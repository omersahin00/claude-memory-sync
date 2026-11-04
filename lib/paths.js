'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const PLATFORM_NAMES = { darwin: 'macOS', win32: 'Windows', linux: 'Linux' };
const platformName = (p = process.platform) => PLATFORM_NAMES[p] || p;
const pathApi = (platform = process.platform) => (platform === 'win32' ? path.win32 : path.posix);
// macOS (APFS default) and Windows file systems are case-insensitive.
const caseInsensitive = (platform = process.platform) => platform === 'win32' || platform === 'darwin';

function claudeDir(env = process.env, home = os.homedir()) {
  return env.CLAUDE_CONFIG_DIR ? path.resolve(env.CLAUDE_CONFIG_DIR) : path.join(home, '.claude');
}

// Claude Code project folder name, as Claude Code 2.1 gives it: the absolute path in NFC form, with every
// non-alphanumeric character as '-'. macOS can keep a name as NFD (Ş as S and a cedilla), and Claude Code reads it as
// NFC. A name over 200 characters is cut there and ends with a hash of the path.
// /Users/demo/GitHub/x  -> -Users-demo-GitHub-x
const MAX_PROJECT_DIR = 200;
const dashes = (s) => String(s).replace(/[^a-zA-Z0-9]/g, '-');
function pathHash(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return Math.abs(h).toString(36);
}
function encodeProjectDir(absPath) {
  const abs = String(absPath).normalize('NFC');
  const name = dashes(abs);
  return name.length <= MAX_PROJECT_DIR ? name : `${name.slice(0, MAX_PROJECT_DIR)}-${pathHash(abs)}`;
}
// The names a folder's Claude project can have: today's, then the one older Claude Code versions gave it (the path in
// the form it came, not cut).
function projectDirNames(absPath) {
  const name = encodeProjectDir(absPath);
  const old = dashes(absPath);
  return name === old ? [name] : [name, old];
}

function normalizeForCompare(p, platform) {
  let n = pathApi(platform).normalize(String(p).normalize('NFC'));
  if (n.length > 1) n = n.replace(/[\\/]+$/, '');
  return caseInsensitive(platform) ? n.toLowerCase() : n;
}

function samePath(a, b, platform = process.platform) {
  if (!a || !b) return false;
  return normalizeForCompare(a, platform) === normalizeForCompare(b, platform);
}

// Path below the home folder with '/' separators ('Documents/GitHub/x'); '' for home itself, null if outside it.
function homeRel(abs, home, platform = process.platform) {
  if (!abs || !home) return null;
  const api = pathApi(platform);
  const rel = api.relative(home, abs);
  if (rel === '') return '';
  if (rel === '..' || rel.startsWith(`..${api.sep}`) || api.isAbsolute(rel)) return null;
  return rel.split(api.sep).join('/');
}

// Stable, readable identifier for a project or folder: same name gives the same key on every device.
function slugKey(name, fallback = 'project') {
  const s = String(name || '')
    .replace(/İ/g, 'I')
    .replace(/ı/g, 'i')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '');
  return s || fallback;
}

// The "cwd" field at the start of session logs (*.jsonl) is the real path of the project folder.
const HEAD_BYTES = 256 * 1024;
function readSessionCwds(projectDir, maxFiles = 5) {
  let files;
  try {
    files = fs
      .readdirSync(projectDir)
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => {
        const full = path.join(projectDir, f);
        let mtime = 0;
        try { mtime = fs.statSync(full).mtimeMs; } catch { /* ignore */ }
        return { full, mtime };
      })
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, maxFiles);
  } catch {
    return [];
  }
  const cwds = new Set();
  for (const { full } of files) {
    let fd;
    try {
      fd = fs.openSync(full, 'r');
      const buf = Buffer.alloc(HEAD_BYTES);
      const n = fs.readSync(fd, buf, 0, HEAD_BYTES, 0);
      const m = buf.toString('utf8', 0, n).match(/"cwd":"((?:[^"\\]|\\.)*)"/);
      if (m) cwds.add(JSON.parse(`"${m[1]}"`));
    } catch {
      /* unreadable session log: skip */
    } finally {
      if (fd !== undefined) try { fs.closeSync(fd); } catch { /* ignore */ }
    }
  }
  return [...cwds];
}

// Finds the real folder behind a Claude project folder name by walking the file system from the root.
// Several folders can encode to the same name; the first existing match wins. Null if none is found.
function decodeProjectDir(name, { platform = process.platform, maxReads = 400 } = {}) {
  const api = pathApi(platform);
  let root;
  if (platform === 'win32') {
    const m = /^([A-Za-z])--/.exec(name);
    if (!m) return null;
    root = `${m[1].toUpperCase()}:\\`;
  } else {
    root = '/';
  }
  const start = encodeProjectDir(root);
  if (!name.startsWith(start)) return null;
  const ci = caseInsensitive(platform);
  const eq = (a, b) => (ci ? a.toLowerCase() === b.toLowerCase() : a === b);
  const startsWith = (s, p) => (ci ? s.toLowerCase().startsWith(p.toLowerCase()) : s.startsWith(p));
  let reads = 0;
  const walk = (dir, rest) => {
    if (rest === '') return dir;
    if (reads++ >= maxReads) return null;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return null;
    }
    for (const e of entries) {
      if (!e.isDirectory() && !e.isSymbolicLink()) continue;
      for (const enc of new Set([dashes(e.name.normalize('NFC')), dashes(e.name)])) {
        if (eq(rest, enc)) return api.join(dir, e.name);
        if (startsWith(rest, `${enc}-`)) {
          const found = walk(api.join(dir, e.name), rest.slice(enc.length + 1));
          if (found) return found;
        }
      }
    }
    return null;
  };
  return walk(root, name.slice(start.length));
}

// ---- Bundle keys ------------------------------------------------------------
// memory/<project key>/<path in the memory folder>
// workspace/<folder key>/<path below that folder>
// claude/<path in the Claude folder>
const KEY_RE = /^[A-Za-z0-9._-]+$/;
const validKey = (k) => typeof k === 'string' && KEY_RE.test(k) && k !== '.' && k !== '..';

function relPathError(rel) {
  if (typeof rel !== 'string' || rel === '') return 'empty path';
  if (rel.includes('\\') || rel.startsWith('/') || /^[a-zA-Z]:/.test(rel)) return `invalid path: ${rel}`;
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.' || seg === '..') return `invalid path segment: ${rel}`;
    if (seg.includes('\x00')) return `invalid character: ${rel}`;
  }
  return null;
}

const WIN_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
function windowsNameError(rel) {
  for (const seg of rel.split('/')) {
    // eslint-disable-next-line no-control-regex
    if (/[<>:"|?*\x00-\x1f]/.test(seg)) return `contains a character that is invalid on Windows: ${rel}`;
    if (WIN_RESERVED.test(seg)) return `reserved name on Windows: ${rel}`;
    if (/[. ]$/.test(seg)) return `name ends with a dot or space, invalid on Windows: ${rel}`;
  }
  return null;
}

const memoryKey = (project, rel) => `memory/${project}/${rel}`;
const workspaceKey = (root, rel) => `workspace/${root}/${rel}`;
const claudeKey = (rel) => `claude/${rel}`;

// Location id in a bundle for each key scope.
const locationIdOf = (scope, owner) => (scope === 'memory' ? `project:${owner}` : scope === 'workspace' ? `workspaceRoot:${owner}` : 'claude');
const scopePrefix = (scope, owner) => (scope === 'claude' ? 'claude/' : `${scope}/${owner}/`);

function parseKey(key) {
  if (typeof key !== 'string') return null;
  const m = /^(memory|workspace)\/([^/]+)\/([\s\S]+)$/.exec(key);
  if (m) {
    const [, scope, owner, rel] = m;
    if (!validKey(owner) || relPathError(rel)) return null;
    return { scope, owner, rel };
  }
  if (key.startsWith('claude/')) {
    const rel = key.slice(7);
    if (relPathError(rel)) return null;
    return { scope: 'claude', owner: null, rel };
  }
  return null;
}

const toAbs = (root, rel) => path.join(root, ...rel.split('/'));

module.exports = {
  platformName, pathApi, caseInsensitive, claudeDir, encodeProjectDir, projectDirNames, samePath, homeRel, slugKey,
  readSessionCwds, decodeProjectDir,
  KEY_RE, validKey, relPathError, windowsNameError, memoryKey, workspaceKey, claudeKey, locationIdOf, scopePrefix, parseKey, toAbs,
};
