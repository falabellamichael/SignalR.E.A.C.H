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
  const agentCheck = $('#agent-check');
  const workspaceLine = $('#workspace-line');

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
  let agenticEnabled = true;
  let pendingEdits = [];
  const editCards = {};
  let stepRow = null;
  let stepTimer = null;
  let contTools = [];
  let contResolved = 0;
  let agentRounds = 0;
  const MAX_AGENT_ROUNDS = 4;
  const followUpQueue = [];
  const appliedEdits = [];

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
    endStep();
  }

  function thoughtIcon(title) {
    const icon = document.createElement('span');
    icon.className = 'thought-icon';
    icon.textContent = '💭';
    icon.title = 'Private reasoning:\n\n' + title;
    return icon;
  }

  function attachThoughts(body, title) {
    const bubbleEl = body.parentElement;
    const left = thoughtIcon(title);
    const right = thoughtIcon(title);
    body.prepend(document.createTextNode('... '));
    body.prepend(left);
    body.appendChild(document.createTextNode(' ...'));
    body.appendChild(right);
    const detail = document.createElement('div');
    detail.className = 'thought-detail';
    detail.textContent = title;
    detail.hidden = true;
    bubbleEl.insertAdjacentElement('afterend', detail);
    const toggle = () => { detail.hidden = !detail.hidden; };
    left.addEventListener('click', toggle);
    right.addEventListener('click', toggle);
  }

  /* ---------- agentic edits: parse, diff, render as Cursor-style cards ---------- */

  function repairJson(s) {
    // models often emit literal newlines inside JSON strings — escape them
    let out = '';
    let inStr = false;
    for (let i = 0; i < s.length; i += 1) {
      const c = s[i];
      if (c === '"' && (i === 0 || s[i - 1] !== '\\')) inStr = !inStr;
      if (inStr && c === '\n') out += '\\n';
      else if (inStr && c === '\t') out += '\\t';
      else out += c;
    }
    return out;
  }

  function extractEdits(text) {
    const edits = [];
    let clean = text || '';
    const re = /```edit\s*\n?([\s\S]*?)```/g;
    let m;
    while ((m = re.exec(text || ''))) {
      try {
        let parsed = JSON.parse(repairJson(m[1].trim()));
        if (Array.isArray(parsed)) parsed = { edits: parsed };
        const items = parsed && parsed.edits ? parsed.edits : [parsed];
        let allOk = items.length > 0;
        items.forEach((it) => {
          if (!it || typeof it.path !== 'string' || typeof it.search !== 'string' || typeof it.replace !== 'string') {
            allOk = false;
          } else {
            edits.push({ path: it.path.replace(/\\/g, '/'), search: it.search, replace: it.replace });
          }
        });
        if (allOk) clean = clean.replace(m[0], '');
      } catch (e) { /* leave unparseable block in the text */ }
    }
    return { text: clean.trim(), edits };
  }

  function extractTools(text) {
    const tools = [];
    let clean = text || '';
    const re = /```tool\s*\n?([\s\S]*?)```/g;
    let m;
    while ((m = re.exec(text || ''))) {
      try {
        const it = JSON.parse(repairJson(m[1].trim()));
        if (it && (it.action === 'read' || it.action === 'search' || it.action === 'list' || it.action === 'shell')) {
          tools.push({
            action: it.action,
            path: String(it.path || '').replace(/\\/g, '/'),
            pattern: String(it.pattern || '').slice(0, 200),
            command: String(it.command || '').slice(0, 1000),
          });
          clean = clean.replace(m[0], '');
        }
      } catch (e) { /* leave unparseable block in the text */ }
    }
    return { text: clean.trim(), tools };
  }

  function diffLines(a, b) {
    const n = a.length;
    const m = b.length;
    const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
    for (let i = n - 1; i >= 0; i -= 1) {
      for (let j = m - 1; j >= 0; j -= 1) {
        dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
    const raw = [];
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (a[i] === b[j]) { raw.push({ t: 'ctx', s: a[i] }); i += 1; j += 1; }
      else if (dp[i + 1][j] >= dp[i][j + 1]) { raw.push({ t: 'del', s: a[i] }); i += 1; }
      else { raw.push({ t: 'add', s: b[j] }); j += 1; }
    }
    while (i < n) { raw.push({ t: 'del', s: a[i] }); i += 1; }
    while (j < m) { raw.push({ t: 'add', s: b[j] }); j += 1; }
    // collapse long unchanged runs to keep cards tight
    const out = [];
    for (let k = 0; k < raw.length; k += 1) {
      if (raw[k].t !== 'ctx') { out.push(raw[k]); continue; }
      const near = raw.slice(Math.max(0, k - 2), k + 3).some((l) => l.t !== 'ctx');
      if (near) out.push(raw[k]);
      else out.push({ t: 'skip' });
    }
    const ded = [];
    let prevSkip = false;
    for (const l of out) {
      if (l.t === 'skip') { if (!prevSkip) ded.push(l); prevSkip = true; }
      else { ded.push(l); prevSkip = false; }
    }
    return ded;
  }

  function renderEditCards(afterEl, edits) {
    const cards = [];
    edits.forEach((ed, idx) => {
      const card = document.createElement('div');
      card.className = 'edit-card';
      const head = document.createElement('div');
      head.className = 'edit-head';
      const fname = document.createElement('span');
      fname.className = 'edit-path';
      fname.textContent = '📄 ' + ed.path;
      fname.title = ed.path;
      const kind = document.createElement('span');
      kind.className = 'edit-kind';
      kind.textContent = ed.search === '' ? 'new file' : 'edit';
      head.appendChild(fname);
      head.appendChild(kind);
      card.appendChild(head);
      const diff = document.createElement('div');
      diff.className = 'edit-diff';
      const isNew = ed.search === '';
      const lines = isNew
        ? ed.replace.split('\n').map((s) => ({ t: 'add', s }))
        : diffLines(ed.search.split('\n'), ed.replace.split('\n'));
      lines.forEach((l) => {
        const row = document.createElement('div');
        row.className = 'edit-line ' + (l.t === 'add' ? 'add' : l.t === 'del' ? 'del' : 'ctx');
        row.textContent = l.t === 'skip' ? '…' : ((l.t === 'add' ? '+ ' : l.t === 'del' ? '- ' : '  ') + l.s);
        diff.appendChild(row);
      });
      card.appendChild(diff);
      const actions = document.createElement('div');
      actions.className = 'edit-actions';
      const apply = document.createElement('button');
      apply.className = 'edit-btn apply';
      apply.textContent = '✓ Apply';
      const discard = document.createElement('button');
      discard.className = 'edit-btn';
      discard.textContent = '✕ Discard';
      const status = document.createElement('span');
      status.className = 'edit-status';
      const uid = Date.now().toString(36) + '-' + idx;
      editCards[uid] = {
        card,
        path: ed.path,
        status,
        disable: () => { apply.disabled = true; discard.disabled = true; },
      };
      apply.addEventListener('click', () => {
        startSteps();
        showStep('✍️ Applying edit to ' + ed.path + '…');
        post('applyEdit', { uid, path: ed.path, search: ed.search, replace: ed.replace });
      });
      discard.addEventListener('click', () => card.remove());
      actions.appendChild(apply);
      actions.appendChild(discard);
      actions.appendChild(status);
      card.appendChild(actions);
      log.insertBefore(card, afterEl.nextSibling);
      cards.push(card);
    });
    if (cards.length > 1) {
      const bar = document.createElement('div');
      bar.className = 'edit-allbar';
      const all = document.createElement('button');
      all.className = 'edit-btn apply';
      all.textContent = '⚡ Apply all (' + cards.length + ')';
      all.addEventListener('click', () => {
        cards.forEach((c) => {
          const ab = c.querySelector('.edit-btn.apply');
          if (ab && !ab.disabled) ab.click();
        });
      });
      bar.appendChild(all);
      log.insertBefore(bar, cards[0]);
    }
    scrollBottom();
  }

  /* ---------- rich rendering: markdown-lite + LaTeX (no CDN, CSP-safe) ---------- */

  const GREEK = {
    alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ε', zeta: 'ζ', eta: 'η',
    theta: 'θ', iota: 'ι', kappa: 'κ', lambda: 'λ', mu: 'μ', nu: 'ν', xi: 'ξ',
    pi: 'π', rho: 'ρ', sigma: 'σ', tau: 'τ', upsilon: 'υ', phi: 'φ', chi: 'χ',
    psi: 'ψ', omega: 'ω',
    Gamma: 'Γ', Delta: 'Δ', Theta: 'Θ', Lambda: 'Λ', Xi: 'Ξ', Pi: 'Π',
    Sigma: 'Σ', Phi: 'Φ', Psi: 'Ψ', Omega: 'Ω',
  };
  const SYMBOLS = {
    times: '×', cdot: '·', pm: '±', mp: '∓', le: '≤', leq: '≤', ge: '≥', geq: '≥',
    ne: '≠', neq: '≠', approx: '≈', sim: '∼', in: '∈', notin: '∉',
    subset: '⊂', subseteq: '⊆', supset: '⊃', supseteq: '⊇',
    forall: '∀', exists: '∃', infty: '∞', to: '→', rightarrow: '→',
    leftarrow: '←', leftrightarrow: '↔', uparrow: '↑', downarrow: '↓',
    sum: '∑', prod: '∏', int: '∫', iint: '∬', partial: '∂', nabla: '∇',
    ldots: '…', cdots: '⋯', dots: '…', propto: '∝', equiv: '≡',
    degree: '°', prime: '′', ast: '*', circ: '∘', cap: '∩', cup: '∪',
    langle: '⟨', rangle: '⟩', perp: '⊥', parallel: '∥', bigoplus: '⊕', bigotimes: '⊗',
  };

  function texToHtml(src) {
    const esc = (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const s = src || '';
    let i = 0;
    function grabGroup() {
      if (s[i] !== '{') return '';
      let depth = 0;
      let j = i;
      for (; j < s.length; j += 1) {
        if (s[j] === '{') depth += 1;
        else if (s[j] === '}') { depth -= 1; if (depth === 0) break; }
      }
      const g = s.slice(i + 1, j);
      i = j + 1;
      return g;
    }
    let out = '';
    while (i < s.length) {
      const c = s[i];
      if (c === '\\') {
        const m = s.slice(i).match(/^\\[a-zA-Z]+/);
        if (!m) { out += esc(c); i += 1; continue; }
        const cmd = m[0].slice(1);
        i += m[0].length;
        if (cmd === 'frac') {
          const num = grabGroup();
          const den = grabGroup();
          out += '<span class="tex-frac"><span class="tex-num">' + texToHtml(num)
            + '</span><span class="tex-den">' + texToHtml(den) + '</span></span>';
        } else if (cmd === 'sqrt') {
          const body = grabGroup();
          out += '<span class="tex-sqrt">√<span class="tex-sqrt-in">' + texToHtml(body) + '</span></span>';
        } else if (cmd === 'text') {
          out += esc(grabGroup());
        } else if (GREEK[cmd]) {
          out += GREEK[cmd];
        } else if (SYMBOLS[cmd]) {
          out += SYMBOLS[cmd];
        } else {
          out += esc('\\' + cmd);
        }
      } else if (c === '^' || c === '_') {
        const tag = c === '^' ? 'sup' : 'sub';
        i += 1;
        let content = '';
        if (s[i] === '{') {
          content = grabGroup();
        } else if (s[i] === '\\') {
          const cm = s.slice(i).match(/^\\[a-zA-Z]+/);
          content = cm ? cm[0] : s[i];
          i += content.length;
        } else {
          content = s[i] || '';
          i += 1;
        }
        out += '<' + tag + '>' + texToHtml(content) + '</' + tag + '>';
      } else if (c === '{' || c === '}') {
        i += 1;
      } else {
        out += esc(c);
        i += 1;
      }
    }
    return out;
  }

  function escapeHtml(t) {
    return t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function inlineMd(line) {
    const bm = line.match(/^\s*\$\$([\s\S]*?)\$\$\s*$/);
    if (bm) return '<div class="tex-block">' + texToHtml(bm[1]) + '</div>';
    let h = line
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*\w])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>')
      .replace(/`([^`]+)`/g, '<code>$1</code>');
    h = h.replace(/\$([^$\n]+)\$/g, (m0, t) => '<span class="tex">' + texToHtml(t) + '</span>');
    return h;
  }

  function setRich(el, text) {
    const src = String(text == null ? '' : text);
    const parts = src.split('```');
    let html = '';
    parts.forEach((p, idx) => {
      if (idx % 2 === 1) {
        const nl = p.indexOf('\n');
        const code = nl >= 0 ? p.slice(nl + 1) : p;
        html += '<div class="md-code-wrap"><pre class="md-code">' + escapeHtml(code) + '</pre></div>';
      } else {
        html += escapeHtml(p).split('\n').map(inlineMd).join('\n');
      }
    });
    el.innerHTML = html;
    attachRunButtons(el);
  }

  function attachRunButtons(root) {
    root.querySelectorAll('.md-code-wrap').forEach((wrap) => {
      if (wrap.querySelector('.run-btn')) return;
      const btn = document.createElement('button');
      btn.className = 'run-btn';
      btn.textContent = '▶ Run';
      btn.title = 'Run this code in the integrated terminal (asks for confirmation)';
      btn.addEventListener('click', () => {
        const pre = wrap.querySelector('.md-code');
        if (pre) post('runCode', { code: pre.textContent.trim().slice(0, 4000) });
      });
      wrap.appendChild(btn);
    });
  }

  function maskFenced(text) {
    return String(text || '').replace(/```(?:edit|tool)[\s\S]*?(?:```|$)/g, '…');
  }

  /* ---------- Cursor-style step tracker (real steps + funny filler) ---------- */

  const FUN_STEPS = [
    'Reading your files… 📂',
    'Searching the codebase… 🔎',
    'Untangling the spaghetti… 🍝',
    'Consulting the rubber duck… 🦆',
    'Asking the model nicely… 🙏',
    'Summoning the compute hamsters… 🐹',
    'Polishing the reply… ✨',
    'Adding semicolons for luck… ;)',
    'Making the magic happen… 🪄',
    'Waiting for the GPU to sneeze… 🤧',
    'Bribing the tokens with gold stars… ⭐',
    'Negotiating with the language model… 🤝',
    'Blowing on the CPU to keep it cool… 🌬️',
    'Reciting the codebase from memory… 📚',
    'Convincing the model it can do this… 💪',
    'Herding the tokens back into line… 🐑',
    'Interpreting the ancient scrolls… 📜',
    'Distilling pure gold from the reply… 🏺',
    'Defragmenting the thought process… 🧩',
    'Sending a carrier pigeon to the API… 🐦',
    'Jiggling the context window… 🪟',
    'Counting tokens like Scrooge McDuck… 🪙',
    'Warming up the matrix… 🟩',
    'Teaching the model table manners… 🍽️',
    'Fluffing the embedding pillows… 🛏️',
    'Aligning the stars and the API… 🌌',
    'Whispering sweet nothings to the parser… 💌',
    'Doing interpretive dance for the compiler… 💃',
    'Sacrificing a rubber chicken to the CI gods… 🐔',
    'Reinflating the context window… 🎈',
    'Polishing each token individually… 🧼',
    'Consulting the oracle of the stack trace… 🔮',
    'Performing percussive maintenance… 🔨',
    'Sending thoughts and prayers to the GPU… 📿',
    'Brewing a fresh pot of context… ☕',
    'Politely disagreeing with the linter… 🧐',
    'Flipping bits until they align… 🎛️',
    'Gently waking the sleeping thread… 😴',
    'Marinating the response in intelligence… 🍖',
    'Checking if it compiles by sheer willpower… 🧘',
  ];

  const FUN_APPLIED = [
    '✓ Applied — the code gods are pleased. ⚡',
    '✓ Applied — file updated, confetti optional. 🎉',
    '✓ Applied — another one bites the diff. 🦈',
    '✓ Applied — the bytes have been rearranged. 🧬',
    '✓ Applied — no bytes were harmed. 🐣',
    '✓ Applied — it compiles in spirit. 🙏',
  ];

  const ABORT_LINES = [
    '(stopped — the hamster needed a break 🐹)',
    '(stopped — mid-thought, but okay 🧠)',
    '(stopped — it was just getting to the good part… 📺)',
    '(stopped — the tokens have been returned to the wild 🦜)',
    '(stopped)',
  ];

  const QUEUE_LINES = [
    '(queued — will send after this reply)',
    '(queued — patiently waiting its turn ⏳)',
    '(queued — holding that thought for you 📌)',
  ];

  function pickFun(arr) {
    return arr[Math.floor(Math.random() * arr.length)];
  }

  function startSteps() {
    endStep();
    stepRow = document.createElement('div');
    stepRow.className = 'step-line';
    const spin = document.createElement('span');
    spin.className = 'mini-spin';
    stepRow.appendChild(spin);
    const txt = document.createElement('span');
    txt.className = 'step-text';
    stepRow.appendChild(txt);
    log.appendChild(stepRow);
    let last = '';
    const tick = () => {
      let pick = FUN_STEPS[Math.floor(Math.random() * FUN_STEPS.length)];
      if (pick === last) pick = FUN_STEPS[(FUN_STEPS.indexOf(pick) + 1) % FUN_STEPS.length];
      last = pick;
      if (stepRow) {
        const t = stepRow.querySelector('.step-text');
        if (t) t.textContent = pick;
      }
    };
    tick();
    stepTimer = setInterval(tick, 2800);
  }

  function showStep(text, done) {
    if (!stepRow) return;
    const t = stepRow.querySelector('.step-text');
    if (t) t.textContent = text;
    stepRow.className = 'step-line' + (done ? ' done' : '');
  }

  function endStep() {
    if (stepTimer) { clearInterval(stepTimer); stepTimer = null; }
    if (stepRow) { stepRow.remove(); stepRow = null; }
  }

  function beginToolRound(tools) {
    startSteps();
    contTools = tools.map((t) => Object.assign({}, t, {
      uid: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      result: null,
    }));
    contResolved = 0;
    contTools.forEach((t) => {
      const desc = t.action === 'read'
        ? 'Reading ' + t.path + '…'
        : t.action === 'search'
          ? 'Searching for "' + t.pattern + '"…'
          : t.action === 'list'
            ? 'Listing ' + (t.path || 'workspace') + '…'
            : 'Running: ' + t.command + '…';
      showStep(desc);
      post('toolReq', { uid: t.uid, action: t.action, path: t.path, pattern: t.pattern, command: t.command });
    });
  }

  function continueAgent() {
    if (!conv) return;
    const resultsText = contTools
      .map((t) => '[' + t.action + ' ' + (t.path || t.pattern || t.command) + ']\n' + t.result)
      .join('\n\n');
    const follow = (conv.messages || []).concat([
      { role: 'assistant', content: pendingText },
      { role: 'user', content: 'TOOL RESULTS (you asked for these — continue from where you stopped, '
        + 'then finish your reply; propose file changes as ```edit blocks):\n\n' + resultsText },
    ]);
    agentRounds += 1;
    showStep('Continuing with what I found…');
    post('chat', {
      body: {
        model: conv.model,
        stream: true,
        messages: follow,
        includeWorkspace: false,
        think: false,
        webSearch: false,
        agentic: true,
      },
    });
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
      setRich(body, m.content);
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
      conv = { id: Date.now(), model: modelSelect.value || 'gpt-4o-mini', ts: Date.now(), title: '', messages: [] };
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
    modelSelect.value = item.model || 'gpt-4o-mini';
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
    let cardsAfter = null;
    if (pendingBubble) {
      cardsAfter = pendingBubble.parentElement;
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
    if (cardsAfter && pendingEdits.length) {
      renderEditCards(cardsAfter, pendingEdits);
      pendingEdits = [];
    }
    busy = false;
    $('#send').disabled = false;
    $('#stop').disabled = true;
    scrollBottom();
    if (followUpQueue.length) {
      const next = followUpQueue.shift();
      startChat(next, true);
    }
  }

  function launchChat() {
    pendingBubble = bubble('assistant');
    const pendingDiv = pendingBubble.parentElement;
    pendingDiv.classList.add('pending');
    pendingDiv.classList.add('thinking');
    showThinking();
    topThink.hidden = false;
    startSteps();
    busy = true;
    $('#stop').disabled = false;
    persist();
    agentRounds = 0;
    pendingEdits = [];
    const msgs = conv.messages.slice();
    if (appliedEdits.length) {
      msgs.unshift({
        role: 'system',
        content: 'Files modified by applied edits since your last turn (assume their current on-disk contents): '
          + appliedEdits.join(', ') + '.',
      });
      appliedEdits.length = 0;
    }
    post('chat', {
      body: {
        model: conv.model,
        stream: true,
        messages: msgs,
        includeWorkspace,
        think: thinkEnabled,
        webSearch: webEnabled,
        agentic: agenticEnabled,
      },
    });
    scrollBottom();
  }

  function startChat(text, queued) {
    ensureConv();
    if (!queued) {
      if (!conv.title) conv.title = text.slice(0, 48);
      conv.messages.push({ role: 'user', content: text });
      setRich(bubble('user'), text);
      persist();
    }
    launchChat();
  }

  function send() {
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    if (busy) {
      // follow-up: fires the moment the current reply finishes
      ensureConv();
      conv.messages.push({ role: 'user', content: text });
      setRich(bubble('user'), text);
      persist();
      followUpQueue.push(text);
      hint(pickFun(QUEUE_LINES));
      scrollBottom();
      return;
    }
    startChat(text);
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
        setRich(pendingBubble, maskFenced(pendingText));
        scrollBottom();
        break;
      case 'done': {
        if (pendingBubble && msg.full !== undefined) {
          pendingText = msg.full;
          setRich(pendingBubble, maskFenced(pendingText));
        }
        let tools = [];
        if (agenticEnabled) {
          const parsedE = extractEdits(pendingText);
          if (parsedE.edits.length) pendingEdits = pendingEdits.concat(parsedE.edits);
          const parsedT = extractTools(parsedE.text);
          tools = parsedT.tools;
          if (parsedT.text !== pendingText) {
            pendingText = parsedT.text;
            if (pendingBubble) setRich(pendingBubble, pendingText);
          }
        }
        if (tools.length && agentRounds < MAX_AGENT_ROUNDS) {
          beginToolRound(tools);
          break;
        }
        if (tools.length) hint('(agent tool limit reached)');
        if (pendingText && pendingBubble && conv) {
          conv.messages.push({ role: 'assistant', content: pendingText });
          conv.ts = Date.now();
          saveConv();
        }
        finishBubble();
        if (msg.aborted) hint(pickFun(ABORT_LINES));
        break;
      }
      case 'toolResult': {
        if (!busy) break;
        const t = contTools.find((x) => x.uid === msg.uid);
        if (!t) break;
        t.result = msg.ok ? msg.result : 'ERROR: ' + (msg.error || 'failed');
        contResolved += 1;
        showStep('✓ ' + (t.action === 'read'
          ? 'Read ' + t.path
          : t.action === 'search'
            ? 'Searched "' + t.pattern + '"'
            : t.action === 'list'
              ? 'Listed ' + (t.path || 'workspace')
              : 'Command sent to terminal'));
        if (contResolved >= contTools.length) continueAgent();
        break;
      }
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
        showStep('🧠 WhisperThink — reasoning privately…');
        break;
      case 'thought':
        pendingThought = (msg.text || '').trim();
        if (thinkRow) thinkRow.title = 'Private reasoning:\n\n' + pendingThought;
        break;
      case 'searchInfo':
        showStep(msg.results
          ? `🔎 Web search — ${msg.results} hit${msg.results === 1 ? '' : 's'} found`
          : '🔎 Searching the web…');
        webCount.textContent = msg.results
          ? `Web · ${msg.results} hits${msg.pages ? ' + ' + msg.pages + ' pages' : ''}`
          : 'Web';
        webCount.title = msg.query
          ? `Searched: "${msg.query}"${msg.playwright ? ' (Playwright)' : ''}`
          : '';
        break;
      case 'contextInfo':
        showStep(`📂 Read ${msg.files} workspace file${msg.files === 1 ? '' : 's'} (~${Math.round((msg.chars || 0) / 1024)}KB)`);
        wsCount.textContent = msg.files
          ? `Workspace · ${msg.files} file${msg.files === 1 ? '' : 's'}`
          : 'Workspace';
        wsCount.title = msg.chars ? `~${Math.round(msg.chars / 1024)}KB of file context sent` : '';
        break;
      case 'workspaceState':
        wsCount.textContent = msg.files
          ? `Workspace · ${msg.files} file${msg.files === 1 ? '' : 's'}`
          : 'Workspace';
        if (msg.roots && msg.roots.length) {
          workspaceLine.textContent = '📁 ' + msg.roots[0];
          workspaceLine.title = msg.roots.join('\n');
          workspaceLine.hidden = false;
        } else {
          workspaceLine.textContent = '';
          workspaceLine.hidden = true;
        }
        if (!msg.workspaceFolders) {
          wsCount.title = 'No workspace folder open — only open-file contents are included.';
        }
        break;
      case 'reload':
        post('fetchModels');
        break;
      case 'editResult': {
        const rec = editCards[msg.uid];
        if (!rec) break;
        if (msg.ok) {
          if (Math.random() < 0.5) showStep(pickFun(FUN_APPLIED), true);
          else showStep('✓ Applied ' + msg.path, true);
          setTimeout(endStep, 2500);
          if (!appliedEdits.includes(msg.path)) appliedEdits.push(msg.path);
          rec.status.textContent = '✓ applied';
          rec.status.className = 'edit-status ok';
        } else {
          endStep();
          rec.status.textContent = '⚠ ' + (msg.error || 'failed');
          rec.status.className = 'edit-status err';
          rec.disable();
          const rb = document.createElement('button');
          rb.className = 'edit-btn';
          rb.textContent = '↻ Re-propose';
          rb.addEventListener('click', () => {
            rb.disabled = true;
            startChat('Your proposed edit to "' + (msg.path || rec.path) + '" failed: '
              + (msg.error || 'error') + '. Re-propose the edit with corrected "search" text in a new ```edit block.');
          });
          const acts = rec.card.querySelector('.edit-actions');
          if (acts) acts.insertBefore(rb, rec.status);
        }
        rec.disable();
        break;
      }
      default:
        break;
    }
  });

  /* ---------- wiring ---------- */

  $('#send').addEventListener('click', send);
  $('#stop').addEventListener('click', () => {
    if (busy) post('abort');
  });
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
  agentCheck.addEventListener('change', () => {
    agenticEnabled = agentCheck.checked;
    vscode.setState(Object.assign(state(), { agenticEnabled }));
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
  if (saved.agenticEnabled !== undefined) {
    agenticEnabled = !!saved.agenticEnabled;
    agentCheck.checked = agenticEnabled;
  }
  if (saved.conv) {
    conv = saved.conv;
    modelSelect.innerHTML = '';
    const opt = document.createElement('option');
    opt.value = conv.model || 'gpt-4o-mini';
    opt.textContent = conv.model || 'gpt-4o-mini';
    modelSelect.appendChild(opt);
    renderMessages();
  }
  updateModelChip();
  post('getConfig');
  post('workspaceInfo');
})();
