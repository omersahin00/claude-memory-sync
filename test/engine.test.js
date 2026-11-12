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
const { readBundle, writeBundle, writeBundleV3 } = require('../lib/bundle');
const { fork } = require('child_process');

const skip = process.platform === 'win32';
// The full name of the temp folder: on Windows it can be a short one (C:\Users\RUNNER~1\...), under which a Claude
// project folder's name cannot be traced back to its folder.
const ROOT = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'cms-engine-')));
// Some tests write chats of hundreds of MB: nothing stays behind.
test.after(() => fs.rmSync(ROOT, { recursive: true, force: true }));
let n = 0;

// What lib/backups.js does, without restic (test/backups.test.js runs the real one): each snapshot is a copy of the stage
// folder the engine filled. fail: the error the next snapshot fails with.
function fakeBackups({ stateHome, fill }) {
  const stageDir = path.join(stateHome, 'Claude');
  const kept = path.join(stateHome, 'fake-snapshots');
  const list = [];
  let restored = 0;
  const describe = (x) => ({ id: x.id, short: x.id.slice(0, 8), time: x.time, host: 'test', mine: true, kind: x.kind, reason: x.reason, files: null, bytes: null, added: null, path: stageDir });
  const fake = {
    stageDir, fail: null,
    view: () => ({ id: 'fake', name: 'Claude', repo: kept, place: stateHome, status: 'ok', schedule: { every: 'daily', time: '12:00', weekday: 1 }, keep: {}, keepBefore: 50, state: {}, nextRun: null, targetPresent: true, passwordSaved: true }),
    isDue: () => false,
    async take(kind, reason) {
      if (fake.fail) throw fake.fail;
      const staged = await fill(stageDir, { kind, reason });
      const id = crypto.randomBytes(32).toString('hex');
      fs.cpSync(stageDir, path.join(kept, id), { recursive: true });
      list.push({ id, kind, reason, time: new Date().toISOString() });
      return { id, staged };
    },
    async backup() {
      const { id, staged } = await fake.take('backup', null);
      return { snapshot: id, staged, dataAdded: 0, filesNew: 0, filesChanged: 0 };
    },
    async before({ reason }) {
      const { id } = await fake.take('before', reason);
      return { snapshot: id, at: new Date().toISOString() };
    },
    snapshots: async () => list.map(describe).reverse(),
    knownSnapshots: () => list.map(describe).reverse(),
    async restore(id, { full = true } = {}) {
      const x = list.find((y) => y.id === id);
      if (!x) throw Object.assign(new Error(`No such snapshot: ${id}`), { code: 'SNAPSHOT_MISSING' });
      const from = path.join(kept, id);
      const chats = path.join(from, 'chats');
      const dir = path.join(stateHome, 'restored', `${id.slice(0, 12)}-${++restored}`);
      fs.cpSync(from, dir, { recursive: true, filter: (src) => full || (src !== chats && !src.startsWith(`${chats}${path.sep}`)) });
      return { dir, snapshot: describe(x) };
    },
    discardRestored: (dir) => fs.rmSync(dir || path.join(stateHome, 'restored'), { recursive: true, force: true }),
    reload() {},
    count: (kind) => list.filter((x) => x.kind === kind).length,
    // As if the backup folder had thinned it out.
    drop: (id) => list.splice(list.findIndex((x) => x.id === id), 1),
    manifest: (id) => JSON.parse(fs.readFileSync(path.join(kept, id, 'manifest.json'), 'utf8')),
  };
  return fake;
}
// An engine as the app makes it, with backups set up (fakeBackups). last.fake is the one the latest engine has.
const last = { fake: null };
const newEngine = (o) => createEngine({ backups: (ctx) => (last.fake = fakeBackups(ctx)), ...o });

function device(name) {
  const home = path.join(ROOT, `${name}-${++n}`);
  const claude = path.join(home, '.claude');
  const state = path.join(home, '.state');
  fs.mkdirSync(path.join(claude, 'projects'), { recursive: true });
  let clock = new Date('2026-10-30T09:00:00');
  const desktop = path.join(home, 'ClaudeDesktop');
  const env = { CLAUDE_CONFIG_DIR: claude, CLAUDE_MEMORY_SYNC_HOME: state, CLAUDE_DESKTOP_DIR: desktop };
  const make = () => newEngine({ env, home, hostname: `${name}.local`, now: () => new Date(clock) });
  const mem = (folder) => path.join(claude, 'projects', P.encodeProjectDir(path.join(home, folder)), 'memory');
  const d = {
    name, home, claude, state, desktop, env,
    engine: make(),
    fake: last.fake,
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
    // Snapshots of this kind ('backup' or 'before') that the device's engine took.
    backups: (kind) => d.fake.count(kind),
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

test('engine: first transfer finds the repo by git remote and the Desktop by its folder, and sets them up', { skip }, async () => {
  const { A, B } = pair();
  const bundle = send(A, B);
  const plan = B.engine.prepare({ bundlePath: bundle });
  const m = Object.fromEntries(plan.matches.map((x) => [x.id, [x.status, x.how, x.include]]));
  assert.deepStrictEqual(m['project:acme-x'], ['create', 'git', true]);
  assert.deepStrictEqual(m['project:desktop'], ['create', 'path', true]);
  const res = await B.engine.apply(plan.id, {});
  assert.ok(res.backupSnapshot);
  assert.strictEqual(B.backups('before'), 1, 'backed up first');
  assert.deepStrictEqual(B.snapshot('work/acme-x'), A.snapshot('code/acme-x'));
  assert.deepStrictEqual(B.snapshot('Desktop'), A.snapshot('Desktop'));

  // Next time the same projects are known; nothing is left to do.
  const again = B.engine.prepare({ bundlePath: bundle });
  assert.strictEqual(again.matches.find((x) => x.id === 'project:acme-x').how, 'saved');
  assert.deepStrictEqual(byRel(again), {});
  const lib = B.engine.library().find((b) => b.path === bundle);
  assert.ok(lib && lib.imported && !lib.isMine);
});

test('engine: a second transfer shows only what changed, waits for conflicts, backs up first every time', { skip }, async () => {
  const { A, B } = pair();
  await B.engine.apply(B.engine.prepare({ bundlePath: send(A, B) }).id, {});

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
  await assert.rejects(B.engine.apply(plan.id, {}), (e) => e.code === 'PENDING');

  await B.engine.createBackup('manual');
  const before = B.backups('before');
  const res = await B.engine.apply(plan.id, { items: { 'memory/desktop/d.md': 'skip', 'memory/acme-x/x.md': 'b' } });
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

test('engine: undo puts back exactly the files one transfer changed', { skip }, async () => {
  const { A, B } = pair();
  await B.engine.apply(B.engine.prepare({ bundlePath: send(A, B) }).id, {});
  A.write('code/acme-x', 'n.md', 'note v2\n');
  A.write('code/acme-x', 'new.md', 'new\n');
  const snap = B.snapshot('work/acme-x');
  const res = await B.engine.apply(B.engine.prepare({ bundlePath: send(A, B) }).id, {});
  assert.notDeepStrictEqual(B.snapshot('work/acme-x'), snap);
  B.write('Desktop', 'later.md', 'written after the transfer\n');

  const entry = B.engine.activity().find((e) => e.id === res.activityId);
  assert.ok(entry.undoable);
  const undo = await B.engine.prepareUndo(res.activityId);
  assert.deepStrictEqual(byRel(undo), { 'acme-x/n.md': 'updated', 'acme-x/new.md': 'deleted' });
  await B.engine.apply(undo.id, {});
  assert.deepStrictEqual(B.snapshot('work/acme-x'), snap);
  assert.ok(B.has('Desktop', 'later.md'), 'files the transfer did not touch are left alone');
  assert.ok(B.engine.activity().find((e) => e.id === res.activityId).undone);
});

test('engine: nothing is written when a file changed after the review', { skip }, async () => {
  const { A, B } = pair();
  await B.engine.apply(B.engine.prepare({ bundlePath: send(A, B) }).id, {});
  A.write('code/acme-x', 'n.md', 'note v2\n');
  const plan = B.engine.prepare({ bundlePath: send(A, B) });
  B.write('work/acme-x', 'n.md', 'Claude wrote this meanwhile\n');
  const before = B.backups('before');
  await assert.rejects(B.engine.apply(plan.id, {}), (e) => e.code === 'STALE');
  assert.strictEqual(B.read('work/acme-x', 'n.md'), 'Claude wrote this meanwhile\n');
  assert.strictEqual(B.backups('before'), before);
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
  assert.strictEqual(cfg.askBackups, true, 'asked about backups like a new install');
  const keys = Object.keys(JSON.parse(fs.readFileSync(path.join(D.state, 'history.json'), 'utf8')).keys).sort();
  assert.deepStrictEqual(keys, ['memory/acme-a/x.md', 'workspace/github/workspaces/a.code-workspace']);
  assert.ok(fs.existsSync(path.join(D.state, 'config.v1.json')));
});

test('engine: a workspace file is made portable with a backup, and the change can be undone', { skip }, async () => {
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
  assert.deepStrictEqual((await A.engine.fixWorkspace({ root: r.key, rel: 'ws/all.code-workspace' })).changes, [{ from: path.join(root, 'acme-x'), to: '../acme-x' }]);
  assert.strictEqual(fs.readFileSync(ws, 'utf8'), original, 'preview writes nothing');
  const done = await A.engine.fixWorkspace({ root: r.key, rel: 'ws/all.code-workspace', apply: true });
  assert.ok(fs.readFileSync(ws, 'utf8').includes('"path": "../acme-x"'));
  await A.engine.apply((await A.engine.prepareUndo(done.activityId)).id, {});
  assert.strictEqual(fs.readFileSync(ws, 'utf8'), original);
});

test('engine: workspaces go where their repositories are; one whose folders are missing comes unselected and is offered again', { skip }, async () => {
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

  await B.engine.apply(plan.id, {});
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

test('engine: language and theme are saved; unknown values fall back; settings of the old backups go', () => {
  const A = device('A');
  const look = (e) => [e.settings().language, e.settings().theme];
  assert.deepStrictEqual(look(A.engine), [null, 'system']);
  A.engine.updateSettings({ language: 'de', theme: 'dark' });
  assert.deepStrictEqual(look(newEngine({ env: { CLAUDE_CONFIG_DIR: A.claude, CLAUDE_MEMORY_SYNC_HOME: A.state }, home: A.home })), ['de', 'dark'], 'read back from disk');
  A.engine.updateSettings({ language: 'Deutsch', theme: 'blue' });
  assert.deepStrictEqual(look(A.engine), [null, 'system']);
  // Settings of a version whose backups were .memsync files: their backups are not used, and the settings go.
  const D = device('B');
  fs.mkdirSync(D.state, { recursive: true });
  fs.writeFileSync(path.join(D.state, 'config.json'), JSON.stringify({ version: 2, deviceId: 'd-id', deviceName: 'D', workspaceRoots: [], backupDir: '/Volumes/X', daily: { enabled: true, time: '18:00' }, keepBefore: 5, keepManual: 2, formerBackupDirs: ['/old'] }));
  const cfg = D.engine.settings();
  for (const k of ['backupDir', 'daily', 'keepBefore', 'keepManual', 'formerBackupDirs', 'earlierDeviceIds']) assert.ok(!(k in cfg), k);
  assert.strictEqual(cfg.askBackups, true, 'asked about the new backups');
});

test('engine: a workspace file left out of a bundle stays as it is on the other device, in a sync and in a restore', { skip }, async () => {
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
  await B.engine.apply(B.engine.prepare({ bundlePath: send(A, B) }).id, {});
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
  await B.engine.apply(B.engine.prepare({ bundlePath: bundle, mode: 'restore' }).id, {});
  assert.match(fs.readFileSync(path.join(bRoot, 'workspaces', 'App.code-workspace'), 'utf8'), /"a":1/);
  assert.strictEqual(fs.readFileSync(path.join(bRoot, 'workspaces', 'Private.code-workspace'), 'utf8'), privateOnB, 'the left-out file is untouched');
  const status = Object.fromEntries(A.engine.workspaces()[0].files.map((f) => [f.rel, f.status]));
  assert.deepStrictEqual(status, { 'workspaces/App.code-workspace': 'synced', 'workspaces/Private.code-workspace': 'changed' }, 'the left-out change still counts as not sent');
});

// A device with memories, a workspace, Claude settings, own settings, backups and a bundle sent: everything a full backup
// has to bring back.
async function busyDevice(name) {
  const A = device(name);
  A.project('code/acme-x', { 'MEMORY.md': '- [N](n.md) — note\n', 'n.md': 'note\n' }, { git: GIT });
  A.project('Desktop', { 'MEMORY.md': '- [D](d.md) — desk\n', 'd.md': 'desk\n' });
  const root = A.folder('Documents/GitHub');
  A.folder('Documents/GitHub/workspaces');
  fs.writeFileSync(path.join(root, 'workspaces', 'App.code-workspace'), JSON.stringify({ folders: [{ path: '../../code/acme-x' }] }));
  fs.writeFileSync(path.join(A.claude, 'CLAUDE.md'), 'Answer briefly.\n');
  A.engine.updateSettings({ deviceName: 'Studio', language: 'de', theme: 'dark', workspaceRoots: [root] });
  await A.engine.createBackup('manual');
  A.setNow('2026-10-30T13:00:00');
  await A.engine.createBackup('scheduled');
  A.folder('Downloads');
  A.engine.exportBundle({ outDir: path.join(A.home, 'Downloads') });
  return { A, root, env: A.env };
}

test('engine: a full backup brings memories, settings, history, matches and activity back after a reset, and where the backups are', { skip }, async () => {
  const { A, root, env } = await busyDevice('mac');
  // Where the backups are and the passwords: the first comes back, the second only this computer could decrypt.
  fs.writeFileSync(path.join(A.state, 'sets.json'), JSON.stringify({ version: 1, sets: [] }));
  fs.writeFileSync(path.join(A.state, 'secrets.json'), '{}');
  const before = {
    id: A.engine.settings().deviceId,
    acme: A.snapshot('code/acme-x'),
    history: fs.readFileSync(path.join(A.state, 'history.json'), 'utf8'),
    keys: A.engine.projects().projects.map((p) => p.key).sort(),
    activity: A.engine.activity(100).map((e) => e.id),
  };
  const out = A.folder('usb');
  const full = A.engine.createFullBackup({ outDir: out });
  assert.deepStrictEqual([...readBundle(full.path).full.keys()].sort(), ['state/activity.jsonl', 'state/config.json', 'state/history.json', 'state/sets.json', 'state/state.json']);

  // The computer is reset: Claude's folder, the app's data and the workspace file are gone.
  for (const dir of [A.claude, A.state, path.join(root, 'workspaces')]) fs.rmSync(dir, { recursive: true, force: true });
  const R = newEngine({ env, home: A.home, hostname: 'mac.local' });
  assert.notStrictEqual(R.settings().deviceId, before.id, 'a fresh install is a new device');
  assert.throws(() => R.prepareFullRestore(path.join(A.home, 'Downloads', fs.readdirSync(path.join(A.home, 'Downloads'))[0])), { code: 'NOT_FULL' });

  const plan = R.prepareFullRestore(full.path);
  assert.deepStrictEqual([plan.remapped, plan.counts.replace, plan.counts.same], [false, 0, 0]);
  assert.strictEqual(plan.counts.new, 6, 'four memory files, the workspace file and CLAUDE.md');
  const r = await R.applyFullRestore(plan.id);
  assert.ok(r.verified && r.backupSnapshot, 'the device was backed up first');
  assert.ok(fs.existsSync(path.join(A.state, 'sets.json')) && !fs.existsSync(path.join(A.state, 'secrets.json')));

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
});

test('engine: a full backup taken under another home folder is restored under this one', { skip }, async () => {
  const { A, env } = await busyDevice('old');
  const full = A.engine.createFullBackup({ outDir: A.folder('usb') });
  const B = device('new');
  assert.throws(() => newEngine({ env: { ...env }, home: B.home, platform: 'win32' }).prepareFullRestore(full.path), { code: 'FULL_PLATFORM' });
  const plan = B.engine.prepareFullRestore(full.path);
  assert.deepStrictEqual([plan.remapped, plan.homeFrom, plan.homeTo], [true, A.home, B.home]);
  await B.engine.applyFullRestore(plan.id);
  assert.strictEqual(B.read('code/acme-x', 'n.md'), 'note\n', 'memory is under the Claude folder name of the new home');
  const root = path.join(B.home, 'Documents/GitHub');
  assert.deepStrictEqual(B.engine.settings().workspaceRoots, [root]);
  assert.ok(fs.existsSync(path.join(root, 'workspaces', 'App.code-workspace')));
});

test('engine: a full backup from another computer imports like a bundle: memories, Claude settings and chats merge, its app data and old backups stay out', { skip }, async () => {
  const { A } = await busyDevice('mac');
  chatOn(A, 'code/acme-x', CHAT, ['Fix the login bug']);
  const full = A.engine.createFullBackup({ outDir: A.folder('usb') });
  // Taken on another system, it cannot go back as it is.
  assert.throws(() => newEngine({ env: { ...A.env }, home: A.home, platform: 'win32' }).prepareFullRestore(full.path), { code: 'FULL_PLATFORM' });

  const B = device('pc');
  B.folder('work/acme-x', { git: 'https://github.com/me/acme-x' });
  B.engine.updateSettings({ deviceName: 'PC', workspaceRoots: [path.join(B.home, 'work')] });
  const before = B.engine.settings();
  const opened = B.engine.openBundle(full.path);
  assert.deepStrictEqual([opened.kind, opened.isMine], ['full', false]);
  const plan = B.engine.prepare({ bundlePath: full.path, mode: 'sync' });
  assert.deepStrictEqual(plan.chats.map((c) => [c.id, c.status]), [[CHAT, 'new']]);
  await B.engine.apply(plan.id, {});

  assert.strictEqual(B.read('work/acme-x', 'n.md'), 'note\n', 'the memory went to the project here');
  assert.ok(fs.existsSync(path.join(chatDir(B, 'work/acme-x'), `${CHAT}.jsonl`)), 'the chat came with it');
  assert.strictEqual(fs.readFileSync(path.join(B.claude, 'CLAUDE.md'), 'utf8'), 'Answer briefly.\n');
  const after = B.engine.settings();
  assert.deepStrictEqual([after.deviceId, after.deviceName, after.language, after.theme, after.workspaceRoots], [before.deviceId, 'PC', before.language, before.theme, before.workspaceRoots], 'this device keeps its own settings');
  assert.deepStrictEqual(B.engine.library().filter((b) => b.device && b.device.id === A.engine.settings().deviceId), [], 'the other computer\'s old backups are not brought over');
  assert.strictEqual(B.engine.activity(1)[0].type, 'sync');
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

test('engine: a chat travels with everything that belongs to it, is brought up to date, and is never shortened', { skip }, async () => {
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
  const take = async (bundle) => {
    const plan = B.engine.prepare({ bundlePath: bundle });
    await B.engine.apply(plan.id, {});
    return plan;
  };

  // New on B: everything lands in B's folder for the project, which is somewhere else. (The bundle goes to a folder
  // that does not exist yet.)
  let plan = await take(send(path.join(B.home, 'Downloads', 'new folder')));
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
  plan = await take(send());
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
  plan = await take(send());
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

test('engine: a chat only opened on one device (lines the apps add on their own) is brought up to date there, not copied', { skip }, async () => {
  const A = device('mac');
  A.project('code/acme-x', { 'MEMORY.md': '- [N](n.md) — note\n', 'n.md': 'note\n' }, { git: GIT });
  chatOn(A, 'code/acme-x', CHAT, ['Fix the login bug'], { desktopTitle: 'Login bug' });
  const B = device('win');
  B.folder('Documents/GitHub/acme-x', { git: 'https://github.com/me/acme-x' });
  B.folder('Downloads');
  fs.mkdirSync(path.join(B.desktop, 'claude-code-sessions', 'acct', 'org'), { recursive: true });
  const prepare = () => B.engine.prepare({ bundlePath: A.engine.exportBundle({ outDir: path.join(B.home, 'Downloads'), selection: { projects: [], workspaces: [], claude: false, chats: [CHAT] } }).path });
  await B.engine.apply(prepare().id, {});
  const aFile = path.join(chatDir(A, 'code/acme-x'), `${CHAT}.jsonl`);
  const bDir = chatDir(B, 'Documents/GitHub/acme-x');
  const bFile = path.join(bDir, `${CHAT}.jsonl`);
  // What opening a chat adds to it, with nothing said.
  const opened = (file, cost) => fs.appendFileSync(file, [{ type: 'cost-state', sessionId: CHAT, totalCostUSD: cost }, { type: 'last-prompt', lastPrompt: 'Fix the login bug', sessionId: CHAT }].map((o) => `${JSON.stringify(o)}\n`).join(''));

  // Opened on B, continued on A: B gets A's chat, and no copy.
  opened(bFile, 1);
  addLine(A, 'code/acme-x', CHAT, 'Now add a test');
  let plan = prepare();
  assert.strictEqual(plan.chats[0].status, 'updated');
  await B.engine.apply(plan.id, {});
  assert.strictEqual(fs.readFileSync(bFile, 'utf8'), fs.readFileSync(aFile, 'utf8'));
  assert.deepStrictEqual(fs.readdirSync(bDir).filter((f) => f.endsWith('.jsonl')), [`${CHAT}.jsonl`], 'no copy');

  // Only opened on both: nothing to take.
  opened(aFile, 2);
  opened(bFile, 3);
  plan = prepare();
  assert.deepStrictEqual([plan.chats[0].status, plan.chats[0].choices], ['same', []]);
  // Continued on B only: B keeps its own.
  addLine(B, 'Documents/GitHub/acme-x', CHAT, 'B went on');
  assert.strictEqual(prepare().chats[0].status, 'local-newer');
  // Something said on both: a copy, as before. Its record does not name the original's earlier transcripts.
  const aRecord = path.join(A.desktop, 'claude-code-sessions', 'acct', 'org', 'local_aaaa.json');
  const earlier = '88888888-8888-4888-8888-888888888888';
  fs.writeFileSync(aRecord, JSON.stringify({ ...JSON.parse(fs.readFileSync(aRecord, 'utf8')), priorCliSessionIds: [earlier] }));
  addLine(A, 'code/acme-x', CHAT, 'A went on');
  plan = prepare();
  assert.strictEqual(plan.chats[0].status, 'diverged');
  await B.engine.apply(plan.id, {});
  const scope = path.join(B.desktop, 'claude-code-sessions', 'acct', 'org');
  const copyRecord = fs.readdirSync(scope).find((f) => f !== 'local_aaaa.json');
  const rec = JSON.parse(fs.readFileSync(path.join(scope, copyRecord), 'utf8'));
  assert.ok(rec.cliSessionId !== CHAT && rec.title.endsWith(`(${A.engine.settings().deviceName})`));
  assert.strictEqual(rec.priorCliSessionIds, undefined);
});

// A chat as Claude Code writes it: messages ([role, id, text], one a minute from start) and lines the apps add on their
// own ([type, fields]).
const CHAT_START = Date.parse('2026-11-04T14:31:00.000Z');
function writeChat(d, folder, id, lines, entrypoint = 'claude-desktop') {
  const dir = chatDir(d, folder);
  fs.mkdirSync(dir, { recursive: true });
  const cwd = path.join(d.home, folder);
  let minute = 0;
  const out = lines.map(([kind, a, b]) => {
    if (kind !== 'user' && kind !== 'assistant') return { type: kind, ...a, sessionId: id };
    const message = kind === 'user' ? { role: 'user', content: b } : { role: 'assistant', model: 'claude-test-1', content: [{ type: 'text', text: b }] };
    return { type: kind, uuid: a, sessionId: id, entrypoint, cwd, timestamp: new Date(CHAT_START + 60000 * minute++).toISOString(), ...(kind === 'user' ? { permissionMode: 'auto' } : {}), message };
  });
  fs.writeFileSync(path.join(dir, `${id}.jsonl`), out.map((o) => `${JSON.stringify(o)}\n`).join(''));
}

test('engine: a chat of the desktop app that comes without its record gets one, made as the app makes one; not its earlier part, a chat deleted or held here, or a chat of VS Code', { skip }, async () => {
  const ids = { early: '22222222-2222-4222-8222-222222222222', later: '33333333-3333-4333-8333-333333333333', gone: '44444444-4444-4444-8444-444444444444', held: '55555555-5555-4555-8555-555555555555', code: '66666666-6666-4666-8666-666666666666' };
  const A = device('pc');
  A.project('code/acme-x', { 'MEMORY.md': '- [N](n.md) — note\n', 'n.md': 'note\n' }, { git: GIT });
  const start = [['user', 'u1', 'Start the backend'], ['assistant', 'a1', 'Sure'], ['user', 'u2', 'Add the users table'], ['assistant', 'a2', 'Done']];
  // The session went on in a new transcript, which has all of the earlier one.
  writeChat(A, 'code/acme-x', ids.early, [...start, ['custom-title', { customTitle: 'Side chat' }]]);
  writeChat(A, 'code/acme-x', ids.later, [...start, ['user', 'u3', 'Now the roles'], ['assistant', 'a3', 'Added'], ['custom-title', { customTitle: 'Backend work' }],
    ['bridge-session', { bridgeSessionId: 'cse_1', ownerAccountUuid: 'acct', ownerOrganizationUuid: 'org' }]]);
  writeChat(A, 'code/acme-x', ids.gone, [['user', 'g1', 'Old question'], ['assistant', 'g2', 'Old answer']]);
  writeChat(A, 'code/acme-x', ids.held, [['user', 'h1', 'Held'], ['assistant', 'h2', 'Yes']]);
  writeChat(A, 'code/acme-x', ids.code, [['user', 'c1', 'From VS Code'], ['assistant', 'c2', 'Ok']], 'claude-vscode');

  const B = device('mac');
  B.folder('Documents/GitHub/acme-x', { git: 'https://github.com/me/acme-x' });
  B.folder('Downloads');
  const scope = path.join(B.desktop, 'claude-code-sessions', 'acct', 'org');
  fs.mkdirSync(scope, { recursive: true });
  // Deleted in the app here, and an earlier part of a session the app here has.
  fs.writeFileSync(path.join(scope, `deleted_${ids.gone}`), '1791902099810');
  fs.writeFileSync(path.join(scope, 'local_held.json'), JSON.stringify({ sessionId: 'local_held', cliSessionId: '77777777-7777-4777-8777-777777777777', priorCliSessionIds: [ids.held], cwd: B.home, title: 'Held' }));
  const prepare = () => B.engine.prepare({ bundlePath: A.engine.exportBundle({ outDir: path.join(B.home, 'Downloads'), selection: { projects: [], workspaces: [], claude: false, chats: Object.values(ids) } }).path });
  const status = (plan) => Object.fromEntries(plan.chats.map((c) => [Object.keys(ids).find((k) => ids[k] === c.id), c.status]));
  const records = () => fs.readdirSync(scope).filter((f) => f.startsWith('local_')).sort();

  let plan = prepare();
  assert.deepStrictEqual(status(plan), { early: 'new', later: 'new', gone: 'new', held: 'new', code: 'new' });
  await B.engine.apply(plan.id, {});
  for (const id of Object.values(ids)) assert.ok(fs.existsSync(path.join(chatDir(B, 'Documents/GitHub/acme-x'), `${id}.jsonl`)), id);
  assert.deepStrictEqual(records(), [`local_${ids.later}.json`, 'local_held.json']);
  const rec = JSON.parse(fs.readFileSync(path.join(scope, `local_${ids.later}.json`), 'utf8'));
  const cwd = path.join(B.home, 'Documents/GitHub/acme-x');
  assert.deepStrictEqual(
    [rec.sessionId, rec.cliSessionId, rec.cwd, rec.originCwd, rec.title, rec.priorCliSessionIds, rec.isArchived, rec.model, rec.permissionMode, rec.createdAt, rec.lastActivityAt, rec.fromCliTranscript],
    [`local_${ids.later}`, ids.later, cwd, cwd, 'Backend work', [ids.early], false, 'claude-test-1', 'auto', CHAT_START, CHAT_START + 5 * 60000, true],
  );

  // Brought over before without a record (as an older version did): the bundle opened again makes it.
  fs.rmSync(path.join(scope, `local_${ids.later}.json`));
  plan = prepare();
  assert.deepStrictEqual(status(plan), { early: 'same', later: 'updated', gone: 'same', held: 'same', code: 'same' });
  await B.engine.apply(plan.id, {});
  assert.deepStrictEqual(records(), [`local_${ids.later}.json`, 'local_held.json']);
  assert.deepStrictEqual(Object.values(status(prepare())), ['same', 'same', 'same', 'same', 'same'], 'with its record, nothing more to do');
});

test('engine: a full backup carries every chat, and a restore after a reset brings them back', { skip }, async () => {
  const { A, env } = await busyDevice('mac');
  chatOn(A, 'code/acme-x', CHAT, ['Fix the login bug', 'And the logout'], { desktopTitle: 'Login bug' });
  const transcript = fs.readFileSync(path.join(chatDir(A, 'code/acme-x'), `${CHAT}.jsonl`), 'utf8');
  const full = A.engine.createFullBackup({ outDir: A.folder('usb') });
  assert.strictEqual(full.chats, 1);
  for (const dir of [A.claude, A.state, path.join(A.desktop, 'claude-code-sessions', 'acct', 'org', 'local_aaaa.json')]) fs.rmSync(dir, { recursive: true, force: true });
  const R = newEngine({ env, home: A.home, hostname: 'mac.local' });
  const plan = R.prepareFullRestore(full.path);
  assert.strictEqual(plan.chats.new, 1);
  await R.applyFullRestore(plan.id);
  assert.strictEqual(fs.readFileSync(path.join(chatDir(A, 'code/acme-x'), `${CHAT}.jsonl`), 'utf8'), transcript);
  assert.ok(fs.existsSync(path.join(A.claude, 'file-history', CHAT, 'abc@v1')));
  assert.match(fs.readFileSync(path.join(A.claude, 'history.jsonl'), 'utf8'), /Fix the login bug/);
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(A.desktop, 'claude-code-sessions', 'acct', 'org', 'local_aaaa.json'), 'utf8')).cliSessionId, CHAT);
});

test('engine: after a reset under another user name, a full restore puts chats, their desktop records and prompts under the new home', { skip }, async () => {
  const { A, root } = await busyDevice('old');
  chatOn(A, 'code/acme-x', CHAT, ['Fix the login bug'], { desktopTitle: 'Login bug' });
  // A workspace file that names its folders with full paths, and one more folder whose name only starts the same way.
  fs.writeFileSync(path.join(root, 'workspaces', 'Full.code-workspace'), JSON.stringify({ folders: [{ path: path.join(A.home, 'code/acme-x') }, { path: `${A.home}2/elsewhere` }] }));
  const full = A.engine.createFullBackup({ outDir: A.folder('usb') });

  // The same system installed again with another user name: another home folder, the desktop app installed again.
  const B = device('new');
  fs.mkdirSync(B.desktop, { recursive: true });
  const plan = B.engine.prepareFullRestore(full.path);
  assert.deepStrictEqual([plan.remapped, plan.homeFrom, plan.homeTo], [true, A.home, B.home]);
  await B.engine.applyFullRestore(plan.id);

  const here = path.join(B.home, 'code/acme-x');
  assert.ok(fs.existsSync(path.join(chatDir(B, 'code/acme-x'), `${CHAT}.jsonl`)), 'the chat is in the Claude folder of the new home');
  const rec = JSON.parse(fs.readFileSync(path.join(B.desktop, 'claude-code-sessions', 'acct', 'org', 'local_aaaa.json'), 'utf8'));
  assert.deepStrictEqual([rec.cliSessionId, rec.cwd], [CHAT, here], 'the desktop app lists it, in the new folder');
  const prompts = fs.readFileSync(path.join(B.claude, 'history.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepStrictEqual(prompts.map((x) => x.project), [here]);
  const ws = JSON.parse(fs.readFileSync(path.join(B.home, 'Documents/GitHub', 'workspaces', 'Full.code-workspace'), 'utf8'));
  assert.deepStrictEqual(ws.folders.map((f) => f.path), [here, `${A.home}2/elsewhere`], 'full paths move to the new home; another folder stays');
  // The project is where it is now, not where its chats ran before the reset (their transcripts still say so).
  assert.strictEqual(B.engine.projects().projects.find((p) => p.key === 'acme-x').cwd, here);
  for (const f of ['config.json', 'state.json']) assert.ok(!fs.readFileSync(path.join(B.state, f), 'utf8').includes(A.home), `${f} names no folder of the old home`);

});

// The rest of Claude's data on a device: what a full backup takes besides memories, chats, workspaces and Claude settings,
// and what it leaves out.
function claudeExtras(A) {
  const put = (abs, data, mode) => {
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, data);
    if (mode) fs.chmodSync(abs, mode);
  };
  const hook = path.join(A.claude, 'hooks', 'notify.sh');
  put(path.join(A.claude, 'settings.json'), JSON.stringify({ model: 'opus', hooks: { Stop: [{ hooks: [{ type: 'command', command: hook }] }] } }));
  put(hook, '#!/bin/sh\necho done\n', 0o755);
  put(path.join(A.claude, 'scheduled-tasks', 'daily-check', 'SKILL.md'), 'Check the invoices.\n');
  put(path.join(A.claude, 'plugins', 'installed_plugins.json'), JSON.stringify({ plugins: { 'x@market': [{ installPath: path.join(A.claude, 'plugins', 'cache', 'x') }] } }));
  put(path.join(A.claude, 'plugins', 'cache', 'x', 'bin', 'run'), '#!/bin/sh\n', 0o755);
  // A prompt of a chat that is gone: the prompt history keeps it.
  put(path.join(A.claude, 'history.jsonl'), `${JSON.stringify({ display: 'An old question', timestamp: 500, project: path.join(A.home, 'code/acme-x'), sessionId: '99999999-9999-4999-8999-999999999999' })}\n`);
  put(path.join(chatDir(A, 'code/acme-x'), 'canvas', 'logo.svg'), '<svg/>');
  // Left out: the login, caches and the state of running sessions.
  put(path.join(A.claude, '.credentials.json'), '{"token":"secret"}');
  put(path.join(A.claude, 'plugins', 'plugin-directory-cache-v2.json'), '{}');
  put(path.join(A.claude, 'session-env', 's1', 'env'), 'X=1');
  put(path.join(A.claude, 'stats-cache.json'), '{}');
  put(path.join(A.claude, '.DS_Store'), 'x');
  // Claude Code's .claude.json: the settings in it go, its counters and account do not.
  put(path.join(A.claude, '.claude.json'), JSON.stringify({
    numStartups: 40, oauthAccount: { emailAddress: 'me@example.com' }, mcpServers: { files: { command: 'npx', args: ['files-mcp'] } },
    projects: { [path.join(A.home, 'code/acme-x')]: { allowedTools: ['Bash(npm test)'], hasTrustDialogAccepted: true, lastCost: 3.2 }, [path.join(A.home, 'tmp')]: { allowedTools: [], lastCost: 1 } },
  }));
  // The desktop app: Cowork, scheduled tasks, a deleted session, its settings; not its caches or its records of Code sessions.
  const scope = path.join(A.desktop, 'claude-code-sessions', 'acct', 'org');
  put(path.join(A.desktop, 'claude_desktop_config.json'), JSON.stringify({ mcpServers: { db: { command: 'db-mcp' } }, preferences: { sidebarMode: 'code', epitaxyPrefs: { 'dframe-group-scopes': { 'acct/org': { groups: [{ id: 'g1', name: 'Work', mode: 'code' }] } } } } }));
  put(path.join(scope, 'scheduled-tasks.json'), JSON.stringify([{ id: 'daily-check', cron: '0 9 * * *' }]));
  put(path.join(A.desktop, 'local-agent-mode-sessions', 'acct', 'org', 'local_c1.json'), JSON.stringify({ sessionId: 'local_c1', title: 'Cowork task', cwd: path.join(A.home, 'Documents') }));
  put(path.join(A.desktop, 'local-agent-mode-sessions', 'acct', 'org', 'local_c1', 'audit.jsonl'), '{"type":"user"}\n');
  put(path.join(A.desktop, 'Code Cache', 'js', 'index'), 'cache');
  put(path.join(A.desktop, 'config.json'), '{"oauth:tokenCache":"secret"}');
  // A project's own Claude files that git leaves out.
  put(path.join(A.home, 'code/acme-x', '.claude', 'settings.local.json'), '{"permissions":{"allow":["Bash(make)"]}}');
  put(path.join(A.home, 'code/acme-x', 'CLAUDE.local.md'), 'Use the staging database.\n');
  return { hook, scope };
}

test('engine: a full backup takes the rest of Claude\'s data and puts it back, waiting for what is not on this device yet', { skip }, async () => {
  const { A, env } = await busyDevice('mac');
  const { hook, scope } = claudeExtras(A);
  const ids = { kept: '33333333-3333-4333-8333-333333333333', gone: '44444444-4444-4444-8444-444444444444' };
  // Two desktop app chats whose records are not here; one of them was deleted in the app.
  for (const [k, id] of Object.entries(ids)) {
    writeChat(A, 'code/acme-x', id, [['user', `${k}1`, `Question ${k}`], ['assistant', `${k}2`, 'Answer'], ['bridge-session', { bridgeSessionId: `cse_${k}`, ownerAccountUuid: 'acct', ownerOrganizationUuid: 'org' }]]);
  }
  fs.writeFileSync(path.join(scope, `deleted_${ids.gone}`), '1791902099810');

  const preview = A.engine.fullBackupPreview();
  const full = A.engine.createFullBackup({ outDir: A.folder('usb') });
  const keys = [...readBundle(full.path).full.keys()].filter((k) => k.startsWith('extra/')).sort();
  const acme = P.encodeProjectDir(path.join(A.home, 'code/acme-x'));
  assert.deepStrictEqual(keys, [
    'extra/claude/history.jsonl', 'extra/claude/hooks/notify.sh', 'extra/claude/plugins/cache/x/bin/run', 'extra/claude/plugins/installed_plugins.json',
    'extra/claude/scheduled-tasks/daily-check/SKILL.md', 'extra/claude/settings.json', 'extra/config',
    `extra/desktop/claude-code-sessions/acct/org/deleted_${ids.gone}`, 'extra/desktop/claude-code-sessions/acct/org/scheduled-tasks.json',
    'extra/desktop/claude_desktop_config.json', 'extra/desktop/local-agent-mode-sessions/acct/org/local_c1.json', 'extra/desktop/local-agent-mode-sessions/acct/org/local_c1/audit.jsonl',
    `extra/projects/${acme}/canvas/logo.svg`, 'extra/repo/acme-x/.claude/settings.local.json', 'extra/repo/acme-x/CLAUDE.local.md',
  ]);
  assert.deepStrictEqual([preview.extras.files, full.extras], [keys.length, keys.length]);
  const config = JSON.parse(readBundle(full.path).full.get('extra/config').buf.toString('utf8'));
  assert.deepStrictEqual(config, { mcpServers: { files: { command: 'npx', args: ['files-mcp'] } }, projects: { [path.join(A.home, 'code/acme-x')]: { allowedTools: ['Bash(npm test)'], hasTrustDialogAccepted: true } } });

  // The computer is reset: the project is not cloned yet and the desktop app not installed.
  for (const dir of [A.claude, A.state, A.desktop, path.join(A.home, 'code')]) fs.rmSync(dir, { recursive: true, force: true });
  const open = (running) => newEngine({ env: { ...env, CMS_DESKTOP_RUNNING: running }, home: A.home, hostname: 'mac.local' });
  let R = open('0');
  let plan = R.prepareFullRestore(full.path);
  const extra = (p) => Object.fromEntries(p.groups.filter((g) => g.extra).map((g) => [g.extra, [g.new, g.replace, g.same, g.waiting]]));
  assert.deepStrictEqual(extra(plan), { claude: [6, 0, 0, 0], projects: [1, 0, 0, 0], config: [1, 0, 0, 0], desktop: [0, 0, 0, 5], repo: [0, 0, 0, 2] });
  assert.deepStrictEqual(plan.warnings.map((w) => [w.code, w.count]), [['extra-repo', 2], ['extra-desktop', 5]]);
  assert.strictEqual(plan.warnings[0].names, 'acme-x');
  let r = await R.applyFullRestore(plan.id);
  assert.deepStrictEqual(r.waiting.map((w) => w.code), ['extra-repo', 'extra-desktop']);
  assert.strictEqual(fs.readFileSync(path.join(A.claude, 'settings.json'), 'utf8'), JSON.stringify({ model: 'opus', hooks: { Stop: [{ hooks: [{ type: 'command', command: hook }] }] } }));
  assert.strictEqual(fs.statSync(hook).mode & 0o777, 0o755, 'a hook can run again');
  assert.strictEqual(fs.statSync(path.join(A.claude, 'plugins', 'cache', 'x', 'bin', 'run')).mode & 0o777, 0o755);
  assert.ok(fs.existsSync(path.join(A.claude, 'scheduled-tasks', 'daily-check', 'SKILL.md')));
  assert.match(fs.readFileSync(path.join(A.claude, 'history.jsonl'), 'utf8'), /An old question/);
  assert.strictEqual(fs.readFileSync(path.join(chatDir(A, 'code/acme-x'), 'canvas', 'logo.svg'), 'utf8'), '<svg/>');
  for (const rel of ['.credentials.json', 'plugins/plugin-directory-cache-v2.json', 'session-env', 'stats-cache.json']) assert.ok(!fs.existsSync(path.join(A.claude, rel)), rel);
  const cc = JSON.parse(fs.readFileSync(path.join(A.claude, '.claude.json'), 'utf8'));
  assert.deepStrictEqual([cc.mcpServers, cc.projects[path.join(A.home, 'code/acme-x')].allowedTools, cc.numStartups, cc.oauthAccount], [config.mcpServers, ['Bash(npm test)'], undefined, undefined]);
  assert.ok(!fs.existsSync(A.desktop) && !fs.existsSync(path.join(A.home, 'code/acme-x')), 'no folder made where a clone or the app goes');

  // Cloned and the desktop app opened once, but running: all but its settings and scheduled tasks.
  A.folder('code/acme-x', { git: GIT });
  fs.mkdirSync(A.desktop, { recursive: true });
  fs.writeFileSync(path.join(A.desktop, 'claude_desktop_config.json'), JSON.stringify({ preferences: { fresh: true } }));
  R = open('1');
  plan = R.prepareFullRestore(full.path);
  assert.deepStrictEqual(extra(plan), { claude: [0, 0, 6, 0], projects: [0, 0, 1, 0], config: [0, 0, 1, 0], desktop: [3, 0, 0, 2], repo: [2, 0, 0, 0] });
  assert.deepStrictEqual(plan.warnings.map((w) => [w.code, w.count]), [['extra-running', 2]]);
  await R.applyFullRestore(plan.id);
  assert.strictEqual(fs.readFileSync(path.join(A.home, 'code/acme-x', 'CLAUDE.local.md'), 'utf8'), 'Use the staging database.\n');
  assert.ok(fs.existsSync(path.join(A.desktop, 'local-agent-mode-sessions', 'acct', 'org', 'local_c1', 'audit.jsonl')));
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(A.desktop, 'claude_desktop_config.json'), 'utf8')), { preferences: { fresh: true } });

  // Claude quit: its settings are merged and its scheduled tasks written; the chat deleted in the app gets no record.
  R = open('0');
  plan = R.prepareFullRestore(full.path);
  assert.deepStrictEqual(extra(plan).desktop, [1, 1, 3, 0]);
  r = await R.applyFullRestore(plan.id);
  const desk = JSON.parse(fs.readFileSync(path.join(A.desktop, 'claude_desktop_config.json'), 'utf8'));
  assert.deepStrictEqual([desk.preferences.fresh, desk.preferences.sidebarMode, desk.mcpServers], [true, 'code', { db: { command: 'db-mcp' } }]);
  assert.deepStrictEqual(desk.preferences.epitaxyPrefs['dframe-group-scopes']['acct/org'].groups.map((g) => g.name), ['Work']);
  assert.ok(fs.existsSync(path.join(scope, 'scheduled-tasks.json')));
  const records = fs.readdirSync(scope).filter((f) => f.startsWith('local_')).sort();
  assert.deepStrictEqual(records, [`local_${ids.kept}.json`]);
  const kept = fs.readdirSync(path.join(A.state, 'replaced'));
  assert.ok(kept.some((d) => fs.existsSync(path.join(A.state, 'replaced', d, 'desktop', 'claude_desktop_config.json'))), 'the settings file written over was kept');

  // Everything is in place.
  plan = open('0').prepareFullRestore(full.path);
  assert.deepStrictEqual([plan.counts.new, plan.counts.replace, plan.warnings], [0, 0, []]);
});

test('engine: under another home folder, the paths in the rest of Claude\'s data are the new home\'s', { skip }, async () => {
  const { A } = await busyDevice('old');
  const { hook } = claudeExtras(A);
  const full = A.engine.createFullBackup({ outDir: A.folder('usb') });
  const B = device('new');
  B.folder('code/acme-x');
  const plan = B.engine.prepareFullRestore(full.path);
  await B.engine.applyFullRestore(plan.id);
  const settings = JSON.parse(fs.readFileSync(path.join(B.claude, 'settings.json'), 'utf8'));
  assert.strictEqual(settings.hooks.Stop[0].hooks[0].command, path.join(B.claude, 'hooks', 'notify.sh'));
  assert.notStrictEqual(hook, settings.hooks.Stop[0].hooks[0].command);
  assert.strictEqual(fs.statSync(path.join(B.claude, 'hooks', 'notify.sh')).mode & 0o777, 0o755);
  const installed = JSON.parse(fs.readFileSync(path.join(B.claude, 'plugins', 'installed_plugins.json'), 'utf8'));
  assert.strictEqual(installed.plugins['x@market'][0].installPath, path.join(B.claude, 'plugins', 'cache', 'x'));
  assert.ok(fs.existsSync(path.join(chatDir(B, 'code/acme-x'), 'canvas', 'logo.svg')), 'in the Claude folder of the project under the new home');
  const cc = JSON.parse(fs.readFileSync(path.join(B.claude, '.claude.json'), 'utf8'));
  assert.deepStrictEqual(Object.keys(cc.projects), [path.join(B.home, 'code/acme-x')]);
  assert.ok(fs.existsSync(path.join(B.home, 'code/acme-x', 'CLAUDE.local.md')));
});

const OTHER = '22222222-2222-4222-8222-222222222222';

test('engine: backups take what the backup settings leave in; the snapshot before an operation takes every file, and the chosen chats', { skip }, async () => {
  const { A, root } = await busyDevice('mac');
  chatOn(A, 'code/acme-x', CHAT, ['Fix the login bug']);
  chatOn(A, 'Desktop', OTHER, ['Plan the week']);
  fs.writeFileSync(path.join(root, 'workspaces', 'Fix.code-workspace'), JSON.stringify({ folders: [{ path: path.join(A.home, 'code/acme-x') }] }));
  const [r] = A.engine.workspaces();
  A.engine.updateSettings({ backup: { excludeProjects: ['desktop'], excludeWorkspaceFiles: { [r.key]: ['workspaces/Fix.code-workspace'] }, claude: false, chats: 'some', chatProjects: ['acme-x'] } });

  const manual = await A.engine.createBackup('manual');
  assert.strictEqual(manual.chats, 1);
  const contentsOf = async (snapshot) => A.engine.bundleContents((await A.engine.openSnapshot(snapshot)).ref);
  const b = await contentsOf(manual.snapshot);
  assert.deepStrictEqual(b.locations.map((l) => l.id).sort(), ['project:acme-x', `workspaceRoot:${r.key}`]);
  assert.deepStrictEqual(b.locations.find((l) => l.type === 'workspaceRoot').skipped, ['workspaces/Fix.code-workspace']);
  assert.deepStrictEqual(b.files.filter((f) => f.location.startsWith('workspaceRoot')).map((f) => f.rel), ['workspaces/App.code-workspace']);
  assert.deepStrictEqual(b.chatList.map((c) => c.id), [CHAT], 'the chats of the chosen project only');

  // The preview follows a draft without saving it.
  assert.deepStrictEqual([A.engine.backupPreview().chats.count, A.engine.backupPreview({ chats: 'all' }).chats.count, A.engine.backupPreview({ chats: 'none' }).chats.count], [1, 2, 0]);
  assert.strictEqual(A.engine.settings().backup.chats, 'some');

  // Before an operation: every memory, workspace file and Claude setting, whatever the settings say, and the chats they
  // choose (so the stage keeps the chats it has).
  const done = await A.engine.fixWorkspace({ root: r.key, rel: 'workspaces/Fix.code-workspace', apply: true });
  const before = await contentsOf(done.backupSnapshot);
  assert.deepStrictEqual(before.locations.map((l) => l.id).sort(), ['claude', 'project:acme-x', 'project:desktop', `workspaceRoot:${r.key}`]);
  assert.ok(before.files.some((f) => f.rel === 'workspaces/Fix.code-workspace'));
  assert.deepStrictEqual(before.chatList.map((c) => c.id), [CHAT]);
  assert.deepStrictEqual([before.kind, before.reason], ['before', 'workspace-fix']);

  // A chat brings its project's memory, even when the project is left out by name.
  A.engine.updateSettings({ backup: { chats: 'some', chatProjects: [], chatIds: [OTHER] } });
  const withChat = await contentsOf((await A.engine.createBackup('manual')).snapshot);
  assert.deepStrictEqual(withChat.chatList.map((c) => c.id), [OTHER]);
  assert.ok(withChat.files.some((f) => f.location === 'project:desktop'), 'the left-out project\'s memory came with its chat');
});

test('engine: a backup brings its chats back, and the stage keeps them as links of the chats themselves', { skip }, async () => {
  const { A } = await busyDevice('mac');
  chatOn(A, 'code/acme-x', CHAT, ['Fix the login bug', 'And the logout']);
  A.engine.updateSettings({ backup: { chats: 'all' } });
  const manual = await A.engine.createBackup('manual');
  const file = path.join(chatDir(A, 'code/acme-x'), `${CHAT}.jsonl`);
  const transcript = fs.readFileSync(file, 'utf8');
  const staged = path.join(A.engine.backupStatus().stageDir, 'chats', 'p', `${CHAT}.jsonl`);
  assert.strictEqual(fs.statSync(staged).ino, fs.statSync(file).ino);

  // Going back to the backup brings a lost chat back.
  fs.rmSync(file);
  const { ref } = await A.engine.openSnapshot(manual.snapshot);
  const plan = A.engine.prepare({ bundlePath: ref, mode: 'restore' });
  assert.deepStrictEqual(plan.chats.map((c) => [c.id, c.status]), [[CHAT, 'new']]);
  await A.engine.apply(plan.id, {});
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

test('engine: a chat from another computer shows in the desktop app here before the app ran a Code session with that account, and a record left out before is written when the bundle is opened again', { skip }, async () => {
  const A = device('mac');
  A.project('code/acme-x', { 'MEMORY.md': '- [N](n.md) — note\n', 'n.md': 'note\n' }, { git: GIT });
  chatOn(A, 'code/acme-x', CHAT, ['Fix the login bug']);
  const cwd = path.join(A.home, 'code/acme-x');
  fs.mkdirSync(path.join(A.desktop, 'claude-code-sessions', 'acct', 'org'), { recursive: true });
  record(A, 'local_aaaa', { cliSessionId: CHAT, cwd, originCwd: cwd, gitAnchorsFolderRealpath: cwd, title: 'Login bug' });
  const B = device('win');
  B.folder('Documents/GitHub/acme-x', { git: 'https://github.com/me/acme-x' });
  B.folder('Downloads');
  // The desktop app is installed here but was used only through Remote Control: it has no Code session folders yet.
  fs.mkdirSync(B.desktop, { recursive: true });
  const bundle = A.engine.exportBundle({ outDir: path.join(B.home, 'Downloads'), selection: { projects: [], workspaces: [], claude: false, chats: [CHAT] } }).path;
  await B.engine.apply(B.engine.prepare({ bundlePath: bundle }).id, {});
  const rec = path.join(B.desktop, 'claude-code-sessions', 'acct', 'org', 'local_aaaa.json');
  const here = path.join(B.home, 'Documents/GitHub/acme-x');
  const r = JSON.parse(fs.readFileSync(rec, 'utf8'));
  assert.deepStrictEqual([r.cliSessionId, r.cwd, r.originCwd, r.gitAnchorsFolderRealpath, r.title], [CHAT, here, here, here, 'Login bug']);

  // Taken before without its record: opening the bundle again writes it, and after that there is nothing left to do.
  fs.rmSync(rec);
  let plan = B.engine.prepare({ bundlePath: bundle });
  assert.deepStrictEqual(plan.chats.map((c) => [c.id, c.status]), [[CHAT, 'updated']]);
  await B.engine.apply(plan.id, {});
  assert.ok(fs.existsSync(rec));
  plan = B.engine.prepare({ bundlePath: bundle });
  assert.strictEqual(plan.chats[0].status, 'same');

  // A computer without the desktop app gets the chat, and nothing in a folder of an app that is not there.
  const L = device('laptop');
  L.folder('Documents/GitHub/acme-x', { git: 'https://github.com/me/acme-x' });
  await L.engine.apply(L.engine.prepare({ bundlePath: bundle }).id, {});
  assert.ok(fs.existsSync(path.join(chatDir(L, 'Documents/GitHub/acme-x'), `${CHAT}.jsonl`)));
  assert.strictEqual(fs.existsSync(L.desktop), false);
});

test('engine: the Desktop of another computer goes to the Desktop here, also when Windows keeps it in OneDrive', { skip }, async () => {
  const A = device('mac');
  A.project('Desktop', { 'MEMORY.md': '- [D](d.md) — desk\n', 'd.md': 'desk\n' });
  const B = device('win');
  B.folder('OneDrive/Desktop');
  B.folder('Downloads');
  let plan = B.engine.prepare({ bundlePath: send(A, B) });
  let m = plan.matches.find((x) => x.remote.key === 'desktop');
  assert.deepStrictEqual([m.include, m.local && m.local.path], [true, path.join(B.home, 'OneDrive', 'Desktop')]);
  await B.engine.apply(plan.id, {});
  assert.strictEqual(B.read('OneDrive/Desktop', 'd.md'), 'desk\n');

  // On a computer where Claude Code already has a project in OneDrive's Desktop, that project is the Desktop's.
  const C = device('pc');
  C.project('OneDrive/Desktop', { 'MEMORY.md': '- [H](h.md) — here\n', 'h.md': 'here\n' });
  C.folder('Downloads');
  plan = C.engine.prepare({ bundlePath: send(A, C) });
  m = plan.matches.find((x) => x.remote.key === 'desktop');
  assert.deepStrictEqual([m.status, m.how, m.local.path], ['ready', 'path', path.join(C.home, 'OneDrive', 'Desktop')]);
});

// macOS can keep a name with Turkish letters as NFD (Ş as S and a cedilla), Windows keeps it as typed (NFC), and
// Claude Code names its project after the NFC form.
test('engine: a folder with Turkish letters matches between computers whichever form each disk keeps, also when picked by hand, and its chats go where Claude Code looks', { skip }, async () => {
  const NAME = 'Desktop/Şikayetvar Entegrasyonu';
  const NFD = NAME.normalize('NFD');
  const A = device('mac');
  A.project(NFD, { 'MEMORY.md': '- [N](n.md) — not\n', 'n.md': 'not\n' });
  chatOn(A, NFD, CHAT, ['Şikayetleri çek']);
  fs.mkdirSync(path.join(A.desktop, 'claude-code-sessions', 'acct', 'org'), { recursive: true });
  record(A, 'local_aaaa', { cliSessionId: CHAT, cwd: path.join(A.home, NFD), originCwd: path.join(A.home, NFD), title: 'Şikayetler' });
  const selection = { projects: [], workspaces: [], claude: false, chats: [CHAT] };
  const historyProject = (d) => JSON.parse(fs.readFileSync(path.join(d.claude, 'history.jsonl'), 'utf8').trim().split('\n').pop()).project;

  // Claude Code here already has the project, in NFC form: the same place, taken without asking.
  const B = device('win');
  B.project(NAME, { 'MEMORY.md': '- [H](h.md) — here\n', 'h.md': 'here\n' });
  B.folder('Downloads');
  fs.mkdirSync(B.desktop, { recursive: true });
  let plan = B.engine.prepare({ bundlePath: A.engine.exportBundle({ outDir: path.join(B.home, 'Downloads'), selection }).path });
  let m = plan.matches.find((x) => x.type === 'project');
  assert.deepStrictEqual([m.status, m.how, m.include], ['ready', 'path', true]);
  await B.engine.apply(plan.id, {});
  const here = path.join(B.home, NAME);
  assert.ok(fs.existsSync(path.join(chatDir(B, NAME), `${CHAT}.jsonl`)));
  const r = JSON.parse(fs.readFileSync(path.join(B.desktop, 'claude-code-sessions', 'acct', 'org', 'local_aaaa.json'), 'utf8'));
  assert.deepStrictEqual([r.cwd, r.originCwd, historyProject(B)], [here, here, here]);

  // Elsewhere here, kept as NFD and picked by hand: the Claude folder has the name Claude Code gives that folder.
  const C = device('pc');
  const picked = C.folder('Belgeler/Şikayetvar Entegrasyonu'.normalize('NFD'));
  C.folder('Downloads');
  fs.mkdirSync(C.desktop, { recursive: true });
  const bundle = A.engine.exportBundle({ outDir: path.join(C.home, 'Downloads'), selection }).path;
  plan = C.engine.prepare({ bundlePath: bundle });
  m = plan.matches.find((x) => x.type === 'project');
  assert.strictEqual(m.status, 'unmatched');
  plan = C.engine.prepare({ bundlePath: bundle, mappings: { [m.id]: { action: 'create', path: picked } } });
  await C.engine.apply(plan.id, {});
  const named = path.join(C.home, 'Belgeler/Şikayetvar Entegrasyonu').replace(/[^a-zA-Z0-9]/g, '-');
  assert.ok(fs.existsSync(path.join(C.claude, 'projects', named, `${CHAT}.jsonl`)));
  assert.deepStrictEqual(fs.readdirSync(path.join(C.claude, 'projects')), [named]);
  const r2 = JSON.parse(fs.readFileSync(path.join(C.desktop, 'claude-code-sessions', 'acct', 'org', 'local_aaaa.json'), 'utf8'));
  assert.deepStrictEqual([r2.cwd, historyProject(C)], [picked.normalize('NFC'), picked.normalize('NFC')]);
  // The project is seen with its chat when this app looks again.
  const p = C.engine.scan().projects.find((x) => x.id === named);
  assert.strictEqual(p.exists, true);
});

test('engine: chats go with their Claude desktop group, a scratch session gets its folder, and the group is set up while the app is closed', { skip }, async () => {
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
  assert.strictEqual((await A.engine.createBackup('manual')).chats, 4, 'a group in the backup settings takes all of its chats');

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
  let done = await B.engine.apply(plan.id, {});
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
  done = await B.engine.apply(plan.id, {});
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
  assert.strictEqual((await B.engine.apply(plan.id, {})).nothing, true);
});

// A chat larger than one chunk of a bundle (16 MB), quick to compress.
function largeChat(A, { slow = false } = {}) {
  A.project('code/big', { 'MEMORY.md': '- [N](n.md)\n', 'n.md': 'note' });
  const id = '11111111-2222-4333-8444-555555555555';
  chatOn(A, 'code/big', id, ['start']);
  const dir = path.join(A.claude, 'projects', P.encodeProjectDir(path.join(A.home, 'code/big')));
  const line = `${JSON.stringify({ type: 'user', message: { role: 'user', content: 'x'.repeat(4000) } })}\n`;
  fs.appendFileSync(path.join(dir, `${id}.jsonl`), line.repeat(Math.ceil((40 * 1024 * 1024) / line.length)));
  // Random text compresses slowly, which leaves time to stop the backup.
  if (slow) fs.appendFileSync(path.join(dir, `${id}.jsonl`), `${JSON.stringify({ type: 'user', message: { content: crypto.randomBytes(120 * 1024 * 1024).toString('base64') } })}\n`);
  A.engine.updateSettings({ backup: { chats: 'all' } });
  return { id, source: fs.readFileSync(path.join(dir, `${id}.jsonl`)) };
}

test('a chat larger than a chunk is written in parts, reported as it goes, and reads back the same', () => {
  const A = device('mac');
  const { id, source } = largeChat(A);
  const outDir = A.folder('out');
  const job = A.engine.exportJob({ outDir, selection: { chats: [id] } });
  const seen = [];
  const written = A.engine.runBackupJob(job, (phase, done, total) => seen.push({ phase, done, total }));
  assert.ok(fs.existsSync(job.abs));
  assert.deepStrictEqual(fs.readdirSync(outDir), [path.basename(job.abs)], 'no temp file stays behind');
  assert.deepStrictEqual([...new Set(seen.map((x) => x.phase))], ['scan', 'write', 'verify']);
  const writes = seen.filter((x) => x.phase === 'write');
  assert.ok(writes.length > 3, 'reported chunk by chunk');
  assert.ok(writes.every((x, i) => !i || x.done >= writes[i - 1].done), 'never goes back');
  assert.strictEqual(seen[seen.length - 1].done, seen[seen.length - 1].total);
  assert.ok(A.engine.finishBackupJob(job, written).activityId);

  const b = readBundle(job.abs);
  assert.ok(b.chats.blobs.get(`p/${id}.jsonl`).members.length >= 3);
  assert.ok(b.chats.read(`p/${id}.jsonl`).equals(source), 'one file to anything that reads it');
});

test('a damaged part of a large chat fails the check', () => {
  const A = device('mac');
  const { id } = largeChat(A);
  const { path: abs } = A.engine.exportBundle({ outDir: A.folder('out'), selection: { chats: [id] } });
  const e = readBundle(abs).chats.blobs.get(`p/${id}.jsonl`);
  const fd = fs.openSync(abs, 'r+');
  fs.writeSync(fd, Buffer.from('damage'), 0, 6, e.offset + e.members[0] + 2000);
  fs.closeSync(fd);
  assert.throws(() => readBundle(abs).chats.check(`p/${id}.jsonl`), (err) => err.code === 'BUNDLE_INTEGRITY');
});

test('a bundle written in another process is recorded only at the end; stopped, it leaves nothing and the history stays', { skip }, async () => {
  const A = device('mac');
  const { id } = largeChat(A, { slow: true });
  const outDir = A.folder('out');
  const history = () => (fs.existsSync(path.join(A.state, 'history.json')) ? fs.readFileSync(path.join(A.state, 'history.json'), 'utf8') : null);
  const historyBefore = history();
  const activity = A.engine.activity(100).length;
  const selection = { chats: [id] };
  const start = (job) => {
    const worker = fork(path.join(__dirname, '..', 'app', 'backup-worker.js'), [], { stdio: 'ignore' });
    const exited = new Promise((resolve) => worker.once('exit', resolve));
    worker.send({ job, engineOptions: { env: A.env, home: A.home, hostname: 'mac.local' } });
    return { worker, exited };
  };
  const end = (w) => new Promise((resolve) => w.worker.on('message', (m) => m.type !== 'progress' && resolve(m)));

  const job = A.engine.exportJob({ outDir, selection });
  const first = start(job);
  const writing = await new Promise((resolve) => first.worker.on('message', (m) => (m.type !== 'progress' || m.phase === 'write') && resolve(m)));
  assert.strictEqual(writing.type, 'progress', 'it was still writing');
  first.worker.kill('SIGKILL');
  await first.exited;
  A.engine.discardBackupJob(job);
  assert.deepStrictEqual(fs.readdirSync(outDir), []);
  assert.strictEqual(history(), historyBefore);
  assert.strictEqual(A.engine.activity(100).length, activity);

  const next = A.engine.exportJob({ outDir, selection });
  const second = start(next);
  const m = await end(second);
  second.worker.kill();
  await second.exited;
  assert.strictEqual(m.type, 'done');
  const r = A.engine.finishBackupJob(next, m.result);
  assert.strictEqual(r.path, next.abs);
  assert.strictEqual(r.chats, 1);
  assert.notStrictEqual(history(), historyBefore, 'the version history is written');
  assert.strictEqual(A.engine.activity(1)[0].type, 'export');
  assert.doesNotThrow(() => readBundle(next.abs).chats.check(`p/${id}.jsonl`));

  // Nothing to put in it: it says so from the other process too.
  const third = start(A.engine.exportJob({ outDir, selection: { projects: [], workspaces: [], claude: false } }));
  const e = await end(third);
  third.worker.kill();
  await third.exited;
  assert.strictEqual(e.error.code, 'EMPTY_EXPORT');
});

// The disk as full as given: free bytes.
const diskWith = (free) => {
  const real = fs.statfsSync;
  fs.statfsSync = () => ({ bavail: free, bsize: 1 });
  return () => { fs.statfsSync = real; };
};
const GB = 1024 ** 3;

test('the size of a file is estimated before it is written, close to what it turns out to be', () => {
  const A = device('mac');
  A.project('code/big', { 'MEMORY.md': '- [N](n.md)\n', 'n.md': 'note' });
  const id = '11111111-2222-4333-8444-555555555555';
  chatOn(A, 'code/big', id, ['start']);
  const transcript = path.join(chatDir(A, 'code/big'), `${id}.jsonl`);
  // Text that compresses well, then some that does not.
  fs.appendFileSync(transcript, `${JSON.stringify({ message: { content: 'word '.repeat(2000) } })}\n`.repeat(4000));
  fs.appendFileSync(transcript, `${JSON.stringify({ message: { content: crypto.randomBytes(6 * 1024 * 1024).toString('base64') } })}\n`);
  for (const make of [() => A.engine.exportJob({ outDir: A.folder('bundles'), selection: { chats: [id] } }), () => A.engine.fullBackupJob({ outDir: A.folder('out') })]) {
    const job = make();
    let estimate = null;
    const written = A.engine.runBackupJob(job, (phase, done, total, info) => { if (info) estimate = info.estimate; });
    assert.ok(Math.abs(estimate - written.size) <= written.size * 0.25 + 256 * 1024, `${job.type}: ${estimate} close to ${written.size}`);
    A.engine.finishBackupJob(job, written);
  }
  const preview = A.engine.fullBackupPreview();
  assert.ok(preview.estimate > 0 && preview.space.need === preview.estimate);
});

test('nothing is written when the file would not fit with room to spare: full backups, bundles, and a transfer whose backup cannot be taken', async () => {
  const { A, B } = pair();
  const bundlePath = send(A, B);
  const outDir = B.folder('out');
  const activity = B.engine.activity(1000).length;
  const plan = B.engine.prepare({ bundlePath });

  // On the computer's own disk 2 GB stay free.
  const restore = diskWith(2 * GB + 4096);
  try {
    const noSpace = (e) => e.code === 'NO_SPACE' && e.need > 0 && e.free === 2 * GB + 4096 && e.reserve === 2 * GB;
    assert.throws(() => B.engine.createFullBackup({ outDir }), noSpace);
    assert.throws(() => A.engine.exportBundle({ outDir }), noSpace);
    assert.strictEqual(B.engine.fullBackupPreview().space.enough, false);
    assert.deepStrictEqual(B.engine.diskSpace(outDir, 8192), { free: 2 * GB + 4096, need: 8192, reserve: 2 * GB, enough: false });
    assert.strictEqual(B.engine.diskSpace(outDir, 4096).enough, true, 'exactly what is left above what stays free');
  } finally {
    restore();
  }
  // The snapshot before the transfer fails (here: its disk is full): nothing is written, nothing recorded.
  B.fake.fail = Object.assign(new Error('Not enough free space.'), { code: 'NO_SPACE' });
  await assert.rejects(B.engine.apply(plan.id, {}), (e) => e.code === 'NO_SPACE', 'a transfer stops at its backup, before anything is written');
  B.fake.fail = null;
  assert.ok(!B.has('work/acme-x', 'n.md'), 'the transfer wrote nothing');
  assert.deepStrictEqual(fs.readdirSync(outDir), []);
  assert.strictEqual(B.backups('before'), 0);
  assert.strictEqual(B.engine.activity(1000).length, activity, 'nothing recorded');
  await B.engine.apply(plan.id, {});
  assert.strictEqual(B.backups('before'), 1, 'with its backup it goes ahead');
});

test('the files macOS keeps next to bundles on an exFAT disk (._name) are not bundles', () => {
  const A = device('mac');
  A.project('code/acme-x', { 'MEMORY.md': '- [N](n.md) — note\n', 'n.md': 'note\n' });
  const { path: abs } = A.engine.exportBundle({ outDir: A.folder('Downloads') });
  const dir = path.dirname(abs);
  const name = path.basename(abs);
  const appleDouble = path.join(dir, `._${name}`);
  fs.writeFileSync(appleDouble, Buffer.alloc(4096));
  assert.deepStrictEqual(A.engine.library().filter((b) => b.dir === dir).map((b) => b.name), [name]);
  assert.ok(A.engine.library().every((b) => !b.error), 'nothing shows as damaged');
  assert.strictEqual(fs.readFileSync(appleDouble).length, 4096, 'left alone: it belongs to macOS');
});

test('a file that does not pass the check after writing never gets its name, and the error says it is about this write', () => {
  const A = device('mac');
  const outDir = A.folder('out');
  const abs = path.join(outDir, 'x.memsync');
  const bad = { format: 'claude-memory-sync', version: 2, device: { id: 'x' }, locations: { nope: { type: 'nope' } }, files: {}, history: {} };
  const said = (e) => e.code === 'BUNDLE_WRITE_CHECK' && /Invalid location/.test(e.detail);
  assert.throws(() => writeBundle(abs, bad), said);
  assert.throws(() => writeBundleV3(abs, bad, []), said);
  assert.deepStrictEqual(fs.readdirSync(outDir), [], 'neither the file nor a temp file');
});

