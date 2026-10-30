// Development: builds two sample devices, then renders every screen of the app to PNG files.
//   node scripts/screenshots.mjs <output folder> [light|dark]
// Nothing outside a temporary folder is read or written; the real ~/.claude is not touched.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const { createEngine } = require('../lib/engine.js');
const P = require('../lib/paths.js');

const out = path.resolve(process.argv[2] || path.join(ROOT, 'screenshots'));
const theme = process.argv[3] || 'light';
fs.mkdirSync(out, { recursive: true });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cms-shots-'));

function device(name) {
  const home = path.join(tmp, name);
  const claude = path.join(home, '.claude');
  const state = path.join(home, '.claude-memory-sync');
  fs.mkdirSync(path.join(claude, 'projects'), { recursive: true });
  for (const d of ['Desktop', 'Downloads', 'Documents/GitHub']) fs.mkdirSync(path.join(home, d), { recursive: true });
  const env = { CLAUDE_CONFIG_DIR: claude, CLAUDE_MEMORY_SYNC_HOME: state };
  const mem = (folder) => path.join(claude, 'projects', P.encodeProjectDir(path.join(home, folder)), 'memory');
  const d = {
    home, claude, state, env,
    engine: createEngine({ env, home, hostname: name }),
    write(folder, rel, text) {
      fs.mkdirSync(mem(folder), { recursive: true });
      fs.writeFileSync(path.join(mem(folder), rel), text);
    },
    rm: (folder, rel) => fs.unlinkSync(path.join(mem(folder), rel)),
    project(folder, files, git) {
      const abs = path.join(home, folder);
      fs.mkdirSync(abs, { recursive: true });
      if (git) {
        fs.mkdirSync(path.join(abs, '.git'), { recursive: true });
        fs.writeFileSync(path.join(abs, '.git', 'config'), `[remote "origin"]\n\turl = ${git}\n`);
      }
      for (const [rel, text] of Object.entries(files)) d.write(folder, rel, text);
    },
  };
  return d;
}

const md = (title, lines) => `---\nname: ${title}\n---\n\n${lines.join('\n')}\n`;
const gh = (repo) => `https://github.com/omersahin00/${repo}.git`;

// ---- Mac: the device the screenshots are taken on ----
const mac = device('Mer-Mac');
mac.project('Documents/GitHub/sasa-custom-frontend', {
  'MEMORY.md': '- [Proje yapısı](proje-yapisi.md) — Next.js, sayfa ve bileşen düzeni\n- [API istemcisi](api-istemcisi.md) — axios, token yenileme\n- [Stil kuralları](stil-kurallari.md) — Tailwind, renkler\n- [Dağıtım](dagitim.md) — Vercel, ortam değişkenleri\n- [Bilinen hatalar](bilinen-hatalar.md) — Safari tarih hatası\n',
  'proje-yapisi.md': md('proje-yapisi', ['Sayfalar app/ altında.', 'Ortak bileşenler components/ui içinde.']),
  'api-istemcisi.md': md('api-istemcisi', ['Tüm istekler lib/api.ts üzerinden.', '401 gelince token yenilenir.']),
  'stil-kurallari.md': md('stil-kurallari', ['Tailwind kullanılır.', 'Ana renk: teal-700.']),
  'dagitim.md': md('dagitim', ['Vercel üzerinde.', 'main dalı canlıya gider.']),
  'bilinen-hatalar.md': md('bilinen-hatalar', ['Safari’de tarih ayrıştırma hatası.']),
}, gh('sasa-custom-frontend'));
mac.project('Documents/GitHub/sasa-backend-service', {
  'MEMORY.md': '- [Veritabanı](veritabani.md) — PostgreSQL şeması\n- [Job’lar](joblar.md) — gece çalışan job’lar\n',
  'veritabani.md': md('veritabani', ['PostgreSQL 16.', 'Migration: prisma.']),
  'joblar.md': md('joblar', ['C4C job’ı 02:00’de çalışır.']),
}, gh('sasa-backend-service'));
mac.project('Documents/GitHub/finder-api', {
  'MEMORY.md': '- [Uç noktalar](uc-noktalar.md) — REST API\n',
  'uc-noktalar.md': md('uc-noktalar', ['GET /search', 'POST /index']),
}, gh('finder-api'));
mac.project('Desktop', {
  'MEMORY.md': '- [Konuşma tarzı](konusma-tarzi.md) — kısa ve net\n- [Çetaş lead sistemi](cetas-lead-sistemi.md) — web formları, ortak API\n',
  'konusma-tarzi.md': md('konusma-tarzi', ['Kısa ve net cevap.', 'Tek adım ver, sonucu bekle.']),
  'cetas-lead-sistemi.md': md('cetas-lead-sistemi', ['8 web formu tek ortak API’ye bağlanacak.']),
});
mac.project('Library/Application Support/Claude/scratch-workspaces/a1/b2/scratch-2026-10-13-846d13', {
  'MEMORY.md': '- [Not](not.md)\n', 'not.md': md('not', ['Geçici oturum notu.']),
});
const ws = path.join(mac.home, 'Documents/GitHub/workspaces');
fs.mkdirSync(ws, { recursive: true });
fs.writeFileSync(path.join(ws, 'sasa.code-workspace'), '{\n  "folders": [\n    { "path": "../sasa-custom-frontend" },\n    { "path": "../sasa-backend-service" }\n  ],\n  "settings": { "editor.tabSize": 2 }\n}\n');
fs.writeFileSync(path.join(ws, 'calisan-sistem.code-workspace'), `{\n  "folders": [\n    { "path": ${JSON.stringify(path.join(mac.home, 'Documents/GitHub/finder-api'))} },\n    { "path": "../sasa-edgemon-go" }\n  ]\n}\n`);
mac.engine.updateSettings({ deviceName: 'Mer-Mac', workspaceRoots: [path.join(mac.home, 'Documents/GitHub')] });
mac.engine.createBackup('manual');

// ---- Windows laptop: got the Mac's bundle once, then worked on its own ----
const win = device('Omer-Win');
for (const repo of ['sasa-custom-frontend', 'sasa-backend-service', 'akin-case-study']) {
  const abs = path.join(win.home, 'Documents/GitHub', repo);
  fs.mkdirSync(path.join(abs, '.git'), { recursive: true });
  fs.writeFileSync(path.join(abs, '.git', 'config'), `[remote "origin"]\n\turl = ${gh(repo)}\n`);
}
win.engine.updateSettings({ deviceName: 'Omer-Win', workspaceRoots: [path.join(win.home, 'Documents/GitHub')] });
const first = mac.engine.exportBundle({ outDir: path.join(win.home, 'Downloads') });
const p1 = win.engine.prepare({ bundlePath: first.path });
win.engine.apply(p1.id, {});

// Changes on Windows
win.write('Documents/GitHub/sasa-custom-frontend', 'api-istemcisi.md', md('api-istemcisi', ['Tüm istekler lib/api.ts üzerinden.', '401 gelince token yenilenir.', 'İstek zaman aşımı 15 sn yapıldı.']));
win.write('Documents/GitHub/sasa-custom-frontend', 'test-kurallari.md', md('test-kurallari', ['Playwright ile uçtan uca test.', 'CI’da her PR’da çalışır.']));
win.rm('Documents/GitHub/sasa-custom-frontend', 'bilinen-hatalar.md');
win.write('Documents/GitHub/sasa-custom-frontend', 'dagitim.md', md('dagitim', ['Vercel üzerinde.', 'main dalı canlıya gider.', 'Önizleme ortamı: preview dalı.']));
win.write('Documents/GitHub/sasa-custom-frontend', 'MEMORY.md', '- [Proje yapısı](proje-yapisi.md) — Next.js, sayfa ve bileşen düzeni\n- [API istemcisi](api-istemcisi.md) — axios, token yenileme, zaman aşımı\n- [Stil kuralları](stil-kurallari.md) — Tailwind, renkler\n- [Dağıtım](dagitim.md) — Vercel, ortam değişkenleri\n- [Test kuralları](test-kurallari.md) — Playwright\n');
win.write('Desktop', 'mobildev-entegrasyonu.md', md('mobildev-entegrasyonu', ['MobilDev SMS entegrasyonu için IP whitelist bekleniyor.']));
win.write('Desktop', 'MEMORY.md', '- [Konuşma tarzı](konusma-tarzi.md) — kısa ve net\n- [Çetaş lead sistemi](cetas-lead-sistemi.md) — web formları, ortak API\n- [MobilDev entegrasyonu](mobildev-entegrasyonu.md) — SMS, whitelist\n');
win.write('Documents/GitHub/akin-case-study', 'MEMORY.md', '- [Görev](gorev.md) — case study kapsamı\n');
win.write('Documents/GitHub/akin-case-study', 'gorev.md', md('gorev', ['React + Node ile küçük bir sipariş uygulaması.']));

// Changes on the Mac meanwhile: the same file differently (conflict), and a new file of its own.
mac.write('Documents/GitHub/sasa-custom-frontend', 'dagitim.md', md('dagitim', ['Vercel üzerinde.', 'main dalı canlıya gider.', 'Canlı ortam değişkenleri Vercel panelinde.']));
mac.write('Documents/GitHub/sasa-backend-service', 'loglama.md', md('loglama', ['pino ile JSON log.']));

const second = win.engine.exportBundle({ outDir: path.join(mac.home, 'Downloads') });
// Show it as coming from a Windows laptop.
const raw = JSON.parse(zlib.gunzipSync(fs.readFileSync(second.path)).toString('utf8'));
raw.device.platform = 'win32';
fs.writeFileSync(second.path, zlib.gzipSync(Buffer.from(JSON.stringify(raw))));

// ---- Build the window and render the steps ----
if (!fs.existsSync(path.join(ROOT, 'dist/renderer/index.html'))) {
  const b = spawnSync(process.execPath, [path.join(ROOT, 'node_modules/vite/bin/vite.js'), 'build'], { cwd: ROOT, stdio: 'inherit' });
  if (b.status) process.exit(b.status);
}
const click = (sel) => `(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) throw new Error('not found: ${sel}'); el.click(); })()`;
const go = (id, params) => `window.__cms.go(${JSON.stringify(id)}, ${JSON.stringify(params || {})})`;
const esc = "window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))";
const steps = [
  { name: '01-genel-bakis', js: go('home') },
  { name: '02-hafizalar', js: go('projects') },
  { name: '03-hafiza-detay', js: click('.card .rows .row.clickable'), wait: 1200 },
  { js: esc, wait: 300 },
  { name: '04-workspaceler', js: go('workspaces') },
  { name: '05-workspace-duzelt', js: click('.card .rows .btn.sm'), wait: 1200 },
  { js: esc, wait: 300 },
  { name: '06-yedekler', js: go('backups') },
  { name: '07-paket-olustur', js: go('transfer', { tab: 'export' }) },
  { name: '08-paket-sec', js: go('transfer', { tab: 'import' }) },
  { name: '09-aktar-1-paket', js: go('transfer', { bundle: second.path }), wait: 1400 },
  { name: '10-aktar-2-eslestirme', js: click('[data-testid="next"]'), wait: 1400 },
  { name: '11-aktar-3-degisiklikler', js: click('[data-testid="next"]'), wait: 1400 },
  { name: '12-aktar-3-fark', js: click('[data-group="conflict"] .rows .btn.ghost'), wait: 1200 },
  { js: esc, wait: 300 },
  { name: '13-aktar-3-kararlar', js: click('[data-testid="keep-all"]'), wait: 1000 },
  { name: '14-aktar-4-onay', js: click('[data-testid="next"]'), wait: 1000 },
  { name: '15-aktar-5-sonuc', js: click('[data-testid="apply"]'), wait: 1600 },
  { name: '16-geri-al', js: click('[data-testid="undo"]'), wait: 1200 },
  { name: '17-gecmis', js: click('[data-testid="undo-apply"]'), wait: 1600 },
  { name: '18-ayarlar', js: go('settings') },
];
const stepsFile = path.join(tmp, 'steps.json');
fs.writeFileSync(stepsFile, JSON.stringify(steps));

const electron = require('electron');
const r = spawnSync(electron, [ROOT], {
  cwd: ROOT,
  stdio: 'inherit',
  env: {
    ...process.env,
    HOME: mac.home,
    USERPROFILE: mac.home,
    CLAUDE_CONFIG_DIR: mac.claude,
    CLAUDE_MEMORY_SYNC_HOME: mac.state,
    CMS_SCREENSHOT_DIR: out,
    CMS_SCREENSHOT_STEPS: stepsFile,
    CMS_THEME: theme,
  },
  timeout: 240000,
});
console.log(`electron exited with ${r.status}; screenshots in ${out}; sample devices in ${tmp}`);
