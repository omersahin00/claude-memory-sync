'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { hashContent, withRetry, TMP_MARK } = require('./fsx');
const P = require('./paths');
const { ID_RE, PART_RE } = require('./chats');

const FORMAT = 'claude-memory-sync';
const VERSION = 2;
const LOCATION_TYPES = new Set(['project', 'workspaceRoot', 'claude']);
// A full backup also carries the app's own files: 'state/<file>' (settings, version history, matches, activity log)
// and 'backups/<kind>/<file>' (every backup taken so far). They are kept byte for byte.
const FULL_REL = /^(state\/[\w-][\w.-]*\.jsonl?|backups\/(daily|before|manual)\/[\w-][\w.-]*\.memsync)$/;
const rawHash = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
// Version 3 (bundles with chats) starts and ends with this; see writeBundleV3.
const MAGIC = Buffer.from('MEMSYNC3', 'ascii');
const TAIL = 4 + MAGIC.length;

class BundleError extends Error {
  constructor(code, message) {
    super(message);
    this.code = `BUNDLE_${code}`;
  }
}

// What was just written did not pass its own check: a fault of this write, not of a file somebody opened.
const writeCheckError = (e) => (e instanceof BundleError
  ? Object.assign(new BundleError('WRITE_CHECK', `The file did not pass the check after writing (${e.message}).`), { detail: e.message })
  : e);

function statsOf(locations, files) {
  const s = { projects: 0, memoryFiles: 0, workspaceFiles: 0, claudeFiles: 0, bytes: 0 };
  for (const loc of Object.values(locations)) if (loc.type === 'project') s.projects++;
  for (const [key, f] of files) {
    s.bytes += f.buf ? f.buf.length : Number(f.size) || 0;
    if (key.startsWith('memory/')) s.memoryFiles++;
    else if (key.startsWith('workspace/')) s.workspaceFiles++;
    else s.claudeFiles++;
  }
  return s;
}

// locations: { [id]: { type, key, name, path, homeRel, gitRemote, claudeDir, scratch, title, skipped } }
//   id is 'project:<key>', 'workspaceRoot:<key>' or 'claude'.
// files: Map<key, { buf, mtime }>, history: Map<key, Set<hash>>, full: Map<'state/...' | 'backups/...', { buf }> (full backups)
// chats: { [id]: { project, title, ... } } (their files are written by writeBundleV3)
function buildBundle({ kind, app, device, locations, files, history, full = null, chats = null, createdAt = new Date() }) {
  const out = {
    format: FORMAT,
    version: VERSION,
    kind,
    createdAt: createdAt.toISOString(),
    app,
    device,
    locations,
    stats: statsOf(locations, files),
    files: {},
    history: {},
  };
  for (const key of [...files.keys()].sort()) {
    const { buf, mtime } = files.get(key);
    out.files[key] = { hash: hashContent(buf), size: buf.length, mtime: mtime ? Math.round(mtime) : undefined, data: buf.toString('base64') };
  }
  for (const key of [...history.keys()].sort()) out.history[key] = [...history.get(key)];
  if (chats) out.chats = { sessions: chats };
  if (full) {
    out.full = { files: {} };
    for (const rel of [...full.keys()].sort()) {
      const { buf } = full.get(rel);
      out.full.files[rel] = { hash: rawHash(buf), size: buf.length, data: buf.toString('base64') };
    }
  }
  return out;
}

// The file gets its name only after it has been read back and verified. Until then it is a temp file, which no list counts,
// so stopping at any moment leaves either nothing or a whole, checked file.
function writeBundle(abs, bundle, onProgress = () => {}) {
  onProgress('write', 0, 1);
  const gz = zlib.gzipSync(Buffer.from(JSON.stringify(bundle), 'utf8'), { level: 9 });
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const tmp = `${abs}${TMP_MARK}${process.pid}`;
  try {
    fs.writeFileSync(tmp, gz);
    onProgress('verify', 0, 1);
    readBundle(tmp);
    withRetry(() => fs.renameSync(tmp, abs));
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw writeCheckError(e);
  }
  return gz.length;
}

// A file a chunk at a time, so its size is limited by the disk and not by the memory.
function eachChunk(src, onChunk) {
  const chunk = Buffer.alloc(CHUNK);
  const fd = fs.openSync(src, 'r');
  try {
    for (let n; (n = fs.readSync(fd, chunk, 0, CHUNK, null));) onChunk(chunk.subarray(0, n));
  } finally {
    fs.closeSync(fd);
  }
}

// Version 3, for bundles with chats, which are far larger than one JSON text can be. Each chat file is gzipped on its
// own, then the version 2 object follows as a gzipped header with where each part is, so the header is read without
// the rest and a part only when it is needed.
//   MEMSYNC3 | part | part | ... | gzip(header JSON) | header length (uint32 BE) | MEMSYNC3
// parts: [{ part, abs }], read from disk one at a time. A part larger than a chunk is several gzip members one after the
// other, which is still one gzip file to any reader; members lists their lengths, so it can be checked without unpacking
// it all into memory.
// Version 4 is the same file with the earlier backups of a full backup as parts too (fullParts: [{ rel, abs }]). They
// are compressed already and can be hundreds of MB each (backups with chats), so they are copied as they are, a chunk
// at a time.
function writeBundleV3(abs, bundle, parts, fullParts = [], onProgress = () => {}) {
  const sizeOf = (src) => {
    try {
      return fs.statSync(src).size;
    } catch {
      return 0;
    }
  };
  const total = [...parts, ...fullParts].reduce((n, p) => n + sizeOf(p.abs), 0);
  const counter = (phase) => {
    let done = 0;
    onProgress(phase, 0, total);
    return (n) => {
      done += n;
      onProgress(phase, Math.min(done, total), total);
    };
  };
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const tmp = `${abs}${TMP_MARK}${process.pid}`;
  const fd = fs.openSync(tmp, 'w');
  const wrote = counter('write');
  let ok = false;
  try {
    let offset = 0;
    const put = (buf) => {
      fs.writeSync(fd, buf, 0, buf.length, offset);
      offset += buf.length;
    };
    put(MAGIC);
    const store = (src, level) => {
      const start = offset;
      const h = crypto.createHash('sha256');
      const members = [];
      let size = 0;
      eachChunk(src, (chunk) => {
        h.update(chunk);
        const gz = zlib.gzipSync(chunk, { level });
        put(gz);
        members.push(gz.length);
        size += chunk.length;
        wrote(chunk.length);
      });
      if (!size) put(zlib.gzipSync(Buffer.alloc(0), { level }));
      return { offset: start, length: offset - start, size, hash: h.digest('hex'), ...(members.length > 1 ? { members } : {}) };
    };
    const copy = (src) => {
      const start = offset;
      const h = crypto.createHash('sha256');
      eachChunk(src, (chunk) => {
        h.update(chunk);
        put(chunk);
        wrote(chunk.length);
      });
      return { offset: start, size: offset - start, hash: h.digest('hex'), raw: true };
    };
    const blobs = parts.map(({ part, abs: src }) => ({ part, ...store(src, 6) }));
    const head = { ...bundle, version: fullParts.length ? 4 : 3 };
    if (bundle.chats) head.chats = { ...bundle.chats, blobs };
    if (fullParts.length) {
      const files = { ...((bundle.full && bundle.full.files) || {}) };
      for (const { rel, abs: src } of fullParts) files[rel] = copy(src);
      head.full = { files };
    }
    const header = zlib.gzipSync(Buffer.from(JSON.stringify(head), 'utf8'), { level: 9 });
    put(header);
    const tail = Buffer.alloc(TAIL);
    tail.writeUInt32BE(header.length, 0);
    MAGIC.copy(tail, 4);
    put(tail);
    fs.fsyncSync(fd);
    ok = true;
  } finally {
    fs.closeSync(fd);
    if (!ok) fs.rmSync(tmp, { force: true });
  }
  // Read back what was written and verify it, every part too. Only then does it get its name.
  try {
    const checked = counter('verify');
    const b = readBundle(tmp);
    if (b.chats) for (const part of b.chats.blobs.keys()) b.chats.check(part, checked);
    if (b.full) for (const f of b.full.values()) if (f.check) f.check(checked);
    withRetry(() => fs.renameSync(tmp, abs));
    return b.compressedSize;
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw writeCheckError(e);
  }
}

function checkHeader(obj) {
  if (!obj || obj.format !== FORMAT) throw new BundleError('NOT_BUNDLE', 'This file is not a memory bundle.');
  if (![1, VERSION, 3, 4].includes(obj.version)) throw new BundleError('VERSION', `Unsupported bundle version: ${obj.version}. Update this app.`);
  if (!obj.device || !obj.device.id) throw new BundleError('HEADER', 'Bundle header is incomplete.');
  return obj;
}

// { obj, size }: a version 3 file is read only as far as its header.
function decode(abs) {
  let fd;
  try {
    fd = fs.openSync(abs, 'r');
  } catch (e) {
    throw new BundleError('UNREADABLE', `Could not read bundle: ${abs} (${e.code || e.message})`);
  }
  let raw;
  try {
    const size = fs.fstatSync(fd).size;
    const head = Buffer.alloc(MAGIC.length);
    fs.readSync(fd, head, 0, head.length, 0);
    if (head.equals(MAGIC)) {
      const tail = Buffer.alloc(TAIL);
      if (size < MAGIC.length + TAIL) throw new BundleError('CORRUPT', 'Bundle is corrupt (too short).');
      fs.readSync(fd, tail, 0, TAIL, size - TAIL);
      const length = tail.readUInt32BE(0);
      if (!tail.subarray(4).equals(MAGIC) || length > size - MAGIC.length - TAIL) throw new BundleError('CORRUPT', 'Bundle is corrupt (end of file).');
      const gz = Buffer.alloc(length);
      fs.readSync(fd, gz, 0, length, size - TAIL - length);
      let obj;
      try {
        obj = JSON.parse(zlib.gunzipSync(gz).toString('utf8'));
      } catch (e) {
        throw new BundleError('CORRUPT', `Bundle is corrupt (${e.message}).`);
      }
      if (obj && obj.version !== 3 && obj.version !== 4) throw new BundleError('CORRUPT', 'Bundle is corrupt (version).');
      return { obj: checkHeader(obj), size };
    }
    raw = Buffer.alloc(size);
    fs.readSync(fd, raw, 0, size, 0);
  } finally {
    fs.closeSync(fd);
  }
  let obj;
  try {
    obj = JSON.parse(zlib.gunzipSync(raw).toString('utf8'));
  } catch (e) {
    throw new BundleError('CORRUPT', `Bundle is corrupt or was not created by this tool (${e.message}).`);
  }
  if (obj && (obj.version === 3 || obj.version === 4)) throw new BundleError('CORRUPT', 'Bundle is corrupt (version).');
  return { obj: checkHeader(obj), size: raw.length };
}

// The chats of a version 3 bundle: sessions by id, where each part is, and read(part), which checks it.
const CHUNK = 16 * 1024 * 1024;
const integrityError = (name) => new BundleError('INTEGRITY', `Bundle integrity check failed (${name}). The file may have been damaged during transfer.`);

// A file kept as it is in a version 4 file (an earlier backup of a full backup): read whole, or only checked, a chunk
// at a time.
function scanRaw(abs, e, name, onChunk) {
  let fd;
  try {
    fd = fs.openSync(abs, 'r');
    const chunk = Buffer.alloc(Math.max(1, Math.min(CHUNK, e.size)));
    for (let at = 0; at < e.size;) {
      const n = fs.readSync(fd, chunk, 0, Math.min(chunk.length, e.size - at), e.offset + at);
      if (!n) throw integrityError(name);
      onChunk(chunk.subarray(0, n), at);
      at += n;
    }
  } catch (err) {
    if (err instanceof BundleError) throw err;
    throw new BundleError('UNREADABLE', `Could not read bundle: ${abs} (${err.code || err.message})`);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function readRaw(abs, e, name) {
  const buf = Buffer.alloc(e.size);
  scanRaw(abs, e, name, (chunk, at) => chunk.copy(buf, at));
  if (rawHash(buf) !== e.hash) throw integrityError(name);
  return buf;
}

function checkRaw(abs, e, name, tick = () => {}) {
  const h = crypto.createHash('sha256');
  scanRaw(abs, e, name, (chunk) => {
    h.update(chunk);
    tick(chunk.length);
  });
  if (h.digest('hex') !== e.hash) throw integrityError(name);
}

const inFile = (e, fileSize) => Boolean(e) && Number.isInteger(e.offset) && Number.isInteger(e.length) && e.offset >= MAGIC.length && e.length > 0 && e.offset + e.length <= fileSize;

// One part of a version 3 or 4 file, unpacked and checked against its hash.
function readPart(abs, e, name) {
  const gz = Buffer.alloc(e.length);
  let fd;
  try {
    fd = fs.openSync(abs, 'r');
    fs.readSync(fd, gz, 0, e.length, e.offset);
  } catch (err) {
    throw new BundleError('UNREADABLE', `Could not read bundle: ${abs} (${err.code || err.message})`);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
  let buf = null;
  try {
    buf = zlib.gunzipSync(gz);
  } catch { /* checked below */ }
  if (!buf || buf.length !== e.size || rawHash(buf) !== e.hash) {
    throw new BundleError('INTEGRITY', `Bundle integrity check failed (${name}). The file may have been damaged during transfer.`);
  }
  return buf;
}

// A part written as several gzip members, checked one member at a time.
function checkMembers(abs, e, name, tick) {
  const h = crypto.createHash('sha256');
  let size = 0;
  let fd;
  try {
    fd = fs.openSync(abs, 'r');
    let at = e.offset;
    for (const length of e.members) {
      const gz = Buffer.alloc(length);
      fs.readSync(fd, gz, 0, length, at);
      at += length;
      const buf = zlib.gunzipSync(gz);
      h.update(buf);
      size += buf.length;
      tick(buf.length);
    }
    if (at !== e.offset + e.length) throw integrityError(name);
  } catch (err) {
    if (err instanceof BundleError) throw err;
    if (err.code && err.code.startsWith('Z_')) throw integrityError(name);
    throw new BundleError('UNREADABLE', `Could not read bundle: ${abs} (${err.code || err.message})`);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
  if (size !== e.size || h.digest('hex') !== e.hash) throw integrityError(name);
}

function readChats(abs, c, locations, fileSize) {
  const sessions = new Map();
  for (const [id, s] of Object.entries((c && c.sessions) || {})) {
    if (!ID_RE.test(id) || !s || !locations[`project:${s.project}`]) throw new BundleError('INVALID', `Invalid chat in bundle: ${id}`);
    sessions.set(id, s);
  }
  const blobs = new Map();
  for (const e of (c && c.blobs) || []) {
    const m = e && PART_RE.exec(String(e.part));
    if (!m || P.relPathError(e.part.slice(2)) || !sessions.has(m[2]) || !inFile(e, fileSize)) throw new BundleError('INVALID', `Invalid chat file in bundle: ${e && e.part}`);
    blobs.set(e.part, e);
  }
  for (const id of sessions.keys()) if (!blobs.has(`p/${id}.jsonl`)) throw new BundleError('INVALID', `Inconsistent bundle: chat ${id} has no transcript.`);
  const read = (part) => {
    const e = blobs.get(part);
    if (!e) throw new BundleError('INVALID', `Not in bundle: ${part}`);
    return readPart(abs, e, part);
  };
  // Checks a part without keeping it in memory. tick(bytes) says how far it got.
  const check = (part, tick = () => {}) => {
    const e = blobs.get(part);
    if (e && Array.isArray(e.members)) return checkMembers(abs, e, part, tick);
    read(part);
    return tick(e.size);
  };
  return { sessions, blobs, read, check };
}

// Version 1 bundles (CLI 1.x): repos by folder name, workspace files relative to the repos folder.
// The repos folder becomes the workspace folder key given by the caller (this device's main folder).
function upgradeV1(obj, workspaceRootKey) {
  if (!obj.repos || typeof obj.repos !== 'object') throw new BundleError('HEADER', 'Bundle header is incomplete.');
  const locations = {};
  for (const [name, info] of Object.entries(obj.repos)) {
    if (!P.validKey(name)) throw new BundleError('INVALID', `Invalid repo name in bundle: ${name}`);
    if (!info || !info.hasMemory) continue;
    const key = P.slugKey(name);
    locations[`project:${key}`] = { type: 'project', key, name, path: null, homeRel: null, gitRemote: info.remote || null, legacy: true };
  }
  if (obj.workspacesIncluded) {
    locations[`workspaceRoot:${workspaceRootKey}`] = { type: 'workspaceRoot', key: workspaceRootKey, name: 'repos', path: null, homeRel: null, legacy: true };
  }
  const convert = (key) => {
    if (typeof key !== 'string') return key;
    if (key.startsWith('memory/')) {
      const rest = key.slice(7);
      const i = rest.indexOf('/');
      return i > 0 ? `memory/${P.slugKey(rest.slice(0, i))}/${rest.slice(i + 1)}` : key;
    }
    if (key.startsWith('workspace/')) return `workspace/${workspaceRootKey}/${key.slice(10)}`;
    return key;
  };
  const files = {};
  for (const [k, f] of Object.entries(obj.files || {})) files[convert(k)] = f;
  const history = {};
  for (const [k, v] of Object.entries(obj.history || {})) history[convert(k)] = v;
  return { ...obj, kind: null, locations, files, history };
}

const str = (v) => (typeof v === 'string' ? v : null);

function validateLocations(locs) {
  if (!locs || typeof locs !== 'object') throw new BundleError('HEADER', 'Bundle header is incomplete.');
  const out = {};
  for (const [id, loc] of Object.entries(locs)) {
    if (!loc || !LOCATION_TYPES.has(loc.type)) throw new BundleError('INVALID', `Invalid location in bundle: ${id}`);
    const key = loc.type === 'claude' ? 'claude' : loc.key;
    if ((loc.type !== 'claude' && !P.validKey(key)) || id !== (loc.type === 'claude' ? 'claude' : `${loc.type}:${key}`)) {
      throw new BundleError('INVALID', `Invalid location in bundle: ${id}`);
    }
    out[id] = {
      type: loc.type, key, name: str(loc.name), path: str(loc.path), homeRel: str(loc.homeRel), gitRemote: str(loc.gitRemote),
      claudeDir: str(loc.claudeDir), scratch: Boolean(loc.scratch), legacy: Boolean(loc.legacy),
    };
    // A scratch session of the desktop app: its session's title there.
    if (str(loc.title)) out[id].title = loc.title;
    // Files of the folder that the sending device left out of the bundle on purpose.
    if (Array.isArray(loc.skipped) && loc.skipped.length) out[id].skipped = loc.skipped.filter((rel) => typeof rel === 'string');
    // A project sent only for its chats: its memory is not in the bundle.
    if (loc.type === 'project' && loc.memory === false) out[id].memory = false;
  }
  return out;
}

function readBundle(abs, { v1WorkspaceRoot = 'repos' } = {}) {
  const { obj: decoded, size } = decode(abs);
  const obj = decoded.version === 1 ? upgradeV1(decoded, v1WorkspaceRoot) : decoded;
  const locations = validateLocations(obj.locations);

  const files = new Map();
  for (const [key, f] of Object.entries(obj.files || {})) {
    const parsed = P.parseKey(key);
    if (!parsed) throw new BundleError('INVALID', `Invalid file path in bundle: ${key}`);
    if (!locations[P.locationIdOf(parsed.scope, parsed.owner)]) {
      throw new BundleError('INVALID', `Inconsistent bundle: ${key} belongs to a location outside the bundle.`);
    }
    const buf = Buffer.from(String(f && f.data), 'base64');
    if (!f || buf.length !== f.size || hashContent(buf) !== f.hash) {
      throw new BundleError('INTEGRITY', `Bundle integrity check failed (${key}). The file may have been damaged during transfer.`);
    }
    files.set(key, { buf, hash: f.hash, mtime: Number(f.mtime) || 0 });
  }

  const history = new Map();
  for (const [key, arr] of Object.entries(obj.history || {})) {
    if (!P.parseKey(key) || !Array.isArray(arr)) throw new BundleError('INVALID', `Invalid history entry in bundle: ${key}`);
    history.set(key, new Set(arr.map(String)));
  }
  for (const [key, f] of files) {
    if (!history.has(key) || !history.get(key).has(f.hash)) throw new BundleError('INVALID', `Inconsistent bundle: ${key} is missing from history.`);
  }

  // Full backups: { buf, size, hash } in the header, or { size, hash, load() } for a part (version 4).
  let full = null;
  if (obj.full && typeof obj.full === 'object') {
    full = new Map();
    for (const [rel, f] of Object.entries(obj.full.files || {})) {
      if (!FULL_REL.test(rel)) throw new BundleError('INVALID', `Invalid file path in bundle: ${rel}`);
      if (decoded.version === 4 && f && f.raw === true) {
        const ok = Number.isInteger(f.offset) && f.offset >= MAGIC.length && Number.isInteger(f.size) && f.size >= 0 && f.offset + f.size <= size && typeof f.hash === 'string';
        if (!ok) throw new BundleError('INVALID', `Invalid file in bundle: ${rel}`);
        full.set(rel, { size: f.size, hash: f.hash, load: () => readRaw(abs, f, rel), check: (tick) => checkRaw(abs, f, rel, tick) });
        continue;
      }
      const buf = Buffer.from(String(f && f.data), 'base64');
      if (!f || buf.length !== f.size || rawHash(buf) !== f.hash) {
        throw new BundleError('INTEGRITY', `Bundle integrity check failed (${rel}). The file may have been damaged during transfer.`);
      }
      full.set(rel, { buf, size: buf.length, hash: f.hash });
    }
  }

  return {
    version: decoded.version,
    kind: obj.kind || null,
    createdAt: obj.createdAt,
    app: obj.app || null,
    device: obj.device,
    locations,
    stats: statsOf(locations, files),
    files,
    history,
    full,
    chats: decoded.version >= 3 && obj.chats ? readChats(abs, obj.chats, locations, size) : null,
    compressedSize: size,
  };
}

// Quick look for the backup library: header and counts, file contents are not checked.
function readBundleHeader(abs) {
  const { obj, size } = decode(abs);
  const entries = Object.entries(obj.files || {});
  const count = (prefix) => entries.filter(([k]) => k.startsWith(prefix)).length;
  const projects = obj.version === 1
    ? Object.values(obj.repos || {}).filter((r) => r && r.hasMemory).length
    : Object.values(obj.locations || {}).filter((l) => l && l.type === 'project').length;
  return {
    version: obj.version,
    kind: obj.kind || null,
    createdAt: obj.createdAt,
    device: obj.device,
    stats: {
      projects,
      memoryFiles: count('memory/'),
      workspaceFiles: count('workspace/'),
      claudeFiles: count('claude/'),
      bytes: entries.reduce((s, [, f]) => s + (Number(f && f.size) || 0), 0),
    },
    full: obj.full ? { backups: Object.keys(obj.full.files || {}).filter((k) => k.startsWith('backups/')).length } : null,
    chats: obj.chats ? Object.keys(obj.chats.sessions || {}).length : 0,
    compressedSize: size,
  };
}

module.exports = { buildBundle, writeBundle, writeBundleV3, readBundle, readBundleHeader, statsOf, BundleError, FORMAT, VERSION };
