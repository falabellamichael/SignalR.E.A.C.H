'use strict';

// Browser alert/confirm can break keyboard focus in Electron on Windows.
// Keep dialogs in the renderer, queue them, and restore focus on dismissal.
(() => {
  let queue = Promise.resolve();
  function show(message, { kind = 'notice', value = '' } = {}) {
    const run = () => new Promise(resolve => {
      const previous = document.activeElement;
      const dialog = document.createElement('dialog');
      dialog.className = 'app-dialog modal-box';
      dialog.setAttribute('aria-label', kind === 'confirm' ? 'Confirm action' : kind === 'prompt' ? 'Choose a team' : 'REACH Studio');
      const text = document.createElement('p');
      text.className = 'app-dialog-message';
      text.textContent = String(message);
      dialog.appendChild(text);
      let input;
      if (kind === 'prompt') {
        input = document.createElement('input');
        input.value = value;
        input.setAttribute('aria-label', 'Team number');
        dialog.appendChild(input);
      }
      const actions = document.createElement('div');
      actions.className = 'modal-actions';
      const cancel = document.createElement('button');
      cancel.textContent = 'Cancel'; cancel.className = 'ghost';
      const okay = document.createElement('button');
      okay.textContent = kind === 'confirm' ? 'Confirm' : 'OK'; okay.className = 'gold';
      if (kind !== 'notice') actions.appendChild(cancel);
      actions.appendChild(okay);
      dialog.appendChild(actions);
      const finish = accepted => {
        dialog.close(); dialog.remove();
        const target = previous?.isConnected && previous.getClientRects().length
          ? previous : document.querySelector('#composer-input');
        target?.focus({ preventScroll: true });
        resolve(kind === 'prompt' ? (accepted ? input.value : null) : accepted);
      };
      cancel.onclick = () => finish(false);
      okay.onclick = () => finish(true);
      dialog.addEventListener('cancel', event => { event.preventDefault(); finish(false); });
      input?.addEventListener('keydown', event => {
        if (event.key === 'Enter' && !event.isComposing) { event.preventDefault(); finish(true); }
      });
      document.body.appendChild(dialog);
      dialog.showModal();
      (input || (kind === 'confirm' ? cancel : okay)).focus();
    });
    const result = queue.then(run);
    queue = result.catch(() => {});
    return result;
  }
  window.ReachDialogs = { notice: message => show(message),
    confirm: message => show(message, { kind: 'confirm' }),
    prompt: message => show(message, { kind: 'prompt' }) };
})();
