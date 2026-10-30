'use strict';
const P = require('./paths');
const { hashContent } = require('./fsx');
const { decide, mergeIndex } = require('./merge');

const INDEX = 'MEMORY.md';

// How each sync action is shown and decided.
//  group   : section of the review screen
//  choices : what the user can pick; take = apply the other device's change, skip = leave this file as it is for now,
//            l = keep this device's version, r = take the other device's version, b = keep both, d = delete / keep deleted
//  default : preselected choice; null means the user has to pick
const SYNC_ACTIONS = {
  add: { group: 'new', choices: ['take', 'skip'], default: 'take' },
  update: { group: 'updated', choices: ['take', 'skip'], default: 'take' },
  delete: { group: 'deleted', choices: ['take', 'skip'], default: 'take' },
  conflict: { group: 'conflict', choices: ['l', 'r', 'b', 'skip'], default: null },
  'conflict-remote-deleted': { group: 'conflict', choices: ['l', 'd', 'skip'], default: null },
  'conflict-local-deleted': { group: 'conflict', choices: ['r', 'd', 'skip'], default: null },
  'local-only': { group: 'kept', choices: [], default: null },
  'local-newer': { group: 'kept', choices: [], default: null },
  'local-deleted': { group: 'kept', choices: [], default: null },
  same: { group: 'same', choices: [], default: null },
};
const MIRROR_GROUP = { add: 'new', update: 'updated', delete: 'deleted' };

// Set of every non-empty hash in the given sets / single hashes.
function union(...parts) {
  const s = new Set();
  for (const p of parts) {
    if (!p) continue;
    for (const v of typeof p === 'string' ? [p] : p) if (v) s.add(v);
  }
  return s;
}

function mirrorAction(L, R) {
  if (L === R) return 'same';
  if (L === null) return 'add';
  if (R === null) return 'delete';
  return 'update';
}

// scope: { id, label, isMemory, partial, root, keyPrefix, local: Map<rel,{hash,buf}>, remote: Map<rel,{hash,buf}> }
// First phase, no questions: what each file needs. Returns problems that block the whole operation.
function classify({ mode, scopes, localHist, remoteHist, platform }) {
  const errors = [];
  const ci = P.caseInsensitive(platform);
  for (const scope of scopes) {
    const rels = [...new Set([...scope.local.keys(), ...scope.remote.keys()])].sort();
    if (ci) {
      const seen = new Map();
      for (const rel of rels) {
        const low = rel.toLowerCase();
        if (seen.has(low)) errors.push({ code: 'case-collision', scope: scope.label, a: seen.get(low), b: rel });
        else seen.set(low, rel);
      }
    }
    if (platform === 'win32') {
      for (const rel of scope.remote.keys()) {
        const e = P.windowsNameError(rel);
        if (e) errors.push({ code: 'windows-name', scope: scope.label, rel, detail: e });
      }
    }
    scope.items = rels.map((rel) => {
      const key = scope.keyPrefix + rel;
      const L = scope.local.get(rel) || null;
      const R = scope.remote.get(rel) || null;
      const LH = new Set(localHist.get(key) || []);
      const RH = new Set(remoteHist.get(key) || []);
      if (L) LH.add(L.hash);
      if (R) RH.add(R.hash);
      const lh = L ? L.hash : null;
      const rh = R ? R.hash : null;
      const isIndex = mode !== 'restore' && scope.isMemory && rel === INDEX;
      const action = mode === 'restore' ? mirrorAction(lh, rh) : decide(lh, rh, LH, RH);
      let meta;
      if (mode === 'restore') meta = action === 'same' ? SYNC_ACTIONS.same : { group: MIRROR_GROUP[action], choices: ['take', 'skip'], default: 'take' };
      else if (isIndex) meta = { group: SYNC_ACTIONS[action].group === 'conflict' || action === 'add' || action === 'update' || action === 'delete' ? 'index' : SYNC_ACTIONS[action].group, choices: ['take', 'skip'], default: 'take' };
      else meta = SYNC_ACTIONS[action];
      return { rel, key, L, R, LH, RH, action, isIndex, group: meta.group, choices: meta.choices, defaultChoice: meta.default };
    });
  }
  return errors;
}

function copyRelFor(rel, label, taken) {
  const slash = rel.lastIndexOf('/');
  const dir = rel.slice(0, slash + 1);
  const name = rel.slice(slash + 1);
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  const slug = label.toLocaleLowerCase('tr').replace(/ı/g, 'i').normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'other-device';
  let candidate = `${dir}${stem}--${slug}${ext}`;
  for (let n = 2; taken.has(candidate.toLowerCase()); n++) candidate = `${dir}${stem}--${slug}-${n}${ext}`;
  return candidate;
}

// Second phase: applies the choices, merges MEMORY.md, builds the write/delete list and the new history.
// It writes nothing and can be run again whenever a choice changes.
//  decisions: { items: { [key]: choice }, lines: { [`${key}#${target}`]: 'local' | 'remote' } }
// Returns { history: Map<key, Set|null>, pending, index: Map<key, merge result> }; fills scope.ops and scope.copies.
// A change the user did not take is not written to history, so it is offered again next time.
function resolve({ mode, scopes, localHist, remoteHist, remoteLabel, decisions = {} }) {
  const itemChoices = decisions.items || {};
  const lineChoices = decisions.lines || {};
  const history = new Map();
  const pending = [];
  const index = new Map();
  const setHistory = (key, set) => history.set(key, set && set.size ? set : null);

  for (const scope of scopes) {
    scope.ops = [];
    scope.copies = [];
    const op = (type, rel, extra) => ({ type, rel, key: scope.keyPrefix + rel, abs: P.toAbs(scope.root, rel), ...extra });
    const write = (rel, buf, hash, reason) => scope.ops.push(op('write', rel, { buf, hash, reason }));
    const del = (rel, reason) => scope.ops.push(op('delete', rel, { reason }));
    const choiceOf = (it) => {
      const c = itemChoices[it.key];
      return c && it.choices.includes(c) ? c : it.defaultChoice;
    };

    if (mode === 'restore') {
      const fromBundle = (k) => (remoteHist.has(k) ? new Set(remoteHist.get(k)) : null);
      for (const it of scope.items) {
        if (it.group === 'same') {
          history.set(it.key, fromBundle(it.key));
          continue;
        }
        it.choice = choiceOf(it);
        if (it.choice !== 'take') continue;
        if (it.action === 'delete') del(it.rel, 'restore');
        else write(it.rel, it.R.buf, it.R.hash, 'restore');
        history.set(it.key, fromBundle(it.key));
      }
      // History also goes back to the bundle's state, as if the syncs in between never happened.
      if (!scope.partial) {
        const itemKeys = new Set(scope.items.map((i) => i.key));
        for (const k of new Set([...localHist.keys(), ...remoteHist.keys()])) {
          if (k.startsWith(scope.keyPrefix) && !itemKeys.has(k)) history.set(k, fromBundle(k));
        }
      }
      continue;
    }

    const winners = new Map();
    const finals = new Map();
    const taken = new Set(scope.items.map((i) => i.rel.toLowerCase()));
    let indexItem = null;

    for (const it of scope.items) {
      if (it.isIndex) {
        indexItem = it;
        continue;
      }
      let final = it.L ? it.L.hash : null;
      let accepted = true;
      const c = it.choices.length ? choiceOf(it) : null;
      it.choice = c;
      const takeRemote = () => {
        write(it.rel, it.R.buf, it.R.hash, it.action);
        final = it.R.hash;
        winners.set(it.rel, 'remote');
      };
      if (it.choices.length && !c) {
        pending.push({ type: 'choice', id: it.key, key: it.key, scope: scope.id, rel: it.rel, action: it.action });
        accepted = false;
      } else {
        switch (it.action) {
          case 'add':
          case 'update':
            if (c === 'take') takeRemote();
            else accepted = false;
            break;
          case 'delete':
            if (c === 'take') {
              del(it.rel, 'delete');
              final = null;
            } else accepted = false;
            break;
          case 'local-only':
          case 'local-newer':
            winners.set(it.rel, 'local');
            break;
          case 'conflict':
            if (c === 'r') takeRemote();
            else if (c === 'l' || c === 'b') {
              winners.set(it.rel, 'local');
              if (c === 'b') {
                const rel = copyRelFor(it.rel, remoteLabel, taken);
                taken.add(rel.toLowerCase());
                write(rel, it.R.buf, it.R.hash, 'copy');
                scope.copies.push({ rel, fromRel: it.rel, label: remoteLabel, hash: it.R.hash });
              }
            } else accepted = false;
            break;
          case 'conflict-remote-deleted':
            if (c === 'd') {
              del(it.rel, 'delete');
              final = null;
            } else if (c === 'l') winners.set(it.rel, 'local');
            else accepted = false;
            break;
          case 'conflict-local-deleted':
            if (c === 'r') takeRemote();
            else if (c !== 'd') accepted = false;
            break;
          default: // same, local-deleted
        }
      }
      // A file kept as it is here keeps its MEMORY.md line as it is here.
      if (!accepted && final !== null && !winners.has(it.rel)) winners.set(it.rel, 'local');
      finals.set(it.rel, final);
      setHistory(it.key, accepted ? union(it.LH, it.RH, final) : union(localHist.get(it.key), final));
    }

    for (const cp of scope.copies) {
      const key = scope.keyPrefix + cp.rel;
      setHistory(key, union(localHist.get(key), cp.hash));
    }

    if (indexItem) {
      const it = indexItem;
      const c = choiceOf(it);
      it.choice = c;
      let final = it.L ? it.L.hash : null;
      const result = { key: it.key, scope: scope.id, display: 'same', stats: null, text: null, skipped: c === 'skip' };
      if (c === 'skip') {
        setHistory(it.key, union(localHist.get(it.key), final));
      } else {
        const finalSet = new Set([...finals].filter(([, h]) => h !== null).map(([r]) => r));
        for (const cp of scope.copies) finalSet.add(cp.rel);
        const knownSet = new Set(finals.keys());
        if (finalSet.size === 0 && (it.action === 'delete' || it.action === 'local-deleted')) {
          if (it.action === 'delete') {
            del(it.rel, 'delete');
            final = null;
            result.display = 'delete';
          }
        } else if (it.L || it.R) {
          const baseSide = !it.L ? 'remote' : !it.R ? 'local' : it.action === 'add' || it.action === 'update' ? 'remote' : 'local';
          const baseBuf = baseSide === 'local' ? it.L.buf : it.R.buf;
          const otherBuf = baseSide === 'local' ? it.R && it.R.buf : it.L && it.L.buf;
          const merged = mergeIndex({
            baseText: baseBuf.toString('utf8'),
            otherText: otherBuf ? otherBuf.toString('utf8') : null,
            baseSide,
            conflict: it.action.startsWith('conflict'),
            finalSet,
            knownSet,
            winnerOf: (r) => winners.get(r) || null,
            copies: scope.copies,
            askLine: (target, localLine, remoteLine) => {
              const id = `${it.key}#${target}`;
              if (lineChoices[id] === 'local' || lineChoices[id] === 'remote') return lineChoices[id];
              pending.push({ type: 'line', id, key: it.key, scope: scope.id, target, local: localLine, remote: remoteLine });
              return 'local';
            },
          });
          let buf = Buffer.from(merged.text, 'utf8');
          const hash = hashContent(buf);
          if (it.R && hash === it.R.hash) buf = it.R.buf;
          if (it.L && hash === it.L.hash) {
            result.display = it.R && it.L.hash === it.R.hash ? 'same' : 'kept';
          } else {
            write(it.rel, buf, hash, 'index');
            result.display = !it.L ? 'add' : it.R && hash === it.R.hash ? 'update' : 'merge';
          }
          result.stats = merged.stats;
          result.text = merged.text;
          final = hash;
        }
        setHistory(it.key, union(it.LH, it.RH, final));
      }
      index.set(it.key, result);
    }
  }
  return { history, pending, index };
}

module.exports = { classify, resolve, copyRelFor, mirrorAction, union, SYNC_ACTIONS, INDEX };
