'use strict';
// One backup or bundle in a process of its own, so the window stays alive however large it is and stopping it is simply ending this
// process. It writes the backup file and nothing else the app relies on: the main process records the result afterwards.
const { createEngine } = require('../lib/engine');

const port = process.parentPort; // not there when a test starts this file with child_process.fork
const send = port ? (message) => port.postMessage(message) : (message) => process.send(message);

// How much of the bar each step takes. Writing compresses, so it takes longest.
const STEPS = { scan: [0, 5], write: [5, 70], verify: [75, 25] };
const EVERY_MS = 100;

function start({ job, engineOptions }) {
  let phase = null;
  let sent = 0;
  // info: { estimate } once it is known, how large the file will be.
  const onProgress = (next, done, total, info = null) => {
    if (!info && next === phase && Date.now() - sent < EVERY_MS) return;
    phase = next;
    sent = Date.now();
    const [from, size] = STEPS[next];
    send({ type: 'progress', phase: next, percent: Math.floor(from + size * (total ? done / total : 0)), ...info });
  };
  try {
    send({ type: 'done', result: createEngine(engineOptions).runBackupJob(job, onProgress) });
  } catch (e) {
    send({ type: 'error', error: { code: e.code || 'ERROR', message: e.message, path: e.path, detail: e.detail, need: e.need, free: e.free, reserve: e.reserve } });
  }
}

if (port) port.once('message', (e) => start(e.data));
else process.once('message', start);
