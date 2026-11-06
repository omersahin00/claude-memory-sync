'use strict';
// Electron main process: window, tray icon, the backups' schedule, file association, and what Folder Backup on the same
// computer sees of this app (core/peers.js). All file work is done by lib/engine.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { app, BrowserWindow, ipcMain, dialog, shell, clipboard, Tray, Menu, nativeImage, nativeTheme, Notification, powerMonitor, safeStorage, utilityProcess } = require('electron');
const { createEngine } = require('../lib/engine');
const peers = require('../core/peers');
const i18n = require('./i18n');

const DEV_URL = process.env.VITE_DEV_SERVER_URL || null;
// Development only: render every step listed in CMS_SCREENSHOT_STEPS (a JSON file) to PNG files in this folder, with the
// text of each screen next to it (to check translations), then quit. CMS_SHOT_PEER=1 lets Folder Backup see it and ask it
// for things meanwhile (core/peers.js), to check the two together.
const SHOT_DIR = process.env.CMS_SCREENSHOT_DIR || null;
const SHOT_PEER = Boolean(SHOT_DIR && process.env.CMS_SHOT_PEER);
const IS_MAC = process.platform === 'darwin';

// Engine functions the window may call; nothing else of this process is reachable from it.
const API = new Set([
  'settings', 'updateSettings', 'setProjectIncluded', 'overview', 'projects', 'projectFiles', 'readFile', 'workspaces', 'claudeConfig', 'fixWorkspace', 'chats',
  'createBackup', 'exportPreview', 'exportBundle', 'library', 'openBundle', 'bundleContents', 'bundleFile',
  'prepare', 'resolvePlan', 'itemDiff', 'apply', 'activity', 'activityDetail', 'prepareUndo',
  'fullBackupPreview', 'createFullBackup', 'diskSpace', 'prepareFullRestore', 'applyFullRestore', 'backupPreview', 'folderAccess',
  'backupStatus', 'backupTarget', 'setUpBackups', 'openBackups', 'backupSettings', 'removeBackups', 'setBackupPassword', 'snapshots', 'openSnapshot',
  'verifyBackups', 'repairBackups', 'oldBackups',
]);
const WRITES = new Set(['createBackup', 'exportBundle', 'apply', 'fixWorkspace', 'updateSettings', 'createFullBackup', 'applyFullRestore', 'setUpBackups', 'openBackups', 'backupSettings', 'removeBackups', 'repairBackups']);
// The ones that run restic (core/), with the window's progress and a way to stop them: { kind, run(signal, onProgress) }.
// The others answer at once.
const JOBS = {
  createBackup: () => ({ kind: 'backup', run: (signal, onProgress) => engine.createBackup('manual', { signal, onProgress }) }),
  apply: (planId, decisions) => ({ kind: 'apply', run: (signal, onProgress) => engine.apply(planId, decisions, { signal, onProgress }) }),
  fixWorkspace: (req) => (req && req.apply ? { kind: 'apply', run: (signal, onProgress) => engine.fixWorkspace(req, { signal, onProgress }) } : null),
  applyFullRestore: (id) => ({ kind: 'apply', run: (signal, onProgress) => engine.applyFullRestore(id, { signal, onProgress }) }),
  prepareUndo: (id) => ({ kind: 'open', run: (signal, onProgress) => engine.prepareUndo(id, { signal, onProgress }) }),
  openSnapshot: (id) => ({ kind: 'open', run: (signal, onProgress) => engine.openSnapshot(id, { signal, onProgress }) }),
  verifyBackups: () => ({ kind: 'verify', run: (signal, onProgress) => engine.verifyBackups({ signal, onProgress }) }),
  repairBackups: () => ({ kind: 'repair', run: (signal, onProgress) => engine.repairBackups({ signal, onProgress }) }),
  setUpBackups: (o) => ({ kind: 'setup', run: () => engine.setUpBackups(o) }),
  openBackups: (o) => ({ kind: 'setup', run: () => engine.openBackups(o) }),
};
// Who makes the app and its pages on GitHub, at the bottom of Settings. The window can open these links and no other.
const AUTHOR = 'Ömer Şahin';
const GITHUB = 'https://github.com/omersahin00';
const REPO = `${GITHUB}/claude-memory-sync`;
const LINKS = { profile: GITHUB, repo: REPO, releases: `${REPO}/releases`, issues: `${REPO}/issues`, license: `${REPO}/blob/main/LICENSE` };
const ERROR_FIELDS = ['path', 'detail', 'need', 'free', 'reserve', 'pending', 'files', 'problems', 'backupSnapshot', 'rolledBack', 'rollbackErrors', 'errors'];

let engine = null;
// false until the window has explained what the app reads and that nothing leaves this computer; until then nothing
// outside the app's own folders is read (macOS asks for Desktop, Documents and Downloads the first time each is read).
let ready = false;
let win = null;
let tray = null;
let quitting = false;
let pendingBundle = null;

if (SHOT_DIR) {
  app.setPath('userData', path.join(SHOT_DIR, '.electron-data'));
}
// Screenshots at CMS_SCALE times the pixels: a bigger window zoomed in by the same factor keeps the same layout.
const SHOT_SCALE = SHOT_DIR ? Number(process.env.CMS_SCALE) || 1 : 1;

// On macOS each build of the app is a new app for its folder permissions (the builds are signed ad hoc), so the
// explanation comes again with every new build; elsewhere once.
const INTRO_KEY = IS_MAC ? `${app.getVersion()}+${Math.round(fs.statSync(process.execPath).mtimeMs)}` : 'shown';
const PRIVACY_PANE = 'x-apple.systempreferences:com.apple.preference.security?Privacy_FilesAndFolders';
const savedSettings = () => (ready ? engine.settings() : engine.introStatus(INTRO_KEY));

const isBundle = (p) => typeof p === 'string' && p.toLowerCase().endsWith('.memsync') && fs.existsSync(p);
const bundleArg = (argv) => argv.slice(1).find(isBundle) || null;
// The interface language: the one chosen in Settings, otherwise the system's.
const language = () => i18n.pickLanguage(savedSettings().language, app.getPreferredSystemLanguages());
const t = (key, params) => i18n.translate(language(), key, params);
const fmtTime = (iso) => new Date(iso).toLocaleString(language(), { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
const windowBackground = () => (nativeTheme.shouldUseDarkColors ? '#18181b' : '#f6f6f3');
const backupStats = (r) => [t('count.projects', { count: r.stats.projects }), t('count.memoryFiles', { count: r.stats.memoryFiles }), r.chats ? t('count.chats', { count: r.chats }) : null].filter(Boolean).join(', ');

// The backups' password, encrypted by the system: the Keychain on macOS, DPAPI on Windows. Screenshots keep it only
// encoded, in their folder.
function codec() {
  if (SHOT_DIR) return { available: () => true, encrypt: (x) => Buffer.from(`shot:${x}`, 'utf8'), decrypt: (b) => b.toString('utf8').replace(/^shot:/, '') };
  return { available: () => safeStorage.isEncryptionAvailable(), encrypt: (x) => safeStorage.encryptString(x), decrypt: (b) => safeStorage.decryptString(b) };
}

function send(channel, ...args) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, ...args);
}

function notify(title, body) {
  if (!SHOT_DIR && Notification.isSupported()) new Notification({ title, body, silent: true }).show();
}

// As fmtBytes in app/renderer/src/format.js.
function fmtBytes(n) {
  const one = (x) => x.toLocaleString(language(), { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  if (n < 1024) return t('units.bytes', { n });
  if (n < 1024 * 1024) return t('units.kb', { n: one(n / 1024) });
  if (n < 1024 ** 3) return t('units.mb', { n: one(n / 1024 / 1024) });
  return t('units.gb', { n: one(n / 1024 ** 3) });
}

// An error in the app's language, the way errorText in app/renderer/src/api.js says it in the window.
function errorText(e) {
  const size = (n) => (n == null ? '' : fmtBytes(n));
  if (e.code && i18n.has(language(), `errors.${e.code}`)) {
    return t(`errors.${e.code}`, { path: e.path ?? '', detail: e.detail ?? '', need: size(e.need), free: size(e.free), reserve: size(e.reserve) });
  }
  return t('errors.unexpected', { detail: e.message });
}

// ---- Window -----------------------------------------------------------------
function createWindow(hidden) {
  win = new BrowserWindow({
    width: 1200 * SHOT_SCALE,
    height: 800 * SHOT_SCALE,
    minWidth: 960,
    minHeight: 640,
    show: false,
    title: 'Claude Memory Sync',
    backgroundColor: windowBackground(),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      offscreen: Boolean(SHOT_DIR),
      zoomFactor: SHOT_SCALE,
    },
  });
  win.once('ready-to-show', () => {
    if (!hidden && !SHOT_DIR) win.show();
  });
  // Closing the window keeps the app running in the tray / menu bar for the daily backup.
  win.on('close', (e) => {
    if (quitting || SHOT_DIR || !ready || !engine.settings().runInBackground) return;
    e.preventDefault();
    win.hide();
    if (IS_MAC && app.dock) app.dock.hide();
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  if (DEV_URL) win.loadURL(DEV_URL);
  else win.loadFile(path.join(__dirname, '..', 'dist', 'renderer', 'index.html'));
}

function showWindow() {
  if (!win || win.isDestroyed()) createWindow(false);
  else {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  }
  if (IS_MAC && app.dock) app.dock.show();
}

// A .memsync file opened from Finder/Explorer, the command line or a second launch.
function openBundle(file) {
  if (!isBundle(file)) return;
  pendingBundle = file;
  showWindow();
  send('open-bundle');
}

// ---- Tray / menu bar ------------------------------------------------------------
function createTray() {
  const img = nativeImage.createFromPath(path.join(__dirname, '..', 'build', IS_MAC ? 'trayTemplate.png' : 'tray.png'));
  if (IS_MAC) img.setTemplateImage(true);
  tray = new Tray(img);
  tray.setToolTip('Claude Memory Sync');
  if (!IS_MAC) tray.on('click', showWindow);
  refreshTray();
}

function refreshTray() {
  if (!tray) return;
  let v = null;
  try {
    v = engine.backupStatus().set;
  } catch { /* shown as not set up */ }
  const st = (v && v.state) || {};
  const info = [{ label: !v ? t('main.tray.noBackups') : st.lastSuccessAt ? t('main.tray.lastBackup', { time: fmtTime(st.lastSuccessAt) }) : t('main.tray.noBackup'), enabled: false }];
  if (v && v.nextRun) info.push({ label: t('main.tray.next', { time: fmtTime(v.nextRun) }), enabled: false });
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Claude Memory Sync', enabled: false },
    ...info,
    { type: 'separator' },
    { label: t('main.tray.open'), click: showWindow },
    { label: t('common.backupNow'), click: backupNow, enabled: Boolean(v) && !busy() },
    { type: 'separator' },
    { label: t('main.tray.quit'), click: () => { quitting = true; app.quit(); } },
  ]));
}

// ---- Backups and bundles in their own process -----------------------------------------------
// The window stays alive and shows how far a backup got, whatever its size. Stopping one ends that process: its file has
// no name until it is whole and verified, and nothing else was changed yet, so what was there before stays as it was.
let backupRun = null;
const KILL_AFTER = 1500;

// A job of the backups (restic, core/): one at a time, also with the bundles above.
let resticRun = null;
const busy = () => Boolean(backupRun || resticRun);
function backupState() {
  if (backupRun) return { kind: backupRun.job.kind, phase: backupRun.phase, percent: backupRun.percent, estimate: backupRun.estimate, stopping: backupRun.stopped };
  if (resticRun) return { kind: resticRun.kind, phase: resticRun.phase, percent: resticRun.percent, estimate: resticRun.estimate, stopping: resticRun.stopping };
  return null;
}
const codeError = (code, message, extra) => Object.assign(new Error(message), { code }, extra);

let sentAt = 0;
let sendTimer = null;
function sendProgress(force = false) {
  clearTimeout(sendTimer);
  const now = Date.now();
  if (force || now - sentAt >= 200) {
    sentAt = now;
    send('backup-progress', backupState());
    publishPeer();
  } else sendTimer = setTimeout(() => sendProgress(true), 200);
}

// work(signal, onProgress) does the job; the window shows each step (backupJob.phase.<phase>) and its percent where
// restic says one. Stopping it stops restic: a snapshot is saved only whole, so the backups stay as they were.
async function runJob(kind, work) {
  if (busy()) throw codeError('BUSY', 'A backup or a bundle is being written.');
  const controller = new AbortController();
  const run = { kind, phase: 'start', percent: null, estimate: null, stopping: false, controller, promise: null };
  resticRun = run;
  sendProgress(true);
  refreshTray();
  const onProgress = (p) => {
    if (p.phase && p.phase !== run.phase) {
      run.phase = p.phase;
      run.percent = null;
    }
    if (p.percent != null) run.percent = Math.max(run.percent || 0, Math.min(100, p.percent));
    if (p.estimate) run.estimate = p.estimate;
    sendProgress();
  };
  run.promise = work(controller.signal, onProgress);
  try {
    return await run.promise;
  } finally {
    resticRun = null;
    sendProgress(true);
    refreshTray();
    send('changed');
  }
}

function runBackupJob(job) {
  if (busy()) return Promise.reject(codeError('BUSY', 'A backup or a bundle is being written.'));
  return new Promise((resolve, reject) => {
    const child = utilityProcess.fork(path.join(__dirname, 'backup-worker.js'), [], { serviceName: 'Claude Memory Sync Backup' });
    const run = { child, job, phase: 'scan', percent: 0, estimate: null, stopped: false, written: null, error: null, killTimer: null };
    backupRun = run;
    send('backup-progress', backupState());
    child.once('spawn', () => child.postMessage({ job }));
    child.on('message', (m) => {
      if (run.stopped) return;
      if (m.type === 'progress') {
        run.phase = m.phase;
        run.percent = Math.max(run.percent, m.percent);
        if (m.estimate) run.estimate = m.estimate;
        send('backup-progress', backupState());
      } else {
        // It has nothing more to do and keeps nothing open.
        if (m.type === 'done') run.written = m.result;
        else run.error = codeError(m.error.code, m.error.message, { path: m.error.path, detail: m.error.detail, need: m.error.need, free: m.error.free, reserve: m.error.reserve });
        child.kill();
      }
    });
    child.once('exit', () => {
      clearTimeout(run.killTimer);
      backupRun = null;
      send('backup-progress', null);
      let result = null;
      let error = run.stopped ? codeError('CANCELLED', 'The backup was stopped.') : run.error;
      if (!error && !run.written) error = codeError('BACKUP_STOPPED', 'The backup process ended unexpectedly.');
      if (error) engine.discardBackupJob(job);
      else {
        try {
          result = engine.finishBackupJob(job, run.written);
        } catch (e) {
          error = e;
        }
      }
      refreshTray();
      send('changed');
      if (error) reject(error);
      else resolve(result);
    });
  });
}

function stopBackup() {
  if (resticRun) {
    if (resticRun.stopping) return;
    resticRun.stopping = true;
    sendProgress(true);
    resticRun.controller.abort();
    return;
  }
  const run = backupRun;
  if (!run || run.stopped || run.written || run.error) return;
  run.stopped = true;
  send('backup-progress', backupState());
  run.child.kill();
  // In case it does not end by itself, for example in the middle of a system call.
  run.killTimer = setTimeout(() => {
    try {
      process.kill(run.child.pid, 'SIGKILL');
    } catch { /* it is gone */ }
  }, KILL_AFTER);
}

async function backupNow() {
  if (busy()) return;
  try {
    const r = await runJob('backup', (signal, onProgress) => engine.createBackup('manual', { signal, onProgress }));
    notify(t('main.notify.backupDone'), backupStats(r));
  } catch (e) {
    if (e.code !== 'CANCELLED') notify(t('main.notify.backupFailed'), errorText(e));
  }
}

// ---- Scheduled backups ----------------------------------------------------------------
// The backups' schedule (core/schedule.js: every hour, day or week, on a 5-minute grid) is checked a second after every
// 5-minute mark of the clock, so a backup set to 12:00 starts then. A time missed while the computer was off or asleep is
// caught shortly after start and a minute after waking up. A failure is told once, not every 5 minutes, until a backup
// succeeds again.
const STEP = 5 * 60 * 1000;
let nextCheck = null;
let lastFailure = null;

async function tick() {
  if (busy()) return;
  try {
    if (engine.backupDue()) await runJob('backup', (signal, onProgress) => engine.createBackup('scheduled', { signal, onProgress }));
    lastFailure = null;
  } catch (e) {
    if (e.code !== 'CANCELLED' && e.code !== 'BUSY' && lastFailure !== e.code) notify(t('main.notify.backupFailed'), errorText(e));
    if (e.code !== 'BUSY') lastFailure = e.code;
  }
  refreshTray();
}

function checkOnTheMark() {
  clearTimeout(nextCheck);
  nextCheck = setTimeout(() => {
    tick();
    checkOnTheMark();
  }, STEP - (Date.now() % STEP) + 1000);
}

function startScheduler() {
  setTimeout(tick, 15 * 1000);
  checkOnTheMark();
  powerMonitor.on('resume', () => {
    setTimeout(tick, 60 * 1000);
    checkOnTheMark();
  });
}

function applyAppSettings() {
  const s = engine.settings();
  // 'system', 'light' or 'dark'; the window's prefers-color-scheme follows it.
  nativeTheme.themeSource = s.theme;
  if (win && !win.isDestroyed()) win.setBackgroundColor(windowBackground());
  Menu.setApplicationMenu(appMenu());
  if (app.isPackaged && !SHOT_DIR) app.setLoginItemSettings({ openAtLogin: s.openAtLogin, openAsHidden: true, args: ['--hidden'] });
  if (s.runInBackground && !tray && !SHOT_DIR) createTray();
  if (!s.runInBackground && tray) {
    tray.destroy();
    tray = null;
  }
}

// ---- Bridge to the window -----------------------------------------------------------
function registerIpc() {
  ipcMain.handle('engine', async (_e, method, args) => {
    if (!API.has(method)) return { ok: false, error: { code: 'NOT_ALLOWED', message: `Not allowed: ${method}` } };
    if (!ready) return { ok: false, error: { code: 'NOT_READY', message: 'The app has not started yet.' } };
    if (busy() && (WRITES.has(method) || JOBS[method])) return { ok: false, error: { code: 'BUSY', message: 'A backup or a bundle is being written.' } };
    try {
      const list = Array.isArray(args) ? args : [];
      const asJob = JOBS[method] ? JOBS[method](...list) : null;
      const value = await (asJob ? runJob(asJob.kind, asJob.run)
        : method === 'createFullBackup' ? runBackupJob(engine.fullBackupJob(...list))
          : method === 'exportBundle' ? runBackupJob(engine.exportJob(...list))
            : engine[method](...list));
      // A full restore brings the settings of the backup back (language, theme, start at login ...).
      if (method === 'updateSettings' || method === 'applyFullRestore') applyAppSettings();
      if (WRITES.has(method)) {
        refreshTray();
        publishPeer();
      }
      return { ok: true, value };
    } catch (e) {
      const error = { code: e.code || 'ERROR', message: e.message };
      for (const k of ERROR_FIELDS) if (e[k] !== undefined) error[k] = e[k];
      return { ok: false, error };
    }
  });
  ipcMain.handle('backup:state', () => backupState());
  ipcMain.handle('backup:stop', () => stopBackup());
  ipcMain.handle('dialog:bundle', async () => {
    const r = await dialog.showOpenDialog(win, {
      title: t('main.dialog.chooseBundle'),
      properties: ['openFile'],
      filters: [{ name: t('main.dialog.bundleFilter'), extensions: ['memsync'] }],
    });
    return r.canceled ? null : r.filePaths[0];
  });
  ipcMain.handle('dialog:folder', async (_e, opts = {}) => {
    if (SHOT_DIR && process.env.CMS_SHOT_FOLDER) return process.env.CMS_SHOT_FOLDER;
    const r = await dialog.showOpenDialog(win, {
      title: opts.title || t('main.dialog.chooseFolder'),
      defaultPath: typeof opts.defaultPath === 'string' ? opts.defaultPath : undefined,
      properties: ['openDirectory', 'createDirectory'],
    });
    return r.canceled ? null : r.filePaths[0];
  });
  ipcMain.handle('shell:reveal', (_e, p) => {
    if (typeof p === 'string' && fs.existsSync(p) && !SHOT_DIR) shell.showItemInFolder(p);
  });
  ipcMain.handle('shell:copy', (_e, text) => {
    if (typeof text === 'string') clipboard.writeText(text);
  });
  // The recovery code, saved as a text file where the user chooses (it is kept nowhere else).
  ipcMain.handle('backup:saveCode', async (_e, code) => {
    const v = engine.backupStatus().set;
    if (typeof code !== 'string' || !v) return null;
    const r = await dialog.showSaveDialog(win, {
      title: t('backups.code.saveTitle'),
      defaultPath: path.join(app.getPath('documents'), `${t('backups.code.fileName')}.txt`),
      filters: [{ name: t('backups.code.textFilter'), extensions: ['txt'] }],
    });
    if (r.canceled || !r.filePath) return null;
    const text = [t('backups.code.fileTitle'), '', `${t('backups.code.fileFolder')}: ${v.repo}`, `${t('backups.code.fileDate')}: ${new Date().toLocaleString(language())}`, '', `${t('backups.code.fileCode')}: ${code}`, '', t('backups.code.fileNote')].join('\n');
    fs.writeFileSync(r.filePath, `${text}\n`, { mode: 0o600 });
    let sameDisk = false;
    try {
      sameDisk = fs.statSync(path.dirname(r.filePath)).dev === fs.statSync(v.repo).dev;
    } catch { /* not known */ }
    return { path: r.filePath, sameDisk };
  });
  // Folder Backup on this computer: what it has, and asking it for something (core/peers.js).
  ipcMain.handle('peer:status', () => peerView());
  ipcMain.handle('peer:ask', (_e, action, setId) => askPeer(action, setId));
  ipcMain.handle('shell:open', (_e, p) => (typeof p === 'string' && fs.existsSync(p) ? shell.openPath(p) : 'missing'));
  // Only bundle files can be removed from the window, and only to the trash.
  ipcMain.handle('shell:trash', async (_e, p) => {
    if (!isBundle(p)) throw new Error('Only .memsync files can be moved to the trash.');
    await shell.trashItem(p);
    return true;
  });
  ipcMain.handle('app:info', () => ({
    version: app.getVersion(), platform: process.platform, packaged: app.isPackaged,
    language: language(), systemLanguage: i18n.pickLanguage(null, app.getPreferredSystemLanguages()),
    author: AUTHOR, links: LINKS,
  }));
  ipcMain.handle('app:openLink', (_e, id) => (Object.hasOwn(LINKS, id) ? shell.openExternal(LINKS[id]) : null));
  ipcMain.handle('app:intro', () => ({ ready, platform: process.platform }));
  ipcMain.handle('app:completeIntro', () => {
    const access = engine.completeIntro(INTRO_KEY);
    if (!ready) {
      ready = true;
      applyAppSettings();
      if (!SHOT_DIR) {
        startScheduler();
        startPeer();
      }
    }
    return access;
  });
  ipcMain.handle('app:privacySettings', () => (IS_MAC ? shell.openExternal(PRIVACY_PANE) : null));
  ipcMain.handle('app:pendingBundle', () => {
    const p = pendingBundle;
    pendingBundle = null;
    return p;
  });
}

function appMenu() {
  if (!IS_MAC) return null;
  return Menu.buildFromTemplate([
    { role: 'appMenu' },
    { role: 'editMenu' },
    { label: t('main.menu.view'), submenu: [{ role: 'reload' }, { role: 'toggleDevTools' }, { type: 'separator' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }] },
    { role: 'windowMenu' },
  ]);
}

// ---- Folder Backup on the same computer (core/peers.js) ------------------------------------
// Its data folder is found from os.homedir(), as this app's engine finds its own ($HOME).
// This app owns its backup set: it alone backs it up and changes it. Folder Backup reads it from sets.json and from what
// this app publishes (peer.json), and asks for changes through request files, which are handled here.
let owner = null;

function peerInfo() {
  const st = engine.backupStatus();
  const v = st.set;
  const b = engine.settings().backup;
  return {
    version: app.getVersion(), exe: app.isPackaged ? process.execPath : null,
    job: resticRun ? { kind: resticRun.kind, phase: resticRun.phase, percent: resticRun.percent, setId: v ? v.id : null } : null,
    sets: v ? { [v.id]: { kind: 'claude', status: v.status, nextRun: v.nextRun, keepBefore: v.keepBefore, place: v.place, content: { chats: b.chats, claude: b.claude, excludedProjects: b.excludeProjects.length, excludedRoots: b.excludeRoots.length } } } : {},
  };
}

function publishPeer() {
  if (owner) owner.publishSoon();
}

const CHATS = ['none', 'all', 'some'];
async function handlePeer(req) {
  const v = engine.backupStatus().set;
  const args = req.args && typeof req.args === 'object' ? req.args : {};
  if (req.action === 'show') {
    showWindow();
    send('navigate', 'backups');
    return true;
  }
  if (!v || req.setId !== v.id) throw codeError('NO_SET', 'There is no such backup set here.');
  if (req.action === 'backup' || req.action === 'verify') {
    if (busy()) throw codeError('BUSY', 'A backup or a bundle is being written.');
    const work = req.action === 'backup' ? (signal, onProgress) => engine.createBackup('manual', { signal, onProgress }) : (signal, onProgress) => engine.verifyBackups({ signal, onProgress });
    runJob(req.action, work).catch((e) => {
      if (e.code !== 'CANCELLED') notify(t('main.notify.backupFailed'), errorText(e));
    });
    return { started: true };
  }
  if (req.action === 'content') {
    // What the backups take, for Folder Backup to show and change: the projects by name, and the rest.
    const b = engine.settings().backup;
    const projects = engine.projects().projects.map((p) => ({ key: p.key, name: p.title || p.name, included: !b.excludeProjects.includes(p.key), scratch: p.isScratch }));
    return { projects, chats: b.chats, claude: b.claude, roots: engine.workspaces().map((r) => ({ key: r.key, name: r.name, included: !b.excludeRoots.includes(r.key) })) };
  }
  if (req.action === 'update') {
    if (busy()) throw codeError('BUSY', 'A backup or a bundle is being written.');
    engine.backupSettings({ schedule: args.schedule || undefined, keep: args.keep || undefined, keepBefore: args.keepBefore != null ? args.keepBefore : undefined });
    const c = args.content && typeof args.content === 'object' ? args.content : null;
    if (c) {
      const b = engine.settings().backup;
      const patch = {};
      if (CHATS.includes(c.chats)) patch.chats = c.chats;
      if (typeof c.claude === 'boolean') patch.claude = c.claude;
      // Left out by name: what is left out of a project or folder that is not on this computer right now stays so.
      const strings = (a) => a.filter((x) => typeof x === 'string');
      if (Array.isArray(c.excludeProjects)) {
        const here = new Set(engine.projects().projects.map((p) => p.key));
        patch.excludeProjects = [...b.excludeProjects.filter((k) => !here.has(k)), ...strings(c.excludeProjects)];
      }
      if (Array.isArray(c.excludeRoots)) {
        const here = new Set(engine.workspaces().map((r) => r.key));
        patch.excludeRoots = [...b.excludeRoots.filter((k) => !here.has(k)), ...strings(c.excludeRoots)];
      }
      engine.updateSettings({ backup: patch });
    }
    send('changed');
    refreshTray();
    publishPeer();
    return engine.backupStatus().set;
  }
  throw codeError('NOT_ALLOWED', `Not allowed: ${req.action}`);
}

function startPeer() {
  if (owner || (SHOT_DIR && !SHOT_PEER)) return;
  owner = peers.createOwner({ self: 'claude-memory-sync', dataDir: engine.settings().device.stateHome, info: peerInfo });
  owner.start(handlePeer);
}

// Folder Backup's sets as the window shows them: read only, with what Folder Backup says of each.
function peerView() {
  const p = peers.readPeer('folder-backup', { home: os.homedir() });
  if (!p) return null;
  const extra = (p.info && p.info.sets) || {};
  return {
    name: p.name, running: p.running, canOpen: Boolean(p.info && p.info.exe && fs.existsSync(p.info.exe)), job: (p.info && p.info.job) || null,
    sets: p.sets.filter((x) => !x.full).map((x) => ({
      id: x.id, name: x.name, repo: x.repo, schedule: x.schedule, lastSuccessAt: (x.state && x.state.lastSuccessAt) || null,
      status: (extra[x.id] && extra[x.id].status) || null, nextRun: (extra[x.id] && extra[x.id].nextRun) || null,
    })),
  };
}

// show: Folder Backup comes to the front (started first when it does not run); backup: it backs the set up now.
async function askPeer(action, setId = null) {
  if (!['show', 'backup'].includes(action)) throw codeError('NOT_ALLOWED', `Not allowed: ${action}`);
  const p = peers.readPeer('folder-backup', { home: os.homedir() });
  if (!p) throw codeError('PEER_MISSING', 'Folder Backup is not on this computer.');
  if (!p.running) {
    if (!peers.launch(p, { hidden: action !== 'show' })) throw codeError('PEER_MISSING', 'Folder Backup could not be started.');
    if (action === 'show') return { answered: true, ok: true };
  }
  const a = await peers.ask(p.dataDir, { from: 'claude-memory-sync', setId, action, timeout: p.running ? 15000 : 30000 });
  if (!a.answered) throw codeError('PEER_NO_ANSWER', 'Folder Backup did not answer.');
  if (!a.ok) throw codeError(a.error.code, a.error.message, a.error);
  return a.value;
}

// ---- Development screenshots ------------------------------------------------------------
async function runScreenshots() {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  if (win.webContents.isLoading()) await new Promise((r) => win.webContents.once('did-finish-load', r));
  await wait(1200);
  const steps = JSON.parse(fs.readFileSync(process.env.CMS_SCREENSHOT_STEPS, 'utf8'));
  for (const s of steps) {
    try {
      if (s.js) await win.webContents.executeJavaScript(s.js, true);
    } catch (e) {
      console.error(`step ${s.name}: ${e.message}`);
    }
    await wait(s.wait || 900);
    if (!s.name) continue;
    fs.writeFileSync(path.join(SHOT_DIR, `${s.name}.png`), (await win.webContents.capturePage()).toPNG());
    fs.writeFileSync(path.join(SHOT_DIR, `${s.name}.txt`), await win.webContents.executeJavaScript('document.body.innerText'));
  }
  quitting = true;
  if (owner) {
    owner.stop();
    owner = null;
  }
  app.quit();
}

// ---- Start ----------------------------------------------------------------------
function start() {
  // Windows shows notifications only for an app with an id (the installer uses the same one).
  if (process.platform === 'win32') app.setAppUserModelId('com.omersahin.claude-memory-sync');
  engine = createEngine({ codec: codec() });
  // Snapshots restored for reading by an earlier run.
  engine.discardRestored();
  registerIpc();
  ready = Boolean(SHOT_DIR && !process.env.CMS_SHOT_INTRO) || engine.introStatus(INTRO_KEY).done;
  pendingBundle = pendingBundle || bundleArg(process.argv);
  // Started at login: hidden, unless the explanation has to be shown first.
  const hidden = ready && !pendingBundle && (process.argv.includes('--hidden') || (IS_MAC && app.getLoginItemSettings().wasOpenedAtLogin));
  if (ready) applyAppSettings();
  else {
    nativeTheme.themeSource = savedSettings().theme;
    Menu.setApplicationMenu(appMenu());
  }
  createWindow(hidden);
  if (hidden && IS_MAC && app.dock) app.dock.hide();
  if (SHOT_DIR) {
    if (SHOT_PEER) startPeer();
    runScreenshots().catch((e) => {
      console.error(e);
      app.exit(1);
    });
    return;
  }
  if (ready) {
    startScheduler();
    startPeer();
  }
}

if (!SHOT_DIR && !app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    const b = bundleArg(argv);
    if (b) openBundle(b);
    else showWindow();
  });
  app.on('open-file', (e, file) => {
    e.preventDefault();
    if (app.isReady() && engine) openBundle(file);
    else pendingBundle = file;
  });
  // A running job is stopped first: restic removes its lock and saves no half snapshot; then the app quits.
  app.on('before-quit', (e) => {
    quitting = true;
    if (owner) {
      owner.stop();
      owner = null;
    }
    if (backupRun) {
      backupRun.child.kill();
      engine.discardBackupJob(backupRun.job);
    }
    if (!resticRun) return;
    e.preventDefault();
    const run = resticRun;
    stopBackup();
    Promise.race([run.promise.catch(() => {}), new Promise((r) => setTimeout(r, 12000))]).then(() => setImmediate(() => app.quit()));
  });
  app.on('window-all-closed', () => {
    if (SHOT_DIR || !engine || !ready || !engine.settings().runInBackground) app.quit();
  });
  app.on('activate', () => {
    if (engine) showWindow();
  });
  app.whenReady().then(start);
}
