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
const defaultBackupDir = (env) => path.join(stateHome(env), 'backups');

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
const pad2 = (n) => String(n).padStart(2, '0');

// ---- Settings ---------------------------------------------------------------
const DEFAULTS = {
  version: 2,
  deviceId: null,
  deviceName: null,
  workspaceRoots: [], // folders scanned for *.code-workspace files; the first one is the main repos folder
  backupDir: null, // null: <state folder>/backups
  bundleDirs: [], // extra folders searched for .memsync files (Desktop and Downloads are always searched)
  daily: { enabled: true, time: '12:00', keep: 30 },
  keepBefore: 50,
  includeClaude: true,
  includeScratch: false,
  excludedProjects: [],
  openAtLogin: true,
  runInBackground: true,
  language: null, // interface language ('en', 'tr' ...); null: the system's
  theme: 'system', // 'system', 'light' or 'dark'
};

const isV1Config = (raw) => Boolean(raw) && !raw.version && typeof raw.reposRoot === 'string';

function normalizeConfig(raw) {
  const c = { ...DEFAULTS, ...raw, daily: { ...DEFAULTS.daily, ...(raw && raw.daily) } };
  c.version = 2;
  for (const k of ['workspaceRoots', 'bundleDirs', 'excludedProjects']) c[k] = Array.isArray(c[k]) ? c[k].filter((x) => typeof x === 'string') : [];
  c.daily.keep = Math.max(1, Number(c.daily.keep) || DEFAULTS.daily.keep);
  c.keepBefore = Math.max(1, Number(c.keepBefore) || DEFAULTS.keepBefore);
  if (!/^\d{1,2}:\d{2}$/.test(String(c.daily.time))) c.daily.time = DEFAULTS.daily.time;
  // The backup time is on the 5-minute grid the app checks at: 13:54 becomes 13:55.
  const [h, m] = c.daily.time.split(':').map(Number);
  const minutes = (Math.round((Math.min(h, 23) * 60 + Math.min(m, 59)) / 5) * 5) % (24 * 60);
  c.daily.time = `${pad2(Math.floor(minutes / 60))}:${pad2(minutes % 60)}`;
  if (typeof c.language !== 'string' || !/^[a-z]{2,3}$/.test(c.language)) c.language = null;
  if (!['system', 'light', 'dark'].includes(c.theme)) c.theme = 'system';
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
    lastDaily: r.lastDaily || null,
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
  stateHome, configPath, historyPath, registryPath, activityPath, defaultBackupDir, readJson, writeJson,
  DEFAULTS, isV1Config, normalizeConfig, loadConfigRaw, saveConfig,
  loadHistory, saveHistory, loadRegistry, saveRegistry, appendActivity, readActivity,
};
