'use strict';
// Free space on the disk a backup is written to. A backup never starts when it would not fit with room to spare, and one
// that is running stops when the disk fills up, so the computer is never left without space: more room is kept on the
// computer's own disk, which the system needs, than on a backup disk.
const fs = require('fs');
const path = require('path');
const { BackupError } = require('./errors');

const GB = 1024 ** 3;
const MB = 1024 ** 2;
// Kept free before a backup starts.
const SYSTEM_RESERVE = 2 * GB;
const OTHER_RESERVE = 100 * MB;
// A running backup stops when the free space falls under this.
const SYSTEM_FLOOR = 1 * GB;
const OTHER_FLOOR = 50 * MB;

// The folder itself, or the nearest folder above it that is there (a backup folder that is about to be made).
function existing(p) {
  let at = path.resolve(String(p));
  while (!fs.existsSync(at) && path.dirname(at) !== at) at = path.dirname(at);
  return at;
}

// Bytes free for this user; null when the disk does not say (some network folders).
function freeSpace(dir) {
  try {
    const s = fs.statfsSync(existing(dir));
    return Number(s.bavail) * Number(s.bsize);
  } catch {
    return null;
  }
}

// Whether the folder is on the disk the home folder is on: the computer's own disk.
function onSystemDisk(dir, home) {
  try {
    return fs.statSync(existing(dir)).dev === fs.statSync(home).dev;
  } catch {
    return true;
  }
}

// need: bytes the backup will write. A disk whose space cannot be read is not held up here.
function spaceFor(dir, need, { home }) {
  const free = freeSpace(dir);
  const system = onSystemDisk(dir, home);
  const reserve = system ? SYSTEM_RESERVE : OTHER_RESERVE;
  return { free, need, reserve, floor: system ? SYSTEM_FLOOR : OTHER_FLOOR, system, enough: free === null || need + reserve <= free };
}

function requireSpace(dir, need, opts) {
  const s = spaceFor(dir, need, opts);
  if (!s.enough) {
    throw new BackupError('NO_SPACE', `Not enough free space for ${dir}: about ${need} bytes to write, ${s.free} free, ${s.reserve} kept free.`, { path: dir, need, free: s.free, reserve: s.reserve });
  }
  return s;
}

module.exports = { freeSpace, onSystemDisk, spaceFor, requireSpace, existing, SYSTEM_RESERVE, OTHER_RESERVE };
