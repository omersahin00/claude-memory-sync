import React, { useEffect, useState } from 'react';
import { FolderTree, FolderPlus, FileCode2, Wrench, Check, X as XIcon, GitBranch, TriangleAlert, Trash2, ShieldCheck } from 'lucide-react';
import { api, shell, errorText } from '../api.js';
import { useApp, Card, Badge, Button, PageHead, Path, PathLink, Loading, Empty, Modal, Banner, DiffView } from '../ui.jsx';
import { fmtRelative, WS_WARNING } from '../format.js';

const FILE_STATUS = { new: ['Hiç paketlenmedi', 'amber'], changed: ['Değişti', 'blue'], synced: ['Pakette var', 'green'] };

function FixModal({ root, file, onClose, onDone }) {
  const { toast } = useApp();
  const [preview, setPreview] = useState(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api.fixWorkspace({ root: root.key, rel: file.rel }).then(setPreview).catch((e) => setPreview({ error: errorText(e) }));
  }, [root.key, file.rel]);
  const apply = async () => {
    setBusy(true);
    try {
      await api.fixWorkspace({ root: root.key, rel: file.rel, apply: true });
      toast('Workspace dosyası düzeltildi. Önce yedek alındı; Geçmiş ekranından geri alınabilir.');
      onDone();
    } catch (e) {
      toast(errorText(e), 'error');
      setBusy(false);
    }
  };
  return (
    <Modal title={`Taşınabilir yap: ${file.rel}`} onClose={onClose} wide
      footer={<>
        <Button onClick={onClose}>Vazgeç</Button>
        <Button variant="primary" icon={Wrench} onClick={apply} disabled={busy || !preview || !preview.changes || !preview.changes.length}>Düzelt</Button>
      </>}>
      {!preview ? <Loading /> : preview.error ? <Banner tone="error" icon={TriangleAlert}>{preview.error}</Banner> : (
        <>
          <p style={{ marginTop: 0 }}>
            Klasör yolları workspace dosyasına göre göreli ve <span className="code">/</span> ile yazılır. Böylece aynı dosya Mac’te ve Windows’ta açılır.
            Yorumlar ve düzen korunur.
          </p>
          {preview.changes.length ? (
            <Card className="card-pad" style={{ marginBottom: 12 }}>
              {preview.changes.map((c, i) => (
                <div key={i} className="op">
                  <Path>{c.from}</Path>
                  <span className="muted">→</span>
                  <Path>{c.to}</Path>
                </div>
              ))}
            </Card>
          ) : <Banner tone="ok" icon={Check}>Değiştirilecek bir yol yok (başka sürücüdeki yollar göreli yapılamaz).</Banner>}
          <DiffView lines={preview.lines} minusLabel="Şimdiki hâli" plusLabel="Düzeltilmiş hâli" />
          <Banner tone="info" icon={ShieldCheck}>Yazmadan önce bu cihazın tam yedeği alınır.</Banner>
        </>
      )}
    </Modal>
  );
}

function WorkspaceFile({ root, f, onFix }) {
  const [s, tone] = FILE_STATUS[f.status];
  return (
    <div className="row" style={{ alignItems: 'flex-start' }}>
      <div className="row-icon violet" style={{ marginTop: 2 }}>
        <FileCode2 size={16} />
      </div>
      <div className="row-main">
        <div className="row-flex">
          <span className="row-title">{f.rel}</span>
          <Badge tone={tone}>{s}</Badge>
          {f.parseError ? <Badge tone="red">Okunamadı</Badge> : null}
        </div>
        <div className="row-sub">{f.folders.length} klasör · {f.settings ? `${f.settings} ayar · ` : ''}{fmtRelative(f.mtime)} değişti</div>
        {f.parseError ? <div className="small" style={{ color: 'var(--red)', marginTop: 4 }}>JSON okunamadı: {f.parseError}</div> : null}
        <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 5 }}>
          {f.folders.map((fo, i) => (
            <div key={i} className="row-flex small" style={{ alignItems: 'flex-start' }}>
              {fo.kind === 'uri' ? <span className="dot-i gray" style={{ marginTop: 5 }} /> : fo.exists ? <Check size={14} style={{ color: 'var(--green)', flex: 'none', marginTop: 1 }} /> : <XIcon size={14} style={{ color: 'var(--red)', flex: 'none', marginTop: 1 }} />}
              <div style={{ minWidth: 0 }}>
                <Path>{fo.path}</Path>
                {fo.name ? <span className="muted"> ({fo.name})</span> : null}
                {fo.isGit ? <GitBranch size={12} style={{ marginLeft: 6, color: 'var(--text-3)' }} /> : null}
                {fo.warnings.length ? (
                  <div style={{ color: 'var(--amber)' }}>{fo.warnings.map((w) => WS_WARNING[w] || w).join(' · ')}</div>
                ) : null}
              </div>
            </div>
          ))}
        </div>
      </div>
      <div className="row-side">
        {f.fixable ? <Button size="sm" icon={Wrench} onClick={() => onFix(root, f)}>Taşınabilir yap</Button> : null}
        <Button size="sm" variant="ghost" className="icon" title="Klasörde göster" onClick={() => shell.reveal(f.path)}>
          <FolderTree size={14} />
        </Button>
      </div>
    </div>
  );
}

export default function Workspaces() {
  const { version, refresh, toast } = useApp();
  const [roots, setRoots] = useState(null);
  const [settings, setSettings] = useState(null);
  const [fix, setFix] = useState(null);

  useEffect(() => {
    api.workspaces().then(setRoots).catch((e) => toast(errorText(e), 'error'));
    api.settings().then(setSettings);
  }, [version, toast]);

  if (!roots || !settings) return <Loading />;

  const saveRoots = async (list) => {
    try {
      await api.updateSettings({ workspaceRoots: list });
      refresh();
    } catch (e) {
      toast(errorText(e), 'error');
    }
  };
  const addRoot = async () => {
    const p = await shell.chooseFolder({ title: 'Workspace dosyalarının arandığı klasör' });
    if (p) saveRoots([...settings.workspaceRoots, p]);
  };
  const removeRoot = (abs) => saveRoots(settings.workspaceRoots.filter((x) => x !== abs));

  return (
    <div className="page">
      <PageHead title="Workspace’ler" sub="VS Code .code-workspace dosyaları. Seçtiğin klasörlerde en fazla 3 seviye derinliğe bakılır; git repolarının içi ve node_modules taranmaz.">
        <Button icon={FolderPlus} onClick={addRoot}>Klasör ekle</Button>
      </PageHead>

      {!roots.length ? (
        <Card>
          <Empty icon={FolderTree} title="Tarama klasörü yok">
            Repolarının durduğu klasörü (örneğin Documents/GitHub) ekle; içindeki workspace dosyaları yedeklere ve paketlere girsin.
            <div className="mt"><Button variant="primary" icon={FolderPlus} onClick={addRoot}>Klasör ekle</Button></div>
          </Empty>
        </Card>
      ) : (
        <div className="stack">
          {roots.map((r, i) => (
            <Card key={r.path}>
              <div className="card-head">
                <FolderTree size={16} />
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div className="card-title row-flex">
                    {r.name}
                    {i === 0 ? <Badge tone="accent">Ana klasör</Badge> : null}
                    {!r.exists ? <Badge tone="red">Bulunamadı</Badge> : null}
                  </div>
                  <PathLink path={r.path} />
                </div>
                <span className="muted small">{r.files.length} dosya</span>
                <Button size="sm" variant="ghost" icon={Trash2} onClick={() => removeRoot(r.path)}>Listeden çıkar</Button>
              </div>
              {r.files.length ? (
                <div className="rows">
                  {r.files.map((f) => <WorkspaceFile key={f.rel} root={r} f={f} onFix={(root, file) => setFix({ root, file })} />)}
                </div>
              ) : (
                <div className="card-pad muted">Bu klasörde .code-workspace dosyası yok.</div>
              )}
            </Card>
          ))}
          <div className="muted small">
            Listeden çıkarmak dosyaları silmez; yalnızca o klasör artık taranmaz. Başka cihazdan gelen workspace dosyaları, o cihazdaki klasörün buradaki karşılığına yazılır.
          </div>
        </div>
      )}

      {fix ? <FixModal root={fix.root} file={fix.file} onClose={() => setFix(null)} onDone={() => { setFix(null); refresh(); }} /> : null}
    </div>
  );
}
