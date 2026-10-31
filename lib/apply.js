'use strict';
const fs = require('fs');
const { writeFileAtomic, removeFile, readIfExists } = require('./fsx');

// Applies writes and deletes in order. If one fails, everything done so far is put back as it was.
// A write with load() instead of buf (a large chat part) is read only when written, and checked right then.
function applyOps(ops) {
  const done = [];
  for (const op of ops) {
    try {
      const before = readIfExists(op.abs);
      if (op.type === 'write') {
        const buf = op.load ? op.load() : op.buf;
        writeFileAtomic(op.abs, buf);
        if (op.load && !fs.readFileSync(op.abs).equals(buf)) throw new Error('content mismatch after writing');
      } else {
        removeFile(op.abs);
      }
      done.push({ op, before });
    } catch (e) {
      const rollbackErrors = [];
      for (const { op: d, before } of done.reverse()) {
        try {
          if (before) writeFileAtomic(d.abs, before);
          else removeFile(d.abs);
        } catch (re) {
          rollbackErrors.push(`${d.abs} (${re.code || re.message})`);
        }
      }
      const err = new Error(`Could not ${op.type === 'write' ? 'write' : 'delete'}: ${op.abs} (${e.code || e.message})`);
      err.code = 'APPLY_FAILED';
      err.done = done.length;
      err.rolledBack = rollbackErrors.length === 0;
      err.rollbackErrors = rollbackErrors;
      throw err;
    }
  }
  return done.length;
}

function verifyOps(ops) {
  const problems = [];
  for (const op of ops) {
    if (op.load) continue; // checked as it was written
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
