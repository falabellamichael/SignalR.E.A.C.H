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
      if (busy) return;
      const signingIn = ['gmail-connect', 'google-connect', 'github-connect', 'oauth-connect'].includes(action);
      busy = true; busyAction = action; render(); message.textContent = signingIn ? 'Continue sign-in in your browser…' : action === 'check' ? 'Checking connection…' : action === 'save' ? 'Verifying and saving connection…' : 'Updating connection…';
      let polling = false;
      const poll = signingIn ? setInterval(async () => {
        if (polling || !host.isConnected) return;
        polling = true;
        try { await call('list'); } catch {} finally { polling = false; }
      }, 1000) : null;
      try { await call(action, value); message.textContent = action === 'save' ? 'Connection settings saved.' : action === 'disconnect' ? 'Disconnected on this device. You can also revoke access in your account security settings.' : ''; }
      finally { clearInterval(poll); busy = false; busyAction = ''; render(); }
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
        badge.textContent = { connected: 'Connected', ready: 'Ready', saved: 'Saved · check needed', disabled: 'Disabled', disconnected: 'Not connected', checking: 'Checking…', authorizing: 'Awaiting authorization', error: 'Check failed' }[item.status.state] || item.status.state;
        const description = document.createElement('p'); description.textContent = item.description;
        const note = document.createElement('p'); note.className = 'app-connection-note'; note.textContent = (item.status.note || item.account || '') + (['gmail', 'outlook'].includes(item.id) && item.configured ? (item.sendAllowed ? ' · Reading and sending permitted' : ' · Send permission not verified') : '');
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
        enabled.disabled = busy;
        enabled.onchange = () => { values.enabled = enabled.checked; patch(); };
        enabledLabel.append(enabled, document.createTextNode('Enable app tools')); details.append(enabledLabel);
        for (const field of item.fields) {
          const label = document.createElement('label'); label.textContent = field.label;
          const input = document.createElement('input'); input.type = field.secret ? 'password' : 'text'; input.autocomplete = 'off'; input.spellcheck = false;
          input.value = values[field.key] ?? field.value ?? '';
          input.disabled = busy;
          if (field.secret) input.placeholder = 'Leave blank to keep saved credential';
          input.oninput = () => { values[field.key] = input.value; patch(); };
          label.append(input); details.append(label);
        }
        if (item.help) { const help = document.createElement('p'); help.textContent = item.help; details.append(help); }
        if (item.chat) {
          const chatLabel = document.createElement('label'); chatLabel.className = 'app-connection-toggle';
          const chat = document.createElement('input'); chat.type = 'checkbox'; chat.checked = values.chatEnabled ?? item.chat.enabled; chat.disabled = busy;
          chat.onchange = () => { values.chatEnabled = chat.checked; patch(); };
          chatLabel.append(chat, document.createTextNode('Talk to REACH in Discord while Studio is open')); details.append(chatLabel);
          const projectLabel = document.createElement('label'); projectLabel.textContent = 'Discord conversation project';
          const project = document.createElement('select'); project.disabled = busy;
          for (const choice of [{ name: 'General conversation', dir: '' }, ...item.chat.projects]) { const option = document.createElement('option'); option.value = choice.dir; option.textContent = choice.name; project.append(option); }
          project.value = values.workspace ?? item.chat.workspace; project.onchange = () => { values.workspace = project.value; patch(); }; projectLabel.append(project); details.append(projectLabel);
          const chatStatus = document.createElement('p'); chatStatus.dataset.discordChatStatus = ''; chatStatus.textContent = item.chat.status?.note || 'Connect Discord, enable chat and Save. DM REACH, or mention it in any server text channel you and REACH can access. Use !stop, !new or !status. Tool approvals use !approve / !deny; file edit reviews stay in Studio.'; details.append(chatStatus);
        }
        const setupActions = document.createElement('div'); setupActions.className = 'app-connection-actions';
        setupActions.append(button('Save', async () => { await perform('save', { id: item.id, patch: values }); drafts.delete(item.id); render(); }, busy));
        if (item.helpUrl) setupActions.append(button('Setup guide', () => call('help', { id: item.id }), busy));
        details.append(setupActions);
        let send;
        if (['gmail', 'outlook'].includes(item.id)) {
          const allowSend = document.createElement('label'); allowSend.className = 'app-connection-toggle';
          send = document.createElement('input'); send.type = 'checkbox';
          send.checked = values.allowSend ?? item.allowSend ?? item.sendAllowed ?? false;
          send.disabled = busy;
          send.onchange = () => { values.allowSend = send.checked; patch(); };
          allowSend.append(send, document.createTextNode('Also allow sending (each send asks for approval)'));
          details.append(allowSend);
        }
        if (item.id === 'gmail' || item.googleSignIn || item.oauthProvider) {
          const provider = item.oauthProvider || 'Google';
          const accountNotice = document.createElement('p'); accountNotice.textContent = 'Choose your own ' + provider + ' account in the browser. Your authorization is encrypted in this device’s profile.' + (item.usesCallbackService ? ' REACH’s connection service completes authorization and token renewal.' + (item.id === 'discord' ? ' Discord message requests also pass through that service.' : '') : ''); details.append(accountNotice);
          actions.prepend(button((item.configured ? 'Reconnect ' : 'Connect ') + provider, async () => {
            const allowSend = send?.checked === true;
            if (drafts.has(item.id)) {
              await perform('save', { id: item.id, patch: { ...values, ...(['gmail', 'outlook'].includes(item.id) ? { allowSend } : {}) } });
              drafts.delete(item.id);
            }
            return perform(item.id === 'github' ? 'github-connect' : item.id === 'gmail' ? 'gmail-connect' : item.googleSignIn ? 'google-connect' : 'oauth-connect', { id: item.id, allowSend });
          }, busy));
          if (item.connecting) actions.append(button('Cancel sign-in', () => call('oauth-cancel')));
        }
        if (item.configured) actions.append(button('Disconnect', async () => {
          await perform('disconnect', { id: item.id });
          drafts.delete(item.id);
          render();
        }, busy));
        const edit = document.createElement('span'); edit.className = 'app-connection-edit'; edit.textContent = 'Edit';
        header.append(heading, badge, edit);card.append(header, description, note, actions, details); grid.append(card);
      }
    }
    let refreshingChat = false;
    const chatTimer = setInterval(async () => {
      if (!host.isConnected) { clearInterval(chatTimer); return; }
      if (busy || refreshingChat || !items.some(item => item.chat?.enabled)) return;
      refreshingChat = true;
      try { const result = await command('list'); const discord = result?.items?.find(item => item.id === 'discord'); const target = host.querySelector('[data-discord-chat-status]'); if (target && discord?.chat?.status) target.textContent = discord.chat.status.note; }
      catch {} finally { refreshingChat = false; }
    }, 5000);
    return { async refresh() { try { await call('list'); } catch (error) { message.textContent = error.message; } } };
  }
  window.ReachAppConnections = { mount };
})();
