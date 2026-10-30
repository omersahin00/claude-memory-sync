'use strict';
const fs = require('fs');
const path = require('path');
const { readTree, hashContent } = require('./fsx');

// User-level Claude Code files worth carrying between devices.
// skills/synced is filled by the Claude app from the account; it comes back by itself.
const ITEMS = ['CLAUDE.md', 'agents', 'commands', 'skills', 'output-styles'];
const SKIP = ['skills/synced'];
const skipped = (rel) => SKIP.some((s) => rel === s || rel.startsWith(`${s}/`));

function readClaudeConfig(claudeDir) {
  const out = new Map();
  for (const item of ITEMS) {
    const abs = path.join(claudeDir, item);
    let st;
    try {
      st = fs.statSync(abs);
    } catch {
      continue;
    }
    if (st.isFile()) {
      const buf = fs.readFileSync(abs);
      out.set(item, { abs, buf, hash: hashContent(buf), mtime: st.mtimeMs });
    } else if (st.isDirectory()) {
      for (const [rel, f] of readTree(abs)) {
        const full = `${item}/${rel}`;
        if (!skipped(full)) out.set(full, f);
      }
    }
  }
  return out;
}

module.exports = { readClaudeConfig, CLAUDE_ITEMS: ITEMS };
