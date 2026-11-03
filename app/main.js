'use strict';
// Electron main process: window, tray icon, daily backup timer, file association. All file work is done by lib/engine.
const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, ipcMain, dialog, shell, Tray, Menu, nativeImage, nativeTheme, Notification, powerMonitor, utilityProcess } = require('electron');
const { createEngine } = require('../lib/engine');
const i18n = require('./i18n');

const DEV_URL = process.env.VITE_DEV_SERVER_URL || null;
// Development only: render every step listed in CMS_SCREENSHOT_STEPS (a JSON file) to PNG files in this folder, with the
// text of each screen next to it (to check translations), then quit.
const SHOT_DIR = process.env.CMS_SCREENSHOT_DIR || null;
const IS_MAC = process.platform === 'darwin';

// Engine functions the window may call; nothing else of this process is reachable from it.
const API = new Set([
  'settings', 'updateSettings', 'setProjectIncluded', 'overview', 'projects', 'projectFiles', 'readFile', 'workspaces', 'claudeConfig', 'fixWorkspace', 'chats',
  'createBackup', 'dailyStatus', 'exportPreview', 'exportBundle', 'library', 'openBundle', 'bundleContents', 'bundleFile',
  'prepare', 'resolvePlan', 'itemDiff', 'apply', 'activity', 'activityDetail', 'prepareUndo',
  'fullBackupPreview', 'createFullBackup', 'diskSpace', 'prepareFullRestore', 'applyFullRestore', 'backupPreview', 'folderAccess',
  'backupsElsewhere', 'reviewBackupFolder', 'inspectBackup', 'backupFolderFindings', 'applyBackupFolder', 'moveNextBackup', 'stopBackupMove',
]);
const WRITES = new Set(['createBackup', 'exportBundle', 'apply', 'fixWorkspace', 'updateSettings', 'createFullBackup', 'applyFullRestore', 'applyBackupFolder', 'moveNextBackup', 'stopBackupMove']);
// Who makes the app and its pages on GitHub, at the bottom of Settings. The window can open these links and no other.
const AUTHOR = 'Ömer Şahin';
const GITHUB = 'https://github.com/omersahin00';
const REPO = `${GITHUB}/claude-memory-sync`;
const LINKS = { profile: GITHUB, repo: REPO, releases: `${REPO}/releases`, issues: `${REPO}/issues`, license: `${REPO}/blob/main/LICENSE` };
const ERROR_FIELDS = ['path', 'detail', 'need', 'free', 'reserve', 'pending', 'files', 'problems', 'backupPath', 'rolledBack', 'rollbackErrors', 'errors'];

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
  let d = null;
  try {
    d = engine.dailyStatus();
  } catch { /* shown as unknown */ }
  const info = [{ label: d && d.lastAt ? t('main.tray.lastDaily', { time: fmtTime(d.lastAt) }) : t('main.tray.noDaily'), enabled: false }];
  if (d && d.enabled && d.nextAt) info.push({ label: t('main.tray.next', { time: fmtTime(d.nextAt) }), enabled: false });
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Claude Memory Sync', enabled: false },
    ...info,
    { type: 'separator' },
    { label: t('main.tray.open'), click: showWindow },
    { label: t('common.backupNow'), click: backupNow },
    { label: t('settings.backup.title'), type: 'checkbox', checked: Boolean(d && d.enabled), enabled: Boolean(d), click: (item) => turnDaily(item.checked) },
    { type: 'separator' },
    { label: t('main.tray.quit'), click: () => { quitting = true; app.quit(); } },
  ]));
}

// ---- Backups and bundles in their own process -----------------------------------------------
// The window stays alive and shows how far a backup got, whatever its size. Stopping one ends that process: its file has
// no name until it is whole and verified, and nothing else was changed yet, so what was there before stays as it was.
let backupRun = null;
const KILL_AFTER = 1500;

const backupState = () => (backupRun ? { kind: backupRun.job.kind, phase: backupRun.phase, percent: backupRun.percent, estimate: backupRun.estimate, stopping: backupRun.stopped } : null);
const codeError = (code, message, extra) => Object.assign(new Error(message), { code }, extra);

function runBackupJob(job) {
  if (backupRun) return Promise.reject(codeError('BUSY', 'A backup or a bundle is being written.'));
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
  if (backupRun) return;
  try {
    const r = await runBackupJob(engine.backupJob('manual'));
    notify(t('main.notify.backupDone'), backupStats(r));
  } catch (e) {
    if (e.code !== 'CANCELLED') notify(t('main.notify.backupFailed'), errorText(e));
  }
}

function turnDaily(enabled) {
  try {
    engine.updateSettings({ daily: { enabled } });
    send('changed');
  } catch (e) {
    notify(t('main.notify.dailyToggleFailed'), errorText(e));
  }
  refreshTray();
}

// ---- Daily backup ----------------------------------------------------------------
// The backup time is on a 5-minute grid (12:00, 12:05 ...) and so are the checks: one runs a second after every 5-minute
// mark of the clock, so the backup starts at the time it is set to. A time missed while the computer was off or asleep
// is caught shortly after start and a minute after waking up.
const STEP = 5 * 60 * 1000;
let nextCheck = null;
// A daily backup that failed is tried again at every check, until the disk is back. It is told once, not every 5 minutes.
let dailyFailure = null;

async function tick() {
  if (backupRun) return;
  try {
    const job = engine.dailyJob();
    if (job) {
      const r = await runBackupJob(job);
      if (!r.skipped) notify(t('main.notify.dailyDone'), backupStats(r));
    }
    dailyFailure = null;
  } catch (e) {
    if (e.code === 'CANCELLED') engine.skipDaily();
    else if (dailyFailure !== e.code) notify(t('main.notify.dailyFailed'), errorText(e));
    dailyFailure = e.code;
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
    if (backupRun && WRITES.has(method)) return { ok: false, error: { code: 'BUSY', message: 'A backup or a bundle is being written.' } };
    try {
      const list = Array.isArray(args) ? args : [];
      const value = await (method === 'createBackup' ? runBackupJob(engine.backupJob(...list))
        : method === 'createFullBackup' ? runBackupJob(engine.fullBackupJob(...list))
          : method === 'exportBundle' ? runBackupJob(engine.exportJob(...list))
            : engine[method](...list));
      // A full restore brings the settings of the backup back (language, theme, start at login ...).
      if (method === 'updateSettings' || method === 'applyFullRestore') applyAppSettings();
      if (WRITES.has(method)) refreshTray();
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
    if (typeof p === 'string' && fs.existsSync(p)) shell.showItemInFolder(p);
  });
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
      if (!SHOT_DIR) startScheduler();
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
  app.quit();
}

// ---- Start ----------------------------------------------------------------------
function start() {
  // Windows shows notifications only for an app with an id (the installer uses the same one).
  if (process.platform === 'win32') app.setAppUserModelId('com.omersahin.claude-memory-sync');
  engine = createEngine();
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
    runScreenshots().catch((e) => {
      console.error(e);
      app.exit(1);
    });
    return;
  }
  if (ready) startScheduler();
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
  app.on('before-quit', () => {
    quitting = true;
    if (backupRun) {
      backupRun.child.kill();
      engine.discardBackupJob(backupRun.job);
    }
  });
  app.on('window-all-closed', () => {
    if (SHOT_DIR || !engine || !ready || !engine.settings().runInBackground) app.quit();
  });
  app.on('activate', () => {
    if (engine) showWindow();
  });
  app.whenReady().then(start);
}
