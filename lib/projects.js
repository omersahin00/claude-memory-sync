'use strict';
const fs = require('fs');
const path = require('path');
const P = require('./paths');
const { readTree } = require('./fsx');
const { readGitRemote, normalizeRemote } = require('./git');

// The Claude desktop app runs sessions that have no folder in scratch folders; their memories rarely mean anything elsewhere.
const SCRATCH_RE = /Claude[\\/-]scratch-workspaces/i;
// The Claude folder of one: …-scratch-workspaces-<account>-<organization>-scratch-<date>-<code>.
const UUID = '[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}';
const SCRATCH_DIR_RE = new RegExp(`scratch-workspaces-(${UUID})-(${UUID})-(scratch-\\d{4}-\\d{2}-\\d{2}-[0-9a-f]+)$`, 'i');

const COMMON_PARENTS = [
  [], ['Desktop'], ['Documents'], ['Documents', 'GitHub'], ['GitHub'], ['source', 'repos'], ['repos'], ['projects'],
  ['code'], ['Developer'], ['dev'], ['OneDrive', 'Desktop'], ['OneDrive', 'Documents'],
];

const knownParents = (home, roots = []) => [...COMMON_PARENTS.map((p) => path.join(home, ...p)), ...roots];

// Display name when the real folder is unknown: the folder name without the longest known parent.
function nameFromDirName(dirName, parents, platform = process.platform) {
  const ci = P.caseInsensitive(platform);
  const name = ci ? dirName.toLowerCase() : dirName;
  let best = 0;
  for (const p of parents) {
    const enc = `${P.encodeProjectDir(p)}-`;
    if (name.startsWith(ci ? enc.toLowerCase() : enc) && enc.length > best) best = enc.length;
  }
  return best ? dirName.slice(best) : dirName.replace(/^-+/, '');
}

// Real folder of a Claude project: session log cwd (or its ancestor) whose encoding is the folder name, then a scratch
// folder of the desktop app (scratchRoot) whose sessions are gone, then for a name cut at 200 characters a folder the
// desktop app's records name (knownPaths: a list, or a function giving it), then a walk of the file system, then any
// session cwd.
function resolveCwd(dirName, dir, { platform = process.platform, cachedPath, scratchRoot, knownPaths } = {}) {
  if (cachedPath && fs.existsSync(cachedPath)) return { cwd: cachedPath, source: 'cache' };
  const api = P.pathApi(platform);
  const ci = P.caseInsensitive(platform);
  const matches = (p) => P.projectDirNames(p).some((n) => (ci ? n.toLowerCase() === dirName.toLowerCase() : n === dirName));
  const cwds = P.readSessionCwds(dir);
  for (const c of cwds) {
    for (let p = c; ; p = api.dirname(p)) {
      if (matches(p)) return { cwd: p, source: 'session' };
      if (api.dirname(p) === p) break;
    }
  }
  const scratch = scratchRoot ? SCRATCH_DIR_RE.exec(dirName) : null;
  if (scratch && matches(api.join(scratchRoot, scratch[1], scratch[2], scratch[3]))) return { cwd: api.join(scratchRoot, scratch[1], scratch[2], scratch[3]), source: 'scratch' };
  // A name Claude Code cut at 200 characters cannot be read back; a folder the desktop app's records name can give it.
  if (dirName.length > 200 && knownPaths) {
    const known = (typeof knownPaths === 'function' ? knownPaths() : knownPaths).find((p) => typeof p === 'string' && matches(p));
    if (known) return { cwd: known, source: SCRATCH_RE.test(known) ? 'scratch' : 'session' };
  }
  const decoded = P.decodeProjectDir(dirName, { platform });
  if (decoded) return { cwd: decoded, source: 'decoded' };
  // A folder that is not there (yet), for example after a full restore under another user name, which already moved the
  // folder this app knew to the new home folder. A chat's folder that does not give this Claude folder name is where
  // the chat ran before, so it comes last.
  if (cachedPath) return { cwd: cachedPath, source: 'cache' };
  if (cwds.length) return { cwd: cwds[0], source: 'session' };
  return { cwd: null, source: null };
}

// Every folder in <Claude folder>/projects, with its memory files and what is known about the real project folder.
function discoverProjects({ claudeDir, home, platform = process.platform, roots = [], cachedPaths = {}, scratchRoot = null, knownPaths = null }) {
  const projectsRoot = path.join(claudeDir, 'projects');
  let dirs = [];
  try {
    dirs = fs.readdirSync(projectsRoot, { withFileTypes: true }).filter((d) => d.isDirectory());
  } catch { /* no projects folder yet */ }
  const parents = knownParents(home, roots);
  const api = P.pathApi(platform);
  return dirs.map((d) => {
    const dir = path.join(projectsRoot, d.name);
    const memoryDir = path.join(dir, 'memory');
    const files = readTree(memoryDir);
    // Projects without memories are walked too: on a new device they are where incoming memories go.
    const { cwd, source } = resolveCwd(d.name, dir, { platform, cachedPath: cachedPaths[d.name], scratchRoot, knownPaths });
    const exists = cwd ? fs.existsSync(cwd) : false;
    const gitRemote = exists ? readGitRemote(cwd) : null;
    let bytes = 0;
    let lastModified = 0;
    for (const f of files.values()) {
      bytes += f.buf.length;
      if (f.mtime > lastModified) lastModified = f.mtime;
    }
    return {
      id: d.name,
      dir,
      memoryDir,
      cwd,
      cwdSource: source,
      exists,
      name: cwd ? api.basename(cwd) || cwd : nameFromDirName(d.name, parents, platform),
      homeRel: cwd ? P.homeRel(cwd, home, platform) : null,
      gitRemote,
      gitId: normalizeRemote(gitRemote),
      isScratch: SCRATCH_RE.test(cwd || d.name),
      files,
      bytes,
      lastModified,
    };
  });
}

const projectDirFor = (claudeDir, folder) => path.join(claudeDir, 'projects', P.encodeProjectDir(folder));

module.exports = { discoverProjects, resolveCwd, nameFromDirName, knownParents, projectDirFor, SCRATCH_RE };
