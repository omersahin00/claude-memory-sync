'use strict';
// The only bridge between the window and the rest of the app.
const { contextBridge, ipcRenderer, webUtils } = require('electron');

const EVENTS = new Set(['open-bundle', 'changed', 'backup-progress', 'navigate']);

contextBridge.exposeInMainWorld('cms', {
  // Returns { ok, value } or { ok: false, error: { code, message, ... } }; errors are rebuilt in the window,
  // because an Error crossing this bridge keeps only its message.
  invoke: (method, args) => ipcRenderer.invoke('engine', method, args),
  backupState: () => ipcRenderer.invoke('backup:state'),
  stopBackup: () => ipcRenderer.invoke('backup:stop'),
  chooseBundle: () => ipcRenderer.invoke('dialog:bundle'),
  chooseFolder: (opts) => ipcRenderer.invoke('dialog:folder', opts || {}),
  reveal: (p) => ipcRenderer.invoke('shell:reveal', p),
  openPath: (p) => ipcRenderer.invoke('shell:open', p),
  trash: (p) => ipcRenderer.invoke('shell:trash', p),
  copy: (text) => ipcRenderer.invoke('shell:copy', text),
  saveRecoveryCode: (code) => ipcRenderer.invoke('backup:saveCode', code),
  peerStatus: () => ipcRenderer.invoke('peer:status'),
  askPeer: (action, setId) => ipcRenderer.invoke('peer:ask', action, setId),
  appInfo: () => ipcRenderer.invoke('app:info'),
  intro: () => ipcRenderer.invoke('app:intro'),
  completeIntro: () => ipcRenderer.invoke('app:completeIntro'),
  openPrivacySettings: () => ipcRenderer.invoke('app:privacySettings'),
  openLink: (id) => ipcRenderer.invoke('app:openLink', id),
  takePendingBundle: () => ipcRenderer.invoke('app:pendingBundle'),
  pathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      return null;
    }
  },
  on(channel, cb) {
    if (!EVENTS.has(channel)) return () => {};
    const h = (_e, ...a) => cb(...a);
    ipcRenderer.on(channel, h);
    return () => ipcRenderer.removeListener(channel, h);
  },
});
