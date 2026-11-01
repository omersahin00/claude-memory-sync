import React, { useEffect, useMemo, useState } from 'react';
import { Brain, Search, GitBranch, FileText, FolderOpen, Sparkles } from 'lucide-react';
import { api, shell, errorText } from '../api.js';
import { useApp, Card, Badge, Toggle, PageHead, Path, PathLink, Loading, Empty, Drawer, Banner, Button } from '../ui.jsx';
import { fmtRelative, fmtBytes, fmtDate, tildify, count, label, FILE_TONE, projectTitle, projectSub } from '../format.js';
import { t, language } from '../i18n.js';

function statusBadge(p) {
  const n = p.status.new + p.status.changed;
  if (!n) return <Badge tone="green">{t('common.upToDate')}</Badge>;
  return <Badge tone="amber" title={t('projects.changesTitle')}>{count('changes', n)}</Badge>;
}

function ProjectRow({ p, onOpen, onToggle }) {
  return (
    <div className="row clickable" onClick={onOpen}>
      <div className="row-icon accent">
        <Brain size={16} />
      </div>
      <div className="row-main">
        <div className="row-title">
          {projectTitle(p)}
          {p.gitRemote ? <GitBranch size={12} style={{ marginLeft: 6, color: 'var(--text-3)' }} /> : null}
        </div>
        <div className="row-sub" title={p.cwd || p.dir}>{p.isScratch ? projectSub(p) : p.cwd ? tildify(p.cwd) : t('projects.noProjectFolder')}</div>
      </div>
      <div className="col-n">{count('files', p.fileCount)}</div>
      <div className="col-m muted small">{p.lastModified ? fmtRelative(p.lastModified) : '-'}</div>
      <div className="col-m">{statusBadge(p)}</div>
      <div className="row-side" onClick={(e) => e.stopPropagation()} title={t('projects.includedTitle')}>
        <Toggle on={p.included} onChange={(v) => onToggle(p, v)} label={t('projects.includedLabel', { name: projectTitle(p) })} />
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
    <Drawer title={projectTitle(p)} sub={p.isScratch ? projectSub(p) : t('projects.projectMemory')} onClose={onClose}
      actions={<Button size="sm" icon={FolderOpen} onClick={() => shell.openPath(p.memoryDir)}>{t('projects.openMemoryFolder')}</Button>}>
      <div className="section-label">{t('projects.from')}</div>
      <dl className="kv">
        <dt>{t('common.projectFolder')}</dt>
        <dd>{p.cwd ? <PathLink path={p.cwd} /> : <span className="muted">{t('common.notFound')}</span>}{p.cwd && !p.exists ? <Badge tone="red">{t('common.notOnDevice')}</Badge> : null}</dd>
        <dt>{t('common.memoryFolder')}</dt>
        <dd><PathLink path={p.memoryDir} /></dd>
        <dt>{t('common.gitRepo')}</dt>
        <dd>{p.gitRemote ? <Path>{p.gitRemote}</Path> : <span className="muted">{t('common.none')}</span>}</dd>
        <dt>{t('projects.keyInBundle')}</dt>
        <dd><span className="code">{p.key}</span></dd>
        <dt>{t('common.sinceLastBundle')}</dt>
        <dd>{t('projects.statusLine', { new: p.status.new, changed: p.status.changed, synced: p.status.synced })}</dd>
      </dl>

      <div className="section-label">{t('projects.filesSection', { count: p.fileCount })}</div>
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
                <Badge tone={FILE_TONE[f.status]}>{label('fileStatus', f.status)}</Badge>
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
            <div className="muted">{t('projects.binary')}</div>
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
    const s = q.trim().toLocaleLowerCase(language());
    return data.projects.filter((p) => !s || `${p.name} ${p.cwd || ''}`.toLocaleLowerCase(language()).includes(s));
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
      <div style={{ flex: 1 }}>{t('projects.col.project')}</div>
      <div className="col-n">{t('projects.col.files')}</div>
      <div className="col-m">{t('projects.col.modified')}</div>
      <div className="col-m">{t('common.status')}</div>
      <div style={{ width: 44 }} title={t('projects.includedTitle')}>{t('projects.col.inBundle')}</div>
    </div>
  );

  return (
    <div className="page">
      <PageHead title={t('nav.projects')} sub={t('projects.sub')} />
      <div className="row-flex" style={{ marginBottom: 12 }}>
        <div className="search-wrap">
          <Search size={15} />
          <input className="input search" placeholder={t('projects.search')} value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <div className="spacer" />
        <span className="muted small">{t('common.sourceLabel')}</span>
        <PathLink path={`${data.claudeDir}/projects`} />
      </div>

      <Card>
        {head}
        {normal.length ? (
          <div className="rows">
            {normal.map((p) => <ProjectRow key={p.id} p={p} onOpen={() => setOpen(p)} onToggle={toggle} />)}
          </div>
        ) : (
          <Empty icon={Brain} title={q ? t('projects.noMatch') : t('projects.none')}>
            {q ? null : t('projects.noneHint')}
          </Empty>
        )}
      </Card>

      {scratch.length ? (
        <Card className="mt">
          <div className="card-head">
            <Sparkles size={16} />
            <div>
              <div className="card-title">{t('common.scratchSessions')}</div>
              <div className="card-sub">{t('projects.scratchSub')}</div>
            </div>
          </div>
          <div className="rows">
            {scratch.map((p) => <ProjectRow key={p.id} p={p} onOpen={() => setOpen(p)} onToggle={toggle} />)}
          </div>
        </Card>
      ) : null}

      {data.withoutMemory ? <div className="muted small mt">{t('projects.withoutMemory', { count: data.withoutMemory })}</div> : null}
      {open ? <ProjectDrawer p={open} onClose={() => setOpen(null)} /> : null}
    </div>
  );
}
