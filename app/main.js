'use strict';
// Electron main process: window, tray icon, daily backup timer, file association. All file work is done by lib/engine.
const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, ipcMain, dialog, shell, Tray, Menu, nativeImage, nativeTheme, Notification, powerMonitor } = require('electron');
const { createEngine } = require('../lib/engine');

const DEV_URL = process.env.VITE_DEV_SERVER_URL || null;
// Development only: render every step listed in CMS_SCREENSHOT_STEPS (a JSON file) to PNG files in this folder, then quit.
const SHOT_DIR = process.env.CMS_SCREENSHOT_DIR || null;
const IS_MAC = process.platform === 'darwin';

// Engine functions the window may call; nothing else of this process is reachable from it.
const API = new Set([
  'settings', 'updateSettings', 'setProjectIncluded', 'overview', 'projects', 'projectFiles', 'readFile', 'workspaces', 'claudeConfig', 'fixWorkspace',
  'createBackup', 'dailyStatus', 'exportPreview', 'exportBundle', 'library', 'openBundle', 'bundleContents', 'bundleFile',
  'prepare', 'resolvePlan', 'itemDiff', 'apply', 'activity', 'activityDetail', 'prepareUndo',
]);
const WRITES = new Set(['createBackup', 'exportBundle', 'apply', 'fixWorkspace', 'updateSettings']);
const ERROR_FIELDS = ['pending', 'files', 'problems', 'backupPath', 'rolledBack', 'rollbackErrors', 'errors'];

let engine = null;
let win = null;
let tray = null;
let quitting = false;
let pendingBundle = null;

if (SHOT_DIR) {
  app.setPath('userData', path.join(SHOT_DIR, '.electron-data'));
  if (process.env.CMS_THEME) nativeTheme.themeSource = process.env.CMS_THEME;
}
// Screenshots at CMS_SCALE times the pixels: a bigger window zoomed in by the same factor keeps the same layout.
const SHOT_SCALE = SHOT_DIR ? Number(process.env.CMS_SCALE) || 1 : 1;

const isBundle = (p) => typeof p === 'string' && p.toLowerCase().endsWith('.memsync') && fs.existsSync(p);
const bundleArg = (argv) => argv.slice(1).find(isBundle) || null;
const fmtTime = (iso) => new Date(iso).toLocaleString('tr-TR', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

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
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#18181b' : '#f6f6f3',
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
  const info = [{ label: d && d.lastAt ? `Son günlük yedek: ${fmtTime(d.lastAt)}` : 'Henüz günlük yedek yok', enabled: false }];
  if (d && d.enabled && d.nextAt) info.push({ label: `Sıradaki: ${fmtTime(d.nextAt)}`, enabled: false });
  if (d && !d.enabled) info.push({ label: 'Günlük yedek kapalı', enabled: false });
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Claude Memory Sync', enabled: false },
    ...info,
    { type: 'separator' },
    { label: 'Pencereyi aç', click: showWindow },
    { label: 'Şimdi yedek al', click: backupNow },
    { type: 'separator' },
    { label: 'Çıkış', click: () => { quitting = true; app.quit(); } },
  ]));
}

function backupNow() {
  try {
    const r = engine.createBackup('manual');
    notify('Yedek alındı', `${r.stats.projects} proje, ${r.stats.memoryFiles} hafıza dosyası`);
    send('changed');
  } catch (e) {
    notify('Yedek alınamadı', e.message);
  }
  refreshTray();
}

// ---- Daily backup ----------------------------------------------------------------
function tick() {
  try {
    const r = engine.runDailyIfDue();
    if (r.due && !r.skipped) {
      notify('Günlük yedek alındı', `${r.stats.projects} proje, ${r.stats.memoryFiles} hafıza dosyası`);
      send('changed');
    }
  } catch (e) {
    notify('Günlük yedek alınamadı', e.message);
  }
  refreshTray();
}

function startScheduler() {
  setTimeout(tick, 15 * 1000);
  setInterval(tick, 5 * 60 * 1000);
  powerMonitor.on('resume', () => setTimeout(tick, 60 * 1000));
}

function applyAppSettings() {
  const s = engine.settings();
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
      if (method === 'updateSettings') applyAppSettings();
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
      title: 'Paket seç',
      properties: ['openFile'],
      filters: [{ name: 'Claude Memory Sync paketi', extensions: ['memsync'] }],
    });
    return r.canceled ? null : r.filePaths[0];
  });
  ipcMain.handle('dialog:folder', async (_e, opts = {}) => {
    const r = await dialog.showOpenDialog(win, {
      title: opts.title || 'Klasör seç',
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
  ipcMain.handle('app:info', () => ({ version: app.getVersion(), platform: process.platform, packaged: app.isPackaged }));
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
    { label: 'Görünüm', submenu: [{ role: 'reload' }, { role: 'toggleDevTools' }, { type: 'separator' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }] },
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
    if (s.name) fs.writeFileSync(path.join(SHOT_DIR, `${s.name}.png`), (await win.webContents.capturePage()).toPNG());
  }
  quitting = true;
  app.quit();
}

// ---- Start ----------------------------------------------------------------------
function start() {
  // Windows shows notifications only for an app with an id (the installer uses the same one).
  if (process.platform === 'win32') app.setAppUserModelId('com.omersahin.claude-memory-sync');
  engine = createEngine();
  Menu.setApplicationMenu(appMenu());
  registerIpc();
  pendingBundle = pendingBundle || bundleArg(process.argv);
  const hidden = !pendingBundle && (process.argv.includes('--hidden') || (IS_MAC && app.getLoginItemSettings().wasOpenedAtLogin));
  createWindow(hidden);
  if (hidden && IS_MAC && app.dock) app.dock.hide();
  applyAppSettings();
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
