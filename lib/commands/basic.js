'use strict';
const path = require('path');
const ui = require('../ui');
const P = require('../paths');
const S = require('../state');
const { scanDevice } = require('../scan');
const { AbortError } = require('../merge');
const C = require('./common');

const { c } = ui;

async function cmdStatus() {
  const config = await C.ensureConfig();
  const scan = scanDevice(config);
  C.printDevice(config, scan);
  C.printRepos(scan);
  C.printWorkspaces(scan);
  console.log('');
  console.log(c.dim(`  Sync history: ${S.loadHistory().size} entries   Automatic backups: ${S.backupDir()}`));
  return 0;
}

async function cmdBackup({ outDir }) {
  const config = await C.ensureConfig();
  const scan = scanDevice(config);
  C.printDevice(config, scan);
  await C.resolveAmbiguous(scan.repos);
  const col = C.collectLocal(scan, S.loadHistory(), { protectEmpty: true });

  ui.section('Bundle contents');
  const rows = [[c.bold('REPO'), c.bold('MEMORY'), c.bold('SIZE'), c.bold('SOURCE')]];
  let total = 0;
  for (const r of scan.repos) {
    if (!col.repos[r.name].hasMemory) continue;
    const size = [...r.files.values()].reduce((s, f) => s + f.buf.length, 0);
    total += r.files.size;
    rows.push([r.name, `${r.files.size} files`, ui.formatBytes(size), c.dim(r.memoryDir)]);
  }
  if (rows.length > 1) ui.table(rows, { indent: 2 });
  else console.log(c.yellow('  No repo has memories.'));

  const noMemory = scan.repos.filter((r) => !col.repos[r.name].hasMemory).map((r) => r.name);
  if (noMemory.length) console.log(c.dim(`  Without memories (only the clone URL is carried): ${noMemory.join(', ')}`));

  if (col.workspacesIncluded) {
    console.log('');
    console.log(`  Workspaces: ${scan.workspaces.size} files`);
    for (const [rel, w] of scan.workspaces) {
      console.log(`     ${rel}`);
      for (const warn of w.warnings) console.log(c.yellow(`        ! ${warn}`));
    }
  }
  for (const key of col.files.keys()) {
    const e = P.windowsNameError(P.parseKey(key).rel);
    if (e) col.warnings.push(`${key}: ${e}`);
  }
  for (const w of col.warnings) console.log(c.yellow(`  ! ${w}`));

  const abs = C.uniquePath(path.join(outDir ? path.resolve(outDir) : C.defaultOutDir(), `claude-memory-${C.slug(config.deviceName)}-${C.stamp()}.memsync`));
  console.log('');
  console.log(`  ${total} memory files in total → ${c.bold(abs)}`);
  if (!(await ui.confirm('Create the bundle?'))) throw new AbortError('Cancelled.');

  const size = C.writeLocalBundle(config, scan, col, abs);
  S.saveHistory(col.localHistory);
  console.log(c.green(`Bundle created and verified (${ui.formatBytes(size)}): ${abs}`));
  console.log(`  To merge it on another device : ${c.bold(`node cli.js sync "<path to ${path.basename(abs)}>"`)}`);
  console.log(`  To reset a device to it       : ${c.bold(`node cli.js restore "<path to ${path.basename(abs)}>"`)}`);
  return 0;
}

async function cmdConfig() {
  await C.setup(S.loadConfig());
  return 0;
}

module.exports = { cmdStatus, cmdBackup, cmdConfig };
