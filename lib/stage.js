'use strict';
// A backup of this device as a folder: what a .memsync bundle holds, unpacked, so restic stores it piece by piece and
// stores again only what changed (lib/backups.js). The folder stays between backups and is brought up to date in place,
// so restic finds an unchanged file unchanged and does not read it again:
//   manifest.json             what a bundle's header says (kind, device, locations, version history, chats), and for
//                             each file its hash and size
//   memory/<project>/<file>   memory files, workspace files and Claude's settings, under the keys of a bundle
//   workspace/<root>/<file>
//   claude/<file>
//   chats/<part>              the files of the chats in it (p/<id>.jsonl, p/<id>/..., h/<id>/..., u/<id>/...): links to
//                             the chats' own files (hard links, which take no room) where the disk allows, copies where not
// Nothing in the folder is ever written into: a file is replaced whole (a new file takes its name) or removed, so a link
// never changes the chat it is a link of.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { hashContent, hashFile, withRetry, TMP_MARK } = require('./fsx');
const { statsOf, validateLocations } = require('./bundle');
const P = require('./paths');
const { ID_RE, PART_RE } = require('./chats');

const FORMAT = 'claude-memory-sync-stage';
const VERSION = 1;
const MANIFEST = 'manifest.json';
const CHATS = 'chats';
const rawHash = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

class StageError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

// 'memory/x/a.md' as a path below dir; null for anything that could leave it.
function below(dir, rel) {
  const parts = String(rel).split('/');
  if (!parts.length || parts.some((x) => !x || x === '.' || x === '..' || /[\\:]/.test(x) && process.platform === 'win32')) return null;
  return path.join(dir, ...parts);
}

// Every file under dir, as 'a/b.md' -> stat.
function listFiles(dir) {
  const out = new Map();
  const walk = (abs, rel) => {
    let entries;
    try {
      entries = fs.readdirSync(abs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const a = path.join(abs, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(a, r);
      else out.set(r, a);
    }
  };
  walk(dir, '');
  return out;
}

function removeEmptyDirs(dir, keepRoot = true) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) if (e.isDirectory()) removeEmptyDirs(path.join(dir, e.name), false);
  if (!keepRoot) {
    try {
      if (!fs.readdirSync(dir).length) fs.rmdirSync(dir);
    } catch { /* not empty, or gone */ }
  }
}

// A new file takes the name, so whatever was there (a link of a chat, too) is never written into.
function replace(abs, write) {
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const tmp = `${abs}${TMP_MARK}${process.pid}`;
  fs.rmSync(tmp, { force: true });
  try {
    write(tmp);
    withRetry(() => fs.renameSync(tmp, abs));
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
}

// What the manifest says of a backup: header ({ kind, reason, createdAt, app, device, locations, history, chats }) and
// the files ({ key -> { buf, mtime } }).
function manifestOf({ kind, reason = null, createdAt, app, device, locations, files, history, chats = null }) {
  const out = { format: FORMAT, version: VERSION, kind, reason, createdAt: createdAt.toISOString(), app, device, locations, stats: statsOf(locations, files), files: {}, history: {} };
  for (const key of [...files.keys()].sort()) {
    const { buf, mtime } = files.get(key);
    out.files[key] = { hash: hashContent(buf), size: buf.length, mtime: mtime ? Math.round(mtime) : undefined };
  }
  for (const key of [...history.keys()].sort()) out.history[key] = [...history.get(key)];
  if (chats) out.chats = { sessions: chats, parts: {} };
  return out;
}

// Brings dir up to date with this backup: header as for manifestOf, files { key -> { buf, mtime } }, chatFiles
// [{ part, abs }]. A file that is the same stays as it is; a chat's link stays while it is still a link of that chat.
// The hash of each chat file is taken again only when the file changed since the last time (size and time of change).
// Resolves to { files, chats, linked, copied }.
async function writeStage(dir, { header, files, chatFiles = [] }) {
  fs.mkdirSync(dir, { recursive: true });
  const previous = readManifest(dir);
  const before = (previous && previous.chats && previous.chats.parts) || {};
  const manifest = manifestOf({ ...header, files });
  const want = new Map();
  for (const key of files.keys()) {
    const abs = below(dir, key);
    if (!abs || key.startsWith(`${CHATS}/`) || key === MANIFEST) throw new StageError('STAGE_INVALID', `Not a name for the backup: ${key}`);
    want.set(key, abs);
  }
  for (const { part } of chatFiles) {
    const abs = below(dir, `${CHATS}/${part}`);
    if (!abs || !PART_RE.test(part)) throw new StageError('STAGE_INVALID', `Not a chat file for the backup: ${part}`);
    want.set(`${CHATS}/${part}`, abs);
  }
  // What is not in this backup goes first, so a file never stands where a folder has to be made.
  for (const [rel, abs] of listFiles(dir)) {
    if (rel !== MANIFEST && !want.has(rel)) withRetry(() => fs.rmSync(abs, { force: true }));
  }
  removeEmptyDirs(dir);

  for (const [key, f] of files) {
    const abs = want.get(key);
    let same = false;
    try {
      same = fs.statSync(abs).size === f.buf.length && fs.readFileSync(abs).equals(f.buf);
    } catch { /* not there */ }
    if (same) continue;
    replace(abs, (tmp) => {
      fs.writeFileSync(tmp, f.buf);
      if (f.mtime) fs.utimesSync(tmp, new Date(f.mtime), new Date(f.mtime));
    });
  }

  let linked = 0;
  let copied = 0;
  for (const { part, abs: src } of chatFiles) {
    const abs = want.get(`${CHATS}/${part}`);
    let st;
    try {
      st = fs.statSync(src);
    } catch {
      // Gone since it was listed (Claude removed it): it is not in this backup.
      continue;
    }
    let cur = null;
    try {
      cur = fs.statSync(abs);
    } catch { /* not there */ }
    const isLink = Boolean(cur) && cur.ino === st.ino && cur.dev === st.dev;
    const sameCopy = Boolean(cur) && !isLink && cur.size === st.size && Math.round(cur.mtimeMs) === Math.round(st.mtimeMs);
    if (!isLink && !sameCopy) {
      replace(abs, (tmp) => {
        try {
          fs.linkSync(src, tmp);
        } catch {
          fs.copyFileSync(src, tmp);
          fs.utimesSync(tmp, st.atime, st.mtime);
        }
      });
      cur = fs.statSync(abs);
    }
    if (cur.ino === st.ino && cur.dev === st.dev) linked++;
    else copied++;
    const old = before[part];
    const hash = old && old.size === st.size && old.mtime === Math.round(st.mtimeMs) && old.hash ? old.hash : await hashFile(abs);
    manifest.chats.parts[part] = { size: st.size, mtime: Math.round(st.mtimeMs), hash };
  }
  replace(path.join(dir, MANIFEST), (tmp) => fs.writeFileSync(tmp, JSON.stringify(manifest, null, 2)));
  return { files: files.size, chats: manifest.chats ? Object.keys(manifest.chats.sessions).length : 0, linked, copied };
}

function readManifest(dir) {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(dir, MANIFEST), 'utf8'));
    return m && m.format === FORMAT ? m : null;
  } catch {
    return null;
  }
}

const integrity = (name) => new StageError('STAGE_INTEGRITY', `The backup does not hold ${name} as it was written.`);

// A stage folder (restored from a snapshot) read back as a bundle (lib/bundle.js readBundle): every file is checked
// against its hash; a chat file is read and checked only when it is used.
function readStage(dir) {
  const m = readManifest(dir);
  if (!m) throw new StageError('STAGE_INVALID', `There is no backup in ${dir}.`);
  if (m.version !== VERSION) throw new StageError('STAGE_VERSION', `This backup was taken by a newer version of the app: ${m.version}.`);
  if (!m.device || !m.device.id) throw new StageError('STAGE_INVALID', 'The backup does not say which device it is of.');
  const locations = validateLocations(m.locations);
  const files = new Map();
  for (const [key, f] of Object.entries(m.files || {})) {
    const pk = P.parseKey(key);
    const abs = below(dir, key);
    if (!pk || !abs || !locations[P.locationIdOf(pk.scope, pk.owner)]) throw new StageError('STAGE_INVALID', `Not a file of the backup: ${key}`);
    let buf;
    try {
      buf = fs.readFileSync(abs);
    } catch {
      throw integrity(key);
    }
    if (!f || buf.length !== f.size || hashContent(buf) !== f.hash) throw integrity(key);
    files.set(key, { buf, hash: f.hash, mtime: Number(f.mtime) || 0 });
  }
  const history = new Map();
  for (const [key, arr] of Object.entries(m.history || {})) if (P.parseKey(key) && Array.isArray(arr)) history.set(key, new Set(arr.map(String)));
  for (const [key, f] of files) {
    if (!history.has(key)) history.set(key, new Set());
    history.get(key).add(f.hash);
  }

  let chats = null;
  if (m.chats && m.chats.sessions) {
    const sessions = new Map();
    for (const [id, s] of Object.entries(m.chats.sessions)) {
      if (!ID_RE.test(id) || !s || !locations[`project:${s.project}`]) throw new StageError('STAGE_INVALID', `Not a chat of the backup: ${id}`);
      sessions.set(id, s);
    }
    const blobs = new Map();
    for (const [part, e] of Object.entries(m.chats.parts || {})) {
      const mm = PART_RE.exec(part);
      if (!mm || !sessions.has(mm[2]) || !e || !Number.isInteger(e.size) || typeof e.hash !== 'string') throw new StageError('STAGE_INVALID', `Not a chat file of the backup: ${part}`);
      blobs.set(part, { part, size: e.size, hash: e.hash, abs: below(dir, `${CHATS}/${part}`) });
    }
    // A chat whose transcript Claude removed before the backup was taken is not in it.
    for (const id of [...sessions.keys()]) if (!blobs.has(`p/${id}.jsonl`)) sessions.delete(id);
    const read = (part) => {
      const e = blobs.get(part);
      if (!e) throw new StageError('STAGE_INVALID', `Not in the backup: ${part}`);
      let buf;
      try {
        buf = fs.readFileSync(e.abs);
      } catch {
        throw integrity(part);
      }
      if (buf.length !== e.size || rawHash(buf) !== e.hash) throw integrity(part);
      return buf;
    };
    const check = (part, tick = () => {}) => {
      const e = blobs.get(part);
      read(part);
      tick(e ? e.size : 0);
    };
    chats = sessions.size ? { sessions, blobs, read, check } : null;
  }
  let size = 0;
  for (const f of files.values()) size += f.buf.length;
  if (chats) for (const e of chats.blobs.values()) size += e.size;
  return {
    version: 'stage', kind: m.kind || 'backup', reason: m.reason || null, createdAt: m.createdAt, app: m.app || null, device: m.device,
    locations, stats: statsOf(locations, files), files, history, full: null, chats, compressedSize: size,
  };
}

module.exports = { writeStage, readStage, readManifest, manifestOf, StageError, FORMAT, MANIFEST, CHATS };
