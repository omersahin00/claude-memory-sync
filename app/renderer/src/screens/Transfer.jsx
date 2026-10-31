import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Download, PackagePlus, FileUp, Inbox, ArrowRight, ArrowLeft, Brain, FolderTree, Settings2, GitBranch, ShieldCheck,
  TriangleAlert, CircleCheck, FolderOpen, Undo2, Info, FileDiff, Check, X, Package, RotateCcw, Merge, FileCode2, HardDrive, MessagesSquare,
  ChevronRight, ChevronDown,
} from 'lucide-react';
import { api, shell, errorText } from '../api.js';
import { useApp, Card, Badge, Button, Path, PathLink, Loading, Empty, Banner, Modal, DiffView, Segmented } from '../ui.jsx';
import { fmtDate, fmtRelative, fmtBytes, count, label, groupMeta, GROUP_ORDER, RESTORE_ORDER, HOW_TONE, FILE_TONE, tildify } from '../format.js';
import { t, language } from '../i18n.js';
import { UndoModal } from './Activity.jsx';
import { contents } from './Backups.jsx';

const TYPE_ICON = { project: Brain, workspaceRoot: FolderTree, claude: Settings2 };
const STEPS = ['bundle', 'match', 'changes', 'confirm', 'result'];

function Steps({ step }) {
  return (
    <div className="steps">
      {STEPS.map((s, i) => (
        <React.Fragment key={s}>
          {i ? <div className="step-line" /> : null}
          <div className={`step ${i + 1 === step ? 'active' : i + 1 < step ? 'done' : ''}`}>
            <div className="step-num">{i + 1 < step ? <Check size={12} /> : i + 1}</div>
            {t(`transfer.steps.${s}`)}
          </div>
        </React.Fragment>
      ))}
    </div>
  );
}

// ---- Choosing a bundle --------------------------------------------------------------
function ChooseBundle({ onPick }) {
  const [over, setOver] = useState(false);
  const [lib, setLib] = useState(null);
  useEffect(() => {
    api.library().then(setLib).catch(() => setLib([]));
  }, []);
  const pick = async () => {
    const p = await shell.chooseBundle();
    if (p) onPick(p);
  };
  const foreign = (lib || []).filter((b) => !b.isMine && !b.error);
  return (
    <div className="stack">
      <div
        className={`drop ${over ? 'over' : ''}`}
        onDragEnter={() => setOver(true)}
        onDragLeave={() => setOver(false)}
        onDrop={() => setOver(false)}
      >
        <FileUp size={30} strokeWidth={1.6} />
        <div className="strong" style={{ color: 'var(--text)' }}>{t('transfer.choose.drop')}</div>
        <div>{t('transfer.choose.or')}</div>
        <Button variant="primary" icon={FolderOpen} onClick={pick} data-testid="choose-bundle">{t('transfer.choose.pick')}</Button>
        <div className="muted small">{t('transfer.choose.hint')}</div>
      </div>
      <Card>
        <div className="card-head">
          <Inbox size={16} />
          <div className="card-title">{t('transfer.choose.found')}</div>
          <div className="card-sub">{t('transfer.choose.foundSub')}</div>
        </div>
        {!lib ? <Loading /> : foreign.length ? (
          <div className="rows">
            {foreign.map((b) => (
              <div key={b.path} className="row clickable" onClick={() => onPick(b.path)}>
                <div className="row-icon amber"><Package size={16} /></div>
                <div className="row-main">
                  <div className="row-flex">
                    <span className="row-title">{b.device.name}</span>
                    <Badge>{b.device.platformName}</Badge>
                    {b.imported ? <Badge tone="green">{t('common.imported')}</Badge> : <Badge tone="amber">{t('common.new')}</Badge>}
                  </div>
                  <div className="row-sub">{fmtDate(b.createdAt)} · {contents(b.stats)}</div>
                  <div className="row-sub"><Path>{b.path}</Path></div>
                </div>
                <ArrowRight size={16} className="muted" />
              </div>
            ))}
          </div>
        ) : (
          <div className="card-pad muted">{t('transfer.choose.none')}</div>
        )}
      </Card>
    </div>
  );
}

// ---- Step 1: what is in the bundle, how to apply it -----------------------------------------
function BundleStep({ bundle, mode, setMode, onNext, onBack, busy }) {
  const own = bundle.isMine;
  return (
    <div className="stack">
      <Card>
        <div className="card-head">
          <Package size={16} />
          <div className="card-title">{own ? label('kind', bundle.kind) || t('common.bundle') : t('transfer.bundle.from', { device: bundle.device.name })}</div>
          <div className="spacer" />
          <Badge tone="green"><ShieldCheck size={12} /> {t('transfer.bundle.verified')}</Badge>
        </div>
        <div className="card-pad">
          <dl className="kv">
            <dt>{t('common.file')}</dt>
            <dd><PathLink path={bundle.path} /></dd>
            <dt>{t('common.createdBy')}</dt>
            <dd>{bundle.device.name} · {bundle.device.platformName}{own ? ` (${t('common.thisDevice')})` : ''}</dd>
            <dt>{t('transfer.bundle.created')}</dt>
            <dd>{fmtDate(bundle.createdAt)} ({fmtRelative(bundle.createdAt)})</dd>
            <dt>{t('common.contents')}</dt>
            <dd>{contents(bundle.stats)} · {fmtBytes(bundle.stats.bytes)}</dd>
            {bundle.chats ? (<><dt>{t('common.chats')}</dt><dd>{t('transfer.export.chatsCount', { count: bundle.chats.count, size: fmtBytes(bundle.chats.bytes) })}</dd></>) : null}
            {bundle.imported ? (<><dt>{t('common.status')}</dt><dd>{t('transfer.bundle.imported')}</dd></>) : null}
          </dl>
        </div>
        <div className="rows" style={{ borderTop: '1px solid var(--border)' }}>
          {bundle.locations.map((l) => {
            const Icon = TYPE_ICON[l.type] || Package;
            return (
              <div key={l.id} className="row" style={{ padding: '8px 18px' }}>
                <Icon size={15} style={{ color: 'var(--text-3)', flex: 'none' }} />
                <div className="row-main">
                  <div className="row-title" style={{ fontWeight: 540 }}>{l.name || l.key}</div>
                  <div className="row-sub" title={l.path || ''}>{l.path ? t('common.source', { path: tildify(l.path) }) : label('type', l.type)}</div>
                </div>
                <span className="muted small">{count('files', l.files)}</span>
              </div>
            );
          })}
        </div>
      </Card>

      <div className="grid cols-2">
        <button type="button" className={`choice-card ${mode === 'sync' ? 'on' : ''}`} onClick={() => setMode('sync')} data-testid="mode-sync">
          <input type="radio" readOnly checked={mode === 'sync'} />
          <div>
            <div className="strong row-flex"><Merge size={15} /> {t('transfer.bundle.sync')} {own ? null : <Badge tone="accent">{t('transfer.bundle.recommended')}</Badge>}</div>
            <div className="muted small" style={{ marginTop: 4 }}>{t('transfer.bundle.syncDesc')}</div>
          </div>
        </button>
        <button type="button" className={`choice-card ${mode === 'restore' ? 'on' : ''}`} onClick={() => setMode('restore')} data-testid="mode-restore">
          <input type="radio" readOnly checked={mode === 'restore'} />
          <div>
            <div className="strong row-flex"><RotateCcw size={15} /> {t('transfer.bundle.restore')} {own ? <Badge tone="accent">{t('transfer.bundle.restoreBadge')}</Badge> : null}</div>
            <div className="muted small" style={{ marginTop: 4 }}>{t('transfer.bundle.restoreDesc')}</div>
          </div>
        </button>
      </div>

      <div className="sticky-foot">
        <Button icon={ArrowLeft} onClick={onBack}>{t('transfer.otherBundle')}</Button>
        <div className="spacer" />
        <Button variant="primary" onClick={onNext} disabled={!mode || busy} data-testid="next">
          {busy ? t('transfer.preparing') : t('common.continue')} <ArrowRight size={16} />
        </Button>
      </div>
    </div>
  );
}

// ---- Step 2: where each part goes on this device -------------------------------------------
function MatchEditor({ m, onSet, onClose }) {
  const [projects, setProjects] = useState(null);
  const name = m.remote.name || m.remote.key;
  useEffect(() => {
    if (m.type === 'project') api.projects().then((d) => setProjects(d.projects));
  }, [m.type]);
  const chooseFolder = async () => {
    const p = await shell.chooseFolder({ title: m.type === 'project' ? t('transfer.match.projectFolder', { name }) : t('transfer.match.workspaceFolder') });
    if (p) onSet({ action: m.type === 'project' ? 'create' : 'map', path: p, include: true });
  };
  return (
    <Modal title={t('transfer.match.where', { name })} onClose={onClose}
      footer={<>
        <Button onClick={() => onSet({ action: 'skip', include: false })}>{t('transfer.match.skip')}</Button>
        <div className="spacer" />
        <Button icon={FolderOpen} onClick={chooseFolder}>{t('transfer.match.chooseFolder')}</Button>
      </>}>
      <p style={{ marginTop: 0 }} className="muted">
        {m.type === 'project' ? t('transfer.match.projectHint') : t('transfer.match.workspaceHint')}
      </p>
      {m.type === 'project' ? (
        !projects ? <Loading /> : (
          <Card>
            <div className="rows">
              {projects.map((p) => (
                <div key={p.id} className="row clickable" onClick={() => onSet({ action: 'map', projectId: p.id, include: true })}>
                  <Brain size={15} style={{ color: 'var(--text-3)', flex: 'none' }} />
                  <div className="row-main">
                    <div className="row-title">{p.name}</div>
                    <div className="row-sub">{tildify(p.cwd || p.dir)}</div>
                  </div>
                  <span className="muted small">{count('files', p.fileCount)}</span>
                  {m.local && m.local.id === p.id ? <Badge tone="accent">{t('transfer.match.current')}</Badge> : null}
                </div>
              ))}
            </div>
          </Card>
        )
      ) : null}
    </Modal>
  );
}

function MatchRow({ m, files, onSet, onEdit }) {
  const Icon = TYPE_ICON[m.type] || Package;
  const how = label('how', m.how);
  return (
    <div className="row" style={{ alignItems: 'flex-start', padding: '13px 18px' }}>
      <input type="checkbox" style={{ marginTop: 9 }} checked={m.include} disabled={!m.local} onChange={(e) => onSet({ include: e.target.checked })} aria-label={t('transfer.match.include')} />
      <div className="match-side">
        <div className="row-flex">
          <Icon size={15} style={{ color: 'var(--text-3)' }} />
          <span className="row-title">{m.remote.name || m.remote.key}</span>
          <span className="muted small">{count('files', files)}</span>
        </div>
        <div className="row-sub" title={m.remote.path || ''}>{m.remote.path ? t('common.source', { path: tildify(m.remote.path) }) : label('type', m.type)}</div>
        {m.remote.gitRemote ? <div className="row-sub"><GitBranch size={11} /> {m.remote.gitRemote}</div> : null}
      </div>
      <ArrowRight size={16} className="match-arrow" style={{ marginTop: 9 }} />
      <div className="match-side">
        {m.local && m.status !== 'skipped' ? (
          <>
            <div className="row-flex">
              <span className="row-title">{m.local.name || m.local.key}</span>
              {m.status === 'create' ? <Badge tone="accent">{t('transfer.match.create')}</Badge> : null}
              {how ? <Badge tone={HOW_TONE[m.how]}>{how}</Badge> : null}
            </div>
            {m.type === 'project' ? (
              <>
                <div className="row-sub" title={m.local.path || ''}>{t('transfer.match.project', { path: m.local.path ? tildify(m.local.path) : '-' })}</div>
                <div className="row-sub" title={m.local.root}>{t('transfer.match.memory', { path: tildify(m.local.root) })}</div>
              </>
            ) : (
              <div className="row-sub" title={m.local.root}>{tildify(m.local.root)}</div>
            )}
            {m.warnings.map((w) => <div key={w} className="small" style={{ color: 'var(--amber)' }}>{label('matchWarning', w) || w}</div>)}
          </>
        ) : m.status === 'skipped' ? (
          <div className="muted" style={{ paddingTop: 2 }}>{t('transfer.match.skipped')}</div>
        ) : (
          <>
            <div className="strong" style={{ color: 'var(--red)' }}>{t('transfer.match.missing')}</div>
            {m.remote.gitRemote ? (
              <div className="small" style={{ marginTop: 2 }}>{t('transfer.match.clone', { command: <span className="code">git clone {m.remote.gitRemote}</span> })}</div>
            ) : (
              <div className="small muted" style={{ marginTop: 2 }}>
                {m.type === 'workspaceRoot' ? t('transfer.match.missingWorkspace') : t('transfer.match.missingProject')}
              </div>
            )}
          </>
        )}
      </div>
      {m.type !== 'claude' ? <Button size="sm" onClick={onEdit}>{t('common.change')}</Button> : null}
    </div>
  );
}

function MatchStep({ plan, setOverride, onNext, onBack, busy }) {
  const [editing, setEditing] = useState(null);
  const files = Object.fromEntries(plan.bundle.locations.map((l) => [l.id, l.files]));
  const included = plan.matches.filter((m) => m.include).length;
  const missing = plan.matches.filter((m) => !m.include).length;
  return (
    <div className="stack">
      <Banner tone="info" icon={Info}>{t('transfer.match.intro')}</Banner>
      <Card>
        <div className="table-head">
          <div style={{ width: 15 }} />
          <div style={{ flex: 1 }}>{t('transfer.match.inBundle')}</div>
          <div style={{ width: 16 }} />
          <div style={{ flex: 1 }}>{t('transfer.match.onDevice')}</div>
          <div style={{ width: 76 }} />
        </div>
        <div className="rows">
          {plan.matches.map((m) => (
            <MatchRow key={m.id} m={m} files={files[m.id] || 0} onSet={(ov) => setOverride(m.id, ov)} onEdit={() => setEditing(m)} />
          ))}
        </div>
      </Card>
      <div className="sticky-foot">
        <Button icon={ArrowLeft} onClick={onBack}>{t('common.back')}</Button>
        <div className="muted small">{t('transfer.match.summary', { count: included })}{missing ? `, ${t('transfer.match.summarySkipped', { count: missing })}` : ''}</div>
        <div className="spacer" />
        <Button variant="primary" onClick={onNext} disabled={!included || busy} data-testid="next">
          {t('transfer.match.next')} <ArrowRight size={16} />
        </Button>
      </div>
      {editing ? <MatchEditor m={editing} onClose={() => setEditing(null)} onSet={(ov) => { setEditing(null); setOverride(editing.id, ov); }} /> : null}
    </div>
  );
}

// ---- Step 3: every file that changes ------------------------------------------------------------
// Choices for each kind of conflict: [value sent to the engine, text in transfer.conflict].
const CONFLICT_OPTIONS = {
  conflict: [['l', 'local'], ['r', 'remote'], ['b', 'both'], ['skip', 'skip']],
  'conflict-remote-deleted': [['l', 'keep'], ['d', 'delete'], ['skip', 'skip']],
  'conflict-local-deleted': [['r', 'bringBack'], ['d', 'stayDeleted'], ['skip', 'skip']],
};
const SAFE_CHOICE = { conflict: 'b', 'conflict-remote-deleted': 'l', 'conflict-local-deleted': 'r' };
const conflictOptions = (action) => CONFLICT_OPTIONS[action].map(([value, k]) => ({ value, label: t(`transfer.conflict.${k}`), title: t(`transfer.conflict.${k}Title`) }));

function DiffModal({ plan, item, decisions, deviceName, onClose }) {
  const [d, setD] = useState(null);
  const [err, setErr] = useState(null);
  useEffect(() => {
    api.itemDiff(plan.id, item.key, decisions).then(setD).catch(setErr);
  }, [plan.id, item.key, decisions]);
  const remoteName = plan.bundle.device.name;
  const group = groupMeta(plan.mode, item.group);
  let body;
  if (err) body = <Banner tone="error">{errorText(err)}</Banner>;
  else if (!d) body = <Loading />;
  else if (d.binary) body = <div className="muted">{t('transfer.diff.binary')}</div>;
  else if (d.isIndex) body = <DiffView lines={d.lines} minusLabel={t('transfer.diff.local', { device: deviceName })} plusLabel={t('transfer.diff.merged')} />;
  else if (d.local == null) body = (<><div className="section-label">{t('transfer.diff.remoteVersion', { device: remoteName })}</div><pre className="preview">{d.remote}</pre></>);
  else if (d.remote == null) body = (<><div className="section-label">{t('transfer.diff.localVersion', { device: deviceName })}</div><pre className="preview">{d.local}</pre></>);
  else body = <DiffView lines={d.lines} minusLabel={t('transfer.diff.onlyLocal', { device: deviceName })} plusLabel={t('transfer.diff.onlyRemote', { device: remoteName })} />;
  return (
    <Modal title={`${item.scopeLabel} / ${item.rel}`} onClose={onClose} wide>
      <div className="muted small" style={{ marginBottom: 10 }}>
        {label('action', item.action) || (group ? group.desc : '')} · <Path>{item.path}</Path>
      </div>
      {body}
    </Modal>
  );
}

function ReviewRow({ it, mode, choice, onChoice, onDiff, indexInfo }) {
  const takeSkip = it.choices.includes('take');
  const sizes = [it.local ? t('transfer.review.sizeLocal', { size: fmtBytes(it.local.size) }) : null, it.remote ? t('transfer.review.sizeRemote', { size: fmtBytes(it.remote.size) }) : null].filter(Boolean).join(' → ');
  const action = label('action', it.action);
  let sub = action && mode === 'sync' ? `${action} · ${sizes}` : sizes;
  if (it.isIndex && indexInfo) {
    const st = indexInfo.stats;
    const lines = st && indexInfo.display === 'merge'
      ? [t('transfer.review.linesAdded', { count: st.added }), t('transfer.review.linesChanged', { count: st.changed }), t('transfer.review.linesRemoved', { count: st.removed }), st.copies ? t('transfer.review.copyLines', { count: st.copies }) : null].filter(Boolean).join(', ')
      : '';
    sub = indexInfo.skipped ? t('transfer.review.untouched') : `${label('indexAction', indexInfo.display) || indexInfo.display}${lines ? ` · ${lines}` : ''}`;
  }
  return (
    <div className="row" style={{ padding: '9px 18px' }}>
      {takeSkip ? (
        <input type="checkbox" checked={choice === 'take'} onChange={(e) => onChoice(e.target.checked ? 'take' : 'skip')} aria-label={t('transfer.review.applyLabel', { name: it.rel })} />
      ) : it.choices.length ? null : <span style={{ width: 15 }} />}
      <div className="row-main">
        <div className="row-title" style={{ fontWeight: 540 }}>
          <span className="muted" style={{ fontWeight: 400 }}>{it.scopeLabel} / </span>{it.rel}
        </div>
        <div className="row-sub">{sub}</div>
      </div>
      {CONFLICT_OPTIONS[it.action] && mode === 'sync' ? (
        <Segmented value={choice || null} options={conflictOptions(it.action)} onChange={onChoice} />
      ) : null}
      <Button size="sm" variant="ghost" icon={FileDiff} onClick={onDiff}>{t('common.diff')}</Button>
    </div>
  );
}

const dirOf = (p) => p.slice(0, Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\')));

function repoBadge(it) {
  if (!it.repos) return null;
  if (it.repoStatus === 'all') return [t('transfer.ws.reposAll'), 'green'];
  if (it.repoStatus === 'some') return [t('transfer.ws.reposSome', { found: it.repos.filter((r) => r.found).length, total: it.repos.length }), 'amber'];
  return [t('transfer.ws.reposNone'), 'red'];
}

function WorkspaceRow({ it, mode, choice, onChoice, onDiff }) {
  const takeSkip = it.choices.includes('take');
  const badge = repoBadge(it);
  return (
    <div className="row" style={{ alignItems: 'flex-start', padding: '11px 18px' }}>
      {takeSkip ? (
        <input type="checkbox" style={{ marginTop: 3 }} checked={choice === 'take'} onChange={(e) => onChoice(e.target.checked ? 'take' : 'skip')} aria-label={t('transfer.ws.importLabel', { name: it.rel })} />
      ) : <span style={{ width: 15, flex: 'none' }} />}
      <div className="row-main">
        <div className="row-flex">
          <span className="row-title">{it.rel.split('/').pop().replace(/\.code-workspace$/, '')}</span>
          {badge ? <Badge tone={badge[1]}>{badge[0]}</Badge> : null}
          <span className="muted small">{label(`transfer.ws.${mode}`, it.group) || label('action', it.action) || ''}</span>
        </div>
        {it.repos ? (
          <div className="repo-list">
            {it.repos.map((r) => (
              <div key={r.path} className="repo" title={r.local || r.path}>
                {r.found ? <Check size={13} className="repo-ok" /> : <X size={13} className="repo-missing" />}
                <span className="repo-name">{r.name}</span>
                <span className="muted">{r.found ? tildify(r.local) : t('transfer.ws.repoMissing', { path: tildify(r.local || r.path) })}</span>
              </div>
            ))}
          </div>
        ) : <div className="row-sub">{t('transfer.ws.foldersUnreadable')}</div>}
      </div>
      {CONFLICT_OPTIONS[it.action] && mode === 'sync' ? <Segmented value={choice || null} options={conflictOptions(it.action)} onChange={onChoice} /> : null}
      <Button size="sm" variant="ghost" icon={FileDiff} onClick={onDiff}>{t('common.diff')}</Button>
    </div>
  );
}

// Chats of the bundle, with what happens to each; none here is overwritten with something shorter.
const CHAT_TONE = { new: 'green', updated: 'blue', diverged: 'amber', same: '', 'local-newer': '' };

function ChatReview({ chats, decisions, setDecisions }) {
  const choiceOf = (c) => (decisions.chats[c.id] !== undefined ? decisions.chats[c.id] : c.defaultChoice);
  const set = (id, v) => setDecisions((d) => ({ ...d, chats: { ...d.chats, [id]: v } }));
  const takes = chats.filter((c) => c.choices.length);
  const setAll = (v) => setDecisions((d) => ({ ...d, chats: { ...d.chats, ...Object.fromEntries(takes.map((c) => [c.id, v])) } }));
  return (
    <>
      <Banner tone="info" icon={Info}>{t('transfer.review.chatsIntro')}</Banner>
      <Card className="mt" data-group="chats">
        <div className="group-head">
          <MessagesSquare size={16} style={{ color: 'var(--text-3)', flex: 'none' }} />
          <div className="group-title">{count('chats', chats.length)}</div>
          <div className="spacer" />
          {takes.length ? (
            <>
              <Button size="sm" variant="ghost" onClick={() => setAll('take')}>{t('common.selectAll')}</Button>
              <Button size="sm" variant="ghost" onClick={() => setAll('skip')}>{t('common.selectNone')}</Button>
            </>
          ) : null}
        </div>
        <div className="rows">
          {chats.map((c) => (
            <div key={c.id} className="row" style={{ padding: '10px 18px' }}>
              {c.choices.length ? (
                <input type="checkbox" checked={choiceOf(c) === 'take'} onChange={(e) => set(c.id, e.target.checked ? 'take' : 'skip')} aria-label={t('transfer.review.applyLabel', { name: c.title || c.id })} />
              ) : <span style={{ width: 15, flex: 'none' }} />}
              <div className="row-main">
                <div className="row-flex">
                  <span className="row-title">{c.title || t('transfer.export.untitled')}</span>
                  <Badge tone={CHAT_TONE[c.status]}>{label('chatStatus', c.status)}</Badge>
                </div>
                <div className="row-sub">{[c.label, label('entrypoint', c.entrypoint), fmtBytes(c.size), c.mtime ? fmtRelative(c.mtime) : null].filter(Boolean).join(' · ')}</div>
              </div>
            </div>
          ))}
        </div>
      </Card>
    </>
  );
}

// Workspace files one by one, with the repositories each opens: the ones whose repositories are all here come selected.
function WorkspaceReview({ plan, items, choiceOf, setChoice, setMany, onDiff }) {
  const changed = items.filter((i) => i.group !== 'same' && i.group !== 'kept');
  const selectable = changed.filter((i) => i.choices.includes('take'));
  const same = items.filter((i) => i.group === 'same').length;
  const kept = items.filter((i) => i.group === 'kept').length;
  const dests = [...new Set(items.map((i) => dirOf(i.path)))];
  return (
    <>
      <Banner tone="info" icon={Info}>{t('transfer.ws.intro')}</Banner>
      <Card className="mt" data-group="workspaces">
        <div className="group-head">
          <FolderTree size={16} style={{ color: 'var(--text-3)', flex: 'none' }} />
          <div style={{ minWidth: 0 }}>
            <div className="group-title">{t('transfer.ws.dest')}</div>
            {dests.map((d) => <div key={d} className="group-desc"><Path>{d}</Path></div>)}
          </div>
          <div className="spacer" />
          {selectable.length ? (
            <>
              <Button size="sm" variant="ghost" onClick={() => setMany(selectable, (it) => (!it.repos || it.repoStatus === 'all' ? 'take' : 'skip'))}>{t('transfer.ws.selectFound')}</Button>
              <Button size="sm" variant="ghost" onClick={() => setMany(selectable, 'take')}>{t('common.selectAll')}</Button>
              <Button size="sm" variant="ghost" onClick={() => setMany(selectable, 'skip')}>{t('common.selectNone')}</Button>
            </>
          ) : null}
        </div>
        {changed.length ? (
          <div className="rows">
            {changed.map((it) => (
              <WorkspaceRow key={it.key} it={it} mode={plan.mode} choice={choiceOf(it)} onChoice={(c) => setChoice(it.key, c)} onDiff={() => onDiff(it)} />
            ))}
          </div>
        ) : <div className="card-pad muted">{t('transfer.ws.noChanges')}</div>}
        {same || kept ? (
          <div className="card-pad muted small" style={{ borderTop: changed.length ? '1px solid var(--border)' : 0 }}>
            {[same ? t('transfer.ws.same', { count: same }) : null, kept ? t('transfer.ws.kept', { count: kept }) : null].filter(Boolean).join(' · ')}
          </div>
        ) : null}
      </Card>
    </>
  );
}

function ReviewStep({ plan, decisions, setDecisions, resolved, deviceName, onNext, onBack, notice }) {
  const [diff, setDiff] = useState(null);
  const [showKept, setShowKept] = useState(false);
  const [lineRows, setLineRows] = useState({});
  const order = plan.mode === 'restore' ? RESTORE_ORDER : GROUP_ORDER;

  useEffect(() => {
    if (!resolved) return;
    const lines = resolved.pending.filter((p) => p.type === 'line');
    if (lines.length) setLineRows((cur) => ({ ...Object.fromEntries(lines.map((p) => [p.id, p])), ...cur }));
  }, [resolved]);

  const choiceOf = (it) => (decisions.items[it.key] !== undefined ? decisions.items[it.key] : it.defaultChoice);
  const setChoice = (key, c) => setDecisions((d) => ({ ...d, items: { ...d.items, [key]: c } }));
  const setMany = (items, c) => setDecisions((d) => ({ ...d, items: { ...d.items, ...Object.fromEntries(items.map((it) => [it.key, typeof c === 'function' ? c(it) : c])) } }));
  const setLine = (id, side) => setDecisions((d) => ({ ...d, lines: { ...d.lines, [id]: side } }));
  const indexInfo = new Map((resolved ? resolved.index : []).map((x) => [x.key, x]));
  const scopeLabel = Object.fromEntries(plan.scopes.map((s) => [s.id, s.label]));
  // Workspace files have their own tab; everything else stays on the first one.
  const wsItems = plan.items.filter((i) => i.scopeType === 'workspaceRoot');
  const memItems = wsItems.length ? plan.items.filter((i) => i.scopeType !== 'workspaceRoot') : plan.items;
  const changing = (list) => list.filter((i) => i.group !== 'same' && i.group !== 'kept').length;
  const chats = plan.chats || [];
  const takingChats = chats.filter((c) => c.choices.length).length;
  const [tab, setTab] = useState(() => (changing(memItems) ? 'memory' : wsItems.length && changing(wsItems) ? 'workspaces' : takingChats ? 'chats' : wsItems.length ? 'workspaces' : 'memory'));

  const counts = {};
  for (const i of memItems) counts[i.group] = (counts[i.group] || 0) + 1;
  const pending = resolved ? resolved.pending.length : 0;
  const nothing = order.every((g) => !memItems.some((i) => i.group === g && g !== 'kept'));
  const strong = (n) => <span className="strong">{n.toLocaleString(language())}</span>;

  return (
    <div>
      {notice ? <Banner tone="warn" icon={TriangleAlert}>{notice}</Banner> : null}
      {plan.errors.length ? (
        <Banner tone="error" icon={TriangleAlert}>
          <div className="strong">{t('transfer.review.blocked')}</div>
          {plan.errors.map((e, i) => <div key={i}>{label('blocking', e.code, e) || e.code}</div>)}
        </Banner>
      ) : null}
      {wsItems.length || chats.length ? (
        <div className="tabs">
          <button type="button" className={`tab ${tab === 'memory' ? 'on' : ''}`} onClick={() => setTab('memory')} data-testid="tab-memory">
            <Brain size={15} /> {memItems.some((i) => i.scopeType === 'claude') ? t('transfer.review.tabMemorySettings') : t('transfer.review.tabMemory')} <span className="muted small">{changing(memItems)}</span>
          </button>
          {wsItems.length ? (
            <button type="button" className={`tab ${tab === 'workspaces' ? 'on' : ''}`} onClick={() => setTab('workspaces')} data-testid="tab-workspaces">
              <FolderTree size={15} /> {t('nav.workspaces')} <span className="muted small">{changing(wsItems)}</span>
            </button>
          ) : null}
          {chats.length ? (
            <button type="button" className={`tab ${tab === 'chats' ? 'on' : ''}`} onClick={() => setTab('chats')} data-testid="tab-chats">
              <MessagesSquare size={15} /> {t('common.chats')} <span className="muted small">{takingChats}</span>
            </button>
          ) : null}
        </div>
      ) : null}

      {tab === 'chats' ? (
        <ChatReview chats={chats} decisions={decisions} setDecisions={setDecisions} />
      ) : tab === 'workspaces' ? (
        <WorkspaceReview plan={plan} items={wsItems} choiceOf={choiceOf} setChoice={setChoice} setMany={setMany} onDiff={setDiff} />
      ) : (
        <>
          <div className="chips">
            {order.filter((g) => counts[g]).map((g) => {
              const meta = groupMeta(plan.mode, g);
              return <span key={g} className="chip"><span className={`dot-i ${meta.tone}`} />{meta.label}<b>{counts[g]}</b></span>;
            })}
            <span className="chip"><span className="dot-i gray" />{t('transfer.review.same')}<b>{counts.same || 0}</b></span>
          </div>

          {nothing ? (
            <Banner tone="ok" icon={CircleCheck}>{wsItems.length || chats.length ? t('transfer.review.noMemoryChanges') : t('transfer.review.identical')}</Banner>
          ) : null}

          {order.map((g) => {
            const items = memItems.filter((i) => i.group === g);
            if (!items.length) return null;
            const meta = groupMeta(plan.mode, g);
            const collapsed = g === 'kept' && !showKept;
            const takeSkip = items.some((i) => i.choices.includes('take'));
            return (
              <Card key={g} className="mt" data-group={g}>
                <div className="group-head">
                  <Badge tone={meta.tone}>{items.length}</Badge>
                  <div style={{ minWidth: 0 }}>
                    <div className="group-title">{meta.label}</div>
                    <div className="group-desc">{meta.desc}</div>
                  </div>
                  <div className="spacer" />
                  {takeSkip ? (
                    <>
                      <Button size="sm" variant="ghost" onClick={() => setMany(items, 'take')}>{t('common.selectAll')}</Button>
                      <Button size="sm" variant="ghost" onClick={() => setMany(items, 'skip')}>{t('common.selectNone')}</Button>
                    </>
                  ) : null}
                  {g === 'conflict' && plan.mode === 'sync' ? (
                    <Button size="sm" onClick={() => setMany(items, (it) => SAFE_CHOICE[it.action])} title={t('transfer.review.keepAllTitle')} data-testid="keep-all">
                      {t('transfer.review.keepAll')}
                    </Button>
                  ) : null}
                  {g === 'kept' ? <Button size="sm" variant="ghost" onClick={() => setShowKept((v) => !v)}>{showKept ? t('common.hide') : t('common.show')}</Button> : null}
                </div>
                {collapsed ? null : (
                  <div className="rows">
                    {items.map((it) => (
                      <ReviewRow key={it.key} it={it} mode={plan.mode} choice={choiceOf(it)} onChoice={(c) => setChoice(it.key, c)} onDiff={() => setDiff(it)} indexInfo={indexInfo.get(it.key)} />
                    ))}
                  </div>
                )}
              </Card>
            );
          })}

          {Object.keys(lineRows).length ? (
            <Card className="mt">
              <div className="group-head">
                <Badge tone="amber">{Object.keys(lineRows).length}</Badge>
                <div>
                  <div className="group-title">{t('transfer.review.lineTitle')}</div>
                  <div className="group-desc">{t('transfer.review.lineDesc')}</div>
                </div>
              </div>
              <div className="rows">
                {Object.values(lineRows).map((p) => (
                  <div key={p.id} className="row" style={{ alignItems: 'flex-start' }}>
                    <div className="row-main">
                      <div className="row-title">{scopeLabel[p.scope]} / {p.target}</div>
                      <label className="row-flex small" style={{ marginTop: 6, cursor: 'pointer' }}>
                        <input type="radio" name={p.id} checked={decisions.lines[p.id] === 'local'} onChange={() => setLine(p.id, 'local')} />
                        <span className="muted" style={{ width: 92, flex: 'none' }}>{t('transfer.conflict.local')}</span> <span className="code">{p.local}</span>
                      </label>
                      <label className="row-flex small" style={{ marginTop: 6, cursor: 'pointer' }}>
                        <input type="radio" name={p.id} checked={decisions.lines[p.id] === 'remote'} onChange={() => setLine(p.id, 'remote')} />
                        <span className="muted" style={{ width: 92, flex: 'none' }}>{t('transfer.conflict.remote')}</span> <span className="code">{p.remote}</span>
                      </label>
                    </div>
                  </div>
                ))}
              </div>
            </Card>
          ) : null}
        </>
      )}

      <div className="sticky-foot">
        <Button icon={ArrowLeft} onClick={onBack}>{t('common.back')}</Button>
        {resolved ? (
          <div className="small">
            {t('transfer.review.writes', { count: resolved.writes, n: strong(resolved.writes) })} · {t('transfer.review.deletes', { count: resolved.deletes, n: strong(resolved.deletes) })}
            {resolved.copies ? <> · {t('transfer.review.copies', { count: resolved.copies, n: strong(resolved.copies) })}</> : null}
            {resolved.chats ? <> · {t('transfer.review.chats', { count: resolved.chats })}</> : null}
            {pending ? <span style={{ color: 'var(--amber)', marginLeft: 10 }} className="strong">{t('transfer.review.pending', { count: pending })}</span> : null}
          </div>
        ) : <span className="muted small">{t('common.calculating')}</span>}
        <div className="spacer" />
        <Button variant="primary" onClick={onNext} disabled={!resolved || pending > 0 || plan.errors.length > 0} data-testid="next">
          {t('common.continue')} <ArrowRight size={16} />
        </Button>
      </div>
      {diff ? <DiffModal plan={plan} item={diff} decisions={decisions} deviceName={deviceName} onClose={() => setDiff(null)} /> : null}
    </div>
  );
}

// ---- Step 4: last look, then apply ---------------------------------------------------------
function ConfirmStep({ plan, resolved, onApply, onBack, busy, error }) {
  const byScope = new Map();
  for (const op of resolved.ops) {
    if (!byScope.has(op.scope)) byScope.set(op.scope, []);
    byScope.get(op.scope).push(op);
  }
  const scopes = plan.scopes.filter((s) => byScope.has(s.id));
  const nothing = !resolved.ops.length && !resolved.chats;
  return (
    <div className="stack">
      {error ? <Banner tone="error" icon={TriangleAlert}>{error}</Banner> : null}
      {nothing ? <Banner tone="ok" icon={CircleCheck}>{t('transfer.confirm.nothing')}</Banner> : null}
      {resolved.chats ? (
        <Card className="card-pad">
          <div className="row-flex strong"><MessagesSquare size={16} /> {t('transfer.confirm.chats', { count: resolved.chats })}</div>
          <div className="muted small" style={{ marginTop: 4 }}>{t('transfer.confirm.chatsNote')}</div>
        </Card>
      ) : null}
      {!resolved.ops.length ? null : (
        <Card>
          <div className="card-head">
            <div className="card-title">{t('transfer.review.writes', { count: resolved.writes, n: resolved.writes })}, {t('transfer.review.deletes', { count: resolved.deletes, n: resolved.deletes })}</div>
          </div>
          <div className="card-pad stack" style={{ gap: 12 }}>
            {scopes.map((s) => (
              <div key={s.id}>
                <div className="row-flex">
                  <span className="strong">{s.label}</span>
                  {s.create ? <Badge tone="accent">{t('transfer.match.create')}</Badge> : null}
                </div>
                <div className="small"><Path>{s.root}</Path></div>
                <div className="op-list" style={{ marginTop: 4 }}>
                  {byScope.get(s.id).map((op) => (
                    <div key={op.key + op.type} className="op">
                      <Badge tone={op.type === 'write' ? 'green' : 'red'}>{op.type === 'write' ? t('transfer.confirm.write') : t('transfer.confirm.delete')}</Badge>
                      <span>{op.rel}</span>
                      {op.reason === 'copy' ? <span className="muted small">{t('transfer.confirm.copy')}</span> : null}
                      {op.reason === 'index' ? <span className="muted small">{t('transfer.confirm.index')}</span> : null}
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}
      {nothing ? null : (
        <Card className="card-pad">
          <div className="row-flex strong" style={{ marginBottom: 8 }}><ShieldCheck size={16} style={{ color: 'var(--green)' }} /> {t('transfer.confirm.safeTitle')}</div>
          <div className="small stack" style={{ gap: 6 }}>
            <div>{t('transfer.confirm.safe1', { path: <Path>{plan.backupDir}</Path> })}</div>
            <div>{t('transfer.confirm.safe2')}</div>
            <div>{t('transfer.confirm.safe3')}</div>
          </div>
          <Banner tone="warn" icon={TriangleAlert}>{t('transfer.confirm.closeSessions')}</Banner>
        </Card>
      )}
      <div className="sticky-foot">
        <Button icon={ArrowLeft} onClick={onBack} disabled={busy}>{t('common.back')}</Button>
        <div className="spacer" />
        <Button variant="primary" size="lg" onClick={onApply} disabled={busy} data-testid="apply">
          {busy ? t('transfer.confirm.applying') : nothing ? t('transfer.confirm.finish') : plan.mode === 'restore' ? t('transfer.confirm.restore') : t('transfer.confirm.apply')}
        </Button>
      </div>
    </div>
  );
}

// ---- Step 5 ---------------------------------------------------------------------------------
function ResultStep({ result, plan, onUndone }) {
  const { go } = useApp();
  const [undo, setUndo] = useState(false);
  return (
    <Card className="card-pad">
      <div className="row-flex" style={{ gap: 16, alignItems: 'flex-start' }}>
        <div className="big-ok"><CircleCheck size={28} /></div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 18, fontWeight: 680 }}>{result.nothing ? t('transfer.result.nothingTitle') : plan.mode === 'restore' ? t('transfer.result.restored') : t('transfer.result.done')}</div>
          <div className="muted" style={{ marginTop: 4 }}>
            {result.nothing ? t('transfer.result.nothing') : t('transfer.result.summary', { changes: `${count('written', result.writes)}, ${count('deleted', result.deletes)}` })}
            {result.chats ? ` ${t('transfer.result.chats', { count: result.chats })}` : ''}
          </div>
          {result.copies ? (
            <Banner tone="info" icon={Info}>{t('transfer.result.copies', { count: result.copies, device: plan.bundle.device.name.toLowerCase() })}</Banner>
          ) : null}
          {result.backupPath ? (
            <dl className="kv mt">
              <dt>{label('kind', 'before')}</dt>
              <dd><PathLink path={result.backupPath} /></dd>
            </dl>
          ) : null}
          <div className="row-flex mt" style={{ flexWrap: 'wrap' }}>
            {result.backupPath ? <Button icon={Undo2} onClick={() => setUndo(true)} data-testid="undo">{t('common.undo')}</Button> : null}
            {plan.mode === 'sync' && !plan.bundle.isMine ? (
              <Button icon={PackagePlus} onClick={() => go('transfer', { tab: 'export' })}>{t('transfer.result.exportBack')}</Button>
            ) : null}
            <Button variant="primary" onClick={() => go('home')}>{t('transfer.result.close')}</Button>
          </div>
        </div>
      </div>
      {undo ? <UndoModal activityId={result.activityId} onClose={() => setUndo(false)} onDone={() => { setUndo(false); onUndone(); }} /> : null}
    </Card>
  );
}

// ---- A full backup: everything back where it was, with the app's own data ---------------------
function FullRestore({ bundle, onBack }) {
  const { go, refresh, changeLanguage } = useApp();
  const [plan, setPlan] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  useEffect(() => {
    api.prepareFullRestore(bundle.path).then(setPlan).catch(setError);
  }, [bundle.path]);
  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      setResult(await api.applyFullRestore(plan.id));
      refresh();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  // The restored settings may bring another interface language.
  const finish = async () => {
    const info = await shell.appInfo();
    changeLanguage(info.language);
    go('home');
  };
  const changes = (g) => [g.new ? t('transfer.full.new', { count: g.new }) : null, g.replace ? t('transfer.full.replace', { count: g.replace }) : null, g.same ? t('transfer.full.same', { count: g.same }) : null].filter(Boolean).join(' · ');

  if (result) {
    return (
      <Card className="card-pad">
        <div className="row-flex" style={{ gap: 16, alignItems: 'flex-start' }}>
          <div className="big-ok"><CircleCheck size={28} /></div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 18, fontWeight: 680 }}>{t('transfer.full.done')}</div>
            <div className="muted" style={{ marginTop: 4 }}>{t('transfer.full.doneText', { files: count('written', result.writes), count: result.backups })}</div>
            <dl className="kv mt">
              <dt>{label('kind', 'before')}</dt>
              <dd><PathLink path={result.backupPath} /></dd>
            </dl>
            <div className="row-flex mt"><Button variant="primary" onClick={finish}>{t('transfer.result.close')}</Button></div>
          </div>
        </div>
      </Card>
    );
  }
  if (!plan) {
    if (!error) return <Loading text={t('transfer.preparing')} />;
    return (
      <div className="stack">
        <Banner tone="error" icon={TriangleAlert}>{errorText(error)}</Banner>
        <div><Button icon={ArrowLeft} onClick={onBack}>{t('transfer.otherBundle')}</Button></div>
      </div>
    );
  }
  const b = plan.bundle;
  return (
    <div className="stack">
      <Card>
        <div className="card-head">
          <HardDrive size={16} />
          <div className="card-title">{t('transfer.full.title', { device: b.device.name })}</div>
          <div className="spacer" />
          <Badge tone="green"><ShieldCheck size={12} /> {t('transfer.bundle.verified')}</Badge>
        </div>
        <div className="card-pad">
          <p style={{ marginTop: 0 }}>{t('transfer.full.intro')}</p>
          <dl className="kv">
            <dt>{t('common.file')}</dt>
            <dd><PathLink path={b.path} /></dd>
            <dt>{t('transfer.bundle.created')}</dt>
            <dd>{fmtDate(b.createdAt)} ({fmtRelative(b.createdAt)})</dd>
            <dt>{t('common.createdBy')}</dt>
            <dd>{b.device.name} · {b.device.platformName}{b.isMine ? ` (${t('common.thisDevice')})` : ''}</dd>
            <dt>{t('common.appData')}</dt>
            <dd>{t('backups.full.appData', { count: plan.activity })}</dd>
            <dt>{t('nav.backups')}</dt>
            <dd>{t('transfer.full.backupsLine', { count: plan.backups.add })}</dd>
            {b.chats ? (<><dt>{t('common.chats')}</dt><dd>{t('transfer.full.chatsLine', { count: plan.chats.new + plan.chats.updated + plan.chats.diverged })}</dd></>) : null}
          </dl>
        </div>
        <div className="rows" style={{ borderTop: '1px solid var(--border)' }}>
          {plan.groups.map((g) => {
            const Icon = TYPE_ICON[g.type] || Package;
            return (
              <div key={g.id} className="row" style={{ padding: '8px 18px' }}>
                <Icon size={15} style={{ color: 'var(--text-3)', flex: 'none' }} />
                <div className="row-main">
                  <div className="row-title" style={{ fontWeight: 540 }}>{g.name}</div>
                  <div className="row-sub" title={g.root || ''}>{g.root ? tildify(g.root) : t('transfer.full.noTarget')}</div>
                </div>
                <span className="muted small">{changes(g)}</span>
              </div>
            );
          })}
        </div>
      </Card>
      {plan.remapped ? <Banner tone="info" icon={Info}>{t('transfer.full.remap', { from: plan.homeFrom, to: plan.homeTo })}</Banner> : null}
      {plan.warnings.map((w, i) => <Banner key={i} tone="warn" icon={TriangleAlert}>{label('fullWarning', w.code, w) || w.code}</Banner>)}
      <Banner tone="warn" icon={ShieldCheck}>{t('transfer.full.stateNote')}</Banner>
      {error ? <Banner tone="error" icon={TriangleAlert}>{errorText(error)}</Banner> : null}
      <div className="sticky-foot">
        <Button icon={ArrowLeft} onClick={onBack} disabled={busy}>{t('transfer.otherBundle')}</Button>
        <div className="muted small">{changes(plan.counts)}</div>
        <div className="spacer" />
        <Button variant="primary" size="lg" onClick={run} disabled={busy} data-testid="full-apply">
          {busy ? t('transfer.confirm.applying') : t('transfer.full.apply')}
        </Button>
      </div>
    </div>
  );
}

function ImportWizard({ initialBundle, initialMode }) {
  const { toast, refresh, device, go } = useApp();
  const [bundlePath, setBundlePath] = useState(initialBundle || null);
  const [bundle, setBundle] = useState(null);
  const [step, setStep] = useState(1);
  const [mode, setMode] = useState(initialMode || null);
  const [mappings, setMappings] = useState({});
  const [plan, setPlan] = useState(null);
  const [decisions, setDecisions] = useState({ items: {}, lines: {}, chats: {} });
  const [resolved, setResolved] = useState(null);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [busy, setBusy] = useState(false);
  const seq = useRef(0);

  useEffect(() => {
    if (!bundlePath) return;
    setBundle(null);
    setError(null);
    api.openBundle(bundlePath)
      .then((b) => {
        setBundle(b);
        setMode((m) => m || (b.isMine && b.kind !== 'export' ? 'restore' : 'sync'));
      })
      .catch(setError);
  }, [bundlePath]);

  const prepare = useCallback(async (nextMappings, keepDecisions) => {
    setBusy(true);
    try {
      const p = await api.prepare({ bundlePath, mode, mappings: nextMappings });
      setPlan(p);
      setResolved(null);
      if (!keepDecisions) setDecisions({ items: {}, lines: {}, chats: {} });
      return p;
    } catch (e) {
      toast(errorText(e), 'error');
      return null;
    } finally {
      setBusy(false);
    }
  }, [bundlePath, mode, toast]);

  // Every change of a choice: recompute what will be written (fast, nothing is written).
  useEffect(() => {
    if (!plan || step < 3 || step > 4) return;
    const n = ++seq.current;
    api.resolvePlan(plan.id, decisions).then((r) => n === seq.current && setResolved(r)).catch((e) => toast(errorText(e), 'error'));
  }, [plan, decisions, step, toast]);

  const setOverride = async (id, ov) => {
    // A new target replaces the old override; a checkbox only changes "include".
    const next = { ...mappings, [id]: ov.action ? { ...ov } : { ...(mappings[id] || {}), ...ov } };
    setMappings(next);
    await prepare(next);
  };

  const apply = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api.apply(plan.id, decisions);
      setResult(r);
      setStep(5);
      refresh();
    } catch (e) {
      if (e.code === 'STALE') {
        const p = await prepare(mappings, true);
        if (p) {
          setNotice(t('transfer.staleNotice'));
          setStep(3);
        }
      } else {
        setError(errorText(e));
      }
    } finally {
      setBusy(false);
    }
  };

  if (!bundlePath) return <ChooseBundle onPick={(p) => { setBundlePath(p); setStep(1); }} />;
  if (error && !bundle) {
    return (
      <div className="stack">
        <Banner tone="error" icon={TriangleAlert}>
          <div className="strong">{t('transfer.openFailed')}</div>
          {errorText(error)}
          <div><Path>{bundlePath}</Path></div>
        </Banner>
        <div><Button icon={ArrowLeft} onClick={() => setBundlePath(null)}>{t('transfer.otherBundle')}</Button></div>
      </div>
    );
  }
  if (!bundle) return <Loading text={t('transfer.opening')} />;
  if (bundle.kind === 'full') return <FullRestore bundle={bundle} onBack={() => { setBundlePath(null); setBundle(null); }} />;

  return (
    <div>
      <Steps step={step} />
      {step === 1 ? (
        <BundleStep bundle={bundle} mode={mode} setMode={setMode} busy={busy}
          onBack={() => { setBundlePath(null); setBundle(null); setMode(null); setMappings({}); }}
          onNext={async () => { setMappings({}); if (await prepare({})) setStep(2); }} />
      ) : null}
      {step === 2 && plan ? <MatchStep plan={plan} setOverride={setOverride} busy={busy} onBack={() => setStep(1)} onNext={() => { setNotice(null); setStep(3); }} /> : null}
      {step === 3 && plan ? (
        <ReviewStep plan={plan} decisions={decisions} setDecisions={setDecisions} resolved={resolved} deviceName={device ? device.name : t('common.thisDevice')} notice={notice}
          onBack={() => setStep(2)} onNext={() => { setError(null); setStep(4); }} />
      ) : null}
      {step === 4 && plan && resolved ? <ConfirmStep plan={plan} resolved={resolved} busy={busy} error={error} onBack={() => setStep(3)} onApply={apply} /> : null}
      {step === 5 && result ? <ResultStep result={result} plan={plan} onUndone={() => { refresh(); go('activity'); }} /> : null}
    </div>
  );
}

// ---- Export ---------------------------------------------------------------------------------
function ExportPanel() {
  const { toast, refresh } = useApp();
  const [projects, setProjects] = useState(null);
  const [roots, setRoots] = useState(null);
  const [claude, setClaude] = useState(null);
  const [chatProjects, setChatProjects] = useState(null);
  const [openChats, setOpenChats] = useState(() => new Set());
  const [sel, setSel] = useState(null);
  const [outDir, setOutDir] = useState(null);
  const [preview, setPreview] = useState(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);

  useEffect(() => {
    Promise.all([api.projects(), api.workspaces(), api.claudeConfig(), api.exportPreview(), api.chats()])
      .then(([p, w, c, prev, ch]) => {
        setProjects(p.projects);
        setRoots(w);
        setClaude(c);
        setChatProjects(ch);
        setOutDir(prev.outDir);
        setSel({
          projects: new Set(p.projects.filter((x) => x.included).map((x) => x.key)),
          workspaces: new Set(w.filter((r) => r.exists && r.files.length).map((r) => r.key)),
          wsSkip: {}, // root key -> workspace files left out of the bundle
          claude: c.included && c.files.length > 0,
          chats: new Set(), // chats go only when picked
        });
      })
      .catch((e) => toast(errorText(e), 'error'));
  }, [toast]);

  const selection = useMemo(() => (sel ? { projects: [...sel.projects], workspaces: [...sel.workspaces], skipWorkspaceFiles: sel.wsSkip, claude: sel.claude, chats: [...sel.chats] } : null), [sel]);
  useEffect(() => {
    if (!selection) return undefined;
    const timer = setTimeout(() => api.exportPreview(selection).then(setPreview).catch(() => {}), 120);
    return () => clearTimeout(timer);
  }, [selection]);

  if (result) {
    return (
      <Card className="card-pad">
        <div className="row-flex" style={{ gap: 16, alignItems: 'flex-start' }}>
          <div className="big-ok"><CircleCheck size={28} /></div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 18, fontWeight: 680 }}>{t('transfer.export.done')}</div>
            <div className="muted" style={{ marginTop: 4 }}>{contents(result.stats, result.chats)} · {fmtBytes(result.size)}</div>
            <div className="mt"><PathLink path={result.path} /></div>
            <div className="stack small mt" style={{ gap: 6 }}>
              <div>{t('transfer.export.step1')}</div>
              <div>{t('transfer.export.step2')}</div>
              <div>{t('transfer.export.step3')}</div>
            </div>
            <div className="row-flex mt">
              <Button icon={FolderOpen} onClick={() => shell.reveal(result.path)}>{t('common.showInFolder')}</Button>
              <Button variant="ghost" onClick={() => setResult(null)}>{t('transfer.export.another')}</Button>
            </div>
          </div>
        </div>
      </Card>
    );
  }
  if (!sel || !projects || !chatProjects) return <Loading />;

  const toggleSet = (k, key) => setSel((s) => {
    const next = new Set(s[k]);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    return { ...s, [k]: next };
  });
  const normal = projects.filter((p) => !p.isScratch);
  const scratch = projects.filter((p) => p.isScratch);
  // Workspace files of a root that stay out: all of them when the root is not selected.
  const skipOf = (s, r) => new Set(s.workspaces.has(r.key) ? s.wsSkip[r.key] || [] : r.files.map((f) => f.rel));
  const toggleRoot = (r) => setSel((s) => {
    const workspaces = new Set(s.workspaces);
    if (s.workspaces.has(r.key) && !(s.wsSkip[r.key] || []).length) workspaces.delete(r.key);
    else workspaces.add(r.key);
    return { ...s, workspaces, wsSkip: { ...s.wsSkip, [r.key]: [] } };
  });
  const toggleFile = (r, rel) => setSel((s) => {
    const skip = skipOf(s, r);
    if (skip.has(rel)) skip.delete(rel);
    else skip.add(rel);
    const workspaces = new Set(s.workspaces);
    if (skip.size === r.files.length) {
      workspaces.delete(r.key);
      skip.clear();
    } else workspaces.add(r.key);
    return { ...s, workspaces, wsSkip: { ...s.wsSkip, [r.key]: [...skip] } };
  });
  const setAllRoots = (on) => setSel((s) => ({ ...s, workspaces: new Set(on ? roots.filter((r) => r.exists && r.files.length).map((r) => r.key) : []), wsSkip: {} }));
  // Picking a chat picks its project's memory too, so the chat arrives with everything it remembers.
  const pickChats = (list, on) => setSel((s) => {
    const chats = new Set(s.chats);
    const picked = new Set(s.projects);
    for (const [p, c] of list) {
      if (!on) chats.delete(c.id);
      else {
        chats.add(c.id);
        if (p.hasMemory) picked.add(p.key);
      }
    }
    return { ...s, chats, projects: picked };
  });
  const chatsOf = (p) => p.chats.map((c) => [p, c]);
  const allChats = chatProjects.flatMap(chatsOf);
  const toggleOpen = (key) => setOpenChats((o) => {
    const next = new Set(o);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    return next;
  });
  const create = async () => {
    setBusy(true);
    try {
      setResult(await api.exportBundle({ outDir, selection }));
      refresh();
    } catch (e) {
      toast(errorText(e), 'error');
    } finally {
      setBusy(false);
    }
  };
  const projectRow = (p) => (
    <label key={p.id} className="row clickable" style={{ padding: '8px 18px' }}>
      <input type="checkbox" checked={sel.projects.has(p.key)} onChange={() => toggleSet('projects', p.key)} />
      <div className="row-main">
        <div className="row-title" style={{ fontWeight: 540 }}>{p.name}</div>
        <div className="row-sub" title={p.cwd || p.memoryDir}>{tildify(p.cwd || p.memoryDir)}</div>
      </div>
      {p.status.new + p.status.changed ? <Badge tone="amber">{count('changes', p.status.new + p.status.changed)}</Badge> : <Badge tone="green">{t('common.upToDate')}</Badge>}
      <span className="col-n muted small">{count('files', p.fileCount)}</span>
    </label>
  );

  return (
    <div className="stack">
      <Card>
        <div className="card-head">
          <Brain size={16} />
          <div className="card-title">{t('common.projectMemories')}</div>
          <div className="spacer" />
          <Button size="sm" variant="ghost" onClick={() => setSel((s) => ({ ...s, projects: new Set(normal.map((p) => p.key)) }))}>{t('common.selectAll')}</Button>
          <Button size="sm" variant="ghost" onClick={() => setSel((s) => ({ ...s, projects: new Set() }))}>{t('common.selectNone')}</Button>
        </div>
        <div className="rows">{normal.map(projectRow)}</div>
        {scratch.length ? (
          <>
            <div className="group-head"><div className="group-desc">{t('transfer.export.scratch')}</div></div>
            <div className="rows">{scratch.map(projectRow)}</div>
          </>
        ) : null}
      </Card>

      <Card>
        <div className="card-head">
          <MessagesSquare size={16} />
          <div>
            <div className="card-title">{t('common.chats')}</div>
            <div className="card-sub">{t('transfer.export.chatsHint')}</div>
          </div>
          <div className="spacer" />
          {allChats.length ? (
            <>
              <Button size="sm" variant="ghost" onClick={() => pickChats(allChats, true)}>{t('common.selectAll')}</Button>
              <Button size="sm" variant="ghost" onClick={() => pickChats(allChats, false)}>{t('common.selectNone')}</Button>
            </>
          ) : null}
        </div>
        {chatProjects.length ? (
          <div className="rows">
            {chatProjects.map((p) => {
              const n = p.chats.filter((c) => sel.chats.has(c.id)).length;
              const open = openChats.has(p.key);
              const Chevron = open ? ChevronDown : ChevronRight;
              return (
                <React.Fragment key={p.key}>
                  <div className="row clickable" style={{ padding: '8px 18px' }} onClick={() => toggleOpen(p.key)} aria-expanded={open} data-chat-project={p.key}>
                    <input type="checkbox" checked={n > 0} onClick={(e) => e.stopPropagation()} onChange={() => pickChats(chatsOf(p), n < p.chats.length)}
                      ref={(el) => { if (el) el.indeterminate = n > 0 && n < p.chats.length; }} aria-label={t('transfer.export.includeFile', { name: p.name })} />
                    <Chevron size={14} style={{ color: 'var(--text-3)', flex: 'none' }} />
                    <div className="row-main">
                      <div className="row-title" style={{ fontWeight: 540 }}>{p.name}</div>
                      {p.path ? <div className="row-sub" title={p.path}>{tildify(p.path)}</div> : null}
                    </div>
                    <span className="muted small">{n ? t('transfer.export.someChats', { n, count: p.chats.length }) : count('chats', p.chats.length)}</span>
                  </div>
                  {open ? p.chats.map((c) => (
                    <label key={c.id} className="row clickable" style={{ padding: '6px 18px 6px 44px' }} data-chat={c.id}>
                      <input type="checkbox" checked={sel.chats.has(c.id)} onChange={(e) => pickChats([[p, c]], e.target.checked)} aria-label={t('transfer.export.includeFile', { name: c.title || c.id })} />
                      <MessagesSquare size={14} style={{ color: 'var(--text-3)', flex: 'none' }} />
                      <div className="row-main">
                        <div className="row-title" style={{ fontWeight: 500 }} title={c.title || ''}>{c.title || t('transfer.export.untitled')}</div>
                        <div className="row-sub">{[c.entrypoint ? label('entrypoint', c.entrypoint) : null, fmtRelative(c.mtime)].filter(Boolean).join(' · ')}</div>
                      </div>
                      <span className="muted small">{fmtBytes(c.size)}</span>
                    </label>
                  )) : null}
                </React.Fragment>
              );
            })}
          </div>
        ) : <div className="card-pad muted small">{t('transfer.export.noChats')}</div>}
      </Card>

      <Card>
        <div className="card-head">
          <FolderTree size={16} />
          <div>
            <div className="card-title">{t('common.workspaceFiles')}</div>
            <div className="card-sub">{t('transfer.export.wsHint')}</div>
          </div>
          <div className="spacer" />
          {roots.length ? (
            <>
              <Button size="sm" variant="ghost" onClick={() => setAllRoots(true)}>{t('common.selectAll')}</Button>
              <Button size="sm" variant="ghost" onClick={() => setAllRoots(false)}>{t('common.selectNone')}</Button>
            </>
          ) : null}
        </div>
        {roots.length ? (
          <div className="rows">
            {roots.map((r) => {
              const skip = skipOf(sel, r);
              const chosen = r.files.length - skip.size;
              const checked = sel.workspaces.has(r.key) && (chosen > 0 || !r.files.length);
              return (
                <React.Fragment key={r.key}>
                  <label className="row clickable" style={{ padding: '8px 18px' }}>
                    <input type="checkbox" checked={checked} disabled={!r.exists} onChange={() => toggleRoot(r)}
                      ref={(el) => { if (el) el.indeterminate = checked && chosen < r.files.length; }} />
                    <div className="row-main">
                      <div className="row-title" style={{ fontWeight: 540 }}>{r.name}</div>
                      <div className="row-sub" title={r.path}>{tildify(r.path)}</div>
                    </div>
                    <span className="muted small">{chosen && chosen < r.files.length ? t('transfer.export.someFiles', { n: chosen, count: r.files.length }) : count('files', r.files.length)}</span>
                  </label>
                  {r.exists ? r.files.map((f) => (
                    <label key={f.rel} className="row clickable" style={{ padding: '6px 18px 6px 44px' }} data-ws-file={f.rel}>
                      <input type="checkbox" checked={!skip.has(f.rel)} onChange={() => toggleFile(r, f.rel)} aria-label={t('transfer.export.includeFile', { name: f.rel })} />
                      <FileCode2 size={14} style={{ color: 'var(--text-3)', flex: 'none' }} />
                      <div className="row-main">
                        <div className="row-title" style={{ fontWeight: 500 }} title={f.path}>{f.rel}</div>
                      </div>
                      <span className="muted small">{count('folders', f.folders.length)}</span>
                      <Badge tone={FILE_TONE[f.status]}>{label('fileStatus', f.status)}</Badge>
                    </label>
                  )) : null}
                </React.Fragment>
              );
            })}
          </div>
        ) : <div className="card-pad muted small">{t('transfer.export.noRoots')}</div>}
      </Card>

      <Card>
        <div className="card-head">
          <Settings2 size={16} />
          <div className="card-title">{t('common.claudeSettings')}</div>
        </div>
        <label className="row clickable" style={{ padding: '10px 18px' }}>
          <input type="checkbox" checked={sel.claude} disabled={!claude.files.length} onChange={() => setSel((s) => ({ ...s, claude: !s.claude }))} />
          <div className="row-main">
            <div className="row-title" style={{ fontWeight: 540 }}>CLAUDE.md, agents, commands, skills</div>
            <div className="row-sub">{claude.files.length ? `${count('files', claude.files.length)} · ${tildify(claude.dir)}` : t('common.notOnDevice')}</div>
          </div>
        </label>
      </Card>

      <Card className="card-pad">
        <div className="row-flex">
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="strong">{t('transfer.export.saveTo')}</div>
            <div className="small"><Path>{outDir}/{preview ? preview.fileName : ''}</Path></div>
          </div>
          <Button size="sm" icon={FolderOpen} onClick={async () => { const p = await shell.chooseFolder({ title: t('transfer.export.chooseFolder'), defaultPath: outDir }); if (p) setOutDir(p); }}>{t('common.change')}</Button>
        </div>
      </Card>

      {preview && preview.warnings.length ? (
        <Banner tone="warn" icon={TriangleAlert}>
          {preview.warnings.map((w, i) => <div key={i}>{label('exportWarning', w.code, w) || w.code}</div>)}
        </Banner>
      ) : null}

      <div className="sticky-foot">
        <div className="small">
          {preview ? <>{t('transfer.export.files', { count: preview.files, n: <span className="strong">{preview.files.toLocaleString(language())}</span> })} · {count('parts', preview.locations.length)}{preview.chats.count ? <> · {t('transfer.export.chatsCount', { count: preview.chats.count, size: fmtBytes(preview.chats.bytes) })}</> : null}</> : t('common.calculating')}
          <div className="muted">{t('transfer.export.readOnly')}</div>
        </div>
        <div className="spacer" />
        <Button variant="primary" size="lg" icon={PackagePlus} onClick={create} disabled={busy || !preview || !preview.locations.length} data-testid="create-bundle">
          {busy ? t('transfer.export.creating') : t('transfer.export.create')}
        </Button>
      </div>
    </div>
  );
}

export default function Transfer({ params = {} }) {
  const [tab, setTab] = useState(params.bundle ? 'import' : params.tab || 'import');
  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1 className="page-title">{t('nav.transfer')}</h1>
          <div className="page-sub">{t('transfer.sub')}</div>
        </div>
      </div>
      <div className="tabs">
        <button type="button" className={`tab ${tab === 'import' ? 'on' : ''}`} onClick={() => setTab('import')} data-testid="tab-import"><Download size={15} /> {t('common.importBundle')}</button>
        <button type="button" className={`tab ${tab === 'export' ? 'on' : ''}`} onClick={() => setTab('export')} data-testid="tab-export"><PackagePlus size={15} /> {t('common.createBundle')}</button>
      </div>
      {tab === 'import' ? <ImportWizard initialBundle={params.bundle} initialMode={params.mode} /> : <ExportPanel />}
    </div>
  );
}
