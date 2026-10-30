// Development: builds two sample devices, then renders every screen of the app to PNG files.
//   node scripts/screenshots.mjs <output folder> [light|dark]
// Nothing outside the sample folder is read or written; the real ~/.claude is not touched.
//   CMS_SHOTS_HOME=<empty or missing folder>  put the sample devices there (shorter paths in the pictures)
//   CMS_SCALE=2                               render at twice the pixel density
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
const fixed = process.env.CMS_SHOTS_HOME;
if (fixed && fs.existsSync(fixed) && fs.readdirSync(fixed).length) {
  console.error(`${fixed} is not empty`);
  process.exit(1);
}
const tmp = fixed ? (fs.mkdirSync(fixed, { recursive: true }), path.resolve(fixed)) : fs.mkdtempSync(path.join(os.tmpdir(), 'cms-shots-'));

function device(folder, name) {
  const home = path.join(tmp, folder);
  const claude = path.join(home, '.claude');
  const state = path.join(home, '.claude-memory-sync');
  fs.mkdirSync(path.join(claude, 'projects'), { recursive: true });
  for (const d of ['Desktop', 'Downloads', 'Documents/GitHub']) fs.mkdirSync(path.join(home, d), { recursive: true });
  const env = { CLAUDE_CONFIG_DIR: claude, CLAUDE_MEMORY_SYNC_HOME: state };
  const mem = (dir) => path.join(claude, 'projects', P.encodeProjectDir(path.join(home, dir)), 'memory');
  const d = {
    home, claude, state, env,
    engine: createEngine({ env, home, hostname: name }),
    write(dir, rel, text) {
      fs.mkdirSync(mem(dir), { recursive: true });
      fs.writeFileSync(path.join(mem(dir), rel), text);
    },
    rm: (dir, rel) => fs.unlinkSync(path.join(mem(dir), rel)),
    repo(dir, git) {
      const abs = path.join(home, dir);
      fs.mkdirSync(path.join(abs, '.git'), { recursive: true });
      fs.writeFileSync(path.join(abs, '.git', 'config'), `[remote "origin"]\n\turl = ${git}\n`);
    },
    project(dir, files, git) {
      fs.mkdirSync(path.join(home, dir), { recursive: true });
      if (git) d.repo(dir, git);
      for (const [rel, text] of Object.entries(files)) d.write(dir, rel, text);
    },
    workspace(name, folders, extra = '') {
      const dir = path.join(home, 'Documents/GitHub/workspaces');
      fs.mkdirSync(dir, { recursive: true });
      const lines = folders.map((f) => `    { "path": ${JSON.stringify(f)} }`).join(',\n');
      fs.writeFileSync(path.join(dir, name), `{\n  "folders": [\n${lines}\n  ]${extra}\n}\n`);
    },
  };
  return d;
}

const md = (title, lines) => `---\nname: ${title}\n---\n\n${lines.join('\n')}\n`;
const gh = (repo) => `https://github.com/example/${repo}.git`;

// ---- Mac: the device the screenshots are taken on ----
const mac = device('mac', 'MacBook');
mac.project('Documents/GitHub/shop-web', {
  'MEMORY.md': '- [Proje yapısı](proje-yapisi.md) — Next.js, sayfa ve bileşen düzeni\n- [API istemcisi](api-istemcisi.md) — fetch sarmalayıcı, token yenileme\n- [Stil kuralları](stil-kurallari.md) — Tailwind, renkler\n- [Dağıtım](dagitim.md) — Vercel, ortam değişkenleri\n- [Bilinen hatalar](bilinen-hatalar.md) — Safari tarih hatası\n',
  'proje-yapisi.md': md('proje-yapisi', ['Sayfalar app/ altında.', 'Ortak bileşenler components/ui içinde.']),
  'api-istemcisi.md': md('api-istemcisi', ['Tüm istekler lib/api.ts üzerinden.', '401 gelince token yenilenir.']),
  'stil-kurallari.md': md('stil-kurallari', ['Tailwind kullanılır.', 'Ana renk: teal-700.']),
  'dagitim.md': md('dagitim', ['Vercel üzerinde.', 'main dalı canlıya gider.']),
  'bilinen-hatalar.md': md('bilinen-hatalar', ['Safari’de tarih ayrıştırma hatası.']),
}, gh('shop-web'));
mac.project('Documents/GitHub/shop-api', {
  'MEMORY.md': '- [Veritabanı](veritabani.md) — PostgreSQL şeması\n- [Zamanlanmış işler](zamanlanmis-isler.md) — gece çalışan işler\n',
  'veritabani.md': md('veritabani', ['PostgreSQL 16.', 'Migration: prisma.']),
  'zamanlanmis-isler.md': md('zamanlanmis-isler', ['Rapor işi her gece 02:00’de çalışır.']),
}, gh('shop-api'));
mac.project('Documents/GitHub/search-service', {
  'MEMORY.md': '- [Uç noktalar](uc-noktalar.md) — REST API\n',
  'uc-noktalar.md': md('uc-noktalar', ['GET /search', 'POST /index']),
}, gh('search-service'));
mac.project('Desktop', {
  'MEMORY.md': '- [Tercihler](tercihler.md) — kısa yanıt, Türkçe\n- [Haftalık plan](haftalik-plan.md) — bu haftanın işleri\n',
  'tercihler.md': md('tercihler', ['Yanıtlar kısa ve Türkçe olsun.', 'Her seferinde tek adım ver.']),
  'haftalik-plan.md': md('haftalik-plan', ['Ödeme sayfası yenilenecek.', 'Arama servisine önbellek eklenecek.']),
});
mac.project('Library/Application Support/Claude/scratch-workspaces/a1/b2/scratch-2026-10-13-846d13', {
  'MEMORY.md': '- [Not](not.md)\n', 'not.md': md('not', ['Geçici oturum notu.']),
});
mac.workspace('shop.code-workspace', ['../shop-web', '../shop-api'], ',\n  "settings": { "editor.tabSize": 2 }');
mac.workspace('search.code-workspace', [path.join(mac.home, 'Documents/GitHub/search-service'), '../search-ui']);
mac.engine.updateSettings({ deviceName: 'MacBook', workspaceRoots: [path.join(mac.home, 'Documents/GitHub')] });
mac.engine.createBackup('manual');

// ---- Windows PC: got the Mac's bundle once, then worked on its own ----
const win = device('win', 'Ofis-PC');
for (const repo of ['shop-web', 'shop-api', 'case-study']) win.repo(`Documents/GitHub/${repo}`, gh(repo));
win.engine.updateSettings({ deviceName: 'Ofis-PC', workspaceRoots: [path.join(win.home, 'Documents/GitHub')] });
const first = mac.engine.exportBundle({ outDir: path.join(win.home, 'Downloads') });
win.engine.apply(win.engine.prepare({ bundlePath: first.path }).id, {});

// Changes on Windows
win.write('Documents/GitHub/shop-web', 'api-istemcisi.md', md('api-istemcisi', ['Tüm istekler lib/api.ts üzerinden.', '401 gelince token yenilenir.', 'İstek zaman aşımı 15 sn yapıldı.']));
win.write('Documents/GitHub/shop-web', 'test-kurallari.md', md('test-kurallari', ['Playwright ile uçtan uca test.', 'CI’da her PR’da çalışır.']));
win.rm('Documents/GitHub/shop-web', 'bilinen-hatalar.md');
win.write('Documents/GitHub/shop-web', 'dagitim.md', md('dagitim', ['Vercel üzerinde.', 'main dalı canlıya gider.', 'Önizleme ortamı: preview dalı.']));
win.write('Documents/GitHub/shop-web', 'MEMORY.md', '- [Proje yapısı](proje-yapisi.md) — Next.js, sayfa ve bileşen düzeni\n- [API istemcisi](api-istemcisi.md) — fetch sarmalayıcı, token yenileme, zaman aşımı\n- [Stil kuralları](stil-kurallari.md) — Tailwind, renkler\n- [Dağıtım](dagitim.md) — Vercel, ortam değişkenleri\n- [Test kuralları](test-kurallari.md) — Playwright\n');
win.write('Desktop', 'okunacaklar.md', md('okunacaklar', ['Next.js önbellek belgeleri.', 'PostgreSQL indeks rehberi.']));
win.write('Desktop', 'MEMORY.md', '- [Tercihler](tercihler.md) — kısa yanıt, Türkçe\n- [Haftalık plan](haftalik-plan.md) — bu haftanın işleri\n- [Okunacaklar](okunacaklar.md) — belge listesi\n');
win.write('Documents/GitHub/case-study', 'MEMORY.md', '- [Görev](gorev.md) — case study kapsamı\n');
win.write('Documents/GitHub/case-study', 'gorev.md', md('gorev', ['React + Node ile küçük bir sipariş uygulaması.']));
// New and changed workspaces on Windows; on the Mac some of the repositories they open are there, some are not.
win.workspace('api.code-workspace', ['../shop-api']);
win.workspace('search-full.code-workspace', ['../search-service', '../search-ui']);
win.workspace('case.code-workspace', ['../case-study']);
win.workspace('shop.code-workspace', ['../shop-web', '../shop-api'], ',\n  "settings": { "editor.tabSize": 2, "editor.formatOnSave": true }');

// Changes on the Mac meanwhile: the same file differently (conflict), and a new file of its own.
mac.write('Documents/GitHub/shop-web', 'dagitim.md', md('dagitim', ['Vercel üzerinde.', 'main dalı canlıya gider.', 'Canlı ortam değişkenleri Vercel panelinde.']));
mac.write('Documents/GitHub/shop-api', 'loglama.md', md('loglama', ['pino ile JSON log.']));

const second = win.engine.exportBundle({ outDir: path.join(mac.home, 'Downloads') });
// Show it as coming from a Windows PC: platform and the paths it names.
const raw = JSON.parse(zlib.gunzipSync(fs.readFileSync(second.path)).toString('utf8'));
raw.device.platform = 'win32';
const winPath = (p) => (typeof p === 'string' && p.startsWith(win.home) ? `C:\\Users\\demo${p.slice(win.home.length).split('/').join('\\')}` : p);
raw.device.home = winPath(raw.device.home);
for (const loc of Object.values(raw.locations)) loc.path = winPath(loc.path);
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
  { name: '11-aktar-3-workspaceler', js: click('[data-testid="tab-workspaces"]'), wait: 900 },
  { js: click('[data-testid="tab-memory"]'), wait: 600 },
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
