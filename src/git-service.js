'use strict';
const { execFile } = require('node:child_process');
const fs = require('node:fs/promises');
const syncFs = require('node:fs');
const path = require('node:path');
const { pushOnExit } = require('./shutdown-sync');

function parseStatus(output) {
  const records = output.split('\0'), files = [];
  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    if (!record) continue;
    const index = record[0], work = record[1];
    const originalPath = /[RC]/.test(index + work) ? records[++i] : null;
    files.push({ path: record.slice(3), originalPath, index, work,
      staged: index !== ' ' && index !== '?', unstaged: work !== ' ' || index === '?' });
  }
  return files;
}

// Porcelain v2 with --branch answers "which files, which branch, how far ahead" in one
// process, and unlike the v1 branch line its headers are never translated.
function parseStatusV2(output) {
  const records = output.split('\0'), files = [], branch = { head: true, name: '', upstream: '', ahead: null };
  const entry = (xy, path, originalPath = null) => {
    const index = xy[0] === '.' ? ' ' : xy[0], work = xy[1] === '.' ? ' ' : xy[1];
    files.push({ path, originalPath, index, work, staged: index !== ' ' && index !== '?', unstaged: work !== ' ' || index === '?' });
  };
  // Paths may contain spaces, so only the fixed number of leading fields is split off.
  const pathAfter = (record, fields) => record.split(' ').slice(fields).join(' ');
  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    if (record.startsWith('# branch.oid ')) branch.head = record.slice(13) !== '(initial)';
    else if (record.startsWith('# branch.head ')) branch.name = record.slice(14) === '(detached)' ? 'HEAD' : record.slice(14);
    else if (record.startsWith('# branch.upstream ')) branch.upstream = record.slice(18);
    else if (record.startsWith('# branch.ab ')) branch.ahead = Number(/^\+(\d+)/.exec(record.slice(12))?.[1]) || 0;
    else if (record.startsWith('1 ')) entry(record.slice(2, 4), pathAfter(record, 8));
    else if (record.startsWith('2 ')) entry(record.slice(2, 4), pathAfter(record, 9), records[++i]);
    else if (record.startsWith('u ')) entry(record.slice(2, 4), pathAfter(record, 10));
    else if (record.startsWith('? ')) entry('??', record.slice(2));
  }
  return { files, branch };
}

function parseStats(output) {
  const records = output.split('\0'), stats = [];
  for (let i = 0; i < records.length; i++) {
    const match = /^(\S+)\t(\S+)\t(.*)$/s.exec(records[i]);
    if (!match) continue;
    let name = match[3];
    if (!name) { name = records[i + 2]; i += 2; }
    if (name) stats.push({ path: name, lines: (Number(match[1]) || 0) + (Number(match[2]) || 0) });
  }
  return stats;
}

class GitService {
  constructor(root, { executable = 'git', trash } = {}) {
    this.root = path.resolve(root);
    this.executable = executable;
    this.trash = trash;
  }
  run(args, options = {}) {
    return new Promise((resolve, reject) => {
      execFile(this.executable, ['-c', 'core.quotepath=false', ...args], {
        cwd: this.root, windowsHide: true, timeout: 120000,
        maxBuffer: 16 * 1024 * 1024, encoding: 'utf8',
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never' },
        ...options,
      }, (error, stdout, stderr) => {
        if (error) { error.message = (stderr || error.message).trim(); reject(error); }
        else resolve(stdout);
      });
    });
  }
  // Obsidian reports changes to ordinary vault files itself, including edits made
  // outside the app. It never reports its hidden configuration folder or Git
  // commands run elsewhere, which only touch .git, so watch just those two folders.
  // Returns a closer, or null when nothing can be watched.
  watch(onChange, configDir = '.obsidian') {
    // libuv aborts the whole process when a Windows 8.3 short path (USERNA~1) is
    // watched, so always resolve to the long path first.
    let root;
    try { root = syncFs.realpathSync.native(this.root); } catch { return null; }
    // Object writes always come with an index or ref change. The workspace layout is
    // rewritten on every tab switch and is ignored in practically every vault.
    const ignored = name => /^\.git\/objects(\/|$)|\.lock$/.test(name) ||
      (name.startsWith(configDir + '/') && /^workspace(-mobile)?\.json$/.test(name.slice(configDir.length + 1)));
    const watchers = [];
    for (const folder of ['.git', configDir]) {
      const listener = (type, name) => {
        const changed = folder + '/' + String(name || '').replace(/\\/g, '/');
        if (ignored(changed)) return;
        if (type !== 'change') { onChange(); return; }
        // Merely listing a folder, as git status does, makes Windows report a change
        // to the folder itself. Only file content counts.
        syncFs.stat(path.join(root, changed), (error, stats) => { if (error || !stats.isDirectory()) onChange(); });
      };
      try { watchers.push(syncFs.watch(path.join(root, folder), { recursive: true }, listener)); }
      catch {
        // No recursive watching on this platform, or the folder is missing.
        try { watchers.push(syncFs.watch(path.join(root, folder), listener)); } catch { /* Missing folder. */ }
      }
    }
    if (!watchers.length) return null;
    for (const watcher of watchers) watcher.on('error', () => watcher.close());
    return () => { for (const watcher of watchers) watcher.close(); };
  }
  async pushOnExit() {
    if (!(await this.isRepo())) return false;
    return pushOnExit((args, options) => this.run(args, options));
  }
  async isRepo() {
    let root;
    try { root = (await this.run(['rev-parse', '--show-toplevel'])).trim(); }
    catch (error) {
      if (/not a git repository/i.test(error.message)) return false;
      throw error;
    }
    const actual = await fs.realpath(root), expected = await fs.realpath(this.root);
    const same = process.platform === 'win32' ? actual.toLowerCase() === expected.toLowerCase() : actual === expected;
    if (!same) throw new Error('보관함 상위 폴더의 저장소는 사용할 수 없습니다. 보관함 루트에 Git 저장소를 만들어 주세요.');
    return true;
  }
  async requireRepo() { if (!(await this.isRepo())) throw new Error('Git 저장소를 먼저 초기화해 주세요.'); }
  validatePath(name) {
    if (!name || name.includes('\0') || name.includes('\\') || path.isAbsolute(name) || name.split('/').some(p => p === '..' || p.toLowerCase() === '.git')) {
      throw new Error('보관함 안의 파일 경로만 사용할 수 있습니다.');
    }
    return name;
  }
  async hasHead() {
    try { await this.run(['rev-parse', '--verify', '--quiet', 'HEAD']); return true; }
    catch (error) { if (error.code === 1) return false; throw error; }
  }
  async status() {
    if (!(await this.isRepo())) return { repo: false, files: [], branch: '', ahead: 0 };
    // Background refreshes must not rewrite .git/index, or the folder watcher would retrigger them.
    const { files, branch } = parseStatusV2(await this.run(['--no-optional-locks', 'status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all']));
    let ahead = branch.ahead ?? 0;
    // Without a usable upstream, count the commits that no remote has yet.
    if (branch.ahead === null && branch.head && (await this.run(['remote'])).trim()) {
      ahead = Number(await this.run(['rev-list', '--count', 'HEAD', '--not', '--remotes'])) || 0;
    }
    return { repo: true, files, branch: branch.head ? branch.name : '(커밋 없음)', ahead, head: branch.head };
  }
  async init() {
    // Refuse inherited repositories here as well.
    if (!(await this.isRepo())) await this.run(['init']);
  }
  async stage(name = '.') {
    await this.requireRepo();
    await this.run(['--literal-pathspecs', 'add', '-A', '--', this.validatePath(name)]);
  }
  async unstage(name = '.') {
    await this.requireRepo(); this.validatePath(name);
    const files = parseStatus(await this.run(['status', '--porcelain=v1', '-z', '--untracked-files=no']));
    const renamed = files.find(file => file.path === name && file.index === 'R');
    const paths = renamed?.originalPath ? [name, renamed.originalPath] : [name];
    if (await this.hasHead()) await this.run(['--literal-pathspecs', 'reset', '-q', 'HEAD', '--', ...paths]);
    else await this.run(['--literal-pathspecs', 'rm', '--cached', '-r', '-q', '--', ...paths]);
  }
  async diff(name, staged) {
    await this.requireRepo(); this.validatePath(name);
    const output = await this.run(['--literal-pathspecs', 'diff', '--no-ext-diff', '--no-textconv', '--no-color', ...(staged ? ['--cached'] : []), '--', name]);
    if (output || staged) return output;
    const files = parseStatus(await this.run(['status', '--porcelain=v1', '-z', '--untracked-files=all']));
    if (!files.some(file => file.path === name && file.index === '?')) return '';
    const absolute = path.join(this.root, name);
    if ((await fs.lstat(absolute)).isSymbolicLink()) return '(심볼릭 링크)';
    const real = await fs.realpath(absolute);
    const relative = path.relative(await fs.realpath(this.root), real);
    if (relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw new Error('보관함 밖의 파일은 읽을 수 없습니다.');
    if ((await fs.stat(real)).size > 2 * 1024 * 1024) return '(2MB보다 큰 새 파일: 미리보기 생략)';
    const content = await fs.readFile(real);
    if (content.includes(0)) return '(바이너리 파일)';
    if (!content.length) return '(빈 새 파일)';
    const lines = content.toString('utf8').split('\n');
    if (lines.at(-1) === '') lines.pop();
    return lines.map(line => '+' + line).join('\n');
  }
  async discard(name) {
    await this.requireRepo(); this.validatePath(name);
    const files = parseStatus(await this.run(['status', '--porcelain=v1', '-z', '--untracked-files=all']));
    const file = files.find(item => item.path === name);
    if (!file?.unstaged) return;
    if (file.index === 'U' || file.work === 'U' || ['AA', 'DD'].includes(file.index + file.work)) throw new Error('충돌 파일은 외부 Git 도구에서 해결해 주세요.');
    if (file.index === '?') {
      if (!this.trash) throw new Error('휴지통을 사용할 수 없습니다.');
      await this.trash(name);
    } else {
      await this.run(['--literal-pathspecs', 'checkout', '--', name]);
    }
  }
  async commit(message) {
    await this.requireRepo();
    let stats = parseStats(await this.run(['diff', '--cached', '--numstat', '-z']));
    if (!stats.length) { await this.stage(); stats = parseStats(await this.run(['diff', '--cached', '--numstat', '-z'])); }
    if (!stats.length) throw new Error('커밋할 변경이 없습니다.');
    stats.sort((a, b) => b.lines - a.lines || a.path.localeCompare(b.path));
    const title = message.trim() || stats[0].path.split('/').pop() + (stats.length > 1 ? ' 등' : '');
    await this.run(['commit', '-m', title]);
    return title;
  }
  // Pass the head flag of a status() result to skip repeating its repository checks.
  async recentFiles(head) {
    if (head === undefined) { await this.requireRepo(); head = await this.hasHead(); }
    if (!head) return [];
    const output = await this.run(['log', '--first-parent', '-n', '30', '--format=', '--name-only', '-z', '--no-renames', '--diff-filter=AMDT']);
    const recent = [];
    for (const name of new Set(output.split('\0').filter(Boolean))) {
      this.validatePath(name);
      recent.push(name);
      if (recent.length === 30) break;
    }
    return recent;
  }
  async recentDiff(name) {
    await this.requireRepo(); this.validatePath(name);
    const commit = (await this.run(['--literal-pathspecs', 'log', '--first-parent', '-1', '--format=%H', '--', name])).trim();
    if (!commit) throw new Error('이 파일의 커밋 기록을 찾을 수 없습니다. 목록을 새로고침해 주세요.');
    const diff = await this.run(['--literal-pathspecs', 'show', '--format=', '--first-parent', '--patch',
      '--no-renames', '--no-ext-diff', '--no-textconv', '--no-color', commit, '--', name]);
    return { commit, diff };
  }
  async pull() {
    await this.requireRepo();
    if ((await this.status()).files.length) throw new Error('Pull 전에 변경사항을 커밋하거나 정리해 주세요.');
    return this.run(['pull', '--ff-only']);
  }
  async push() {
    await this.requireRepo();
    try { return await this.run(['push']); }
    catch (error) {
      if (!/no upstream|has no upstream|set-upstream/i.test(error.message)) throw error;
      const branch = (await this.run(['symbolic-ref', '--short', 'HEAD'])).trim();
      const remotes = (await this.run(['remote'])).trim().split('\n').filter(Boolean);
      const remote = remotes.includes('origin') ? 'origin' : remotes.length === 1 ? remotes[0] : null;
      if (!remote) throw new Error('원격 저장소와 upstream을 먼저 설정해 주세요.');
      return this.run(['push', '--set-upstream', remote, branch]);
    }
  }
}
module.exports = { GitService, parseStatus, parseStatusV2, parseStats };
