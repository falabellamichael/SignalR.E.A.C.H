/* REACH chat — webview script. Talks to the extension host exclusively via postMessage.
 * History + current conversation persist in the webview state (survives reloads). */
(function () {
  const vscode = window.acquireVsCodeApi ? window.acquireVsCodeApi() : null;
  if (!vscode) return;

  const $ = (sel) => document.querySelector(sel);
  const log = $('#log');
  const input = $('#input');
  const modelSelect = $('#model');
  const providerSelect = $('#provider');
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
  const trayBtn = $('#tray-btn');
  const browserBtn = $('#browser-btn');
  const settingsPanel = $('#settings-panel');
  const topThink = $('#top-think');
  const modelChip = $('#model-chip');
  const statusDot = $('#status-dot');
  const agentCheck = $('#agent-check');
  const workspaceLine = $('#workspace-line');
  const attachBtn = $('#attach-btn');
  const attachClear = $('#attach-clear');
  const attachMenu = $('#attach-menu');
  const attachChips = $('#attach-chips');
  const togglesRow = document.querySelector('.row.toggles');

  let conv = null;            // current conversation {id, model, ts, title, messages, thoughts}
  let busy = false;
  let pendingBubble = null;
  let thinkRow = null;
  let pendingText = '';
  // Frame-batched streaming render: deltas accumulate instantly, but the
  // bubble re-renders at most once per animation frame. Re-rendering per
  // delta can fire 100+ full markdown re-parses per second and makes the
  // stream look jerky.
  let rafPending = false;
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
  let stepsEl = null;        // Copilot-style work-log container (step stack)
  let stepRows = [];         // visible narration rows
  let rowByUid = {};         // tool uid -> row, so results can tick their own line
  let activeTrace = null;
  let activeTraceConvId = null;
  let activeResponseStep = null;

  let contTools = [];
  let contResolved = 0;
  let agentRounds = 0;
  let continuationRetries = 0;
  let stopRequested = false;
  let agentMessages = [];
  let activeRequestLength = 0;
  let activeRequestConvId = null;
  let contextRevision = 0;
  let activeContextRevision = 0;
  const MAX_AGENT_ROUNDS = 40;
  const followUpQueue = [];
  const appliedEdits = [];
  const attachments = [];
  const MAX_ATTACHMENTS = 6;

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
    // removing a block leaves its surrounding blank lines behind; pre-wrap
    // would render each as vertical space — collapse runs of 3+ to one blank
    clean = clean.replace(/\n{3,}/g, '\n\n');
    return { text: clean.trim(), edits };
  }

  function extractTools(text) {
    const tools = [];
    let clean = text || '';
    // Providers use both fenced tool blocks and XML wrappers. Only explicit,
    // complete wrappers are executable; ordinary JSON remains chat content.
    const re = /```tool\s*\n?([\s\S]*?)```|<tool\s*>([\s\S]*?)<\/tool\s*>/gi;
    let m;
    while ((m = re.exec(text || ''))) {
      try {
        const it = JSON.parse(repairJson((m[1] === undefined ? m[2] : m[1]).trim()));
        const allowedTool = ['read', 'search', 'list', 'shell', 'browse', 'websearch'];
        if (it && allowedTool.includes(it.action)) {
          tools.push({
            action: it.action,
            path: String(it.path || '').replace(/\\/g, '/'),
            startLine: it.startLine ?? it.start_line,
            endLine: it.endLine ?? it.end_line,
            pattern: String(it.pattern || '').slice(0, 200),
            command: String(it.command || '').slice(0, 1000),
            url: String(it.url || '').slice(0, 800),
            query: String(it.query || '').slice(0, 200),
          });
          clean = clean.replace(m[0], '');
        }
      } catch (e) { /* leave unparseable block in the text */ }
    }
    clean = clean.replace(/\n{3,}/g, '\n\n');
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
    const batch = document.createElement('section');
    batch.className = 'edit-batch';
    batch.setAttribute('aria-label', 'Proposed edits');
    const bar = document.createElement('div');
    bar.className = 'edit-allbar';
    const title = document.createElement('strong');
    title.className = 'edit-batch-title';
    bar.appendChild(title);
    const records = [];
    let applyingBatch = false;
    const button = (label, kind, handler) => {
      const el = document.createElement('button');
      el.type = 'button'; el.className = 'edit-btn ' + kind; el.textContent = label;
      el.addEventListener('click', handler);
      return el;
    };
    const allReview = button('Review all', 'review', () => {
      records.filter(r => r.state === 'pending').forEach(r => r.review());
    });
    const allApply = button('Apply all', 'apply', async () => {
      if (applyingBatch) return;
      applyingBatch = true; updateBatch();
      for (const rec of records) {
        if (rec.state === 'pending' && !await rec.apply()) break;
      }
      applyingBatch = false; updateBatch();
    });
    const allReject = button('Reject all', 'reject', () => {
      records.forEach(r => r.reject());
    });
    allReject.title = 'Reject edits that have not been applied';
    bar.append(allReview, allApply, allReject);
    batch.appendChild(bar);
    function updateBatch() {
      const pending = records.filter(r => r.state === 'pending').length;
      const rejected = records.filter(r => r.state === 'rejected').length;
      const applied = records.filter(r => r.state === 'applied').length;
      const failed = records.filter(r => r.state === 'failed').length;
      const inFlight = records.some(r => r.state === 'applying');
      records.filter(r => r.state === 'pending').forEach(r => { r.applyButton.disabled = inFlight || applyingBatch; });
      title.textContent = pending ? pending + ' proposed edit' + (pending === 1 ? '' : 's')
        : records.some(r => r.state === 'applying') ? 'Applying edits…'
        : failed ? failed + ' failed edit' + (failed === 1 ? '' : 's') : 'Edits resolved';
      title.title = applied + ' applied, ' + rejected + ' rejected';
      allReview.disabled = !pending;
      allApply.disabled = !pending || applyingBatch || inFlight;
      allReject.disabled = !records.some(r => r.state === 'pending' || r.state === 'failed');
      allApply.textContent = applyingBatch ? 'Applying…' : 'Apply all';
    }
    edits.forEach((ed, idx) => {
      const card = document.createElement('div');
      card.className = 'edit-card';
      const head = document.createElement('div');
      head.className = 'edit-head';
      const fname = document.createElement('span');
      fname.className = 'edit-path'; fname.textContent = ed.path; fname.title = ed.path;
      const kind = document.createElement('span');
      kind.className = 'edit-kind'; kind.textContent = ed.search === '' ? 'New file' : 'Edit';
      head.append(fname, kind); card.appendChild(head);
      const preview = document.createElement('details');
      preview.className = 'edit-preview';
      const summary = document.createElement('summary');
      const lines = ed.search === '' ? ed.replace.split('\n').map(s => ({ t: 'add', s }))
        : diffLines(ed.search.split('\n'), ed.replace.split('\n'));
      summary.textContent = 'Changes · +' + lines.filter(l => l.t === 'add').length
        + ' / −' + lines.filter(l => l.t === 'del').length;
      preview.appendChild(summary);
      const diff = document.createElement('div');
      diff.className = 'edit-diff';
      lines.forEach(l => {
        const row = document.createElement('div');
        row.className = 'edit-line ' + (l.t === 'skip' ? 'ctx' : l.t);
        row.textContent = l.t === 'skip' ? '…' : (l.t === 'add' ? '+ ' : l.t === 'del' ? '- ' : '  ') + l.s;
        diff.appendChild(row);
      });
      preview.appendChild(diff); card.appendChild(preview);
      const actions = document.createElement('div'); actions.className = 'edit-actions';
      const status = document.createElement('span'); status.className = 'edit-status';
      status.setAttribute('role', 'status');
      const uid = Date.now().toString(36) + '-' + idx + '-' + Math.random().toString(36).slice(2, 7);
      let resolveApply;
      const rec = {
        card, path: ed.path, status, state: 'pending',
        disable: () => { review.disabled = true; apply.disabled = true; reject.disabled = true; refresh.disabled = true; },
        showRefresh: () => { refresh.hidden = false; refresh.disabled = false; },
        review: () => {
          if (rec.state !== 'pending') return;
          post('reviewEdit', { uid, path: ed.path, search: ed.search, replace: ed.replace });
        },
        apply: () => {
          if (rec.state !== 'pending') return Promise.resolve(false);
          rec.state = 'applying'; rec.disable();
          status.textContent = 'Applying…'; updateBatch();
          const done = new Promise(resolve => { resolveApply = resolve; });
          post('applyEdit', { uid, path: ed.path, search: ed.search, replace: ed.replace });
          return done;
        },
        reject: () => {
          if (!['pending', 'failed'].includes(rec.state)) return;
          rec.state = 'rejected'; rec.disable(); preview.open = false;
          card.classList.add('rejected');
          status.textContent = 'Rejected'; status.className = 'edit-status';
          const retry = actions.querySelector('.repropose');
          if (retry) retry.remove();
          updateBatch();
        },
        finish: ok => {
          rec.state = ok ? 'applied' : 'failed'; rec.disable();
          if (!ok) reject.disabled = false;
          else { preview.open = false; card.classList.add('applied'); }
          updateBatch();
          if (resolveApply) { resolveApply(ok); resolveApply = null; }
        },
      };
      const review = button('Review', 'review', rec.review);
      const apply = button('Apply', 'apply', rec.apply);
      const reject = button('Reject', 'reject', rec.reject);
      const refresh = button('Refresh edit', 'refresh', () => {
        if (rec.state === 'rejected' || rec.state === 'applied') return;
        refresh.disabled = true;
        status.textContent = 'Reading current source…'; status.className = 'edit-status';
        post('refreshEdit', { uid, path: ed.path, search: ed.search, replace: ed.replace, model: conv && conv.model });
      });
      refresh.hidden = true;
      review.setAttribute('aria-label', 'Review ' + ed.path);
      apply.setAttribute('aria-label', 'Apply ' + ed.path);
      reject.setAttribute('aria-label', 'Reject ' + ed.path);
      rec.applyButton = apply;
      actions.append(review, apply, reject, refresh, status); card.appendChild(actions);
      editCards[uid] = rec; records.push(rec); batch.appendChild(card);
    });
    updateBatch();
    log.insertBefore(batch, afterEl.nextSibling);
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
        let t = escapeHtml(p).split('\n').map(inlineMd).join('\n');
        // The code div is block-level (it breaks the line itself); under the
        // body's white-space:pre-wrap, any newline adjacent to it renders as
        // an EXTRA blank line — the big gaps around code blocks. Eat them.
        if (idx > 0) t = t.replace(/^\n+/, '');
        if (idx < parts.length - 1) t = t.replace(/\n+$/, '');
        html += t;
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
    let out = String(text || '')
      .replace(/```(?:edit|tool)[\s\S]*?(?:```|$)/gi, '…')
      .replace(/<tool\s*>[\s\S]*?(?:<\/tool\s*>|$)/gi, '…');
    // Adjacent masked blocks separated by ONLY whitespace collapse to a single
    // ellipsis — otherwise a run of ```tool blocks streams as a full-height
    // wall of "…" rows (pre-wrap renders the blank lines between them). Real
    // prose between blocks is preserved (\s* won't match across it).
    while (/…\s*…/.test(out)) out = out.replace(/…\s*…/g, '…');
    out = out.replace(/\n{3,}/g, '\n\n');
    return out.trim();
  }

  /* ---------- Cursor-style step tracker (real steps + funny filler) ---------- */

  const ABORT_LINES = ['Stopped.'];
  const QUEUE_LINES = ['Queued — will send after this reply.'];

  function pickFun(arr) {
    return arr[Math.floor(Math.random() * arr.length)];
  }

  function createTimeline(trace, beforeEl) {
    const region = document.createElement('section');
    region.className = 'steps'; region.setAttribute('aria-label', 'Agent activity');
    const title = document.createElement('div'); title.className = 'steps-title'; title.textContent = 'Agent activity';
    region.appendChild(title);
    log.insertBefore(region, beforeEl || null);
    return region;
  }

  function paintStep(region, record, fullResult) {
    const el = document.createElement('article'); el.className = 'step-line';
    const head = document.createElement('div'); head.className = 'step-head';
    const spin = document.createElement('span'); spin.className = 'mini-spin'; spin.setAttribute('aria-hidden', 'true');
    const text = document.createElement('span'); text.className = 'step-text'; text.textContent = record.title;
    const state = document.createElement('span'); state.className = 'step-state';
    head.append(spin, text, state); el.appendChild(head);
    const output = document.createElement('div'); output.className = 'step-output'; el.appendChild(output);
    region.appendChild(el);
    const row = { el, textEl: text, stateEl: state, outputEl: output, record, real: true,
      closed: record.status !== 'running', uid: record.uid || null };
    updateStep(row, record.status, fullResult === undefined ? record.result : fullResult, false);
    return row;
  }

  function saveSteps() {
    if (conv && activeTrace && conv.id === activeTraceConvId) { persist(); saveConv(); }
  }

  function startSteps() {
    if (stepsEl) return;
    activeTrace = { before: busy ? activeRequestLength : (conv ? conv.messages.length : 0), steps: [] };
    activeTraceConvId = conv && conv.id;
    if (conv) { if (!conv.activity) conv.activity = []; conv.activity.push(activeTrace); }
    stepsEl = createTimeline(activeTrace, pendingBubble && pendingBubble.parentElement);
  }

  function addStepRow(uid, text, title) {
    if (!stepsEl) startSteps();
    const record = { uid: uid || null, title: title || text || 'Preparing request', status: 'running', result: '' };
    activeTrace.steps.push(record);
    const row = paintStep(stepsEl, record);
    if (uid) rowByUid[uid] = row;
    stepRows.push(row); saveSteps(); scrollBottom();
    return row;
  }

  function updateStep(row, status, result, save = true) {
    if (!row) return;
    row.record.status = status || 'completed'; row.closed = row.record.status !== 'running';
    row.el.className = 'step-line ' + row.record.status;
    row.stateEl.textContent = { running: 'Running', completed: 'Done', error: 'Failed', cancelled: 'Stopped' }[row.record.status] || row.record.status;
    row.outputEl.replaceChildren();
    const text = String(result || '');
    if (save) { row.record.result = text.slice(0, 12000); row.record.resultChars = text.length; }
    const total = Math.max(text.length, row.record.resultChars || 0);
    if (text) {
      const preview = document.createElement('pre'); preview.className = 'step-result';
      preview.textContent = text.length > 1200 ? text.slice(0, 1200) + '\n…' : text;
      row.outputEl.appendChild(preview);
      if (text.length > 1200) {
        const details = document.createElement('details'); details.className = 'step-details';
        const label = document.createElement('summary');
        label.textContent = text.length < total ? 'Expand saved output preview' : 'Show full result (' + total.toLocaleString() + ' characters)';
        details.appendChild(label);
        details.addEventListener('toggle', () => {
          if (details.open && !details.querySelector('pre')) {
            const full = document.createElement('pre'); full.className = 'step-result'; full.textContent = text; details.appendChild(full);
          }
        });
        row.outputEl.appendChild(details);
      }
      if (text.length < total) {
        const note = document.createElement('div'); note.className = 'step-preview-note';
        note.textContent = 'Saved first ' + text.length.toLocaleString() + ' of ' + total.toLocaleString() + ' characters.';
        row.outputEl.appendChild(note);
      }
    } else if (status === 'running') {
      row.outputEl.textContent = 'Waiting for result…';
    }
    if (save) saveSteps();
  }

  function closeStep(row, result, status = 'completed') {
    if (!row) return;
    updateStep(row, status, result === undefined ? (row.record.result || 'Completed.') : result);
  }

  function showStep(text, done, title, result) {
    if (!stepsEl) startSteps();
    const previous = stepRows[stepRows.length - 1];
    if (previous && !previous.closed && !previous.uid) closeStep(previous);
    const row = addStepRow(null, text, title);
    if (done) closeStep(row, result || text);
    return row;
  }

  function endStep(status = 'completed') {
    stepRows.filter(row => !row.closed).forEach(row => closeStep(row,
      status === 'cancelled' ? 'Stopped before a result was returned.' : status === 'error' ? 'The request ended with an error.' : 'Completed.', status));
    saveSteps();
    // Keep the rendered timeline and saved records; detach only active handles.
    stepsEl = null; activeTrace = null; stepRows = []; rowByUid = {}; activeResponseStep = null;
  }

  function restoreTimelines(before) {
    for (const trace of (conv && conv.activity) || []) {
      if (trace.before !== before) continue;
      const region = createTimeline(trace);
      for (const record of trace.steps) {
        const saved = record.status === 'running' ? { ...record, status: 'cancelled', result: 'Interrupted before a result was saved.' } : record;
        paintStep(region, saved);
      }
    }
  }

  function beginToolRound(tools) {
    startSteps();

    contTools = tools.map((t) => Object.assign({}, t, {
      uid: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      result: null,
    }));
    contResolved = 0;
    if (pendingBubble) { pendingBubble.textContent = ''; showThinking(); }
    contTools.forEach((t) => {
      const detail = t.action === 'read'
        ? t.path
        : t.action === 'search'
          ? t.pattern
          : t.action === 'list'
            ? (t.path || 'the workspace')
            : t.action === 'browse'
              ? t.url
              : t.action === 'websearch'
                ? t.query
                : t.command;
      const label = {read:'Read',search:'Search',list:'List',shell:'Run command',browse:'Browse',websearch:'Web search'}[t.action] || t.action;
      addStepRow(t.uid, label + ': ' + detail);
      post('toolReq', { uid: t.uid, action: t.action, path: t.path, startLine: t.startLine, endLine: t.endLine, pattern: t.pattern, command: t.command, url: t.url, query: t.query });
    });
  }

  function isUnfinishedUpdate(text) {
    const prose = String(text || '').replace(/```[\s\S]*?(?:```|$)/g, '').trim();
    // Recover clear promises of immediate work, not offers, questions, or
    // explanations that describe what somebody else could do.
    if (!prose || prose.length > 1800 || /\?|\b(?:if you|would you|let me know|need your|awaiting|approval|permission|blocked|cannot|can't)\b/i.test(prose)) return false;
    return /(?:^|[.!…\n]\s*)(?:(?:first|next|now|then)[,:]?\s+)?I(?:['’]ll| will|['’]m going to| am going to)\s+(?:continue|scan|inspect|read|search|check|review|investigate|fix|update|implement|patch|run|test|look|start|work|make|clean|refactor)\b/i.test(prose);
  }

  function continueAgent(instruction) {
    if (!conv) return;
    const resultsText = contTools
      .map((t) => '[' + t.action + ' ' + (t.path || t.pattern || t.command || t.url || t.query) + ']\n' + t.result)
      .join('\n\n');
    const follow = agentMessages.concat([
      { role: 'assistant', content: pendingText },
      { role: 'user', content: instruction || 'TOOL RESULTS (you asked for these — continue from where you stopped, '
        + 'then finish your reply; propose file changes as ```edit blocks):\n\n' + resultsText },
    ]);
    agentMessages = follow;
    pendingText = '';
    agentRounds += 1;
    if (pendingBubble) { pendingBubble.textContent = ''; showThinking(); }
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

  /* ---------- per-message actions (Copy / Retry / Delete / Edit) ---------- */

  function copyText(text) {
    const t = String(text || '');
    if (!t) return;
    const done = () => hint('Copied to clipboard');
    const legacy = () => {
      const ta = document.createElement('textarea');
      ta.value = t;
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); hint('Copied to clipboard'); }
      catch (e) { hint('Copy failed'); }
      document.body.removeChild(ta);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(t).then(done).catch(legacy);
    } else legacy();
  }

  function addMessageButtons(role, body, index) {
    const bubbleEl = body.parentElement;
    bubbleEl.classList.add('has-actions');
    const bar = document.createElement('div');
    bar.className = 'msg-actions';
    const mk = (label, title, cb) => {
      const b = document.createElement('button');
      b.className = 'msg-act';
      b.textContent = label;
      b.title = title;
      b.addEventListener('click', cb);
      return b;
    };
    const content = () => {
      const m = conv && conv.messages[index];
      return (m && m.content) || body.innerText || '';
    };
    const group = document.createElement('span');
    group.className = 'msg-act-group';
    group.appendChild(mk('Copy', 'Copy message', () => copyText(content())));
    group.appendChild(mk('Retry', 'Regenerate from this point', () => retryAt(index)));
    group.appendChild(mk('Delete', 'Delete this message', () => deleteMsgAt(index)));
    bar.appendChild(group);
    const edit = mk('Edit', 'Edit this message', () => editMsgAt(body, role, index));
    edit.classList.add('msg-act-edit');
    bar.appendChild(edit);
    bubbleEl.appendChild(bar);
  }

  function retryAt(index) {
    if (!conv) return;
    if (busy) { hint('Wait for the current reply to finish.'); return; }
    const role = conv.messages[index] && conv.messages[index].role;
    if (!role) return;
    const end = role === 'assistant' ? index : index + 1;
    if (conv.requestContext && conv.requestContext.through > end) delete conv.requestContext;
    contextRevision++;
    conv.messages = conv.messages.slice(0, end);
    conv.activity = (conv.activity || []).filter(t => t.before < end);
    persist();
    renderMessages();
    launchChat();
  }

  function deleteMsgAt(index) {
    if (!conv) return;
    const t = conv.thoughts || {};
    const thoughtsArr = [];
    conv.messages.forEach((m, i) => { if (t[i] != null) thoughtsArr[i] = t[i]; });
    delete conv.requestContext; contextRevision++;
    conv.messages.splice(index, 1);
    conv.activity = (conv.activity || []).filter(t => t.before !== index + 1).map(t => ({ ...t, before: t.before > index ? t.before - 1 : t.before }));
    thoughtsArr.splice(index, 1);
    conv.thoughts = {};
    thoughtsArr.forEach((th, i) => { if (th != null) conv.thoughts[i] = th; });
    persist();
    saveConv();
    renderMessages();
    scrollBottom();
  }

  function editMsgAt(body, role, index) {
    if (!conv) return;
    const msg = conv.messages[index];
    if (!msg) return;
    const bubbleEl = body.parentElement;
    const content = String(msg.content == null ? '' : msg.content);
    const editor = document.createElement('textarea');
    editor.className = 'msg-edit';
    editor.value = content;
    const normalActions = bubbleEl.querySelector('.msg-actions');
    body.hidden = true;
    bubbleEl.insertBefore(editor, body);
    if (normalActions) normalActions.hidden = true;
    const editBar = document.createElement('div');
    editBar.className = 'msg-actions';
    editBar.classList.add('edit-bar');
    const save = document.createElement('button');
    save.className = 'msg-act';
    save.textContent = 'Save';
    const cancel = document.createElement('button');
    cancel.className = 'msg-act';
    cancel.textContent = 'Cancel';
    editBar.appendChild(save);
    editBar.appendChild(cancel);
    bubbleEl.appendChild(editBar);
    editor.focus();
    editor.setSelectionRange(editor.value.length, editor.value.length);
    const done = (apply) => {
      if (apply) {
        const next = editor.value;
        delete conv.requestContext; contextRevision++;
        conv.messages[index].content = next;
        conv.activity = (conv.activity || []).filter(t => t.before <= index);
        persist();
        saveConv();
      }
      editor.remove();
      editBar.remove();
      body.hidden = false;
      if (normalActions) normalActions.hidden = false;
      if (apply) renderMessages();
    };
    cancel.addEventListener('click', () => done(false));
    save.addEventListener('click', () => done(true));
    editor.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); save.click(); }
      else if (e.key === 'Escape') { e.preventDefault(); cancel.click(); }
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
      restoreTimelines(idx);
      const body = bubble(m.role);
      setRich(body, m.content);
      if (m.role === 'assistant' && conv.thoughts && conv.thoughts[idx]) {
        attachThoughts(body, conv.thoughts[idx]);
      }
      addMessageButtons(m.role, body, idx);
    });
    restoreTimelines(msgs.length);
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

  function updateProviderOptions(cfg) {
    providerSelect.replaceChildren(new Option('Free endpoints', 'endpoint'));
    const others = document.createElement('optgroup');
    others.label = 'Other providers';
    for (const endpoint of new Set(cfg.additionalEndpoints || [])) {
      if (endpoint.trim()) others.appendChild(new Option(endpoint, 'endpoint:' + endpoint));
    }
    others.appendChild(new Option('Microsoft 365 Copilot', 'copilot'));
    providerSelect.appendChild(others);
    providerSelect.value = cfg.providerSelection || cfg.provider || 'endpoint';
  }

  function renderSettings() {
    const cfg = configCache || {};
    settingsPanel.innerHTML = '';
    const endpoints = document.createElement('div');
    endpoints.className = 'setting-endpoints';
    const endpointLabel = document.createElement('label');
    endpointLabel.htmlFor = 'set-endpoint';
    endpointLabel.textContent = 'Endpoint';
    endpoints.appendChild(endpointLabel);
    const endpointRows = document.createElement('div');
    endpointRows.className = 'endpoint-rows';
    endpoints.appendChild(endpointRows);
    let nextEndpointId = 0;
    const saveAdditional = () => post('setConfig', {
      key: 'additionalEndpoints',
      value: Array.from(endpointRows.querySelectorAll('.endpoint-url')).slice(1).map(input => input.value.trim()),
    });
    function addEndpoint(value, first = false) {
      const entry = document.createElement('div');
      entry.className = 'endpoint-entry';
      const row = document.createElement('div');
      row.className = 'setting-row endpoint-row';
      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'endpoint-url';
      input.value = value;
      input.placeholder = 'https://your-endpoint/v1';
      input.spellcheck = false;
      input.setAttribute('aria-label', first ? 'Endpoint' : 'Additional endpoint');
      if (first) {
        input.id = 'set-endpoint';
        input.readOnly = true;
        input.title = 'Free endpoints — locked';
      }
      const keyPanel = document.createElement('div');
      keyPanel.className = 'setting-row endpoint-key-panel';
      keyPanel.id = 'endpoint-key-panel-' + nextEndpointId++;
      keyPanel.hidden = true;
      const keyInput = document.createElement('input');
      keyInput.type = 'password';
      keyInput.id = keyPanel.id + '-input';
      keyInput.autocomplete = 'off';
      keyInput.spellcheck = false;
      keyInput.placeholder = 'Access key (optional)';
      const readKey = () => first ? (configCache?.freeAccessKey || '')
        : (configCache?.endpointAccessKeys?.[input.value.trim()] || '');
      keyInput.value = readKey();
      const keyLabel = document.createElement('label');
      keyLabel.htmlFor = keyInput.id;
      keyLabel.textContent = 'Access key';
      keyInput.addEventListener('change', () => {
        if (!input.value.trim()) return;
        post('setConfig', { key: 'endpointAccessKey', endpoint: input.value.trim(), value: keyInput.value });
      });
      keyPanel.append(keyLabel, keyInput);
      const keyButton = document.createElement('button');
      keyButton.type = 'button';
      keyButton.className = 'icon-btn endpoint-action endpoint-key-toggle';
      keyButton.innerHTML = '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M6.5 9.5a4 4 0 1 1 3-3L8 8l1.5 1.5L8 11 6.5 9.5 5 11v2H3v2H1v-3l5.5-5.5" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/><circle cx="11" cy="3" r=".8" fill="currentColor"/></svg>';
      keyButton.title = 'Show access key';
      keyButton.setAttribute('aria-label', 'Show access key');
      keyButton.setAttribute('aria-expanded', 'false');
      keyButton.setAttribute('aria-controls', keyPanel.id);
      keyButton.addEventListener('click', () => {
        keyPanel.hidden = !keyPanel.hidden;
        keyInput.type = keyPanel.hidden ? 'password' : 'text';
        keyButton.title = keyPanel.hidden ? 'Show access key' : 'Hide access key';
        keyButton.setAttribute('aria-label', keyButton.title);
        keyButton.setAttribute('aria-expanded', String(!keyPanel.hidden));
        if (!keyPanel.hidden) keyInput.focus();
      });
      if (!first) input.addEventListener('change', () => {
        // Keys belong to URLs; editing a URL must not send its old key to a new provider.
        keyInput.value = readKey();
        saveAdditional();
      });
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'icon-btn endpoint-action';
      button.textContent = first ? '+' : '−';
      button.title = first ? 'Add endpoint' : 'Remove endpoint';
      button.setAttribute('aria-label', button.title);
      button.addEventListener('click', (event) => {
        event.stopPropagation();
        if (first) addEndpoint('').focus();
        else {
          const next = entry.nextElementSibling || entry.previousElementSibling;
          entry.remove();
          saveAdditional();
          next.querySelector('.endpoint-url').focus();
        }
      });
      row.append(keyButton, input, button);
      entry.append(row, keyPanel);
      endpointRows.appendChild(entry);
      return input;
    }
    addEndpoint(cfg.freeEndpoint || cfg.endpoint || '', true);
    (cfg.additionalEndpoints || []).forEach(value => addEndpoint(value));
    settingsPanel.appendChild(endpoints);
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
      title: conv.title, messages: conv.messages.slice(), requestContext: conv.requestContext,
      thoughts: Object.assign({}, conv.thoughts || {}), activity: conv.activity || [],
    };
    hist.push(entry);
    vscode.setState({ history: hist, conv });
  }

  function loadHistory(id) {
    const item = state().history.find((h) => h.id === id);
    if (!item) return;
    if (conv && conv.messages.length) saveConv();
    conv = { id: item.id, model: item.model, ts: item.ts, title: item.title, messages: item.messages.slice(), requestContext: item.requestContext, activity: item.activity || [], thoughts: Object.assign({}, item.thoughts || {}) };
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

  function clearChat(force = false) {
    if (force !== true && !clearArmed) {
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
    clearAttachments();
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

  function finishBubble(outcome = 'completed') {
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
      if (conv && conv.messages[conv.messages.length - 1] &&
          conv.messages[conv.messages.length - 1].role === 'assistant') {
        addMessageButtons('assistant', pendingBubble, conv.messages.length - 1);
      }
      pendingBubble = null;
    }
    if (conv && conv.id === activeRequestConvId && contextRevision === activeContextRevision
        && (conv.requestContext || agentRounds > 0)) {
      conv.requestContext = { messages: agentMessages.slice(), through: activeRequestLength };
      persist(); saveConv();
    }
    pendingText = '';
    pendingThought = '';
    if (cardsAfter && pendingEdits.length) {
      renderEditCards(cardsAfter, pendingEdits);
      pendingEdits = [];
    }
    busy = false;
    modelSelect.disabled = false;
    providerSelect.disabled = false;
    modelSelect.title = 'Model';
    $('#send').disabled = false;
    $('#stop').disabled = true;
    scrollBottom();
    endStep(outcome);
    if (outcome === 'completed' && followUpQueue.length) {
      const next = followUpQueue.shift();
      startChat(next, true);
    }
  }

  function buildRequestMessages() {
    const checkpoint = conv.requestContext;
    const msgs = checkpoint && checkpoint.through <= conv.messages.length
      ? checkpoint.messages.concat(conv.messages.slice(checkpoint.through))
      : conv.messages.slice();
    if (!attachments.length) return msgs;
    const last = msgs[msgs.length - 1];
    if (last && last.role === 'user') {
      const imgs = attachments.filter((a) => a.kind === 'image' && a.dataUrl);
      const texts = attachments.filter((a) => a.kind === 'text' && a.content);
      const block = texts.length
        ? '\n\nAttached context:\n' + texts.map((t) => '--- ' + t.name + ' ---\n' + t.content.slice(0, 30000)).join('\n\n')
        : '';
      if (imgs.length) {
        msgs[msgs.length - 1] = Object.assign({}, last, {
          content: [{ type: 'text', text: last.content + block }].concat(
            imgs.map((i) => ({ type: 'image_url', image_url: { url: i.dataUrl } }))),
        });
      } else if (block) {
        msgs[msgs.length - 1] = Object.assign({}, last, { content: last.content + block });
      }
    }
    return msgs;
  }

  function renderChips() {
    attachChips.innerHTML = '';
    attachments.forEach((a, idx) => {
      const chip = document.createElement('span');
      chip.className = 'chip';
      if (a.kind === 'image' && a.dataUrl) {
        const img = document.createElement('img');
        img.className = 'chip-thumb';
        img.src = a.dataUrl;
        chip.appendChild(img);
      }
      const label = document.createElement('span');
      label.className = 'chip-label';
      label.textContent = (a.kind === 'image' ? '🖼 ' : '📎 ') + a.name
        + (a.size ? ' (' + Math.max(1, Math.round(a.size / 1024)) + 'KB)' : '');
      chip.appendChild(label);
      const x = document.createElement('button');
      x.className = 'chip-x';
      x.textContent = '✕';
      x.title = 'Remove ' + a.name;
      x.addEventListener('click', () => { attachments.splice(idx, 1); renderChips(); });
      chip.appendChild(x);
      attachChips.appendChild(chip);
    });
    attachChips.hidden = !attachments.length;
    attachClear.hidden = !attachments.length;
  }

  function clearAttachments() {
    attachments.length = 0;
    renderChips();
  }

  function setTrayState(status) {
    trayBtn.classList.toggle('tray-on', status === 'running');
    trayBtn.classList.toggle('tray-busy', status === 'starting');
    trayBtn.classList.toggle('tray-err', status === 'error' || status === 'missing');
    trayBtn.title = status === 'running'
      ? 'System tray running (Copilot bridge :21302)'
      : status === 'starting'
        ? 'System tray starting…'
        : status === 'error' || status === 'missing'
          ? 'System tray unavailable — click to retry'
          : 'System tray stopped — click to start';
  }

  function launchChat() {
    if (stepsEl) endStep();
    activeRequestLength = conv.messages.length;
    activeRequestConvId = conv.id;
    activeContextRevision = contextRevision;
    busy = true;
    pendingBubble = bubble('assistant');
    const pendingDiv = pendingBubble.parentElement;
    pendingDiv.classList.add('pending');
    pendingDiv.classList.add('thinking');
    showThinking();
    topThink.hidden = false;
    startSteps();
    modelSelect.disabled = true;
    providerSelect.disabled = true;
    modelSelect.title = 'Model is locked while the AI is responding';
    $('#stop').disabled = false;
    persist();
    agentRounds = 0;
    continuationRetries = 0;
    stopRequested = false;
    contTools = [];
    contResolved = 0;
    pendingEdits = [];
    const msgs = buildRequestMessages();
    if (appliedEdits.length) {
      msgs.unshift({
        role: 'system',
        content: 'Files modified by applied edits since your last turn (assume their current on-disk contents): '
          + appliedEdits.join(', ') + '.',
      });
      appliedEdits.length = 0;
    }
    agentMessages = msgs.slice();
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

  function startChat(text, queued, displaySuffix) {
    ensureConv();
    if (!queued) {
      if (!conv.title) conv.title = text.slice(0, 48);
      conv.messages.push({ role: 'user', content: text });
      const body = bubble('user');
      setRich(body, text + (displaySuffix || ''));
      addMessageButtons('user', body, conv.messages.length - 1);
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
      const body = bubble('user');
      setRich(body, text);
      addMessageButtons('user', body, conv.messages.length - 1);
      persist();
      followUpQueue.push(text);
      hint(pickFun(QUEUE_LINES));
      scrollBottom();
      return;
    }
    const suffix = attachments.length
      ? '  ' + attachments.map((a) => (a.kind === 'image' ? '🖼' : '📎')).join(' ')
      : '';
    startChat(text, false, suffix);
    clearAttachments();
  }

  /* ---------- extension-host messages ---------- */

  window.addEventListener('message', (event) => {
    const msg = event.data || {};
    switch (msg.type) {
      case 'config':
        configCache = msg;
        updateProviderOptions(msg);
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
      case 'configSaved': {
        const previousSelection = configCache?.providerSelection || configCache?.provider || 'endpoint';
        configCache = msg.config || configCache;
        updateProviderOptions(configCache);
        if (msg.key === 'provider' || previousSelection !== providerSelect.value) { clearChat(true); post('getConfig'); }
        if (msg.config && msg.config.endpoint) endpointLine.textContent = msg.config.endpoint;
        break;
      }
      case 'models':
        if ((msg.providerSelection || msg.provider) !== providerSelect.value) break;
        endpointLine.textContent = msg.endpoint || endpointLine.textContent;
        setModelOptions(msg.models, (conv && conv.model) || modelSelect.value || null);
        if (conv && !msg.models.includes(conv.model)) { conv.model = modelSelect.value; persist(); updateModelChip(); }
        break;
      case 'delta':
        if (!busy || stopRequested) break;
        if (!pendingBubble) {
          pendingBubble = bubble('assistant');
          pendingBubble.parentElement.classList.add('pending');
        }
        if (!pendingText) hideThinking();
        pendingText += msg.text;
        if (!rafPending) {
          rafPending = true;
          requestAnimationFrame(() => {
            rafPending = false;
            if (!pendingBubble) return;
            setRich(pendingBubble, maskFenced(pendingText));
            scrollBottom();
          });
        }
        break;
      case 'done': {
        if (!busy) break;
        const aborted = msg.aborted || stopRequested;
        if (rafPending && pendingBubble) {
          rafPending = false;
          setRich(pendingBubble, maskFenced(pendingText));
        }
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
        if (!aborted && tools.length && agentRounds < MAX_AGENT_ROUNDS) {
          continuationRetries = 0;
          if (activeResponseStep) closeStep(rowByUid[activeResponseStep], pendingText || 'Requested ' + tools.length + ' workspace action(s).');
          else if (pendingText) showStep('Assistant update', true, '', pendingText);
          beginToolRound(tools);
          break;
        }
        const unfinished = agenticEnabled && !tools.length && !pendingEdits.length && isUnfinishedUpdate(pendingText);
        if (!aborted && unfinished && continuationRetries < 2 && agentRounds < MAX_AGENT_ROUNDS) {
          if (activeResponseStep) closeStep(rowByUid[activeResponseStep], pendingText);
          else showStep('Assistant update', true, '', pendingText);
          continuationRetries += 1;
          showStep('Continue unfinished work', true, '', 'The reply announced a next step without requesting an action. Asking the agent to perform it.');
          continueAgent('Continue the work you just announced now. Emit the required tool blocks or proposed edit blocks in this reply. '
            + 'Do not stop at another promise or plan. If the task is complete, provide the result; if blocked or waiting for user input, explain exactly what is needed.');
          break;
        }
        const paused = !aborted && (tools.length || unfinished);
        if (paused) {
          const reason = agentRounds >= MAX_AGENT_ROUNDS
            ? 'Paused after ' + MAX_AGENT_ROUNDS + ' agent rounds. Send “continue” to resume with the saved context.'
            : 'Paused because the model repeated a plan without taking action. Send “continue” to retry with the saved context.';
          pendingText = (pendingText ? pendingText + '\n\n' : '') + reason;
          if (pendingBubble) setRich(pendingBubble, pendingText);
          showStep('Agent paused', true, '', reason);
        }
        if (activeResponseStep) closeStep(rowByUid[activeResponseStep], aborted ? 'Stopped.' : 'Response shown below.', aborted ? 'cancelled' : 'completed');
        if (pendingText && pendingBubble && conv) {
          conv.messages.push({ role: 'assistant', content: pendingText });
          conv.ts = Date.now();
          saveConv();
        }
        finishBubble(aborted || paused ? 'cancelled' : 'completed');
        if (aborted) hint(pickFun(ABORT_LINES));
        break;
      }
      case 'toolResult': {
        if (!busy || stopRequested) break;
        const t = contTools.find((x) => x.uid === msg.uid);
        if (!t || t.result !== null) break;
        t.result = msg.ok ? msg.result : 'ERROR: ' + (msg.error || 'failed');
        contResolved += 1;
        const row = rowByUid[msg.uid];
        if (row) closeStep(row, t.result, msg.ok ? 'completed' : 'error'); // tick the narrated line that was waiting on this tool
        if (msg.image) {
          const snap = document.createElement('div');
          snap.className = 'browse-snap';
          const cap = document.createElement('div');
          cap.className = 'browse-cap';
          cap.textContent = '🌐 ' + (t.url || 'browser') + ' — snapshot';
          const img = document.createElement('img');
          img.src = 'data:image/jpeg;base64,' + msg.image;
          img.alt = t.url || 'browser snapshot';
          snap.appendChild(cap);
          snap.appendChild(img);
          log.appendChild(snap);
          scrollBottom();
        }
        if (contResolved >= contTools.length) continueAgent();
        break;
      }
      case 'error':
        setStatus('offline');
        stepRows.filter(row => !row.closed).forEach(row => closeStep(row, msg.message || 'Request failed.', 'error'));
        finishBubble('error');
        const err = document.createElement('div');
        err.className = 'bubble error';
        err.textContent = '⚠ ' + (msg.message || 'error');
        log.appendChild(err);
        scrollBottom();
        break;
      case 'thinking':
        if (pendingBubble && !thinkRow && !pendingText) showThinking();
        {
          addStepRow('planning', 'Prepare response plan');
        }
        break;
      case 'planningComplete':
        closeStep(rowByUid.planning, msg.ok ? 'Plan prepared.' : 'Planning was unavailable; continuing with the direct response.');
        break;
      case 'thought':
        closeStep(rowByUid.planning, 'Plan prepared.');
        pendingThought = (msg.text || '').trim();
        if (thinkRow) thinkRow.title = 'Private reasoning:\n\n' + pendingThought;
        break;
      case 'searchInfo': {
        webCount.textContent = msg.results
          ? `Web · ${msg.results} hits${msg.pages ? ' + ' + msg.pages + ' pages' : ''}`
          : 'Web';
        webCount.title = msg.query
          ? `Searched: "${msg.query}"${msg.playwright ? ' (Playwright)' : ''}`
          : '';
        break;
      }
      case 'agentStep': {
        if (!busy || !conv || conv.id !== activeRequestConvId) break;
        let row = rowByUid[msg.uid];
        if (!row) row = addStepRow(msg.uid, msg.title);
        if (msg.kind === 'response') activeResponseStep = msg.uid;
        if (msg.status && msg.status !== 'running') closeStep(row, msg.result || 'Completed.', msg.status);
        break;
      }
      case 'contextCompacted': {
        if (!busy || !conv || conv.id !== activeRequestConvId || contextRevision !== activeContextRevision) break;
        agentMessages = msg.messages.slice();
        conv.requestContext = { messages: msg.messages, through: activeRequestLength };
        persist(); saveConv();
        const detail = Math.round(msg.before / 1000) + 'K → ' + Math.round(msg.after / 1000) + 'K characters';
        showStep('Context compressed · ' + detail, true, 'Older context summarized; recent source retained');
        break;
      }
      case 'contextProgress':
        showStep(msg.text, true, msg.text);
        break;
      case 'contextInfo': {
        if (msg.context) agentMessages.unshift({ role: 'system', content: msg.context });
        showStep('Workspace context ready', true, '', msg.files + ' file(s), ' + Math.round((msg.chars || 0) / 1024) + ' KB supplied to the model.');
        wsCount.textContent = msg.files
          ? `Workspace · ${msg.files} file${msg.files === 1 ? '' : 's'}`
          : 'Workspace';
        wsCount.title = msg.chars ? `~${Math.round(msg.chars / 1024)}KB of file context sent` : '';
        break;
      }
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
      case 'trayState':
        setTrayState(String(msg.status || 'stopped'));
        break;
      case 'startPrompt': {
        const text = String(msg.text || '').slice(0, 20000);
        if (!text) break;
        if (busy) {
          ensureConv();
          conv.messages.push({ role: 'user', content: text });
          const body = bubble('user');
          setRich(body, text);
          addMessageButtons('user', body, conv.messages.length - 1);
          persist();
          followUpQueue.push(text);
          hint(pickFun(QUEUE_LINES));
          scrollBottom();
          break;
        }
        startChat(text);
        break;
      }
      case 'pickedFiles': {
        const errs = (msg.items || []).filter((i) => i.error);
        const ok = (msg.items || []).filter((i) => !i.error);
        ok.forEach((i) => { if (attachments.length < MAX_ATTACHMENTS) attachments.push(i); });
        renderChips();
        if (errs.length) hint('⚠ ' + errs.map((e) => e.name + ': ' + e.error).join(' · '));
        break;
      }
      case 'addContextItem': {
        // Element picked in the REACH Browser — attach it like a file so it
        // rides along with the user's next message. Never auto-answers.
        const content = String(msg.content || '').slice(0, 200000);
        if (!content) break;
        if (attachments.length >= MAX_ATTACHMENTS) {
          hint('⚠ Attachment limit reached (' + MAX_ATTACHMENTS + ') — remove one first');
          break;
        }
        attachments.push({
          kind: 'text',
          name: String(msg.name || 'browser element').slice(0, 60),
          content,
          sourceUrl: String(msg.url || ''),
          sourceTitle: String(msg.title || ''),
        });
        renderChips();
        hint('📎 Element attached — type your question and send');
        input.focus();
        break;
      }
      case 'editRefreshed': {
        const rec = editCards[msg.uid];
        if (!rec || ['rejected', 'applied'].includes(rec.state)) break;
        if (msg.error) {
          rec.status.textContent = msg.error; rec.status.className = 'edit-status err'; rec.showRefresh();
        } else if (msg.edit) {
          rec.reject(); rec.status.textContent = 'Replaced by refreshed proposal';
          renderEditCards(rec.card.closest('.edit-batch'), [msg.edit]);
        }
        break;
      }
      case 'editResult': {
        const rec = editCards[msg.uid];
        if (!rec || rec.state === 'rejected' || rec.state === 'applied') break;
        if (msg.reviewed) {
          if (rec.state !== 'pending') break;
          if (msg.ok) {
            rec.status.textContent = '✓ opened in VS Code diff';
            rec.status.className = 'edit-status ok';
          } else {
            rec.status.textContent = '⚠ ' + (msg.error || 'failed');
            rec.status.className = 'edit-status err';
            rec.showRefresh();
          }
          break;
        }
        if (msg.ok) {
          showStep('Apply: ' + msg.path, true, '', msg.unsaved ? 'Updated the editor buffer; changes remain unsaved.' : 'Applied and saved.');
          if (!busy) endStep();
          if (!appliedEdits.includes(msg.path)) appliedEdits.push(msg.path);
          rec.status.textContent = msg.unsaved ? 'Applied · unsaved' : '✓ applied';
          rec.status.className = 'edit-status ok';
        } else {
          if (!busy) endStep();
          rec.status.textContent = '⚠ ' + (msg.error || 'failed');
          rec.status.className = 'edit-status err';
        }
        rec.finish(!!msg.ok);
        if (!msg.ok) rec.showRefresh();
        break;
      }
      default:
        break;
    }
  });

  /* ---------- wiring ---------- */

  $('#send').addEventListener('click', send);
  $('#stop').addEventListener('click', () => {
    if (!busy) return;
    stopRequested = true;
    post('abort');
    // Tool rounds can be waiting without an active model request to abort.
    if (contTools.some(t => t.result === null)) finishBubble('cancelled');
  });
  attachBtn.addEventListener('click', () => {
    attachMenu.hidden = !attachMenu.hidden;
  });
  attachBtn.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      attachMenu.hidden = !attachMenu.hidden;
    }
  });
  attachClear.addEventListener('click', clearAttachments);
  attachClear.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      clearAttachments();
    }
  });
  [attachBtn, attachClear].forEach((el) => {
    el.addEventListener('mousedown', (e) => e.preventDefault());
  });
  attachMenu.querySelectorAll('.attach-item').forEach((b) => {
    b.addEventListener('click', () => {
      attachMenu.hidden = true;
      post('pickFiles', { kind: b.dataset.kind });
    });
  });
  attachChips.addEventListener('wheel', (e) => {
    if (attachChips.scrollWidth <= attachChips.clientWidth + 1) return;
    if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
      e.preventDefault();
      attachChips.scrollLeft += e.deltaY;
    }
  }, { passive: false });
  if (togglesRow) {
    togglesRow.addEventListener('wheel', (e) => {
      if (togglesRow.scrollWidth <= togglesRow.clientWidth + 1) return;
      if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
        e.preventDefault();
        togglesRow.scrollLeft += e.deltaY;
      }
    }, { passive: false });
  }
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
  trayBtn.addEventListener('click', () => post('trayStart'));
  browserBtn.addEventListener('click', () => post('openBrowser'));
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
    if (!attachMenu.hidden && !attachMenu.contains(e.target) && !attachBtn.contains(e.target)) {
      attachMenu.hidden = true;
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
  providerSelect.addEventListener('change', () => {
    if (!busy) post('setConfig', { key: 'provider', value: providerSelect.value });
  });
  modelSelect.addEventListener('change', () => {
    if (busy) return; // locked while the AI is responding
    if (conv) { conv.model = modelSelect.value; persist(); }
    updateModelChip();
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  });

  /* ---------- custom right-click context menu (REACH) ---------- */

  let ctxMenu = null;
  function getSelectionText() {
    const s = window.getSelection && window.getSelection().toString();
    return s ? s.trim() : '';
  }
  function hideCtxMenu() {
    if (ctxMenu) { ctxMenu.remove(); ctxMenu = null; }
  }
  function forceClearChat() {
    if (conv && conv.messages.length) saveConv();
    conv = null;
    clearAttachments();
    persist();
    renderMessages();
    renderHistory();
    updateModelChip();
  }
  function askAbout(text) {
    if (!text) { hint('Select some text first.'); return; }
    if (busy) {
      ensureConv();
      conv.messages.push({ role: 'user', content: text });
      const body = bubble('user');
      setRich(body, text);
      addMessageButtons('user', body, conv.messages.length - 1);
      persist();
      followUpQueue.push(text);
      hint(pickFun(QUEUE_LINES));
      scrollBottom();
    } else {
      startChat(text, false, '');
    }
  }
  function showCtxMenu(x, y) {
    hideCtxMenu();
    const menu = document.createElement('div');
    menu.className = 'ctx-menu';
    const item = (label, cb) => {
      const b = document.createElement('button');
      b.className = 'ctx-item';
      b.textContent = label;
      b.addEventListener('click', () => { hideCtxMenu(); cb(); });
      return b;
    };
    const sel = getSelectionText();
    if (sel) {
      menu.appendChild(item('Copy', () => copyText(sel)));
      menu.appendChild(item('Ask about selection', () => askAbout(sel)));
    }
    menu.appendChild(item('Reload models', () => post('fetchModels')));
    menu.appendChild(item('Clear chat', forceClearChat));
    document.body.appendChild(menu);
    const r = menu.getBoundingClientRect();
    menu.style.left = Math.max(4, Math.min(x, window.innerWidth - r.width - 4)) + 'px';
    menu.style.top = Math.max(4, Math.min(y, window.innerHeight - r.height - 4)) + 'px';
    ctxMenu = menu;
  }
  log.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    showCtxMenu(e.clientX, e.clientY);
  });
  document.addEventListener('click', hideCtxMenu);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hideCtxMenu(); });

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
  post('trayStatus');
})();
