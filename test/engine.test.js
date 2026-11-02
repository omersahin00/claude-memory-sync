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

test('engine: on a new install the daily backup is off, and the question stays open until it is answered', { skip }, () => {
  const A = device('mac');
  A.project('code/acme-x', { 'MEMORY.md': '- [N](n.md)\n', 'n.md': 'note' });
  const reopen = () => createEngine({ env: A.env, home: A.home, hostname: 'mac.local' });
  assert.deepStrictEqual(A.engine.settings().daily, { enabled: false, time: '12:00', keep: 30, ask: true });
  const st = A.engine.dailyStatus();
  assert.deepStrictEqual([st.enabled, st.ask, st.due, st.nextAt], [false, true, false, null]);
  assert.deepStrictEqual(A.engine.runDailyIfDue(), { due: false });
  assert.strictEqual(A.backups('daily'), 0, 'nothing is taken before the answer');

  // Closing the app or changing the time is no answer.
  assert.strictEqual(reopen().settings().daily.ask, true);
  A.engine.updateSettings({ daily: { time: '09:00' } });
  assert.deepStrictEqual(reopen().settings().daily, { enabled: false, time: '09:00', keep: 30, ask: true });

  // No: it stays off and is not asked again.
  A.engine.updateSettings({ daily: { enabled: false } });
  assert.deepStrictEqual(reopen().settings().daily, { enabled: false, time: '09:00', keep: 30, ask: false });
  assert.deepStrictEqual(A.engine.runDailyIfDue(), { due: false });

  // Yes, with a time: the first backup comes at the next check, the next one at that time.
  const Y = device('mac');
  Y.project('code/acme-x', { 'MEMORY.md': '- [N](n.md)\n', 'n.md': 'note' });
  Y.setNow('2026-10-30T15:00:00');
  Y.engine.updateSettings({ daily: { enabled: true, time: '09:00' } });
  assert.deepStrictEqual([Y.engine.settings().daily.enabled, Y.engine.settings().daily.time, Y.engine.settings().daily.ask], [true, '09:00', false]);
  assert.strictEqual(Y.engine.dailyStatus().due, true);
  assert.ok(Y.engine.runDailyIfDue().path);
  assert.strictEqual(new Date(Y.engine.dailyStatus().nextAt).getTime(), new Date('2026-10-31T09:00:00').getTime());
});

test('engine: the daily backup can be turned off and on at any time; off stops it and removes nothing', { skip }, () => {
  const { A, B } = pair();
  A.setNow('2026-10-30T09:00:00');
  A.engine.updateSettings({ daily: { enabled: true, time: '12:00' } });
  const first = A.engine.runDailyIfDue();
  assert.ok(first.path);

  A.engine.updateSettings({ daily: { enabled: false } });
  A.setNow('2026-10-31T13:00:00');
  A.write('code/acme-x', 'n.md', 'note v2\n');
  const off = A.engine.dailyStatus();
  assert.deepStrictEqual([off.enabled, off.due, off.nextAt], [false, false, null]);
  assert.strictEqual(new Date(off.lastAt).getTime(), new Date('2026-10-30T09:00:00').getTime(), 'the last one is still known');
  assert.deepStrictEqual(A.engine.runDailyIfDue(), { due: false });
  assert.strictEqual(A.backups('daily'), 1);
  assert.ok(fs.existsSync(first.path), 'turning it off deletes nothing');
  assert.ok(A.engine.createBackup('manual').path, 'a backup by hand still works');
  assert.strictEqual(createEngine({ env: A.env, home: A.home, hostname: 'mac.local' }).settings().daily.enabled, false, 'still off after a restart');

  // On a device that has it off, what is written is still backed up first: Undo depends on it.
  assert.strictEqual(B.engine.settings().daily.enabled, false);
  assert.ok(fs.existsSync(B.engine.apply(B.engine.prepare({ bundlePath: send(A, B) }).id, {}).backupPath));
  assert.strictEqual(B.backups('daily'), 0);

  // On again: the day missed comes at the next check, then it goes on at its time.
  A.engine.updateSettings({ daily: { enabled: true } });
  const on = A.engine.dailyStatus();
  assert.deepStrictEqual([on.enabled, on.due, on.time], [true, true, '12:00']);
  assert.ok(A.engine.runDailyIfDue().path);
  assert.strictEqual(A.backups('daily'), 2);
  assert.strictEqual(new Date(A.engine.dailyStatus().nextAt).getTime(), new Date('2026-11-01T12:00:00').getTime());

  // Turned on again after today's: nothing until its time.
  A.engine.updateSettings({ daily: { enabled: false } });
  A.engine.updateSettings({ daily: { enabled: true } });
  assert.strictEqual(A.engine.dailyStatus().due, false);
});

test('engine: an update keeps the daily backup of an existing install and does not ask', { skip }, () => {
  const saved = (name, daily) => {
    const D = device(name);
    D.project('code/acme-x', { 'MEMORY.md': '- [N](n.md)\n', 'n.md': 'note' });
    fs.mkdirSync(D.state, { recursive: true });
    fs.writeFileSync(path.join(D.state, 'config.json'), JSON.stringify({ version: 2, deviceId: `${name}-id`, deviceName: name, workspaceRoots: [], ...(daily ? { daily } : {}) }));
    return D;
  };
  // As every version before the question wrote it: on from the old default, at a time the user may have changed.
  const on = saved('on', { enabled: true, time: '18:00', keep: 5 });
  assert.deepStrictEqual(on.engine.settings().daily, { enabled: true, time: '18:00', keep: 5, ask: false });
  assert.ok(on.engine.runDailyIfDue().path, 'its backups go on');
  on.engine.updateSettings({ deviceName: 'Renamed' });
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(on.state, 'config.json'), 'utf8')).daily, { enabled: true, time: '18:00', keep: 5, ask: false });

  const off = saved('off', { enabled: false, time: '12:00', keep: 30 });
  assert.deepStrictEqual(off.engine.settings().daily, { enabled: false, time: '12:00', keep: 30, ask: false }, 'turned off earlier: it stays off');

  // Settings that do not say anything about it never heard the question either.
  for (const D of [saved('none'), saved('time', { time: '07:00' })]) {
    assert.deepStrictEqual([D.engine.settings().daily.enabled, D.engine.settings().daily.ask], [false, true]);
    assert.deepStrictEqual(D.engine.runDailyIfDue(), { due: false });
  }
  assert.strictEqual(saved('kept', { time: '07:00' }).engine.settings().daily.time, '07:00');
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
  assert.deepStrictEqual([cfg.daily.enabled, cfg.daily.ask], [false, true], '1.x had no daily backup: asked like a new install');
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
  A.engine.updateSettings({ deviceName: 'Studio', language: 'de', theme: 'dark', workspaceRoots: [root], daily: { enabled: true } });
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
  assert.deepStrictEqual([R.settings().daily.enabled, R.settings().daily.ask], [false, true], 'and is asked about the daily backup');
  assert.throws(() => R.prepareFullRestore(path.join(A.home, 'Downloads', fs.readdirSync(path.join(A.home, 'Downloads'))[0])), { code: 'NOT_FULL' });

  const plan = R.prepareFullRestore(full.path);
  assert.deepStrictEqual([plan.remapped, plan.counts.replace, plan.counts.same, plan.backups.add], [false, 0, 0, before.backups.length]);
  assert.strictEqual(plan.counts.new, 6, 'four memory files, the workspace file and CLAUDE.md');
  const r = R.applyFullRestore(plan.id);
  assert.ok(r.verified && fs.existsSync(r.backupPath), 'the device was backed up first');

  const s = R.settings();
  assert.deepStrictEqual([s.deviceId, s.deviceName, s.language, s.theme, s.workspaceRoots], [before.id, 'Studio', 'de', 'dark', [root]]);
  assert.deepStrictEqual([s.daily.enabled, s.daily.ask], [true, false], 'the daily backup goes on as it was, and the question is gone');
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
  assert.deepStrictEqual(plan.items.map((i) => i.rel).sort(), ['MEMORY.md', 'n.md'], 'the memory was not chosen, but the chat brings it');
  const bDir = chatDir(B, 'Documents/GitHub/acme-x');
  assert.strictEqual(fs.readFileSync(path.join(bDir, `${CHAT}.jsonl`), 'utf8'), fs.readFileSync(path.join(chatDir(A, 'code/acme-x'), `${CHAT}.jsonl`), 'utf8'));
  for (const rel of [`${CHAT}/subagents/agent-1.jsonl`, `${CHAT}/custom-title.json`]) assert.ok(fs.existsSync(path.join(bDir, rel)), rel);
  assert.ok(fs.existsSync(path.join(B.claude, 'file-history', CHAT, 'abc@v1')));
  assert.deepStrictEqual([...fs.readFileSync(path.join(B.claude, 'uploads', CHAT, 'shot.png'))], [0, 1, 2, 255]);
  const prompt = JSON.parse(fs.readFileSync(path.join(B.claude, 'history.jsonl'), 'utf8').trim());
  assert.deepStrictEqual([prompt.sessionId, prompt.project], [CHAT, path.join(B.home, 'Documents/GitHub/acme-x')], 'the prompt history points to B\'s folder');
  const rec = JSON.parse(fs.readFileSync(path.join(B.desktop, 'claude-code-sessions', 'acct', 'org', 'local_aaaa.json'), 'utf8'));
  assert.deepStrictEqual([rec.cliSessionId, rec.cwd, rec.title], [CHAT, path.join(B.home, 'Documents/GitHub/acme-x'), 'Login bug']);
  assert.strictEqual(fs.readFileSync(path.join(bDir, 'memory', 'n.md'), 'utf8'), 'note\n', 'the chat\'s project memory came with it');

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

  // A chat brings its project's memory, even when the project is left out by name.
  A.engine.updateSettings({ backup: { chats: 'some', chatProjects: [], chatIds: [OTHER] } });
  const withChat = A.engine.bundleContents(A.engine.createBackup('manual').path);
  assert.deepStrictEqual(withChat.chatList.map((c) => c.id), [OTHER]);
  assert.ok(withChat.files.some((f) => f.location === 'project:desktop'), 'the left-out project\'s memory came with its chat');
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

test('engine: before the first-start explanation only the saved settings are read; then the folders are checked', { skip: skip || (process.getuid && process.getuid() === 0) }, () => {
  const A = device('mac');
  A.folder('Desktop');
  fs.chmodSync(A.folder('Downloads'), 0);
  assert.deepStrictEqual(A.engine.introStatus('build-1'), { done: false, language: null, theme: 'system' });
  assert.ok(!fs.existsSync(path.join(A.state, 'config.json')), 'nothing is set up (or looked for) before it');
  const access = A.engine.completeIntro('build-1');
  fs.chmodSync(path.join(A.home, 'Downloads'), 0o755);
  assert.deepStrictEqual(access.map((a) => [a.id, a.state]), [['desktop', 'ok'], ['documents', 'missing'], ['downloads', 'denied']]);
  assert.strictEqual(A.engine.introStatus('build-1').done, true);
  assert.strictEqual(A.engine.introStatus('build-2').done, false, 'a new build explains again');
});

test('engine: manual backups are all kept unless a number is set; then the oldest go', { skip }, () => {
  const A = device('mac');
  A.project('code/acme-x', { 'MEMORY.md': '- [N](n.md) — note\n', 'n.md': 'note\n' }, { git: GIT });
  for (const m of ['00', '01', '02']) {
    A.setNow(`2026-10-30T10:${m}:00`);
    A.engine.createBackup('manual');
  }
  assert.strictEqual(A.backups('manual'), 3, 'none is deleted by default');
  A.engine.updateSettings({ keepManual: 2 });
  A.setNow('2026-10-30T10:03:00');
  A.engine.createBackup('manual');
  assert.strictEqual(A.backups('manual'), 2);
});


// The Claude desktop app's sidebar groups. Its data folder is named Claude here, as in the app, so a session that had no
// folder (a scratch session) is one, as on a real device.
const THIRD = '33333333-3333-4333-8333-333333333333';
const FOURTH = '44444444-4444-4444-8444-444444444444';
const SCRATCH = 'Library/Application Support/Claude/scratch-workspaces/acct/org/scratch-2026-09-22-4b56e5';
function desktopApp(d, prefs) {
  d.desktop = path.join(d.home, 'Library', 'Application Support', 'Claude');
  d.env.CLAUDE_DESKTOP_DIR = d.desktop;
  fs.mkdirSync(path.join(d.desktop, 'claude-code-sessions', 'acct', 'org'), { recursive: true });
  fs.writeFileSync(path.join(d.desktop, 'claude_desktop_config.json'), JSON.stringify({ coworkUserFilesPath: '/x', preferences: { epitaxyPrefs: prefs } }, null, 2));
}
const record = (d, name, fields) => fs.writeFileSync(path.join(d.desktop, 'claude-code-sessions', 'acct', 'org', `${name}.json`), JSON.stringify({ sessionId: name, ...fields }));
const desktopPrefs = (d) => JSON.parse(fs.readFileSync(path.join(d.desktop, 'claude_desktop_config.json'), 'utf8')).preferences.epitaxyPrefs;
const sections = (names) => ({ 'acct/org': { sections: [{ id: 'pinned', kind: 'pinned', v: 2, name: '', order: 0 }, ...names.map(([id, name], i) => ({ id, kind: 'manual', v: 2, name, order: i + 1, sortBy: 'recency', ascending: false, show: { sideChats: false }, collapsed: false, shown: true, members: [] })), { id: 'sessions', kind: 'sessions', v: 2, name: '', order: names.length + 1, groupBy: 'none' }] } });

test('engine: chats go with their Claude desktop group, a scratch session gets its folder, and the group is set up while the app is closed', { skip }, () => {
  const A = device('mac');
  desktopApp(A, {
    'dframe-group-scopes': { 'acct/org': { groups: [{ id: 'cg-work', name: 'Work', mode: 'code' }], assignments: { 'code:local_aaaa': 'cg-work', 'code:local_cccc': 'cg-work' }, order: { 'cg-work': ['code:local_aaaa', 'code:local_cccc'] } } },
    'dframe-code-sections': sections([['cg-work', 'Work']]),
  });
  A.folder(SCRATCH);
  A.folder('Desktop');
  chatOn(A, SCRATCH, CHAT, ['Many things']);
  chatOn(A, SCRATCH, OTHER, ['A side question']);
  chatOn(A, SCRATCH, THIRD, ['How it began']);
  chatOn(A, 'Desktop', FOURTH, ['The API']);
  record(A, 'local_aaaa', { cliSessionId: CHAT, cwd: path.join(A.home, SCRATCH), title: 'Many things', priorCliSessionIds: [THIRD] });
  record(A, 'local_bbbb', { cliSessionId: OTHER, cwd: path.join(A.home, SCRATCH), title: 'Side chat', forkedFromSessionId: 'local_aaaa' });
  record(A, 'local_cccc', { cliSessionId: FOURTH, cwd: path.join(A.home, 'Desktop'), title: 'API work' });

  // A scratch folder whose session was moved into a folder: found by its Claude folder name, named after the session.
  const MOVED = 'Library/Application Support/Claude/scratch-workspaces/87b66e6c-ef21-4f60-b43f-c011c048a29b/294c1317-ad1f-4b25-9f6d-bc88412e85b2/scratch-2026-10-09-9a7331';
  fs.mkdirSync(path.join(A.claude, 'projects', P.encodeProjectDir(path.join(A.home, MOVED)), 'memory'), { recursive: true });
  fs.writeFileSync(path.join(A.claude, 'projects', P.encodeProjectDir(path.join(A.home, MOVED)), 'memory', 'MEMORY.md'), '- [Plan](plan.md)\n');
  record(A, 'local_dddd', { cliSessionId: OTHER.replace('2222', '5555'), cwd: path.join(A.home, 'Desktop'), title: 'Planning', scratchCarried: { from: [path.join(A.home, MOVED)], to: path.join(A.home, 'Desktop') } });
  const moved = A.engine.projects().projects.find((p) => p.name === 'scratch-2026-10-09-9a7331');
  assert.deepStrictEqual([moved.cwd, moved.isScratch, moved.title, moved.movedTo], [path.join(A.home, MOVED), true, 'Planning', path.join(A.home, 'Desktop')]);
  assert.strictEqual(A.engine.chats().find((p) => p.isScratch).title, 'Many things', 'a scratch folder is named after its session');

  // Each chat with its group: a side chat and an earlier part go with their session.
  const listed = Object.fromEntries(A.engine.chats().flatMap((p) => p.chats.map((c) => [c.id, c.group && c.group.name])));
  assert.deepStrictEqual(listed, { [CHAT]: 'Work', [OTHER]: 'Work', [THIRD]: 'Work', [FOURTH]: 'Work' });
  A.engine.updateSettings({ backup: { chats: 'some', chatGroups: ['cg-work'] } });
  assert.strictEqual(A.engine.createBackup('manual').chats, 4, 'a group in the backup settings takes all of its chats');

  const B = device('mac2');
  desktopApp(B, {
    'dframe-group-scopes': { 'acct/org': { groups: [{ id: 'cg-home', name: 'Home', mode: 'code' }], assignments: { 'code:local_mine': 'cg-home' }, order: { 'cg-home': ['code:local_mine'] } } },
    'dframe-code-sections': sections([['cg-home', 'Home']]),
    other: { kept: true },
  });
  B.folder('Desktop');
  B.folder('Downloads');
  const bundle = A.engine.exportBundle({ outDir: path.join(B.home, 'Downloads'), selection: { projects: [], workspaces: [], claude: false, chats: [CHAT, OTHER, THIRD, FOURTH] } }).path;
  const configBefore = fs.readFileSync(path.join(B.desktop, 'claude_desktop_config.json'), 'utf8');

  // While the app runs: the chats come, the scratch session gets the same scratch folder in B's app, the group waits.
  B.env.CMS_DESKTOP_RUNNING = '1';
  let plan = B.engine.prepare({ bundlePath: bundle });
  const scratch = plan.matches.find((m) => m.remote.scratch);
  assert.deepStrictEqual([scratch.status, scratch.how, scratch.include, scratch.remote.title], ['create', 'scratch', true, 'Many things']);
  assert.deepStrictEqual(plan.chats.map((c) => [c.id, c.group]).sort(), [[CHAT, 'Work'], [OTHER, null], [THIRD, null], [FOURTH, 'Work']].sort());
  assert.deepStrictEqual(B.engine.resolvePlan(plan.id, {}).groups, { names: ['Work'], state: 'running' });
  let done = B.engine.apply(plan.id, {});
  assert.deepStrictEqual([done.chats, done.groups], [4, { names: ['Work'], state: 'running' }]);
  const folder = path.join(B.home, SCRATCH);
  assert.ok(fs.statSync(folder).isDirectory(), 'the scratch folder is made');
  assert.ok(fs.existsSync(path.join(chatDir(B, SCRATCH), `${CHAT}.jsonl`)));
  const rec = JSON.parse(fs.readFileSync(path.join(B.desktop, 'claude-code-sessions', 'acct', 'org', 'local_aaaa.json'), 'utf8'));
  assert.deepStrictEqual([rec.cwd, rec.title], [folder, 'Many things']);
  assert.strictEqual(fs.readFileSync(path.join(B.desktop, 'claude_desktop_config.json'), 'utf8'), configBefore, 'the app\'s settings are not touched while it runs');

  // Opened again with the app closed: only the group is set up, after a copy of the settings file is kept.
  B.env.CMS_DESKTOP_RUNNING = '0';
  plan = B.engine.prepare({ bundlePath: bundle });
  assert.deepStrictEqual(plan.chats.map((c) => c.status), ['same', 'same', 'same', 'same']);
  assert.deepStrictEqual(B.engine.resolvePlan(plan.id, {}).groups, { names: ['Work'], state: 'set' });
  done = B.engine.apply(plan.id, {});
  assert.deepStrictEqual([done.nothing, done.groups.names, done.groups.state], [false, ['Work'], 'set']);
  const prefs = desktopPrefs(B);
  const scope = prefs['dframe-group-scopes']['acct/org'];
  assert.deepStrictEqual(scope.groups.map((g) => g.name), ['Home', 'Work']);
  assert.deepStrictEqual(scope.assignments, { 'code:local_mine': 'cg-home', 'code:local_aaaa': 'cg-work', 'code:local_cccc': 'cg-work' }, 'a side chat stays with its session, as on A');
  assert.deepStrictEqual(prefs['dframe-code-sections']['acct/org'].sections.map((s) => `${s.order}:${s.name || s.id}`), ['0:pinned', '1:Home', '2:Work', '3:sessions']);
  assert.deepStrictEqual(prefs.other, { kept: true });
  const copies = fs.readdirSync(path.join(B.state, 'claude-desktop'));
  assert.deepStrictEqual(copies.map((x) => path.join(B.state, 'claude-desktop', x)), [done.groups.copy]);
  assert.strictEqual(fs.readFileSync(done.groups.copy, 'utf8'), configBefore);

  // Once more: nothing left to do. A session moved to another group here stays there.
  plan = B.engine.prepare({ bundlePath: bundle });
  assert.deepStrictEqual(B.engine.resolvePlan(plan.id, {}).groups, { names: ['Work'], state: 'already' });
  assert.strictEqual(B.engine.apply(plan.id, {}).nothing, true);
});

// ---- Changing the backup folder ----------------------------------------------------------------------
// Review, read through what is in the folder, apply, and move until done, the way the window does it.
async function changeFolder(d, request, choices = {}) {
  const plan = d.engine.reviewBackupFolder(request);
  for (const f of plan.found) await d.engine.inspectBackup(plan.id, f.path);
  const findings = d.engine.backupFolderFindings(plan.id, choices);
  const applied = d.engine.applyBackupFolder(plan.id, choices);
  let progress = null;
  for (let i = 0; i < applied.moving; i++) progress = await d.engine.moveNextBackup(plan.id);
  return { plan, findings, applied, progress };
}
const memsyncIn = (dir) => {
  const out = [];
  const visit = (at) => {
    if (!fs.existsSync(at)) return;
    for (const e of fs.readdirSync(at, { withFileTypes: true })) {
      if (e.isDirectory()) visit(path.join(at, e.name));
      else if (e.name.endsWith('.memsync')) out.push(path.relative(dir, path.join(at, e.name)));
    }
  };
  visit(dir);
  return out.sort();
};
function folderDevice(name = 'mac') {
  const d = device(name);
  d.project('code/acme-x', { 'MEMORY.md': '- [N](n.md) — note\n', 'n.md': 'note\n' }, { git: GIT });
  d.engine.updateSettings({ daily: { enabled: true } });
  return d;
}
const stateOf = (d) => JSON.parse(fs.readFileSync(path.join(d.state, 'state.json'), 'utf8'));
const configOf = (d) => JSON.parse(fs.readFileSync(path.join(d.state, 'config.json'), 'utf8'));
const makeRename = (fails) => {
  const real = fs.renameSync;
  fs.renameSync = (a, b) => {
    if (fails(a, b)) throw Object.assign(new Error('EXDEV: cross-device link not permitted'), { code: 'EXDEV' });
    return real(a, b);
  };
  return () => { fs.renameSync = real; };
};

test('backup folder: backups move along, verified, and everything that points to them follows', { skip }, async () => {
  const { A, B } = pair();
  B.engine.apply(B.engine.prepare({ bundlePath: send(A, B) }).id, {});
  const beforeImport = B.read('work/acme-x', 'n.md');
  A.write('code/acme-x', 'n.md', 'note v2\n');
  const done = B.engine.apply(B.engine.prepare({ bundlePath: send(A, B) }).id, {});
  B.setNow('2026-10-30T13:00:00');
  B.engine.updateSettings({ daily: { enabled: true } });
  const daily = B.engine.runDailyIfDue();
  B.setNow('2026-10-30T13:01:00');
  const manual = B.engine.createBackup('manual');
  const old = path.join(B.state, 'backups');
  const names = memsyncIn(old);
  assert.ok(names.length >= 4);
  const target = path.join(B.home, 'disk', 'backups');

  const { plan, applied, progress } = await changeFolder(B, { dir: target }, { move: true });
  assert.ok(plan.changed);
  assert.strictEqual(plan.moves.count, names.length, 'it finds them by itself');
  assert.deepStrictEqual(plan.moves.dirs.map((x) => x.dir), [old]);
  assert.strictEqual(applied.moving, names.length);
  assert.deepStrictEqual([progress.done, progress.moved, progress.left, progress.failures], [true, names.length, 0, []]);
  assert.deepStrictEqual(memsyncIn(target), names, 'the same files in the same places');
  assert.deepStrictEqual(memsyncIn(old), [], 'none is left behind');
  assert.strictEqual(B.engine.settings().device.backupDir, target);
  assert.strictEqual(B.engine.library().filter((b) => b.isMine && b.path.startsWith(target)).length, names.length);
  assert.deepStrictEqual(B.engine.backupsElsewhere().count, 0);

  // Undo finds the backup at its new place, and restores from it.
  const entry = B.engine.activity(50).find((e) => e.id === done.activityId);
  assert.ok(entry.undoable, 'undo still works');
  assert.ok(entry.backupPath.startsWith(target));
  B.engine.apply(B.engine.prepareUndo(done.activityId).id, {});
  assert.strictEqual(B.read('work/acme-x', 'n.md'), beforeImport);
  const row = B.engine.activity(50).find((e) => e.id === manual.activityId);
  assert.ok(row.path.startsWith(target));
  assert.ok(B.engine.bundleContents(row.path).stats.memoryFiles > 0);

  // The daily backup continues: nothing changed since the moved backup (but for the undo above), so its check still holds.
  assert.ok(stateOf(B).lastDaily.path.startsWith(target), `moved daily ${daily.path}`);
  const kinds = B.engine.activity(50).map((e) => e.type);
  assert.ok(kinds.includes('backup-folder') && kinds.includes('backup-move'));
  const move = B.engine.activity(50).find((e) => e.type === 'backup-move');
  assert.deepStrictEqual([move.ok, move.moved, move.left, move.from, move.to], [true, names.length, 0, [old], target]);
});

test('backup folder: a daily backup with nothing changed stays skipped after a move, and is written after a change without one', { skip }, async () => {
  const A = folderDevice();
  A.setNow('2026-10-30T13:00:00');
  assert.ok(!A.engine.runDailyIfDue().skipped);
  const moved = path.join(A.home, 'moved');
  await changeFolder(A, { dir: moved }, { move: true });
  A.setNow('2026-10-31T13:00:00');
  assert.strictEqual(A.engine.runDailyIfDue().skipped, true, 'the moved backup still counts');

  // Left behind: the new folder gets a backup of its own although nothing changed.
  const left = path.join(A.home, 'left');
  await changeFolder(A, { dir: left }, { move: false });
  A.setNow('2026-11-01T13:00:00');
  const r = A.engine.runDailyIfDue();
  assert.ok(!r.skipped && r.path.startsWith(left));
  assert.strictEqual(memsyncIn(moved).length, 1, 'the old one stays where it is');
});

test('backup folder: backups left behind stay in the list and can be moved at any time, also after stopping halfway', { skip }, async () => {
  const A = folderDevice();
  for (const m of ['00', '01', '02', '03']) {
    A.setNow(`2026-10-30T10:${m}:00`);
    A.engine.createBackup('manual');
  }
  const first = path.join(A.home, 'first');
  await changeFolder(A, { dir: first }, { move: true });
  const second = path.join(A.home, 'second');
  await changeFolder(A, { dir: second }, { move: false });
  assert.deepStrictEqual(configOf(A).formerBackupDirs, [first]);
  assert.strictEqual(memsyncIn(first).length, 4);
  assert.deepStrictEqual(A.engine.library().filter((b) => b.isMine).map((b) => path.dirname(path.dirname(b.path))), [first, first, first, first], 'still listed');
  const elsewhere = A.engine.backupsElsewhere();
  assert.deepStrictEqual([elsewhere.count, elsewhere.dirs.map((x) => x.dir), elsewhere.kinds], [4, [first], { manual: 4 }]);
  assert.ok(A.engine.fullBackupPreview().backups.count === 4, 'a full backup takes them too');

  // Move here, stopped halfway: what moved stays moved, the rest is still offered.
  const plan = A.engine.reviewBackupFolder();
  assert.deepStrictEqual([plan.changed, plan.to, plan.found, plan.moves.count], [false, second, [], 4]);
  assert.strictEqual(A.engine.applyBackupFolder(plan.id, { move: true }).moving, 4);
  await A.engine.moveNextBackup(plan.id);
  const stopped = A.engine.stopBackupMove(plan.id);
  assert.deepStrictEqual([stopped.moved, stopped.left, stopped.done], [1, 3, false]);
  assert.strictEqual(memsyncIn(second).length, 1);
  assert.strictEqual(memsyncIn(first).length, 3);
  assert.strictEqual(A.engine.backupsElsewhere().count, 3);
  assert.deepStrictEqual(configOf(A).formerBackupDirs, [first]);

  // A new engine, as after quitting the app in the middle of it: the same offer.
  const restarted = createEngine({ env: A.env, home: A.home, hostname: 'mac.local', now: () => new Date('2026-10-30T11:00:00') });
  assert.strictEqual(restarted.backupsElsewhere().count, 3);
  const again = restarted.reviewBackupFolder();
  restarted.applyBackupFolder(again.id, { move: true });
  for (let i = 0; i < 3; i++) await restarted.moveNextBackup(again.id);
  assert.strictEqual(memsyncIn(second).length, 4);
  assert.deepStrictEqual(memsyncIn(first), []);
  assert.deepStrictEqual(configOf(A).formerBackupDirs, [], 'an empty folder is no longer looked at');
  assert.strictEqual(restarted.backupsElsewhere().count, 0);
  assert.ok(!fs.existsSync(path.join(first, 'manual')), 'the empty folders of the app are gone');
});

test('backup folder: to another disk each file is copied, checked, and only then removed', { skip }, async () => {
  const A = folderDevice();
  A.setNow('2026-10-30T10:00:00');
  const b1 = A.engine.createBackup('manual');
  A.setNow('2026-10-30T10:01:00');
  const b2 = A.engine.createBackup('manual');
  const mtime = fs.statSync(b1.path).mtimeMs;
  const content = fs.readFileSync(b1.path);
  const target = path.join(A.home, 'usb');
  const crossing = (a, b) => a.startsWith(A.state) !== b.startsWith(A.state);
  const restore = makeRename(crossing);
  try {
    // A copy that goes wrong: the original stays, nothing is left next to the target, and the next one goes on.
    const plan = A.engine.reviewBackupFolder({ dir: target });
    A.engine.applyBackupFolder(plan.id, { move: true });
    const copyFile = fs.promises.copyFile;
    fs.promises.copyFile = async () => { throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' }); };
    let p;
    try {
      p = await A.engine.moveNextBackup(plan.id);
    } finally {
      fs.promises.copyFile = copyFile;
    }
    assert.deepStrictEqual([p.done, p.moved, p.left, p.failures.map((f) => f.code)], [false, 0, 2, ['ENOSPC']]);
    assert.ok(fs.existsSync(b1.path) && fs.existsSync(b2.path));
    assert.deepStrictEqual(fs.readdirSync(path.join(target, 'manual')), [], 'no half-written file');

    // A copy that differs: the same.
    fs.promises.copyFile = async (a, b) => {
      await copyFile(a, b);
      fs.appendFileSync(b, 'x');
    };
    try {
      p = await A.engine.moveNextBackup(plan.id);
    } finally {
      fs.promises.copyFile = copyFile;
    }
    assert.deepStrictEqual([p.done, p.moved, p.left, p.failures.map((f) => f.code)], [true, 0, 2, ['ENOSPC', 'COPY_MISMATCH']], 'everything was tried');
    assert.ok(fs.existsSync(b1.path) && fs.existsSync(b2.path));
    assert.deepStrictEqual(fs.readdirSync(path.join(target, 'manual')), []);
    assert.strictEqual(A.engine.backupsElsewhere().count, 2);

    // Tried again: those two, one at a time.
    p = await A.engine.moveNextBackup(plan.id, { retry: true });
    assert.deepStrictEqual([p.done, p.moved, p.left, p.failures], [false, 1, 1, []]);
    p = await A.engine.moveNextBackup(plan.id);
    assert.deepStrictEqual([p.done, p.moved, p.left, p.failures], [true, 2, 0, []]);
  } finally {
    restore();
  }
  const moved = path.join(target, 'manual', path.basename(b1.path));
  assert.ok(!fs.existsSync(b1.path) && !fs.existsSync(b2.path));
  assert.ok(fs.readFileSync(moved).equals(content));
  assert.strictEqual(Math.round(fs.statSync(moved).mtimeMs), Math.round(mtime), 'it keeps its time');
  assert.deepStrictEqual(memsyncIn(target).length, 2);
});

test('backup folder: one file that cannot be moved does not hold up the others, and giving up leaves it listed', { skip }, async () => {
  const A = folderDevice();
  for (const m of ['00', '01', '02']) {
    A.setNow(`2026-10-30T10:${m}:00`);
    A.engine.createBackup('manual');
  }
  const old = path.join(A.state, 'backups', 'manual');
  const stuck = fs.readdirSync(old).sort()[0];
  const target = path.join(A.home, 'target');
  const plan = A.engine.reviewBackupFolder({ dir: target });
  assert.strictEqual(A.engine.applyBackupFolder(plan.id, { move: true }).moving, 3);
  // To another disk, where the first one cannot be read.
  const restore = makeRename((a, b) => a.startsWith(A.state) !== b.startsWith(A.state));
  const copyFile = fs.promises.copyFile;
  fs.promises.copyFile = async (a, b) => {
    if (path.basename(a) === stuck) throw Object.assign(new Error('EIO: i/o error'), { code: 'EIO' });
    return copyFile(a, b);
  };
  let p;
  try {
    for (let i = 0; i < 3; i++) p = await A.engine.moveNextBackup(plan.id);
  } finally {
    fs.promises.copyFile = copyFile;
    restore();
  }
  assert.deepStrictEqual([p.done, p.moved, p.left, p.failures.map((f) => f.name)], [true, 2, 1, [stuck]]);
  assert.deepStrictEqual(fs.readdirSync(old), [stuck], 'the file stays where it is, the others went');
  assert.strictEqual(fs.readdirSync(path.join(target, 'manual')).length, 2);
  const ended = A.engine.stopBackupMove(plan.id);
  assert.deepStrictEqual([ended.moved, ended.left], [2, 1]);
  assert.strictEqual(A.engine.backupsElsewhere().count, 1);
  const row = A.engine.activity(50).find((e) => e.type === 'backup-move');
  assert.deepStrictEqual([row.ok, row.moved, row.left, row.error], [false, 2, 1, 'EIO: i/o error']);
  assert.throws(() => A.engine.stopBackupMove(plan.id), (e) => e.code === 'PLAN_EXPIRED');
  await assert.rejects(A.engine.moveNextBackup(plan.id), (e) => e.code === 'PLAN_EXPIRED');

  // It can be moved later like any other.
  const again = A.engine.reviewBackupFolder();
  A.engine.applyBackupFolder(again.id, { move: true });
  assert.strictEqual((await A.engine.moveNextBackup(again.id)).done, true);
  assert.strictEqual(A.engine.backupsElsewhere().count, 0);
});

test('backup folder: the same backup in the new folder is not kept twice, another one with the same name is not overwritten', { skip }, async () => {
  const A = folderDevice();
  A.setNow('2026-10-30T10:00:00');
  const same = A.engine.createBackup('manual');
  A.setNow('2026-10-30T10:01:00');
  const clash = A.engine.createBackup('manual');
  const target = path.join(A.home, 'target');
  fs.mkdirSync(path.join(target, 'manual'), { recursive: true });
  fs.copyFileSync(same.path, path.join(target, 'manual', path.basename(same.path)));
  A.setNow('2026-10-30T10:02:00');
  const otherContent = A.engine.createBackup('manual');
  fs.renameSync(otherContent.path, path.join(target, 'manual', path.basename(clash.path)));
  const there = fs.readFileSync(path.join(target, 'manual', path.basename(clash.path)));
  const mine = fs.readFileSync(clash.path);
  assert.ok(!there.equals(mine), 'a different file under the same name');

  await changeFolder(A, { dir: target }, { move: true });
  const stem = path.basename(clash.path, '.memsync');
  assert.deepStrictEqual(fs.readdirSync(path.join(target, 'manual')).sort(), [path.basename(same.path), `${stem}-2.memsync`, `${stem}.memsync`].sort());
  assert.ok(fs.readFileSync(path.join(target, 'manual', `${stem}.memsync`)).equals(there), 'what was there stays');
  assert.ok(fs.readFileSync(path.join(target, 'manual', `${stem}-2.memsync`)).equals(mine));
  assert.ok(!fs.existsSync(same.path) && !fs.existsSync(clash.path));
  assert.ok(A.engine.activity(50).find((e) => e.id === clash.activityId).path.endsWith(`${stem}-2.memsync`), 'the log follows the new name');
});

test('backup folder: a linked folder or another spelling is the same folder, and no backup is lost through it', { skip }, async () => {
  const A = folderDevice();
  A.setNow('2026-10-30T10:00:00');
  const real = path.join(A.home, 'real');
  await changeFolder(A, { dir: real });
  const b = A.engine.createBackup('manual');
  const link = path.join(A.home, 'link');
  fs.symlinkSync(real, link);

  const plan = A.engine.reviewBackupFolder({ dir: link });
  assert.deepStrictEqual([plan.changed, plan.to, plan.moves.count], [false, real, 0]);
  for (const f of plan.found) await A.engine.inspectBackup(plan.id, f.path);
  assert.strictEqual(A.engine.applyBackupFolder(plan.id, { move: true }).moving, 0);
  assert.ok(fs.existsSync(b.path));

  // One kind folder of the old backup folder is a link into the new one: the "copy" there is the file itself.
  const other = path.join(A.home, 'other');
  fs.mkdirSync(other);
  fs.symlinkSync(path.join(real, 'manual'), path.join(other, 'manual'));
  const r = await changeFolder(A, { dir: other }, { move: true });
  assert.ok(fs.existsSync(b.path), 'the only copy is still there');
  assert.deepStrictEqual([r.applied.moving, r.progress.skipped, r.progress.moved], [1, 1, 0]);
  assert.strictEqual(fs.readdirSync(path.join(real, 'manual')).length, 1);
});

test('backup folder: backups already in the folder are read through first; this device\'s join the history and backing up continues from them', { skip }, async () => {
  const A = folderDevice();
  // Taken earlier, then moved to the other disk by hand and forgotten by the app.
  const disk = path.join(A.home, 'disk');
  fs.mkdirSync(disk);
  A.setNow('2026-10-29T13:00:00');
  const d1 = A.engine.runDailyIfDue();
  A.setNow('2026-10-30T13:00:00');
  A.write('code/acme-x', 'n.md', 'note 2\n');
  const d2 = A.engine.runDailyIfDue();
  A.setNow('2026-10-30T14:00:00');
  const m = A.engine.createBackup('manual');
  fs.renameSync(path.join(A.state, 'backups'), path.join(disk, 'backups'));
  const lines = fs.readFileSync(path.join(A.state, 'activity.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.ok(lines.every((e) => e.path && !fs.existsSync(e.path)), 'the log points to where they were');
  // The log of those runs is gone too, as after a reinstall that kept the device id.
  fs.rmSync(path.join(A.state, 'activity.jsonl'));
  fs.writeFileSync(path.join(A.state, 'state.json'), '{}');
  let clock = new Date('2026-10-31T09:00:00');
  const E = createEngine({ env: A.env, home: A.home, hostname: 'mac.local', now: () => new Date(clock) });
  assert.strictEqual(E.dailyStatus().due, true, 'as far as it knows, a daily backup has never been taken');

  const plan = E.reviewBackupFolder({ dir: path.join(disk, 'backups') });
  assert.strictEqual(plan.found.length, 3);
  assert.throws(() => E.applyBackupFolder(plan.id, {}), (e) => e.code === 'NOT_INSPECTED', 'not used before it is read through');
  for (const f of plan.found) assert.strictEqual((await E.inspectBackup(plan.id, f.path)).state, 'mine');
  const findings = E.backupFolderFindings(plan.id);
  assert.deepStrictEqual([findings.pending, findings.mine.count, findings.other, findings.damaged], [0, 3, [], []]);
  assert.ok(Date.parse(findings.mine.last) === new Date('2026-10-30T14:00:00').getTime());
  const applied = E.applyBackupFolder(plan.id, {});
  assert.strictEqual(applied.adopted, 3);

  const rows = E.activity(50);
  assert.deepStrictEqual(rows.filter((e) => e.adopted).map((e) => [e.kind, path.basename(e.path)]), [['manual', path.basename(m.path)], ['daily', path.basename(d2.path)], ['daily', path.basename(d1.path)]], 'newest first, at their own dates');
  assert.ok(rows.filter((e) => e.adopted).every((e) => e.stats.memoryFiles === 2 && fs.existsSync(e.path)));
  assert.strictEqual(rows[0].type, 'backup-folder', 'the change itself is the newest entry');

  // Continues from there: it is known when the last daily was and what it held.
  const st = E.dailyStatus();
  assert.strictEqual(new Date(st.lastAt).getTime(), new Date('2026-10-30T13:00:00').getTime());
  assert.strictEqual(st.due, false, 'yesterday\'s has been taken; today\'s comes at its time');
  clock = new Date('2026-10-31T12:05:00');
  const next = E.runDailyIfDue();
  assert.deepStrictEqual([next.due, next.skipped], [true, true], 'nothing changed since that backup, so no new file');
  assert.ok(next.path.includes(path.join('disk', 'backups')));
  assert.strictEqual(E.library().filter((b) => b.isMine).length, 3);

  // Choosing it again adds nothing twice.
  const again = await (async () => {
    const p = E.reviewBackupFolder({ dir: path.join(disk, 'backups') });
    for (const f of p.found) await E.inspectBackup(p.id, f.path);
    return E.applyBackupFolder(p.id, {});
  })();
  assert.strictEqual(again.adopted, 0);
  assert.strictEqual(E.activity(50).filter((e) => e.adopted).length, 3);
});

test('backup folder: moved by hand, the log finds the backups in the new place and undo keeps working', { skip }, async () => {
  const { A, B } = pair();
  B.engine.apply(B.engine.prepare({ bundlePath: send(A, B) }).id, {});
  A.write('code/acme-x', 'n.md', 'note v2\n');
  const done = B.engine.apply(B.engine.prepare({ bundlePath: send(A, B) }).id, {});
  assert.ok(B.engine.activity(50).find((e) => e.id === done.activityId).undoable);
  const disk = path.join(B.home, 'disk');
  fs.mkdirSync(disk);
  fs.renameSync(path.join(B.state, 'backups'), path.join(disk, 'backups'));
  assert.ok(!B.engine.activity(50).find((e) => e.id === done.activityId).undoable, 'the file is gone from where the log says');
  await changeFolder(B, { dir: path.join(disk, 'backups') });
  assert.ok(B.engine.activity(50).find((e) => e.id === done.activityId).undoable);
  assert.strictEqual(B.engine.apply(B.engine.prepareUndo(done.activityId).id, {}).verified, true);
});

test('backup folder: other devices\' backups and damaged files are listed, not used, not touched and never make room', { skip }, async () => {
  const A = folderDevice();
  const W = device('win');
  W.project('code/other', { 'MEMORY.md': '- x\n' });
  W.setNow('2026-10-20T10:00:00');
  W.engine.updateSettings({ daily: { enabled: true } });
  W.engine.runDailyIfDue();
  W.setNow('2026-10-21T10:00:00');
  W.engine.createBackup('manual');
  const shared = path.join(A.home, 'shared');
  fs.cpSync(path.join(W.state, 'backups'), shared, { recursive: true });
  const theirs = memsyncIn(shared);
  // Damaged in three ways: not a bundle, cut short, one memory file changed inside.
  fs.mkdirSync(path.join(shared, 'daily'), { recursive: true });
  fs.writeFileSync(path.join(shared, 'daily', '20260101-000000-daily.memsync'), 'not a bundle');
  A.setNow('2026-10-25T10:00:00');
  const own = A.engine.createBackup('manual');
  const whole = fs.readFileSync(own.path);
  fs.writeFileSync(path.join(shared, 'manual', '20260102-000000-manual.memsync'), whole.subarray(0, whole.length >> 1));
  const raw = JSON.parse(require('zlib').gunzipSync(whole).toString('utf8'));
  const key = Object.keys(raw.files).find((k) => k.endsWith('n.md'));
  raw.files[key].data = Buffer.from('changed').toString('base64');
  raw.files[key].size = 7;
  fs.writeFileSync(path.join(shared, 'manual', '20260103-000000-manual.memsync'), require('zlib').gzipSync(Buffer.from(JSON.stringify(raw))));
  // From a newer version of the app.
  raw.version = 99;
  fs.writeFileSync(path.join(shared, 'manual', '20260104-000000-manual.memsync'), require('zlib').gzipSync(Buffer.from(JSON.stringify(raw))));
  const everything = memsyncIn(shared);

  const { findings, applied } = await changeFolder(A, { dir: shared }, { move: true });
  assert.deepStrictEqual(findings.other.map((x) => [x.name, x.count]), [['win', 2]]);
  assert.deepStrictEqual(findings.earlier, []);
  assert.strictEqual(findings.mine.count, 0);
  assert.deepStrictEqual(findings.damaged.map((x) => [x.name, x.code]), [
    ['20260101-000000-daily.memsync', 'BUNDLE_CORRUPT'],
    ['20260102-000000-manual.memsync', 'BUNDLE_CORRUPT'],
    ['20260103-000000-manual.memsync', 'BUNDLE_INTEGRITY'],
    ['20260104-000000-manual.memsync', 'BUNDLE_VERSION'],
  ]);
  assert.strictEqual(applied.adopted, 0, 'nothing of another device goes into this device\'s history');
  assert.strictEqual(A.engine.activity(50).filter((e) => e.adopted).length, 0);
  const lib = A.engine.library();
  assert.ok(theirs.every((rel) => lib.find((b) => b.path === path.join(shared, rel) && !b.isMine && !b.error)), 'the other device\'s can still be imported');
  assert.ok(lib.find((b) => b.name === '20260103-000000-manual.memsync').error, 'a file that failed is not offered as a backup');

  // Keeping one of each: only this device's own go.
  A.engine.updateSettings({ keepManual: 1, daily: { keep: 1 } });
  for (const day of ['10-30', '10-31', '11-01']) {
    A.setNow(`2026-${day}T13:00:00`);
    A.write('code/acme-x', 'n.md', `note ${day}\n`);
    A.engine.createBackup('manual');
    assert.ok(A.engine.runDailyIfDue().path);
  }
  const after = memsyncIn(shared);
  assert.ok(everything.every((rel) => rel === path.join('manual', path.basename(own.path)) || after.includes(rel)), 'all of them are still there');
  const mineThere = A.engine.library().filter((b) => b.isMine && b.kind === 'manual' && b.path.startsWith(shared));
  assert.strictEqual(mineThere.length, 1);
  assert.ok(A.engine.fullBackupPreview().backups.count < after.length, 'a full backup does not take another device\'s backups');
});

test('backup folder: a damaged part of a backup with chats is found when reading it through', { skip }, async () => {
  const A = device('mac');
  A.project('code/acme-x', { 'MEMORY.md': '- [N](n.md)\n', 'n.md': 'note\n' }, { git: GIT });
  const dir = path.join(A.claude, 'projects', P.encodeProjectDir(path.join(A.home, 'code/acme-x')));
  const id = '11111111-1111-4111-8111-111111111111';
  fs.writeFileSync(path.join(dir, `${id}.jsonl`), `${JSON.stringify({ type: 'user', sessionId: id, cwd: path.join(A.home, 'code/acme-x'), message: { role: 'user', content: 'hi '.repeat(2000) } })}\n`);
  A.engine.updateSettings({ backup: { chats: 'all' } });
  const b = A.engine.createBackup('manual');
  assert.strictEqual(b.chats, 1);
  const disk = path.join(A.home, 'disk');
  fs.mkdirSync(path.join(disk, 'manual'), { recursive: true });
  const good = path.join(disk, 'manual', path.basename(b.path));
  const bad = path.join(disk, 'manual', `x-${path.basename(b.path)}`);
  fs.copyFileSync(b.path, good);
  const buf = fs.readFileSync(b.path);
  buf[20] ^= 0xff; // inside the first part; the header at the end is fine
  fs.writeFileSync(bad, buf);
  assert.ok(A.engine.library().find((x) => x.path === b.path && !x.error));

  const plan = A.engine.reviewBackupFolder({ dir: disk });
  assert.strictEqual((await A.engine.inspectBackup(plan.id, good)).state, 'mine');
  assert.strictEqual((await A.engine.inspectBackup(plan.id, bad)).state, 'damaged');
  assert.deepStrictEqual(A.engine.backupFolderFindings(plan.id).damaged.map((x) => x.code), ['BUNDLE_INTEGRITY']);
});

test('backup folder: backups of an earlier install on this computer can be taken over', { skip }, async () => {
  const A = folderDevice();
  A.setNow('2026-10-29T13:00:00');
  A.engine.runDailyIfDue();
  A.setNow('2026-10-30T14:00:00');
  const m = A.engine.createBackup('manual');
  const disk = path.join(A.home, 'disk');
  fs.renameSync(path.join(A.state, 'backups'), disk);
  const oldId = A.engine.settings().deviceId;
  // Reinstalled: the app's data is gone, a new device id; same computer, same home folder.
  fs.rmSync(A.state, { recursive: true });
  const make = () => createEngine({ env: A.env, home: A.home, hostname: 'MAC', now: () => new Date('2026-10-31T09:00:00') });
  const E = make();
  assert.notStrictEqual(E.settings().deviceId, oldId);

  // Without taking them over they are another device's.
  let plan = E.reviewBackupFolder({ dir: disk });
  for (const f of plan.found) assert.strictEqual((await E.inspectBackup(plan.id, f.path)).state, 'earlier');
  const findings = E.backupFolderFindings(plan.id);
  assert.deepStrictEqual(findings.earlier.map((d) => [d.id, d.count]), [[oldId, 2]]);
  assert.strictEqual(E.applyBackupFolder(plan.id, { adopt: [] }).adopted, 0);
  assert.ok(E.library().every((b) => !b.isMine));
  assert.strictEqual(E.dailyStatus().lastAt, null);

  // Taken over: they are this device's backups, in the list, the history and the daily backup.
  plan = E.reviewBackupFolder({ dir: disk });
  for (const f of plan.found) await E.inspectBackup(plan.id, f.path);
  assert.strictEqual(E.applyBackupFolder(plan.id, { adopt: [oldId] }).adopted, 2);
  assert.ok(E.library().every((b) => b.isMine));
  assert.strictEqual(E.openBundle(m.path.replace(path.join(A.state, 'backups'), disk)).isMine, true);
  assert.strictEqual(new Date(E.dailyStatus().lastAt).getTime(), new Date('2026-10-29T13:00:00').getTime());
  assert.strictEqual(E.activity(50).filter((e) => e.adopted).length, 2);
  const res = E.prepare({ bundlePath: m.path.replace(path.join(A.state, 'backups'), disk), mode: 'restore' });
  assert.ok(res.matches.every((x) => x.how === 'self' || x.how === 'claude'), 'restored like one of its own');
  assert.deepStrictEqual(configOf(A).earlierDeviceIds, [oldId]);

  // The limit counts them now, and says so beforehand.
  E.updateSettings({ daily: { keep: 1 }, keepManual: 1 });
  const p2 = E.reviewBackupFolder({ dir: disk });
  for (const f of p2.found) await E.inspectBackup(p2.id, f.path);
  assert.deepStrictEqual(E.backupFolderFindings(p2.id).retention, []);
  const extra = path.join(disk, 'manual', '20261030-150000-manual.memsync');
  fs.copyFileSync(m.path.replace(path.join(A.state, 'backups'), disk), extra);
  const p3 = E.reviewBackupFolder({ dir: disk });
  for (const f of p3.found) await E.inspectBackup(p3.id, f.path);
  assert.deepStrictEqual(E.backupFolderFindings(p3.id).retention, [{ kind: 'manual', keep: 1, total: 2, extra: 2 }]);
});

test('backup folder: a look-alike of another computer is not taken for this one', { skip }, async () => {
  const A = folderDevice();
  A.setNow('2026-10-29T13:00:00');
  A.engine.createBackup('manual');
  const disk = path.join(A.home, 'disk');
  fs.renameSync(path.join(A.state, 'backups'), disk);
  fs.rmSync(A.state, { recursive: true });
  const E = createEngine({ env: A.env, home: A.home, hostname: 'another-mac', now: () => new Date('2026-10-31T09:00:00') });
  const plan = E.reviewBackupFolder({ dir: disk });
  for (const f of plan.found) assert.strictEqual((await E.inspectBackup(plan.id, f.path)).state, 'other');
  E.applyBackupFolder(plan.id, { adopt: [plan.found[0].path] });
  assert.ok(E.library().every((b) => !b.isMine));
  assert.deepStrictEqual(configOf(A).earlierDeviceIds, []);
});

test('backup folder: the limits are counted with what comes along, and the warning says how many go', { skip }, async () => {
  const A = folderDevice();
  for (const m of ['00', '01', '02']) {
    A.setNow(`2026-10-30T10:${m}:00`);
    A.engine.createBackup('manual');
  }
  A.engine.updateSettings({ keepManual: 2 });
  const plan = A.engine.reviewBackupFolder({ dir: path.join(A.home, 'target') });
  assert.deepStrictEqual(A.engine.backupFolderFindings(plan.id, { move: false }).retention, []);
  assert.deepStrictEqual(A.engine.backupFolderFindings(plan.id, { move: true }).retention, [{ kind: 'manual', keep: 2, total: 3, extra: 2 }]);
});

test('backup folder on a disk that is gone: no backup and no new folder, with the reason; it goes on when the disk is back', async () => {
  const A = folderDevice();
  A.setNow('2026-10-30T15:00:00');
  A.engine.updateSettings({ daily: { enabled: true, time: '09:00' } });
  const disk = path.join(A.home, 'disk');
  const dir = path.join(disk, 'backups');
  await changeFolder(A, { dir }, {});
  const gone = path.join(A.home, 'disk-away');
  fs.renameSync(disk, gone);
  // A mount point stays behind as an empty folder: the backups must not end up on the computer's own disk.
  fs.mkdirSync(disk);

  const missing = (e) => e.code === 'BACKUP_DIR_MISSING' && e.path === dir;
  assert.throws(() => A.engine.createBackup('manual'), missing);
  assert.throws(() => A.engine.runDailyIfDue(), missing, 'the daily backup too');
  assert.throws(() => A.engine.reviewBackupFolder({}), missing, 'moving backups to it too');
  assert.ok(!fs.existsSync(dir), 'the folder was not made again');
  assert.strictEqual(A.engine.dailyStatus().due, true, 'still due');

  fs.rmdirSync(disk);
  fs.renameSync(gone, disk);
  assert.ok(A.engine.runDailyIfDue().path.startsWith(dir), 'taken as soon as the disk is back');

  // Another folder can be chosen while it is away, and the way back to the default is open.
  fs.renameSync(disk, gone);
  const back = A.engine.reviewBackupFolder({ useDefault: true });
  assert.strictEqual(back.to, path.join(A.state, 'backups'));
});

test('backup folder: refused when it is inside the folder being left or cannot be written; the way back and moving up work', { skip }, async () => {
  const A = folderDevice();
  A.engine.createBackup('manual');
  const base = path.join(A.home, 'base');
  const first = path.join(base, 'backups');
  await changeFolder(A, { dir: first }, { move: true });
  assert.strictEqual(memsyncIn(first).length, 1);
  assert.throws(() => A.engine.reviewBackupFolder({ dir: path.join(first, 'manual') }), (e) => e.code === 'BACKUP_DIR_INSIDE');
  assert.throws(() => A.engine.reviewBackupFolder({ dir: path.join(first, 'x', 'y') }), (e) => e.code === 'BACKUP_DIR_INSIDE');
  assert.strictEqual(A.engine.settings().device.backupDir, first, 'nothing changed');

  const locked = path.join(A.home, 'locked');
  fs.mkdirSync(locked);
  fs.chmodSync(locked, 0o555);
  assert.throws(() => A.engine.reviewBackupFolder({ dir: locked }), (e) => e.code === 'BACKUP_DIR_UNWRITABLE');
  fs.chmodSync(locked, 0o755);
  const file = path.join(A.home, 'a-file');
  fs.writeFileSync(file, 'x');
  assert.throws(() => A.engine.reviewBackupFolder({ dir: file }), (e) => e.code === 'BACKUP_DIR_UNWRITABLE');

  // The folder above: its backups are not "already there".
  const up = await changeFolder(A, { dir: base }, { move: true });
  assert.deepStrictEqual([up.plan.moves.count, up.plan.found.length, up.progress.moved], [1, 0, 1]);
  assert.strictEqual(memsyncIn(base).length, 1);
  assert.ok(memsyncIn(base)[0].startsWith('manual'), 'in the place of its kind');

  // The default folder, with the old one's memory of it cleaned up.
  const back = await changeFolder(A, { useDefault: true }, { move: true });
  assert.strictEqual(back.progress.moved, 1);
  assert.strictEqual(configOf(A).backupDir, null);
  assert.deepStrictEqual(configOf(A).formerBackupDirs, []);
  assert.strictEqual(A.engine.settings().device.backupDir, path.join(A.state, 'backups'));
  assert.strictEqual(A.backups('manual'), 1);
});

test('backup folder: backups left in the default folder before this existed are offered too, and a plain folder change has nothing to ask', { skip }, async () => {
  const A = folderDevice();
  const empty = path.join(A.home, 'empty');
  let plan = A.engine.reviewBackupFolder({ dir: empty });
  assert.strictEqual(plan.nothing, true);
  A.engine.applyBackupFolder(plan.id, {});
  assert.strictEqual(A.engine.settings().device.backupDir, empty);
  assert.deepStrictEqual(configOf(A).formerBackupDirs, []);

  fs.mkdirSync(path.join(A.state, 'backups', 'manual'), { recursive: true });
  const b = A.engine.createBackup('manual');
  fs.renameSync(b.path, path.join(A.state, 'backups', 'manual', path.basename(b.path)));
  assert.strictEqual(A.engine.backupsElsewhere().count, 1);
  plan = A.engine.reviewBackupFolder();
  assert.deepStrictEqual([plan.nothing, plan.moves.dirs.map((d) => d.dir)], [false, [path.join(A.state, 'backups')]]);
  assert.strictEqual(plan.space.enough, true);
  A.engine.applyBackupFolder(plan.id, { move: true });
  assert.strictEqual((await A.engine.moveNextBackup(plan.id)).done, true);
  assert.strictEqual(memsyncIn(empty).length, 1);
  assert.strictEqual(A.engine.backupsElsewhere().count, 0);
});
