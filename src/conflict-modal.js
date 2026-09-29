'use strict';
const { Modal } = require('obsidian');

class ConflictModal extends Modal {
  constructor(app, preview, resolve) { super(app); this.preview = preview; this.resolve = resolve; }
  onOpen() {
    const preview = this.preview;
    this.setTitle('내용 보존하며 충돌 해결 · ' + preview.name);
    this.modalEl.addClass('luggit-conflict-modal');
    this.contentEl.createEl('p', { text: preview.reason || (preview.count
      ? `충돌 ${preview.count}곳에서 양쪽 내용을 순서대로 남깁니다. 중복이나 서로 다른 설명이 남을 수 있으니 결과를 확인해 주세요.`
      : '현재 파일의 내용을 보존합니다. 한쪽에서 삭제한 파일도 남깁니다. 결과를 확인해 주세요.') });
    if (preview.result !== null) {
      this.contentEl.createEl('pre', { text: preview.result, cls: 'luggit-conflict-preview', attr: { tabindex: '0', 'aria-label': '양쪽 내용을 보존한 병합 결과' } });
    }
    this.contentEl.createEl('p', { text: '기준·양쪽 원본·현재 파일을 보관함의 .git/luggit-backups에 별도로 백업합니다. 이 백업은 Git으로 동기화되지 않습니다. 적용하면 이 파일만 스테이지하여 해결로 표시합니다. 커밋은 Obsidian Git에서 진행하세요.' });
    const actions = this.contentEl.createDiv({ cls: 'modal-button-container' });
    const cancel = actions.createEl('button', { text: '취소' });
    cancel.onclick = () => this.close();
    const backup = actions.createEl('button', { text: '원본만 백업' });
    backup.onclick = () => { this.close(); this.resolve(false); };
    if (preview.result !== null) {
      const apply = actions.createEl('button', { text: '적용하고 해결로 표시', cls: 'mod-cta' });
      apply.onclick = () => { this.close(); this.resolve(true); };
    }
    cancel.focus();
  }
  onClose() { this.contentEl.empty(); }
}
module.exports = { ConflictModal };
