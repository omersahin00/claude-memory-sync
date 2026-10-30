'use strict';
const ui = require('../ui');

const { c } = ui;

const HOW = {
  self: 'own backup', saved: 'matched before', git: 'same git remote', path: 'same folder', key: 'same name',
  name: 'same name only', manual: 'chosen', claude: 'Claude folder',
};
const MATCH_WARNINGS = {
  'name-only': 'only the name matches, check it',
  'git-mismatch': 'a project with this name has a different git remote',
  'duplicate-target': 'another location already goes to the same place',
};
const GROUPS = {
  new: ['+', 'green', 'new on the other device'],
  updated: ['~', 'cyan', 'changed on the other device'],
  deleted: ['-', 'red', 'deleted on the other device'],
  conflict: ['!', 'yellow', 'changed on both devices, decision needed'],
  index: ['*', 'magenta', 'index file, merged line by line'],
  kept: ['.', 'gray', 'kept as it is on this device'],
};
const MIRROR_GROUPS = {
  new: ['+', 'green', 'will be added'],
  updated: ['~', 'cyan', 'will be replaced with the bundle version'],
  deleted: ['-', 'red', 'not in the bundle, will be deleted'],
};
const ACTIONS = {
  'conflict-remote-deleted': 'changed here, deleted on the other device',
  'conflict-local-deleted': 'deleted here, changed on the other device',
  'local-only': 'only on this device',
  'local-newer': 'newer on this device',
  'local-deleted': 'deleted on this device, stays deleted',
};
const LOCATION_TYPES = { project: 'project', workspaceRoot: 'workspace folder', claude: 'Claude settings' };

function blockingText(e) {
  if (e.code === 'case-collision') return `${e.scope}: "${e.a}" and "${e.b}" differ only by letter case and would be the same file on this device.`;
  if (e.code === 'windows-name') return `${e.scope}: ${e.detail}`;
  return JSON.stringify(e);
}

function warningText(w) {
  if (w.code === 'empty-memory') return `${w.name}: memory folder is empty but had files before; it may have been deleted by mistake, so it was left out.`;
  if (w.code === 'empty-workspaces') return `${w.path}: no workspace files found, but there were some before; left out.`;
  if (w.code === 'empty-claude') return 'Claude settings folder looks empty but had files before; left out.';
  return w.code;
}

function printDevice(dev) {
  ui.section('Device');
  ui.table([
    ['Operating system', dev.platformName],
    ['Device name', dev.name],
    ['Claude folder', `${dev.claudeDir} ${dev.claudeExists ? c.green('(exists)') : c.red('(missing)')}`],
    ['State folder', dev.stateHome],
  ], { indent: 2 });
}

function locationLabel(loc) {
  return `${loc.name || loc.key} ${c.dim(`(${LOCATION_TYPES[loc.type] || loc.type})`)}`;
}

module.exports = { HOW, MATCH_WARNINGS, GROUPS, MIRROR_GROUPS, ACTIONS, LOCATION_TYPES, blockingText, warningText, printDevice, locationLabel };
