'use strict';
// Runs restic, the program that writes and reads the backups (scripts/fetch-restic.js puts it in vendor/restic). Each
// call is one restic process: its JSON lines are handed over as they come, and its exit code says how it ended. The
// password reaches restic through its environment, never the command line, and RESTIC_* settings of the user's own shell
// are not passed on, so they cannot point a backup at another place or password.
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { BackupError } = require('./errors');

const EXE = process.platform === 'win32' ? 'restic.exe' : 'restic';
const OS = { darwin: 'mac', win32: 'win' }[process.platform] || process.platform;

function resticPath() {
  if (process.env.FOLDER_BACKUP_RESTIC) return process.env.FOLDER_BACKUP_RESTIC;
  // The installed app has it in its resources (package.json: build.extraResources).
  if (process.resourcesPath) {
    const packaged = path.join(process.resourcesPath, 'restic', EXE);
    if (fs.existsSync(packaged)) return packaged;
  }
  return path.join(__dirname, '..', 'vendor', 'restic', `${OS}-${process.arch}`, EXE);
}

// restic's exit codes (restic 0.17 and later); any other code is a failure.
const EXIT_CODES = { 3: 'INCOMPLETE', 10: 'REPO_NOT_FOUND', 11: 'REPO_LOCKED', 12: 'WRONG_PASSWORD', 130: 'CANCELLED' };
// After SIGINT restic removes its lock and ends; one that has not ended by then is ended hard.
const STOP_GRACE_MS = 10000;
const TEXT_KEEP = 8000;

function environment({ repo, password, cacheDir, keyHint, from }) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('RESTIC_')) env[k] = v;
  if (repo) env.RESTIC_REPOSITORY = repo;
  if (password != null) env.RESTIC_PASSWORD = password;
  if (cacheDir) env.RESTIC_CACHE_DIR = cacheDir;
  // Opening a backup folder derives a key from the password, on purpose slow (about a second). The hint names the key to
  // try first, so the recovery code's key is not tried and failed every time.
  if (keyHint) env.RESTIC_KEY_HINT = keyHint;
  // The backup folder that copy and init --copy-chunker-params read from. restic takes its password from
  // RESTIC_FROM_PASSWORD too, though its help names only the file and the command.
  if (from) {
    env.RESTIC_FROM_REPOSITORY = from.dir;
    env.RESTIC_FROM_PASSWORD = from.password;
    if (from.keyHint) env.RESTIC_FROM_KEY_HINT = from.keyHint;
  }
  // Progress four times a second; without it restic reports rarely when its output is not a terminal.
  env.RESTIC_PROGRESS_FPS = '4';
  return env;
}

// args: restic's arguments, without --json. Options:
//   repo, password, cacheDir   where the backup folder is, its password, restic's cache folder
//   keyHint                    the ID of the key the password belongs to (repository.keys), tried first
//   from                       { dir, password, keyHint } of the backup folder copy reads from
//   onMessage(message)         each JSON line of the output, as it comes; then the lines are not kept
//   onOutput(chunk)            the raw output instead of JSON lines (restic dump)
//   onText(line)               each line of the output that is not JSON, as it comes (prune answers only in text)
//   input                      a string or Buffer given to restic on its standard input (backup --stdin)
//   cwd                        the folder restic runs in; otherwise the app's own, which is '/' and cannot be written
//                              when the app is opened from the Finder. Only repair packs writes there.
//   signal                    an AbortSignal that stops restic: SIGINT, so it cleans up after itself, then SIGKILL if it
//                              has not ended in 10 seconds. On Windows a process is always ended hard; the lock it leaves
//                              behind is removed by unlock.
//   okCodes                    exit codes that are no error, e.g. 3 for a backup that could not read some files
// Resolves to { code, messages, summary, errors, text }: the JSON lines (without onMessage), the last summary message,
// restic's error messages ({ message, item, during }) and the lines that were not JSON.
function run(args, { repo, password, cacheDir, keyHint, from = null, onMessage = null, onOutput = null, onText = null, input = null, cwd = undefined, signal = null, okCodes = [0] } = {}) {
  return new Promise((resolve, reject) => {
    const exe = resticPath();
    if (!fs.existsSync(exe)) {
      reject(new BackupError('RESTIC_MISSING', `restic was not found: ${exe}. Run npm run restic.`));
      return;
    }
    if (signal && signal.aborted) {
      reject(new BackupError('CANCELLED', 'Stopped before restic started.'));
      return;
    }
    const child = spawn(exe, onOutput ? args : [...args, '--json'], { cwd, env: environment({ repo, password, cacheDir, keyHint, from }), stdio: [input == null ? 'ignore' : 'pipe', 'pipe', 'pipe'], windowsHide: true });
    if (input != null) {
      // restic may end before it has read everything (a wrong password): that is told by its exit code, not here.
      child.stdin.on('error', () => {});
      child.stdin.end(input);
    }
    const messages = [];
    const errors = [];
    const text = [];
    let summary = null;
    let exitError = null;
    let stderrText = '';
    let out = '';
    let err = '';
    let killTimer = null;

    const stop = () => {
      if (process.platform === 'win32') child.kill();
      else {
        child.kill('SIGINT');
        killTimer = setTimeout(() => child.kill('SIGKILL'), STOP_GRACE_MS);
      }
    };
    if (signal) signal.addEventListener('abort', stop, { once: true });

    const takeOut = (line) => {
      if (!line.trim()) return;
      let m;
      try {
        m = JSON.parse(line);
      } catch {
        // Some commands answer in plain text even with --json ("saved new key with ID ...").
        if (onText) onText(line);
        if (text.length < 1000) text.push(line);
        return;
      }
      if (m && m.message_type === 'summary') summary = m;
      if (onMessage) onMessage(m);
      else messages.push(m);
    };
    const takeErr = (line) => {
      if (!line.trim()) return;
      try {
        const m = JSON.parse(line);
        if (m.message_type === 'exit_error') exitError = m;
        else if (m.message_type === 'error') errors.push({ message: m.error && m.error.message, item: m.item || null, during: m.during || null });
        return;
      } catch { /* plain text: kept for the error message */ }
      stderrText = (stderrText + line + '\n').slice(-TEXT_KEEP);
    };
    const lines = (buffer, chunk, take) => {
      let rest = buffer + chunk;
      let i;
      while ((i = rest.indexOf('\n')) >= 0) {
        take(rest.slice(0, i));
        rest = rest.slice(i + 1);
      }
      return rest;
    };

    child.stdout.on('data', (d) => {
      if (onOutput) onOutput(d);
      else out = lines(out, d.toString('utf8'), takeOut);
    });
    child.stderr.on('data', (d) => {
      err = lines(err, d.toString('utf8'), takeErr);
    });
    child.on('error', (e) => {
      clearTimeout(killTimer);
      reject(new BackupError('RESTIC_FAILED', `restic could not start: ${e.message}`));
    });
    child.on('close', (code, sig) => {
      clearTimeout(killTimer);
      if (signal) signal.removeEventListener('abort', stop);
      takeOut(out);
      takeErr(err);
      const result = { code, messages, summary, errors, text };
      if (okCodes.includes(code)) {
        resolve(result);
        return;
      }
      const name = (signal && signal.aborted) || sig ? 'CANCELLED' : EXIT_CODES[code] || 'RESTIC_FAILED';
      const message = (exitError && exitError.message) || stderrText.trim().split('\n').slice(-3).join('\n') || `restic ended with ${code ?? sig}`;
      reject(new BackupError(name, message, { exitCode: code, errors, summary }));
    });
  });
}

// Windows: whether restic can read through shadow copies of the disks (Volume Shadow Copy), which hold every file as it
// was at one moment, also the ones other programs keep open and locked. restic needs administrator rights for them and
// refuses the whole backup without, so they are asked for only when this process has those rights: "net session"
// answers only an administrator. Once restic could not start the service after all, not again until the app starts
// again. FOLDER_BACKUP_VSS=0 turns them off.
let shadowCopies = null;
function fsSnapshotAvailable() {
  if (process.platform !== 'win32' || process.env.FOLDER_BACKUP_VSS === '0') return false;
  if (shadowCopies === null) shadowCopies = spawnSync('net', ['session'], { windowsHide: true, stdio: 'ignore', timeout: 10000 }).status === 0;
  return shadowCopies;
}
const shadowCopyRefused = () => {
  shadowCopies = false;
};

async function version() {
  const { messages } = await run(['version']);
  return messages[0] ? messages[0].version : null;
}

module.exports = { run, version, resticPath, fsSnapshotAvailable, shadowCopyRefused, EXIT_CODES };
