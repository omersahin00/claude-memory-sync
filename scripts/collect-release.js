'use strict';
// Runs after electron-builder: moves the installers it made in dist/electron into release/, so release/ holds only
// what is handed out. Older installers and the leftovers of builds that wrote straight into release/ are removed there;
// anything else in release/ is left alone. The Mac processor is named the way Mac users know it:
// Claude-Memory-Sync-macOS-arm64-2.2.1.dmg becomes Claude-Memory-Sync-macOS-Apple-Silicon-2.2.1.dmg.
//   node scripts/collect-release.js mac|win
const fs = require('fs');
const path = require('path');

const EXT = { mac: '.dmg', win: '.exe' };
const LEFTOVER = /^(win-unpacked|mac|mac-arm64|mac-universal|\.icon-icns|\.icon-ico|builder-debug\.yml|builder-effective-config\.yaml|latest(-mac)?\.yml)$|\.(blockmap|zip)$/;
const PROCESSOR = { arm64: 'Apple-Silicon', x64: 'Intel' };
const publicName = (name) => name.replace(/-macOS-(arm64|x64)-/, (m, arch) => `-macOS-${PROCESSOR[arch]}-`);

const platform = process.argv[2];
if (!EXT[platform]) {
  console.error('usage: node scripts/collect-release.js mac|win');
  process.exit(1);
}
const root = path.join(__dirname, '..');
const from = path.join(root, 'dist', 'electron');
const to = path.join(root, 'release');
const installers = fs.readdirSync(from).filter((name) => name.endsWith(EXT[platform]) && !name.startsWith('__'));
if (!installers.length) {
  console.error(`No ${EXT[platform]} file in ${from}`);
  process.exit(1);
}
fs.mkdirSync(to, { recursive: true });
for (const name of fs.readdirSync(to)) {
  if (name.endsWith(EXT[platform]) || LEFTOVER.test(name)) fs.rmSync(path.join(to, name), { recursive: true, force: true });
}
for (const name of installers) {
  fs.renameSync(path.join(from, name), path.join(to, publicName(name)));
  console.log(`release/${publicName(name)}`);
}
