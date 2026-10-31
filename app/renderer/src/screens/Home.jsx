import React, { useEffect, useState } from 'react';
import { Brain, FolderTree, ShieldCheck, Send, Save, PackagePlus, Download, Inbox, TriangleAlert, Clock, ArrowRight, Wrench } from 'lucide-react';
import { api, shell, errorText } from '../api.js';
import { useApp, Button, Card, Badge, Stat, Banner, PageHead, Path, PathLink, Loading } from '../ui.jsx';
import { fmtDate, fmtRelative, fmtBytes, count, label } from '../format.js';
import { t } from '../i18n.js';
import { ActivityRow } from './Activity.jsx';

function Warning({ w, go }) {
  if (w.code === 'no-claude') {
    return (
      <Banner tone="warn" icon={TriangleAlert}>
        {t('home.warn.noClaude', { path: <Path>{w.path}</Path> })}
      </Banner>
    );
  }
  if (w.code === 'root-missing') {
    return (
      <Banner tone="warn" icon={TriangleAlert} action={<Button size="sm" onClick={() => go('workspaces')}>{t('home.warn.edit')}</Button>}>
        {t('home.warn.rootMissing', { path: <Path>{w.path}</Path> })}
      </Banner>
    );
  }
  if (w.code === 'no-roots') {
    return (
      <Banner tone="warn" icon={FolderTree} action={<Button size="sm" onClick={() => go('workspaces')}>{t('common.addFolder')}</Button>}>
        {t('home.warn.noRoots')}
      </Banner>
    );
  }
  if (w.code === 'workspace-fixable') {
    return (
      <Banner tone="warn" icon={Wrench} action={<Button size="sm" onClick={() => go('workspaces')}>{t('common.show')}</Button>}>
        {t('home.warn.fixable', { count: w.count })}
      </Banner>
    );
  }
  return null;
}

export default function Home() {
  const { go, toast, refresh, version } = useApp();
  const [ov, setOv] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    api.overview().then(setOv).catch(setError);
  }, [version]);

  if (error) return <div className="page"><Banner tone="error" icon={TriangleAlert}>{errorText(error)}</Banner></div>;
  if (!ov) return <Loading />;

  const c = ov.counts;
  const d = ov.daily;
  const pending = ov.pending.new + ov.pending.changed;
  // A daily run that found nothing changed counts as the last backup too, although it wrote no new file.
  const last = d.lastUnchanged && d.lastAt && (!ov.lastBackup || d.lastAt > ov.lastBackup.createdAt)
    ? { at: d.lastAt, note: `${label('kind', 'daily')} · ${fmtDate(d.lastAt)} ${t('home.daily.unchanged')}` }
    : ov.lastBackup ? { at: ov.lastBackup.createdAt, note: `${label('kind', ov.lastBackup.kind)} · ${fmtDate(ov.lastBackup.createdAt)}` } : null;

  const backupNow = async () => {
    setBusy(true);
    try {
      const r = await api.createBackup('manual');
      toast(t('common.backupVerified', { contents: `${count('projects', r.stats.projects)}, ${count('memoryFiles', r.stats.memoryFiles)}` }));
      refresh();
    } catch (e) {
      toast(errorText(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page">
      <PageHead title={t('nav.home')} sub={t('home.sub', { device: ov.device.name, platform: ov.device.platformName })}>
        <Button icon={Save} onClick={backupNow} disabled={busy} data-testid="backup-now">
          {busy ? t('common.backingUp') : t('common.backupNow')}
        </Button>
        <Button icon={PackagePlus} onClick={() => go('transfer', { tab: 'export' })}>{t('common.createBundle')}</Button>
        <Button variant="primary" icon={Download} onClick={() => go('transfer', { tab: 'import' })}>{t('common.importBundle')}</Button>
      </PageHead>

      {ov.incoming.map((b) => (
        <Banner key={b.path} tone="info" icon={Inbox} action={<Button size="sm" variant="primary" onClick={() => go('transfer', { bundle: b.path })}>{t('home.incoming.review')}</Button>}>
          {t('home.incoming.text', { device: <span className="strong">{b.device.name}</span> })} · {fmtDate(b.createdAt)} ·{' '}
          {count('projects', b.stats.projects)}, {count('memoryFiles', b.stats.memoryFiles)}
          <div><Path>{b.path}</Path></div>
        </Banner>
      ))}
      {ov.warnings.map((w, i) => <Warning key={i} w={w} go={go} />)}

      <div className="grid cols-4">
        <Stat icon={Brain} label={t('common.projectMemories')} value={count('projects', c.projects)} note={`${count('files', c.memoryFiles)} · ${fmtBytes(c.bytes)}`} onClick={() => go('projects')} />
        <Stat icon={FolderTree} label={t('common.workspaceFiles')} value={count('files', c.workspaceFiles)} note={count('scanFolders', c.workspaceRoots)} onClick={() => go('workspaces')} />
        <Stat
          icon={ShieldCheck}
          label={t('home.stat.lastBackup')}
          value={last ? fmtRelative(last.at) : t('common.notYet')}
          note={last ? last.note : t('home.stat.takeOne')}
          onClick={() => go('backups')}
        />
        <Stat
          icon={Send}
          label={t('common.sinceLastBundle')}
          value={pending ? count('files', pending) : t('home.stat.noChanges')}
          note={pending ? t('home.stat.pendingNote', { new: ov.pending.new, changed: ov.pending.changed }) : t('home.stat.allInBundle')}
          onClick={() => go('transfer', { tab: 'export' })}
        />
      </div>

      <div className="grid cols-2 mt">
        <Card>
          <div className="card-head">
            <Clock size={16} />
            <div className="card-title">{t('home.daily.title')}</div>
            <div className="spacer" />
            <Badge tone={d.enabled ? 'green' : ''}>{d.enabled ? t('common.on') : t('common.off')}</Badge>
          </div>
          <div className="card-pad">
            <dl className="kv">
              <dt>{t('home.daily.time')}</dt>
              <dd>{d.enabled ? t('home.daily.everyDay', { time: d.time }) : '-'}</dd>
              <dt>{t('home.daily.last')}</dt>
              <dd>{d.lastAt ? `${fmtDate(d.lastAt)}${d.lastUnchanged ? ` ${t('home.daily.unchanged')}` : ''}` : t('common.notYet')}</dd>
              <dt>{t('home.daily.next')}</dt>
              <dd>{!d.enabled || !d.nextAt ? '-' : d.due ? t('home.daily.soon') : fmtRelative(d.nextAt)}</dd>
              <dt>{t('common.backupFolder')}</dt>
              <dd><PathLink path={ov.device.backupDir} /></dd>
            </dl>
            <div className="muted small mt">{t('home.daily.note')}</div>
          </div>
          <div className="card-foot">
            <Button size="sm" onClick={() => go('settings')}>{t('home.daily.changeSettings')}</Button>
            <Button size="sm" variant="ghost" onClick={() => shell.openPath(ov.device.backupDir)}>{t('common.openFolder')}</Button>
          </div>
        </Card>

        <Card>
          <div className="card-head">
            <Brain size={16} />
            <div className="card-title">{t('home.source.title')}</div>
          </div>
          <div className="card-pad">
            <dl className="kv">
              <dt>{t('common.claudeFolder')}</dt>
              <dd><PathLink path={ov.device.claudeDir} /></dd>
              <dt>{t('common.projectMemories')}</dt>
              <dd className="small">{t('home.source.perProject', { path: <span className="code">{t('home.source.memoryPath')}</span> })}</dd>
              <dt>{t('common.claudeSettings')}</dt>
              <dd className="small">{c.claudeFiles ? `${count('files', c.claudeFiles)} (CLAUDE.md, agents, commands, skills)` : t('common.none')}</dd>
              <dt>{t('common.appData')}</dt>
              <dd><PathLink path={ov.device.stateHome} /></dd>
            </dl>
            {c.scratchProjects ? <div className="muted small mt">{t('home.source.scratch', { count: c.scratchProjects })}</div> : null}
          </div>
          <div className="card-foot">
            <Button size="sm" onClick={() => go('projects')}>{t('home.source.viewMemories')}</Button>
          </div>
        </Card>
      </div>

      <Card className="mt">
        <div className="card-head">
          <div className="card-title">{t('home.recent.title')}</div>
          <div className="spacer" />
          <Button size="sm" variant="ghost" onClick={() => go('activity')}>
            {t('common.all')} <ArrowRight size={14} />
          </Button>
        </div>
        {ov.recent.length ? (
          <div className="rows">
            {ov.recent.slice(0, 5).map((e) => <ActivityRow key={e.id} e={e} compact />)}
          </div>
        ) : (
          <div className="card-pad muted">{t('home.recent.none')}</div>
        )}
      </Card>
    </div>
  );
}
