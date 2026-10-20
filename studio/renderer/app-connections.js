'use strict';
(() => {
  function mount(host, command) {
    let items = [], busy = false, busyAction = '';
    const drafts = new Map();
    const expanded = new Set();
    const message = document.createElement('p'); message.className = 'app-connection-notice'; message.setAttribute('role', 'status');
    const grid = document.createElement('div'); grid.className = 'app-connections-grid';
    host.replaceChildren(message, grid);
    function button(label, run, disabled = false) {
      const element = document.createElement('button'); element.type = 'button'; element.textContent = label; element.disabled = disabled;
      element.onclick = () => Promise.resolve().then(run).catch(error => { message.textContent = error.message; });
      return element;
    }
    async function call(action, value) {
      const result = await command(action, value);
      if (!result?.ok) throw new Error(result?.err || 'Connection command failed.');
      if (result.items) { items = result.items; render(); }
      return result;
    }
    async function perform(action, value) {
      busy = true; busyAction = action; render(); message.textContent = action === 'gmail-connect' ? 'Continue Google sign-in in your browser…' : action === 'check' ? 'Checking connection…' : 'Saving connection…';
      try { await call(action, value); message.textContent = action === 'save' ? 'Connection settings saved.' : action === 'disconnect' ? 'Disconnected on this device. You can also revoke access in your account security settings.' : ''; }
      finally { busy = false; busyAction = ''; render(); }
    }
    function render() {
      grid.replaceChildren();
      for (const item of items) {
        const card = document.createElement('details'); card.className = 'app-connection-card'; card.dataset.connection = item.id;
        card.open = expanded.has(item.id);
        card.ontoggle = () => { if (!card.isConnected) return; if (card.open) expanded.add(item.id); else expanded.delete(item.id); };
        const header = document.createElement('summary'); header.className = 'app-connection-header';
        const heading = document.createElement('h3'); heading.textContent = item.name;
        const badge = document.createElement('span'); badge.className = 'app-connection-badge'; badge.dataset.state = item.status.state;
        badge.textContent = { connected: 'Connected', ready: 'Ready', saved: 'Saved · check needed', disabled: 'Disabled', disconnected: 'Not connected', checking: 'Checking…', error: 'Check failed' }[item.status.state] || item.status.state;
        const description = document.createElement('p'); description.textContent = item.description;
        const note = document.createElement('p'); note.className = 'app-connection-note'; note.textContent = (item.status.note || item.account || '') + (item.id === 'gmail' && item.configured ? (item.sendAllowed ? ' · Reading and sending permitted' : ' · Read only') : '');
        const actions = document.createElement('div'); actions.className = 'app-connection-actions';
        actions.append(button('Check', () => {
          if (drafts.has(item.id)) throw new Error('Save this connection’s changes before checking.');
          return perform('check', { id: item.id });
        }, busy || !item.enabled));
        const details = document.createElement('div'); details.className = 'app-connection-editor';
        const values = drafts.get(item.id) || {};
        const patch = () => { drafts.set(item.id, values); };
        const enabledLabel = document.createElement('label'); enabledLabel.className = 'app-connection-toggle';
        const enabled = document.createElement('input'); enabled.type = 'checkbox'; enabled.checked = values.enabled ?? item.enabled;
        enabled.onchange = () => { values.enabled = enabled.checked; patch(); };
        enabledLabel.append(enabled, document.createTextNode('Enable app tools')); details.append(enabledLabel);
        for (const field of item.fields) {
          const label = document.createElement('label'); label.textContent = field.label;
          const input = document.createElement('input'); input.type = field.secret ? 'password' : 'text'; input.autocomplete = 'off'; input.spellcheck = false;
          input.value = values[field.key] ?? field.value ?? '';
          if (field.secret) input.placeholder = 'Leave blank to keep saved credential';
          input.oninput = () => { values[field.key] = input.value; patch(); };
          label.append(input); details.append(label);
        }
        if (item.help) { const help = document.createElement('p'); help.textContent = item.help; details.append(help); }
        const setupActions = document.createElement('div'); setupActions.className = 'app-connection-actions';
        setupActions.append(button('Save', async () => { await perform('save', { id: item.id, patch: values }); drafts.delete(item.id); render(); }, busy));
        if (item.helpUrl) setupActions.append(button('Setup guide', () => call('help', { id: item.id }), busy));
        details.append(setupActions);
        if (item.id === 'gmail') {
          const allowSend = document.createElement('label'); allowSend.className = 'app-connection-toggle';
          const send = document.createElement('input'); send.type = 'checkbox'; allowSend.append(send, document.createTextNode('Also allow sending (each send asks for approval)'));
          details.append(allowSend);
          actions.prepend(button(item.configured ? 'Reconnect Google' : 'Connect Google', () => {
            if (drafts.has(item.id)) throw new Error('Save the Google client settings before connecting.');
            return perform('gmail-connect', { allowSend: send.checked });
          }, busy));
          if (busyAction === 'gmail-connect' || item.connecting) actions.append(button('Cancel Google sign-in', () => call('gmail-cancel')));
        }
        if (item.configured) actions.append(button('Disconnect', () => perform('disconnect', { id: item.id }), busy));
        const edit = document.createElement('span'); edit.className = 'app-connection-edit'; edit.textContent = 'Edit';
        header.append(heading, badge, edit);card.append(header, description, note, actions, details); grid.append(card);
      }
    }
    return { async refresh() { try { await call('list'); } catch (error) { message.textContent = error.message; } } };
  }
  window.ReachAppConnections = { mount };
})();
