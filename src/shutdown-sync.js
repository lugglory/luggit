'use strict';

// 종료 후에는 이미 만든 커밋만 전송한다. 파일 저장/스테이지/커밋은 하지 않는다.
async function pushOnExit(git, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  const run = args => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error('종료 시 Push 시간이 초과되었습니다');
    return git(args, { timeout: remaining, windowsHide: true,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never',
        GIT_SSH_COMMAND: (process.env.GIT_SSH_COMMAND || 'ssh') + ' -oBatchMode=yes -oConnectTimeout=5' } });
  };
  if (!(await run(['remote'])).trim()) return false;
  const head = await run(['rev-parse', '--verify', '--quiet', 'HEAD']).catch(() => '');
  if (!head.trim()) return false;
  const upstream = (await run(['rev-parse', '--symbolic-full-name', '@{upstream}']).catch(() => '')).trim();
  const count = Number((await run(upstream ? ['rev-list', '--count', upstream + '..HEAD'] : ['rev-list', '--count', 'HEAD', '--not', '--remotes'])).trim());
  if (!count) return false;
  try { await run(['push']); }
  catch (error) {
    if (!/no upstream|has no upstream|set-upstream/i.test(error.message)) throw error;
    const branch = (await run(['symbolic-ref', '--short', 'HEAD'])).trim();
    const remotes = (await run(['remote'])).trim().split('\n').filter(Boolean);
    const remote = remotes.includes('origin') ? 'origin' : remotes.length === 1 ? remotes[0] : null;
    if (!remote) throw new Error('원격 저장소와 upstream을 먼저 설정해 주세요.');
    await run(['push', '-u', remote, branch]);
  }
  return true;
}

module.exports = { pushOnExit };
