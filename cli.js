#!/usr/bin/env node
'use strict';
const ui = require('./lib/ui');
const { AbortError } = require('./lib/merge');

const HELP = `
claude-memory-sync: moves Claude Code memories and VSCode workspace files of prefixed repos between devices.

Usage:  node cli.js <command>

  status              Show what is detected on this device (writes nothing)
  backup [-o <dir>]   Pack all memories into a single .memsync file (for transfer and backup)
  sync <file>         Two-way merge a .memsync file into this device
  restore <file>      Make this device exactly match a .memsync file (after a format, or to undo)
  config              Change the repos folder, device name and prefix

Every write shows a plan and asks for confirmation first.
sync and restore take an automatic backup of this device before writing anything.
`;

function parseArgs(argv) {
  const args = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-o' || a === '--out') flags.outDir = argv[++i];
    else if (a === '-h' || a === '--help') flags.help = true;
    else args.push(a);
  }
  return { args, flags };
}

async function main() {
  const major = Number(process.versions.node.split('.')[0]);
  if (major < 18) {
    console.error(`Node.js 18 or newer is required (this device has ${process.versions.node}).`);
    return 2;
  }
  const { args, flags } = parseArgs(process.argv.slice(2));
  const [cmd, ...rest] = args;
  if (flags.help || !cmd || cmd === 'help') {
    console.log(HELP);
    return 0;
  }
  const basic = require('./lib/commands/basic');
  const { cmdSync } = require('./lib/commands/sync');
  switch (cmd) {
    case 'status': return basic.cmdStatus();
    case 'backup': return basic.cmdBackup({ outDir: flags.outDir });
    case 'sync': return cmdSync(rest[0], 'sync');
    case 'restore': return cmdSync(rest[0], 'restore');
    case 'config': return basic.cmdConfig();
    default:
      console.error(`Unknown command: ${cmd}`);
      console.log(HELP);
      return 2;
  }
}

main().then(
  (code) => {
    ui.close();
    process.exitCode = code || 0;
  },
  (e) => {
    ui.close();
    if (e instanceof AbortError) {
      console.log(ui.c.yellow(`${e.message} Nothing was changed.`));
      process.exitCode = 1;
    } else {
      console.error(ui.c.red(`Error: ${e.message}`));
      if (process.env.CLAUDE_MEMORY_SYNC_DEBUG) console.error(e.stack);
      process.exitCode = 2;
    }
  }
);
