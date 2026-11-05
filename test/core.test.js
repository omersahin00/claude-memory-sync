'use strict';
// The backup engine this app shares with Folder Backup (core/, brought in by scripts/sync-core.js): that it is the one
// Folder Backup has, not changed here, and that it backs up and restores here with the restic this app carries
// (npm test downloads it first).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

test('core/ is the engine Folder Backup has, not changed here', () => {
  const source = JSON.parse(fs.readFileSync(path.join(ROOT, 'core', 'SOURCE.json'), 'utf8'));
  assert.strictEqual(source.from, 'folder-backup');
  const here = fs.readdirSync(path.join(ROOT, 'core')).filter((n) => n.endsWith('.js')).map((n) => `core/${n}`).sort();
  assert.deepStrictEqual(here, Object.keys(source.files).filter((f) => f.startsWith('core/')).sort(), 'a file was added to core/ or taken from it here');
  for (const [file, sum] of Object.entries(source.files)) {
    assert.strictEqual(sha256(fs.readFileSync(path.join(ROOT, file))), sum, `${file} was changed here: change it in Folder Backup, then run npm run core`);
  }
});

test('the shared engine backs up encrypted and incrementally, and restores, with the restic this app carries', async () => {
  const repo = require('../core/repository');
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cms-core-test-')));
  try {
    const src = path.join(tmp, 'memory');
    fs.mkdirSync(src);
    const secret = 'Proje notu: hafıza dosyası';
    fs.writeFileSync(path.join(src, 'MEMORY.md'), `${secret}\n`);
    fs.writeFileSync(path.join(src, 'other.md'), 'unchanged\n');
    const opts = { dir: path.join(tmp, 'backup'), cacheDir: path.join(tmp, 'cache'), password: 'correct horse battery staple' };
    const { recoveryCode } = await repo.createRepository(opts);
    assert.match(recoveryCode, /^[0-9A-Z]{4}(-[0-9A-Z]{4}){5}$/);
    await repo.backup({ ...opts, paths: [src] });
    fs.appendFileSync(path.join(src, 'MEMORY.md'), 'ikinci satır\n');
    const second = await repo.backup({ ...opts, paths: [src] });
    assert.deepStrictEqual([second.summary.files_changed, second.summary.files_unmodified], [1, 1], 'only what changed is written again');

    // Nothing in the backup folder can be read without the password.
    const needle = Buffer.from('hafıza', 'utf8');
    const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
    for (const f of walk(opts.dir)) assert.strictEqual(fs.readFileSync(f).includes(needle), false, `${f} holds the text as it is`);

    const back = path.join(tmp, 'back');
    await repo.restore({ ...opts, snapshot: second.snapshot, folder: src, target: back });
    assert.strictEqual(fs.readFileSync(path.join(back, 'MEMORY.md'), 'utf8'), `${secret}\nikinci satır\n`);
    assert.strictEqual(fs.readFileSync(path.join(back, 'other.md'), 'utf8'), 'unchanged\n');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
