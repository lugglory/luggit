'use strict';
const { Modal } = require('obsidian');

class ConfirmationModal extends Modal {
  constructor(app, options, resolve) {
    super(app);
    this.options = options;
    this.resolve = resolve;
    this.accepted = false;
  }
  onOpen() {
    this.setTitle(this.options.title);
    this.contentEl.createEl('p', { text: this.options.message });
    // Use the host's dialog button styling; no separate stylesheet is needed
    // when either plugin is installed on its own.
    const actions = this.contentEl.createDiv({ cls: 'modal-button-container luggit-confirm-actions' });
    Object.assign(actions.style, { display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '24px', flexWrap: 'wrap' });
    const cancel = actions.createEl('button', { text: '취소', attr: { type: 'button' } });
    const approve = actions.createEl('button', { text: this.options.confirmLabel, cls: 'mod-warning', attr: { type: 'button' } });
    cancel.onclick = () => this.close();
    const accept = () => { this.accepted = true; this.close(); };
    approve.onclick = accept;
    this.keyHandler = event => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      if (event.isComposing || event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) return;
      if (event.target === cancel) return; // Keep a deliberately focused Cancel button usable.
      event.preventDefault(); event.stopPropagation();
      if (!event.repeat) accept();
    };
    this.modalEl.addEventListener('keydown', this.keyHandler);
    approve.focus({ preventScroll: true });
  }
  onClose() {
    this.modalEl.removeEventListener('keydown', this.keyHandler);
    this.contentEl.empty();
    this.resolve(this.accepted);
  }
}

function confirmAction(app, options) {
  return new Promise(resolve => new ConfirmationModal(app, options, resolve).open());
}
module.exports = { confirmAction };
