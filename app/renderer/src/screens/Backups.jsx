import React, { useEffect, useMemo, useState } from 'react';
import { Archive, CalendarClock, ShieldCheck, Hand, Package, Inbox, FolderOpen, Trash2, Eye, Download, RotateCcw, TriangleAlert, Save, Brain, FolderTree, Settings2, FileText } from 'lucide-react';
import { api, shell, errorText } from '../api.js';
import { useApp, Card, Badge, Button, PageHead, Path, PathLink, Loading, Empty, Drawer, Banner, Modal } from '../ui.jsx';
import { fmtDate, fmtRelative, fmtBytes, count, label, KIND_TONE } from '../format.js';
import { t } from '../i18n.js';

const KIND_ICON = { daily: CalendarClock, before: ShieldCheck, manual: Hand, export: Package };
const TYPE_ICON = { project: Brain, workspaceRoot: FolderTree, claude: Settings2 };
const TABS = ['all', 'daily', 'before', 'manual', 'export', 'foreign'];

export const contents = (s) => (s ? [count('projects', s.projects), count('memoryFiles', s.memoryFiles), s.workspaceFiles ? count('workspaces', s.workspaceFiles) : null, s.claudeFiles ? count('claudeFiles', s.claudeFiles) : null].filter(Boolean).join(' · ') : '');

function BundleDrawer({ path, onClose }) {
  const [b, setB] = useState(null);
  const [err, setErr] = useState(null);
  const [file, setFile] = useState(null);
  useEffect(() => {
    api.bundleContents(path).then(setB).catch(setErr);
  }, [path]);
  const openFile = async (key) => {
    try {
      setFile({ key, ...(await api.bundleFile(path, key)) });
    } catch (e) {
      setFile({ key, error: errorText(e) });
    }
  };
  return (
    <Drawer title={b ? fmtDate(b.createdAt) : t('common.bundle')} sub={b ? `${label('kind', b.kind) || t('common.bundle')} · ${b.device.name} (${b.device.platformName})` : null} onClose={onClose}>
      {err ? <Banner tone="error" icon={TriangleAlert}>{errorText(err)}</Banner> : !b ? <Loading /> : (
        <>
          <Banner tone="ok" icon={ShieldCheck}>{t('backups.verified', { count: b.stats.memoryFiles + b.stats.workspaceFiles + b.stats.claudeFiles })}</Banner>
          <dl className="kv">
            <dt>{t('common.file')}</dt>
            <dd><PathLink path={b.path} /></dd>
            <dt>{t('common.createdBy')}</dt>
            <dd>{b.device.name} · {b.device.platformName}{b.isMine ? ` (${t('common.thisDevice')})` : ''}</dd>
            <dt>{t('backups.size')}</dt>
            <dd>{t('backups.compressed', { size: fmtBytes(b.size) })}</dd>
            <dt>{t('common.status')}</dt>
            <dd>{b.imported ? t('backups.state.imported') : b.isMine ? t('backups.state.mine') : t('backups.state.notImported')}</dd>
          </dl>
          {b.locations.map((loc) => {
            const Icon = TYPE_ICON[loc.type] || Archive;
            const files = b.files.filter((f) => f.location === loc.id);
            return (
              <div key={loc.id}>
                <div className="section-label row-flex" style={{ textTransform: 'none', letterSpacing: 0, fontSize: 13, color: 'var(--text)' }}>
                  <Icon size={15} /> {loc.name || loc.key}
                  <Badge>{label('type', loc.type)}</Badge>
                  <span className="muted small" style={{ fontWeight: 400 }}>{count('files', files.length)}</span>
                </div>
                {loc.path ? <div className="small muted" style={{ marginTop: -4, marginBottom: 6 }}>{t('common.source', { path: <Path>{loc.path}</Path> })}</div> : null}
                <Card>
                  <div className="rows">
                    {files.map((f) => (
                      <div key={f.key} className="row clickable" style={{ padding: '6px 14px' }} onClick={() => openFile(f.key)}>
                        <FileText size={14} style={{ color: 'var(--text-3)', flex: 'none' }} />
                        <div className="row-main"><div className="row-title" style={{ fontWeight: 500 }}>{f.rel}</div></div>
                        <span className="muted small">{fmtBytes(f.size)}</span>
                      </div>
                    ))}
                  </div>
                </Card>
              </div>
            );
          })}
        </>
      )}
      {file ? (
        <Modal title={file.key} onClose={() => setFile(null)} wide>
          {file.error ? <Banner tone="error">{file.error}</Banner> : file.binary ? <div className="muted">{t('backups.binary')}</div> : <pre className="preview">{file.text}</pre>}
        </Modal>
      ) : null}
    </Drawer>
  );
}

export default function Backups() {
  const { version, refresh, toast, go } = useApp();
  const [lib, setLib] = useState(null);
  const [tab, setTab] = useState('all');
  const [open, setOpen] = useState(null);
  const [trash, setTrash] = useState(null);
  const [busy, setBusy] = useState(false);
  const [dir, setDir] = useState(null);

  useEffect(() => {
    api.library().then(setLib).catch((e) => toast(errorText(e), 'error'));
    api.settings().then((s) => setDir(s.device.backupDir));
  }, [version, toast]);

  const list = useMemo(() => {
    if (!lib) return [];
    if (tab === 'all') return lib;
    if (tab === 'foreign') return lib.filter((b) => !b.isMine);
    return lib.filter((b) => b.isMine && b.kind === tab);
  }, [lib, tab]);

  if (!lib) return <Loading />;

  const backupNow = async () => {
    setBusy(true);
    try {
      const r = await api.createBackup('manual');
      toast(t('common.backupVerified', { contents: count('memoryFiles', r.stats.memoryFiles) }));
      refresh();
    } catch (e) {
      toast(errorText(e), 'error');
    } finally {
      setBusy(false);
    }
  };
  const doTrash = async () => {
    try {
      await shell.trash(trash.path);
      toast(t('backups.trashed'));
      setTrash(null);
      refresh();
    } catch (e) {
      toast(errorText(e), 'error');
    }
  };

  return (
    <div className="page">
      <PageHead title={t('nav.backups')} sub={t('backups.sub')}>
        <Button icon={FolderOpen} onClick={() => dir && shell.openPath(dir)}>{t('backups.openFolder')}</Button>
        <Button variant="primary" icon={Save} onClick={backupNow} disabled={busy}>{busy ? t('common.backingUp') : t('common.backupNow')}</Button>
      </PageHead>

      <div className="tabs">
        {TABS.map((id) => {
          const n = id === 'all' ? lib.length : id === 'foreign' ? lib.filter((b) => !b.isMine).length : lib.filter((b) => b.isMine && b.kind === id).length;
          return (
            <button key={id} type="button" className={`tab ${tab === id ? 'on' : ''}`} onClick={() => setTab(id)}>
              {t(`backups.tab.${id}`)} <span className="muted small">{n}</span>
            </button>
          );
        })}
      </div>

      <Card>
        {list.length ? (
          <div className="rows">
            {list.map((b) => {
              const Icon = b.isMine ? KIND_ICON[b.kind] || Archive : Inbox;
              return (
                <div key={b.path} className="row">
                  <div className={`row-icon ${b.error ? 'red' : b.isMine ? KIND_TONE[b.kind] || '' : 'amber'}`}>
                    <Icon size={16} />
                  </div>
                  <div className="row-main">
                    <div className="row-flex">
                      <span className="row-title">{b.createdAt ? fmtDate(b.createdAt) : b.name}</span>
                      {b.error ? <Badge tone="red">{t('common.unreadable')}</Badge> : (
                        <>
                          <Badge tone={b.isMine ? KIND_TONE[b.kind] : 'amber'}>{b.isMine ? label('kind', b.kind) : `${b.device.name} · ${b.device.platformName}`}</Badge>
                          {b.imported ? <Badge tone="green">{t('common.imported')}</Badge> : null}
                          {b.version === 1 ? <Badge>{t('backups.oldVersion')}</Badge> : null}
                        </>
                      )}
                    </div>
                    <div className="row-sub">
                      {b.error ? b.error.message : `${contents(b.stats)} · ${fmtBytes(b.size)} · ${fmtRelative(b.createdAt)}`}
                    </div>
                    <div className="row-sub"><Path>{b.path}</Path></div>
                  </div>
                  <div className="row-side">
                    {!b.error ? <Button size="sm" icon={Eye} onClick={() => setOpen(b.path)}>{t('common.contents')}</Button> : null}
                    {!b.error && !b.isMine ? <Button size="sm" variant="primary" icon={Download} onClick={() => go('transfer', { bundle: b.path, mode: 'sync' })}>{t('backups.import')}</Button> : null}
                    {!b.error && b.isMine ? <Button size="sm" icon={RotateCcw} onClick={() => go('transfer', { bundle: b.path, mode: 'restore' })}>{t('backups.restore')}</Button> : null}
                    <Button size="sm" variant="ghost" className="icon" title={t('common.showInFolder')} onClick={() => shell.reveal(b.path)}><FolderOpen size={14} /></Button>
                    <Button size="sm" variant="ghost" className="icon" title={t('backups.trash')} onClick={() => setTrash(b)}><Trash2 size={14} /></Button>
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <Empty icon={Archive} title={t('backups.empty')}>
            {tab === 'foreign' ? t('backups.emptyForeign') : t('backups.emptyHint')}
          </Empty>
        )}
      </Card>

      {open ? <BundleDrawer path={open} onClose={() => setOpen(null)} /> : null}
      {trash ? (
        <Modal title={t('backups.trashTitle')} onClose={() => setTrash(null)}
          footer={<><Button onClick={() => setTrash(null)}>{t('common.cancel')}</Button><Button variant="primary" icon={Trash2} onClick={doTrash}>{t('backups.trash')}</Button></>}>
          <p style={{ marginTop: 0 }}>{t('backups.trashText', { name: trash.createdAt ? fmtDate(trash.createdAt) : trash.name })}</p>
          <Path>{trash.path}</Path>
        </Modal>
      ) : null}
    </div>
  );
}
