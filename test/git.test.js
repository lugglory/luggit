const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { GitService, parseStatus, parseStatusV2, parseStats } = require('../src/git-service');

async function repository(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'luggit-test-git-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const trashed = [];
  const git = new GitService(root, { trash: async name => { trashed.push(name); await fs.rename(path.join(root, name), path.join(root, name + '.trashed')); } });
  await git.init();
  await git.run(['config', 'user.name', 'Plugin Test']);
  await git.run(['config', 'user.email', 'plugin-test@example.invalid']);
  await git.run(['config', 'core.autocrlf', 'false']);
  return { git, root, trashed, write: (name, data) => fs.writeFile(path.join(root, name), data), read: name => fs.readFile(path.join(root, name), 'utf8') };
}
test('NUL parsers preserve unusual names and rename destination', () => {
  assert.deepEqual(parseStatus('R  new\nname.md\0old.md\0?? 한 글.md\0').map(file => [file.path, file.originalPath]), [['new\nname.md', 'old.md'], ['한 글.md', null]]);
  assert.deepEqual(parseStats('2\t3\t\0old.md\0new.md\0-\t-\tphoto.png\0'), [{ path: 'new.md', lines: 5 }, { path: 'photo.png', lines: 0 }]);
});
test('initial staging, unstage, automatic commit title and recent files', async t => {
  const repo = await repository(t);
  await repo.write('한 글.md', 'one\ntwo\n');
  await repo.git.stage('한 글.md');
  assert.equal((await repo.git.status()).files[0].staged, true);
  await repo.git.unstage();
  assert.equal((await repo.git.status()).files[0].index, '?');
  assert.equal(await repo.git.commit(''), '한 글.md');
  assert.deepEqual((await repo.git.status()).files, []);
  assert.deepEqual(await repo.git.recentFiles(), ['한 글.md']);
  assert.equal((await repo.git.run(['log', '-1', '--format=%s'])).trim(), '한 글.md');
});
test('literal pathspec stages only the requested wildcard filename', async t => {
  const repo = await repository(t);
  await repo.write('[a].md', 'a'); await repo.write('a.md', 'b');
  await repo.git.stage('[a].md');
  const files = (await repo.git.status()).files;
  assert.equal(files.find(file => file.path === '[a].md').staged, true);
  assert.equal(files.find(file => file.path === 'a.md').staged, false);
  await assert.rejects(repo.git.stage('../outside'), /보관함 안/);
});

test('recent files retain committed deletions and files no longer present on disk', async t => {
  const repo = await repository(t);
  await repo.write('deleted.md', 'recorded content\n'); await repo.write('missing.md', 'still in Git\n');
  await repo.git.commit('initial');
  await fs.unlink(path.join(repo.root, 'deleted.md')); await repo.git.commit('delete note');
  await fs.unlink(path.join(repo.root, 'missing.md'));
  assert.deepEqual(await repo.git.recentFiles(), ['deleted.md', 'missing.md']);
  const result = await repo.git.recentDiff('deleted.md');
  assert.equal(result.commit, (await repo.git.run(['rev-parse', 'HEAD'])).trim());
  assert.match(result.diff, /-recorded content/);
});

test('recent diff uses the latest commit for the exact filename, independent of HEAD and working edits', async t => {
  const repo = await repository(t);
  await repo.write('[a].md', 'original\n'); await repo.write('a.md', 'unrelated\n');
  await repo.git.commit('initial');
  assert.match((await repo.git.recentDiff('[a].md')).diff, /\+original/);
  await repo.write('[a].md', 'updated\n'); await repo.git.commit('update exact filename');
  const expected = (await repo.git.run(['rev-parse', 'HEAD'])).trim();
  await repo.write('a.md', 'unrelated new\n'); await repo.git.commit('unrelated commit');
  await repo.write('[a].md', 'unsaved to Git\n');
  const result = await repo.git.recentDiff('[a].md');
  assert.equal(result.commit, expected);
  assert.match(result.diff, /-original/); assert.match(result.diff, /\+updated/);
  assert.doesNotMatch(result.diff, /unrelated|unsaved to Git/);
  await assert.rejects(repo.git.recentDiff('no-history.md'), /커밋 기록/);
});
test('rename unstage restores both index paths', async t => {
  const repo = await repository(t);
  await repo.write('before.md', 'original\n'); await repo.git.commit('initial');
  await fs.rename(path.join(repo.root, 'before.md'), path.join(repo.root, 'after.md'));
  await repo.git.stage();
  assert.equal((await repo.git.status()).files[0].index, 'R');
  await repo.git.unstage('after.md');
  assert.equal((await repo.git.status()).files.some(file => file.staged), false);
});
test('discard restores index content and untracked files go through trash', async t => {
  const repo = await repository(t);
  await repo.write('note.md', 'base'); await repo.git.commit('initial');
  await repo.write('note.md', 'staged'); await repo.git.stage();
  await repo.write('note.md', 'working');
  await repo.git.discard('note.md');
  assert.equal(await repo.read('note.md'), 'staged');
  await repo.write('new.md', 'keep in trash'); await repo.git.discard('new.md');
  assert.deepEqual(repo.trashed, ['new.md']);
  assert.equal(await repo.read('new.md.trashed'), 'keep in trash');
});
test('diff includes additions, cached changes, and binary placeholder', async t => {
  const repo = await repository(t);
  await repo.write('new.md', 'hello\n');
  assert.match(await repo.git.diff('new.md', false), /^\+hello/);
  await repo.git.stage('new.md');
  assert.match(await repo.git.diff('new.md', true), /\+hello/);
  await repo.write('binary.bin', Buffer.from([0, 1, 2]));
  assert.match(await repo.git.diff('binary.bin', false), /바이너리/);
});
test('vault within a parent repository is rejected', async t => {
  const repo = await repository(t);
  const child = path.join(repo.root, 'child'); await fs.mkdir(child);
  await assert.rejects(new GitService(child).status(), /상위 폴더/);
  await assert.rejects(new GitService(child).init(), /상위 폴더/);
});
test('push configures a missing upstream and counts waiting commits', async t => {
  const repo = await repository(t);
  const remote = await fs.mkdtemp(path.join(os.tmpdir(), 'luggit-test-remote-'));
  t.after(() => fs.rm(remote, { recursive: true, force: true }));
  await repo.git.run(['init', '--bare', remote]);
  await repo.git.run(['remote', 'add', 'origin', remote]);
  await repo.write('note.md', 'base'); await repo.git.commit('initial');
  assert.equal((await repo.git.status()).ahead, 1);
  await repo.git.push();
  assert.equal((await repo.git.status()).ahead, 0);
  await repo.write('note.md', 'dirty');
  await assert.rejects(repo.git.pull(), /Pull 전에/);
});
test('unstage failure with a HEAD never falls back to removing the index', async t => {
  const repo = await repository(t);
  await repo.write('note.md', 'base'); await repo.git.commit('initial');
  await repo.write('note.md', 'new'); await repo.git.stage();
  await fs.writeFile(path.join(repo.root, '.git/index.lock'), 'locked');
  await assert.rejects(repo.git.unstage(), /index.lock/);
  assert.equal((await repo.git.status()).files[0].staged, true);
});
test('exit push sends existing commits and never stages or commits working changes', async t => {
  const repo = await repository(t);
  const remote = await fs.mkdtemp(path.join(os.tmpdir(), 'luggit-exit-remote-'));
  t.after(() => fs.rm(remote, { recursive: true, force: true }));
  await repo.git.run(['init', '--bare', remote]); await repo.git.run(['remote', 'add', 'origin', remote]);
  await repo.write('note.md', 'committed'); await repo.git.commit('initial');
  await repo.write('note.md', 'working');
  assert.equal(await repo.git.pushOnExit(), true);
  assert.equal((await repo.git.status()).ahead, 0);
  assert.equal((await repo.git.status()).files[0].unstaged, true);
  assert.equal((await repo.git.run(['rev-list', '--count', 'HEAD'])).trim(), '1');
});

test('watching .git and the config folder reports what Obsidian never does', async t => {
  const repo = await repository(t);
  await repo.write('note.md', 'one\n'); await repo.git.commit('initial');
  await fs.mkdir(path.join(repo.root, '.obsidian/plugins/sample'), { recursive: true });
  let changes = 0;
  const stop = repo.git.watch(() => changes++);
  t.after(stop);
  await new Promise(resolve => setTimeout(resolve, 200));
  await repo.git.status();
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(changes, 0, 'A background status refresh does not retrigger itself');
  await repo.git.run(['commit', '--allow-empty', '-m', 'outside']);
  for (let i = 0; i < 40 && !changes; i++) await new Promise(resolve => setTimeout(resolve, 50));
  assert.ok(changes > 0);
  await new Promise(resolve => setTimeout(resolve, 300));
  changes = 0;
  await repo.write('.obsidian/workspace.json', '{}');
  await repo.write('ordinary note.md', 'Obsidian reports this one itself');
  await new Promise(resolve => setTimeout(resolve, 500));
  assert.equal(changes, 0, 'The constantly rewritten workspace layout and ordinary vault files are not watched');
  await repo.write('.obsidian/plugins/sample/main.js', 'changed');
  for (let i = 0; i < 40 && !changes; i++) await new Promise(resolve => setTimeout(resolve, 50));
  assert.ok(changes > 0, 'Hidden configuration that Obsidian never reports is detected');
});

test('porcelain v2 parser matches the v1 file shape and reads untranslated branch headers', async t => {
  const parsed = parseStatusV2('# branch.oid abc\0# branch.head main\0# branch.upstream origin/main\0# branch.ab +3 -1\0' +
    '1 .M N... 100644 100644 100644 a b 한 글 노트.md\0002 R. N... 100644 100644 100644 a b R100 new name.md\0old name.md\0' +
    'u UU N... 100644 100644 100644 100644 a b c conflict.md\0? new file.md\0');
  assert.deepEqual(parsed.branch, { head: true, name: 'main', upstream: 'origin/main', ahead: 3 });
  assert.deepEqual(parsed.files.map(file => [file.path, file.originalPath, file.index, file.work, file.staged, file.unstaged]), [
    ['한 글 노트.md', null, ' ', 'M', false, true], ['new name.md', 'old name.md', 'R', ' ', true, false],
    ['conflict.md', null, 'U', 'U', true, true], ['new file.md', null, '?', '?', false, true]]);
  assert.deepEqual(parseStatusV2('# branch.oid (initial)\0# branch.head main\0').branch, { head: false, name: 'main', upstream: '', ahead: null });
  const repo = await repository(t);
  await repo.write('a b.md', 'one\n'); await repo.write('staged.md', 'x'); await repo.git.stage('staged.md');
  const legacy = parseStatus(await repo.git.run(['status', '--porcelain=v1', '-z', '--untracked-files=all']));
  const sort = files => files.slice().sort((a, b) => a.path.localeCompare(b.path));
  assert.deepEqual(sort((await repo.git.status()).files), sort(legacy));
  assert.equal((await repo.git.status()).head, false);
});
