import React, { useEffect, useMemo, useState } from 'react';
import { Archive, CalendarClock, ShieldCheck, Hand, Package, Inbox, FolderOpen, Trash2, Eye, Download, RotateCcw, TriangleAlert, Save, Brain, FolderTree, Settings2, FileText } from 'lucide-react';
import { api, shell, errorText } from '../api.js';
import { useApp, Card, Badge, Button, PageHead, Path, PathLink, Loading, Empty, Drawer, Banner, Modal } from '../ui.jsx';
import { fmtDate, fmtRelative, fmtBytes, KIND_LABEL, KIND_TONE, TYPE_LABEL } from '../format.js';

const KIND_ICON = { daily: CalendarClock, before: ShieldCheck, manual: Hand, export: Package };
const TYPE_ICON = { project: Brain, workspaceRoot: FolderTree, claude: Settings2 };
const TABS = [
  ['all', 'Tümü'],
  ['daily', 'Günlük'],
  ['before', 'İşlem öncesi'],
  ['manual', 'Elle'],
  ['export', 'Paketler'],
  ['foreign', 'Diğer cihazlardan'],
];

export const contents = (s) => (s ? [`${s.projects} proje`, `${s.memoryFiles} hafıza dosyası`, s.workspaceFiles ? `${s.workspaceFiles} workspace` : null, s.claudeFiles ? `${s.claudeFiles} Claude ayarı` : null].filter(Boolean).join(' · ') : '');

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
    <Drawer title={b ? fmtDate(b.createdAt) : 'Paket'} sub={b ? `${KIND_LABEL[b.kind] || 'Paket'} · ${b.device.name} (${b.device.platformName})` : null} onClose={onClose}>
      {err ? <Banner tone="error" icon={TriangleAlert}>{errorText(err)}</Banner> : !b ? <Loading /> : (
        <>
          <Banner tone="ok" icon={ShieldCheck}>Paket açıldı; içindeki {b.stats.memoryFiles + b.stats.workspaceFiles + b.stats.claudeFiles} dosyanın hepsi doğrulandı.</Banner>
          <dl className="kv">
            <dt>Dosya</dt>
            <dd><PathLink path={b.path} /></dd>
            <dt>Oluşturan cihaz</dt>
            <dd>{b.device.name} · {b.device.platformName}{b.isMine ? ' (bu cihaz)' : ''}</dd>
            <dt>Boyut</dt>
            <dd>{fmtBytes(b.size)} (sıkıştırılmış)</dd>
            <dt>Durum</dt>
            <dd>{b.imported ? 'Bu cihaza aktarıldı' : b.isMine ? 'Bu cihazda oluşturuldu' : 'Henüz aktarılmadı'}</dd>
          </dl>
          {b.locations.map((loc) => {
            const Icon = TYPE_ICON[loc.type] || Archive;
            const files = b.files.filter((f) => f.location === loc.id);
            return (
              <div key={loc.id}>
                <div className="section-label row-flex" style={{ textTransform: 'none', letterSpacing: 0, fontSize: 13, color: 'var(--text)' }}>
                  <Icon size={15} /> {loc.name || loc.key}
                  <Badge>{TYPE_LABEL[loc.type]}</Badge>
                  <span className="muted small" style={{ fontWeight: 400 }}>{files.length} dosya</span>
                </div>
                {loc.path ? <div className="small muted" style={{ marginTop: -4, marginBottom: 6 }}>Kaynak: <Path>{loc.path}</Path></div> : null}
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
          {file.error ? <Banner tone="error">{file.error}</Banner> : file.binary ? <div className="muted">İkili dosya.</div> : <pre className="preview">{file.text}</pre>}
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
      toast(`Yedek alındı ve doğrulandı: ${r.stats.memoryFiles} hafıza dosyası`);
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
      toast('Dosya çöp kutusuna taşındı.');
      setTrash(null);
      refresh();
    } catch (e) {
      toast(errorText(e), 'error');
    }
  };

  return (
    <div className="page">
      <PageHead title="Yedekler" sub="Bu cihazın yedekleri ve bulunan paketler. Yedek klasörü, Masaüstü, İndirilenler ve Ayarlar’da eklediğin klasörler kendiliğinden taranır.">
        <Button icon={FolderOpen} onClick={() => dir && shell.openPath(dir)}>Yedek klasörünü aç</Button>
        <Button variant="primary" icon={Save} onClick={backupNow} disabled={busy}>{busy ? 'Yedek alınıyor…' : 'Şimdi yedek al'}</Button>
      </PageHead>

      <div className="tabs">
        {TABS.map(([id, label]) => {
          const n = id === 'all' ? lib.length : id === 'foreign' ? lib.filter((b) => !b.isMine).length : lib.filter((b) => b.isMine && b.kind === id).length;
          return (
            <button key={id} type="button" className={`tab ${tab === id ? 'on' : ''}`} onClick={() => setTab(id)}>
              {label} <span className="muted small">{n}</span>
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
                      {b.error ? <Badge tone="red">Okunamadı</Badge> : (
                        <>
                          <Badge tone={b.isMine ? KIND_TONE[b.kind] : 'amber'}>{b.isMine ? KIND_LABEL[b.kind] : `${b.device.name} · ${b.device.platformName}`}</Badge>
                          {b.imported ? <Badge tone="green">Aktarıldı</Badge> : null}
                          {b.version === 1 ? <Badge>Eski sürüm</Badge> : null}
                        </>
                      )}
                    </div>
                    <div className="row-sub">
                      {b.error ? b.error.message : `${contents(b.stats)} · ${fmtBytes(b.size)} · ${fmtRelative(b.createdAt)}`}
                    </div>
                    <div className="row-sub"><Path>{b.path}</Path></div>
                  </div>
                  <div className="row-side">
                    {!b.error ? <Button size="sm" icon={Eye} onClick={() => setOpen(b.path)}>İçerik</Button> : null}
                    {!b.error && !b.isMine ? <Button size="sm" variant="primary" icon={Download} onClick={() => go('transfer', { bundle: b.path, mode: 'sync' })}>Aktar</Button> : null}
                    {!b.error && b.isMine ? <Button size="sm" icon={RotateCcw} onClick={() => go('transfer', { bundle: b.path, mode: 'restore' })}>Bu yedeğe dön</Button> : null}
                    <Button size="sm" variant="ghost" className="icon" title="Klasörde göster" onClick={() => shell.reveal(b.path)}><FolderOpen size={14} /></Button>
                    <Button size="sm" variant="ghost" className="icon" title="Çöp kutusuna taşı" onClick={() => setTrash(b)}><Trash2 size={14} /></Button>
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <Empty icon={Archive} title="Bu grupta dosya yok">
            {tab === 'foreign' ? 'Başka cihazdan getirdiğin .memsync dosyasını Masaüstüne ya da İndirilenler’e koyman yeterli.' : 'Yedekler alındıkça burada listelenir.'}
          </Empty>
        )}
      </Card>

      {open ? <BundleDrawer path={open} onClose={() => setOpen(null)} /> : null}
      {trash ? (
        <Modal title="Çöp kutusuna taşınsın mı?" onClose={() => setTrash(null)}
          footer={<><Button onClick={() => setTrash(null)}>Vazgeç</Button><Button variant="primary" icon={Trash2} onClick={doTrash}>Çöp kutusuna taşı</Button></>}>
          <p style={{ marginTop: 0 }}>{trash.createdAt ? fmtDate(trash.createdAt) : trash.name} tarihli dosya çöp kutusuna taşınacak. Çöp kutusundan geri alınabilir.</p>
          <Path>{trash.path}</Path>
        </Modal>
      ) : null}
    </div>
  );
}
