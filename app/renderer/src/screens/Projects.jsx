import React, { useEffect, useMemo, useState } from 'react';
import { Brain, Search, GitBranch, FileText, FolderOpen, Sparkles } from 'lucide-react';
import { api, shell, errorText } from '../api.js';
import { useApp, Card, Badge, Toggle, PageHead, Path, PathLink, Loading, Empty, Drawer, Banner, Button } from '../ui.jsx';
import { fmtRelative, fmtBytes, fmtDate, tildify } from '../format.js';

const FILE_STATUS = { new: ['Hiç paketlenmedi', 'amber'], changed: ['Değişti', 'blue'], synced: ['Pakette var', 'green'] };

function statusBadge(p) {
  const n = p.status.new + p.status.changed;
  if (!n) return <Badge tone="green">Güncel</Badge>;
  return <Badge tone="amber" title="Son paketten beri eklenen ya da değişen dosyalar">{n} değişiklik</Badge>;
}

function ProjectRow({ p, onOpen, onToggle }) {
  return (
    <div className="row clickable" onClick={onOpen}>
      <div className="row-icon accent">
        <Brain size={16} />
      </div>
      <div className="row-main">
        <div className="row-title">
          {p.name}
          {p.gitRemote ? <GitBranch size={12} style={{ marginLeft: 6, color: 'var(--text-3)' }} /> : null}
        </div>
        <div className="row-sub" title={p.cwd || p.dir}>{p.cwd ? tildify(p.cwd) : 'Proje klasörü bulunamadı'}</div>
      </div>
      <div className="col-n">{p.fileCount} dosya</div>
      <div className="col-m muted small">{p.lastModified ? fmtRelative(p.lastModified) : '-'}</div>
      <div className="col-m">{statusBadge(p)}</div>
      <div className="row-side" onClick={(e) => e.stopPropagation()} title="Başka cihaza giden pakete dahil">
        <Toggle on={p.included} onChange={(v) => onToggle(p, v)} label={`${p.name} pakete dahil`} />
      </div>
    </div>
  );
}

function ProjectDrawer({ p, onClose }) {
  const [files, setFiles] = useState(null);
  const [sel, setSel] = useState(null);
  const [preview, setPreview] = useState(null);
  useEffect(() => {
    api.projectFiles(p.id).then((f) => {
      setFiles(f);
      if (f.length) setSel(f[0].rel);
    });
  }, [p.id]);
  useEffect(() => {
    if (!sel) return;
    setPreview(null);
    api.readFile({ scope: 'memory', project: p.id, rel: sel }).then(setPreview).catch((e) => setPreview({ error: errorText(e) }));
  }, [p.id, sel]);

  return (
    <Drawer title={p.name} sub={p.isScratch ? 'Claude uygulamasının geçici oturumu' : 'Claude Code proje hafızası'} onClose={onClose}
      actions={<Button size="sm" icon={FolderOpen} onClick={() => shell.openPath(p.memoryDir)}>Hafıza klasörünü aç</Button>}>
      <div className="section-label">Nereden</div>
      <dl className="kv">
        <dt>Proje klasörü</dt>
        <dd>{p.cwd ? <PathLink path={p.cwd} /> : <span className="muted">Bulunamadı</span>}{p.cwd && !p.exists ? <Badge tone="red">Bu cihazda yok</Badge> : null}</dd>
        <dt>Hafıza klasörü</dt>
        <dd><PathLink path={p.memoryDir} /></dd>
        <dt>Git deposu</dt>
        <dd>{p.gitRemote ? <Path>{p.gitRemote}</Path> : <span className="muted">Yok</span>}</dd>
        <dt>Paketteki adı</dt>
        <dd><span className="code">{p.key}</span></dd>
        <dt>Son paketten beri</dt>
        <dd>{p.status.new} yeni · {p.status.changed} değişmiş · {p.status.synced} pakette</dd>
      </dl>

      <div className="section-label">Dosyalar ({p.fileCount})</div>
      {!files ? <Loading /> : (
        <Card>
          <div className="rows">
            {files.map((f) => (
              <div key={f.rel} className="row clickable" style={{ padding: '8px 14px', background: sel === f.rel ? 'var(--accent-soft)' : undefined }} onClick={() => setSel(f.rel)}>
                <FileText size={15} style={{ color: 'var(--text-3)', flex: 'none' }} />
                <div className="row-main">
                  <div className="row-title" style={{ fontWeight: f.rel === 'MEMORY.md' ? 650 : 520 }}>{f.rel}</div>
                </div>
                <span className="muted small">{fmtBytes(f.size)}</span>
                <Badge tone={FILE_STATUS[f.status][1]}>{FILE_STATUS[f.status][0]}</Badge>
              </div>
            ))}
          </div>
        </Card>
      )}

      {sel ? (
        <>
          <div className="section-label row-flex">
            {sel}
            {preview && preview.path ? <span className="muted" style={{ textTransform: 'none', letterSpacing: 0, fontWeight: 400 }}>· {fmtDate(files && (files.find((f) => f.rel === sel) || {}).mtime)}</span> : null}
          </div>
          {!preview ? <Loading /> : preview.error ? <Banner tone="error">{preview.error}</Banner> : preview.binary ? (
            <div className="muted">İkili dosya, önizleme yok.</div>
          ) : (
            <pre className="preview">{preview.text}{preview.truncated ? '\n…' : ''}</pre>
          )}
        </>
      ) : null}
    </Drawer>
  );
}

export default function Projects() {
  const { version, refresh, toast } = useApp();
  const [data, setData] = useState(null);
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(null);

  useEffect(() => {
    api.projects().then(setData).catch((e) => toast(errorText(e), 'error'));
  }, [version, toast]);

  const filtered = useMemo(() => {
    if (!data) return [];
    const s = q.trim().toLocaleLowerCase('tr');
    return data.projects.filter((p) => !s || `${p.name} ${p.cwd || ''}`.toLocaleLowerCase('tr').includes(s));
  }, [data, q]);

  if (!data) return <Loading />;

  const toggle = async (p, on) => {
    try {
      await api.setProjectIncluded(p.key, on);
      refresh();
    } catch (e) {
      toast(errorText(e), 'error');
    }
  };
  const normal = filtered.filter((p) => !p.isScratch);
  const scratch = filtered.filter((p) => p.isScratch);
  const head = (
    <div className="table-head">
      <div style={{ width: 30 }} />
      <div style={{ flex: 1 }}>Proje</div>
      <div className="col-n">Dosya</div>
      <div className="col-m">Son değişiklik</div>
      <div className="col-m">Durum</div>
      <div style={{ width: 44 }} title="Başka cihaza giden pakete dahil">Pakette</div>
    </div>
  );

  return (
    <div className="page">
      <PageHead title="Hafızalar" sub="Claude Code’un bu cihazda tuttuğu proje hafızaları. Yedeklere hepsi girer; başka cihaza giden pakete hangilerinin gireceğini sağdaki düğmeyle seçersin." />
      <div className="row-flex" style={{ marginBottom: 12 }}>
        <div className="search-wrap">
          <Search size={15} />
          <input className="input search" placeholder="Proje ara" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <div className="spacer" />
        <span className="muted small">Kaynak:</span>
        <PathLink path={`${data.claudeDir}/projects`} />
      </div>

      <Card>
        {head}
        {normal.length ? (
          <div className="rows">
            {normal.map((p) => <ProjectRow key={p.id} p={p} onOpen={() => setOpen(p)} onToggle={toggle} />)}
          </div>
        ) : (
          <Empty icon={Brain} title={q ? 'Eşleşen proje yok' : 'Henüz proje hafızası yok'}>
            {q ? null : 'Claude Code bir projede hafıza tuttuğunda burada görünür.'}
          </Empty>
        )}
      </Card>

      {scratch.length ? (
        <Card className="mt">
          <div className="card-head">
            <Sparkles size={16} />
            <div>
              <div className="card-title">Claude uygulamasının geçici oturumları</div>
              <div className="card-sub">Klasör seçilmeden açılan oturumlar. Yedeklere girer; başka cihazda karşılığı olmadığı için pakete varsayılan olarak girmez.</div>
            </div>
          </div>
          <div className="rows">
            {scratch.map((p) => <ProjectRow key={p.id} p={p} onOpen={() => setOpen(p)} onToggle={toggle} />)}
          </div>
        </Card>
      ) : null}

      {data.withoutMemory ? <div className="muted small mt">{data.withoutMemory} Claude projesinin hafızası yok; listede gösterilmiyor.</div> : null}
      {open ? <ProjectDrawer p={open} onClose={() => setOpen(null)} /> : null}
    </div>
  );
}
