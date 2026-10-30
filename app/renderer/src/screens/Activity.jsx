import React, { useEffect, useState } from 'react';
import { History, CalendarClock, ShieldCheck, Hand, Package, Download, RotateCcw, Undo2, Wrench, ArrowUpCircle, TriangleAlert, Eye } from 'lucide-react';
import { api, errorText } from '../api.js';
import { useApp, Card, Badge, Button, PageHead, Path, PathLink, Loading, Empty, Drawer, Banner, Modal } from '../ui.jsx';
import { fmtDate, fmtRelative, fmtBytes, KIND_LABEL, ACTIVITY, RESTORE_GROUPS } from '../format.js';

const ICON = { sync: Download, restore: RotateCcw, undo: Undo2, export: Package, 'workspace-fix': Wrench, migrate: ArrowUpCircle };
const BACKUP_ICON = { daily: CalendarClock, manual: Hand, before: ShieldCheck };

function title(e) {
  if (e.type === 'backup') return KIND_LABEL[e.kind] || ACTIVITY.backup;
  return ACTIVITY[e.type] || e.type;
}

function summary(e) {
  if (!e.ok) return e.error || 'Başarısız';
  const s = e.stats;
  switch (e.type) {
    case 'backup':
    case 'export':
      return s ? `${s.projects} proje, ${s.memoryFiles} hafıza, ${s.workspaceFiles} workspace dosyası · ${fmtBytes(e.size)}` : '';
    case 'sync':
    case 'restore':
    case 'undo': {
      const from = e.bundle && !e.undoOf ? `${e.bundle.device} · ` : '';
      if (!e.writes && !e.deletes) return `${from}değişiklik yoktu`;
      return `${from}${e.writes} dosya yazıldı, ${e.deletes} silindi${e.copies ? `, ${e.copies} kopya` : ''}`;
    }
    case 'workspace-fix':
      return `${(e.changes || []).length} yol göreli yapıldı`;
    case 'migrate':
      return '1.x ayarları ve geçmişi yeni sürüme taşındı';
    default:
      return '';
  }
}

export function ActivityRow({ e, compact, onUndo, onOpen }) {
  const Icon = e.type === 'backup' ? BACKUP_ICON[e.kind] || ShieldCheck : ICON[e.type] || History;
  return (
    <div className="row">
      <div className={`row-icon ${!e.ok ? 'red' : e.type === 'sync' || e.type === 'restore' ? 'accent' : e.type === 'undo' ? 'amber' : ''}`}>
        <Icon size={16} />
      </div>
      <div className="row-main">
        <div className="row-flex">
          <span className="row-title">{title(e)}</span>
          {!e.ok ? <Badge tone="red">Başarısız</Badge> : null}
          {e.undone ? <Badge tone="amber">Geri alındı</Badge> : null}
        </div>
        <div className="row-sub">{summary(e)}</div>
      </div>
      <div className="row-side">
        <span className="muted small" title={fmtDate(e.at)}>{fmtRelative(e.at)}</span>
        {!compact && e.undoable && onUndo ? <Button size="sm" icon={Undo2} onClick={() => onUndo(e)}>Geri al</Button> : null}
        {!compact && onOpen ? <Button size="sm" variant="ghost" icon={Eye} onClick={() => onOpen(e)}>Ayrıntı</Button> : null}
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
      toast(r.nothing ? 'Geri alınacak bir değişiklik kalmamıştı.' : `Geri alındı: ${r.writes} dosya yazıldı, ${r.deletes} silindi.`);
      onDone(r);
    } catch (e) {
      setErr(e);
      setBusy(false);
    }
  };
  return (
    <Modal title="İşlemi geri al" onClose={onClose}
      footer={<><Button onClick={onClose}>Vazgeç</Button><Button variant="primary" icon={Undo2} onClick={run} disabled={!plan || busy} data-testid="undo-apply">{busy ? 'Geri alınıyor…' : 'Yedek al ve geri al'}</Button></>}>
      {err ? <Banner tone="error" icon={TriangleAlert}>{errorText(err)}</Banner> : null}
      {!plan && !err ? <Loading /> : null}
      {plan ? (
        <>
          <p style={{ marginTop: 0 }}>
            Bu işlemin değiştirdiği dosyalar, işlemden hemen önce alınan yedekteki hâline döner. Başka dosyalara dokunulmaz. Önce yine bu cihazın tam yedeği alınır.
          </p>
          {items.length ? (
            <Card>
              <div className="rows">
                {items.map((it) => (
                  <div key={it.key} className="row" style={{ padding: '7px 14px' }}>
                    <Badge tone={RESTORE_GROUPS[it.group] ? RESTORE_GROUPS[it.group].tone : ''}>{RESTORE_GROUPS[it.group] ? RESTORE_GROUPS[it.group].label : it.group}</Badge>
                    <div className="row-main"><div className="row-title" style={{ fontWeight: 520 }}><span className="muted">{it.scopeLabel} / </span>{it.rel}</div></div>
                  </div>
                ))}
              </div>
            </Card>
          ) : <Banner tone="ok">Bu dosyalar zaten işlem öncesindeki hâlinde.</Banner>}
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
    <Drawer title={e ? title(e) : 'Ayrıntı'} sub={e ? fmtDate(e.at) : null} onClose={onClose}>
      {!e ? <Loading /> : (
        <>
          {!e.ok ? <Banner tone="error" icon={TriangleAlert}>{e.error}{e.rolledBack ? ' Yapılanlar geri alındı.' : ''}</Banner> : null}
          <dl className="kv">
            {e.bundle ? (<><dt>Paket</dt><dd>{e.bundle.device} · {fmtDate(e.bundle.createdAt)}<div><Path>{e.bundle.path}</Path></div></dd></>) : null}
            {e.path ? (<><dt>Dosya</dt><dd><PathLink path={e.path} /></dd></>) : null}
            {e.backupPath ? (<><dt>İşlem öncesi yedek</dt><dd><PathLink path={e.backupPath} /></dd></>) : null}
            {e.stats ? (<><dt>İçerik</dt><dd>{e.stats.projects} proje, {e.stats.memoryFiles} hafıza, {e.stats.workspaceFiles} workspace, {e.stats.claudeFiles} Claude dosyası</dd></>) : null}
          </dl>
          {e.scopes && e.scopes.length ? (
            <>
              <div className="section-label">Yazılan yerler</div>
              {e.scopes.map((s, i) => (
                <div key={i} style={{ marginBottom: 8 }}>
                  <div className="strong">{s.label} <span className="muted small" style={{ fontWeight: 400 }}>{s.writes} yazıldı, {s.deletes} silindi</span></div>
                  <Path>{s.root}</Path>
                </div>
              ))}
            </>
          ) : null}
          {e.touched && e.touched.length ? (
            <>
              <div className="section-label">Değişen dosyalar ({e.touched.length})</div>
              <Card>
                <div className="rows">
                  {e.touched.map((t, i) => (
                    <div key={i} className="row" style={{ padding: '6px 14px' }}>
                      <Badge tone={t.type === 'write' ? 'green' : 'red'}>{t.type === 'write' ? 'yazıldı' : 'silindi'}</Badge>
                      <div className="row-main"><Path>{t.path}</Path></div>
                    </div>
                  ))}
                </div>
              </Card>
            </>
          ) : null}
          {e.changes && e.changes.length ? (
            <>
              <div className="section-label">Değişen yollar</div>
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
      <PageHead title="Geçmiş" sub="Bu cihazda yapılan yedekleme, paketleme ve aktarımlar. Bir aktarımı geri almak yalnızca onun değiştirdiği dosyaları işlem öncesi yedekteki hâline döndürür." />
      <Card>
        {list.length ? (
          <div className="rows">
            {list.map((e) => <ActivityRow key={e.id} e={e} onUndo={(x) => setUndo(x.id)} onOpen={(x) => setOpen(x.id)} />)}
          </div>
        ) : <Empty icon={History} title="Henüz bir işlem yok" />}
      </Card>
      {undo ? <UndoModal activityId={undo} onClose={() => setUndo(null)} onDone={() => { setUndo(null); refresh(); }} /> : null}
      {open ? <DetailDrawer id={open} onClose={() => setOpen(null)} /> : null}
    </div>
  );
}
