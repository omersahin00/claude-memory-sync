'use strict';
const path = require('path');
const ui = require('../ui');
const { AbortError } = require('../merge');
const { copyRelFor } = require('../plan');
const C = require('./common');

const { c } = ui;

function showDiff(lines, aLabel, bLabel) {
  console.log(`   ${c.red('-')} ${c.dim(`only on this device (${aLabel})`)}   ${c.green('+')} ${c.dim(`only on the other device (${bLabel})`)}`);
  for (const d of lines.slice(0, 40)) {
    if (d.t === '-') console.log(c.red(`   - ${d.s}`));
    else if (d.t === '+') console.log(c.green(`   + ${d.s}`));
    else if (d.t === '…') console.log(c.dim(`   … ${d.s}`));
    else console.log(c.dim(`     ${d.s}`));
  }
  if (lines.length > 40) console.log(c.dim(`   … (${lines.length - 40} more lines)`));
}

function preview(text, label) {
  console.log(c.dim(`   ${label}:`));
  if (text == null) return console.log(c.dim('   (binary file)'));
  const lines = text.split(/\r?\n/);
  for (const l of lines.slice(0, 15)) console.log(c.dim(`     ${l}`));
  if (lines.length > 15) console.log(c.dim(`     … (${lines.length - 15} more lines)`));
}

async function askConflict(engine, plan, it, localLabel, remoteLabel) {
  console.log('');
  console.log(`${c.yellow(c.bold(`! ${it.scopeLabel} / ${it.rel}`))}  ${C.ACTIONS[it.action] || 'changed on both devices'}`);
  const d = engine.itemDiff(plan.id, it.key);
  if (d.binary) console.log(c.dim('   (binary file, no diff shown)'));
  else if (it.local && it.remote) showDiff(d.lines, localLabel, remoteLabel);
  else if (it.local) preview(d.local, `version on this device (${localLabel})`);
  else preview(d.remote, `version on the other device (${remoteLabel})`);
  const skip = { key: 's', label: 'Skip for now; it is asked again next time' };
  const options = {
    conflict: [
      { key: 'l', label: `Keep this device's version (${localLabel})` },
      { key: 'r', label: `Take the other device's version (${remoteLabel}); this one stays in the automatic backup` },
      { key: 'b', label: `Keep both; the other version is added as "${copyRelFor(it.rel, remoteLabel, new Set())}" and noted in MEMORY.md` },
      skip,
    ],
    'conflict-remote-deleted': [
      { key: 'l', label: "Keep this device's version" },
      { key: 'd', label: 'Delete it (deleted on the other device); it stays in the automatic backup' },
      skip,
    ],
    'conflict-local-deleted': [
      { key: 'r', label: `Bring back the other device's version (${remoteLabel})` },
      { key: 'd', label: 'Keep it deleted' },
      skip,
    ],
  }[it.action];
  const k = await ui.choose('  What should happen?', options);
  return k === null ? null : k === 's' ? 'skip' : k;
}

async function cmdSync(engine, file, mode) {
  const isMirror = mode === 'restore';
  if (!file) throw new Error(`No bundle file given. Usage: node cli.js ${mode} <file>`);
  const cfg = engine.settings();
  const bundle = engine.openBundle(path.resolve(file));

  ui.section('Bundle');
  const st = bundle.stats;
  ui.table([
    ['File', bundle.path],
    ['Source device', `${bundle.device.name} (${bundle.device.platformName})`],
    ['Created', new Date(bundle.createdAt).toLocaleString()],
    ['Contents', `${st.projects} projects, ${st.memoryFiles} memory files, ${st.workspaceFiles} workspace files, ${st.claudeFiles} Claude files`],
  ], { indent: 2 });
  if (bundle.isMine) console.log(c.dim('  (This bundle was created on this device.)'));
  C.printDevice(cfg.device);

  // ---- Matching ------------------------------------------------------------
  let plan = engine.prepare({ bundlePath: bundle.path, mode });
  const mappings = {};
  for (const m of plan.matches) {
    if (m.include || !m.local || m.status === 'skipped') continue;
    console.log('');
    console.log(c.yellow(`  ${m.remote.name || m.remote.key} in the bundle may be ${m.local.path || m.local.name} here: ${C.MATCH_WARNINGS[m.warnings[0]] || 'it could not be confirmed'}.`));
    if (await ui.confirm('  Use it?')) mappings[m.id] = { include: true };
  }
  if (Object.keys(mappings).length) plan = engine.prepare({ bundlePath: bundle.path, mode, mappings });

  ui.section('Readiness');
  const rows = [[c.bold('WHAT'), c.bold('STATUS'), c.bold('TARGET ON THIS DEVICE')]];
  for (const m of plan.matches) {
    let status;
    if (m.include) status = c.green(m.status === 'create' ? 'ready (will be set up)' : 'ready');
    else if (m.status === 'skipped') status = c.gray('skipped');
    else if (m.local) status = c.yellow('not selected');
    else status = c.red('not found on this device');
    rows.push([C.locationLabel({ ...m.remote, type: m.type }), status, m.local ? m.local.root : '']);
  }
  ui.table(rows, { indent: 2 });
  for (const m of plan.matches.filter((x) => x.include && x.how && x.how !== 'self' && x.how !== 'claude')) {
    console.log(c.dim(`  ${m.remote.name || m.remote.key}: ${C.HOW[m.how] || m.how}`));
  }

  const ready = plan.matches.filter((m) => m.include);
  const missing = plan.matches.filter((m) => !m.include);
  const missingProjects = missing.filter((m) => m.type === 'project' && !m.local);
  if (missingProjects.length) {
    console.log('');
    console.log(c.bold('  To do (these will not be touched now):'));
    const root = cfg.workspaceRoots[0];
    for (const m of missingProjects) {
      const target = root ? path.join(root, m.remote.name || m.remote.key) : m.remote.name || m.remote.key;
      console.log(`  ${c.bold(m.remote.name || m.remote.key)}`);
      console.log(m.remote.gitRemote ? `     1) git clone ${m.remote.gitRemote} "${target}"` : `     1) Put the project folder at: ${target}`);
      console.log('     2) Run the same command again');
    }
  }
  if (!ready.length) {
    console.log('');
    console.log(c.yellow('Nothing in the bundle matches this device. Nothing was changed.'));
    return 1;
  }
  if (missing.length && !(await ui.confirm(`\nContinue with the ${ready.length} matched part(s)?`))) throw new AbortError('Cancelled.');

  if (plan.errors.length) {
    ui.section('Blocking problems');
    for (const e of plan.errors) console.log(c.red(`  x ${C.blockingText(e)}`));
    throw new Error('These problems must be fixed first. Nothing was changed.');
  }

  // ---- Plan ----------------------------------------------------------------
  ui.section(isMirror ? 'Plan: this device will be reset to the bundle' : 'Plan');
  for (const sc of plan.scopes) {
    const items = plan.items.filter((i) => i.scope === sc.id);
    const visible = items.filter((i) => i.group !== 'same');
    console.log('');
    console.log(`  ${c.bold(sc.label)}  ${c.dim('→')}  ${sc.root}${sc.create ? c.dim(' (will be set up)') : ''}`);
    for (const it of visible) {
      const [sym, color, text] = (isMirror ? C.MIRROR_GROUPS : C.GROUPS)[it.group] || ['?', 'gray', it.group];
      const left = it.defaultChoice === 'skip' ? c.yellow('  not taken: the folders it opens are not all on this device') : '';
      console.log(`     ${c[color](sym)} ${it.rel}  ${c.dim(C.ACTIONS[it.action] || text)}${left}`);
    }
    const same = items.length - visible.length;
    if (!visible.length) console.log(c.dim(`     no changes (${same} files identical)`));
    else if (same) console.log(c.dim(`     = ${same} files identical`));
  }

  // ---- Decisions -----------------------------------------------------------
  const decisions = { items: {}, lines: {} };
  const conflicts = plan.items.filter((i) => i.choices.length && i.defaultChoice === null);
  if (conflicts.length) {
    ui.section(`Decisions (${conflicts.length})`);
    console.log(c.dim("  The version you don't pick is not lost: this device's copy stays in the automatic backup, the other one stays in the bundle."));
    for (const it of conflicts) {
      const choice = await askConflict(engine, plan, it, cfg.deviceName, bundle.device.name);
      if (choice === null) throw new AbortError('Cancelled.');
      decisions.items[it.key] = choice;
    }
  }
  for (let res = engine.resolvePlan(plan.id, decisions); ; res = engine.resolvePlan(plan.id, decisions)) {
    const lines = res.pending.filter((p) => p.type === 'line' && !(p.id in decisions.lines));
    if (!lines.length) break;
    for (const p of lines) {
      console.log('');
      console.log(c.yellow(c.bold(`! MEMORY.md: the line for "${p.target}" differs between devices`)));
      const k = await ui.choose('  Which line should stay?', [
        { key: 'l', label: `${c.dim(`this device (${cfg.deviceName}):`)} ${p.local}` },
        { key: 'r', label: `${c.dim(`other device (${bundle.device.name}):`)} ${p.remote}` },
      ]);
      if (k === null) throw new AbortError('Cancelled.');
      decisions.lines[p.id] = k === 'l' ? 'local' : 'remote';
    }
  }

  const res = engine.resolvePlan(plan.id, decisions);
  if (!res.ops.length) {
    engine.apply(plan.id, decisions);
    console.log('');
    console.log(c.green('Nothing to write or delete. Nothing was changed.'));
    return 0;
  }

  // ---- Confirm -------------------------------------------------------------
  ui.section('Confirm');
  const mergeStats = new Map(res.index.filter((x) => x.display === 'merge' && x.stats).map((x) => [x.key, x.stats]));
  for (const sc of plan.scopes) {
    const ops = res.ops.filter((o) => o.scope === sc.id);
    if (!ops.length) continue;
    console.log(`  ${c.bold(sc.label)}  ${c.dim('→')}  ${sc.root}`);
    for (const op of ops) {
      const s = mergeStats.get(op.key);
      const extra = s ? c.dim(` (${s.added} lines added, ${s.changed} changed, ${s.removed} removed)`) : '';
      console.log(op.type === 'write' ? `     ${c.green('write')}  ${op.rel}${extra}` : `     ${c.red('delete')} ${op.rel}`);
    }
  }
  console.log('');
  console.log(`  Total: ${c.green(`${res.writes} writes`)}, ${c.red(`${res.deletes} deletes`)}`);
  console.log(`  A full backup of this device is taken first, into: ${c.dim(plan.backupDir)}`);
  console.log(c.yellow('  Close any Claude Code sessions open in these projects first.'));
  if (!(await ui.confirm('Apply?'))) throw new AbortError('Cancelled.');

  // ---- Apply ---------------------------------------------------------------
  let out;
  try {
    out = engine.apply(plan.id, decisions);
  } catch (e) {
    if (e.code === 'APPLY_FAILED' || e.code === 'VERIFY_FAILED') {
      console.log(c.red(`  ${e.message}`));
      for (const p of e.problems || []) console.log(c.red(`  x ${p}`));
      console.log(c.red(e.rolledBack ? '  Everything written so far was put back. Sync history was not updated.' : '  Sync history was not updated.'));
      console.log(`  To go back: ${c.bold(`node cli.js restore "${e.backupPath}"`)}`);
      return 2;
    }
    throw e;
  }
  console.log(c.green('  Automatic backup taken and verified.'));
  ui.section('Done');
  console.log(c.green(`  ${out.writes} files written, ${out.deletes} files deleted; all verified.`));
  if (out.copies) console.log(c.yellow(`  ${out.copies} conflict copies created; you can ask Claude to merge the copies marked "version" in MEMORY.md.`));
  console.log(c.dim(`  To undo: node cli.js restore "${out.backupPath}"`));
  if (!isMirror) console.log(`  To carry this device's changes to the other device: ${c.bold('node cli.js backup')}`);
  return 0;
}

module.exports = { cmdSync };
