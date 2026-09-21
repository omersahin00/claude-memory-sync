'use strict';

// Three-way decision. L/R: local/remote content hash (null if missing).
// LH/RH: every hash that device has seen for this file (including its current content).
function decide(L, R, LH, RH) {
  if (L === R) return 'same';
  if (L === null) {
    if (LH.has(R)) return 'local-deleted';              // this device had that version and deleted it
    return LH.size ? 'conflict-local-deleted' : 'add';  // deleted here, but the other side has a newer version
  }
  if (R === null) {
    if (RH.has(L)) return 'delete';                     // the other device had this version and deleted it
    return RH.size ? 'conflict-remote-deleted' : 'local-only';
  }
  const localIsOld = RH.has(L);
  const remoteIsOld = LH.has(R);
  if (localIsOld && !remoteIsOld) return 'update';
  if (remoteIsOld && !localIsOld) return 'local-newer';
  return 'conflict';
}

const LINK_RE = /\]\(\s*<?([^)\s>]+)>?\s*\)/;

function linkTarget(line) {
  const m = line.match(LINK_RE);
  if (!m) return null;
  let t = m[1];
  if (/^[a-z][a-z0-9+.-]*:/i.test(t) || t.startsWith('#')) return null;
  t = t.replace(/^\.\//, '');
  try { t = decodeURI(t); } catch { /* keep as is */ }
  return t.toLowerCase().endsWith('.md') ? t : null;
}

function splitLines(text) {
  const src = text || '';
  const eol = src.includes('\r\n') ? '\r\n' : '\n';
  const lines = src === '' ? [] : src.split(/\r?\n/);
  const trailing = src === '' || (lines.length > 0 && lines[lines.length - 1] === '');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  return { lines, eol, trailing };
}

class AbortError extends Error {}

// Merges the MEMORY.md index file line by line.
//  baseText/baseSide : the side used as the base ('local' | 'remote')
//  conflict          : true if both sides changed (new lines from the other side are also added)
//  finalSet          : memory files that will exist after the sync (excluding MEMORY.md)
//  knownSet          : files that exist on either side (lines are only removed for these)
//  winnerOf(target)  : which side that file's content came from ('local'|'remote'|null)
//  copies            : [{ rel, fromRel, label }] "keep both" copies
//  askLine(target, localLine, remoteLine) -> 'local' | 'remote' | null
async function mergeIndex({ baseText, otherText, baseSide, conflict, finalSet, knownSet, winnerOf, copies = [], askLine }) {
  const base = splitLines(baseText);
  const lines = base.lines.slice();
  const stats = { added: 0, changed: 0, removed: 0, copies: 0 };
  const indexOfTarget = (t) => lines.findIndex((l) => linkTarget(l) === t);
  const otherSide = baseSide === 'local' ? 'remote' : 'local';

  if (otherText != null) {
    let anchor = -1;
    for (const ol of splitLines(otherText).lines) {
      const t = linkTarget(ol);
      if (t) {
        const idx = indexOfTarget(t);
        if (idx >= 0) {
          anchor = idx;
          if (conflict && lines[idx] !== ol) {
            let pick = winnerOf(t);
            if (!pick) {
              const localLine = baseSide === 'local' ? lines[idx] : ol;
              const remoteLine = baseSide === 'local' ? ol : lines[idx];
              pick = await askLine(t, localLine, remoteLine);
              if (pick === null) throw new AbortError('Cancelled.');
            }
            if (pick === otherSide) {
              lines[idx] = ol;
              stats.changed++;
            }
          }
        } else if (finalSet.has(t)) {
          lines.splice(++anchor, 0, ol);
          stats.added++;
        }
      } else if (conflict && ol.trim() !== '') {
        const idx = lines.indexOf(ol);
        if (idx >= 0) anchor = idx;
        else {
          lines.splice(++anchor, 0, ol);
          stats.added++;
        }
      }
    }
  }

  for (let i = lines.length - 1; i >= 0; i--) {
    const t = linkTarget(lines[i]);
    if (t && !finalSet.has(t) && knownSet.has(t)) {
      lines.splice(i, 1);
      stats.removed++;
    }
  }

  for (const cp of copies) {
    if (indexOfTarget(cp.rel) >= 0) continue;
    const line = `- [${cp.fromRel} — ${cp.label} version](${cp.rel}) — changed differently on two devices; merge into the original and delete this copy`;
    const idx = indexOfTarget(cp.fromRel);
    if (idx >= 0) lines.splice(idx + 1, 0, line);
    else lines.push(line);
    stats.copies++;
  }

  let text = lines.join(base.eol);
  if (lines.length && base.trailing) text += base.eol;
  return { text, stats };
}

// Short line diff (LCS) for the conflict screen. Long unchanged stretches are collapsed to "…".
function lineDiff(aText, bText, { context = 1, maxLines = 40 } = {}) {
  const a = splitLines(aText).lines;
  const b = splitLines(bText).lines;
  if (a.length * b.length > 4e6) return [{ t: ' ', s: '(file too large to show a diff)' }];
  const n = a.length;
  const m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  }
  const ops = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { ops.push({ t: ' ', s: a[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) ops.push({ t: '-', s: a[i++] });
    else ops.push({ t: '+', s: b[j++] });
  }
  while (i < n) ops.push({ t: '-', s: a[i++] });
  while (j < m) ops.push({ t: '+', s: b[j++] });

  const keep = ops.map((o, k) => o.t !== ' ' || ops.slice(Math.max(0, k - context), k + context + 1).some((x) => x.t !== ' '));
  const out = [];
  let skipped = false;
  ops.forEach((o, k) => {
    if (keep[k]) { out.push(o); skipped = false; }
    else if (!skipped) { out.push({ t: '…', s: '' }); skipped = true; }
  });
  if (out.length > maxLines) return [...out.slice(0, maxLines), { t: '…', s: `(${out.length - maxLines} more lines)` }];
  return out;
}

module.exports = { decide, linkTarget, splitLines, mergeIndex, lineDiff, AbortError };
