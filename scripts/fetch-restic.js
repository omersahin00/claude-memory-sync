'use strict';
// Downloads restic, the program that writes and reads every backup, checks each file against the SHA-256 sums below and
// unpacks it into vendor/restic/<os>-<arch>, where the app and the tests find it and the installers take it from.
//   node scripts/fetch-restic.js            this computer
//   node scripts/fetch-restic.js mac|win|all
// The sums are restic's own SHA256SUMS for this version. Its signature (SHA256SUMS.asc) was checked against the release
// key restic's documentation names: CF8F 18F2 8445 7597 3F79 D4E1 91A6 868B D3F7 A907, Alexander Neumann. For a new
// version, check the signature the same way, then change VERSION and the sums.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const VERSION = '0.19.1';
const BASE = `https://github.com/restic/restic/releases/download/v${VERSION}`;
const TARGETS = {
  'mac-arm64': { asset: `restic_${VERSION}_darwin_arm64.bz2`, sha256: '7be0a144ccc377880f294204aa271d76e4b79554b42a751151d425ce6ebac143' },
  'mac-x64': { asset: `restic_${VERSION}_darwin_amd64.bz2`, sha256: 'c38d579622cf602f665234c5a8c315030b6cf70656028fe6dc29a786b60e5f35' },
  'win-x64': { asset: `restic_${VERSION}_windows_amd64.zip`, sha256: 'da948ad707ed690426473aaba2046cd61f8f90f6f0e7dab6be0d5796531de67d' },
};
// restic's license goes with every copy of the program (BSD 2-Clause).
const LICENSE = { url: `https://raw.githubusercontent.com/restic/restic/v${VERSION}/LICENSE`, sha256: '6f08a01a9fab5b24e139a09f15cc24a73087c7bc09e3bacf099fdf2d767bf897' };

const ROOT = path.join(__dirname, '..', 'vendor', 'restic');
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

async function download(url, expected) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`Download failed (${res.status}): ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const got = sha256(buf);
  if (got !== expected) throw new Error(`Checksum mismatch for ${url}\n  expected ${expected}\n  got      ${got}`);
  return buf;
}

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: ['ignore', 'inherit', 'inherit'], ...opts });
  if (r.error) throw new Error(`${cmd} could not run: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed with exit code ${r.status}`);
}

// .bz2 for macOS (bunzip2 comes with macOS), .zip for Windows (tar comes with Windows 10 and later, and with macOS).
function unpack(file, dir, target) {
  const exe = path.join(dir, target.startsWith('win') ? 'restic.exe' : 'restic');
  if (file.endsWith('.bz2')) {
    const fd = fs.openSync(exe, 'w');
    try {
      run('bunzip2', ['-c', file], { stdio: ['ignore', fd, 'inherit'] });
    } finally {
      fs.closeSync(fd);
    }
  } else {
    run('tar', ['-xf', file, '-C', dir]);
    const inner = fs.readdirSync(dir).find((n) => n.startsWith('restic_') && n.endsWith('.exe'));
    if (!inner) throw new Error(`No restic program in ${file}`);
    fs.renameSync(path.join(dir, inner), exe);
  }
  fs.chmodSync(exe, 0o755);
  return exe;
}

async function fetchTarget(target) {
  const { asset, sha256: expected } = TARGETS[target];
  const dir = path.join(ROOT, target);
  const mark = path.join(dir, '.version');
  if (fs.existsSync(mark) && fs.readFileSync(mark, 'utf8').trim() === VERSION) {
    console.log(`restic ${VERSION} ${target}: already there`);
    return;
  }
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, asset);
  fs.writeFileSync(file, await download(`${BASE}/${asset}`, expected));
  const exe = unpack(file, dir, target);
  fs.rmSync(file, { force: true });
  fs.writeFileSync(mark, `${VERSION}\n`);
  console.log(`restic ${VERSION} ${target}: ${path.relative(process.cwd(), exe)}`);
}

function wanted(arg) {
  if (arg === 'all') return Object.keys(TARGETS);
  if (arg === 'mac') return ['mac-arm64', 'mac-x64'];
  if (arg === 'win') return ['win-x64'];
  const os = process.platform === 'darwin' ? 'mac' : process.platform === 'win32' ? 'win' : process.platform;
  const target = `${os}-${process.arch}`;
  if (!TARGETS[target]) throw new Error(`No restic download for ${target}. Supported: ${Object.keys(TARGETS).join(', ')}`);
  return [target];
}

async function main() {
  fs.mkdirSync(ROOT, { recursive: true });
  for (const target of wanted(process.argv[2])) await fetchTarget(target);
  const license = path.join(ROOT, 'LICENSE');
  if (!fs.existsSync(license) || sha256(fs.readFileSync(license)) !== LICENSE.sha256) fs.writeFileSync(license, await download(LICENSE.url, LICENSE.sha256));
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
