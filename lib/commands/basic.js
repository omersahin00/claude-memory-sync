'use strict';
const os = require('os');
const path = require('path');
const ui = require('../ui');
const { AbortError } = require('../merge');
const C = require('./common');

const { c } = ui;

const WS_WARNINGS = {
  absolute: 'absolute path, will not open on another device or OS',
  backslash: 'backslash (\\) does not work on macOS/Linux',
  'outside-root': 'points outside the workspace folder; it must exist at the same relative place on the other device',
  missing: 'folder does not exist on this device',
};

async function cmdStatus(engine) {
  const ov = engine.overview();
  C.printDevice(ov.device);

  ui.section('Projects');
  const { projects, withoutMemory } = engine.projects();
  if (!projects.length) console.log(c.yellow('  No Claude project with memories found.'));
  else {
    const rows = [[c.bold('PROJECT'), c.bold('MEMORY'), c.bold('IN BUNDLES'), c.bold('NOT SENT YET'), c.bold('FOLDER')]];
    for (const p of projects) {
      const pending = p.status.new + p.status.changed;
      rows.push([
        p.name + (p.isScratch ? c.dim(' (Claude app scratch)') : ''),
        `${p.fileCount} files`,
        p.included ? 'yes' : c.gray('no'),
        pending ? c.yellow(String(pending)) : c.gray('-'),
        c.dim(p.cwd || p.dir),
      ]);
    }
    ui.table(rows, { indent: 2 });
  }
  if (withoutMemory) console.log(c.dim(`  ${withoutMemory} more Claude projects have no memories.`));

  ui.section('Workspace files');
  const roots = engine.workspaces();
  if (!roots.length) console.log(c.gray('  No workspace folder is set. Run "node cli.js config".'));
  for (const r of roots) {
    console.log(`  ${c.bold(r.path)} ${r.exists ? '' : c.red('(missing)')}`);
    if (!r.files.length) console.log(c.gray('     no .code-workspace files'));
    for (const f of r.files) {
      console.log(`     ${f.rel}  ${c.dim(`(${f.folders.length} folders)`)}`);
      if (f.parseError) console.log(c.yellow(`        ! could not parse: ${f.parseError}`));
      for (const fo of f.folders) for (const w of fo.warnings) console.log(c.yellow(`        ! ${fo.path}: ${WS_WARNINGS[w] || w}`));
    }
  }

  ui.section('Backups');
  const d = ov.daily;
  ui.table([
    ['Last backup', ov.lastBackup ? `${new Date(ov.lastBackup.createdAt).toLocaleString()} (${ov.lastBackup.kind})` : c.gray('none')],
    ['Daily backup', d.enabled ? `on, every day at ${d.time}` : c.gray('off')],
    ['Backups folder', ov.device.backupDir],
    ['Not sent yet', `${ov.pending.new} new, ${ov.pending.changed} changed files`],
  ], { indent: 2 });
  for (const b of ov.incoming) console.log(c.yellow(`  ! Bundle from ${b.device.name} not applied yet: ${b.path}`));
  return 0;
}

// Bundle for another device (1.x name kept: "backup").
async function cmdBackup(engine, { outDir }) {
  C.printDevice(engine.overview().device);
  const prev = engine.exportPreview();
  ui.section('Bundle contents');
  if (!prev.locations.length) {
    console.log(c.yellow('  Nothing to put in the bundle.'));
    return 1;
  }
  const rows = [[c.bold('WHAT'), c.bold('FILES'), c.bold('SIZE'), c.bold('SOURCE')]];
  for (const l of prev.locations) rows.push([C.locationLabel(l), String(l.files), ui.formatBytes(l.bytes), c.dim(l.path || '')]);
  ui.table(rows, { indent: 2 });
  for (const w of prev.warnings) console.log(c.yellow(`  ! ${C.warningText(w)}`));
  const dir = outDir ? path.resolve(outDir) : prev.outDir;
  console.log('');
  console.log(`  ${prev.files} files → ${c.bold(dir)}`);
  if (!(await ui.confirm('Create the bundle?'))) throw new AbortError('Cancelled.');
  const res = engine.exportBundle({ outDir: dir });
  console.log(c.green(`Bundle created and verified (${ui.formatBytes(res.size)}): ${res.path}`));
  console.log(`  To merge it on another device : ${c.bold(`node cli.js sync "<path to ${path.basename(res.path)}>"`)}`);
  console.log(`  To reset a device to it       : ${c.bold(`node cli.js restore "<path to ${path.basename(res.path)}>"`)}`);
  return 0;
}

async function askOrAbort(q) {
  const a = await ui.ask(q);
  if (a === null) throw new AbortError('Cancelled.');
  return a.replace(/^["']|["']$/g, '');
}

async function cmdConfig(engine) {
  const cur = engine.settings();
  ui.section('Settings');
  ui.table([['Settings file', path.join(cur.device.stateHome, 'config.json')], ['Claude folder', cur.device.claudeDir]], { indent: 2 });
  console.log('');
  const deviceName = (await askOrAbort(`  Device name [${cur.deviceName}]: `)) || cur.deviceName;
  const rootsText = cur.workspaceRoots.join(', ');
  const a = await askOrAbort(`  Folders with workspace files, comma separated${rootsText ? ` [${rootsText}]` : ''}: `);
  const roots = a ? a.split(',').map((s) => s.trim()).filter(Boolean).map((s) => path.resolve(s.replace(/^~(?=$|[\\/])/, os.homedir()))) : cur.workspaceRoots;
  console.log('');
  ui.table([['Device name', deviceName], ['Workspace folders', roots.join(', ') || '-']], { indent: 2 });
  if (!(await ui.confirm('  Save these settings?'))) throw new AbortError('Settings were not saved.');
  engine.updateSettings({ deviceName, workspaceRoots: roots });
  console.log(c.green('  Settings saved.'));
  return 0;
}

module.exports = { cmdStatus, cmdBackup, cmdConfig };
