'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { TextDecoder } = require('node:util');

// Keep every non-marker byte of both alternatives, including whitespace and EOLs.
// diff3's ancestor is historical content, saved separately in the backup.
function preserveBoth(text) {
  const lines = text.match(/[^\n]*\n|[^\n]+$/g) || [];
  let state = 'outside', width = 0, count = 0, result = '';
  for (const line of lines) {
    const marker = /^(<{7,}|\|{7,}|={7,}|>{7,})(?:[ \r\n]|$)/.exec(line);
    if (!marker) { if (state !== 'base') result += line; continue; }
    const kind = marker[1][0];
    if (kind === '<' && state === 'outside') { width = marker[1].length; state = 'ours'; count++; }
    else if (marker[1].length !== width) throw new Error('충돌 표식의 길이가 다릅니다. 직접 검토해 주세요.');
    else if (kind === '|' && state === 'ours') state = 'base';
    else if (kind === '=' && (state === 'ours' || state === 'base')) state = 'theirs';
    else if (kind === '>' && state === 'theirs') state = 'outside';
    else throw new Error('충돌 표식이 불완전하거나 중첩되어 있습니다. 직접 검토해 주세요.');
  }
  if (state !== 'outside') throw new Error('충돌 표식이 닫히지 않았습니다. 직접 검토해 주세요.');
  return { text: result, count };
}

function decode(bytes) {
  if (bytes === null || bytes.includes(0)) return null;
  try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { return null; }
}

class ConflictService {
  constructor(git) { this.git = git; }
  async safePath(name, missing = false) {
    this.git.validatePath(name);
    const root = await fs.realpath(this.git.root);
    let current = root;
    const parts = name.split('/');
    for (let i = 0; i < parts.length; i++) {
      current = path.join(current, parts[i]);
      let stat;
      try { stat = await fs.lstat(current); }
      catch (error) { if (missing && error.code === 'ENOENT') return null; throw error; }
      if (stat.isSymbolicLink() || (i < parts.length - 1 ? !stat.isDirectory() : !stat.isFile())) {
        throw new Error('심볼릭 링크나 디렉터리 충돌은 외부 Git 도구에서 검토해 주세요.');
      }
    }
    return current;
  }
  async gitDirectory() {
    // Keep backups and temporary indexes within this vault. Linked worktrees are
    // intentionally not written because their Git directory may be elsewhere.
    const directory = path.join(this.git.root, '.git');
    const stat = await fs.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('이 저장소의 충돌 해결은 외부 Git 도구에서 진행해 주세요.');
    return directory;
  }
  async entries(name) {
    return this.git.run(['--literal-pathspecs', 'ls-files', '--unmerged', '-z', '--', name]);
  }
  async preview(name) {
    await this.git.requireRepo(); this.git.validatePath(name);
    await this.gitDirectory();
    const entries = await this.entries(name);
    if (!entries) throw new Error('이미 해결되었거나 충돌 파일이 아닙니다.');
    const versions = {};
    let regular = true;
    for (const entry of entries.split('\0').filter(Boolean)) {
      const match = /^(\d+) ([0-9a-f]+) ([123])\t/.exec(entry);
      if (!match) throw new Error('충돌 정보를 읽지 못했습니다.');
      regular &&= /^100(644|755)$/.test(match[1]);
      if (regular) versions[{ 1: 'base', 2: 'ours', 3: 'theirs' }[match[3]]] = await this.git.run(['cat-file', 'blob', match[2]], { encoding: 'buffer' });
    }
    if (!regular) throw new Error('심볼릭 링크나 서브모듈 충돌은 외부 Git 도구에서 검토해 주세요.');
    const filename = await this.safePath(name, true);
    const current = filename ? await fs.readFile(filename) : null;
    let result = null, reason = '', count = 0;
    const text = decode(current);
    if (!/\.(md|txt|markdown)$/i.test(name) || text === null || Object.values(versions).some(bytes => decode(bytes) === null)) {
      reason = '첨부파일·삭제 충돌·UTF-8이 아닌 파일은 자동 병합하지 않습니다. 원본을 백업한 뒤 외부 도구에서 검토해 주세요.';
    } else {
      try {
        const merged = preserveBoth(text);
        const frontmatter = /^\uFEFF?---\r?\n[\s\S]*?(?:\r?\n(?:---|\.\.\.)(?:\r?\n|$)|$)/.exec(text)?.[0];
        const startsWithFrontmatterConflict = /^\uFEFF?<{7,}/.test(text) &&
          Object.values(versions).some(bytes => /^\uFEFF?---\r?\n/.test(decode(bytes)));
        if (startsWithFrontmatterConflict || (frontmatter && /^(<{7,}|\|{7,}|={7,}|>{7,})/m.test(frontmatter))) {
          reason = 'YAML 속성 안의 충돌은 자동 병합하지 않습니다. 원본을 백업한 뒤 외부 도구에서 속성을 검토하고 해결해 주세요.';
        } else if (!merged.count && versions.ours && versions.theirs && !versions.ours.equals(versions.theirs)) {
          reason = '양쪽 원본이 다른데 충돌 표식이 없습니다. 원본을 백업한 뒤 외부 도구에서 해결해 주세요.';
        } else { result = merged.text; count = merged.count; }
      } catch (error) { reason = error.message; }
    }
    return { name, entries, versions, current, result, reason, count };
  }
  async unchanged(preview) {
    const filename = await this.safePath(preview.name, true);
    const current = filename ? await fs.readFile(filename) : null;
    if (await this.entries(preview.name) !== preview.entries ||
      (current === null ? preview.current !== null : preview.current === null || !current.equals(preview.current))) {
      throw new Error('미리보기 후 파일 또는 Git 상태가 변경되었습니다. 다시 확인해 주세요.');
    }
  }
  async backup(preview, directory) {
    const base = path.join(directory, 'luggit-backups');
    await fs.mkdir(base, { recursive: true });
    if ((await fs.lstat(base)).isSymbolicLink()) throw new Error('백업 폴더에 심볼릭 링크를 사용할 수 없습니다.');
    const destination = await fs.mkdtemp(path.join(base, 'conflict-'));
    const versions = { ...preview.versions, working: preview.current };
    for (const [label, bytes] of Object.entries(versions)) {
      if (bytes !== null) await fs.writeFile(path.join(destination, label + '.blob'), bytes, { flag: 'wx' });
    }
    await fs.writeFile(path.join(destination, 'metadata.json'), JSON.stringify({
      path: preview.name, created: new Date().toISOString(), entries: preview.entries,
      files: Object.fromEntries(['base', 'ours', 'theirs', 'working'].map(label => [label, versions[label] == null ? null : label + '.blob'])),
    }, null, 2), { flag: 'wx' });
    return destination;
  }
  async resolve(preview, apply, write) {
    await this.git.requireRepo();
    const directory = await this.gitDirectory();
    if (apply && preview.result === null) throw new Error('이 충돌은 원본 백업 후 직접 검토해야 합니다.');
    // Hold Git's standard index lock across validation, backup, file update and
    // staging. Build a separate index so other staged files remain byte-for-byte
    // represented, and a failed add never leaves a partially updated real index.
    const lockPath = path.join(directory, 'index.lock');
    const lock = await fs.open(lockPath, 'wx').catch(error => {
      if (error.code === 'EEXIST') throw new Error('다른 Git 작업이 진행 중입니다. 잠시 후 다시 시도해 주세요.');
      throw error;
    });
    const temporaryIndex = path.join(directory, 'luggit-index-' + randomUUID());
    let backup, ownsLock = true;
    try {
      await this.unchanged(preview);
      backup = await this.backup(preview, directory);
      if (!apply) return backup;
      if ((await fs.lstat(path.join(directory, 'index'))).isSymbolicLink()) throw new Error('인덱스에 심볼릭 링크를 사용할 수 없습니다.');
      await fs.copyFile(path.join(directory, 'index'), temporaryIndex);
      await this.unchanged(preview);
      await write(decode(preview.current), preview.result);
      const currentPath = await this.safePath(preview.name);
      if (!(await fs.readFile(currentPath)).equals(Buffer.from(preview.result))) throw new Error('병합 중 파일이 변경되어 해결 처리를 중단했습니다.');
      await this.git.run(['--literal-pathspecs', 'add', '--', preview.name], {
        env: { ...process.env, GIT_INDEX_FILE: temporaryIndex, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never' },
      });
      if (!(await fs.readFile(await this.safePath(preview.name))).equals(Buffer.from(preview.result))) throw new Error('병합 중 파일이 변경되어 해결 처리를 중단했습니다.');
      await lock.close();
      await fs.copyFile(temporaryIndex, lockPath);
      await fs.rename(lockPath, path.join(directory, 'index'));
      ownsLock = false;
      return backup;
    } catch (error) {
      if (backup) error.message += '\n원본 백업: ' + backup + '\n파일 내용과 충돌 상태를 다시 확인해 주세요.';
      throw error;
    } finally {
      await lock.close().catch(() => {});
      if (ownsLock) await fs.unlink(lockPath).catch(() => {});
      await fs.unlink(temporaryIndex).catch(() => {});
      await fs.unlink(temporaryIndex + '.lock').catch(() => {});
    }
  }
}
module.exports = { ConflictService, preserveBoth, decode };
