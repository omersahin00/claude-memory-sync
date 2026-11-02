import React, { useEffect, useMemo, useState } from 'react';
import { Archive, CalendarClock, ShieldCheck, Hand, Package, Inbox, FolderInput, FolderOpen, Trash2, Eye, Download, RotateCcw, TriangleAlert, Brain, FolderTree, Settings2, FileText, HardDrive, Info, MessagesSquare, SlidersHorizontal } from 'lucide-react';
import { api, shell, errorText } from '../api.js';
import { useApp, Card, Badge, Button, PageHead, Path, PathLink, Loading, Empty, Drawer, Banner, Modal } from '../ui.jsx';
import { fmtDate, fmtRelative, fmtBytes, count, label, contents, KIND_TONE } from '../format.js';
import { t } from '../i18n.js';
import BackupContent from './BackupContent.jsx';
import BackupFolder from './BackupFolder.jsx';

const KIND_ICON = { daily: CalendarClock, before: ShieldCheck, manual: Hand, export: Package, full: HardDrive };
const TYPE_ICON = { project: Brain, workspaceRoot: FolderTree, claude: Settings2 };
const TABS = ['all', 'daily', 'before', 'manual', 'export', 'full', 'foreign'];
const BACKUP_TYPES = [['manual', Hand], ['daily', CalendarClock], ['before', ShieldCheck], ['full', HardDrive], ['export', Package]];

// What each kind of backup is for: the difference between Back up now and Full backup above all.
function BackupTypes({ onClose }) {
  return (
    <Modal title={t('backups.help.title')} onClose={onClose} wide footer={<Button variant="primary" onClick={onClose}>{t('common.close')}</Button>}>
      <Banner tone="info" icon={Info}>{t('backups.help.summary')}</Banner>
      <div className="rows">
        {BACKUP_TYPES.map(([kind, Icon]) => (
          <div key={kind} className="row" style={{ alignItems: 'flex-start', padding: '12px 2px' }}>
            <div className={`row-icon ${KIND_TONE[kind]}`}><Icon size={16} /></div>
            <div className="row-main">
              <div className="row-title">{label('kind', kind)}</div>
              <div className="muted small" style={{ whiteSpace: 'normal', marginTop: 2 }}>{t(`backups.help.${kind}`)}</div>
            </div>
          </div>
        ))}
      </div>
    </Modal>
  );
}

const inTab = (b, tab) => (tab === 'all' ? true : tab === 'foreign' ? !b.isMine : tab === 'full' ? b.kind === 'full' : b.isMine && b.kind === tab);


// Everything of this device in one file, to bring back after the computer is reset.
export function FullBackupModal({ onClose }) {
  const { toast, refresh } = useApp();
  const [preview, setPreview] = useState(null);
  const [outDir, setOutDir] = useState(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  useEffect(() => {
    api.fullBackupPreview().then((p) => {
      setPreview(p);
      setOutDir(p.outDir);
    }).catch((e) => toast(errorText(e), 'error'));
  }, [toast]);
  const create = async () => {
    setBusy(true);
    try {
      setResult(await api.createFullBackup({ outDir }));
      refresh();
    } catch (e) {
      toast(errorText(e), 'error');
    } finally {
      setBusy(false);
    }
  };
  const chooseFolder = async () => {
    const p = await shell.chooseFolder({ title: t('backups.full.chooseFolder'), defaultPath: outDir });
    if (p) setOutDir(p);
  };
  const footer = result ? (
    <>
      <Button icon={FolderOpen} onClick={() => shell.reveal(result.path)}>{t('common.showInFolder')}</Button>
      <Button variant="primary" onClick={onClose}>{t('transfer.result.close')}</Button>
    </>
  ) : (
    <>
      <Button onClick={onClose}>{t('common.cancel')}</Button>
      <Button variant="primary" icon={HardDrive} onClick={create} disabled={busy || !preview} data-testid="full-create">{busy ? t('transfer.export.creating') : t('backups.full.create')}</Button>
    </>
  );
  return (
    <Modal title={t('backups.full.title')} onClose={onClose} footer={footer} wide>
      {result ? (
        <>
          <Banner tone="ok" icon={ShieldCheck}>{t('backups.full.done')}</Banner>
          <dl className="kv">
            <dt>{t('common.file')}</dt>
            <dd><PathLink path={result.path} /></dd>
            <dt>{t('backups.size')}</dt>
            <dd>{fmtBytes(result.size)}</dd>
            {result.chats ? (<><dt>{t('common.chats')}</dt><dd>{count('chats', result.chats)}</dd></>) : null}
          </dl>
          <p className="muted">{t('backups.full.next')}</p>
        </>
      ) : !preview ? <Loading /> : (
        <>
          <p style={{ marginTop: 0 }}>{t('backups.full.intro')}</p>
          <dl className="kv">
            <dt>{t('nav.projects')}</dt>
            <dd>{count('projects', preview.stats.projects)}, {count('memoryFiles', preview.stats.memoryFiles)}</dd>
            <dt>{t('common.workspaceFiles')}</dt>
            <dd>{count('files', preview.stats.workspaceFiles)}</dd>
            <dt>{t('common.claudeSettings')}</dt>
            <dd>{count('files', preview.stats.claudeFiles)}</dd>
            <dt>{t('common.chats')}</dt>
            <dd>{t('transfer.export.chatsCount', { count: preview.chats.count, size: fmtBytes(preview.chats.bytes) })}</dd>
            <dt>{t('common.appData')}</dt>
            <dd>{t('backups.full.appData', { count: preview.activity })}</dd>
            <dt>{t('nav.backups')}</dt>
            <dd>{t('backups.full.backups', { count: preview.backups.count, size: fmtBytes(preview.backups.bytes) })}</dd>
            <dt>{t('transfer.export.saveTo')}</dt>
            <dd>
              <span className="row-flex" style={{ alignItems: 'flex-start' }}>
                <Path>{`${outDir}/${preview.fileName}`}</Path>
                <Button size="sm" onClick={chooseFolder}>{t('common.change')}</Button>
              </span>
            </dd>
          </dl>
          <Banner tone="warn" icon={TriangleAlert}>{t('backups.full.keepOff')}</Banner>
        </>
      )}
    </Modal>
  );
}

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
  const projectName = (key) => {
    const loc = b && b.locations.find((l) => l.type === 'project' && l.key === key);
    return (loc && loc.name) || key;
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
            {b.full ? (<><dt>{t('common.appData')}</dt><dd>{t('backups.full.drawer', { count: b.full.backups })}</dd></>) : null}
          </dl>
          {b.locations.filter((loc) => loc.memory !== false).map((loc) => {
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
          {b.chatList.length ? (
            <div>
              <div className="section-label row-flex" style={{ textTransform: 'none', letterSpacing: 0, fontSize: 13, color: 'var(--text)' }}>
                <MessagesSquare size={15} /> {t('common.chats')}
                <span className="muted small" style={{ fontWeight: 400 }}>{t('transfer.export.chatsCount', { count: b.chats.count, size: fmtBytes(b.chats.bytes) })}</span>
              </div>
              <Card>
                <div className="rows">
                  {b.chatList.map((c) => (
                    <div key={c.id} className="row" style={{ padding: '6px 14px' }}>
                      <MessagesSquare size={14} style={{ color: 'var(--text-3)', flex: 'none' }} />
                      <div className="row-main">
                        <div className="row-title" style={{ fontWeight: 500 }}>{c.title || t('transfer.export.untitled')}</div>
                        <div className="row-sub">{[projectName(c.project), c.entrypoint ? label('entrypoint', c.entrypoint) : null].filter(Boolean).join(' · ')}</div>
                      </div>
                      <span className="muted small">{fmtBytes(c.size)}</span>
                    </div>
                  ))}
                </div>
              </Card>
            </div>
          ) : null}
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
  const [dir, setDir] = useState(null);
  const [content, setContent] = useState(false);
  const [help, setHelp] = useState(false);
  const [elsewhere, setElsewhere] = useState(null);
  const [moving, setMoving] = useState(null);

  useEffect(() => {
    api.library().then(setLib).catch((e) => toast(errorText(e), 'error'));
    api.settings().then((s) => setDir(s.device.backupDir));
    api.backupsElsewhere().then(setElsewhere).catch(() => {});
  }, [version, toast]);

  const list = useMemo(() => {
    if (!lib) return [];
    return lib.filter((b) => inTab(b, tab));
  }, [lib, tab]);

  if (!lib) return <Loading />;

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
      <PageHead title={t('nav.backups')} sub={t('backups.sub')} onHelp={() => setHelp(true)} helpLabel={t('backups.help.title')}>
        <Button icon={FolderOpen} onClick={() => dir && shell.openPath(dir)}>{t('backups.openFolder')}</Button>
        <Button icon={SlidersHorizontal} onClick={() => setContent(true)} data-testid="backup-content">{t('settings.backup.content')}</Button>
      </PageHead>

      {elsewhere && elsewhere.count ? (
        <Banner tone="info" icon={FolderInput} action={<Button size="sm" variant="primary" icon={FolderInput} onClick={() => setMoving({})} data-testid="backups-elsewhere">{t('settings.backup.moveHere')}</Button>}>
          {t('backups.elsewhere', { count: elsewhere.count, size: fmtBytes(elsewhere.bytes) })}
          {elsewhere.dirs.map((d) => <div key={d.dir}><Path>{d.dir}</Path></div>)}
        </Banner>
      ) : null}

      <div className="tabs">
        {TABS.map((id) => {
          const n = lib.filter((b) => inTab(b, id)).length;
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
              const isFull = b.kind === 'full';
              const Icon = b.isMine || isFull ? KIND_ICON[b.kind] || Archive : Inbox;
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
                          <Badge tone={b.isMine ? KIND_TONE[b.kind] : 'amber'}>{b.isMine ? label('kind', b.kind) : isFull ? `${label('kind', 'full')} · ${b.device.name}` : `${b.device.name} · ${b.device.platformName}`}</Badge>
                          {b.imported ? <Badge tone="green">{t('common.imported')}</Badge> : null}
                          {b.version === 1 ? <Badge>{t('backups.oldVersion')}</Badge> : null}
                        </>
                      )}
                    </div>
                    <div className="row-sub">
                      {b.error ? b.error.message : `${contents(b.stats, b.chats)} · ${fmtBytes(b.size)} · ${fmtRelative(b.createdAt)}`}
                    </div>
                    <div className="row-sub"><Path>{b.path}</Path></div>
                  </div>
                  <div className="row-side">
                    {!b.error ? <Button size="sm" icon={Eye} onClick={() => setOpen(b.path)}>{t('common.contents')}</Button> : null}
                    {!b.error && isFull ? <Button size="sm" variant={b.isMine ? '' : 'primary'} icon={RotateCcw} onClick={() => go('transfer', { bundle: b.path })}>{t('backups.full.restore')}</Button> : null}
                    {!b.error && !isFull && !b.isMine ? <Button size="sm" variant="primary" icon={Download} onClick={() => go('transfer', { bundle: b.path, mode: 'sync' })}>{t('backups.import')}</Button> : null}
                    {!b.error && !isFull && b.isMine ? <Button size="sm" icon={RotateCcw} onClick={() => go('transfer', { bundle: b.path, mode: 'restore' })}>{t('backups.restore')}</Button> : null}
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
      {content ? <BackupContent onClose={() => setContent(false)} /> : null}
      {help ? <BackupTypes onClose={() => setHelp(false)} /> : null}
      {moving ? <BackupFolder request={moving} onClose={() => setMoving(null)} /> : null}
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
