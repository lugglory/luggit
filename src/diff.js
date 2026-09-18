'use strict';

function parseDiff(text, limit = 3000) {
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  const allAdded = lines.length > 0 && lines.every(line => line.startsWith('+'));
  const rows = [];
  let oldLine = 0, newLine = 1, inHunk = allAdded, added = 0, removed = 0, total = 0;
  const append = row => { total++; if (rows.length < limit) rows.push(row); };
  for (const line of lines) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      oldLine = Number(hunk[1]); newLine = Number(hunk[2]); inHunk = true;
      append({ type: 'hunk', text: `${oldLine ? '이전 ' + oldLine + '행' : '새 문서'} → ${newLine ? '현재 ' + newLine + '행' : '삭제'}` });
    } else if (line.startsWith('diff --git ')) inHunk = false;
    else if (inHunk && /^[ +\-]/.test(line)) {
      const isAdded = line[0] === '+', isRemoved = line[0] === '-';
      if (isAdded) added++; if (isRemoved) removed++;
      append({ type: isAdded ? 'added' : isRemoved ? 'removed' : 'context', old: isAdded ? '' : oldLine++, current: isRemoved ? '' : newLine++, sign: line[0], text: line.slice(1) });
    } else if (inHunk && line.startsWith('\\')) append({ type: 'hunk', text: '파일 끝에 줄바꿈 없음' });
  }
  let message = '';
  if (!rows.length) {
    if (/Binary files|GIT binary patch|바이너리/.test(text)) message = '바이너리 파일이 변경되었습니다. 텍스트로 비교할 수 없습니다.';
    else if (/2MB보다 큰/.test(text)) message = '새 파일이 2MB보다 커서 미리보기를 생략했습니다.';
    else if (/빈 새 파일|new file mode/.test(text)) message = '내용이 없는 새 파일입니다.';
    else if (/deleted file mode/.test(text)) message = '내용이 없는 파일이 삭제되었습니다.';
    else if (/심볼릭 링크/.test(text)) message = '심볼릭 링크가 추가되었습니다.';
    else if (text.trim()) message = '파일 이름이나 속성이 변경되었습니다. 본문 변경은 없습니다.';
    else message = '본문 변경이 없습니다.';
  }
  return { rows, added, removed, message, truncated: total > rows.length, limit };
}
function copyableDiff(text) {
  const diff = parseDiff(text, Infinity);
  return diff.rows.length ? diff.rows.map(row => row.type === 'hunk' ? row.text : row.sign + row.text).join('\n') : diff.message;
}

module.exports = { parseDiff, copyableDiff };
