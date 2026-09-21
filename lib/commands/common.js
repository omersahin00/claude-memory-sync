'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const ui = require('../ui');
const P = require('../paths');
const S = require('../state');
const { readTree, attachProject } = require('../scan');
const { buildBundle, writeBundle } = require('../bundle');
const { AbortError } = require('../merge');

const { c } = ui;
const DEFAULT_PREFIX = 'sasa';
const METHOD = { name: 'folder name', session: 'session log', guess: 'guessed' };

const pad2 = (n) => String(n).padStart(2, '0');
const stamp = (d = new Date()) =>
  `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}-${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`;
const slug = (s) => String(s).toLocaleLowerCase('tr').replace(/ı/g, 'i').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'device';

function guessReposRoot(prefix) {
  const index = P.createProjectIndex(path.join(P.claudeDir(), 'projects'));
  const counts = new Map();
  for (const d of index.dirs) {
    for (const cwd of index.cwdsOf(d)) {
      if (!path.basename(cwd).toLowerCase().startsWith(prefix.toLowerCase())) continue;
      const parent = path.dirname(cwd);
      if (fs.existsSync(parent)) counts.set(parent, (counts.get(parent) || 0) + 1);
    }
  }
  const best = [...counts].sort((a, b) => b[1] - a[1])[0];
  if (best) return best[0];
  const home = os.homedir();
  return (
    [['Documents', 'GitHub'], ['GitHub'], ['source', 'repos'], ['repos'], ['projects'], ['code'], ['Desktop', 'GitHub']]
      .map((p) => path.join(home, ...p))
      .find((p) => fs.existsSync(p)) || null
  );
}

async function askOrAbort(q) {
  const a = await ui.ask(q);
  if (a === null) throw new AbortError('Cancelled.');
  return a.replace(/^["']|["']$/g, '');
}

async function setup(existing) {
  ui.section('Settings');
  const cdir = P.claudeDir();
  ui.table([
    ['Operating system', P.platformName()],
    ['Claude folder', `${cdir} ${fs.existsSync(cdir) ? c.green('(exists)') : c.red('(missing)')}`],
    ['State folder', S.stateHome()],
  ], { indent: 2 });
  if (!fs.existsSync(cdir)) console.log(c.yellow('  Claude Code does not seem to have run on this device yet. Install it and sign in first.'));
  console.log('');

  const prefixDefault = (existing && existing.prefix) || DEFAULT_PREFIX;
  const prefix = (await askOrAbort(`  Repo prefix [${prefixDefault}]: `)) || prefixDefault;

  const rootDefault = (existing && existing.reposRoot) || guessReposRoot(prefix);
  let reposRoot;
  for (;;) {
    const a = await askOrAbort(`  Folder that contains the repos${rootDefault ? ` [${rootDefault}]` : ''}: `);
    const candidate = a ? path.resolve(a.replace(/^~(?=$|[\\/])/, os.homedir())) : rootDefault;
    if (candidate && fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
      reposRoot = candidate;
      break;
    }
    console.log(c.yellow(`  Folder not found: ${candidate || '(empty)'}`));
  }

  const nameDefault = (existing && existing.deviceName) || os.hostname();
  const deviceName = (await askOrAbort(`  Device name [${nameDefault}]: `)) || nameDefault;

  const cfg = S.newConfig({ reposRoot, deviceName, prefix, deviceId: existing && existing.deviceId });
  console.log('');
  ui.table([['Prefix', cfg.prefix], ['Repos folder', cfg.reposRoot], ['Device name', cfg.deviceName], ['Saved to', S.configPath()]], { indent: 2 });
  if (!(await ui.confirm('  Save these settings?'))) throw new AbortError('Settings were not saved.');
  S.saveConfig(cfg);
  console.log(c.green('  Settings saved.'));
  return cfg;
}

async function ensureConfig() {
  const cfg = S.loadConfig();
  if (cfg) return cfg;
  console.log(c.bold('First run on this device; a few settings are needed.'));
  return setup(null);
}

function printDevice(config, scan) {
  ui.section('Device');
  ui.table([
    ['Operating system', P.platformName(scan.platform)],
    ['Device name', config.deviceName],
    ['Claude folder', `${scan.claudeDir} ${scan.projectsRootExists ? c.green('(exists)') : c.red('(no projects folder)')}`],
    ['Repos folder', `${scan.reposRoot} ${scan.reposRootExists ? c.green('(exists)') : c.red('(missing)')}`],
    ['Prefix', scan.prefix],
  ], { indent: 2 });
}

function projectLabel(repo) {
  if (repo.ambiguous) return c.yellow(`${repo.candidates.length} candidates, choice needed`);
  if (!repo.project) return c.gray('none');
  const m = repo.project.method;
  return `${c.green('yes')} ${m === 'guess' ? c.yellow('(guessed match)') : c.dim(`(${METHOD[m]})`)}`;
}

function printRepos(scan) {
  ui.section('Repos');
  if (!scan.repos.length) {
    console.log(c.yellow(`  No repos with prefix "${scan.prefix}" found.`));
    return;
  }
  const rows = [[c.bold('REPO'), c.bold('GIT'), c.bold('CLAUDE PROJECT'), c.bold('MEMORY')]];
  for (const r of scan.repos) {
    rows.push([
      r.name + (r.outsideRoot ? c.yellow(' (outside repos folder)') : ''),
      r.isGit ? 'yes' : c.gray('no'),
      projectLabel(r),
      r.files.size ? `${r.files.size} files` : c.gray('-'),
    ]);
  }
  ui.table(rows, { indent: 2 });
  for (const r of scan.repos) {
    if (r.project && r.project.method === 'guess') console.log(c.yellow(`  ! ${r.name}: Claude project matched only by name suffix → ${r.project.dir}`));
    if (r.outsideRoot) console.log(c.yellow(`  ! ${r.name}: outside the repos folder → ${r.path}`));
  }
  for (const s of scan.stray) {
    console.log(c.yellow(`  ! ${s.repo}: a Claude project opened from another path has ${s.count} memory files and is not included → ${s.dir} (${s.cwd})`));
  }
}

function printWorkspaces(scan) {
  ui.section('Workspace files');
  if (!scan.workspaces.size) {
    console.log(c.gray('  No workspace file references a prefixed repo.'));
    return;
  }
  for (const [rel, w] of scan.workspaces) {
    console.log(`  ${rel}  ${c.dim(`(${w.folders.length} folders)`)}`);
    for (const warn of w.warnings) console.log(c.yellow(`     ! ${warn}`));
  }
}

async function resolveAmbiguous(repos) {
  for (const r of repos.filter((x) => x.ambiguous)) {
    console.log('');
    console.log(c.yellow(`More than one Claude project with memories was found for ${r.name}:`));
    const options = r.candidates.map((cand, i) => ({
      key: String(i + 1),
      label: `${cand.name} ${c.dim(`(${readTree(path.join(cand.dir, 'memory')).size} files, ${METHOD[cand.method]})`)}`,
    }));
    const k = await ui.choose('Which one belongs to this repo?', options);
    if (k === null) throw new AbortError('Cancelled.');
    attachProject(r, r.candidates[Number(k) - 1]);
    r.ambiguous = false;
  }
}

// Snapshot of this device: bundle files, repo info and history.
// protectEmpty: leave out scopes that had files before but look empty now
// (so an accidentally emptied folder does not turn into a mass delete on the other device).
function collectLocal(scan, localHist, { protectEmpty }) {
  const files = new Map();
  const repos = {};
  const warnings = [];
  const localHistory = new Map([...localHist].map(([k, v]) => [k, new Set(v)]));
  const note = (key, hash) => {
    if (!localHistory.has(key)) localHistory.set(key, new Set());
    localHistory.get(key).add(hash);
  };
  const hasHistory = (prefix) => [...localHist.keys()].some((k) => k.startsWith(prefix));

  for (const r of scan.repos) {
    let hasMemory = Boolean(r.project);
    if (hasMemory && protectEmpty && r.files.size === 0 && hasHistory(`memory/${r.name}/`)) {
      hasMemory = false;
      warnings.push(`${r.name}: memory folder is empty but had files before; it may have been deleted by mistake, so it was left out of the bundle.`);
    }
    repos[r.name] = { remote: r.remote, hasMemory, memoryFiles: hasMemory ? r.files.size : 0 };
    if (!hasMemory) continue;
    for (const [rel, f] of r.files) {
      const key = P.memoryKey(r.name, rel);
      files.set(key, { buf: f.buf });
      note(key, f.hash);
    }
  }

  let workspacesIncluded = scan.reposRootExists;
  if (workspacesIncluded && protectEmpty && scan.workspaces.size === 0 && hasHistory('workspace/')) {
    workspacesIncluded = false;
    warnings.push('No workspace files found, but there were some before; workspaces were left out of the bundle.');
  }
  if (workspacesIncluded) {
    for (const [rel, w] of scan.workspaces) {
      const key = P.workspaceKey(rel);
      files.set(key, { buf: w.buf });
      note(key, w.hash);
    }
  }

  const bundleHistory = new Map();
  for (const [k, v] of localHistory) {
    const p = P.parseKey(k);
    if (!p) continue;
    if (p.scope === 'memory' && !(repos[p.repo] && repos[p.repo].hasMemory)) continue;
    if (p.scope === 'workspace' && !workspacesIncluded) continue;
    bundleHistory.set(k, v);
  }
  return { files, repos, workspacesIncluded, bundleHistory, localHistory, warnings };
}

function writeLocalBundle(config, scan, collected, abs) {
  const bundle = buildBundle({
    config,
    platform: scan.platform,
    hostname: os.hostname(),
    repos: collected.repos,
    workspacesIncluded: collected.workspacesIncluded,
    files: collected.files,
    history: collected.bundleHistory,
  });
  return writeBundle(abs, bundle);
}

function uniquePath(abs) {
  if (!fs.existsSync(abs)) return abs;
  const ext = path.extname(abs);
  const stem = abs.slice(0, abs.length - ext.length);
  for (let n = 2; ; n++) {
    const p = `${stem}-${n}${ext}`;
    if (!fs.existsSync(p)) return p;
  }
}

function defaultOutDir() {
  const home = os.homedir();
  return [path.join(home, 'Desktop'), path.join(home, 'OneDrive', 'Desktop')].find((p) => fs.existsSync(p)) || home;
}

module.exports = {
  stamp, slug, setup, ensureConfig, printDevice, printRepos, printWorkspaces,
  resolveAmbiguous, collectLocal, writeLocalBundle, defaultOutDir, uniquePath,
};
