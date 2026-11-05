'use strict';
// Before a backup starts: how much it will read and about how much it will write, for the free-space check and the
// overlay. It walks the folders the way restic will, with the same exclusions as far as they can be told without
// restic, and counts as changed every file modified since the last backup started. That errs on the large side: restic
// writes only the parts of a changed file that are new, and compresses them.
const fs = require('fs');
const path = require('path');
const { BackupError } = require('./errors');

// How many folders and files are read at the same time.
const PARALLEL = 32;
const CACHEDIR_SIGNATURE = 'Signature: 8a477f597d28d172789f06886806bc55';

const toSlash = (p) => p.split(path.sep).join('/');

// restic's exclude patterns: * ? and [...] within one name, ** for any number of folders. A pattern that does not start
// with / matches at any depth, and a folder that matches is left out with all that is in it. Patterns that bring
// something back (!) are ignored here: the estimate only gets larger for it.
function globPart(part) {
  let re = '';
  for (let i = 0; i < part.length; i++) {
    const c = part[i];
    if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else if (c === '[') {
      const end = part.indexOf(']', i + 1);
      if (end < 0) re += '\\[';
      else {
        re += `[${part.slice(i + 1, end).replace(/^!/, '^').replace(/\\/g, '\\\\')}]`;
        i = end;
      }
    } else if (c === '\\' && i + 1 < part.length) re += `\\${part[++i]}`;
    else re += c.replace(/[.+^${}()|\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

function compile(pattern) {
  const p = toSlash(pattern.trim()).replace(/\/+$/, '');
  if (!p || p.startsWith('!')) return null;
  const parts = p.split('/').filter(Boolean).map((x) => (x === '**' ? '**' : globPart(x)));
  return p.startsWith('/') || /^[A-Za-z]:/.test(p) ? parts : ['**', ...parts];
}

function matchParts(pat, i, segs, j) {
  if (i === pat.length) return j === segs.length;
  if (pat[i] === '**') {
    for (let k = j; k <= segs.length; k++) if (matchParts(pat, i + 1, segs, k)) return true;
    return false;
  }
  return j < segs.length && pat[i].test(segs[j]) && matchParts(pat, i + 1, segs, j + 1);
}

function excluder(patterns) {
  const compiled = patterns.map(compile).filter(Boolean);
  return (abs) => {
    if (!compiled.length) return false;
    const segs = toSlash(abs).split('/').filter(Boolean);
    return compiled.some((pat) => matchParts(pat, 0, segs, 0));
  };
}

function isCacheDir(dir) {
  try {
    const fd = fs.openSync(path.join(dir, 'CACHEDIR.TAG'), 'r');
    try {
      const buf = Buffer.alloc(CACHEDIR_SIGNATURE.length);
      fs.readSync(fd, buf, 0, buf.length, 0);
      return buf.toString('latin1') === CACHEDIR_SIGNATURE;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return false;
  }
}

// paths: absolute folders and files. since: when the last backup started (ms), or null for the first one.
// Resolves to { files, bytes, changedFiles, changedBytes, unreadable }: unreadable counts what could not be read here
// (restic will name it).
async function estimate({ paths, excludes = [], excludeCaches = false, since = null, signal = null, onProgress = () => {} }) {
  const excluded = excluder(excludes);
  const out = { files: 0, bytes: 0, changedFiles: 0, changedBytes: 0, unreadable: 0 };
  const queue = [];
  let lastReport = 0;
  const report = () => {
    const now = Date.now();
    if (now - lastReport < 250) return;
    lastReport = now;
    onProgress({ files: out.files, bytes: out.bytes });
  };

  const visit = async (abs) => {
    let st;
    try {
      st = await fs.promises.lstat(abs);
    } catch {
      out.unreadable++;
      return;
    }
    if (st.isDirectory()) {
      if (excludeCaches && isCacheDir(abs)) return;
      let names;
      try {
        names = await fs.promises.readdir(abs);
      } catch {
        out.unreadable++;
        return;
      }
      for (const name of names) {
        const child = path.join(abs, name);
        if (!excluded(child)) queue.push(child);
      }
    } else if (st.isFile()) {
      out.files++;
      out.bytes += st.size;
      if (since == null || st.mtimeMs > since || st.ctimeMs > since) {
        out.changedFiles++;
        out.changedBytes += st.size;
      }
    }
    report();
  };

  for (const p of paths) if (!excluded(p)) queue.push(p);
  // PARALLEL visits at a time; each one that ends starts the next, until nothing is left and nothing runs.
  let active = 0;
  await new Promise((resolve, reject) => {
    const pump = () => {
      if (signal && signal.aborted) {
        if (!active) reject(new BackupError('CANCELLED', 'Stopped while counting the files.'));
        return;
      }
      while (active < PARALLEL && queue.length) {
        active++;
        visit(queue.pop()).then(() => {
          active--;
          pump();
        });
      }
      if (!active && !queue.length) resolve();
    };
    pump();
  });
  onProgress({ files: out.files, bytes: out.bytes });
  return out;
}

module.exports = { estimate, excluder };
