import { t, has } from './i18n.js';
import { fmtBytes } from './format.js';

// Calls into lib/engine through the preload bridge: api.overview(), api.prepare({...}) ...
const bridge = window.cms;

async function call(method, args) {
  const r = await bridge.invoke(method, args);
  if (r.ok) return r.value;
  const err = new Error(r.error.message);
  Object.assign(err, r.error);
  throw err;
}

export const api = new Proxy({}, { get: (_, method) => (...args) => call(method, args) });

export const shell = {
  backupState: () => bridge.backupState(),
  stopBackup: () => bridge.stopBackup(),
  chooseBundle: () => bridge.chooseBundle(),
  chooseFolder: (opts) => bridge.chooseFolder(opts),
  reveal: (p) => bridge.reveal(p),
  openPath: (p) => bridge.openPath(p),
  trash: (p) => bridge.trash(p),
  appInfo: () => bridge.appInfo(),
  intro: () => bridge.intro(),
  completeIntro: () => bridge.completeIntro(),
  openPrivacySettings: () => bridge.openPrivacySettings(),
  openLink: (id) => bridge.openLink(id),
  takePendingBundle: () => bridge.takePendingBundle(),
  pathForFile: (f) => bridge.pathForFile(f),
  on: (channel, cb) => bridge.on(channel, cb),
};

// Errors by code, the engine's and the system's (errors.<CODE> in the locale files). One without a text says it was not
// expected and gives the English detail. app/main.js says errors the same way in notifications.
export function errorText(e) {
  if (!e) return '';
  if (e.code === 'APPLY_FAILED') return e.rolledBack ? t('errors.applyRolledBack') : t('errors.applyFailed', { path: e.backupPath });
  if (e.code === 'VERIFY_FAILED') return t('errors.verifyFailed', { path: e.backupPath });
  const size = (n) => (n == null ? '' : fmtBytes(n));
  if (e.code && has(`errors.${e.code}`)) return t(`errors.${e.code}`, { path: e.path ?? '', detail: e.detail ?? '', need: size(e.need), free: size(e.free), reserve: size(e.reserve) });
  return t('errors.unexpected', { detail: e.message || String(e) });
}

// shell.openPath answers with nothing when the folder opened; a missing one (a disk not plugged in) would otherwise do nothing.
export async function openFolder(dir, toast) {
  if (await shell.openPath(dir)) toast(errorText({ code: 'ENOENT', path: dir }), 'error');
}
