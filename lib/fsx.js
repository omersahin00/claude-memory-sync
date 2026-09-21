'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// On Windows, antivirus scanners or open file handles can cause transient EPERM/EBUSY errors.
const RETRY_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function withRetry(fn, attempts = 10) {
  for (let i = 1; ; i++) {
    try {
      return fn();
    } catch (e) {
      if (!RETRY_CODES.has(e.code) || i >= attempts) throw e;
      sleepSync(100 * i);
    }
  }
}

const TMP_MARK = '.cms-tmp-';

// Write to a temp file, then rename over the target in one step: no half-written files.
function writeFileAtomic(abs, data) {
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const tmp = `${abs}${TMP_MARK}${process.pid}`;
  fs.writeFileSync(tmp, data);
  try {
    withRetry(() => fs.renameSync(tmp, abs));
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    throw e;
  }
}

function removeFile(abs) {
  withRetry(() => {
    try {
      fs.unlinkSync(abs);
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
  });
}

// For text files, BOM and CRLF/LF differences do not change the hash: Windows and macOS see the same content as equal.
function hashContent(buf) {
  let data = buf;
  if (!buf.includes(0)) {
    const s = buf.toString('utf8');
    if (Buffer.from(s, 'utf8').equals(buf)) {
      data = Buffer.from((s.charCodeAt(0) === 0xfeff ? s.slice(1) : s).replace(/\r\n/g, '\n'), 'utf8');
    }
  }
  return crypto.createHash('sha256').update(data).digest('hex').slice(0, 40);
}

module.exports = { withRetry, writeFileAtomic, removeFile, hashContent, TMP_MARK };
