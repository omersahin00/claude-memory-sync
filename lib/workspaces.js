'use strict';
const fs = require('fs');
const path = require('path');
const { hashContent } = require('./fsx');
const { isGitRepo } = require('./git');

const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'out', 'target', 'vendor', 'bin', 'obj', 'Library', 'AppData']);
const MAX_DEPTH = 3;
const MAX_ENTRIES = 20000;

// VSCode workspace files allow comments and trailing commas (JSONC).
function parseJsonc(text) {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  let noComments = '';
  for (let i = 0, inStr = false; i < src.length; ) {
    const ch = src[i];
    const nx = src[i + 1];
    if (inStr) {
      noComments += ch;
      if (ch === '\\') { noComments += nx === undefined ? '' : nx; i += 2; continue; }
      if (ch === '"') inStr = false;
      i++;
    } else if (ch === '"') { inStr = true; noComments += ch; i++; }
    else if (ch === '/' && nx === '/') { while (i < src.length && src[i] !== '\n') i++; }
    else if (ch === '/' && nx === '*') { i += 2; while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++; i += 2; }
    else { noComments += ch; i++; }
  }
  let out = '';
  for (let i = 0, inStr = false; i < noComments.length; i++) {
    const ch = noComments[i];
    if (inStr) {
      out += ch;
      if (ch === '\\') { out += noComments[++i] || ''; continue; }
      if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; out += ch; continue; }
    if (ch === ',') {
      let j = i + 1;
      while (j < noComments.length && /\s/.test(noComments[j])) j++;
      if (noComments[j] === '}' || noComments[j] === ']') continue;
    }
    out += ch;
  }
  return JSON.parse(out);
}

const ABSOLUTE_RE = /^([a-zA-Z]:[\\/]|[\\/])/;

// Folders of a workspace file as seen on this device, and what will not survive a move to another device.
// Folder warnings: absolute | backslash | outside-root | missing
function inspectWorkspace(abs, root, buf = fs.readFileSync(abs)) {
  const text = buf.toString('utf8');
  let json;
  try {
    json = parseJsonc(text);
  } catch (e) {
    return { parseError: e.message, folders: [], fixable: false, settings: 0, extensions: 0 };
  }
  const folders = [];
  for (const f of Array.isArray(json.folders) ? json.folders : []) {
    if (!f || typeof f !== 'object') continue;
    if (typeof f.uri === 'string' && typeof f.path !== 'string') {
      folders.push({ path: f.uri, name: f.name || null, resolved: null, exists: null, kind: 'uri', isGit: false, warnings: [] });
      continue;
    }
    if (typeof f.path !== 'string') continue;
    const p = f.path;
    const absolute = ABSOLUTE_RE.test(p);
    const resolved = absolute ? p : path.resolve(path.dirname(abs), ...p.split(/[\\/]/));
    const exists = fs.existsSync(resolved);
    const warnings = [];
    if (absolute) warnings.push('absolute');
    if (p.includes('\\')) warnings.push('backslash');
    if (!absolute && root) {
      const rel = path.relative(root, resolved);
      if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) warnings.push('outside-root');
    }
    if (!exists) warnings.push('missing');
    folders.push({ path: p, name: f.name || null, resolved, exists, kind: absolute ? 'absolute' : 'relative', isGit: exists && isGitRepo(resolved), warnings });
  }
  return {
    parseError: null,
    folders,
    fixable: folders.some((f) => f.warnings.includes('absolute') || f.warnings.includes('backslash')),
    settings: json.settings && typeof json.settings === 'object' ? Object.keys(json.settings).length : 0,
    extensions: json.extensions && Array.isArray(json.extensions.recommendations) ? json.extensions.recommendations.length : 0,
  };
}

// *.code-workspace files below a folder (MAX_DEPTH levels); git repositories, hidden and build folders are skipped.
function scanRoot(root, { maxDepth = MAX_DEPTH, maxEntries = MAX_ENTRIES } = {}) {
  const out = new Map();
  let seen = 0;
  const visit = (dir, parts, depth) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (++seen > maxEntries) return;
      const abs = path.join(dir, e.name);
      if (e.isFile() && e.name.endsWith('.code-workspace')) {
        try {
          const buf = fs.readFileSync(abs);
          out.set([...parts, e.name].join('/'), { abs, buf, hash: hashContent(buf), mtime: fs.statSync(abs).mtimeMs });
        } catch { /* unreadable: skip */ }
      } else if (e.isDirectory() && depth < maxDepth && !e.name.startsWith('.') && !SKIP_DIRS.has(e.name) && !isGitRepo(abs)) {
        visit(abs, [...parts, e.name], depth + 1);
      }
    }
  };
  visit(root, [], 0);
  return out;
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Rewrites absolute and backslash folder paths as relative '/' paths (relative to the workspace file),
// so the same file opens on macOS and Windows. Comments and formatting are kept.
function makePortable(text, abs) {
  let json;
  try {
    json = parseJsonc(text);
  } catch {
    return { text, changes: [] };
  }
  let out = text;
  const changes = [];
  for (const f of Array.isArray(json.folders) ? json.folders : []) {
    if (!f || typeof f.path !== 'string') continue;
    let target = f.path;
    if (ABSOLUTE_RE.test(target)) {
      if (!path.isAbsolute(target)) continue; // a path of another operating system
      const rel = path.relative(path.dirname(abs), target);
      if (!rel || path.isAbsolute(rel)) continue; // another drive: cannot be made relative
      target = rel;
    }
    target = target.split(/[\\/]+/).join('/');
    if (target === f.path) continue;
    const re = new RegExp(`("path"\\s*:\\s*)${escapeRe(JSON.stringify(f.path))}`, 'g');
    const next = out.replace(re, (_, lead) => lead + JSON.stringify(target));
    if (next !== out) {
      out = next;
      changes.push({ from: f.path, to: target });
    }
  }
  return { text: out, changes };
}

module.exports = { parseJsonc, inspectWorkspace, scanRoot, makePortable };
