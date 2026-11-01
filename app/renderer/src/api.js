import { t, has } from './i18n.js';

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
  chooseBundle: () => bridge.chooseBundle(),
  chooseFolder: (opts) => bridge.chooseFolder(opts),
  reveal: (p) => bridge.reveal(p),
  openPath: (p) => bridge.openPath(p),
  trash: (p) => bridge.trash(p),
  appInfo: () => bridge.appInfo(),
  intro: () => bridge.intro(),
  completeIntro: () => bridge.completeIntro(),
  openPrivacySettings: () => bridge.openPrivacySettings(),
  takePendingBundle: () => bridge.takePendingBundle(),
  pathForFile: (f) => bridge.pathForFile(f),
  on: (channel, cb) => bridge.on(channel, cb),
};

// Engine errors by code (errors.<CODE> in the locale files); the engine's own English message otherwise.
export function errorText(e) {
  if (!e) return '';
  if (e.code === 'APPLY_FAILED') return e.rolledBack ? t('errors.applyRolledBack') : t('errors.applyFailed', { path: e.backupPath });
  if (e.code === 'VERIFY_FAILED') return t('errors.verifyFailed', { path: e.backupPath });
  if (e.code && has(`errors.${e.code}`)) return t(`errors.${e.code}`);
  return e.message || String(e);
}
