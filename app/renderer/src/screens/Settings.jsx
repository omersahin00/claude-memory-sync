import React, { useEffect, useState } from 'react';
import { Monitor, Clock, AppWindow, Package, FolderSearch, FolderPlus, Trash2, Info, FolderOpen } from 'lucide-react';
import { api, shell, errorText } from '../api.js';
import { useApp, Card, Button, Toggle, Segmented, PageHead, Path, PathLink, Loading } from '../ui.jsx';
import { t, LANGUAGES } from '../i18n.js';
import BackupContent, { backupSummary } from './BackupContent.jsx';

const THEMES = ['system', 'light', 'dark'];
// The daily backup time, in the 5-minute steps the app checks at.
const HOURS = Array.from({ length: 24 }, (_, i) => String(i).padStart(2, '0'));
const MINUTES = Array.from({ length: 12 }, (_, i) => String(i * 5).padStart(2, '0'));

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

  useEffect(() => {
    api.settings().then((x) => {
      setS(x);
      setName(x.deviceName);
    });
    shell.appInfo().then(setInfo);
    api.backupPreview().then(setPreview).catch(() => {});
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
  const chooseBackupDir = async () => {
    const p = await shell.chooseFolder({ title: t('settings.backup.chooseFolder'), defaultPath: s.device.backupDir });
    if (p) save({ backupDir: p }, t('settings.backup.folderChanged'));
  };
  const addBundleDir = async () => {
    const p = await shell.chooseFolder({ title: t('settings.dirs.choose') });
    if (p) save({ bundleDirs: [...s.bundleDirs, p] });
  };
  const systemName = info && (LANGUAGES.find((l) => l.code === info.systemLanguage) || {}).name;
  const [hh, mm] = s.daily.time.split(':');
  const setTime = (h, m) => save({ daily: { time: `${h}:${m}` } }, t('settings.backup.timeSaved'));

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

        <Section icon={Clock} title={t('settings.backup.title')} sub={t('settings.backup.sub')}>
          <Line label={t('settings.backup.daily')} sub={t('settings.backup.dailySub')}>
            <Toggle on={s.daily.enabled} onChange={(v) => save({ daily: { enabled: v } })} label={t('kind.daily')} />
          </Line>
          <Line label={t('settings.backup.time')}>
            <select className="input" value={hh} disabled={!s.daily.enabled} onChange={(e) => setTime(e.target.value, mm)} aria-label={t('settings.backup.time')} data-testid="daily-hour">
              {HOURS.map((h) => <option key={h} value={h}>{h}</option>)}
            </select>
            <span className="muted">:</span>
            <select className="input" value={mm} disabled={!s.daily.enabled} onChange={(e) => setTime(hh, e.target.value)} aria-label={t('settings.backup.time')} data-testid="daily-minute">
              {MINUTES.map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
          </Line>
          <Line label={t('settings.backup.content')} sub={preview ? backupSummary(preview, s.backup.chats) : t('common.calculating')}>
            <Button size="sm" onClick={() => setContent(true)} data-testid="backup-content">{t('common.change')}</Button>
          </Line>
          <Line label={t('settings.backup.keepDaily')} sub={t('settings.backup.keepDailySub')}>
            <input className="input" type="number" min="1" max="365" style={{ width: 80 }} defaultValue={s.daily.keep} onBlur={(e) => Number(e.target.value) !== s.daily.keep && save({ daily: { keep: Number(e.target.value) } })} />
          </Line>
          <Line label={t('settings.backup.keepBefore')} sub={t('settings.backup.keepBeforeSub')}>
            <input className="input" type="number" min="1" max="1000" style={{ width: 80 }} defaultValue={s.keepBefore} onBlur={(e) => Number(e.target.value) !== s.keepBefore && save({ keepBefore: Number(e.target.value) })} />
          </Line>
          <Line label={t('common.backupFolder')} sub={<Path>{s.device.backupDir}</Path>}>
            <Button size="sm" icon={FolderOpen} onClick={() => shell.openPath(s.device.backupDir)}>{t('common.open')}</Button>
            <Button size="sm" onClick={chooseBackupDir}>{t('common.change')}</Button>
            {s.backupDir ? <Button size="sm" variant="ghost" onClick={() => save({ backupDir: null })}>{t('settings.backup.default')}</Button> : null}
          </Line>
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

        <Section icon={Info} title={t('settings.about.title')}>
          <Line label="Claude Memory Sync" sub={t('settings.about.sub')}>
            <span className="muted">{t('settings.about.version', { version: s.device.appVersion })}</span>
          </Line>
        </Section>
      </div>
      {content ? <BackupContent onClose={() => setContent(false)} /> : null}
    </div>
  );
}
