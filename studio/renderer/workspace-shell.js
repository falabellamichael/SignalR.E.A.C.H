'use strict';

/* Reach Studio — workspace shell: persistent nav rail, Ctrl/Cmd+1-6 hotkeys,
 * the bottom status bar, and the Workspace dashboard.
 *
 * PRD sources:
 *   Navigation Design §1  Sidebar Quick-Navigation Menu with Cmd/Ctrl+1-6
 *   Navigation Design §3  Persistent Bottom Status Bar across all routes
 *   Design Principle 3    Native Ergonomics & Keyboard First
 *   Design Principle 2    Immediate feedback without blocking the workflow
 *
 * Relay management is out of scope for this build, so the status bar reports
 * the configured OpenAI-compatible endpoint rather than a reachd daemon, and
 * the Workspace dashboard renders LOCAL system telemetry only (telemetry.cjs
 * samples CPU/RAM/GPU/processes without contacting any relay).
 *
 * Everything here is additive: the existing header tabs keep working, and
 * showTab() stays the single source of truth for which page is active.
 */
(() => {
  const $ = sel => document.querySelector(sel);

  /* Views this build has, in hotkey order. The PRD's /aliases, /logs,
   * /tray-settings and /app-settings routes are relay management and are not
   * part of this scope, so 1-6 cover the views that exist. */
  const VIEWS = [
    { key: '1', view: 'workspace', label: 'Workspace' },
    { key: '2', view: 'playground', label: 'Playground' },
    { key: '3', view: 'projects', label: 'Projects' },
    { key: '4', view: 'agents', label: 'Agents' },
    { key: '5', view: 'create', label: 'Create' },
    { key: '6', view: 'settings', label: 'Settings' },
  ];
  const ALL_VIEWS = VIEWS.map(v => v.view).concat(['refactor', 'about']);

  /* ------------------------------------------------------------- nav rail */

  const rail = $('#nav-rail');
  let railViews = ALL_VIEWS;

  function activeView() {
    const page = document.querySelector('.page.active');
    return page ? page.id.replace(/^page-/, '') : null;
  }

  function markRail() {
    const current = activeView();
    if (!rail) return;
    for (const button of rail.querySelectorAll('.rail-item')) {
      const on = button.dataset.view === current;
      button.classList.toggle('active', on);
      button.setAttribute('aria-current', on ? 'page' : 'false');
    }
  }

  /* showTab() is a top-level function declaration in app.js, so it is a real
   * global (function declarations land on globalThis). currentAgent and
   * currentProject are `let` bindings — lexical globals that are NOT properties
   * of window, exactly like telemetry.js reaches them. Referencing them via
   * window.* would silently read undefined, so use the bare identifiers.
   * app.js is loaded before this file, so they are initialized by now. */
  async function goView(view) {
    if (!ALL_VIEWS.includes(view)) return false;
    if (typeof showTab === 'function') {
      // showTab() already marks the rail and syncs the workspace/about views,
      // so this path must not repeat that work.
      await showTab(view);
      return true;
    }
    for (const page of document.querySelectorAll('.page')) page.classList.remove('active');
    const target = $('#page-' + view);
    if (!target) return false;
    target.classList.add('active');
    markRail();
    if (view === 'workspace') window.ReachWorkspaceDash?.sync();
    if (view === 'about') window.ReachAbout?.sync();
    return true;
  }

  if (rail) {
    for (const button of rail.querySelectorAll('.rail-item')) {
      button.addEventListener('click', () => {
        goView(button.dataset.view).catch(e => window.ReachDialogs?.notice(e.message));
      });
    }
    rail.addEventListener('keydown', (e) => {
      if (!['ArrowDown', 'ArrowUp'].includes(e.key)) return;
      e.preventDefault();
      const items = [...rail.querySelectorAll('.rail-item')];
      const i = items.indexOf(document.activeElement);
      if (i < 0) return;
      items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length].focus();
    });
  }

  /* Keyboard-first navigation. Guarded so it never fires while typing in a
   * field or while a modal owns focus — Ctrl+1 in a textarea must not yank the
   * user out of their prompt. */
  document.addEventListener('keydown', (e) => {
    if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return;
    const entry = VIEWS.find(v => v.key === e.key);
    if (!entry) return;
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) {
      // A number typed into a text field is data, not a shortcut.
      if (t.type !== 'button' && t.type !== 'checkbox' && t.type !== 'range') return;
    }
    if (document.querySelector('dialog[open]')) return;
    e.preventDefault();
    goView(entry.view).catch(err => window.ReachDialogs?.notice(err.message));
  });

  /* Rail highlighting needs no observer or document-wide click listener.
   *
   * An earlier revision installed a MutationObserver on document.body watching
   * every class change, whose callback wrote classes itself — a self-triggering
   * feedback loop. On macOS that collided with CodeMirror's own ResizeObserver
   * and produced "ResizeObserver loop completed with undelivered
   * notifications", which the smoke treats as a fatal renderer error.
   *
   * It was also redundant: showTab() in app.js is the ONLY place a .page
   * becomes active (verified by grep), and it already calls markRail(). Every
   * navigation path — header tabs, this rail, and the hotkeys below — goes
   * through showTab(). */

  /* ------------------------------------------------------------ status bar */

  const statusBar = {
    endpoint: $('#sb-endpoint'),
    dot: $('#sb-endpoint-dot'),
    endpointText: $('#sb-endpoint-text'),
    latency: $('#sb-latency'),
    latencyVal: $('#sb-latency-val'),
    model: $('#sb-model'),
    modelVal: $('#sb-model-val'),
    index: $('#sb-index'),
    indexVal: $('#sb-index-val'),
    sync: $('#sb-sync'),
    syncVal: $('#sb-sync-val'),
  };

  function setChip(el, visible) { if (el) el.hidden = !visible; }

  function endpointLabel(url) {
    const text = String(url || '').trim();
    if (!text) return 'no endpoint';
    try {
      const u = new URL(text);
      // Host only: never put a key or credentials in the status bar.
      return u.host;
    } catch { return text.slice(0, 32); }
  }

  async function refreshEndpointChip() {
    try {
      const s = await window.reach.getSettings();
      const has = !!s.endpoint;
      if (statusBar.endpointText) statusBar.endpointText.textContent = endpointLabel(s.endpoint);
      if (statusBar.dot) {
        statusBar.dot.className = 'sb-dot' + (has ? ' on' : '');
      }
      if (statusBar.endpoint) statusBar.endpoint.classList.toggle('sb-off', !has);
      if (statusBar.modelVal && s.model) {
        statusBar.modelVal.textContent = s.model;
        setChip(statusBar.model, true);
      } else setChip(statusBar.model, false);
      return s;
    } catch { return null; }
  }

  function setLatency(ms, ok) {
    if (!statusBar.latencyVal) return;
    statusBar.latencyVal.textContent = Number.isFinite(ms) ? ms + ' ms' : '—';
    setChip(statusBar.latency, true);
    if (statusBar.latency) statusBar.latency.classList.toggle('sb-bad', ok === false);
  }

  function setIndex(text) {
    if (!statusBar.indexVal) return;
    statusBar.indexVal.textContent = text;
    setChip(statusBar.index, true);
  }

  function setSync(text, state) {
    if (!statusBar.syncVal) return;
    statusBar.syncVal.textContent = text;
    setChip(statusBar.sync, true);
    if (statusBar.sync) {
      statusBar.sync.classList.toggle('sb-bad', state === 'error');
      statusBar.sync.classList.toggle('sb-ok', state === 'ok');
    }
  }

  if ($('#sb-settings')) {
    $('#sb-settings').addEventListener('click', () => {
      // openSettingsPanel() is a top-level function in settings.js => global.
      const open = typeof openSettingsPanel === 'function'
        ? openSettingsPanel('connection')
        : goView('settings');
      Promise.resolve(open).catch(e => window.ReachDialogs?.notice(e.message));
    });
  }

  /* --------------------------------------------------------- workspace page */

  const HISTORY = 60;
  const state = {
    live: true,
    timer: null,
    history: [],       // [{cpu, gpu, ram}]
    sample: null,
    index: null,       // summarized code index
    busy: false,
  };

  const fmtBytes = (n) => {
    if (!Number.isFinite(n)) return '—';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0, v = n;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
    return v.toFixed(v >= 100 || i === 0 ? 0 : 1) + ' ' + units[i];
  };
  const fmtUptime = (secs) => {
    if (!Number.isFinite(secs)) return '—';
    const d = Math.floor(secs / 86400), h = Math.floor(secs % 86400 / 3600), m = Math.floor(secs % 3600 / 60);
    return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
  };
  const pct = (n) => Number.isFinite(n) ? Math.round(n) + '%' : '—';

  const dash = {
    stamp: $('#ws-stamp'),
    cpu: $('#ws-cpu'), cpuNote: $('#ws-cpu-note'),
    ram: $('#ws-ram'), ramNote: $('#ws-ram-note'),
    gpu: $('#ws-gpu'), gpuNote: $('#ws-gpu-note'),
    uptime: $('#ws-uptime'), uptimeNote: $('#ws-uptime-note'),
    chart: $('#ws-chart'),
    processes: $('#ws-processes'),
    endpoint: $('#ws-endpoint'),
    pingResult: $('#ws-ping-result'),
    indexSummary: $('#ws-index-summary'),
    indexWarnings: $('#ws-index-warnings'),
    symbolResults: $('#ws-symbol-results'),
  };

  function setMetric(el, noteEl, value, note) {
    if (el) el.textContent = value;
    if (noteEl) noteEl.textContent = note;
  }

  /* Canvas history chart. Redrawn on theme change because the colours come
   * from computed CSS variables rather than hardcoded values. */
  function drawChart() {
    const canvas = dash.chart;
    if (!canvas || !canvas.getContext) return;
    // Never touch layout while hidden. Writing canvas.width/height reflows the
    // page, and several other modules (CodeMirror, scrollbar.js, telemetry.js,
    // workspace.js) run ResizeObserver callbacks; reflowing from a window-resize
    // handler while they are measuring is how "ResizeObserver loop completed
    // with undelivered notifications" gets raised. A hidden page cannot be seen
    // anyway, so drawing it is wasted work AND a layout hazard.
    if (document.hidden || activeView() !== 'workspace') return;
    const dpr = window.devicePixelRatio || 1;
    const cssW = canvas.clientWidth || 600, cssH = 150;
    if (canvas.width !== Math.round(cssW * dpr)) { canvas.width = Math.round(cssW * dpr); canvas.height = Math.round(cssH * dpr); }
    const ctx = canvas.getContext('2d');
    const styles = getComputedStyle(document.documentElement);
    const grid = styles.getPropertyValue('--line').trim() || '#323027';
    const gold = styles.getPropertyValue('--gold').trim() || '#d4af37';
    const okc = styles.getPropertyValue('--ok').trim() || '#7aa86a';
    const textc = styles.getPropertyValue('--dim').trim() || '#8a8578';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);
    // grid
    ctx.strokeStyle = grid; ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
      const y = Math.round((cssH - 1) * i / 4) + 0.5;
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(cssW, y); ctx.stroke();
    }
    const points = state.history.slice(-HISTORY);
    if (points.length < 2) {
      ctx.fillStyle = textc; ctx.font = '11px system-ui, sans-serif';
      ctx.fillText('Collecting samples…', 8, cssH / 2);
      return;
    }
    const stepX = (cssW - 4) / (HISTORY - 1);
    const plot = (key, color) => {
      ctx.strokeStyle = color; ctx.lineWidth = 1.5; ctx.beginPath();
      let started = false;
      for (let i = 0; i < points.length; i++) {
        const v = points[i][key];
        if (!Number.isFinite(v)) continue;
        const x = 2 + (i + (HISTORY - points.length)) * stepX;
        const y = cssH - 2 - (Math.max(0, Math.min(100, v)) / 100) * (cssH - 6);
        if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
      }
      ctx.stroke();
    };
    plot('cpu', gold);
    plot('gpu', okc);
  }

  function renderSample(sample) {
    if (!sample) return;
    state.sample = sample;
    const cpu = sample.cpu || {}, ram = sample.ram || {}, gpu = sample.gpu || {};
    setMetric(dash.cpu, dash.cpuNote, pct(cpu.percent), `${cpu.threads || '?'} threads`);
    setMetric(dash.ram, dash.ramNote,
      ram.total ? Math.round(100 * ram.used / ram.total) + '%' : '—',
      ram.total ? `${fmtBytes(ram.used)} of ${fmtBytes(ram.total)}` : 'no data');
    setMetric(dash.gpu, dash.gpuNote, pct(gpu.utilization),
      gpu.dedicated !== null && gpu.dedicated !== undefined ? `VRAM ${fmtBytes(gpu.dedicated)}` : (gpu.name || 'not reported'));
    setMetric(dash.uptime, dash.uptimeNote, fmtUptime(sample.uptime), sample.platform || '');
    if (dash.stamp) {
      dash.stamp.textContent = 'Sampled ' + new Date(sample.at).toLocaleTimeString()
        + (sample.notes && sample.notes.length ? ' · ' + sample.notes[0] : '');
    }
    // history for the chart
    state.history.push({ cpu: cpu.percent, gpu: gpu.utilization, ram: ram.total ? 100 * ram.used / ram.total : null });
    while (state.history.length > HISTORY) state.history.shift();
    drawChart();
    renderProcesses(sample.processes || []);
  }

  function renderProcesses(list) {
    if (!dash.processes) return;
    dash.processes.textContent = '';
    const rows = list.slice(0, 8);
    if (!rows.length) {
      const empty = document.createElement('p');
      empty.className = 'dim';
      empty.textContent = 'No process data on this platform.';
      dash.processes.appendChild(empty);
      return;
    }
    const max = Math.max(1, ...rows.map(p => p.ram || 0));
    for (const p of rows) {
      const row = document.createElement('div');
      row.className = 'ws-process';
      const name = document.createElement('span');
      name.className = 'ws-process-name';
      name.textContent = p.name;
      name.title = `pid ${p.pid}`;
      const bar = document.createElement('span');
      bar.className = 'ws-process-bar';
      const fill = document.createElement('i');
      fill.style.width = Math.round(100 * (p.ram || 0) / max) + '%';
      bar.appendChild(fill);
      const size = document.createElement('span');
      size.className = 'ws-process-ram';
      size.textContent = fmtBytes(p.ram);
      row.append(name, bar, size);
      dash.processes.appendChild(row);
    }
  }

  async function sampleNow() {
    if (state.busy) return;
    state.busy = true;
    try {
      const s = await window.reach.telemetry.sample();
      renderSample(s);
    } catch (e) {
      if (dash.stamp) dash.stamp.textContent = 'Telemetry unavailable: ' + e.message;
    } finally { state.busy = false; }
  }

  function startLive() {
    stopLive();
    if (!state.live) return;
    state.timer = setInterval(() => {
      // Only sample while the page is actually visible: polling a hidden canvas
      // burns a PowerShell round-trip on Windows for nothing.
      if (document.hidden || activeView() !== 'workspace') return;
      sampleNow();
    }, 2500);
  }
  function stopLive() { if (state.timer) { clearInterval(state.timer); state.timer = null; } }

  /* ------------------------------------------------------- endpoint ping */

  async function pingEndpoint() {
    if (!dash.pingResult) return;
    dash.pingResult.textContent = 'Pinging…';
    dash.pingResult.className = 'ws-ping-result pending';
    try {
      const res = await window.reach.workspace.pingEndpoint();
      if (res.ok) {
        dash.pingResult.textContent = `OK · ${res.latencyMs} ms · HTTP ${res.status}`
          + (res.models !== null && res.models !== undefined ? ` · ${res.models} model(s)` : '');
        dash.pingResult.className = 'ws-ping-result ok';
        setLatency(res.latencyMs, true);
      } else {
        // PRD: "Failed ping requests trigger an alert toast with diagnostic error message"
        dash.pingResult.textContent = `Failed · ${res.err}`;
        dash.pingResult.className = 'ws-ping-result bad';
        setLatency(null, false);
        window.ReachDialogs?.notice('Endpoint ping failed: ' + res.err);
      }
    } catch (e) {
      dash.pingResult.textContent = 'Failed · ' + e.message;
      dash.pingResult.className = 'ws-ping-result bad';
      window.ReachDialogs?.notice('Endpoint ping failed: ' + e.message);
    }
  }

  function renderEndpoint(settings) {
    if (!dash.endpoint) return;
    dash.endpoint.textContent = '';
    const rows = [
      ['Endpoint', settings.endpoint ? endpointLabel(settings.endpoint) : 'not configured'],
      ['Default model', settings.model || 'none'],
      ['Access key', settings.accessKey ? 'set (hidden)' : 'none'],
    ];
    for (const [k, v] of rows) {
      const row = document.createElement('div');
      row.className = 'ws-row';
      const key = document.createElement('span');
      key.className = 'dim';
      key.textContent = k;
      const val = document.createElement('b');
      val.textContent = v;
      row.append(key, val);
      dash.endpoint.appendChild(row);
    }
  }

  /* ------------------------------------------------------- codebase index */

  function boundProjectDir() {
    // Prefer the open conversation's project, then the selected project. Both
    // are lexical globals from app.js; drawerDir() is its accessor.
    try {
      if (typeof currentAgent !== 'undefined' && currentAgent?.dir) return currentAgent.dir;
      if (typeof drawerDir === 'function') { const d = drawerDir(); if (d) return d; }
      if (typeof currentProject !== 'undefined' && currentProject?.dir) return currentProject.dir;
    } catch { /* a binding that is not yet initialized must not break the page */ }
    return null;
  }

  async function indexProject() {
    const dir = boundProjectDir();
    if (!dir) {
      window.ReachDialogs?.notice('Open a project or conversation first so there is a directory to index.');
      return;
    }
    if (dash.indexSummary) dash.indexSummary.textContent = 'Indexing…';
    try {
      const res = await window.reach.workspace.indexCode(dir);
      if (!res.ok) {
        if (dash.indexSummary) dash.indexSummary.textContent = 'Index failed: ' + res.err;
        window.ReachDialogs?.notice('Indexing failed: ' + res.err);
        return;
      }
      state.index = res.summary;
      renderIndex(res.summary, res.warnings);
      setIndex(res.summary.symbols + ' symbols');
    } catch (e) {
      if (dash.indexSummary) dash.indexSummary.textContent = 'Index failed: ' + e.message;
      window.ReachDialogs?.notice('Indexing failed: ' + e.message);
    }
  }

  function renderIndex(summary, warnings) {
    if (!dash.indexSummary || !summary) return;
    dash.indexSummary.textContent = '';
    const rows = [
      ['Files indexed', `${summary.indexedFiles} of ${summary.files}`],
      ['Symbols', String(summary.symbols)],
      ['Dependencies', String(summary.dependencies)],
      ['Dependency cycles', String(summary.fileCycles)],
      ['Parse warnings', String(summary.warnings)],
    ];
    for (const [k, v] of rows) {
      const row = document.createElement('div');
      row.className = 'ws-row';
      const key = document.createElement('span');
      key.className = 'dim';
      key.textContent = k;
      const val = document.createElement('b');
      val.textContent = v;
      row.append(key, val);
      dash.indexSummary.appendChild(row);
    }
    if (dash.indexWarnings) {
      const list = Array.isArray(warnings) ? warnings : [];
      if (!list.length) { dash.indexWarnings.hidden = true; dash.indexWarnings.textContent = ''; }
      else {
        dash.indexWarnings.hidden = false;
        dash.indexWarnings.textContent = '';
        const head = document.createElement('strong');
        head.textContent = `Skipped or partially indexed (${list.length}):`;
        dash.indexWarnings.appendChild(head);
        for (const w of list.slice(0, 12)) {
          const line = document.createElement('div');
          line.textContent = `${w.path}: ${w.message}`;
          dash.indexWarnings.appendChild(line);
        }
        if (list.length > 12) {
          const more = document.createElement('div');
          more.className = 'dim';
          more.textContent = `…and ${list.length - 12} more.`;
          dash.indexWarnings.appendChild(more);
        }
      }
    }
  }

  async function searchSymbols() {
    const query = ($('#ws-symbol-query')?.value || '').trim();
    if (!dash.symbolResults) return;
    if (!query) { dash.symbolResults.textContent = ''; return; }
    const dir = boundProjectDir();
    if (!dir) { window.ReachDialogs?.notice('Open a project first.'); return; }
    dash.symbolResults.textContent = 'Searching…';
    try {
      const res = await window.reach.workspace.searchSymbols({ projectDir: dir, query, limit: 20 });
      dash.symbolResults.textContent = '';
      if (!res.ok) {
        const err = document.createElement('p');
        err.className = 'dim';
        err.textContent = res.err;
        dash.symbolResults.appendChild(err);
        return;
      }
      if (!res.symbols.length) {
        const none = document.createElement('p');
        none.className = 'dim';
        none.textContent = 'No matching symbols.';
        dash.symbolResults.appendChild(none);
        return;
      }
      for (const s of res.symbols) {
        const row = document.createElement('button');
        row.className = 'ws-symbol';
        row.type = 'button';
        row.setAttribute('role', 'listitem');
        const kind = document.createElement('span');
        kind.className = 'ws-symbol-kind';
        kind.textContent = s.kind;
        const name = document.createElement('span');
        name.className = 'ws-symbol-name';
        name.textContent = s.qualified;
        const where = document.createElement('span');
        where.className = 'ws-symbol-where dim';
        where.textContent = `${s.path}:${s.line}`;
        row.append(kind, name, where);
        row.title = s.signature || '';
        row.addEventListener('click', () => {
          // Hand the hit to the existing editor opener rather than duplicating
          // its unsaved-changes and tab logic. openFile() takes a
          // project-relative path and accepts no line argument, so when it is
          // available we jump to the file; otherwise we just report the
          // location. Either way exactly one notice is shown.
          if (typeof openFile === 'function') {
            Promise.resolve(openFile(s.path))
              .then(() => goView('projects'))
              .catch(e => window.ReachDialogs?.notice(e.message));
            return;
          }
          window.ReachDialogs?.notice(`${s.kind} ${s.qualified} — ${s.path}:${s.line}`);
        });
        dash.symbolResults.appendChild(row);
      }
    } catch (e) {
      dash.symbolResults.textContent = '';
      const err = document.createElement('p');
      err.className = 'dim';
      err.textContent = e.message;
      dash.symbolResults.appendChild(err);
    }
  }

  /* --------------------------------------------------------------- wiring */

  function sync() {
    markRail();
    if (activeView() !== 'workspace') return;
    refreshEndpointChip().then(s => { if (s) renderEndpoint(s); });
    sampleNow();
  }

  function bind() {
    $('#ws-live')?.addEventListener('change', (e) => {
      state.live = e.target.checked;
      if (state.live) { sampleNow(); startLive(); } else stopLive();
    });
    $('#ws-refresh')?.addEventListener('click', () => sampleNow());
    $('#ws-ping')?.addEventListener('click', () => pingEndpoint());
    $('#ws-index')?.addEventListener('click', () => indexProject());
    $('#ws-symbol-run')?.addEventListener('click', () => searchSymbols());
    $('#ws-symbol-query')?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); searchSymbols(); }
    });
    document.addEventListener('reach-theme-change', drawChart);
    // Coalesce resize into a single draw on the next frame. The smoke (and real
    // window dragging) fires many resize events back-to-back; without this each
    // one reflowed synchronously inside the event, which is the pattern that
    // trips ResizeObserver loop detection. One frame => at most one reflow.
    let chartFrame = 0;
    window.addEventListener('resize', () => {
      if (chartFrame) return;
      chartFrame = requestAnimationFrame(() => { chartFrame = 0; drawChart(); });
    });
    document.addEventListener('visibilitychange', () => { if (document.hidden) stopLive(); else if (state.live) startLive(); });
  }

  window.ReachWorkspaceShell = { goView, markRail, activeView, VIEWS, refreshEndpointChip, setLatency, setIndex, setSync, setChip };
  window.ReachWorkspaceDash = { sync, sampleNow, drawChart, indexProject, pingEndpoint };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  function init() {
    bind();
    refreshEndpointChip().then(s => { if (s) renderEndpoint(s); });
    startLive();
    markRail();
  }
})();
