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
  return t('units.mb', { n: one(n / 1024 / 1024) });
}

// "3 projects", "1 file" ...: count.<what> in the locale files.
export const count = (what, n) => t(`count.${what}`, { count: n });

// What a bundle or backup holds, from its stats (and number of chats): '5 projects · 17 memory files · 2 workspaces'.
export const contents = (s, chats = 0) => (s ? [count('projects', s.projects), count('memoryFiles', s.memoryFiles), s.workspaceFiles ? count('workspaces', s.workspaceFiles) : null, s.claudeFiles ? count('claudeFiles', s.claudeFiles) : null, chats ? count('chats', chats) : null].filter(Boolean).join(' · ') : '');

// A text from one of the label tables of the locale files ('kind', 'how' ...); undefined for a value the table does not list.
export const label = (table, value, params) => (has(`${table}.${value}`) ? t(`${table}.${value}`, params) : undefined);

export const KIND_TONE = { daily: 'blue', before: 'violet', manual: 'green', export: 'accent', full: 'accent' };

// Badge colour of a file's fileStatus (new: never bundled, changed, synced).
export const FILE_TONE = { new: 'amber', changed: 'blue', synced: 'green' };

export const HOW_TONE = { self: 'green', saved: 'green', git: 'green', path: 'green', key: 'green', name: 'amber', manual: 'accent', repos: 'green', claude: 'green' };

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
