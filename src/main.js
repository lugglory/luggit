'use strict';
const { Plugin, ItemView, TextFileView, Modal, Notice, PluginSettingTab, Setting, FileSystemAdapter, addIcon, setIcon, setTooltip } = require('obsidian');
const { GitService } = require('./git-service');
const { ConflictService } = require('./conflicts');
const { ConflictModal } = require('./conflict-modal');
const { parseDiff, copyableDiff } = require('./diff');
const VIEW = 'luggit-changes';
const GIT_ICON = 'luggit-logo';
let sectionSequence = 0;

function registerIcons() {
  /*! Git logomark by Jason Long, CC BY 3.0. https://git-scm.com/community/logos
   * Official SVG geometry; only scaled from 78 to 100 units and recolored for the host theme.
   * https://creativecommons.org/licenses/by/3.0/ */
  addIcon(GIT_ICON, '<g transform="scale(1.282051282051282)"><path fill="currentColor" stroke="none" transform="translate(10 10) rotate(-45 29 29)" d="M5,58c-2.76142,0 -5,-2.23858 -5,-5v-48c0,-2.76142 2.23858,-5 5,-5h33v12.54404c-2.06553,0.94801 -3.5,3.03446 -3.5,5.45596c0,0.73514 0.13221,1.43941 0.37415,2.09031l-15.28384,15.28384c-0.6509,-0.24194 -1.35517,-0.37415 -2.09031,-0.37415c-3.31371,0 -6,2.68629 -6,6c0,3.31371 2.68629,6 6,6c3.31371,0 6,-2.68629 6,-6c0,-0.73514 -0.13221,-1.43941 -0.37415,-2.09031l14.87415,-14.87415l0,11.50851c-2.06553,0.94801 -3.5,3.03446 -3.5,5.45596c0,3.31371 2.68629,6 6,6c3.31371,0 6,-2.68629 6,-6c0,-2.42149 -1.43447,-4.50795 -3.5,-5.45596l0,-12.08808c2.06553,-0.94801 3.5,-3.03446 3.5,-5.45596c0,-2.42149 -1.43447,-4.50795 -3.5,-5.45596l0,-12.54404h10c2.76142,0 5,2.23858 5,5v48c0,2.76142 -2.23858,5 -5,5z"/></g>');
}

const fileName = path => path.split('/').pop();

function iconButton(parent, icons, label, action) {
  const button = parent.createEl('button', { cls: 'luggit-icon', attr: { type: 'button', 'aria-label': label } });
  setTooltip(button, label, { placement: 'bottom' });
  for (const icon of icons) setIcon(button.createSpan({ attr: { 'aria-hidden': 'true' } }), icon);
  button.onclick = event => { event.stopPropagation(); action(); };
  return button;
}

class DiffModal extends Modal {
  constructor(app, name, diff, staged, openFile, contextLabel) { super(app); this.name = name; this.diff = diff; this.staged = staged; this.openFile = openFile; this.contextLabel = contextLabel; }
  onOpen() {
    this.setTitle(this.name);
    this.titleEl.empty();
    this.titleEl.createSpan({ text: this.name, cls: 'luggit-diff-title-text' });
    if (this.openFile) {
      this.titleEl.addClass('luggit-diff-title');
      this.titleEl.setAttribute('role', 'button');
      this.titleEl.setAttribute('tabindex', '0');
      this.titleEl.setAttribute('aria-label', this.name + ' 편집기로 열기');
      setTooltip(this.titleEl, this.name + ' · 편집기로 열기');
      const open = event => { event.preventDefault(); event.stopPropagation(); this.close(); this.openFile(); };
      this.titleEl.onkeydown = event => {
        if ((event.key === 'Enter' || event.key === ' ') && !event.repeat && !event.isComposing &&
          !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey) open(event);
      };
      // The whole window opens the file, except buttons, scrollbars, and the end of a drag selection.
      this.modalEl.addClass('is-openable');
      this.modalEl.onclick = event => {
        const target = event.target;
        if (event.button !== 0 || target.closest('button')) return;
        if (target.classList.contains('luggit-diff-scroll') && (event.offsetX >= target.clientWidth || event.offsetY >= target.clientHeight)) return;
        const selection = target.ownerDocument.getSelection();
        if (selection && !selection.isCollapsed && this.modalEl.contains(selection.anchorNode)) return;
        open(event);
      };
    }
    this.modalEl.addClass('luggit-diff-modal');
    const diff = parseDiff(this.diff);
    const summary = this.contentEl.createDiv({ cls: 'luggit-diff-summary' });
    summary.createSpan({ text: this.contextLabel || (this.staged ? '스테이지된 변경' : '작업 중인 변경'), cls: 'luggit-diff-label' });
    summary.createSpan({ text: `+${diff.added} 추가`, cls: 'luggit-diff-added' });
    summary.createSpan({ text: `−${diff.removed} 삭제`, cls: 'luggit-diff-removed' });
    if (diff.rows.length) {
      const scroll = this.contentEl.createDiv({ cls: 'luggit-diff-scroll', attr: { tabindex: '0', 'aria-label': '변경 전후 내용' } });
      const table = scroll.createEl('table', { cls: 'luggit-diff-table' });
      const header = table.createEl('thead').createEl('tr');
      for (const label of ['이전', '현재', '', '변경 내용']) header.createEl('th', { text: label, attr: { scope: 'col' } });
      const body = table.createEl('tbody');
      for (const row of diff.rows) {
        const tr = body.createEl('tr', { cls: 'is-' + row.type });
        if (row.type === 'hunk') tr.createEl('td', { text: row.text, attr: { colspan: '4' } });
        else {
          tr.createEl('td', { text: String(row.old), cls: 'luggit-diff-number' });
          tr.createEl('td', { text: String(row.current), cls: 'luggit-diff-number' });
          tr.createEl('td', { text: row.sign, cls: 'luggit-diff-sign' });
          tr.createEl('td', { text: row.text || ' ', cls: 'luggit-diff-code' });
        }
      }
    } else this.contentEl.createDiv({ text: diff.message, cls: 'luggit-diff-empty' });
    if (diff.truncated) {
      this.contentEl.createEl('p', { text: `내용이 길어 처음 ${diff.limit.toLocaleString()}줄만 표시합니다.`, cls: 'luggit-muted' });
    }
    const actions = this.contentEl.createDiv({ cls: 'luggit-diff-actions', attr: { role: 'group', 'aria-label': '비교 문서 작업' } });
    iconButton(actions, ['copy'], '제목 복사 (경로 포함)', () => this.copy(this.name));
    iconButton(actions, ['clipboard-list'], '변경 내용 복사', () => this.copy(copyableDiff(this.diff)));
  }
  async copy(text) {
    try {
      await this.contentEl.ownerDocument.defaultView.navigator.clipboard.writeText(text);
      new Notice('복사했습니다.', 1500);
    } catch (error) { new Notice('복사하지 못했습니다: ' + error.message, 6000); }
  }
  onClose() { this.contentEl.empty(); }
}

class GitView extends ItemView {
  constructor(leaf, plugin) { super(leaf); this.plugin = plugin; this.collapsedSections = new Set(); }
  getViewType() { return VIEW; }
  getDisplayText() { return 'Git 변경사항'; }
  getIcon() { return GIT_ICON; }
  async onOpen() {
    this.contentEl.empty(); this.contentEl.addClass('luggit');
    this.empty = this.contentEl.createDiv();
    this.empty.createEl('p', { text: '이 보관함은 아직 Git 저장소가 아닙니다. Obsidian Git이나 외부 Git 도구에서 저장소를 설정해 주세요.' });
    this.body = this.contentEl.createDiv();
    this.staged = this.section('스테이지됨');
    this.unstaged = this.section('변경됨');
    this.recent = this.section('최근 변경한 파일');
    await this.plugin.refresh();
  }
  onClose() {}
  section(title) {
    const section = this.body.createDiv({ cls: 'luggit-section' });
    const header = section.createDiv({ cls: 'luggit-section-header' });
    const listId = 'luggit-section-' + ++sectionSequence;
    const toggle = header.createEl('button', { cls: 'luggit-section-toggle', attr: { type: 'button', 'aria-controls': listId } });
    const arrow = toggle.createSpan({ attr: { 'aria-hidden': 'true' } });
    const label = toggle.createSpan({ text: title, cls: 'luggit-section-label' });
    const list = section.createDiv({ cls: 'luggit-list', attr: { id: listId } });
    const update = () => {
      const collapsed = this.collapsedSections.has(title);
      list.hidden = collapsed;
      toggle.setAttribute('aria-expanded', String(!collapsed));
      setIcon(arrow, collapsed ? 'chevron-right' : 'chevron-down');
    };
    toggle.onclick = () => {
      if (this.collapsedSections.has(title)) this.collapsedSections.delete(title);
      else this.collapsedSections.add(title);
      update();
    };
    update();
    return { title, label, list, toggle };
  }
  render(snapshot) {
    if (!this.body) return;
    this.empty.hidden = snapshot.repo; this.body.hidden = !snapshot.repo;
    if (!snapshot.repo) return;
    this.renderFiles(this.staged, snapshot.files.filter(file => file.staged), true);
    this.renderFiles(this.unstaged, snapshot.files.filter(file => file.unstaged), false);
    this.recent.list.empty();
    for (const name of snapshot.recent || []) {
      const link = this.recent.list.createEl('a', { text: fileName(name), cls: 'luggit-recent', attr: { href: '#' } });
      setTooltip(link, name + ' · 최근 커밋 diff 보기');
      link.onclick = event => { event.preventDefault(); this.plugin.showRecentDiff(name); };
    }
    if (!snapshot.recent?.length) this.recent.list.createDiv({ text: '없음', cls: 'luggit-muted' });
  }
  renderFiles(section, files, staged) {
    section.label.setText(`${section.title} (${files.length})`);
    section.list.empty();
    if (!files.length) section.list.createDiv({ text: '없음', cls: 'luggit-muted' });
    for (const file of files) {
      const row = section.list.createDiv({ cls: 'luggit-file' });
      row.onclick = () => this.plugin.showDiff(file.path, staged);
      const code = file.conflicted ? 'U' : staged ? file.index : file.work;
      const statusName = { M: '수정', A: '추가', D: '삭제', R: '이름 변경', C: '복사', U: '충돌', T: '유형 변경', '?': '추적 안 됨' }[code] || code;
      const status = row.createSpan({ text: code, cls: 'luggit-code', attr: { 'data-status': code, 'aria-label': statusName } });
      setTooltip(status, statusName);
      const link = row.createEl('a', { text: fileName(file.path), cls: 'luggit-path', attr: { href: '#' } });
      setTooltip(link, file.path + ' · diff 보기');
      link.onclick = event => event.preventDefault();
      if (file.conflicted) {
        const tools = row.createDiv({ cls: 'luggit-actions' });
        iconButton(tools, ['git-merge'], '내용 보존하며 충돌 해결', () => this.plugin.showConflict(file.path)).disabled = this.plugin.busy;
      }

    }
  }
}

class GitSettings extends PluginSettingTab {
  constructor(app, plugin) { super(app, plugin); this.plugin = plugin; }
  display() {
    this.containerEl.empty();
    new Setting(this.containerEl).setName('Git 실행 파일').setDesc('git 또는 실행 파일의 절대 경로. 변경 후 플러그인을 다시 켜세요.').addText(input => input.setValue(this.plugin.settings.executable).onChange(async value => {
      this.plugin.settings.executable = value.trim() || 'git'; await this.plugin.saveData(this.plugin.settings);
    }));
  }
}

module.exports = class LuggitPlugin extends Plugin {
  async onload() {
    if (!(this.app.vault.adapter instanceof FileSystemAdapter)) { new Notice('Luggit은 데스크톱 보관함에서 사용할 수 있습니다.'); return; }
    registerIcons();
    const saved = await this.loadData();
    this.settings = { executable: saved?.executable || 'git' };
    this.busy = false; this.lastRefreshError = ''; this.refreshId = 0;
    const adapter = this.app.vault.adapter;
    this.git = new GitService(adapter.getBasePath(), { executable: this.settings.executable });
    this.conflicts = new ConflictService(this.git);
    this.registerView(VIEW, leaf => new GitView(leaf, this));
    this.addRibbonIcon(GIT_ICON, 'Git 변경사항', () => this.openPanel());
    this.addCommand({ id: 'open-panel', name: 'Git 변경사항 패널 열기', callback: () => this.openPanel() });
    this.addCommand({ id: 'refresh', name: '변경사항 새로고침', callback: () => this.refresh(false, true) });
    this.addSettingTab(new GitSettings(this.app, this));
    for (const name of ['modify', 'create', 'delete', 'rename']) this.registerEvent(this.app.vault.on(name, () => this.scheduleRefresh()));
    this.register(() => window.clearTimeout(this.refreshTimer));
    this.register(() => this.stopGitWatch?.());
    this.register(() => this.progressNotice?.hide());
    this.app.workspace.onLayoutReady(() => this.openPanel());
  }
  // Matches saved state too: a leaf kept across a plugin update is ours before its view is rebuilt.
  panelLeaves() {
    const leaves = [];
    this.app.workspace.iterateAllLeaves(leaf => { if (leaf.getViewState().type === VIEW) leaves.push(leaf); });
    return leaves;
  }
  openPanel() {
    // One at a time, so overlapping calls cannot each create a panel.
    return this.openingPanel ||= (async () => {
      try {
        let [leaf, ...extras] = this.panelLeaves();
        for (const extra of extras) extra.detach();
        if (!leaf) { leaf = this.app.workspace.getRightLeaf(false); if (!leaf) return; await leaf.setViewState({ type: VIEW, active: true }); }
        await this.app.workspace.revealLeaf(leaf);
      } catch (error) { this.fail(error); } finally { this.openingPanel = null; }
    })();
  }
  scheduleRefresh() { window.clearTimeout(this.refreshTimer); this.refreshTimer = window.setTimeout(() => this.refresh(), 500); }
  // A background tab holds a deferred placeholder until it is shown; its onOpen refreshes then.
  render() { for (const leaf of this.app.workspace.getLeavesOfType(VIEW)) if (leaf.view instanceof GitView) leaf.view.render(this.snapshot || { repo: false, files: [] }); }
  async refresh(force = false, notify = false) {
    if (this.busy && !force) return;
    const id = ++this.refreshId;
    try {
      const status = await this.git.status();
      if (status.repo) status.recent = await this.git.recentFiles(status.head);
      if (id !== this.refreshId) return;
      if (status.repo) this.stopGitWatch ||= this.git.watch(() => this.scheduleRefresh(), this.app.vault.configDir);
      this.lastRefreshError = ''; this.snapshot = status; this.render();
      if (notify) new Notice('변경사항을 새로고침했습니다.', 1500);
    } catch (error) {
      if (id !== this.refreshId) return;
      if (notify || this.lastRefreshError !== error.message) this.fail(error);
      this.lastRefreshError = error.message;
    }
  }
  async saveOpenViews() {
    const views = [];
    this.app.workspace.iterateAllLeaves(leaf => { if (leaf.view instanceof TextFileView && leaf.view.file) views.push(leaf.view); });
    const snapshots = views.map(view => ({ view, file: view.file, data: view.getViewData() }));
    for (const item of snapshots) {
      if (snapshots.some(other => other.file === item.file && other.data !== item.data)) throw new Error('같은 파일의 편집 내용이 서로 다릅니다. 먼저 저장 내용을 정리해 주세요.');
      await item.view.save();
    }
    for (const item of snapshots) {
      if (item.view.file !== item.file || item.view.getViewData() !== item.data || await this.app.vault.read(item.file) !== item.data) throw new Error('저장 중 문서가 변경되었습니다. 다시 실행해 주세요.');
    }
  }
  async perform(label, action, save = true) {
    if (this.busy) return;
    this.busy = true; ++this.refreshId; this.render();
    const progress = this.progressNotice = new Notice(label + ' 중…', 0);
    try {
      if (save) await this.saveOpenViews();
      const result = await action();
      if (result !== false) new Notice(label + ' 완료', 1500);
    }
    catch (error) { this.fail(error); }
    finally { progress.hide(); this.progressNotice = null; this.busy = false; await this.refresh(); }
  }
  fail(error) { new Notice(error.message, 6000); this.render(); }
  async showConflict(name) {
    return this.perform('충돌 미리보기', async () => {
      const preview = await this.conflicts.preview(name);
      new ConflictModal(this.app, preview, (apply) => this.resolveConflict(preview, apply)).open();
      return false;
    });
  }
  async resolveConflict(preview, apply) {
    return this.perform(apply ? '내용 보존 병합' : '충돌 원본 백업', async () => {
      const write = async (before, after) => {
        const file = this.app.vault.getFileByPath(preview.name);
        if (!file) throw new Error('파일을 찾을 수 없습니다. 목록을 새로고침해 주세요.');
        await this.app.vault.process(file, current => {
          if (current !== before) throw new Error('미리보기 후 문서가 변경되었습니다. 다시 확인해 주세요.');
          return after;
        });
      };
      const backup = await this.conflicts.resolve(preview, apply, write);
      new Notice('충돌 원본 백업: ' + backup, 12000);
    });
  }
  async showDiff(name, staged) {
    if (this.busy) return;
    try { new DiffModal(this.app, name, await this.git.diff(name, staged), staged,
      this.app.vault.getFileByPath(name) ? () => this.openFile(name) : null).open(); }
    catch (error) { this.fail(error); }
  }
  async openFile(name) {
    try {
      const file = this.app.vault.getFileByPath(name);
      if (!file) throw new Error('보관함에서 파일을 찾을 수 없습니다.');
      await this.app.workspace.getLeaf(false).openFile(file, { state: { mode: 'source' } });
    } catch (error) { this.fail(error); }
  }
  async showRecentDiff(name) {
    if (this.busy) return;
    try {
      const { commit, diff } = await this.git.recentDiff(name);
      new DiffModal(this.app, name, diff, false,
        this.app.vault.getFileByPath(name) ? () => this.openFile(name) : null,
        '최근 변경 커밋 · ' + commit.slice(0, 7)).open();
    } catch (error) { this.fail(error); }
  }
};
