'use strict';
// Texts of the main process (tray menu, notifications, dialogs). The window has the same lookup in
// app/renderer/src/i18n.js; both read the locale files in app/locales, one per language.
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, 'locales');
const FALLBACK = 'en';
const LANGUAGES = fs.readdirSync(DIR).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -'.json'.length));
const loaded = new Map();

function locale(code) {
  if (!loaded.has(code)) loaded.set(code, JSON.parse(fs.readFileSync(path.join(DIR, `${code}.json`), 'utf8')));
  return loaded.get(code);
}

// The language set in Settings, otherwise the first of the system's languages that has a locale file, otherwise English.
function pickLanguage(setting, preferred = []) {
  if (setting && LANGUAGES.includes(setting)) return setting;
  for (const tag of preferred) {
    const code = String(tag).toLowerCase().split(/[-_]/)[0];
    if (LANGUAGES.includes(code)) return code;
  }
  return FALLBACK;
}

const find = (code, key) => key.split('.').reduce((o, k) => (o && typeof o === 'object' ? o[k] : undefined), locale(code));
const has = (code, key) => (find(code, key) ?? find(FALLBACK, key)) !== undefined;

function translate(code, key, params = {}) {
  let text = find(code, key) ?? find(FALLBACK, key);
  if (text === undefined) return key;
  if (typeof text === 'object') text = text[new Intl.PluralRules(code).select(Number(params.count) || 0)] ?? text.other;
  return String(text).replace(/\{(\w+)\}/g, (m, name) => {
    const v = params[name];
    if (v === undefined || v === null) return m;
    return typeof v === 'number' ? v.toLocaleString(code) : String(v);
  });
}

module.exports = { DIR, LANGUAGES, FALLBACK, pickLanguage, has, translate };
