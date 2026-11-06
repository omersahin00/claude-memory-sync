'use strict';
// The apps built on this engine see each other when both are on one computer (lib/apps.js). Each keeps its own sets in
// its own data folder and is the only one that backs them up or changes them: their owner. The other app reads them and
// asks the owner for what it wants done. In the owner's data folder:
//   sets.json             its sets and their state (lib/sets.js), only read by the other app
//   peer.json             written by the owner: who it is, whether it runs (a beat every BEAT_MS while it does), the job it
//                         is doing, and for each set what sets.json does not tell (its status, its next backup, a summary
//                         of what it backs up)
//   requests/<id>.json    written by the other app: { id, from, at, setId, action, args }
//   responses/<id>.json   the owner's answer: { id, ok, value | error, at }
// A request waits in its folder until the owner handles it, which it does as it comes and when it starts. Every file is
// written whole into a new file that then takes its name, so nothing is ever read half written.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { APPS, appName, dataDirOf } = require('./apps');

const PEER_FILE = 'peer.json';
const SETS_FILE = 'sets.json';
const REQUESTS = 'requests';
const RESPONSES = 'responses';
const BEAT_MS = 30 * 1000;
// A beat older than this is an app that is not running (it quit without saying so, or the computer slept).
const ALIVE_MS = 3 * BEAT_MS;
const POLL_MS = 5 * 1000;
// While a job runs, what it is doing is written at most this often.
const PUBLISH_MS = 1000;
// Answers nobody came for, and requests the owner never took (it was uninstalled), go after a day.
const STALE_MS = 24 * 60 * 60 * 1000;

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

const alive = (pid) => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
};

const isRequestName = (n) => /^[\w-]+\.json$/.test(n);

// ---- The owner's side ----------------------------------------------------------------
// self: this app's id; dataDir: its data folder. info() gives what peer.json says besides who and whether it runs:
// { version, exe, job, sets: { [setId]: { ... } } }.
function createOwner({ self, dataDir, info = () => ({}), now = () => new Date() }) {
  const file = path.join(dataDir, PEER_FILE);
  const requests = path.join(dataDir, REQUESTS);
  const responses = path.join(dataDir, RESPONSES);
  const startedAt = now().toISOString();
  let timer = null;
  let watcher = null;
  let poll = null;
  let busy = false;
  let again = false;
  let publishedAt = 0;
  let soon = null;

  function publish(running = true) {
    publishedAt = Date.now();
    const extra = info() || {};
    writeJson(file, {
      app: self, name: appName(self), pid: process.pid, platform: process.platform, startedAt,
      beat: running ? now().toISOString() : null, running, ...extra,
    });
  }

  // publish, but not more often than PUBLISH_MS: the last change within that time is written when it is over.
  function publishSoon() {
    clearTimeout(soon);
    const wait = PUBLISH_MS - (Date.now() - publishedAt);
    if (wait > 0) {
      soon = setTimeout(publishSoon, wait);
      if (soon.unref) soon.unref();
      return;
    }
    try {
      publish();
    } catch { /* the next beat */ }
  }

  function sweep() {
    for (const dir of [requests, responses]) {
      let names = [];
      try {
        names = fs.readdirSync(dir);
      } catch {
        continue;
      }
      for (const n of names) {
        try {
          const abs = path.join(dir, n);
          if (now() - fs.statSync(abs).mtimeMs > STALE_MS) fs.rmSync(abs, { force: true });
        } catch { /* gone */ }
      }
    }
  }

  // Handles every request that is waiting, oldest first. handler(request) answers with a value or throws; the request
  // is claimed first (renamed), so two processes of the app never handle one twice.
  async function take(handler) {
    if (busy) {
      again = true;
      return 0;
    }
    busy = true;
    let count = 0;
    try {
      do {
        again = false;
        let names = [];
        try {
          names = fs.readdirSync(requests).filter(isRequestName).sort();
        } catch {
          names = [];
        }
        for (const n of names) {
          const abs = path.join(requests, n);
          const claimed = `${abs}.taken`;
          try {
            fs.renameSync(abs, claimed);
          } catch {
            continue;
          }
          const req = readJson(claimed);
          fs.rmSync(claimed, { force: true });
          if (!req || typeof req.id !== 'string' || !isRequestName(`${req.id}.json`)) continue;
          let answer;
          try {
            answer = { id: req.id, ok: true, value: (await handler(req)) ?? null, at: now().toISOString() };
          } catch (e) {
            answer = { id: req.id, ok: false, error: { code: e.code || 'ERROR', message: e.message, ...(e.path ? { path: e.path } : {}), ...(e.detail ? { detail: e.detail } : {}) }, at: now().toISOString() };
          }
          writeJson(path.join(responses, `${req.id}.json`), answer);
          count++;
        }
      } while (again);
    } finally {
      busy = false;
    }
    return count;
  }

  // Publishes itself now and every BEAT_MS, and handles requests as they come (a watch on the folder, and a look every
  // POLL_MS, since a watch can miss one).
  function start(handler) {
    fs.mkdirSync(requests, { recursive: true });
    sweep();
    publish();
    const run = () => take(handler).catch(() => {});
    run();
    timer = setInterval(() => {
      try {
        publish();
      } catch { /* the next beat */ }
    }, BEAT_MS);
    poll = setInterval(run, POLL_MS);
    try {
      watcher = fs.watch(requests, () => run());
    } catch { /* the look every few seconds is enough */ }
    for (const t of [timer, poll]) if (t.unref) t.unref();
  }

  function stop() {
    clearInterval(timer);
    clearInterval(poll);
    clearTimeout(soon);
    if (watcher) watcher.close();
    try {
      publish(false);
    } catch { /* the beat stops anyway */ }
  }

  return { publish, publishSoon, take, start, stop, file };
}

// ---- The other app's side -------------------------------------------------------------
// What another app built on this engine has on this computer, read only. null when it was never run here.
function readPeer(id, { home, platform, env } = {}) {
  const dir = dataDirOf(id, { home, platform, env });
  if (!dir) return null;
  const info = readJson(path.join(dir, PEER_FILE));
  const store = readJson(path.join(dir, SETS_FILE));
  if (!info && !store) return null;
  const beat = info && info.beat ? Date.parse(info.beat) : null;
  const running = Boolean(info && info.running && beat && Date.now() - beat < ALIVE_MS && alive(info.pid));
  return {
    id, name: appName(id), dataDir: dir, running, info: info || {},
    sets: Array.isArray(store && store.sets) ? store.sets : [],
  };
}

// Asks the owner (its data folder) for something and waits up to timeout for the answer. Resolves to { answered: true,
// ok, value, error } or, when no answer came in time, { answered: false, id }: the request then stays and is handled when
// the owner runs.
async function ask(dataDir, { from, setId = null, action, args = {}, timeout = 15000, pollMs = 150 }) {
  const id = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}`;
  writeJson(path.join(dataDir, REQUESTS, `${id}.json`), { id, from, at: new Date().toISOString(), setId, action, args });
  const answer = path.join(dataDir, RESPONSES, `${id}.json`);
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    const a = readJson(answer);
    if (a) {
      fs.rmSync(answer, { force: true });
      return { answered: true, ok: Boolean(a.ok), value: a.value ?? null, error: a.error || null };
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
  return { answered: false, id };
}

// Starts the other app from where it last ran (peer.json exe): in the background with its window closed, or with
// hidden false in front.
function launch(peer, { hidden = true } = {}) {
  const exe = peer && peer.info && peer.info.exe;
  if (typeof exe !== 'string' || !fs.existsSync(exe)) return false;
  const bundle = process.platform === 'darwin' ? /^(.*?\.app)\/Contents\/MacOS\//.exec(exe) : null;
  const args = hidden ? ['--hidden'] : [];
  const child = bundle
    ? spawn('open', [...(hidden ? ['-g'] : []), '-a', bundle[1], ...(args.length ? ['--args', ...args] : [])], { detached: true, stdio: 'ignore' })
    : spawn(exe, args, { detached: true, stdio: 'ignore', windowsHide: true });
  child.on('error', () => {});
  child.unref();
  return true;
}

module.exports = { createOwner, readPeer, ask, launch, APPS, BEAT_MS, ALIVE_MS };
