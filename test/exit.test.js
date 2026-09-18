const { test } = require('node:test');
const assert = require('node:assert/strict');
const { exitWarning, guardExit, nativeConfirm, installExitGuard } = require('../src/exit-guard');

test('exit warning includes staged, unstaged and not-yet-saved editor changes once', () => {
  const message = exitWarning({ repo: true, files: [{ path: 'a.md' }, { path: 'b.md' }], unsaved: ['b.md', 'c.md'] });
  assert.match(message, /3개/); assert.match(message, /디스크 저장/);
  assert.equal(message.split('b.md').length, 2);
  assert.equal(exitWarning({ repo: false, files: [], unsaved: [] }), '');
  assert.equal(exitWarning({ repo: true, files: [], unsaved: [] }), '');
});
test('exit cancel blocks closing, approve preserves the original close/reload operation', () => {
  for (const accepted of [false, true]) {
    const event = { prevented: false, preventDefault() { this.prevented = true; } };
    guardExit(event, { inspect: () => ({ repo: true, files: [{ path: 'a.md' }], unsaved: [] }), confirm: () => accepted });
    assert.equal(event.prevented, !accepted);
    assert.equal(event.returnValue, accepted ? undefined : false);
  }
});
test('busy Git operations and inspection errors prompt instead of silently closing', () => {
  for (const busy of [true, false]) {
    const event = { preventDefault() { this.prevented = true; } }; let message;
    guardExit(event, { busy, inspect: () => { throw new Error('git missing'); }, confirm: value => { message = value; return false; } });
    assert.match(message, busy ? /진행 중/ : /확인하지 못했습니다/);
    assert.equal(event.prevented, true);
  }
});

test('native confirm never blocks the exit when no synchronous dialog is available', () => {
  assert.equal(nativeConfirm({}, 'x'), true);
  const seen = [];
  const win = answer => ({ electronWindow: 'owner', electron: { remote: { dialog: { showMessageBoxSync: (owner, options) => { seen.push([owner, options.cancelId]); return answer; } } } } });
  assert.equal(nativeConfirm(win(0), 'x'), true);
  assert.equal(nativeConfirm(win(1), 'x'), false);
  assert.deepEqual(seen, [['owner', 1], ['owner', 1]]);
});

test('exit guard wraps the host hook: cancel keeps it armed, approval runs it once, uninstall restores it', () => {
  const calls = [];
  const win = { onbeforeunload() { calls.push('host'); win.onbeforeunload = null; } };
  const host = win.onbeforeunload;
  let block = true;
  const uninstall = installExitGuard(win, () => { calls.push('guard'); return block; });
  win.onbeforeunload({});
  assert.deepEqual(calls, ['guard'], 'A cancelled exit never fires the one-shot host quit hook');
  block = false;
  win.onbeforeunload({});
  assert.deepEqual(calls, ['guard', 'guard', 'host']);
  assert.equal(win.onbeforeunload, null, 'The host re-close after its quit tasks is not asked again');
  uninstall();
  assert.equal(win.onbeforeunload, null);
  const other = { onbeforeunload: host };
  installExitGuard(other, () => true)();
  assert.equal(other.onbeforeunload, host);
});
