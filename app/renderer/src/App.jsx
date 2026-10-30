import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { LayoutDashboard, Brain, FolderTree, Archive, ArrowLeftRight, History, Settings as SettingsIcon } from 'lucide-react';
import { api, shell } from './api.js';
import { AppContext } from './ui.jsx';
import { setHome } from './format.js';
import Home from './screens/Home.jsx';
import Projects from './screens/Projects.jsx';
import Workspaces from './screens/Workspaces.jsx';
import Backups from './screens/Backups.jsx';
import Transfer from './screens/Transfer.jsx';
import Activity from './screens/Activity.jsx';
import Settings from './screens/Settings.jsx';

const NAV = [
  { id: 'home', label: 'Genel Bakış', icon: LayoutDashboard, screen: Home },
  { id: 'projects', label: 'Hafızalar', icon: Brain, screen: Projects },
  { id: 'workspaces', label: 'Workspace’ler', icon: FolderTree, screen: Workspaces },
  { id: 'backups', label: 'Yedekler', icon: Archive, screen: Backups },
  { id: 'transfer', label: 'Aktarım', icon: ArrowLeftRight, screen: Transfer },
  { id: 'activity', label: 'Geçmiş', icon: History, screen: Activity },
  { id: 'settings', label: 'Ayarlar', icon: SettingsIcon, screen: Settings },
];

export default function App() {
  const [route, setRoute] = useState({ id: 'home', params: {}, n: 0 });
  const [version, setVersion] = useState(0);
  const [device, setDevice] = useState(null);
  const [daily, setDaily] = useState(null);
  const [toasts, setToasts] = useState([]);

  const go = useCallback((id, params = {}) => setRoute((r) => ({ id, params, n: r.n + 1 })), []);
  const refresh = useCallback(() => setVersion((v) => v + 1), []);
  const toast = useCallback((text, tone = '') => {
    const id = `${Date.now()}-${Math.random()}`;
    setToasts((t) => [...t, { id, text, tone }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), tone === 'error' ? 8000 : 4500);
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
    else toast('Yalnızca .memsync paket dosyaları açılabilir.', 'error');
  };

  const ctx = useMemo(() => ({ go, refresh, toast, version, device }), [go, refresh, toast, version, device]);
  const current = NAV.find((n) => n.id === route.id) || NAV[0];
  const Screen = current.screen;

  return (
    <AppContext.Provider value={ctx}>
      <div className="app" onDragOver={(e) => e.preventDefault()} onDrop={onDrop}>
        <aside className="sidebar">
          <div className="brand">
            <div className="brand-mark">
              <Brain size={18} />
            </div>
            <div>
              <div className="brand-name">Claude Memory Sync</div>
              <div className="brand-sub">Hafıza yedekleme ve aktarım</div>
            </div>
          </div>
          {NAV.map((n) => (
            <button key={n.id} type="button" className={`nav-item ${n.id === current.id ? 'active' : ''}`} onClick={() => go(n.id)} data-nav={n.id}>
              <n.icon size={17} strokeWidth={1.9} />
              {n.label}
            </button>
          ))}
          <div className="sidebar-foot">
            {device ? (
              <>
                <div className="strong" style={{ color: 'var(--text-2)' }}>{device.name}</div>
                <div>{device.platformName} · sürüm {device.appVersion}</div>
              </>
            ) : null}
            {daily ? (
              <div style={{ marginTop: 6 }}>
                <span className="dot" style={{ background: daily.enabled ? 'var(--green)' : 'var(--border-strong)' }} />
                {daily.enabled ? `Günlük yedek açık · ${daily.time}` : 'Günlük yedek kapalı'}
              </div>
            ) : null}
          </div>
        </aside>
        <main className="main">
          <Screen key={`${route.id}-${route.n}`} params={route.params} />
        </main>
      </div>
      <div className="toasts">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.tone}`}>
            {t.text}
          </div>
        ))}
      </div>
    </AppContext.Provider>
  );
}
