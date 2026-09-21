'use strict';
const path = require('path');
const ui = require('../ui');
const P = require('../paths');
const S = require('../state');
const { scanDevice, findLocalRepo, inspectWorkspace } = require('../scan');
const { readBundle } = require('../bundle');
const { classify, resolve, needsDecision, copyRelFor, CONFLICTS } = require('../plan');
const { lineDiff, AbortError } = require('../merge');
const { applyOps, verifyOps } = require('../apply');
const C = require('./common');

const { c } = ui;

const VIEW = {
  add: ['+', 'green', 'will be added'],
  update: ['~', 'cyan', 'will be updated (the other side is newer)'],
  delete: ['-', 'red', 'will be deleted (deleted on the other device)'],
  merge: ['*', 'magenta', 'both sides will be merged line by line'],
  'local-only': ['.', 'gray', 'only on this device, kept'],
  'local-newer': ['.', 'gray', 'newer on this device, kept'],
  'local-deleted': ['.', 'gray', 'deleted on this device, stays deleted'],
  conflict: ['!', 'yellow', 'changed on both devices, decision needed'],
  'conflict-remote-deleted': ['!', 'yellow', 'changed here, deleted on the other device, decision needed'],
  'conflict-local-deleted': ['!', 'yellow', 'deleted here, changed on the other device, decision needed'],
  same: ['=', 'dim', 'same'],
};
const MIRROR_VIEW = {
  add: ['+', 'green', 'will be added'],
  update: ['~', 'cyan', 'will be replaced with the bundle version'],
  delete: ['-', 'red', 'not in the bundle, will be deleted'],
  same: ['=', 'dim', 'same'],
};

function showDiff(aBuf, bBuf, aLabel, bLabel) {
  if (aBuf.includes(0) || bBuf.includes(0)) {
    console.log(c.dim('   (binary file, no diff shown)'));
    return;
  }
  console.log(`   ${c.red('-')} ${c.dim(`only on this device (${aLabel})`)}   ${c.green('+')} ${c.dim(`only on the other device (${bLabel})`)}`);
  for (const d of lineDiff(aBuf.toString('utf8'), bBuf.toString('utf8'))) {
    if (d.t === '-') console.log(c.red(`   - ${d.s}`));
    else if (d.t === '+') console.log(c.green(`   + ${d.s}`));
    else if (d.t === '…') console.log(c.dim(`   … ${d.s}`));
    else console.log(c.dim(`     ${d.s}`));
  }
}

function preview(buf, label) {
  console.log(c.dim(`   ${label}:`));
  if (buf.includes(0)) return console.log(c.dim('   (binary file)'));
  const lines = buf.toString('utf8').split(/\r?\n/);
  for (const l of lines.slice(0, 15)) console.log(c.dim(`     ${l}`));
  if (lines.length > 15) console.log(c.dim(`     … (${lines.length - 15} more lines)`));
}

function makeAsk(localLabel, remoteLabel) {
  return {
    async conflict(scope, it) {
      console.log('');
      console.log(`${c.yellow(c.bold(`! ${scope.label} / ${it.rel}`))}  ${VIEW[it.action][2].replace(', decision needed', '')}`);
      if (it.L && it.R) showDiff(it.L.buf, it.R.buf, localLabel, remoteLabel);
      else if (it.L) preview(it.L.buf, `version on this device (${localLabel})`);
      else preview(it.R.buf, `version on the other device (${remoteLabel})`);
      let options;
      if (it.action === 'conflict') {
        options = [
          { key: 'l', label: `Keep this device's version (${localLabel})` },
          { key: 'r', label: `Take the other device's version (${remoteLabel}); this one stays in the automatic backup` },
          { key: 'b', label: `Keep both; the other version is added as "${copyRelFor(it.rel, remoteLabel, new Set())}" and noted in MEMORY.md` },
        ];
      } else if (it.action === 'conflict-remote-deleted') {
        options = [
          { key: 'l', label: "Keep this device's version" },
          { key: 'd', label: 'Delete it (deleted on the other device); it stays in the automatic backup' },
        ];
      } else {
        options = [
          { key: 'r', label: `Bring back the other device's version (${remoteLabel})` },
          { key: 'd', label: 'Keep it deleted' },
        ];
      }
      return ui.choose('  What should happen?', options);
    },
    async indexLine(scope, target, localLine, remoteLine) {
      console.log('');
      console.log(c.yellow(c.bold(`! ${scope.label} / MEMORY.md: the line for "${target}" differs between devices`)));
      const k = await ui.choose('  Which line should stay?', [
        { key: 'l', label: `${c.dim(`this device (${localLabel}):`)} ${localLine}` },
        { key: 'r', label: `${c.dim(`other device (${remoteLabel}):`)} ${remoteLine}` },
      ]);
      return k === null ? null : k === 'l' ? 'local' : 'remote';
    },
  };
}

async function cmdSync(file, mode) {
  const isMirror = mode === 'restore';
  if (!file) throw new Error(`No bundle file given. Usage: node cli.js ${mode} <file>`);
  const config = await C.ensureConfig();
  const bundleAbs = path.resolve(file);
  const bundle = readBundle(bundleAbs);

  ui.section('Bundle');
  const memRepos = Object.entries(bundle.repos).filter(([, r]) => r.hasMemory);
  const memFiles = [...bundle.files.keys()].filter((k) => k.startsWith('memory/')).length;
  const wsFiles = [...bundle.files.keys()].filter((k) => k.startsWith('workspace/')).length;
  ui.table([
    ['File', bundleAbs],
    ['Source device', `${bundle.device.name} (${P.platformName(bundle.device.platform)})`],
    ['Created', new Date(bundle.createdAt).toLocaleString()],
    ['Contents', `${memRepos.length} repos, ${memFiles} memory files, ${wsFiles} workspace files`],
  ], { indent: 2 });
  if (bundle.device.id === config.deviceId) console.log(c.dim('  (This bundle was created on this device.)'));
  if (String(bundle.prefix).toLowerCase() !== config.prefix.toLowerCase()) {
    console.log(c.yellow(`  ! The bundle prefix is "${bundle.prefix}", this device uses "${config.prefix}".`));
    if (!(await ui.confirm('  Continue anyway?'))) throw new AbortError('Cancelled.');
  }

  const scan = scanDevice(config);
  C.printDevice(config, scan);

  // ---- Readiness ----------------------------------------------------------
  ui.section('Readiness');
  const ready = [];
  const notReady = [];
  const optional = [];
  for (const [name, info] of Object.entries(bundle.repos).sort(([a], [b]) => a.localeCompare(b))) {
    const local = findLocalRepo(scan, name);
    const needed = info.hasMemory && info.memoryFiles > 0;
    if (!local || !local.exists) {
      (needed ? notReady : optional).push({ name, info, reason: 'clone', target: path.join(config.reposRoot, name) });
    } else if (!info.hasMemory) {
      continue;
    } else if (!local.project && !local.ambiguous) {
      if (needed) notReady.push({ name, info, reason: 'project', target: local.path });
    } else {
      ready.push({ name, info, local });
    }
  }
  const wsReady = bundle.workspacesIncluded && scan.reposRootExists;

  const rows = [[c.bold('REPO'), c.bold('STATUS'), c.bold('TARGET')]];
  for (const r of ready) rows.push([r.name, c.green('ready'), r.local.ambiguous ? c.yellow('(choice needed)') : r.local.memoryDir]);
  for (const r of notReady) rows.push([r.name, c.red(r.reason === 'clone' ? 'not cloned' : 'no Claude project'), r.target]);
  if (bundle.workspacesIncluded) rows.push(['(workspaces)', wsReady ? c.green('ready') : c.red('repos folder missing'), scan.reposRoot]);
  ui.table(rows, { indent: 2 });
  for (const r of ready) {
    if (r.local.project && r.local.project.method === 'guess') {
      console.log(c.yellow(`  ! ${r.name}: Claude project matched only by name suffix, check the target → ${r.local.project.dir}`));
    }
  }

  if (notReady.length) {
    console.log('');
    console.log(c.bold('  To do (these repos will not be touched now):'));
    for (const r of notReady) {
      console.log(`  ${c.bold(r.name)}`);
      if (r.reason === 'clone') {
        console.log(r.info.remote ? `     1) git clone ${r.info.remote} "${r.target}"` : `     1) Clone the repo manually to: ${r.target}`);
        console.log('     2) Open the folder in Claude Code and send any message');
      } else {
        console.log(`     Open "${r.target}" in Claude Code and send any message (this creates the project entry)`);
      }
    }
    console.log(c.dim('  Then run the same command again.'));
  }
  if (optional.length) {
    console.log('');
    console.log(c.dim('  Repos missing on this device that have no memories (cloning is optional):'));
    for (const o of optional) console.log(c.dim(`     ${o.info.remote ? `git clone ${o.info.remote} "${o.target}"` : o.name}`));
  }

  if (!ready.length && !wsReady) {
    console.log('');
    console.log(c.yellow('No repo is ready. Nothing was changed.'));
    return notReady.length ? 1 : 0;
  }
  if (notReady.length && !(await ui.confirm(`\nContinue with the ${ready.length} ready repo(s)${wsReady ? ' and the workspace files' : ''}?`))) {
    throw new AbortError('Cancelled.');
  }
  await C.resolveAmbiguous(ready.map((r) => r.local));

  // ---- Plan ---------------------------------------------------------------
  const scopes = [];
  const remoteOf = (prefix) => {
    const m = new Map();
    for (const [key, f] of bundle.files) if (key.startsWith(prefix)) m.set(key.slice(prefix.length), f);
    return m;
  };
  for (const r of ready) {
    const keyPrefix = `memory/${r.name}/`;
    scopes.push({ label: r.name, isMemory: true, root: r.local.memoryDir, keyPrefix, local: r.local.files, remote: remoteOf(keyPrefix) });
  }
  if (wsReady) {
    scopes.push({ label: 'workspaces', isMemory: false, root: scan.reposRoot, keyPrefix: 'workspace/', local: scan.workspaces, remote: remoteOf('workspace/') });
  }

  const localHist = S.loadHistory();
  const errors = classify({ mode, scopes, localHist, remoteHist: bundle.history, platform: scan.platform });
  if (errors.length) {
    ui.section('Blocking problems');
    for (const e of errors) console.log(c.red(`  x ${e}`));
    throw new Error('These problems must be fixed first. Nothing was changed.');
  }

  ui.section(isMirror ? 'Plan: this device will be reset to the bundle' : 'Plan');
  for (const scope of scopes) {
    const shown = scope.items.map((it) => ({ it, act: it.isIndex && CONFLICTS.has(it.action) ? 'merge' : it.action }));
    const visible = shown.filter((x) => x.act !== 'same');
    console.log('');
    console.log(`  ${c.bold(scope.label)}  ${c.dim('→')}  ${scope.root}`);
    for (const { it, act } of visible) {
      const [sym, color, text] = (isMirror ? MIRROR_VIEW : VIEW)[act];
      console.log(`     ${c[color](sym)} ${it.rel}  ${c.dim(text)}`);
      if (!scope.isMemory && it.R && !['same', 'local-only', 'local-newer', 'local-deleted', 'delete'].includes(act)) {
        const info = inspectWorkspace(P.toAbs(scope.root, it.rel), scan.reposRoot, config.prefix.toLowerCase(), it.R.buf);
        for (const w of (info && info.warnings) || []) console.log(c.yellow(`        ! ${w}`));
      }
    }
    const same = shown.length - visible.length;
    if (!visible.length) console.log(c.dim(`     no changes (${same} files identical)`));
    else if (same) console.log(c.dim(`     = ${same} files identical`));
  }

  const decisions = scopes.reduce((n, s) => n + s.items.filter(needsDecision).length, 0);
  if (decisions) {
    ui.section(`Decisions (${decisions})`);
    console.log(c.dim("  The version you don't pick is not lost: this device's copy stays in the automatic backup, the other one stays in the bundle."));
  }
  const history = await resolve({
    mode, scopes, localHist, remoteHist: bundle.history, remoteLabel: bundle.device.name,
    ask: makeAsk(config.deviceName, bundle.device.name),
  });

  const allOps = scopes.flatMap((s) => s.ops);
  if (!allOps.length) {
    console.log('');
    console.log(c.green('Nothing to write or delete. Nothing was changed.'));
    return 0;
  }

  // ---- Confirm ------------------------------------------------------------
  ui.section('Confirm');
  for (const scope of scopes) {
    if (!scope.ops.length) continue;
    console.log(`  ${c.bold(scope.label)}  ${c.dim('→')}  ${scope.root}`);
    for (const op of scope.ops) {
      const idx = scope.items.find((i) => i.rel === op.rel && i.isIndex);
      const s = idx && idx.display === 'merge' ? idx.mergeStats : null;
      const extra = s ? c.dim(` (${s.added} lines added, ${s.changed} changed, ${s.removed} removed)`) : '';
      console.log(op.type === 'write' ? `     ${c.green('write')}  ${op.rel}${extra}` : `     ${c.red('delete')} ${op.rel}`);
    }
  }
  const writes = allOps.filter((o) => o.type === 'write').length;
  const deletes = allOps.length - writes;
  const backupAbs = C.uniquePath(path.join(S.backupDir(), `auto-before-${mode}-${C.stamp()}.memsync`));
  console.log('');
  console.log(`  Total: ${c.green(`${writes} writes`)}, ${c.red(`${deletes} deletes`)}`);
  console.log(`  An automatic backup of this device is taken first: ${c.dim(backupAbs)}`);
  console.log(c.yellow('  Close any Claude Code sessions open in these repos first.'));
  if (!(await ui.confirm('Apply?'))) throw new AbortError('Cancelled.');

  // ---- Apply --------------------------------------------------------------
  C.writeLocalBundle(config, scan, C.collectLocal(scan, localHist, { protectEmpty: false }), backupAbs);
  console.log(c.green('  Automatic backup taken and verified.'));

  const restoreHint = () => console.log(`  To go back: ${c.bold(`node cli.js restore "${backupAbs}"`)}`);
  try {
    applyOps(allOps);
  } catch (e) {
    console.log(c.red(`  ${e.message}`));
    console.log(c.red(`  ${e.done}/${allOps.length} operations done, the rest were not. Sync history was not updated.`));
    restoreHint();
    return 2;
  }
  const problems = verifyOps(allOps);
  if (problems.length) {
    for (const p of problems) console.log(c.red(`  x ${p}`));
    console.log(c.red('  Verification failed. Sync history was not updated.'));
    restoreHint();
    return 2;
  }

  const newHist = new Map([...localHist].map(([k, v]) => [k, new Set(v)]));
  for (const [k, v] of history) {
    if (v === null) newHist.delete(k);
    else newHist.set(k, v);
  }
  S.saveHistory(newHist);

  ui.section('Done');
  console.log(c.green(`  ${writes} files written, ${deletes} files deleted; all verified.`));
  const copies = scopes.reduce((n, s) => n + (s.copies ? s.copies.length : 0), 0);
  if (copies) console.log(c.yellow(`  ${copies} conflict copies created; you can ask Claude to merge the copies marked "version" in MEMORY.md.`));
  console.log(c.dim(`  To undo: node cli.js restore "${backupAbs}"`));
  if (!isMirror) console.log(`  To carry this device's changes to the other device: ${c.bold('node cli.js backup')}`);
  return 0;
}

module.exports = { cmdSync };
