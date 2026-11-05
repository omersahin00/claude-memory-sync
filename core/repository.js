'use strict';
// A backup folder: restic calls it a repository. Everything in it is encrypted with one master key (AES-256, with a
// Poly1305 code on every file, so any change is found), and each secret that opens it is a key that unlocks that master
// key. Every backup folder has two keys: the password and the recovery code. A forgotten password is replaced with the
// code, and the backups stay as they are.
//
// Backups are only ever added: a backup writes new files and never changes one that is there, and its snapshot is
// written last, so a backup stopped at any point leaves the earlier ones whole (docs/TASARIM.md).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { run } = require('./restic');
const { newRecoveryCode, normalizeRecoveryCode } = require('./recovery-code');
const { BackupError } = require('./errors');

// The names on the two keys, so the keys say which is which even when nothing else about the folder is known.
const KEY_HOST = 'folder-backup';
const PASSWORD_USER = 'password';
const RECOVERY_USER = 'recovery-code';

// opts of every function: dir (the backup folder), password, cacheDir (restic's cache) and keyHint (restic.run).
const ctxOf = ({ dir, password, cacheDir, keyHint }) => ({ repo: dir, password, cacheDir, keyHint });

function needPassword(password) {
  if (typeof password !== 'string' || !password) throw new BackupError('NO_PASSWORD', 'A password is needed.');
}

// restic reads a new key's secret only from a file. It is written into a folder only this user can open, read by restic
// and removed straight away, also when restic fails.
async function withSecretFile(secret, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'folder-backup-'));
  const file = path.join(dir, 'secret');
  try {
    fs.writeFileSync(file, secret, { mode: 0o600 });
    return await fn(file);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const isEmptyDir = (dir) => fs.readdirSync(dir).length === 0;

// What a new backup folder left behind when it could not be finished: the folder itself if it was made for it, its
// contents if it was an empty folder already.
function removeNew(dir, existed) {
  if (!existed) {
    fs.rmSync(dir, { recursive: true, force: true });
    return;
  }
  for (const name of fs.readdirSync(dir)) fs.rmSync(path.join(dir, name), { recursive: true, force: true });
}

async function keys(opts) {
  const { messages } = await run(['key', 'list'], ctxOf(opts));
  return (messages[0] || []).map((k) => ({
    id: k.id, current: Boolean(k.current), user: k.userName, host: k.hostName, created: k.created,
    kind: k.userName === RECOVERY_USER ? 'recovery' : 'password',
  }));
}

// Returns the new key's ID (restic answers "saved new key with ID <id>").
async function addKey(opts, secret, user) {
  const { text } = await withSecretFile(secret, (file) => run(['key', 'add', '--new-password-file', file, '--user', user, '--host', KEY_HOST], ctxOf(opts)));
  const m = /with ID ([0-9a-f]{64})/.exec(text.join('\n'));
  return m ? m[1] : null;
}

const passwordKeyOf = async (opts) => {
  const k = (await keys(opts)).find((x) => x.current);
  return k ? k.id : null;
};

// dir: a folder that is empty or not there yet. Returns the recovery code, which is shown to the user once (the app does
// not keep it), and the ID of the password's key, for keyHint.
// copyFrom ({ dir, password, keyHint }): a backup folder whose snapshots will be copied into this one (copySnapshots).
// The new one cuts files into pieces the same way, so a piece that is in both is stored once.
async function createRepository(opts) {
  const { dir, password, copyFrom = null } = opts;
  needPassword(password);
  const existed = fs.existsSync(dir);
  if (existed && !isEmptyDir(dir)) throw new BackupError('NOT_EMPTY', `A new backup needs an empty folder: ${dir}`, { path: dir });
  try {
    const args = ['init', '--repository-version', '2', ...(copyFrom ? ['--copy-chunker-params'] : [])];
    const init = await run(args, { ...ctxOf(opts), from: copyFrom });
    const id = (init.messages.find((m) => m.message_type === 'initialized') || {}).id || null;
    // The first key carries this computer's user name; it is renamed to be the password key.
    await withSecretFile(password, (file) => run(['key', 'passwd', '--new-password-file', file, '--user', PASSWORD_USER, '--host', KEY_HOST], ctxOf(opts)));
    const recoveryCode = newRecoveryCode();
    await addKey(opts, recoveryCode, RECOVERY_USER);
    return { id, recoveryCode, passwordKey: await passwordKeyOf(opts) };
  } catch (e) {
    removeNew(dir, existed);
    throw e;
  }
}

// Opens the backup folder's configuration, which only the right password or recovery code can decrypt.
async function verifyPassword(opts) {
  await run(['cat', 'config'], ctxOf(opts));
  return true;
}

// The backup folder's ID, which stays the same wherever the folder is copied or moved.
async function repositoryId(opts) {
  // restic writes the config over several lines.
  const { messages, text } = await run(['cat', 'config'], ctxOf(opts));
  if (messages[0] && messages[0].id) return messages[0].id;
  try {
    return JSON.parse(text.join('\n')).id || null;
  } catch {
    return null;
  }
}

// The password is forgotten: the recovery code opens the folder and sets a new password. The old password stops
// working, the code keeps working. Old keys go only after the new password has opened the folder.
async function resetPassword({ dir, cacheDir, recoveryCode, newPassword }) {
  needPassword(newPassword);
  const code = normalizeRecoveryCode(recoveryCode);
  if (!code) throw new BackupError('BAD_RECOVERY_CODE', 'This is not a recovery code.');
  const withCode = { dir, cacheDir, password: code };
  const before = await keys(withCode);
  const passwordKey = await addKey(withCode, newPassword, PASSWORD_USER);
  await verifyPassword({ dir, cacheDir, password: newPassword, keyHint: passwordKey });
  for (const k of before) if (k.kind === 'password') await run(['key', 'remove', k.id], ctxOf(withCode));
  return { passwordKey };
}

// A new recovery code, for one that was lost or seen by someone else: the old code stops working.
async function replaceRecoveryCode(opts) {
  needPassword(opts.password);
  const before = await keys(opts);
  const recoveryCode = newRecoveryCode();
  const recoveryKey = await addKey(opts, recoveryCode, RECOVERY_USER);
  await verifyPassword({ ...opts, password: recoveryCode, keyHint: recoveryKey });
  for (const k of before) if (k.kind === 'recovery') await run(['key', 'remove', k.id], ctxOf(opts));
  return { recoveryCode };
}

// Changes the password of the key it was opened with; the recovery code stays. Returns the new key's ID.
async function changePassword({ dir, cacheDir, password, keyHint, newPassword }) {
  needPassword(newPassword);
  await withSecretFile(newPassword, (file) => run(['key', 'passwd', '--new-password-file', file, '--user', PASSWORD_USER, '--host', KEY_HOST], ctxOf({ dir, cacheDir, password, keyHint })));
  return { passwordKey: await passwordKeyOf({ dir, cacheDir, password: newPassword }) };
}

const progressOf = (m) => ({
  percent: m.percent_done || 0, bytesDone: m.bytes_done || 0, totalBytes: m.total_bytes || 0,
  filesDone: m.files_done || 0, totalFiles: m.total_files || 0,
  secondsRemaining: m.seconds_remaining ?? null, currentFiles: m.current_files || [],
});

// paths: absolute folders and files. Only what changed since the last snapshot is written; the snapshot is still whole
// on its own. When some files could not be read, the snapshot is saved without them: incomplete, and unreadable names
// them.
// host: the name the snapshot is saved under. restic takes the computer's name otherwise, which on a Mac changes with the
// network ("name.local"), and a snapshot under another name is not found as the parent of the next one, so the next
// backup reads every file again. excludeCaches leaves out folders marked as caches (a CACHEDIR.TAG file in them).
// time: the date the snapshot is given instead of now (for tests of thinning out old snapshots).
// force reads every file again instead of trusting the previous snapshot (after a repair, to write lost data again).
async function backup({ dir, cacheDir, password, keyHint, paths, excludes = [], excludeCaches = false, tags = [], host = null, time = null, force = false, onProgress = () => {}, signal = null }) {
  if (!paths || !paths.length) throw new BackupError('NO_SOURCES', 'Nothing was chosen to back up.');
  for (const p of paths) if (!path.isAbsolute(p)) throw new BackupError('INVALID', `Not an absolute path: ${p}`);
  const args = ['backup', ...paths];
  for (const e of excludes) args.push('--exclude', e);
  if (excludeCaches) args.push('--exclude-caches');
  for (const t of tags) args.push('--tag', t);
  if (host) args.push('--host', host);
  if (time) args.push('--time', time);
  if (force) args.push('--force');
  const r = await run(args, {
    ...ctxOf({ dir, cacheDir, password, keyHint }), signal, okCodes: [0, 3],
    onMessage: (m) => m.message_type === 'status' && onProgress(progressOf(m)),
  });
  if (!r.summary || !r.summary.snapshot_id) throw new BackupError('RESTIC_FAILED', 'restic ended without saving a snapshot.');
  return { snapshot: r.summary.snapshot_id, summary: r.summary, incomplete: r.code === 3, unreadable: r.errors.map((e) => e.item).filter(Boolean) };
}

// A backup set's definition (its name, folders, exclusions and schedule, never a secret) is kept in its backup folder too,
// as a snapshot of one file, so a new installation gets it back from the folder alone. Only the newest one is kept.
const SETTINGS_TAG = 'folder-backup:settings';
const SETTINGS_FILE = 'folder-backup-set.json';

// Oldest first. kind is 'settings' for the snapshots that hold a backup set's definition (writeDefinition), 'data' for
// the backups themselves.
async function snapshots(opts) {
  const { messages } = await run(['snapshots'], ctxOf(opts));
  return (messages[0] || [])
    .map((s) => ({
      id: s.id, time: s.time, paths: s.paths || [], host: s.hostname, tags: s.tags || [], summary: s.summary || null,
      kind: (s.tags || []).includes(SETTINGS_TAG) ? 'settings' : 'data',
      // A snapshot that copy wrote: the ID of the one it was copied from.
      original: s.original || null,
    }))
    .sort((a, b) => Date.parse(a.time) - Date.parse(b.time));
}

// fresh: a new backup folder, which has no older definition to forget.
async function writeDefinition({ dir, cacheDir, password, keyHint, definition, host = null, fresh = false }) {
  const ctx = ctxOf({ dir, cacheDir, password, keyHint });
  const args = ['backup', '--stdin', '--stdin-filename', SETTINGS_FILE, '--tag', SETTINGS_TAG];
  if (host) args.push('--host', host);
  const r = await run(args, { ...ctx, input: JSON.stringify(definition, null, 2) });
  const id = r.summary && r.summary.snapshot_id;
  if (!id) throw new BackupError('RESTIC_FAILED', 'restic ended without saving the definition.');
  if (fresh) return id;
  await dropOldDefinitions({ dir, cacheDir, password, keyHint });
  return id;
}

// Only the newest definition is kept. A second copy gets every one the set writes (copySnapshots).
async function dropOldDefinitions({ dir, cacheDir, password, keyHint }) {
  const defs = (await snapshots({ dir, cacheDir, password, keyHint })).filter((s) => s.kind === 'settings');
  const older = defs.slice(0, -1).map((s) => s.id);
  if (older.length) await run(['forget', '--retry-lock', '2m', ...older], ctxOf({ dir, cacheDir, password, keyHint }));
  return older.length;
}

// Copies the snapshots of from ({ dir, password, keyHint }) that this backup folder does not have yet into it: restic
// reads them there and writes them here with this folder's key. One copied before is not copied again; one removed here
// that from still has is copied again. Answers only in text: progress from "[0:01] 42.00%" lines, and a "snapshot <id>
// saved, copied from source snapshot <id>" line for each one copied. Stopping it is safe: a snapshot is saved last.
async function copySnapshots({ dir, cacheDir, password, keyHint, from, onProgress = () => {}, signal = null }) {
  const PROGRESS = /^\[[\d:]+\]\s+([\d.]+)%/;
  let copied = 0;
  await run(['copy', '--retry-lock', '2m'], {
    ...ctxOf({ dir, cacheDir, password, keyHint }), from, signal,
    onText: (line) => {
      const t = line.trim();
      const m = PROGRESS.exec(t);
      if (m) onProgress({ percent: Number(m[1]) / 100, copied });
      else if (/^snapshot \w+ saved, copied from/.test(t)) {
        copied += 1;
        onProgress({ copied });
      }
    },
  });
  return { copied };
}

// The newest definition in the backup folder, or null when it has none (a folder made by restic itself, without the app).
async function readDefinition(opts, list = null) {
  const found = (list || (await snapshots(opts))).filter((s) => s.kind === 'settings');
  if (!found.length) return null;
  const chunks = [];
  await run(['dump', found[found.length - 1].id, `/${SETTINGS_FILE}`], { ...ctxOf(opts), onOutput: (d) => chunks.push(d) });
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return null;
  }
}

// Thins old snapshots out the way Time Machine does: every backup of the last day, one a day for the last month, one a
// week after that (keep: { hours, days, weeks }, weeks 'all' or a number). The newest snapshot and the set's
// definition always stay, and so does the oldest snapshot (restic keeps it when the weeks kept reach back that far).
// Snapshots are grouped by computer: what another computer backed up into the same folder is
// thinned on its own. Only the list of snapshots changes here; the space comes back with prune.
async function forget({ dir, cacheDir, password, keyHint, keep, signal = null }) {
  // The restore window's catalog may be reading the folder (restic ls) for a moment: wait for it.
  const args = ['forget', '--retry-lock', '2m', '--group-by', 'host', '--keep-tag', SETTINGS_TAG, '--keep-last', '1'];
  // Every snapshot of the last hours stays, also the ones taken by hand between two scheduled ones.
  if (keep.hours) args.push('--keep-within', `${keep.hours}h`);
  if (keep.days) args.push('--keep-within-daily', `${keep.days}d`);
  if (keep.weeks === 'all') args.push('--keep-weekly', 'unlimited');
  else if (keep.weeks) args.push('--keep-within-weekly', `${keep.weeks * 7}d`);
  const { messages } = await run(args, { ...ctxOf({ dir, cacheDir, password, keyHint }), signal });
  const groups = messages[0] || [];
  return {
    kept: groups.reduce((n, g) => n + (g.keep || []).length, 0),
    removed: groups.flatMap((g) => (g.remove || []).map((s) => s.id)),
  };
}

// Gives back the space of data no snapshot uses any more. Stopping it at any point is safe: restic writes the new files
// first and removes the old ones last. It answers only in text; progress comes from its "[0:01] 42.00%" lines.
async function prune({ dir, cacheDir, password, keyHint, onProgress = () => {}, signal = null }) {
  const PROGRESS = /^\[[\d:]+\]\s+([\d.]+)%/;
  await run(['prune', '--retry-lock', '2m'], {
    ...ctxOf({ dir, cacheDir, password, keyHint }), signal,
    onText: (line) => {
      const m = PROGRESS.exec(line.trim());
      if (m) onProgress({ percent: Number(m[1]) / 100 });
    },
  });
}

const nodeOf = (m) => ({
  name: m.name, path: m.path, type: m.type, size: m.type === 'file' ? m.size || 0 : null,
  mtime: m.mtime || null, permissions: m.permissions || null,
});

// The items of one folder of a snapshot, without what is inside its subfolders: what the restore window shows. Folders
// first, then by name.
async function list({ dir, cacheDir, password, keyHint, snapshot, folder }) {
  const items = [];
  await run(['ls', snapshot, folder], {
    ...ctxOf({ dir, cacheDir, password, keyHint }),
    onMessage: (m) => m.message_type === 'node' && m.path !== folder && items.push(nodeOf(m)),
  });
  return items.sort((a, b) => (a.type === 'dir') === (b.type === 'dir') ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1);
}

// restic's include and exclude patterns treat * ? [ and \ as special; a name is matched as it is. On Windows the
// backslash separates folders, so the characters are put in a class of their own there ([?] matches only ?).
const literal = (name) => (process.platform === 'win32' ? name.replace(/[*?[]/g, (c) => `[${c}]`) : name.replace(/[\\*?[]/g, (c) => `\\${c}`));

// Restores the items named (all of them without names) of one folder of a snapshot into target, which must be empty or
// not there yet: nothing on this computer is overwritten here. Every restored file is read back and compared (--verify).
// excludeFile: a file of exclude patterns instead of names (restic takes one or the other).
async function restore({ dir, cacheDir, password, keyHint, snapshot, folder, names = null, excludeFile = null, target, onProgress = () => {}, signal = null }) {
  if (fs.existsSync(target) && !isEmptyDir(target)) throw new BackupError('NOT_EMPTY', `Restoring needs an empty folder: ${target}`, { path: target });
  const args = ['restore', `${snapshot}:${folder}`, '--target', target, '--verify'];
  if (names) for (const n of names) args.push('--include', `/${literal(n)}`);
  else if (excludeFile) args.push('--exclude-file', excludeFile);
  const r = await run(args, {
    ...ctxOf({ dir, cacheDir, password, keyHint }), signal,
    onMessage: (m) => m.message_type === 'status' && onProgress({ percent: m.percent_done || 0, bytesDone: m.bytes_restored || 0, totalBytes: m.total_bytes || 0 }),
  });
  return r.summary;
}

// The start of one file of a snapshot, for a preview: at most limit bytes.
async function readFile({ dir, cacheDir, password, keyHint, snapshot, file, limit = 1024 * 1024 }) {
  const chunks = [];
  let size = 0;
  const enough = new AbortController();
  try {
    await run(['dump', snapshot, file], {
      ...ctxOf({ dir, cacheDir, password, keyHint }), signal: enough.signal,
      onOutput: (d) => {
        if (size >= limit) return;
        chunks.push(d);
        size += d.length;
        if (size >= limit) enough.abort();
      },
    });
  } catch (e) {
    if (!(e.code === 'CANCELLED' && enough.signal.aborted)) throw e;
  }
  return { data: Buffer.concat(chunks).subarray(0, limit), truncated: enough.signal.aborted };
}

// Reads the backup folder's structure and, with readData, all of its data, or with subset ('3/12') one part of it, and
// compares every piece with its checksum. ok is false, with restic's findings, when anything is damaged.
async function check({ dir, cacheDir, password, keyHint, readData = false, subset = null, signal = null }) {
  // The restore window's catalog may be reading the folder for a moment: wait for it.
  const args = ['check', '--retry-lock', '2m'];
  if (subset) args.push(`--read-data-subset=${subset}`);
  else if (readData) args.push('--read-data');
  try {
    const { summary } = await run(args, { ...ctxOf({ dir, cacheDir, password, keyHint }), signal });
    return { ok: !(summary && summary.num_errors), summary, brokenPacks: (summary && summary.broken_packs) || [] };
  } catch (e) {
    if (e.code !== 'RESTIC_FAILED') throw e;
    return { ok: false, summary: e.summary || null, brokenPacks: (e.summary && e.summary.broken_packs) || [], message: e.message, errors: e.errors };
  }
}

// The repairs restic documents, in its order (see jobs.repairSet): the index built again from the data files, the
// readable parts of damaged data files saved into new ones, and snapshots that still need data that is lost rewritten
// without the files it belonged to.
async function repairIndex({ dir, cacheDir, password, keyHint, signal = null }) {
  await run(['repair', 'index', '--retry-lock', '2m'], { ...ctxOf({ dir, cacheDir, password, keyHint }), signal });
}

// restic first saves a copy of every damaged data file into the folder it runs in, and does not start when it cannot:
// copiesDir, a folder that can be written. Once the repair has removed those files, the copies are all that is left of
// them.
async function repairPacks({ dir, cacheDir, password, keyHint, ids, copiesDir, signal = null }) {
  if (!copiesDir) throw new Error('repairPacks needs copiesDir.');
  if (ids.length) await run(['repair', 'packs', '--retry-lock', '2m', ...ids], { ...ctxOf({ dir, cacheDir, password, keyHint }), cwd: copiesDir, signal });
}

// The bytes of these data files of a backup folder (restic's layout: data/<first two letters of the ID>/<ID>); a file
// that is not there counts nothing.
function dataBytes(dir, ids) {
  let bytes = 0;
  for (const id of ids) {
    try {
      bytes += fs.statSync(path.join(dir, 'data', id.slice(0, 2), id)).size;
    } catch { /* not there */ }
  }
  return bytes;
}

async function repairSnapshots({ dir, cacheDir, password, keyHint, signal = null }) {
  const { text } = await run(['repair', 'snapshots', '--forget', '--retry-lock', '2m'], { ...ctxOf({ dir, cacheDir, password, keyHint }), signal });
  return { changed: !text.some((l) => /no snapshots were modified/.test(l)) };
}

// Removes locks that a restic process which no longer runs left behind (a backup ended hard, or a computer that went off).
async function unlock(opts) {
  await run(['unlock'], ctxOf(opts));
}

// Whether a folder holds a backup folder (a restic repository): it has restic's config file and its folders.
function isRepository(dir) {
  try {
    return fs.statSync(path.join(dir, 'config')).isFile() && fs.statSync(path.join(dir, 'keys')).isDirectory();
  } catch {
    return false;
  }
}

module.exports = {
  createRepository, verifyPassword, repositoryId, keys, resetPassword, replaceRecoveryCode, changePassword,
  backup, snapshots, list, restore, readFile, check, unlock,
  writeDefinition, readDefinition, dropOldDefinitions, copySnapshots, forget, prune, isRepository, repairIndex, repairPacks, dataBytes, repairSnapshots, SETTINGS_TAG,
  literal,
};
