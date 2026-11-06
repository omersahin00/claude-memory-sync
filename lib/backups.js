'use strict';
// This device's backups: one backup set of the engine this app shares with Folder Backup (core/, docs/TASARIM.md), the
// Claude set. Its backup folder is a restic repository, encrypted, which only its password and its recovery code open;
// every backup stores only what changed. What it backs up is the stage folder (lib/stage.js), which the engine fills
// right before each snapshot. Two kinds of snapshot, told apart by their tags:
//   claude-memory-sync:backup   scheduled and manual backups: what Backup contents leaves in, thinned out the way Time
//                               Machine does (every one of the last day, one a day for a month, one a week after that)
//   claude-memory-sync:before   before every import, restore, undo and workspace fix: every memory, workspace file and
//                               Claude setting; the newest keepBefore stay
// The set belongs to this app: Folder Backup, when it is on this computer too, shows it and asks this app for changes
// (core/peers.js), and never backs it up itself.
const fs = require('fs');
const os = require('os');
const path = require('path');
const sets = require('../core/sets');
const jobs = require('../core/jobs');
const repo = require('../core/repository');
const schedule = require('../core/schedule');
const space = require('../core/space');
const { createSecrets } = require('../core/secrets');
const { BackupError } = require('../core/errors');

const OWNER = 'claude-memory-sync';
const TAG = `${OWNER}:backup`;
const BEFORE = `${OWNER}:before`;
const REASON = `${OWNER}:reason=`;
const SET_NAME = 'Claude';
const KEEP_BEFORE = 50;
const DEFAULT_SCHEDULE = { every: 'daily', time: '12:00', weekday: 1 };
// The backup folders this app makes: <place>/Claude Memory Sync/Claude.
sets.setParentFolder('Claude Memory Sync');

const exists = (p) => {
  try {
    fs.statSync(p);
    return true;
  } catch {
    return false;
  }
};

// stateHome: the app's folder (sets.json, secrets.json and restic's cache go there, next to the stage folder).
// codec: how passwords are kept (core/secrets.js): the system's (Electron safeStorage) in the app.
// fill(dir, { kind, reason }): the engine writes what this backup takes into dir (lib/stage.js writeStage).
// host: the name this computer's snapshots are saved under.
// password: where the password comes from instead of the saved one, when it gives one (the command line: an environment
// variable, since it cannot decrypt what the app saved).
function createBackups({ stateHome, codec, fill, host = null, home = os.homedir(), password: given = null }) {
  const store = sets.createStore(stateHome);
  const secrets = createSecrets(stateHome, codec);
  const cacheDir = path.join(stateHome, 'cache');
  const stageDir = path.join(stateHome, SET_NAME);
  const restoredRoot = path.join(stateHome, 'restored');
  const hostName = () => host || store.device().host;
  // The newest list of snapshots read, so the window and the activity list do not wait for restic.
  let listed = null;

  const current = () => store.list().find((s) => s.owner === OWNER) || null;
  function need() {
    const s = current();
    if (!s) throw new BackupError('NO_BACKUP_SET', 'Backups are not set up yet.');
    return s;
  }

  // A password the system would not give back (the Keychain was refused) is not asked for again by scheduled backups,
  // which would show the system's question every few minutes; the window asks for it once.
  function passwordOf(set) {
    const p0 = given ? given() : null;
    if (p0) return p0;
    if (set.state && set.state.secretBlocked) throw new BackupError('SECRET_UNREADABLE', 'The saved password could not be decrypted.');
    let p;
    try {
      p = secrets.get(set.id);
    } catch (e) {
      if (e.code === 'SECRET_UNREADABLE') store.updateState(set.id, (st) => { st.secretBlocked = new Date().toISOString(); });
      throw e;
    }
    if (!p) throw new BackupError('NO_SAVED_PASSWORD', 'The password of the backups is not saved on this computer.');
    return p;
  }
  const optsOf = (set, password) => ({ dir: set.repo, cacheDir, password, keyHint: set.passwordKey });

  function statusOf(set, running = false) {
    const st = set.state || {};
    if (running) return 'running';
    if (!(given && given()) && (!secrets.has(set.id) || st.secretBlocked)) return 'noPassword';
    if (!exists(set.repo)) return 'targetMissing';
    if (st.damaged) return 'damaged';
    if (st.lastFailure && (!st.lastSuccessAt || Date.parse(st.lastFailure.at) > Date.parse(st.lastSuccessAt))) return 'failed';
    if (!st.lastSuccessAt) return 'never';
    if (st.last && st.last.incomplete) return 'incomplete';
    return 'ok';
  }

  // What the window (and Folder Backup) shows of the set; null when there is none.
  function view(running = false) {
    const set = current();
    if (!set) return null;
    const next = schedule.nextRun(set.schedule, set.state || {});
    const parent = path.dirname(set.repo);
    return {
      id: set.id, name: set.name, repo: set.repo, place: path.basename(parent) === sets.parentFolder() ? path.dirname(parent) : parent,
      repoId: set.repoId, schedule: set.schedule, keep: set.keep, keepBefore: (set.keepTagged || {})[BEFORE] || KEEP_BEFORE,
      createdAt: set.createdAt, state: set.state || {}, status: statusOf(set, running), nextRun: next ? next.toISOString() : null,
      targetPresent: exists(set.repo), passwordSaved: secrets.has(set.id), secretsAvailable: secrets.available(),
    };
  }

  const fields = (keepBefore = KEEP_BEFORE) => ({ owner: OWNER, tag: TAG, keepTagged: { [BEFORE]: Math.max(1, Math.floor(keepBefore)) } });

  // Where the backup folder will be in place, and whether it can be made there (core/jobs.js targetInfo).
  const targetInfo = (place) => jobs.targetInfo(place, SET_NAME, { home });

  // A new backup folder in place (place/Claude Memory Sync/Claude), with the password and a recovery code. The recovery
  // code is shown to the user once and kept nowhere. There is only one Claude set: a second is refused.
  async function setUp({ place, password, schedule: sch = DEFAULT_SCHEDULE }) {
    if (current()) throw new BackupError('BACKUP_SET_EXISTS', 'Backups are set up already.');
    if (!secrets.available() && !given) throw new BackupError('SECRET_STORE_UNAVAILABLE', 'This system cannot keep the password encrypted.');
    fs.mkdirSync(stageDir, { recursive: true });
    const def = { name: SET_NAME, sources: [stageDir], excludes: [], schedule: sch };
    const { set, recoveryCode } = await jobs.createSet({ def, password, place, cacheDir, host: hostName(), home, fields: fields() });
    store.add(set);
    let passwordSaved = true;
    try {
      secrets.set(set.id, password);
    } catch {
      passwordSaved = false;
    }
    listed = null;
    return { view: view(), recoveryCode, passwordSaved };
  }

  // A Claude backup folder that is already on a disk (after a reset, on another computer, or one removed from the app),
  // opened with its password or its recovery code (then with a new password). Its snapshots stay as they are; this
  // computer's backups go on in it.
  async function open({ dir, secret, newPassword = null }) {
    if (current()) throw new BackupError('BACKUP_SET_EXISTS', 'Backups are set up already.');
    if (!secrets.available() && !given) throw new BackupError('SECRET_STORE_UNAVAILABLE', 'This system cannot keep the password encrypted.');
    const r = await jobs.openExisting({ dir, secret, newPassword, cacheDir, owner: OWNER });
    fs.mkdirSync(stageDir, { recursive: true });
    // The stage folder of this computer, whichever computer took the snapshots.
    const set = { ...r.set, ...fields(r.set.keepTagged ? r.set.keepTagged[BEFORE] : KEEP_BEFORE), sources: [stageDir] };
    set.state.definitionHash = null;
    store.add(set);
    if (secrets.available()) secrets.set(set.id, r.password);
    listed = null;
    return { view: view(), byRecovery: r.byRecovery, snapshots: r.snapshots };
  }

  // schedule, keep (core/sets.js) and keepBefore: how many snapshots taken before an operation stay.
  function update({ schedule: sch, keep, keepBefore } = {}) {
    const set = need();
    if (sch || keep) store.updateDefinition(set.id, { ...(sch ? { schedule: sch } : {}), ...(keep ? { keep } : {}) });
    if (keepBefore != null) store.update(set.id, fields(Number(keepBefore) || KEEP_BEFORE));
    return view();
  }

  // Only from the app: the backup folder and its snapshots stay where they are, and can be opened again.
  function remove() {
    const set = need();
    store.remove(set.id);
    secrets.remove(set.id);
    listed = null;
  }

  // A password that is not saved here any more (or that the system would not give back): checked, then saved.
  async function setPassword(password) {
    const set = need();
    const ks = await repo.keys({ dir: set.repo, cacheDir, password, keyHint: set.passwordKey });
    const cur = ks.find((k) => k.current);
    if (cur && cur.kind === 'recovery') throw new BackupError('IS_RECOVERY_CODE', 'This is the recovery code, not the password.');
    secrets.set(set.id, password);
    if (cur && cur.id !== set.passwordKey) store.update(set.id, { passwordKey: cur.id });
    store.updateState(set.id, (st) => { st.secretBlocked = null; });
    return view();
  }

  const isDue = () => {
    const set = current();
    return Boolean(set && (secrets.has(set.id) || (given && given())) && !(set.state && set.state.secretBlocked) && schedule.isDue(set.schedule, set.state || {}));
  };

  // A scheduled or manual backup with what goes after it (core/jobs.js runBackup): the stage folder is filled first.
  async function backup({ onProgress = () => {}, signal = null } = {}) {
    const set = need();
    const password = passwordOf(set);
    const startedAt = new Date().toISOString();
    try {
      onProgress({ phase: 'stage' });
      const staged = await fill(stageDir, { kind: 'backup' });
      const result = await jobs.runBackup({ set, password, cacheDir, host: hostName(), home, onProgress, signal });
      store.updateState(set.id, (st) => jobs.applyResult(st, result, { definitionHash: sets.definitionHash(set) }));
      listed = null;
      return { ...result, staged };
    } catch (e) {
      if (e.code === 'CANCELLED') store.updateState(set.id, (st) => { st.skippedAt = new Date().toISOString(); });
      else if (e.code !== 'BUSY') store.updateState(set.id, (st) => jobs.applyFailure(st, e, startedAt));
      throw e;
    }
  }

  // The snapshot before an operation writes anything: every memory, workspace file and Claude setting as they are now.
  // Nothing after it but the thinning of these snapshots; the scheduled backups are not changed by it.
  async function before({ reason, onProgress = () => {}, signal = null }) {
    const set = need();
    const password = passwordOf(set);
    onProgress({ phase: 'stage' });
    const staged = await fill(stageDir, { kind: 'before', reason });
    const r = await jobs.takeSnapshot({ set, password, cacheDir, host: hostName(), home, tags: [BEFORE, `${REASON}${reason}`], onProgress, signal });
    try {
      await repo.forget({ ...optsOf(set, password), keepLast: (set.keepTagged || {})[BEFORE] || KEEP_BEFORE, tag: BEFORE });
    } catch { /* thinned with the next backup */ }
    listed = null;
    return { snapshot: r.snapshot, at: r.snapshotStart, staged };
  }

  const describe = (s) => ({
    id: s.id, short: s.id.slice(0, 8), time: s.time, host: s.host, mine: s.host === hostName(),
    kind: s.tags.includes(BEFORE) ? 'before' : s.tags.includes(TAG) ? 'backup' : 'other',
    reason: (s.tags.find((x) => x.startsWith(REASON)) || '').slice(REASON.length) || null,
    files: s.summary ? s.summary.total_files_processed ?? null : null,
    bytes: s.summary ? s.summary.total_bytes_processed ?? null : null,
    added: s.summary ? s.summary.data_added_packed ?? s.summary.data_added ?? null : null,
    path: s.paths[0] || null,
  });

  // The snapshots in the backup folder, newest first, also those other computers took into it.
  async function snapshots() {
    const set = need();
    const list = await repo.snapshots(optsOf(set, passwordOf(set)));
    listed = { at: Date.now(), list: list.filter((s) => s.kind === 'data').map(describe).reverse() };
    return listed.list;
  }
  // Without waiting for restic: the last list read, or null.
  const knownSnapshots = () => (listed ? listed.list : null);

  // Restores one snapshot's stage folder into a new folder of its own and resolves to it, to be read with
  // lib/stage.js readStage. full false leaves the chats out (an undo needs only the files an operation touched).
  async function restore(id, { full = true, onProgress = () => {}, signal = null } = {}) {
    const set = need();
    if (!exists(set.repo)) throw new BackupError('TARGET_MISSING', `The backup folder is not there: ${set.repo}`, { path: set.repo });
    const password = passwordOf(set);
    const opts = optsOf(set, password);
    const list = await repo.snapshots(opts);
    const snap = list.find((s) => s.kind === 'data' && (s.id === id || s.id.startsWith(String(id))));
    if (!snap || !snap.paths[0]) throw new BackupError('SNAPSHOT_MISSING', `There is no such backup in the backup folder: ${id}`);
    fs.mkdirSync(restoredRoot, { recursive: true });
    const bytes = snap.summary && snap.summary.total_bytes_processed ? snap.summary.total_bytes_processed : 0;
    space.requireSpace(restoredRoot, bytes, { home });
    const target = path.join(restoredRoot, `${snap.id.slice(0, 12)}-${Date.now()}`);
    try {
      await repo.restore({
        ...opts, snapshot: snap.id, folder: snap.paths[0], target, signal,
        names: full ? null : ['manifest.json', 'memory', 'workspace', 'claude'],
        onProgress: (p) => onProgress({ phase: 'restore', percent: Math.round(p.percent * 1000) / 10 }),
      });
    } catch (e) {
      fs.rmSync(target, { recursive: true, force: true });
      throw e;
    }
    return { dir: target, snapshot: describe(snap) };
  }

  // Folders restored for reading, once read: removed. All of them when the app starts.
  const discardRestored = (dir = null) => fs.rmSync(dir || restoredRoot, { recursive: true, force: true });

  // All of the data read back and compared; the set is marked damaged or sound by what it finds.
  async function verify({ onProgress = () => {}, signal = null } = {}) {
    const set = need();
    const r = await jobs.verifySet({ set, password: passwordOf(set), cacheDir, signal, onProgress });
    store.updateState(set.id, (st) => {
      const at = new Date().toISOString();
      st.lastFullCheck = { at, ok: r.ok };
      st.damaged = r.ok ? null : { at, message: r.message, brokenPacks: r.brokenPacks };
      if (r.ok && st.lastRepair) st.lastRepair.copies = null;
    });
    return r;
  }

  async function repair({ onProgress = () => {}, signal = null } = {}) {
    const set = need();
    const r = await jobs.repairSet({ set, password: passwordOf(set), cacheDir, host: hostName(), home, signal, onProgress });
    store.updateState(set.id, (st) => {
      const at = new Date().toISOString();
      st.lastFullCheck = { at, ok: r.ok };
      st.lastRepair = { at, ok: r.ok, copies: r.copies || null };
      st.damaged = r.ok ? null : { at, message: r.message, brokenPacks: r.brokenPacks };
    });
    listed = null;
    return r;
  }

  return {
    view, targetInfo, setUp, open, update, remove, setPassword, isDue, backup, before, snapshots, knownSnapshots, restore,
    discardRestored, verify, repair, stageDir, store, secrets, cacheDir, current,
    reload: () => {
      store.reload();
      listed = null;
    },
  };
}

module.exports = { createBackups, OWNER, TAG, BEFORE, KEEP_BEFORE, DEFAULT_SCHEDULE };
