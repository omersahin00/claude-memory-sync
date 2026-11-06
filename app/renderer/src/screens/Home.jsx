import React, { useEffect, useState } from 'react';
import { Brain, FolderTree, ShieldCheck, ShieldAlert, Send, Inbox, TriangleAlert, Lock, ArrowRight, Wrench } from 'lucide-react';
import { api, errorText } from '../api.js';
import { useApp, Button, Card, Stat, Banner, PageHead, Path, PathLink, Loading } from '../ui.jsx';
import { fmtDate, fmtRelative, fmtBytes, count, scheduleText } from '../format.js';
import { t } from '../i18n.js';
import { ActivityRow } from './Activity.jsx';
import { BackupSummary, SetupBackups, PasswordModal } from './BackupSet.jsx';

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
  const { go, version } = useApp();
  const [ov, setOv] = useState(null);
  const [error, setError] = useState(null);
  const [modal, setModal] = useState(null);

  useEffect(() => {
    api.overview().then(setOv).catch(setError);
  }, [version]);

  if (error) return <div className="page"><Banner tone="error" icon={TriangleAlert}>{errorText(error)}</Banner></div>;
  if (!ov) return <Loading />;

  const c = ov.counts;
  const set = ov.backup;
  const pending = ov.pending.new + ov.pending.changed;
  const lastAt = set && set.state.lastSuccessAt;

  return (
    <div className="page">
      <PageHead title={t('nav.home')} sub={t('home.sub', { device: ov.device.name, platform: ov.device.platformName })} />

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
          value={lastAt ? fmtRelative(lastAt) : t('common.notYet')}
          note={!set ? t('home.stat.notSetUp') : lastAt ? `${scheduleText(set.schedule)} · ${fmtDate(lastAt)}` : t('home.stat.takeOne')}
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
            <Lock size={16} />
            <div className="card-title">{t('backups.card.title')}</div>
          </div>
          <div className="card-pad">
            {set ? <BackupSummary set={set} onPassword={() => setModal('password')} /> : (
              <>
                <Banner tone="warn" icon={ShieldAlert}>{t('backups.card.none')}</Banner>
                <div className="muted small">{t('backups.ask.why')}</div>
              </>
            )}
          </div>
          <div className="card-foot">
            {set ? <Button size="sm" onClick={() => go('backups')}>{t('home.backup.show')}</Button> : <Button size="sm" variant="primary" icon={ShieldCheck} onClick={() => setModal('setup')} data-testid="home-setup">{t('backups.ask.setup')}</Button>}
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
      {modal === 'setup' ? <SetupBackups onClose={() => setModal(null)} /> : null}
      {modal === 'password' ? <PasswordModal onClose={() => setModal(null)} /> : null}
    </div>
  );
}
