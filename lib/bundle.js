'use strict';
const fs = require('fs');
const zlib = require('zlib');
const crypto = require('crypto');
const { writeFileAtomic, hashContent } = require('./fsx');
const P = require('./paths');

const FORMAT = 'claude-memory-sync';
const VERSION = 2;
const LOCATION_TYPES = new Set(['project', 'workspaceRoot', 'claude']);
// A full backup also carries the app's own files: 'state/<file>' (settings, version history, matches, activity log)
// and 'backups/<kind>/<file>' (every backup taken so far). They are kept byte for byte.
const FULL_REL = /^(state\/[\w-][\w.-]*\.jsonl?|backups\/(daily|before|manual)\/[\w-][\w.-]*\.memsync)$/;
const rawHash = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

class BundleError extends Error {
  constructor(code, message) {
    super(message);
    this.code = `BUNDLE_${code}`;
  }
}

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

// locations: { [id]: { type, key, name, path, homeRel, gitRemote, claudeDir, scratch, skipped } }
//   id is 'project:<key>', 'workspaceRoot:<key>' or 'claude'.
// files: Map<key, { buf, mtime }>, history: Map<key, Set<hash>>, full: Map<'state/...' | 'backups/...', { buf }> (full backups)
function buildBundle({ kind, app, device, locations, files, history, full = null, createdAt = new Date() }) {
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
  if (full) {
    out.full = { files: {} };
    for (const rel of [...full.keys()].sort()) {
      const { buf } = full.get(rel);
      out.full.files[rel] = { hash: rawHash(buf), size: buf.length, data: buf.toString('base64') };
    }
  }
  return out;
}

function writeBundle(abs, bundle) {
  const gz = zlib.gzipSync(Buffer.from(JSON.stringify(bundle), 'utf8'), { level: 9 });
  writeFileAtomic(abs, gz);
  readBundle(abs); // read back what was written and verify it
  return gz.length;
}

function decode(abs) {
  let raw;
  try {
    raw = fs.readFileSync(abs);
  } catch (e) {
    throw new BundleError('UNREADABLE', `Could not read bundle: ${abs} (${e.code || e.message})`);
  }
  let obj;
  try {
    obj = JSON.parse(zlib.gunzipSync(raw).toString('utf8'));
  } catch (e) {
    throw new BundleError('CORRUPT', `Bundle is corrupt or was not created by this tool (${e.message}).`);
  }
  if (!obj || obj.format !== FORMAT) throw new BundleError('NOT_BUNDLE', 'This file is not a memory bundle.');
  if (obj.version !== 1 && obj.version !== VERSION) throw new BundleError('VERSION', `Unsupported bundle version: ${obj.version}. Update this app.`);
  if (!obj.device || !obj.device.id) throw new BundleError('HEADER', 'Bundle header is incomplete.');
  return { obj, raw };
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
    // Files of the folder that the sending device left out of the bundle on purpose.
    if (Array.isArray(loc.skipped) && loc.skipped.length) out[id].skipped = loc.skipped.filter((rel) => typeof rel === 'string');
  }
  return out;
}

function readBundle(abs, { v1WorkspaceRoot = 'repos' } = {}) {
  const { obj: decoded, raw } = decode(abs);
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

  let full = null;
  if (obj.full && typeof obj.full === 'object') {
    full = new Map();
    for (const [rel, f] of Object.entries(obj.full.files || {})) {
      if (!FULL_REL.test(rel)) throw new BundleError('INVALID', `Invalid file path in bundle: ${rel}`);
      const buf = Buffer.from(String(f && f.data), 'base64');
      if (!f || buf.length !== f.size || rawHash(buf) !== f.hash) {
        throw new BundleError('INTEGRITY', `Bundle integrity check failed (${rel}). The file may have been damaged during transfer.`);
      }
      full.set(rel, { buf });
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
    compressedSize: raw.length,
  };
}

// Quick look for the backup library: header and counts, file contents are not checked.
function readBundleHeader(abs) {
  const { obj, raw } = decode(abs);
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
    compressedSize: raw.length,
  };
}

module.exports = { buildBundle, writeBundle, readBundle, readBundleHeader, statsOf, BundleError, FORMAT, VERSION };
