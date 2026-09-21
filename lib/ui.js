'use strict';
const readline = require('readline');

const useColor = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
const wrap = (code) => (s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const c = {
  bold: wrap('1'), dim: wrap('2'), red: wrap('31'), green: wrap('32'),
  yellow: wrap('33'), blue: wrap('34'), magenta: wrap('35'), cyan: wrap('36'), gray: wrap('90'),
};

// Line queue: works the same for an interactive terminal and for piped input (tests).
let rl = null;
let closed = false;
const queue = [];
const waiters = [];

function ensureReader() {
  if (rl) return;
  rl = readline.createInterface({ input: process.stdin, terminal: false });
  rl.on('line', (line) => (waiters.length ? waiters.shift()(line) : queue.push(line)));
  rl.on('close', () => {
    closed = true;
    while (waiters.length) waiters.shift()(null);
  });
}

function readLine() {
  ensureReader();
  if (queue.length) return Promise.resolve(queue.shift());
  if (closed) return Promise.resolve(null);
  return new Promise((resolve) => waiters.push(resolve));
}

async function ask(question) {
  process.stdout.write(question);
  const line = await readLine();
  if (line === null) {
    process.stdout.write('\n');
    return null;
  }
  if (!process.stdin.isTTY) process.stdout.write(line + '\n');
  return line.trim();
}

// The default is always NO. Closed input also counts as NO.
async function confirm(question) {
  const a = await ask(`${question} ${c.dim('(y/N)')} `);
  return a !== null && ['y', 'yes'].includes(a.toLowerCase());
}

// options: [{ key, label }]. Asks until a valid key is entered; returns null if input closes.
async function choose(question, options) {
  const keys = options.map((o) => o.key);
  for (;;) {
    console.log(question);
    for (const o of options) console.log(`   ${c.bold(o.key)}) ${o.label}`);
    const a = await ask(`   Choice [${keys.join('/')}]: `);
    if (a === null) return null;
    const k = a.toLowerCase();
    if (keys.includes(k)) return k;
    console.log(c.yellow(`   Invalid choice: "${a}"`));
  }
}

function close() {
  if (rl) rl.close();
}

function section(title) {
  console.log('');
  console.log(c.bold(c.cyan(`== ${title} `.padEnd(72, '='))));
}

function table(rows, { indent = 0 } = {}) {
  if (!rows.length) return;
  // eslint-disable-next-line no-control-regex
  const strip = (s) => String(s).replace(/\x1b\[[0-9;]*m/g, '');
  const widths = [];
  for (const r of rows) r.forEach((cell, i) => (widths[i] = Math.max(widths[i] || 0, strip(cell).length)));
  for (const r of rows) {
    const line = r
      .map((cell, i) => (i === r.length - 1 ? String(cell) : String(cell) + ' '.repeat(widths[i] - strip(cell).length)))
      .join('  ');
    console.log(' '.repeat(indent) + line);
  }
}

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

module.exports = { c, ask, confirm, choose, close, section, table, formatBytes };
