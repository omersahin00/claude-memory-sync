import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Archive, CalendarClock, ShieldCheck, ShieldAlert, Package, Inbox, FolderOpen, Trash2, Eye, Download, RotateCcw, TriangleAlert, Brain, FolderTree, Settings2, FileText, HardDrive, Info, MessagesSquare, SlidersHorizontal, Save, Lock, Wrench, RefreshCw, Clock, ExternalLink, FolderArchive } from 'lucide-react';
import { api, shell, errorText, openFolder } from '../api.js';
import { useApp, Card, Badge, Button, PageHead, Path, PathLink, Loading, Empty, Drawer, Banner, Modal } from '../ui.jsx';
import { fmtDate, fmtRelative, fmtBytes, count, label, contents, scheduleText, KIND_TONE } from '../format.js';
import { t } from '../i18n.js';
import BackupContent from './BackupContent.jsx';
import { SetupBackups, OpenBackups, PasswordModal, ScheduleEditor, BackupSummary, StatusBadge } from './BackupSet.jsx';

const KIND_ICON = { backup: CalendarClock, before: ShieldCheck, export: Package, full: HardDrive };
const TYPE_ICON = { project: Brain, workspaceRoot: FolderTree, claude: Settings2 };
const TABS = ['all', 'export', 'full', 'foreign'];
const BACKUP_TYPES = [['backup', CalendarClock], ['before', ShieldCheck], ['full', HardDrive], ['export', Package]];

// What each kind is for: the backups in their encrypted folder, the full backup and the bundles in files of their own.
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

// When the backups are taken, and how many of the snapshots before an operation stay.
function BackupSettings({ set, onClose }) {
  const { toast, refresh } = useApp();
  const [sched, setSched] = useState(set.schedule);
  const [keepBefore, setKeepBefore] = useState(set.keepBefore);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      await api.backupSettings({ schedule: sched, keepBefore: Math.max(1, Number(keepBefore) || 1) });
      toast(t('common.saved'));
      refresh();
      onClose();
    } catch (e) {
      toast(errorText(e), 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title={t('backups.settings.title')} onClose={onClose} wide footer={<><Button onClick={onClose}>{t('common.cancel')}</Button><Button variant="primary" disabled={busy} onClick={save} data-testid="backup-settings-save">{t('common.save')}</Button></>}>
      <div className="stack">
        <ScheduleEditor value={sched} onChange={setSched} />
        <label className="field">
          <span className="field-label">{t('backups.settings.keepBefore')}</span>
          <input className="input" type="number" min="1" max="1000" style={{ width: 100 }} value={keepBefore} onChange={(e) => setKeepBefore(e.target.value)} data-testid="keep-before" />
          <span className="field-hint">{t('backups.settings.keepBeforeHint')}</span>
        </label>
        <div className="muted small">{t('backups.setup.keep')}</div>
      </div>
    </Modal>
  );
}

// A snapshot's name in the list: a backup, or the one before an operation and which.
const snapshotLabel = (x) => (x.kind === 'before' ? label('reason', x.reason) || label('kind', 'before') : label('kind', x.kind) || label('kind', 'backup'));

function SnapshotList({ set }) {
  const { version, toast, go } = useApp();
  const [list, setList] = useState(null);
  const [error, setError] = useState(null);
  const [open, setOpen] = useState(null);
  const [all, setAll] = useState(false);
  useEffect(() => {
    setError(null);
    api.snapshots().then(setList).catch(setError);
  }, [version, set.repo]);

  const openOne = async (x, then) => {
    try {
      const r = await api.openSnapshot(x.id);
      then(r);
    } catch (e) {
      if (e.code !== 'CANCELLED') toast(errorText(e), 'error');
    }
  };
  if (error) return <div className="card-pad"><Banner tone={error.code === 'TARGET_MISSING' ? 'warn' : 'error'} icon={TriangleAlert}>{errorText(error)}</Banner></div>;
  if (!list) return <Loading text={t('backups.snapshots.loading')} />;
  if (!list.length) return <Empty icon={Archive} title={t('backups.snapshots.empty')}>{t('backups.snapshots.emptyHint')}</Empty>;
  const shown = all ? list : list.slice(0, 25);
  return (
    <>
      <div className="rows">
        {shown.map((x) => {
          const Icon = x.mine ? KIND_ICON[x.kind] || Archive : Inbox;
          return (
            <div key={x.id} className="row" data-testid="snapshot">
              <div className={`row-icon ${x.mine ? KIND_TONE[x.kind] || '' : 'amber'}`}><Icon size={16} /></div>
              <div className="row-main">
                <div className="row-flex">
                  <span className="row-title">{fmtDate(x.time)}</span>
                  <Badge tone={x.mine ? KIND_TONE[x.kind] : 'amber'}>{x.mine ? snapshotLabel(x) : t('backups.snapshots.from', { host: x.host })}</Badge>
                </div>
                <div className="row-sub">
                  {[x.files != null ? count('files', x.files) : null, x.bytes != null ? fmtBytes(x.bytes) : null, x.added != null ? t('backups.snapshots.added', { size: fmtBytes(x.added) }) : null, fmtRelative(x.time)].filter(Boolean).join(' · ')}
                </div>
              </div>
              <div className="row-side">
                <Button size="sm" icon={Eye} onClick={() => openOne(x, (r) => setOpen(r.ref))} data-testid="snapshot-contents">{t('common.contents')}</Button>
                {x.mine ? (
                  <Button size="sm" icon={RotateCcw} onClick={() => openOne(x, (r) => go('transfer', { bundle: r.ref, mode: 'restore' }))} data-testid="snapshot-restore">{t('backups.restore')}</Button>
                ) : (
                  <Button size="sm" variant="primary" icon={Download} onClick={() => openOne(x, (r) => go('transfer', { bundle: r.ref, mode: 'sync' }))}>{t('backups.import')}</Button>
                )}
              </div>
            </div>
          );
        })}
      </div>
      {list.length > shown.length ? <div className="card-foot"><Button size="sm" variant="ghost" onClick={() => setAll(true)}>{t('backups.snapshots.more', { count: list.length - shown.length })}</Button></div> : null}
      {open ? <BundleDrawer path={open} onClose={() => setOpen(null)} /> : null}
    </>
  );
}

// Folder Backup on this computer: its sets, which it backs up itself; read here, and asked to back one up now.
function PeerCard() {
  const { version, toast } = useApp();
  const [peer, setPeer] = useState(undefined);
  const load = useCallback(() => shell.peerStatus().then(setPeer).catch(() => setPeer(null)), []);
  useEffect(() => {
    load();
    const id = setInterval(load, 5000);
    return () => clearInterval(id);
  }, [load, version]);
  if (!peer) return null;
  const ask = async (action, setId = null) => {
    try {
      await shell.askPeer(action, setId);
      if (action === 'backup') toast(t('backups.peer.started'));
      load();
    } catch (e) {
      toast(errorText(e), 'error');
    }
  };
  return (
    <Card className="mt" data-testid="peer-card">
      <div className="card-head">
        <FolderArchive size={16} />
        <div className="card-title">{t('backups.peer.title')}</div>
        <Badge tone={peer.running ? 'green' : ''}>{peer.running ? t('backups.peer.running') : t('backups.peer.notRunning')}</Badge>
        <div className="spacer" />
        <Button size="sm" icon={ExternalLink} onClick={() => ask('show')}>{t('backups.peer.open')}</Button>
      </div>
      <div className="card-pad muted small">{t('backups.peer.text')}</div>
      {peer.sets.length ? (
        <div className="rows">
          {peer.sets.map((x) => (
            <div key={x.id} className="row">
              <div className="row-icon"><FolderArchive size={16} /></div>
              <div className="row-main">
                <div className="row-flex">
                  <span className="row-title">{x.name}</span>
                  {peer.job && peer.job.setId === x.id ? <Badge tone="blue">{t('backups.status.running')}</Badge> : x.status ? <StatusBadge status={x.status} /> : null}
                </div>
                <div className="row-sub">{[scheduleText(x.schedule), x.lastSuccessAt ? t('backups.peer.last', { time: fmtRelative(x.lastSuccessAt) }) : t('backups.peer.never')].join(' · ')}</div>
              </div>
              <div className="row-side">
                <Button size="sm" icon={Save} disabled={Boolean(peer.job)} onClick={() => ask('backup', x.id)}>{t('common.backupNow')}</Button>
              </div>
            </div>
          ))}
        </div>
      ) : <div className="card-pad muted">{t('backups.peer.noSets')}</div>}
    </Card>
  );
}

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
      toast(errorText(e), e.code === 'CANCELLED' ? '' : 'error');
    } finally {
      setBusy(false);
    }
  };
  const [space, setSpace] = useState(null);
  useEffect(() => {
    if (!preview || !outDir) return;
    api.diskSpace(outDir, preview.estimate).then(setSpace).catch(() => setSpace(null));
  }, [preview, outDir]);
  const noSpace = Boolean(space && !space.enough);
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
      <Button variant="primary" icon={HardDrive} onClick={create} disabled={busy || !preview || noSpace} data-testid="full-create">{busy ? t('transfer.export.creating') : t('backups.full.create')}</Button>
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
            <dt>{t('transfer.export.saveTo')}</dt>
            <dd>
              <span className="row-flex" style={{ alignItems: 'flex-start' }}>
                <Path>{`${outDir}/${preview.fileName}`}</Path>
                <Button size="sm" onClick={chooseFolder}>{t('common.change')}</Button>
              </span>
            </dd>
            <dt>{t('backups.full.estimate')}</dt>
            <dd data-testid="full-estimate">{t('backups.full.about', { size: fmtBytes(preview.estimate) })}</dd>
            {space && space.free !== null ? (<><dt>{t('backups.full.free')}</dt><dd>{fmtBytes(space.free)}</dd></>) : null}
          </dl>
          {noSpace ? <Banner tone="error" icon={TriangleAlert}>{t('backups.full.noSpace', { need: fmtBytes(space.need), free: fmtBytes(space.free), reserve: fmtBytes(space.reserve) })}</Banner> : null}
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
    <Drawer title={b ? fmtDate(b.createdAt) : t('common.bundle')} sub={b ? `${(b.kind === 'before' && b.reason ? label('reason', b.reason) : null) || label('kind', b.kind) || t('common.bundle')} · ${b.device.name} (${b.device.platformName})` : null} onClose={onClose}>
      {err ? <Banner tone="error" icon={TriangleAlert}>{errorText(err)}</Banner> : !b ? <Loading /> : (
        <>
          <Banner tone="ok" icon={ShieldCheck}>{t(b.snapshot ? 'backups.verifiedSnapshot' : 'backups.verified', { count: b.stats.memoryFiles + b.stats.workspaceFiles + b.stats.claudeFiles })}</Banner>
          <dl className="kv">
            {b.snapshot ? (
              <><dt>{t('transfer.bundle.snapshot')}</dt><dd>{t('transfer.bundle.snapshotText', { id: b.snapshot.short })}</dd></>
            ) : (
              <><dt>{t('common.file')}</dt><dd><PathLink path={b.path} /></dd></>
            )}
            <dt>{t('common.createdBy')}</dt>
            <dd>{b.device.name} · {b.device.platformName}{b.isMine ? ` (${t('common.thisDevice')})` : ''}</dd>
            <dt>{t('backups.size')}</dt>
            <dd>{b.snapshot ? fmtBytes(b.size) : t('backups.compressed', { size: fmtBytes(b.size) })}</dd>
            <dt>{t('common.status')}</dt>
            <dd>{b.imported ? t('backups.state.imported') : b.isMine ? t('backups.state.mine') : t('backups.state.notImported')}</dd>
            {b.full ? (<><dt>{t('common.appData')}</dt><dd>{t('backups.full.drawer')}</dd></>) : null}
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
  const [status, setStatus] = useState(null);
  const [lib, setLib] = useState(null);
  const [old, setOld] = useState(null);
  const [tab, setTab] = useState('all');
  const [open, setOpen] = useState(null);
  const [trash, setTrash] = useState(null);
  const [modal, setModal] = useState(null);

  useEffect(() => {
    api.backupStatus().then(setStatus).catch((e) => toast(errorText(e), 'error'));
    api.library().then((l) => setLib(l.filter((b) => !b.old))).catch((e) => toast(errorText(e), 'error'));
    api.oldBackups().then(setOld).catch(() => {});
  }, [version, toast]);

  const list = useMemo(() => (lib ? lib.filter((b) => inTab(b, tab)) : []), [lib, tab]);
  if (!status || !lib) return <Loading />;
  const set = status.set;

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
  const job = async (method) => {
    try {
      const r = await api[method]();
      if (method === 'verifyBackups') toast(r.ok ? t('backups.verify.ok') : t('backups.verify.damaged'), r.ok ? '' : 'error');
      if (method === 'repairBackups') toast(r.ok ? t('backups.repair.ok') : t('backups.repair.left'), r.ok ? '' : 'error');
      refresh();
    } catch (e) {
      if (e.code !== 'CANCELLED') toast(errorText(e), 'error');
    }
  };

  return (
    <div className="page">
      <PageHead title={t('nav.backups')} sub={t('backups.sub')} onHelp={() => setModal('help')} helpLabel={t('backups.help.title')}>
        <Button icon={SlidersHorizontal} onClick={() => setModal('content')} data-testid="backup-content">{t('settings.backup.content')}</Button>
      </PageHead>

      {old && old.count ? (
        <Banner tone="info" icon={Info} action={<Button size="sm" icon={FolderOpen} onClick={() => openFolder(old.dir, toast)}>{t('common.openFolder')}</Button>}>
          {t('backups.old', { count: old.count, size: fmtBytes(old.bytes) })}
          <div><Path>{old.dir}</Path></div>
        </Banner>
      ) : null}

      <Card>
        <div className="card-head">
          <Lock size={16} />
          <div className="card-title">{t('backups.card.title')}</div>
          <div className="spacer" />
          {set ? <Badge>{t('backups.card.encrypted')}</Badge> : null}
        </div>
        {set ? (
          <>
            <div className="card-pad"><BackupSummary set={set} onPassword={() => setModal('password')} /></div>
            <div className="card-foot">
              <Button size="sm" icon={Clock} onClick={() => setModal('settings')} data-testid="backup-settings">{t('backups.settings.button')}</Button>
              <Button size="sm" icon={ShieldCheck} onClick={() => job('verifyBackups')} disabled={!set.targetPresent} data-testid="backup-verify">{t('backups.verify.button')}</Button>
              {set.status === 'damaged' ? <Button size="sm" variant="primary" icon={Wrench} onClick={() => job('repairBackups')} data-testid="backup-repair">{t('backups.repair.button')}</Button> : null}
            </div>
          </>
        ) : (
          <div className="card-pad">
            <Banner tone="warn" icon={ShieldAlert}>{t('backups.card.none')}</Banner>
            <div className="row-flex mt">
              <Button variant="primary" icon={ShieldCheck} onClick={() => setModal('setup')} data-testid="backups-setup">{t('backups.ask.setup')}</Button>
              <Button icon={Lock} onClick={() => setModal('open')} data-testid="backups-open">{t('backups.ask.open')}</Button>
            </div>
          </div>
        )}
      </Card>

      {set ? (
        <Card className="mt">
          <div className="card-head">
            <Archive size={16} />
            <div className="card-title">{t('backups.snapshots.title')}</div>
            <div className="spacer" />
            <Button size="sm" variant="ghost" icon={RefreshCw} onClick={refresh} title={t('backups.snapshots.reload')} />
          </div>
          <SnapshotList set={set} />
        </Card>
      ) : null}

      <div className="section-label" style={{ marginTop: 22 }}>{t('backups.files.title')}</div>
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
                      {b.error ? errorText(b.error) : `${contents(b.stats, b.chats)} · ${fmtBytes(b.size)} · ${fmtRelative(b.createdAt)}`}
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
          <Empty icon={Package} title={t('backups.files.empty')}>
            {tab === 'foreign' ? t('backups.emptyForeign') : t('backups.files.emptyHint')}
          </Empty>
        )}
      </Card>

      <PeerCard />

      {open ? <BundleDrawer path={open} onClose={() => setOpen(null)} /> : null}
      {modal === 'content' ? <BackupContent onClose={() => setModal(null)} /> : null}
      {modal === 'help' ? <BackupTypes onClose={() => setModal(null)} /> : null}
      {modal === 'setup' ? <SetupBackups onClose={() => setModal(null)} /> : null}
      {modal === 'open' ? <OpenBackups onClose={() => setModal(null)} /> : null}
      {modal === 'password' ? <PasswordModal onClose={() => setModal(null)} /> : null}
      {modal === 'settings' && set ? <BackupSettings set={set} onClose={() => setModal(null)} /> : null}
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
