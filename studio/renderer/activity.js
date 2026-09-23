/* Adapted from vscode/media/chat.js activity rows and live timing. */
(() => {
  const model = window.ReachActivityState, states = new Map(), views = new Map();
  let selected = null, frame = false;
  const panel = document.querySelector('#agent-activity');
  const badge = document.querySelector('#activity-global');
  const scroller = document.querySelector('#chat-scroll');
  let teamVisible = false, concealed = false, lastScroll = scroller.scrollTop;
  function updateVisibility() {
    const unavailable = teamVisible || !states.get(selected);
    const hidden = !unavailable && concealed && !panel.querySelector(':focus-visible');
    panel.classList.toggle('is-concealed', hidden);
    panel.inert = unavailable || hidden;
    panel.setAttribute('aria-hidden', String(unavailable || hidden));
  }
  scroller.addEventListener('scroll', () => {
    const next = scroller.scrollTop, delta = next - lastScroll;
    if (next <= 8) concealed = false;
    else if (Math.abs(delta) >= 2) concealed = delta > 0;
    lastScroll = next;
    updateVisibility();
  }, { passive: true });
  panel.addEventListener('focusout', () => queueMicrotask(updateVisibility));
  function createView(host) {
    host.classList.add('activity-panel');
    host.innerHTML = '<div class="activity-head"><span class="activity-spinner" aria-hidden="true"></span><strong class="activity-title" role="status" aria-live="polite"></strong><span class="activity-time"></span></div><p class="activity-note"></p><div class="activity-progress" aria-hidden="true"><i></i></div><details class="activity-details"><summary>Agent activity <span class="activity-count"></span></summary><div class="activity-steps" tabindex="0" role="region" aria-label="Agent activity steps"></div></details>';
    return { host, rows: new Map() };
  }
  const mainView = createView(panel);
  function text(el, value) { if (el.textContent !== value) el.textContent = value; }
  function paint(view, state, now, key) {
    const host = view.host;
    host.classList.toggle('hidden', !state || view === mainView && teamVisible);
    if (!state) return;
    const summary = model.summary(state, now);
    view.card?._teamDeck?.update(view.card, state, now);
    const session = key + ':' + state.startedAt;
    const details = host.querySelector('.activity-details');
    // Every new trace starts compact; updates (including completion) respect
    // the user's choice to open or close it. Shared by agents and team workers.
    if (view.session !== session) details.open = false;
    view.session = session;
    host.dataset.status = state.status;
    host.dataset.active = String(summary.active && !summary.waiting);
    host.dataset.waiting = String(summary.waiting || summary.silent);
    text(host.querySelector('.activity-title'), summary.title);
    text(host.querySelector('.activity-time'), summary.elapsed + ' elapsed');
    text(host.querySelector('.activity-note'), summary.detail);
    text(host.querySelector('.activity-count'), `· ${state.count} steps${state.round ? ' · round ' + state.round : ''}`);
    const items = host.querySelector('.activity-steps');
    // Keep details nodes stable while counters update so expanded results stay open.
    const keys = new Set();
    for (const step of state.steps) {
      const key = state.startedAt + ':' + step.index; keys.add(key);
      let row = view.rows.get(key);
      if (!row) {
        row = document.createElement('article');
        row.innerHTML = '<div class="activity-step-head"><span class="activity-number"></span><strong></strong><span class="activity-step-time"></span></div><p></p><details class="activity-result"><summary></summary><pre></pre></details>';
        items.appendChild(row); view.rows.set(key, row);
      }
      row.className = 'activity-step ' + step.status;
      text(row.querySelector('.activity-number'), String(step.index) + '.');
      text(row.querySelector('strong'), step.title);
      const label = { running:'Running', waiting:'Waiting', done:'Done', paused:'Paused', error:'Failed' }[step.status];
      text(row.querySelector('.activity-step-time'), `${label} · ${model.duration((step.endedAt || now) - step.startedAt)}`);
      text(row.querySelector('p'), (step.note || '') + (!step.endedAt ? ` · last update ${model.duration(now - step.updatedAt)} ago` : ''));
      const result = row.querySelector('.activity-result');
      result.hidden = !step.result;
      if (step.result) { text(result.querySelector('summary'), `Result · ${step.result.length.toLocaleString()} characters`); text(result.querySelector('pre'), step.result); }
    }
    for (const [key, row] of view.rows) if (!keys.has(key)) { row.remove(); view.rows.delete(key); }
  }
  function render() {
    frame = false;
    const now = Date.now();
    paint(mainView, states.get(selected), now, selected);
    updateVisibility();
    for (const [key, view] of views) {
      if (!view.host.isConnected) {
        // Switching conversations temporarily detaches a live team. Its tabs
        // must recover the same activity when the user switches back.
        if (view.card?._teamDeck && (!view.card._teamDeck.ended || view.card._teamDeck.element._retainTeamView)) continue;
        view.card?._teamDeck?.dispose();
        views.delete(key); states.delete(key); continue;
      }
      paint(view, states.get(key), now, key);
    }
    const count = [...states.values()].filter(s => s?.status === 'running').length;
    badge.hidden = count === 0;
    text(badge.querySelector('span'), `${count} active`);
    const current = model.summary(states.get(selected), now);
    document.querySelector('#agent-status').classList.toggle('activity-busy', current.active && !current.waiting);
    document.querySelector('#btn-send').classList.toggle('activity-busy', current.active && !current.waiting);
    document.querySelector('#chat-log').setAttribute('aria-busy', String(current.active));
  }
  function schedule() { if (!frame) { frame = true; setTimeout(() => requestAnimationFrame(render), 80); } }
  function ingest(event, key = event.agentId) {
    if (!key) return;
    const state = model.reduce(states.get(key), event);
    if (state) states.set(key, state);
    schedule();
  }
  function select(agent) {
    selected = agent?.id || null;
    lastScroll = scroller.scrollTop;
    concealed = false;
    if (agent?.activity && (!states.has(selected) || agent.activity.updatedAt > states.get(selected).updatedAt)) states.set(selected, structuredClone(agent.activity));
    if (agent?.runState?.status === 'running' && !states.has(selected)) ingest({ type:'run-state', status:'running', agentId:selected });
    schedule();
  }
  function setTeamVisible(visible) {
    teamVisible = !!visible;
    panel.classList.toggle('hidden', teamVisible || !states.get(selected));
    updateVisibility();
    schedule();
  }
  function team(event, card) {
    const prefix = 'team:' + event.teamRunId + ':';
    if (card) {
      const key = prefix + (event.type === 'subagent' ? event.agentId : event.index);
      if (!views.has(key)) { const host = document.createElement('div'); card.appendChild(host); views.set(key, { ...createView(host), card }); }
      const type = event.memberType || event.netType || event.type;
      let normalized = { ...event, type };
      if (['member-start','member-resumed','agent-started','agent-resumed'].includes(type)) normalized = { type:'run-state', status:'running' };
      if (['member-done','agent-state'].includes(type)) normalized = { type:'run-state', status:event.status || (event.ok ? 'completed' : 'error'), reason:event.error };
      if (['member-control','agent-control'].includes(type)) normalized = { type:'run-state', status:event.paused ? 'paused' : 'running' };
      if (['member-waiting','agent-waiting','member-question','agent-question'].includes(type)) normalized = { type:'run-state', status: type.includes('question') ? 'waiting_input' : 'waiting_edits' };
      ingest(normalized, key);
    }
    if (['done','error','control'].includes(event.type)) {
      for (const [key, state] of states) if (key.startsWith(prefix) && !['completed', 'error', 'stalled'].includes(state.status)) {
        // Team-wide stop/start should also update paused members; finished
        // members must retain their outcome and never regain a live spinner.
        if (event.type === 'control' && !['running', 'paused'].includes(state.status)) continue;
        ingest({ type:'run-state', status:event.type === 'control' ? (event.paused ? 'paused' : 'running') : event.type === 'error' ? 'error' : 'stopped' }, key);
      }
    }
  }
  window.ReachActivity = { ingest, select, team, setTeamVisible };
  setInterval(() => { if ([...states.values()].some(s => s?.status === 'running')) schedule(); }, 1000);
})();
