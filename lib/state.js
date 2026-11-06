'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { writeFileAtomic } = require('./fsx');

function stateHome(env = process.env) {
  return env.CLAUDE_MEMORY_SYNC_HOME ? path.resolve(env.CLAUDE_MEMORY_SYNC_HOME) : path.join(os.homedir(), '.claude-memory-sync');
}
const configPath = (env) => path.join(stateHome(env), 'config.json');
const historyPath = (env) => path.join(stateHome(env), 'history.json');
const registryPath = (env) => path.join(stateHome(env), 'state.json');
const activityPath = (env) => path.join(stateHome(env), 'activity.jsonl');

function readJson(p, fallback) {
  let text;
  try {
    text = fs.readFileSync(p, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return fallback;
    throw new Error(`Could not read ${p}: ${e.message}`);
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(`${p} is corrupt (${e.message}). Fix it or delete it.`);
  }
}

const writeJson = (p, obj) => writeFileAtomic(p, JSON.stringify(obj, null, 2) + '\n');

// ---- Settings ---------------------------------------------------------------
const DEFAULTS = {
  version: 2,
  deviceId: null,
  deviceName: null,
  workspaceRoots: [], // folders scanned for *.code-workspace files; the first one is the main repos folder
  bundleDirs: [], // extra folders searched for .memsync files (Desktop and Downloads are always searched)
  // The first-start question about setting up backups is still open. Where they go and when is the backup set's
  // (lib/backups.js, sets.json), not here.
  askBackups: true,
  includeClaude: true,
  includeScratch: false,
  excludedProjects: [],
  openAtLogin: true,
  runInBackground: true,
  language: null, // interface language ('en', 'tr' ...); null: the system's
  theme: 'system', // 'system', 'light' or 'dark'
  introSeen: null, // what the first-start explanation was last shown for (on macOS an app build, see app/main.js)
  // What daily and manual backups take. Memories and workspace files are left out by name, so new ones go in; chats go
  // in only when chosen: all of them, or those of the chosen projects (new ones too) and single chats.
  backup: { excludeProjects: [], excludeRoots: [], excludeWorkspaceFiles: {}, claude: true, chats: 'none', chatProjects: [], chatGroups: [], chatIds: [] },
};
const CHAT_MODES = ['none', 'all', 'some'];
const strings = (a) => (Array.isArray(a) ? [...new Set(a.filter((x) => typeof x === 'string' && x))] : []);

function normalizeBackup(raw) {
  const b = raw && typeof raw === 'object' ? raw : {};
  const files = b.excludeWorkspaceFiles && typeof b.excludeWorkspaceFiles === 'object' ? b.excludeWorkspaceFiles : {};
  return {
    excludeProjects: strings(b.excludeProjects),
    excludeRoots: strings(b.excludeRoots),
    excludeWorkspaceFiles: Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strings(v)]).filter(([, v]) => v.length)),
    claude: b.claude !== false,
    chats: CHAT_MODES.includes(b.chats) ? b.chats : 'none',
    chatProjects: strings(b.chatProjects),
    chatGroups: strings(b.chatGroups),
    chatIds: strings(b.chatIds),
  };
}

const isV1Config = (raw) => Boolean(raw) && !raw.version && typeof raw.reposRoot === 'string';
// Settings of versions before 3, whose backups were .memsync files: their backups are not used any more.
const OLD_BACKUP_KEYS = ['backupDir', 'formerBackupDirs', 'earlierDeviceIds', 'daily', 'keepBefore', 'keepManual'];

function normalizeConfig(raw) {
  const c = { ...DEFAULTS, ...raw };
  c.version = 2;
  for (const k of OLD_BACKUP_KEYS) delete c[k];
  for (const k of ['workspaceRoots', 'bundleDirs', 'excludedProjects']) c[k] = Array.isArray(c[k]) ? c[k].filter((x) => typeof x === 'string') : [];
  c.askBackups = c.askBackups !== false;
  if (typeof c.language !== 'string' || !/^[a-z]{2,3}$/.test(c.language)) c.language = null;
  if (!['system', 'light', 'dark'].includes(c.theme)) c.theme = 'system';
  if (typeof c.introSeen !== 'string' || !c.introSeen) c.introSeen = null;
  c.backup = normalizeBackup(c.backup);
  delete c.reposRoot;
  delete c.prefix;
  return c;
}

const loadConfigRaw = (env) => readJson(configPath(env), null);
const saveConfig = (cfg, env) => writeJson(configPath(env), cfg);

// ---- History: key -> every content hash this device has seen or accepted ---------
function loadHistory(env) {
  const obj = readJson(historyPath(env), { version: 1, keys: {} });
  const map = new Map();
  for (const [k, arr] of Object.entries(obj.keys || {})) if (Array.isArray(arr)) map.set(k, new Set(arr));
  return map;
}

function saveHistory(map, env) {
  const keys = {};
  for (const k of [...map.keys()].sort()) if (map.get(k) && map.get(k).size) keys[k] = [...map.get(k)];
  writeJson(historyPath(env), { version: 1, keys });
}

// ---- Registry: what this device remembers about names and matches -----------------
//  projectKeys  : Claude project folder name -> key used in bundles
//  projectPaths : Claude project folder name -> real project folder (found once, kept)
//  links        : key in other devices' bundles -> local target, confirmed by the user or a strong match
//  imported     : bundles already applied on this device
function loadRegistry(env) {
  const r = readJson(registryPath(env), {}) || {};
  return {
    version: 2,
    projectKeys: r.projectKeys || {},
    projectPaths: r.projectPaths || {},
    rootKeys: r.rootKeys || {},
    links: { project: (r.links && r.links.project) || {}, root: (r.links && r.links.root) || {} },
    imported: r.imported || {},
  };
}
const saveRegistry = (reg, env) => writeJson(registryPath(env), reg);

// ---- Activity log ---------------------------------------------------------------
const ACTIVITY_KEEP = 1000;

function appendActivity(entry, env) {
  const p = activityPath(env);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.appendFileSync(p, JSON.stringify(entry) + '\n');
  try {
    const lines = fs.readFileSync(p, 'utf8').split('\n').filter(Boolean);
    if (lines.length > ACTIVITY_KEEP * 1.2) writeFileAtomic(p, lines.slice(-ACTIVITY_KEEP).join('\n') + '\n');
  } catch { /* trimming is best effort */ }
}

// Entries of what happened earlier go in at the place of their time.
function addActivity(entries, env) {
  if (!entries.length) return;
  const all = [...readActivity(env, Infinity).reverse(), ...entries];
  all.sort((a, b) => String(a.at).localeCompare(String(b.at)));
  writeFileAtomic(activityPath(env), all.slice(-ACTIVITY_KEEP).map((e) => JSON.stringify(e)).join('\n') + '\n');
}

// change(entry) returns the entry to keep in its place.
function rewriteActivity(change, env) {
  const all = readActivity(env, Infinity).reverse();
  if (all.length) writeFileAtomic(activityPath(env), all.map((e) => JSON.stringify(change(e))).join('\n') + '\n');
}

// Newest first.
function readActivity(env, limit = 200) {
  let text;
  try {
    text = fs.readFileSync(activityPath(env), 'utf8');
  } catch {
    return [];
  }
  const out = [];
  for (const line of text.split('\n').reverse()) {
    if (!line) continue;
    try {
      out.push(JSON.parse(line));
    } catch { /* damaged line: skip */ }
    if (out.length >= limit) break;
  }
  return out;
}

module.exports = {
  stateHome, configPath, historyPath, registryPath, activityPath, readJson, writeJson,
  DEFAULTS, isV1Config, normalizeConfig, normalizeBackup, loadConfigRaw, saveConfig,
  loadHistory, saveHistory, loadRegistry, saveRegistry, appendActivity, addActivity, rewriteActivity, readActivity,
};
