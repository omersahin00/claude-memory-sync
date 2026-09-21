'use strict';
const fs = require('fs');
const zlib = require('zlib');
const { writeFileAtomic, hashContent } = require('./fsx');
const { parseKey, REPO_NAME } = require('./paths');

const FORMAT = 'claude-memory-sync';
const VERSION = 1;

// repos: { <repo>: { remote, hasMemory, memoryFiles } }. Repos with hasMemory=true are the bundle's memory scopes.
// files: Map<key, { buf }>, history: Map<key, Set<hash>>
function buildBundle({ config, platform, hostname, repos, workspacesIncluded, files, history }) {
  const out = {
    format: FORMAT,
    version: VERSION,
    createdAt: new Date().toISOString(),
    device: { id: config.deviceId, name: config.deviceName, platform, hostname },
    prefix: config.prefix,
    repos,
    workspacesIncluded: Boolean(workspacesIncluded),
    files: {},
    history: {},
  };
  for (const key of [...files.keys()].sort()) {
    const { buf } = files.get(key);
    out.files[key] = { hash: hashContent(buf), size: buf.length, data: buf.toString('base64') };
  }
  for (const key of [...history.keys()].sort()) out.history[key] = [...history.get(key)];
  return out;
}

function writeBundle(abs, bundle) {
  const gz = zlib.gzipSync(Buffer.from(JSON.stringify(bundle), 'utf8'), { level: 9 });
  writeFileAtomic(abs, gz);
  readBundle(abs); // read back what was written and verify it
  return gz.length;
}

function readBundle(abs) {
  let raw;
  try {
    raw = fs.readFileSync(abs);
  } catch (e) {
    throw new Error(`Could not read bundle: ${abs} (${e.code || e.message})`);
  }
  let obj;
  try {
    obj = JSON.parse(zlib.gunzipSync(raw).toString('utf8'));
  } catch (e) {
    throw new Error(`Bundle is corrupt or was not created by this tool (${e.message}).`);
  }
  if (!obj || obj.format !== FORMAT) throw new Error('This file is not a memory bundle.');
  if (obj.version !== VERSION) throw new Error(`Unsupported bundle version: ${obj.version}`);
  if (!obj.device || !obj.device.id || !obj.repos || typeof obj.repos !== 'object') throw new Error('Bundle header is incomplete.');

  for (const name of Object.keys(obj.repos)) {
    if (!REPO_NAME.test(name) || name === '.' || name === '..') throw new Error(`Invalid repo name in bundle: ${name}`);
  }

  const files = new Map();
  for (const [key, f] of Object.entries(obj.files || {})) {
    const parsed = parseKey(key);
    if (!parsed) throw new Error(`Invalid file path in bundle: ${key}`);
    if (parsed.scope === 'memory' && !(obj.repos[parsed.repo] && obj.repos[parsed.repo].hasMemory)) {
      throw new Error(`Inconsistent bundle: ${key} belongs to a repo outside the bundle scope.`);
    }
    if (parsed.scope === 'workspace' && !obj.workspacesIncluded) throw new Error(`Inconsistent bundle: ${key}`);
    const buf = Buffer.from(String(f.data), 'base64');
    if (buf.length !== f.size || hashContent(buf) !== f.hash) {
      throw new Error(`Bundle integrity check failed (${key}). The file may have been damaged during transfer.`);
    }
    files.set(key, { buf, hash: f.hash });
  }

  const history = new Map();
  for (const [key, arr] of Object.entries(obj.history || {})) {
    if (!parseKey(key) || !Array.isArray(arr)) throw new Error(`Invalid history entry in bundle: ${key}`);
    history.set(key, new Set(arr.map(String)));
  }
  for (const [key, f] of files) {
    if (!history.has(key) || !history.get(key).has(f.hash)) throw new Error(`Inconsistent bundle: ${key} is missing from history.`);
  }

  return {
    createdAt: obj.createdAt,
    device: obj.device,
    prefix: obj.prefix,
    repos: obj.repos,
    workspacesIncluded: obj.workspacesIncluded,
    files,
    history,
    compressedSize: raw.length,
  };
}

module.exports = { buildBundle, writeBundle, readBundle, FORMAT, VERSION };
