'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { writeFileAtomic } = require('./fsx');

function stateHome(env = process.env) {
  return env.CLAUDE_MEMORY_SYNC_HOME ? path.resolve(env.CLAUDE_MEMORY_SYNC_HOME) : path.join(os.homedir(), '.claude-memory-sync');
}
const configPath = () => path.join(stateHome(), 'config.json');
const historyPath = () => path.join(stateHome(), 'history.json');
const backupDir = () => path.join(stateHome(), 'backups');

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
    throw new Error(`${p} is corrupt (${e.message}). Fix it, or delete it and run "node cli.js config".`);
  }
}

const writeJson = (p, obj) => writeFileAtomic(p, JSON.stringify(obj, null, 2) + '\n');

function loadConfig() {
  const cfg = readJson(configPath(), null);
  if (!cfg) return null;
  for (const k of ['deviceId', 'deviceName', 'reposRoot', 'prefix']) {
    if (!cfg[k]) throw new Error(`"${k}" is missing in ${configPath()}. Run "node cli.js config".`);
  }
  return cfg;
}

function newConfig({ reposRoot, deviceName, prefix, deviceId }) {
  return { deviceId: deviceId || crypto.randomUUID(), deviceName, reposRoot, prefix };
}

const saveConfig = (cfg) => writeJson(configPath(), cfg);

// history: key -> every content hash this device has seen or accepted
function loadHistory() {
  const obj = readJson(historyPath(), { version: 1, keys: {} });
  const map = new Map();
  for (const [k, arr] of Object.entries(obj.keys || {})) map.set(k, new Set(arr));
  return map;
}

function saveHistory(map) {
  const keys = {};
  for (const k of [...map.keys()].sort()) keys[k] = [...map.get(k)];
  writeJson(historyPath(), { version: 1, keys });
}

module.exports = { stateHome, configPath, historyPath, backupDir, loadConfig, newConfig, saveConfig, loadHistory, saveHistory };
