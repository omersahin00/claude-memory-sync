import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Download, PackagePlus, FileUp, Inbox, ArrowRight, ArrowLeft, Brain, FolderTree, Settings2, GitBranch, ShieldCheck,
  TriangleAlert, CircleCheck, FolderOpen, Undo2, Info, FileDiff, Check, Package, RotateCcw, Merge,
} from 'lucide-react';
import { api, shell, errorText } from '../api.js';
import { useApp, Card, Badge, Button, Path, PathLink, Loading, Empty, Banner, Modal, DiffView, Segmented } from '../ui.jsx';
import {
  fmtDate, fmtRelative, fmtBytes, KIND_LABEL, TYPE_LABEL, HOW, MATCH_WARNING, GROUPS, RESTORE_GROUPS, GROUP_ORDER,
  ACTION_TEXT, INDEX_TEXT, BLOCKING, EXPORT_WARNING, tildify,
} from '../format.js';
import { UndoModal } from './Activity.jsx';
import { contents } from './Backups.jsx';

const TYPE_ICON = { project: Brain, workspaceRoot: FolderTree, claude: Settings2 };
const STEPS = ['Paket', 'Eşleştirme', 'Değişiklikler', 'Onay', 'Sonuç'];

function Steps({ step }) {
  return (
    <div className="steps">
      {STEPS.map((s, i) => (
        <React.Fragment key={s}>
          {i ? <div className="step-line" /> : null}
          <div className={`step ${i + 1 === step ? 'active' : i + 1 < step ? 'done' : ''}`}>
            <div className="step-num">{i + 1 < step ? <Check size={12} /> : i + 1}</div>
            {s}
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
        <div className="strong" style={{ color: 'var(--text)' }}>Bir .memsync paketini buraya bırak</div>
        <div>ya da</div>
        <Button variant="primary" icon={FolderOpen} onClick={pick} data-testid="choose-bundle">Dosya seç</Button>
        <div className="muted small">Paket dosyasına Finder’da ya da Gezgin’de çift tıklayınca da burası açılır.</div>
      </div>
      <Card>
        <div className="card-head">
          <Inbox size={16} />
          <div className="card-title">Bulunan paketler</div>
          <div className="card-sub">Masaüstü, İndirilenler ve yedek klasörü</div>
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
                    {b.imported ? <Badge tone="green">Aktarıldı</Badge> : <Badge tone="amber">Yeni</Badge>}
                  </div>
                  <div className="row-sub">{fmtDate(b.createdAt)} · {contents(b.stats)}</div>
                  <div className="row-sub"><Path>{b.path}</Path></div>
                </div>
                <ArrowRight size={16} className="muted" />
              </div>
            ))}
          </div>
        ) : (
          <div className="card-pad muted">Başka cihazdan gelen paket bulunamadı. Paketi Masaüstüne ya da İndirilenler’e koyarsan burada görünür.</div>
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
          <div className="card-title">{own ? KIND_LABEL[bundle.kind] || 'Paket' : `${bundle.device.name} cihazından gelen paket`}</div>
          <div className="spacer" />
          <Badge tone="green"><ShieldCheck size={12} /> Bütünlük doğrulandı</Badge>
        </div>
        <div className="card-pad">
          <dl className="kv">
            <dt>Dosya</dt>
            <dd><PathLink path={bundle.path} /></dd>
            <dt>Oluşturan cihaz</dt>
            <dd>{bundle.device.name} · {bundle.device.platformName}{own ? ' (bu cihaz)' : ''}</dd>
            <dt>Oluşturulma</dt>
            <dd>{fmtDate(bundle.createdAt)} ({fmtRelative(bundle.createdAt)})</dd>
            <dt>İçerik</dt>
            <dd>{contents(bundle.stats)} · {fmtBytes(bundle.stats.bytes)}</dd>
            {bundle.imported ? (<><dt>Durum</dt><dd>Bu paket daha önce bu cihaza aktarıldı.</dd></>) : null}
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
                  <div className="row-sub" title={l.path || ''}>{l.path ? `Kaynak: ${tildify(l.path)}` : TYPE_LABEL[l.type]}</div>
                </div>
                <span className="muted small">{l.files} dosya</span>
              </div>
            );
          })}
        </div>
      </Card>

      <div className="grid cols-2">
        <button type="button" className={`choice-card ${mode === 'sync' ? 'on' : ''}`} onClick={() => setMode('sync')} data-testid="mode-sync">
          <input type="radio" readOnly checked={mode === 'sync'} />
          <div>
            <div className="strong row-flex"><Merge size={15} /> İki yönlü birleştir {own ? null : <Badge tone="accent">Önerilen</Badge>}</div>
            <div className="muted small" style={{ marginTop: 4 }}>
              Karşıdaki yenilikler alınır, bu cihazdaki yenilikler korunur. Yeni gelen, değişen ve silinen her dosyayı tek tek görür, onaylarsın.
            </div>
          </div>
        </button>
        <button type="button" className={`choice-card ${mode === 'restore' ? 'on' : ''}`} onClick={() => setMode('restore')} data-testid="mode-restore">
          <input type="radio" readOnly checked={mode === 'restore'} />
          <div>
            <div className="strong row-flex"><RotateCcw size={15} /> Bu cihazı paketteki hâline getir {own ? <Badge tone="accent">Yedekten dönüş</Badge> : null}</div>
            <div className="muted small" style={{ marginTop: 4 }}>
              Format sonrası ya da bir yedeğe dönmek için. Paketteki her şey yazılır; pakette olmayan dosyalar silinir. Yine her dosyayı görürsün.
            </div>
          </div>
        </button>
      </div>

      <div className="sticky-foot">
        <Button icon={ArrowLeft} onClick={onBack}>Başka paket seç</Button>
        <div className="spacer" />
        <Button variant="primary" onClick={onNext} disabled={!mode || busy} data-testid="next">
          {busy ? 'Hazırlanıyor…' : 'Devam'} <ArrowRight size={16} />
        </Button>
      </div>
    </div>
  );
}

// ---- Step 2: where each part goes on this device -------------------------------------------
function MatchEditor({ m, onSet, onClose }) {
  const [projects, setProjects] = useState(null);
  useEffect(() => {
    if (m.type === 'project') api.projects().then((d) => setProjects(d.projects));
  }, [m.type]);
  const chooseFolder = async () => {
    const p = await shell.chooseFolder({ title: m.type === 'project' ? `${m.remote.name || m.remote.key} projesinin bu cihazdaki klasörü` : 'Workspace dosyalarının yazılacağı klasör' });
    if (p) onSet({ action: m.type === 'project' ? 'create' : 'map', path: p, include: true });
  };
  return (
    <Modal title={`${m.remote.name || m.remote.key}: bu cihazda nereye?`} onClose={onClose}
      footer={<>
        <Button onClick={() => onSet({ action: 'skip', include: false })}>Bu sefer atla</Button>
        <div className="spacer" />
        <Button icon={FolderOpen} onClick={chooseFolder}>Klasör seç…</Button>
      </>}>
      <p style={{ marginTop: 0 }} className="muted">
        {m.type === 'project'
          ? 'Hafızaların yazılacağı projeyi seç. Listede yoksa projenin klasörünü seç; Claude Code o klasörü açtığında hafızaları görür.'
          : 'Workspace dosyalarının yazılacağı klasörü seç. Klasör, tarama klasörlerine eklenir.'}
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
                  <span className="muted small">{p.fileCount} dosya</span>
                  {m.local && m.local.id === p.id ? <Badge tone="accent">Şu anki</Badge> : null}
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
  const how = HOW[m.how];
  return (
    <div className="row" style={{ alignItems: 'flex-start', padding: '13px 18px' }}>
      <input type="checkbox" style={{ marginTop: 9 }} checked={m.include} disabled={!m.local} onChange={(e) => onSet({ include: e.target.checked })} aria-label="Aktarıma dahil" />
      <div className="match-side">
        <div className="row-flex">
          <Icon size={15} style={{ color: 'var(--text-3)' }} />
          <span className="row-title">{m.remote.name || m.remote.key}</span>
          <span className="muted small">{files} dosya</span>
        </div>
        <div className="row-sub" title={m.remote.path || ''}>{m.remote.path ? `Kaynak: ${tildify(m.remote.path)}` : TYPE_LABEL[m.type]}</div>
        {m.remote.gitRemote ? <div className="row-sub"><GitBranch size={11} /> {m.remote.gitRemote}</div> : null}
      </div>
      <ArrowRight size={16} className="match-arrow" style={{ marginTop: 9 }} />
      <div className="match-side">
        {m.local && m.status !== 'skipped' ? (
          <>
            <div className="row-flex">
              <span className="row-title">{m.local.name || m.local.key}</span>
              {m.status === 'create' ? <Badge tone="accent">Kurulacak</Badge> : null}
              {how ? <Badge tone={how[1]}>{how[0]}</Badge> : null}
            </div>
            {m.type === 'project' ? (
              <>
                <div className="row-sub" title={m.local.path || ''}>Proje: {m.local.path ? tildify(m.local.path) : '-'}</div>
                <div className="row-sub" title={m.local.root}>Hafıza: {tildify(m.local.root)}</div>
              </>
            ) : (
              <div className="row-sub" title={m.local.root}>{tildify(m.local.root)}</div>
            )}
            {m.warnings.map((w) => <div key={w} className="small" style={{ color: 'var(--amber)' }}>{MATCH_WARNING[w] || w}</div>)}
          </>
        ) : m.status === 'skipped' ? (
          <div className="muted" style={{ paddingTop: 2 }}>Atlanacak</div>
        ) : (
          <>
            <div className="strong" style={{ color: 'var(--red)' }}>Bu cihazda bulunamadı</div>
            {m.remote.gitRemote ? (
              <div className="small" style={{ marginTop: 2 }}>Önce klonla: <span className="code">git clone {m.remote.gitRemote}</span>, sonra paketi yeniden aç ya da klasörünü seç.</div>
            ) : (
              <div className="small muted" style={{ marginTop: 2 }}>
                {m.type === 'workspaceRoot'
                  ? 'Değiştir’e basıp workspace dosyalarının yazılacağı klasörü seç.'
                  : 'Proje klasörünü seçersen hafızalar oraya kurulur.'}
              </div>
            )}
          </>
        )}
      </div>
      {m.type !== 'claude' ? <Button size="sm" onClick={onEdit}>Değiştir</Button> : null}
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
      <Banner tone="info" icon={Info}>
        Paketteki her parçanın bu cihazda nereye yazılacağı aşağıda. Projeler önce git deposundan, sonra klasör yolundan tanınır; emin olunamayanlar seçili gelmez.
      </Banner>
      <Card>
        <div className="table-head">
          <div style={{ width: 15 }} />
          <div style={{ flex: 1 }}>Pakette</div>
          <div style={{ width: 16 }} />
          <div style={{ flex: 1 }}>Bu cihazda</div>
          <div style={{ width: 76 }} />
        </div>
        <div className="rows">
          {plan.matches.map((m) => (
            <MatchRow key={m.id} m={m} files={files[m.id] || 0} onSet={(ov) => setOverride(m.id, ov)} onEdit={() => setEditing(m)} />
          ))}
        </div>
      </Card>
      <div className="sticky-foot">
        <Button icon={ArrowLeft} onClick={onBack}>Geri</Button>
        <div className="muted small">{included} parça aktarılacak{missing ? `, ${missing} parça atlanacak` : ''}</div>
        <div className="spacer" />
        <Button variant="primary" onClick={onNext} disabled={!included || busy} data-testid="next">
          Değişiklikleri gör <ArrowRight size={16} />
        </Button>
      </div>
      {editing ? <MatchEditor m={editing} onClose={() => setEditing(null)} onSet={(ov) => { setEditing(null); setOverride(editing.id, ov); }} /> : null}
    </div>
  );
}

// ---- Step 3: every file that changes ------------------------------------------------------------
const CONFLICT_OPTIONS = {
  conflict: [
    { value: 'l', label: 'Bu cihazdaki', title: 'Bu cihazdaki sürüm kalır; gelen sürüm pakette kalır' },
    { value: 'r', label: 'Gelen', title: 'Gelen sürüm yazılır; bu cihazdaki sürüm işlem öncesi yedekte kalır' },
    { value: 'b', label: 'İkisini de tut', title: 'Bu cihazdaki kalır; gelen sürüm yanına ayrı dosya olarak eklenir ve MEMORY.md’ye yazılır' },
    { value: 'skip', label: 'Atla', title: 'Şimdilik dokunma; sonraki aktarımda yine sorulur' },
  ],
  'conflict-remote-deleted': [
    { value: 'l', label: 'Tut', title: 'Bu cihazdaki değişmiş sürüm kalır' },
    { value: 'd', label: 'Sil', title: 'Silinir; işlem öncesi yedekte kalır' },
    { value: 'skip', label: 'Atla', title: 'Şimdilik dokunma; sonraki aktarımda yine sorulur' },
  ],
  'conflict-local-deleted': [
    { value: 'r', label: 'Geri getir', title: 'Karşı cihazdaki sürüm yazılır' },
    { value: 'd', label: 'Silinmiş kalsın', title: 'Bu cihazda silinmiş kalır' },
    { value: 'skip', label: 'Atla', title: 'Şimdilik dokunma; sonraki aktarımda yine sorulur' },
  ],
};
const SAFE_CHOICE = { conflict: 'b', 'conflict-remote-deleted': 'l', 'conflict-local-deleted': 'r' };

function DiffModal({ plan, item, decisions, deviceName, onClose }) {
  const [d, setD] = useState(null);
  const [err, setErr] = useState(null);
  useEffect(() => {
    api.itemDiff(plan.id, item.key, decisions).then(setD).catch(setErr);
  }, [plan.id, item.key, decisions]);
  const remoteName = plan.bundle.device.name;
  let body;
  if (err) body = <Banner tone="error">{errorText(err)}</Banner>;
  else if (!d) body = <Loading />;
  else if (d.binary) body = <div className="muted">İkili dosya; fark gösterilemiyor.</div>;
  else if (d.isIndex) body = <DiffView lines={d.lines} minusLabel={`Bu cihazdaki (${deviceName})`} plusLabel="Birleştirildikten sonra" />;
  else if (d.local == null) body = (<><div className="section-label">Gelen sürüm ({remoteName})</div><pre className="preview">{d.remote}</pre></>);
  else if (d.remote == null) body = (<><div className="section-label">Bu cihazdaki sürüm ({deviceName})</div><pre className="preview">{d.local}</pre></>);
  else body = <DiffView lines={d.lines} minusLabel={`Yalnız bu cihazda (${deviceName})`} plusLabel={`Yalnız gelende (${remoteName})`} />;
  return (
    <Modal title={`${item.scopeLabel} / ${item.rel}`} onClose={onClose} wide>
      <div className="muted small" style={{ marginBottom: 10 }}>
        {ACTION_TEXT[item.action] || GROUPS[item.group]?.desc || ''} · <Path>{item.path}</Path>
      </div>
      {body}
    </Modal>
  );
}

function ReviewRow({ it, mode, choice, onChoice, onDiff, indexInfo }) {
  const takeSkip = it.choices.includes('take');
  const sizes = [it.local ? `bu cihaz ${fmtBytes(it.local.size)}` : null, it.remote ? `gelen ${fmtBytes(it.remote.size)}` : null].filter(Boolean).join(' → ');
  let sub = ACTION_TEXT[it.action] && mode === 'sync' ? `${ACTION_TEXT[it.action]} · ${sizes}` : sizes;
  if (it.isIndex && indexInfo) {
    const st = indexInfo.stats;
    sub = indexInfo.skipped ? 'Dokunulmayacak' : `${INDEX_TEXT[indexInfo.display] || indexInfo.display}${st && indexInfo.display === 'merge' ? ` · ${st.added} satır eklenecek, ${st.changed} değişecek, ${st.removed} çıkarılacak${st.copies ? `, ${st.copies} kopya satırı` : ''}` : ''}`;
  }
  return (
    <div className="row" style={{ padding: '9px 18px' }}>
      {takeSkip ? (
        <input type="checkbox" checked={choice === 'take'} onChange={(e) => onChoice(e.target.checked ? 'take' : 'skip')} aria-label={`${it.rel} uygulansın`} />
      ) : it.choices.length ? null : <span style={{ width: 15 }} />}
      <div className="row-main">
        <div className="row-title" style={{ fontWeight: 540 }}>
          <span className="muted" style={{ fontWeight: 400 }}>{it.scopeLabel} / </span>{it.rel}
        </div>
        <div className="row-sub">{sub}</div>
      </div>
      {CONFLICT_OPTIONS[it.action] && mode === 'sync' ? (
        <Segmented value={choice || null} options={CONFLICT_OPTIONS[it.action]} onChange={onChoice} />
      ) : null}
      <Button size="sm" variant="ghost" icon={FileDiff} onClick={onDiff}>Fark</Button>
    </div>
  );
}

function ReviewStep({ plan, decisions, setDecisions, resolved, deviceName, onNext, onBack, notice }) {
  const [diff, setDiff] = useState(null);
  const [showKept, setShowKept] = useState(false);
  const [lineRows, setLineRows] = useState({});
  const metas = plan.mode === 'restore' ? RESTORE_GROUPS : GROUPS;
  const order = plan.mode === 'restore' ? ['new', 'updated', 'deleted'] : GROUP_ORDER;

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

  const counts = plan.groups;
  const pending = resolved ? resolved.pending.length : 0;
  const nothing = order.every((g) => !plan.items.some((i) => i.group === g && g !== 'kept'));

  return (
    <div>
      {notice ? <Banner tone="warn" icon={TriangleAlert}>{notice}</Banner> : null}
      {plan.errors.length ? (
        <Banner tone="error" icon={TriangleAlert}>
          <div className="strong">Bu aktarım şu sorunlar giderilmeden yapılamaz:</div>
          {plan.errors.map((e, i) => <div key={i}>{(BLOCKING[e.code] || (() => e.code))(e)}</div>)}
        </Banner>
      ) : null}
      <div className="chips">
        {order.filter((g) => counts[g]).map((g) => (
          <span key={g} className="chip"><span className={`dot-i ${metas[g].tone}`} />{metas[g].label}<b>{counts[g]}</b></span>
        ))}
        <span className="chip"><span className="dot-i gray" />Aynı<b>{counts.same || 0}</b></span>
      </div>

      {nothing ? (
        <Banner tone="ok" icon={CircleCheck}>Bu cihaz paketle aynı; alınacak bir değişiklik yok.</Banner>
      ) : null}

      {order.map((g) => {
        const items = plan.items.filter((i) => i.group === g);
        if (!items.length) return null;
        const meta = metas[g];
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
                  <Button size="sm" variant="ghost" onClick={() => setMany(items, 'take')}>Tümünü seç</Button>
                  <Button size="sm" variant="ghost" onClick={() => setMany(items, 'skip')}>Hiçbirini seçme</Button>
                </>
              ) : null}
              {g === 'conflict' && plan.mode === 'sync' ? (
                <Button size="sm" onClick={() => setMany(items, (it) => SAFE_CHOICE[it.action])} title="İki cihazda da değişenlerde ikisini de tut; silinmiş olanları koru ya da geri getir" data-testid="keep-all">
                  Hepsinde hiçbir şeyi kaybetme
                </Button>
              ) : null}
              {g === 'kept' ? <Button size="sm" variant="ghost" onClick={() => setShowKept((v) => !v)}>{showKept ? 'Gizle' : 'Göster'}</Button> : null}
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
              <div className="group-title">MEMORY.md satır farkları</div>
              <div className="group-desc">Aynı dosyanın içindekiler satırı iki cihazda farklı yazılmış. Hangisi kalsın?</div>
            </div>
          </div>
          <div className="rows">
            {Object.values(lineRows).map((p) => (
              <div key={p.id} className="row" style={{ alignItems: 'flex-start' }}>
                <div className="row-main">
                  <div className="row-title">{scopeLabel[p.scope]} / {p.target}</div>
                  <label className="row-flex small" style={{ marginTop: 6, cursor: 'pointer' }}>
                    <input type="radio" name={p.id} checked={decisions.lines[p.id] === 'local'} onChange={() => setLine(p.id, 'local')} />
                    <span className="muted" style={{ width: 92, flex: 'none' }}>Bu cihazdaki</span> <span className="code">{p.local}</span>
                  </label>
                  <label className="row-flex small" style={{ marginTop: 6, cursor: 'pointer' }}>
                    <input type="radio" name={p.id} checked={decisions.lines[p.id] === 'remote'} onChange={() => setLine(p.id, 'remote')} />
                    <span className="muted" style={{ width: 92, flex: 'none' }}>Gelen</span> <span className="code">{p.remote}</span>
                  </label>
                </div>
              </div>
            ))}
          </div>
        </Card>
      ) : null}

      <div className="sticky-foot">
        <Button icon={ArrowLeft} onClick={onBack}>Geri</Button>
        {resolved ? (
          <div className="small">
            <span className="strong">{resolved.writes}</span> dosya yazılacak · <span className="strong">{resolved.deletes}</span> dosya silinecek
            {resolved.copies ? <> · <span className="strong">{resolved.copies}</span> kopya</> : null}
            {pending ? <span style={{ color: 'var(--amber)', marginLeft: 10 }} className="strong">{pending} karar bekliyor</span> : null}
          </div>
        ) : <span className="muted small">Hesaplanıyor…</span>}
        <div className="spacer" />
        <Button variant="primary" onClick={onNext} disabled={!resolved || pending > 0 || plan.errors.length > 0} data-testid="next">
          Devam <ArrowRight size={16} />
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
  const nothing = !resolved.ops.length;
  return (
    <div className="stack">
      {error ? <Banner tone="error" icon={TriangleAlert}>{error}</Banner> : null}
      {nothing ? (
        <Banner tone="ok" icon={CircleCheck}>Yazılacak ya da silinecek bir dosya yok. Bitir’e basınca yalnızca bu paketin görüldüğü kaydedilir.</Banner>
      ) : (
        <Card>
          <div className="card-head">
            <div className="card-title">{resolved.writes} dosya yazılacak, {resolved.deletes} dosya silinecek</div>
          </div>
          <div className="card-pad stack" style={{ gap: 12 }}>
            {scopes.map((s) => (
              <div key={s.id}>
                <div className="row-flex">
                  <span className="strong">{s.label}</span>
                  {s.create ? <Badge tone="accent">Kurulacak</Badge> : null}
                </div>
                <div className="small"><Path>{s.root}</Path></div>
                <div className="op-list" style={{ marginTop: 4 }}>
                  {byScope.get(s.id).map((op) => (
                    <div key={op.key + op.type} className="op">
                      <Badge tone={op.type === 'write' ? 'green' : 'red'}>{op.type === 'write' ? 'yaz' : 'sil'}</Badge>
                      <span>{op.rel}</span>
                      {op.reason === 'copy' ? <span className="muted small">(gelen sürümün kopyası)</span> : null}
                      {op.reason === 'index' ? <span className="muted small">(birleştirilmiş içindekiler)</span> : null}
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
          <div className="row-flex strong" style={{ marginBottom: 8 }}><ShieldCheck size={16} style={{ color: 'var(--green)' }} /> Kayıpsız aktarım</div>
          <div className="small stack" style={{ gap: 6 }}>
            <div>1. Önce bu cihazın tam yedeği alınır ve geri okunarak doğrulanır: <Path>{plan.backupDir}</Path></div>
            <div>2. Dosyalar geçici dosyaya yazılıp tek adımda yerine konur. Bir dosyada hata olursa o ana kadar yapılanlar geri alınır.</div>
            <div>3. İşlem bitince her dosya tekrar okunup kontrol edilir. Geçmiş’ten tek tıkla geri alınabilir.</div>
          </div>
          <Banner tone="warn" icon={TriangleAlert}>Bu projelerde açık bir Claude Code oturumu varsa önce kapat; açık oturum aynı anda hafızaya yazabilir.</Banner>
        </Card>
      )}
      <div className="sticky-foot">
        <Button icon={ArrowLeft} onClick={onBack} disabled={busy}>Geri</Button>
        <div className="spacer" />
        <Button variant="primary" size="lg" onClick={onApply} disabled={busy} data-testid="apply">
          {busy ? 'Uygulanıyor…' : nothing ? 'Bitir' : plan.mode === 'restore' ? 'Yedek al ve geri yükle' : 'Yedek al ve aktar'}
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
          <div style={{ fontSize: 18, fontWeight: 680 }}>{result.nothing ? 'Değişiklik yoktu' : plan.mode === 'restore' ? 'Geri yükleme tamamlandı' : 'Aktarım tamamlandı'}</div>
          <div className="muted" style={{ marginTop: 4 }}>
            {result.nothing ? 'Bu cihaz paketle zaten aynıydı; paketin görüldüğü kaydedildi.' : `${result.writes} dosya yazıldı, ${result.deletes} dosya silindi; hepsi tekrar okunup doğrulandı.`}
          </div>
          {result.copies ? (
            <Banner tone="info" icon={Info}>
              {result.copies} çakışma kopyası oluşturuldu (dosya--{plan.bundle.device.name.toLowerCase()}.md gibi) ve MEMORY.md’ye yazıldı. Claude’dan bunları asıl dosyayla birleştirmesini isteyebilirsin.
            </Banner>
          ) : null}
          {result.backupPath ? (
            <dl className="kv mt">
              <dt>İşlem öncesi yedek</dt>
              <dd><PathLink path={result.backupPath} /></dd>
            </dl>
          ) : null}
          <div className="row-flex mt" style={{ flexWrap: 'wrap' }}>
            {result.backupPath ? <Button icon={Undo2} onClick={() => setUndo(true)} data-testid="undo">Geri al</Button> : null}
            {plan.mode === 'sync' && !plan.bundle.isMine ? (
              <Button icon={PackagePlus} onClick={() => go('transfer', { tab: 'export' })}>Bu cihazdan paket oluştur (karşıya göndermek için)</Button>
            ) : null}
            <Button variant="primary" onClick={() => go('home')}>Bitti</Button>
          </div>
        </div>
      </div>
      {undo ? <UndoModal activityId={result.activityId} onClose={() => setUndo(false)} onDone={() => { setUndo(false); onUndone(); }} /> : null}
    </Card>
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
  const [decisions, setDecisions] = useState({ items: {}, lines: {} });
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
      if (!keepDecisions) setDecisions({ items: {}, lines: {} });
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
          setNotice('Plan hazırlandıktan sonra bazı dosyalar değişti (Claude açık olabilir). Değişiklikler yeniden okundu; lütfen tekrar gözden geçir.');
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
          <div className="strong">Paket açılamadı</div>
          {errorText(error)}
          <div><Path>{bundlePath}</Path></div>
        </Banner>
        <div><Button icon={ArrowLeft} onClick={() => setBundlePath(null)}>Başka paket seç</Button></div>
      </div>
    );
  }
  if (!bundle) return <Loading text="Paket açılıyor ve doğrulanıyor…" />;

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
        <ReviewStep plan={plan} decisions={decisions} setDecisions={setDecisions} resolved={resolved} deviceName={device ? device.name : 'bu cihaz'} notice={notice}
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
  const [sel, setSel] = useState(null);
  const [outDir, setOutDir] = useState(null);
  const [preview, setPreview] = useState(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);

  useEffect(() => {
    Promise.all([api.projects(), api.workspaces(), api.claudeConfig(), api.exportPreview()])
      .then(([p, w, c, prev]) => {
        setProjects(p.projects);
        setRoots(w);
        setClaude(c);
        setOutDir(prev.outDir);
        setSel({
          projects: new Set(p.projects.filter((x) => x.included).map((x) => x.key)),
          workspaces: new Set(w.filter((r) => r.exists && r.files.length).map((r) => r.key)),
          claude: c.included && c.files.length > 0,
        });
      })
      .catch((e) => toast(errorText(e), 'error'));
  }, [toast]);

  const selection = useMemo(() => (sel ? { projects: [...sel.projects], workspaces: [...sel.workspaces], claude: sel.claude } : null), [sel]);
  useEffect(() => {
    if (!selection) return undefined;
    const t = setTimeout(() => api.exportPreview(selection).then(setPreview).catch(() => {}), 120);
    return () => clearTimeout(t);
  }, [selection]);

  if (result) {
    return (
      <Card className="card-pad">
        <div className="row-flex" style={{ gap: 16, alignItems: 'flex-start' }}>
          <div className="big-ok"><CircleCheck size={28} /></div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 18, fontWeight: 680 }}>Paket oluşturuldu ve doğrulandı</div>
            <div className="muted" style={{ marginTop: 4 }}>{contents(result.stats)} · {fmtBytes(result.size)}</div>
            <div className="mt"><PathLink path={result.path} /></div>
            <div className="stack small mt" style={{ gap: 6 }}>
              <div>1. Bu dosyayı diğer cihaza taşı (USB bellek, AirDrop, e-posta, bulut klasörü).</div>
              <div>2. Diğer cihazda Claude Memory Sync’i aç ve dosyaya çift tıkla ya da Aktarım → Paket aktar’dan seç.</div>
              <div>3. Orada her değişikliği görüp onayladıktan sonra aktarılır; önce o cihazın da yedeği alınır.</div>
            </div>
            <div className="row-flex mt">
              <Button icon={FolderOpen} onClick={() => shell.reveal(result.path)}>Klasörde göster</Button>
              <Button variant="ghost" onClick={() => setResult(null)}>Yeni paket</Button>
            </div>
          </div>
        </div>
      </Card>
    );
  }
  if (!sel || !projects) return <Loading />;

  const toggleSet = (k, key) => setSel((s) => {
    const next = new Set(s[k]);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    return { ...s, [k]: next };
  });
  const normal = projects.filter((p) => !p.isScratch);
  const scratch = projects.filter((p) => p.isScratch);
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
      {p.status.new + p.status.changed ? <Badge tone="amber">{p.status.new + p.status.changed} değişiklik</Badge> : <Badge tone="green">Güncel</Badge>}
      <span className="col-n muted small">{p.fileCount} dosya</span>
    </label>
  );

  return (
    <div className="stack">
      <Card>
        <div className="card-head">
          <Brain size={16} />
          <div className="card-title">Proje hafızaları</div>
          <div className="spacer" />
          <Button size="sm" variant="ghost" onClick={() => setSel((s) => ({ ...s, projects: new Set(normal.map((p) => p.key)) }))}>Tümünü seç</Button>
          <Button size="sm" variant="ghost" onClick={() => setSel((s) => ({ ...s, projects: new Set() }))}>Hiçbirini seçme</Button>
        </div>
        <div className="rows">{normal.map(projectRow)}</div>
        {scratch.length ? (
          <>
            <div className="group-head"><div className="group-desc">Claude uygulamasının geçici oturumları (başka cihazda karşılığı yoktur)</div></div>
            <div className="rows">{scratch.map(projectRow)}</div>
          </>
        ) : null}
      </Card>

      <div className="grid cols-2">
        <Card>
          <div className="card-head">
            <FolderTree size={16} />
            <div className="card-title">Workspace dosyaları</div>
          </div>
          {roots.length ? (
            <div className="rows">
              {roots.map((r) => (
                <label key={r.key} className="row clickable" style={{ padding: '8px 18px' }}>
                  <input type="checkbox" checked={sel.workspaces.has(r.key)} disabled={!r.exists} onChange={() => toggleSet('workspaces', r.key)} />
                  <div className="row-main">
                    <div className="row-title" style={{ fontWeight: 540 }}>{r.name}</div>
                    <div className="row-sub" title={r.path}>{tildify(r.path)}</div>
                  </div>
                  <span className="muted small">{r.files.length} dosya</span>
                </label>
              ))}
            </div>
          ) : <div className="card-pad muted small">Tarama klasörü yok. Workspace’ler ekranından ekleyebilirsin.</div>}
        </Card>
        <Card>
          <div className="card-head">
            <Settings2 size={16} />
            <div className="card-title">Claude ayarları</div>
          </div>
          <label className="row clickable" style={{ padding: '10px 18px' }}>
            <input type="checkbox" checked={sel.claude} disabled={!claude.files.length} onChange={() => setSel((s) => ({ ...s, claude: !s.claude }))} />
            <div className="row-main">
              <div className="row-title" style={{ fontWeight: 540 }}>CLAUDE.md, agents, commands, skills</div>
              <div className="row-sub">{claude.files.length ? `${claude.files.length} dosya · ${tildify(claude.dir)}` : 'Bu cihazda yok'}</div>
            </div>
          </label>
        </Card>
      </div>

      <Card className="card-pad">
        <div className="row-flex">
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="strong">Kaydedilecek yer</div>
            <div className="small"><Path>{outDir}/{preview ? preview.fileName : ''}</Path></div>
          </div>
          <Button size="sm" icon={FolderOpen} onClick={async () => { const p = await shell.chooseFolder({ title: 'Paketin kaydedileceği klasör', defaultPath: outDir }); if (p) setOutDir(p); }}>Değiştir</Button>
        </div>
      </Card>

      {preview && preview.warnings.length ? (
        <Banner tone="warn" icon={TriangleAlert}>
          {preview.warnings.map((w, i) => <div key={i}>{(EXPORT_WARNING[w.code] || (() => w.code))(w)}</div>)}
        </Banner>
      ) : null}

      <div className="sticky-foot">
        <div className="small">
          {preview ? <><span className="strong">{preview.files}</span> dosya pakete girecek · {preview.locations.length} parça</> : 'Hesaplanıyor…'}
          <div className="muted">Paketi oluşturmak bu cihazda hiçbir dosyayı değiştirmez.</div>
        </div>
        <div className="spacer" />
        <Button variant="primary" size="lg" icon={PackagePlus} onClick={create} disabled={busy || !preview || !preview.locations.length} data-testid="create-bundle">
          {busy ? 'Oluşturuluyor…' : 'Paketi oluştur'}
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
          <h1 className="page-title">Aktarım</h1>
          <div className="page-sub">Başka cihaza götürmek için paket hazırla ya da başka cihazdan gelen paketi bu cihaza aktar. Her aktarımdan önce bu cihazın yedeği alınır.</div>
        </div>
      </div>
      <div className="tabs">
        <button type="button" className={`tab ${tab === 'import' ? 'on' : ''}`} onClick={() => setTab('import')} data-testid="tab-import"><Download size={15} /> Paket aktar</button>
        <button type="button" className={`tab ${tab === 'export' ? 'on' : ''}`} onClick={() => setTab('export')} data-testid="tab-export"><PackagePlus size={15} /> Paket oluştur</button>
      </div>
      {tab === 'import' ? <ImportWizard initialBundle={params.bundle} initialMode={params.mode} /> : <ExportPanel />}
    </div>
  );
}
