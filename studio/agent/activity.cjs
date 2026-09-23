/* Shared event model for Studio's VS Code-style activity timeline.
 * Timers measure waiting; only provider/tool events count as reported activity.
 *
 * ENGINE-OWNED (plan item E9). This module is the single source of truth for the
 * activity reducer. It used to live in renderer/activity-state.js, which meant
 * agent-loop.cjs and agent-store.cjs imported a UI file: the engine could not be
 * unit-tested or packaged headlessly, and a renderer refactor could break a run.
 *
 * The reducer is pure and dependency-free, so the same source runs in both
 * places. `renderer/activity-state.js` is GENERATED from this file by
 * scripts/build-activity.cjs (npm run build:activity) because the renderer loads
 * its scripts as plain <script> tags under CSP 'self' and cannot require(). The
 * generated file carries a sha256 header of this file, and activity.test.cjs
 * fails if the two ever diverge. Edit THIS file, never the generated one.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ReachActivityState = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const relevant = new Set(['run-state','round','request-start','message-start','reasoning','delta','message-end','tool-call','tool-result','approval-wait','approval-end','rate-limit','retry','budget-recovery','recovery','compaction-start','compaction-progress','compacted','code-context','jev-context','jev-auto','error','stopped']);
  function reduce(state, event, now = event.at || Date.now()) {
    if (!relevant.has(event.type)) return state;
    if (!state || event.type === 'run-state' && event.status === 'running' && state.status !== 'running') {
      state = { status: 'running', startedAt: now, updatedAt: now, steps: [], count: 0, round: 0 };
    }
    state.updatedAt = now;
    let step = state.steps.at(-1);
    const close = (status = 'done', result) => {
      if (!step || step.endedAt) return;
      step.status = status; step.endedAt = now;
      if (result !== undefined) step.result = String(result).slice(0, 6000);
    };
    const start = (title, note, kind) => {
      close();
      step = { index: ++state.count, title, note, kind, startedAt: now, updatedAt: now, status: 'running', chars: 0, reasoning: 0 };
      state.steps.push(step);
      if (state.steps.length > 80) state.steps.shift();
    };
    const note = text => { if (step) { step.note = text; step.updatedAt = now; } };
    switch (event.type) {
      case 'run-state':
        state.status = event.status;
        if (event.status === 'running') { if (!step) start('Prepare request', 'Preparing conversation context', 'prepare'); }
        else { close(event.status === 'completed' ? 'done' : event.status === 'error' ? 'error' : 'paused'); state.endedAt = now; state.reason = event.reason || ''; }
        break;
      case 'round': state.round = event.round; break;
      case 'jev-auto': {
        const usage = event.usage ? ` · ${event.usage.inputTokens} Jev input tokens` : '';
        const action = event.label || 'Kept your selected setup';
        start('Jev Auto', action + usage + (event.cached ? ' · cached' : ''), 'prepare');
        close('done', action + (event.reason ? ` · ${event.reason}` : '') + usage);
        break;
      }
      case 'jev-context': {
        const action = event.reason === 'jev-skip' ? 'Skipped unrelated code context'
          : event.reason === 'jev-keep' ? 'Kept code context'
            : event.reason === 'missing-key' ? 'Kept code context · add a TypeSafe key in Settings'
              : event.reason?.startsWith('http-') ? `Kept code context · Jev ${event.reason.replace('http-', 'HTTP ')}`
                : event.reason === 'request-failed' ? 'Kept code context · Jev request failed'
                  : 'Kept code context after Jev fallback';
        const usage = event.usage?.inputTokens ? ` · ${event.usage.inputTokens} Jev input tokens` : '';
        start('Jev context selection', action + usage + (event.cached ? ' · cached' : ''), 'prepare');
        close('done', action + usage);
        break;
      }
      case 'code-context':
        // Injection is invisible work that changes what the model sees, so it
        // belongs in the trail — but only when something was actually injected.
        // A skip is normal (greeting, near the compaction trigger) and would
        // only add noise. Emitted before request-start, so it closes as its own
        // completed step ahead of 'Generate response'.
        if (event.injected) {
          const matched = Array.isArray(event.symbols) ? event.symbols : [];
          start('Gather codebase context', matched.length
            ? `Matched ${matched.length} symbol(s) from the project index` : 'Injected relevant symbols', 'prepare');
          if (matched.length) note(matched.slice(0, 6).map(s => `${s.name} (${s.path}:${s.line})`).join(', '));
          close('done', event.chars ? `${Number(event.chars).toLocaleString()} characters injected` : undefined);
        }
        break;
      case 'compaction-progress': note(event.note); break;
      case 'compaction-start': start(event.total ? `Compress context · segment ${event.segment} of ${event.total}` : 'Compress context', 'Preparing a conversation summary', 'compress'); break;
      case 'compacted': close('done', `Context reduced from ${event.before} to ${event.after} characters`); break;
      case 'request-start':
        if (event.purpose === 'summary') { if (step?.kind !== 'compress') start('Compress context', 'Waiting for summary response', 'compress'); }
        else start('Generate response', 'Request sent · waiting for response headers', 'generate');
        break;
      case 'message-start':
        if (step?.kind !== 'generate' || step.endedAt) start('Generate response', 'Response opened · waiting for content', 'generate');
        else note('Response opened · waiting for content');
        break;
      case 'reasoning':
        if (!step || step.endedAt) start('Generate response', '', 'generate');
        step.reasoning = event.chars || 0;
        note(`Model is reasoning · ${step.reasoning.toLocaleString()} characters received`); break;
      case 'delta':
        if (!step || step.endedAt) start('Generate response', '', 'generate');
        step.chars += String(event.text || '').length;
        note(`Receiving response · ${step.chars.toLocaleString()} characters received`); break;
      case 'message-end': close(event.error ? 'error' : 'done', event.error || event.content || 'Response received'); break;
      case 'tool-call': {
        const label = { read:'Read file', search:'Search workspace', list:'List files', shell:'Run command', browse:'Browse page', websearch:'Search the web', write:'Prepare edit', edit:'Prepare edit' }[event.tool] || event.tool;
        start(label, `Starting ${event.tool}`, 'tool');
        step.tool = event.tool;
        const target = event.arguments?.path || event.arguments?.query || event.arguments?.url;
        if (typeof target === 'string') step.note = target.slice(0, 250);
        break;
      }
      case 'approval-wait': if (step) step.status = 'waiting'; note('Waiting for your approval'); break;
      case 'approval-end': if (step && !step.endedAt) step.status = 'running'; note('Approval received · continuing'); break;
      case 'tool-result': close(event.pending ? 'waiting' : event.ok ? 'done' : 'error', event.error || JSON.stringify(event.result || {}).slice(0, 6000)); break;
      case 'budget-recovery': start('Finish within budget', event.note, 'budget'); break;
      case 'rate-limit':
        start('Provider rate limit', event.note || 'Slowing this crew\u2019s requests', 'rate-limit');
        close('waiting', event.note || 'Waiting for the provider to accept requests again');
        break;
      case 'retry': close('error', event.error); start('Retry request', event.error || 'Retrying the provider request', 'retry'); break;
      case 'recovery': start('Request executable actions', event.reason || 'Requesting a usable action response', 'recovery'); break;
      case 'error': close('error', event.message); state.status = 'error'; state.endedAt = now; state.reason = event.message; break;
      case 'stopped': close('paused'); state.status = 'stopped'; state.endedAt = now; break;
    }
    return state;
  }
  function duration(ms) {
    const seconds = Math.max(0, Math.floor(ms / 1000));
    return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  }
  function summary(state, now = Date.now()) {
    const step = state?.steps.at(-1);
    if (!state) return { active: false, title: '', detail: '' };
    const active = state.status === 'running';
    const waiting = active && step?.status === 'waiting';
    const silent = active && !waiting && now - state.updatedAt >= 30000;
    return { active, waiting, silent,
      title: !active ? ({ completed:'Completed', paused:'Paused', stopped:'Stopped', stalled:'Stalled', waiting_input:'Waiting for your answer', waiting_edits:'Waiting for edit review', error:'Failed' }[state.status] || state.status)
        : waiting ? step?.kind === 'rate-limit' ? 'Waiting for the provider' : 'Waiting for your approval' : silent ? 'Waiting for an update' : step?.note?.startsWith('Model is reasoning') ? 'Thinking' : step?.title || 'Working',
      detail: active ? (silent ? `No new activity for ${duration(now - state.updatedAt)} · request is still pending` : step?.note || 'Preparing request') : state.status === 'completed' ? 'Response saved in the conversation.' : state.reason || 'Activity saved',
      elapsed: duration((state.endedAt || now) - state.startedAt),
      age: duration(now - (step?.updatedAt || state.updatedAt)) };
  }
  return { reduce, duration, summary };
});
