'use strict';
// The locale files in app/locales: every language has every text of the English one, with the same placeholders, and
// every text the code asks for exists.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const i18n = require('../app/i18n');

const load = (code) => JSON.parse(fs.readFileSync(path.join(i18n.DIR, `${code}.json`), 'utf8'));
const isPlural = (v) => v && typeof v === 'object' && typeof v.other === 'string';
// { 'home.sub': 'text' | { one, other } } for every text of a locale file.
function texts(obj, prefix = '', out = {}) {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (typeof v === 'string' || isPlural(v)) out[key] = v;
    else texts(v, key, out);
  }
  return out;
}
const placeholders = (v) => [...new Set((typeof v === 'string' ? [v] : Object.values(v)).join(' ').match(/\{\w+\}/g) || [])].sort();

const en = texts(load('en'));

test('every language has exactly the texts of the English file, with the same placeholders', () => {
  assert.ok(i18n.LANGUAGES.includes('en') && i18n.LANGUAGES.includes('tr'));
  for (const code of i18n.LANGUAGES) {
    const loc = texts(load(code));
    assert.deepStrictEqual(Object.keys(loc).filter((k) => !(k in en)), [], `${code}: texts that English does not have`);
    assert.deepStrictEqual(Object.keys(en).filter((k) => !(k in loc)), [], `${code}: missing texts`);
    const categories = new Intl.PluralRules(code).resolvedOptions().pluralCategories;
    for (const [k, v] of Object.entries(loc)) {
      assert.deepStrictEqual(placeholders(v), placeholders(en[k]), `${code}: placeholders of ${k}`);
      if (typeof v === 'object') {
        for (const form of Object.keys(v)) assert.ok(categories.includes(form), `${code}: ${k} has the form "${form}", which ${code} does not use`);
      }
    }
  }
});

test('every text the code asks for exists', () => {
  const files = [path.join(__dirname, '..', 'app', 'main.js')];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.jsx?$/.test(e.name)) files.push(p);
    }
  };
  walk(path.join(__dirname, '..', 'app', 'renderer', 'src'));
  const tables = new Set(Object.keys(en).map((k) => k.slice(0, k.lastIndexOf('.'))));
  const asked = [];
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    for (const m of src.matchAll(/\bt\(\s*'([^']+)'/g)) asked.push([m[1], f]);
    for (const m of src.matchAll(/\bcount\(\s*'([^']+)'/g)) asked.push([`count.${m[1]}`, f]);
    for (const m of src.matchAll(/\blabel\(\s*'([^']+)'/g)) assert.ok(tables.has(m[1]), `${path.basename(f)}: no table ${m[1]}`);
    // t(`nav.${id}`) and the like: the part before the first ${ must be a table.
    for (const m of src.matchAll(/\b(?:t|label)\(\s*`([^`$]+)\.\$\{/g)) assert.ok(tables.has(m[1]), `${path.basename(f)}: no table ${m[1]}`);
  }
  assert.ok(asked.length > 300, 'the texts were found in the code');
  for (const [key, f] of asked) assert.ok(key in en, `${path.basename(f)}: ${key} is not in en.json`);
});

test('every error code the engine and the main process give has a text', () => {
  const sources = [path.join(__dirname, '..', 'app', 'main.js')];
  const lib = path.join(__dirname, '..', 'lib');
  for (const f of fs.readdirSync(lib)) if (f.endsWith('.js')) sources.push(path.join(lib, f));
  // These two have their own texts, picked in errorText.
  const own = new Set(['APPLY_FAILED', 'VERIFY_FAILED']);
  const codes = new Set();
  for (const f of sources) {
    const src = fs.readFileSync(f, 'utf8');
    for (const m of src.matchAll(/\b(?:EngineError|fail)\(\s*'([A-Z_]+)'/g)) codes.add(m[1]);
    for (const m of src.matchAll(/\bBundleError\(\s*'([A-Z_]+)'/g)) codes.add(`BUNDLE_${m[1]}`);
    for (const m of src.matchAll(/\bcode: '([A-Z_]+)'/g)) codes.add(m[1]);
  }
  assert.ok(codes.size > 20, 'the codes were found in the code');
  for (const code of codes) if (!own.has(code)) assert.ok(`errors.${code}` in en, `no text for ${code}`);
});

test('translate fills placeholders, picks plural forms and falls back to English', () => {
  assert.strictEqual(i18n.translate('en', 'count.files', { count: 1 }), '1 file');
  assert.strictEqual(i18n.translate('en', 'count.files', { count: 1200 }), '1,200 files');
  assert.strictEqual(i18n.translate('tr', 'count.files', { count: 1200 }), '1.200 dosya');
  assert.strictEqual(i18n.translate('tr', 'main.tray.next', { time: '12:00' }), 'Sıradaki: 12:00');
  assert.strictEqual(i18n.translate('tr', 'no.such.text'), 'no.such.text');
  assert.strictEqual(i18n.translate('en', 'main.tray.next'), 'Next: {time}', 'a missing param stays visible');
});

test('the language is the one set, otherwise the first system language with a locale file, otherwise English', () => {
  assert.strictEqual(i18n.pickLanguage('tr', ['en-US']), 'tr');
  assert.strictEqual(i18n.pickLanguage(null, ['tr-TR', 'en-US']), 'tr');
  assert.strictEqual(i18n.pickLanguage(null, ['ja-JP', 'fr-CA']), 'fr');
  assert.strictEqual(i18n.pickLanguage('xx', ['ja-JP']), 'en');
});
