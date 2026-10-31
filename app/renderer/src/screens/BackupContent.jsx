import React, { useEffect, useMemo, useState } from 'react';
import { Info, TriangleAlert } from 'lucide-react';
import { api, errorText } from '../api.js';
import { useApp, Button, Modal, Banner, Loading, Segmented } from '../ui.jsx';
import { fmtBytes, count, contents } from '../format.js';
import { t } from '../i18n.js';
import { MemoryPicker, WorkspacePicker, ClaudePicker, ChatPicker } from '../pickers.jsx';

const CHAT_MODES = ['none', 'all', 'some'];

// One line for what backups take, from api.backupPreview(): '5 projects · 17 memory files · 2 workspaces · no chats'.
export const backupSummary = (preview, mode) => [contents(preview.stats, preview.chats.count), mode === 'none' ? t('backups.content.noChats') : null].filter(Boolean).join(' · ');

// Settings → Backup contents: what daily and manual backups take. What is not ticked is left out by name, so new
// projects and workspace files go in; chats go in only when chosen.
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
        setData({ saved: b, keep: s.daily.keep, projects: p.projects, roots: w, claude: c, chatProjects: ch });
        setDraft({
          projects: new Set(p.projects.filter((x) => !noProjects.has(x.key)).map((x) => x.key)),
          roots: new Set(w.filter((r) => r.exists && !noRoots.has(r.key)).map((r) => r.key)),
          skip: b.excludeWorkspaceFiles,
          claude: b.claude,
          chats: b.chats,
          chatProjects: new Set(b.chatProjects),
          chatIds: new Set(b.chatIds),
        });
      })
      .catch((e) => toast(errorText(e), 'error'));
  }, [toast]);

  // Back to the settings. What is left out but not on this device right now stays left out.
  const backup = useMemo(() => {
    if (!draft) return null;
    const projectKeys = new Set(data.projects.map((p) => p.key));
    const rootKeys = new Set(data.roots.filter((r) => r.exists).map((r) => r.key));
    return {
      excludeProjects: [...data.saved.excludeProjects.filter((k) => !projectKeys.has(k)), ...[...projectKeys].filter((k) => !draft.projects.has(k))],
      excludeRoots: [...data.saved.excludeRoots.filter((k) => !rootKeys.has(k)), ...[...rootKeys].filter((k) => !draft.roots.has(k))],
      excludeWorkspaceFiles: Object.fromEntries(Object.entries(draft.skip).filter(([k, v]) => v.length && (draft.roots.has(k) || !rootKeys.has(k)))),
      claude: draft.claude,
      chats: draft.chats,
      chatProjects: [...draft.chatProjects],
      chatIds: [...draft.chatIds],
    };
  }, [draft, data]);

  useEffect(() => {
    if (!backup) return undefined;
    const timer = setTimeout(() => api.backupPreview(backup).then(setPreview).catch(() => {}), 150);
    return () => clearTimeout(timer);
  }, [backup]);

  const set = (patch) => setDraft((d) => ({ ...d, ...patch }));
  const singles = (p) => p.chats.filter((c) => draft.chatIds.has(c.id)).length;
  // A project's box takes all its chats, new ones too; its single chats are then decided by the box.
  const toggleProject = (p) => {
    const chatProjects = new Set(draft.chatProjects);
    const chatIds = new Set(draft.chatIds);
    if (chatProjects.has(p.key)) chatProjects.delete(p.key);
    else chatProjects.add(p.key);
    for (const c of p.chats) chatIds.delete(c.id);
    set({ chatProjects, chatIds });
  };
  const toggleChat = (p, c, on) => {
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

  return (
    <Modal title={t('settings.backup.content')} onClose={onClose} footer={footer} wide>
      {!draft ? <Loading /> : (
        <div className="stack">
          <Banner tone="info" icon={Info}>{t('backups.content.intro')}</Banner>
          <MemoryPicker projects={data.projects} picked={draft.projects} onChange={(v) => set({ projects: v })} sub={t('backups.content.memorySub')} withScratch />
          <ChatPicker
            chatProjects={data.chatProjects}
            sub={t('backups.content.chatsSub')}
            head={<Segmented value={draft.chats} options={CHAT_MODES.map((v) => ({ value: v, label: t(`backups.content.chatModes.${v}`) }))} onChange={(v) => set({ chats: v })} />}
            body={chatsNote && data.chatProjects.length ? <div className="card-pad muted small">{chatsNote}</div> : null}
            box={(p) => {
              const whole = draft.chatProjects.has(p.key);
              const n = singles(p);
              return {
                checked: whole || n > 0,
                indeterminate: !whole && n > 0,
                note: whole ? t('backups.content.projectAll', { count: p.chats.length }) : n ? t('transfer.export.someChats', { n, count: p.chats.length }) : count('chats', p.chats.length),
              };
            }}
            onProject={toggleProject}
            isOn={(p, c) => draft.chatIds.has(c.id)}
            locked={(p) => draft.chatProjects.has(p.key)}
            onChat={toggleChat}
          />
          <WorkspacePicker roots={data.roots} picked={draft.roots} skip={draft.skip} onChange={({ picked, skip }) => set({ roots: picked, skip })} sub={t('backups.content.wsSub')} />
          <ClaudePicker claude={data.claude} on={draft.claude} onChange={(v) => set({ claude: v })} />
          {empty ? <Banner tone="warn" icon={TriangleAlert}>{t('backups.content.empty')}</Banner> : null}
        </div>
      )}
    </Modal>
  );
}
