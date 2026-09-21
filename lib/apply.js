'use strict';
const fs = require('fs');
const { writeFileAtomic, removeFile } = require('./fsx');

function applyOps(ops) {
  let done = 0;
  for (const op of ops) {
    try {
      if (op.type === 'write') writeFileAtomic(op.abs, op.buf);
      else removeFile(op.abs);
    } catch (e) {
      const err = new Error(`Could not ${op.type === 'write' ? 'write' : 'delete'}: ${op.abs} (${e.code || e.message})`);
      err.done = done;
      throw err;
    }
    done++;
  }
  return done;
}

function verifyOps(ops) {
  const problems = [];
  for (const op of ops) {
    if (op.type === 'write') {
      let buf;
      try {
        buf = fs.readFileSync(op.abs);
      } catch {
        problems.push(`could not read back: ${op.abs}`);
        continue;
      }
      if (!buf.equals(op.buf)) problems.push(`content mismatch: ${op.abs}`);
    } else if (fs.existsSync(op.abs)) {
      problems.push(`still exists after delete: ${op.abs}`);
    }
  }
  return problems;
}

module.exports = { applyOps, verifyOps };
