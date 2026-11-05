'use strict';
// Brings in the backup engine this app shares with Folder Backup, which is where it is written: Folder Backup's lib/
// becomes core/ here, and its restic download script scripts/fetch-restic.js. The engine is changed only there and
// brought in again with this script, never edited here. core/SOURCE.json records where it came from and the SHA-256 of
// each file, so test/core.test.js can tell that nothing was changed here.
//   node scripts/sync-core.js [folder-backup]    default: ../folder-backup beside this repository
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const CORE = path.join(ROOT, 'core');
const FROM = path.resolve(process.argv[2] || path.join(ROOT, '..', 'folder-backup'));
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const git = (...args) => spawnSync('git', ['-C', FROM, ...args], { encoding: 'utf8' });

function main() {
  const lib = path.join(FROM, 'lib');
  const fetcher = path.join(FROM, 'scripts', 'fetch-restic.js');
  if (!fs.existsSync(lib) || !fs.existsSync(fetcher)) {
    console.error(`Folder Backup was not found at ${FROM}. Give its folder: node scripts/sync-core.js <folder-backup>`);
    process.exit(1);
  }
  const names = fs.readdirSync(lib).filter((n) => n.endsWith('.js')).sort();
  fs.mkdirSync(CORE, { recursive: true });
  // A file the engine no longer has goes here too.
  for (const n of fs.readdirSync(CORE)) if (n.endsWith('.js') && !names.includes(n)) fs.rmSync(path.join(CORE, n));
  const files = {};
  for (const n of names) {
    const buf = fs.readFileSync(path.join(lib, n));
    fs.writeFileSync(path.join(CORE, n), buf);
    files[`core/${n}`] = sha256(buf);
  }
  const fetchBuf = fs.readFileSync(fetcher);
  fs.writeFileSync(path.join(ROOT, 'scripts', 'fetch-restic.js'), fetchBuf);
  files['scripts/fetch-restic.js'] = sha256(fetchBuf);

  const commit = git('rev-parse', 'HEAD').stdout.trim() || null;
  // Changes in Folder Backup that are not committed yet: the source is then that commit and those changes.
  const dirty = Boolean(git('status', '--porcelain', '--', 'lib', 'scripts/fetch-restic.js').stdout.trim());
  const source = { from: 'folder-backup', commit, dirty, files };
  fs.writeFileSync(path.join(CORE, 'SOURCE.json'), `${JSON.stringify(source, null, 2)}\n`);
  console.log(`core/: ${names.length} files from Folder Backup ${commit ? commit.slice(0, 7) : '(no commit)'}${dirty ? ' with uncommitted changes' : ''}`);
}

main();
