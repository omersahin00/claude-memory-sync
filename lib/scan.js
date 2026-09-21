'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const P = require('./paths');
const { hashContent, TMP_MARK } = require('./fsx');

const IGNORED = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini']);
const ignoredName = (n) => IGNORED.has(n) || n.includes(TMP_MARK);

// All files in a folder: Map<relative path ('/' separated), { abs, buf, hash }>
function readTree(root) {
  const out = new Map();
  const visit = (dir, parts) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      if (e.code === 'ENOENT') return;
      throw e;
    }
    for (const e of entries) {
      if (ignoredName(e.name)) continue;
      const abs = path.join(dir, e.name);
      const rel = [...parts, e.name];
      if (e.isDirectory()) visit(abs, rel);
      else if (e.isFile()) {
        const buf = fs.readFileSync(abs);
        out.set(rel.join('/'), { abs, buf, hash: hashContent(buf) });
      }
    }
  };
  visit(root, []);
  return out;
}

function gitRemote(repoPath) {
  try {
    const url = execFileSync('git', ['-C', repoPath, 'remote', 'get-url', 'origin'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10000, windowsHide: true,
    }).trim();
    return url || null;
  } catch {
    return null;
  }
}

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

const lastSegment = (p) => p.split(/[\\/]/).filter(Boolean).pop() || '';

function inspectWorkspace(abs, reposRoot, prefix, buf = fs.readFileSync(abs)) {
  const text = buf.toString('utf8');
  const hasPrefix = (n) => n.toLowerCase().startsWith(prefix);
  const warnings = [];
  let folders = null;
  try {
    const json = parseJsonc(text);
    folders = Array.isArray(json.folders) ? json.folders.map((f) => f && f.path).filter((p) => typeof p === 'string') : [];
  } catch (e) {
    if (!text.toLowerCase().includes(prefix)) return null;
    warnings.push(`could not parse JSON (${e.message}); folder paths were not checked`);
    return { buf, hash: hashContent(buf), folders: [], warnings };
  }
  if (!folders.some((p) => hasPrefix(lastSegment(p)))) return null;
  for (const p of folders) {
    if (/^([a-zA-Z]:[\\/]|[\\/])/.test(p)) warnings.push(`absolute path, will not open on another device or OS: ${p}`);
    else {
      if (p.includes('\\')) warnings.push(`backslash (\\) does not work on macOS/Linux: ${p}`);
      const resolved = path.resolve(path.dirname(abs), ...p.split(/[\\/]/));
      const relToRoot = path.relative(reposRoot, resolved);
      if (relToRoot.startsWith('..') || path.isAbsolute(relToRoot)) {
        warnings.push(`points outside the repos folder; it must exist at the same relative location on the target device: ${p}`);
      }
    }
  }
  return { buf, hash: hashContent(buf), folders, warnings };
}

// *.code-workspace files in the repos folder and in its (non-repo) subfolders.
function scanWorkspaces(reposRoot, prefix) {
  const out = new Map();
  const isRepoLike = (dir, name) => name.toLowerCase().startsWith(prefix) || fs.existsSync(path.join(dir, '.git'));
  const take = (abs, rel) => {
    const info = inspectWorkspace(abs, reposRoot, prefix);
    if (info) out.set(rel, { abs, ...info });
  };
  let top;
  try {
    top = fs.readdirSync(reposRoot, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of top) {
    const abs = path.join(reposRoot, e.name);
    if (e.isFile() && e.name.endsWith('.code-workspace')) take(abs, e.name);
    else if (e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules' && !isRepoLike(abs, e.name)) {
      let sub;
      try { sub = fs.readdirSync(abs, { withFileTypes: true }); } catch { continue; }
      for (const s of sub) {
        if (s.isFile() && s.name.endsWith('.code-workspace')) take(path.join(abs, s.name), `${e.name}/${s.name}`);
      }
    }
  }
  return out;
}

function chooseProject(candidates) {
  if (candidates.length <= 1) return { project: candidates[0] || null, ambiguous: false };
  const withMemory = candidates.filter((c) => readTree(path.join(c.dir, 'memory')).size > 0);
  if (withMemory.length === 1) return { project: withMemory[0], ambiguous: false };
  if (withMemory.length === 0) return { project: candidates.find((c) => c.method === 'name') || candidates[0], ambiguous: false };
  return { project: null, ambiguous: true };
}

function attachProject(repo, project) {
  repo.project = project;
  repo.memoryDir = project ? path.join(project.dir, 'memory') : null;
  repo.files = project ? readTree(repo.memoryDir) : new Map();
}

function scanDevice(config, { platform = process.platform, env = process.env } = {}) {
  const claudeDir = P.claudeDir(env);
  const projectsRoot = path.join(claudeDir, 'projects');
  const index = P.createProjectIndex(projectsRoot);
  const prefix = config.prefix.toLowerCase();
  const reposRoot = config.reposRoot;
  const hasPrefix = (n) => n.toLowerCase().startsWith(prefix);

  const makeRepo = (name, repoPath, outsideRoot) => {
    const isGit = fs.existsSync(path.join(repoPath, '.git'));
    const candidates = P.findProjectDirs(repoPath, index, platform);
    const { project, ambiguous } = chooseProject(candidates);
    const repo = { name, path: repoPath, exists: fs.existsSync(repoPath), isGit, outsideRoot, remote: isGit ? gitRemote(repoPath) : null, candidates, ambiguous };
    attachProject(repo, project);
    return repo;
  };

  const repos = new Map();
  let entries = [];
  try { entries = fs.readdirSync(reposRoot, { withFileTypes: true }); } catch { /* no repos folder */ }
  for (const e of entries) {
    if (e.isDirectory() && hasPrefix(e.name) && P.REPO_NAME.test(e.name)) {
      repos.set(e.name, makeRepo(e.name, path.join(reposRoot, e.name), false));
    }
  }

  // Claude projects opened outside the repos folder (prefixed session cwd) that have memories.
  const used = new Set([...repos.values()].flatMap((r) => r.candidates.map((c) => c.dir)));
  const stray = [];
  for (const d of index.dirs) {
    if (used.has(d.dir)) continue;
    for (const cwd of index.cwdsOf(d)) {
      const name = P.pathApi(platform).basename(cwd);
      if (!hasPrefix(name) || !P.REPO_NAME.test(name)) continue;
      const count = readTree(path.join(d.dir, 'memory')).size;
      if (count === 0) continue;
      if (!repos.has(name)) {
        repos.set(name, makeRepo(name, cwd, true));
        used.add(d.dir);
      } else {
        stray.push({ repo: name, dir: d.dir, cwd, count });
      }
      break;
    }
  }

  return {
    platform,
    claudeDir,
    projectsRoot,
    projectsRootExists: fs.existsSync(projectsRoot),
    reposRoot,
    reposRootExists: fs.existsSync(reposRoot),
    prefix: config.prefix,
    repos: [...repos.values()].sort((a, b) => a.name.localeCompare(b.name)),
    stray,
    workspaces: scanWorkspaces(reposRoot, prefix),
  };
}

function findLocalRepo(scan, name) {
  const ci = P.caseInsensitive(scan.platform);
  return scan.repos.find((r) => (ci ? r.name.toLowerCase() === name.toLowerCase() : r.name === name)) || null;
}

module.exports = { readTree, parseJsonc, inspectWorkspace, scanDevice, scanWorkspaces, attachProject, findLocalRepo, gitRemote };
