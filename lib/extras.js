'use strict';
// The rest of Claude's data, for full backups: what is not a memory, a chat, a workspace file or a Claude setting
// (claude-config.js), yet is gone after a reset. A full backup keeps it as it is, and a full restore puts it back where it
// was, on the same system. Kept in a full backup as 'extra/<area>/...':
//   claude/<rel>             the rest of the Claude folder: settings.json, keybindings, hooks, scheduled tasks, plugins,
//                            plans, to-dos, the prompt history (merged on restore) and whatever else Claude Code keeps there
//   projects/<folder>/<rel>  files in a Claude project folder that are neither its memory nor its chats
//   desktop/<rel>            the Claude desktop app's: Cowork sessions, scheduled tasks, the marks of deleted sessions,
//                            files of sessions without a folder, and its settings file (merged on restore)
//   repo/<key>/<rel>         a project's own Claude files that git leaves out: .claude/settings.local.json, CLAUDE.local.md
//   config                   Claude Code's settings in .claude.json: MCP servers, preferences, and each project's allowed
//                            tools, servers and trust (merged on restore)
// Left out: what Claude makes again (caches, the running sessions' state, downloaded programs) and what is of this
// computer only or a secret (the login, this computer's ids, the desktop app's browser profile).
const fs = require('fs');
const path = require('path');
const C = require('./chats');
const { CLAUDE_ITEMS } = require('./claude-config');
const { TMP_MARK } = require('./fsx');

// The Claude folder: taken by the other parts of a backup, or left out.
const TAKEN = new Set(['projects', 'file-history', 'uploads', ...CLAUDE_ITEMS]);
const LEFT_OUT = new Set([
  '.credentials.json', '.claude.json', 'backups', 'cache', 'daemon', 'debug', 'downloads', 'ide', 'jobs', 'local', 'paste-cache',
  'session-env', 'sessions', 'shell-snapshots', 'spares', 'state', 'statsig', 'telemetry', 'stats-cache.json',
  'mcp-needs-auth-cache.json', '.last-cleanup', '.last-update-result.json',
]);
// Plugins come back whole, but for what the account fills in and the directory's cache.
const PLUGINS_LEFT_OUT = /^plugins\/(synced(\/|$)|plugin-directory-cache[^/]*$)/;
const JUNK = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini']);
const junk = (rel) => rel.split('/').some((seg) => JUNK.has(seg) || seg.includes(TMP_MARK));

// The desktop app's folder: these, and its settings file. A record of a Code session (local_<id>.json) goes with its chat.
const DESKTOP_DIRS = ['claude-code-sessions', 'local-agent-mode-sessions', 'scratch-workspaces'];
const RECORD = /^claude-code-sessions\/[^/]+\/[^/]+\/local_[\w-]+\.json$/;

// A project's own files that are not in git.
const REPO_FILES = ['.claude/settings.local.json', 'CLAUDE.local.md'];

// .claude.json: the settings in it, not its caches, counters, account or this computer's ids.
const CONFIG_KEYS = ['mcpServers', 'theme', 'verbose', 'editorMode', 'autoCompactEnabled', 'preferredNotifChannel', 'autoConnectIde',
  'autoInstallIdeExtension', 'diffTool', 'autoUpdates', 'messageIdleNotifThresholdMs'];
const PROJECT_KEYS = ['allowedTools', 'mcpServers', 'enabledMcpjsonServers', 'disabledMcpjsonServers', 'mcpContextUris',
  'hasTrustDialogAccepted', 'hasClaudeMdExternalIncludesApproved', 'hasClaudeMdExternalIncludesWarningShown'];

// Files with paths in them, written under another home folder with that folder's paths.
const TEXT = /\.(json|jsonl|md|txt|sh|bash|zsh|ps1|cmd|bat|py|js|mjs|cjs|ts|toml|ya?ml)$/i;
const isText = (rel, buf) => TEXT.test(rel) && !buf.includes(0);

// Merged on restore instead of written over.
const MERGED = { history: 'extra/claude/history.jsonl', config: 'extra/config', desktop: `extra/desktop/${C.DESKTOP_CONFIG}` };

const isObj = (x) => Boolean(x) && typeof x === 'object' && !Array.isArray(x);
const parse = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

// Claude Code's .claude.json: in the Claude folder when CLAUDE_CONFIG_DIR names one, else in the home folder.
const configPath = (env, home) => (env.CLAUDE_CONFIG_DIR ? path.join(path.resolve(env.CLAUDE_CONFIG_DIR), '.claude.json') : path.join(home, '.claude.json'));

// Execute bits, which hooks, status line scripts and plugins need.
function modeOf(st) {
  const m = st.mode & 0o777;
  return m & 0o111 ? m : undefined;
}

function fileEntry(abs) {
  try {
    const st = fs.statSync(abs);
    return st.isFile() ? { abs, size: st.size, mode: modeOf(st) } : null;
  } catch {
    return null;
  }
}

// Claude Code's settings in .claude.json, or null when it has none.
function configSubset(text) {
  const obj = parse(text);
  if (!isObj(obj)) return null;
  const out = {};
  for (const k of CONFIG_KEYS) if (obj[k] !== undefined) out[k] = obj[k];
  const projects = {};
  for (const [p, v] of Object.entries(isObj(obj.projects) ? obj.projects : {})) {
    if (!isObj(v)) continue;
    const kept = {};
    for (const k of PROJECT_KEYS) if (v[k] !== undefined) kept[k] = v[k];
    // Defaults Claude Code writes for every folder it opens are not worth keeping.
    const empty = Object.entries(kept).every(([, x]) => x === false || (Array.isArray(x) ? !x.length : isObj(x) && !Object.keys(x).length));
    if (!empty) projects[p] = kept;
  }
  if (Object.keys(projects).length) out.projects = projects;
  return Object.keys(out).length ? out : null;
}

// What a full backup takes besides memories, chats, workspace files and Claude settings: 'extra/...' -> { abs, size,
// mode } (a file) or { buf } (.claude.json's settings). projects: [{ key, path }], this device's Claude projects.
function collect({ claudeDir, desktopDir, configFile, projects = [] }) {
  const out = new Map();
  // A name a bundle could not hold (one segment with a backslash) is left out, not the whole backup.
  const add = (rel, abs) => {
    if (junk(rel) || !parseRel(rel)) return;
    const e = fileEntry(abs);
    if (e) out.set(rel, e);
  };
  let top = [];
  try {
    top = fs.readdirSync(claudeDir, { withFileTypes: true });
  } catch { /* no Claude folder */ }
  for (const d of top) {
    if (TAKEN.has(d.name) || LEFT_OUT.has(d.name)) continue;
    const abs = path.join(claudeDir, d.name);
    // A link (settings.json kept in a dotfiles repository) is taken by what it points to.
    let st = d;
    if (d.isSymbolicLink()) {
      try {
        st = fs.statSync(abs);
      } catch {
        continue;
      }
    }
    if (st.isFile()) add(`extra/claude/${d.name}`, abs);
    else if (st.isDirectory()) {
      for (const [rel, f] of C.walk(abs, d.name)) if (!PLUGINS_LEFT_OUT.test(rel)) add(`extra/claude/${rel}`, f);
    }
  }
  // Anything in a project folder but its memory and its chats (<id>.jsonl and <id>/).
  let folders = [];
  try {
    folders = fs.readdirSync(path.join(claudeDir, 'projects'), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch { /* none */ }
  for (const folder of folders) {
    for (const [rel, abs] of C.walk(path.join(claudeDir, 'projects', folder))) {
      const first = rel.split('/')[0];
      if (first === 'memory' || (first.endsWith('.jsonl') && C.ID_RE.test(first.slice(0, -'.jsonl'.length))) || (C.ID_RE.test(first) && first !== rel)) continue;
      add(`extra/projects/${folder}/${rel}`, abs);
    }
  }
  if (desktopDir) {
    add(MERGED.desktop, path.join(desktopDir, C.DESKTOP_CONFIG));
    for (const dir of DESKTOP_DIRS) {
      for (const [rel, abs] of C.walk(path.join(desktopDir, dir), dir)) if (!RECORD.test(rel)) add(`extra/desktop/${rel}`, abs);
    }
  }
  for (const p of projects) {
    if (!p.path) continue;
    for (const rel of REPO_FILES) add(`extra/repo/${p.key}/${rel}`, path.join(p.path, ...rel.split('/')));
  }
  let config = null;
  try {
    config = configSubset(fs.readFileSync(configFile, 'utf8'));
  } catch { /* none */ }
  if (config) out.set(MERGED.config, { buf: Buffer.from(JSON.stringify(config), 'utf8') });
  return out;
}

// 'extra/...' taken apart: { area, rel } for claude and desktop, { area, scope, rel } for projects and repo, { area } for
// config; null for anything else or a path that could leave its folder.
const SAFE_SEG = (s) => typeof s === 'string' && s !== '' && s !== '.' && s !== '..' && !/[\\/\x00]/.test(s);
function parseRel(rel) {
  if (rel === MERGED.config) return { area: 'config' };
  const m = /^extra\/(claude|desktop|projects|repo)\/(.+)$/.exec(String(rel));
  if (!m) return null;
  const segs = m[2].split('/');
  if (!segs.every(SAFE_SEG)) return null;
  if (m[1] === 'claude' || m[1] === 'desktop') return { area: m[1], rel: m[2] };
  if (segs.length < 2) return null;
  return { area: m[1], scope: segs[0], rel: segs.slice(1).join('/') };
}

// Two settings objects, the second over the first: objects are merged key by key; lists of { id } items keep the items of
// both (the second's for the same id); anything else is the second's.
function deepMerge(a, b) {
  if (isObj(a) && isObj(b)) {
    const out = { ...a };
    for (const [k, v] of Object.entries(b)) out[k] = k in a ? deepMerge(a[k], v) : v;
    return out;
  }
  const byId = (xs) => Array.isArray(xs) && xs.length && xs.every((x) => isObj(x) && typeof x.id === 'string');
  if (byId(a) && byId(b)) {
    const ids = new Map(b.map((x) => [x.id, x]));
    return [...a.map((x) => (ids.has(x.id) ? deepMerge(x, ids.get(x.id)) : x)), ...b.filter((x) => !a.some((y) => y.id === x.id))];
  }
  return b;
}

// .claude.json with the backup's settings in it; text: this device's file, or null.
function mergeConfig(text, subText) {
  const sub = parse(subText);
  if (!isObj(sub)) return text;
  const cur = text == null ? {} : parse(text);
  if (!isObj(cur)) return text;
  const out = { ...cur };
  for (const k of CONFIG_KEYS) if (sub[k] !== undefined) out[k] = isObj(cur[k]) && isObj(sub[k]) ? { ...cur[k], ...sub[k] } : sub[k];
  if (isObj(sub.projects)) {
    out.projects = { ...(isObj(cur.projects) ? cur.projects : {}) };
    for (const [p, v] of Object.entries(sub.projects)) out.projects[p] = { ...(isObj(out.projects[p]) ? out.projects[p] : {}), ...v };
  }
  return text != null && JSON.stringify(out) === JSON.stringify(cur) ? text : `${JSON.stringify(out, null, 2)}\n`;
}

// The desktop app's settings file with the backup's settings over this device's: the sidebar groups of both stay.
function mergeDesktopConfig(text, backupText) {
  const bak = parse(backupText);
  if (!isObj(bak)) return text;
  const cur = text == null ? {} : parse(text);
  if (!isObj(cur)) return text;
  const out = deepMerge(cur, bak);
  return text != null && JSON.stringify(out) === JSON.stringify(cur) ? text : JSON.stringify(out, null, 2);
}

// The prompt history with the backup's prompts in it; text: this device's, or null. The same text when nothing is new.
const sig = (o) => `${o.sessionId}|${o.timestamp}|${o.display}`;
function mergeHistory(text, backupText) {
  const here = new Set(String(text || '').split('\n').filter(Boolean).map(parse).filter(isObj).map(sig));
  const add = String(backupText).split('\n').filter(Boolean).map(parse).filter((o) => isObj(o) && !here.has(sig(o)));
  return add.length ? C.mergePrompts(text || '', add) : text;
}

// The chats deleted in the desktop app, by the marks it left (deleted_<id>) among a full backup's files.
const DELETED = /^extra\/desktop\/claude-code-sessions\/[^/]+\/[^/]+\/deleted_(.+)$/;
function deletedIn(full) {
  const out = new Set();
  for (const rel of full ? full.keys() : []) {
    const m = DELETED.exec(rel);
    if (m && C.ID_RE.test(m[1])) out.add(m[1]);
  }
  return out;
}

module.exports = {
  collect, parseRel, configPath, configSubset, mergeConfig, mergeDesktopConfig, mergeHistory, deepMerge, isText, deletedIn, MERGED,
  REPO_FILES, LEFT_OUT,
};
