const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { GitService } = require('../src/git-service');
const { ConflictService, preserveBoth, decode } = require('../src/conflicts');

async function conflict(t, { name = 'note.md', base = 'before\nbase\nafter\n', ours = 'before\nours\nafter\n', theirs = 'before\ntheirs\nafter\n' } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'luggit-conflict-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const git = new GitService(root);
  const write = data => data === null ? fs.unlink(path.join(root, name)) : fs.writeFile(path.join(root, name), data);
  const read = () => fs.readFile(path.join(root, name));
  await git.run(['init', '-b', 'main']);
  await git.run(['config', 'user.name', 'Test']);
  await git.run(['config', 'user.email', 'test@example.invalid']);
  await git.run(['config', 'core.autocrlf', 'false']);
  await git.run(['config', 'merge.conflictStyle', 'diff3']);
  const commit = async message => { await git.run(['add', '-A']); await git.run(['commit', '-m', message]); };
  await write(base); await commit('base');
  await git.run(['checkout', '-b', 'other']); await write(theirs); await commit('theirs');
  await git.run(['checkout', 'main']); await write(ours); await commit('ours');
  await assert.rejects(git.run(['merge', 'other']));
  const service = new ConflictService(git);
  return { root, git, service, write, read, preview: () => service.preview(name),
    apply: async (before, after) => { assert.equal((await read()).toString(), before); await write(after); } };
}

test('union preserves both sides, duplicates, EOLs, surrounding edits and missing final newline', () => {
  const input = '\uFEFFoutside\r\n<<<<<<< HEAD\r\na\r\nsame\r\n||||||| base\r\nold\r\n=======\r\nb\r\nsame\r\n>>>>>>> other\r\nlast';
  assert.deepEqual(preserveBoth(input), { text: '\uFEFFoutside\r\na\r\nsame\r\nb\r\nsame\r\nlast', count: 1 });
  assert.equal(decode(Buffer.from('\uFEFFnote')), '\uFEFFnote');
  assert.equal(decode(Buffer.from([0xff])), null);
  assert.equal(preserveBoth('<<<<<<< a\none\n=======\ntwo\n>>>>>>> b\n<<<<<<< a\nx\n=======\ny\n>>>>>>> b\n').count, 2);
});

test('malformed, nested and mismatched markers are rejected', () => {
  for (const text of ['<<<<<<< a\none', '<<<<<<< a\n<<<<<<< nested\n', '<<<<<<< a\na\n========\nb\n>>>>>>> b\n', '=======\n']) {
    assert.throws(() => preserveBoth(text), /충돌 표식/);
  }
});

test('real merge backs up every version and resolves only the selected file without committing', async t => {
  const repo = await conflict(t, { name: '[a] 한글.md' });
  await fs.writeFile(path.join(repo.root, 'other.md'), 'already staged');
  await repo.git.run(['add', 'other.md']);
  const head = await repo.git.run(['rev-parse', 'HEAD']);
  const staged = await repo.git.run(['rev-parse', ':other.md']);
  const preview = await repo.preview();
  assert.equal((await repo.git.status()).files.find(f => f.path === preview.name).conflicted, true);
  assert.equal(preview.result, 'before\nours\ntheirs\nafter\n');
  const backup = await repo.service.resolve(preview, true, repo.apply);
  for (const [label, bytes] of Object.entries({ ...preview.versions, working: preview.current })) {
    assert.deepEqual(await fs.readFile(path.join(backup, label + '.blob')), bytes);
  }
  assert.equal(JSON.parse(await fs.readFile(path.join(backup, 'metadata.json'))).path, preview.name);
  assert.equal(await repo.service.entries(preview.name), '');
  assert.equal(await repo.git.run(['rev-parse', ':other.md']), staged);
  assert.equal(await repo.git.run(['rev-parse', 'HEAD']), head);
  assert.equal((await repo.read()).toString(), preview.result);
  assert.equal((await repo.git.status()).files.some(f => f.path.includes('luggit-backups')), false);
});

test('changed working copy and changed index invalidate a preview', async t => {
  const repo = await conflict(t);
  const preview = await repo.preview();
  await repo.write('new editing');
  await assert.rejects(repo.service.resolve(preview, true, repo.apply), /변경되었습니다/);
  assert.equal((await repo.read()).toString(), 'new editing');
  await repo.write(preview.current);
  await repo.git.run(['add', 'note.md']);
  await assert.rejects(repo.service.resolve(preview, true, repo.apply), /변경되었습니다/);
});

test('another Git lock prevents applying or backing up and is never removed', async t => {
  const repo = await conflict(t);
  const preview = await repo.preview();
  const lock = path.join(repo.root, '.git/index.lock');
  await fs.writeFile(lock, 'other operation');
  await assert.rejects(repo.service.resolve(preview, true, repo.apply), /다른 Git 작업/);
  assert.equal(await fs.readFile(lock, 'utf8'), 'other operation');
  assert.deepEqual(await repo.read(), preview.current);
});

test('a failed writer leaves index unresolved and provides recoverable backups', async t => {
  const repo = await conflict(t);
  const preview = await repo.preview();
  await assert.rejects(repo.service.resolve(preview, true, async () => { throw new Error('editor changed'); }), /editor changed[\s\S]*원본 백업/);
  assert.equal(await repo.service.entries(preview.name), preview.entries);
  assert.deepEqual(await repo.read(), preview.current);
  await assert.rejects(fs.stat(path.join(repo.root, '.git/index.lock')), { code: 'ENOENT' });
});

test('binary alternatives are separately preserved without rewriting or staging', async t => {
  const repo = await conflict(t, { name: 'image.bin', base: Buffer.from([0, 1]), ours: Buffer.from([0, 2]), theirs: Buffer.from([0, 3]) });
  const preview = await repo.preview();
  assert.equal(preview.result, null);
  const backup = await repo.service.resolve(preview, false);
  assert.deepEqual(await fs.readFile(path.join(backup, 'ours.blob')), Buffer.from([0, 2]));
  assert.deepEqual(await fs.readFile(path.join(backup, 'theirs.blob')), Buffer.from([0, 3]));
  assert.equal(await repo.service.entries(preview.name), preview.entries);
  await assert.rejects(repo.service.resolve(preview, true, repo.apply), /직접 검토/);
});

test('YAML conflicts are backup-only and no duplicate keys are auto-written', async t => {
  const repo = await conflict(t, { base: '---\ntitle: base\n---\nbody\n', ours: '---\ntitle: ours\n---\nbody\n', theirs: '---\ntitle: theirs\n---\nbody\n' });
  const preview = await repo.preview();
  assert.equal(preview.result, null); assert.match(preview.reason, /YAML/);
  await repo.service.resolve(preview, false);
  assert.deepEqual(await repo.read(), preview.current);
});

test('removed markers do not silently choose one of two different originals', async t => {
  const repo = await conflict(t);
  await repo.write('manually edited');
  const preview = await repo.preview();
  assert.equal(preview.result, null); assert.match(preview.reason, /표식이 없습니다/);
});

test('path traversal is refused before reading a conflict', async t => {
  const repo = await conflict(t);
  await assert.rejects(repo.service.preview('../outside.md'), /보관함 안/);
  await assert.rejects(repo.service.preview('.git/config'), /보관함 안/);
});

test('an add failure retains the real conflict index and all backups', async t => {
  const repo = await conflict(t);
  const preview = await repo.preview();
  const run = repo.git.run.bind(repo.git);
  repo.git.run = (args, options) => args.includes('add') ? Promise.reject(new Error('add failed')) : run(args, options);
  await assert.rejects(repo.service.resolve(preview, true, repo.apply), /add failed[\s\S]*원본 백업/);
  assert.equal(await repo.service.entries(preview.name), preview.entries);
  assert.equal((await repo.read()).toString(), preview.result);
  const backups = await fs.readdir(path.join(repo.root, '.git/luggit-backups'));
  assert.deepEqual(await fs.readFile(path.join(repo.root, '.git/luggit-backups', backups[0], 'working.blob')), preview.current);
});

test('a second apply of the same preview cannot restage or overwrite a resolved note', async t => {
  const repo = await conflict(t);
  const preview = await repo.preview();
  await repo.service.resolve(preview, true, repo.apply);
  await repo.write('next editing session');
  await assert.rejects(repo.service.resolve(preview, true, repo.apply), /변경되었습니다/);
  assert.equal((await repo.read()).toString(), 'next editing session');
});

test('YAML at the start of a whole-file conflict is not concatenated', async t => {
  const repo = await conflict(t, { base: 'plain\n', ours: '---\ntitle: ours\n---\nbody\n', theirs: '---\ntitle: theirs\n---\nbody\n' });
  const preview = await repo.preview();
  assert.equal(preview.result, null); assert.match(preview.reason, /YAML/);
});

test('body conflicts below unchanged YAML can be preserved', async t => {
  const repo = await conflict(t, { base: '---\ntitle: note\n---\nbase\n', ours: '---\ntitle: note\n---\nours\n', theirs: '---\ntitle: note\n---\ntheirs\n' });
  assert.equal((await repo.preview()).result, '---\ntitle: note\n---\nours\ntheirs\n');
});

test('a missing working file offers backup only, with its absence recorded', async t => {
  const repo = await conflict(t);
  await fs.unlink(path.join(repo.root, 'note.md'));
  const preview = await repo.preview();
  assert.equal(preview.current, null); assert.equal(preview.result, null);
  const backup = await repo.service.resolve(preview, false);
  assert.equal(JSON.parse(await fs.readFile(path.join(backup, 'metadata.json'))).files.working, null);
  assert.equal(await repo.service.entries(preview.name), preview.entries);
});

test('buffer-mode Git errors retain a readable error message', async t => {
  const repo = await conflict(t);
  await assert.rejects(repo.git.run(['cat-file', 'blob', 'nonexistent-object'], { encoding: 'buffer' }), /fatal/);
});

test('modify/delete resolution keeps the surviving note and records the missing alternative', async t => {
  const repo = await conflict(t, { theirs: null });
  const preview = await repo.preview();
  assert.equal(preview.result, 'before\nours\nafter\n');
  const backup = await repo.service.resolve(preview, true, repo.apply);
  assert.equal(JSON.parse(await fs.readFile(path.join(backup, 'metadata.json'))).files.theirs, null);
  assert.equal(await repo.service.entries(preview.name), '');
  assert.equal((await repo.read()).toString(), preview.result);
});
