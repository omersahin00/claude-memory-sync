'use strict';
// This device's backups with the real restic (lib/backups.js, lib/stage.js, through the engine): set up with a password
// and a recovery code, backed up incrementally and encrypted, a snapshot before every operation that undo goes back to,
// a snapshot restored through the usual plan, chats kept as links, and the folder opened again after a reset.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const P = require('../lib/paths');
const { createEngine } = require('../lib/engine');
const repo = require('../core/repository');

// On Windows too: the stage's links and restic's paths there are checked only on GitHub's Windows runner.
const skip = false;
const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cms-backups-')));
test.after(() => fs.rmSync(ROOT, { recursive: true, force: true }));
const PASSWORD = 'correct horse battery staple';
// The system's encryption of the saved password, as a test stand-in.
const codec = { available: () => true, encrypt: (x) => Buffer.from(`k:${x}`), decrypt: (b) => b.toString().replace(/^k:/, '') };
const CHAT = '22222222-2222-4222-8222-222222222222';

let n = 0;
function device(name) {
  const home = path.join(ROOT, `${name}-${++n}`);
  const claude = path.join(home, '.claude');
  const state = path.join(home, '.state');
  fs.mkdirSync(path.join(claude, 'projects'), { recursive: true });
  const env = { CLAUDE_CONFIG_DIR: claude, CLAUDE_MEMORY_SYNC_HOME: state, CLAUDE_DESKTOP_DIR: path.join(home, 'ClaudeDesktop') };
  const mem = (folder) => path.join(claude, 'projects', P.encodeProjectDir(path.join(home, folder)), 'memory');
  const d = {
    home, claude, state, env,
    make: () => createEngine({ env, home, hostname: `${name}.local`, codec }),
    write(folder, rel, text) {
      fs.mkdirSync(path.join(home, folder), { recursive: true });
      fs.mkdirSync(mem(folder), { recursive: true });
      fs.writeFileSync(path.join(mem(folder), rel), text);
    },
    read: (folder, rel) => fs.readFileSync(path.join(mem(folder), rel), 'utf8'),
    has: (folder, rel) => fs.existsSync(path.join(mem(folder), rel)),
    chatDir: (folder) => path.join(claude, 'projects', P.encodeProjectDir(path.join(home, folder))),
  };
  d.engine = d.make();
  return d;
}

const byRel = (plan) => Object.fromEntries(plan.items.filter((i) => i.group !== 'same' && i.group !== 'kept').map((i) => [`${i.scopeLabel}/${i.rel}`, i.group]));

test('backups: set up once, encrypted and incremental; every operation is backed up first and undone from that snapshot', { skip }, async () => {
  const A = device('mac');
  A.write('code/acme', 'MEMORY.md', '- [N](n.md) — note\n');
  A.write('code/acme', 'n.md', 'secret note\n');
  const disk = path.join(A.home, 'usb');
  fs.mkdirSync(disk);

  await assert.rejects(A.engine.createBackup('manual'), (e) => e.code === 'NO_BACKUP_SET');
  assert.strictEqual(A.engine.backupStatus().ask, true, 'a new install asks once');
  const up = await A.engine.setUpBackups({ place: disk, password: PASSWORD });
  assert.match(up.recoveryCode, /^[0-9A-Z]{4}(-[0-9A-Z]{4}){5}$/);
  assert.strictEqual(up.view.repo, path.join(disk, 'Claude Memory Sync', 'Claude'));
  assert.strictEqual(up.view.place, disk);
  assert.strictEqual(A.engine.backupStatus().ask, false);
  await assert.rejects(A.engine.setUpBackups({ place: disk, password: PASSWORD }), (e) => e.code === 'BACKUP_SET_EXISTS');

  const one = await A.engine.createBackup('manual');
  assert.deepStrictEqual([one.stats.projects, one.stats.memoryFiles], [1, 2]);
  A.write('code/acme', 'n.md', 'secret note, longer now\n');
  const two = await A.engine.createBackup('scheduled');
  assert.strictEqual(two.filesChanged, 2, 'only what changed is read again: the file and the manifest');
  assert.strictEqual(two.filesNew, 0);
  assert.strictEqual(A.engine.backupStatus().set.status, 'ok');

  // Nothing in the backup folder can be read without the password.
  const needle = Buffer.from('secret note');
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
  for (const f of walk(up.view.repo)) assert.strictEqual(fs.readFileSync(f).includes(needle), false, `${f} holds the text as it is`);

  // A bundle from another device: the transfer is backed up first, and undo puts back what it changed.
  const B = device('win');
  B.write('code/acme', 'MEMORY.md', '- [N](n.md) — note\n- [M](m.md) — more\n');
  B.write('code/acme', 'n.md', 'from the other device\n');
  B.write('code/acme', 'm.md', 'more\n');
  const bundle = B.engine.exportBundle({ outDir: A.home }).path;
  const plan = A.engine.prepare({ bundlePath: bundle, mappings: { 'project:acme': { action: 'map', projectId: A.engine.projects().projects[0].id } } });
  const decisions = { items: Object.fromEntries(plan.items.filter((i) => i.choices && i.choices.length).map((i) => [i.key, i.choices.includes('b') ? 'b' : i.choices[0]])) };
  const phases = new Set();
  const res = await A.engine.apply(plan.id, decisions, { onProgress: (p) => phases.add(p.phase) });
  assert.ok(res.backupSnapshot, 'the snapshot taken first');
  assert.ok(phases.has('stage') && phases.has('backup'));
  assert.strictEqual(A.read('code/acme', 'm.md'), 'more\n');

  const snaps = await A.engine.snapshots();
  assert.deepStrictEqual(snaps.map((s) => [s.kind, s.reason]), [['before', 'sync'], ['backup', null], ['backup', null]], 'newest first');
  assert.ok(snaps.every((s) => s.mine && s.host === 'mac'));
  const entry = A.engine.activity().find((e) => e.id === res.activityId);
  assert.strictEqual(entry.backupSnapshot, res.backupSnapshot);
  assert.ok(entry.undoable);

  const undo = await A.engine.prepareUndo(res.activityId);
  assert.ok(Object.keys(byRel(undo)).includes('acme/m.md'));
  await A.engine.apply(undo.id, {});
  assert.strictEqual(A.has('code/acme', 'm.md'), false, 'the file the transfer added is gone again');
  assert.strictEqual(A.read('code/acme', 'n.md'), 'secret note, longer now\n');
  assert.ok(A.engine.activity().find((e) => e.id === res.activityId).undone);

  // The first backup, opened and restored through the plan: the device goes back to how it was then.
  const first = (await A.engine.snapshots()).filter((s) => s.kind === 'backup').pop();
  const opened = await A.engine.openSnapshot(first.id);
  assert.strictEqual(opened.bundle.snapshot.id, first.id);
  assert.strictEqual(opened.bundle.stats.memoryFiles, 2);
  const contents = A.engine.bundleContents(opened.ref);
  assert.deepStrictEqual(contents.files.map((f) => f.rel).sort(), ['MEMORY.md', 'n.md']);
  const back = A.engine.prepare({ bundlePath: opened.ref, mode: 'restore' });
  assert.deepStrictEqual(byRel(back), { 'acme/n.md': 'updated' });
  await A.engine.apply(back.id, {});
  assert.strictEqual(A.read('code/acme', 'n.md'), 'secret note\n');
  assert.strictEqual((await A.engine.snapshots()).filter((s) => s.kind === 'before').length, 3, 'each of the three operations was backed up first');
});

test('backups: only the newest snapshots before operations stay; chats are links in the stage, not copies, and come back', { skip }, async () => {
  const A = device('mac');
  A.write('code/acme', 'MEMORY.md', 'm\n');
  const dir = A.chatDir('code/acme');
  fs.writeFileSync(path.join(dir, `${CHAT}.jsonl`), `${JSON.stringify({ type: 'user', sessionId: CHAT, cwd: path.join(A.home, 'code/acme'), message: { content: 'Hello' } })}\n`);
  fs.mkdirSync(path.join(A.claude, 'file-history', CHAT), { recursive: true });
  fs.writeFileSync(path.join(A.claude, 'file-history', CHAT, 'f@v1'), 'old\n');
  A.engine.updateSettings({ backup: { chats: 'all' } });
  const disk = path.join(A.home, 'disk');
  fs.mkdirSync(disk);
  await A.engine.setUpBackups({ place: disk, password: PASSWORD });
  A.engine.backupSettings({ keepBefore: 2 });
  assert.strictEqual(A.engine.backupStatus().set.keepBefore, 2);

  await A.engine.createBackup('manual');
  const stage = A.engine.backupStatus().stageDir;
  const staged = fs.statSync(path.join(stage, 'chats', 'p', `${CHAT}.jsonl`));
  const own = fs.statSync(path.join(dir, `${CHAT}.jsonl`));
  assert.strictEqual(staged.ino, own.ino, 'the chat is a link, which takes no room');
  for (let i = 0; i < 3; i++) await A.engine.takeBefore('sync');
  const before = (await A.engine.snapshots()).filter((s) => s.kind === 'before');
  assert.strictEqual(before.length, 2);

  // Claude goes on with the chat; the next backup holds the longer one, the stage still a link.
  fs.appendFileSync(path.join(dir, `${CHAT}.jsonl`), `${JSON.stringify({ type: 'user', sessionId: CHAT, message: { content: 'More' } })}\n`);
  const later = await A.engine.createBackup('manual');
  assert.strictEqual(later.chats, 1);
  const transcript = fs.readFileSync(path.join(dir, `${CHAT}.jsonl`), 'utf8');

  // Lost here; the backup brings it back.
  fs.rmSync(path.join(dir, `${CHAT}.jsonl`));
  fs.rmSync(path.join(A.claude, 'file-history', CHAT), { recursive: true });
  const opened = await A.engine.openSnapshot(later.snapshot);
  const plan = A.engine.prepare({ bundlePath: opened.ref, mode: 'restore' });
  assert.deepStrictEqual(plan.chats.map((c) => [c.id, c.status]), [[CHAT, 'new']]);
  await A.engine.apply(plan.id, {});
  assert.strictEqual(fs.readFileSync(path.join(dir, `${CHAT}.jsonl`), 'utf8'), transcript);
  assert.strictEqual(fs.readFileSync(path.join(A.claude, 'file-history', CHAT, 'f@v1'), 'utf8'), 'old\n');
});

test('backups: after a reset the backup folder opens again with the recovery code, and backing up goes on in it', { skip }, async () => {
  const A = device('mac');
  A.write('code/acme', 'MEMORY.md', 'one\n');
  const disk = path.join(A.home, 'usb');
  fs.mkdirSync(disk);
  const up = await A.engine.setUpBackups({ place: disk, password: PASSWORD });
  await A.engine.createBackup('manual');

  // The computer is reset: the app's folder is gone, the disk is not.
  fs.rmSync(A.state, { recursive: true, force: true });
  const R = A.make();
  await assert.rejects(R.openBackups({ dir: up.view.repo, secret: 'wrong password' }), (e) => e.code === 'WRONG_PASSWORD');
  await assert.rejects(R.openBackups({ dir: up.view.repo, secret: up.recoveryCode }), (e) => e.code === 'NEED_NEW_PASSWORD');
  const opened = await R.openBackups({ dir: up.view.repo, secret: up.recoveryCode, newPassword: 'a new password here' });
  assert.strictEqual(opened.byRecovery, true);
  assert.strictEqual(opened.snapshots, 1);
  assert.strictEqual(opened.view.keepBefore, 50);
  const list = await R.snapshots();
  assert.strictEqual(list.length, 1);
  A.write('code/acme', 'MEMORY.md', 'two\n');
  const next = await R.createBackup('manual');
  assert.ok(next.snapshot);
  assert.strictEqual((await R.snapshots()).length, 2);
  // The old password does not open it any more; the new one and the code do.
  await assert.rejects(repo.keys({ dir: up.view.repo, cacheDir: path.join(A.state, 'cache'), password: PASSWORD }), (e) => e.code === 'WRONG_PASSWORD');

  // A folder of Folder Backup is not a Claude backup.
  const other = path.join(A.home, 'other');
  fs.mkdirSync(other);
  await repo.createRepository({ dir: other, cacheDir: path.join(A.state, 'cache'), password: PASSWORD });
  fs.rmSync(path.join(A.state, 'sets.json'));
  const S = A.make();
  await assert.rejects(S.openBackups({ dir: other, secret: PASSWORD }), (e) => e.code === 'OTHER_APP' && e.detail === 'Folder Backup');
});
