'use strict';
// Bringing files back from a snapshot, in two ways:
//   to another folder: into a new folder made for it, so nothing on this computer is overwritten;
//   in place: first into a hidden folder beside where they were (the same disk, so the next move is only a rename), every
//   file read back and compared; only then each one is moved into place. What was there is moved to the Trash first,
//   never deleted. A restore stopped or failed before the move leaves everything as it was; one that fails during the
//   move leaves the rest of the restored files in a visible folder beside them, so nothing is lost.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const repo = require('./repository');
const { run } = require('./restic');
const { localPath } = require('./catalog');
const { BackupError } = require('./errors');

// Names Windows cannot make: < > : " \ | ? * and control characters, a name ending in a space or a dot, and the names
// of devices (CON, NUL, COM1 ...). A Mac allows all of them, so a backup made there can hold them. restic does not
// rename anything, so such a file is written under a safe name instead: each of those characters becomes _.
const RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;
const BAD = /[<>:"\\|?*\u0000-\u001f]/g;
const windowsInvalid = (name) => /[<>:"\\|?*\u0000-\u001f]/.test(name) || /[. ]$/.test(name) || RESERVED.test(name);
function windowsSafe(name) {
  let s = name.replace(BAD, '_').replace(/[. ]+$/, (m) => '_'.repeat(m.length));
  if (RESERVED.test(s)) s = `_${s}`;
  return s;
}

const exists = (p) => {
  try {
    fs.lstatSync(p);
    return true;
  } catch {
    return false;
  }
};

// A name for a new folder in place that is not taken: "label", "label 2", ...
function freeName(place, label) {
  let name = label;
  for (let i = 2; exists(path.join(place, name)); i++) name = `${label} ${i}`;
  return path.join(place, name);
}

const join = (folder, name) => (folder === '/' ? `/${name}` : `${folder}/${name}`);

async function nodes(ctx, snapshot, dirs, recursive, signal) {
  const out = [];
  await run(['ls', snapshot, ...dirs, ...(recursive ? ['--recursive'] : [])], { ...ctx, signal, onMessage: (m) => m.message_type === 'node' && out.push(m) });
  return out;
}

// Like repository.restore, but names this system cannot make are written under safe names (invalid tells which; on
// Windows the names above). restic cannot rename, so those items are left out of its restore and written on their own:
// a file with restic dump, a folder by restoring it into a folder of the safe name, the same way again. Returns the
// items renamed, as { from, to } paths relative to the target.
async function restoreSafe({ dir, cacheDir, password, keyHint, snapshot, folder, names = null, target, invalid = windowsInvalid, onProgress, signal }) {
  const ctx = { repo: dir, cacheDir, password, keyHint };
  const under = names ? names.map((n) => join(folder, n)) : [folder];
  const all = (await nodes(ctx, snapshot, under, true, signal)).filter((n) => n.path !== folder);
  const rel = (p) => p.slice(folder === '/' ? 1 : folder.length + 1);
  const bad = [];
  for (const n of all.sort((a, b) => a.path.localeCompare(b.path))) {
    if (!invalid(n.name)) continue;
    if (bad.some((b) => n.path.startsWith(`${b.path}/`))) continue;
    bad.push(n);
  }
  if (!bad.length) {
    await repo.restore({ dir, cacheDir, password, keyHint, snapshot, folder, names, target, onProgress, signal });
    return [];
  }
  // restic takes names to include or patterns to leave out, not both: what was not chosen is left out with the rest.
  const out = bad.map((n) => `/${rel(n.path).split('/').map(repo.literal).join('/')}`);
  if (names) {
    const siblings = (await nodes(ctx, snapshot, [folder], false, signal)).filter((n) => n.path !== folder && !names.includes(n.name));
    for (const n of siblings) out.push(`/${repo.literal(n.name)}`);
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'folder-backup-'));
  const file = path.join(tmp, 'exclude');
  try {
    fs.writeFileSync(file, out.join('\n') + '\n', { mode: 0o600 });
    await repo.restore({ dir, cacheDir, password, keyHint, snapshot, folder, excludeFile: file, target, onProgress, signal });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  const renamed = [];
  for (const n of bad) {
    const r = rel(n.path);
    const to = path.join(target, ...path.posix.dirname(r).split('/').filter((x) => x !== '.'), windowsSafe(n.name));
    fs.mkdirSync(path.dirname(to), { recursive: true });
    if (n.type === 'dir') {
      const inner = await restoreSafe({ dir, cacheDir, password, keyHint, snapshot, folder: n.path, target: to, invalid, signal });
      for (const x of inner) renamed.push({ from: `${r}/${x.from}`, to: path.posix.join(path.relative(target, to).split(path.sep).join('/'), x.to) });
    } else if (n.type === 'file') {
      const fd = fs.openSync(to, 'wx');
      try {
        await run(['dump', snapshot, n.path], { ...ctx, signal, onOutput: (d) => fs.writeSync(fd, d) });
      } finally {
        fs.closeSync(fd);
      }
      if (n.mtime) fs.utimesSync(to, new Date(), new Date(n.mtime));
    } else continue;
    renamed.push({ from: r, to: path.relative(target, to).split(path.sep).join('/') });
  }
  return renamed;
}

// Names are made safe for this system only where it needs it: on Windows.
const restoreHere = (opts) => (opts.invalid || process.platform === 'win32' ? restoreSafe(opts) : repo.restore(opts).then(() => []));

// folder: the folder of the snapshot (as restic lists it) the names are in; names: the items chosen, all without it.
async function restoreTo({ dir, cacheDir, password, keyHint, snapshot, folder, names = null, place, label, invalid, onProgress, signal }) {
  if (!exists(place)) throw new BackupError('TARGET_MISSING', `The place to restore to is not there: ${place}`, { path: place });
  const target = freeName(place, label);
  let renamed;
  try {
    renamed = await restoreHere({ dir, cacheDir, password, keyHint, snapshot, folder, names, target, invalid, onProgress, signal });
  } catch (e) {
    fs.rmSync(target, { recursive: true, force: true });
    throw e;
  }
  return { target, renamed };
}

// trash(path): moves a file or folder to the system's Trash (shell.trashItem in the app).
async function restoreInPlace({ dir, cacheDir, password, keyHint, snapshot, folder, names, trash, keepLabel, invalid, onProgress, signal }) {
  if (!names || !names.length) throw new BackupError('INVALID', 'Choose what to restore.');
  const here = localPath(folder);
  if (!here) throw new BackupError('OTHER_SYSTEM', `This backup was made on another system: ${folder}`, { path: folder });
  fs.mkdirSync(here, { recursive: true });
  const tmp = path.join(here, `.folder-backup-restore-${crypto.randomBytes(4).toString('hex')}`);
  let renamed;
  try {
    renamed = await restoreHere({ dir, cacheDir, password, keyHint, snapshot, folder, names, target: tmp, invalid, onProgress, signal });
  } catch (e) {
    fs.rmSync(tmp, { recursive: true, force: true });
    throw e;
  }
  const restored = [];
  const trashed = [];
  try {
    for (const original of names) {
      const top = renamed.find((r) => r.from === original);
      const name = top ? top.to : original;
      const from = path.join(tmp, name);
      if (!exists(from)) continue;
      const to = path.join(here, name);
      if (exists(to)) {
        await trash(to);
        trashed.push(to);
      }
      fs.renameSync(from, to);
      restored.push(to);
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch (e) {
    const kept = freeName(here, keepLabel);
    try {
      fs.renameSync(tmp, kept);
    } catch { /* left hidden where it is */ }
    throw new BackupError('RESTORE_MOVE_FAILED', `Restored, but moving into place failed: ${e.message}`, { path: kept, detail: e.message });
  }
  return { restored, trashed, renamed };
}

module.exports = { restoreTo, restoreInPlace, restoreSafe, freeName, windowsInvalid, windowsSafe };
