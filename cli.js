#!/usr/bin/env node
'use strict';
const ui = require('./lib/ui');
const { AbortError } = require('./lib/merge');

const HELP = `
claude-memory-sync: moves Claude Code memories, VSCode workspace files and Claude settings between devices.
The desktop app does the same with a window; this is the command line.

Usage:  node cli.js <command>

  status                  Show what is found on this device (writes nothing)
  backup [-o <dir>]       Pack this device into a single .memsync file for another device
  sync <file>             Two-way merge a .memsync file into this device
  restore <file>          Make this device exactly match a .memsync file (after a format)
  undo                    Undo the last sync or restore, from the backup taken right before it
  setup-backups <folder>  Set up this device's encrypted backups in a folder
  config                  Change the device name and the folders with workspace files

Every write shows a plan and asks for confirmation first.
sync and restore back up this device's files before writing anything (backups must be set up). The command line
takes the backups' password from CLAUDE_MEMORY_SYNC_PASSWORD.
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
  const { createEngine } = require('./lib/engine');
  const basic = require('./lib/commands/basic');
  const { cmdSync } = require('./lib/commands/sync');
  // The password the app saved is encrypted by the system for the app alone: here it comes from the environment.
  const engine = createEngine({ password: () => process.env.CLAUDE_MEMORY_SYNC_PASSWORD || null });
  switch (cmd) {
    case 'status': return basic.cmdStatus(engine);
    case 'backup':
    case 'export': return basic.cmdBackup(engine, { outDir: flags.outDir });
    case 'sync': return cmdSync(engine, rest[0], 'sync');
    case 'restore': return cmdSync(engine, rest[0], 'restore');
    case 'undo': return cmdSync(engine, null, 'restore', { undo: true });
    case 'config': return basic.cmdConfig(engine);
    case 'setup-backups': return basic.cmdSetupBackups(engine, rest[0]);
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
