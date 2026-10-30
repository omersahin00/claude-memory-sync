'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const P = require('../lib/paths');
const { normalizeRemote } = require('../lib/git');
const { discoverProjects, nameFromDirName } = require('../lib/projects');
const { hashContent } = require('../lib/fsx');

test('encodeProjectDir: macOS and Windows paths', () => {
  assert.strictEqual(P.encodeProjectDir('/Users/demo/Documents/GitHub/acme-custom-frontend'), '-Users-demo-Documents-GitHub-acme-custom-frontend');
  assert.strictEqual(P.encodeProjectDir('C:\\Users\\demo\\Documents\\GitHub\\acme-x'), 'C--Users-demo-Documents-GitHub-acme-x');
});

test('slugKey and homeRel', () => {
  assert.strictEqual(P.slugKey('acme-custom-frontend'), 'acme-custom-frontend');
  assert.strictEqual(P.slugKey('Çalışma Notları DB'), 'calisma-notlari-db');
  assert.strictEqual(P.slugKey('Özel Entegrasyon'), 'ozel-entegrasyon');
  assert.strictEqual(P.slugKey('...'), 'project');
  assert.strictEqual(P.homeRel('/Users/o/Documents/GitHub/x', '/Users/o', 'darwin'), 'Documents/GitHub/x');
  assert.strictEqual(P.homeRel('C:\\Users\\o\\Desktop', 'C:\\Users\\o', 'win32'), 'Desktop');
  assert.strictEqual(P.homeRel('/Users/o', '/Users/o', 'darwin'), '');
  assert.strictEqual(P.homeRel('/opt/x', '/Users/o', 'darwin'), null);
});

test('nameFromDirName strips the longest known parent', () => {
  const parents = ['/Users/demo', '/Users/demo/Desktop', '/Users/demo/Documents/GitHub'];
  assert.strictEqual(nameFromDirName('-Users-demo-Documents-GitHub-acme-backend-service', parents, 'darwin'), 'acme-backend-service');
  assert.strictEqual(nameFromDirName('-Users-demo-Desktop-Ozel-Entegrasyon', parents, 'darwin'), 'Ozel-Entegrasyon');
  assert.strictEqual(nameFromDirName('-opt-x', parents, 'darwin'), 'opt-x');
});

test('decodeProjectDir and discoverProjects', { skip: process.platform === 'win32' }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cms-p-'));
  const repo = path.join(root, 'my repo', 'acme-x');
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  fs.writeFileSync(path.join(repo, '.git', 'config'), '[core]\n\tbare = false\n[remote "origin"]\n\turl = git@github.com:me/acme-x.git\n');
  const claude = path.join(root, '.claude');
  const dirName = P.encodeProjectDir(repo);
  fs.mkdirSync(path.join(claude, 'projects', dirName, 'memory'), { recursive: true });
  fs.writeFileSync(path.join(claude, 'projects', dirName, 'memory', 'MEMORY.md'), '- [A](a.md)\n');
  assert.strictEqual(P.decodeProjectDir(dirName), repo);

  // The session log tells the folder even when it no longer exists.
  const gone = path.join(root, 'old', 'thing');
  const goneDir = P.encodeProjectDir(gone);
  fs.mkdirSync(path.join(claude, 'projects', goneDir), { recursive: true });
  fs.writeFileSync(path.join(claude, 'projects', goneDir, 's.jsonl'), JSON.stringify({ type: 'user', cwd: gone }) + '\n');

  const list = discoverProjects({ claudeDir: claude, home: root });
  const x = list.find((p) => p.id === dirName);
  assert.strictEqual(x.cwd, repo);
  assert.strictEqual(x.name, 'acme-x');
  assert.strictEqual(x.gitId, 'github.com/me/acme-x');
  assert.strictEqual(x.homeRel, 'my repo/acme-x');
  assert.strictEqual(x.files.size, 1);
  const g = list.find((p) => p.id === goneDir);
  assert.strictEqual(g.cwd, gone);
  assert.strictEqual(g.exists, false);
  assert.strictEqual(g.name, 'thing');
});

test('normalizeRemote: one repository written different ways', () => {
  for (const u of ['git@github.com:Me/Repo.git', 'https://github.com/me/repo', 'https://user@github.com/me/repo.git/', 'ssh://git@github.com:22/me/repo.git']) {
    assert.strictEqual(normalizeRemote(u), 'github.com/me/repo', u);
  }
  assert.strictEqual(normalizeRemote(null), null);
});

test('parseKey and Windows name checks', () => {
  assert.deepStrictEqual(P.parseKey('memory/acme-a/x.md'), { scope: 'memory', owner: 'acme-a', rel: 'x.md' });
  assert.deepStrictEqual(P.parseKey('workspace/documents-github/workspaces/a.code-workspace'), { scope: 'workspace', owner: 'documents-github', rel: 'workspaces/a.code-workspace' });
  assert.deepStrictEqual(P.parseKey('claude/agents/x.md'), { scope: 'claude', owner: null, rel: 'agents/x.md' });
  for (const bad of ['memory/acme-a/../x.md', 'memory/../x.md', 'memory/acme-a/a\\b.md', 'workspace//x', 'workspace/C:/x', 'other/x', 'claude/../x', 'memory/a b/x.md']) {
    assert.strictEqual(P.parseKey(bad), null, bad);
  }
  assert.ok(P.windowsNameError('a:b.md'));
  assert.ok(P.windowsNameError('con.md'));
  assert.ok(P.windowsNameError('dir./x.md'));
  assert.strictEqual(P.windowsNameError('spc-madde-durumu.md'), null);
});

test('hashContent: CRLF/LF and BOM are equal, content change is not', () => {
  const a = hashContent(Buffer.from('satır 1\nsatır 2\n'));
  assert.strictEqual(hashContent(Buffer.from('satır 1\r\nsatır 2\r\n')), a);
  assert.strictEqual(hashContent(Buffer.from('\uFEFFsatır 1\nsatır 2\n')), a);
  assert.notStrictEqual(hashContent(Buffer.from('satır 1\nsatır 3\n')), a);
});
