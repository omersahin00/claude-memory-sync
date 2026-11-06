'use strict';
// The restore window's list of what each snapshot holds, kept on this computer. Asking restic takes about a second each
// time (the key is derived slowly on purpose), so the folders are read from here and restic is asked only for the files
// themselves. One SQLite file per set, filled from restic ls after each backup (app/catalog-worker.js).
//
// Most files are the same from one snapshot to the next, so a file is not kept once per snapshot: a version of a path
// (its type, size and modification time) is kept once, with the range of snapshots it is in (first and last, by the
// order the snapshots were added, oldest first). A path is in a snapshot when one of its versions' ranges holds it.
// Snapshots removed from the backup folder (forget) leave the ranges as they are: what was in every snapshot of a range
// is still in every snapshot of it that is left.
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { treePath } = require('./repository');

const VERSION = 1;
const TYPES = { dir: 0, file: 1, symlink: 2 };
const TYPE_NAMES = ['dir', 'file', 'symlink', 'other'];
const ROOT = 0;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS snapshots (seq INTEGER PRIMARY KEY, id TEXT UNIQUE NOT NULL, time TEXT NOT NULL, host TEXT, paths TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS names (id INTEGER PRIMARY KEY, parent INTEGER NOT NULL, name TEXT NOT NULL, UNIQUE (parent, name));
CREATE TABLE IF NOT EXISTS versions (path INTEGER NOT NULL, first INTEGER NOT NULL, last INTEGER NOT NULL, type INTEGER NOT NULL, size INTEGER, mtime INTEGER);
CREATE INDEX IF NOT EXISTS versions_by_path ON versions (path, last);
`;

// A snapshot's folders as restic lists them: on Windows C:\Users\x is /C/Users/x (repository.treePath).
const resticPath = (p) => treePath(p);

// The other way, for restoring a file where it was: the path on this computer, or null when it is another system's.
function localPath(p, platform = process.platform) {
  if (platform === 'win32') {
    const m = /^\/([A-Za-z])(\/.*)?$/.exec(p);
    return m ? `${m[1]}:${(m[2] || '/').replace(/\//g, '\\')}` : null;
  }
  return p.startsWith('/') ? p : null;
}

const parts = (p) => p.split('/').filter(Boolean);

function openCatalog(file, { readonly = false } = {}) {
  if (!readonly) fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file, readonly ? { readOnly: true } : {});
  if (!readonly) {
    db.exec('PRAGMA journal_mode = WAL');
    db.exec(SCHEMA);
    const v = db.prepare("SELECT value FROM meta WHERE key = 'version'").get();
    if (!v) db.prepare("INSERT INTO meta (key, value) VALUES ('version', ?)").run(String(VERSION));
  }
  const q = (sql) => db.prepare(sql);

  const snapshotRows = () => q('SELECT seq, id, time, host, paths FROM snapshots ORDER BY seq').all().map((r) => ({ ...r, paths: JSON.parse(r.paths) }));

  // The name ID of a path, or null when no snapshot ever had it.
  function idOf(p) {
    let id = ROOT;
    const find = q('SELECT id FROM names WHERE parent = ? AND name = ?');
    for (const name of parts(p)) {
      const r = find.get(id, name);
      if (!r) return null;
      id = r.id;
    }
    return id;
  }

  // The newest snapshot left in a version's range, or null when none of them is left.
  const lastLeft = q('SELECT seq, id, time FROM snapshots WHERE seq BETWEEN ? AND ? ORDER BY seq DESC LIMIT 1');
  const firstLeft = q('SELECT seq, id, time FROM snapshots WHERE seq BETWEEN ? AND ? ORDER BY seq LIMIT 1');

  const item = (r) => ({ name: r.name, type: TYPE_NAMES[r.type] || 'other', size: r.type === TYPES.file ? r.size : null, mtime: r.mtime ? new Date(r.mtime).toISOString() : null });
  const sorted = (items) => items.sort((a, b) => (a.type === 'dir') === (b.type === 'dir') ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1);

  return {
    file,
    close: () => db.close(),
    snapshots: snapshotRows,

    // The snapshots the backup folder has now (data snapshots, any order): those gone are dropped, with versions no
    // snapshot is left in. Returns the ones still to add, oldest first. When one of them is older than a snapshot
    // already added, the ranges would not hold, so everything is added again.
    sync(list) {
      const have = new Map(snapshotRows().map((s) => [s.id, s]));
      const keep = new Set(list.map((s) => s.id));
      const gone = [...have.values()].filter((s) => !keep.has(s.id));
      if (gone.length) {
        db.exec('BEGIN');
        try {
          for (const s of gone) q('DELETE FROM snapshots WHERE seq = ?').run(s.seq);
          db.exec('DELETE FROM versions WHERE NOT EXISTS (SELECT 1 FROM snapshots s WHERE s.seq BETWEEN versions.first AND versions.last)');
          db.exec('COMMIT');
        } catch (e) {
          db.exec('ROLLBACK');
          throw e;
        }
      }
      const missing = list.filter((s) => !have.has(s.id)).sort((a, b) => Date.parse(a.time) - Date.parse(b.time));
      const newest = snapshotRows().reduce((t, s) => Math.max(t, Date.parse(s.time)), -Infinity);
      if (missing.length && Date.parse(missing[0].time) < newest) {
        db.exec('DELETE FROM versions; DELETE FROM snapshots; DELETE FROM names;');
        return [...list].sort((a, b) => Date.parse(a.time) - Date.parse(b.time));
      }
      return missing;
    },

    // Adds a snapshot, the newest one, from restic ls: begin(), then node(n) for each node, then end(); abort() on a
    // failure leaves the catalog as it was.
    adder(snapshot) {
      const prev = q('SELECT max(seq) AS seq FROM snapshots').get().seq || 0;
      const seq = prev + 1;
      const names = new Map();
      const findName = q('SELECT id FROM names WHERE parent = ? AND name = ?');
      const addName = q('INSERT INTO names (parent, name) VALUES (?, ?)');
      const current = q('SELECT rowid, type, size, mtime FROM versions WHERE path = ? AND last = ?');
      const extend = q('UPDATE versions SET last = ? WHERE rowid = ?');
      const addVersion = q('INSERT INTO versions (path, first, last, type, size, mtime) VALUES (?, ?, ?, ?, ?, ?)');
      const nameId = (parent, name) => {
        const k = `${parent}/${name}`;
        let id = names.get(k);
        if (id !== undefined) return id;
        const r = findName.get(parent, name);
        id = r ? r.id : Number(addName.run(parent, name).lastInsertRowid);
        names.set(k, id);
        return id;
      };
      let count = 0;
      return {
        begin() {
          db.exec('BEGIN');
          q('INSERT INTO snapshots (seq, id, time, host, paths) VALUES (?, ?, ?, ?, ?)').run(seq, snapshot.id, snapshot.time, snapshot.host || null, JSON.stringify(snapshot.paths || []));
        },
        node(n) {
          let parent = ROOT;
          const ps = parts(n.path);
          for (let i = 0; i < ps.length - 1; i++) parent = nameId(parent, ps[i]);
          const id = nameId(parent, ps[ps.length - 1] || n.name);
          const type = TYPES[n.type] ?? 3;
          const size = type === TYPES.file ? n.size || 0 : null;
          const mtime = n.mtime ? Date.parse(n.mtime) || null : null;
          const c = prev ? current.get(id, prev) : null;
          if (c && c.type === type && c.size === size && c.mtime === mtime) extend.run(seq, c.rowid);
          else addVersion.run(id, seq, seq, type, size, mtime);
          count++;
        },
        end() {
          db.exec('COMMIT');
          return count;
        },
        abort() {
          try {
            db.exec('ROLLBACK');
          } catch { /* nothing begun */ }
        },
      };
    },

    // What a folder held in a snapshot. Without a folder: the snapshot's own folders, the sets' sources.
    list(snapshotId, folder = null) {
      const s = q('SELECT seq, paths FROM snapshots WHERE id = ?').get(snapshotId);
      if (!s) return null;
      if (folder == null) {
        return JSON.parse(s.paths).map((p) => {
          const rp = resticPath(p);
          const id = idOf(rp);
          const v = id == null ? null : q('SELECT type, size, mtime FROM versions WHERE path = ? AND first <= ? AND last >= ?').get(id, s.seq, s.seq);
          return { ...item({ name: rp, type: v ? v.type : TYPES.dir, size: v && v.size, mtime: v && v.mtime }), name: path.posix.basename(rp) || rp, path: rp };
        });
      }
      const id = idOf(folder);
      if (id == null) return [];
      const rows = q(`SELECT n.name, v.type, v.size, v.mtime FROM names n JOIN versions v ON v.path = n.id
        WHERE n.parent = ? AND v.first <= ? AND v.last >= ?`).all(id, s.seq, s.seq);
      return sorted(rows.map((r) => ({ ...item(r), path: path.posix.join(folder, r.name) })));
    },

    // What was in the folder in an earlier snapshot but is not in this one, each with the newest snapshot left that has
    // it, to restore it from.
    deleted(snapshotId, folder) {
      const s = q('SELECT seq FROM snapshots WHERE id = ?').get(snapshotId);
      const id = idOf(folder);
      if (!s || id == null) return [];
      const rows = q(`SELECT n.id, n.name, v.type, v.size, v.mtime, v.first, v.last FROM names n JOIN versions v ON v.path = n.id
        WHERE n.parent = ? AND v.last < ? AND NOT EXISTS (SELECT 1 FROM versions w WHERE w.path = n.id AND w.first <= ? AND w.last >= ?)
        ORDER BY v.last DESC`).all(id, s.seq, s.seq, s.seq);
      const out = new Map();
      for (const r of rows) {
        if (out.has(r.name)) continue;
        const from = lastLeft.get(r.first, r.last);
        if (!from) continue;
        out.set(r.name, { ...item(r), path: path.posix.join(folder, r.name), deleted: true, from: { id: from.id, time: from.time } });
      }
      return sorted([...out.values()]);
    },

    // Every version of one path, newest first: when it was first and last seen, and a snapshot to restore it from.
    versions(p) {
      const id = idOf(p);
      if (id == null) return [];
      const rows = q('SELECT type, size, mtime, first, last FROM versions WHERE path = ? ORDER BY first DESC').all(id);
      const out = [];
      for (const r of rows) {
        const a = firstLeft.get(r.first, r.last);
        const b = lastLeft.get(r.first, r.last);
        if (!a) continue;
        out.push({ ...item({ ...r, name: path.posix.basename(p) }), path: p, since: a.time, until: b.time, snapshot: b.id });
      }
      return out;
    },
  };
}

// Brings the catalog up to the backup folder: drops what was forgotten there and adds what is new, one restic ls per
// snapshot. progress({ done, total }) after each one.
async function fill(catalog, { dir, cacheDir, password, keyHint, signal = null, onProgress = () => {} }) {
  const repo = require('./repository');
  const { run } = require('./restic');
  const list = (await repo.snapshots({ dir, cacheDir, password, keyHint })).filter((s) => s.kind === 'data');
  const todo = catalog.sync(list);
  onProgress({ done: 0, total: todo.length });
  for (let i = 0; i < todo.length; i++) {
    const add = catalog.adder(todo[i]);
    add.begin();
    try {
      // A backup's forget or prune may hold the folder for a moment.
      await run(['ls', '--retry-lock', '2m', todo[i].id], {
        repo: dir, cacheDir, password, keyHint, signal,
        onMessage: (m) => m.message_type === 'node' && add.node(m),
      });
      add.end();
    } catch (e) {
      add.abort();
      throw e;
    }
    onProgress({ done: i + 1, total: todo.length });
  }
  return { added: todo.length, snapshots: list.length };
}

module.exports = { openCatalog, fill, resticPath, localPath };
