'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const P = require('../lib/paths');
const { parseJsonc } = require('../lib/scan');
const { hashContent } = require('../lib/fsx');

test('encodeProjectDir: macOS and Windows paths', () => {
  assert.strictEqual(P.encodeProjectDir('/Users/omer/Documents/GitHub/sasa-custom-frontend'), '-Users-omer-Documents-GitHub-sasa-custom-frontend');
  assert.strictEqual(P.encodeProjectDir('C:\\Users\\omer\\Documents\\GitHub\\sasa-x'), 'C--Users-omer-Documents-GitHub-sasa-x');
});

test('findProjectDirs: Windows path (name, letter case, session, guess)', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cms-p-'));
  fs.mkdirSync(path.join(root, 'C--Users-Omer-Documents-GitHub-sasa-x'));
  fs.mkdirSync(path.join(root, 'other-name'));
  fs.writeFileSync(path.join(root, 'other-name', 's.jsonl'), JSON.stringify({ type: 'user', cwd: 'c:\\users\\omer\\GitHub\\sasa-y\\' }) + '\n');
  fs.mkdirSync(path.join(root, 'D--old-place-sasa-z'));
  const idx = P.createProjectIndex(root);

  const a = P.findProjectDirs('C:\\Users\\omer\\Documents\\GitHub\\sasa-x', idx, 'win32');
  assert.deepStrictEqual(a.map((x) => [x.name, x.method]), [['C--Users-Omer-Documents-GitHub-sasa-x', 'name']]);
  const b = P.findProjectDirs('C:\\Users\\Omer\\GitHub\\sasa-y', idx, 'win32');
  assert.deepStrictEqual(b.map((x) => [x.name, x.method]), [['other-name', 'session']]);
  const z = P.findProjectDirs('C:\\Users\\omer\\GitHub\\sasa-z', idx, 'win32');
  assert.deepStrictEqual(z.map((x) => [x.name, x.method]), [['D--old-place-sasa-z', 'guess']]);
  assert.deepStrictEqual(P.findProjectDirs('C:\\x\\sasa-missing', idx, 'win32'), []);

  // Linux is case-sensitive: an exact name match does not count; macOS counts it
  fs.mkdirSync(path.join(root, '-home-Omer-sasa-q'));
  const idx2 = P.createProjectIndex(root);
  assert.deepStrictEqual(P.findProjectDirs('/home/omer/sasa-q', idx2, 'linux').map((x) => x.method), ['guess']);
  assert.deepStrictEqual(P.findProjectDirs('/home/omer/sasa-q', idx2, 'darwin').map((x) => x.method), ['name']);
});

test('parseKey and Windows name checks', () => {
  assert.deepStrictEqual(P.parseKey('memory/sasa-a/x.md'), { scope: 'memory', repo: 'sasa-a', rel: 'x.md' });
  assert.deepStrictEqual(P.parseKey('workspace/workspaces/a.code-workspace'), { scope: 'workspace', rel: 'workspaces/a.code-workspace' });
  for (const bad of ['memory/sasa-a/../x.md', 'memory/../x.md', 'memory/sasa-a/a\\b.md', 'workspace//x', 'workspace/C:/x', 'other/x']) {
    assert.strictEqual(P.parseKey(bad), null, bad);
  }
  assert.ok(P.windowsNameError('a:b.md'));
  assert.ok(P.windowsNameError('con.md'));
  assert.ok(P.windowsNameError('dir./x.md'));
  assert.strictEqual(P.windowsNameError('spc-madde-durumu.md'), null);
});

test('parseJsonc: comments and trailing commas, // inside strings is kept', () => {
  const j = parseJsonc('\uFEFF{\n // comment\n "folders": [ { "path": "../sasa-a", }, /* x */ ],\n "u": "http://a//b",\n}');
  assert.deepStrictEqual(j, { folders: [{ path: '../sasa-a' }], u: 'http://a//b' });
});

test('hashContent: CRLF/LF and BOM are equal, content change is not', () => {
  const a = hashContent(Buffer.from('satır 1\nsatır 2\n'));
  assert.strictEqual(hashContent(Buffer.from('satır 1\r\nsatır 2\r\n')), a);
  assert.strictEqual(hashContent(Buffer.from('\uFEFFsatır 1\nsatır 2\n')), a);
  assert.notStrictEqual(hashContent(Buffer.from('satır 1\nsatır 3\n')), a);
});
