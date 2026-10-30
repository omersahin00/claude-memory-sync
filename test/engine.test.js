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

const GIT = 'git@github.com:me/sasa-x.git';

// Device A with a git repo and the Desktop as Claude projects; device B has the repo elsewhere and has not opened anything yet.
function pair() {
  const A = device('mac');
  A.project('code/sasa-x', { 'MEMORY.md': '- [N](n.md) — note\n- [X](x.md) — x\n', 'n.md': 'note\n', 'x.md': 'x\n' }, { git: GIT });
  A.project('Desktop', { 'MEMORY.md': '- [D](d.md) — desk\n', 'd.md': 'desk\n' });
  const B = device('win');
  B.folder('work/sasa-x', { git: 'https://github.com/me/sasa-x' });
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
  A.project('code/sasa-x', { 'MEMORY.md': '- [N](n.md)\n', 'n.md': 'note' }, { git: GIT });
  A.project('Desktop', { 'MEMORY.md': '- [D](d.md)\n', 'd.md': 'desk' });
  A.project('Library/Application Support/Claude/scratch-workspaces/u1/u2/scratch-2026-10-01-abc', { 'MEMORY.md': 's' });
  A.project('code/empty');
  const { projects, withoutMemory } = A.engine.projects();
  assert.deepStrictEqual(
    projects.map((p) => [p.key, p.isScratch, p.included]).sort(),
    [['desktop', false, true], ['sasa-x', false, true], ['scratch-2026-10-01-abc', true, false]],
  );
  assert.strictEqual(withoutMemory, 1);
  assert.deepStrictEqual(A.engine.exportPreview().locations.map((l) => l.id).sort(), ['project:desktop', 'project:sasa-x']);
  assert.deepStrictEqual(A.engine.settings().workspaceRoots, [path.join(A.home, 'code')], 'the usual parent folder becomes the workspace folder');
});

test('engine: first transfer finds the repo by git remote and the Desktop by its folder, and sets them up', { skip }, () => {
  const { A, B } = pair();
  const bundle = send(A, B);
  const plan = B.engine.prepare({ bundlePath: bundle });
  const m = Object.fromEntries(plan.matches.map((x) => [x.id, [x.status, x.how, x.include]]));
  assert.deepStrictEqual(m['project:sasa-x'], ['create', 'git', true]);
  assert.deepStrictEqual(m['project:desktop'], ['create', 'path', true]);
  const res = B.engine.apply(plan.id, {});
  assert.ok(fs.existsSync(res.backupPath));
  assert.deepStrictEqual(B.snapshot('work/sasa-x'), A.snapshot('code/sasa-x'));
  assert.deepStrictEqual(B.snapshot('Desktop'), A.snapshot('Desktop'));

  // Next time the same projects are known; nothing is left to do.
  const again = B.engine.prepare({ bundlePath: bundle });
  assert.strictEqual(again.matches.find((x) => x.id === 'project:sasa-x').how, 'saved');
  assert.deepStrictEqual(byRel(again), {});
  const lib = B.engine.library().find((b) => b.path === bundle);
  assert.ok(lib && lib.imported && !lib.isMine);
});

test('engine: a second transfer shows only what changed, waits for conflicts, backs up first every time', { skip }, () => {
  const { A, B } = pair();
  B.engine.apply(B.engine.prepare({ bundlePath: send(A, B) }).id, {});

  A.write('code/sasa-x', 'n.md', 'note v2\n');
  A.write('code/sasa-x', 'm.md', 'more\n');
  A.write('code/sasa-x', 'MEMORY.md', '- [N](n.md) — note\n- [X](x.md) — x\n- [M](m.md) — more\n');
  A.rm('Desktop', 'd.md');
  A.write('Desktop', 'MEMORY.md', '');
  A.write('code/sasa-x', 'x.md', 'x from A\n');
  B.write('work/sasa-x', 'x.md', 'x from B\n');

  const bundle = send(A, B);
  const plan = B.engine.prepare({ bundlePath: bundle });
  assert.deepStrictEqual(byRel(plan), {
    'sasa-x/MEMORY.md': 'index', 'sasa-x/m.md': 'new', 'sasa-x/n.md': 'updated', 'sasa-x/x.md': 'conflict',
    'Desktop/MEMORY.md': 'index', 'Desktop/d.md': 'deleted',
  });
  assert.throws(() => B.engine.apply(plan.id, {}), (e) => e.code === 'PENDING');

  B.engine.createBackup('manual');
  const before = B.backups('before');
  const res = B.engine.apply(plan.id, { items: { 'memory/desktop/d.md': 'skip', 'memory/sasa-x/x.md': 'b' } });
  assert.strictEqual(B.backups('before'), before + 1, 'a backup is taken even right after a manual one');
  assert.strictEqual(B.read('work/sasa-x', 'n.md'), 'note v2\n');
  assert.strictEqual(B.read('work/sasa-x', 'm.md'), 'more\n');
  assert.strictEqual(B.read('work/sasa-x', 'x.md'), 'x from B\n');
  assert.strictEqual(B.read('work/sasa-x', 'x--mac.md'), 'x from A\n');
  assert.match(B.read('work/sasa-x', 'MEMORY.md'), /\(x--mac\.md\)/);
  assert.ok(B.has('Desktop', 'd.md'), 'skipped deletion keeps the file');
  assert.strictEqual(res.writes, 4);

  // The skipped deletion is offered again (with its MEMORY.md line); everything else is done.
  const plan2 = B.engine.prepare({ bundlePath: bundle });
  assert.deepStrictEqual(byRel(plan2), { 'Desktop/MEMORY.md': 'index', 'Desktop/d.md': 'deleted' });
});

test('engine: undo puts back exactly the files one transfer changed', { skip }, () => {
  const { A, B } = pair();
  B.engine.apply(B.engine.prepare({ bundlePath: send(A, B) }).id, {});
  A.write('code/sasa-x', 'n.md', 'note v2\n');
  A.write('code/sasa-x', 'new.md', 'new\n');
  const snap = B.snapshot('work/sasa-x');
  const res = B.engine.apply(B.engine.prepare({ bundlePath: send(A, B) }).id, {});
  assert.notDeepStrictEqual(B.snapshot('work/sasa-x'), snap);
  B.write('Desktop', 'later.md', 'written after the transfer\n');

  const entry = B.engine.activity().find((e) => e.id === res.activityId);
  assert.ok(entry.undoable);
  const undo = B.engine.prepareUndo(res.activityId);
  assert.deepStrictEqual(byRel(undo), { 'sasa-x/n.md': 'updated', 'sasa-x/new.md': 'deleted' });
  B.engine.apply(undo.id, {});
  assert.deepStrictEqual(B.snapshot('work/sasa-x'), snap);
  assert.ok(B.has('Desktop', 'later.md'), 'files the transfer did not touch are left alone');
  assert.ok(B.engine.activity().find((e) => e.id === res.activityId).undone);
});

test('engine: nothing is written when a file changed after the review', { skip }, () => {
  const { A, B } = pair();
  B.engine.apply(B.engine.prepare({ bundlePath: send(A, B) }).id, {});
  A.write('code/sasa-x', 'n.md', 'note v2\n');
  const plan = B.engine.prepare({ bundlePath: send(A, B) });
  B.write('work/sasa-x', 'n.md', 'Claude wrote this meanwhile\n');
  const before = B.backups('before');
  assert.throws(() => B.engine.apply(plan.id, {}), (e) => e.code === 'STALE');
  assert.strictEqual(B.read('work/sasa-x', 'n.md'), 'Claude wrote this meanwhile\n');
  assert.strictEqual(B.backups('before'), before);
});

test('engine: daily backup runs once a day, a missed day runs later, an unchanged day is not stored twice', { skip }, () => {
  const A = device('mac');
  A.project('code/sasa-x', { 'MEMORY.md': '- [N](n.md)\n', 'n.md': 'note' });
  A.engine.updateSettings({ daily: { enabled: true, time: '12:00' } });
  A.setNow('2026-10-30T09:00:00');
  assert.ok(A.engine.runDailyIfDue().path, 'first start: a backup right away');
  assert.strictEqual(A.engine.runDailyIfDue().due, false);
  A.setNow('2026-10-30T12:05:00');
  assert.strictEqual(A.engine.runDailyIfDue().skipped, true, 'nothing changed since the morning');
  A.setNow('2026-11-02T08:00:00');
  A.write('code/sasa-x', 'n.md', 'note v2');
  const r = A.engine.runDailyIfDue();
  assert.ok(r.due && !r.skipped && fs.existsSync(r.path), 'missed days run at the next check');
  assert.strictEqual(A.backups('daily'), 2);
  assert.strictEqual(A.engine.library().filter((b) => b.kind === 'daily' && b.isMine).length, 2);
});

test('engine: 1.x settings and history are carried over', () => {
  const D = device('old');
  fs.mkdirSync(D.state, { recursive: true });
  const repos = path.join(D.home, 'GitHub');
  fs.writeFileSync(path.join(D.state, 'config.json'), JSON.stringify({ deviceId: 'old-id', deviceName: 'Old Mac', reposRoot: repos, prefix: 'sasa' }));
  fs.writeFileSync(path.join(D.state, 'history.json'), JSON.stringify({ version: 1, keys: { 'memory/sasa-a/x.md': ['h1'], 'workspace/workspaces/a.code-workspace': ['h2'] } }));
  const cfg = D.engine.settings();
  assert.strictEqual(cfg.deviceId, 'old-id');
  assert.strictEqual(cfg.deviceName, 'Old Mac');
  assert.deepStrictEqual(cfg.workspaceRoots, [repos]);
  const keys = Object.keys(JSON.parse(fs.readFileSync(path.join(D.state, 'history.json'), 'utf8')).keys).sort();
  assert.deepStrictEqual(keys, ['memory/sasa-a/x.md', 'workspace/github/workspaces/a.code-workspace']);
  assert.ok(fs.existsSync(path.join(D.state, 'config.v1.json')));
});

test('engine: a workspace file is made portable with a backup, and the change can be undone', { skip }, () => {
  const A = device('mac');
  const root = A.folder('code');
  A.folder('code/sasa-x', { git: GIT });
  A.folder('code/ws');
  const ws = path.join(root, 'ws', 'all.code-workspace');
  const original = `{\n  "folders": [ { "path": ${JSON.stringify(path.join(root, 'sasa-x'))} } ]\n}\n`;
  fs.writeFileSync(ws, original);
  A.engine.updateSettings({ workspaceRoots: [root] });
  const [r] = A.engine.workspaces();
  assert.strictEqual(r.files[0].fixable, true);
  assert.deepStrictEqual(A.engine.fixWorkspace({ root: r.key, rel: 'ws/all.code-workspace' }).changes, [{ from: path.join(root, 'sasa-x'), to: '../sasa-x' }]);
  assert.strictEqual(fs.readFileSync(ws, 'utf8'), original, 'preview writes nothing');
  const done = A.engine.fixWorkspace({ root: r.key, rel: 'ws/all.code-workspace', apply: true });
  assert.ok(fs.readFileSync(ws, 'utf8').includes('"path": "../sasa-x"'));
  A.engine.apply(A.engine.prepareUndo(done.activityId).id, {});
  assert.strictEqual(fs.readFileSync(ws, 'utf8'), original);
});
