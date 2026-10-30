'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { classify, resolve } = require('../lib/plan');
const { hashContent } = require('../lib/fsx');

const f = (text) => {
  const buf = Buffer.from(text);
  return { buf, hash: hashContent(buf) };
};
const h = (text) => hashContent(Buffer.from(text));
const files = (obj) => new Map(Object.entries(obj).map(([rel, text]) => [rel, f(text)]));
const scope = (local, remote) => ({ id: 's', label: 'p', isMemory: true, root: '/r', keyPrefix: 'memory/p/', local: files(local), remote: files(remote) });
const hist = (obj) => new Map(Object.entries(obj).map(([rel, list]) => [`memory/p/${rel}`, new Set(list.map(h))]));

function run(local, remote, localHist, remoteHist, decisions, mode = 'sync') {
  const sc = scope(local, remote);
  const L = hist(localHist);
  const R = hist(remoteHist);
  classify({ mode, scopes: [sc], localHist: L, remoteHist: R, platform: 'linux' });
  const res = resolve({ mode, scopes: [sc], localHist: L, remoteHist: R, remoteLabel: 'mac', decisions });
  return { sc, res, ops: sc.ops.map((o) => `${o.type} ${o.rel}`).sort() };
}

test('groups: new, updated, deleted, conflict, kept', () => {
  const { sc } = run(
    { 'up.md': 'v1', 'del.md': 'd', 'both.md': 'mine', 'mine.md': 'only here' },
    { 'up.md': 'v2', 'new.md': 'n', 'both.md': 'theirs' },
    { 'up.md': ['v1'], 'del.md': ['d'], 'both.md': ['base', 'mine'] },
    { 'up.md': ['v1', 'v2'], 'del.md': ['d'], 'both.md': ['base', 'theirs'], 'new.md': ['n'] },
    {},
  );
  const groups = Object.fromEntries(sc.items.map((i) => [i.rel, i.group]));
  assert.deepStrictEqual(groups, { 'both.md': 'conflict', 'del.md': 'deleted', 'mine.md': 'kept', 'new.md': 'new', 'up.md': 'updated' });
});

test('defaults take new, updated and deleted files; conflicts wait for a decision', () => {
  const { res, ops } = run(
    { 'up.md': 'v1', 'del.md': 'd', 'both.md': 'mine' },
    { 'up.md': 'v2', 'new.md': 'n', 'both.md': 'theirs' },
    { 'up.md': ['v1'], 'del.md': ['d'], 'both.md': ['base', 'mine'] },
    { 'up.md': ['v1', 'v2'], 'del.md': ['d'], 'both.md': ['base', 'theirs'], 'new.md': ['n'] },
    {},
  );
  assert.deepStrictEqual(ops, ['delete del.md', 'write new.md', 'write up.md']);
  assert.deepStrictEqual(res.pending.map((p) => p.rel), ['both.md']);
});

test('a change that is skipped is not written to history, so it is offered again', () => {
  const local = { 'up.md': 'v1', 'del.md': 'd' };
  const remote = { 'up.md': 'v2', 'new.md': 'n' };
  const lh = { 'up.md': ['v1'], 'del.md': ['d'] };
  const rh = { 'up.md': ['v1', 'v2'], 'del.md': ['d'], 'new.md': ['n'] };
  const skipAll = { items: { 'memory/p/up.md': 'skip', 'memory/p/del.md': 'skip', 'memory/p/new.md': 'skip' } };
  const { res, ops } = run(local, remote, lh, rh, skipAll);
  assert.deepStrictEqual(ops, []);
  assert.deepStrictEqual([...res.history.get('memory/p/up.md')], [h('v1')]);
  assert.strictEqual(res.history.get('memory/p/new.md'), null);

  // Next time with the history saved as it is: the same three changes are offered again.
  const again = run(local, remote, lh, rh, {});
  assert.deepStrictEqual(again.ops, ['delete del.md', 'write new.md', 'write up.md']);
});

test('conflict choices: keep this one, take theirs, keep both', () => {
  const args = [{ 'x.md': 'mine' }, { 'x.md': 'theirs' }, { 'x.md': ['base', 'mine'] }, { 'x.md': ['base', 'theirs'] }];
  assert.deepStrictEqual(run(...args, { items: { 'memory/p/x.md': 'l' } }).ops, []);
  assert.deepStrictEqual(run(...args, { items: { 'memory/p/x.md': 'r' } }).ops, ['write x.md']);
  const both = run(...args, { items: { 'memory/p/x.md': 'b' } });
  assert.deepStrictEqual(both.ops, ['write x--mac.md']);
  assert.ok(both.res.history.get('memory/p/x.md').has(h('theirs')), 'their version is seen: next time this device is newer');
  const skipped = run(...args, { items: { 'memory/p/x.md': 'skip' } });
  assert.ok(!skipped.res.history.get('memory/p/x.md').has(h('theirs')), 'skipped conflict stays a conflict');
});

test('MEMORY.md is merged; a skipped file keeps its line out of the merge', () => {
  const { ops, res } = run(
    { 'MEMORY.md': '- [A](a.md)\n', 'a.md': 'a' },
    { 'MEMORY.md': '- [A](a.md)\n- [B](b.md)\n- [C](c.md)\n', 'a.md': 'a', 'b.md': 'b', 'c.md': 'c' },
    { 'MEMORY.md': ['- [A](a.md)\n'], 'a.md': ['a'] },
    { 'MEMORY.md': ['- [A](a.md)\n', '- [A](a.md)\n- [B](b.md)\n- [C](c.md)\n'], 'a.md': ['a'], 'b.md': ['b'], 'c.md': ['c'] },
    { items: { 'memory/p/c.md': 'skip' } },
  );
  assert.deepStrictEqual(ops, ['write MEMORY.md', 'write b.md']);
  assert.strictEqual(res.index.get('memory/p/MEMORY.md').text, '- [A](a.md)\n- [B](b.md)\n');
});

test('restore mode mirrors the bundle, files can be left out', () => {
  const { ops } = run(
    { 'a.md': 'local', 'extra.md': 'x' },
    { 'a.md': 'bundle', 'b.md': 'b' },
    {}, {},
    { items: { 'memory/p/extra.md': 'skip' } },
    'restore',
  );
  assert.deepStrictEqual(ops, ['write a.md', 'write b.md']);
});
