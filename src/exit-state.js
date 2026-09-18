'use strict';

// Runtime state belongs to this device, not to the vault's tracked plugin settings.
// Include the vault and configuration directory so separate vaults/profiles do not mix.
class ExitPushState {
  constructor(storage, vaultPath, configDir = '.obsidian') {
    this.storage = storage;
    this.key = 'luggit:exit-push:' + JSON.stringify([vaultPath, configDir]);
  }
  read() { return this.storage.getItem(this.key) || ''; }
  write(message) {
    if (message) this.storage.setItem(this.key, message);
    else this.storage.removeItem(this.key);
  }
}

module.exports = { ExitPushState };
