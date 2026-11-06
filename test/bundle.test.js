'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { buildBundle, writeBundle, writeBundleV3, readBundle, readBundleHeader } = require('../lib/bundle');
const { hashContent } = require('../lib/fsx');

function sample() {
  const buf = Buffer.from('# memory\n');
  return buildBundle({
    kind: 'export',
    app: { name: 'claude-memory-sync', version: '2.0.0' },
    device: { id: 'id-1', name: 'mac', platform: 'darwin', hostname: 'h' },
    locations: { 'project:acme-a': { type: 'project', key: 'acme-a', name: 'acme-a', path: '/x/acme-a', homeRel: 'x/acme-a', gitRemote: 'https://x/acme-a.git' } },
    files: new Map([['memory/acme-a/MEMORY.md', { buf }]]),
    history: new Map([['memory/acme-a/MEMORY.md', new Set(['old', hashContent(buf)])]]),
  });
}

// Everything these tests write is under one folder, removed at the end.
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'cms-bundle-'));
test.after(() => fs.rmSync(ROOT, { recursive: true, force: true }));
const tmp = () => fs.mkdtempSync(path.join(ROOT, 'b-'));
const writeRaw = (dir, obj) => {
  const abs = path.join(dir, `${Math.random()}.memsync`);
  fs.writeFileSync(abs, zlib.gzipSync(JSON.stringify(obj)));
  return abs;
};

test('bundle: write and read back', () => {
  const abs = path.join(tmp(), 'p.memsync');
  writeBundle(abs, sample());
  const b = readBundle(abs);
  assert.strictEqual(b.files.get('memory/acme-a/MEMORY.md').buf.toString(), '# memory\n');
  assert.ok(b.history.get('memory/acme-a/MEMORY.md').has('old'));
  assert.strictEqual(b.locations['project:acme-a'].homeRel, 'x/acme-a');
  assert.deepStrictEqual(readBundleHeader(abs).stats, { projects: 1, memoryFiles: 1, workspaceFiles: 0, claudeFiles: 0, bytes: 9 });
});

test('bundle: tampered content, path escape, foreign files and non-bundles are rejected', () => {
  const dir = tmp();
  const tampered = sample();
  tampered.files['memory/acme-a/MEMORY.md'].data = Buffer.from('# changed\n').toString('base64');
  assert.throws(() => readBundle(writeRaw(dir, tampered)), /integrity/);

  const escape = sample();
  escape.files['memory/acme-a/../../x.md'] = escape.files['memory/acme-a/MEMORY.md'];
  assert.throws(() => readBundle(writeRaw(dir, escape)), /Invalid file path/);

  const foreign = sample();
  foreign.files['memory/other/x.md'] = foreign.files['memory/acme-a/MEMORY.md'];
  assert.throws(() => readBundle(writeRaw(dir, foreign)), /outside the bundle/);

  const abs = path.join(dir, 'plain.txt');
  fs.writeFileSync(abs, 'hello');
  assert.throws(() => readBundle(abs), /corrupt/);
});

test('bundle: version 1 bundles are read with the local repos folder', () => {
  const mem = Buffer.from('- [A](a.md)\n');
  const ws = Buffer.from('{"folders":[{"path":"../acme-a"}]}');
  const f = (buf) => ({ hash: hashContent(buf), size: buf.length, data: buf.toString('base64') });
  const v1 = {
    format: 'claude-memory-sync', version: 1, createdAt: new Date().toISOString(),
    device: { id: 'old', name: 'win', platform: 'win32', hostname: 'w' }, prefix: 'acme',
    repos: { 'acme-a': { remote: 'https://x/acme-a.git', hasMemory: true, memoryFiles: 1 }, 'acme-b': { remote: null, hasMemory: false, memoryFiles: 0 } },
    workspacesIncluded: true,
    files: { 'memory/acme-a/MEMORY.md': f(mem), 'workspace/workspaces/x.code-workspace': f(ws) },
    history: { 'memory/acme-a/MEMORY.md': [hashContent(mem)], 'workspace/workspaces/x.code-workspace': [hashContent(ws)] },
  };
  const b = readBundle(writeRaw(tmp(), v1), { v1WorkspaceRoot: 'documents-github' });
  assert.strictEqual(b.version, 1);
  assert.deepStrictEqual([...b.files.keys()].sort(), ['memory/acme-a/MEMORY.md', 'workspace/documents-github/workspaces/x.code-workspace']);
  assert.strictEqual(b.locations['project:acme-a'].legacy, true);
  assert.strictEqual(b.locations['project:acme-a'].gitRemote, 'https://x/acme-a.git');
  assert.ok(b.locations['workspaceRoot:documents-github']);
  assert.ok(!b.locations['project:acme-b']);
});

test('bundle: chats go into a version 3 file, read part by part and checked; a damaged part or end is caught', () => {
  const dir = fs.mkdtempSync(path.join(ROOT, 'v3-'));
  const id = '22222222-2222-4222-8222-222222222222';
  const src = path.join(dir, 'chat.jsonl');
  fs.writeFileSync(src, '{"type":"user","message":{"content":"hello"}}\n'.repeat(500));
  const bundle = buildBundle({
    kind: 'export', app: { name: 'x', version: '1' }, device: { id: 'd1', name: 'A', platform: 'darwin' },
    locations: { 'project:acme-a': { type: 'project', key: 'acme-a', name: 'acme-a', memory: false } },
    files: new Map(), history: new Map(), chats: { [id]: { project: 'acme-a', title: 'Hello' } },
  });
  const abs = path.join(dir, 'b.memsync');
  writeBundleV3(abs, bundle, [{ part: `p/${id}.jsonl`, abs: src }]);
  const b = readBundle(abs);
  assert.strictEqual(b.chats.read(`p/${id}.jsonl`).toString(), fs.readFileSync(src, 'utf8'));
  assert.deepStrictEqual([b.locations['project:acme-a'].memory, readBundleHeader(abs).chats], [false, 1]);
  const raw = fs.readFileSync(abs);
  raw[20] ^= 0xff;
  fs.writeFileSync(abs, raw);
  assert.throws(() => readBundle(abs).chats.read(`p/${id}.jsonl`), { code: 'BUNDLE_INTEGRITY' });
  fs.writeFileSync(abs, raw.subarray(0, raw.length - 3));
  assert.throws(() => readBundle(abs), { code: 'BUNDLE_CORRUPT' });
});

test('bundle: a full backup keeps earlier backups as parts (version 4), read and checked when needed', () => {
  const dir = fs.mkdtempSync(path.join(ROOT, 'v4-'));
  const src = path.join(dir, 'old.memsync');
  fs.writeFileSync(src, zlib.gzipSync(Buffer.from('an earlier backup '.repeat(2000))));
  const bundle = buildBundle({
    kind: 'full', app: { name: 'x', version: '1' }, device: { id: 'd1', name: 'A', platform: 'darwin' },
    locations: {}, files: new Map(), history: new Map(), full: new Map([['state/config.json', { buf: Buffer.from('{}') }]]),
  });
  const abs = path.join(dir, 'full.memsync');
  writeBundleV3(abs, bundle, [], [{ rel: 'backups/manual/x-manual.memsync', abs: src }]);
  const b = readBundle(abs);
  assert.deepStrictEqual([readBundleHeader(abs).version, b.chats, b.full.get('state/config.json').buf.toString()], [4, null, '{}']);
  const part = b.full.get('backups/manual/x-manual.memsync');
  assert.ok(!part.buf && part.load().equals(fs.readFileSync(src)), 'read only when needed, byte for byte');
  const raw = fs.readFileSync(abs);
  raw[40] ^= 0xff;
  fs.writeFileSync(abs, raw);
  assert.throws(() => readBundle(abs).full.get('backups/manual/x-manual.memsync').load(), { code: 'BUNDLE_INTEGRITY' });
  fs.rmSync(dir, { recursive: true, force: true });
});
