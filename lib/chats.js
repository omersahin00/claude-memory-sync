'use strict';
// Claude Code chats (sessions). A chat is <Claude folder>/projects/<project folder>/<id>.jsonl, together with
//   <project folder>/<id>/   sub-agent conversations, large tool outputs, its title
//   file-history/<id>/       earlier versions of the files it changed (for rewinding)
//   uploads/<id>/            files added to it
//   history.jsonl            the prompts typed in it (lines with its sessionId)
// and, for chats of the Claude desktop app, the app's own record of it (title, model, settings) in its data folder:
// claude-code-sessions/<account>/<organization>/local_<id>.json, and the group it is in in the app's sidebar.
// In a bundle each file of a chat is a part named by area and path: p/<id>.jsonl, p/<id>/..., h/<id>/..., u/<id>/...
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const ID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const ID_RE = new RegExp(`^${ID}$`, 'i');
const PART_RE = new RegExp(`^([phu])/(${ID})(\\.jsonl|/.+)$`, 'i');
const HEAD_BYTES = 128 * 1024;
// Parts whose text names the chat: a chat copied under a new id gets the new id in them too.
const TEXT_PART = /\.(jsonl|json|txt|md)$/i;

const rawHash = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

// [posix path, absolute path] of every file under dir.
function walk(dir, base = '') {
  const out = [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const abs = path.join(dir, e.name);
    const rel = base ? `${base}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...walk(abs, rel));
    else if (e.isFile()) out.push([rel, abs]);
  }
  return out;
}

// The chats of one Claude project folder: { id, size, mtime }.
function listChats(projectDir) {
  let names = [];
  try {
    names = fs.readdirSync(projectDir);
  } catch {
    return [];
  }
  return names
    .filter((n) => n.endsWith('.jsonl') && ID_RE.test(n.slice(0, -'.jsonl'.length)))
    .map((n) => {
      const st = fs.statSync(path.join(projectDir, n));
      return { id: n.slice(0, -'.jsonl'.length), size: st.size, mtime: st.mtimeMs };
    });
}

// Every file of a chat, as [part, absolute path].
function chatParts(claudeDir, projectDir, id) {
  const parts = [[`p/${id}.jsonl`, path.join(projectDir, `${id}.jsonl`)]];
  for (const [rel, abs] of walk(path.join(projectDir, id))) parts.push([`p/${id}/${rel}`, abs]);
  for (const [rel, abs] of walk(path.join(claudeDir, 'file-history', id))) parts.push([`h/${id}/${rel}`, abs]);
  for (const [rel, abs] of walk(path.join(claudeDir, 'uploads', id))) parts.push([`u/${id}/${rel}`, abs]);
  return parts;
}

const partChat = (part) => {
  const m = PART_RE.exec(part);
  return m ? m[2] : null;
};

// Where a part goes on this device.
function partTarget(claudeDir, projectDir, part) {
  const m = PART_RE.exec(part);
  if (!m) return null;
  const root = m[1] === 'p' ? projectDir : path.join(claudeDir, m[1] === 'h' ? 'file-history' : 'uploads');
  return path.join(root, ...part.slice(2).split('/'));
}

// The same part for the chat under a new id; text parts get the new id inside too. mark (the device the copy came
// from) is added to its title, in custom-title.json and in the transcript's custom-title lines, so Claude Code's list
// tells the two apart.
function renamePart(part, buf, from, to, mark = null) {
  const renamed = part.slice(0, 2) + to + part.slice(2 + from.length);
  if (!TEXT_PART.test(part)) return { part: renamed, buf };
  const text = buf.toString('utf8').split(from).join(to);
  return { part: renamed, buf: Buffer.from(mark && part.startsWith('p/') ? markTitle(text, mark) : text, 'utf8') };
}

function markTitle(text, mark) {
  return text.split('\n').map((l) => {
    if (!l.includes('"customTitle"')) return l;
    try {
      const o = JSON.parse(l);
      if (o && typeof o.customTitle === 'string' && (o.type === 'custom-title' || o.type === undefined)) return JSON.stringify({ ...o, customTitle: `${o.customTitle} (${mark})` });
    } catch { /* kept as it is */ }
    return l;
  }).join('\n');
}

// Its title (as set in Claude Code), where it was started (claude-desktop, claude-vscode, cli) and its first prompt,
// from the start of the chat.
function chatInfo(projectDir, id) {
  let title = null;
  try {
    title = JSON.parse(fs.readFileSync(path.join(projectDir, id, 'custom-title.json'), 'utf8')).customTitle || null;
  } catch { /* no title */ }
  let head = '';
  try {
    const fd = fs.openSync(path.join(projectDir, `${id}.jsonl`), 'r');
    try {
      const buf = Buffer.alloc(HEAD_BYTES);
      head = buf.subarray(0, fs.readSync(fd, buf, 0, HEAD_BYTES, 0)).toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch { /* unreadable */ }
  let entrypoint = null;
  let prompt = null;
  for (const line of head.split('\n')) {
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (!entrypoint && typeof o.entrypoint === 'string') entrypoint = o.entrypoint;
    if (!prompt && o.type === 'user' && !o.isMeta && o.message) {
      const c = o.message.content;
      const text = typeof c === 'string' ? c : Array.isArray(c) ? (c.find((x) => x && x.type === 'text') || {}).text : null;
      if (typeof text === 'string' && text.trim() && !text.trim().startsWith('<')) prompt = text.replace(/\s+/g, ' ').trim().slice(0, 140);
    }
    if (entrypoint && prompt) break;
  }
  return { title, entrypoint, prompt };
}

// A chat's lines, as views into its buffer (empty lines left out).
function jsonLines(buf) {
  const out = [];
  let start = 0;
  for (;;) {
    const end = buf.indexOf(0x0a, start);
    const line = buf.subarray(start, end === -1 ? buf.length : end);
    if (line.length) out.push(line);
    if (end === -1) return out;
    start = end + 1;
  }
}

const parseLine = (line) => {
  try {
    const o = JSON.parse(line.toString('utf8'));
    return o && typeof o === 'object' ? o : null;
  } catch {
    return null;
  }
};

// Lines Claude Code and the desktop app write into a chat on their own, with nothing said in it: its costs and the tools
// it used, the last prompt, its title, its mode, its Remote Control link, the folder it moved to. Opening a chat adds
// some of them. Any other line (a message, an attachment, a file snapshot, a kind not known here) counts as said.
const BOOKKEEPING = new Set(['cost-state', 'tools-used', 'last-prompt', 'bridge-session', 'custom-title', 'agent-name', 'mode', 'atis-latch', 'relocated']);
const said = (line) => {
  const o = parseLine(line);
  return !(o && BOOKKEEPING.has(o.type));
};

// Two copies of a chat, line by line: how many lines they start with in common, and whether either has anything said
// after them. Copies that differ only in BOOKKEEPING lines after what they share were not both continued.
function chatTails(local, remote) {
  const a = jsonLines(local);
  const b = jsonLines(remote);
  let shared = 0;
  while (shared < a.length && shared < b.length && a[shared].equals(b[shared])) shared++;
  return { shared, localSaid: a.slice(shared).some(said), remoteSaid: b.slice(shared).some(said) };
}

// The ids of a chat's messages, in order.
function messageIds(buf) {
  const out = [];
  for (const line of jsonLines(buf)) {
    if (!line.includes('"uuid"')) continue;
    const o = parseLine(line);
    if (o && (o.type === 'user' || o.type === 'assistant') && typeof o.uuid === 'string') out.push(o.uuid);
  }
  return out;
}

// What a desktop app record says about a chat, from the chat itself: its first and last time, the title set in it, the
// model and permission mode it ran with last, and the account and organization its Remote Control link names.
function chatFacts(buf) {
  const f = { first: null, last: null, title: null, model: null, permissionMode: null, owner: null };
  for (const line of jsonLines(buf)) {
    const o = parseLine(line);
    if (!o) continue;
    const t = typeof o.timestamp === 'string' ? Date.parse(o.timestamp) : NaN;
    if (Number.isFinite(t)) {
      if (f.first === null) f.first = t;
      f.last = t;
    }
    if (o.type === 'custom-title' && typeof o.customTitle === 'string' && o.customTitle.trim()) f.title = o.customTitle.trim();
    else if (o.type === 'assistant' && o.message && typeof o.message.model === 'string' && /^[\w.-]+$/.test(o.message.model)) f.model = o.message.model;
    else if (o.type === 'user' && typeof o.permissionMode === 'string') f.permissionMode = o.permissionMode;
    else if (o.type === 'bridge-session' && /^[\w-]+$/.test(String(o.ownerAccountUuid)) && /^[\w-]+$/.test(String(o.ownerOrganizationUuid))) {
      f.owner = `${o.ownerAccountUuid}/${o.ownerOrganizationUuid}`;
    }
  }
  return f;
}

// A desktop app record for a chat of the app that came without one, as the app makes one when it takes in a chat from
// Claude Code (local_<chat id>, marked as taken from the transcript); priorIds: earlier parts of the same session.
function madeRecord(facts, { id, cwd, title, priorIds = [], now = Date.now() }) {
  return {
    sessionId: `local_${id}`, cliSessionId: id, cwd, originCwd: cwd,
    createdAt: facts.first ?? now, lastActivityAt: facts.last ?? now, isArchived: false,
    title: facts.title || title || 'Untitled', titleSource: 'auto',
    ...(facts.model ? { model: facts.model } : {}),
    ...(facts.permissionMode ? { permissionMode: facts.permissionMode } : {}),
    ...(priorIds.length ? { priorCliSessionIds: priorIds } : {}),
    sessionPermissionUpdates: [], alwaysAllowedReasons: [],
    adoptedFromOtherSurface: true, fromCliTranscript: true,
  };
}

// The chats a desktop app record stands for: its transcript and the earlier ones of the same session.
function recordIds(record) {
  if (!record || typeof record !== 'object') return [];
  const prior = Array.isArray(record.priorCliSessionIds) ? record.priorCliSessionIds : [];
  return [record.cliSessionId, record.unarchivedCliSessionId, ...prior].filter((id) => typeof id === 'string' && ID_RE.test(id));
}

// The chats deleted in the desktop app: deleting a session leaves claude-code-sessions/<account>/<org>/deleted_<id>.
function desktopDeleted(dir) {
  const out = new Set();
  for (const [rel] of walk(path.join(dir, 'claude-code-sessions'))) {
    const segs = rel.split('/');
    const m = segs.length === 3 ? /^deleted_(.+)$/.exec(segs[2]) : null;
    if (m && ID_RE.test(m[1])) out.add(m[1]);
  }
  return out;
}

// The Claude desktop app's data folder (CLAUDE_DESKTOP_DIR overrides it, for tests).
function desktopDir(env = process.env, home = os.homedir(), platform = process.platform) {
  if (env.CLAUDE_DESKTOP_DIR) return path.resolve(env.CLAUDE_DESKTOP_DIR);
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'Claude');
  if (platform === 'win32') return path.join(env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'Claude');
  return path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'Claude');
}

// The desktop app's records of its Code sessions, by chat id: { dir: '<account>/<organization>', name, record }.
function desktopRecords(dir) {
  const out = new Map();
  for (const [rel, abs] of walk(path.join(dir, 'claude-code-sessions'))) {
    const segs = rel.split('/');
    if (segs.length !== 3 || !/^local_[\w-]+\.json$/.test(segs[2])) continue;
    try {
      const record = JSON.parse(fs.readFileSync(abs, 'utf8'));
      if (record && ID_RE.test(String(record.cliSessionId || ''))) out.set(record.cliSessionId, { dir: `${segs[0]}/${segs[1]}`, name: segs[2], record });
    } catch { /* unreadable record */ }
  }
  return out;
}

// The groups of the desktop app's sidebar, in its settings file (claude_desktop_config.json), under
// preferences.epitaxyPrefs: 'dframe-group-scopes'[<account>/<organization>] = { groups: [{ id, name, mode }],
// assignments: { 'code:local_<id>': group id }, order: { group id: ['code:local_<id>', …] } }, and each group's section
// in 'dframe-code-sections'. The format is the app's own: it is read with care and only added to, never while the app
// is running (see desktopRunning).
const DESKTOP_CONFIG = 'claude_desktop_config.json';
const GROUP_SCOPES = 'dframe-group-scopes';
const CODE_SECTIONS = 'dframe-code-sections';
const isObj = (x) => Boolean(x) && typeof x === 'object' && !Array.isArray(x);
const sessionOf = (d) => d.name.slice(0, -'.json'.length);
const codeGroup = (g) => isObj(g) && typeof g.id === 'string' && typeof g.name === 'string' && (g.mode === undefined || g.mode === 'code');

// By scope (<account>/<organization>, as in desktopRecords): { groups: Map(id → name), of: Map(local_<id> → group id) }.
function desktopGroups(dir) {
  const out = new Map();
  let scopes;
  try {
    scopes = JSON.parse(fs.readFileSync(path.join(dir, DESKTOP_CONFIG), 'utf8')).preferences.epitaxyPrefs[GROUP_SCOPES];
  } catch {
    return out;
  }
  for (const [scope, s] of Object.entries(isObj(scopes) ? scopes : {})) {
    if (!isObj(s)) continue;
    const groups = new Map((Array.isArray(s.groups) ? s.groups : []).filter(codeGroup).map((g) => [g.id, g.name]));
    const of = new Map();
    for (const [k, id] of Object.entries(isObj(s.assignments) ? s.assignments : {})) if (k.startsWith('code:') && groups.has(id)) of.set(k.slice(5), id);
    out.set(scope, { groups, of });
  }
  return out;
}

// The group of each chat as the sidebar shows it, by chat id: { id, name, own }. A session is in its own group (own);
// its side chats (forked from it) and its earlier transcripts (priorCliSessionIds) go with it.
function chatGroups(records, groups) {
  const bySession = new Map([...records.values()].map((d) => [sessionOf(d), d]));
  const ownGroup = (d) => {
    const s = groups.get(d.dir);
    const id = s && s.of.get(sessionOf(d));
    return id ? { id, name: s.groups.get(id) } : null;
  };
  const out = new Map();
  for (const [id, d] of records) {
    for (let x = d, n = 0; x && n < 8; n++) {
      const g = ownGroup(x);
      if (g) {
        out.set(id, { ...g, own: x === d });
        break;
      }
      const parent = x.record.forkedFromSessionId || (isObj(x.record.spawnedFrom) ? x.record.spawnedFrom.sessionId : null);
      x = typeof parent === 'string' ? bySession.get(parent) : null;
    }
  }
  for (const [id, d] of records) {
    const g = out.get(id);
    if (!g || !Array.isArray(d.record.priorCliSessionIds)) continue;
    for (const prior of d.record.priorCliSessionIds) if (typeof prior === 'string' && ID_RE.test(prior) && !out.has(prior)) out.set(prior, { id: g.id, name: g.name, own: false });
  }
  return out;
}

// What the desktop app calls each of its scratch folders, by folder: { title, movedTo }. The title of the session that
// ran there (not a side chat; the longest one), or of a session the app moved from there into a folder (movedTo), whose
// memory stayed behind.
function scratchTitles(records) {
  const out = new Map();
  const turns = new Map();
  for (const d of records.values()) {
    const r = d.record;
    if (typeof r.title !== 'string' || !r.title || typeof r.cwd !== 'string' || r.forkedFromSessionId || isObj(r.spawnedFrom)) continue;
    const n = Number(r.completedTurns) || 0;
    if (!turns.has(r.cwd) || n > turns.get(r.cwd)) {
      turns.set(r.cwd, n);
      out.set(r.cwd, { title: r.title, movedTo: null });
    }
  }
  for (const d of records.values()) {
    const r = d.record;
    const from = isObj(r.scratchCarried) && Array.isArray(r.scratchCarried.from) ? r.scratchCarried.from : [];
    for (const f of from) if (typeof f === 'string' && !out.has(f) && typeof r.title === 'string') out.set(f, { title: r.title, movedTo: typeof r.cwd === 'string' ? r.cwd : null });
  }
  return out;
}

// The settings file's text with sessions put into groups, or null when nothing changes. adds: [{ scope, session
// (local_<id>), group: { id, name } }]. A session already in a group stays there; a group not here yet is found by its
// name or added, with a section of its own in the sidebar before the list of all sessions.
function withGroups(text, adds) {
  let obj;
  try {
    obj = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isObj(obj)) return null;
  const child = (o, k) => (isObj(o[k]) ? o[k] : (o[k] = {}));
  const prefs = child(child(obj, 'preferences'), 'epitaxyPrefs');
  const scopes = child(prefs, GROUP_SCOPES);
  let changed = false;
  for (const a of adds) {
    const s = child(scopes, a.scope);
    if (!Array.isArray(s.groups)) s.groups = [];
    const assignments = child(s, 'assignments');
    const order = child(s, 'order');
    const key = `code:${a.session}`;
    if (s.groups.some((g) => isObj(g) && g.id === assignments[key])) continue;
    const name = a.group.name.toLocaleLowerCase();
    let g = s.groups.find((x) => isObj(x) && x.id === a.group.id) || s.groups.find((x) => codeGroup(x) && x.name.toLocaleLowerCase() === name);
    if (!g) {
      g = { id: a.group.id, name: a.group.name, mode: 'code' };
      s.groups.push(g);
      addSection(prefs, a.scope, g);
    }
    assignments[key] = g.id;
    if (!Array.isArray(order[g.id])) order[g.id] = [];
    if (!order[g.id].includes(key)) order[g.id].push(key);
    changed = true;
  }
  if (!changed) return null;
  const indent = (/^\{\r?\n([ \t]+)"/.exec(text) || [null, '  '])[1];
  return JSON.stringify(obj, null, indent) + (text.endsWith('\n') ? '\n' : '');
}

// A group's section in the sidebar, shaped like the sections there, right before the list of all sessions. An account
// with no sections yet gets them from the app itself.
function addSection(prefs, scope, g) {
  const s = isObj(prefs[CODE_SECTIONS]) ? prefs[CODE_SECTIONS][scope] : null;
  if (!isObj(s) || !Array.isArray(s.sections) || s.sections.some((x) => isObj(x) && x.id === g.id)) return;
  const like = s.sections.find((x) => isObj(x) && x.kind === 'manual') || s.sections.find((x) => isObj(x) && x.kind === 'sessions') || {};
  const sessions = s.sections.find((x) => isObj(x) && x.kind === 'sessions');
  const orders = s.sections.map((x) => (isObj(x) && Number.isFinite(x.order) ? x.order : -1));
  const at = sessions && Number.isFinite(sessions.order) ? sessions.order : Math.max(-1, ...orders) + 1;
  for (const x of s.sections) if (isObj(x) && Number.isFinite(x.order) && x.order >= at) x.order += 1;
  const section = { id: g.id, kind: 'manual', v: like.v || 2, name: g.name, order: at, sortBy: like.sortBy || 'recency', ascending: Boolean(like.ascending) };
  if (isObj(like.show)) section.show = { ...like.show };
  Object.assign(section, { collapsed: false, shown: true, members: [] });
  s.sections.splice(sessions ? s.sections.indexOf(sessions) : s.sections.length, 0, section);
}

// Whether the Claude desktop app is running: true, false, or null when that cannot be told. Its settings file is
// written only while it is closed, since the app keeps its settings in memory and writes them over the file.
// CMS_DESKTOP_RUNNING (1 or 0) answers instead, for tests.
function desktopRunning(env = process.env, platform = process.platform) {
  if (env.CMS_DESKTOP_RUNNING === '1' || env.CMS_DESKTOP_RUNNING === '0') return env.CMS_DESKTOP_RUNNING === '1';
  try {
    if (platform === 'darwin') {
      return execFileSync('ps', ['-axo', 'comm='], { encoding: 'utf8', timeout: 5000 }).split('\n').some((l) => /\/Claude\.app\/Contents\/MacOS\/Claude$/.test(l.trim()));
    }
    if (platform === 'win32') {
      const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Get-Process -Name claude -ErrorAction SilentlyContinue | ForEach-Object { $_.Path }'], { encoding: 'utf8', timeout: 10000, windowsHide: true });
      // The desktop app, installed for the user or from the Store; Claude Code's own claude.exe is not it.
      return out.split(/\r?\n/).some((l) => /\\(AnthropicClaude|WindowsApps)\\/i.test(l));
    }
  } catch { /* could not tell */ }
  return null;
}

// history.jsonl lines (typed prompts), by chat id.
function promptLines(claudeDir) {
  const out = new Map();
  let text = '';
  try {
    text = fs.readFileSync(path.join(claudeDir, 'history.jsonl'), 'utf8');
  } catch {
    return out;
  }
  for (const line of text.split('\n')) {
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (o && typeof o.sessionId === 'string') {
      if (!out.has(o.sessionId)) out.set(o.sessionId, []);
      out.get(o.sessionId).push(o);
    }
  }
  return out;
}

// history.jsonl with the given prompts added: lines already there are kept as they are, the result is in time order.
function mergePrompts(text, add) {
  const lines = text.split('\n').filter(Boolean).map((raw, i) => {
    let o = null;
    try {
      o = JSON.parse(raw);
    } catch { /* kept as it is */ }
    return { raw, t: o && Number(o.timestamp), i, sig: o ? `${o.sessionId}|${o.timestamp}|${o.display}` : null };
  });
  const seen = new Set(lines.map((l) => l.sig));
  let n = lines.length;
  for (const o of add) {
    const sig = `${o.sessionId}|${o.timestamp}|${o.display}`;
    if (seen.has(sig)) continue;
    seen.add(sig);
    lines.push({ raw: JSON.stringify(o), t: Number(o.timestamp), i: n++ });
  }
  lines.sort((a, b) => (Number.isFinite(a.t) && Number.isFinite(b.t) && a.t !== b.t ? a.t - b.t : a.i - b.i));
  return lines.map((l) => l.raw).join('\n') + (lines.length ? '\n' : '');
}

module.exports = {
  ID_RE, PART_RE, rawHash, walk, listChats, chatParts, partChat, partTarget, renamePart, chatInfo, desktopDir, desktopRecords,
  DESKTOP_CONFIG, desktopGroups, chatGroups, scratchTitles, withGroups, desktopRunning, promptLines, mergePrompts,
  BOOKKEEPING, chatTails, messageIds, chatFacts, madeRecord, recordIds, desktopDeleted,
};
