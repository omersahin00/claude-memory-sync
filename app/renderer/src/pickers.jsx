import React, { useState } from 'react';
import { Brain, FolderTree, Settings2, MessagesSquare, FileCode2, ChevronRight, ChevronDown } from 'lucide-react';
import { Card, Badge, Button } from './ui.jsx';
import { fmtBytes, fmtRelative, count, label, FILE_TONE, tildify } from './format.js';
import { t } from './i18n.js';

// Lists to tick what goes into a bundle (Create bundle) or into backups (Backup contents).

const toggled = (set, key) => {
  const next = new Set(set);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  return next;
};

function CardHead({ icon: Icon, title, sub, children }) {
  return (
    <div className="card-head">
      <Icon size={16} />
      <div>
        <div className="card-title">{title}</div>
        {sub ? <div className="card-sub">{sub}</div> : null}
      </div>
      <div className="spacer" />
      {children}
    </div>
  );
}

export const AllNone = ({ onAll, onNone }) => (
  <>
    <Button size="sm" variant="ghost" onClick={onAll}>{t('common.selectAll')}</Button>
    <Button size="sm" variant="ghost" onClick={onNone}>{t('common.selectNone')}</Button>
  </>
);

// Project memories. picked: Set of project keys. withStatus: whether each one is in the last bundle (Create bundle).
// Select all leaves the Claude app's scratch sessions out unless withScratch.
export function MemoryPicker({ projects, picked, onChange, sub, withStatus = false, withScratch = false }) {
  const normal = projects.filter((p) => !p.isScratch);
  const scratch = projects.filter((p) => p.isScratch);
  const row = (p) => (
    <label key={p.id} className="row clickable" style={{ padding: '8px 18px' }}>
      <input type="checkbox" checked={picked.has(p.key)} onChange={() => onChange(toggled(picked, p.key))} />
      <div className="row-main">
        <div className="row-title" style={{ fontWeight: 540 }}>{p.name}</div>
        <div className="row-sub" title={p.cwd || p.memoryDir}>{tildify(p.cwd || p.memoryDir)}</div>
      </div>
      {!withStatus ? null : p.status.new + p.status.changed ? <Badge tone="amber">{count('changes', p.status.new + p.status.changed)}</Badge> : <Badge tone="green">{t('common.upToDate')}</Badge>}
      <span className="col-n muted small">{count('files', p.fileCount)}</span>
    </label>
  );
  return (
    <Card>
      <CardHead icon={Brain} title={t('common.projectMemories')} sub={sub}>
        <AllNone onAll={() => onChange(new Set((withScratch ? projects : normal).map((p) => p.key)))} onNone={() => onChange(new Set())} />
      </CardHead>
      <div className="rows">{normal.map(row)}</div>
      {scratch.length ? (
        <>
          <div className="group-head"><div className="group-desc">{t('transfer.export.scratch')}</div></div>
          <div className="rows">{scratch.map(row)}</div>
        </>
      ) : null}
    </Card>
  );
}

// Workspace files: the roots ticked (Set of keys) and the files left out of each ({ [root key]: [rel] });
// onChange({ picked, skip }).
export function WorkspacePicker({ roots, picked, skip, onChange, sub, withStatus = false }) {
  // Files of a root that stay out: all of them when the root is not ticked.
  const skipOf = (r) => new Set(picked.has(r.key) ? skip[r.key] || [] : r.files.map((f) => f.rel));
  const toggleRoot = (r) => {
    const next = new Set(picked);
    if (picked.has(r.key) && !(skip[r.key] || []).length) next.delete(r.key);
    else next.add(r.key);
    onChange({ picked: next, skip: { ...skip, [r.key]: [] } });
  };
  const toggleFile = (r, rel) => {
    const out = skipOf(r);
    if (out.has(rel)) out.delete(rel);
    else out.add(rel);
    const next = new Set(picked);
    if (out.size === r.files.length) {
      next.delete(r.key);
      out.clear();
    } else next.add(r.key);
    onChange({ picked: next, skip: { ...skip, [r.key]: [...out] } });
  };
  const setAll = (on) => onChange({ picked: new Set(on ? roots.filter((r) => r.exists && r.files.length).map((r) => r.key) : []), skip: {} });
  return (
    <Card>
      <CardHead icon={FolderTree} title={t('common.workspaceFiles')} sub={sub}>
        {roots.length ? <AllNone onAll={() => setAll(true)} onNone={() => setAll(false)} /> : null}
      </CardHead>
      {roots.length ? (
        <div className="rows">
          {roots.map((r) => {
            const out = skipOf(r);
            const chosen = r.files.length - out.size;
            const checked = picked.has(r.key) && (chosen > 0 || !r.files.length);
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
                    <input type="checkbox" checked={!out.has(f.rel)} onChange={() => toggleFile(r, f.rel)} aria-label={t('transfer.export.includeFile', { name: f.rel })} />
                    <FileCode2 size={14} style={{ color: 'var(--text-3)', flex: 'none' }} />
                    <div className="row-main">
                      <div className="row-title" style={{ fontWeight: 500 }} title={f.path}>{f.rel}</div>
                    </div>
                    <span className="muted small">{count('folders', f.folders.length)}</span>
                    {withStatus ? <Badge tone={FILE_TONE[f.status]}>{label('fileStatus', f.status)}</Badge> : null}
                  </label>
                )) : null}
              </React.Fragment>
            );
          })}
        </div>
      ) : <div className="card-pad muted small">{t('transfer.export.noRoots')}</div>}
    </Card>
  );
}

export function ClaudePicker({ claude, on, onChange }) {
  return (
    <Card>
      <CardHead icon={Settings2} title={t('common.claudeSettings')} />
      <label className="row clickable" style={{ padding: '10px 18px' }}>
        <input type="checkbox" checked={on} disabled={!claude.files.length} onChange={() => onChange(!on)} />
        <div className="row-main">
          <div className="row-title" style={{ fontWeight: 540 }}>CLAUDE.md, agents, commands, skills</div>
          <div className="row-sub">{claude.files.length ? `${count('files', claude.files.length)} · ${tildify(claude.dir)}` : t('common.notOnDevice')}</div>
        </div>
      </label>
    </Card>
  );
}

// Chats by project, each project opened to its chats with a click.
//   box(p)            { checked, indeterminate, note } of a project's box
//   onProject(p)      its box was clicked
//   isOn(p, c)        whether a chat is ticked; locked(p): its chats are all in through the project's box
//   onChat(p, c, on)  a chat's box was clicked
// head: what stands at the right of the title (select all / none, a mode); body: shown instead of the list.
export function ChatPicker({ chatProjects, sub, head, body, box, onProject, isOn, locked = () => false, onChat }) {
  const [open, setOpen] = useState(() => new Set());
  return (
    <Card>
      <CardHead icon={MessagesSquare} title={t('common.chats')} sub={sub}>{head}</CardHead>
      {body || (chatProjects.length ? (
        <div className="rows">
          {chatProjects.map((p) => {
            const b = box(p);
            const isOpen = open.has(p.key);
            const Chevron = isOpen ? ChevronDown : ChevronRight;
            return (
              <React.Fragment key={p.key}>
                <div className="row clickable" style={{ padding: '8px 18px' }} onClick={() => setOpen((o) => toggled(o, p.key))} aria-expanded={isOpen} data-chat-project={p.key}>
                  <input type="checkbox" checked={b.checked} onClick={(e) => e.stopPropagation()} onChange={() => onProject(p)}
                    ref={(el) => { if (el) el.indeterminate = b.indeterminate; }} aria-label={t('transfer.export.includeFile', { name: p.name })} />
                  <Chevron size={14} style={{ color: 'var(--text-3)', flex: 'none' }} />
                  <div className="row-main">
                    <div className="row-title" style={{ fontWeight: 540 }}>{p.name}</div>
                    {p.path ? <div className="row-sub" title={p.path}>{tildify(p.path)}</div> : null}
                  </div>
                  <span className="muted small">{b.note}</span>
                </div>
                {isOpen ? p.chats.map((c) => (
                  <label key={c.id} className="row clickable" style={{ padding: '6px 18px 6px 44px' }} data-chat={c.id}>
                    <input type="checkbox" checked={locked(p) || isOn(p, c)} disabled={locked(p)} onChange={(e) => onChat(p, c, e.target.checked)} aria-label={t('transfer.export.includeFile', { name: c.title || c.id })} />
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
      ) : <div className="card-pad muted small">{t('transfer.export.noChats')}</div>)}
    </Card>
  );
}
