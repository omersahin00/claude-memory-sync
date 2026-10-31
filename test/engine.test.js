'use strict';
// Two or more simulated devices in one process, each with its own home, Claude folder, state folder and clock.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const P = require('../lib/paths');
const { createEngine } = require('../lib/engine');

const skip = process.platform === 'win32';
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'cms-engine-'));
let n = 0;

function device(name) {
  const home = path.join(ROOT, `${name}-${++n}`);
  const claude = path.join(home, '.claude');
  const state = path.join(home, '.state');
  fs.mkdirSync(path.join(claude, 'projects'), { recursive: true });
  let clock = new Date('2026-10-30T09:00:00');
  const env = { CLAUDE_CONFIG_DIR: claude, CLAUDE_MEMORY_SYNC_HOME: state };
  const make = () => createEngine({ env, home, hostname: `${name}.local`, now: () => new Date(clock) });
  const mem = (folder) => path.join(claude, 'projects', P.encodeProjectDir(path.join(home, folder)), 'memory');
  const d = {
    name, home, claude, state,
    engine: make(),
    setNow: (s) => { clock = new Date(s); },
    folder(folder, { git } = {}) {
      const abs = path.join(home, folder);
      fs.mkdirSync(abs, { recursive: true });
      if (git) {
        fs.mkdirSync(path.join(abs, '.git'), { recursive: true });
        fs.writeFileSync(path.join(abs, '.git', 'config'), `[remote "origin"]\n\turl = ${git}\n`);
      }
      return abs;
    },
    // A folder opened in Claude Code, with memory files.
    project(folder, files = {}, opts = {}) {
      d.folder(folder, opts);
      fs.mkdirSync(mem(folder), { recursive: true });
      for (const [rel, text] of Object.entries(files)) d.write(folder, rel, text);
    },
    write: (folder, rel, text) => {
      fs.mkdirSync(mem(folder), { recursive: true });
      fs.writeFileSync(path.join(mem(folder), rel), text);
    },
    read: (folder, rel) => fs.readFileSync(path.join(mem(folder), rel), 'utf8'),
    has: (folder, rel) => fs.existsSync(path.join(mem(folder), rel)),
    rm: (folder, rel) => fs.unlinkSync(path.join(mem(folder), rel)),
    snapshot(folder) {
      const out = {};
      for (const f of fs.readdirSync(mem(folder)).sort()) out[f] = fs.readFileSync(path.join(mem(folder), f), 'utf8');
      return out;
    },
    backups: (kind) => {
      try {
        return fs.readdirSync(path.join(state, 'backups', kind)).length;
      } catch {
        return 0;
      }
    },
  };
  return d;
}

const GIT = 'git@github.com:me/acme-x.git';

// Device A with a git repo and the Desktop as Claude projects; device B has the repo elsewhere and has not opened anything yet.
function pair() {
  const A = device('mac');
  A.project('code/acme-x', { 'MEMORY.md': '- [N](n.md) — note\n- [X](x.md) — x\n', 'n.md': 'note\n', 'x.md': 'x\n' }, { git: GIT });
  A.project('Desktop', { 'MEMORY.md': '- [D](d.md) — desk\n', 'd.md': 'desk\n' });
  const B = device('win');
  B.folder('work/acme-x', { git: 'https://github.com/me/acme-x' });
  B.folder('Desktop');
  B.folder('Downloads');
  B.engine.updateSettings({ workspaceRoots: [path.join(B.home, 'work')] });
  return { A, B };
}

const send = (from, to) => from.engine.exportBundle({ outDir: path.join(to.home, 'Downloads') }).path;
// Files the plan offers to change (identical files and files kept as they are here are left out).
const byRel = (plan) => Object.fromEntries(plan.items.filter((i) => i.group !== 'same' && i.group !== 'kept').map((i) => [`${i.scopeLabel}/${i.rel}`, i.group]));

test('engine: every Claude project is found; Claude app scratch sessions stay out of bundles', { skip }, () => {
  const A = device('mac');
  A.project('code/acme-x', { 'MEMORY.md': '- [N](n.md)\n', 'n.md': 'note' }, { git: GIT });
  A.project('Desktop', { 'MEMORY.md': '- [D](d.md)\n', 'd.md': 'desk' });
  A.project('Library/Application Support/Claude/scratch-workspaces/u1/u2/scratch-2026-10-01-abc', { 'MEMORY.md': 's' });
  A.project('code/empty');
  const { projects, withoutMemory } = A.engine.projects();
  assert.deepStrictEqual(
    projects.map((p) => [p.key, p.isScratch, p.included]).sort(),
    [['acme-x', false, true], ['desktop', false, true], ['scratch-2026-10-01-abc', true, false]],
  );
  assert.strictEqual(withoutMemory, 1);
  assert.deepStrictEqual(A.engine.exportPreview().locations.map((l) => l.id).sort(), ['project:acme-x', 'project:desktop']);
  assert.deepStrictEqual(A.engine.settings().workspaceRoots, [path.join(A.home, 'code')], 'the usual parent folder becomes the workspace folder');
});

test('engine: first transfer finds the repo by git remote and the Desktop by its folder, and sets them up', { skip }, () => {
  const { A, B } = pair();
  const bundle = send(A, B);
  const plan = B.engine.prepare({ bundlePath: bundle });
  const m = Object.fromEntries(plan.matches.map((x) => [x.id, [x.status, x.how, x.include]]));
  assert.deepStrictEqual(m['project:acme-x'], ['create', 'git', true]);
  assert.deepStrictEqual(m['project:desktop'], ['create', 'path', true]);
  const res = B.engine.apply(plan.id, {});
  assert.ok(fs.existsSync(res.backupPath));
  assert.deepStrictEqual(B.snapshot('work/acme-x'), A.snapshot('code/acme-x'));
  assert.deepStrictEqual(B.snapshot('Desktop'), A.snapshot('Desktop'));

  // Next time the same projects are known; nothing is left to do.
  const again = B.engine.prepare({ bundlePath: bundle });
  assert.strictEqual(again.matches.find((x) => x.id === 'project:acme-x').how, 'saved');
  assert.deepStrictEqual(byRel(again), {});
  const lib = B.engine.library().find((b) => b.path === bundle);
  assert.ok(lib && lib.imported && !lib.isMine);
});

test('engine: a second transfer shows only what changed, waits for conflicts, backs up first every time', { skip }, () => {
  const { A, B } = pair();
  B.engine.apply(B.engine.prepare({ bundlePath: send(A, B) }).id, {});

  A.write('code/acme-x', 'n.md', 'note v2\n');
  A.write('code/acme-x', 'm.md', 'more\n');
  A.write('code/acme-x', 'MEMORY.md', '- [N](n.md) — note\n- [X](x.md) — x\n- [M](m.md) — more\n');
  A.rm('Desktop', 'd.md');
  A.write('Desktop', 'MEMORY.md', '');
  A.write('code/acme-x', 'x.md', 'x from A\n');
  B.write('work/acme-x', 'x.md', 'x from B\n');

  const bundle = send(A, B);
  const plan = B.engine.prepare({ bundlePath: bundle });
  assert.deepStrictEqual(byRel(plan), {
    'acme-x/MEMORY.md': 'index', 'acme-x/m.md': 'new', 'acme-x/n.md': 'updated', 'acme-x/x.md': 'conflict',
    'Desktop/MEMORY.md': 'index', 'Desktop/d.md': 'deleted',
  });
  assert.throws(() => B.engine.apply(plan.id, {}), (e) => e.code === 'PENDING');

  B.engine.createBackup('manual');
  const before = B.backups('before');
  const res = B.engine.apply(plan.id, { items: { 'memory/desktop/d.md': 'skip', 'memory/acme-x/x.md': 'b' } });
  assert.strictEqual(B.backups('before'), before + 1, 'a backup is taken even right after a manual one');
  assert.strictEqual(B.read('work/acme-x', 'n.md'), 'note v2\n');
  assert.strictEqual(B.read('work/acme-x', 'm.md'), 'more\n');
  assert.strictEqual(B.read('work/acme-x', 'x.md'), 'x from B\n');
  assert.strictEqual(B.read('work/acme-x', 'x--mac.md'), 'x from A\n');
  assert.match(B.read('work/acme-x', 'MEMORY.md'), /\(x--mac\.md\)/);
  assert.ok(B.has('Desktop', 'd.md'), 'skipped deletion keeps the file');
  assert.strictEqual(res.writes, 4);

  // The skipped deletion is offered again (with its MEMORY.md line); everything else is done.
  const plan2 = B.engine.prepare({ bundlePath: bundle });
  assert.deepStrictEqual(byRel(plan2), { 'Desktop/MEMORY.md': 'index', 'Desktop/d.md': 'deleted' });
});

test('engine: undo puts back exactly the files one transfer changed', { skip }, () => {
  const { A, B } = pair();
  B.engine.apply(B.engine.prepare({ bundlePath: send(A, B) }).id, {});
  A.write('code/acme-x', 'n.md', 'note v2\n');
  A.write('code/acme-x', 'new.md', 'new\n');
  const snap = B.snapshot('work/acme-x');
  const res = B.engine.apply(B.engine.prepare({ bundlePath: send(A, B) }).id, {});
  assert.notDeepStrictEqual(B.snapshot('work/acme-x'), snap);
  B.write('Desktop', 'later.md', 'written after the transfer\n');

  const entry = B.engine.activity().find((e) => e.id === res.activityId);
  assert.ok(entry.undoable);
  const undo = B.engine.prepareUndo(res.activityId);
  assert.deepStrictEqual(byRel(undo), { 'acme-x/n.md': 'updated', 'acme-x/new.md': 'deleted' });
  B.engine.apply(undo.id, {});
  assert.deepStrictEqual(B.snapshot('work/acme-x'), snap);
  assert.ok(B.has('Desktop', 'later.md'), 'files the transfer did not touch are left alone');
  assert.ok(B.engine.activity().find((e) => e.id === res.activityId).undone);
});

test('engine: nothing is written when a file changed after the review', { skip }, () => {
  const { A, B } = pair();
  B.engine.apply(B.engine.prepare({ bundlePath: send(A, B) }).id, {});
  A.write('code/acme-x', 'n.md', 'note v2\n');
  const plan = B.engine.prepare({ bundlePath: send(A, B) });
  B.write('work/acme-x', 'n.md', 'Claude wrote this meanwhile\n');
  const before = B.backups('before');
  assert.throws(() => B.engine.apply(plan.id, {}), (e) => e.code === 'STALE');
  assert.strictEqual(B.read('work/acme-x', 'n.md'), 'Claude wrote this meanwhile\n');
  assert.strictEqual(B.backups('before'), before);
});

test('engine: daily backup runs once a day, a missed day runs later, an unchanged day is not stored twice', { skip }, () => {
  const A = device('mac');
  A.project('code/acme-x', { 'MEMORY.md': '- [N](n.md)\n', 'n.md': 'note' });
  A.engine.updateSettings({ daily: { enabled: true, time: '12:00' } });
  A.setNow('2026-10-30T09:00:00');
  assert.ok(A.engine.runDailyIfDue().path, 'first start: a backup right away');
  assert.strictEqual(A.engine.runDailyIfDue().due, false);
  A.setNow('2026-10-30T12:05:00');
  assert.strictEqual(A.engine.runDailyIfDue().skipped, true, 'nothing changed since the morning');
  A.setNow('2026-11-02T08:00:00');
  A.write('code/acme-x', 'n.md', 'note v2');
  const r = A.engine.runDailyIfDue();
  assert.ok(r.due && !r.skipped && fs.existsSync(r.path), 'missed days run at the next check');
  assert.strictEqual(A.backups('daily'), 2);
  assert.strictEqual(A.engine.library().filter((b) => b.kind === 'daily' && b.isMine).length, 2);
});

test('engine: 1.x settings and history are carried over', () => {
  const D = device('old');
  fs.mkdirSync(D.state, { recursive: true });
  const repos = path.join(D.home, 'GitHub');
  fs.writeFileSync(path.join(D.state, 'config.json'), JSON.stringify({ deviceId: 'old-id', deviceName: 'Old Mac', reposRoot: repos, prefix: 'acme' }));
  fs.writeFileSync(path.join(D.state, 'history.json'), JSON.stringify({ version: 1, keys: { 'memory/acme-a/x.md': ['h1'], 'workspace/workspaces/a.code-workspace': ['h2'] } }));
  const cfg = D.engine.settings();
  assert.strictEqual(cfg.deviceId, 'old-id');
  assert.strictEqual(cfg.deviceName, 'Old Mac');
  assert.deepStrictEqual(cfg.workspaceRoots, [repos]);
  const keys = Object.keys(JSON.parse(fs.readFileSync(path.join(D.state, 'history.json'), 'utf8')).keys).sort();
  assert.deepStrictEqual(keys, ['memory/acme-a/x.md', 'workspace/github/workspaces/a.code-workspace']);
  assert.ok(fs.existsSync(path.join(D.state, 'config.v1.json')));
});

test('engine: a workspace file is made portable with a backup, and the change can be undone', { skip }, () => {
  const A = device('mac');
  const root = A.folder('code');
  A.folder('code/acme-x', { git: GIT });
  A.folder('code/ws');
  const ws = path.join(root, 'ws', 'all.code-workspace');
  const original = `{\n  "folders": [ { "path": ${JSON.stringify(path.join(root, 'acme-x'))} } ]\n}\n`;
  fs.writeFileSync(ws, original);
  A.engine.updateSettings({ workspaceRoots: [root] });
  const [r] = A.engine.workspaces();
  assert.strictEqual(r.files[0].fixable, true);
  assert.deepStrictEqual(A.engine.fixWorkspace({ root: r.key, rel: 'ws/all.code-workspace' }).changes, [{ from: path.join(root, 'acme-x'), to: '../acme-x' }]);
  assert.strictEqual(fs.readFileSync(ws, 'utf8'), original, 'preview writes nothing');
  const done = A.engine.fixWorkspace({ root: r.key, rel: 'ws/all.code-workspace', apply: true });
  assert.ok(fs.readFileSync(ws, 'utf8').includes('"path": "../acme-x"'));
  A.engine.apply(A.engine.prepareUndo(done.activityId).id, {});
  assert.strictEqual(fs.readFileSync(ws, 'utf8'), original);
});

test('engine: workspaces go where their repositories are; one whose folders are missing comes unselected and is offered again', { skip }, () => {
  const A = device('mac');
  const root = A.folder('Documents/GitHub');
  A.folder('Documents/GitHub/app', { git: GIT });
  A.folder('Documents/GitHub/lib');
  A.folder('Documents/GitHub/workspaces');
  const ws = (name, folders) => fs.writeFileSync(path.join(root, 'workspaces', name), JSON.stringify({ folders: folders.map((p) => ({ path: p })) }));
  ws('App.code-workspace', ['../app', '../lib']);
  ws('Other.code-workspace', ['../app', '../other']);
  A.engine.updateSettings({ workspaceRoots: [root] });

  const B = device('win');
  B.folder('Downloads');
  B.folder('code/app');
  B.folder('code/lib');
  B.engine.updateSettings({ workspaceRoots: [] });
  const bundle = send(A, B);
  const plan = B.engine.prepare({ bundlePath: bundle });
  const m = plan.matches.find((x) => x.type === 'workspaceRoot');
  assert.deepStrictEqual([m.status, m.how, m.include, m.local.path], ['create', 'repos', true, path.join(B.home, 'code')]);
  const item = (p, rel) => p.items.find((i) => i.rel === `workspaces/${rel}`);
  assert.deepStrictEqual([item(plan, 'App.code-workspace').repoStatus, item(plan, 'App.code-workspace').defaultChoice], ['all', 'take']);
  const other = item(plan, 'Other.code-workspace');
  assert.deepStrictEqual([other.repoStatus, other.defaultChoice], ['some', 'skip']);
  assert.deepStrictEqual(other.repos.map((r) => [r.name, r.found, r.local]), [['app', true, path.join(B.home, 'code', 'app')], ['other', false, path.join(B.home, 'code', 'other')]]);

  B.engine.apply(plan.id, {});
  assert.ok(fs.existsSync(path.join(B.home, 'code', 'workspaces', 'App.code-workspace')));
  assert.ok(!fs.existsSync(path.join(B.home, 'code', 'workspaces', 'Other.code-workspace')));
  assert.deepStrictEqual(B.engine.settings().workspaceRoots, [path.join(B.home, 'code')]);

  // The folder is remembered; the workspace left out comes again, selected once its repository is here.
  B.folder('code/other');
  const again = B.engine.prepare({ bundlePath: bundle });
  assert.strictEqual(again.matches.find((x) => x.type === 'workspaceRoot').how, 'saved');
  assert.deepStrictEqual([item(again, 'Other.code-workspace').action, item(again, 'Other.code-workspace').defaultChoice], ['add', 'take']);
  assert.strictEqual(item(again, 'App.code-workspace').group, 'same');
});

test('engine: the interface language and theme are saved; unknown values fall back to the defaults', () => {
  const A = device('A');
  const look = (e) => [e.settings().language, e.settings().theme];
  assert.deepStrictEqual(look(A.engine), [null, 'system']);
  A.engine.updateSettings({ language: 'de', theme: 'dark' });
  assert.deepStrictEqual(look(createEngine({ env: { CLAUDE_CONFIG_DIR: A.claude, CLAUDE_MEMORY_SYNC_HOME: A.state }, home: A.home })), ['de', 'dark'], 'read back from disk');
  A.engine.updateSettings({ language: 'Deutsch', theme: 'blue' });
  assert.deepStrictEqual(look(A.engine), [null, 'system']);
});

test('engine: a workspace file left out of a bundle stays as it is on the other device, in a sync and in a restore', { skip }, () => {
  const A = device('mac');
  const root = A.folder('Documents/GitHub');
  A.folder('Documents/GitHub/app', { git: GIT });
  A.folder('Documents/GitHub/workspaces');
  const ws = (d, dir, name, extra) => fs.writeFileSync(path.join(dir, 'workspaces', name), JSON.stringify({ folders: [{ path: '../app' }], ...extra }));
  ws(A, root, 'App.code-workspace');
  ws(A, root, 'Private.code-workspace');
  A.engine.updateSettings({ workspaceRoots: [root] });
  const B = device('win');
  B.folder('Downloads');
  B.folder('code/app');
  B.engine.updateSettings({ workspaceRoots: [] });
  B.engine.apply(B.engine.prepare({ bundlePath: send(A, B) }).id, {});
  const bRoot = path.join(B.home, 'code');
  assert.ok(fs.existsSync(path.join(bRoot, 'workspaces', 'Private.code-workspace')), 'both files arrived the first time');

  // A changes both files, then leaves Private out of the next bundle.
  ws(A, root, 'App.code-workspace', { settings: { a: 1 } });
  ws(A, root, 'Private.code-workspace', { settings: { p: 1 } });
  const key = A.engine.workspaces()[0].key;
  const selection = { projects: [], workspaces: [key], skipWorkspaceFiles: { [key]: ['workspaces/Private.code-workspace'] }, claude: false };
  assert.strictEqual(A.engine.exportPreview(selection).files, 1);
  const bundle = A.engine.exportBundle({ outDir: path.join(B.home, 'Downloads'), selection }).path;
  const privateOnB = fs.readFileSync(path.join(bRoot, 'workspaces', 'Private.code-workspace'), 'utf8');

  for (const mode of ['sync', 'restore']) {
    const plan = B.engine.prepare({ bundlePath: bundle, mode });
    assert.deepStrictEqual(plan.items.map((i) => i.rel), ['workspaces/App.code-workspace'], `${mode}: only the bundled file is in the plan`);
  }
  B.engine.apply(B.engine.prepare({ bundlePath: bundle, mode: 'restore' }).id, {});
  assert.match(fs.readFileSync(path.join(bRoot, 'workspaces', 'App.code-workspace'), 'utf8'), /"a":1/);
  assert.strictEqual(fs.readFileSync(path.join(bRoot, 'workspaces', 'Private.code-workspace'), 'utf8'), privateOnB, 'the left-out file is untouched');
  const status = Object.fromEntries(A.engine.workspaces()[0].files.map((f) => [f.rel, f.status]));
  assert.deepStrictEqual(status, { 'workspaces/App.code-workspace': 'synced', 'workspaces/Private.code-workspace': 'changed' }, 'the left-out change still counts as not sent');
});
