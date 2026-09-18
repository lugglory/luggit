const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ExitPushState } = require('../src/exit-state');

function storage() {
  const entries = new Map();
  return { getItem: key => entries.get(key) ?? null, setItem: (key, value) => entries.set(key, value), removeItem: key => entries.delete(key) };
}

test('exit warning survives reload locally and stays isolated by vault and configuration directory', () => {
  const local = storage(), state = new ExitPushState(local, 'vault-a');
  state.write('offline');
  assert.equal(new ExitPushState(local, 'vault-a').read(), 'offline');
  assert.equal(new ExitPushState(local, 'vault-b').read(), '');
  assert.equal(new ExitPushState(local, 'vault-a', '.obsidian-work').read(), '');
  state.write('');
  assert.equal(new ExitPushState(local, 'vault-a').read(), '');
});
