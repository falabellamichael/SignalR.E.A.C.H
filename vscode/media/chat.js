/* REACH chat — webview script. Talks to the extension host exclusively via postMessage.
 * History + current conversation persist in the webview state (survives reloads). */
(function () {
  const vscode = window.acquireVsCodeApi ? window.acquireVsCodeApi() : null;
  if (!vscode) return;

  const $ = (sel) => document.querySelector(sel);
  const log = $('#log');
  const input = $('#input');
  const slashMenu = $('#slash-menu');
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
  let answerNowBtn = null;
  let answeringNow = false;
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
  // Agent effort limits come from settings (simplereach.agentMaxRounds /
  // simplereach.agentUnfinishedRetries); 0 there means "no limit" — the agent
  // works until the task is done or the user presses Stop. These initial values
  // are the fallback used until the first config message arrives.
  let MAX_AGENT_ROUNDS = 40;
  let UNFINISHED_RETRY_LIMIT = 2;
  const followUpQueue = [];
  const appliedEdits = [];
  const attachments = [];
  const MAX_ATTACHMENTS = 6;

  function state() { return vscode.getState() || { history: [], conv: null }; }
  function persist() { vscode.setState({ history: state().history, conv }); }

  /* Agent effort limits are user settings: 0 = no limit (unlimited rounds, and
   * announced work is chased without pausing), a positive number caps it. */
  function applyAgentLimits(cfg) {
    const rounds = Number(cfg && cfg.agentMaxRounds);
    MAX_AGENT_ROUNDS = Number.isFinite(rounds) && rounds > 0 ? Math.floor(rounds) : Infinity;
    const retries = Number(cfg && cfg.agentUnfinishedRetries);
    UNFINISHED_RETRY_LIMIT = Number.isFinite(retries) && retries > 0 ? Math.floor(retries) : Infinity;
  }

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
    if (!pendingBubble || typeof pendingBubble.prepend !== 'function') return;
    if (thinkRow && typeof pendingBubble.contains === 'function' && !pendingBubble.contains(thinkRow)) thinkRow = null;
    if (answerNowBtn && typeof pendingBubble.contains === 'function' && !pendingBubble.contains(answerNowBtn)) answerNowBtn = null;
    if (thinkRow) return;

    const wrap = document.createElement('div');
    wrap.className = 'pending-status';

    const spinner = document.createElement('span');
    spinner.className = 'think-spinner';
    spinner.setAttribute('aria-label', 'thinking');
    wrap.appendChild(spinner);
    thinkRow = spinner;

    if (!answeringNow) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'answer-now-btn';
      btn.setAttribute('aria-label', 'Answer now');
      btn.title = 'Answer now using the context gathered so far';
      btn.innerHTML = '<svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true"><path d="M9.5 1.5L3 9.5h4.5L6.5 14.5 13 6.5H8.5l1-5z" fill="currentColor"/></svg><span>Answer now</span>';
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        answerNow();
      });
      wrap.appendChild(btn);
      answerNowBtn = btn;
    } else {
      const label = document.createElement('span');
      label.className = 'answering-label';
      label.textContent = 'Answering now…';
      wrap.appendChild(label);
    }

    pendingBubble.prepend(wrap);
  }

  function hideThinking() {
    if (answerNowBtn) {
      if (typeof answerNowBtn.remove === 'function') answerNowBtn.remove();
      answerNowBtn = null;
    }
    if (thinkRow) {
      if (typeof thinkRow.remove === 'function') thinkRow.remove();
      thinkRow = null;
    }
    if (pendingBubble && typeof pendingBubble.querySelector === 'function') {
      const statusWrap = pendingBubble.querySelector('.pending-status');
      if (statusWrap && typeof statusWrap.remove === 'function') statusWrap.remove();
    }
    if (pendingBubble && pendingBubble.parentElement && pendingBubble.parentElement.classList) {
      pendingBubble.parentElement.classList.remove('thinking');
    }
    if (typeof topThink !== 'undefined' && topThink) topThink.hidden = true;
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
    const allowed = (typeof window !== 'undefined' && Array.isArray(window.REACH_TOOL_NAMES) && window.REACH_TOOL_NAMES.length)
      ? window.REACH_TOOL_NAMES
      : ['read', 'glob', 'search', 'list', 'shell', 'browse', 'websearch', 'vscode', 'git', 'pullRequests', 'open', 'runTask', 'vscodeCommand',
        'todo_write', 'todo_read', 'tool_help',
        'browser_open', 'browser_navigate', 'browser_snapshot', 'browser_click', 'browser_type', 'browser_press', 'browser_scroll', 'browser_wait', 'browser_back', 'browser_forward', 'browser_reload', 'browser_find', 'browser_console', 'browser_network', 'browser_screenshot', 'browser_close'];
    // One wrapper may hold SEVERAL complete JSON values — a model can stream one
    // action per line inside a single block — and a truncated fence (REACH's own
    // dialect) can lose its closing backticks. parseValues returns every
    // complete value it finds plus how many characters of the content it used.
    const parseValues = (content) => {
      const values = [];
      let rest = String(content || '').trimStart();
      const total = rest.length;
      for (;;) {
        rest = rest.replace(/^[\s,]+/, '');
        if (!rest || (rest[0] !== '{' && rest[0] !== '[')) break;
        const openChar = rest[0];
        const closeChar = openChar === '{' ? '}' : ']';
        let depth = 0, inStr = false, end = -1;
        for (let i = 0; i < rest.length; i += 1) {
          const c = rest[i];
          if (inStr) {
            if (c === '\\') i += 1;
            else if (c === '"') inStr = false;
            continue;
          }
          if (c === '"') { inStr = true; continue; }
          if (c === openChar) depth += 1;
          else if (c === closeChar) { depth -= 1; if (depth === 0) { end = i; break; } }
        }
        if (end < 0) break;
        try { values.push(JSON.parse(repairJson(rest.slice(0, end + 1)))); }
        catch (e) { break; }
        rest = rest.slice(end + 1);
      }
      return { values, consumed: total - rest.length };
    };
    // Providers use several tool dialects. Only explicit, complete wrappers are
    // executable; ordinary JSON remains chat content. Accepted here:
    //   ```tool            - REACH's own fenced contract; end of text closes a
    //                        truncated fence so a complete call is not lost
    //   <tool>             - REACH's XML form (must be closed)
    //   <tool_call>/<invoke>  - Cline / Anthropic-style XML wrappers
    const re = /```tool\s*\n?([\s\S]*?)(?:```|$)|<tool\s*>([\s\S]*?)<\/tool\s*>|<tool_call\s*>([\s\S]*?)<\/tool_call\s*>|<invoke\s*>([\s\S]*?)<\/invoke\s*>/gi;
    let m;
    const jobs = [];
    while ((m = re.exec(text || ''))) {
      const rawContent = (m[1] !== undefined ? m[1] : (m[2] !== undefined ? m[2] : (m[3] !== undefined ? m[3] : m[4]))).trim();
      if (rawContent) jobs.push({ block: m[0], content: rawContent });
    }
    // Bare "tool" label dialect: some providers copy the word from the contract
    // but drop the backticks — "tool\n{...}". Only a line that is exactly `tool`,
    // followed by complete JSON values with known actions, is executed; only the
    // consumed span leaves the visible text, and plain prose is untouched.
    const bare = /(^|\n)[ \t]*tool[ \t]*:?[ \t]*\n([\s\S]*)/i.exec(clean);
    if (bare) jobs.unshift({ bare: true, start: bare.index + bare[1].length, prefixLen: bare[0].length - bare[1].length - bare[2].length, content: bare[2] });
    for (const job of jobs) {
      const parsedContent = parseValues(job.content);
      const pendingValues = parsedContent.values;
      let added = 0;
      while (pendingValues.length) {
        let parsed = pendingValues.shift();
        if (parsed && !parsed.action && parsed.name) {
          const args = parsed.arguments ?? parsed.parameters ?? {};
          parsed = Object.assign({}, typeof args === 'string'
            ? (() => { try { return JSON.parse(args); } catch (e) { return {}; } })()
            : args, { action: parsed.name });
        }
        const it = parsed;
        if (it && allowed.includes(it.action)) {
          tools.push({
            action: it.action,
            topic: String(it.topic || '').slice(0, 80),
            remote: String(it.remote || '').slice(0, 200),
            lookup: it.lookup,
            state: it.state === undefined ? undefined : String(it.state).slice(0, 40),
            maxChars: it.maxChars,
            maxChanges: it.maxChanges,
            severity: String(it.severity || '').slice(0, 40),
            key: String(it.key || '').slice(0, 200),
            details: it.details === true,
            operation: String(it.operation || 'status').slice(0, 40),
            repository: typeof it.repository === 'number' ? it.repository : String(it.repository ?? '').slice(0, 1000),
            workspace: typeof it.workspace === 'number' ? it.workspace : (it.workspace === undefined ? undefined : String(it.workspace).slice(0, 1000)),
            extensionId: String(it.extensionId || '').slice(0, 200),
            name: String(it.name || '').slice(0, 200),
            line: it.line,
            column: it.column,
            limit: it.limit,
            staged: it.staged === true,
            path: String(it.path || '').replace(/\\/g, '/'),
            startLine: it.startLine ?? it.start_line,
            endLine: it.endLine ?? it.end_line,
            pattern: String(it.pattern || '').slice(0, 200),
            command: String(it.command || '').slice(0, 1000),
            url: String(it.url || '').slice(0, 800),
            query: String(it.query || '').slice(0, 200),
            // browser_* verbs
            ref: it.ref === undefined ? undefined : String(it.ref).slice(0, 200),
            selector: String(it.selector || '').slice(0, 300),
            text: String(it.text || '').slice(0, 4000),
            browserKey: String(it.browserKey || it.key || '').slice(0, 40),
            x: it.x, y: it.y,
            submit: it.submit === true,
            timeout: it.timeout,
            // todo_write / tool_help
            todos: Array.isArray(it.todos) ? it.todos.slice(0, 50).map(t => ({
              text: String((t && t.text) || '').slice(0, 300),
              status: String((t && t.status) || 'pending').slice(0, 20),
            })) : undefined,
            // edit_patch
            hunks: Array.isArray(it.hunks) ? it.hunks.slice(0, 40) : undefined,
          });
          added += 1;
        }
      }
      if (added) {
        if (job.bare) clean = clean.slice(0, job.start) + clean.slice(job.start + job.prefixLen + parsedContent.consumed);
        else clean = clean.replace(job.block, '');
      }
    }
    clean = clean.replace(/\n{3,}/g, '\n\n');
    return { text: clean.trim(), tools };
  }

  /* The agent's own question format: a fenced confirm block naming the
   * question and (optionally) the options it offers:
   *   ```confirm
   *   {"question": "Rename these 12 files now?", "options": ["Yes", "No"]}
   *   ```
   * The block is stripped from the visible reply; the panel below the bubble
   * renders the question with one button per option plus a free-text answer. */
  function extractConfirm(text) {
    let clean = text || '';
    let confirm = null;
    const re = /```confirm\s*\n?([\s\S]*?)(?:```|$)/gi;
    let m;
    while ((m = re.exec(text || ''))) {
      try {
        const parsed = JSON.parse(repairJson(m[1].trim()));
        const question = parsed && typeof parsed.question === 'string' ? parsed.question.trim() : '';
        if (!question) continue;
        const options = Array.isArray(parsed.options)
          ? parsed.options.filter(o => typeof o === 'string' && o.trim()).map(o => o.trim().slice(0, 120)).slice(0, 6)
          : [];
        confirm = { question: question.slice(0, 600), options };
        clean = clean.replace(m[0], '');
      } catch (e) { /* leave unparseable block in the text */ }
    }
    clean = clean.replace(/\n{3,}/g, '\n\n');
    return { text: clean.trim(), confirm };
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
    // Collapsible drop-up: collapsed it shows a single small toggle bar; opened
    // it reveals the edit cards in a scrollable block (like Settings/History).
    // This keeps the assistant's answer last in the reading flow — the edits
    // only appear when you press the toggle.
    const wrap = document.createElement('section');
    wrap.className = 'edit-dropup';
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'edit-dropup-toggle';
    toggle.setAttribute('aria-expanded', 'false');
    const caret = document.createElement('span');
    caret.className = 'edit-dropup-caret';
    caret.setAttribute('aria-hidden', 'true');
    caret.textContent = '▴';
    const toggleLabel = document.createElement('span');
    toggleLabel.className = 'edit-dropup-label';
    toggle.append(caret, toggleLabel);
    const panel = document.createElement('div');
    panel.className = 'edit-dropup-panel';
    panel.hidden = true;
    let open = false;
    const setOpen = (next) => {
      open = next;
      panel.hidden = !open;
      wrap.classList.toggle('open', open);
      toggle.setAttribute('aria-expanded', String(open));
      if (open) scrollBottom();
    };
    toggle.addEventListener('click', () => setOpen(!open));
    wrap.append(toggle, panel);

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
      // Keep the collapsed toggle honest about what is waiting inside.
      const total = records.length;
      const summary = pending ? pending + ' proposed edit' + (pending === 1 ? '' : 's')
        : records.some(r => r.state === 'applying') ? 'Applying edits…'
        : failed ? failed + ' failed edit' + (failed === 1 ? '' : 's') : 'Edits resolved';
      toggleLabel.textContent = '📝 ' + summary + (total > 1 ? ' · ' + total : '');
      toggle.title = summary + ' — click to ' + (open ? 'close' : 'open');
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
    panel.appendChild(batch);
    updateBatch();
    // afterEl may be a card's batch (nested inside an existing drop-up) — anchor
    // on the top-level drop-up so insertBefore stays a direct child of the log.
    const anchor = afterEl && afterEl.closest ? (afterEl.closest('.edit-dropup') || afterEl) : afterEl;
    log.insertBefore(wrap, anchor ? anchor.nextSibling : null);
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
      .replace(/```(?:edit|tool|confirm)[\s\S]*?(?:```|$)/gi, '…')
      .replace(/<tool\s*>[\s\S]*?(?:<\/tool\s*>|$)/gi, '…');
    // Adjacent masked blocks separated by ONLY whitespace collapse to a single
    // ellipsis — otherwise a run of ```tool blocks streams as a full-height
    // wall of "…" rows (pre-wrap renders the blank lines between them). Real
    // prose between blocks is preserved (\s* won't match across it).
    while (/…\s*…/.test(out)) out = out.replace(/…\s*…/g, '…');
    out = out.replace(/\n{3,}/g, '\n\n');
    return out.trim();
  }

  /* The agent asked a question — present it like a VS Code confirmation: the
   * question text, one button per option the model offered, and a free-text
   * answer field. Answering sends the text as the user's next message and
   * resumes the conversation with the full context intact. */
  function dismissConfirmPanels() {
    if (typeof document === 'undefined') return;
    log.querySelectorAll('.confirm-card').forEach((node) => node.remove());
  }

  function showConfirmPanel(confirm) {
    if (typeof document === 'undefined') return;
    dismissConfirmPanels();
    const card = document.createElement('div');
    card.className = 'confirm-card';
    const head = document.createElement('div');
    head.className = 'confirm-question';
    head.textContent = '❓ ' + ((confirm && confirm.question) || 'The agent needs your decision before it continues.');
    card.appendChild(head);
    const answer = (text) => {
      const value = String(text || '').trim();
      if (!value || busy) return;
      dismissConfirmPanels();
      startChat(value, false, '');
    };
    const options = confirm && Array.isArray(confirm.options) ? confirm.options : [];
    if (options.length) {
      const row = document.createElement('div');
      row.className = 'confirm-options';
      options.forEach((label) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'confirm-btn';
        button.textContent = label;
        button.addEventListener('click', () => answer(label));
        row.appendChild(button);
      });
      card.appendChild(row);
    }
    const row = document.createElement('div');
    row.className = 'confirm-input-row';
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'confirm-input';
    input.placeholder = options.length ? 'Or type another answer…' : 'Type your answer…';
    const send = document.createElement('button');
    send.type = 'button';
    send.className = 'confirm-btn primary';
    send.textContent = 'Send';
    const submit = () => answer(input.value);
    send.addEventListener('click', submit);
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); submit(); }
    });
    row.append(input, send);
    card.appendChild(row);
    log.appendChild(card);
    scrollBottom();
    input.focus();
  }

  /* ---------- Cursor-style step tracker (real steps + funny filler) ---------- */

  const ABORT_LINES = ['Stopped.'];
  const QUEUE_LINES = ['Queued — will send after this reply.'];

  function pickFun(arr) {
    return arr[Math.floor(Math.random() * arr.length)];
  }

  /* ---- step analysis: numbering, quips, plan groups, progress ---- */

  let stepsHead = null;        // { region, chip, bar, fill } of the live timeline
  let currentStepRow = null;   // the row the run is on right now
  let lastTodos = [];          // latest Agent-plan list (todo_write); [] until then

  const STEP_QUIPS = {
    read: ['reading it like it owes me money', 'squinting at the source', 'cracking the file open', 'every line, all the way down'],
    search: ['digging through the repo', 'shaking the file tree for answers', 'hunting for that one symbol', 'turning the workspace upside down'],
    list: ['taking inventory', 'seeing what is in the drawer'],
    browse: ['taking the web for a spin', 'peeking at the live page', 'driving the browser around the block'],
    websearch: ['asking the internet nicely', 'consulting the hive mind', 'googling professionally'],
    plan: ['sharpening the checklist', 'laying out the steps', 'making a list, checking it twice'],
    compress: ['squashing old context into notes', 'doing some memory yoga', 'folding the history neatly'],
    context: ['taking stock of the workspace', 'checking the map before the trip'],
    generate: ['putting the answer together', 'assembling the reply', 'polishing the words'],
    apply: ['patching it in carefully', 'landing the edit'],
    shell: ['letting the terminal do the talking'],
    think: ['thinking it through', 'weighing the options'],
    other: ['working on it', 'making progress'],
  };
  const WAIT_QUIPS = [
    'still going — it is a big one',
    'no timeouts here, we wait it out',
    'taking its sweet time, all good',
    'still connected, still working',
    'the model is being thorough',
  ];

  // Same step, same line: a reload or repaint must never reshuffle commentary.
  function stepHash(text) {
    const s = String(text || '');
    let h = 0;
    for (let i = 0; i < s.length; i += 1) h = (h * 31 + s.charCodeAt(i)) | 0;
    return Math.abs(h);
  }

  function stepFamily(title) {
    const t = String(title || '').toLowerCase();
    if (t.startsWith('apply')) return 'apply';
    if (t.includes('compress')) return 'compress';
    if (t.includes('plan')) return 'plan';
    if (t.includes('web search') || t.includes('search the web')) return 'websearch';
    if (t.startsWith('read')) return 'read';
    if (t.includes('browse') || t.includes('browser:')) return 'browse';
    if (t.startsWith('search') || t.includes('find relevant') || t.includes('workspace files')) return 'search';
    if (t.startsWith('list')) return 'list';
    if (t.startsWith('run command') || t.startsWith('run:')) return 'shell';
    if (t.includes('context')) return 'context';
    if (t.includes('generate') || t.includes('answer')) return 'generate';
    if (t.includes('think') || t.includes('unfinished') || t.includes('paused')) return 'think';
    return 'other';
  }

  function quipFor(family, seed) {
    const pool = STEP_QUIPS[family] || STEP_QUIPS.other;
    return pool[stepHash(seed) % pool.length];
  }

  function planProgress(todos) {
    const list = (Array.isArray(todos) ? todos : []).filter((t) => t && t.text);
    const done = list.filter((t) => t.status === 'completed').length;
    const currentIndex = list.findIndex((t) => t.status === 'in_progress');
    return { total: list.length, done: done, currentIndex: currentIndex,
      currentText: currentIndex >= 0 ? list[currentIndex].text : '' };
  }

  /* With an Agent plan, the plan items ARE the main steps: each new step is
   * grouped under the item that is in progress when it starts. No plan, no
   * groups — the header counter stands on its own. */
  function phaseFor(title, todos) {
    const plan = planProgress(todos);
    if (!plan.total) return '';
    if (plan.currentText) return 'Plan ' + (plan.currentIndex + 1) + '/' + plan.total + ' \u00b7 ' + plan.currentText;
    return plan.done >= plan.total ? 'Plan complete \u00b7 ' + plan.total + '/' + plan.total
      : 'Plan ' + Math.min(plan.total, plan.done + 1) + '/' + plan.total;
  }

  function rowClassName(row) {
    return 'step-line ' + row.record.status + (row === currentStepRow ? ' current' : '');
  }

  function refreshCurrentRow() {
    let running = null;
    for (let i = stepRows.length - 1; i >= 0; i -= 1) {
      if (!stepRows[i].closed) { running = stepRows[i]; break; }
    }
    currentStepRow = running;
    stepRows.forEach((row) => { row.el.className = rowClassName(row); });
  }

  function updateStepsHead(trace, frozen) {
    if (!stepsHead) return;
    const steps = (trace && trace.steps) || [];
    let running = null;
    for (let i = steps.length - 1; i >= 0; i -= 1) {
      if (steps[i].status === 'running') { running = steps[i]; break; }
    }
    const live = !!running;
    const plan = frozen ? { total: 0, done: 0, currentIndex: -1 } : planProgress(lastTodos);
    let chipText = '';
    let fill = null;             // 0..1 determinate; null = unknown -> sheen
    if (steps.length) {
      if (plan.total) {
        const reached = Math.min(plan.total, plan.done + (plan.currentIndex >= 0 ? 1 : 0));
        chipText = 'Plan ' + reached + '/' + plan.total;
        fill = reached / plan.total;
      } else {
        chipText = live ? 'Step ' + (running.index || steps.length)
          : steps.length + (steps.length === 1 ? ' step' : ' steps');
      }
    }
    stepsHead.chip.textContent = chipText;
    stepsHead.region.className = 'steps' + (live ? ' running' : '');
    stepsHead.bar.className = 'step-progress' + (live ? ' running' : '') + (fill !== null ? ' determinate' : '');
    if (fill !== null && stepsHead.fill && stepsHead.fill.style) {
      stepsHead.fill.style.width = Math.round(fill * 100) + '%';
    }
  }

  function createTimeline(trace, beforeEl) {
    const region = document.createElement('section');
    region.className = 'steps'; region.setAttribute('aria-label', 'Agent activity');
    const head = document.createElement('div'); head.className = 'steps-head';
    const title = document.createElement('span'); title.className = 'steps-title'; title.textContent = 'Agent activity';
    const chip = document.createElement('span'); chip.className = 'steps-chip'; chip.setAttribute('aria-live', 'polite');
    const bar = document.createElement('div'); bar.className = 'step-progress';
    const fill = document.createElement('i'); fill.className = 'step-progress-fill';
    bar.appendChild(fill);
    head.append(title, chip, bar);
    region.appendChild(head);
    stepsHead = { region: region, chip: chip, bar: bar, fill: fill };
    updateStepsHead(trace);
    log.insertBefore(region, beforeEl || null);
    return region;
  }

  /* The live plan the model maintains with todo_write. The host posts a
   * `todos` message after every write, so this card is re-painted in place
   * rather than appended per update — a plan that is rewritten five times
   * should read as one checklist that changes, not five stacked copies. */
  let todoCard = null;

  function renderTodoCard(todos) {
    const list = Array.isArray(todos) ? todos : [];
    lastTodos = list;
    if (!list.length) { if (todoCard) { todoCard.remove(); todoCard = null; } return; }
    if (!todoCard || !todoCard.isConnected) {
      const region = document.createElement('section');
      region.className = 'todo-card';
      region.setAttribute('aria-label', 'Agent plan');
      const head = document.createElement('div');
      head.className = 'todo-head';
      const title = document.createElement('span');
      title.className = 'todo-title';
      title.textContent = 'Agent plan';
      const count = document.createElement('span');
      count.className = 'todo-count';
      head.append(title, count);
      region.appendChild(head);
      const items = document.createElement('ul');
      items.className = 'todo-items';
      region.appendChild(items);
      todoCard = region;
      if (stepsEl) stepsEl.insertBefore(region, stepsEl.firstChild ? stepsEl.children[1] || null : null);
      else log.insertBefore(region, pendingBubble && pendingBubble.parentElement);
    }
    const done = list.filter((t) => t && t.status === 'completed').length;
    todoCard.querySelector('.todo-count').textContent = done + '/' + list.length + ' done';
    const items = todoCard.querySelector('.todo-items');
    items.textContent = '';
    const mark = { pending: '\u25cb', in_progress: '\u25d0', completed: '\u2713' };
    list.forEach((t) => {
      const item = document.createElement('li');
      const status = (t && t.status) || 'pending';
      item.className = 'todo-item todo-' + status;
      const glyph = document.createElement('span');
      glyph.className = 'todo-glyph';
      glyph.textContent = mark[status] || mark.pending;
      glyph.setAttribute('aria-hidden', 'true');
      const label = document.createElement('span');
      label.className = 'todo-text';
      label.textContent = String((t && t.text) || '');
      item.append(glyph, label);
      items.appendChild(item);
    });
    if (stepsEl && activeTrace) updateStepsHead(activeTrace);
    scrollBottom();
  }

  function paintStep(region, record, fullResult) {
    if (record.index === undefined) record.index = (region.__count = (region.__count || 0) + 1);
    if (!record.quip) record.quip = quipFor(stepFamily(record.title), record.uid || record.title + '#' + record.index);
    if (record.phase === undefined) record.phase = phaseFor(record.title, lastTodos);
    if (record.phase && region.__phase !== record.phase) {
      region.__phase = record.phase;
      const group = document.createElement('div');
      group.className = 'step-group';
      group.textContent = record.phase;
      region.appendChild(group);
    }
    const el = document.createElement('article'); el.className = 'step-line';
    const head = document.createElement('div'); head.className = 'step-head';
    const spin = document.createElement('span'); spin.className = 'mini-spin'; spin.setAttribute('aria-hidden', 'true');
    const num = document.createElement('span'); num.className = 'step-num'; num.textContent = record.index + '.';
    const text = document.createElement('span'); text.className = 'step-text'; text.textContent = record.title;
    const state = document.createElement('span'); state.className = 'step-state';
    head.append(spin, num, text, state); el.appendChild(head);
    const quip = document.createElement('div'); quip.className = 'step-quip'; quip.textContent = record.quip;
    el.appendChild(quip);
    const output = document.createElement('div'); output.className = 'step-output'; el.appendChild(output);
    region.appendChild(el);
    const row = { el, textEl: text, stateEl: state, outputEl: output, quipEl: quip,
      record, real: true, closed: record.status !== 'running', uid: record.uid || null,
      quipText: record.quip, openChoice: undefined };
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
    record.index = activeTrace.steps.length + 1;
    record.quip = quipFor(stepFamily(record.title), uid || (record.title + '#' + record.index));
    record.phase = phaseFor(record.title, lastTodos);
    activeTrace.steps.push(record);
    const row = paintStep(stepsEl, record);
    row.startedAt = Date.now();
    if (uid) rowByUid[uid] = row;
    stepRows.push(row);
    refreshCurrentRow();
    updateStepsHead(activeTrace);
    saveSteps(); scrollBottom();
    return row;
  }

  const runningTickers = new WeakMap();   // row element -> interval id

  function stopRunningTicker(row) {
    const id = runningTickers.get(row.el);
    if (id) { clearInterval(id); runningTickers.delete(row.el); }
  }

  function fmtDuration(seconds) {
    if (seconds < 60) return seconds + 's';
    const minutes = Math.floor(seconds / 60);
    return minutes + 'm ' + String(seconds % 60).padStart(2, '0') + 's';
  }

  // A running step counts up instead of only saying "waiting". Nothing here
  // aborts anything: there are no timeouts, so the elapsed figure is the way to
  // tell a live request from a stalled one. When the host reports real progress
  // (a streamed summary growing, a thinking trace in flight), that note is
  // shown instead — an observed liveness beats a claimed one.
  function startRunningTicker(row) {
    stopRunningTicker(row);
    const startedAt = row.startedAt || Date.now();
    const paint = () => {
      if (row.closed) { stopRunningTicker(row); return; }
      const seconds = Math.max(0, Math.round((Date.now() - startedAt) / 1000));
      if (row.quipEl) {
        const line = Math.floor(seconds / 12);
        row.quipEl.textContent = line === 0 ? row.quipText : WAIT_QUIPS[line % WAIT_QUIPS.length];
      }
      if (row.progressNote) {
        row.outputEl.textContent = row.progressNote + ' · ' + fmtDuration(seconds) + ' elapsed';
        return;
      }
      if (seconds < 5) { row.outputEl.textContent = 'Waiting for result…'; return; }
      const patience = seconds >= 45 ? ' — no timeouts, nothing will be cut off' : '';
      row.outputEl.textContent = 'Still working · ' + fmtDuration(seconds) + ' elapsed' + patience;
    };
    paint();
    runningTickers.set(row.el, setInterval(paint, 1000));
  }

  // Live progress from the host for a running step (streamed summary length,
  // thinking-trace length). Purely informational — no timeout ever reads it,
  // and a closed row ignores late notes.
  function noteStep(uid, note) {
    const row = rowByUid[uid];
    if (!row || row.closed) return;
    row.progressNote = String(note || '');
    if (row.progressNote) row.outputEl.textContent = row.progressNote;
  }

  function updateStep(row, status, result, save = true) {
    if (!row) return;
    stopRunningTicker(row);
    row.record.status = status || 'completed'; row.closed = row.record.status !== 'running';
    const text = String(result || '');
    if (save) { row.record.result = text.slice(0, 12000); row.record.resultChars = text.length; }
    if (row.closed && !row.record.duration && row.startedAt) {
      row.record.duration = Math.max(1, Math.round((Date.now() - row.startedAt) / 1000));
    }
    const statusText = { running: 'Running', completed: 'Done', error: 'Failed', cancelled: 'Stopped' }[row.record.status] || row.record.status;
    row.stateEl.textContent = statusText + (row.closed && row.record.duration ? ' · ' + fmtDuration(row.record.duration) : '');
    // Completed work folds to one line; the running step keeps its output open.
    row.el.className = rowClassName(row);
    row.outputEl.replaceChildren();
    const total = Math.max(text.length, row.record.resultChars || 0);
    if (text) {
      const preview = document.createElement('pre'); preview.className = 'step-result';
      preview.textContent = text.length > 1200 ? text.slice(0, 1200) + '\n…' : text;
      const parts = [preview];
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
        parts.push(details);
      }
      if (text.length < total) {
        const note = document.createElement('div'); note.className = 'step-preview-note';
        note.textContent = 'Saved first ' + text.length.toLocaleString() + ' of ' + total.toLocaleString() + ' characters.';
        parts.push(note);
      }
      if (row.closed) {
        // The result is kept — as a dropdown — so a finished list stays
        // scannable without hiding anything. Live steps are never folded:
        // a running row renders its status inline, and a dropdown the user
        // opened stays open and keeps updating when new data arrives.
        const drop = document.createElement('details'); drop.className = 'step-drop';
        const summary = document.createElement('summary');
        summary.textContent = 'Result · ' + total.toLocaleString() + (total === 1 ? ' character' : ' characters');
        drop.open = row.openChoice === undefined ? row.record.status === 'error' : row.openChoice;
        drop.addEventListener('toggle', () => { row.openChoice = drop.open; });
        drop.appendChild(summary);
        parts.forEach((node) => drop.appendChild(node));
        row.outputEl.appendChild(drop);
      } else {
        parts.forEach((node) => row.outputEl.appendChild(node));
      }
    } else if (status === 'running') {
      startRunningTicker(row);
    }
    refreshCurrentRow();
    if (activeTrace) updateStepsHead(activeTrace);
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
    const trace = activeTrace;
    stepRows.filter(row => !row.closed).forEach(row => closeStep(row,
      status === 'cancelled' ? 'Stopped before a result was returned.' : status === 'error' ? 'The request ended with an error.' : 'Completed.', status));
    saveSteps();
    updateStepsHead(trace);
    // Keep the rendered timeline and saved records; detach only active handles.
    stepsEl = null; activeTrace = null; stepRows = []; rowByUid = {}; activeResponseStep = null; currentStepRow = null;
  }

  function restoreTimelines(before) {
    for (const trace of (conv && conv.activity) || []) {
      if (trace.before !== before) continue;
      const region = createTimeline(trace);
      trace.steps.forEach((record, i) => {
        if (record.index === undefined) record.index = i + 1;
        const saved = record.status === 'running' ? { ...record, status: 'cancelled', result: 'Interrupted before a result was saved.' } : record;
        paintStep(region, saved);
      });
      updateStepsHead(trace, true);
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
                : (t.topic || t.name || t.command || t.operation || t.action);
      const label = {
        read: 'Read', glob: 'Find files', search: 'Search', list: 'List', shell: 'Run command', browse: 'Browse', websearch: 'Web search',
        browser_open: 'Browser: Open', browser_snapshot: 'Browser: Snapshot', browser_click: 'Browser: Click',
        browser_type: 'Browser: Type', browser_press: 'Browser: Press', browser_scroll: 'Browser: Scroll',
        browser_wait: 'Browser: Wait', browser_back: 'Browser: Back', browser_console: 'Browser: Console',
        browser_network: 'Browser: Network', browser_screenshot: 'Browser: Screenshot', browser_close: 'Browser: Close',
        todo_write: 'Update Plan', todo_read: 'Read Plan', tool_help: 'Tool Help',
      }[t.action] || t.action;
      addStepRow(t.uid, label + ': ' + detail);
      post('toolReq', Object.assign({}, t, { allowIdeContext: includeWorkspace }));
    });
  }

  function isUnfinishedUpdate(text) {
    const prose = String(text || '').replace(/```[\s\S]*?(?:```|$)/g, '').trim();
    // Recover clear promises of immediate work, not offers, questions, or
    // explanations that describe what somebody else could do. Models announce
    // the next step in many voices — "I'll inspect…", "Let me inspect…",
    // "Next I need to check…", or a headline trailer like "Reading the
    // reader's URL/IP validation now:" — and every one of them must continue
    // the run instead of ending it (users otherwise have to keep typing
    // "continue"). Summaries do not: summarize/conclude/explain are
    // deliberately absent from the verb set. The wait-state guard needs an
    // I/we subject so domain words like "blocked_address" or "cannot be
    // reached" never stop a run that is still making progress.
    if (!prose || prose.length > 1800 || isWaitingUpdate(prose)) return false;
    const subject = "(?:i(?:['’]ll| will|['’]m going to| am going to| need to| should| want to| have to)"
      + "|let me|let['’]s|we(?:['’]ll| will| need to| should))";
    const adverb = "(?:\\s+(?:now|next|first|then|also|quickly|carefully|just|really|still))?";
    const verb = "(?:continue|scan|inspect|read|search|check|review|investigate|fix|update|implement|patch|run|test|look|start|work|make|clean|refactor|examine|explore|trace|verify|debug|dig|find|grep|compare|open|list|confirm|locate|pinpoint|analyze|gather|determine|identify|ensure|double-check|rerun|re-read|dive)";
    const announced = "(?:^|[.!…\\n]\\s*)(?:(?:first|next|now|then)[,:]?\\s+)?" + subject + adverb + "\\s+" + verb + "\\b";
    if (new RegExp(announced, 'i').test(prose)) return true;
    // Present continuous — "I'm checking the UIs…", "I am now reading…",
    // "We're tracing…" — is the most common stall shape of all (a sentence
    // that describes current work instead of doing it).
    const continuous = "(?:^|[.!…\\n]\\s*)(?:(?:first|next|now|then)[,:]?\\s+)?(?:i['’]m|i am|we['’]re|we are)" + adverb + "\\s+\\w+ing\\b";
    if (new RegExp(continuous, 'i').test(prose)) return true;
    // Headline trailer: a final line that PROMISES the next action —
    // "Reading the reader's URL/IP validation now:", "Next: inspecting the
    // engine." — triggers even without a subject, while a plain result like
    // "Running the tests showed everything passes." does not.
    const lastLine = prose.split('\n').map((line) => line.trim()).filter(Boolean).pop() || '';
    // ANY gerund opens a headline trailer — "Emitting the reads … now:",
    // "Reading the reader's URL/IP validation now:". A fixed verb list kept
    // missing new phrasings (emitting, greeting, wiring…), so the SHAPE is
    // what matters: a line that STARTS with an -ing action and reads like a
    // headline (ends with : or contains "now"). Plain results ("Running the
    // tests showed everything passes.") carry neither.
    if (/^(?:(?:now|next|then)[,:]\s+)?[a-z]+ing\b/i.test(lastLine)
        && /[:…]\s*$|\bnow\b/i.test(lastLine)) return true;
    return new RegExp("^(?:now|next|then)[,:]\\s+(?:(?:[a-z]+ing)|(?:" + verb + "))\\b", 'i').test(lastLine);
  }

  /* The reply stops to ask something — a question, a go-ahead, or a blocking
   * state. That is "waiting for the user", not unfinished work: instead of an
   * automatic nudge, the confirmation panel below the bubble offers the
   * answer UI (option buttons + free text). */
  function isWaitingUpdate(text) {
    const prose = String(text || '').trim();
    if (!prose) return false;
    return /\?/.test(prose)
      || /\b(?:if you|would you|let me know|need your|awaiting|approval|permission to|shall i)\b/i.test(prose)
      || /\b(?:i|we)(?:['’]m|['’]re| am| are)?\s+(?:blocked|cannot|can['’]t)\b/i.test(prose);
  }

  function continueAgent(instruction) {
    if (!conv) return;
    const resultsText = contTools
      .map((t) => '[' + t.action + ' ' + (t.path || t.topic || t.name || t.command || t.pattern || t.url || t.query || t.operation || t.action) + ']\n' + t.result)
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
        includeIdeContext: includeWorkspace,
        think: false,
        webSearch: false,
        agentic: true,
      },
    });
  }

  function answerNow() {
    if (!busy || stopRequested || answeringNow || !conv) return;
    answeringNow = true;

    if (answerNowBtn) {
      answerNowBtn.disabled = true;
      answerNowBtn.textContent = 'Answering…';
    }

    const readyTools = contTools.filter((t) => t.result !== null && !String(t.result).startsWith('Cancelled by Answer now'));
    const pendingActionTools = contTools.filter((t) => t.result === null);

    pendingActionTools.forEach((t) => {
      t.result = 'Cancelled by Answer now.';
      const row = rowByUid[t.uid];
      if (row && !row.closed) closeStep(row, 'Skipped — Answer now requested.', 'cancelled');
    });
    contTools = [];
    contResolved = 0;

    stepRows.filter((row) => !row.closed).forEach((row) => {
      closeStep(row, 'Skipped — Answer now requested.', 'completed');
    });
    showStep('Answer now', true, 'Answering now with available context');

    let instruction = 'Answer the user request now using the context currently available. Provide a direct, concise and complete answer immediately without requesting additional tools or actions.';
    if (readyTools.length) {
      const resultsText = readyTools
        .map((t) => '[' + t.action + ' ' + (t.path || t.pattern || t.command || t.url || t.query) + ']\n' + t.result)
        .join('\n\n');
      instruction = 'TOOL RESULTS (results gathered before answering):\n\n' + resultsText
        + '\n\nAnswer the user request now using the context and results gathered above. Provide a direct, concise and complete answer immediately without requesting additional tools or actions.';
    }

    const cleanPending = typeof maskFenced === 'function'
      ? maskFenced(pendingText).replace(/…/g, '').trim()
      : String(pendingText || '').replace(/…/g, '').trim();
    const follow = agentMessages.concat([
      ...(cleanPending ? [{ role: 'assistant', content: cleanPending }] : []),
      { role: 'user', content: instruction },
    ]);
    agentMessages = follow;
    pendingText = '';
    agentRounds += 1;

    if (pendingBubble) {
      pendingBubble.textContent = '';
      showThinking();
    }

    post('chat', {
      body: {
        model: conv.model,
        stream: true,
        messages: follow,
        includeWorkspace: false,
        think: false,
        webSearch: false,
        agentic: false,
        quickAnswer: true,
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

  function setKeyVisibility(control, visible) {
    const field = control.querySelector('input');
    const button = control.querySelector('button');
    field.type = visible ? 'text' : 'password';
    button.title = visible ? 'Hide access key' : 'Show access key';
    button.setAttribute('aria-label', button.title);
    button.setAttribute('aria-pressed', String(visible));
  }

  function hideAccessKeys(except) {
    settingsPanel.querySelectorAll('.setting-secret').forEach(control => {
      if (!except || !control.contains(except)) setKeyVisibility(control, false);
    });
  }

  function accessKeyControl(field, onCommit) {
    const control = document.createElement('span');
    control.className = 'setting-secret';
    field.autocomplete = 'off';
    field.spellcheck = false;
    field.setAttribute('autocapitalize', 'off');
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'secret-toggle';
    button.setAttribute('aria-controls', field.id);
    button.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/><path class="eye-slash" d="m3 3 18 18"/></svg>';
    control.append(field, button);
    setKeyVisibility(control, false);
    // Changing an input's type can reset Chromium's native change tracking.
    // Commit on blur too, while keeping Enter/change to a single save.
    let committedValue = field.value;
    const commit = () => {
      if (field.value === committedValue) return;
      committedValue = field.value;
      onCommit();
    };
    field.addEventListener('focus', () => { committedValue = field.value; });
    field.addEventListener('change', commit);
    field.addEventListener('blur', commit);
    // Keep pointer clicks on the eye from committing the field through blur.
    button.addEventListener('pointerdown', event => event.preventDefault());
    button.addEventListener('click', () => {
      const visible = field.type === 'password';
      field.focus();
      setKeyVisibility(control, visible);
    });
    control.addEventListener('focusout', event => {
      if (!control.contains(event.relatedTarget)) setKeyVisibility(control, false);
    });
    control.addEventListener('keydown', event => {
      if (event.isComposing || (event.key !== 'Escape'
        && (event.key !== 'Enter' || event.target !== field))) return;
      event.preventDefault();
      event.stopPropagation();
      setKeyVisibility(control, false);
      if (control.contains(document.activeElement)) document.activeElement.blur();
    });
    return control;
  }

  document.addEventListener('pointerdown', event => hideAccessKeys(event.target));
  window.addEventListener('blur', () => hideAccessKeys());
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) hideAccessKeys();
  });

  const SETTING_FIELDS = [
    { key: 'model', label: 'Default model', type: 'text' },
    { key: 'temperature', label: 'Temperature (blank = provider default)', type: 'text' },
    { key: 'additionalHeaders', label: 'Extra headers (one Name: value per line)', type: 'text' },
    { key: 'workspaceContext', label: 'Workspace context', type: 'check' },
    { key: 'think', label: 'WhisperThink', type: 'check' },
    { key: 'thinkModel', label: 'Think model', type: 'text' },
    { key: 'webSearch', label: 'Web search', type: 'check' },
    { key: 'playwright', label: 'Playwright fetch', type: 'check' },
  ];

  /* Every output/effort budget is a user setting — nothing is hardcoded.
   * 0 means "no limit": the request goes out without the parameter and the
   * provider's own maximum applies. */
  const BUDGET_FIELDS = [
    { key: 'maxTokens', label: 'Answer tokens', type: 'number', min: 0, title: 'Output tokens for one answer. 0 = the provider decides.' },
    { key: 'thinkMaxTokens', label: 'Think tokens', type: 'number', min: 0, title: 'Output tokens for the private reasoning pass. 0 = the provider decides.' },
    { key: 'summaryMaxTokens', label: 'Summary tokens', type: 'number', min: 0, title: 'Output tokens for conversation compression. 0 = the provider decides (full room is recommended for reasoning models).' },
    { key: 'compressThink', label: 'Think during compression', type: 'check', title: 'Off (default): compression asks reasoning endpoints to skip the thinking trace — segments finish in seconds. On: the model may deliberate before writing the summary.' },
    { key: 'selectMaxTokens', label: 'Selection tokens', type: 'number', min: 0, title: 'Output tokens for the workspace file-selection pass. 0 = the provider decides.' },
    { key: 'toolResultBudgetKb', label: 'Tool results KB', type: 'number', min: 0, title: 'How much of a tool result is kept in context (read always keeps the complete result). 0 = no limit.' },
    { key: 'agentMaxRounds', label: 'Agent rounds', type: 'number', min: 0, title: 'Model \u2194 tool exchanges per request. 0 = no limit.' },
    { key: 'agentUnfinishedRetries', label: 'Unfinished retries', type: 'number', min: 0, title: 'Extra rounds when a reply announces work it never starts. 0 = no limit.' },
    { key: 'contextMaxKb', label: 'Context max KB', type: 'number', min: 8, title: 'Workspace source budget per request.' },
    { key: 'searchResults', label: 'Search results', type: 'number', min: 1, max: 10, title: 'Search results injected per question.' },
  ];

  function appendFieldRows(container, fields, cfg) {
    fields.forEach((f) => {
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
        if (f.title) { box.title = f.title; label.title = f.title; }
        row.appendChild(box);
        row.appendChild(label);
      } else {
        const label = document.createElement('label');
        label.htmlFor = id;
        label.textContent = f.label;
        if (f.title) label.title = f.title;
        const input = document.createElement('input');
        input.type = f.type;
        input.id = id;
        input.value = cfg[f.key] !== undefined ? String(cfg[f.key]) : '';
        if (f.min !== undefined) input.min = f.min;
        if (f.max !== undefined) input.max = f.max;
        if (f.title) input.title = f.title;
        input.addEventListener('change', () => post('setConfig', { key: f.key, value: input.value }));
        row.appendChild(label);
        row.appendChild(input);
      }
      container.appendChild(row);
    });
  }

  function updateProviderOptions(cfg) {
    providerSelect.replaceChildren(new Option('Free endpoints', 'endpoint'));
    const others = document.createElement('optgroup');
    others.label = 'Other providers';
    for (const endpoint of new Set(cfg.additionalEndpoints || [])) {
      if (endpoint.trim()) others.appendChild(new Option(endpoint, 'endpoint:' + endpoint));
    }
    others.appendChild(new Option('Microsoft 365 Copilot', 'copilot'));
    others.appendChild(new Option('ChatGPT', 'chatgpt'));
    others.appendChild(new Option('CodeGPT economy models', 'codegpt'));
    providerSelect.appendChild(others);
    providerSelect.value = cfg.providerSelection || cfg.provider || 'endpoint';
  }

  function renderConnectionPage() {
    const cfg = configCache || {};
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
      const saveKey = () => {
        if (!input.value.trim()) return;
        post('setConfig', { key: 'endpointAccessKey', endpoint: input.value.trim(), value: keyInput.value });
      };
      keyPanel.append(keyLabel, accessKeyControl(keyInput, saveKey));
      const keyButton = document.createElement('button');
      keyButton.type = 'button';
      keyButton.className = 'icon-btn endpoint-action endpoint-key-toggle';
      keyButton.innerHTML = '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M6.5 9.5a4 4 0 1 1 3-3L8 8l1.5 1.5L8 11 6.5 9.5 5 11v2H3v2H1v-3l5.5-5.5" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/><circle cx="11" cy="3" r=".8" fill="currentColor"/></svg>';
      keyButton.title = 'Edit access key';
      keyButton.setAttribute('aria-label', 'Edit access key');
      keyButton.setAttribute('aria-expanded', 'false');
      keyButton.setAttribute('aria-controls', keyPanel.id);
      keyButton.addEventListener('click', () => {
        keyPanel.hidden = !keyPanel.hidden;
        hideAccessKeys();
        keyButton.title = keyPanel.hidden ? 'Edit access key' : 'Close access key';
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
    appendFieldRows(settingsPanel, SETTING_FIELDS, cfg);

    /* Agent instructions — a NEW card appended after the existing fields.
     * Nothing above is reflowed. Empty means "use the built-in agent prompt",
     * so leaving it blank preserves today's behaviour exactly. */
    const agentRow = document.createElement('div');
    agentRow.className = 'setting-row agent-row';
    const agentLabel = document.createElement('label');
    agentLabel.htmlFor = 'set-agentTemplate';
    agentLabel.textContent = 'Agent instructions (blank = built-in)';
    const agentInput = document.createElement('textarea');
    agentInput.id = 'set-agentTemplate';
    agentInput.rows = 5;
    agentInput.className = 'agent-template';
    agentInput.spellcheck = false;
    agentInput.placeholder = 'Leave blank to use the built-in agent prompt.\nVariables: {{workspace}}, {{model}}, {{provider}}';
    agentInput.value = (cfg && cfg.agentTemplate) || '';
    agentInput.addEventListener('change', () => post('setConfig', { key: 'agentTemplate', value: agentInput.value }));
    const agentHint = document.createElement('div');
    agentHint.className = 'settings-hint';
    agentHint.textContent = 'The fenced ```edit / ```tool format is always appended, so edits keep working.';
    agentRow.appendChild(agentLabel);
    agentRow.appendChild(agentInput);
    agentRow.appendChild(agentHint);
    settingsPanel.appendChild(agentRow);
  }

  function renderBudgetsPage() {
    const cfg = configCache || {};
    const hint = document.createElement('div');
    hint.className = 'settings-hint';
    hint.textContent = 'Budgets are yours to set — 0 means no limit: the request goes out without the field and the provider’s own maximum applies.';
    settingsPanel.appendChild(hint);
    appendFieldRows(settingsPanel, BUDGET_FIELDS, cfg);
  }

  /* The gear opens a two-page sheet; the icon tabs switch pages. Connection
   * keeps endpoints + behaviour controls, Budgets carries every cap the agent
   * respects while it works. */
  let settingsPage = 'connection';
  function renderSettings() {
    const pageIcon = {
      connection: '<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" aria-hidden="true"><path d="M6 1.5v3.2M10 1.5v3.2M4.2 4.7h7.6v1.8a3.8 3.8 0 0 1-7.6 0V4.7z"/><path d="M8 10.3v4.2"/></svg>',
      budgets: '<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" aria-hidden="true"><path d="M2 4h12M2 8h12M2 12h12"/><circle cx="6" cy="4" r="1.5" fill="var(--reach-surface)"/><circle cx="10.5" cy="8" r="1.5" fill="var(--reach-surface)"/><circle cx="5" cy="12" r="1.5" fill="var(--reach-surface)"/></svg>',
    };
    settingsPanel.innerHTML = '';
    const tabs = document.createElement('div');
    tabs.className = 'settings-tabs';
    tabs.setAttribute('role', 'tablist');
    [['connection', 'Connection'], ['budgets', 'Budgets']].forEach(([page, label]) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'settings-tab' + (settingsPage === page ? ' active' : '');
      button.setAttribute('role', 'tab');
      button.setAttribute('aria-selected', String(settingsPage === page));
      button.innerHTML = pageIcon[page] + '<span>' + label + '</span>';
      button.addEventListener('click', (event) => {
        // Switching re-renders the sheet, which detaches this button before
        // the click reaches the document handler — stop here so the
        // outside-click test can’t mistake the detached target for a click
        // somewhere else and close the panel.
        event.stopPropagation();
        if (settingsPage === page) return;
        settingsPage = page;
        renderSettings();
      });
      tabs.appendChild(button);
    });
    settingsPanel.appendChild(tabs);
    if (settingsPage === 'budgets') renderBudgetsPage();
    else renderConnectionPage();

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

  /* `groups` is the optional sectioned form: [{label, models}]. When present
   * it renders as <optgroup>s so the CodeGPT economy models are a distinct
   * section under Free endpoints. Falls back to a flat list when absent, so an
   * older host that only sends `models` still works. */
  function setModelOptions(models, current, groups) {
    modelSelect.innerHTML = '';
    const sectioned = Array.isArray(groups) && groups.some((g) => g && g.models && g.models.length);
    const sources = sectioned ? groups.filter((g) => g && g.models && g.models.length) : [{ label: '', models }];
    sources.forEach((group) => {
      const target = group.label ? document.createElement('optgroup') : modelSelect;
      if (group.label) target.label = group.label;
      group.models.forEach((m) => {
        const opt = document.createElement('option');
        opt.value = m;
        opt.textContent = m;
        if (m === current) opt.selected = true;
        target.appendChild(opt);
      });
      if (group.label) modelSelect.appendChild(target);
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
    answeringNow = false;
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
      ? 'System tray running (Copilot & ChatGPT bridge :21302)'
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
    answeringNow = false;
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
    dismissConfirmPanels();
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
    const typed = input.value.trim();
    // A pending chip is expanded here, once, into the exact string the old
    // filled-textarea path produced: buildSlashPrompt(cmd, rest). `typed` is
    // that same `rest`. Callers without a chip (askAbout, the queue) are
    // unaffected; the expansion is a no-op when pendingSlash is null.
    const text = pendingSlash ? buildSlashPrompt(pendingSlash, typed) : typed;
    // A chip with an empty box is still a complete request (e.g. /commit-style
    // templates the user wants verbatim), but a plain empty box is not.
    if (!text && !pendingSlash) return;
    if (!pendingSlash && !typed) return;
    pendingSlash = null;
    renderSlashChip();
    input.value = '';
    if (!text) return;
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
        applyAgentLimits(msg);
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
        applyAgentLimits(configCache);
        updateProviderOptions(configCache);
        if (msg.key === 'provider' || previousSelection !== providerSelect.value) { clearChat(true); post('getConfig'); }
        if (msg.config && msg.config.endpoint) endpointLine.textContent = msg.config.endpoint;
        break;
      }
      case 'models':
        if ((msg.providerSelection || msg.provider) !== providerSelect.value) break;
        endpointLine.textContent = msg.endpoint || endpointLine.textContent;
        setModelOptions(msg.models, (conv && conv.model) || modelSelect.value || null, msg.groups);
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
        const isAnsweringNow = typeof answeringNow !== 'undefined' && Boolean(answeringNow);
        const aborted = (msg.aborted && !isAnsweringNow) || stopRequested;
        if (rafPending && pendingBubble) {
          rafPending = false;
          setRich(pendingBubble, maskFenced(pendingText));
        }
        if (pendingBubble && msg.full !== undefined) {
          pendingText = msg.full;
          setRich(pendingBubble, maskFenced(pendingText));
        }
        // An empty, unaborted "done" is a failed round, not an answer: it used
        // to close the response step as "Response shown below." over an empty
        // bubble, hiding the real failure behind a green timeline (2026-09-10).
        if (!aborted && !isAnsweringNow && !String(pendingText || '').trim() && !pendingEdits.length) {
          const note = 'The provider returned an empty response — nothing was streamed. Retry, or check the tray / CodeGPT connection.';
          if (activeResponseStep) closeStep(rowByUid[activeResponseStep], note, 'error');
          else showStep('No reply', true, '', note);
          finishBubble('error');
          const emptyErr = document.createElement('div');
          emptyErr.className = 'bubble error';
          emptyErr.textContent = '⚠ ' + note;
          log.appendChild(emptyErr);
          scrollBottom();
          break;
        }
        let tools = [];
        let confirm = null;
        if (agenticEnabled) {
          const parsedE = extractEdits(pendingText);
          if (parsedE.edits.length) pendingEdits = pendingEdits.concat(parsedE.edits);
          if (!isAnsweringNow) {
            const parsedT = extractTools(parsedE.text);
            tools = parsedT.tools;
            const parsedC = extractConfirm(parsedT.text);
            confirm = parsedC.confirm;
            if (parsedC.text !== pendingText) {
              pendingText = parsedC.text;
              if (pendingBubble) setRich(pendingBubble, pendingText);
            }
          }
        }
        if (!aborted && !isAnsweringNow && tools.length && agentRounds < MAX_AGENT_ROUNDS) {
          continuationRetries = 0;
          if (activeResponseStep) closeStep(rowByUid[activeResponseStep], pendingText || 'Requested ' + tools.length + ' workspace action(s).');
          else if (pendingText) showStep('Assistant update', true, '', pendingText);
          beginToolRound(tools);
          break;
        }
        // INVARIANT, not phrasing: once a run has actually used tools, a
        // reply that still asks for nothing is chased again no matter how it
        // is worded — announcing, musing, or plainly stalling. Two ways out:
        // the model states a completion, or it repeats itself verbatim
        // (nothing new to say). Wait-states fall through to the confirm panel.
        const waitingNow = typeof isWaitingUpdate === 'function' ? isWaitingUpdate(pendingText) : false;
        const settled = !waitingNow && (
          /\b(?:is|are|was|were|now|has|have|had)\s+(?:done|completed?|finished|fixed|resolved|implemented|ready)\b/i.test(String(pendingText || ''))
          || /^\s*(?:done|completed?|finished|fixed|ready)\b/i.test(String(pendingText || ''))
          || /\bnothing (?:left|else) (?:to do|for me)\b/i.test(String(pendingText || '')));
        const previousAssistant = (() => {
          const pools = [agentMessages, conv && conv.messages];
          for (const pool of pools) {
            if (!Array.isArray(pool)) continue;
            for (let i = pool.length - 1; i >= 0; i -= 1) {
              if (pool[i] && pool[i].role === 'assistant') return String(pool[i].content || '');
            }
          }
          return '';
        })();
        const normalize = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
        const repeated = previousAssistant !== '' && normalize(previousAssistant) === normalize(pendingText);
        const unfinished = !isAnsweringNow && agenticEnabled && !tools.length && !pendingEdits.length && !confirm
          && (isUnfinishedUpdate(pendingText)
              || (agentRounds > 0 && !settled && !waitingNow && !(continuationRetries > 0 && repeated)));
        if (!aborted && unfinished && continuationRetries < UNFINISHED_RETRY_LIMIT && agentRounds < MAX_AGENT_ROUNDS) {
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
        // A reply that stops to ask something earns a confirmation panel with
        // the model's own options — one click answers it — instead of leaving
        // the user to spell the answer out in the composer.
        let confirmPayload = confirm;
        if (!confirmPayload && !aborted && !isAnsweringNow && agenticEnabled && !tools.length && !pendingEdits.length
            && !unfinished && waitingNow) {
          confirmPayload = { question: '', options: [] };
        }
        if (activeResponseStep) closeStep(rowByUid[activeResponseStep], aborted ? 'Stopped.' : 'Response shown below.', aborted ? 'cancelled' : 'completed');
        if (pendingText && pendingBubble && conv) {
          conv.messages.push({ role: 'assistant', content: pendingText });
          conv.ts = Date.now();
          saveConv();
        }
        finishBubble(aborted || paused ? 'cancelled' : 'completed');
        if (confirmPayload && typeof showConfirmPanel === 'function') showConfirmPanel(confirmPayload);
        if (typeof answeringNow !== 'undefined') answeringNow = false;
        if (aborted) hint(pickFun(ABORT_LINES));
        break;
      }
      case 'todos':
        renderTodoCard(msg.todos);
        break;
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
        answeringNow = false;
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
      case 'localCommandResult': {
        // /vram, /gpu, /ollama — local hardware facts, printed verbatim.
        const node = pendingLocal[msg.uid];
        if (node) { delete pendingLocal[msg.uid]; node.remove(); }
        const card = document.createElement('div');
        card.className = 'local-card';
        const head = document.createElement('div');
        head.className = 'local-head';
        head.textContent = msg.title || msg.uid || 'local';
        const pre = document.createElement('pre');
        pre.className = 'local-body';
        pre.textContent = String(msg.text || '(no output)');
        card.append(head, pre);
        const copyBtn = document.createElement('button');
        copyBtn.className = 'local-copy';
        copyBtn.textContent = 'Copy';
        copyBtn.addEventListener('click', () => copyText(pre.textContent));
        card.appendChild(copyBtn);
        log.appendChild(card);
        scrollBottom();
        break;
      }
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
        if (msg.note) noteStep(msg.uid, msg.note);
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
      case 'ideContextInfo': {
        const label = msg.available ? 'VS Code context ready' : 'VS Code context unavailable';
        showStep(label, true, label + ' — editor, Git and extension metadata', msg.context || '');
        wsCount.title = label + '. Run REACH: Inspect VS Code Context to review the live snapshot.';
        break;
      }
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
        } else {
          wsCount.title = 'Open folder: ' + msg.roots.join(', ') + ' — Agent mode includes full folder contents.';
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
          if (msg.already) {
            // The change is already in the file: the card is done — no error,
            // and no "Apply:" timeline step for a no-op.
            if (!busy) endStep();
            rec.status.textContent = '✓ already applied — nothing left to change';
            rec.status.className = 'edit-status ok';
          } else {
            showStep('Apply: ' + msg.path, true, '', msg.unsaved ? 'Updated the editor buffer; changes remain unsaved.' : 'Applied and saved.');
            if (!busy) endStep();
            if (!appliedEdits.includes(msg.path)) appliedEdits.push(msg.path);
            rec.status.textContent = msg.unsaved ? 'Applied · unsaved' : '✓ applied';
            rec.status.className = 'edit-status ok';
          }
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
    answeringNow = false;
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
    // The event path is fixed when the click is dispatched, so it still names
    // a control that re-rendered its panel mid-dispatch (page tabs, delete
    // buttons): `contains` alone would see a detached target and close the
    // whole panel as if the click had landed outside it.
    const clickPath = typeof e.composedPath === 'function' ? e.composedPath() : [];
    const inside = (panel) => panel.contains(e.target) || clickPath.includes(panel);
    if (!settingsPanel.hidden && !inside(settingsPanel) && !settingsBtn.contains(e.target)) {
      settingsPanel.hidden = true;
      settingsBtn.classList.remove('open');
    }
    if (!searchResults.hidden && !inside(searchResults) && !searchInput.contains(e.target)) {
      searchResults.hidden = true;
    }
    if (!historyPanel.hidden && !inside(historyPanel) && !historyBtn.contains(e.target)) {
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
  /* ---------- slash commands (typed "/" -> filtered menu) ----------
   *
   * Typing "/" as the first character of the composer opens a filtered list of
   * commands, exactly like a normal IDE. Filtering by what follows the slash,
   * Arrow Up/Down (or Ctrl+Click-free hover) moves the selection, Enter runs
   * the highlighted one, Tab completes it, Escape closes. Clicking an item and
   * typing its name are the same path: both call runSlash().
   *
   * A command is a prompt template. Expanding it fills the composer rather than
   * sending immediately, so the user can add context first — except commands
   * marked send:true, which dispatch at once.
   */
  const SLASH_COMMANDS = [
    { name: '/review', desc: 'Review the current selection or open file',
      prompt: 'Review this code for correctness, edge cases and clarity. Point out concrete problems with file and line, then propose fixes.\n\n' },
    { name: '/explain', desc: 'Explain what the selected code does',
      prompt: 'Explain what this code does, step by step, then note anything surprising or risky.\n\n' },
    { name: '/fix', desc: 'Find and fix a bug in the selection',
      prompt: 'Find the bug in this code, explain the root cause briefly, then emit the corrected code as an ```edit block.\n\n' },
    { name: '/test', desc: 'Write tests for the selection',
      prompt: 'Write focused tests for this code, covering the happy path and the edge cases that matter. Emit new files as ```edit blocks.\n\n' },
    { name: '/commit', desc: 'Draft a commit message for the staged changes',
      prompt: 'Draft a conventional-commit message for the current staged and unstaged changes. Inspect the diff first with the shell or read tools if you need to. Output only the message.',
      send: true },
    { name: '/read', desc: 'Read a file into the conversation',
      prompt: 'Read the file I name next and summarise its structure.\n\n' },
    { name: '/search', desc: 'Search the workspace for a pattern',
      prompt: 'Search the workspace for the pattern I name next and report every meaningful hit with file and line.\n\n' },
    { name: '/help', desc: 'Show what REACH can do',
      prompt: 'Briefly list what you can do here: agentic code edits as diffs, workspace reading and search, running approved shell commands, web search and browsing. Keep it short.',
      send: true },

    /* ---- planning + implementation ---- */
    { name: '/goal', desc: 'Turn this request into a measurable goal',
      prompt: 'Goal: ' },  // completed by buildSlashPrompt: fills in a goal-oriented template
    { name: '/plan', desc: 'Plan the work before touching code',
      prompt: 'Plan the work for this request BEFORE changing any files. Inspect whatever you need with read/glob/search/list first, then answer with:\n1. Goal and explicit acceptance criteria\n2. Files to change with the exact path and why\n3. Ordered steps, each independently verifiable\n4. Risks, unknowns and the assumptions you are making\n5. How the change will be verified (tests, commands)\nDo not emit edit blocks in this reply.\n\nRequest: ' },
    { name: '/implement', desc: 'Implement the plan and apply the edits',
      prompt: 'Implement this now, end to end. Read every file you change before you change it, emit ```edit blocks for each change, then state exactly how the result should be verified.\n\nImplement: ' },
    { name: '/debug', desc: 'Diagnose and fix the failure',
      prompt: 'Diagnose this failure: reproduce it from the code and tests you can read, state the root cause with evidence (file and line), then fix it and say how you verified the fix.\n\nProblem: ' },
    { name: '/refactor', desc: 'Refactor without changing behaviour',
      prompt: 'Refactor this to be smaller and clearer without changing behaviour. Call out anything that could still be observed differently, then emit the change as an ```edit block.\n\nRefactor: ' },
    { name: '/docs', desc: 'Document the selection or project',
      prompt: 'Write accurate documentation for this — what it does, its inputs and outputs, and its failure modes. Doc-comments in place; emit ```edit blocks.\n\nDocument: ' },

    /* ---- workspace + subagents ---- */
    { name: '/workspace', desc: 'Summarise the project structure',
      prompt: 'List the project folders and describe the structure of this workspace: the top-level components, what each one is for, and how they connect. Cite the file that proves each claim. Then name the three files a newcomer should read first.',
      send: true },
    { name: '/agent', desc: 'Delegate this to a sub-agent',
      prompt: 'Delegate this to a sub-agent. Give it a self-contained brief first — the goal, the files it owns, what it must not touch, and how it reports back — then, acting as that sub-agent, do the work and return the result.\n\nTask: ' },
    { name: '/status', desc: 'Report state: git, tests, TODOs',
      prompt: 'Report the current state of this workspace: git branch and outstanding changes, TODO/FIXME markers worth knowing about, and how to run the tests. Use the git tool and a workspace search; do not guess.',
      send: true },
    { name: '/todos', desc: 'Re-open the structured plan',
      prompt: 'Read the current structured plan (todo_read), list it with the completed/total count, then propose the next concrete step.',
      send: true },

    /* ---- runtime / hardware (runs locally, no model call) ---- */
    { name: '/vram', desc: 'Show GPU + VRAM usage (local)', local: true, action: 'vram' },
    { name: '/gpu', desc: 'Show GPU: usage, memory, temperature (local)', local: true, action: 'gpu' },
    { name: '/ollama', desc: 'Show local models and what they hold in VRAM (local)', local: true, action: 'ollama' },
  ];

  let slashItems = [];        // currently filtered commands
  let slashIndex = 0;         // highlighted item
  let slashOpen = false;
  // The range of the typed query (the "/word" at the caret), so expansion can
  // replace exactly that text rather than the whole box.
  let slashQueryStart = -1;

  function slashQuery() {
    const value = input.value;
    const caret = input.selectionStart;
    if (caret === null) return null;
    // Only when the slash sits at the very start of the composer, which keeps
    // this from firing on a stray "and/or" mid-sentence.
    if (value[0] !== '/') return null;
    const upto = value.slice(0, caret);
    const m = /^\/([^\s]*)$/.exec(upto);
    if (!m) return null;
    return { word: m[1], start: 0, end: caret };
  }

  function hideSlash() {
    slashOpen = false;
    slashMenu.hidden = true;
    slashMenu.innerHTML = '';
    slashItems = [];
    slashIndex = 0;
  }

  function renderSlash() {
    slashMenu.innerHTML = '';
    if (!slashItems.length) {
      const empty = document.createElement('div');
      empty.className = 'slash-empty';
      empty.textContent = 'No matching commands';
      slashMenu.appendChild(empty);
      return;
    }
    slashItems.forEach((cmd, i) => {
      const b = document.createElement('button');
      b.className = 'slash-item' + (i === slashIndex ? ' active' : '');
      b.type = 'button';
      b.setAttribute('role', 'option');
      b.setAttribute('aria-selected', i === slashIndex ? 'true' : 'false');
      const name = document.createElement('span');
      name.className = 'slash-cmd';
      name.textContent = cmd.name;
      const desc = document.createElement('span');
      desc.className = 'slash-desc';
      desc.textContent = cmd.desc;
      b.appendChild(name);
      b.appendChild(desc);
      // Mouse and keyboard share runSlash, so clicking and typing agree.
      b.addEventListener('mousedown', (e) => { e.preventDefault(); runSlash(i); });
      b.addEventListener('mouseenter', () => { slashIndex = i; renderSlash(); });
      slashMenu.appendChild(b);
    });
  }

  function openSlash(query) {
    const q = query.word.toLowerCase();
    slashItems = SLASH_COMMANDS.filter((c) =>
      c.name.slice(1).toLowerCase().startsWith(q)
      || c.desc.toLowerCase().includes(q));
    if (!slashItems.length && !q) slashItems = SLASH_COMMANDS.slice();
    slashIndex = 0;
    slashQueryStart = query.start;
    slashOpen = true;
    slashMenu.hidden = false;
    renderSlash();
  }

  /* A few commands are templates rather than fixed text: their real prompt
   * depends on what the user typed after the name (e.g. "/goal ship v2"). */
  function buildSlashPrompt(cmd, rest) {
    const subject = rest || '';
    if (cmd.name === '/goal') {
      return 'Turn the following into one measurable goal, then work to it.\n\n'
        + 'Goal: ' + subject + '\n\n'
        + 'Restate it as: (a) the outcome in one sentence, (b) the acceptance criteria as a short checklist, '
        + '(c) explicitly out of scope. Keep it to a compact block, then say what you will do first.\n';
    }
    return cmd.prompt + subject;
  }

  // name -> placeholder node, so a slow probe can be replaced by its result
  // even if the webview re-renders while it runs.
  const pendingLocal = {};

  /* Local commands never reach the model: they run in the extension and print
   * their output straight into the transcript. */
  function runLocalSlash(cmd) {
    const node = hint('⏳ ' + cmd.name + ' — collecting local GPU data…');
    post('localCommand', { action: cmd.action, uid: cmd.name });
    pendingLocal[cmd.name] = node;
  }

  /* A picked command is held here rather than pasted into the textarea as its
   * full template. The composer shows a compact chip; the template is expanded
   * at send time by the same buildSlashPrompt() the old path used, so the text
   * that reaches the model is unchanged. Transient by design: never persisted,
   * never written into conv.messages. */
  let pendingSlash = null;

  function renderSlashChip() {
    const bar = document.getElementById('slash-chip-bar');
    if (!bar) return;
    bar.innerHTML = '';
    bar.hidden = !pendingSlash;
    if (!pendingSlash) return;
    const chip = document.createElement('span');
    chip.className = 'slash-chip';
    const name = document.createElement('span');
    name.className = 'slash-chip-cmd';
    name.textContent = pendingSlash.name;
    const desc = document.createElement('span');
    desc.className = 'slash-chip-desc';
    desc.textContent = pendingSlash.desc;
    const clear = document.createElement('button');
    clear.className = 'slash-chip-clear';
    clear.type = 'button';
    clear.setAttribute('aria-label', 'Remove ' + pendingSlash.name);
    clear.title = 'Remove command (Backspace on an empty box) — the text is not sent';
    clear.textContent = '\u00d7';
    clear.addEventListener('mousedown', (e) => {
      e.preventDefault();
      pendingSlash = null;
      renderSlashChip();
      input.focus();
    });
    chip.append(name, desc, clear);
    bar.appendChild(chip);
  }

  function clearSlashChip() {
    if (!pendingSlash) return false;
    pendingSlash = null;
    renderSlashChip();
    return true;
  }

  function runSlash(index) {
    const cmd = slashItems[index];
    if (!cmd) return;
    // Replace just the typed "/word", keeping any text the user added after it.
    const value = input.value;
    const query = slashQuery();
    const upto = query ? query.end : 0;
    const rest = value.slice(upto).replace(/^\s+/, '');
    hideSlash();
    if (cmd.local) { runLocalSlash(cmd); return; }
    if (cmd.send) {
      // Dispatch-at-once commands keep their old behaviour exactly.
      input.value = buildSlashPrompt(cmd, rest);
      send();
      return;
    }
    // Template commands become a chip; the user's own words go in the box and
    // arrive as `rest` at send time, exactly as if they had followed the name.
    pendingSlash = cmd;
    input.value = rest;
    renderSlashChip();
    input.focus();
    input.selectionStart = input.selectionEnd = input.value.length;
  }

  // Keep the menu in step with what is typed. This runs on every input event,
  // including paste and programmatic changes, so the menu never goes stale.
  function syncSlash() {
    const query = slashQuery();
    if (!query) { if (slashOpen) hideSlash(); return; }
    openSlash(query);
  }

  input.addEventListener('input', syncSlash);
  input.addEventListener('click', syncSlash);
  input.addEventListener('blur', () => { if (slashOpen) hideSlash(); });

  function moveSlash(delta) {
    if (!slashItems.length) return;
    slashIndex = (slashIndex + delta + slashItems.length) % slashItems.length;
    renderSlash();
    const active = slashMenu.querySelector('.slash-item.active');
    if (active && active.scrollIntoView) active.scrollIntoView({ block: 'nearest' });
  }

  input.addEventListener('keydown', (e) => {
    // The slash menu intercepts navigation and Enter *only while it is open*,
    // so a normal message is never hijacked.
    if (slashOpen) {
      if (e.key === 'ArrowDown') { e.preventDefault(); moveSlash(1); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); moveSlash(-1); return; }
      if (e.key === 'Escape') { e.preventDefault(); hideSlash(); return; }
      if (e.key === 'Tab') { e.preventDefault(); runSlash(slashIndex); return; }
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        runSlash(slashIndex);
        return;
      }
    }
    // With a chip pending, Backspace on an empty box removes it — the usual
    // "delete the token to the left" gesture, applied to the command token.
    if (e.key === 'Backspace' && pendingSlash && !input.value && !slashOpen) {
      e.preventDefault();
      clearSlashChip();
      return;
    }
    if (e.key === 'Escape' && pendingSlash && !slashOpen) {
      e.preventDefault();
      clearSlashChip();
      return;
    }
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
