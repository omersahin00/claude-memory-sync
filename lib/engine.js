'use strict';
// Single entry point of the core: the desktop app and the CLI both call this.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const P = require('./paths');
const S = require('./state');
const { readIfExists, hashContent, hashFile, sameFile, moveFile, removeFile } = require('./fsx');
const { discoverProjects, projectDirFor, knownParents } = require('./projects');
const { scanRoot, inspectWorkspace, folderRels, makePortable } = require('./workspaces');
const { readClaudeConfig } = require('./claude-config');
const { buildBundle, writeBundle, writeBundleV3, readBundle, readBundleHeader, statsOf } = require('./bundle');
const C = require('./chats');
const { classify, resolve, union } = require('./plan');
const { applyOps, verifyOps } = require('./apply');
const { lineDiff } = require('./merge');
const { isDailyDue, nextSlot } = require('./schedule');
const { readGitRemote, normalizeRemote } = require('./git');

const APP = { name: 'claude-memory-sync', version: require('../package.json').version };
const KIND_DIRS = { daily: 'daily', before: 'before', manual: 'manual' };
const PREVIEW_LIMIT = 256 * 1024;
const DIFF_LINES = 400;

class EngineError extends Error {
  constructor(code, message, extra) {
    super(message);
    this.code = code;
    if (extra) Object.assign(this, extra);
  }
}

const pad2 = (n) => String(n).padStart(2, '0');
const stamp = (d) => `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}-${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`;
const scopeOfType = (type) => (type === 'project' ? 'memory' : type === 'workspaceRoot' ? 'workspace' : 'claude');
const isDir = (p) => {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
};
const filterMap = (map, keep) => new Map([...map].filter(([k]) => keep(k)));
const isBinary = (buf) => buf.includes(0);
const textOf = (f) => (f && !isBinary(f.buf) ? capText(f.buf.toString('utf8')) : null);
const capText = (s) => (s.length > PREVIEW_LIMIT ? s.slice(0, PREVIEW_LIMIT) : s);
const importId = (b) => `${b.device.id}|${b.createdAt}`;

function uniquePath(abs) {
  if (!fs.existsSync(abs)) return abs;
  const ext = path.extname(abs);
  const stem = abs.slice(0, abs.length - ext.length);
  for (let n = 2; ; n++) {
    const p = `${stem}-${n}${ext}`;
    if (!fs.existsSync(p)) return p;
  }
}

function kindFromName(abs) {
  const name = path.basename(abs);
  if (/^auto-before-/.test(name)) return 'before';
  const m = /-(daily|before|manual)\.memsync$/.exec(name);
  return m ? m[1] : 'export';
}

// .memsync files in a folder and below it, down to depth folders.
function memsyncFiles(dir, depth) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const e of entries) {
    const abs = path.join(dir, e.name);
    if (e.isFile() && e.name.endsWith('.memsync')) out.push(abs);
    else if (e.isDirectory() && depth > 0 && !e.name.startsWith('.')) out.push(...memsyncFiles(abs, depth - 1));
  }
  return out;
}

const realPath = (p) => {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return path.resolve(p);
  }
};

// Status of a file against this device's history: never sent anywhere, changed since, or already shared.
function statusOf(hist, hash) {
  if (!hist) return 'new';
  return hist.has(hash) ? 'synced' : 'changed';
}

function createEngine(opts = {}) {
  const env = opts.env || process.env;
  const platform = opts.platform || process.platform;
  const home = opts.home || os.homedir();
  const hostname = opts.hostname || os.hostname();
  const now = opts.now || (() => new Date());

  let config = null;
  let reg = null;
  let scanCache = null;
  const plans = new Map();
  const bundleCache = new Map();
  const headerCache = new Map();

  const claudeDirPath = () => P.claudeDir(env, home);
  const desktopDirPath = () => C.desktopDir(env, home, platform);
  const ci = (s) => (P.caseInsensitive(platform) ? String(s).toLowerCase() : String(s));
  const samePath = (a, b) => P.samePath(a, b, platform);
  // The real folders behind the paths: a linked folder or another spelling is the same folder.
  const sameFolder = (a, b) => samePath(realPath(a), realPath(b));
  const isUnder = (dir, abs) => {
    const rel = path.relative(ci(realPath(dir)), ci(realPath(abs)));
    return rel !== '' && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
  };
  const invalidate = () => {
    scanCache = null;
  };

  // ---- Settings and state -----------------------------------------------------
  const defaultDeviceName = () => hostname.replace(/\.local$/i, '') || 'device';

  function registry() {
    if (!reg) reg = S.loadRegistry(env);
    return reg;
  }
  const saveRegistry = () => S.saveRegistry(registry(), env);

  function rootKeyFor(abs) {
    const saved = registry().rootKeys[abs];
    if (saved) return saved;
    const rel = P.homeRel(abs, home, platform);
    return P.slugKey(rel === null ? abs : rel === '' ? 'home' : rel, 'folder');
  }

  // Most common parent folder of the projects Claude Code has seen, else a usual repos folder.
  function guessRoots() {
    const counts = new Map();
    for (const p of discoverProjects({ claudeDir: claudeDirPath(), home, platform })) {
      if (!p.cwd || !p.exists || p.isScratch) continue;
      const parent = path.dirname(p.cwd);
      if (samePath(parent, home)) continue;
      counts.set(parent, (counts.get(parent) || 0) + 1);
    }
    const best = [...counts].sort((a, b) => b[1] - a[1])[0];
    if (best && best[1] >= 2) return [best[0]];
    const common = [['Documents', 'GitHub'], ['GitHub'], ['source', 'repos'], ['repos'], ['projects'], ['code'], ['Developer']]
      .map((p) => path.join(home, ...p))
      .find(isDir);
    return common ? [common] : [];
  }

  // 1.x settings (reposRoot, prefix) become 2.x; the old files are kept next to the new ones.
  function migrateV1(raw) {
    const dir = S.stateHome(env);
    for (const f of ['config.json', 'history.json']) {
      const src = path.join(dir, f);
      const dst = path.join(dir, f.replace('.json', '.v1.json'));
      if (fs.existsSync(src) && !fs.existsSync(dst)) fs.copyFileSync(src, dst);
    }
    const cfg = S.normalizeConfig({ deviceId: raw.deviceId, deviceName: raw.deviceName, workspaceRoots: raw.reposRoot ? [raw.reposRoot] : [] });
    const rootKey = raw.reposRoot ? rootKeyFor(raw.reposRoot) : 'repos';
    const hist = new Map();
    for (const [k, v] of S.loadHistory(env)) {
      let nk = k;
      if (k.startsWith('memory/')) {
        const rest = k.slice(7);
        const i = rest.indexOf('/');
        if (i > 0) nk = `memory/${P.slugKey(rest.slice(0, i))}/${rest.slice(i + 1)}`;
      } else if (k.startsWith('workspace/')) {
        nk = `workspace/${rootKey}/${k.slice(10)}`;
      }
      hist.set(nk, union(hist.get(nk), v));
    }
    S.saveHistory(hist, env);
    S.saveConfig(cfg, env);
    S.appendActivity({ id: crypto.randomUUID(), at: now().toISOString(), type: 'migrate', ok: true, from: 1, to: 2 }, env);
    return cfg;
  }

  function settings() {
    if (config) return config;
    const raw = S.loadConfigRaw(env);
    if (raw && S.isV1Config(raw)) config = migrateV1(raw);
    else if (raw) config = S.normalizeConfig(raw);
    else config = S.normalizeConfig({ workspaceRoots: guessRoots() });
    let changed = !raw;
    if (!config.deviceId) {
      config.deviceId = crypto.randomUUID();
      changed = true;
    }
    if (!config.deviceName) {
      config.deviceName = defaultDeviceName();
      changed = true;
    }
    if (changed) S.saveConfig(config, env);
    return config;
  }

  // The backup folder is not here: it changes only through reviewBackupFolder and applyBackupFolder.
  const EDITABLE = ['deviceName', 'workspaceRoots', 'bundleDirs', 'daily', 'keepBefore', 'keepManual', 'includeClaude', 'includeScratch', 'excludedProjects', 'openAtLogin', 'runInBackground', 'language', 'theme', 'backup', 'introSeen'];

  function updateSettings(patch = {}) {
    const cur = settings();
    const next = { ...cur };
    for (const k of EDITABLE) {
      if (!(k in patch)) continue;
      next[k] = k === 'daily' || k === 'backup' ? { ...cur[k], ...patch[k] } : patch[k];
    }
    // Turning the daily backup on or off, from anywhere, answers the first-start question.
    if (patch.daily && 'enabled' in patch.daily) next.daily.ask = false;
    if (typeof next.deviceName !== 'string' || !next.deviceName.trim()) throw new EngineError('INVALID', 'Device name cannot be empty.');
    next.deviceName = next.deviceName.trim();
    const uniqPaths = (list) => {
      const out = [];
      for (const p of (list || []).map((x) => path.resolve(String(x)))) if (!out.some((q) => samePath(q, p))) out.push(p);
      return out;
    };
    next.workspaceRoots = uniqPaths(next.workspaceRoots);
    next.bundleDirs = uniqPaths(next.bundleDirs);
    config = S.normalizeConfig(next);
    S.saveConfig(config, env);
    invalidate();
    return config;
  }

  // ---- First start ------------------------------------------------------------------------
  // macOS asks for permission the first time Desktop, Documents and Downloads are read. Until the window has said why,
  // only the saved settings are read: settings() itself would look for the usual project folders on a first start.
  const PROTECTED_FOLDERS = ['Desktop', 'Documents', 'Downloads'];

  // key: what the explanation is shown for (on macOS an app build, since each build is a new app for its permissions).
  function introStatus(key) {
    const c = S.normalizeConfig(S.loadConfigRaw(env) || {});
    return { done: Boolean(key) && c.introSeen === String(key), language: c.language, theme: c.theme };
  }

  // Desktop, Documents and Downloads: { id, path, state: 'ok' | 'denied' (no permission) | 'missing' }.
  function folderAccess() {
    return PROTECTED_FOLDERS.map((name) => {
      const abs = path.join(home, name);
      try {
        fs.readdirSync(abs);
        return { id: name.toLowerCase(), path: abs, state: 'ok' };
      } catch (e) {
        return { id: name.toLowerCase(), path: abs, state: e.code === 'ENOENT' || e.code === 'ENOTDIR' ? 'missing' : 'denied' };
      }
    });
  }

  // The folders are read for the first time here; on macOS each asks for permission now.
  function completeIntro(key) {
    const access = folderAccess();
    updateSettings({ introSeen: String(key) });
    return access;
  }

  function setProjectIncluded(key, on) {
    const set = new Set(settings().excludedProjects);
    if (on) set.delete(key);
    else set.add(key);
    return updateSettings({ excludedProjects: [...set] });
  }

  const backupRoot = () => settings().backupDir || S.defaultBackupDir(env);
  const isMineId = (id) => id === settings().deviceId || settings().earlierDeviceIds.includes(id);

  function defaultOutDir() {
    return [path.join(home, 'Desktop'), path.join(home, 'OneDrive', 'Desktop')].find(isDir) || home;
  }

  function log(entry) {
    const e = { id: crypto.randomUUID(), at: now().toISOString(), ...entry };
    S.appendActivity(e, env);
    return e;
  }

  // ---- Scanning this device -----------------------------------------------------
  // Keys stay the same once given; new projects get their folder name, made unique.
  function assignKeys(projects, r) {
    let changed = false;
    const used = new Set();
    for (const p of projects) {
      const k = r.projectKeys[p.id];
      if (k && P.validKey(k) && !used.has(k)) {
        p.key = k;
        used.add(k);
      }
    }
    const rest = projects
      .filter((p) => !p.key)
      .sort((a, b) => (b.files.size > 0) - (a.files.size > 0) || a.isScratch - b.isScratch || a.id.localeCompare(b.id));
    for (const p of rest) {
      const base = P.slugKey(p.name);
      let k = base;
      for (let n = 2; used.has(k); n++) k = `${base}-${n}`;
      p.key = k;
      used.add(k);
      if (p.files.size > 0) {
        r.projectKeys[p.id] = k;
        changed = true;
      }
    }
    return changed;
  }

  function scan({ fresh = false } = {}) {
    if (!fresh && scanCache && Date.now() - scanCache.t < 2000) return scanCache.value;
    const cfg = settings();
    const r = registry();
    const claudeDir = claudeDirPath();
    const projects = discoverProjects({ claudeDir, home, platform, roots: cfg.workspaceRoots, cachedPaths: r.projectPaths, scratchRoot: path.join(desktopDirPath(), 'scratch-workspaces') });
    let changed = assignKeys(projects, r);
    for (const p of projects) {
      if (p.cwd && p.cwdSource !== 'cache' && r.projectKeys[p.id] && r.projectPaths[p.id] !== p.cwd) {
        r.projectPaths[p.id] = p.cwd;
        changed = true;
      }
    }
    if (changed) saveRegistry();
    const usedRootKeys = new Set();
    const roots = cfg.workspaceRoots.map((abs) => {
      let key = rootKeyFor(abs);
      for (let n = 2; usedRootKeys.has(key); n++) key = `${rootKeyFor(abs)}-${n}`;
      usedRootKeys.add(key);
      const exists = isDir(abs);
      return { key, abs, name: path.basename(abs) || abs, homeRel: P.homeRel(abs, home, platform), exists, files: exists ? scanRoot(abs) : new Map() };
    });
    const claude = { dir: claudeDir, exists: isDir(claudeDir), files: readClaudeConfig(claudeDir) };
    const value = { claudeDir, projects, roots, claude };
    scanCache = { t: Date.now(), value };
    return value;
  }

  function included(p, selection) {
    if (selection && Array.isArray(selection.projects)) return selection.projects.includes(p.key);
    const cfg = settings();
    if (cfg.excludedProjects.includes(p.key)) return false;
    return !p.isScratch || cfg.includeScratch;
  }

  function counts(files, prefix, hist) {
    const c = { new: 0, changed: 0, synced: 0 };
    for (const [rel, f] of files) c[statusOf(hist.get(prefix + rel), f.hash)]++;
    return c;
  }

  // ---- Views for the UI and the CLI (plain data, no buffers) ------------------------
  function deviceView() {
    const cfg = settings();
    const claudeDir = claudeDirPath();
    return {
      id: cfg.deviceId, name: cfg.deviceName, platform, platformName: P.platformName(platform), hostname, home,
      claudeDir, claudeExists: isDir(claudeDir), stateHome: S.stateHome(env), backupDir: backupRoot(), appVersion: APP.version,
    };
  }

  // The desktop app's names of the scratch folders among the projects (C.scratchTitles), by project id.
  function scratchNames(projects) {
    const out = new Map();
    const scratch = projects.filter((p) => p.isScratch && p.cwd);
    if (!scratch.length) return out;
    const titles = C.scratchTitles(C.desktopRecords(desktopDirPath()));
    for (const p of scratch) {
      for (const [abs, t] of titles) {
        if (samePath(abs, p.cwd)) {
          out.set(p.id, t);
          break;
        }
      }
    }
    return out;
  }

  function projectView(p, hist, names = new Map()) {
    const named = names.get(p.id) || {};
    return {
      id: p.id, key: p.key, name: p.name, title: named.title || null, movedTo: named.movedTo || null, cwd: p.cwd, cwdSource: p.cwdSource, exists: p.exists, homeRel: p.homeRel,
      gitRemote: p.gitRemote, isScratch: p.isScratch, dir: p.dir, memoryDir: p.memoryDir,
      fileCount: p.files.size, bytes: p.bytes, lastModified: p.lastModified || null,
      included: included(p), status: counts(p.files, `memory/${p.key}/`, hist),
    };
  }

  function projects() {
    const s = scan();
    const hist = S.loadHistory(env);
    const names = scratchNames(s.projects);
    return {
      claudeDir: s.claudeDir,
      projects: s.projects
        .filter((p) => p.files.size > 0)
        .map((p) => projectView(p, hist, names))
        .sort((a, b) => a.isScratch - b.isScratch || (b.lastModified || 0) - (a.lastModified || 0)),
      withoutMemory: s.projects.filter((p) => p.files.size === 0).length,
    };
  }

  function findProject(s, id) {
    const p = s.projects.find((x) => x.id === id);
    if (!p) throw new EngineError('NOT_FOUND', `Project not found: ${id}`);
    return p;
  }

  function projectFiles(id) {
    const p = findProject(scan(), id);
    const hist = S.loadHistory(env);
    return [...p.files]
      .sort(([a], [b]) => (a === 'MEMORY.md' ? -1 : b === 'MEMORY.md' ? 1 : a.localeCompare(b)))
      .map(([rel, f]) => ({ rel, path: f.abs, size: f.buf.length, mtime: f.mtime || null, status: statusOf(hist.get(P.memoryKey(p.key, rel)), f.hash), binary: isBinary(f.buf) }));
  }

  // ref: { scope: 'memory', project: id, rel } | { scope: 'workspace', root: key, rel } | { scope: 'claude', rel }
  function readFile(ref) {
    const s = scan();
    let f = null;
    if (ref.scope === 'memory') f = findProject(s, ref.project).files.get(ref.rel);
    else if (ref.scope === 'workspace') f = (s.roots.find((r) => r.key === ref.root) || { files: new Map() }).files.get(ref.rel);
    else if (ref.scope === 'claude') f = s.claude.files.get(ref.rel);
    if (!f) throw new EngineError('NOT_FOUND', `File not found: ${ref.rel}`);
    return { path: f.abs, size: f.buf.length, binary: isBinary(f.buf), text: textOf(f), truncated: f.buf.length > PREVIEW_LIMIT };
  }

  function workspaces() {
    const s = scan();
    const hist = S.loadHistory(env);
    return s.roots.map((r) => ({
      key: r.key, path: r.abs, name: r.name, homeRel: r.homeRel, exists: r.exists,
      files: [...r.files]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([rel, f]) => ({
          rel, path: f.abs, size: f.buf.length, mtime: f.mtime || null,
          status: statusOf(hist.get(P.workspaceKey(r.key, rel)), f.hash),
          ...inspectWorkspace(f.abs, r.abs, f.buf),
        })),
    }));
  }

  function claudeConfig() {
    const s = scan();
    const hist = S.loadHistory(env);
    return {
      dir: s.claude.dir, exists: s.claude.exists, included: settings().includeClaude,
      files: [...s.claude.files]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([rel, f]) => ({ rel, path: f.abs, size: f.buf.length, mtime: f.mtime || null, status: statusOf(hist.get(P.claudeKey(rel)), f.hash) })),
    };
  }

  // ---- Collecting this device into a bundle -------------------------------------------
  // forExport: only what is selected for another device, and scopes that suddenly look empty are left out
  // (an accidentally emptied folder must not turn into a mass delete on the other device).
  // Backups always take everything.
  // chats: null (none), 'all' (full backups), a Set of chat ids (bundles) or (project, chat) => boolean (backups). A
  // project whose chats are in the bundle is in it even when its memory is not: { memory: false } carries neither its
  // memory files nor their history, so the other device leaves its memory alone.
  // pick (daily and manual backups): what the backup settings leave in, see backupPick; null takes everything.
  function collect(s, hist, { forExport = false, selection = null, chats = null, pick = null } = {}) {
    const cfg = settings();
    const files = new Map();
    const locations = {};
    const warnings = [];
    const localHistory = new Map([...hist].map(([k, v]) => [k, new Set(v)]));
    const note = (key, f) => {
      files.set(key, f);
      if (!localHistory.has(key)) localHistory.set(key, new Set());
      localHistory.get(key).add(f.hash);
    };
    const hadHistory = (prefix) => {
      for (const k of hist.keys()) if (k.startsWith(prefix)) return true;
      return false;
    };
    // true: include the scope; false: skip it
    const keepScope = (size, prefix, warning) => {
      if (size > 0) return true;
      if (!hadHistory(prefix)) return false;
      if (forExport) {
        warnings.push(warning);
        return false;
      }
      return true;
    };

    const chatSessions = {};
    const chatFiles = [];
    let desktop = null;
    let groups = null;
    let prompts = null;
    let names = null;
    const titleOf = (p) => {
      if (!p.isScratch) return null;
      if (!names) names = scratchNames(s.projects);
      return (names.get(p.id) || {}).title || null;
    };
    const wantChat = chats === 'all' ? () => true : chats instanceof Set ? (p, c) => chats.has(c.id) : typeof chats === 'function' ? chats : null;
    for (const p of s.projects) {
      const prefix = `memory/${p.key}/`;
      const picked = wantChat ? C.listChats(p.dir).filter((c) => wantChat(p, c)) : [];
      // A chat always goes with its project's memory: Claude reads the memory of the folder the chat runs in.
      const memory = (picked.length > 0 || (forExport ? included(p, selection) : !pick || pick.project(p))) && keepScope(p.files.size, prefix, { code: 'empty-memory', name: p.name, key: p.key });
      if (!memory && !picked.length) continue;
      const title = titleOf(p);
      locations[`project:${p.key}`] = {
        type: 'project', key: p.key, name: p.name, path: p.cwd, homeRel: p.homeRel, gitRemote: p.gitRemote, claudeDir: p.id, scratch: p.isScratch,
        ...(title ? { title } : {}),
        ...(memory ? {} : { memory: false }),
      };
      if (memory) for (const [rel, f] of p.files) note(prefix + rel, f);
      if (picked.length && !desktop) {
        desktop = C.desktopRecords(desktopDirPath());
        groups = C.chatGroups(desktop, C.desktopGroups(desktopDirPath()));
        prompts = C.promptLines(claudeDirPath());
      }
      for (const c of picked) {
        const info = C.chatInfo(p.dir, c.id);
        const d = desktop.get(c.id) || null;
        const g = d && groups.get(c.id);
        chatSessions[c.id] = {
          project: p.key, title: (d && d.record.title) || info.title || null, prompt: info.prompt, entrypoint: info.entrypoint || (d ? 'claude-desktop' : null),
          size: c.size, mtime: Math.round(c.mtime), prompts: prompts.get(c.id) || [], desktop: d,
          // The sidebar group the session is in, set up again on the other device.
          ...(g && g.own ? { group: { id: g.id, name: g.name } } : {}),
        };
        for (const [part, abs] of C.chatParts(claudeDirPath(), p.dir, c.id)) chatFiles.push({ part, abs });
      }
    }

    const wantRoots = selection && Array.isArray(selection.workspaces) ? new Set(selection.workspaces) : null;
    // Workspace files left out one by one ({ [root key]: [rel] }): neither the file nor its history goes into the bundle,
    // and the location lists them as skipped, so the other device keeps its own copy instead of reading a delete.
    const skipList = (key) => {
      if (pick) return pick.skipFiles(key);
      return forExport && selection && selection.skipWorkspaceFiles && Array.isArray(selection.skipWorkspaceFiles[key]) ? selection.skipWorkspaceFiles[key] : [];
    };
    const skippedKeys = new Set();
    for (const r of s.roots) {
      if (!r.exists || (forExport && wantRoots && !wantRoots.has(r.key)) || (pick && !pick.root(r))) continue;
      const prefix = `workspace/${r.key}/`;
      const skip = new Set(skipList(r.key));
      const skipped = [...r.files.keys()].filter((rel) => skip.has(rel)).sort();
      if (skipped.length && skipped.length === r.files.size) continue;
      if (!keepScope(r.files.size, prefix, { code: 'empty-workspaces', path: r.abs })) continue;
      locations[`workspaceRoot:${r.key}`] = { type: 'workspaceRoot', key: r.key, name: r.name, path: r.abs, homeRel: r.homeRel, ...(skipped.length ? { skipped } : {}) };
      for (const [rel, f] of r.files) {
        if (skip.has(rel)) skippedKeys.add(prefix + rel);
        else note(prefix + rel, f);
      }
    }

    const wantClaude = forExport ? (selection && typeof selection.claude === 'boolean' ? selection.claude : cfg.includeClaude) : !pick || pick.claude;
    if (wantClaude && s.claude.exists && keepScope(s.claude.files.size, 'claude/', { code: 'empty-claude' })) {
      locations.claude = { type: 'claude', key: 'claude', name: 'Claude', path: s.claude.dir };
      for (const [rel, f] of s.claude.files) note(`claude/${rel}`, f);
    }

    const bundleHistory = new Map();
    for (const [k, v] of localHistory) {
      const pk = P.parseKey(k);
      const loc = pk && locations[P.locationIdOf(pk.scope, pk.owner)];
      if (loc && loc.memory !== false && !skippedKeys.has(k)) bundleHistory.set(k, v);
    }
    return { files, locations, bundleHistory, localHistory, warnings, chats: chatFiles.length ? chatSessions : null, chatFiles };
  }

  // full (full backups): app files, { buf } kept in the header, { abs } (earlier backups) as parts of the file.
  function writeCollected(col, abs, kind, full = null) {
    const cfg = settings();
    const inline = full ? new Map([...full].filter(([, f]) => f.buf)) : null;
    const fullParts = full ? [...full].filter(([, f]) => !f.buf).map(([rel, f]) => ({ rel, abs: f.abs })) : [];
    const bundle = buildBundle({
      kind, app: APP, device: { id: cfg.deviceId, name: cfg.deviceName, platform, hostname, home },
      locations: col.locations, files: col.files, history: col.bundleHistory, full: inline, chats: col.chats, createdAt: now(),
    });
    const size = col.chats || fullParts.length ? writeBundleV3(abs, bundle, col.chatFiles, fullParts) : writeBundle(abs, bundle);
    headerCache.delete(abs);
    return { size, stats: bundle.stats };
  }

  const fingerprint = (col) => {
    const h = crypto.createHash('sha256');
    for (const key of [...col.files.keys()].sort()) h.update(`${key}\0${col.files.get(key).hash}\n`);
    for (const id of Object.keys(col.locations).sort()) h.update(`${id}\n`);
    // Chats by size and time of the last change: hashing hundreds of MB for every daily run would be slow.
    for (const f of [...col.chatFiles].sort((a, b) => (a.part < b.part ? -1 : a.part > b.part ? 1 : 0))) {
      let st = null;
      try {
        st = fs.statSync(f.abs);
      } catch { /* gone meanwhile */ }
      h.update(`${f.part}\0${st ? `${st.size}\0${Math.round(st.mtimeMs)}` : '-'}\n`);
    }
    return h.digest('hex');
  };

  function prune(kind) {
    const cfg = settings();
    const keep = kind === 'daily' ? cfg.daily.keep : kind === 'before' ? cfg.keepBefore : cfg.keepManual;
    if (!keep) return [];
    const dir = path.join(backupRoot(), KIND_DIRS[kind]);
    let names;
    try {
      names = fs.readdirSync(dir).filter((f) => f.endsWith(`-${kind}.memsync`)).sort();
    } catch {
      return [];
    }
    // The folder can be shared: only this device's backups count and go. A file that cannot be read is left alone.
    names = names.filter((f) => isOwnBackup(path.join(dir, f)));
    const extra = names.slice(0, Math.max(0, names.length - keep));
    for (const f of extra) {
      try {
        fs.unlinkSync(path.join(dir, f));
      } catch { /* best effort */ }
    }
    return extra;
  }

  // kind: 'manual' | 'daily' | 'before'. A daily backup with nothing changed since the last one is not written again.
  // Daily and manual backups take what Settings → Backup contents leaves in. Before-operation backups always take every
  // memory, workspace file and Claude setting, so undo and rollback have every file an operation can touch; chats are
  // never in them, since nothing shortens or deletes a chat.
  function backupPick(b = settings().backup) {
    const noProjects = new Set(b.excludeProjects);
    const noRoots = new Set(b.excludeRoots);
    const chatProjects = new Set(b.chatProjects);
    const chatIds = new Set(b.chatIds);
    const chatGroups = new Set(b.chatGroups);
    // A group of the desktop app's sidebar takes the chats in it when the backup is made, new ones too.
    let groupOf = null;
    const inGroup = (c) => {
      if (!chatGroups.size) return false;
      if (!groupOf) groupOf = C.chatGroups(C.desktopRecords(desktopDirPath()), C.desktopGroups(desktopDirPath()));
      const g = groupOf.get(c.id);
      return Boolean(g && chatGroups.has(g.id));
    };
    return {
      project: (p) => !noProjects.has(p.key),
      root: (r) => !noRoots.has(r.key),
      skipFiles: (key) => b.excludeWorkspaceFiles[key] || [],
      claude: b.claude,
      chats: b.chats === 'all' ? 'all' : b.chats === 'some' ? (p, c) => chatProjects.has(p.key) || chatIds.has(c.id) || inGroup(c) : null,
    };
  }

  // What daily and manual backups take with the given backup settings (the saved ones when none are given).
  function backupPreview(draft = null) {
    const pick = backupPick(draft ? S.normalizeBackup(draft) : settings().backup);
    const col = collect(scan({ fresh: true }), S.loadHistory(env), { forExport: false, pick, chats: pick.chats });
    let bytes = 0;
    for (const f of col.files.values()) bytes += f.buf.length;
    return {
      stats: statsOf(col.locations, col.files), files: col.files.size, bytes, locations: Object.keys(col.locations).length,
      chats: { count: col.chats ? Object.keys(col.chats).length : 0, bytes: chatBytes(col) },
    };
  }

  // A folder chosen by hand can be on a disk that is not plugged in. It is not made again: that fails, or where a disk is
  // mounted in an ordinary folder it puts the backups on the computer's own disk. The default folder is made when needed.
  function requireBackupFolder() {
    const dir = settings().backupDir;
    if (dir && !isDir(dir)) throw new EngineError('BACKUP_DIR_MISSING', `The backup folder cannot be reached: ${dir}`, { path: dir });
  }

  function createBackup(kind = 'manual', { reason = null, dedupe = false } = {}) {
    if (!KIND_DIRS[kind]) throw new EngineError('INVALID', `Unknown backup kind: ${kind}`);
    requireBackupFolder();
    const s = scan({ fresh: true });
    const pick = kind === 'before' ? null : backupPick();
    const col = collect(s, S.loadHistory(env), { forExport: false, pick, chats: pick && pick.chats });
    const r = registry();
    const fp = fingerprint(col);
    // A last backup left behind in another folder does not count: the backup folder gets its own.
    if (dedupe && r.lastDaily && r.lastDaily.fingerprint === fp && r.lastDaily.path && fs.existsSync(r.lastDaily.path) && isUnder(backupRoot(), r.lastDaily.path)) {
      r.lastDaily = { ...r.lastDaily, at: now().toISOString(), unchanged: true };
      saveRegistry();
      // In the history too, so the run shows although it wrote no new file.
      const entry = log({ type: 'backup', ok: true, kind, unchanged: true, path: r.lastDaily.path });
      return { kind, skipped: true, path: r.lastDaily.path, activityId: entry.id };
    }
    const abs = uniquePath(path.join(backupRoot(), KIND_DIRS[kind], `${stamp(now())}-${kind}.memsync`));
    let written;
    try {
      written = writeCollected(col, abs, kind);
    } catch (e) {
      // The disk was removed while the file was being written.
      requireBackupFolder();
      throw e;
    }
    const { size, stats } = written;
    if (kind === 'daily') {
      r.lastDaily = { at: now().toISOString(), fingerprint: fp, path: abs, unchanged: false };
      saveRegistry();
    }
    const pruned = prune(kind);
    const chats = col.chats ? Object.keys(col.chats).length : 0;
    const result = { kind, path: abs, size, stats, chats, pruned: pruned.length };
    if (kind !== 'before') result.activityId = log({ type: 'backup', ok: true, kind, reason, path: abs, size, stats, chats: chats || undefined }).id;
    return result;
  }

  function dailyStatus() {
    const cfg = settings();
    const last = registry().lastDaily;
    const due = cfg.daily.enabled && isDailyDue({ time: cfg.daily.time, lastAt: last && last.at, now: now() });
    return {
      ...cfg.daily, due, lastAt: last ? last.at : null, lastPath: last ? last.path : null, lastUnchanged: Boolean(last && last.unchanged),
      nextAt: cfg.daily.enabled ? (due ? now() : nextSlot(cfg.daily.time, now())).toISOString() : null,
    };
  }

  function runDailyIfDue() {
    const st = dailyStatus();
    if (!st.enabled || !st.due) return { due: false };
    return { due: true, ...createBackup('daily', { dedupe: true }) };
  }

  const chosenChats = (selection) => (selection && Array.isArray(selection.chats) && selection.chats.length ? new Set(selection.chats) : null);
  const chatBytes = (col) => col.chatFiles.reduce((n, f) => {
    try {
      return n + fs.statSync(f.abs).size;
    } catch {
      return n;
    }
  }, 0);

  function exportPreview(selection = null) {
    const s = scan({ fresh: true });
    const col = collect(s, S.loadHistory(env), { forExport: true, selection, chats: chosenChats(selection) });
    const per = new Map();
    for (const [key, f] of col.files) {
      const pk = P.parseKey(key);
      const id = P.locationIdOf(pk.scope, pk.owner);
      const c = per.get(id) || { files: 0, bytes: 0 };
      c.files++;
      c.bytes += f.buf.length;
      per.set(id, c);
    }
    return {
      outDir: defaultOutDir(),
      fileName: `claude-memory-${P.slugKey(settings().deviceName, 'device')}-${stamp(now())}.memsync`,
      locations: Object.entries(col.locations).map(([id, loc]) => ({ id, ...loc, ...(per.get(id) || { files: 0, bytes: 0 }) })),
      files: col.files.size,
      chats: { count: col.chats ? Object.keys(col.chats).length : 0, bytes: chatBytes(col) },
      warnings: col.warnings,
    };
  }

  function exportBundle({ outDir = null, selection = null } = {}) {
    const s = scan({ fresh: true });
    const hist = S.loadHistory(env);
    const col = collect(s, hist, { forExport: true, selection, chats: chosenChats(selection) });
    if (!Object.keys(col.locations).length) throw new EngineError('EMPTY_EXPORT', 'Nothing was selected for the bundle.');
    const dir = outDir ? path.resolve(outDir) : defaultOutDir();
    const abs = uniquePath(path.join(dir, `claude-memory-${P.slugKey(settings().deviceName, 'device')}-${stamp(now())}.memsync`));
    const { size, stats } = writeCollected(col, abs, 'export');
    S.saveHistory(col.localHistory, env);
    const chats = col.chats ? Object.keys(col.chats).length : 0;
    const entry = log({ type: 'export', ok: true, path: abs, size, stats, chats: chats || undefined, warnings: col.warnings });
    invalidate();
    return { path: abs, size, stats, chats, warnings: col.warnings, activityId: entry.id };
  }

  // ---- Full backup: everything of this device, for after a reset ---------------------------
  // All memories, workspace files and Claude settings, plus the app's own data: settings, version history, matches,
  // activity log and every backup taken so far. Restored on the same system, everything goes back where it was and the
  // app continues as if the computer had never been reset.
  const STATE_FILE = /^[\w-][\w.-]*\.jsonl?$/;
  const jsonLines = (text) => text.split('\n').filter(Boolean).flatMap((l) => {
    try {
      return [JSON.parse(l)];
    } catch {
      return [];
    }
  });
  const fullFileName = () => `claude-memory-full-${P.slugKey(settings().deviceName, 'device')}-${stamp(now())}.memsync`;

  // 'state/<file>' -> { buf }, 'backups/<kind>/<file>' -> { abs, size } (read only while the full backup is written)
  function appFiles() {
    const out = new Map();
    const dir = S.stateHome(env);
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch { /* no app data yet */ }
    for (const e of entries) if (e.isFile() && STATE_FILE.test(e.name)) out.set(`state/${e.name}`, { buf: fs.readFileSync(path.join(dir, e.name)) });
    for (const root of [backupRoot(), S.defaultBackupDir(env), ...settings().formerBackupDirs]) {
      for (const kind of Object.values(KIND_DIRS)) {
        let names = [];
        try {
          names = fs.readdirSync(path.join(root, kind)).filter((n) => n.endsWith('.memsync')).sort();
        } catch {
          continue;
        }
        for (const name of names) {
          const rel = `backups/${kind}/${name}`;
          const abs = path.join(root, kind, name);
          // Another device's backups in a shared folder are not this device's data.
          const { header } = headerEntry(abs);
          if (!out.has(rel) && (!header || isMineId(header.device.id))) out.set(rel, { abs, size: fs.statSync(abs).size });
        }
      }
    }
    return out;
  }

  function fullBackupPreview() {
    const col = collect(scan({ fresh: true }), S.loadHistory(env), { forExport: false, chats: 'all' });
    const backups = [...appFiles()].filter(([rel]) => rel.startsWith('backups/'));
    return {
      outDir: defaultOutDir(),
      fileName: fullFileName(),
      stats: statsOf(col.locations, col.files),
      backups: { count: backups.length, bytes: backups.reduce((n, [, f]) => n + f.size, 0) },
      activity: S.readActivity(env, Infinity).length,
      chats: { count: col.chats ? Object.keys(col.chats).length : 0, bytes: chatBytes(col) },
    };
  }

  function createFullBackup({ outDir = null } = {}) {
    const col = collect(scan({ fresh: true }), S.loadHistory(env), { forExport: false, chats: 'all' });
    const full = appFiles();
    const abs = uniquePath(path.join(outDir ? path.resolve(outDir) : defaultOutDir(), fullFileName()));
    const { size, stats } = writeCollected(col, abs, 'full', full);
    const backups = [...full.keys()].filter((rel) => rel.startsWith('backups/')).length;
    const chats = col.chats ? Object.keys(col.chats).length : 0;
    const entry = log({ type: 'full-backup', ok: true, path: abs, size, stats, backups, chats });
    return { path: abs, size, stats, backups, chats, activityId: entry.id };
  }

  // Paths of a full backup taken under another home folder (another user name) are moved to this one. Claude project
  // folder names spell the path out (-Users-old-code-x), so they follow too.
  function homeMapper(fromHome) {
    if (!fromHome || samePath(fromHome, home)) return (s) => s;
    const { sep } = P.pathApi(platform);
    const encFrom = P.encodeProjectDir(fromHome);
    const encTo = P.encodeProjectDir(home);
    return (s) => {
      if (typeof s !== 'string') return s;
      let out = s;
      if (samePath(out, fromHome)) out = home;
      else if (ci(out).startsWith(ci(fromHome + sep))) out = home + out.slice(fromHome.length);
      return out.split(sep).map((seg) => (seg === encFrom || seg.startsWith(`${encFrom}-`) ? encTo + seg.slice(encFrom.length) : seg)).join(sep);
    };
  }
  const remapDeep = (v, map) => {
    if (typeof v === 'string') return map(v);
    if (Array.isArray(v)) return v.map((x) => remapDeep(x, map));
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [map(k), remapDeep(x, map)]));
    return v;
  };

  // Memory, workspace and Claude settings files of a full backup, each to where it was. Workspace folders outside the
  // home folder and anything that is not a .code-workspace file there are not written.
  function fullFileOps(b, map) {
    const claudeDir = claudeDirPath();
    const groups = [];
    const ops = [];
    for (const [id, loc] of Object.entries(b.locations).sort(([a], [c]) => a.localeCompare(c))) {
      let root = null;
      if (loc.type === 'project') {
        const folder = loc.claudeDir ? map(loc.claudeDir) : null;
        if (folder && !/[\\/]/.test(folder) && folder !== '.' && folder !== '..') root = path.join(claudeDir, 'projects', folder, 'memory');
      } else if (loc.type === 'workspaceRoot') {
        const abs = loc.path ? map(loc.path) : null;
        if (abs && P.homeRel(abs, home, platform) !== null) root = abs;
      } else {
        root = claudeDir;
      }
      const g = { id, type: loc.type, name: loc.name || loc.key, root, new: 0, replace: 0, same: 0 };
      groups.push(g);
      if (!root) continue;
      const prefix = P.scopePrefix(scopeOfType(loc.type), loc.key);
      for (const [key, f] of b.files) {
        if (!key.startsWith(prefix)) continue;
        const rel = key.slice(prefix.length);
        if (loc.type === 'workspaceRoot' && !rel.endsWith('.code-workspace')) continue;
        const abs = P.toAbs(root, rel);
        const cur = readIfExists(abs);
        const status = !cur ? 'new' : cur.equals(f.buf) ? 'same' : 'replace';
        g[status]++;
        if (status !== 'same') ops.push({ type: 'write', abs, buf: f.buf, key, rel });
      }
    }
    return { groups, ops };
  }

  // The app's own files, merged with what this device has now: settings, matches and the backup folder come from the
  // backup; version history and activity log keep the entries of both; other files are only added when missing.
  function fullStateOps(b, map) {
    const dir = S.stateHome(env);
    const ops = [];
    const warnings = [];
    let backupDir = S.defaultBackupDir(env);
    const json = (buf) => JSON.parse(buf.toString('utf8'));
    const write = (name, text) => ops.push({ type: 'write', abs: path.join(dir, name), buf: Buffer.from(text, 'utf8'), rel: `state/${name}` });
    for (const [rel, f] of b.full) {
      if (!rel.startsWith('state/')) continue;
      const name = rel.slice('state/'.length);
      if (name === 'config.json') {
        const cfg = S.normalizeConfig(remapDeep(json(f.buf), map));
        if (cfg.backupDir && !isDir(path.dirname(cfg.backupDir))) {
          warnings.push({ code: 'backup-dir', path: cfg.backupDir });
          cfg.backupDir = null;
        }
        if (cfg.backupDir) backupDir = cfg.backupDir;
        write(name, JSON.stringify(cfg, null, 2) + '\n');
      } else if (name === 'history.json') {
        const merged = S.loadHistory(env);
        for (const [k, arr] of Object.entries(json(f.buf).keys || {})) {
          if (!merged.has(k)) merged.set(k, new Set());
          for (const h of arr) merged.get(k).add(h);
        }
        const keys = {};
        for (const k of [...merged.keys()].sort()) if (merged.get(k).size) keys[k] = [...merged.get(k)];
        write(name, JSON.stringify({ version: 1, keys }, null, 2) + '\n');
      } else if (name === 'state.json') {
        const restored = remapDeep(json(f.buf), map) || {};
        const cur = S.loadRegistry(env);
        const merged = { ...cur, ...restored };
        for (const field of ['projectKeys', 'projectPaths', 'rootKeys', 'imported']) merged[field] = { ...cur[field], ...(restored[field] || {}) };
        merged.links = { project: { ...cur.links.project, ...((restored.links || {}).project || {}) }, root: { ...cur.links.root, ...((restored.links || {}).root || {}) } };
        // Keys stay unique: a key this device gave to another folder in the meantime goes to the backup's folder.
        const used = new Set(Object.values(restored.projectKeys || {}));
        for (const [folder, k] of Object.entries(cur.projectKeys)) if (!(restored.projectKeys || {})[folder] && used.has(k)) delete merged.projectKeys[folder];
        write(name, JSON.stringify(merged, null, 2) + '\n');
      } else if (name === 'activity.jsonl') {
        const byId = new Map();
        let current = '';
        try {
          current = fs.readFileSync(S.activityPath(env), 'utf8');
        } catch { /* none yet */ }
        for (const e of [...jsonLines(f.buf.toString('utf8')).map((x) => remapDeep(x, map)), ...jsonLines(current)]) if (e && e.id) byId.set(e.id, e);
        const all = [...byId.values()].sort((x, y) => String(x.at).localeCompare(String(y.at)));
        write(name, all.map((e) => JSON.stringify(e)).join('\n') + (all.length ? '\n' : ''));
      } else if (!fs.existsSync(path.join(dir, name))) {
        ops.push({ type: 'write', abs: path.join(dir, name), buf: f.buf, rel });
      }
    }
    return { ops, warnings, backupDir };
  }

  // Backups go into the backup folder; one with the same name and other content is kept under a new name. Those kept as
  // parts of the full backup (version 4) are read from it only while they are written.
  function fullBackupOps(b, backupDir) {
    const ops = [];
    let same = 0;
    for (const [rel, f] of b.full) {
      if (!rel.startsWith('backups/')) continue;
      const [, kind, name] = rel.split('/');
      let abs = path.join(backupDir, kind, name);
      let size = -1;
      try {
        size = fs.statSync(abs).size;
      } catch { /* not there */ }
      if (size === f.size && C.rawHash(readIfExists(abs)) === f.hash) {
        same++;
        continue;
      }
      if (size >= 0) abs = uniquePath(abs);
      ops.push({ type: 'write', abs, rel, ...(f.buf ? { buf: f.buf } : { load: f.load }) });
    }
    return { ops, same };
  }

  const fullPlans = new Map();

  function prepareFullRestore(abs) {
    const b = loadBundle(abs);
    if (b.kind !== 'full' || !b.full) throw new EngineError('NOT_FULL', 'This bundle is not a full backup.');
    if (b.device.platform !== platform) throw new EngineError('FULL_PLATFORM', 'This full backup was taken on another operating system.');
    const map = homeMapper(b.device.home);
    const files = fullFileOps(b, map);
    const state = fullStateOps(b, map);
    const backups = fullBackupOps(b, state.backupDir);
    const chats = fullChats(b, map);
    const id = crypto.randomUUID();
    fullPlans.set(id, { id, bundle: b, map });
    while (fullPlans.size > 5) fullPlans.delete(fullPlans.keys().next().value);
    const sum = (k) => files.groups.reduce((n, g) => n + g[k], 0);
    return {
      id,
      bundle: bundleView(b),
      homeFrom: b.device.home || null,
      homeTo: home,
      remapped: Boolean(b.device.home && !samePath(b.device.home, home)),
      groups: files.groups,
      counts: { new: sum('new'), replace: sum('replace'), same: sum('same') },
      state: state.ops.map((op) => op.rel.slice('state/'.length)),
      backups: { add: backups.ops.length, same: backups.same, dir: state.backupDir },
      activity: b.full.has('state/activity.jsonl') ? jsonLines(b.full.get('state/activity.jsonl').buf.toString('utf8')).length : 0,
      chats: Object.fromEntries(['new', 'updated', 'diverged', 'same', 'local-newer'].map((k) => [k, chats.filter((c) => c.status === k).length])),
      warnings: state.warnings,
    };
  }

  // The chats of a full backup, each to the Claude project folder it was in.
  function fullChats(b, map) {
    if (!b.chats) return [];
    const out = [];
    for (const [id, meta] of b.chats.sessions) {
      const loc = b.locations[`project:${meta.project}`];
      const folder = loc && loc.claudeDir ? map(loc.claudeDir) : null;
      if (!folder || /[\\/]/.test(folder) || folder === '.' || folder === '..') continue;
      const projectDir = path.join(claudeDirPath(), 'projects', folder);
      out.push({ id, meta, scope: `project:${meta.project}`, label: loc.title || loc.name || loc.key, projectDir, projectPath: loc.path ? map(loc.path) : null, scratch: Boolean(loc.scratch), ...chatStatus(b, id, projectDir) });
    }
    return out;
  }

  function applyFullRestore(id) {
    const plan = fullPlans.get(id);
    if (!plan) throw new EngineError('PLAN_EXPIRED', 'This plan is no longer available. Open the bundle again.');
    const b = plan.bundle;
    const backup = createBackup('before', { reason: 'full-restore' });
    // Worked out again now, so nothing written since the review (a daily backup, a log line) is lost.
    const files = fullFileOps(b, plan.map);
    const state = fullStateOps(b, plan.map);
    const backups = fullBackupOps(b, state.backupDir);
    const all = fullChats(b, plan.map);
    const chats = all.filter((c) => chatChoice(c, null) === 'take');
    const writes = chatOps(b, chats, b.device.name);
    const desk = desktopGroupOps(all, writes);
    const ops = [...files.ops, ...backups.ops, ...state.ops, ...writes, ...desk.ops];
    const fail = (code, message, extra) => {
      log({ type: 'full-restore', ok: false, error: message, bundle: bundleRef(b), backupPath: backup.path, ...extra });
      invalidate();
      return new EngineError(code, message, { backupPath: backup.path, ...extra });
    };
    try {
      applyOps(ops);
    } catch (e) {
      throw fail('APPLY_FAILED', e.message, { rolledBack: e.rolledBack, rollbackErrors: e.rollbackErrors });
    }
    const problems = verifyOps(ops);
    if (problems.length) throw fail('VERIFY_FAILED', 'Verification failed after writing.', { problems });
    if (desk.ops.length) keepDesktopCopies();
    // A backup folder that came back without any backups: without it, the next backup would take its disk for removed.
    try {
      fs.mkdirSync(state.backupDir, { recursive: true });
    } catch { /* the next backup says so */ }
    // The app's own data was replaced: read it again.
    config = null;
    reg = null;
    invalidate();
    plans.clear();
    fullPlans.clear();
    bundleCache.clear();
    headerCache.clear();
    const groups = desk.groups || undefined;
    const entry = log({ type: 'full-restore', ok: true, bundle: bundleRef(b), backupPath: backup.path, writes: files.ops.length, backups: backups.ops.length, chats: chats.length, groups });
    return { activityId: entry.id, backupPath: backup.path, writes: files.ops.length, backups: backups.ops.length, chats: chats.length, groups: groups || null, verified: true };
  }

  // ---- Chats -----------------------------------------------------------------------------------
  // A chat goes where its project goes: <project folder>/<id>.jsonl and the rest next to it (see chats.js). Nothing of a
  // chat on this device is overwritten with something shorter or deleted: a chat that is new here is added, one
  // continued on the other device (this device has its beginning) is brought up to date, and one continued on both
  // devices is added next to this one under a new id.

  // Chats of this device by project, newest first, for choosing what goes into a bundle.
  // Each chat with the group it is in in the desktop app's sidebar (side chats and earlier parts with their session).
  function chatList() {
    const s = scan();
    const desktop = C.desktopRecords(desktopDirPath());
    const groups = C.chatGroups(desktop, C.desktopGroups(desktopDirPath()));
    const names = scratchNames(s.projects);
    return s.projects
      .map((p) => ({
        key: p.key, name: p.name, title: (names.get(p.id) || {}).title || null, movedTo: (names.get(p.id) || {}).movedTo || null,
        path: p.cwd, isScratch: p.isScratch, hasMemory: p.files.size > 0, fileCount: p.files.size,
        chats: C.listChats(p.dir)
          .map((c) => {
            const info = C.chatInfo(p.dir, c.id);
            const d = desktop.get(c.id);
            const g = groups.get(c.id);
            return {
              id: c.id, title: (d && d.record.title) || info.title || info.prompt || null, entrypoint: info.entrypoint || (d ? 'claude-desktop' : null), size: c.size, mtime: c.mtime,
              group: g ? { id: g.id, name: g.name } : null,
            };
          })
          .sort((a, b) => b.mtime - a.mtime),
      }))
      .filter((p) => p.chats.length)
      .sort((a, b) => a.isScratch - b.isScratch || b.chats[0].mtime - a.chats[0].mtime);
  }

  // new | same | updated (continued on the other device, or parts missing here) | local-newer | diverged
  function chatStatus(b, id, projectDir) {
    const part = `p/${id}.jsonl`;
    const local = readIfExists(path.join(projectDir, `${id}.jsonl`));
    if (!local) return { status: 'new', localHash: null };
    const e = b.chats.blobs.get(part);
    const localHash = C.rawHash(local);
    if (localHash === e.hash) {
      const missing = [...b.chats.blobs.keys()].some((x) => C.partChat(x) === id && !fs.existsSync(C.partTarget(claudeDirPath(), projectDir, x)));
      return { status: missing ? 'updated' : 'same', localHash };
    }
    const remote = b.chats.read(part);
    if (local.length < remote.length && remote.subarray(0, local.length).equals(local)) return { status: 'updated', localHash };
    if (remote.length < local.length && local.subarray(0, remote.length).equals(remote)) return { status: 'local-newer', localHash };
    return { status: 'diverged', localHash };
  }

  const CHAT_TAKES = new Set(['new', 'updated', 'diverged']);
  const chatChoice = (c, decisions) => {
    if (!CHAT_TAKES.has(c.status)) return null;
    const d = decisions && decisions.chats && decisions.chats[c.id];
    return d === 'skip' ? 'skip' : 'take';
  };

  const chatView = (b) => (c) => ({
    id: c.id, scope: c.scope, label: c.label, status: c.status,
    title: c.meta.title || c.meta.prompt || null, entrypoint: c.meta.entrypoint || null, mtime: c.meta.mtime || null,
    group: groupOfChat(c) ? c.meta.group.name : null,
    size: b.chats.blobs.get(`p/${c.id}.jsonl`).size,
    choices: CHAT_TAKES.has(c.status) ? ['take', 'skip'] : [], defaultChoice: CHAT_TAKES.has(c.status) ? 'take' : null,
  });

  // The desktop app's record of a chat, so it is in the app's list here too: written when this device's app uses the
  // same account and has no record of it yet.
  function chatDesktopOp(c, to, deviceName) {
    const d = c.meta.desktop;
    if (!d || !d.record || !/^[\w-]+\/[\w-]+$/.test(String(d.dir)) || !/^local_[\w-]+\.json$/.test(String(d.name))) return null;
    const dir = path.join(desktopDirPath(), 'claude-code-sessions', ...d.dir.split('/'));
    if (!isDir(dir)) return null;
    const copy = to !== c.id;
    const name = copy ? `local_${crypto.randomUUID()}.json` : d.name;
    const abs = path.join(dir, name);
    if (fs.existsSync(abs)) return null;
    const record = { ...d.record, cliSessionId: to };
    if (copy) {
      record.sessionId = name.slice(0, -'.json'.length);
      record.title = `${record.title || c.meta.prompt || ''} (${deviceName})`.trim();
    }
    if (c.projectPath) {
      record.cwd = c.projectPath;
      if (record.originCwd) record.originCwd = c.projectPath;
    }
    return { type: 'write', abs, buf: Buffer.from(JSON.stringify(record), 'utf8'), record: { chat: c.id, scope: d.dir } };
  }

  // Writes for the chats taken: the scratch folder of a desktop app session that had no folder, their parts (read from
  // the bundle only when written), their desktop records, and the prompts typed in them, added to history.jsonl last.
  function chatOps(b, items, deviceName) {
    const claudeDir = claudeDirPath();
    const ops = [];
    const prompts = [];
    const folders = new Set();
    for (const c of items) {
      if (c.scratch && c.projectPath && !isDir(c.projectPath) && !folders.has(c.projectPath)) {
        folders.add(c.projectPath);
        ops.push({ type: 'mkdir', abs: c.projectPath });
      }
      const to = c.status === 'diverged' ? crypto.randomUUID() : c.id;
      for (const part of [...b.chats.blobs.keys()].filter((x) => C.partChat(x) === c.id)) {
        if (to === c.id) {
          const abs = C.partTarget(claudeDir, c.projectDir, part);
          const e = b.chats.blobs.get(part);
          const cur = readIfExists(abs);
          if (cur && cur.length === e.size && C.rawHash(cur) === e.hash) continue;
          ops.push({ type: 'write', abs, load: () => b.chats.read(part) });
        } else {
          const abs = C.partTarget(claudeDir, c.projectDir, C.renamePart(part, Buffer.alloc(0), c.id, to).part);
          ops.push({ type: 'write', abs, load: () => C.renamePart(part, b.chats.read(part), c.id, to, deviceName).buf });
        }
      }
      for (const o of c.meta.prompts || []) prompts.push({ ...o, sessionId: to, project: c.projectPath || o.project });
      const d = chatDesktopOp(c, to, deviceName);
      if (d) ops.push(d);
    }
    if (prompts.length) {
      const abs = path.join(claudeDir, 'history.jsonl');
      ops.push({ type: 'write', abs, load: () => Buffer.from(C.mergePrompts((readIfExists(abs) || Buffer.alloc(0)).toString('utf8'), prompts), 'utf8') });
    }
    return ops;
  }

  const groupOfChat = (c) => Boolean(c.meta.desktop && c.meta.group && typeof c.meta.group.id === 'string' && typeof c.meta.group.name === 'string' && c.meta.group.name);

  // The groups of the desktop app's sidebar for the bundle's sessions here: the ones written now (chatOps' records) and
  // the ones already here, so opening a bundle again sets up a group that was left out while the app was running.
  // The app's settings file is written only while the app is closed, after a copy of it is kept in this app's folder.
  // groups: { names, state: 'set' | 'already' (nothing to add) | 'running' | 'unknown' (could not tell) | 'failed' }.
  function desktopGroupOps(chats, writes) {
    const written = new Map(writes.filter((o) => o.record).map((o) => [o.record.chat, { scope: o.record.scope, session: path.basename(o.abs, '.json') }]));
    let here = null;
    const adds = [];
    for (const c of chats) {
      if (!groupOfChat(c)) continue;
      if (!here) here = C.desktopRecords(desktopDirPath());
      const group = { id: c.meta.group.id, name: c.meta.group.name };
      const w = written.get(c.id);
      if (w) adds.push({ ...w, group });
      const d = here.get(c.id);
      if (d && !(w && w.session === path.basename(d.name, '.json'))) adds.push({ scope: d.dir, session: path.basename(d.name, '.json'), group });
    }
    if (!adds.length) return { ops: [], groups: null };
    const names = [...new Set(adds.map((a) => a.group.name))];
    const abs = path.join(desktopDirPath(), C.DESKTOP_CONFIG);
    const cur = readIfExists(abs);
    if (!cur) return { ops: [], groups: null };
    const running = C.desktopRunning(env, platform);
    if (running !== false) return { ops: [], groups: { names, state: running ? 'running' : 'unknown' } };
    let text;
    try {
      text = C.withGroups(cur.toString('utf8'), adds);
    } catch {
      return { ops: [], groups: { names, state: 'failed' } };
    }
    if (text == null) return { ops: [], groups: { names, state: 'already' } };
    const copy = uniquePath(path.join(S.stateHome(env), 'claude-desktop', `${stamp(now())}-${C.DESKTOP_CONFIG}`));
    return { ops: [{ type: 'write', abs: copy, buf: cur }, { type: 'write', abs, buf: Buffer.from(text, 'utf8') }], groups: { names, state: 'set', copy } };
  }

  // The copies of the desktop app's settings file kept before writing it: the last ten.
  function keepDesktopCopies() {
    const dir = path.join(S.stateHome(env), 'claude-desktop');
    let names = [];
    try {
      names = fs.readdirSync(dir).filter((x) => x.endsWith(C.DESKTOP_CONFIG)).sort();
    } catch {
      return;
    }
    for (const x of names.slice(0, -10)) removeFile(path.join(dir, x));
  }

  // The groups a plan would set up, for its review: the records chatOps would write, without writing them.
  function plannedGroups(plan, decisions) {
    const keep = (plan.chats || []).filter((c) => chatChoice(c, decisions) !== 'skip');
    const writes = keep.filter((c) => chatChoice(c, decisions) === 'take' && groupOfChat(c))
      .map((c) => chatDesktopOp(c, c.status === 'diverged' ? crypto.randomUUID() : c.id, plan.bundle.device.name))
      .filter(Boolean);
    const g = desktopGroupOps(keep, writes).groups;
    return g && { names: g.names, state: g.state };
  }

  // Chats changed here after the review (Claude may be writing to them): taken as they were reviewed, they could lose it.
  const staleChats = (items) => items
    .map((c) => ({ c, abs: path.join(c.projectDir, `${c.id}.jsonl`) }))
    .filter(({ c, abs }) => c.status !== 'diverged' && ((cur) => (cur ? C.rawHash(cur) : null))(readIfExists(abs)) !== c.localHash)
    .map(({ abs }) => abs);

  // ---- Backup library -----------------------------------------------------------------
  function bundleDirs() {
    const cfg = settings();
    const list = [
      { dir: backupRoot(), depth: 2 },
      { dir: S.defaultBackupDir(env), depth: 2 },
      ...cfg.formerBackupDirs.map((dir) => ({ dir, depth: 2 })),
      { dir: path.join(home, 'Desktop'), depth: 0 },
      { dir: path.join(home, 'OneDrive', 'Desktop'), depth: 0 },
      { dir: path.join(home, 'Downloads'), depth: 0 },
      ...cfg.bundleDirs.map((dir) => ({ dir, depth: 1 })),
    ];
    const out = [];
    for (const d of list) if (!out.some((x) => samePath(x.dir, d.dir))) out.push(d);
    return out;
  }

  function findBundleFiles() {
    const found = new Map();
    for (const { dir, depth } of bundleDirs()) for (const abs of memsyncFiles(dir, depth)) found.set(ci(abs), abs);
    return [...found.values()];
  }

  // A bundle's header, read again only when the file has changed.
  function headerEntry(abs, st = fs.statSync(abs)) {
    let entry = headerCache.get(abs);
    if (!entry || entry.mtime !== st.mtimeMs || entry.size !== st.size) {
      let header = null;
      let error = null;
      try {
        header = readBundleHeader(abs);
      } catch (e) {
        error = { code: e.code || 'ERROR', message: e.message };
      }
      entry = { mtime: st.mtimeMs, size: st.size, header, error };
      headerCache.set(abs, entry);
    }
    return entry;
  }

  function isOwnBackup(abs, ids = null) {
    try {
      const { header } = headerEntry(abs);
      return Boolean(header && (isMineId(header.device.id) || (ids && ids.includes(header.device.id))));
    } catch {
      return false;
    }
  }

  function library() {
    const r = registry();
    const list = [];
    for (const abs of findBundleFiles()) {
      let st;
      try {
        st = fs.statSync(abs);
      } catch {
        continue;
      }
      const entry = headerEntry(abs, st);
      const h = entry.header;
      list.push({
        path: abs, name: path.basename(abs), dir: path.dirname(abs), size: st.size, mtime: st.mtimeMs,
        kind: (h && h.kind) || kindFromName(abs),
        createdAt: h ? h.createdAt : null,
        device: h ? { id: h.device.id, name: h.device.name, platform: h.device.platform, platformName: P.platformName(h.device.platform) } : null,
        isMine: Boolean(h && isMineId(h.device.id)),
        version: h ? h.version : null,
        stats: h ? h.stats : null,
        chats: h ? h.chats || 0 : 0,
        imported: Boolean(h && r.imported[importId(h)]),
        error: entry.error,
      });
    }
    list.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')) || b.mtime - a.mtime);
    return list;
  }

  // ---- Changing the backup folder -------------------------------------------------------
  // Works the way a folder backup program does. Backups of this device in the folders left behind can come along.
  // What is already in the chosen folder is read through before it is used: this device's backups join the list and the
  // history and backing up continues from them, those of an earlier install on this computer can be taken over, and
  // other devices' backups and damaged files are listed and never touched.
  //   reviewBackupFolder -> inspectBackup for each file found -> backupFolderFindings -> applyBackupFolder ->
  //   moveNextBackup until it says done. One call at a time, so the window stays alive and shows how far it got.
  const folderPlans = new Map();
  const pause = () => new Promise((r) => setImmediate(r));
  const hostKey = (h) => String(h || '').replace(/\.local$/i, '').toLowerCase();
  // Another install of the app on this computer: the same computer name, home folder and system.
  const sameComputer = (d) => d.platform === platform && hostKey(d.hostname) === hostKey(hostname) && samePath(d.home, home);

  function folderPlan(id) {
    const plan = folderPlans.get(id);
    if (!plan) throw new EngineError('PLAN_EXPIRED', 'This plan is no longer available. Choose the folder again.');
    return plan;
  }

  function checkWritable(dir) {
    const probe = path.join(dir, '.cms-write-check');
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(probe, '');
      fs.rmSync(probe, { force: true });
    } catch (e) {
      throw new EngineError('BACKUP_DIR_UNWRITABLE', `Cannot write to ${dir} (${e.code || e.message}).`);
    }
  }

  const knownBackupDirs = () => [backupRoot(), S.defaultBackupDir(env), ...settings().formerBackupDirs];

  // This device's backups in the backup folders other than target, and what stays there because it is not this device's.
  // Deepest folder first, so a file is taken relative to the backup folder it is in.
  function backupsOutside(target) {
    const roots = knownBackupDirs()
      .filter((dir, i, all) => !sameFolder(dir, target) && all.findIndex((x) => sameFolder(x, dir)) === i)
      .sort((a, b) => b.length - a.length);
    const seen = new Set();
    const files = [];
    const stay = { other: 0, unreadable: 0 };
    for (const root of roots) {
      // Files below the target are in it already, unless their whole backup folder is below it and is being left.
      const leaving = isUnder(target, root);
      for (const abs of memsyncFiles(root, 2)) {
        if (seen.has(ci(abs)) || (!leaving && isUnder(target, abs))) continue;
        seen.add(ci(abs));
        let st;
        try {
          st = fs.statSync(abs);
        } catch {
          continue;
        }
        const h = headerEntry(abs, st).header;
        if (!h) stay.unreadable++;
        else if (!isMineId(h.device.id)) stay.other++;
        else files.push({ path: abs, root, rel: path.relative(root, abs), size: st.size, dev: st.dev, kind: h.kind || kindFromName(abs) });
      }
    }
    return { files, stay, roots };
  }

  function summarize(files) {
    const dirs = new Map();
    const kinds = {};
    for (const f of files) {
      const d = dirs.get(f.root) || { dir: f.root, count: 0, bytes: 0 };
      d.count++;
      d.bytes += f.size;
      dirs.set(f.root, d);
      kinds[f.kind] = (kinds[f.kind] || 0) + 1;
    }
    return { count: files.length, bytes: files.reduce((n, f) => n + f.size, 0), dirs: [...dirs.values()], kinds };
  }

  // Backups of this device that were left in another backup folder, for Settings and the Backups screen.
  const backupsElsewhere = () => summarize(backupsOutside(backupRoot()).files);

  function freeSpace(dir) {
    try {
      const s = fs.statfsSync(dir);
      return Number(s.bavail) * Number(s.bsize);
    } catch {
      return null;
    }
  }

  // { dir }: the folder chosen; { useDefault: true }: the default folder; nothing: move what was left elsewhere to the
  // backup folder in use, without reading through it.
  function reviewBackupFolder({ dir = null, useDefault = false } = {}) {
    const current = backupRoot();
    const chosen = useDefault ? S.defaultBackupDir(env) : dir ? path.resolve(String(dir)) : current;
    const changed = !sameFolder(chosen, current);
    const to = changed ? chosen : current;
    if (!dir && !useDefault) requireBackupFolder();
    checkWritable(to);
    // Inside a folder being left it would be moved into itself. The default folder is always allowed: the way back.
    const inside = changed && !useDefault && knownBackupDirs().find((root) => !sameFolder(root, to) && isUnder(root, to));
    if (inside) throw new EngineError('BACKUP_DIR_INSIDE', `The backup folder cannot be inside ${inside}.`);
    const { files, stay, roots } = backupsOutside(to);
    const leaving = roots.filter((root) => !isUnder(root, to));
    const found = !dir && !useDefault ? [] : memsyncFiles(to, 2)
      .filter((abs) => !leaving.some((root) => isUnder(root, abs)))
      .sort()
      .map((abs) => ({ path: abs, name: path.basename(abs), state: 'pending' }));
    const dev = fs.statSync(to).dev;
    const need = files.filter((f) => f.dev !== dev).reduce((n, f) => n + f.size, 0);
    const free = freeSpace(to);
    const id = crypto.randomUUID();
    folderPlans.set(id, { id, to, changed, found, run: null });
    while (folderPlans.size > 5) folderPlans.delete(folderPlans.keys().next().value);
    return {
      id, from: current, to, changed,
      moves: summarize(files), stay, found: found.map((f) => ({ path: f.path, name: f.name })),
      space: { need, free, enough: free === null || need <= free },
      nothing: !files.length && !found.length,
    };
  }

  // Reads a file found in the folder all the way through, every part of it checked against its hash.
  async function inspectBackup(id, abs) {
    const f = folderPlan(id).found.find((x) => x.path === abs);
    if (!f) throw new EngineError('NOT_FOUND', `Not in this folder: ${abs}`);
    let st = null;
    try {
      st = fs.statSync(abs);
      const b = readBundle(abs, { v1WorkspaceRoot: primaryRootKey() });
      if (!Number.isFinite(Date.parse(b.createdAt))) throw new EngineError('BUNDLE_HEADER', 'Bundle header is incomplete.');
      if (b.chats) {
        for (const part of b.chats.blobs.keys()) {
          b.chats.read(part);
          await pause();
        }
      }
      if (b.full) {
        for (const x of b.full.values()) {
          if (!x.check) continue;
          x.check();
          await pause();
        }
      }
      Object.assign(f, {
        state: isMineId(b.device.id) ? 'mine' : sameComputer(b.device) ? 'earlier' : 'other',
        size: st.size, kind: b.kind || kindFromName(abs), createdAt: b.createdAt, stats: b.stats, chats: b.chats ? b.chats.sessions.size : 0,
        device: { id: b.device.id, name: b.device.name, platformName: P.platformName(b.device.platform) },
      });
    } catch (e) {
      Object.assign(f, { state: 'damaged', code: e.code || 'ERROR', message: e.message });
      // Not counted as a backup from now on, whatever its header says.
      if (st) headerCache.set(abs, { mtime: st.mtimeMs, size: st.size, header: null, error: { code: f.code, message: e.message } });
    }
    return { path: abs, state: f.state };
  }

  // What was found, and what the choices would mean: over the number kept, the oldest backups go at the next backup.
  function backupFolderFindings(id, { move = false, adopt = [] } = {}) {
    const plan = folderPlan(id);
    const cfg = settings();
    const newest = (list) => list.map((f) => f.createdAt).sort().pop() || null;
    const devices = (state) => {
      const by = new Map();
      for (const f of plan.found) {
        if (f.state !== state) continue;
        if (!by.has(f.device.id)) by.set(f.device.id, { ...f.device, list: [] });
        by.get(f.device.id).list.push(f);
      }
      return [...by.values()].map(({ list, ...d }) => ({ ...d, count: list.length, last: newest(list) }));
    };
    const mine = plan.found.filter((f) => f.state === 'mine');
    const keep = { daily: cfg.daily.keep, before: cfg.keepBefore, manual: cfg.keepManual };
    const coming = move ? backupsOutside(plan.to).files : [];
    const retention = Object.keys(KIND_DIRS).map((kind) => {
      const slot = (f) => f.endsWith(`-${kind}.memsync`);
      const here = memsyncFiles(path.join(plan.to, KIND_DIRS[kind]), 0).filter((abs) => slot(abs) && isOwnBackup(abs, adopt)).length;
      const total = here + coming.filter((f) => path.dirname(f.rel) === KIND_DIRS[kind] && slot(f.rel)).length;
      return { kind, keep: keep[kind], total, extra: total + 1 - keep[kind] };
    }).filter((x) => x.keep && x.total > x.keep);
    return {
      pending: plan.found.filter((f) => f.state === 'pending').length,
      mine: { count: mine.length, last: newest(mine) },
      earlier: devices('earlier'),
      other: devices('other'),
      damaged: plan.found.filter((f) => f.state === 'damaged').map((f) => ({ path: f.path, name: f.name, code: f.code, message: f.message })),
      retention,
    };
  }

  // Where the log and the last daily backup say a backup is, after it moved: Undo and the daily check keep finding it.
  function relink(moved) {
    if (!moved.size) return;
    const to = (p) => moved.get(ci(p)) || p;
    S.rewriteActivity((e) => ({
      ...e,
      ...(e.path ? { path: to(e.path) } : null),
      ...(e.backupPath ? { backupPath: to(e.backupPath) } : null),
      ...(e.bundle && e.bundle.path ? { bundle: { ...e.bundle, path: to(e.bundle.path) } } : null),
    }), env);
    const r = registry();
    if (r.lastDaily && r.lastDaily.path && moved.has(ci(r.lastDaily.path))) {
      r.lastDaily = { ...r.lastDaily, path: moved.get(ci(r.lastDaily.path)) };
      saveRegistry();
    }
  }

  // This device's backups found in the folder become part of its history as if they had been taken here, and the daily
  // backup continues from the newest. Version history (history.json) is left alone: it says what was shared with other
  // devices, and having a backup does not mean that. A restore merges it as always.
  function adoptBackups(plan) {
    const own = plan.found.filter((f) => f.state !== 'damaged' && isMineId(f.device.id));
    if (!own.length) return 0;
    const entries = S.readActivity(env, Infinity);
    const known = new Set(entries.filter((e) => e.type === 'backup' && e.path).map((e) => path.basename(e.path)));
    const rows = own.filter((f) => (f.kind === 'daily' || f.kind === 'manual') && !known.has(f.name));
    S.addActivity(rows.map((f) => ({ id: crypto.randomUUID(), at: f.createdAt, type: 'backup', ok: true, adopted: true, kind: f.kind, path: f.path, size: f.size, stats: f.stats, chats: f.chats || undefined })), env);

    // Files that were moved here by hand: what points to the old place points here now.
    const byName = new Map(own.map((f) => [f.name, f.path]));
    const refs = new Map();
    const note = (p) => {
      if (p && byName.has(path.basename(p)) && !fs.existsSync(p)) refs.set(ci(p), byName.get(path.basename(p)));
    };
    for (const e of entries) {
      note(e.path);
      note(e.backupPath);
      if (e.bundle) note(e.bundle.path);
    }
    const r = registry();
    if (r.lastDaily) note(r.lastDaily.path);
    relink(refs);

    const daily = own.filter((f) => f.kind === 'daily').sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0];
    if (daily && (!r.lastDaily || !(Date.parse(r.lastDaily.at) >= Date.parse(daily.createdAt)))) {
      // With chats the fingerprint has their times on disk, which the backup does not hold: the next daily backup is new.
      const b = readBundle(daily.path, { v1WorkspaceRoot: primaryRootKey() });
      r.lastDaily = { at: daily.createdAt, path: daily.path, fingerprint: b.chats ? null : fingerprint({ files: b.files, locations: b.locations, chatFiles: [] }), unchanged: false };
      saveRegistry();
    }
    return rows.length;
  }

  // adopt: earlier installs on this computer (ids from backupFolderFindings) whose backups count as this device's.
  function applyBackupFolder(id, { move = false, adopt = [] } = {}) {
    const plan = folderPlan(id);
    if (plan.found.some((f) => f.state === 'pending')) throw new EngineError('NOT_INSPECTED', 'The folder has not been checked yet.');
    checkWritable(plan.to);
    const cfg = settings();
    const from = backupRoot();
    const isDefault = (dir) => sameFolder(dir, S.defaultBackupDir(env));
    const taken = plan.found.filter((f) => f.state === 'earlier' && adopt.includes(f.device.id)).map((f) => f.device.id);
    config = S.normalizeConfig({
      ...cfg,
      backupDir: isDefault(plan.to) ? null : plan.to,
      // The folder left behind stays in the list as long as backups are there.
      formerBackupDirs: [...cfg.formerBackupDirs, ...(plan.changed ? [from] : [])]
        .filter((dir, i, all) => !isDefault(dir) && !sameFolder(dir, plan.to) && all.findIndex((x) => sameFolder(x, dir)) === i),
      earlierDeviceIds: [...new Set([...cfg.earlierDeviceIds, ...taken])],
    });
    S.saveConfig(config, env);
    invalidate();
    plans.clear();
    fullPlans.clear();
    const adopted = adoptBackups(plan);
    if (plan.changed || adopted) log({ type: 'backup-folder', ok: true, from: plan.changed ? from : undefined, to: plan.to, added: adopted });
    const files = move ? backupsOutside(plan.to).files : [];
    plan.run = { queue: files, failures: [], total: files.length, totalBytes: files.reduce((n, f) => n + f.size, 0), moved: 0, skipped: 0, bytes: 0, roots: [...new Set(files.map((f) => f.root))] };
    if (!files.length) endMove(plan);
    return { moving: files.length, bytes: plan.run.totalBytes, adopted };
  }

  const moveProgress = ({ run }) => ({
    done: !run.queue.length, moved: run.moved, skipped: run.skipped, total: run.total, bytes: run.bytes, totalBytes: run.totalBytes,
    left: run.queue.length + run.failures.length,
    failures: run.failures.map((f) => ({ path: f.path, name: path.basename(f.path), code: f.code, message: f.message })),
  });

  // Moves one backup. What points to it follows right away, so stopping at any point leaves everything in order: the
  // rest stays in the old folder, listed, and can be moved later. A file that cannot be moved stays where it is and does
  // not hold up the others; retry: try those again.
  async function moveNextBackup(id, { retry = false } = {}) {
    const plan = folderPlan(id);
    const { run } = plan;
    if (!run) throw new EngineError('INVALID', 'The backup folder has not been applied yet.');
    if (retry) run.queue.push(...run.failures.splice(0));
    const f = run.queue.shift();
    if (!f) return moveProgress(plan);
    try {
      let dst = path.join(plan.to, f.rel);
      if (!fs.existsSync(f.path)) {
        // Gone in the meantime: the daily backup keeps only so many.
        run.skipped++;
        dst = null;
      } else if (fs.existsSync(dst) && sameFile(f.path, dst)) {
        // The very same file through a linked folder: there already.
        run.skipped++;
        dst = null;
      } else if (fs.existsSync(dst) && fs.statSync(dst).size === f.size && (await hashFile(dst)) === (await hashFile(f.path))) {
        // The same backup is there already.
        removeFile(f.path);
        run.moved++;
        run.bytes += f.size;
      } else {
        dst = uniquePath(dst);
        await moveFile(f.path, dst);
        run.moved++;
        run.bytes += f.size;
      }
      if (dst) relink(new Map([[ci(f.path), dst]]));
      headerCache.delete(f.path);
      bundleCache.delete(f.path);
    } catch (e) {
      run.failures.push({ ...f, code: e.code || 'ERROR', message: e.message });
    }
    const progress = moveProgress(plan);
    if (progress.done && !run.failures.length) endMove(plan);
    return progress;
  }

  // Stopping, or giving up after an error: what was moved stays moved, the rest stays where it is.
  function stopBackupMove(id) {
    const plan = folderPlan(id);
    const progress = moveProgress(plan);
    endMove(plan);
    return progress;
  }

  function endMove(plan) {
    const { run } = plan;
    folderPlans.delete(plan.id);
    if (run.moved || run.failures.length) {
      log({
        type: 'backup-move', ok: !run.failures.length, from: run.roots, to: plan.to, moved: run.moved, bytes: run.bytes, left: run.queue.length + run.failures.length,
        error: run.failures.length ? run.failures[0].message : undefined,
      });
    }
    // Folders of the app that are empty now. A folder that still holds something stays.
    for (const root of run.roots) {
      for (const kind of Object.values(KIND_DIRS)) {
        try {
          fs.rmdirSync(path.join(root, kind));
        } catch { /* not empty, or not there */ }
      }
    }
    // A folder that cannot be reached may be a disk that is not plugged in: it stays in the list.
    const cfg = settings();
    const former = cfg.formerBackupDirs.filter((dir) => !isDir(dir) || memsyncFiles(dir, 2).length);
    if (former.length !== cfg.formerBackupDirs.length) {
      config = S.normalizeConfig({ ...cfg, formerBackupDirs: former });
      S.saveConfig(config, env);
    }
  }

  // ---- Opening a bundle ---------------------------------------------------------------
  const primaryRootKey = () => {
    const roots = settings().workspaceRoots;
    return roots.length ? rootKeyFor(roots[0]) : 'repos';
  };

  function loadBundle(abs) {
    const full = path.resolve(String(abs || ''));
    let st;
    try {
      st = fs.statSync(full);
    } catch {
      throw new EngineError('BUNDLE_UNREADABLE', `Could not read bundle: ${full}`);
    }
    const c = bundleCache.get(full);
    if (c && c.mtime === st.mtimeMs && c.size === st.size) return c.bundle;
    const b = readBundle(full, { v1WorkspaceRoot: primaryRootKey() });
    b.path = full;
    if (!b.kind) b.kind = kindFromName(full);
    bundleCache.set(full, { mtime: st.mtimeMs, size: st.size, bundle: b });
    if (bundleCache.size > 20) bundleCache.delete(bundleCache.keys().next().value);
    return b;
  }

  function bundleView(b) {
    const per = new Map();
    for (const [key, f] of b.files) {
      const pk = P.parseKey(key);
      const id = P.locationIdOf(pk.scope, pk.owner);
      const c = per.get(id) || { files: 0, bytes: 0 };
      c.files++;
      c.bytes += f.buf.length;
      per.set(id, c);
    }
    return {
      path: b.path, name: path.basename(b.path), size: b.compressedSize, version: b.version, kind: b.kind, createdAt: b.createdAt,
      device: { id: b.device.id, name: b.device.name, platform: b.device.platform, platformName: P.platformName(b.device.platform), hostname: b.device.hostname || null },
      isMine: isMineId(b.device.id),
      imported: Boolean(registry().imported[importId(b)]),
      stats: b.stats,
      full: b.full ? { backups: [...b.full.keys()].filter((rel) => rel.startsWith('backups/')).length } : null,
      chats: b.chats ? { count: b.chats.sessions.size, bytes: [...b.chats.blobs.values()].reduce((n, e) => n + e.size, 0) } : null,
      locations: Object.entries(b.locations)
        .sort(([a], [c]) => a.localeCompare(c))
        .map(([id, loc]) => ({ id, ...loc, ...(per.get(id) || { files: 0, bytes: 0 }) })),
    };
  }

  const openBundle = (abs) => bundleView(loadBundle(abs));

  function bundleContents(abs) {
    const b = loadBundle(abs);
    const files = [];
    for (const [key, f] of b.files) {
      const pk = P.parseKey(key);
      files.push({ key, location: P.locationIdOf(pk.scope, pk.owner), rel: pk.rel, size: f.buf.length, mtime: f.mtime || null, binary: isBinary(f.buf) });
    }
    const chatList = b.chats
      ? [...b.chats.sessions]
        .map(([id, c]) => ({ id, project: c.project, title: c.title || c.prompt || null, entrypoint: c.entrypoint || null, size: b.chats.blobs.get(`p/${id}.jsonl`).size, mtime: c.mtime || null }))
        .sort((x, y) => (y.mtime || 0) - (x.mtime || 0))
      : [];
    return { ...bundleView(b), files, chatList };
  }

  function bundleFile(abs, key) {
    const f = loadBundle(abs).files.get(key);
    if (!f) throw new EngineError('NOT_FOUND', `Not in bundle: ${key}`);
    return { key, size: f.buf.length, binary: isBinary(f.buf), text: textOf(f), truncated: f.buf.length > PREVIEW_LIMIT };
  }

  // ---- Matching the bundle's locations to this device -----------------------------------
  // how: self (own backup) | saved (matched before) | git | path | key | name | manual | claude
  // status: ready | create (a Claude project or workspace folder will be set up) | skipped | unmatched
  function matchLocations(b, s, mappings = {}) {
    const cfg = settings();
    const r = registry();
    const isSelf = isMineId(b.device.id);
    const byId = new Map(s.projects.map((p) => [ci(p.id), p]));
    const byKey = new Map(s.projects.map((p) => [p.key, p]));
    const eqRel = (a, c) => a != null && c != null && ci(a) === ci(c);
    const out = [];

    const projectTarget = (p) => ({ kind: 'project', id: p.id, key: p.key, name: p.name, path: p.cwd, root: p.memoryDir, files: p.files, create: false });
    const createProjectTarget = (folder, wantedKey) => {
      const used = new Set(s.projects.map((p) => p.key));
      let key = wantedKey;
      for (let n = 2; used.has(key); n++) key = `${wantedKey}-${n}`;
      const dir = projectDirFor(s.claudeDir, folder);
      return { kind: 'project', id: path.basename(dir), key, name: path.basename(folder), path: folder, root: path.join(dir, 'memory'), files: new Map(), create: true };
    };

    // The folder exists on this device but Claude Code has no project for it yet.
    const findFolder = (loc) => {
      const candidates = [];
      if (loc.homeRel != null) candidates.push({ path: loc.homeRel === '' ? home : path.join(home, ...loc.homeRel.split('/')), how: 'path' });
      if (loc.name) for (const root of cfg.workspaceRoots) candidates.push({ path: path.join(root, loc.name), how: 'key' });
      const remoteGit = normalizeRemote(loc.gitRemote);
      for (const c of candidates) {
        if (!isDir(c.path)) continue;
        if (remoteGit) {
          const g = normalizeRemote(readGitRemote(c.path));
          if (g === remoteGit) return { ...c, how: 'git' };
          if (g) continue;
        }
        return c;
      }
      return null;
    };

    // A session of the desktop app that had no folder ran in one of the app's scratch folders,
    // …/Claude/scratch-workspaces/<account>/<organization>/<name>: here it is the same one in this device's app.
    const scratchFolder = (loc) => {
      const m = loc.scratch ? /[\\/](scratch-workspaces(?:[\\/][^\\/]+)+)$/i.exec(String(loc.path || '')) : null;
      const segs = m ? m[1].split(/[\\/]/) : [];
      return segs.length > 1 && !segs.some((x) => x === '.' || x === '..') ? path.join(desktopDirPath(), ...segs) : null;
    };

    const suggest = (loc) => {
      const name = ci(loc.name || loc.key);
      return s.projects
        .filter((p) => p.files.size > 0 || p.exists)
        .map((p) => {
          const n = ci(p.name);
          const score = n === name ? 3 : n.includes(name) || name.includes(n) ? 2 : n.split(/[^a-z0-9]+/).some((t) => t.length > 2 && name.includes(t)) ? 1 : 0;
          return { id: p.id, score };
        })
        .filter((x) => x.score > 0)
        .sort((a, c) => c.score - a.score)
        .slice(0, 5)
        .map((x) => x.id);
    };

    function matchProject(m, loc, ov) {
      const ready = (p, how, include = true) => Object.assign(m, { local: projectTarget(p), localKey: p.key, status: 'ready', how, include });
      const create = (folder, how, include = true) => {
        const existing = byId.get(ci(P.encodeProjectDir(folder)));
        if (existing) return ready(existing, how, include);
        const t = createProjectTarget(folder, loc.key);
        return Object.assign(m, { local: t, localKey: t.key, status: 'create', how, include });
      };
      if (ov) {
        if (ov.action === 'skip') return Object.assign(m, { status: 'skipped', how: 'manual' });
        if (ov.action === 'map') {
          const p = s.projects.find((x) => x.id === ov.projectId);
          if (p) return ready(p, 'manual');
        }
        if (ov.action === 'create' && ov.path) return create(path.resolve(ov.path), 'manual');
      }
      if (isSelf && loc.claudeDir && byId.has(ci(loc.claudeDir))) return ready(byId.get(ci(loc.claudeDir)), 'self');
      const linked = r.links.project[loc.key];
      if (linked && byId.has(ci(linked))) return ready(byId.get(ci(linked)), 'saved');
      // The folder is made with the first chat that goes there (chatOps).
      const scratch = scratchFolder(loc);
      if (scratch) {
        const here = s.projects.find((p) => p.cwd && samePath(p.cwd, scratch));
        return here ? ready(here, 'path') : create(scratch, 'scratch');
      }

      const remoteGit = normalizeRemote(loc.gitRemote);
      const same = byKey.get(loc.key);
      if (same) {
        if (remoteGit && same.gitId) {
          if (remoteGit === same.gitId) return ready(same, 'git');
          m.warnings.push('git-mismatch');
        } else if (eqRel(loc.homeRel, same.homeRel)) {
          return ready(same, 'path');
        } else if (loc.legacy || isSelf) {
          return ready(same, 'key');
        }
        ready(same, 'name', false);
        if (!m.warnings.length) m.warnings.push('name-only');
      }
      const byGit = remoteGit && s.projects.find((p) => p !== same && p.gitId === remoteGit);
      if (byGit) {
        m.warnings = [];
        return ready(byGit, 'git');
      }
      const byPath = s.projects.find((p) => p !== same && eqRel(p.homeRel, loc.homeRel));
      if (byPath) {
        m.warnings = [];
        return ready(byPath, 'path');
      }
      if (m.status === 'ready') return m; // only a same-named project: offered, not selected
      if (isSelf && loc.path && isDir(loc.path)) return create(loc.path, 'self');
      const folder = findFolder(loc);
      if (folder) {
        const strong = folder.how !== 'key' || loc.legacy;
        if (!strong) m.warnings.push('name-only');
        return create(folder.path, folder.how, strong);
      }
      m.suggestions = suggest(loc);
      return m;
    }

    // Folders the incoming workspace files of a location open, relative to that location's folder.
    const repoRels = (loc) => {
      const prefix = P.scopePrefix('workspace', loc.key);
      const rels = new Set();
      for (const [key, f] of b.files) if (key.startsWith(prefix)) for (const rel of folderRels(key.slice(prefix.length), f.buf)) rels.add(rel);
      return [...rels];
    };
    // Folders here that may hold repositories: workspace folders, parents of Claude projects, the usual places.
    const repoParents = () => {
      const out = [];
      const push = (p) => {
        if (p && !out.some((x) => samePath(x, p)) && isDir(p)) out.push(p);
      };
      for (const x of s.roots) push(x.abs);
      for (const p of s.projects) if (p.exists && p.cwd && !p.isScratch) push(path.dirname(p.cwd));
      for (const p of knownParents(home)) push(p);
      return out;
    };
    const reposUnder = (dir, rels) => rels.filter((rel) => isDir(path.join(dir, ...rel.split('/')))).length;

    function matchRoot(m, loc, ov) {
      const ready = (root, how, include = true) =>
        Object.assign(m, { local: { kind: 'root', key: root.key, name: root.name, path: root.abs, root: root.abs, files: root.files, create: false }, localKey: root.key, status: 'ready', how, include });
      const add = (abs, how, include = true) => {
        const existing = s.roots.find((x) => samePath(x.abs, abs));
        if (existing) return ready(existing, how, include);
        const used = new Set(s.roots.map((x) => x.key));
        let key = loc.key;
        for (let n = 2; used.has(key); n++) key = `${loc.key}-${n}`;
        return Object.assign(m, {
          local: { kind: 'root', key, name: path.basename(abs), path: abs, root: abs, files: scanRoot(abs), create: true },
          localKey: key, status: 'create', how, include,
        });
      };
      if (ov) {
        if (ov.action === 'skip') return Object.assign(m, { status: 'skipped', how: 'manual' });
        if ((ov.action === 'map' || ov.action === 'create') && ov.path && isDir(ov.path)) return add(path.resolve(ov.path), 'manual');
      }
      if (isSelf && loc.path) {
        const x = s.roots.find((y) => samePath(y.abs, loc.path));
        if (x) return ready(x, 'self');
      }
      const linked = r.links.root[loc.key];
      const lx = linked && s.roots.find((y) => samePath(y.abs, linked) && y.exists);
      if (lx) return ready(lx, 'saved');
      const same = s.roots.find((y) => y.key === loc.key && y.exists);
      if (same) return ready(same, loc.legacy ? 'key' : 'path');
      const samePlace = loc.homeRel == null ? null : loc.homeRel === '' ? home : path.join(home, ...loc.homeRel.split('/'));
      const byPath = samePlace && isDir(samePlace) ? samePlace : null;
      // The folder holding most of the repositories the workspaces open; the same place under home wins a tie.
      const wanted = repoRels(loc);
      if (wanted.length) {
        let best = null;
        let most = 0;
        for (const dir of [byPath, ...repoParents()]) {
          const count = dir ? reposUnder(dir, wanted) : 0;
          if (count > most) {
            best = dir;
            most = count;
          }
        }
        if (best) return add(best, best === byPath ? 'path' : 'repos');
      }
      if (byPath) return add(byPath, 'path');
      if (isSelf && loc.path && isDir(loc.path)) return add(loc.path, 'self');
      return m;
    }

    for (const [id, loc] of Object.entries(b.locations).sort(([a], [c]) => a.localeCompare(c))) {
      const m = { id, type: loc.type, remote: loc, status: 'unmatched', how: null, include: false, local: null, localKey: null, warnings: [], suggestions: [] };
      const ov = mappings[id];
      if (loc.type === 'claude') {
        const skip = ov && ov.action === 'skip';
        Object.assign(m, {
          local: { kind: 'claude', key: 'claude', name: 'Claude', path: s.claude.dir, root: s.claude.dir, files: s.claude.files, create: !s.claude.exists },
          localKey: 'claude', status: skip ? 'skipped' : 'ready', how: skip ? 'manual' : 'claude', include: !skip,
        });
      } else if (loc.type === 'project') {
        matchProject(m, loc, ov);
      } else {
        matchRoot(m, loc, ov);
      }
      if (ov && ov.include === false) m.include = false;
      if (ov && ov.include === true && m.local) m.include = true;
      out.push(m);
    }
    // One local target can receive only one location.
    const taken = new Set();
    for (const m of out) {
      if (!m.include || !m.local) continue;
      const t = `${m.type}:${m.local.kind === 'project' ? ci(m.local.id) : ci(m.local.path)}`;
      if (taken.has(t)) {
        m.include = false;
        m.warnings.push('duplicate-target');
      } else taken.add(t);
    }
    return out;
  }

  function matchView(m) {
    return {
      id: m.id, type: m.type, status: m.status, how: m.how, include: m.include, warnings: m.warnings, suggestions: m.suggestions,
      remote: { key: m.remote.key, name: m.remote.name, title: m.remote.title, path: m.remote.path, homeRel: m.remote.homeRel, gitRemote: m.remote.gitRemote, scratch: m.remote.scratch, legacy: m.remote.legacy },
      local: m.local ? { id: m.local.id || null, key: m.local.key, name: m.local.name, path: m.local.path, root: m.local.root, create: m.local.create, fileCount: m.local.files.size } : null,
    };
  }

  // ---- Planning, reviewing and applying a transfer ---------------------------------------
  function getPlan(id) {
    const plan = plans.get(id);
    if (!plan) throw new EngineError('PLAN_EXPIRED', 'This plan is no longer available. Open the bundle again.');
    return plan;
  }

  // mode: 'sync' (two-way merge) | 'restore' (make this device match the bundle)
  // mappings: { [locationId]: { action: 'map', projectId } | { action: 'create', path } | { action: 'skip' } | { include } }
  // onlyKeys: limit to these keys (undo of one operation)
  function prepare({ bundlePath, mode = 'sync', mappings = {}, onlyKeys = null, undoOf = null } = {}) {
    if (mode !== 'sync' && mode !== 'restore') throw new EngineError('INVALID', `Unknown mode: ${mode}`);
    const b = loadBundle(bundlePath);
    const s = scan({ fresh: true });
    const localHist = S.loadHistory(env);
    const matches = matchLocations(b, s, mappings);
    const only = onlyKeys ? new Set(onlyKeys) : null;
    const remoteHist = new Map();
    const scopes = [];
    for (const m of matches) {
      if (!m.include || !m.local) continue;
      const scope = scopeOfType(m.type);
      const remotePrefix = P.scopePrefix(scope, m.remote.key);
      const localPrefix = P.scopePrefix(scope, m.localKey);
      let remote = new Map();
      for (const [key, f] of b.files) if (key.startsWith(remotePrefix)) remote.set(key.slice(remotePrefix.length), f);
      for (const [key, v] of b.history) if (key.startsWith(remotePrefix)) remoteHist.set(localPrefix + key.slice(remotePrefix.length), v);
      let local = m.remote.memory === false ? new Map() : m.local.files;
      // Files the other device left out of the bundle on purpose are not part of this transfer, in either mode.
      if (m.remote.skipped) local = filterMap(local, (rel) => !m.remote.skipped.includes(rel));
      if (only) {
        local = filterMap(local, (rel) => only.has(localPrefix + rel));
        remote = filterMap(remote, (rel) => only.has(localPrefix + rel));
      }
      scopes.push({ id: m.id, label: m.local.name || m.remote.name || m.remote.key, type: m.type, isMemory: m.type === 'project', partial: Boolean(only), root: m.local.root, keyPrefix: localPrefix, local, remote, match: m });
    }
    if (only) {
      // Touched files whose folder is not in the bundle at all (created by that operation): they go back to not existing.
      const covered = new Set(scopes.map((sc) => sc.keyPrefix));
      const extra = new Map();
      for (const key of only) {
        const pk = P.parseKey(key);
        if (!pk) continue;
        const prefix = P.scopePrefix(pk.scope, pk.owner);
        if (covered.has(prefix) || extra.has(prefix)) continue;
        let t = null;
        if (pk.scope === 'memory') {
          const p = s.projects.find((x) => x.key === pk.owner);
          if (p) t = { type: 'project', label: p.name, root: p.memoryDir, files: p.files };
        } else if (pk.scope === 'workspace') {
          const x = s.roots.find((y) => y.key === pk.owner);
          if (x) t = { type: 'workspaceRoot', label: x.name, root: x.abs, files: x.files };
        } else {
          t = { type: 'claude', label: 'Claude', root: s.claude.dir, files: s.claude.files };
        }
        if (t) extra.set(prefix, t);
      }
      for (const [prefix, t] of extra) {
        scopes.push({ id: `local:${prefix}`, label: t.label, type: t.type, isMemory: t.type === 'project', partial: true, root: t.root, keyPrefix: prefix, local: filterMap(t.files, (rel) => only.has(prefix + rel)), remote: new Map(), match: null });
      }
    }
    const errors = classify({ mode, scopes, localHist, remoteHist, platform });
    for (const sc of scopes) if (sc.type === 'workspaceRoot') markRepos(sc, mode === 'sync');
    // The bundle's chats go with their projects.
    const chats = [];
    if (b.chats && !only) {
      for (const m of matches) {
        if (!m.include || !m.local || m.type !== 'project') continue;
        const projectDir = path.dirname(m.local.root);
        for (const [cid, meta] of b.chats.sessions) {
          if (meta.project !== m.remote.key) continue;
          chats.push({ id: cid, meta, scope: m.id, label: m.remote.title || m.local.name || m.remote.name || m.remote.key, projectDir, projectPath: m.local.path || null, scratch: Boolean(m.remote.scratch), ...chatStatus(b, cid, projectDir) });
        }
      }
    }
    const id = crypto.randomUUID();
    plans.set(id, { id, mode, bundle: b, matches, scopes, localHist, remoteHist, errors, undoOf, mappings, chats });
    while (plans.size > 10) plans.delete(plans.keys().next().value);
    return planView(plans.get(id));
  }

  // The folders each workspace file opens and whether they are on this device. In a sync, a workspace that is new here
  // and whose folders are not all here comes unselected; not taking it keeps it out of history, so it is offered again.
  function markRepos(sc, preselect) {
    for (const it of sc.items) {
      const f = it.R || it.L;
      if (!f || !it.rel.endsWith('.code-workspace')) continue;
      const folders = inspectWorkspace(P.toAbs(sc.root, it.rel), sc.root, f.buf).folders.filter((x) => x.kind !== 'uri');
      if (!folders.length) continue;
      it.repos = folders.map((x) => ({ path: x.path, name: x.name || x.path.split(/[\\/]/).filter(Boolean).pop() || x.path, local: x.resolved, found: Boolean(x.exists) }));
      const found = it.repos.filter((x) => x.found).length;
      it.repoStatus = found === it.repos.length ? 'all' : found ? 'some' : 'none';
      if (preselect && it.action === 'add' && it.repoStatus !== 'all') it.defaultChoice = 'skip';
    }
  }

  function planView(plan) {
    const items = [];
    const groups = { new: 0, updated: 0, deleted: 0, conflict: 0, index: 0, kept: 0, same: 0 };
    for (const sc of plan.scopes) {
      for (const it of sc.items) {
        groups[it.group] = (groups[it.group] || 0) + 1;
        items.push({
          key: it.key, scope: sc.id, scopeLabel: sc.label, scopeType: sc.type, rel: it.rel, action: it.action, group: it.group,
          choices: it.choices, defaultChoice: it.defaultChoice, isIndex: it.isIndex, repos: it.repos || null, repoStatus: it.repoStatus || null,
          local: it.L ? { size: it.L.buf.length, mtime: it.L.mtime || null } : null,
          remote: it.R ? { size: it.R.buf.length, mtime: it.R.mtime || null } : null,
          path: P.toAbs(sc.root, it.rel),
          binary: Boolean((it.L && isBinary(it.L.buf)) || (it.R && isBinary(it.R.buf))),
        });
      }
    }
    return {
      id: plan.id, mode: plan.mode, undoOf: plan.undoOf || null, bundle: bundleView(plan.bundle),
      matches: plan.matches.map(matchView), errors: plan.errors, items, groups,
      scopes: plan.scopes.map((sc) => ({ id: sc.id, label: sc.label, type: sc.type, root: sc.root, create: Boolean(sc.match && sc.match.local.create), files: sc.items.length })),
      chats: (plan.chats || []).map(chatView(plan.bundle)),
      backupDir: path.join(backupRoot(), KIND_DIRS.before),
    };
  }

  const runResolve = (plan, decisions) =>
    resolve({ mode: plan.mode, scopes: plan.scopes, localHist: plan.localHist, remoteHist: plan.remoteHist, remoteLabel: plan.bundle.device.name, decisions });

  function resolvePlan(planId, decisions = {}) {
    const plan = getPlan(planId);
    const res = runResolve(plan, decisions);
    const ops = plan.scopes.flatMap((sc) =>
      sc.ops.map((op) => ({ type: op.type, key: op.key, rel: op.rel, path: op.abs, scope: sc.id, scopeLabel: sc.label, reason: op.reason, size: op.buf ? op.buf.length : null })));
    return {
      pending: res.pending,
      ops,
      writes: ops.filter((o) => o.type === 'write').length,
      deletes: ops.filter((o) => o.type === 'delete').length,
      copies: plan.scopes.reduce((n, sc) => n + sc.copies.length, 0),
      chats: (plan.chats || []).filter((c) => chatChoice(c, decisions) === 'take').length,
      groups: plannedGroups(plan, decisions),
      index: [...res.index.values()].map((x) => ({ key: x.key, scope: x.scope, display: x.display, stats: x.stats, skipped: x.skipped })),
    };
  }

  function itemDiff(planId, key, decisions = {}) {
    const plan = getPlan(planId);
    let it = null;
    for (const sc of plan.scopes) {
      it = sc.items.find((x) => x.key === key);
      if (it) break;
    }
    if (!it) throw new EngineError('NOT_FOUND', `Not in plan: ${key}`);
    const out = { key, rel: it.rel, isIndex: it.isIndex, binary: Boolean((it.L && isBinary(it.L.buf)) || (it.R && isBinary(it.R.buf))), local: textOf(it.L), remote: textOf(it.R) };
    if (it.isIndex) {
      const ix = runResolve(plan, decisions).index.get(key);
      out.merged = ix && ix.text != null ? ix.text : out.local;
      out.lines = lineDiff(out.local || '', out.merged || '', { context: 2, maxLines: DIFF_LINES });
    } else {
      out.lines = lineDiff(out.local || '', out.remote || '', { context: 2, maxLines: DIFF_LINES });
    }
    return out;
  }

  // Files the plan will touch must still be exactly as they were when the plan was made.
  function staleFiles(plan, ops) {
    const stale = [];
    for (const sc of plan.scopes) {
      const byRel = new Map(sc.items.map((it) => [it.rel, it]));
      for (const op of sc.ops) {
        const it = byRel.get(op.rel);
        const expected = it && it.L ? it.L.hash : null;
        const cur = readIfExists(op.abs);
        if ((cur ? hashContent(cur) : null) !== expected) stale.push(op.abs);
      }
    }
    return stale.filter((p) => ops.some((o) => o.abs === p));
  }

  const bundleRef = (b) => ({ path: b.path, device: b.device.name, deviceId: b.device.id, createdAt: b.createdAt, kind: b.kind });

  function finish(plan, res, ops, backup, chats = 0, groups = null) {
    const hist = S.loadHistory(env);
    for (const [k, v] of res.history) {
      if (!v || !v.size) hist.delete(k);
      else hist.set(k, v);
    }
    S.saveHistory(hist, env);

    const r = registry();
    const cfg = settings();
    let cfgChanged = false;
    for (const m of plan.matches) {
      if (!m.include || !m.local) continue;
      if (m.type === 'project') {
        if (m.local.create) {
          r.projectKeys[m.local.id] = m.local.key;
          r.projectPaths[m.local.id] = m.local.path;
        }
        if (m.how !== 'self') r.links.project[m.remote.key] = m.local.id;
      } else if (m.type === 'workspaceRoot') {
        if (m.local.create && !cfg.workspaceRoots.some((x) => samePath(x, m.local.path))) {
          cfg.workspaceRoots.push(m.local.path);
          r.rootKeys[m.local.path] = m.local.key;
          cfgChanged = true;
        }
        if (m.how !== 'self') r.links.root[m.remote.key] = m.local.path;
      }
    }
    if (!plan.undoOf) r.imported[importId(plan.bundle)] = { at: now().toISOString() };
    saveRegistry();
    if (cfgChanged) S.saveConfig(cfg, env);
    invalidate();

    const writes = ops.filter((o) => o.type === 'write').length;
    return log({
      type: plan.undoOf ? 'undo' : plan.mode,
      ok: true,
      undoOf: plan.undoOf || undefined,
      bundle: bundleRef(plan.bundle),
      backupPath: backup ? backup.path : null,
      writes,
      deletes: ops.length - writes,
      copies: plan.scopes.reduce((n, sc) => n + sc.copies.length, 0),
      chats: chats || undefined,
      groups: groups || undefined,
      scopes: plan.scopes
        .filter((sc) => sc.ops.length)
        .map((sc) => ({ label: sc.label, type: sc.type, root: sc.root, writes: sc.ops.filter((o) => o.type === 'write').length, deletes: sc.ops.filter((o) => o.type === 'delete').length })),
      touched: ops.map((o) => ({ key: o.key, path: o.abs, type: o.type, reason: o.reason })),
    });
  }

  // Always: fresh-state check, full backup of this device (verified), write with rollback, read-back check, then history.
  function apply(planId, decisions = {}) {
    const plan = getPlan(planId);
    if (plan.errors.length) throw new EngineError('BLOCKED', 'This plan has blocking problems.', { errors: plan.errors });
    const res = runResolve(plan, decisions);
    if (res.pending.length) throw new EngineError('PENDING', `${res.pending.length} decision(s) are still open.`, { pending: res.pending });
    const ops = plan.scopes.flatMap((sc) => sc.ops);
    const chats = (plan.chats || []).filter((c) => chatChoice(c, decisions) === 'take');
    const stale = [...staleFiles(plan, ops), ...staleChats(chats)];
    if (stale.length) throw new EngineError('STALE', 'Some files changed after the plan was made. Review the changes again.', { files: stale });
    const writes = chatOps(plan.bundle, chats, plan.bundle.device.name);
    const desk = desktopGroupOps((plan.chats || []).filter((c) => chatChoice(c, decisions) !== 'skip'), writes);
    const groups = desk.groups;
    if (!ops.length && !chats.length) {
      // Only the sidebar groups, when the chats are here already: the app's settings file is copied first.
      if (desk.ops.length) {
        try {
          applyOps(desk.ops);
        } catch (e) {
          throw new EngineError('APPLY_FAILED', e.message, { rolledBack: e.rolledBack, rollbackErrors: e.rollbackErrors });
        }
        keepDesktopCopies();
      }
      const entry = finish(plan, res, ops, null, 0, groups);
      plans.delete(planId);
      return { nothing: !desk.ops.length, writes: 0, deletes: 0, copies: 0, chats: 0, groups, activityId: entry.id, backupPath: null };
    }

    const backup = createBackup('before', { reason: plan.undoOf ? 'undo' : plan.mode });
    const fail = (code, message, extra) => {
      log({ type: plan.undoOf ? 'undo' : plan.mode, ok: false, error: message, bundle: bundleRef(plan.bundle), backupPath: backup.path, ...extra });
      invalidate();
      return new EngineError(code, message, { backupPath: backup.path, ...extra });
    };
    try {
      applyOps([...ops, ...writes, ...desk.ops]);
    } catch (e) {
      throw fail('APPLY_FAILED', e.message, { rolledBack: e.rolledBack, rollbackErrors: e.rollbackErrors });
    }
    const problems = verifyOps(ops);
    if (problems.length) throw fail('VERIFY_FAILED', 'Verification failed after writing.', { problems });
    if (desk.ops.length) keepDesktopCopies();

    const entry = finish(plan, res, ops, backup, chats.length, groups);
    plans.delete(planId);
    return { activityId: entry.id, backupPath: backup.path, writes: entry.writes, deletes: entry.deletes, copies: entry.copies, chats: chats.length, groups, verified: true };
  }

  // ---- History of operations, undo ---------------------------------------------------------
  const UNDOABLE = new Set(['sync', 'restore', 'undo', 'workspace-fix']);

  function activity(limit = 200) {
    const list = S.readActivity(env, Math.max(limit, 300));
    const undone = new Set(list.filter((e) => e.type === 'undo' && e.ok && e.undoOf).map((e) => e.undoOf));
    return list.slice(0, limit).map((e) => ({
      ...e,
      touched: undefined,
      touchedCount: e.touched ? e.touched.length : 0,
      undone: undone.has(e.id),
      undoable: Boolean(e.ok && UNDOABLE.has(e.type) && e.backupPath && e.touched && e.touched.length && !undone.has(e.id) && fs.existsSync(e.backupPath)),
    }));
  }

  function activityDetail(id) {
    const e = S.readActivity(env, 2000).find((x) => x.id === id);
    if (!e) throw new EngineError('NOT_FOUND', 'Activity entry not found.');
    return e;
  }

  // Puts back only the files that operation changed, from the backup taken right before it.
  function prepareUndo(activityId) {
    const e = activityDetail(activityId);
    if (!e.ok || !UNDOABLE.has(e.type) || !e.backupPath || !e.touched || !e.touched.length) throw new EngineError('NOT_UNDOABLE', 'This operation cannot be undone.');
    if (!fs.existsSync(e.backupPath)) throw new EngineError('BACKUP_MISSING', `The backup taken before this operation no longer exists: ${e.backupPath}`);
    return prepare({ bundlePath: e.backupPath, mode: 'restore', onlyKeys: e.touched.map((t) => t.key), undoOf: e.id });
  }

  // ---- Workspace files -------------------------------------------------------------------------
  function fixWorkspace({ root: rootKey, rel, apply: doApply = false }) {
    const s = scan({ fresh: true });
    const root = s.roots.find((r) => r.key === rootKey);
    const f = root && root.files.get(rel);
    if (!f) throw new EngineError('NOT_FOUND', `Workspace file not found: ${rel}`);
    const before = f.buf.toString('utf8');
    const { text, changes } = makePortable(before, f.abs);
    const lines = lineDiff(before, text, { context: 2, maxLines: DIFF_LINES });
    if (!doApply || !changes.length) return { path: f.abs, changes, lines, applied: false };
    const cur = readIfExists(f.abs);
    if (!cur || hashContent(cur) !== f.hash) throw new EngineError('STALE', 'The file changed. Review it again.', { files: [f.abs] });
    const backup = createBackup('before', { reason: 'workspace-fix' });
    const op = { type: 'write', abs: f.abs, buf: Buffer.from(text, 'utf8'), key: P.workspaceKey(root.key, rel), rel };
    applyOps([op]);
    const problems = verifyOps([op]);
    invalidate();
    if (problems.length) throw new EngineError('VERIFY_FAILED', 'Verification failed after writing.', { problems, backupPath: backup.path });
    const entry = log({ type: 'workspace-fix', ok: true, path: f.abs, changes, backupPath: backup.path, writes: 1, deletes: 0, touched: [{ key: op.key, path: f.abs, type: 'write', reason: 'fix' }] });
    return { path: f.abs, changes, lines, applied: true, backupPath: backup.path, activityId: entry.id };
  }

  // ---- Home screen ---------------------------------------------------------------------------
  function overview() {
    const s = scan();
    const hist = S.loadHistory(env);
    const withMemory = s.projects.filter((p) => p.files.size > 0);
    const pending = { new: 0, changed: 0 };
    const add = (c) => {
      pending.new += c.new;
      pending.changed += c.changed;
    };
    for (const p of withMemory) if (included(p)) add(counts(p.files, `memory/${p.key}/`, hist));
    for (const r of s.roots) add(counts(r.files, `workspace/${r.key}/`, hist));
    if (settings().includeClaude) add(counts(s.claude.files, 'claude/', hist));

    const lib = library();
    const ownBackups = lib.filter((b) => b.isMine && b.kind !== 'export' && !b.error);
    const warnings = [];
    if (!s.claude.exists) warnings.push({ code: 'no-claude', path: s.claudeDir });
    for (const r of s.roots) if (!r.exists) warnings.push({ code: 'root-missing', path: r.abs });
    if (!s.roots.length) warnings.push({ code: 'no-roots' });
    let fixable = 0;
    for (const r of s.roots) for (const f of r.files.values()) if (inspectWorkspace(f.abs, r.abs, f.buf).fixable) fixable++;
    if (fixable) warnings.push({ code: 'workspace-fixable', count: fixable });

    return {
      device: deviceView(),
      counts: {
        projects: withMemory.length,
        includedProjects: withMemory.filter((p) => included(p)).length,
        scratchProjects: withMemory.filter((p) => p.isScratch).length,
        memoryFiles: withMemory.reduce((n, p) => n + p.files.size, 0),
        workspaceFiles: s.roots.reduce((n, r) => n + r.files.size, 0),
        workspaceRoots: s.roots.length,
        claudeFiles: s.claude.files.size,
        bytes: withMemory.reduce((n, p) => n + p.bytes, 0),
      },
      pending,
      lastBackup: ownBackups[0] || null,
      lastExport: lib.find((b) => b.isMine && b.kind === 'export' && !b.error) || null,
      incoming: lib.filter((b) => !b.isMine && !b.imported && !b.error).slice(0, 5),
      daily: dailyStatus(),
      warnings,
      recent: activity(6),
    };
  }

  return {
    // settings
    settings: () => ({ ...settings(), device: deviceView() }),
    updateSettings,
    introStatus,
    completeIntro,
    folderAccess,
    setProjectIncluded,
    // this device
    overview,
    projects,
    projectFiles,
    readFile,
    workspaces,
    claudeConfig,
    fixWorkspace,
    // backups and bundles
    createBackup: (kind = 'manual') => createBackup(kind === 'daily' ? 'daily' : 'manual'),
    runDailyIfDue,
    dailyStatus,
    backupPreview,
    exportPreview,
    exportBundle,
    chats: chatList,
    fullBackupPreview,
    createFullBackup,
    prepareFullRestore,
    applyFullRestore,
    library,
    openBundle,
    bundleContents,
    bundleFile,
    // the backup folder
    backupsElsewhere,
    reviewBackupFolder,
    inspectBackup,
    backupFolderFindings,
    applyBackupFolder,
    moveNextBackup,
    stopBackupMove,
    // transfer
    prepare,
    resolvePlan,
    itemDiff,
    apply,
    // history
    activity,
    activityDetail,
    prepareUndo,
    // for tests and the CLI
    scan: (o) => scan(o),
    refresh: invalidate,
  };
}

module.exports = { createEngine, EngineError, APP };
