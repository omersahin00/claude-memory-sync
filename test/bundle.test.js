'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { buildBundle, writeBundle, readBundle, readBundleHeader } = require('../lib/bundle');
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

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cms-b-'));
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
