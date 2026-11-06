import { t, has, language } from './i18n.js';

// Paths under the home folder are shown as ~/… (the full path stays in the tooltip and in every action).
let home = null;
export const setHome = (h) => {
  home = h;
};
export function tildify(p) {
  if (!home || typeof p !== 'string') return p;
  const low = (s) => (/^[a-z]:\\/i.test(s) ? s.toLowerCase() : s);
  if (low(p) === low(home)) return '~';
  const sep = home.includes('\\') ? '\\' : '/';
  return low(p).startsWith(low(home) + sep) ? `~${p.slice(home.length)}` : p;
}

// What a project is called. A session of the Claude desktop app that was opened without a folder (a scratch session)
// by its session's title there, or by the day it was started.
export function projectTitle(p) {
  if (!p.isScratch || p.title) return p.title || p.name;
  const m = /scratch-(\d{4})-(\d{2})-(\d{2})/.exec(p.name || '');
  if (!m) return p.name;
  return t('transfer.export.scratchUntitled', { date: new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).toLocaleDateString(language(), { dateStyle: 'medium' }) });
}

// The line under its name: its folder, or for a scratch session what it is (and where its session went, if it moved).
export function projectSub(p, path) {
  if (!p.isScratch) return tildify(path);
  const moved = p.movedTo ? t('transfer.export.scratchMoved', { folder: p.movedTo.split(/[\\/]/).filter(Boolean).pop() }) : null;
  return [t('projects.scratchSession'), moved].filter(Boolean).join(' · ');
}

export function fmtDate(v) {
  const d = v ? new Date(v) : null;
  if (!d || Number.isNaN(d.getTime())) return '-';
  return d.toLocaleString(language(), { dateStyle: 'medium', timeStyle: 'short' });
}

export const fmtTime = (v) => new Date(v).toLocaleTimeString(language(), { timeStyle: 'short' });

export function fmtRelative(v, now = Date.now()) {
  if (!v) return '-';
  const d = new Date(v);
  const s = (now - d.getTime()) / 1000;
  const rel = new Intl.RelativeTimeFormat(language());
  const sameDay = (a, b) => a.toDateString() === b.toDateString();
  if (s < 0) {
    const ahead = -s;
    if (ahead < 3600) return rel.format(Math.max(1, Math.round(ahead / 60)), 'minute');
    if (sameDay(d, new Date(now))) return t('time.today', { time: fmtTime(d) });
    if (sameDay(d, new Date(now + 86400000))) return t('time.tomorrow', { time: fmtTime(d) });
    return fmtDate(d);
  }
  if (s < 60) return t('time.justNow');
  if (s < 3600) return rel.format(-Math.round(s / 60), 'minute');
  if (sameDay(d, new Date(now))) return rel.format(-Math.round(s / 3600), 'hour');
  if (sameDay(d, new Date(now - 86400000))) return t('time.yesterday', { time: fmtTime(d) });
  if (s < 7 * 86400) return rel.format(-Math.round(s / 86400), 'day');
  return fmtDate(d);
}

export function fmtBytes(n) {
  if (n == null) return '-';
  if (n < 1024) return t('units.bytes', { n });
  const one = (x) => x.toLocaleString(language(), { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  if (n < 1024 * 1024) return t('units.kb', { n: one(n / 1024) });
  if (n < 1024 ** 3) return t('units.mb', { n: one(n / 1024 / 1024) });
  return t('units.gb', { n: one(n / 1024 ** 3) });
}

// "3 projects", "1 file" ...: count.<what> in the locale files.
export const count = (what, n) => t(`count.${what}`, { count: n });

// What a bundle or backup holds, from its stats (and number of chats): '5 projects · 17 memory files · 2 workspaces'.
export const contents = (s, chats = 0) => (s ? [count('projects', s.projects), count('memoryFiles', s.memoryFiles), s.workspaceFiles ? count('workspaces', s.workspaceFiles) : null, s.claudeFiles ? count('claudeFiles', s.claudeFiles) : null, chats ? count('chats', chats) : null].filter(Boolean).join(' · ') : '');

// A text from one of the label tables of the locale files ('kind', 'how' ...); undefined for a value the table does not list.
export const label = (table, value, params) => (has(`${table}.${value}`) ? t(`${table}.${value}`, params) : undefined);

export const KIND_TONE = { daily: 'blue', before: 'violet', manual: 'green', backup: 'blue', export: 'accent', full: 'accent' };

// A day of the week by its number (0 Sunday), in the language of the window.
export function weekdayName(day) {
  const d = new Date(2026, 10, 1 + day); // 1 November 2026 is a Sunday.
  return d.toLocaleDateString(language(), { weekday: 'long' });
}

// When the backups are taken: 'Every day at 12:00'.
export function scheduleText(s) {
  if (!s || s.every === 'off') return t('schedule.text.off');
  if (s.every === 'hourly') return t('schedule.text.hourly');
  if (s.every === 'daily') return t('schedule.text.daily', { time: s.time });
  return t('schedule.text.weekly', { day: weekdayName(s.weekday), time: s.time });
}

// Badge colour of a file's fileStatus (new: never bundled, changed, synced).
export const FILE_TONE = { new: 'amber', changed: 'blue', synced: 'green' };

export const HOW_TONE = { self: 'green', saved: 'green', git: 'green', path: 'green', key: 'green', name: 'amber', manual: 'accent', repos: 'green', claude: 'green', scratch: 'green' };

// Sections of the review screen, in display order.
export const GROUP_ORDER = ['conflict', 'new', 'updated', 'deleted', 'index', 'kept'];
export const RESTORE_ORDER = ['new', 'updated', 'deleted'];
const GROUP_TONE = { conflict: 'amber', new: 'green', updated: 'blue', deleted: 'red', index: 'violet', kept: 'gray' };

// { label, desc, tone } of a review section; a restore names the same sections differently.
export function groupMeta(mode, group) {
  const restore = mode === 'restore';
  if (!(restore ? RESTORE_ORDER : GROUP_ORDER).includes(group)) return null;
  const key = `${restore ? 'restoreGroup' : 'group'}.${group}`;
  return { label: t(`${key}.label`), desc: t(`${key}.desc`), tone: GROUP_TONE[group] };
}
