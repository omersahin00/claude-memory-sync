'use strict';
// Electron main process: window, tray icon, daily backup timer, file association. All file work is done by lib/engine.
const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, ipcMain, dialog, shell, Tray, Menu, nativeImage, nativeTheme, Notification, powerMonitor } = require('electron');
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
  'fullBackupPreview', 'createFullBackup', 'prepareFullRestore', 'applyFullRestore',
]);
const WRITES = new Set(['createBackup', 'exportBundle', 'apply', 'fixWorkspace', 'updateSettings', 'createFullBackup', 'applyFullRestore']);
const ERROR_FIELDS = ['pending', 'files', 'problems', 'backupPath', 'rolledBack', 'rollbackErrors', 'errors'];

let engine = null;
let win = null;
let tray = null;
let quitting = false;
let pendingBundle = null;

if (SHOT_DIR) {
  app.setPath('userData', path.join(SHOT_DIR, '.electron-data'));
}
// Screenshots at CMS_SCALE times the pixels: a bigger window zoomed in by the same factor keeps the same layout.
const SHOT_SCALE = SHOT_DIR ? Number(process.env.CMS_SCALE) || 1 : 1;

const isBundle = (p) => typeof p === 'string' && p.toLowerCase().endsWith('.memsync') && fs.existsSync(p);
const bundleArg = (argv) => argv.slice(1).find(isBundle) || null;
// The interface language: the one chosen in Settings, otherwise the system's.
const language = () => i18n.pickLanguage(engine.settings().language, app.getPreferredSystemLanguages());
const t = (key, params) => i18n.translate(language(), key, params);
const fmtTime = (iso) => new Date(iso).toLocaleString(language(), { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
const windowBackground = () => (nativeTheme.shouldUseDarkColors ? '#18181b' : '#f6f6f3');
const backupStats = (stats) => `${t('count.projects', { count: stats.projects })}, ${t('count.memoryFiles', { count: stats.memoryFiles })}`;

function send(channel, ...args) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, ...args);
}

function notify(title, body) {
  if (!SHOT_DIR && Notification.isSupported()) new Notification({ title, body, silent: true }).show();
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
    if (quitting || SHOT_DIR || !engine.settings().runInBackground) return;
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
  if (d && !d.enabled) info.push({ label: t('app.dailyOff'), enabled: false });
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Claude Memory Sync', enabled: false },
    ...info,
    { type: 'separator' },
    { label: t('main.tray.open'), click: showWindow },
    { label: t('common.backupNow'), click: backupNow },
    { type: 'separator' },
    { label: t('main.tray.quit'), click: () => { quitting = true; app.quit(); } },
  ]));
}

function backupNow() {
  try {
    const r = engine.createBackup('manual');
    notify(t('main.notify.backupDone'), backupStats(r.stats));
    send('changed');
  } catch (e) {
    notify(t('main.notify.backupFailed'), e.message);
  }
  refreshTray();
}

// ---- Daily backup ----------------------------------------------------------------
// The backup time is on a 5-minute grid (12:00, 12:05 ...) and so are the checks: one runs a second after every 5-minute
// mark of the clock, so the backup starts at the time it is set to. A time missed while the computer was off or asleep
// is caught shortly after start and a minute after waking up.
const STEP = 5 * 60 * 1000;
let nextCheck = null;

function tick() {
  try {
    const r = engine.runDailyIfDue();
    if (r.due && !r.skipped) notify(t('main.notify.dailyDone'), backupStats(r.stats));
    if (r.due) send('changed');
  } catch (e) {
    notify(t('main.notify.dailyFailed'), e.message);
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
  ipcMain.handle('engine', (_e, method, args) => {
    if (!API.has(method)) return { ok: false, error: { code: 'NOT_ALLOWED', message: `Not allowed: ${method}` } };
    try {
      const value = engine[method](...(Array.isArray(args) ? args : []));
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
  ipcMain.handle('dialog:bundle', async () => {
    const r = await dialog.showOpenDialog(win, {
      title: t('main.dialog.chooseBundle'),
      properties: ['openFile'],
      filters: [{ name: t('main.dialog.bundleFilter'), extensions: ['memsync'] }],
    });
    return r.canceled ? null : r.filePaths[0];
  });
  ipcMain.handle('dialog:folder', async (_e, opts = {}) => {
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
  }));
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
  pendingBundle = pendingBundle || bundleArg(process.argv);
  const hidden = !pendingBundle && (process.argv.includes('--hidden') || (IS_MAC && app.getLoginItemSettings().wasOpenedAtLogin));
  applyAppSettings();
  createWindow(hidden);
  if (hidden && IS_MAC && app.dock) app.dock.hide();
  if (SHOT_DIR) {
    runScreenshots().catch((e) => {
      console.error(e);
      app.exit(1);
    });
    return;
  }
  startScheduler();
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
  });
  app.on('window-all-closed', () => {
    if (SHOT_DIR || !engine || !engine.settings().runInBackground) app.quit();
  });
  app.on('activate', () => {
    if (engine) showWindow();
  });
  app.whenReady().then(start);
}
