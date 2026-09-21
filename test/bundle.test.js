'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { buildBundle, writeBundle, readBundle } = require('../lib/bundle');
const { hashContent } = require('../lib/fsx');

function sample() {
  const buf = Buffer.from('# memory\n');
  return buildBundle({
    config: { deviceId: 'id-1', deviceName: 'mac', prefix: 'sasa' },
    platform: 'darwin', hostname: 'h',
    repos: { 'sasa-a': { remote: 'https://x/sasa-a.git', hasMemory: true, memoryFiles: 1 } },
    workspacesIncluded: true,
    files: new Map([['memory/sasa-a/MEMORY.md', { buf }]]),
    history: new Map([['memory/sasa-a/MEMORY.md', new Set(['old', hashContent(buf)])]]),
  });
}

test('bundle: write and read back', () => {
  const abs = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cms-b-')), 'p.memsync');
  writeBundle(abs, sample());
  const b = readBundle(abs);
  assert.strictEqual(b.files.get('memory/sasa-a/MEMORY.md').buf.toString(), '# memory\n');
  assert.ok(b.history.get('memory/sasa-a/MEMORY.md').has('old'));
});

test('bundle: tampered content, path escape and foreign files are rejected', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cms-b-'));
  const write = (obj) => {
    const abs = path.join(dir, `${Math.random()}.memsync`);
    fs.writeFileSync(abs, zlib.gzipSync(JSON.stringify(obj)));
    return abs;
  };
  const tampered = sample();
  tampered.files['memory/sasa-a/MEMORY.md'].data = Buffer.from('# changed\n').toString('base64');
  assert.throws(() => readBundle(write(tampered)), /integrity/);

  const escape = sample();
  escape.files['memory/sasa-a/../../x.md'] = escape.files['memory/sasa-a/MEMORY.md'];
  assert.throws(() => readBundle(write(escape)), /Invalid file path/);

  const abs = path.join(dir, 'plain.txt');
  fs.writeFileSync(abs, 'hello');
  assert.throws(() => readBundle(abs), /corrupt/);
});
