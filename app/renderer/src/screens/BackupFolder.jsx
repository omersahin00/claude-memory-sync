import React, { useEffect, useRef, useState } from 'react';
import { ArrowRight, FileWarning, FolderInput, Inbox, Laptop, RotateCw, ShieldCheck, Square, TriangleAlert } from 'lucide-react';
import { api, errorText } from '../api.js';
import { useApp, Button, Card, Banner, Modal, Path, Loading } from '../ui.jsx';
import { fmtDate, fmtBytes, count, label } from '../format.js';
import { t } from '../i18n.js';

function Progress({ done, total, children }) {
  return (
    <div style={{ margin: '4px 0 12px' }}>
      <div className="small muted" style={{ marginBottom: 6 }}>{children}</div>
      <div className="progress" role="progressbar" aria-valuemin={0} aria-valuenow={done} aria-valuemax={total}>
        <div style={{ width: `${total ? (done / total) * 100 : 0}%` }} />
      </div>
    </div>
  );
}

// One kind of thing found in the folder.
function Found({ icon: Icon, tone, title, sub, children }) {
  return (
    <div className="row" style={{ alignItems: 'flex-start', padding: '10px 14px' }}>
      <div className={`row-icon ${tone}`}><Icon size={16} /></div>
      <div className="row-main">
        <div className="row-title" style={{ whiteSpace: 'normal' }}>{title}</div>
        <div className="muted small" style={{ whiteSpace: 'normal', marginTop: 2 }}>{sub}</div>
        {children}
      </div>
    </div>
  );
}

const kindsText = (kinds) => Object.entries(kinds).map(([k, n]) => `${label('kind', k) || k}: ${n}`).join(' · ');

// Choosing a backup folder, as in a folder backup program. What is in the chosen folder is read through first and only
// then used, the backups in the folders left behind can come along, and it asks only when there is something to ask.
// request: { dir }, { useDefault: true }, or {} to move what was left elsewhere to the folder in use.
export default function BackupFolder({ request, onClose }) {
  const { toast, refresh } = useApp();
  const [plan, setPlan] = useState(null);
  const [checked, setChecked] = useState(0);
  const [findings, setFindings] = useState(null);
  const [move, setMove] = useState(true);
  const [adopt, setAdopt] = useState(null);
  const [phase, setPhase] = useState('review');
  const [applied, setApplied] = useState(null);
  const [progress, setProgress] = useState(null);
  const [stopping, setStopping] = useState(false);
  const stop = useRef(false);

  const fail = (e) => {
    toast(errorText(e), 'error');
    refresh();
    onClose();
  };

  useEffect(() => {
    let gone = false;
    (async () => {
      const p = await api.reviewBackupFolder(request);
      if (gone) return;
      if (p.nothing) {
        if (p.changed) await api.applyBackupFolder(p.id, {});
        toast(p.changed ? t('settings.backup.folderChanged') : t('settings.backup.folder.nothing'));
        refresh();
        onClose();
        return;
      }
      setPlan(p);
      setMove(p.space.enough);
      for (const [i, f] of p.found.entries()) {
        await api.inspectBackup(p.id, f.path);
        if (gone) return;
        setChecked(i + 1);
      }
      const first = await api.backupFolderFindings(p.id);
      if (!gone) setAdopt(first.earlier.map((d) => d.id));
    })().catch((e) => {
      if (!gone) fail(e);
    });
    return () => {
      gone = true;
    };
  }, [request]);

  const willMove = Boolean(plan && plan.moves.count && plan.space.enough && move);

  useEffect(() => {
    if (plan && adopt && phase === 'review') api.backupFolderFindings(plan.id, { move: willMove, adopt }).then(setFindings).catch(fail);
  }, [plan, adopt, willMove, phase]);

  const runMoves = async (retry = false) => {
    setPhase('moving');
    stop.current = false;
    setStopping(false);
    try {
      let p = await api.moveNextBackup(plan.id, { retry });
      setProgress(p);
      while (!p.done && !stop.current) {
        p = await api.moveNextBackup(plan.id);
        setProgress(p);
      }
      if (p.done && p.failures.length) {
        setPhase('failed');
        return;
      }
      if (!p.done) setProgress(await api.stopBackupMove(plan.id));
      setPhase('done');
      refresh();
    } catch (e) {
      fail(e);
    }
  };

  const apply = async () => {
    setPhase('applying');
    try {
      const r = await api.applyBackupFolder(plan.id, { move: willMove, adopt });
      setApplied(r);
      if (r.moving) {
        runMoves();
        return;
      }
      toast([plan.changed ? t('settings.backup.folderChanged') : null, r.adopted ? t('settings.backup.folder.added', { count: r.adopted }) : null].filter(Boolean).join(' ') || t('common.saved'));
      refresh();
      onClose();
    } catch (e) {
      fail(e);
    }
  };

  const giveUp = async () => {
    try {
      await api.stopBackupMove(plan.id);
    } catch { /* it has ended already */ }
    refresh();
    onClose();
  };

  if (!plan) return <Modal title={t('settings.backup.folder.title')} onClose={onClose}><Loading /></Modal>;

  if (phase !== 'review') {
    const total = progress ? progress.total : applied ? applied.moving : 0;
    const moved = progress ? total - progress.left : 0;
    const footer = phase === 'done' ? <Button variant="primary" onClick={onClose} data-testid="folder-close">{t('common.close')}</Button>
      : phase === 'failed' ? <><Button onClick={giveUp} data-testid="folder-give-up">{t('common.close')}</Button><Button variant="primary" icon={RotateCw} onClick={() => runMoves(true)} data-testid="folder-retry">{t('settings.backup.folder.retry')}</Button></>
        : <Button icon={Square} disabled={phase === 'applying' || stopping} onClick={() => { stop.current = true; setStopping(true); }} data-testid="folder-stop">{stopping ? t('settings.backup.folder.stopping') : t('settings.backup.folder.stop')}</Button>;
    return (
      <Modal title={t('settings.backup.folder.title')} footer={footer} onClose={phase === 'done' ? onClose : undefined}>
        {phase === 'done' ? (
          <Banner tone={progress.left ? 'info' : 'ok'} icon={ShieldCheck}>
            {progress.left ? t('settings.backup.folder.movedSome', { moved: progress.moved, left: progress.left }) : t('settings.backup.folder.movedAll', { count: progress.moved })}
            {applied && applied.adopted ? ` ${t('settings.backup.folder.added', { count: applied.adopted })}` : ''}
          </Banner>
        ) : phase === 'failed' ? (
          <Banner tone="error" icon={TriangleAlert}>
            {t('settings.backup.folder.failed', { moved: progress.moved, left: progress.left })}
            {progress.failures.map((f) => (
              <div key={f.path} className="small" style={{ marginTop: 4 }}>
                <Path>{f.name}</Path> <span className="muted">{errorText(f)}</span>
              </div>
            ))}
          </Banner>
        ) : (
          <Progress done={moved} total={total}>{t('settings.backup.folder.moving', { done: moved, total })}</Progress>
        )}
        <div className="op"><Path>{plan.to}</Path></div>
      </Modal>
    );
  }

  const checking = checked < plan.found.length || !findings;
  const hasFound = plan.found.length > 0;
  const applyLabel = plan.changed ? (willMove ? 'moveAndUse' : 'use') : willMove ? 'moveHere' : 'done';
  const footer = (
    <>
      <Button onClick={onClose}>{t('common.cancel')}</Button>
      <Button variant="primary" icon={FolderInput} disabled={checking || (!plan.changed && !hasFound && !willMove)} onClick={apply} data-testid="folder-apply">{t(`settings.backup.folder.apply.${applyLabel}`)}</Button>
    </>
  );

  return (
    <Modal title={t('settings.backup.folder.title')} onClose={onClose} footer={footer}>
      {plan.changed ? (
        <dl className="kv" style={{ marginTop: 0 }}>
          <dt>{t('settings.backup.folder.from')}</dt>
          <dd><Path>{plan.from}</Path></dd>
          <dt>{t('settings.backup.folder.to')}</dt>
          <dd className="row-flex"><ArrowRight size={14} style={{ flex: 'none' }} /><Path>{plan.to}</Path></dd>
        </dl>
      ) : null}

      {plan.moves.count ? (
        <>
          <div className="section-label">{t('settings.backup.folder.current')}</div>
          <Card>
            <label className="row" style={{ alignItems: 'flex-start', padding: '10px 14px', cursor: plan.space.enough ? 'pointer' : 'default' }}>
              <input type="checkbox" style={{ marginTop: 2 }} checked={willMove} disabled={!plan.space.enough} onChange={(e) => setMove(e.target.checked)} data-testid="folder-move" />
              <div className="row-main">
                <div className="row-title" style={{ whiteSpace: 'normal' }}>{t(plan.changed ? 'settings.backup.folder.moveLabel' : 'settings.backup.folder.moveHereLabel')}</div>
                <div className="muted small">{count('backups', plan.moves.count)} · {fmtBytes(plan.moves.bytes)} · {kindsText(plan.moves.kinds)}</div>
                {plan.moves.dirs.map((d) => <div key={d.dir} className="small"><Path>{d.dir}</Path></div>)}
                <div className="muted small" style={{ whiteSpace: 'normal', marginTop: 4 }}>
                  {!willMove ? t('settings.backup.folder.noMove') : plan.space.need ? t('settings.backup.folder.otherDisk', { size: fmtBytes(plan.space.need) }) : t('settings.backup.folder.sameDisk')}
                </div>
              </div>
            </label>
          </Card>
          {!plan.space.enough ? <Banner tone="warn" icon={TriangleAlert}>{t('settings.backup.folder.noSpace', { need: fmtBytes(plan.space.need), free: fmtBytes(plan.space.free) })}</Banner> : null}
        </>
      ) : null}
      {plan.stay.other || plan.stay.unreadable ? (
        <div className="muted small" style={{ marginTop: 8 }}>
          {plan.stay.other ? `${t('settings.backup.folder.stayOther', { count: plan.stay.other })} ` : ''}
          {plan.stay.unreadable ? t('settings.backup.folder.stayUnreadable', { count: plan.stay.unreadable }) : ''}
        </div>
      ) : null}

      {hasFound ? (
        <>
          <div className="section-label">{t('settings.backup.folder.found')}</div>
          {checking ? (
            <Progress done={checked} total={plan.found.length}>{t('settings.backup.folder.checking', { done: checked, total: plan.found.length })}</Progress>
          ) : (
            <Card>
              <div className="rows" data-testid="folder-findings">
                {findings.mine.count ? (
                  <Found icon={ShieldCheck} tone="green" title={t('settings.backup.folder.mine', { count: findings.mine.count })} sub={t('settings.backup.folder.mineSub', { date: fmtDate(findings.mine.last) })} />
                ) : null}
                {findings.earlier.map((d) => (
                  <Found key={d.id} icon={Laptop} tone="accent" title={t('settings.backup.folder.earlier', { count: d.count, device: d.name })} sub={t('settings.backup.folder.earlierSub', { date: fmtDate(d.last) })}>
                    <label className="row-flex" style={{ marginTop: 6, cursor: 'pointer' }}>
                      <input type="checkbox" checked={adopt.includes(d.id)} onChange={(e) => setAdopt(e.target.checked ? [...adopt, d.id] : adopt.filter((x) => x !== d.id))} data-testid="folder-adopt" />
                      <span>{t('settings.backup.folder.earlierUse')}</span>
                    </label>
                  </Found>
                ))}
                {findings.other.map((d) => (
                  <Found key={d.id} icon={Inbox} tone="amber" title={t('settings.backup.folder.otherDevice', { count: d.count, device: d.name, system: d.platformName })} sub={t('settings.backup.folder.otherDeviceSub')} />
                ))}
                {findings.damaged.length ? (
                  <Found icon={FileWarning} tone="red" title={t('settings.backup.folder.damaged', { count: findings.damaged.length })} sub={t('settings.backup.folder.damagedSub')}>
                    {findings.damaged.map((f) => (
                      <div key={f.path} className="small" style={{ marginTop: 4, whiteSpace: 'normal' }}>
                        <Path>{f.name}</Path> <span className="muted">{errorText(f)}</span>
                      </div>
                    ))}
                  </Found>
                ) : null}
              </div>
            </Card>
          )}
        </>
      ) : null}

      {!checking && findings.retention.length ? (
        <div style={{ marginTop: 12 }}>
          {findings.retention.map((r) => (
            <Banner key={r.kind} tone="warn" icon={TriangleAlert}>
              {t('settings.backup.folder.retention', { kind: label('kind', r.kind), total: r.total, keep: r.keep, extra: r.extra })}
            </Banner>
          ))}
        </div>
      ) : null}
    </Modal>
  );
}
