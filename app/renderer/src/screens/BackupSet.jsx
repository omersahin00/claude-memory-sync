import React, { useEffect, useState } from 'react';
import { ShieldCheck, ShieldAlert, HardDrive, FolderOpen, Eye, EyeOff, Copy, FileDown, TriangleAlert, KeyRound, Lock, FolderSearch, Clock } from 'lucide-react';
import { api, shell, errorText, openFolder } from '../api.js';
import { useApp, Button, Badge, Banner, Modal, Path, PathLink, Segmented, TimePicker, Loading } from '../ui.jsx';
import { fmtBytes, fmtDate, fmtRelative, scheduleText, weekdayName } from '../format.js';
import { t } from '../i18n.js';

// The backups of this device: one encrypted backup folder (lib/backups.js). Setting it up, opening one that is already
// on a disk, its password and its schedule; the window's pieces for them, used on Overview, Backups and in Settings.

export const MIN_PASSWORD = 8;

export function Field({ label, hint, children, error }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {error ? <span className="field-error">{error}</span> : hint ? <span className="field-hint">{hint}</span> : null}
    </label>
  );
}

// A new password, typed twice.
export function PasswordFields({ value, repeat, onChange, onRepeat, autoFocus }) {
  const [show, setShow] = useState(false);
  const short = value && value.length < MIN_PASSWORD;
  const differ = repeat && value !== repeat;
  return (
    <>
      <Field label={t('backups.form.password')} error={short ? t('backups.form.short', { n: MIN_PASSWORD }) : null} hint={t('backups.form.passwordHint', { n: MIN_PASSWORD })}>
        <div className="row-flex">
          <input className="input grow" type={show ? 'text' : 'password'} value={value} onChange={(e) => onChange(e.target.value)} autoFocus={autoFocus} autoComplete="new-password" data-testid="password" />
          <Button variant="ghost" className="icon" icon={show ? EyeOff : Eye} onClick={() => setShow(!show)} title={show ? t('backups.form.hide') : t('backups.form.show')} aria-label={show ? t('backups.form.hide') : t('backups.form.show')} />
        </div>
      </Field>
      <Field label={t('backups.form.repeat')} error={differ ? t('backups.form.differ') : null}>
        <input className="input" type={show ? 'text' : 'password'} value={repeat} onChange={(e) => onRepeat(e.target.value)} autoComplete="new-password" data-testid="password-repeat" />
      </Field>
    </>
  );
}

export const passwordOk = (value, repeat) => value.length >= MIN_PASSWORD && value === repeat;

// When the backups are taken: every hour, day or week, at a time on the 5-minute grid, or only by hand.
export function ScheduleEditor({ value, onChange }) {
  const set = (patch) => onChange({ ...value, ...patch });
  return (
    <div className="field">
      <span className="field-label">{t('backups.form.schedule')}</span>
      <Segmented value={value.every} onChange={(every) => set({ every })} options={['hourly', 'daily', 'weekly', 'off'].map((v) => ({ value: v, label: t(`schedule.every.${v}`) }))} />
      {value.every === 'daily' || value.every === 'weekly' ? (
        <div className="row-flex" style={{ marginTop: 10 }}>
          {value.every === 'weekly' ? (
            <select className="input" value={value.weekday} onChange={(e) => set({ weekday: Number(e.target.value) })} aria-label={t('backups.form.weekday')}>
              {[1, 2, 3, 4, 5, 6, 0].map((d) => <option key={d} value={d}>{weekdayName(d)}</option>)}
            </select>
          ) : null}
          <TimePicker value={value.time} onChange={(time) => set({ time })} label={t('backups.form.time')} />
        </div>
      ) : null}
      <span className="field-hint">{t(`backups.form.scheduleHint.${value.every}`)}</span>
    </div>
  );
}

// The recovery code, shown once: copied or saved to a file, and confirmed before the window can close.
export function RecoveryCode({ code, confirmed, onConfirm }) {
  const { toast } = useApp();
  const [saved, setSaved] = useState(null);
  const copy = async () => {
    await shell.copy(code);
    toast(t('backups.code.copied'));
  };
  const save = async () => {
    try {
      const r = await shell.saveRecoveryCode(code);
      if (r) setSaved(r);
    } catch (e) {
      toast(errorText(e), 'error');
    }
  };
  return (
    <div className="stack">
      <div className="muted">{t('backups.code.intro')}</div>
      <div className="code-box" data-testid="recovery-code">{code}</div>
      <div className="row-flex" style={{ justifyContent: 'center' }}>
        <Button icon={Copy} onClick={copy}>{t('backups.code.copy')}</Button>
        <Button icon={FileDown} onClick={save}>{t('backups.code.save')}</Button>
      </div>
      {saved ? (
        <Banner tone={saved.sameDisk ? 'error' : 'ok'} icon={saved.sameDisk ? TriangleAlert : undefined}>
          {saved.sameDisk ? t('backups.code.savedSameDisk', { path: saved.path }) : t('backups.code.saved', { path: saved.path })}
        </Banner>
      ) : null}
      <Banner tone="warn" icon={ShieldAlert}>{t('backups.code.warning')}</Banner>
      <label className="check-line">
        <input type="checkbox" checked={confirmed} onChange={(e) => onConfirm(e.target.checked)} data-testid="recovery-confirm" />
        <span>{t('backups.code.confirm')}</span>
      </label>
    </div>
  );
}

const STATUS_TONE = { ok: 'green', running: 'blue', never: '', incomplete: 'amber', failed: 'red', damaged: 'red', targetMissing: 'amber', noPassword: 'amber' };
export const StatusBadge = ({ status }) => <Badge tone={STATUS_TONE[status] || ''}>{t(`backups.status.${status}`)}</Badge>;

const DEFAULT_SCHEDULE = { every: 'daily', time: '12:00', weekday: 1 };

// Setting the backups up: where (a folder, best on another disk), a password, when. Then the recovery code.
export function SetupBackups({ onClose }) {
  const { device, refresh, toast } = useApp();
  const [place, setPlace] = useState(device ? device.stateHome : null);
  const [info, setInfo] = useState(null);
  const [password, setPassword] = useState('');
  const [repeat, setRepeat] = useState('');
  const [sched, setSched] = useState(DEFAULT_SCHEDULE);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(null);
  const [confirmed, setConfirmed] = useState(false);

  useEffect(() => {
    if (!place) return;
    setInfo(null);
    api.backupTarget(place).then(setInfo).catch((e) => setInfo({ error: errorText(e) }));
  }, [place]);

  const choose = async () => {
    const p = await shell.chooseFolder({ title: t('backups.setup.choose'), defaultPath: place || undefined });
    if (p) setPlace(p);
  };
  const create = async () => {
    setBusy(true);
    try {
      setDone(await api.setUpBackups({ place, password, schedule: sched }));
      refresh();
    } catch (e) {
      toast(errorText(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  if (done) {
    return (
      <Modal title={t('backups.setup.doneTitle')} wide footer={<Button variant="primary" disabled={!confirmed} onClick={onClose} data-testid="setup-close">{t('common.close')}</Button>}>
        <Banner tone="ok" icon={ShieldCheck}>{t('backups.setup.done', { path: <Path>{done.view.repo}</Path> })}</Banner>
        {!done.passwordSaved ? <Banner tone="warn" icon={KeyRound}>{t('backups.setup.notSaved')}</Banner> : null}
        <RecoveryCode code={done.recoveryCode} confirmed={confirmed} onConfirm={setConfirmed} />
      </Modal>
    );
  }
  const blocked = info && (info.error || !info.placeExists || !info.writable || info.isRepository || !info.empty);
  const ok = place && info && !blocked && passwordOk(password, repeat);
  return (
    <Modal
      title={t('backups.setup.title')}
      wide
      onClose={busy ? undefined : onClose}
      footer={(
        <>
          <Button onClick={onClose} disabled={busy}>{t('common.cancel')}</Button>
          <Button variant="primary" icon={ShieldCheck} disabled={!ok || busy} onClick={create} data-testid="setup-create">{busy ? t('backups.setup.creating') : t('backups.setup.create')}</Button>
        </>
      )}
    >
      <div className="stack">
        <div className="muted">{t('backups.setup.intro')}</div>
        <div className="field">
          <span className="field-label">{t('backups.setup.place')}</span>
          <div className="row-flex" style={{ alignItems: 'flex-start' }}>
            <Path>{place || '-'}</Path>
            <Button size="sm" icon={FolderSearch} onClick={choose} data-testid="setup-choose">{t('common.change')}</Button>
          </div>
          {!info ? <Loading /> : info.error ? <span className="field-error">{info.error}</span> : (
            <span className="field-hint">
              {t('backups.setup.folder', { path: info.repo })}
              {info.free != null ? ` · ${t('backups.setup.free', { size: fmtBytes(info.free) })}` : ''}
            </span>
          )}
        </div>
        {info && !info.error ? (
          <>
            {!info.placeExists ? <Banner tone="error" icon={TriangleAlert}>{t('errors.TARGET_MISSING', { path: place })}</Banner> : null}
            {info.placeExists && !info.writable ? <Banner tone="error" icon={TriangleAlert}>{t('errors.TARGET_NOT_WRITABLE', { path: place })}</Banner> : null}
            {info.isRepository ? <Banner tone="warn" icon={TriangleAlert}>{t('backups.setup.isRepository')}</Banner> : !info.empty ? <Banner tone="error" icon={TriangleAlert}>{t('errors.NOT_EMPTY', { path: info.repo })}</Banner> : null}
            {info.systemDisk ? <Banner tone="info" icon={HardDrive}>{t('backups.setup.systemDisk')}</Banner> : null}
          </>
        ) : null}
        <PasswordFields value={password} repeat={repeat} onChange={setPassword} onRepeat={setRepeat} />
        <ScheduleEditor value={sched} onChange={setSched} />
        <div className="muted small">{t('backups.setup.keep')}</div>
      </div>
    </Modal>
  );
}

// A backup folder of this app that is already on a disk (after a reset, or from another computer), opened with its
// password or its recovery code; with the code, a new password is set.
export function OpenBackups({ onClose }) {
  const { refresh, toast } = useApp();
  const [dir, setDir] = useState(null);
  const [secret, setSecret] = useState('');
  const [needNew, setNeedNew] = useState(false);
  const [password, setPassword] = useState('');
  const [repeat, setRepeat] = useState('');
  const [busy, setBusy] = useState(false);

  const choose = async () => {
    const p = await shell.chooseFolder({ title: t('backups.open.choose') });
    if (p) setDir(p);
  };
  const open = async () => {
    setBusy(true);
    try {
      const r = await api.openBackups({ dir, secret, newPassword: needNew ? password : null });
      toast(t('backups.open.done', { count: r.snapshots }));
      refresh();
      onClose();
    } catch (e) {
      if (e.code === 'NEED_NEW_PASSWORD') setNeedNew(true);
      else toast(errorText(e), 'error');
    } finally {
      setBusy(false);
    }
  };
  const ok = dir && secret && (!needNew || passwordOk(password, repeat));
  return (
    <Modal
      title={t('backups.open.title')}
      wide
      onClose={busy ? undefined : onClose}
      footer={(
        <>
          <Button onClick={onClose} disabled={busy}>{t('common.cancel')}</Button>
          <Button variant="primary" icon={Lock} disabled={!ok || busy} onClick={open} data-testid="open-backups">{t('backups.open.open')}</Button>
        </>
      )}
    >
      <div className="stack">
        <div className="muted">{t('backups.open.intro')}</div>
        <div className="field">
          <span className="field-label">{t('backups.open.folder')}</span>
          <div className="row-flex" style={{ alignItems: 'flex-start' }}>
            <Path>{dir || t('backups.open.none')}</Path>
            <Button size="sm" icon={FolderSearch} onClick={choose} data-testid="open-choose">{t('common.change')}</Button>
          </div>
        </div>
        <Field label={t('backups.open.secret')} hint={t('backups.open.secretHint')}>
          <input className="input" type="password" value={secret} onChange={(e) => setSecret(e.target.value)} autoComplete="off" data-testid="open-secret" />
        </Field>
        {needNew ? (
          <>
            <Banner tone="info" icon={KeyRound}>{t('backups.open.newPassword')}</Banner>
            <PasswordFields value={password} repeat={repeat} onChange={setPassword} onRepeat={setRepeat} autoFocus />
          </>
        ) : null}
      </div>
    </Modal>
  );
}

// The password, typed once more: it is not saved on this computer, or the system would not give it back.
export function PasswordModal({ onClose }) {
  const { refresh, toast } = useApp();
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      await api.setBackupPassword(password);
      toast(t('backups.password.saved'));
      refresh();
      onClose();
    } catch (e) {
      toast(errorText(e), 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title={t('backups.password.title')} onClose={onClose} footer={<><Button onClick={onClose}>{t('common.cancel')}</Button><Button variant="primary" icon={KeyRound} disabled={!password || busy} onClick={save} data-testid="password-save">{t('common.save')}</Button></>}>
      <div className="stack">
        <div className="muted">{t('backups.password.intro')}</div>
        <Field label={t('backups.form.password')}>
          <input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoFocus autoComplete="current-password" data-testid="password-again" />
        </Field>
      </div>
    </Modal>
  );
}

// Asked once on a new install, and after an update from a version whose backups were .memsync files. It can be
// answered later: the backups are set up on Backups at any time, and nothing is written before they are.
// onDone: answered (set up, opened or later).
export function BackupQuestion({ onDone }) {
  const { toast } = useApp();
  const [setup, setSetup] = useState(null);
  const later = async () => {
    try {
      await api.updateSettings({ askBackups: false });
      onDone();
    } catch (e) {
      toast(errorText(e), 'error');
    }
  };
  // Closed without setting anything up: the question is asked again.
  const closed = async () => {
    const st = await api.backupStatus().catch(() => null);
    if (st && st.set) onDone();
    else setSetup(null);
  };
  if (setup === 'new') return <SetupBackups onClose={closed} />;
  if (setup === 'open') return <OpenBackups onClose={closed} />;
  return (
    <Modal
      title={t('backups.ask.title')}
      footer={(
        <>
          <Button onClick={later} data-testid="ask-later">{t('backups.ask.later')}</Button>
          <Button onClick={() => setSetup('open')} data-testid="ask-open">{t('backups.ask.open')}</Button>
          <Button variant="primary" icon={ShieldCheck} onClick={() => setSetup('new')} data-testid="ask-setup">{t('backups.ask.setup')}</Button>
        </>
      )}
    >
      <div className="stack">
        <div>{t('backups.ask.text')}</div>
        <div className="muted small">{t('backups.ask.why')}</div>
      </div>
    </Modal>
  );
}

// The backups at a glance: status, place, schedule, the last and the next backup.
export function BackupSummary({ set, onPassword }) {
  const st = set.state || {};
  const last = st.last || null;
  return (
    <>
      <dl className="kv">
        <dt>{t('common.status')}</dt>
        <dd className="row-flex"><StatusBadge status={set.status} />{set.status === 'noPassword' && onPassword ? <Button size="sm" icon={KeyRound} onClick={onPassword} data-testid="backup-password">{t('backups.password.button')}</Button> : null}</dd>
        <dt>{t('backups.card.schedule')}</dt>
        <dd>{scheduleText(set.schedule)}</dd>
        <dt>{t('backups.card.last')}</dt>
        <dd>{st.lastSuccessAt ? `${fmtDate(st.lastSuccessAt)}${last && last.dataAdded != null ? ` · ${t('backups.card.added', { size: fmtBytes(last.dataAdded) })}` : ''}` : t('common.notYet')}</dd>
        <dt>{t('backups.card.next')}</dt>
        <dd>{set.nextRun ? fmtRelative(set.nextRun) : '-'}</dd>
        <dt>{t('backups.card.folder')}</dt>
        <dd>
          {set.targetPresent ? <PathLink path={set.repo} /> : <Path>{set.repo}</Path>}
        </dd>
      </dl>
      {st.lastFailure && set.status === 'failed' ? <Banner tone="error" icon={TriangleAlert}>{errorText(st.lastFailure)}</Banner> : null}
      {set.status === 'targetMissing' ? <Banner tone="warn" icon={HardDrive}>{t('backups.card.missing')}</Banner> : null}
      {set.status === 'damaged' ? <Banner tone="error" icon={ShieldAlert}>{t('backups.card.damaged')}</Banner> : null}
    </>
  );
}

export const scheduleIcon = Clock;
