'use strict';
// The recovery code: a second key to a backup, for the day its password is forgotten. 120 random bits in Crockford's
// base32, which has no I, L, O or U, so a code copied from paper is not misread: six groups of four characters.
const crypto = require('crypto');

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const LENGTH = 24;

const group = (s) => s.match(/.{4}/g).join('-');

function newRecoveryCode() {
  let out = '';
  let value = 0;
  let bits = 0;
  for (const byte of crypto.randomBytes((LENGTH * 5) / 8)) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += ALPHABET[(value >>> bits) & 31];
    }
    value &= (1 << bits) - 1;
  }
  return group(out);
}

// A code as the user typed it: any case, with or without dashes or spaces, O for 0 and I or L for 1. null when it cannot
// be a recovery code.
function normalizeRecoveryCode(input) {
  const s = String(input || '').toUpperCase().replace(/[\s_-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
  if (s.length !== LENGTH || [...s].some((c) => !ALPHABET.includes(c))) return null;
  return group(s);
}

module.exports = { newRecoveryCode, normalizeRecoveryCode };
