import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { LayoutDashboard, Brain, FolderTree, Archive, ArrowLeftRight, History, Settings as SettingsIcon, Save, HardDrive, PackagePlus, Download, Loader2 } from 'lucide-react';
import { api, shell, errorText } from './api.js';
import { AppContext, useApp, Button } from './ui.jsx';
import { setHome, count, fmtBytes } from './format.js';
import { t, language, setLanguage } from './i18n.js';
import Home from './screens/Home.jsx';
import Projects from './screens/Projects.jsx';
import Workspaces from './screens/Workspaces.jsx';
import Backups, { FullBackupModal } from './screens/Backups.jsx';
import Transfer from './screens/Transfer.jsx';
import Activity from './screens/Activity.jsx';
import Settings from './screens/Settings.jsx';
import { BackupQuestion, SetupBackups } from './screens/BackupSet.jsx';

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
  const [setup, setSetup] = useState(false);

  const backupNow = async () => {
    setBusy(true);
    try {
      const r = await api.createBackup('manual');
      toast(t('common.backupVerified', { contents: [count('projects', r.stats.projects), count('memoryFiles', r.stats.memoryFiles), r.chats ? count('chats', r.chats) : null].filter(Boolean).join(', ') }));
      refresh();
    } catch (e) {
      // Not set up yet: the way to set them up opens instead.
      if (e.code === 'NO_BACKUP_SET') setSetup(true);
      else toast(errorText(e), e.code === 'CANCELLED' ? '' : 'error');
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
      {setup ? <SetupBackups onClose={() => { setSetup(false); refresh(); }} /> : null}
    </>
  );
}

// Over everything while a backup runs, by whichever way it started. The rest of the window takes no clicks or keys until it
// ends. It keeps its own state, so the screens below are not drawn again at every step of the bar.
function BackupOverlay({ onBusy }) {
  const [job, setJob] = useState(null);
  const box = useRef(null);
  const active = Boolean(job);
  useEffect(() => {
    shell.backupState().then(setJob).catch(() => {});
    return shell.on('backup-progress', setJob);
  }, []);
  useEffect(() => {
    onBusy(active);
    if (!active) return undefined;
    // The buttons and modals below listen on the window (Esc closes a modal).
    const stopKeys = (e) => {
      if (box.current && box.current.contains(e.target)) return;
      e.preventDefault();
      e.stopPropagation();
    };
    window.addEventListener('keydown', stopKeys, true);
    return () => window.removeEventListener('keydown', stopKeys, true);
  }, [active, onBusy]);
  if (!job) return null;
  const ignore = (e) => e.preventDefault();
  return (
    <div className="backup-overlay" role="alertdialog" aria-modal="true" aria-label={t(`backupJob.title.${job.kind}`)} onDragOver={ignore} onDrop={ignore} data-testid="backup-overlay">
      <div className="backup-card" ref={box}>
        <Loader2 size={26} className="spin" />
        <div className="backup-title">{t(`backupJob.title.${job.kind}`)}</div>
        <div className="muted small">{job.stopping ? t('backupJob.stopping') : t(`backupJob.phase.${job.phase}`)}</div>
        {/* restic says how far it is only while it writes or reads files; the other steps show only that it works. */}
        <div className={`progress ${job.percent == null ? 'indeterminate' : ''}`} role="progressbar" aria-valuemin={0} aria-valuenow={job.percent ?? undefined} aria-valuemax={100}>
          <div style={job.percent == null ? undefined : { width: `${job.percent}%` }} />
        </div>
        {job.percent != null ? <div className="strong">{Math.round(job.percent)}%</div> : null}
        {job.estimate ? <div className="muted small">{t('backupJob.estimate', { size: fmtBytes(job.estimate) })}</div> : null}
        <div className="muted small">{t(`backupJob.note.${job.kind}`)}</div>
        {job.kind !== 'setup' ? <Button autoFocus onClick={() => shell.stopBackup()} disabled={job.stopping} data-testid="backup-stop">{t('backupJob.stop')}</Button> : null}
      </div>
    </div>
  );
}

export default function App() {
  const [route, setRoute] = useState({ id: 'home', params: {}, n: 0 });
  const [version, setVersion] = useState(0);
  const [device, setDevice] = useState(null);
  const [backups, setBackups] = useState(null);
  // The question stays until it is answered, also when the backups get set up meanwhile: its window shows the
  // recovery code then.
  const [asking, setAsking] = useState(false);
  const [toasts, setToasts] = useState([]);
  const [lang, setLang] = useState(language);
  const [, setClock] = useState(0);
  const [backingUp, setBackingUp] = useState(false);

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
    api.backupStatus().then((st) => {
      setBackups(st);
      if (st.ask) setAsking(true);
    }).catch(() => {});
  }, [version]);

  // A bundle opened from Finder/Explorer (double click), a second launch or dropped on the window.
  useEffect(() => {
    const openPending = async () => {
      const p = await shell.takePendingBundle();
      if (p) go('transfer', { bundle: p });
    };
    openPending();
    const offs = [shell.on('open-bundle', openPending), shell.on('changed', refresh), shell.on('navigate', (id) => go(id))];
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
      <div className="app" key={lang} inert={backingUp || undefined} onDragOver={(e) => e.preventDefault()} onDrop={onDrop}>
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
            {backups ? (
              <div style={{ marginTop: 6 }}>
                <span className="dot" style={{ background: backups.set && backups.set.status === 'ok' ? 'var(--green)' : backups.set ? 'var(--amber)' : 'var(--border-strong)' }} />
                {backups.set ? t(`backups.status.${backups.set.status}`) : t('app.backupsOff')}
              </div>
            ) : null}
          </div>
        </aside>
        <main className="main">
          <Screen key={`${route.id}-${route.n}`} params={route.params} />
        </main>
      </div>
      {asking ? <BackupQuestion onDone={() => { setAsking(false); refresh(); }} /> : null}
      <BackupOverlay onBusy={setBackingUp} />
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
