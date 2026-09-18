'use strict';
const { Plugin, ItemView, MarkdownView, TextFileView, Modal, Notice, PluginSettingTab, Setting, FileSystemAdapter, addIcon, setIcon, setTooltip } = require('obsidian');
const { GitService } = require('./git-service');
const { confirmAction } = require('./confirmation');
const { ExitPushState } = require('./exit-state');
const { parseDiff, copyableDiff } = require('./diff');
const VIEW = 'luggit-changes';
const GIT_ICON = 'luggit-logo';
const COMMIT_PUSH_ICON = 'luggit-commit-push';
let toolbarSequence = 0;
let sectionSequence = 0;

function registerIcons() {
  // Obsidian custom icons use a 100 × 100 viewBox. Draw on the same 24-unit
  // grid as the surrounding Lucide controls to keep stroke weight consistent.
  const wrap = content => `<g transform="scale(4.1666666667)" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${content}</g>`;
  addIcon(COMMIT_PUSH_ICON, wrap('<path d="m7 8 5-5 5 5M12 3v9M4 18h5m6 0h5"/><circle cx="12" cy="18" r="3"/>'));
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
      this.titleEl.onclick = open;
      this.titleEl.onkeydown = event => {
        if ((event.key === 'Enter' || event.key === ' ') && !event.repeat && !event.isComposing &&
          !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey) open(event);
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
    if (this.openFile) iconButton(actions, ['file-pen-line'], '문서 열기', () => { this.close(); this.openFile(); });
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
    const toolbarLabel = 'luggit-toolbar-' + ++toolbarSequence;
    const header = this.contentEl.createDiv({ cls: 'luggit-header', attr: { role: 'toolbar', 'aria-labelledby': toolbarLabel } });
    header.createSpan({ text: 'Git 작업', attr: { id: toolbarLabel, hidden: '' } });
    this.commitPushButton = iconButton(header, [COMMIT_PUSH_ICON], '커밋 후 Push', () => this.plugin.commit(true));
    this.commitButton = iconButton(header, ['git-commit-horizontal'], '커밋', () => this.plugin.commit(false));
    this.stageAllButton = iconButton(header, ['plus'], '모두 스테이지', () => this.plugin.perform('스테이지', () => this.plugin.git.stage()));
    this.unstageAllButton = iconButton(header, ['minus'], '모두 스테이지 해제', () => this.plugin.perform('스테이지 해제', () => this.plugin.git.unstage()));
    this.pushButton = iconButton(header, ['arrow-up-from-line'], 'Push · 커밋 올리기', () => this.plugin.perform('Push', () => this.plugin.push()));
    this.pullButton = iconButton(header, ['arrow-down-to-line'], 'Pull · 원격 변경 가져오기', () => this.plugin.pullFromRemote());
    this.empty = this.contentEl.createDiv();
    this.empty.createEl('p', { text: '이 보관함은 아직 Git 저장소가 아닙니다.' });
    iconButton(this.empty, ['git-branch-plus'], '보관함에 Git 저장소 만들기', () => this.plugin.perform('초기화', () => this.plugin.git.init(), false));
    this.body = this.contentEl.createDiv();
    this.message = this.body.createEl('textarea', { cls: 'luggit-message', placeholder: '커밋 메시지 (비우면 파일명 사용)', attr: { 'aria-label': '커밋 메시지', rows: '1' } });
    this.message.value = this.plugin.draft;
    this.message.oninput = () => { this.plugin.draft = this.message.value; this.resizeMessage(); };
    this.messageObserver?.disconnect();
    let width = 0;
    this.messageObserver = new this.message.ownerDocument.defaultView.ResizeObserver(entries => {
      const nextWidth = entries[0].contentRect.width;
      if (nextWidth > 0 && nextWidth !== width) {
        width = nextWidth;
        const win = this.message.ownerDocument.defaultView;
        win.cancelAnimationFrame(this.messageResizeFrame);
        this.messageResizeFrame = win.requestAnimationFrame(() => this.resizeMessage());
      }
    });
    this.messageObserver.observe(this.message);
    this.message.onkeydown = event => {
      if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.isComposing) {
        event.preventDefault(); this.plugin.commit(false);
      }
    };
    this.staged = this.section('스테이지됨', [
      ['minus', '모두 스테이지 해제', () => this.plugin.perform('스테이지 해제', () => this.plugin.git.unstage())],
    ]);
    this.unstaged = this.section('변경됨', [
      ['undo-2', '모두 버리기', () => this.plugin.discard()],
      ['plus', '모두 스테이지', () => this.plugin.perform('스테이지', () => this.plugin.git.stage())],
    ]);
    this.recent = this.section('최근 변경한 파일', []);
    await this.plugin.refresh();
  }
  onClose() {
    this.messageObserver?.disconnect();
    this.message?.ownerDocument.defaultView.cancelAnimationFrame(this.messageResizeFrame);
  }
  resizeMessage() {
    if (!this.message?.getClientRects().length) return;
    const css = this.message.ownerDocument.defaultView.getComputedStyle(this.message);
    const border = parseFloat(css.borderTopWidth) + parseFloat(css.borderBottomWidth);
    this.message.style.height = 'auto';
    // An empty field stays one line even if its placeholder wraps in a narrow sidebar.
    const height = this.message.value ? this.message.scrollHeight :
      parseFloat(css.lineHeight) + parseFloat(css.paddingTop) + parseFloat(css.paddingBottom);
    this.message.style.height = `${Math.ceil(height + border)}px`;
  }
  section(title, actions) {
    const section = this.body.createDiv({ cls: 'luggit-section' });
    const header = section.createDiv({ cls: 'luggit-section-header' });
    const listId = 'luggit-section-' + ++sectionSequence;
    const toggle = header.createEl('button', { cls: 'luggit-section-toggle', attr: { type: 'button', 'aria-controls': listId } });
    const arrow = toggle.createSpan({ attr: { 'aria-hidden': 'true' } });
    const label = toggle.createSpan({ text: title, cls: 'luggit-section-label' });
    const tools = actions.length ? header.createDiv({ cls: 'luggit-actions' }) : null;
    const buttons = actions.map(([icon, name, action]) => iconButton(tools, [icon], name, action));
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
    return { title, label, buttons, list, toggle };
  }
  render(snapshot) {
    if (!this.body) return;
    this.empty.hidden = snapshot.repo; this.body.hidden = !snapshot.repo;
    this.message.disabled = this.plugin.busy;
    for (const button of this.contentEl.querySelectorAll('.luggit-icon')) button.disabled = this.plugin.busy;
    for (const button of [this.stageAllButton, this.unstageAllButton, this.commitButton, this.pushButton, this.pullButton, this.commitPushButton]) {
      button.disabled = this.plugin.busy || !snapshot.repo;
      if (!snapshot.repo) button.removeClass('is-pending');
    }
    if (!snapshot.repo) return;
    this.stageAllButton.disabled = this.plugin.busy || !snapshot.files.some(file => file.unstaged);
    this.unstageAllButton.disabled = this.plugin.busy || !snapshot.files.some(file => file.staged);
    this.message.value = this.plugin.draft;
    this.resizeMessage();
    // Disable only what certainly cannot work: staging and committing depend on the
    // file list alone. The ahead count is an estimate, so Push is highlighted but
    // never disabled, and nothing is known about Pull before asking the remote.
    const changed = snapshot.files.length > 0;
    for (const button of [this.commitButton, this.commitPushButton]) {
      button.disabled = this.plugin.busy || !changed;
      button.toggleClass('is-pending', changed);
    }
    this.pushButton.toggleClass('is-pending', snapshot.ahead > 0);
    setTooltip(this.pushButton, `Push · 대기 커밋 ${snapshot.ahead}개`, { placement: 'bottom' });
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
    for (const button of section.buttons) button.disabled = this.plugin.busy || !files.length;
    section.list.empty();
    if (!files.length) section.list.createDiv({ text: '없음', cls: 'luggit-muted' });
    for (const file of files) {
      const row = section.list.createDiv({ cls: 'luggit-file' });
      row.onclick = () => this.plugin.showDiff(file.path, staged);
      const code = staged ? file.index : file.work;
      const statusName = { M: '수정', A: '추가', D: '삭제', R: '이름 변경', C: '복사', U: '충돌', T: '유형 변경', '?': '추적 안 됨' }[code] || code;
      const status = row.createSpan({ text: code, cls: 'luggit-code', attr: { 'data-status': code, 'aria-label': statusName } });
      setTooltip(status, statusName);
      const link = row.createEl('a', { text: fileName(file.path), cls: 'luggit-path', attr: { href: '#' } });
      setTooltip(link, file.path + ' · diff 보기');
      link.onclick = event => event.preventDefault();
      const tools = row.createDiv({ cls: 'luggit-actions' });
      if (staged) iconButton(tools, ['minus'], '스테이지 해제', () => this.plugin.perform('스테이지 해제', () => this.plugin.git.unstage(file.path)));
      else {
        iconButton(tools, ['undo-2'], '변경 버리기', () => this.plugin.discard(file.path));
        iconButton(tools, ['plus'], '스테이지', () => this.plugin.perform('스테이지', () => this.plugin.git.stage(file.path)));
      }
      for (const button of tools.querySelectorAll('button')) button.disabled = this.plugin.busy;
    }
  }
}

class GitSettings extends PluginSettingTab {
  constructor(app, plugin) { super(app, plugin); this.plugin = plugin; }
  display() {
    this.containerEl.empty();
    new Setting(this.containerEl).setName('시작할 때 Pull').setDesc('원격 저장소가 있고 보관함에 변경사항이 없을 때만 가져옵니다.').addToggle(toggle => toggle.setValue(this.plugin.settings.autoPull).onChange(async value => {
      this.plugin.settings.autoPull = value; await this.plugin.saveData(this.plugin.settings);
    }));
    new Setting(this.containerEl).setName('종료할 때 Push').setDesc('이미 만들어 둔 커밋만 최대 15초 동안 Push합니다. Obsidian의 종료 이벤트가 생략되면 실행되지 않을 수 있습니다.').addToggle(toggle => toggle.setValue(this.plugin.settings.autoPushOnExit).onChange(async value => {
      this.plugin.settings.autoPushOnExit = value; await this.plugin.saveData(this.plugin.settings);
    }));
    new Setting(this.containerEl).setName('Git 실행 파일').setDesc('git 또는 실행 파일의 절대 경로. 변경 후 플러그인을 다시 켜세요.').addText(input => input.setValue(this.plugin.settings.executable).onChange(async value => {
      this.plugin.settings.executable = value.trim() || 'git'; await this.plugin.saveData(this.plugin.settings);
    }));
  }
}

module.exports = class LuggitPlugin extends Plugin {
  async onload() {
    if (!(this.app.vault.adapter instanceof FileSystemAdapter)) { new Notice('Luggit은 데스크톱 보관함에서 사용할 수 있습니다.'); return; }
    registerIcons();
    this.settings = Object.assign({ autoPull: true, autoPushOnExit: true, executable: 'git' }, await this.loadData());
    this.draft = ''; this.busy = false; this.lastRefreshError = ''; this.refreshId = 0;
    const adapter = this.app.vault.adapter;
    this.exitPushError = '';
    try {
      this.exitState = new ExitPushState(window.localStorage, adapter.getBasePath(), this.app.vault.configDir);
      this.exitPushError = this.exitState.read();
    } catch (error) {
      new Notice('종료 Push 상태를 로컬 저장소에서 읽지 못했습니다: ' + error.message, 6000);
    }
    this.git = new GitService(adapter.getBasePath(), { executable: this.settings.executable, trash: async name => {
      if (!(await adapter.trashSystem(name))) await adapter.trashLocal(name);
    } });
    this.registerView(VIEW, leaf => new GitView(leaf, this));
    this.addRibbonIcon(GIT_ICON, 'Git 변경사항', () => this.openPanel());
    this.addCommand({ id: 'open-panel', name: 'Git 변경사항 패널 열기', callback: () => this.openPanel() });
    this.addCommand({ id: 'save-stage-current', name: '현재 문서 저장 후 스테이지', editorCallback: (_editor, view) => {
      if (view.file) this.perform('저장 및 스테이지', () => this.git.stage(view.file.path));
    } });
    this.addCommand({ id: 'save-stage-all', name: '모두 저장 후 스테이지', callback: () => this.perform('모두 스테이지', () => this.git.stage()) });
    this.addCommand({ id: 'commit', name: '커밋', callback: () => this.commit(false) });
    this.addCommand({ id: 'commit-and-push', name: '커밋 후 Push', callback: () => this.commit(true) });
    this.addCommand({ id: 'pull', name: 'Pull', callback: () => this.pullFromRemote() });
    this.addCommand({ id: 'push', name: 'Push', callback: () => this.perform('Push', () => this.push()) });
    this.addCommand({ id: 'refresh', name: '변경사항 새로고침', callback: () => this.refresh(false, true) });
    this.addSettingTab(new GitSettings(this.app, this));
    for (const name of ['modify', 'create', 'delete', 'rename']) this.registerEvent(this.app.vault.on(name, () => this.scheduleRefresh()));
    this.register(() => window.clearTimeout(this.refreshTimer));
    this.register(() => this.stopGitWatch?.());
    this.register(() => this.progressNotice?.hide());
    this.registerEvent(this.app.workspace.on('quit', tasks => {
      if (!this.settings.autoPushOnExit || this.busy) return;
      tasks.add(() => this.pushOnExit());
    }));
    this.app.workspace.onLayoutReady(() => {
      this.openPanel();
      this.reportExitPush();
      if (this.settings.autoPull) this.perform('자동 Pull', async () => {
        const status = await this.git.status();
        if (status.repo && !status.files.length && (await this.git.run(['remote'])).trim()) await this.git.pull();
        else return false;
      });
    });
  }
  async openPanel() {
    try {
      let leaf = this.app.workspace.getLeavesOfType(VIEW)[0];
      if (!leaf) { leaf = this.app.workspace.getRightLeaf(false); if (!leaf) return; await leaf.setViewState({ type: VIEW, active: true }); }
      await this.app.workspace.revealLeaf(leaf);
    } catch (error) { this.fail(error); }
  }
  scheduleRefresh() { window.clearTimeout(this.refreshTimer); this.refreshTimer = window.setTimeout(() => this.refresh(), 500); }
  async pullFromRemote() {
    return this.perform('Pull', async () => {
      const status = await this.git.status();
      if (status.repo && (await this.git.run(['remote'])).trim()) await this.git.pull();
    });
  }
  render() { for (const leaf of this.app.workspace.getLeavesOfType(VIEW)) leaf.view.render(this.snapshot || { repo: false, files: [] }); }
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
  recordExitPushError(message) {
    this.exitPushError = message;
    try { this.exitState.write(message); }
    catch (error) { new Notice('종료 Push 상태를 로컬에 저장하지 못했습니다: ' + error.message, 6000); }
  }
  // The window closes right after an exit push, so clearing the marker may never
  // reach the disk. Trust the repository instead: nothing waiting means it was pushed.
  async reportExitPush() {
    if (!this.exitPushError) return;
    try {
      const status = await this.git.status();
      if (status.repo && !status.ahead) { this.recordExitPushError(''); return; }
    } catch { /* Report the stored failure below. */ }
    new Notice('지난 종료 Push: ' + this.exitPushError + '\nPush 버튼으로 다시 시도하세요.', 8000);
  }
  async pushOnExit() {
    try {
      const status = await this.git.status();
      if (!status.repo || !status.ahead) return;
      this.recordExitPushError('Push 완료를 확인하지 못했습니다.');
      await this.git.pushOnExit();
      this.recordExitPushError('');
    } catch (error) { this.recordExitPushError(error.message); }
  }
  async push() {
    await this.git.push();
    this.recordExitPushError('');
  }
  async commit(push) {
    return this.perform(push ? '커밋 후 Push' : '커밋', async () => {
      await this.git.commit(this.draft); this.draft = '';
      if (push) {
        try { await this.push(); }
        catch (error) { throw new Error('커밋은 완료됐지만 Push에 실패했습니다. Push 버튼으로 다시 시도하세요.\n' + error.message); }
      }
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
  async discard(name) {
    return this.perform('변경 버리기', async () => {
      const status = await this.git.status();
      const files = status.files.filter(file => file.unstaged && (!name || file.path === name));
      if (!files.length) return false;
      const views = this.app.workspace.getLeavesOfType('markdown').map(leaf => leaf.view)
        .filter(view => view instanceof MarkdownView && files.some(file => file.path === view.file?.path))
        .map(view => ({ view, file: view.file, content: view.editor.getValue() }));
      const message = `${name || files.length + '개 파일'}의 스테이지되지 않은 변경을 버릴까요? 새 파일은 휴지통으로 보냅니다.`;
      if (!(await confirmAction(this.app, { title: '변경 버리기', message, confirmLabel: name ? '변경 버리기' : '모두 버리기' }))) return false;
      for (const item of views) if (item.view.file !== item.file || item.view.editor.getValue() !== item.content) throw new Error('확인 중 문서가 변경되어 취소했습니다.');
      const current = (await this.git.status()).files.filter(file => file.unstaged && (!name || file.path === name));
      if (JSON.stringify(files) !== JSON.stringify(current)) throw new Error('Git 상태가 변경되었습니다. 다시 확인해 주세요.');
      for (const file of files) {
        await this.git.discard(file.path);
        for (const item of views.filter(item => item.file.path === file.path)) {
          if (item.view.file !== item.file || item.view.editor.getValue() !== item.content) continue;
          if (file.index === '?') item.view.leaf.detach();
          else {
            const data = await this.app.vault.read(item.file);
            if (item.view.file === item.file && item.view.editor.getValue() === item.content) item.view.setViewData(data, false);
          }
        }
      }
    });
  }
};
