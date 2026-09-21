'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const PLATFORM_NAMES = { darwin: 'macOS', win32: 'Windows', linux: 'Linux' };
const platformName = (p = process.platform) => PLATFORM_NAMES[p] || p;
const pathApi = (platform = process.platform) => (platform === 'win32' ? path.win32 : path.posix);
// macOS (APFS default) and Windows file systems are case-insensitive.
const caseInsensitive = (platform = process.platform) => platform === 'win32' || platform === 'darwin';

function claudeDir(env = process.env) {
  return env.CLAUDE_CONFIG_DIR ? path.resolve(env.CLAUDE_CONFIG_DIR) : path.join(os.homedir(), '.claude');
}

// Claude Code project folder name: every non-alphanumeric character of the absolute path becomes '-'.
// /Users/omer/GitHub/x  -> -Users-omer-GitHub-x
function encodeProjectDir(absPath) {
  return String(absPath).replace(/[^a-zA-Z0-9]/g, '-');
}

function normalizeForCompare(p, platform) {
  let n = pathApi(platform).normalize(p);
  if (n.length > 1) n = n.replace(/[\\/]+$/, '');
  return caseInsensitive(platform) ? n.toLowerCase() : n;
}

function samePath(a, b, platform = process.platform) {
  if (!a || !b) return false;
  return normalizeForCompare(a, platform) === normalizeForCompare(b, platform);
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

function createProjectIndex(projectsRoot) {
  let dirs = [];
  try {
    dirs = fs
      .readdirSync(projectsRoot, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => ({ name: d.name, dir: path.join(projectsRoot, d.name) }));
  } catch { /* no projects folder */ }
  const cache = new Map();
  const cwdsOf = (d) => {
    if (!cache.has(d.dir)) cache.set(d.dir, readSessionCwds(d.dir));
    return cache.get(d.dir);
  };
  return { projectsRoot, dirs, cwdsOf };
}

// Finds the Claude project folders of a repo path.
// method: 'name' (folder name matches exactly), 'session' (session log cwd), 'guess' (name suffix only, single candidate)
function findProjectDirs(repoPath, index, platform = process.platform) {
  const ci = caseInsensitive(platform);
  const eq = (a, b) => (ci ? a.toLowerCase() === b.toLowerCase() : a === b);
  const encoded = encodeProjectDir(repoPath);
  const found = [];
  for (const d of index.dirs) {
    if (eq(d.name, encoded)) found.push({ ...d, method: 'name' });
    else if (index.cwdsOf(d).some((cwd) => samePath(cwd, repoPath, platform))) found.push({ ...d, method: 'session' });
  }
  if (found.length) return found;
  const suffix = '-' + encodeProjectDir(pathApi(platform).basename(repoPath));
  const guesses = index.dirs.filter((d) =>
    ci ? d.name.toLowerCase().endsWith(suffix.toLowerCase()) : d.name.endsWith(suffix)
  );
  return guesses.length === 1 ? [{ ...guesses[0], method: 'guess' }] : [];
}

// ---- Bundle keys ------------------------------------------------------------
// memory/<repo>/<relative path>   |   workspace/<path relative to the repos folder>
const REPO_NAME = /^[A-Za-z0-9._-]+$/;

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

const memoryKey = (repo, rel) => `memory/${repo}/${rel}`;
const workspaceKey = (rel) => `workspace/${rel}`;

function parseKey(key) {
  if (typeof key !== 'string') return null;
  if (key.startsWith('memory/')) {
    const rest = key.slice(7);
    const i = rest.indexOf('/');
    if (i <= 0) return null;
    const repo = rest.slice(0, i);
    const rel = rest.slice(i + 1);
    if (!REPO_NAME.test(repo) || repo === '.' || repo === '..' || relPathError(rel)) return null;
    return { scope: 'memory', repo, rel };
  }
  if (key.startsWith('workspace/')) {
    const rel = key.slice(10);
    if (relPathError(rel)) return null;
    return { scope: 'workspace', rel };
  }
  return null;
}

const toAbs = (root, rel) => path.join(root, ...rel.split('/'));

module.exports = {
  platformName, pathApi, caseInsensitive, claudeDir, encodeProjectDir, samePath,
  readSessionCwds, createProjectIndex, findProjectDirs,
  REPO_NAME, relPathError, windowsNameError, memoryKey, workspaceKey, parseKey, toAbs,
};
