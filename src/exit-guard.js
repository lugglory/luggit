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
  return !accepted;
}

// Chromium blocks window.confirm during beforeunload: it returns false without
// showing anything, which would keep the window open forever. Electron's native
// message box is synchronous and still works there. Without it, never block.
function nativeConfirm(win, message) {
  const remote = win.electron?.remote;
  if (!remote?.dialog?.showMessageBoxSync) return true;
  const options = { type: 'warning', title: 'Luggit', message, buttons: ['닫기', '취소'], defaultId: 1, cancelId: 1, noLink: true };
  const owner = win.electronWindow;
  return (owner ? remote.dialog.showMessageBoxSync(owner, options) : remote.dialog.showMessageBoxSync(options)) === 0;
}

// Obsidian's own onbeforeunload hook fires the one-shot 'quit' event and then
// disarms itself. Listeners cannot run ahead of it, so wrap it: a cancelled exit
// leaves the host hook armed, and an approved one is not asked again when the
// host re-closes the window after its quit tasks. Returns the uninstaller.
function installExitGuard(win, guard) {
  const host = win.onbeforeunload;
  let active = true;
  const wrapped = function (event) {
    if (active && guard(event)) return;
    return host?.call(this, event);
  };
  win.onbeforeunload = wrapped;
  return () => { active = false; if (win.onbeforeunload === wrapped) win.onbeforeunload = host; };
}
module.exports = { exitWarning, guardExit, nativeConfirm, installExitGuard };
