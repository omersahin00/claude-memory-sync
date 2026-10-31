import React, { useEffect, useState } from 'react';
import { History, CalendarClock, ShieldCheck, Hand, Package, Download, RotateCcw, Undo2, Wrench, ArrowUpCircle, TriangleAlert, Eye, HardDrive, HardDriveDownload } from 'lucide-react';
import { api, errorText } from '../api.js';
import { useApp, Card, Badge, Button, PageHead, Path, PathLink, Loading, Empty, Drawer, Banner, Modal } from '../ui.jsx';
import { fmtDate, fmtRelative, fmtBytes, count, label, groupMeta } from '../format.js';
import { t } from '../i18n.js';

const ICON = { sync: Download, restore: RotateCcw, undo: Undo2, export: Package, 'workspace-fix': Wrench, migrate: ArrowUpCircle, 'full-backup': HardDrive, 'full-restore': HardDriveDownload };
const BACKUP_ICON = { daily: CalendarClock, manual: Hand, before: ShieldCheck };

function title(e) {
  if (e.type === 'backup') return label('kind', e.kind) || label('activityType', 'backup');
  return label('activityType', e.type) || e.type;
}

const changes = (writes, deletes, copies) => [count('written', writes), count('deleted', deletes), copies ? count('copies', copies) : null].filter(Boolean).join(', ');

function summary(e) {
  if (!e.ok) return e.error || t('common.failed');
  const s = e.stats;
  switch (e.type) {
    case 'backup':
    case 'export':
      if (e.unchanged) return t('history.unchanged');
      return s ? `${count('projects', s.projects)}, ${count('memoryFiles', s.memoryFiles)}, ${count('workspaceFiles', s.workspaceFiles)} · ${fmtBytes(e.size)}` : '';
    case 'sync':
    case 'restore':
    case 'undo': {
      const from = e.bundle && !e.undoOf ? `${e.bundle.device} · ` : '';
      if (!e.writes && !e.deletes) return `${from}${t('history.noChanges')}`;
      return `${from}${changes(e.writes, e.deletes, e.copies)}`;
    }
    case 'full-backup':
      return s ? `${count('projects', s.projects)}, ${count('memoryFiles', s.memoryFiles)}, ${t('history.backupsIncluded', { count: e.backups || 0 })} · ${fmtBytes(e.size)}` : '';
    case 'full-restore':
      return `${e.bundle ? `${e.bundle.device} · ` : ''}${count('written', e.writes || 0)}, ${t('history.backupsIncluded', { count: e.backups || 0 })}`;
    case 'workspace-fix':
      return t('history.pathsFixed', { count: (e.changes || []).length });
    case 'migrate':
      return t('history.migrated');
    default:
      return '';
  }
}

export function ActivityRow({ e, compact, onUndo, onOpen }) {
  const Icon = e.type === 'backup' ? BACKUP_ICON[e.kind] || ShieldCheck : ICON[e.type] || History;
  return (
    <div className="row">
      <div className={`row-icon ${!e.ok ? 'red' : e.type === 'sync' || e.type === 'restore' || e.type === 'full-restore' ? 'accent' : e.type === 'undo' ? 'amber' : ''}`}>
        <Icon size={16} />
      </div>
      <div className="row-main">
        <div className="row-flex">
          <span className="row-title">{title(e)}</span>
          {!e.ok ? <Badge tone="red">{t('common.failed')}</Badge> : null}
          {e.undone ? <Badge tone="amber">{t('history.undone')}</Badge> : null}
        </div>
        <div className="row-sub">{summary(e)}</div>
      </div>
      <div className="row-side">
        <span className="muted small" title={fmtDate(e.at)}>{fmtRelative(e.at)}</span>
        {!compact && e.undoable && onUndo ? <Button size="sm" icon={Undo2} onClick={() => onUndo(e)}>{t('common.undo')}</Button> : null}
        {!compact && onOpen ? <Button size="sm" variant="ghost" icon={Eye} onClick={() => onOpen(e)}>{t('history.details')}</Button> : null}
      </div>
    </div>
  );
}

// Shows what undoing an operation will put back, then does it (with a backup first, as always).
export function UndoModal({ activityId, onClose, onDone }) {
  const { toast } = useApp();
  const [plan, setPlan] = useState(null);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api.prepareUndo(activityId).then(setPlan).catch(setErr);
  }, [activityId]);
  const items = plan ? plan.items.filter((i) => i.group !== 'same') : [];
  const run = async () => {
    setBusy(true);
    try {
      const r = await api.apply(plan.id, {});
      toast(r.nothing ? t('history.undo.nothing') : t('history.undo.done', { changes: changes(r.writes, r.deletes) }));
      onDone(r);
    } catch (e) {
      setErr(e);
      setBusy(false);
    }
  };
  return (
    <Modal title={t('history.undo.title')} onClose={onClose}
      footer={<><Button onClick={onClose}>{t('common.cancel')}</Button><Button variant="primary" icon={Undo2} onClick={run} disabled={!plan || busy} data-testid="undo-apply">{busy ? t('history.undo.busy') : t('history.undo.apply')}</Button></>}>
      {err ? <Banner tone="error" icon={TriangleAlert}>{errorText(err)}</Banner> : null}
      {!plan && !err ? <Loading /> : null}
      {plan ? (
        <>
          <p style={{ marginTop: 0 }}>{t('history.undo.intro')}</p>
          {items.length ? (
            <Card>
              <div className="rows">
                {items.map((it) => {
                  const g = groupMeta('restore', it.group);
                  return (
                    <div key={it.key} className="row" style={{ padding: '7px 14px' }}>
                      <Badge tone={g ? g.tone : ''}>{g ? g.label : it.group}</Badge>
                      <div className="row-main"><div className="row-title" style={{ fontWeight: 520 }}><span className="muted">{it.scopeLabel} / </span>{it.rel}</div></div>
                    </div>
                  );
                })}
              </div>
            </Card>
          ) : <Banner tone="ok">{t('history.undo.already')}</Banner>}
        </>
      ) : null}
    </Modal>
  );
}

function DetailDrawer({ id, onClose }) {
  const [e, setE] = useState(null);
  useEffect(() => {
    api.activityDetail(id).then(setE);
  }, [id]);
  return (
    <Drawer title={e ? title(e) : t('history.details')} sub={e ? fmtDate(e.at) : null} onClose={onClose}>
      {!e ? <Loading /> : (
        <>
          {!e.ok ? <Banner tone="error" icon={TriangleAlert}>{e.error}{e.rolledBack ? ` ${t('history.detail.rolledBack')}` : ''}</Banner> : null}
          <dl className="kv">
            {e.bundle ? (<><dt>{t('common.bundle')}</dt><dd>{e.bundle.device} · {fmtDate(e.bundle.createdAt)}<div><Path>{e.bundle.path}</Path></div></dd></>) : null}
            {e.path ? (<><dt>{t('common.file')}</dt><dd><PathLink path={e.path} /></dd></>) : null}
            {e.backupPath ? (<><dt>{label('kind', 'before')}</dt><dd><PathLink path={e.backupPath} /></dd></>) : null}
            {e.stats ? (<><dt>{t('common.contents')}</dt><dd>{[count('projects', e.stats.projects), count('memoryFiles', e.stats.memoryFiles), count('workspaceFiles', e.stats.workspaceFiles), count('claudeFiles', e.stats.claudeFiles)].join(', ')}</dd></>) : null}
          </dl>
          {e.scopes && e.scopes.length ? (
            <>
              <div className="section-label">{t('history.detail.scopes')}</div>
              {e.scopes.map((s, i) => (
                <div key={i} style={{ marginBottom: 8 }}>
                  <div className="strong">{s.label} <span className="muted small" style={{ fontWeight: 400 }}>{changes(s.writes, s.deletes)}</span></div>
                  <Path>{s.root}</Path>
                </div>
              ))}
            </>
          ) : null}
          {e.touched && e.touched.length ? (
            <>
              <div className="section-label">{t('history.detail.files', { count: e.touched.length })}</div>
              <Card>
                <div className="rows">
                  {e.touched.map((x, i) => (
                    <div key={i} className="row" style={{ padding: '6px 14px' }}>
                      <Badge tone={x.type === 'write' ? 'green' : 'red'}>{x.type === 'write' ? t('history.detail.write') : t('history.detail.delete')}</Badge>
                      <div className="row-main"><Path>{x.path}</Path></div>
                    </div>
                  ))}
                </div>
              </Card>
            </>
          ) : null}
          {e.changes && e.changes.length ? (
            <>
              <div className="section-label">{t('history.detail.paths')}</div>
              {e.changes.map((c, i) => <div key={i} className="op"><Path>{c.from}</Path> → <Path>{c.to}</Path></div>)}
            </>
          ) : null}
        </>
      )}
    </Drawer>
  );
}

export default function Activity() {
  const { version, refresh, toast } = useApp();
  const [list, setList] = useState(null);
  const [undo, setUndo] = useState(null);
  const [open, setOpen] = useState(null);
  useEffect(() => {
    api.activity(200).then(setList).catch((e) => toast(errorText(e), 'error'));
  }, [version, toast]);
  if (!list) return <Loading />;
  return (
    <div className="page">
      <PageHead title={t('nav.activity')} sub={t('history.sub')} />
      <Card>
        {list.length ? (
          <div className="rows">
            {list.map((e) => <ActivityRow key={e.id} e={e} onUndo={(x) => setUndo(x.id)} onOpen={(x) => setOpen(x.id)} />)}
          </div>
        ) : <Empty icon={History} title={t('history.empty')} />}
      </Card>
      {undo ? <UndoModal activityId={undo} onClose={() => setUndo(null)} onDone={() => { setUndo(null); refresh(); }} /> : null}
      {open ? <DetailDrawer id={open} onClose={() => setOpen(null)} /> : null}
    </div>
  );
}
