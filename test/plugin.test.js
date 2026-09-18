const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function plugin() {
  const notices = [];
  const obsidian = { Plugin: class {}, ItemView: class {}, MarkdownView: class {}, TextFileView: class {}, Modal: class {}, PluginSettingTab: class {},
    Notice: class { constructor(message) { notices.push(message); } hide() {} } };
  const filename = path.join(__dirname, '../src/main.js');
  const load = filename => {
    const output = { exports: {} };
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { module: output,
      require: name => name === 'obsidian' ? obsidian : name.startsWith('.') ? load(require.resolve(path.resolve(path.dirname(filename), name))) : require(name),
    }, { filename });
    return output.exports;
  };
  const Plugin = load(filename);
  const result = new Plugin();
  result.render = () => {}; result.refresh = async () => {}; result.draft = 'title'; result.refreshId = 0;
  result.saveOpenViews = async () => {}; result.app = { vault: { configDir: '.obsidian' } };
  result.exitState = { message: '', write(message) { this.message = message; } };
  result.saveData = async () => { throw new Error('Git operations must not write plugin settings'); };
  return { plugin: result, notices };
}

test('exit push marks pending locally, stores failure, and clears on successful retry', async () => {
  const { plugin: p } = plugin();
  p.git = { status: async () => ({ repo: true, ahead: 1 }), pushOnExit: async () => {
    assert.match(p.exitState.message, /완료/);
    throw new Error('offline');
  } };
  await p.pushOnExit();
  assert.equal(p.exitState.message, 'offline');
  assert.equal(p.exitPushError, 'offline');
  p.git.push = async () => {};
  await p.push();
  assert.equal(p.exitState.message, '');
  assert.equal(p.exitPushError, '');
});

test('successful exit push clears local state without writing settings', async () => {
  const { plugin: p } = plugin();
  p.git = { status: async () => ({ repo: true, ahead: 1 }), pushOnExit: async () => {} };
  await p.pushOnExit();
  assert.equal(p.exitState.message, '');
  assert.equal(p.exitPushError, '');
});

test('local storage failure does not prevent pushing commits', async () => {
  const { plugin: p, notices } = plugin(); let pushed = false;
  p.exitState.write = () => { throw new Error('storage unavailable'); };
  p.git = { status: async () => ({ repo: true, ahead: 1 }), pushOnExit: async () => { pushed = true; } };
  await p.pushOnExit();
  assert.equal(pushed, true);
  assert.equal(p.exitPushError, '');
  assert.match(notices.at(-1), /로컬에 저장하지 못했습니다/);
});
test('combined action commits once before pushing and clears the message', async () => {
  const { plugin: p } = plugin(), events = [];
  p.git = { commit: async message => events.push('commit:' + message), push: async () => events.push('push') };
  await p.commit(true);
  assert.deepEqual(events, ['commit:title', 'push']);
  assert.equal(p.draft, '');
});
test('push failure reports successful commit and allows a standalone retry', async () => {
  const { plugin: p, notices } = plugin(), events = [];
  p.git = { commit: async () => events.push('commit'), push: async () => { events.push('push'); throw new Error('offline'); } };
  await p.commit(true);
  assert.match(notices.at(-1), /커밋은 완료됐지만 Push에 실패/);
  assert.equal(p.draft, '');
  assert.equal(p.busy, false);
  p.git.push = async () => events.push('retry push');
  await p.perform('Push', () => p.git.push());
  assert.deepEqual(events, ['commit', 'push', 'retry push']);
});
test('commit/save failure never pushes and preserves draft', async () => {
  for (const failure of ['commit', 'save']) {
    const { plugin: p } = plugin(); let pushes = 0;
    p.git = { commit: async () => { throw new Error('commit failed'); }, push: async () => pushes++ };
    if (failure === 'save') p.saveOpenViews = async () => { throw new Error('save failed'); };
    await p.commit(true);
    assert.equal(pushes, 0); assert.equal(p.draft, 'title'); assert.equal(p.busy, false);
  }
});
test('overlapping Git actions are ignored while a command is running', async () => {
  const { plugin: p } = plugin(); let release, calls = 0;
  const running = p.perform('first', () => new Promise(resolve => { release = resolve; }));
  await new Promise(resolve => setImmediate(resolve));
  await p.perform('second', async () => { calls++; });
  release(); await running;
  assert.equal(calls, 0);
});

test('manual refresh saves editors, pulls from the remote, then updates the local panel', async () => {
  const { plugin: p } = plugin(), events = [];
  p.saveOpenViews = async () => events.push('save');
  p.refresh = async () => events.push('local refresh');
  p.git = { status: async () => ({ repo: true }), run: async () => 'origin\n', pull: async () => events.push('pull') };
  await p.pullFromRemote();
  assert.deepEqual(events, ['save', 'pull', 'local refresh']);
});

test('manual refresh without a repository or remote still updates the panel without pulling', async () => {
  for (const repo of [true, false]) {
    const { plugin: p } = plugin(); let refreshes = 0;
    p.refresh = async () => refreshes++;
    p.git = { status: async () => ({ repo }), run: async () => '', pull() { assert.fail('must not pull without a remote'); } };
    await p.pullFromRemote();
    assert.equal(refreshes, 1);
  }
});

test('failed manual Pull reports the error and still refreshes the local panel', async () => {
  const { plugin: p, notices } = plugin(); let refreshes = 0;
  p.refresh = async () => refreshes++;
  p.git = { status: async () => ({ repo: true }), run: async () => 'origin\n', pull: async () => { throw new Error('Pull 전에 변경사항을 커밋하거나 정리해 주세요.'); } };
  await p.pullFromRemote();
  assert.equal(refreshes, 1); assert.equal(p.busy, false);
  assert.match(notices.at(-1), /Pull 전에/);
});

test('background refresh stays local and never runs Pull', async () => {
  const { plugin: p } = plugin();
  p.git = { status: async () => ({ repo: true, files: [] }), recentFiles: async () => [], watch: () => null,
    run() { assert.fail('background refresh must not query remotes'); }, pull() { assert.fail('background refresh must not pull'); } };
  await Object.getPrototypeOf(p).refresh.call(p);
  assert.equal(p.snapshot.repo, true);
});

test('a stale exit push marker is cleared silently when nothing is waiting to be pushed', async () => {
  const { plugin: p, notices } = plugin();
  p.exitPushError = 'Push 완료를 확인하지 못했습니다.';
  p.git = { status: async () => ({ repo: true, ahead: 0 }) };
  await p.reportExitPush();
  assert.deepEqual(notices, []); assert.equal(p.exitPushError, ''); assert.equal(p.exitState.message, '');
  p.exitPushError = 'offline';
  p.git = { status: async () => ({ repo: true, ahead: 2 }) };
  await p.reportExitPush();
  assert.match(notices[0], /지난 종료 Push: offline/); assert.equal(p.exitPushError, 'offline');
});
