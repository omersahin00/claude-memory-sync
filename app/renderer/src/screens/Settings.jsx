import React, { useEffect, useState } from 'react';
import { Monitor, AppWindow, Package, FolderSearch, FolderPlus, Trash2, Info, FolderOpen, ShieldCheck, Settings2, GitBranch, ExternalLink, Lock, KeyRound } from 'lucide-react';
import { api, shell, errorText, openFolder } from '../api.js';
import { useApp, Card, Button, Toggle, Segmented, PageHead, Path, PathLink, Loading, Modal } from '../ui.jsx';
import { t, LANGUAGES } from '../i18n.js';
import BackupContent, { backupSummary } from './BackupContent.jsx';
import { SetupBackups, OpenBackups, PasswordModal, ScheduleEditor, StatusBadge } from './BackupSet.jsx';
import { label, scheduleText } from '../format.js';

const THEMES = ['system', 'light', 'dark'];

function Section({ icon: Icon, title, sub, children }) {
  return (
    <Card>
      <div className="card-head">
        <Icon size={16} />
        <div>
          <div className="card-title">{title}</div>
          {sub ? <div className="card-sub">{sub}</div> : null}
        </div>
      </div>
      <div className="rows">{children}</div>
    </Card>
  );
}

function Line({ label, sub, children }) {
  return (
    <div className="row" style={{ padding: '12px 18px' }}>
      <div className="row-main">
        <div style={{ fontWeight: 540 }}>{label}</div>
        {sub ? <div className="muted small" style={{ whiteSpace: 'normal' }}>{sub}</div> : null}
      </div>
      <div className="row-side">{children}</div>
    </div>
  );
}

export default function Settings() {
  const { version, refresh, toast, changeLanguage } = useApp();
  const [s, setS] = useState(null);
  const [name, setName] = useState('');
  const [info, setInfo] = useState(null);
  const [content, setContent] = useState(false);
  const [preview, setPreview] = useState(null);
  const [access, setAccess] = useState(null);
  const [backup, setBackup] = useState(null);
  const [modal, setModal] = useState(null);
  const [sched, setSched] = useState(null);

  useEffect(() => {
    api.settings().then((x) => {
      setS(x);
      setName(x.deviceName);
    });
    shell.appInfo().then(setInfo);
    api.backupPreview().then(setPreview).catch(() => {});
    api.folderAccess().then(setAccess).catch(() => {});
    api.backupStatus().then((st) => {
      setBackup(st.set);
      setSched(st.set ? st.set.schedule : null);
    }).catch(() => {});
  }, [version]);

  if (!s) return <Loading />;

  const save = async (patch, message = t('common.saved')) => {
    try {
      await api.updateSettings(patch);
      toast(message);
      refresh();
    } catch (e) {
      toast(errorText(e), 'error');
    }
  };
  // '' follows the system language.
  const chooseLanguage = async (code) => {
    setS((x) => ({ ...x, language: code || null }));
    try {
      await api.updateSettings({ language: code || null });
      changeLanguage(code || (info && info.systemLanguage));
      toast(t('common.saved'));
      refresh();
    } catch (e) {
      toast(errorText(e), 'error');
    }
  };
  const saveBackup = async (patch) => {
    try {
      await api.backupSettings(patch);
      toast(t('common.saved'));
      refresh();
    } catch (e) {
      toast(errorText(e), 'error');
    }
  };
  // Taken out of the app only: the backup folder and its snapshots stay as they are and open again with Open existing.
  const removeBackups = async () => {
    try {
      await api.removeBackups();
      setModal(null);
      toast(t('settings.backup.removed'));
      refresh();
    } catch (e) {
      toast(errorText(e), 'error');
    }
  };
  const addBundleDir = async () => {
    const p = await shell.chooseFolder({ title: t('settings.dirs.choose') });
    if (p) save({ bundleDirs: [...s.bundleDirs, p] });
  };
  const systemName = info && (LANGUAGES.find((l) => l.code === info.systemLanguage) || {}).name;

  return (
    <div className="page">
      <PageHead title={t('nav.settings')} sub={t('settings.sub')} />
      <div className="stack">
        <Section icon={Monitor} title={t('settings.device.title')}>
          <Line label={t('settings.device.name')} sub={t('settings.device.nameSub')}>
            <input className="input" style={{ width: 220 }} value={name} onChange={(e) => setName(e.target.value)} />
            <Button size="sm" disabled={!name.trim() || name === s.deviceName} onClick={() => save({ deviceName: name })}>{t('common.save')}</Button>
          </Line>
          <Line label={t('settings.device.os')}>{s.device.platformName}</Line>
          <Line label={t('common.claudeFolder')} sub={t('settings.device.claudeDirSub')}><PathLink path={s.device.claudeDir} /></Line>
          <Line label={t('common.appData')} sub={t('settings.device.appDataSub')}><PathLink path={s.device.stateHome} /></Line>
        </Section>

        <Section icon={Lock} title={t('settings.backup.title')} sub={t('settings.backup.sub')}>
          {backup ? (
            <>
              <Line label={t('common.status')} sub={scheduleText(backup.schedule)}>
                <StatusBadge status={backup.status} />
                {backup.status === 'noPassword' ? <Button size="sm" icon={KeyRound} onClick={() => setModal('password')}>{t('backups.password.button')}</Button> : null}
              </Line>
              <Line label={t('backups.form.schedule')} sub={t(`backups.form.scheduleHint.${sched ? sched.every : backup.schedule.every}`)}>
                <div style={{ maxWidth: 420 }}>
                  <ScheduleEditor value={sched || backup.schedule} onChange={(v) => { setSched(v); saveBackup({ schedule: v }); }} />
                </div>
              </Line>
              <Line label={t('settings.backup.content')} sub={preview ? backupSummary(preview, s.backup.chats) : t('common.calculating')}>
                <Button size="sm" onClick={() => setContent(true)} data-testid="backup-content">{t('common.change')}</Button>
              </Line>
              <Line label={t('backups.settings.keepBefore')} sub={t('backups.settings.keepBeforeHint')}>
                <input className="input" type="number" min="1" max="1000" style={{ width: 80 }} defaultValue={backup.keepBefore} onBlur={(e) => Number(e.target.value) !== backup.keepBefore && saveBackup({ keepBefore: Number(e.target.value) })} data-testid="keep-before" />
              </Line>
              <Line label={t('backups.card.folder')} sub={<Path>{backup.repo}</Path>}>
                <Button size="sm" icon={FolderOpen} onClick={() => openFolder(backup.repo, toast)}>{t('common.open')}</Button>
                <Button size="sm" variant="ghost" icon={Trash2} onClick={() => setModal('remove')} data-testid="backups-remove">{t('settings.backup.remove')}</Button>
              </Line>
            </>
          ) : (
            <Line label={t('backups.card.none')} sub={t('backups.ask.why')}>
              <Button size="sm" variant="primary" icon={ShieldCheck} onClick={() => setModal('setup')}>{t('backups.ask.setup')}</Button>
              <Button size="sm" onClick={() => setModal('open')}>{t('backups.ask.open')}</Button>
            </Line>
          )}
        </Section>

        <Section icon={AppWindow} title={t('settings.app.title')}>
          <Line label={t('settings.app.language')} sub={t('settings.app.languageSub')}>
            <select className="input" value={s.language || ''} onChange={(e) => chooseLanguage(e.target.value)} data-testid="language">
              <option value="">{systemName ? t('settings.app.systemLanguage', { name: systemName }) : t('settings.app.system')}</option>
              {LANGUAGES.map((l) => <option key={l.code} value={l.code}>{l.name}</option>)}
            </select>
          </Line>
          <Line label={t('settings.app.theme')} sub={t('settings.app.themeSub')}>
            <Segmented value={s.theme} options={THEMES.map((v) => ({ value: v, label: t(`settings.app.themes.${v}`) }))} onChange={(v) => save({ theme: v })} />
          </Line>
          <Line label={t('settings.app.openAtLogin')} sub={info && !info.packaged ? t('settings.app.openAtLoginDev') : t('settings.app.openAtLoginSub')}>
            <Toggle on={s.openAtLogin} onChange={(v) => save({ openAtLogin: v })} label={t('settings.app.openAtLoginLabel')} />
          </Line>
          <Line label={t('settings.app.background')} sub={t('settings.app.backgroundSub')}>
            <Toggle on={s.runInBackground} onChange={(v) => save({ runInBackground: v })} label={t('settings.app.backgroundLabel')} />
          </Line>
        </Section>

        <Section icon={Package} title={t('settings.bundle.title')} sub={t('settings.bundle.sub')}>
          <Line label={t('common.claudeSettings')} sub={t('settings.bundle.claudeSub')}>
            <Toggle on={s.includeClaude} onChange={(v) => save({ includeClaude: v })} label={t('common.claudeSettings')} />
          </Line>
          <Line label={t('common.scratchSessions')} sub={t('settings.bundle.scratchSub')}>
            <Toggle on={s.includeScratch} onChange={(v) => save({ includeScratch: v })} label={t('settings.bundle.scratchLabel')} />
          </Line>
          <Line label={t('settings.bundle.excluded')} sub={s.excludedProjects.length ? s.excludedProjects.join(', ') : t('settings.bundle.excludedNone')} />
        </Section>

        <Section icon={FolderSearch} title={t('settings.dirs.title')} sub={t('settings.dirs.sub')}>
          {s.bundleDirs.map((d) => (
            <Line key={d} label={<Path>{d}</Path>}>
              <Button size="sm" variant="ghost" icon={Trash2} onClick={() => save({ bundleDirs: s.bundleDirs.filter((x) => x !== d) })}>{t('common.remove')}</Button>
            </Line>
          ))}
          <Line label={t('common.addFolder')}>
            <Button size="sm" icon={FolderPlus} onClick={addBundleDir}>{t('common.add')}</Button>
          </Line>
        </Section>

        <Section icon={ShieldCheck} title={t('settings.privacy.title')}>
          <Line label={t('intro.privacyTitle')} sub={t('intro.privacy')} />
          {info && info.platform === 'darwin' ? (
            <Line label={t('settings.privacy.folders')} sub={access ? access.map((a) => `${label('folder', a.id)}: ${label('access', a.state)}`).join(' · ') : t('common.calculating')}>
              <Button size="sm" icon={Settings2} onClick={() => shell.openPrivacySettings()}>{t('intro.openSettings')}</Button>
            </Line>
          ) : null}
        </Section>

        <Section icon={Info} title={t('settings.about.title')}>
          <Line label="Claude Memory Sync" sub={t('settings.about.sub')}>
            <span className="muted">{t('settings.about.version', { version: s.device.appVersion })}</span>
          </Line>
        </Section>

        {info && info.links ? (
          <Section icon={GitBranch} title="GitHub" sub={t('settings.github.sub')}>
            <Line label={info.author} sub={`${t('settings.github.author')} · ${info.links.profile.replace(/^https:\/\//, '')}`}>
              <Button size="sm" icon={ExternalLink} onClick={() => shell.openLink('profile')} data-testid="github-profile">{t('settings.github.profile')}</Button>
            </Line>
            <Line label={t('settings.github.repo')} sub={info.links.repo.replace(/^https:\/\//, '')}>
              <Button size="sm" icon={ExternalLink} onClick={() => shell.openLink('repo')}>{t('common.open')}</Button>
            </Line>
            <Line label={t('settings.github.releases')} sub={t('settings.github.releasesSub')}>
              <Button size="sm" icon={ExternalLink} onClick={() => shell.openLink('releases')}>{t('common.open')}</Button>
            </Line>
            <Line label={t('settings.github.issues')} sub={t('settings.github.issuesSub')}>
              <Button size="sm" icon={ExternalLink} onClick={() => shell.openLink('issues')}>{t('common.open')}</Button>
            </Line>
            <Line label={t('settings.github.license')} sub={t('settings.github.licenseSub')}>
              <Button size="sm" icon={ExternalLink} onClick={() => shell.openLink('license')}>{t('common.open')}</Button>
            </Line>
          </Section>
        ) : null}
      </div>
      {content ? <BackupContent onClose={() => setContent(false)} /> : null}
      {modal === 'setup' ? <SetupBackups onClose={() => setModal(null)} /> : null}
      {modal === 'open' ? <OpenBackups onClose={() => setModal(null)} /> : null}
      {modal === 'password' ? <PasswordModal onClose={() => setModal(null)} /> : null}
      {modal === 'remove' ? (
        <Modal title={t('settings.backup.removeTitle')} onClose={() => setModal(null)} footer={<><Button onClick={() => setModal(null)}>{t('common.cancel')}</Button><Button variant="primary" icon={Trash2} onClick={removeBackups} data-testid="backups-remove-yes">{t('settings.backup.remove')}</Button></>}>
          <p style={{ marginTop: 0 }}>{t('settings.backup.removeText')}</p>
          <Path>{backup ? backup.repo : ''}</Path>
        </Modal>
      ) : null}
    </div>
  );
}
