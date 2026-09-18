const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseDiff, copyableDiff } = require('../src/diff');
test('new-file metadata stays out of diff rows and addition counts', () => {
  const diff = parseDiff('diff --git a/new.md b/new.md\nnew file mode 100644\nindex 000..123\n--- /dev/null\n+++ b/new.md\n@@ -0,0 +1,2 @@\n+# 제목\n+본문\n');
  assert.equal(diff.added, 2); assert.equal(diff.removed, 0);
  assert.deepEqual(diff.rows.filter(row => row.type === 'added').map(row => [row.old, row.current, row.text]), [['', 1, '# 제목'], ['', 2, '본문']]);
  assert.equal(JSON.stringify(diff.rows).includes('/dev/null'), false);
});
test('changed hunks keep line numbers and real content that resembles metadata', () => {
  const diff = parseDiff('--- a/a.md\n+++ b/a.md\n@@ -4,2 +4,2 @@\n context\n-old\n+--- /dev/null\n');
  assert.equal(diff.added, 1); assert.equal(diff.removed, 1);
  assert.equal(diff.rows.at(-1).text, '--- /dev/null');
  assert.equal(diff.rows.at(-1).current, 5); assert.equal(diff.rows.at(-2).old, 5);
});
test('untracked, binary, empty and truncated diffs have meaningful output', () => {
  assert.equal(parseDiff('+one\n+two').added, 2);
  assert.match(parseDiff('Binary files a/a and b/a differ').message, /바이너리/);
  assert.match(parseDiff('(빈 새 파일)').message, /내용이 없는 새 파일/);
  const truncated = parseDiff('+one\n+two', 1);
  assert.equal(truncated.rows.length, 1); assert.equal(truncated.added, 2); assert.equal(truncated.truncated, true);
});

test('copy preserves change signs and content without file metadata or preview truncation', () => {
  assert.equal(copyableDiff('--- a/a.md\n+++ b/a.md\n@@ -1,2 +1,2 @@\n context\n-old\n+new\n'), '이전 1행 → 현재 1행\n context\n-old\n+new');
  const large = Array.from({ length: 3100 }, (_, index) => '+' + index).join('\n');
  assert.equal(copyableDiff(large), large);
  assert.match(copyableDiff('Binary files a/a and b/a differ'), /바이너리/);
});
