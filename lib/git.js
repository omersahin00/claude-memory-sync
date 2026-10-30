'use strict';
const fs = require('fs');
const path = require('path');

// The repository's config folder: '.git' itself, or for worktrees/submodules the folder its '.git' file points to.
function gitConfigDir(dir) {
  const dotgit = path.join(dir, '.git');
  let st;
  try {
    st = fs.statSync(dotgit);
  } catch {
    return null;
  }
  if (st.isDirectory()) return dotgit;
  try {
    const m = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(dotgit, 'utf8'));
    if (!m) return null;
    const gitdir = path.resolve(dir, m[1].trim());
    const common = path.join(gitdir, 'commondir');
    return fs.existsSync(common) ? path.resolve(gitdir, fs.readFileSync(common, 'utf8').trim()) : gitdir;
  } catch {
    return null;
  }
}

const isGitRepo = (dir) => gitConfigDir(dir) !== null;

// URL of the "origin" remote (or the first remote) read from .git/config; git itself is not needed.
function readGitRemote(dir) {
  const g = gitConfigDir(dir);
  if (!g) return null;
  let text;
  try {
    text = fs.readFileSync(path.join(g, 'config'), 'utf8');
  } catch {
    return null;
  }
  let section = null;
  let first = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const sec = /^\[\s*remote\s+"([^"]+)"\s*\]$/.exec(line);
    if (sec) {
      section = sec[1];
      continue;
    }
    if (line.startsWith('[')) {
      section = null;
      continue;
    }
    const kv = section && /^url\s*=\s*(.+)$/.exec(line);
    if (kv) {
      if (section === 'origin') return kv[1].trim();
      if (!first) first = kv[1].trim();
    }
  }
  return first;
}

// Same repository written different ways compares equal:
// git@github.com:a/b.git, https://user@github.com/a/b, ssh://git@github.com:22/a/b  ->  github.com/a/b
function normalizeRemote(url) {
  if (!url) return null;
  let u = String(url).trim().replace(/\/+$/, '').replace(/\.git$/i, '');
  const scp = /^[^@\s/]+@([^:\s/]+):(?!\/)(.+)$/.exec(u);
  if (scp) u = `${scp[1]}/${scp[2]}`;
  else u = u.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/^[^@/]+@/, '').replace(/^([^/:]+):\d+\//, '$1/');
  return u.toLowerCase();
}

module.exports = { gitConfigDir, isGitRepo, readGitRemote, normalizeRemote };
