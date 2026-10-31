// Interface texts. Each language is one file in app/locales, shared with the main process (app/i18n.js); a new file there
// is a new language. t('nav.home') gives the text in the current language, or the English one when it is missing.
// {name} placeholders are filled from params, numbers in the language's format. A text with plural forms
// ({ "one": ..., "other": ... }) is picked by params.count. A React element given as a param is put into the text, which
// is then returned as an element.
import React from 'react';

const files = import.meta.glob('../../locales/*.json', { eager: true, import: 'default' });
const LOCALES = Object.fromEntries(Object.entries(files).map(([file, data]) => [file.replace(/^.*\/|\.json$/g, ''), data]));
const FALLBACK = 'en';

export const LANGUAGES = Object.entries(LOCALES)
  .map(([code, data]) => ({ code, name: data.meta.name }))
  .sort((a, b) => a.name.localeCompare(b.name));

let current = FALLBACK;
export const language = () => current;
export function setLanguage(code) {
  current = LOCALES[code] ? code : FALLBACK;
  document.documentElement.lang = current;
}

const find = (code, key) => key.split('.').reduce((o, k) => (o && typeof o === 'object' ? o[k] : undefined), LOCALES[code]);
const lookup = (key) => find(current, key) ?? find(FALLBACK, key);
export const has = (key) => lookup(key) !== undefined;

export function t(key, params = {}) {
  let text = lookup(key);
  if (text === undefined) return key;
  if (typeof text === 'object') text = text[new Intl.PluralRules(current).select(Number(params.count) || 0)] ?? text.other;
  const parts = String(text).split(/\{(\w+)\}/);
  let rich = false;
  for (let i = 1; i < parts.length; i += 2) {
    const v = params[parts[i]];
    if (v === undefined || v === null) parts[i] = `{${parts[i]}}`;
    else if (typeof v === 'number') parts[i] = v.toLocaleString(current);
    else if (typeof v === 'object') {
      rich = true;
      parts[i] = v;
    } else parts[i] = String(v);
  }
  return rich ? React.createElement(React.Fragment, null, ...parts) : parts.join('');
}
