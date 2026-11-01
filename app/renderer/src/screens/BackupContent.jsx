import React, { useEffect, useMemo, useState } from 'react';
import { Info, TriangleAlert } from 'lucide-react';
import { api, errorText } from '../api.js';
import { useApp, Button, Modal, Banner, Loading, Segmented } from '../ui.jsx';
import { fmtBytes, count, contents } from '../format.js';
import { t } from '../i18n.js';
import { ProjectPicker, WorkspacePicker, ClaudePicker, AllNone, chatGroupsOf, projectItems } from '../pickers.jsx';

const CHAT_MODES = ['none', 'all', 'some'];

// One line for what backups take, from api.backupPreview(): '5 projects · 17 memory files · 2 workspaces · no chats'.
export const backupSummary = (preview, mode) => [contents(preview.stats, preview.chats.count), mode === 'none' ? t('backups.content.noChats') : null].filter(Boolean).join(' · ');

// Settings → Backup contents: what daily and manual backups take. What is not ticked is left out by name, so new
// projects and workspace files go in; chats go in only when chosen, and always with their project's memory.
export default function BackupContent({ onClose }) {
  const { toast, refresh } = useApp();
  const [data, setData] = useState(null);
  const [draft, setDraft] = useState(null);
  const [preview, setPreview] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    Promise.all([api.settings(), api.projects(), api.workspaces(), api.claudeConfig(), api.chats()])
      .then(([s, p, w, c, ch]) => {
        const b = s.backup;
        const noProjects = new Set(b.excludeProjects);
        const noRoots = new Set(b.excludeRoots);
        setData({ saved: b, keep: s.daily.keep, items: projectItems(p.projects, ch), groups: chatGroupsOf(ch), roots: w, claude: c });
        setDraft({
          projects: new Set(p.projects.filter((x) => !noProjects.has(x.key)).map((x) => x.key)),
          roots: new Set(w.filter((r) => r.exists && !noRoots.has(r.key)).map((r) => r.key)),
          skip: b.excludeWorkspaceFiles,
          claude: b.claude,
          chats: b.chats,
          chatProjects: new Set(b.chatProjects),
          chatGroups: new Set(b.chatGroups),
          chatIds: new Set(b.chatIds),
        });
      })
      .catch((e) => toast(errorText(e), 'error'));
  }, [toast]);

  // Back to the settings. What is left out but not on this device right now stays left out.
  const backup = useMemo(() => {
    if (!draft) return null;
    const projectKeys = new Set(data.items.filter((it) => it.fileCount > 0).map((it) => it.key));
    const rootKeys = new Set(data.roots.filter((r) => r.exists).map((r) => r.key));
    return {
      excludeProjects: [...data.saved.excludeProjects.filter((k) => !projectKeys.has(k)), ...[...projectKeys].filter((k) => !draft.projects.has(k))],
      excludeRoots: [...data.saved.excludeRoots.filter((k) => !rootKeys.has(k)), ...[...rootKeys].filter((k) => !draft.roots.has(k))],
      excludeWorkspaceFiles: Object.fromEntries(Object.entries(draft.skip).filter(([k, v]) => v.length && (draft.roots.has(k) || !rootKeys.has(k)))),
      claude: draft.claude,
      chats: draft.chats,
      chatProjects: [...draft.chatProjects],
      chatGroups: [...draft.chatGroups],
      chatIds: [...draft.chatIds],
    };
  }, [draft, data]);

  useEffect(() => {
    if (!backup) return undefined;
    const timer = setTimeout(() => api.backupPreview(backup).then(setPreview).catch(() => {}), 150);
    return () => clearTimeout(timer);
  }, [backup]);

  const set = (patch) => setDraft((d) => ({ ...d, ...patch }));
  const some = draft && draft.chats === 'some';
  // Whether a chat goes in, and whether that is decided by a box above it (all chats, its project's or its group's).
  const viaGroup = (c) => Boolean(c.group && draft.chatGroups.has(c.group.id));
  const chatIn = (key, c) => draft.chats === 'all' || (some && (draft.chatProjects.has(key) || draft.chatIds.has(c.id) || viaGroup(c)));
  const chatLocked = (key, c) => !some || draft.chatProjects.has(key) || viaGroup(c);
  const chatsIn = (it) => it.chats.filter((c) => chatIn(it.key, c)).length;
  // A box that takes a set of chats, new ones too (a project's, a group's): its single chats are then decided by it.
  const toggleWhole = (field, id, chats) => {
    const whole = new Set(draft[field]);
    const chatIds = new Set(draft.chatIds);
    if (whole.has(id)) whole.delete(id);
    else whole.add(id);
    for (const c of chats) chatIds.delete(c.id);
    set({ [field]: whole, chatIds });
  };
  // A project's box: its memory; a project without memory takes all its chats through it.
  const toggleProject = (it) => {
    if (!it.fileCount) return toggleWhole('chatProjects', it.key, it.chats);
    const projects = new Set(draft.projects);
    if (projects.has(it.key)) projects.delete(it.key);
    else projects.add(it.key);
    return set({ projects });
  };
  const toggleChat = (it, c, on) => {
    const chatIds = new Set(draft.chatIds);
    if (on) chatIds.add(c.id);
    else chatIds.delete(c.id);
    set({ chatIds });
  };
  const empty = preview && !preview.locations && !preview.chats.count;
  const save = async () => {
    setBusy(true);
    try {
      await api.updateSettings({ backup });
      toast(t('backups.content.saved'));
      refresh();
      onClose();
    } catch (e) {
      toast(errorText(e), 'error');
      setBusy(false);
    }
  };

  const footer = (
    <>
      <div className="small" style={{ flex: 1, minWidth: 0 }}>
        {preview && draft ? t('backups.content.estimate', { contents: backupSummary(preview, draft.chats), size: fmtBytes(preview.bytes + preview.chats.bytes) }) : t('common.calculating')}
        {preview && preview.chats.count ? <div className="muted">{t('backups.content.dailyTotal', { keep: data.keep, total: fmtBytes((preview.bytes + preview.chats.bytes) * data.keep) })}</div> : null}
      </div>
      <Button onClick={onClose}>{t('common.cancel')}</Button>
      <Button variant="primary" onClick={save} disabled={busy || !preview || empty} data-testid="backup-content-save">{t('common.save')}</Button>
    </>
  );

  let chatsNote = null;
  if (draft && draft.chats === 'none') chatsNote = t('backups.content.chatsNone');
  else if (draft && draft.chats === 'all') chatsNote = t('backups.content.chatsAll', { chats: preview ? t('transfer.export.chatsCount', { count: preview.chats.count, size: fmtBytes(preview.chats.bytes) }) : '…' });
  else if (draft) chatsNote = t('backups.content.chatsSome');

  // Which chats go in: none, all, or the ones ticked in the list below.
  const toolbar = draft ? (
    <div className="row" style={{ padding: '10px 18px', borderTop: '1px solid var(--border)' }}>
      <div className="row-main">
        <div style={{ fontWeight: 540 }}>{t('backups.content.chatsLabel')}</div>
        <div className="muted small" style={{ whiteSpace: 'normal' }}>{chatsNote}{draft.chats !== 'none' ? ` ${t('backups.content.chatsSub')}` : ''}</div>
      </div>
      <div className="row-side">
        <Segmented value={draft.chats} options={CHAT_MODES.map((v) => ({ value: v, label: t(`backups.content.chatModes.${v}`) }))} onChange={(v) => set({ chats: v })} />
      </div>
    </div>
  ) : null;

  return (
    <Modal title={t('settings.backup.content')} onClose={onClose} footer={footer} wide>
      {!draft ? <Loading /> : (
        <div className="stack">
          <Banner tone="info" icon={Info}>{t('backups.content.intro')}</Banner>
          <ProjectPicker
            items={data.items}
            title={t('transfer.export.projectsTitle')}
            sub={t('backups.content.projectsSub')}
            head={<AllNone allLabel={t('transfer.export.allMemories')} onAll={() => set({ projects: new Set(data.items.filter((it) => it.fileCount).map((it) => it.key)) })} onNone={() => set({ projects: new Set() })} />}
            toolbar={toolbar}
            box={(it) => {
              const n = chatsIn(it);
              return it.fileCount
                ? { checked: draft.projects.has(it.key) || n > 0, locked: n > 0 }
                : { checked: n > 0, locked: !some };
            }}
            onProject={toggleProject}
            chatBox={(it, c) => ({ checked: chatIn(it.key, c), locked: chatLocked(it.key, c) })}
            onChat={toggleChat}
            allChats={some ? (it) => ({ checked: draft.chatProjects.has(it.key), label: t('backups.content.allChats') }) : null}
            onAllChats={(it) => toggleWhole('chatProjects', it.key, it.chats)}
            groups={some ? data.groups : []}
            groupBox={(g) => {
              const whole = draft.chatGroups.has(g.id);
              const n = g.chats.filter(([p, c]) => chatIn(p.key, c)).length;
              return {
                checked: whole || n > 0,
                indeterminate: !whole && n > 0,
                note: whole ? t('backups.content.projectAll', { count: g.chats.length }) : n ? t('transfer.export.someChats', { n, count: g.chats.length }) : count('chats', g.chats.length),
              };
            }}
            onGroup={(g) => toggleWhole('chatGroups', g.id, g.chats.map(([, c]) => c))}
          />
          <WorkspacePicker roots={data.roots} picked={draft.roots} skip={draft.skip} onChange={({ picked, skip }) => set({ roots: picked, skip })} sub={t('backups.content.wsSub')} />
          <ClaudePicker claude={data.claude} on={draft.claude} onChange={(v) => set({ claude: v })} />
          {empty ? <Banner tone="warn" icon={TriangleAlert}>{t('backups.content.empty')}</Banner> : null}
        </div>
      )}
    </Modal>
  );
}
