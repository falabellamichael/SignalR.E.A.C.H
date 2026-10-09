'use strict';

/* Reach Studio — prompt studio bench (PRD US-2 / API Playground).
 *
 * A workstation for one completion. It is not a conversation: one request goes
 * to the configured endpoint, the response streams onto the bench, and the run
 * stays in the bench log. Metrics are time-to-first-token, total latency,
 * tokens/second, token count, finish reason, and reasoning size.
 *
 * Streaming is driven over IPC (playground:token events) because the renderer
 * cannot hold the endpoint access key. See main.mjs `playground:run`.
 */
(() => {
  const $ = sel => document.querySelector(sel);
  const LOG_KEY = 'reach.promptStudio.log';
  const LOG_MAX = 12;
  const LOG_VISIBLE = 3;
  const LOG_OUTPUT = 8000;

  /* System presets are bench setups, not chats. Temperature is only written
     when the preset names one, so Blank leaves the slider where it is. */
  const PRESETS = [
    { id: 'direct', name: 'Direct', temp: 0.2, hint: 'Answer the request and stop.', system: 'Answer the request directly. No preamble and no closing remark.' },
    { id: 'review', name: 'Review', temp: 0.3, hint: 'Findings first, then what is missing.', system: 'Review the text for correctness, missing cases, and unclear claims. Lead with the findings.' },
    { id: 'extract', name: 'Extract', temp: 0, hint: 'JSON only, no markdown fence.', system: 'Extract the requested structure. Reply with JSON only, no markdown fence.' },
    { id: 'rewrite', name: 'Rewrite', temp: 0.4, hint: 'Same meaning, tighter sentences.', system: 'Rewrite the text. Preserve the meaning. Prefer shorter sentences. Do not add claims.' },
    { id: 'diff', name: 'Diff', temp: 0.2, hint: 'What changed, the risk, and what did not.', system: 'Read the change as a reviewer. Name the behavior that changed, the risk, and what was left untouched.' },
    { id: 'blank', name: 'Blank', temp: null, hint: 'Clear the system prompt.', system: '' },
  ];

  const els = {
    conn: $('#pg-conn'),
    model: $('#pg-model'),
    modelSrc: $('#pg-model-src'),
    modelList: $('#pg-model-list'),
    browse: $('#pg-browse'),
    temp: $('#pg-temp'),
    tempVal: $('#pg-temp-val'),
    max: $('#pg-max'),
    stream: $('#pg-stream'),
    controls: $('#pg-controls'),
    system: $('#pg-system'),
    prompt: $('#pg-prompt'),
    run: $('#pg-run'),
    stop: $('#pg-stop'),
    logStop: $('#pg-log-stop'),
    clear: $('#pg-clear'),
    copyPrompt: $('#pg-copy-prompt'),
    copyOutput: $('#pg-copy-output'),
    status: $('#pg-status'),
    output: $('#pg-output'),
    ttft: $('#pg-ttft'),
    elapsed: $('#pg-elapsed'),
    tps: $('#pg-tps'),
    tokens: $('#pg-tokens'),
    finish: $('#pg-finish'),
    reason: $('#pg-reason'),
    rawWrap: $('#pg-raw-wrap'),
    raw: $('#pg-raw'),
    presets: $('#pg-presets'),
    budgetTokens: $('#pg-budget-tokens'),
    budgetDetail: $('#pg-budget-detail'),
    log: $('#pg-log'),
    logClear: $('#pg-log-clear'),
  };

  const state = { running: false, runId: null, startedAt: 0, firstTokenAt: 0, chars: 0, tokens: 0 };

  function setStatus(text, kind) {
    if (!els.status) return;
    els.status.textContent = text || '';
    els.status.className = 'dim' + (kind ? ' pg-' + kind : '');
  }
  function setRunning(on) {
    state.running = on;
    if (els.run) els.run.disabled = on;
    if (els.stop) els.stop.disabled = !on;
    if (els.logStop) els.logStop.disabled = !on;
  }
  function resetMetrics() {
    state.firstTokenAt = 0; state.chars = 0; state.tokens = 0;
    for (const el of [els.ttft, els.elapsed, els.tps, els.tokens, els.finish, els.reason]) {
      if (el) el.textContent = '—';
    }
  }

  function updateBudget() {
    const system = els.system?.value || '';
    const prompt = els.prompt?.value || '';
    const tokens = Math.ceil((system.length + prompt.length) / 4);
    if (els.budgetTokens) els.budgetTokens.textContent = tokens ? '~' + tokens : '0';
    if (els.budgetDetail) els.budgetDetail.textContent = system.length + ' system · ' + prompt.length + ' prompt';
  }

  function markPreset(id) {
    els.presets?.querySelectorAll('.pg-preset').forEach(btn => {
      btn.setAttribute('aria-pressed', btn.dataset.preset === id ? 'true' : 'false');
    });
  }

  function applyPreset(id) {
    const preset = PRESETS.find(item => item.id === id);
    if (!preset || !els.system) return;
    els.system.value = preset.system;
    if (preset.temp != null && els.temp) {
      els.temp.value = String(preset.temp);
      if (els.tempVal) els.tempVal.textContent = preset.temp.toFixed(2);
    }
    markPreset(id);
    updateBudget();
    els.prompt?.focus();
  }

  function syncPreset() {
    const system = els.system?.value || '';
    const match = PRESETS.find(item => item.system === system);
    markPreset(match ? match.id : '');
  }

  function renderPresets() {
    if (!els.presets) return;
    els.presets.textContent = '';
    for (const preset of PRESETS) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'pg-preset';
      btn.dataset.preset = preset.id;
      btn.textContent = preset.name;
      btn.title = preset.hint;
      btn.setAttribute('aria-pressed', 'false');
      btn.addEventListener('click', () => applyPreset(preset.id));
      els.presets.appendChild(btn);
    }
  }

  function readLog() {
    try {
      const parsed = JSON.parse(localStorage.getItem(LOG_KEY) || '[]');
      return Array.isArray(parsed) ? parsed : [];
    } catch { return []; }
  }

  function writeLog(entries) {
    try { localStorage.setItem(LOG_KEY, JSON.stringify(entries.slice(0, LOG_MAX))); }
    catch { /* a full store must not block the run */ }
  }

  function formatWhen(at) {
    const date = new Date(at);
    if (Number.isNaN(date.getTime())) return '';
    return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }

  function restoreRun(entry) {
    if (!entry) return;
    if (els.system) els.system.value = entry.system || '';
    if (els.prompt) els.prompt.value = entry.prompt || '';
    if (els.model && entry.model) els.model.value = entry.model;
    if (els.output) els.output.textContent = entry.output || '';
    if (els.temp && Number.isFinite(entry.temperature)) {
      els.temp.value = String(entry.temperature);
      if (els.tempVal) els.tempVal.textContent = Number(entry.temperature).toFixed(2);
    }
    if (els.max && Number.isFinite(entry.maxTokens)) els.max.value = String(entry.maxTokens);
    if (els.stream) els.stream.checked = entry.stream !== false;
    if (els.ttft) els.ttft.textContent = entry.ttft || '—';
    if (els.elapsed) els.elapsed.textContent = entry.elapsed || '—';
    if (els.tps) els.tps.textContent = entry.tps || '—';
    if (els.tokens) els.tokens.textContent = entry.tokens == null ? '—' : String(entry.tokens);
    if (els.finish) els.finish.textContent = entry.finish || '—';
    if (els.reason) els.reason.textContent = entry.reason || '—';
    if (els.raw) els.raw.textContent = entry.usage || '';
    if (els.rawWrap) els.rawWrap.hidden = !entry.usage;
    syncPreset();
    updateBudget();
    setStatus('Restored from the bench log.', 'ok');
  }

  function logItem(entry) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'pg-log-item';
    btn.title = 'Restore this run onto the bench';
    const when = document.createElement('span');
    when.textContent = formatWhen(entry.at);
    const name = document.createElement('span');
    name.textContent = (entry.prompt || entry.err || 'Run').replace(/\s+/g, ' ');
    const meta = document.createElement('span');
    meta.className = 'dim';
    const bits = [];
    if (entry.model) bits.push(entry.model);
    if (entry.tokens != null) bits.push(entry.tokens + ' tok');
    if (!entry.ok) bits.push('failed');
    meta.textContent = bits.join(' · ');
    btn.append(when, name, meta);
    btn.addEventListener('click', () => restoreRun(entry));
    return btn;
  }

  function renderLog() {
    if (!els.log) return;
    const entries = readLog();
    els.log.textContent = '';
    if (!entries.length) {
      const empty = document.createElement('p');
      empty.className = 'dim pg-log-empty';
      empty.textContent = 'Completed runs stay on this bench.';
      els.log.appendChild(empty);
      return;
    }
    for (const entry of entries.slice(0, LOG_VISIBLE)) els.log.appendChild(logItem(entry));
    const rest = entries.slice(LOG_VISIBLE);
    if (!rest.length) return;
    const more = document.createElement('details');
    more.className = 'pg-log-more';
    const summary = document.createElement('summary');
    summary.textContent = rest.length === 1 ? '1 earlier run' : rest.length + ' earlier runs';
    const list = document.createElement('div');
    list.className = 'pg-log-more-list';
    for (const entry of rest) list.appendChild(logItem(entry));
    more.append(summary, list);
    els.log.appendChild(more);
  }

  function rememberRun(extra) {
    const prompt = (els.prompt?.value || '').trim();
    if (!prompt && !(extra && extra.err)) return;
    const entry = {
      at: Date.now(),
      ok: !extra || extra.ok !== false,
      model: (els.model?.value || '').trim(),
      system: els.system?.value || '',
      prompt,
      output: (els.output?.textContent || '').slice(0, LOG_OUTPUT),
      temperature: parseFloat(els.temp?.value ?? '0.7'),
      maxTokens: parseInt(els.max?.value || '0', 10) || 0,
      stream: els.stream?.checked !== false,
      ttft: els.ttft?.textContent || '—',
      elapsed: els.elapsed?.textContent || '—',
      tps: els.tps?.textContent || '—',
      tokens: els.tokens && els.tokens.textContent !== '—' ? Number(els.tokens.textContent) : null,
      finish: els.finish?.textContent || '—',
      reason: els.reason?.textContent || '—',
      usage: els.raw?.textContent || '',
      err: extra && extra.err ? String(extra.err).slice(0, 240) : '',
    };
    if (!Number.isFinite(entry.tokens)) entry.tokens = null;
    writeLog([entry, ...readLog()].slice(0, LOG_MAX));
    renderLog();
  }

  async function copyText(text, okLabel) {
    if (!text) { setStatus('Nothing to copy.', 'bad'); return; }
    try {
      await navigator.clipboard.writeText(text);
      setStatus(okLabel, 'ok');
    } catch (e) {
      setStatus('Could not copy: ' + e.message, 'bad');
    }
  }

  function promptBundle() {
    const system = (els.system?.value || '').trim();
    const prompt = (els.prompt?.value || '').trim();
    if (system && prompt) return 'System:\n' + system + '\n\nPrompt:\n' + prompt;
    return prompt || system;
  }

  async function browseModels() {
    if (!els.browse) return;
    els.browse.disabled = true;
    try {
      // List from the connection THIS console is pointed at, not the globally
      // active one: with several providers configured, browsing the wrong
      // endpoint yields model ids that then fail at request time.
      const target = window.ReachConnections?.connectionId('playground') || undefined;
      const res = await window.reach.listModels(target);
      if (!res.ok) { setStatus(res.err || 'Could not list models.', 'bad'); return; }
      const models = res.models || [];
      if (els.modelList) {
        els.modelList.textContent = '';
        for (const m of models) els.modelList.appendChild(new Option(m, m));
      }
      if (els.model) {
        // Keep a typed model editable while still offering the fetched list.
        els.model.readOnly = false;
        els.model.setAttribute('list', 'pg-model-list');
        if (!els.model.value && models.length) els.model.value = models[0];
      }
      // Say whose models these are. The server's own connection name is
      // authoritative; fall back to the picker's label for an ad-hoc lookup.
      const from = res.connectionName || window.ReachConnections?.currentLabel('playground') || '';
      if (els.modelSrc) els.modelSrc.textContent = from ? `from ${from}` : '';
      setStatus(models.length ? `${models.length} model(s) from ${from || 'the endpoint'}.` : 'Endpoint returned no models.', models.length ? 'ok' : 'bad');
    } catch (e) {
      setStatus('Could not list models: ' + e.message, 'bad');
    } finally { els.browse.disabled = false; }
  }

  async function loadDefaultModel() {
    try {
      // The selected connection's own default model, not the global one.
      const conn = window.ReachConnections?.current('playground');
      if (els.model && conn && conn.model && !els.model.value) els.model.value = conn.model;
      if (!els.model || els.model.value) return;
      const s = await window.reach.getSettings();
      if (els.model && s.model && !els.model.value) els.model.value = s.model;
    } catch { /* settings unavailable is not fatal here */ }
  }

  async function run() {
    if (state.running) return;
    const prompt = (els.prompt?.value || '').trim();
    if (!prompt) { setStatus('Enter a prompt first.', 'bad'); return; }
    const model = (els.model?.value || '').trim();
    if (!model) { setStatus('Choose a model first.', 'bad'); window.ReachDialogs?.notice('Pick a model with Browse before running a completion.'); return; }

    const maxTokens = Math.max(0, parseInt(els.max?.value || '0', 10) || 0);
    const temperature = Math.max(0, Math.min(2, parseFloat(els.temp?.value ?? '0.7')));
    // The run id ties playground:token events back to THIS request. Without it
    // a slow first run's tokens would render into a second run's output pane.
    state.runId = 'pg_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
    const payload = {
      runId: state.runId,
      model,
      // Route at the connection the console is pointed at. Omitting this would
      // run against the ACTIVE connection while the UI shows another one — the
      // kind of mismatch that costs tokens on the wrong provider.
      connectionId: window.ReachConnections?.connectionId('playground') || undefined,
      system: (els.system?.value || '').trim(),
      prompt,
      stream: els.stream?.checked !== false,
      temperature,
      maxTokens,
      // Bridges that reject sampling fields ask for this to be false. The
      // relay still strips controls it does not honour.
      controls: els.controls ? els.controls.checked : true,
    };

    if (els.output) els.output.textContent = '';
    if (els.raw) els.raw.textContent = '';
    if (els.rawWrap) els.rawWrap.hidden = true;
    resetMetrics();
    setRunning(true);
    state.startedAt = performance.now();
    setStatus('Sending…');

    let res;
    try {
      res = await window.reach.playground.run(payload);
    } catch (e) {
      setRunning(false);
      setStatus('Request failed: ' + e.message, 'bad');
      window.ReachDialogs?.notice('Prompt studio request failed: ' + e.message);
      rememberRun({ ok: false, err: e.message });
      return;
    }

    // For a streaming run, main.mjs resolves once the stream closes and the
    // tokens have already arrived via playground:token. For a non-streaming run
    // the whole text comes back in res.
    if (!payload.stream && res && res.ok && typeof res.text === 'string') {
      appendText(res.text);
      finalize(res);
    }
    if (!res || !res.ok) {
      setRunning(false);
      const code = res && res.status ? ` (HTTP ${res.status})` : '';
      const msg = (res && res.err) || 'Unknown error';
      setStatus('Upstream error' + code + ': ' + msg, 'bad');
      // PRD: timeout / rate-limit errors display formatted error with status codes
      window.ReachDialogs?.notice(`Completion failed${code}: ${msg}`);
      rememberRun({ ok: false, err: msg });
      return;
    }
    if (payload.stream) finalize(res);
  }

  function appendText(chunk) {
    if (!els.output || !chunk) return;
    if (!state.firstTokenAt) {
      state.firstTokenAt = performance.now();
      const ttft = Math.round(state.firstTokenAt - state.startedAt);
      if (els.ttft) els.ttft.textContent = ttft + ' ms';
    }
    els.output.textContent += chunk;
    state.chars += chunk.length;
    // Live tokens/second against elapsed stream time.
    const secs = (performance.now() - state.startedAt) / 1000;
    if (els.tps && secs > 0.05 && state.tokens > 0) els.tps.textContent = (state.tokens / secs).toFixed(1);
    els.output.scrollTop = els.output.scrollHeight;
  }

  function finalize(res) {
    const usage = res && res.usage;
    const latencyMs = res && res.latencyMs;
    setRunning(false);
    const totalMs = Number.isFinite(latencyMs) ? Math.round(latencyMs) : Math.round(performance.now() - state.startedAt);
    if (els.elapsed) els.elapsed.textContent = totalMs + ' ms';
    const completionTokens = usage && Number.isFinite(usage.completion_tokens)
      ? usage.completion_tokens
      : Math.max(state.tokens, Math.round(state.chars / 4));
    state.tokens = completionTokens;
    if (els.tokens) els.tokens.textContent = String(completionTokens);
    if (els.tps && totalMs > 0) els.tps.textContent = (completionTokens / (totalMs / 1000)).toFixed(1);
    if (els.finish) els.finish.textContent = (res && res.finishReason) || '—';
    if (els.reason) els.reason.textContent = res && res.reasoningChars ? String(res.reasoningChars) : '—';
    if (usage && els.raw) {
      els.raw.textContent = JSON.stringify(usage, null, 2);
      if (els.rawWrap) els.rawWrap.hidden = false;
    }
    setStatus(completionTokens ? `Done · ${completionTokens} tokens · ${totalMs} ms` : `Done · ${totalMs} ms`, 'ok');
    rememberRun({ ok: true });
  }

  function stop() {
    if (!state.running) return;
    window.reach.playground.stop(state.runId).catch(() => {});
    setStatus('Stopping…');
  }

  function clear() {
    if (els.prompt) els.prompt.value = '';
    if (els.output) els.output.textContent = '';
    if (els.raw) els.raw.textContent = '';
    if (els.rawWrap) els.rawWrap.hidden = true;
    resetMetrics();
    updateBudget();
    syncPreset();
    setStatus('');
    els.prompt?.focus();
  }

  function clearLog() {
    writeLog([]);
    renderLog();
  }

  // Streaming token events from main.mjs.
  window.reach.playground.onToken?.((d) => {
    if (!d || d.runId !== state.runId) return;
    if (typeof d.delta === 'string') appendText(d.delta);
    if (Number.isFinite(d.tokens)) state.tokens = d.tokens;
  });

  function bind() {
    els.browse?.addEventListener('click', browseModels);
    els.run?.addEventListener('click', run);
    els.stop?.addEventListener('click', stop);
    els.logStop?.addEventListener('click', stop);
    els.clear?.addEventListener('click', clear);
    els.copyPrompt?.addEventListener('click', () => copyText(promptBundle(), 'Copied the prompt.'));
    els.copyOutput?.addEventListener('click', () => copyText(els.output?.textContent || '', 'Copied the response.'));
    els.logClear?.addEventListener('click', clearLog);
    els.system?.addEventListener('input', () => { syncPreset(); updateBudget(); });
    els.prompt?.addEventListener('input', updateBudget);
    // Changing connection invalidates the model list: models are per-endpoint, so
    // the previously fetched ids may not exist on the new one. Clear the field and
    // the datalist rather than let a stale id be submitted.
    window.ReachConnections?.bind('playground', els.conn, {
      onChange: () => {
        if (els.modelList) els.modelList.textContent = '';
        if (els.model) { els.model.value = ''; els.model.readOnly = true; els.model.removeAttribute('list'); }
        if (els.modelSrc) els.modelSrc.textContent = '';
        loadDefaultModel();
      },
    });
    els.temp?.addEventListener('input', () => { if (els.tempVal) els.tempVal.textContent = (parseFloat(els.temp.value) || 0).toFixed(2); });
    els.prompt?.addEventListener('keydown', (e) => {
      // Ctrl/Cmd+Enter runs, matching the composer's send shortcut elsewhere.
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); run(); }
    });
  }

  window.ReachPlayground = { run, stop, clear, browseModels, sync, applyPreset };

  // Repopulate the connection picker (settings may have changed since this page
  // was built) and re-read the default model for whatever is now selected.
  async function sync() {
    await window.ReachConnections?.refresh('playground');
    await loadDefaultModel();
    updateBudget();
    renderLog();
  }

  function init() {
    renderPresets();
    bind();
    updateBudget();
    renderLog();
    sync();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
