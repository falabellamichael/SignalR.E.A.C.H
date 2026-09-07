/* REACH chat — webview script. Talks to the extension host exclusively via postMessage.
 * History + current conversation persist in the webview state (survives reloads). */
(function () {
  const vscode = window.acquireVsCodeApi ? window.acquireVsCodeApi() : null;
  if (!vscode) return;

  const $ = (sel) => document.querySelector(sel);
  const log = $('#log');
  const input = $('#input');
  const modelSelect = $('#model');
  const endpointLine = $('#endpoint');
  const historyPanel = $('#history-panel');
  const historyBtn = $('#history-btn');
  const clearBtn = $('#clear-btn');
  const wsCheck = $('#ws-check');
  const wsCount = $('#ws-count');
  const thinkCheck = $('#think-check');
  const webCheck = $('#web-check');
  const webCount = $('#web-count');
  const searchInput = $('#search');
  const searchResults = $('#search-results');
  const settingsBtn = $('#settings-btn');
  const settingsPanel = $('#settings-panel');
  const topThink = $('#top-think');
  const modelChip = $('#model-chip');
  const statusDot = $('#status-dot');

  let conv = null;            // current conversation {id, model, ts, title, messages, thoughts}
  let busy = false;
  let pendingBubble = null;
  let thinkRow = null;
  let pendingText = '';
  let clearArmed = false;
  let clearTimer = null;
  let includeWorkspace = true;
  let thinkEnabled = true;
  let webEnabled = true;
  let pendingThought = '';
  let configCache = null;

  function state() { return vscode.getState() || { history: [], conv: null }; }
  function persist() { vscode.setState({ history: state().history, conv }); }

  function post(type, payload) {
    vscode.postMessage(Object.assign({ type }, payload || {}));
  }

  /* ---------- rendering ---------- */

  function hint(text) {
    const div = document.createElement('div');
    div.className = 'hint';
    div.textContent = text;
    log.appendChild(div);
    return div;
  }

  function bubble(role) {
    const div = document.createElement('div');
    div.className = 'bubble ' + role;
    const label = document.createElement('span');
    label.className = 'role';
    label.textContent = role === 'user' ? 'You' : (conv && conv.model) || modelSelect.value || 'assistant';
    div.appendChild(label);
    const body = document.createElement('div');
    body.className = 'body';
    div.appendChild(body);
    log.appendChild(div);
    return body;
  }

  function showThinking() {
    if (!pendingBubble || thinkRow) return;
    const spinner = document.createElement('span');
    spinner.className = 'think-spinner';
    spinner.setAttribute('aria-label', 'thinking');
    pendingBubble.prepend(spinner);
    thinkRow = spinner;
  }

  function hideThinking() {
    if (thinkRow) { thinkRow.remove(); thinkRow = null; }
    if (pendingBubble && pendingBubble.parentElement) pendingBubble.parentElement.classList.remove('thinking');
    topThink.hidden = true;
  }

  function thoughtIcon(title) {
    const icon = document.createElement('span');
    icon.className = 'thought-icon';
    icon.textContent = '💭';
    icon.title = 'Private reasoning:\n\n' + title;
    return icon;
  }

  function attachThoughts(body, title) {
    body.prepend(document.createTextNode('... '));
    body.prepend(thoughtIcon(title));
    body.appendChild(document.createTextNode(' ...'));
    body.appendChild(thoughtIcon(title));
  }

  function renderMessages() {
    log.innerHTML = '';
    const msgs = (conv && conv.messages) || [];
    if (!msgs.length) {
      hint('Type a message below. Models and endpoint load automatically from your REACH relay.');
      return;
    }
    msgs.forEach((m, idx) => {
      const body = bubble(m.role);
      body.textContent = m.content;
      if (m.role === 'assistant' && conv.thoughts && conv.thoughts[idx]) {
        attachThoughts(body, conv.thoughts[idx]);
      }
    });
    scrollBottom();
  }

  function scrollBottom() {
    log.scrollTop = log.scrollHeight;
  }

  function fmtTime(ts) {
    const d = new Date(ts);
    const now = new Date();
    const sameDay = d.toDateString() === now.toDateString();
    const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    return sameDay ? time : d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' + time;
  }

  function snippet(messages, query) {
    const q = query.toLowerCase();
    for (const m of messages || []) {
      const content = m.content || '';
      const i = content.toLowerCase().indexOf(q);
      if (i >= 0) {
        const start = Math.max(0, i - 30);
        const s = content.slice(start, start + 110).replace(/\s+/g, ' ').trim();
        return (start > 0 ? '…' : '') + s + (start + 110 < content.length ? '…' : '');
      }
    }
    return '';
  }

  function renderSearch() {
    searchResults.innerHTML = '';
    const q = searchInput.value.trim().toLowerCase();
    if (!q) { searchResults.hidden = true; return; }
    const matches = [];
    state().history.forEach((item) => {
      const inTitle = (item.title || '').toLowerCase().includes(q);
      const inMsg = (item.messages || []).some((m) => (m.content || '').toLowerCase().includes(q));
      if (inTitle || inMsg) matches.push({ item, sn: inTitle ? '' : snippet(item.messages, q) });
    });
    if (!matches.length) {
      const empty = document.createElement('div');
      empty.className = 'history-empty';
      empty.textContent = 'No saved chats match.';
      searchResults.appendChild(empty);
    } else {
      matches.slice(0, 20).forEach(({ item, sn }) => {
        const row = document.createElement('div');
        row.className = 'history-item';
        const meta = document.createElement('div');
        meta.className = 'meta';
        const t = document.createElement('div');
        t.className = 'title';
        t.textContent = item.title || '(untitled)';
        const sub = document.createElement('div');
        sub.className = 'sub';
        sub.textContent = sn || (item.model || '') + ' · ' + fmtTime(item.ts);
        meta.appendChild(t);
        meta.appendChild(sub);
        row.appendChild(meta);
        row.addEventListener('click', () => {
          searchResults.hidden = true;
          searchInput.value = '';
          loadHistory(item.id);
        });
        searchResults.appendChild(row);
      });
    }
    searchResults.hidden = false;
  }

  function renderHistory() {
    const hist = state().history;
    historyPanel.innerHTML = '';
    const title = document.createElement('div');
    title.className = 'history-title';
    title.textContent = 'History';
    historyPanel.appendChild(title);
    if (!hist.length) {
      const empty = document.createElement('div');
      empty.className = 'history-empty';
      empty.textContent = 'No saved chats yet.';
      historyPanel.appendChild(empty);
      return;
    }
    hist.slice().sort((a, b) => b.ts - a.ts).forEach((item) => {
      const row = document.createElement('div');
      row.className = 'history-item' + (conv && conv.id === item.id ? ' active' : '');
      const meta = document.createElement('div');
      meta.className = 'meta';
      const t = document.createElement('div');
      t.className = 'title';
      t.textContent = item.title || '(untitled)';
      const sub = document.createElement('div');
      sub.className = 'sub';
      sub.textContent = (item.model || '') + ' · ' + fmtTime(item.ts);
      meta.appendChild(t);
      meta.appendChild(sub);
      row.appendChild(meta);
      const del = document.createElement('button');
      del.className = 'del';
      del.title = 'Delete this chat';
      del.textContent = '✕';
      del.addEventListener('click', (e) => {
        e.stopPropagation();
        deleteHistory(item.id);
      });
      row.appendChild(del);
      row.addEventListener('click', () => loadHistory(item.id));
      historyPanel.appendChild(row);
    });
  }

  const SETTING_FIELDS = [
    { key: 'endpoint', label: 'Endpoint', type: 'text' },
    { key: 'accessKey', label: 'Access key', type: 'password' },
    { key: 'model', label: 'Default model', type: 'text' },
    { key: 'maxTokens', label: 'Max tokens', type: 'number', min: 1 },
    { key: 'workspaceContext', label: 'Workspace context', type: 'check' },
    { key: 'contextMaxKb', label: 'Context max KB', type: 'number', min: 8 },
    { key: 'think', label: 'WhisperThink', type: 'check' },
    { key: 'thinkModel', label: 'Think model', type: 'text' },
    { key: 'thinkMaxTokens', label: 'Think max tokens', type: 'number', min: 64 },
    { key: 'webSearch', label: 'Web search', type: 'check' },
    { key: 'searchResults', label: 'Search results', type: 'number', min: 1, max: 10 },
    { key: 'playwright', label: 'Playwright fetch', type: 'check' },
  ];

  function renderSettings() {
    const cfg = configCache || {};
    settingsPanel.innerHTML = '';
    SETTING_FIELDS.forEach((f) => {
      const row = document.createElement('div');
      row.className = 'setting-row' + (f.type === 'check' ? ' check' : '');
      const id = 'set-' + f.key;
      if (f.type === 'check') {
        const box = document.createElement('input');
        box.type = 'checkbox';
        box.id = id;
        box.checked = !!cfg[f.key];
        box.addEventListener('change', () => post('setConfig', { key: f.key, value: box.checked }));
        const label = document.createElement('label');
        label.htmlFor = id;
        label.textContent = f.label;
        row.appendChild(box);
        row.appendChild(label);
      } else {
        const label = document.createElement('label');
        label.htmlFor = id;
        label.textContent = f.label;
        const input = document.createElement('input');
        input.type = f.type;
        input.id = id;
        input.value = cfg[f.key] !== undefined ? String(cfg[f.key]) : '';
        if (f.min !== undefined) input.min = f.min;
        if (f.max !== undefined) input.max = f.max;
        input.addEventListener('change', () => post('setConfig', { key: f.key, value: input.value }));
        row.appendChild(label);
        row.appendChild(input);
      }
      settingsPanel.appendChild(row);
    });
    const link = document.createElement('div');
    link.className = 'settings-link';
    link.textContent = 'Edit in VS Code settings…';
    link.addEventListener('click', () => post('openSettings'));
    settingsPanel.appendChild(link);
  }

  /* ---------- history / conversation management ---------- */

  function ensureConv() {
    if (!conv) {
      conv = { id: Date.now(), model: modelSelect.value || 'gpt-4o', ts: Date.now(), title: '', messages: [] };
    }
    return conv;
  }

  function saveConv() {
    if (!conv || !conv.messages.length) return;
    const hist = state().history.filter((h) => h.id !== conv.id);
    const entry = {
      id: conv.id, model: conv.model, ts: conv.ts,
      title: conv.title, messages: conv.messages.slice(),
      thoughts: Object.assign({}, conv.thoughts || {}),
    };
    hist.push(entry);
    vscode.setState({ history: hist, conv });
  }

  function loadHistory(id) {
    const item = state().history.find((h) => h.id === id);
    if (!item) return;
    if (conv && conv.messages.length) saveConv();
    conv = { id: item.id, model: item.model, ts: item.ts, title: item.title, messages: item.messages.slice(), thoughts: Object.assign({}, item.thoughts || {}) };
    modelSelect.value = item.model || 'gpt-4o';
    persist();
    renderMessages();
    renderHistory();
    historyPanel.hidden = true;
    updateModelChip();
  }

  function deleteHistory(id) {
    const hist = state().history.filter((h) => h.id !== id);
    vscode.setState({ history: hist, conv });
    if (conv && conv.id === id) {
      conv = null;
      persist();
      renderMessages();
      updateModelChip();
    }
    renderHistory();
  }

  function clearChat() {
    if (!clearArmed) {
      clearArmed = true;
      clearBtn.classList.add('armed');
      clearBtn.title = 'Click again to confirm';
      clearTimer = setTimeout(() => {
        clearArmed = false;
        clearBtn.classList.remove('armed');
        clearBtn.title = 'Clear chat';
      }, 3000);
      return;
    }
    clearArmed = false;
    clearBtn.classList.remove('armed');
    clearBtn.title = 'Clear chat';
    if (clearTimer) { clearTimeout(clearTimer); clearTimer = null; }
    if (conv && conv.messages.length) saveConv();
    conv = null;
    persist();
    renderMessages();
    renderHistory();
    updateModelChip();
  }

  /* ---------- sending ---------- */

  function setModelOptions(models, current) {
    modelSelect.innerHTML = '';
    models.forEach((m) => {
      const opt = document.createElement('option');
      opt.value = m;
      opt.textContent = m;
      if (m === current) opt.selected = true;
      modelSelect.appendChild(opt);
    });
    if (!modelSelect.value && models.length) modelSelect.value = models[0];
    updateModelChip();
    setStatus('online');
  }

  function updateModelChip() {
    const m = (conv && conv.model) || modelSelect.value || '';
    modelChip.textContent = m || '—';
    modelChip.title = m ? 'Active model: ' + m : 'Active model';
    modelChip.classList.toggle('live', !!m);
  }

  function setStatus(kind) {
    statusDot.className = 'status-dot' + (kind ? ' ' + kind : '');
    statusDot.title = kind === 'online' ? 'Relay connected'
      : kind === 'offline' ? 'Relay unreachable'
        : kind === 'checking' ? 'Checking relay…' : 'Relay status unknown';
  }

  function finishBubble() {
    if (pendingBubble) {
      hideThinking();
      if (pendingThought && conv) {
        // discreet: private reasoning stays hoverable via a single icon inline with the reply
        attachThoughts(pendingBubble, pendingThought);
        if (!conv.thoughts) conv.thoughts = {};
        conv.thoughts[conv.messages.length - 1] = pendingThought;
      }
      pendingBubble.parentElement.classList.remove('pending');
      pendingBubble = null;
    }
    pendingText = '';
    pendingThought = '';
    busy = false;
    $('#send').disabled = false;
    scrollBottom();
  }

  function send() {
    if (busy) return;
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    ensureConv();
    if (!conv.title) conv.title = text.slice(0, 48);
    conv.messages.push({ role: 'user', content: text });
    const body = bubble('user');
    body.textContent = text;
    pendingBubble = bubble('assistant');
    const pendingDiv = pendingBubble.parentElement;
    pendingDiv.classList.add('pending');
    pendingDiv.classList.add('thinking');
    showThinking();
    topThink.hidden = false;
    busy = true;
    $('#send').disabled = true;
    persist();
    post('chat', {
      body: {
        model: conv.model,
        stream: true,
        messages: conv.messages.slice(),
        includeWorkspace,
        think: thinkEnabled,
        webSearch: webEnabled,
      },
    });
    scrollBottom();
  }

  /* ---------- extension-host messages ---------- */

  window.addEventListener('message', (event) => {
    const msg = event.data || {};
    switch (msg.type) {
      case 'config':
        configCache = msg;
        if (msg.model) {
          const opt = document.createElement('option');
          opt.value = msg.model;
          opt.textContent = msg.model;
          modelSelect.innerHTML = '';
          modelSelect.appendChild(opt);
        }
        endpointLine.textContent = msg.endpoint || '';
        setStatus('checking');
        if (msg.endpoint) post('fetchModels');
        break;
      case 'configSaved':
        configCache = msg.config || configCache;
        if (msg.config && msg.config.endpoint) endpointLine.textContent = msg.config.endpoint;
        break;
      case 'models':
        endpointLine.textContent = msg.endpoint || endpointLine.textContent;
        setModelOptions(msg.models, (conv && conv.model) || modelSelect.value || null);
        break;
      case 'delta':
        if (!pendingBubble) {
          pendingBubble = bubble('assistant');
          pendingBubble.parentElement.classList.add('pending');
        }
        if (!pendingText) hideThinking();
        pendingText += msg.text;
        pendingBubble.textContent = pendingText;
        scrollBottom();
        break;
      case 'done':
        if (pendingBubble && msg.full !== undefined) {
          pendingText = msg.full;
          pendingBubble.textContent = pendingText;
        }
        if (pendingText && pendingBubble && conv) {
          conv.messages.push({ role: 'assistant', content: pendingText });
          conv.ts = Date.now();
          saveConv();
        }
        finishBubble();
        if (msg.aborted) hint('(stopped)');
        break;
      case 'error':
        setStatus('offline');
        finishBubble();
        const err = document.createElement('div');
        err.className = 'bubble error';
        err.textContent = '⚠ ' + (msg.message || 'error');
        log.appendChild(err);
        scrollBottom();
        break;
      case 'thinking':
        if (pendingBubble && !thinkRow && !pendingText) showThinking();
        break;
      case 'thought':
        pendingThought = (msg.text || '').trim();
        if (thinkRow) thinkRow.title = 'Private reasoning:\n\n' + pendingThought;
        break;
      case 'searchInfo':
        webCount.textContent = msg.results
          ? `Web · ${msg.results} hits${msg.pages ? ' + ' + msg.pages + ' pages' : ''}`
          : 'Web';
        webCount.title = msg.query
          ? `Searched: "${msg.query}"${msg.playwright ? ' (Playwright)' : ''}`
          : '';
        break;
      case 'contextInfo':
        wsCount.textContent = msg.files
          ? `Workspace · ${msg.files} file${msg.files === 1 ? '' : 's'}`
          : 'Workspace';
        wsCount.title = msg.chars ? `~${Math.round(msg.chars / 1024)}KB of file context sent` : '';
        break;
      case 'workspaceState':
        wsCount.textContent = msg.files
          ? `Workspace · ${msg.files} file${msg.files === 1 ? '' : 's'}`
          : 'Workspace';
        if (!msg.workspaceFolders) {
          wsCount.title = 'No workspace folder open — only open-file contents are included.';
        }
        break;
      case 'reload':
        post('fetchModels');
        break;
      default:
        break;
    }
  });

  /* ---------- wiring ---------- */

  $('#send').addEventListener('click', send);
  $('#refresh').addEventListener('click', () => post('fetchModels'));
  wsCheck.addEventListener('change', () => {
    includeWorkspace = wsCheck.checked;
    vscode.setState(Object.assign(state(), { includeWorkspace }));
    post('workspaceToggle');
  });
  thinkCheck.addEventListener('change', () => {
    thinkEnabled = thinkCheck.checked;
    vscode.setState(Object.assign(state(), { thinkEnabled }));
  });
  webCheck.addEventListener('change', () => {
    webEnabled = webCheck.checked;
    vscode.setState(Object.assign(state(), { webEnabled }));
  });
  historyBtn.addEventListener('click', () => {
    historyPanel.hidden = !historyPanel.hidden;
    settingsPanel.hidden = true;
    searchResults.hidden = true;
    if (!historyPanel.hidden) renderHistory();
  });
  settingsBtn.addEventListener('click', () => {
    const open = settingsPanel.hidden;
    settingsPanel.hidden = !open;
    settingsBtn.classList.toggle('open', open);
    if (open) {
      historyPanel.hidden = true;
      searchResults.hidden = true;
      renderSettings();
    }
  });
  document.addEventListener('click', (e) => {
    if (!settingsPanel.hidden && !settingsPanel.contains(e.target) && !settingsBtn.contains(e.target)) {
      settingsPanel.hidden = true;
      settingsBtn.classList.remove('open');
    }
    if (!searchResults.hidden && !searchResults.contains(e.target) && !searchInput.contains(e.target)) {
      searchResults.hidden = true;
    }
    if (!historyPanel.hidden && !historyPanel.contains(e.target) && !historyBtn.contains(e.target)) {
      historyPanel.hidden = true;
    }
  });
  searchInput.addEventListener('input', () => {
    historyPanel.hidden = true;
    settingsPanel.hidden = true;
    renderSearch();
  });
  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      searchInput.value = '';
      renderSearch();
      searchInput.blur();
    }
  });
  clearBtn.addEventListener('click', clearChat);
  modelSelect.addEventListener('change', () => {
    if (conv) { conv.model = modelSelect.value; persist(); }
    updateModelChip();
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  });

  /* ---------- boot ---------- */

  const saved = state();
  if (saved.includeWorkspace !== undefined) {
    includeWorkspace = !!saved.includeWorkspace;
    wsCheck.checked = includeWorkspace;
  }
  if (saved.thinkEnabled !== undefined) {
    thinkEnabled = !!saved.thinkEnabled;
    thinkCheck.checked = thinkEnabled;
  }
  if (saved.webEnabled !== undefined) {
    webEnabled = !!saved.webEnabled;
    webCheck.checked = webEnabled;
  }
  if (saved.conv) {
    conv = saved.conv;
    modelSelect.innerHTML = '';
    const opt = document.createElement('option');
    opt.value = conv.model || 'gpt-4o';
    opt.textContent = conv.model || 'gpt-4o';
    modelSelect.appendChild(opt);
    renderMessages();
  }
  updateModelChip();
  post('getConfig');
})();
