'use strict';

function exitWarning(status) {
  if (!status.repo) return '';
  const paths = [...new Set([...status.files.map(file => file.path), ...status.unsaved])];
  if (!paths.length) return '';
  const list = paths.slice(0, 8).join('\n') + (paths.length > 8 ? `\n외 ${paths.length - 8}개` : '');
  return `커밋하지 않은 변경사항이 ${paths.length}개 있습니다.\n\n${list}\n\n` +
    (status.unsaved.length ? '아직 디스크 저장이 확인되지 않은 편집 내용도 있습니다.\n\n' : '') +
    '커밋하지 않고 계속 닫을까요?\n취소를 누르면 돌아가서 커밋할 수 있습니다.';
}

function guardExit(event, { busy, inspect, confirm, report }) {
  let message;
  try { message = busy ? 'Git 작업이 진행 중입니다. 지금 닫으면 작업이 중단될 수 있습니다. 계속 닫을까요?' : exitWarning(inspect()); }
  catch (error) { message = `종료 전 Git 상태를 확인하지 못했습니다.\n${error.message}\n\n확인하지 않고 계속 닫을까요?`; }
  if (!message) return;
  let accepted = false;
  try { accepted = confirm(message); } catch (error) { report(error); }
  if (!accepted) { event.preventDefault(); event.returnValue = false; }
}
module.exports = { exitWarning, guardExit };
