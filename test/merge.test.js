'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { decide, mergeIndex, linkTarget, lineDiff } = require('../lib/merge');
const { copyRelFor } = require('../lib/plan');

const S = (...a) => new Set(a);

test('decide: every case', () => {
  assert.strictEqual(decide('a', 'a', S('a'), S('a')), 'same');
  assert.strictEqual(decide(null, 'a', S(), S('a')), 'add');
  assert.strictEqual(decide(null, 'a', S('a'), S('a')), 'local-deleted');
  assert.strictEqual(decide(null, 'b', S('a'), S('a', 'b')), 'conflict-local-deleted');
  assert.strictEqual(decide('a', null, S('a'), S('a')), 'delete');
  assert.strictEqual(decide('b', null, S('a', 'b'), S('a')), 'conflict-remote-deleted');
  assert.strictEqual(decide('a', null, S('a'), S()), 'local-only');
  assert.strictEqual(decide('a', 'b', S('a'), S('a', 'b')), 'update');
  assert.strictEqual(decide('b', 'a', S('a', 'b'), S('a')), 'local-newer');
  assert.strictEqual(decide('b', 'c', S('a', 'b'), S('a', 'c')), 'conflict');
  assert.strictEqual(decide('a', 'b', S('a', 'b'), S('a', 'b')), 'conflict'); // each side has seen the other: ambiguous
});

test('linkTarget', () => {
  assert.strictEqual(linkTarget('- [X](x-y.md) — hook'), 'x-y.md');
  assert.strictEqual(linkTarget('- [X](./x.md)'), 'x.md');
  assert.strictEqual(linkTarget('[site](https://a.com/x.md)'), null);
  assert.strictEqual(linkTarget('plain line'), null);
});

const base = { finalSet: S('a.md', 'b.md', 'c.md'), knownSet: S('a.md', 'b.md', 'c.md'), winnerOf: () => null, askLine: async () => 'local' };

test('mergeIndex: on conflict, new lines from both sides are merged in order', async () => {
  const r = await mergeIndex({
    ...base,
    baseText: '- [A](a.md) — x\n- [B](b.md) — y\n',
    otherText: '- [A](a.md) — x\n- [C](c.md) — z\n- [B](b.md) — y\n',
    baseSide: 'local',
    conflict: true,
  });
  assert.strictEqual(r.text, '- [A](a.md) — x\n- [C](c.md) — z\n- [B](b.md) — y\n');
  assert.strictEqual(r.stats.added, 1);
});

test('mergeIndex: line of a deleted file is removed, unknown broken links are left alone', async () => {
  const r = await mergeIndex({
    ...base,
    finalSet: S('a.md'),
    knownSet: S('a.md', 'd.md'),
    baseText: '- [A](a.md)\n- [D](d.md)\n- [Z](zz.md)\n',
    otherText: null,
    baseSide: 'local',
    conflict: false,
  });
  assert.strictEqual(r.text, '- [A](a.md)\n- [Z](zz.md)\n');
});

test('mergeIndex: differing line follows the winning side, otherwise asks', async () => {
  const r1 = await mergeIndex({
    ...base, winnerOf: (t) => (t === 'a.md' ? 'remote' : null),
    baseText: '- [A](a.md) — old\n', otherText: '- [A](a.md) — new\n', baseSide: 'local', conflict: true,
  });
  assert.strictEqual(r1.text, '- [A](a.md) — new\n');
  let asked = 0;
  const r2 = await mergeIndex({
    ...base, askLine: async () => { asked++; return 'remote'; },
    baseText: '- [A](a.md) — old\n', otherText: '- [A](a.md) — new\n', baseSide: 'local', conflict: true,
  });
  assert.strictEqual(asked, 1);
  assert.strictEqual(r2.text, '- [A](a.md) — new\n');
});

test('mergeIndex: copy line, CRLF preserved, unchanged text stays identical', async () => {
  const r = await mergeIndex({
    ...base, finalSet: S('a.md', 'a--win.md'),
    baseText: '- [A](a.md)\r\n- [B](b.md)\r\n', otherText: null, baseSide: 'local', conflict: false,
    knownSet: S('a.md'), copies: [{ rel: 'a--win.md', fromRel: 'a.md', label: 'win' }],
  });
  assert.ok(r.text.startsWith('- [A](a.md)\r\n- [a.md — win version](a--win.md)'));
  assert.ok(r.text.endsWith('- [B](b.md)\r\n'));
  const same = '- [A](a.md)\n- [B](b.md)\n';
  const r2 = await mergeIndex({ ...base, baseText: same, otherText: same, baseSide: 'local', conflict: false });
  assert.strictEqual(r2.text, same);
});

test('copyRelFor and lineDiff', () => {
  assert.strictEqual(copyRelFor('x.md', 'Ömer Win', S()), 'x--omer-win.md');
  assert.strictEqual(copyRelFor('x.md', 'win', S('x--win.md')), 'x--win-2.md');
  const d = lineDiff('a\nb\nc\n', 'a\nB\nc\n');
  assert.deepStrictEqual(d.filter((x) => x.t !== ' ').map((x) => x.t + x.s), ['-b', '+B']);
});
