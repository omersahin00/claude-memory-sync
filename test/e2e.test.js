'use strict';
// Simulates two devices (A and B) with separate home/Claude/state folders and drives the CLI with real input.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const P = require('../lib/paths');

const CLI = path.join(__dirname, '..', 'cli.js');

function device(root, name) {
  const home = path.join(root, name);
  const repos = path.join(home, 'GitHub');
  const claude = path.join(home, '.claude');
  const state = path.join(home, 'state');
  for (const d of [repos, path.join(claude, 'projects'), state]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(state, 'config.json'), JSON.stringify({ deviceId: `${name}-id`, deviceName: name, reposRoot: repos, prefix: 'sasa' }));
  const mem = (repo) => path.join(claude, 'projects', P.encodeProjectDir(path.join(repos, repo)), 'memory');
  return {
    name, repos, state,
    clone: (repo) => fs.mkdirSync(path.join(repos, repo, '.git'), { recursive: true }),
    openClaude: (repo) => fs.mkdirSync(mem(repo), { recursive: true }),
    mem,
    write: (repo, rel, text) => { fs.mkdirSync(mem(repo), { recursive: true }); fs.writeFileSync(path.join(mem(repo), rel), text); },
    read: (repo, rel) => fs.readFileSync(path.join(mem(repo), rel), 'utf8'),
    has: (repo, rel) => fs.existsSync(path.join(mem(repo), rel)),
    rm: (repo, rel) => fs.unlinkSync(path.join(mem(repo), rel)),
    snapshot(repo) {
      const out = {};
      for (const f of fs.readdirSync(mem(repo)).sort()) out[f] = fs.readFileSync(path.join(mem(repo), f), 'utf8');
      return out;
    },
    history: () => fs.readFileSync(path.join(state, 'history.json'), 'utf8'),
    run(args, input) {
      const r = spawnSync(process.execPath, [CLI, ...args], {
        input, encoding: 'utf8',
        env: { ...process.env, CLAUDE_MEMORY_SYNC_HOME: state, CLAUDE_CONFIG_DIR: claude, HOME: home, USERPROFILE: home, NO_COLOR: '1' },
      });
      return { code: r.status, out: r.stdout + r.stderr };
    },
    backup(input = 'y\n') {
      const outDir = fs.mkdtempSync(path.join(home, 'bundle-'));
      const r = this.run(['backup', '-o', outDir], input);
      assert.strictEqual(r.code, 0, r.out);
      const files = fs.readdirSync(outDir).filter((f) => f.endsWith('.memsync'));
      assert.strictEqual(files.length, 1, r.out);
      return path.join(outDir, files[0]);
    },
  };
}

test('end to end: transfer, two-way sync, conflict, cancel, undo, empty-folder protection, restore after format', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cms-e2e-'));
  const A = device(root, 'mac');
  const B = device(root, 'win');

  // --- A: two repos and a workspace
  for (const r of ['sasa-a', 'sasa-b']) A.clone(r);
  A.write('sasa-a', 'MEMORY.md', '- [X](x.md) — x\n- [Y](y.md) — y\n');
  A.write('sasa-a', 'x.md', 'x v1\n');
  A.write('sasa-a', 'y.md', 'y v1\n');
  A.write('sasa-b', 'MEMORY.md', '- [B](b.md) — b\n');
  A.write('sasa-b', 'b.md', 'b\n');
  fs.mkdirSync(path.join(A.repos, 'workspaces'));
  fs.writeFileSync(path.join(A.repos, 'workspaces', 'sasa.code-workspace'), '{ "folders": [ { "path": "../sasa-a" }, ], }\n');

  // --- B: only sasa-a is cloned and opened in Claude
  B.clone('sasa-a');
  B.openClaude('sasa-a');

  // 1) First transfer: sasa-b is not ready, warn and continue with the ready ones
  let bundle = A.backup();
  let r = B.run(['sync', bundle], 'y\ny\n');
  assert.strictEqual(r.code, 0, r.out);
  assert.match(r.out, /sasa-b\s+not cloned/);
  assert.deepStrictEqual(B.snapshot('sasa-a'), A.snapshot('sasa-a'));
  assert.strictEqual(fs.readFileSync(path.join(B.repos, 'workspaces', 'sasa.code-workspace'), 'utf8'), '{ "folders": [ { "path": "../sasa-a" }, ], }\n');
  assert.ok(!fs.existsSync(B.mem('sasa-b')), 'a repo that is not ready must not be touched');

  // 2) Same bundle again: nothing to write; a CRLF difference is not a change
  B.write('sasa-a', 'x.md', 'x v1\r\n');
  r = B.run(['sync', bundle], 'y\n');
  assert.strictEqual(r.code, 0, r.out);
  assert.match(r.out, /Nothing to write or delete/);

  // 3) Two-way: A updates/deletes/adds while B adds
  A.write('sasa-a', 'x.md', 'x v2\n');
  A.rm('sasa-a', 'y.md');
  A.write('sasa-a', 'z.md', 'z\n');
  A.write('sasa-a', 'MEMORY.md', '- [X](x.md) — x\n- [Z](z.md) — z\n');
  B.write('sasa-a', 'w.md', 'w\n');
  B.write('sasa-a', 'MEMORY.md', '- [X](x.md) — x\n- [Y](y.md) — y\n- [W](w.md) — w\n');

  bundle = A.backup();
  r = B.run(['sync', bundle], 'y\ny\n');
  assert.strictEqual(r.code, 0, r.out);
  assert.strictEqual(B.read('sasa-a', 'x.md'), 'x v2\n');
  assert.ok(!B.has('sasa-a', 'y.md'), 'a file deleted on A must be deleted on B');
  assert.strictEqual(B.read('sasa-a', 'z.md'), 'z\n');
  assert.strictEqual(B.read('sasa-a', 'w.md'), 'w\n');
  assert.strictEqual(B.read('sasa-a', 'MEMORY.md'), '- [X](x.md) — x\n- [Z](z.md) — z\n- [W](w.md) — w\n');

  r = A.run(['sync', B.backup()], 'y\n');
  assert.strictEqual(r.code, 0, r.out);
  assert.deepStrictEqual(A.snapshot('sasa-a'), B.snapshot('sasa-a'), 'both devices must be equal after the round trip');
  assert.deepStrictEqual(A.snapshot('sasa-b'), { 'MEMORY.md': '- [B](b.md) — b\n', 'b.md': 'b\n' }, 'a repo missing on B must not be deleted on A');

  // 4) Conflict: both devices change the same file, "keep both"
  A.write('sasa-a', 'x.md', 'x A\n');
  B.write('sasa-a', 'x.md', 'x B\n');
  bundle = A.backup();
  const beforeB = B.snapshot('sasa-a');
  r = B.run(['sync', bundle], 'y\nb\ny\n');
  assert.strictEqual(r.code, 0, r.out);
  assert.strictEqual(B.read('sasa-a', 'x.md'), 'x B\n');
  assert.strictEqual(B.read('sasa-a', 'x--mac.md'), 'x A\n');
  assert.match(B.read('sasa-a', 'MEMORY.md'), /\(x--mac\.md\)/);
  const undo = r.out.match(/To undo: node cli\.js restore "([^"]+)"/)[1];

  // 5) Cancel: nothing changes without confirmation
  const snap = B.snapshot('sasa-a');
  const hist = B.history();
  A.write('sasa-a', 'z.md', 'z v2\n');
  r = B.run(['sync', A.backup()], 'y\nn\n');
  assert.strictEqual(r.code, 1, r.out);
  assert.deepStrictEqual(B.snapshot('sasa-a'), snap);
  assert.strictEqual(B.history(), hist);

  // 6) Undo: the state before the conflict comes back exactly
  r = B.run(['restore', undo], 'y\n');
  assert.strictEqual(r.code, 0, r.out);
  assert.deepStrictEqual(B.snapshot('sasa-a'), beforeB);

  // 7) Empty-folder protection: if B's memory is emptied by mistake, A is not mass-deleted
  for (const f of Object.keys(B.snapshot('sasa-a'))) B.rm('sasa-a', f);
  const emptyBundle = B.backup();
  const beforeA = A.snapshot('sasa-a');
  r = A.run(['sync', emptyBundle], 'y\n');
  assert.deepStrictEqual(A.snapshot('sasa-a'), beforeA, r.out);

  // 8) After a format: no state folder and no memories, full restore from the bundle
  const C = device(root, 'mac-format');
  C.clone('sasa-a');
  C.openClaude('sasa-a');
  C.clone('sasa-b');
  C.openClaude('sasa-b');
  r = C.run(['restore', A.backup()], 'y\n');
  assert.strictEqual(r.code, 0, r.out);
  assert.deepStrictEqual(C.snapshot('sasa-a'), A.snapshot('sasa-a'));
  assert.deepStrictEqual(C.snapshot('sasa-b'), A.snapshot('sasa-b'));
});
