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

function readIfExists(abs) {
  try {
    return fs.readFileSync(abs);
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}

// sha256 of a file, read a chunk at a time without holding up the process (files can be hundreds of MB).
async function hashFile(abs) {
  const h = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(abs, { highWaterMark: 1024 * 1024 })) h.update(chunk);
  return h.digest('hex');
}

// Two paths of one file on disk (a linked folder, for example): removing "the other copy" would remove the only one.
function sameFile(a, b) {
  try {
    const x = fs.statSync(a, { bigint: true });
    const y = fs.statSync(b, { bigint: true });
    return x.ino === y.ino && x.dev === y.dev;
  } catch {
    return false;
  }
}

async function syncPath(abs) {
  const fh = await fs.promises.open(abs, 'r+');
  try {
    await fh.sync();
  } finally {
    await fh.close();
  }
}

// A file is in one of the two places at every moment. On one disk this is a rename. Across disks it is a copy next to
// the target, written out to the disk and compared with the original; the original goes only after that. dst must be
// free: a rename would replace what is there.
async function moveFile(src, dst) {
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  try {
    fs.renameSync(src, dst);
    return;
  } catch (e) {
    if (e.code === 'ENOENT') throw e;
  }
  const tmp = `${dst}${TMP_MARK}move`;
  try {
    const st = fs.statSync(src);
    await fs.promises.copyFile(src, tmp);
    await fs.promises.utimes(tmp, st.atime, st.mtime);
    await syncPath(tmp);
    if ((await hashFile(tmp)) !== (await hashFile(src))) throw Object.assign(new Error(`The copy differs from the original: ${src}`), { code: 'COPY_MISMATCH' });
    withRetry(() => fs.renameSync(tmp, dst));
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
  // The new name on the disk before the old one goes. A folder cannot be opened like this on Windows.
  await fs.promises.open(path.dirname(dst), 'r').then((fh) => fh.sync().finally(() => fh.close())).catch(() => {});
  removeFile(src);
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

const IGNORED = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini']);
const ignoredName = (n) => IGNORED.has(n) || n.includes(TMP_MARK);

// All files in a folder: Map<relative path ('/' separated), { abs, buf, hash, mtime }>
function readTree(root) {
  const out = new Map();
  const visit = (dir, parts) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return;
      throw e;
    }
    for (const e of entries) {
      if (ignoredName(e.name)) continue;
      const abs = path.join(dir, e.name);
      const rel = [...parts, e.name];
      if (e.isDirectory()) visit(abs, rel);
      else if (e.isFile()) {
        const buf = fs.readFileSync(abs);
        let mtime = 0;
        try { mtime = fs.statSync(abs).mtimeMs; } catch { /* ignore */ }
        out.set(rel.join('/'), { abs, buf, hash: hashContent(buf), mtime });
      }
    }
  };
  visit(root, []);
  return out;
}

module.exports = { withRetry, writeFileAtomic, removeFile, readIfExists, hashContent, hashFile, sameFile, moveFile, readTree, TMP_MARK };
