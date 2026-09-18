'use strict';

/* Reach Studio — interactive prompt console (PRD US-2 / "API Playground").
 *
 * A throwaway completion tester that is deliberately NOT a conversation: it
 * sends one chat/completions request against the configured endpoint, streams
 * the response, and reports the metrics the PRD asks for — time-to-first-token,
 * total latency, tokens/second, and token count. Upstream errors surface as a
 * descriptive status with the HTTP code rather than a generic failure.
 *
 * Streaming is driven over IPC (playground:token events) because the renderer
 * cannot hold the endpoint access key. See main.mjs `playground:run`.
 */
(() => {
  const $ = sel => document.querySelector(sel);

  const els = {
    model: $('#pg-model'),
    modelList: $('#pg-model-list'),
    browse: $('#pg-browse'),
    temp: $('#pg-temp'),
    tempVal: $('#pg-temp-val'),
    max: $('#pg-max'),
    stream: $('#pg-stream'),
    system: $('#pg-system'),
    prompt: $('#pg-prompt'),
    run: $('#pg-run'),
    stop: $('#pg-stop'),
    clear: $('#pg-clear'),
    status: $('#pg-status'),
    output: $('#pg-output'),
    ttft: $('#pg-ttft'),
    elapsed: $('#pg-elapsed'),
    tps: $('#pg-tps'),
    tokens: $('#pg-tokens'),
    rawWrap: $('#pg-raw-wrap'),
    raw: $('#pg-raw'),
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
  }
  function resetMetrics() {
    state.firstTokenAt = 0; state.chars = 0; state.tokens = 0;
    for (const el of [els.ttft, els.elapsed, els.tps, els.tokens]) if (el) el.textContent = '—';
  }

  async function browseModels() {
    if (!els.browse) return;
    els.browse.disabled = true;
    try {
      const res = await window.reach.listModels();
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
      setStatus(models.length ? `${models.length} model(s) from the endpoint.` : 'Endpoint returned no models.', models.length ? 'ok' : 'bad');
    } catch (e) {
      setStatus('Could not list models: ' + e.message, 'bad');
    } finally { els.browse.disabled = false; }
  }

  async function loadDefaultModel() {
    try {
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
      system: (els.system?.value || '').trim(),
      prompt,
      stream: els.stream?.checked !== false,
      temperature,
      maxTokens,
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
      window.ReachDialogs?.notice('Prompt console request failed: ' + e.message);
      return;
    }

    // For a streaming run, main.mjs resolves once the stream closes and the
    // tokens have already arrived via playground:token. For a non-streaming run
    // the whole text comes back in res.
    if (!payload.stream && res && res.ok && typeof res.text === 'string') {
      appendText(res.text);
      finalize(res.usage || null, res.latencyMs);
    }
    if (!res || !res.ok) {
      setRunning(false);
      const code = res && res.status ? ` (HTTP ${res.status})` : '';
      const msg = (res && res.err) || 'Unknown error';
      setStatus('Upstream error' + code + ': ' + msg, 'bad');
      // PRD: timeout / rate-limit errors display formatted error with status codes
      window.ReachDialogs?.notice(`Completion failed${code}: ${msg}`);
      return;
    }
    if (payload.stream) finalize(res.usage || null, res.latencyMs);
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

  function finalize(usage, latencyMs) {
    setRunning(false);
    const totalMs = Number.isFinite(latencyMs) ? Math.round(latencyMs) : Math.round(performance.now() - state.startedAt);
    if (els.elapsed) els.elapsed.textContent = totalMs + ' ms';
    const completionTokens = usage && Number.isFinite(usage.completion_tokens)
      ? usage.completion_tokens
      : Math.max(state.tokens, Math.round(state.chars / 4));
    state.tokens = completionTokens;
    if (els.tokens) els.tokens.textContent = String(completionTokens);
    if (els.tps && totalMs > 0) els.tps.textContent = (completionTokens / (totalMs / 1000)).toFixed(1);
    if (usage && els.raw) {
      els.raw.textContent = JSON.stringify(usage, null, 2);
      if (els.rawWrap) els.rawWrap.hidden = false;
    }
    setStatus(completionTokens ? `Done · ${completionTokens} tokens · ${totalMs} ms` : `Done · ${totalMs} ms`, 'ok');
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
    setStatus('');
    els.prompt?.focus();
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
    els.clear?.addEventListener('click', clear);
    els.temp?.addEventListener('input', () => { if (els.tempVal) els.tempVal.textContent = (parseFloat(els.temp.value) || 0).toFixed(2); });
    els.prompt?.addEventListener('keydown', (e) => {
      // Ctrl/Cmd+Enter runs, matching the composer's send shortcut elsewhere.
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); run(); }
    });
  }

  window.ReachPlayground = { run, stop, clear, browseModels };

  function init() { bind(); loadDefaultModel(); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
