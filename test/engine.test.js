'use strict';
// Two or more simulated devices in one process, each with its own home, Claude folder, state folder and clock.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
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
  const desktop = path.join(home, 'ClaudeDesktop');
  const env = { CLAUDE_CONFIG_DIR: claude, CLAUDE_MEMORY_SYNC_HOME: state, CLAUDE_DESKTOP_DIR: desktop };
  const make = () => createEngine({ env, home, hostname: `${name}.local`, now: () => new Date(clock) });
  const mem = (folder) => path.join(claude, 'projects', P.encodeProjectDir(path.join(home, folder)), 'memory');
  const d = {
    name, home, claude, state, desktop, env,
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
  assert.deepStrictEqual([A.engine.activity(1)[0].kind, A.engine.activity(1)[0].unchanged], ['daily', true], 'the run without a new file is in the history');
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

test('engine: language, theme and backup time are saved; unknown values fall back, the time snaps to 5 minutes', () => {
  const A = device('A');
  const look = (e) => [e.settings().language, e.settings().theme];
  assert.deepStrictEqual(look(A.engine), [null, 'system']);
  A.engine.updateSettings({ language: 'de', theme: 'dark' });
  assert.deepStrictEqual(look(createEngine({ env: { CLAUDE_CONFIG_DIR: A.claude, CLAUDE_MEMORY_SYNC_HOME: A.state }, home: A.home })), ['de', 'dark'], 'read back from disk');
  A.engine.updateSettings({ language: 'Deutsch', theme: 'blue' });
  assert.deepStrictEqual(look(A.engine), [null, 'system']);
  for (const [set, saved] of [['13:54', '13:55'], ['9:02', '09:00'], ['23:58', '00:00'], ['noon', '12:00']]) {
    A.engine.updateSettings({ daily: { time: set } });
    assert.strictEqual(A.engine.settings().daily.time, saved, `backup time ${set} is on the 5-minute grid`);
  }
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

// A device with memories, a workspace, Claude settings, own settings, backups and a bundle sent: everything a full backup
// has to bring back.
function busyDevice(name) {
  const A = device(name);
  A.project('code/acme-x', { 'MEMORY.md': '- [N](n.md) — note\n', 'n.md': 'note\n' }, { git: GIT });
  A.project('Desktop', { 'MEMORY.md': '- [D](d.md) — desk\n', 'd.md': 'desk\n' });
  const root = A.folder('Documents/GitHub');
  A.folder('Documents/GitHub/workspaces');
  fs.writeFileSync(path.join(root, 'workspaces', 'App.code-workspace'), JSON.stringify({ folders: [{ path: '../../code/acme-x' }] }));
  fs.writeFileSync(path.join(A.claude, 'CLAUDE.md'), 'Answer briefly.\n');
  A.engine.updateSettings({ deviceName: 'Studio', language: 'de', theme: 'dark', workspaceRoots: [root] });
  A.engine.createBackup('manual');
  A.setNow('2026-10-30T13:00:00');
  A.engine.runDailyIfDue();
  A.folder('Downloads');
  A.engine.exportBundle({ outDir: path.join(A.home, 'Downloads') });
  return { A, root, env: A.env };
}

test('engine: a full backup brings memories, settings, history, matches, activity and backups back after a reset', { skip }, () => {
  const { A, root, env } = busyDevice('mac');
  const before = {
    id: A.engine.settings().deviceId,
    acme: A.snapshot('code/acme-x'),
    history: fs.readFileSync(path.join(A.state, 'history.json'), 'utf8'),
    keys: A.engine.projects().projects.map((p) => p.key).sort(),
    activity: A.engine.activity(100).map((e) => e.id),
    backups: A.engine.library().filter((b) => b.isMine && b.kind !== 'export').map((b) => b.name).sort(),
  };
  const out = A.folder('usb');
  const full = A.engine.createFullBackup({ outDir: out });
  assert.strictEqual(full.backups, before.backups.length);

  // The computer is reset: Claude's folder, the app's data and the workspace file are gone.
  for (const dir of [A.claude, A.state, path.join(root, 'workspaces')]) fs.rmSync(dir, { recursive: true, force: true });
  const R = createEngine({ env, home: A.home, hostname: 'mac.local' });
  assert.notStrictEqual(R.settings().deviceId, before.id, 'a fresh install is a new device');
  assert.throws(() => R.prepareFullRestore(path.join(A.home, 'Downloads', fs.readdirSync(path.join(A.home, 'Downloads'))[0])), { code: 'NOT_FULL' });

  const plan = R.prepareFullRestore(full.path);
  assert.deepStrictEqual([plan.remapped, plan.counts.replace, plan.counts.same, plan.backups.add], [false, 0, 0, before.backups.length]);
  assert.strictEqual(plan.counts.new, 6, 'four memory files, the workspace file and CLAUDE.md');
  const r = R.applyFullRestore(plan.id);
  assert.ok(r.verified && fs.existsSync(r.backupPath), 'the device was backed up first');

  const s = R.settings();
  assert.deepStrictEqual([s.deviceId, s.deviceName, s.language, s.theme, s.workspaceRoots], [before.id, 'Studio', 'de', 'dark', [root]]);
  assert.deepStrictEqual(A.snapshot('code/acme-x'), before.acme);
  assert.ok(fs.existsSync(path.join(root, 'workspaces', 'App.code-workspace')));
  assert.strictEqual(fs.readFileSync(path.join(A.claude, 'CLAUDE.md'), 'utf8'), 'Answer briefly.\n');
  const history = JSON.parse(fs.readFileSync(path.join(A.state, 'history.json'), 'utf8')).keys;
  for (const [k, hashes] of Object.entries(JSON.parse(before.history).keys)) assert.deepStrictEqual(hashes.filter((h) => !history[k].includes(h)), [], k);
  assert.deepStrictEqual(R.projects().projects.map((p) => p.key).sort(), before.keys, 'projects keep their keys');
  const ids = R.activity(100).map((e) => e.id);
  assert.deepStrictEqual(before.activity.filter((id) => !ids.includes(id)), [], 'the activity log is back');
  assert.strictEqual(R.activity(1)[0].type, 'full-restore');
  const mine = R.library().filter((b) => b.isMine && b.kind !== 'export' && b.kind !== 'full').map((b) => b.name);
  assert.deepStrictEqual(before.backups.filter((n) => !mine.includes(n)), [], 'old backups are back and are this device\'s own');
});

test('engine: a full backup taken under another home folder is restored under this one', { skip }, () => {
  const { A, env } = busyDevice('old');
  const full = A.engine.createFullBackup({ outDir: A.folder('usb') });
  const B = device('new');
  assert.throws(() => createEngine({ env: { ...env }, home: B.home, platform: 'win32' }).prepareFullRestore(full.path), { code: 'FULL_PLATFORM' });
  const plan = B.engine.prepareFullRestore(full.path);
  assert.deepStrictEqual([plan.remapped, plan.homeFrom, plan.homeTo], [true, A.home, B.home]);
  B.engine.applyFullRestore(plan.id);
  assert.strictEqual(B.read('code/acme-x', 'n.md'), 'note\n', 'memory is under the Claude folder name of the new home');
  const root = path.join(B.home, 'Documents/GitHub');
  assert.deepStrictEqual(B.engine.settings().workspaceRoots, [root]);
  assert.ok(fs.existsSync(path.join(root, 'workspaces', 'App.code-workspace')));
});

// A Claude Code chat with everything that belongs to it: the transcript, the folder next to it, file-history, uploads,
// its prompts in history.jsonl and, optionally, the desktop app's record of it.
const CHAT = '11111111-1111-4111-8111-111111111111';
const chatDir = (d, folder) => path.join(d.claude, 'projects', P.encodeProjectDir(path.join(d.home, folder)));
const line = (d, folder, id, text) => JSON.stringify({ type: 'user', sessionId: id, entrypoint: 'claude-desktop', cwd: path.join(d.home, folder), message: { content: text } });
function chatOn(d, folder, id, texts, { desktopTitle } = {}) {
  const dir = chatDir(d, folder);
  fs.mkdirSync(path.join(dir, id, 'subagents'), { recursive: true });
  const title = JSON.stringify({ type: 'custom-title', customTitle: 'Login work', sessionId: id });
  fs.writeFileSync(path.join(dir, `${id}.jsonl`), [...texts.map((t) => line(d, folder, id, t)), title].join('\n') + '\n');
  fs.writeFileSync(path.join(dir, id, 'subagents', 'agent-1.jsonl'), JSON.stringify({ sessionId: id, type: 'assistant' }) + '\n');
  fs.writeFileSync(path.join(dir, id, 'custom-title.json'), JSON.stringify({ customTitle: 'Login work' }));
  for (const [area, file, data] of [['file-history', 'abc@v1', 'old version\n'], ['uploads', 'shot.png', Buffer.from([0, 1, 2, 255])]]) {
    fs.mkdirSync(path.join(d.claude, area, id), { recursive: true });
    fs.writeFileSync(path.join(d.claude, area, id, file), data);
  }
  fs.appendFileSync(path.join(d.claude, 'history.jsonl'), JSON.stringify({ display: texts[0], pastedContents: {}, timestamp: 1000, project: path.join(d.home, folder), sessionId: id }) + '\n');
  if (desktopTitle) {
    const rec = path.join(d.desktop, 'claude-code-sessions', 'acct', 'org');
    fs.mkdirSync(rec, { recursive: true });
    fs.writeFileSync(path.join(rec, 'local_aaaa.json'), JSON.stringify({ sessionId: 'local_aaaa', cliSessionId: id, cwd: path.join(d.home, folder), title: desktopTitle }));
  }
  return dir;
}
const addLine = (d, folder, id, text) => fs.appendFileSync(path.join(chatDir(d, folder), `${id}.jsonl`), line(d, folder, id, text) + '\n');

test('engine: a chat travels with everything that belongs to it, is brought up to date, and is never shortened', { skip }, () => {
  const A = device('mac');
  A.project('code/acme-x', { 'MEMORY.md': '- [N](n.md) — note\n', 'n.md': 'note\n' }, { git: GIT });
  chatOn(A, 'code/acme-x', CHAT, ['Fix the login bug'], { desktopTitle: 'Login bug' });
  const B = device('win');
  B.folder('Documents/GitHub/acme-x', { git: 'https://github.com/me/acme-x' });
  B.folder('Downloads');
  fs.mkdirSync(path.join(B.desktop, 'claude-code-sessions', 'acct', 'org'), { recursive: true });

  const listed = A.engine.chats();
  assert.deepStrictEqual(listed.map((p) => [p.name, p.chats.map((c) => [c.id, c.title, c.entrypoint])]), [['acme-x', [[CHAT, 'Login bug', 'claude-desktop']]]]);
  const send = (outDir = path.join(B.home, 'Downloads')) => A.engine.exportBundle({ outDir, selection: { projects: [], workspaces: [], claude: false, chats: [CHAT] } }).path;
  const take = (bundle) => {
    const plan = B.engine.prepare({ bundlePath: bundle });
    B.engine.apply(plan.id, {});
    return plan;
  };

  // New on B: everything lands in B's folder for the project, which is somewhere else. (The bundle goes to a folder
  // that does not exist yet.)
  let plan = take(send(path.join(B.home, 'Downloads', 'new folder')));
  assert.deepStrictEqual(plan.chats.map((c) => [c.id, c.status, c.title]), [[CHAT, 'new', 'Login bug']]);
  assert.strictEqual(plan.items.length, 0, 'the memory was not chosen, so nothing of it is in the plan');
  const bDir = chatDir(B, 'Documents/GitHub/acme-x');
  assert.strictEqual(fs.readFileSync(path.join(bDir, `${CHAT}.jsonl`), 'utf8'), fs.readFileSync(path.join(chatDir(A, 'code/acme-x'), `${CHAT}.jsonl`), 'utf8'));
  for (const rel of [`${CHAT}/subagents/agent-1.jsonl`, `${CHAT}/custom-title.json`]) assert.ok(fs.existsSync(path.join(bDir, rel)), rel);
  assert.ok(fs.existsSync(path.join(B.claude, 'file-history', CHAT, 'abc@v1')));
  assert.deepStrictEqual([...fs.readFileSync(path.join(B.claude, 'uploads', CHAT, 'shot.png'))], [0, 1, 2, 255]);
  const prompt = JSON.parse(fs.readFileSync(path.join(B.claude, 'history.jsonl'), 'utf8').trim());
  assert.deepStrictEqual([prompt.sessionId, prompt.project], [CHAT, path.join(B.home, 'Documents/GitHub/acme-x')], 'the prompt history points to B\'s folder');
  const rec = JSON.parse(fs.readFileSync(path.join(B.desktop, 'claude-code-sessions', 'acct', 'org', 'local_aaaa.json'), 'utf8'));
  assert.deepStrictEqual([rec.cliSessionId, rec.cwd, rec.title], [CHAT, path.join(B.home, 'Documents/GitHub/acme-x'), 'Login bug']);
  assert.ok(!fs.existsSync(path.join(B.claude, 'projects', path.basename(bDir), 'memory', 'n.md')), 'B\'s memory is left alone');

  // Continued on A: B gets the rest.
  addLine(A, 'code/acme-x', CHAT, 'Now add a test');
  plan = take(send());
  assert.strictEqual(plan.chats[0].status, 'updated');
  assert.match(fs.readFileSync(path.join(bDir, `${CHAT}.jsonl`), 'utf8'), /Now add a test/);
  assert.strictEqual(fs.readFileSync(path.join(B.claude, 'history.jsonl'), 'utf8').trim().split('\n').length, 1, 'a prompt already there is not added twice');

  // Continued further on B only: an older copy changes nothing.
  addLine(B, 'Documents/GitHub/acme-x', CHAT, 'B went on');
  const bAhead = fs.readFileSync(path.join(bDir, `${CHAT}.jsonl`), 'utf8');
  plan = B.engine.prepare({ bundlePath: send() });
  assert.deepStrictEqual([plan.chats[0].status, plan.chats[0].choices], ['local-newer', []]);

  // Continued on both: B keeps its own and gets A's as another chat.
  addLine(A, 'code/acme-x', CHAT, 'A went on');
  plan = take(send());
  assert.strictEqual(plan.chats[0].status, 'diverged');
  assert.strictEqual(fs.readFileSync(path.join(bDir, `${CHAT}.jsonl`), 'utf8'), bAhead);
  const copies = fs.readdirSync(bDir).filter((f) => f.endsWith('.jsonl') && f !== `${CHAT}.jsonl`);
  assert.strictEqual(copies.length, 1);
  const copy = fs.readFileSync(path.join(bDir, copies[0]), 'utf8');
  assert.ok(/A went on/.test(copy) && !copy.includes(CHAT), 'the copy has its own id inside');
  assert.ok(fs.existsSync(path.join(B.claude, 'file-history', copies[0].replace('.jsonl', ''), 'abc@v1')));
  const name = A.engine.settings().deviceName;
  const titles = copy.trim().split('\n').map((l) => JSON.parse(l)).filter((o) => o.type === 'custom-title').map((o) => o.customTitle);
  assert.deepStrictEqual(titles, [`Login work (${name})`], 'the copy is named after the device it came from');
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(bDir, copies[0].replace('.jsonl', ''), 'custom-title.json'), 'utf8')).customTitle, `Login work (${name})`);
  assert.match(bAhead, /"customTitle":"Login work"/, 'B\'s own chat keeps its title');
});

test('engine: a full backup carries every chat, and a restore after a reset brings them back', { skip }, () => {
  const { A, env } = busyDevice('mac');
  chatOn(A, 'code/acme-x', CHAT, ['Fix the login bug', 'And the logout'], { desktopTitle: 'Login bug' });
  const transcript = fs.readFileSync(path.join(chatDir(A, 'code/acme-x'), `${CHAT}.jsonl`), 'utf8');
  const full = A.engine.createFullBackup({ outDir: A.folder('usb') });
  assert.strictEqual(full.chats, 1);
  for (const dir of [A.claude, A.state, path.join(A.desktop, 'claude-code-sessions', 'acct', 'org', 'local_aaaa.json')]) fs.rmSync(dir, { recursive: true, force: true });
  const R = createEngine({ env, home: A.home, hostname: 'mac.local' });
  const plan = R.prepareFullRestore(full.path);
  assert.strictEqual(plan.chats.new, 1);
  R.applyFullRestore(plan.id);
  assert.strictEqual(fs.readFileSync(path.join(chatDir(A, 'code/acme-x'), `${CHAT}.jsonl`), 'utf8'), transcript);
  assert.ok(fs.existsSync(path.join(A.claude, 'file-history', CHAT, 'abc@v1')));
  assert.match(fs.readFileSync(path.join(A.claude, 'history.jsonl'), 'utf8'), /Fix the login bug/);
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(A.desktop, 'claude-code-sessions', 'acct', 'org', 'local_aaaa.json'), 'utf8')).cliSessionId, CHAT);
});

const OTHER = '22222222-2222-4222-8222-222222222222';

test('engine: daily and manual backups take what the backup settings leave in; before-operation backups take everything', { skip }, () => {
  const { A, root } = busyDevice('mac');
  chatOn(A, 'code/acme-x', CHAT, ['Fix the login bug']);
  chatOn(A, 'Desktop', OTHER, ['Plan the week']);
  fs.writeFileSync(path.join(root, 'workspaces', 'Fix.code-workspace'), JSON.stringify({ folders: [{ path: path.join(A.home, 'code/acme-x') }] }));
  const [r] = A.engine.workspaces();
  A.engine.updateSettings({ backup: { excludeProjects: ['desktop'], excludeWorkspaceFiles: { [r.key]: ['workspaces/Fix.code-workspace'] }, claude: false, chats: 'some', chatProjects: ['acme-x'] } });

  const manual = A.engine.createBackup('manual');
  assert.strictEqual(manual.chats, 1);
  const b = A.engine.bundleContents(manual.path);
  assert.deepStrictEqual(b.locations.map((l) => l.id).sort(), ['project:acme-x', `workspaceRoot:${r.key}`]);
  assert.deepStrictEqual(b.locations.find((l) => l.type === 'workspaceRoot').skipped, ['workspaces/Fix.code-workspace']);
  assert.deepStrictEqual(b.files.filter((f) => f.location.startsWith('workspaceRoot')).map((f) => f.rel), ['workspaces/App.code-workspace']);
  assert.deepStrictEqual(b.chatList.map((c) => c.id), [CHAT], 'the chats of the chosen project only');

  // The preview follows a draft without saving it.
  assert.deepStrictEqual([A.engine.backupPreview().chats.count, A.engine.backupPreview({ chats: 'all' }).chats.count, A.engine.backupPreview({ chats: 'none' }).chats.count], [1, 2, 0]);
  assert.strictEqual(A.engine.settings().backup.chats, 'some');

  // A daily run with nothing changed writes nothing; a chat that went on is a change.
  A.setNow('2026-10-31T13:00:00');
  assert.ok(!A.engine.runDailyIfDue().skipped);
  A.setNow('2026-11-01T13:00:00');
  assert.ok(A.engine.runDailyIfDue().skipped);
  addLine(A, 'code/acme-x', CHAT, 'And the logout');
  A.setNow('2026-11-02T13:00:00');
  const daily = A.engine.runDailyIfDue();
  assert.deepStrictEqual([daily.skipped, daily.chats], [undefined, 1]);

  // Before an operation: every memory, workspace file and Claude setting, whatever the settings say; no chats.
  const done = A.engine.fixWorkspace({ root: r.key, rel: 'workspaces/Fix.code-workspace', apply: true });
  const before = A.engine.bundleContents(done.backupPath);
  assert.deepStrictEqual(before.locations.map((l) => l.id).sort(), ['claude', 'project:acme-x', 'project:desktop', `workspaceRoot:${r.key}`]);
  assert.ok(before.files.some((f) => f.rel === 'workspaces/Fix.code-workspace'));
  assert.deepStrictEqual(before.chatList, []);
});

const backupFiles = (d) => {
  const out = {};
  for (const kind of ['daily', 'before', 'manual']) {
    const dir = path.join(d.state, 'backups', kind);
    for (const name of fs.existsSync(dir) ? fs.readdirSync(dir) : []) out[`${kind}/${name}`] = crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, name))).digest('hex');
  }
  return out;
};

test('engine: a backup brings its chats back, and a full backup keeps earlier backups as parts', { skip }, () => {
  const { A, env } = busyDevice('mac');
  chatOn(A, 'code/acme-x', CHAT, ['Fix the login bug', 'And the logout']);
  A.engine.updateSettings({ backup: { chats: 'all' } });
  const manual = A.engine.createBackup('manual');
  const file = path.join(chatDir(A, 'code/acme-x'), `${CHAT}.jsonl`);
  const transcript = fs.readFileSync(file, 'utf8');

  // Going back to the backup brings a lost chat back.
  fs.rmSync(file);
  const plan = A.engine.prepare({ bundlePath: manual.path, mode: 'restore' });
  assert.deepStrictEqual(plan.chats.map((c) => [c.id, c.status]), [[CHAT, 'new']]);
  A.engine.apply(plan.id, {});
  assert.strictEqual(fs.readFileSync(file, 'utf8'), transcript);

  // After a reset, every earlier backup (this one with its chat too) comes back byte for byte.
  const kept = backupFiles(A);
  const full = A.engine.createFullBackup({ outDir: A.folder('usb') });
  assert.strictEqual(require('../lib/bundle').readBundleHeader(full.path).version, 4);
  for (const dir of [A.claude, A.state]) fs.rmSync(dir, { recursive: true, force: true });
  const R = createEngine({ env, home: A.home, hostname: 'mac.local' });
  R.applyFullRestore(R.prepareFullRestore(full.path).id);
  const now = backupFiles(A);
  for (const [rel, hash] of Object.entries(kept)) assert.strictEqual(now[rel], hash, rel);
  assert.strictEqual(fs.readFileSync(file, 'utf8'), transcript);
});
