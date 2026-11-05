'use strict';
// Errors by code. The window says each one in the user's language (errors.<CODE> in app/locales); the message stays
// English, for the log and for the command line.
class BackupError extends Error {
  constructor(code, message, extra) {
    super(message);
    this.code = code;
    if (extra) Object.assign(this, extra);
  }
}

module.exports = { BackupError };
