'use strict';
// The passwords of the backup sets, so scheduled backups run without asking. They are encrypted by the system before they
// are written: the app passes Electron's safeStorage (the Keychain on macOS, DPAPI on Windows), which only this user on
// this computer can undo. The file holds nothing readable, and a copy of it opens nothing elsewhere.
const fs = require('fs');
const path = require('path');
const { BackupError } = require('./errors');

const FILE = 'secrets.json';

// codec: { encrypt(string) -> Buffer, decrypt(Buffer) -> string, available() -> boolean }
function createSecrets(dataDir, codec) {
  const file = path.join(dataDir, FILE);
  const read = () => {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      return {};
    }
  };
  const write = (all) => {
    fs.mkdirSync(dataDir, { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(all, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, file);
  };
  return {
    available: () => codec.available(),
    has: (id) => Object.hasOwn(read(), id),
    // null when there is none; SECRET_UNREADABLE when the system would not decrypt it (the Keychain was refused).
    get(id) {
      const all = read();
      if (!Object.hasOwn(all, id)) return null;
      try {
        return codec.decrypt(Buffer.from(all[id], 'base64'));
      } catch (e) {
        throw new BackupError('SECRET_UNREADABLE', `The saved password could not be decrypted: ${e.message}`);
      }
    },
    set(id, secret) {
      if (!codec.available()) throw new BackupError('SECRET_STORE_UNAVAILABLE', 'This system cannot keep the password encrypted.');
      const all = read();
      all[id] = codec.encrypt(secret).toString('base64');
      write(all);
    },
    remove(id) {
      const all = read();
      if (!Object.hasOwn(all, id)) return;
      delete all[id];
      write(all);
    },
  };
}

module.exports = { createSecrets };
