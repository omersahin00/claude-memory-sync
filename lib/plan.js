'use strict';
const P = require('./paths');
const { hashContent } = require('./fsx');
const { decide, mergeIndex, AbortError } = require('./merge');

const INDEX = 'MEMORY.md';
const CONFLICTS = new Set(['conflict', 'conflict-remote-deleted', 'conflict-local-deleted']);

const union = (a, b, extra) => {
  const s = new Set([...a, ...b]);
  if (extra) s.add(extra);
  return s;
};

function mirrorAction(L, R) {
  if (L === R) return 'same';
  if (L === null) return 'add';
  if (R === null) return 'delete';
  return 'update';
}

// scope: { label, isMemory, root, keyPrefix, local: Map<rel,{hash,buf}>, remote: Map<rel,{hash,buf}> }
// First, non-interactive phase: decides what happens to each file. Returns blocking problems.
function classify({ mode, scopes, localHist, remoteHist, platform }) {
  const errors = [];
  const ci = P.caseInsensitive(platform);
  for (const scope of scopes) {
    const rels = [...new Set([...scope.local.keys(), ...scope.remote.keys()])].sort();
    if (ci) {
      const seen = new Map();
      for (const rel of rels) {
        const low = rel.toLowerCase();
        if (seen.has(low)) errors.push(`${scope.label}: "${seen.get(low)}" and "${rel}" differ only by letter case and would be the same file on this device.`);
        else seen.set(low, rel);
      }
    }
    if (platform === 'win32') {
      for (const rel of scope.remote.keys()) {
        const e = P.windowsNameError(rel);
        if (e) errors.push(`${scope.label}: ${e}`);
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
      const action = mode === 'restore' ? mirrorAction(lh, rh) : decide(lh, rh, LH, RH);
      return { rel, key, L, R, LH, RH, action, isIndex: mode !== 'restore' && scope.isMemory && rel === INDEX };
    });
  }
  return errors;
}

const needsDecision = (item) => CONFLICTS.has(item.action) && !item.isIndex;

function copyRelFor(rel, label, taken) {
  const slash = rel.lastIndexOf('/');
  const dir = rel.slice(0, slash + 1);
  const name = rel.slice(slash + 1);
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  const slug = label.toLocaleLowerCase('tr').replace(/ı/g, 'i').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'other-device';
  let candidate = `${dir}${stem}--${slug}${ext}`;
  for (let n = 2; taken.has(candidate.toLowerCase()); n++) candidate = `${dir}${stem}--${slug}-${n}${ext}`;
  return candidate;
}

// Second phase: asks about conflicts, merges MEMORY.md, builds the write/delete list and the new history.
// ask.conflict(scope, item) -> 'l' | 'r' | 'b' | 'd' | null
// ask.indexLine(scope, target, localLine, remoteLine) -> 'local' | 'remote' | null
async function resolve({ mode, scopes, localHist, remoteHist, remoteLabel, ask }) {
  const history = new Map(); // key -> Set | null (null: remove the entry)

  for (const scope of scopes) {
    scope.ops = [];
    scope.copies = [];
    const write = (rel, buf, hash) => scope.ops.push({ type: 'write', rel, abs: P.toAbs(scope.root, rel), buf, hash });
    const del = (rel) => scope.ops.push({ type: 'delete', rel, abs: P.toAbs(scope.root, rel) });

    if (mode === 'restore') {
      for (const it of scope.items) {
        if (it.action === 'add' || it.action === 'update') write(it.rel, it.R.buf, it.R.hash);
        else if (it.action === 'delete') del(it.rel);
      }
      // History also goes back to the bundle's state, as if the syncs in between never happened.
      const keys = new Set(scope.items.map((i) => i.key));
      for (const k of [...localHist.keys(), ...remoteHist.keys()]) if (k.startsWith(scope.keyPrefix)) keys.add(k);
      for (const k of keys) history.set(k, remoteHist.has(k) ? new Set(remoteHist.get(k)) : null);
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
      const takeRemote = () => {
        write(it.rel, it.R.buf, it.R.hash);
        final = it.R.hash;
        winners.set(it.rel, 'remote');
      };
      switch (it.action) {
        case 'add':
        case 'update':
          takeRemote();
          break;
        case 'delete':
          del(it.rel);
          final = null;
          break;
        case 'local-only':
        case 'local-newer':
          winners.set(it.rel, 'local');
          break;
        case 'same':
        case 'local-deleted':
          break;
        default: {
          const choice = await ask.conflict(scope, it);
          if (choice === null) throw new AbortError('Cancelled.');
          it.choice = choice;
          if (it.action === 'conflict') {
            if (choice === 'r') takeRemote();
            else {
              winners.set(it.rel, 'local');
              if (choice === 'b') {
                const rel = copyRelFor(it.rel, remoteLabel, taken);
                taken.add(rel.toLowerCase());
                write(rel, it.R.buf, it.R.hash);
                scope.copies.push({ rel, fromRel: it.rel, label: remoteLabel, hash: it.R.hash });
              }
            }
          } else if (it.action === 'conflict-remote-deleted') {
            if (choice === 'd') {
              del(it.rel);
              final = null;
            } else winners.set(it.rel, 'local');
          } else if (choice === 'r') {
            takeRemote(); // conflict-local-deleted
          }
        }
      }
      finals.set(it.rel, final);
      history.set(it.key, union(it.LH, it.RH, final));
    }

    for (const cp of scope.copies) {
      const key = scope.keyPrefix + cp.rel;
      history.set(key, union(localHist.get(key) || [], [], cp.hash));
    }

    if (indexItem) {
      const it = indexItem;
      const finalSet = new Set([...finals].filter(([, h]) => h !== null).map(([r]) => r));
      for (const cp of scope.copies) finalSet.add(cp.rel);
      const knownSet = new Set(finals.keys());
      let final = it.L ? it.L.hash : null;
      it.display = it.action;

      if (finalSet.size === 0 && (it.action === 'delete' || it.action === 'local-deleted')) {
        if (it.action === 'delete') {
          del(it.rel);
          final = null;
        }
      } else if (it.L || it.R) {
        const baseSide = !it.L ? 'remote' : !it.R ? 'local' : it.action === 'add' || it.action === 'update' ? 'remote' : 'local';
        const baseBuf = baseSide === 'local' ? it.L.buf : it.R.buf;
        const otherBuf = baseSide === 'local' ? it.R && it.R.buf : it.L && it.L.buf;
        const merged = await mergeIndex({
          baseText: baseBuf.toString('utf8'),
          otherText: otherBuf ? otherBuf.toString('utf8') : null,
          baseSide,
          conflict: CONFLICTS.has(it.action),
          finalSet,
          knownSet,
          winnerOf: (r) => winners.get(r) || null,
          copies: scope.copies,
          askLine: (t, l, r) => ask.indexLine(scope, t, l, r),
        });
        let buf = Buffer.from(merged.text, 'utf8');
        const hash = hashContent(buf);
        if (it.R && hash === it.R.hash) buf = it.R.buf;
        if (it.L && hash === it.L.hash) {
          it.display = it.R && it.L.hash === it.R.hash ? 'same' : 'local-newer';
        } else {
          write(it.rel, buf, hash);
          it.display = !it.L ? 'add' : it.R && hash === it.R.hash ? 'update' : 'merge';
        }
        it.mergeStats = merged.stats;
        final = hash;
      }
      history.set(it.key, union(it.LH, it.RH, final));
    }
  }
  return history;
}

module.exports = { classify, resolve, needsDecision, copyRelFor, CONFLICTS, INDEX };
