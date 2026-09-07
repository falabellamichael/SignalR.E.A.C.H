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

  let conv = null;            // current conversation {id, model, ts, title, messages, thoughts}
  let busy = false;
  let pendingBubble = null;
  let pendingText = '';
  let clearArmed = false;
  let clearTimer = null;
  let includeWorkspace = true;
  let thinkEnabled = true;
  let pendingThought = '';

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

  function showThinking(body) {
    const spinner = document.createElement('span');
    spinner.className = 'think-spinner';
    spinner.setAttribute('aria-label', 'thinking');
    body.appendChild(spinner);
    body.closest('.bubble').classList.add('thinking');
  }

  function hideThinking(body) {
    const spinner = body.querySelector('.think-spinner');
    if (spinner) spinner.remove();
    const bub = body.closest('.bubble');
    if (bub) bub.classList.remove('thinking');
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
        const chip = document.createElement('span');
        chip.className = 'thought-chip';
        chip.textContent = '💭';
        chip.title = 'Private reasoning:\n\n' + conv.thoughts[idx];
        body.parentElement.appendChild(chip);
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
  }

  function deleteHistory(id) {
    const hist = state().history.filter((h) => h.id !== id);
    vscode.setState({ history: hist, conv });
    if (conv && conv.id === id) {
      conv = null;
      persist();
      renderMessages();
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
  }

  function finishBubble() {
    if (pendingBubble) {
      hideThinking(pendingBubble);
      if (pendingThought && conv) {
        // discreet: attach the private reasoning to the reply as a tooltip only
        const chip = document.createElement('span');
        chip.className = 'thought-chip';
        chip.textContent = '💭';
        chip.title = 'Private reasoning:\n\n' + pendingThought;
        pendingBubble.parentElement.appendChild(chip);
        if (!conv.thoughts) conv.thoughts = {};
        conv.thoughts[conv.messages.length - 1] = pendingThought;
      }
      pendingBubble.classList.remove('pending');
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
    pendingBubble.classList.add('pending');
    showThinking(pendingBubble);
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
      },
    });
    scrollBottom();
  }

  /* ---------- extension-host messages ---------- */

  window.addEventListener('message', (event) => {
    const msg = event.data || {};
    switch (msg.type) {
      case 'config':
        if (msg.model) {
          const opt = document.createElement('option');
          opt.value = msg.model;
          opt.textContent = msg.model;
          modelSelect.innerHTML = '';
          modelSelect.appendChild(opt);
        }
        endpointLine.textContent = msg.endpoint || '';
        if (msg.endpoint) post('fetchModels');
        break;
      case 'models':
        endpointLine.textContent = msg.endpoint || endpointLine.textContent;
        setModelOptions(msg.models, (conv && conv.model) || modelSelect.value || null);
        break;
      case 'delta':
        if (!pendingBubble) pendingBubble = bubble('assistant');
        if (!pendingText) hideThinking(pendingBubble);
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
        finishBubble();
        const err = document.createElement('div');
        err.className = 'bubble error';
        err.textContent = '⚠ ' + (msg.message || 'error');
        log.appendChild(err);
        scrollBottom();
        break;
      case 'thinking':
        if (pendingBubble) {
          const thinkSpinner = document.createElement('span');
          thinkSpinner.className = 'think-chip';
          thinkSpinner.textContent = '🧠 thinking…';
          pendingBubble.parentElement.appendChild(thinkSpinner);
        }
        break;
      case 'thought':
        pendingThought = (msg.text || '').trim();
        const chips = document.querySelectorAll('.think-chip');
        chips.forEach((c) => { c.textContent = '🧠'; c.title = 'Private reasoning:\n\n' + pendingThought; });
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
  historyBtn.addEventListener('click', () => {
    historyPanel.hidden = !historyPanel.hidden;
    if (!historyPanel.hidden) renderHistory();
  });
  clearBtn.addEventListener('click', clearChat);
  modelSelect.addEventListener('change', () => {
    if (conv) { conv.model = modelSelect.value; persist(); }
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
  if (saved.conv) {
    conv = saved.conv;
    modelSelect.innerHTML = '';
    const opt = document.createElement('option');
    opt.value = conv.model || 'gpt-4o';
    opt.textContent = conv.model || 'gpt-4o';
    modelSelect.appendChild(opt);
    renderMessages();
  }
  post('getConfig');
})();
