'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseJsonc, inspectWorkspace, scanRoot, makePortable } = require('../lib/workspaces');

test('parseJsonc: comments and trailing commas, // inside strings is kept', () => {
  const j = parseJsonc('﻿{\n // comment\n "folders": [ { "path": "../acme-a", }, /* x */ ],\n "u": "http://a//b",\n}');
  assert.deepStrictEqual(j, { folders: [{ path: '../acme-a' }], u: 'http://a//b' });
});

// Everything these tests write is under one folder, removed at the end.
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'cms-workspaces-'));
test.after(() => fs.rmSync(ROOT, { recursive: true, force: true }));

function fixture() {
  const root = fs.mkdtempSync(path.join(ROOT, 'w-'));
  fs.mkdirSync(path.join(root, 'acme-a', '.git'), { recursive: true });
  fs.mkdirSync(path.join(root, 'workspaces'));
  const ws = path.join(root, 'workspaces', 'x.code-workspace');
  const text = `{\n  // my workspace\n  "folders": [\n    { "path": ${JSON.stringify(path.join(root, 'acme-a'))} },\n    { "path": "..\\\\acme-b" },\n    { "path": "../acme-a" },\n  ],\n  "settings": { "a": 1 },\n}\n`;
  fs.writeFileSync(ws, text);
  return { root, ws, text };
}

test('inspectWorkspace: absolute paths, backslashes and missing folders are reported', { skip: process.platform === 'win32' }, () => {
  const { root, ws } = fixture();
  const info = inspectWorkspace(ws, root);
  assert.strictEqual(info.folders.length, 3);
  assert.deepStrictEqual(info.folders[0].warnings, ['absolute']);
  assert.ok(info.folders[0].isGit);
  assert.deepStrictEqual(info.folders[1].warnings, ['backslash', 'missing']);
  assert.deepStrictEqual(info.folders[2].warnings, []);
  assert.strictEqual(info.fixable, true);
  assert.strictEqual(info.settings, 1);
});

test('makePortable: relative forward-slash paths, comments kept', { skip: process.platform === 'win32' }, () => {
  const { ws, text } = fixture();
  const { text: out, changes } = makePortable(text, ws);
  assert.strictEqual(changes.length, 2);
  assert.ok(out.includes('// my workspace'));
  assert.strictEqual((out.match(/"path": "\.\.\/acme-a"/g) || []).length, 2);
  assert.ok(out.includes('"path": "../acme-b"'));
  assert.deepStrictEqual(makePortable(out, ws).changes, []);
});

test('scanRoot: finds workspace files, skips git repositories and node_modules', () => {
  const { root } = fixture();
  fs.writeFileSync(path.join(root, 'top.code-workspace'), '{"folders":[]}');
  fs.writeFileSync(path.join(root, 'acme-a', 'inside-repo.code-workspace'), '{"folders":[]}');
  fs.mkdirSync(path.join(root, 'node_modules', 'x'), { recursive: true });
  fs.writeFileSync(path.join(root, 'node_modules', 'x', 'y.code-workspace'), '{}');
  assert.deepStrictEqual([...scanRoot(root).keys()].sort(), ['top.code-workspace', 'workspaces/x.code-workspace']);
});

test('folderRels: folders a workspace opens, inside the scanned folder only', () => {
  const { folderRels } = require('../lib/workspaces');
  const buf = Buffer.from('{ "folders": [ { "path": "../app" }, { "path": "..\\\\win\\\\lib" }, { "path": "../../outside" }, { "path": "/abs/x" }, { "path": "C:\\\\x" }, { "uri": "vscode-remote://x" }, ], }');
  assert.deepStrictEqual(folderRels('workspaces/a.code-workspace', buf), ['app', 'win/lib']);
  assert.deepStrictEqual(folderRels('a.code-workspace', Buffer.from('{ "folders": [ { "path": "app" }, { "path": "." } ] }')), ['app']);
  assert.deepStrictEqual(folderRels('a.code-workspace', Buffer.from('not json')), []);
});
