import React, { useEffect, useState } from 'react';
import { FolderTree, FolderPlus, FileCode2, Wrench, Check, X as XIcon, GitBranch, TriangleAlert, Trash2, ShieldCheck } from 'lucide-react';
import { api, shell, errorText } from '../api.js';
import { useApp, Card, Badge, Button, PageHead, Path, PathLink, Loading, Empty, Modal, Banner, DiffView } from '../ui.jsx';
import { fmtRelative, count, label, FILE_TONE } from '../format.js';
import { t } from '../i18n.js';

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
      toast(t('workspaces.fixed'));
      onDone();
    } catch (e) {
      toast(errorText(e), 'error');
      setBusy(false);
    }
  };
  return (
    <Modal title={t('workspaces.fixTitle', { file: file.rel })} onClose={onClose} wide
      footer={<>
        <Button onClick={onClose}>{t('common.cancel')}</Button>
        <Button variant="primary" icon={Wrench} onClick={apply} disabled={busy || !preview || !preview.changes || !preview.changes.length}>{t('workspaces.fix')}</Button>
      </>}>
      {!preview ? <Loading /> : preview.error ? <Banner tone="error" icon={TriangleAlert}>{preview.error}</Banner> : (
        <>
          <p style={{ marginTop: 0 }}>{t('workspaces.fixIntro', { slash: <span className="code">/</span> })}</p>
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
          ) : <Banner tone="ok" icon={Check}>{t('workspaces.nothingToFix')}</Banner>}
          <DiffView lines={preview.lines} minusLabel={t('workspaces.current')} plusLabel={t('workspaces.fixedVersion')} />
          <Banner tone="info" icon={ShieldCheck}>{t('workspaces.backupFirst')}</Banner>
        </>
      )}
    </Modal>
  );
}

function WorkspaceFile({ root, f, onFix }) {
  const sub = [count('folders', f.folders.length), f.settings ? count('settings', f.settings) : null, t('workspaces.modified', { when: fmtRelative(f.mtime) })];
  return (
    <div className="row" style={{ alignItems: 'flex-start' }}>
      <div className="row-icon violet" style={{ marginTop: 2 }}>
        <FileCode2 size={16} />
      </div>
      <div className="row-main">
        <div className="row-flex">
          <span className="row-title">{f.rel}</span>
          <Badge tone={FILE_TONE[f.status]}>{label('fileStatus', f.status)}</Badge>
          {f.parseError ? <Badge tone="red">{t('common.unreadable')}</Badge> : null}
        </div>
        <div className="row-sub">{sub.filter(Boolean).join(' · ')}</div>
        {f.parseError ? <div className="small" style={{ color: 'var(--red)', marginTop: 4 }}>{t('workspaces.parseError', { error: f.parseError })}</div> : null}
        <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 5 }}>
          {f.folders.map((fo, i) => (
            <div key={i} className="row-flex small" style={{ alignItems: 'flex-start' }}>
              {fo.kind === 'uri' ? <span className="dot-i gray" style={{ marginTop: 5 }} /> : fo.exists ? <Check size={14} style={{ color: 'var(--green)', flex: 'none', marginTop: 1 }} /> : <XIcon size={14} style={{ color: 'var(--red)', flex: 'none', marginTop: 1 }} />}
              <div style={{ minWidth: 0 }}>
                <Path>{fo.path}</Path>
                {fo.name ? <span className="muted"> ({fo.name})</span> : null}
                {fo.isGit ? <GitBranch size={12} style={{ marginLeft: 6, color: 'var(--text-3)' }} /> : null}
                {fo.warnings.length ? (
                  <div style={{ color: 'var(--amber)' }}>{fo.warnings.map((w) => label('wsWarning', w) || w).join(' · ')}</div>
                ) : null}
              </div>
            </div>
          ))}
        </div>
      </div>
      <div className="row-side">
        {f.fixable ? <Button size="sm" icon={Wrench} onClick={() => onFix(root, f)}>{t('workspaces.makePortable')}</Button> : null}
        <Button size="sm" variant="ghost" className="icon" title={t('common.showInFolder')} onClick={() => shell.reveal(f.path)}>
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
    const p = await shell.chooseFolder({ title: t('workspaces.chooseRoot') });
    if (p) saveRoots([...settings.workspaceRoots, p]);
  };
  const removeRoot = (abs) => saveRoots(settings.workspaceRoots.filter((x) => x !== abs));

  return (
    <div className="page">
      <PageHead title={t('nav.workspaces')} sub={t('workspaces.sub')}>
        <Button icon={FolderPlus} onClick={addRoot}>{t('common.addFolder')}</Button>
      </PageHead>

      {!roots.length ? (
        <Card>
          <Empty icon={FolderTree} title={t('workspaces.noRoots')}>
            {t('workspaces.noRootsHint')}
            <div className="mt"><Button variant="primary" icon={FolderPlus} onClick={addRoot}>{t('common.addFolder')}</Button></div>
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
                    {i === 0 ? <Badge tone="accent">{t('workspaces.mainRoot')}</Badge> : null}
                    {!r.exists ? <Badge tone="red">{t('common.notFound')}</Badge> : null}
                  </div>
                  <PathLink path={r.path} />
                </div>
                <span className="muted small">{count('files', r.files.length)}</span>
                <Button size="sm" variant="ghost" icon={Trash2} onClick={() => removeRoot(r.path)}>{t('workspaces.remove')}</Button>
              </div>
              {r.files.length ? (
                <div className="rows">
                  {r.files.map((f) => <WorkspaceFile key={f.rel} root={r} f={f} onFix={(root, file) => setFix({ root, file })} />)}
                </div>
              ) : (
                <div className="card-pad muted">{t('workspaces.noFiles')}</div>
              )}
            </Card>
          ))}
          <div className="muted small">{t('workspaces.removeNote')}</div>
        </div>
      )}

      {fix ? <FixModal root={fix.root} file={fix.file} onClose={() => setFix(null)} onDone={() => { setFix(null); refresh(); }} /> : null}
    </div>
  );
}
