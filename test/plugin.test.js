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
  result.render = () => {}; result.refresh = async () => {}; result.refreshId = 0;
  result.saveOpenViews = async () => {}; result.app = { vault: { configDir: '.obsidian' } };
  result.saveData = async () => { throw new Error('Git operations must not write plugin settings'); };
  return { plugin: result, notices };
}

test('overlapping Git actions are ignored while a command is running', async () => {
  const { plugin: p } = plugin(); let release, calls = 0;
  const running = p.perform('first', () => new Promise(resolve => { release = resolve; }));
  await new Promise(resolve => setImmediate(resolve));
  await p.perform('second', async () => { calls++; });
  release(); await running;
  assert.equal(calls, 0);
});

test('background refresh stays local and never runs Pull', async () => {
  const { plugin: p } = plugin();
  p.git = { status: async () => ({ repo: true, files: [] }), recentFiles: async () => [], watch: () => null,
    run() { assert.fail('background refresh must not query remotes'); }, pull() { assert.fail('background refresh must not pull'); } };
  await Object.getPrototypeOf(p).refresh.call(p);
  assert.equal(p.snapshot.repo, true);
});

test('resolution saves editors before applying through the vault and reports backup location', async () => {
  const { plugin: p, notices } = plugin();
  const events = [], file = { path: 'note.md' };
  let content = 'before';
  p.saveOpenViews = async () => events.push('save');
  p.app.vault.getFileByPath = () => file;
  p.app.vault.process = async (target, callback) => {
    assert.equal(target, file); content = callback(content); events.push('write');
  };
  p.conflicts = { resolve: async (preview, apply, write) => {
    assert.equal(apply, true); assert.equal(preview.name, 'note.md');
    await write('before', 'both sides'); return 'vault/.git/luggit-backups/example';
  } };
  await p.resolveConflict({ name: 'note.md' }, true);
  assert.deepEqual(events, ['save', 'write']); assert.equal(content, 'both sides');
  assert.ok(notices.some(message => message.includes('luggit-backups/example')));
});

test('vault edits made after saving cannot be overwritten by the preview', async () => {
  const { plugin: p, notices } = plugin();
  let content = 'new editing';
  p.app.vault.getFileByPath = () => ({ path: 'note.md' });
  p.app.vault.process = async (_file, callback) => { content = callback(content); };
  p.conflicts = { resolve: async (_preview, _apply, write) => write('before', 'both sides') };
  await p.resolveConflict({ name: 'note.md' }, true);
  assert.equal(content, 'new editing'); assert.equal(p.busy, false);
  assert.ok(notices.some(message => message.includes('문서가 변경되었습니다')));
});
