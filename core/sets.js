'use strict';
// Backup sets: what is backed up, where to, and when. A set has a name, source folders, exclusions, a backup folder
// (one restic repository of its own) and a schedule. The sets and the app's settings are kept in one file in the app's
// data folder, written whole into a new file that then takes the old one's place, so a crash never leaves half a file.
// Passwords are not in it: they are kept apart, encrypted by the system (lib/secrets.js).
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { BackupError } = require('./errors');
const schedule = require('./schedule');

const FILE = 'sets.json';
const VERSION = 1;
// The folder a new set's backup folder is made in, inside the place chosen for it: named after the app, which says so once
// when it starts (setParentFolder). This engine is shared: Claude Memory Sync takes it from here as its core/.
let PARENT = 'Folder Backup';
const parentFolder = () => PARENT;
function setParentFolder(name) {
  if (typeof name !== 'string' || !name.trim() || /[\\/]/.test(name)) throw new Error(`Not a folder name: ${name}`);
  PARENT = name.trim();
}
// Time Machine's way: every backup of the last 24 hours, one a day for a month, one a week after that.
const DEFAULT_KEEP = { hours: 24, days: 30, weeks: 'all' };
// What the systems write into folders to draw them (icon positions, thumbnails); nothing anyone made.
const DEFAULT_EXCLUDES = ['.DS_Store', 'Thumbs.db', 'desktop.ini'];
const DEFAULT_APP = { language: null, theme: 'system', runInBackground: true, openAtLogin: true };

const caseless = process.platform === 'darwin' || process.platform === 'win32';
const key = (p) => (caseless ? p.toLowerCase() : p);

// A path as the system knows it (/tmp is /private/tmp on a Mac), also for one that is not there yet.
function real(p) {
  let at = path.resolve(p);
  const rest = [];
  while (!fs.existsSync(at) && path.dirname(at) !== at) {
    rest.unshift(path.basename(at));
    at = path.dirname(at);
  }
  try {
    at = fs.realpathSync.native(at);
  } catch { /* as given */ }
  return path.join(at, ...rest);
}

// Whether inner is outer or inside it.
function within(inner, outer) {
  const a = key(real(inner));
  const b = key(real(outer));
  return a === b || a.startsWith(b.endsWith(path.sep) ? b : b + path.sep);
}

// A name that works as a folder name on both systems.
function folderName(name) {
  const s = String(name).replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-').replace(/[. ]+$/, '').trim();
  return s || 'Backup';
}

const repoFolderFor = (place, name) => path.join(place, PARENT, folderName(name));

function invalid(field, message) {
  return new BackupError('INVALID', message, { field });
}

// A set's definition as the user gave it, checked and tidied. Throws INVALID (with the field), SOURCES_NESTED,
// TARGET_IN_SOURCE or SOURCE_IN_TARGET.
// allowNoSources: for a set opened from a backup folder whose folders are not on this computer; it backs up nothing
// until folders are chosen.
function normalizeDefinition(def, { repo = def.repo, allowNoSources = false } = {}) {
  const name = String(def.name || '').trim();
  if (!name || name.length > 80) throw invalid('name', 'A set needs a name of at most 80 characters.');
  const sources = [];
  for (const s of def.sources || []) {
    if (typeof s !== 'string' || !path.isAbsolute(s)) throw invalid('sources', `Not an absolute path: ${s}`);
    const p = path.resolve(s);
    if (!sources.some((x) => key(x) === key(p))) sources.push(p);
  }
  if (!sources.length && !allowNoSources) throw new BackupError('NO_SOURCES', 'Nothing was chosen to back up.');
  for (const a of sources) {
    for (const b of sources) {
      if (a !== b && within(a, b)) throw new BackupError('SOURCES_NESTED', `${a} is inside ${b}.`, { path: a, detail: b });
    }
  }
  if (repo) {
    for (const s of sources) {
      // A backup folder inside what it backs up would back itself up, larger every time.
      if (within(repo, s)) throw new BackupError('TARGET_IN_SOURCE', `The backup folder ${repo} is inside ${s}.`, { path: s });
      if (within(s, repo)) throw new BackupError('SOURCE_IN_TARGET', `${s} is inside the backup folder ${repo}.`, { path: s });
    }
  }
  const excludes = [...new Set((def.excludes || []).map((e) => String(e).trim()).filter(Boolean))];
  const keep = { ...DEFAULT_KEEP, ...(def.keep || {}) };
  return { name, sources, excludes, schedule: schedule.normalize(def.schedule), keep };
}

// A set another app made with this engine (Claude Memory Sync's) says so, and how its snapshots are told apart:
//   owner       the app that made it and alone backs it up ('claude-memory-sync'); a set of this app has none
//   tag         the tag its backups carry; only those are thinned out by keep
//   keepTagged  { [tag]: n }: of the snapshots with that tag, the newest n stay (snapshots it takes for itself)
const MODULE_FIELDS = ['owner', 'tag', 'keepTagged'];
const moduleFields = (set) => Object.fromEntries(MODULE_FIELDS.filter((k) => set[k] != null).map((k) => [k, set[k]]));

// What goes into the backup folder (repository.writeDefinition): everything needed to set the set up again, no secret.
// A full backup's says so (full), and which set it was taken of.
function definitionOf(set) {
  return {
    format: 'folder-backup-set', version: VERSION,
    name: set.name, sources: set.sources, excludes: set.excludes, schedule: set.schedule, keep: set.keep,
    platform: process.platform, createdAt: set.createdAt,
    ...moduleFields(set),
    ...(set.full ? { full: { setName: set.full.setName, ofRepo: set.full.ofRepo, at: set.full.at } } : {}),
  };
}

// A full backup (jobs.takeFullBackup) is kept in the list like a set, so the restore window, the check and Open existing
// work on it as they do on a set. It is never backed up into again (schedule off, and the app refuses it), never thinned
// and never deleted by the app. full: { setName, ofRepo, at }: the set it was taken of, by its backup folder's ID, which
// stays the same on every computer, and the moment of its snapshot.
const FULL_NAME_MAX = 76;

// Its name, also its folder's: label(name) puts the set's name into the words around it. The set's name is shortened when
// the whole would be too long for a name (80, with room for a ' 2' when the folder is there already).
function fullBackupName(setName, label) {
  let base = folderName(setName);
  const over = folderName(label(base)).length - FULL_NAME_MAX;
  if (over > 0) base = base.slice(0, Math.max(1, base.length - over)).trim();
  return folderName(label(base));
}

function newFullBackup(of, { name, repo, repoId, passwordKey, at }) {
  const set = newSet({ name, sources: of.sources, excludes: of.excludes, schedule: { every: 'off' }, keep: of.keep }, { repo, repoId, passwordKey });
  set.full = { setName: of.name, ofRepo: of.repoId || null, at };
  return set;
}

const definitionHash = (def) => {
  const { name, sources, excludes, schedule: sch, keep } = def;
  return crypto.createHash('sha256').update(JSON.stringify({ name, sources, excludes, sch, keep, ...moduleFields(def) })).digest('hex');
};

// A name for this computer that does not change: restic keeps it with every snapshot and finds the previous backup by it.
function hostName() {
  const h = os.hostname().replace(/\.local$/i, '').replace(/[^A-Za-z0-9._-]/g, '-');
  return h || 'computer';
}

function createStore(dataDir) {
  const file = path.join(dataDir, FILE);
  let data = null;

  function load() {
    if (data) return data;
    let read = null;
    try {
      read = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
      if (e.code !== 'ENOENT') {
        // An unreadable file is kept aside, not overwritten: the backups themselves are never in it.
        const aside = `${file}.unreadable-${Date.now()}`;
        try {
          fs.renameSync(file, aside);
        } catch { /* left where it is */ }
      }
    }
    data = {
      version: VERSION,
      device: { host: (read && read.device && read.device.host) || hostName() },
      app: { ...DEFAULT_APP, ...((read && read.app) || {}) },
      sets: Array.isArray(read && read.sets) ? read.sets : [],
    };
    if (!read) save();
    return data;
  }

  function save() {
    fs.mkdirSync(dataDir, { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    const fd = fs.openSync(tmp, 'w', 0o600);
    try {
      fs.writeSync(fd, JSON.stringify(data, null, 2));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, file);
  }

  const find = (id) => {
    const s = load().sets.find((x) => x.id === id);
    if (!s) throw new BackupError('NO_SET', `There is no backup set ${id}.`);
    return s;
  };

  return {
    file,
    // Read again from the file at the next call: another process (a full restore of the app's own files) replaced it.
    reload() {
      data = null;
    },
    device: () => load().device,
    app: () => load().app,
    updateApp(patch) {
      const d = load();
      d.app = { ...d.app, ...patch };
      save();
      return d.app;
    },
    list: () => load().sets.map((s) => structuredClone(s)),
    get: (id) => structuredClone(find(id)),
    // set: from newSet. Two sets cannot share one backup folder.
    add(set) {
      const d = load();
      if (d.sets.some((s) => (set.repoId && s.repoId === set.repoId) || key(real(s.repo)) === key(real(set.repo)))) {
        throw new BackupError('ALREADY_ADDED', `This backup folder is already a backup set: ${set.repo}`, { path: set.repo });
      }
      d.sets.push(structuredClone(set));
      save();
      return structuredClone(set);
    },
    // The definition (name, folders, exclusions, schedule), checked again.
    updateDefinition(id, patch) {
      const s = find(id);
      const def = normalizeDefinition({ ...s, ...patch }, { repo: s.repo });
      Object.assign(s, def);
      save();
      return structuredClone(s);
    },
    // fn(state) changes the set's state in place.
    updateState(id, fn) {
      const s = find(id);
      s.state = s.state || {};
      fn(s.state);
      save();
      return structuredClone(s);
    },
    update(id, patch) {
      Object.assign(find(id), patch);
      save();
      return structuredClone(find(id));
    },
    remove(id) {
      const d = load();
      find(id);
      d.sets = d.sets.filter((s) => s.id !== id);
      save();
    },
  };
}

// fields: owner, tag and keepTagged of a set another app makes (MODULE_FIELDS).
function newSet(def, { repo, repoId, passwordKey, allowNoSources = false, fields = {} }) {
  return {
    id: crypto.randomUUID(), ...normalizeDefinition(def, { repo, allowNoSources }), repo, repoId, passwordKey,
    ...moduleFields(fields), createdAt: new Date().toISOString(), state: { checkPart: 1 },
  };
}

module.exports = {
  createStore, newSet, newFullBackup, fullBackupName, normalizeDefinition, definitionOf, definitionHash, repoFolderFor, folderName,
  within, real, hostName, moduleFields, DEFAULT_KEEP, DEFAULT_EXCLUDES, parentFolder, setParentFolder,
};
