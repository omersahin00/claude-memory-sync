// Development: builds two sample devices, then renders every screen of the app to PNG files, with the text of each
// screen in a .txt file next to it.
//   node scripts/screenshots.mjs <output folder> [light|dark] [en|tr|de|es|fr]
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
const language = process.argv[4] || 'en';
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
  'MEMORY.md': '- [Project structure](project-structure.md) — Next.js pages and components\n- [API client](api-client.md) — fetch wrapper, token refresh\n- [Style rules](style-rules.md) — Tailwind, colors\n- [Deployment](deployment.md) — Vercel, environment variables\n- [Known bugs](known-bugs.md) — Safari date bug\n',
  'project-structure.md': md('project-structure', ['Pages live under app/.', 'Shared components are in components/ui.']),
  'api-client.md': md('api-client', ['Every request goes through lib/api.ts.', 'A 401 refreshes the token.']),
  'style-rules.md': md('style-rules', ['Tailwind only.', 'Primary color: teal-700.']),
  'deployment.md': md('deployment', ['Hosted on Vercel.', 'The main branch goes to production.']),
  'known-bugs.md': md('known-bugs', ['Date parsing fails in Safari.']),
}, gh('shop-web'));
mac.project('Documents/GitHub/shop-api', {
  'MEMORY.md': '- [Database](database.md) — PostgreSQL schema\n- [Scheduled jobs](scheduled-jobs.md) — nightly jobs\n',
  'database.md': md('database', ['PostgreSQL 16.', 'Migrations: prisma.']),
  'scheduled-jobs.md': md('scheduled-jobs', ['The report job runs every night at 02:00.']),
}, gh('shop-api'));
mac.project('Documents/GitHub/search-service', {
  'MEMORY.md': '- [Endpoints](endpoints.md) — REST API\n',
  'endpoints.md': md('endpoints', ['GET /search', 'POST /index']),
}, gh('search-service'));
mac.project('Desktop', {
  'MEMORY.md': '- [Preferences](preferences.md) — short answers\n- [Weekly plan](weekly-plan.md) — tasks for this week\n',
  'preferences.md': md('preferences', ['Keep answers short.', 'One step at a time.']),
  'weekly-plan.md': md('weekly-plan', ['Redesign the checkout page.', 'Add caching to the search service.']),
});
mac.project('Library/Application Support/Claude/scratch-workspaces/a1/b2/scratch-2026-10-13-846d13', {
  'MEMORY.md': '- [Note](note.md)\n', 'note.md': md('note', ['Scratch session note.']),
});
mac.workspace('shop.code-workspace', ['../shop-web', '../shop-api'], ',\n  "settings": { "editor.tabSize": 2 }');
mac.workspace('search.code-workspace', [path.join(mac.home, 'Documents/GitHub/search-service'), '../search-ui']);
mac.engine.updateSettings({ deviceName: 'MacBook', workspaceRoots: [path.join(mac.home, 'Documents/GitHub')], language, theme, daily: { enabled: true } });
mac.engine.createBackup('manual');

// ---- Windows PC: got the Mac's bundle once, then worked on its own ----
const win = device('win', 'Office-PC');
for (const repo of ['shop-web', 'shop-api', 'case-study']) win.repo(`Documents/GitHub/${repo}`, gh(repo));
win.engine.updateSettings({ deviceName: 'Office-PC', workspaceRoots: [path.join(win.home, 'Documents/GitHub')] });
const first = mac.engine.exportBundle({ outDir: path.join(win.home, 'Downloads') });
win.engine.apply(win.engine.prepare({ bundlePath: first.path }).id, {});

// Changes on Windows
win.write('Documents/GitHub/shop-web', 'api-client.md', md('api-client', ['Every request goes through lib/api.ts.', 'A 401 refreshes the token.', 'Request timeout raised to 15 s.']));
win.write('Documents/GitHub/shop-web', 'test-rules.md', md('test-rules', ['End-to-end tests with Playwright.', 'They run on every PR in CI.']));
win.rm('Documents/GitHub/shop-web', 'known-bugs.md');
win.write('Documents/GitHub/shop-web', 'deployment.md', md('deployment', ['Hosted on Vercel.', 'The main branch goes to production.', 'Preview environment: the preview branch.']));
win.write('Documents/GitHub/shop-web', 'MEMORY.md', '- [Project structure](project-structure.md) — Next.js pages and components\n- [API client](api-client.md) — fetch wrapper, token refresh, timeout\n- [Style rules](style-rules.md) — Tailwind, colors\n- [Deployment](deployment.md) — Vercel, environment variables\n- [Test rules](test-rules.md) — Playwright\n');
win.write('Desktop', 'reading-list.md', md('reading-list', ['Next.js caching docs.', 'PostgreSQL index guide.']));
win.write('Desktop', 'MEMORY.md', '- [Preferences](preferences.md) — short answers\n- [Weekly plan](weekly-plan.md) — tasks for this week\n- [Reading list](reading-list.md) — docs to read\n');
win.write('Documents/GitHub/case-study', 'MEMORY.md', '- [Task](task.md) — case study scope\n');
win.write('Documents/GitHub/case-study', 'task.md', md('task', ['A small ordering app with React and Node.']));
// New and changed workspaces on Windows; on the Mac some of the repositories they open are there, some are not.
win.workspace('api.code-workspace', ['../shop-api']);
win.workspace('search-full.code-workspace', ['../search-service', '../search-ui']);
win.workspace('case.code-workspace', ['../case-study']);
win.workspace('shop.code-workspace', ['../shop-web', '../shop-api'], ',\n  "settings": { "editor.tabSize": 2, "editor.formatOnSave": true }');

// Changes on the Mac meanwhile: the same file differently (conflict), and a new file of its own.
mac.write('Documents/GitHub/shop-web', 'deployment.md', md('deployment', ['Hosted on Vercel.', 'The main branch goes to production.', 'Production variables live in the Vercel dashboard.']));
mac.write('Documents/GitHub/shop-api', 'logging.md', md('logging', ['JSON logs with pino.']));

const second = win.engine.exportBundle({ outDir: path.join(mac.home, 'Downloads') });
// Show it as coming from a Windows PC: platform and the paths it names.
const raw = JSON.parse(zlib.gunzipSync(fs.readFileSync(second.path)).toString('utf8'));
raw.device.platform = 'win32';
const winPath = (p) => (typeof p === 'string' && p.startsWith(win.home) ? `C:\\Users\\demo${p.slice(win.home.length).split('/').join('\\')}` : p);
raw.device.home = winPath(raw.device.home);
for (const loc of Object.values(raw.locations)) loc.path = winPath(loc.path);
fs.writeFileSync(second.path, zlib.gzipSync(Buffer.from(JSON.stringify(raw))));

// ---- A folder on another disk that already holds backups: of this device, of an earlier install on this computer, of
// the Windows PC, and damaged ones. Choosing it is what the backup folder steps below show. ----
const outside = path.join(mac.home, 'External/Backups');
const sample = JSON.parse(zlib.gunzipSync(fs.readFileSync(fs.readdirSync(path.join(mac.state, 'backups/manual')).map((f) => path.join(mac.state, 'backups/manual', f))[0])).toString('utf8'));
const put = (rel, obj) => {
  fs.mkdirSync(path.dirname(path.join(outside, rel)), { recursive: true });
  fs.writeFileSync(path.join(outside, rel), zlib.gzipSync(Buffer.from(JSON.stringify(obj))));
};
for (const day of ['28', '29']) put(`daily/202610${day}-120000-daily.memsync`, { ...sample, kind: 'daily', createdAt: `2026-10-${day}T09:00:00.000Z` });
for (const day of ['12', '13']) put(`manual/202609${day}-101500-manual.memsync`, { ...sample, createdAt: `2026-09-${day}T07:15:00.000Z`, device: { ...sample.device, id: 'an-earlier-install', hostname: os.hostname() } });
put('manual/20261020-093000-manual.memsync', { ...raw, kind: 'manual', createdAt: '2026-10-20T06:30:00.000Z' });
fs.writeFileSync(path.join(outside, 'daily/20261001-120000-daily.memsync'), 'damaged');

// ---- Build the window and render the steps ----
if (!fs.existsSync(path.join(ROOT, 'dist/renderer/index.html'))) {
  const b = spawnSync(process.execPath, [path.join(ROOT, 'node_modules/vite/bin/vite.js'), 'build'], { cwd: ROOT, stdio: 'inherit' });
  if (b.status) process.exit(b.status);
}
const click = (sel) => `(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) throw new Error('not found: ${sel}'); el.click(); })()`;
const go = (id, params) => `window.__cms.go(${JSON.stringify(id)}, ${JSON.stringify(params || {})})`;
const esc = "window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))";
const steps = [
  { name: '01-overview', js: go('home') },
  { name: '02-memories', js: go('projects') },
  { name: '03-memory-detail', js: click('.card .rows .row.clickable'), wait: 1200 },
  { js: esc, wait: 300 },
  { name: '04-workspaces', js: go('workspaces') },
  { name: '05-workspace-fix', js: click('.card .rows .btn.sm'), wait: 1200 },
  { js: esc, wait: 300 },
  { name: '06-backups', js: go('backups') },
  { name: '07-create-bundle', js: go('transfer', { tab: 'export' }) },
  { name: '08-choose-bundle', js: go('transfer', { tab: 'import' }) },
  { name: '09-import-1-bundle', js: go('transfer', { bundle: second.path }), wait: 1400 },
  { name: '10-import-2-matching', js: click('[data-testid="next"]'), wait: 1400 },
  { name: '11-import-3-changes', js: click('[data-testid="next"]'), wait: 1400 },
  { name: '11-import-3-workspaces', js: click('[data-testid="tab-workspaces"]'), wait: 900 },
  { js: click('[data-testid="tab-memory"]'), wait: 600 },
  { name: '12-import-3-diff', js: click('[data-group="conflict"] .rows .btn.ghost'), wait: 1200 },
  { js: esc, wait: 300 },
  { name: '13-import-3-decisions', js: click('[data-testid="keep-all"]'), wait: 1000 },
  { name: '14-import-4-confirm', js: click('[data-testid="next"]'), wait: 1000 },
  { name: '15-import-5-result', js: click('[data-testid="apply"]'), wait: 1600 },
  { name: '16-undo', js: click('[data-testid="undo"]'), wait: 1200 },
  { name: '17-history', js: click('[data-testid="undo-apply"]'), wait: 1600 },
  { name: '18-settings', js: go('settings') },
  { name: '19-settings-language', js: "document.querySelector('[data-testid=\"language\"]').scrollIntoView({ block: 'center' })", wait: 500 },
  // Keeping two manual backups makes the limit warning show.
  { js: "window.cms.invoke('updateSettings', [{ keepManual: 2 }])", wait: 300 },
  { name: '20-backup-folder-review', js: click('[data-testid="backup-folder-change"]'), wait: 1600 },
  { name: '21-backup-folder-leave', js: click('[data-testid="folder-move"]'), wait: 500 },
  { js: click('[data-testid="folder-apply"]'), wait: 1200 },
  { name: '22-backups-left-behind', js: go('backups') },
  { name: '23-backup-folder-move-here', js: click('[data-testid="backups-elsewhere"]'), wait: 1200 },
  { name: '24-backup-folder-moved', js: click('[data-testid="folder-apply"]'), wait: 1400 },
  { js: click('[data-testid="folder-close"]'), wait: 400 },
  { name: '25-backups-after-move', js: go('backups') },
  { name: '26-history-after-move', js: go('activity') },
  // The question of a new install, answered no, and the switch on Overview that turns it on again.
  { js: "window.cms.invoke('updateSettings', [{ daily: { ask: true } }]).then(() => window.__cms.refresh())", wait: 400 },
  { name: '27-daily-question', js: go('home'), wait: 900 },
  { name: '28-daily-off', js: click('[data-testid="daily-no"]'), wait: 900 },
  { name: '29-daily-on', js: click('[data-testid="daily-toggle"]'), wait: 900 },
];
const stepsFile = path.join(tmp, 'steps.json');
fs.writeFileSync(stepsFile, JSON.stringify(steps));

const electron = require('electron');
const r = spawnSync(electron, [ROOT], {
  cwd: ROOT,
  stdio: 'inherit',
  env: {
    ...process.env,
    ELECTRON_RUN_AS_NODE: undefined, // set in shells started by an Electron app such as VS Code; the app would not start
    HOME: mac.home,
    USERPROFILE: mac.home,
    CLAUDE_CONFIG_DIR: mac.claude,
    CLAUDE_MEMORY_SYNC_HOME: mac.state,
    CMS_SCREENSHOT_DIR: out,
    CMS_SCREENSHOT_STEPS: stepsFile,
    CMS_SHOT_FOLDER: outside,
  },
  timeout: 240000,
});
console.log(`electron exited with ${r.status}; screenshots in ${out}; sample devices in ${tmp}`);
