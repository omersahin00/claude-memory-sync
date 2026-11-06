'use strict';
// The work a backup set does: setting one up, opening one that is already on a disk, and taking a backup with what goes
// after it. A backup runs in this order:
//   1. the backup folder and the source folders are there;
//   2. the files are counted, and the disk has room for what will be written, with space to spare (lib/space.js);
//   3. restic writes the snapshot, and stops if the disk fills up meanwhile;
//   4. the set's definition goes into the backup folder when it changed;
//   5. old snapshots are thinned out (forget), and once a week the space they used comes back (prune);
//   6. one twelfth of the data is read back and compared, about once a day, so all of it is read in about twelve days;
//   7. the set's second copy, when it has one and its disk is there, gets what it does not have yet (syncCopy).
// Stopped in steps 1 to 3, nothing is saved and the earlier backups stay as they were. Stopped after that, the snapshot
// is already saved, and the step stopped is done next time.
const fs = require('fs');
const os = require('os');
const path = require('path');
const repo = require('./repository');
const scan = require('./scan');
const space = require('./space');
const sets = require('./sets');
const { normalizeRecoveryCode } = require('./recovery-code');
const { appName } = require('./apps');
const { BackupError } = require('./errors');

const CHECK_PARTS = 12;
const CHECK_EVERY = 20 * 60 * 60 * 1000;
const PRUNE_EVERY = 7 * 24 * 60 * 60 * 1000;
const GUARD_EVERY = 1000;
const UNREADABLE_KEPT = 200;
// Index and folder lists restic writes besides the files' data: a little room on top of the estimate.
const OVERHEAD = (bytes) => Math.ceil(bytes * 0.02) + 16 * 1024 * 1024;

const exists = (p) => {
  try {
    fs.statSync(p);
    return true;
  } catch {
    return false;
  }
};

// Where a new set's backup folder will be, and whether it can be made there.
function targetInfo(place, name, { home }) {
  const repoDir = sets.repoFolderFor(place, name || 'Backup');
  const info = { place, repo: repoDir, placeExists: exists(place), free: space.freeSpace(place), systemDisk: space.onSystemDisk(place, home) };
  info.isRepository = repo.isRepository(repoDir);
  info.empty = !exists(repoDir) || fs.readdirSync(repoDir).filter((n) => !n.startsWith('.')).length === 0;
  try {
    fs.accessSync(space.existing(place), fs.constants.W_OK);
    info.writable = true;
  } catch {
    info.writable = false;
  }
  return info;
}

// A new set: its backup folder is made inside place (place/Folder Backup/<name>), with the password and a recovery code,
// and its definition is written into it. Returns the set, for the store, and the recovery code, which is shown to the
// user once and kept nowhere.
// fields: owner, tag and keepTagged of a set another app makes (sets.newSet).
async function createSet({ def, password, place, cacheDir, host, home, fields = {} }) {
  if (typeof password !== 'string' || password.length < 8) throw new BackupError('PASSWORD_SHORT', 'The password needs at least 8 characters.');
  if (!exists(place)) throw new BackupError('TARGET_MISSING', `The place for the backup is not there: ${place}`, { path: place });
  const repoDir = sets.repoFolderFor(place, def.name);
  const draft = sets.normalizeDefinition(def, { repo: repoDir });
  const info = targetInfo(place, draft.name, { home });
  if (!info.writable) throw new BackupError('TARGET_NOT_WRITABLE', `The backup cannot be written in ${place}.`, { path: place });
  if (info.isRepository) throw new BackupError('REPO_EXISTS', `There is a backup in ${repoDir} already.`, { path: repoDir });
  if (!info.empty) throw new BackupError('NOT_EMPTY', `A new backup needs an empty folder: ${repoDir}`, { path: repoDir });
  const parent = path.dirname(repoDir);
  const madeParent = !exists(parent);
  // restic makes the folder itself; macOS leaves ._ files beside it on exFAT, which count as nothing.
  if (exists(repoDir)) for (const n of fs.readdirSync(repoDir)) if (n.startsWith('._') || n === '.DS_Store') fs.rmSync(path.join(repoDir, n), { force: true });
  let created = null;
  try {
    created = await repo.createRepository({ dir: repoDir, password, cacheDir });
    const set = sets.newSet(draft, { repo: repoDir, repoId: created.id, passwordKey: created.passwordKey, fields });
    const opts = { dir: repoDir, cacheDir, password, keyHint: set.passwordKey };
    await repo.writeDefinition({ ...opts, definition: sets.definitionOf(set), host, fresh: true });
    set.state.definitionHash = sets.definitionHash(set);
    return { set, recoveryCode: created.recoveryCode };
  } catch (e) {
    if (created) fs.rmSync(repoDir, { recursive: true, force: true });
    if (madeParent && exists(parent) && fs.readdirSync(parent).every((n) => n.startsWith('.'))) fs.rmSync(parent, { recursive: true, force: true });
    throw e;
  }
}

// A backup folder that is already on a disk, opened with its password or its recovery code: after a new installation, on
// another computer, or for a set that was removed from the app. Opened with the recovery code, a new password is needed
// (NEED_NEW_PASSWORD until it is given) and replaces the old one. The set comes back as it was defined, from the
// definition in the folder; a folder made without the app becomes a set of the folders its newest snapshot backed up.
// owner: the app that opens it, null for this one. A backup folder another app made (its definition's owner) is not
// opened as one of this app's sets: OTHER_APP, with that app in detail. It is checked before the password is changed.
async function openExisting({ dir, secret, newPassword = null, cacheDir, owner = null }) {
  if (!repo.isRepository(dir)) throw new BackupError('REPO_NOT_FOUND', `There is no backup in ${dir}.`, { path: dir });
  if (typeof secret !== 'string' || !secret) throw new BackupError('NO_PASSWORD', 'A password is needed.');
  let opened = secret;
  let list;
  try {
    list = await repo.keys({ dir, cacheDir, password: secret });
  } catch (e) {
    const code = normalizeRecoveryCode(secret);
    if (e.code !== 'WRONG_PASSWORD' || !code || code === secret) throw e;
    opened = code;
    list = await repo.keys({ dir, cacheDir, password: code });
  }
  const current = list.find((k) => k.current);
  let password = opened;
  let passwordKey = current ? current.id : null;
  const byRecovery = Boolean(current && current.kind === 'recovery');
  const early = { dir, cacheDir, password: opened, keyHint: passwordKey };
  const definition = await repo.readDefinition(early).catch(() => null);
  const madeBy = (definition && definition.format === 'folder-backup-set' && typeof definition.owner === 'string' && definition.owner) || null;
  if (madeBy !== (owner || null)) {
    const app = appName(madeBy || 'folder-backup');
    throw new BackupError('OTHER_APP', `This backup folder belongs to ${app}.`, { path: dir, detail: app, owner: madeBy || 'folder-backup' });
  }
  if (byRecovery) {
    if (!newPassword) throw new BackupError('NEED_NEW_PASSWORD', 'Opened with the recovery code: a new password is needed.');
    if (newPassword.length < 8) throw new BackupError('PASSWORD_SHORT', 'The password needs at least 8 characters.');
    ({ passwordKey } = await repo.resetPassword({ dir, cacheDir, recoveryCode: opened, newPassword }));
    password = newPassword;
  }
  const opts = { dir, cacheDir, password, keyHint: passwordKey };
  const repoId = await repo.repositoryId(opts);
  const snaps = await repo.snapshots(opts);
  const data = snaps.filter((s) => s.kind === 'data');
  const def = definition && definition.format === 'folder-backup-set'
    ? definition
    : { name: path.basename(dir), sources: data.length ? data[data.length - 1].paths : [], excludes: sets.DEFAULT_EXCLUDES };
  // Folders of another system (C:\Users\... read on a Mac) cannot be backed up here; the user chooses this computer's.
  const all = Array.isArray(def.sources) ? def.sources.filter((x) => typeof x === 'string') : [];
  const foreignSources = all.filter((x) => !path.isAbsolute(x));
  const set = sets.newSet({ ...def, sources: all.filter((x) => path.isAbsolute(x)) }, { repo: dir, repoId, passwordKey, allowNoSources: true, fields: definition || {} });
  // A full backup comes back as one: never on a schedule, never backed up into.
  const full = definition && definition.full && typeof definition.full === 'object' ? definition.full : null;
  if (full) {
    set.full = { setName: String(full.setName || ''), ofRepo: full.ofRepo || null, at: full.at || (data.length ? new Date(data[0].time).toISOString() : null) };
    set.schedule = { ...set.schedule, every: 'off' };
  }
  set.state.definitionHash = definition && !foreignSources.length ? sets.definitionHash(set) : null;
  // The newest backup in the folder counts as the last one, for the schedule and the window. The count before the next
  // backup still reads every file as changed: that backup may be this computer's first.
  if (data.length) set.state.lastSuccessAt = new Date(data[data.length - 1].time).toISOString();
  return {
    set, password, byRecovery, restored: Boolean(definition), snapshots: data.length,
    missingSources: set.sources.filter((x) => !exists(x)), foreignSources,
  };
}

// fn(signal) with a signal that is also aborted when the disk of dir falls under room.floor while restic writes there:
// DISK_FILLED then, so the computer or the backup disk is never left full.
async function guarded(dir, room, signal, fn) {
  const inner = new AbortController();
  const relay = () => inner.abort();
  if (signal && signal.aborted) inner.abort();
  else if (signal) signal.addEventListener('abort', relay, { once: true });
  let filled = null;
  const guard = setInterval(() => {
    const free = space.freeSpace(dir);
    if (free !== null && free < room.floor) {
      filled = free;
      inner.abort();
    }
  }, GUARD_EVERY);
  try {
    return await fn(inner.signal);
  } catch (e) {
    if (filled !== null) throw new BackupError('DISK_FILLED', `The disk of ${dir} filled up while it was written; it was stopped.`, { path: dir, free: filled, reserve: room.floor });
    throw e;
  } finally {
    clearInterval(guard);
    if (signal) signal.removeEventListener('abort', relay);
  }
}

// One snapshot written by restic into opts.dir, with progress as phase 'backup', stopped when the disk fills up
// (guarded). retryLocked: a lock left by a restic that no longer runs (ended hard, or a computer that went off) is
// removed, which unlock does only for those, and the snapshot is tried again.
async function writeSnapshot({ opts, paths, excludes, tags = [], host, room, estimate, signal, onProgress, retryLocked = false }) {
  return guarded(opts.dir, room, signal, async (inner) => {
    const take = () => repo.backup({
      ...opts, paths, excludes, excludeCaches: true, tags, host, signal: inner,
      onProgress: (p) => onProgress({ phase: 'backup', estimate, ...p, percent: Math.round(p.percent * 1000) / 10 }),
    });
    onProgress({ phase: 'backup', estimate, percent: 0 });
    try {
      return await take();
    } catch (e) {
      if (!retryLocked || e.code !== 'REPO_LOCKED') throw e;
      await repo.unlock(opts);
      return await take();
    }
  });
}

// What a snapshot written by writeSnapshot holds, for the window and for applyResult.
function resultOf(r, { startedAt, estimate, missingSources }) {
  const s = r.summary;
  return {
    snapshot: r.snapshot, startedAt: startedAt.toISOString(), snapshotStart: s.backup_start || startedAt.toISOString(),
    filesNew: s.files_new || 0, filesChanged: s.files_changed || 0, filesUnmodified: s.files_unmodified || 0,
    totalFiles: s.total_files_processed || 0, totalBytes: s.total_bytes_processed || 0,
    dataAdded: s.data_added_packed ?? s.data_added ?? 0, estimate,
    incomplete: r.incomplete, unreadable: r.unreadable.slice(0, UNREADABLE_KEPT), unreadableCount: r.unreadable.length, missingSources,
    shadowCopy: r.fsSnapshot ? { failed: r.fsSnapshot.failed } : null,
    definitionWritten: false, removed: 0, pruned: false, check: null, followUp: null,
  };
}

// Steps 1 to 3 of a backup: one snapshot of the set's folders, with tags (the set's own when none are given). Returns
// what it holds (resultOf), the moment it started and how much it was thought to write.
async function takeSnapshot({ set, password, cacheDir, host, home, tags = null, onProgress = () => {}, signal = null, now = () => new Date() }) {
  const state = set.state || {};
  const opts = { dir: set.repo, cacheDir, password, keyHint: set.passwordKey };
  const startedAt = now();
  if (set.full) throw new BackupError('FULL_FIXED', 'A full backup is not backed up into again.');
  if (!exists(set.repo)) throw new BackupError('TARGET_MISSING', `The backup folder is not there: ${set.repo}`, { path: set.repo });
  if (!repo.isRepository(set.repo)) throw new BackupError('REPO_NOT_FOUND', `There is no backup in ${set.repo}.`, { path: set.repo });
  if (!set.sources.length) throw new BackupError('NO_SOURCES', 'Nothing was chosen to back up.');
  const present = set.sources.filter(exists);
  const missingSources = set.sources.filter((s) => !present.includes(s));
  if (!present.length) throw new BackupError('SOURCES_MISSING', 'None of the folders to back up is there.', { path: set.sources[0] });

  onProgress({ phase: 'scan', files: 0, bytes: 0 });
  const since = state.lastSnapshotStart ? Date.parse(state.lastSnapshotStart) : null;
  const counted = await scan.estimate({
    paths: present, excludes: set.excludes, excludeCaches: true, since, signal,
    onProgress: (p) => onProgress({ phase: 'scan', ...p }),
  });
  const toWrite = (since == null ? counted.bytes : counted.changedBytes);
  const estimate = toWrite + OVERHEAD(toWrite);
  const room = space.requireSpace(set.repo, estimate, { home });
  const r = await writeSnapshot({
    opts, paths: present, excludes: set.excludes, tags: tags || (set.tag ? [set.tag] : []), host, room, estimate, signal, onProgress, retryLocked: true,
  });
  return resultOf(r, { startedAt, estimate, missingSources });
}

// Thins the set's snapshots out by its rules (repository.forget): its backups by keep, only the ones with its tag when
// it has one, and of each tag in keepTagged the newest n, apart from them. Returns how many snapshots went.
async function thinOut(opts, set, signal = null) {
  let removed = (await repo.forget({ ...opts, keep: set.keep, tag: set.tag || null, signal })).removed.length;
  for (const [tag, last] of Object.entries(set.keepTagged || {})) removed += (await repo.forget({ ...opts, keepLast: last, tag, signal })).removed.length;
  return removed;
}

// Takes one backup of the set and what goes after it (see the top of this file). progress({ phase, ... }) is told each
// step: 'scan' with files and bytes counted, 'backup' with restic's percent, files, bytes and time left, then
// 'settings', 'forget', 'prune' and 'check'. Returns what happened, for the window and for applyResult.
async function runBackup({ set, password, cacheDir, host, home, onProgress = () => {}, signal = null, now = () => new Date() }) {
  const state = set.state || {};
  const opts = { dir: set.repo, cacheDir, password, keyHint: set.passwordKey };
  const result = await takeSnapshot({ set, password, cacheDir, host, home, onProgress, signal, now });

  // Steps 4 to 6: the snapshot is saved; whatever stops them now leaves it as it is.
  try {
    if (sets.definitionHash(set) !== state.definitionHash) {
      onProgress({ phase: 'settings' });
      await repo.writeDefinition({ ...opts, definition: sets.definitionOf(set), host });
      result.definitionWritten = true;
    }
    onProgress({ phase: 'forget' });
    result.removed = await thinOut(opts, set, signal);
    const prunePending = Boolean(state.prunePending || result.removed);
    if (prunePending && (!state.lastPruneAt || now() - Date.parse(state.lastPruneAt) >= PRUNE_EVERY)) {
      onProgress({ phase: 'prune', percent: 0 });
      await repo.prune({ ...opts, signal, onProgress: (p) => onProgress({ phase: 'prune', percent: Math.round(p.percent * 1000) / 10 }) });
      result.pruned = true;
    }
    if (!state.lastCheck || now() - Date.parse(state.lastCheck.at) >= CHECK_EVERY) {
      const part = state.checkPart || 1;
      onProgress({ phase: 'check', part, of: CHECK_PARTS });
      const c = await repo.check({ ...opts, subset: `${part}/${CHECK_PARTS}`, signal });
      result.check = { ok: c.ok, part, of: CHECK_PARTS, message: c.ok ? null : c.message || 'restic found damage.' };
    }
  } catch (e) {
    result.followUp = { stopped: e.code === 'CANCELLED', code: e.code || 'ERROR', message: e.message };
  }

  // Step 7: the second copy, when its disk is there. Whatever happens to it, the backup stays saved.
  if (set.copy && !(result.followUp && result.followUp.stopped)) {
    if (!exists(set.copy.repo)) result.copy = { missing: true };
    else {
      try {
        result.copy = { ok: true, ...(await syncCopy({ set, password, cacheDir, home, signal, onProgress, now })) };
      } catch (e) {
        result.copy = { ok: false, stopped: e.code === 'CANCELLED', code: e.code || 'ERROR', message: e.message, path: e.path || null };
      }
    }
  }
  return result;
}

// ---- Full backups ----------------------------------------------------------------
// The folder for a full backup named name inside place (place/Folder Backup/<name>), with ' 2', ' 3' and so on when one
// of that name is there already.
function fullBackupFolder(place, name) {
  const parent = path.join(place, sets.parentFolder());
  let n = name;
  for (let i = 2; exists(path.join(parent, n)); i++) n = `${name} ${i}`;
  return path.join(parent, n);
}

// What to know about place before a full backup of the set is taken there: the folder it would get, the free space, and
// whether it is on the computer's own disk or on the disk of the set's own backup. size is the size of the set's folders
// at its last backup (null before the first), estimate that with the room restic needs besides; the backup counts the
// folders again before it writes anything.
function fullBackupTarget(set, place, name, { home }) {
  const dir = fullBackupFolder(place, name);
  const last = set.state && set.state.last;
  const size = last && last.totalBytes != null ? last.totalBytes : null;
  const estimate = size == null ? null : size + OVERHEAD(size);
  const info = { place, dir, placeExists: exists(place), free: space.freeSpace(place), systemDisk: space.onSystemDisk(place, home), size, estimate };
  try {
    info.sameDisk = fs.statSync(space.existing(place)).dev === fs.statSync(set.repo).dev;
  } catch {
    info.sameDisk = false;
  }
  try {
    fs.accessSync(space.existing(place), fs.constants.W_OK);
    info.writable = true;
  } catch {
    info.writable = false;
  }
  info.enough = info.free == null || estimate == null || space.spaceFor(place, estimate, { home }).enough;
  return info;
}

// A full backup of the set: a new backup folder in place that shares nothing with the set's own or any other, with one
// snapshot of the set's folders (its exclusions too) and the definition beside it, so it also opens on its own with Open
// existing. It opens with the set's password and with a recovery code of its own. In this order:
//   1. the folders are counted, and the disk has room for all of them, with space to spare;
//   2. the backup folder is made, with its two keys;
//   3. restic writes the snapshot, and stops if the disk fills up meanwhile;
//   4. the definition is written;
//   5. all of the data is read back and compared.
// Stopped or failed at any point, the folder is removed again: there is never half of one, and the set's own backups are
// not touched. Returns the entry for the store (sets.newFullBackup), the recovery code, which is shown once and kept
// nowhere, and what was written.
async function takeFullBackup({ set, password, place, name, cacheDir, host, home, signal = null, onProgress = () => {} }) {
  if (set.full) throw new BackupError('FULL_FIXED', 'A full backup is not backed up into again.');
  if (!exists(place)) throw new BackupError('TARGET_MISSING', `The place for the full backup is not there: ${place}`, { path: place });
  if (!set.sources.length) throw new BackupError('NO_SOURCES', 'Nothing was chosen to back up.');
  const present = set.sources.filter(exists);
  const missingSources = set.sources.filter((s) => !present.includes(s));
  if (!present.length) throw new BackupError('SOURCES_MISSING', 'None of the folders to back up is there.', { path: set.sources[0] });
  const dir = fullBackupFolder(place, name);
  try {
    fs.accessSync(space.existing(place), fs.constants.W_OK);
  } catch {
    throw new BackupError('TARGET_NOT_WRITABLE', `The backup cannot be written in ${place}.`, { path: place });
  }
  // A backup folder inside what it backs up would back itself up.
  sets.normalizeDefinition({ name: path.basename(dir), sources: set.sources, excludes: set.excludes }, { repo: dir });

  const startedAt = new Date();
  onProgress({ phase: 'scan', files: 0, bytes: 0 });
  const counted = await scan.estimate({
    paths: present, excludes: set.excludes, excludeCaches: true, signal,
    onProgress: (p) => onProgress({ phase: 'scan', ...p }),
  });
  const estimate = counted.bytes + OVERHEAD(counted.bytes);
  const room = space.requireSpace(dir, estimate, { home });

  const parent = path.dirname(dir);
  const madeParent = !exists(parent);
  // Only a folder this backup made is removed; createRepository refuses one with anything in it.
  let made = false;
  try {
    onProgress({ phase: 'create' });
    const created = await repo.createRepository({ dir, password, cacheDir });
    made = true;
    const opts = { dir, cacheDir, password, keyHint: created.passwordKey };
    const r = await writeSnapshot({ opts, paths: present, excludes: set.excludes, host, room, estimate, signal, onProgress });
    const result = resultOf(r, { startedAt, estimate, missingSources });
    const entry = sets.newFullBackup(set, { name: path.basename(dir), repo: dir, repoId: created.id, passwordKey: created.passwordKey, at: result.snapshotStart });
    onProgress({ phase: 'settings' });
    await repo.writeDefinition({ ...opts, definition: sets.definitionOf(entry), host, fresh: true });
    result.definitionWritten = true;
    onProgress({ phase: 'verify' });
    const c = await repo.check({ ...opts, readData: true, signal });
    if (!c.ok) throw new BackupError('FULL_CHECK_FAILED', `The full backup did not read back sound: ${c.message || 'restic found damage.'}`, { path: dir });
    applyResult(entry.state, result, { definitionHash: sets.definitionHash(entry) });
    entry.state.lastFullCheck = { at: new Date().toISOString(), ok: true };
    return { set: entry, recoveryCode: created.recoveryCode, result };
  } catch (e) {
    if (made) fs.rmSync(dir, { recursive: true, force: true });
    if (madeParent && exists(parent) && fs.readdirSync(parent).every((n) => n.startsWith('.'))) fs.rmSync(parent, { recursive: true, force: true });
    throw e;
  }
}

// ---- The second copy ----------------------------------------------------------------
// A set can keep a second copy of its backups on another disk: a backup folder of its own (the set's password, a
// recovery code of its own), into which every snapshot of the set is copied (restic copy), after every backup and when
// its disk comes back. It is thinned out by the set's rules, right after a copy, when it holds what the set's own folder
// holds, so both keep the same snapshots. It is checked a twelfth at a time, like the set's own. When the set's own disk
// is lost, the copy becomes the set's backup folder (main.js promoteCopy).

// The size of a folder's files, for the room a copy of a backup folder needs.
async function folderBytes(dir) {
  let total = 0;
  const walk = async (d) => {
    let list;
    try {
      list = await fs.promises.readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    await Promise.all(list.map(async (e) => {
      const abs = path.join(d, e.name);
      if (e.isDirectory()) await walk(abs);
      else if (e.isFile()) {
        // Not total += await ...: that reads total before the await, and the stats run side by side.
        let size = 0;
        try {
          size = (await fs.promises.stat(abs)).size;
        } catch { /* gone */ }
        total += size;
      }
    }));
  };
  await walk(dir);
  return total;
}

// What to know about place before the set's second copy is made there: its folder (place/Folder Backup/<set>), the free
// space, the size of the set's own backup folder, and whether place is on the same disk, which a copy must not be.
async function copyTarget(set, place, { home }) {
  const dir = sets.repoFolderFor(place, set.name);
  const info = { place, dir, placeExists: exists(place), free: space.freeSpace(place), systemDisk: space.onSystemDisk(place, home) };
  info.isRepository = repo.isRepository(dir);
  info.empty = !exists(dir) || fs.readdirSync(dir).filter((n) => !n.startsWith('.')).length === 0;
  try {
    info.sameDisk = fs.statSync(space.existing(place)).dev === fs.statSync(set.repo).dev;
  } catch {
    info.sameDisk = false;
  }
  try {
    fs.accessSync(space.existing(place), fs.constants.W_OK);
    info.writable = true;
  } catch {
    info.writable = false;
  }
  info.size = exists(set.repo) ? await folderBytes(set.repo) : null;
  info.enough = info.free == null || info.size == null || space.spaceFor(place, info.size + OVERHEAD(info.size), { home }).enough;
  return info;
}

// Makes the set's second copy in place, with every snapshot the set has, and checks a twelfth of it. Stopped or failed,
// the new folder is removed again. Returns the set's copy ({ repo, repoId, passwordKey, addedAt }), the copy's state, and
// its recovery code, which is shown once and kept nowhere. allowSameDisk is for the tests, which have one disk.
async function addCopy({ set, password, place, cacheDir, home, allowSameDisk = false, signal = null, onProgress = () => {} }) {
  if (set.full) throw new BackupError('FULL_FIXED', 'A full backup has no second copy.');
  if (set.copy) throw new BackupError('COPY_EXISTS', 'This set has a second copy already.');
  if (!exists(set.repo)) throw new BackupError('TARGET_MISSING', `The backup folder is not there: ${set.repo}`, { path: set.repo });
  if (!exists(place)) throw new BackupError('TARGET_MISSING', `The place for the second copy is not there: ${place}`, { path: place });
  const info = await copyTarget(set, place, { home });
  if (!info.writable) throw new BackupError('TARGET_NOT_WRITABLE', `The backup cannot be written in ${place}.`, { path: place });
  if (info.sameDisk && !allowSameDisk) throw new BackupError('COPY_SAME_DISK', `${place} is on the disk of the set's own backup.`, { path: place });
  if (info.isRepository) throw new BackupError('REPO_EXISTS', `There is a backup in ${info.dir} already.`, { path: info.dir });
  if (!info.empty) throw new BackupError('NOT_EMPTY', `A new backup needs an empty folder: ${info.dir}`, { path: info.dir });
  sets.normalizeDefinition({ name: set.name, sources: set.sources, excludes: set.excludes }, { repo: info.dir });
  const room = space.requireSpace(info.dir, info.size + OVERHEAD(info.size), { home });

  const dir = info.dir;
  const parent = path.dirname(dir);
  const madeParent = !exists(parent);
  let made = false;
  const startedAt = new Date();
  try {
    onProgress({ phase: 'create' });
    const from = { dir: set.repo, password, keyHint: set.passwordKey };
    const created = await repo.createRepository({ dir, password, cacheDir, copyFrom: from });
    made = true;
    const copy = { repo: dir, repoId: created.id, passwordKey: created.passwordKey, addedAt: startedAt.toISOString() };
    const r = await syncCopy({ set: { ...set, copy, state: { ...set.state, copy: {} } }, password, cacheDir, home, signal, onProgress, room, forceCheck: true });
    if (r.check && !r.check.ok) throw new BackupError('COPY_CHECK_FAILED', `The second copy did not read back sound: ${r.check.message}`, { path: dir });
    if (r.followUp) throw new BackupError(r.followUp.code, r.followUp.message);
    const state = applyCopyResult({}, r).copy;
    return { copy, copyState: state, recoveryCode: created.recoveryCode, result: r };
  } catch (e) {
    if (made) fs.rmSync(dir, { recursive: true, force: true });
    if (madeParent && exists(parent) && fs.readdirSync(parent).every((n) => n.startsWith('.'))) fs.rmSync(parent, { recursive: true, force: true });
    throw e;
  }
}

// Brings the set's second copy up to date: copies what it does not have yet, then thins it out by the set's rules, gives
// the space back once a week and checks a twelfth of it about once a day, as for the set's own folder. COPY_MISSING
// when its disk is not there. Steps after the copy that fail or are stopped leave the copy as it is (followUp).
async function syncCopy({ set, password, cacheDir, home, signal = null, onProgress = () => {}, now = () => new Date(), room = null, forceCheck = false }) {
  const copy = set.copy;
  if (!copy) throw new BackupError('NO_COPY', 'This set has no second copy.');
  if (!exists(set.repo)) throw new BackupError('TARGET_MISSING', `The backup folder is not there: ${set.repo}`, { path: set.repo });
  if (!exists(copy.repo)) throw new BackupError('COPY_MISSING', `The disk of the second copy is not there: ${copy.repo}`, { path: copy.repo });
  if (!repo.isRepository(copy.repo)) throw new BackupError('REPO_NOT_FOUND', `There is no backup in ${copy.repo}.`, { path: copy.repo });
  const cs = (set.state && set.state.copy) || {};
  const startedAt = now();
  const opts = { dir: copy.repo, cacheDir, password, keyHint: copy.passwordKey };
  const from = { dir: set.repo, password, keyHint: set.passwordKey };
  const roomHere = room || space.requireSpace(copy.repo, 0, { home });

  // What the set has that the copy has not: copied snapshots carry the ID they were copied from.
  onProgress({ phase: 'copy', copied: 0 });
  const [mine, theirs] = await Promise.all([repo.snapshots({ dir: set.repo, cacheDir, password, keyHint: set.passwordKey }), repo.snapshots(opts)]);
  const have = new Set(theirs.flatMap((s) => [s.id, s.original].filter(Boolean)));
  const pending = mine.filter((s) => !have.has(s.id)).length;
  let copied = 0;
  if (pending) {
    onProgress({ phase: 'copy', copied: 0, total: pending, percent: 0 });
    ({ copied } = await guarded(copy.repo, roomHere, signal, (inner) => repo.copySnapshots({
      ...opts, from, signal: inner,
      onProgress: (p) => p.copied != null && onProgress({ phase: 'copy', copied: p.copied, total: pending, percent: Math.round((p.copied / pending) * 1000) / 10 }),
    })));
  }
  const result = { startedAt: startedAt.toISOString(), copied, removed: 0, pruned: false, check: null, followUp: null };
  try {
    onProgress({ phase: 'copyForget' });
    await repo.dropOldDefinitions(opts);
    result.removed = await thinOut(opts, set, signal);
    if ((cs.prunePending || result.removed) && (!cs.lastPruneAt || now() - Date.parse(cs.lastPruneAt) >= PRUNE_EVERY)) {
      onProgress({ phase: 'copyPrune', percent: 0 });
      await repo.prune({ ...opts, signal, onProgress: (p) => onProgress({ phase: 'copyPrune', percent: Math.round(p.percent * 1000) / 10 }) });
      result.pruned = true;
    }
    if (forceCheck || !cs.lastCheck || now() - Date.parse(cs.lastCheck.at) >= CHECK_EVERY) {
      const part = cs.checkPart || 1;
      onProgress({ phase: 'copyCheck', part, of: CHECK_PARTS });
      const c = await repo.check({ ...opts, subset: `${part}/${CHECK_PARTS}`, signal });
      result.check = { ok: c.ok, part, of: CHECK_PARTS, message: c.ok ? null : c.message || 'restic found damage.' };
    }
  } catch (e) {
    result.followUp = { stopped: e.code === 'CANCELLED', code: e.code || 'ERROR', message: e.message };
  }
  return result;
}

// The set's state after its copy was brought up to date (state.copy, changed in place). lastCopyAt is when that copy
// started: every backup that started before it is in the copy.
function applyCopyResult(state, result) {
  const at = new Date().toISOString();
  const cs = state.copy || {};
  state.copy = cs;
  cs.lastCopyAt = result.startedAt;
  cs.lastCopied = result.copied;
  cs.lastFailure = null;
  if (result.removed) cs.prunePending = true;
  if (result.pruned) {
    cs.prunePending = false;
    cs.lastPruneAt = at;
  }
  if (result.check) {
    cs.lastCheck = { at, ok: result.check.ok, part: result.check.part };
    cs.checkPart = (result.check.part % CHECK_PARTS) + 1;
    cs.damaged = result.check.ok ? null : { at, message: result.check.message };
  }
  return state;
}

function applyCopyFailure(state, error) {
  state.copy = state.copy || {};
  state.copy.lastFailure = { at: new Date().toISOString(), code: error.code || 'ERROR', message: error.message, path: error.path || null };
  return state;
}

// Whether the copy misses a backup the set has: one finished after the last copy started.
const copyBehind = (set) => Boolean(set.copy && set.state && set.state.lastSuccessAt && (!set.state.copy || !set.state.copy.lastCopyAt || Date.parse(set.state.lastSuccessAt) > Date.parse(set.state.copy.lastCopyAt)));

// Where a repair keeps restic's copies of the damaged data files: a hidden folder beside the backup folder, on its disk
// (the computer's own disk is often the small one), or else the system's temporary folder. Never inside the backup
// folder, which restic alone writes to.
function repairRoots(set) {
  const roots = [];
  const parent = path.dirname(set.repo);
  if (parent !== set.repo) roots.push(path.join(parent, `.${path.basename(set.repo)}-repair`));
  roots.push(path.join(os.tmpdir(), `folder-backup-repair-${set.id}`));
  return roots;
}

// A new folder for this repair's copies, in the first place that can be written and has room for them. A new one each
// time: restic does not write over a file, so a repair tried again must not meet the copies of the one before.
function repairCopiesFolder(set, need, { home }) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  let failure = null;
  for (const root of repairRoots(set)) {
    try {
      space.requireSpace(root, need, { home });
      const dir = path.join(root, stamp);
      fs.mkdirSync(dir, { recursive: true });
      return dir;
    } catch (e) {
      failure = e;
    }
  }
  throw failure;
}

// The copies are kept until all of the backup folder has been read back sound; after that they are of no use.
function dropRepairCopies(set) {
  for (const root of repairRoots(set)) {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch { /* tried again after the next sound check */ }
  }
}

// Reads all of the backup folder's data back and compares every piece with its checksum.
async function verifySet({ set, password, cacheDir, signal = null, onProgress = () => {} }) {
  if (!exists(set.repo)) throw new BackupError('TARGET_MISSING', `The backup folder is not there: ${set.repo}`, { path: set.repo });
  onProgress({ phase: 'verify' });
  const c = await repo.check({ dir: set.repo, cacheDir, password, keyHint: set.passwordKey, readData: true, signal });
  if (c.ok) dropRepairCopies(set);
  return { ok: c.ok, brokenPacks: c.brokenPacks, message: c.ok ? null : c.message || 'restic found damage.' };
}

// Repairs a damaged backup folder in the order restic documents, then reads all of it again:
//   1. the index is built again from the data files;
//   2. the readable parts of damaged data files are saved into new files, and the damaged ones go (restic keeps a copy
//      of each, see repairRoots; the result's copies says where, when the repair did not end sound);
//   3. the set's folders are backed up again, every file read, so data that is lost but still on this computer is
//      written again;
//   4. snapshots that still need lost data are rewritten without the files it belonged to (those cannot be brought
//      back from this folder any more);
//   5. all of the data is read back and checked.
async function repairSet({ set, password, cacheDir, host, home = os.homedir(), signal = null, onProgress = () => {} }) {
  // Its repair would back up again into it; a damaged full backup is replaced with a new one.
  if (set.full) throw new BackupError('FULL_FIXED', 'A full backup is not repaired: take a new one.');
  if (!exists(set.repo)) throw new BackupError('TARGET_MISSING', `The backup folder is not there: ${set.repo}`, { path: set.repo });
  const opts = { dir: set.repo, cacheDir, password, keyHint: set.passwordKey, signal };
  onProgress({ phase: 'verify' });
  const before = await repo.check({ ...opts, readData: true });
  onProgress({ phase: 'repairIndex' });
  await repo.repairIndex(opts);
  let copies = null;
  if (before.brokenPacks.length) {
    copies = repairCopiesFolder(set, repo.dataBytes(set.repo, before.brokenPacks), { home });
    onProgress({ phase: 'repairPacks' });
    await repo.repairPacks({ ...opts, ids: before.brokenPacks, copiesDir: copies });
  }
  const present = set.sources.filter(exists);
  let rebacked = false;
  if (present.length) {
    onProgress({ phase: 'backup', percent: 0 });
    await repo.backup({
      ...opts, paths: present, excludes: set.excludes, excludeCaches: true, tags: set.tag ? [set.tag] : [], host, force: true,
      onProgress: (p) => onProgress({ phase: 'backup', ...p, percent: Math.round(p.percent * 1000) / 10 }),
    });
    rebacked = true;
  }
  onProgress({ phase: 'repairSnapshots' });
  const { changed } = await repo.repairSnapshots(opts);
  onProgress({ phase: 'verify' });
  const after = await repo.check({ ...opts, readData: true });
  if (after.ok) dropRepairCopies(set);
  return {
    ok: after.ok, brokenPacks: before.brokenPacks, rebacked, snapshotsChanged: changed, copies: after.ok ? null : copies,
    message: after.ok ? null : after.message || 'restic still finds damage.',
  };
}

// The set's state after a backup (state is changed in place).
function applyResult(state, result, { definitionHash } = {}) {
  const at = new Date().toISOString();
  state.lastAttemptAt = result.startedAt;
  state.lastSuccessAt = result.startedAt;
  state.lastSnapshotStart = result.snapshotStart;
  state.lastFailure = null;
  state.notified = null;
  state.last = {
    at, ok: true, snapshot: result.snapshot, filesNew: result.filesNew, filesChanged: result.filesChanged,
    totalFiles: result.totalFiles, totalBytes: result.totalBytes, dataAdded: result.dataAdded,
    incomplete: result.incomplete, unreadable: result.unreadable.slice(0, 20), unreadableCount: result.unreadableCount,
    missingSources: result.missingSources, shadowCopy: result.shadowCopy || null, followUp: result.followUp,
  };
  if (result.definitionWritten && definitionHash) state.definitionHash = definitionHash;
  if (result.removed) state.prunePending = true;
  if (result.pruned) {
    state.prunePending = false;
    state.lastPruneAt = at;
  }
  if (result.check) {
    state.lastCheck = { at, ok: result.check.ok, part: result.check.part };
    state.checkPart = (result.check.part % CHECK_PARTS) + 1;
    if (!result.check.ok) state.damaged = { at, message: result.check.message };
  }
  if (result.copy && result.copy.ok) applyCopyResult(state, result.copy);
  else if (result.copy && !result.copy.missing && !result.copy.stopped) applyCopyFailure(state, result.copy);
  return state;
}

function applyFailure(state, error, startedAt) {
  state.lastAttemptAt = startedAt;
  state.lastFailure = { at: new Date().toISOString(), code: error.code || 'ERROR', message: error.message };
  return state;
}

module.exports = {
  targetInfo, createSet, openExisting, takeSnapshot, thinOut, runBackup, fullBackupTarget, takeFullBackup, copyTarget, addCopy, syncCopy,
  applyCopyResult, applyCopyFailure, copyBehind, verifySet, repairSet, repairRoots, applyResult, applyFailure, CHECK_PARTS,
};
