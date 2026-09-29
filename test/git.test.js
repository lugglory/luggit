const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { GitService, parseStatus, parseStatusV2 } = require('../src/git-service');

async function repository(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'luggit-test-git-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const git = new GitService(root);
  await git.run(['init']);
  await git.run(['config', 'user.name', 'Plugin Test']);
  await git.run(['config', 'user.email', 'plugin-test@example.invalid']);
  await git.run(['config', 'core.autocrlf', 'false']);
  return { git, root, commit: async message => { await git.run(['add', '-A']); await git.run(['commit', '-m', message]); }, stage: name => git.run(['--literal-pathspecs', 'add', '--', name || '.']), write: (name, data) => fs.writeFile(path.join(root, name), data), read: name => fs.readFile(path.join(root, name), 'utf8') };
}
test('NUL parsers preserve unusual names and rename destination', () => {
  assert.deepEqual(parseStatus('R  new\nname.md\0old.md\0?? 한 글.md\0').map(file => [file.path, file.originalPath]), [['new\nname.md', 'old.md'], ['한 글.md', null]]);
});
test('recent files retain committed deletions and files no longer present on disk', async t => {
  const repo = await repository(t);
  await repo.write('deleted.md', 'recorded content\n'); await repo.write('missing.md', 'still in Git\n');
  await repo.commit('initial');
  await fs.unlink(path.join(repo.root, 'deleted.md')); await repo.commit('delete note');
  await fs.unlink(path.join(repo.root, 'missing.md'));
  assert.deepEqual(await repo.git.recentFiles(), ['deleted.md', 'missing.md']);
  const result = await repo.git.recentDiff('deleted.md');
  assert.equal(result.commit, (await repo.git.run(['rev-parse', 'HEAD'])).trim());
  assert.match(result.diff, /-recorded content/);
});

test('recent diff uses the latest commit for the exact filename, independent of HEAD and working edits', async t => {
  const repo = await repository(t);
  await repo.write('[a].md', 'original\n'); await repo.write('a.md', 'unrelated\n');
  await repo.commit('initial');
  assert.match((await repo.git.recentDiff('[a].md')).diff, /\+original/);
  await repo.write('[a].md', 'updated\n'); await repo.commit('update exact filename');
  const expected = (await repo.git.run(['rev-parse', 'HEAD'])).trim();
  await repo.write('a.md', 'unrelated new\n'); await repo.commit('unrelated commit');
  await repo.write('[a].md', 'unsaved to Git\n');
  const result = await repo.git.recentDiff('[a].md');
  assert.equal(result.commit, expected);
  assert.match(result.diff, /-original/); assert.match(result.diff, /\+updated/);
  assert.doesNotMatch(result.diff, /unrelated|unsaved to Git/);
  await assert.rejects(repo.git.recentDiff('no-history.md'), /커밋 기록/);
});
test('diff includes additions, cached changes, and binary placeholder', async t => {
  const repo = await repository(t);
  await repo.write('new.md', 'hello\n');
  assert.match(await repo.git.diff('new.md', false), /^\+hello/);
  await repo.stage('new.md');
  assert.match(await repo.git.diff('new.md', true), /\+hello/);
  await repo.write('binary.bin', Buffer.from([0, 1, 2]));
  assert.match(await repo.git.diff('binary.bin', false), /바이너리/);
});
test('vault within a parent repository is rejected', async t => {
  const repo = await repository(t);
  const child = path.join(repo.root, 'child'); await fs.mkdir(child);
  await assert.rejects(new GitService(child).status(), /상위 폴더/);
});
test('watching .git and the config folder reports what Obsidian never does', async t => {
  const repo = await repository(t);
  await repo.write('note.md', 'one\n'); await repo.commit('initial');
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
  await repo.write('a b.md', 'one\n'); await repo.write('staged.md', 'x'); await repo.stage('staged.md');
  const legacy = parseStatus(await repo.git.run(['status', '--porcelain=v1', '-z', '--untracked-files=all']));
  const sort = files => files.slice().sort((a, b) => a.path.localeCompare(b.path));
  assert.deepEqual(sort((await repo.git.status()).files), sort(legacy));
  assert.equal((await repo.git.status()).head, false);
});
