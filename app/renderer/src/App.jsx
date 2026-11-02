import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { LayoutDashboard, Brain, FolderTree, Archive, ArrowLeftRight, History, Settings as SettingsIcon, Save, HardDrive, PackagePlus, Download } from 'lucide-react';
import { api, shell, errorText } from './api.js';
import { AppContext, useApp, Button } from './ui.jsx';
import { setHome, count } from './format.js';
import { t, language, setLanguage } from './i18n.js';
import Home from './screens/Home.jsx';
import Projects from './screens/Projects.jsx';
import Workspaces from './screens/Workspaces.jsx';
import Backups, { FullBackupModal } from './screens/Backups.jsx';
import Transfer from './screens/Transfer.jsx';
import Activity from './screens/Activity.jsx';
import Settings from './screens/Settings.jsx';
import DailyQuestion from './screens/DailyQuestion.jsx';

const NAV = [
  { id: 'home', icon: LayoutDashboard, screen: Home },
  { id: 'projects', icon: Brain, screen: Projects },
  { id: 'workspaces', icon: FolderTree, screen: Workspaces },
  { id: 'backups', icon: Archive, screen: Backups },
  { id: 'transfer', icon: ArrowLeftRight, screen: Transfer },
  { id: 'activity', icon: History, screen: Activity },
  { id: 'settings', icon: SettingsIcon, screen: Settings },
];

// What the app is mostly opened for, in the same place and order on every screen. The screens do not repeat these.
function QuickActions() {
  const { go, toast, refresh } = useApp();
  const [busy, setBusy] = useState(false);
  const [full, setFull] = useState(false);

  const backupNow = async () => {
    setBusy(true);
    try {
      const r = await api.createBackup('manual');
      toast(t('common.backupVerified', { contents: [count('projects', r.stats.projects), count('memoryFiles', r.stats.memoryFiles), r.chats ? count('chats', r.chats) : null].filter(Boolean).join(', ') }));
      refresh();
    } catch (e) {
      toast(errorText(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="sidebar-actions" role="group" aria-label={t('app.quickActions')}>
        <div className="sidebar-label">{t('app.quickActions')}</div>
        <Button icon={Save} onClick={backupNow} disabled={busy} title={t('app.actionHint.backupNow')} data-testid="backup-now">{busy ? t('common.backingUp') : t('common.backupNow')}</Button>
        <Button icon={HardDrive} onClick={() => setFull(true)} title={t('app.actionHint.full')} data-testid="full-backup">{t('backups.full.button')}</Button>
        <Button icon={PackagePlus} onClick={() => go('transfer', { tab: 'export' })} title={t('app.actionHint.create')} data-testid="quick-create">{t('common.createBundle')}</Button>
        <Button icon={Download} onClick={() => go('transfer', { tab: 'import' })} title={t('app.actionHint.import')} data-testid="quick-import">{t('common.importBundle')}</Button>
      </div>
      {full ? <FullBackupModal onClose={() => setFull(false)} /> : null}
    </>
  );
}

export default function App() {
  const [route, setRoute] = useState({ id: 'home', params: {}, n: 0 });
  const [version, setVersion] = useState(0);
  const [device, setDevice] = useState(null);
  const [daily, setDaily] = useState(null);
  const [toasts, setToasts] = useState([]);
  const [lang, setLang] = useState(language);
  const [, setClock] = useState(0);

  const go = useCallback((id, params = {}) => setRoute((r) => ({ id, params, n: r.n + 1 })), []);
  const refresh = useCallback(() => setVersion((v) => v + 1), []);
  const toast = useCallback((text, tone = '') => {
    const id = `${Date.now()}-${Math.random()}`;
    setToasts((list) => [...list, { id, text, tone }]);
    setTimeout(() => setToasts((list) => list.filter((x) => x.id !== id)), tone === 'error' ? 8000 : 4500);
  }, []);
  // Every screen is drawn again in the new language.
  const changeLanguage = useCallback((code) => {
    setLanguage(code);
    setLang(language());
  }, []);

  // Relative times ("3 minutes ago") are drawn again every 30 seconds.
  useEffect(() => {
    const id = setInterval(() => setClock((n) => n + 1), 30 * 1000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    api.settings().then((s) => {
      setHome(s.device.home);
      setDevice(s.device);
    }).catch(() => {});
    api.dailyStatus().then(setDaily).catch(() => {});
  }, [version]);

  // A bundle opened from Finder/Explorer (double click), a second launch or dropped on the window.
  useEffect(() => {
    const openPending = async () => {
      const p = await shell.takePendingBundle();
      if (p) go('transfer', { bundle: p });
    };
    openPending();
    const offs = [shell.on('open-bundle', openPending), shell.on('changed', refresh)];
    window.__cms = { go, refresh };
    return () => offs.forEach((off) => off());
  }, [go, refresh]);

  const onDrop = (e) => {
    e.preventDefault();
    const f = e.dataTransfer.files && e.dataTransfer.files[0];
    if (!f) return;
    const p = shell.pathForFile(f);
    if (p && p.toLowerCase().endsWith('.memsync')) go('transfer', { bundle: p });
    else toast(t('app.onlyBundles'), 'error');
  };

  const ctx = useMemo(() => ({ go, refresh, toast, version, device, changeLanguage }), [go, refresh, toast, version, device, changeLanguage]);
  const current = NAV.find((n) => n.id === route.id) || NAV[0];
  const Screen = current.screen;

  return (
    <AppContext.Provider value={ctx}>
      <div className="app" key={lang} onDragOver={(e) => e.preventDefault()} onDrop={onDrop}>
        <aside className="sidebar">
          <div className="brand">
            <div className="brand-mark">
              <Brain size={18} />
            </div>
            <div>
              <div className="brand-name">Claude Memory Sync</div>
              <div className="brand-sub">{t('app.tagline')}</div>
            </div>
          </div>
          {NAV.map((n) => (
            <button key={n.id} type="button" className={`nav-item ${n.id === current.id ? 'active' : ''}`} onClick={() => go(n.id)} data-nav={n.id}>
              <n.icon size={17} strokeWidth={1.9} />
              {t(`nav.${n.id}`)}
            </button>
          ))}
          <QuickActions />
          <div className="sidebar-foot">
            {device ? (
              <>
                <div className="strong" style={{ color: 'var(--text-2)' }}>{device.name}</div>
                <div>{device.platformName} · {t('app.version', { version: device.appVersion })}</div>
              </>
            ) : null}
            {daily ? (
              <div style={{ marginTop: 6 }}>
                <span className="dot" style={{ background: daily.enabled ? 'var(--green)' : 'var(--border-strong)' }} />
                {daily.enabled ? t('app.dailyOn', { time: daily.time }) : t('app.dailyOff')}
              </div>
            ) : null}
          </div>
        </aside>
        <main className="main">
          <Screen key={`${route.id}-${route.n}`} params={route.params} />
        </main>
      </div>
      {daily && daily.ask ? <DailyQuestion daily={daily} /> : null}
      <div className="toasts">
        {toasts.map((x) => (
          <div key={x.id} className={`toast ${x.tone}`}>
            {x.text}
          </div>
        ))}
      </div>
    </AppContext.Provider>
  );
}
