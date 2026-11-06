'use strict';
// The apps built on this engine: Folder Backup, whose lib/ it is, and Claude Memory Sync, which takes it as its core/.
// Each keeps its sets in its own data folder, which the other finds here (lib/peers.js).
const os = require('os');
const path = require('path');

const APPS = {
  'folder-backup': {
    name: 'Folder Backup',
    // Electron's userData folder of the app.
    dataDir: ({ home = os.homedir(), platform = process.platform, env = process.env } = {}) => {
      if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'Folder Backup');
      if (platform === 'win32') return path.join(env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'Folder Backup');
      return path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'Folder Backup');
    },
  },
  'claude-memory-sync': {
    name: 'Claude Memory Sync',
    dataDir: ({ home = os.homedir(), env = process.env } = {}) => (env.CLAUDE_MEMORY_SYNC_HOME ? path.resolve(env.CLAUDE_MEMORY_SYNC_HOME) : path.join(home, '.claude-memory-sync')),
  },
};

const appName = (id) => (APPS[id] ? APPS[id].name : String(id || ''));

// Where an app keeps its data. PEER_DIR_<ID> (PEER_DIR_CLAUDE_MEMORY_SYNC) points elsewhere, for screenshots and tests.
function dataDirOf(id, { home, platform, env = process.env } = {}) {
  const override = env[`PEER_DIR_${String(id).toUpperCase().replace(/-/g, '_')}`];
  if (override) return path.resolve(override);
  return APPS[id] ? APPS[id].dataDir({ home, platform, env }) : null;
}

module.exports = { APPS, appName, dataDirOf };
