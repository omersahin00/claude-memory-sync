'use strict';
// Claude Code chats (sessions). A chat is <Claude folder>/projects/<project folder>/<id>.jsonl, together with
//   <project folder>/<id>/   sub-agent conversations, large tool outputs, its title
//   file-history/<id>/       earlier versions of the files it changed (for rewinding)
//   uploads/<id>/            files added to it
//   history.jsonl            the prompts typed in it (lines with its sessionId)
// and, for chats of the Claude desktop app, the app's own record of it (title, model, settings) in its data folder:
// claude-code-sessions/<account>/<organization>/local_<id>.json.
// In a bundle each file of a chat is a part named by area and path: p/<id>.jsonl, p/<id>/..., h/<id>/..., u/<id>/...
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

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
  promptLines, mergePrompts,
};
