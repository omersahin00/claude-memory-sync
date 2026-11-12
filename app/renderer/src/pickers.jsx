import React, { useState } from 'react';
import { Brain, FolderTree, Settings2, MessagesSquare, FileCode2, ChevronRight, ChevronDown, Layers } from 'lucide-react';
import { Card, Badge, Button } from './ui.jsx';
import { fmtBytes, fmtRelative, count, label, FILE_TONE, tildify, projectTitle, projectSub } from './format.js';
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

export const AllNone = ({ onAll, onNone, allLabel = t('common.selectAll') }) => (
  <>
    <Button size="sm" variant="ghost" onClick={onAll}>{allLabel}</Button>
    <Button size="sm" variant="ghost" onClick={onNone}>{t('common.selectNone')}</Button>
  </>
);

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

// The rest of Claude's data (lib/extras.js), in Backup contents: taken or not. extras: { files, bytes } or null.
export function ExtrasPicker({ extras, on, onChange }) {
  return (
    <Card>
      <CardHead icon={Layers} title={t('backups.full.extras')} />
      <label className="row clickable" style={{ padding: '10px 18px' }}>
        <input type="checkbox" checked={on} onChange={() => onChange(!on)} data-testid="backup-extras" />
        <div className="row-main">
          <div className="row-title" style={{ fontWeight: 540, whiteSpace: 'normal' }}>{t('backups.content.extrasRow')}</div>
          <div className="row-sub" style={{ whiteSpace: 'normal' }}>{on && extras ? `${count('files', extras.files)}, ${fmtBytes(extras.bytes)} · ` : ''}{t('backups.content.extrasSub')}</div>
        </div>
      </label>
    </Card>
  );
}

// The groups of the Claude desktop app's sidebar among the chats, by name: [{ id, name, chats: [[project, chat]], size }].
export function chatGroupsOf(chatProjects) {
  const byId = new Map();
  for (const p of chatProjects) {
    for (const c of p.chats) {
      if (!c.group) continue;
      if (!byId.has(c.group.id)) byId.set(c.group.id, { id: c.group.id, name: c.group.name, chats: [], size: 0 });
      const g = byId.get(c.group.id);
      g.chats.push([p, c]);
      g.size += c.size;
    }
  }
  return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
}

// Projects with what each has: the memory (api.projects()) and the chats (api.chats()), by key. Projects in folders
// first, then the desktop app's sessions without a folder; each by its last change.
export function projectItems(projects, chatProjects) {
  const byKey = new Map();
  for (const p of projects) {
    byKey.set(p.key, { key: p.key, name: p.name, title: p.title, movedTo: p.movedTo, path: p.cwd || p.memoryDir, isScratch: p.isScratch, fileCount: p.fileCount, status: p.status, chats: [], last: p.lastModified || 0 });
  }
  for (const cp of chatProjects) {
    const it = byKey.get(cp.key) || { key: cp.key, name: cp.name, title: cp.title, movedTo: cp.movedTo, path: cp.path, isScratch: cp.isScratch, fileCount: 0, status: null, chats: [], last: 0 };
    it.chats = cp.chats;
    it.last = Math.max(it.last, ...cp.chats.map((c) => c.mtime || 0));
    byKey.set(cp.key, it);
  }
  return [...byKey.values()].sort((a, b) => a.isScratch - b.isScratch || b.last - a.last);
}

// Every project with its memory and its chats, as one list: a project's box takes its memory, a click on the row opens
// its chats. A chat always goes with its project's memory, so a project stays ticked while one of its chats is.
// Above the projects the groups of the desktop app's sidebar, below them its sessions that had no folder.
//   box(it)            { checked, locked } of a project's box: its memory, or its chats when it has no memory
//   onProject(it)      the box was clicked
//   chatBox(it, c)     { checked, locked };  onChat(it, c, on)
//   allChats(it)       optional { checked, indeterminate, label } or null: one box for all of a project's chats; onAllChats(it)
//   groups             from chatGroupsOf; groupBox(g) { checked, indeterminate, note }, onGroup(g)
// head: what stands at the right of the title; toolbar: a line under the title; withStatus: whether each memory is in
// the last bundle.
export function ProjectPicker({ items, title, sub, head, toolbar, box, onProject, chatBox, onChat, allChats, onAllChats, groups = [], groupBox, onGroup, withStatus = false }) {
  const [open, setOpen] = useState(() => new Set());
  const chatRow = (it, c) => {
    const b = chatBox(it, c);
    return (
      <label key={c.id} className="row clickable" style={{ padding: '6px 18px 6px 52px' }} data-chat={c.id}>
        <input type="checkbox" checked={b.checked} disabled={b.locked} onChange={(e) => onChat(it, c, e.target.checked)} aria-label={t('transfer.export.includeFile', { name: c.title || c.id })} />
        <MessagesSquare size={14} style={{ color: 'var(--text-3)', flex: 'none' }} />
        <div className="row-main">
          <div className="row-title" style={{ fontWeight: 500 }} title={c.title || ''}>{c.title || t('transfer.export.untitled')}</div>
          <div className="row-sub">{[c.group ? c.group.name : null, c.entrypoint ? label('entrypoint', c.entrypoint) : null, fmtRelative(c.mtime)].filter(Boolean).join(' · ')}</div>
        </div>
        <span className="muted small">{fmtBytes(c.size)}</span>
      </label>
    );
  };
  const row = (it) => {
    const b = box(it);
    const isOpen = open.has(it.key);
    const Chevron = isOpen ? ChevronDown : ChevronRight;
    const chosen = it.chats.filter((c) => chatBox(it, c).checked).length;
    const memory = !it.fileCount ? t('transfer.export.noMemory') : b.locked ? t('transfer.export.memoryWithChat') : b.checked ? t('transfer.export.memoryGoes') : t('transfer.export.memoryStays');
    const all = allChats && it.chats.length ? allChats(it) : null;
    return (
      <React.Fragment key={it.key}>
        <div className="row clickable" style={{ padding: '8px 18px' }} onClick={() => setOpen((o) => toggled(o, it.key))} aria-expanded={isOpen} data-project={it.key}>
          <input type="checkbox" checked={b.checked} disabled={b.locked} onClick={(e) => e.stopPropagation()} onChange={() => onProject(it)}
            aria-label={t('transfer.export.includeFile', { name: projectTitle(it) })} />
          <Chevron size={14} style={{ color: 'var(--text-3)', flex: 'none' }} />
          <div className="row-main">
            <div className="row-title" style={{ fontWeight: 540 }} title={it.path || ''}>{projectTitle(it)}</div>
            <div className="row-sub" title={it.path || ''}>{projectSub(it, it.path)}</div>
          </div>
          {!withStatus || !it.fileCount || !it.status ? null : it.status.new + it.status.changed ? <Badge tone="amber">{count('changes', it.status.new + it.status.changed)}</Badge> : <Badge tone="green">{t('common.upToDate')}</Badge>}
          <span className="muted small" style={{ flex: 'none' }}>
            {[it.fileCount ? count('memoryFiles', it.fileCount) : null, it.chats.length ? (chosen ? t('transfer.export.someChats', { n: chosen, count: it.chats.length }) : count('chats', it.chats.length)) : null].filter(Boolean).join(' · ')}
          </span>
        </div>
        {isOpen ? (
          <>
            <div className="row" style={{ padding: '6px 18px 6px 52px' }} data-memory={it.key}>
              <Brain size={14} style={{ color: 'var(--text-3)', flex: 'none' }} />
              <div className="row-main">
                <div className="row-title" style={{ fontWeight: 500 }}>{it.fileCount ? t('transfer.export.memoryLine', { files: count('files', it.fileCount) }) : t('transfer.export.noMemory')}</div>
              </div>
              {it.fileCount ? <Badge tone={b.checked ? 'green' : ''}>{memory}</Badge> : null}
            </div>
            {all ? (
              <label className="row clickable" style={{ padding: '6px 18px 6px 52px' }} data-all-chats={it.key}>
                <input type="checkbox" checked={all.checked} onChange={() => onAllChats(it)} ref={(el) => { if (el) el.indeterminate = Boolean(all.indeterminate); }} aria-label={all.label} />
                <MessagesSquare size={14} style={{ color: 'var(--text-3)', flex: 'none' }} />
                <div className="row-main"><div className="row-title" style={{ fontWeight: 540 }}>{all.label}</div></div>
                <span className="muted small">{count('chats', it.chats.length)}</span>
              </label>
            ) : null}
            {it.chats.map((c) => chatRow(it, c))}
          </>
        ) : null}
      </React.Fragment>
    );
  };
  const normal = items.filter((it) => !it.isScratch);
  const scratch = items.filter((it) => it.isScratch);
  return (
    <Card>
      <CardHead icon={Brain} title={title} sub={sub}>{head}</CardHead>
      {toolbar}
      {groups.length ? (
        <>
          <div className="group-head"><div className="group-desc">{t('transfer.export.groups')}</div></div>
          <div className="rows">
            {groups.map((g) => {
              const b = groupBox(g);
              return (
                <label key={g.id} className="row clickable" style={{ padding: '8px 18px' }} data-chat-group={g.name}>
                  <input type="checkbox" checked={b.checked} disabled={b.locked} onChange={() => onGroup(g)}
                    ref={(el) => { if (el) el.indeterminate = b.indeterminate; }} aria-label={t('transfer.export.includeFile', { name: g.name })} />
                  <Layers size={14} style={{ color: 'var(--text-3)', flex: 'none' }} />
                  <div className="row-main">
                    <div className="row-title" style={{ fontWeight: 540 }}>{g.name}</div>
                    <div className="row-sub">{t('transfer.export.groupSub', { size: fmtBytes(g.size) })}</div>
                  </div>
                  <span className="muted small">{b.note}</span>
                </label>
              );
            })}
          </div>
        </>
      ) : null}
      {normal.length ? (
        <>
          <div className="group-head"><div className="group-desc">{t('transfer.export.folders')}</div></div>
          <div className="rows">{normal.map(row)}</div>
        </>
      ) : null}
      {scratch.length ? (
        <>
          <div className="group-head"><div className="group-desc">{t('transfer.export.scratch')}</div></div>
          <div className="rows">{scratch.map(row)}</div>
        </>
      ) : null}
      {items.length ? null : <div className="card-pad muted small">{t('transfer.export.noProjects')}</div>}
    </Card>
  );
}
