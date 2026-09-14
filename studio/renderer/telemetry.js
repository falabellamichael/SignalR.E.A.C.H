'use strict';
(() => {
  const { node, action, modal } = window.ReachWorkspace;
  const views = ['overview', 'activity', 'models'];
  let view = localStorage.getItem('reach.telemetry.view') || 'overview';
  if (!views.includes(view)) view = 'overview';
  let enabled = localStorage.getItem('reach.telemetry.enabled') !== 'false', forced = false;
  let data = null, history = [], pending = false, timer = null, selectedId = null, wasEmpty = true;
  const dashboard = node('section', 'telemetry-dashboard'); dashboard.id = 'telemetry-dashboard'; dashboard.setAttribute('aria-label', 'Workspace telemetry');
  const heading = node('div', 'telemetry-heading');
  const intro = node('div'); intro.append(node('h2', '', 'Ready when you are'), node('p', '', 'Start a conversation. Keep an eye on your machine.'));
  heading.append(intro); dashboard.append(heading);
  const welcome = node('div', 'telemetry-welcome'); welcome.append(node('p', '', 'Your next idea starts here.'), action('Start a conversation', () => $('#btn-new-chat').click()));
  const content = node('div', 'telemetry-content'); dashboard.append(content, welcome);
  const bar = node('div', 'telemetry-bar'); bar.append(node('strong', '', 'System telemetry'));
  const stamp = node('span', 'telemetry-stamp', 'Waiting for a sample…'); stamp.setAttribute('role', 'status');
  const returnChat = action('Back to chat', () => { forced = false; sync(); });
  const landingView = node('select'); landingView.setAttribute('aria-label', 'Opening telemetry view');
  landingView.append(new Option('Overview', 'overview'), new Option('Activity', 'activity'), new Option('Models & Memory', 'models'));
  bar.append(stamp, landingView, returnChat, action('Details…', details)); content.append(bar);
  const metrics = node('div', 'telemetry-metrics'), metricElements = {};
  for (const [key, label] of Object.entries({ cpu: 'CPU', gpu: 'GPU', ram: 'RAM', vram: 'VRAM' })) {
    const section = node('section', 'telemetry-metric'), value = node('strong', 'metric-value', '—'), note = node('small', 'metric-note', 'Waiting for data'), graph = node('canvas', 'metric-graph');
    graph.setAttribute('aria-label', label + ' recent history'); graph.setAttribute('role', 'img');
    section.append(node('span', 'metric-label', label), value, note, graph); metrics.append(section);
    metricElements[key] = { value, note, graph };
  }
  const graphPanel = node('section', 'telemetry-chart-panel');
  const graphHead = node('div', 'telemetry-section-head'); graphHead.append(node('h3', '', 'System activity'), node('span', 'telemetry-legend', 'CPU · gold     GPU · green'));
  const graph = node('canvas', 'telemetry-chart'); graph.setAttribute('aria-label', 'CPU and GPU activity over the last sixty seconds'); graph.setAttribute('role', 'img');
  const axis = node('div', 'telemetry-axis'); axis.append(node('span', '', '60 seconds ago'), node('span', '', 'Now'));
  graphPanel.append(graphHead, graph, axis);
  const modelsPanel = node('section', 'telemetry-models'), processPanel = node('section', 'telemetry-processes');
  const modelsHeading = node('div', 'telemetry-section-head'); modelsHeading.append(node('h3', '', 'Models in memory'), action('Sources…', sourcesDialog));
  const modelsList = node('div', 'telemetry-table-wrap');
  const modelNote = node('p', 'telemetry-footnote', 'Loaded state is reported by the provider. Unknown memory stays unreported.');
  modelsPanel.append(modelsHeading, modelsList, modelNote);
  const processHeading = node('div', 'telemetry-section-head'); processHeading.append(node('h3', '', 'What is using RAM?'), action('Processes…', processDialog));
  const memoryTrack = node('progress', 'telemetry-memory'); memoryTrack.max = 100; memoryTrack.setAttribute('aria-label', 'System RAM used');
  const memoryText = node('p', 'telemetry-footnote');
  const processList = node('div', 'telemetry-process-list');
  processPanel.append(processHeading, memoryTrack, memoryText, processList, node('p', 'telemetry-footnote', 'Process working sets include shared pages and overhead; they do not add up to system RAM or model weights.'));
  const grid = node('div', 'telemetry-grid'); grid.append(modelsPanel, processPanel);
  content.append(metrics, graphPanel, grid);
  const footer = node('div', 'telemetry-footer'); content.append(footer);
  const toggle = $('#telemetry-toggle'), select = $('#telemetry-view'); select.value = landingView.value = view;
  function choose(value) { view = value; select.value = landingView.value = value; localStorage.setItem('reach.telemetry.view', value); forced = true; enabled = true; localStorage.setItem('reach.telemetry.enabled', 'true'); layout(); chatScroll.scrollTop = noAgent.scrollTop = 0; sync(); }
  select.onchange = () => choose(select.value); landingView.onchange = () => choose(landingView.value);
  toggle.onclick = () => {
    if (!empty() && !forced) { forced = true; enabled = true; }
    else { forced = false; enabled = !enabled; }
    localStorage.setItem('reach.telemetry.enabled', String(enabled)); sync();
  };
  function empty() { return !currentAgent || !chatLog.children.length; }
  function visible() { return $('#page-agents').classList.contains('active') && !document.hidden && enabled && (empty() || forced); }
  function layout() {
    dashboard.dataset.view = view;
    if (view === 'models') { grid.append(metrics); content.insertBefore(grid, graphPanel); }
    else { content.insertBefore(metrics, grid); content.insertBefore(graphPanel, grid); }
    graphPanel.hidden = view !== 'activity'; requestAnimationFrame(draw);
  }
  function sync() {
    const isEmpty = empty();
    if (selectedId !== currentAgent?.id || wasEmpty && !isEmpty) forced = false;
    selectedId = currentAgent?.id; wasEmpty = isEmpty;
    const parent = currentAgent ? chatScroll : noAgent;
    if (dashboard.parentElement !== parent) parent.prepend(dashboard);
    noAgent.classList.add('telemetry-landing');
    const show = enabled && (isEmpty || forced);
    dashboard.hidden = !isEmpty && !forced;
    content.hidden = !show; welcome.hidden = show;
    welcome.querySelector('button').hidden = !!currentAgent;
    heading.hidden = !isEmpty;
    returnChat.hidden = isEmpty || !forced;
    landingView.hidden = !!currentAgent;
    chatLog.hidden = !isEmpty && forced && enabled;
    todosPanel.classList.toggle('telemetry-covered', !isEmpty && forced && enabled);
    agentView.classList.toggle('conversation-empty', isEmpty);
    toggle.setAttribute('aria-pressed', String(show));
    toggle.title = show ? 'Hide telemetry' : 'Show telemetry';
    if (visible()) { if (!timer && !pending) poll(); }
    else { clearTimeout(timer); timer = null; }
    requestAnimationFrame(draw);
  }
  async function poll() {
    timer = null; if (!visible() || pending) return;
    pending = true;
    try {
      const next = await reachApi.telemetry.sample();
      data = next;
      if (history.at(-1)?.at !== next.at) history.push(next);
      history = history.filter(s => s.at >= next.at - 60000).slice(-40);
      render();
    } catch (error) { stamp.textContent = 'Telemetry unavailable · ' + error.message; }
    finally { pending = false; if (visible()) timer = setTimeout(poll, 3000); }
  }
  function bytes(value) { if (value === null || value === undefined || !Number.isFinite(Number(value))) return 'Not reported'; const n = Number(value); return n >= 1024 ** 3 ? (n / 1024 ** 3).toFixed(1) + ' GB' : (n / 1024 ** 2).toFixed(1) + ' MB'; }
  function percent(value) { return value === null || value === undefined ? '—' : Math.round(value) + '%'; }
  function rate(value) { return value == null ? 'Not reported' : bytes(value) + '/s'; }
  function table(labels, rows) {
    const table = node('table', 'telemetry-table'), head = node('thead'), header = node('tr');
    labels.forEach(label => { const th = node('th', '', label); th.scope = 'col'; header.append(th); }); head.append(header);
    const body = node('tbody'); rows.forEach(row => { const tr = node('tr'); row.forEach(value => tr.append(node('td', '', value))); body.append(tr); });
    table.append(head, body); return table;
  }
  function render() {
    if (!data) return;
    stamp.textContent = 'Updated ' + new Date(data.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    metricElements.cpu.value.textContent = percent(data.cpu.percent); metricElements.cpu.note.textContent = data.cpu.threads + ' threads · ' + data.cpu.name;
    metricElements.gpu.value.textContent = percent(data.gpu.utilization); metricElements.gpu.note.textContent = data.gpu.name;
    metricElements.ram.value.textContent = bytes(data.ram.used); metricElements.ram.note.textContent = 'of ' + bytes(data.ram.total) + ' · ' + bytes(data.ram.available) + ' available';
    metricElements.vram.value.textContent = bytes(data.gpu.dedicated); metricElements.vram.note.textContent = data.gpu.total ? 'of ' + bytes(data.gpu.total) + ' dedicated' : 'Dedicated GPU memory · total not reported';
    for (const m of Object.values(metricElements)) m.note.title = m.note.textContent;
    const modelRows = data.models.map(m => [m.name, m.provider + (m.local ? '' : ' · remote'), m.placement, bytes(m.bytes)]);
    modelsList.replaceChildren(modelRows.length ? table(['Model', 'Provider', 'Placement', 'Memory'], modelRows) : node('p', 'telemetry-empty', data.sources.some(s => s.state === 'connected') ? 'No loaded models reported by connected sources.' : 'No model providers connected. Configure Sources to see loaded models.'));
    modelNote.textContent = `${data.models.length} loaded model${data.models.length === 1 ? '' : 's'} reported · Memory is provider-reported, never inferred from the model file size.`;
    memoryTrack.value = data.ram.used / data.ram.total * 100; memoryText.textContent = bytes(data.ram.used) + ' in use · ' + bytes(data.ram.available) + ' available';
    processList.replaceChildren();
    for (const process of data.processes.slice(0, 5)) {
      const row = node('div', 'telemetry-process-row'), name = node('span', '', process.name); name.title = process.name + ' · PID ' + process.pid;
      const bar = node('progress'); bar.max = data.ram.total; bar.value = process.ram || 0; bar.setAttribute('aria-label', process.name + ' memory');
      row.append(name, bar, node('span', '', bytes(process.ram))); processList.append(row);
    }
    if (!data.processes.length) processList.append(node('p', 'telemetry-empty', 'Process memory is unavailable on this sample.'));
    footer.replaceChildren(node('span', '', 'This machine · ' + (data.platform === 'win32' ? 'Windows' : data.platform)),
      node('span', '', `Network ↓ ${rate(data.network?.receive)} · ↑ ${rate(data.network?.send)}`),
      node('span', '', `Disk read ${rate(data.disk?.read)} · write ${rate(data.disk?.write)}`));
    if (data.notes.length) footer.append(node('span', 'telemetry-note', data.notes.join(' · ')));
    draw();
  }
  function drawGraph(canvas, lines, gridLines = false) {
    const rect = canvas.getBoundingClientRect(); if (!rect.width || !rect.height) return;
    const scale = window.devicePixelRatio || 1; canvas.width = Math.round(rect.width * scale); canvas.height = Math.round(rect.height * scale);
    const ctx = canvas.getContext('2d'); ctx.scale(scale, scale);
    const width = rect.width, height = rect.height, style = getComputedStyle(document.documentElement);
    const inset = gridLines ? 27 : 2, end = data?.at || Date.now();
    if (gridLines) { ctx.strokeStyle = style.getPropertyValue('--line'); ctx.fillStyle = style.getPropertyValue('--dim'); ctx.font = '10px Segoe UI';
      for (let i = 0; i <= 4; i++) { const y = 8 + (height - 20) * i / 4; ctx.fillText(String(100 - i * 25), 0, y + 4); ctx.beginPath(); ctx.moveTo(inset, y); ctx.lineTo(width, y); ctx.stroke(); } }
    for (const { key, color } of lines) {
      ctx.strokeStyle = style.getPropertyValue(color); ctx.lineWidth = gridLines ? 2 : 1.5; ctx.beginPath(); let pen = false;
      for (const sample of history) {
        const value = key === 'cpu' ? sample.cpu.percent : key === 'gpu' ? sample.gpu.utilization : key === 'ram' ? sample.ram.used / sample.ram.total * 100 : sample.gpu.total && sample.gpu.dedicated !== null ? sample.gpu.dedicated / sample.gpu.total * 100 : null;
        if (value === null) { pen = false; continue; }
        const x = inset + (width - inset - 3) * Math.max(0, 1 - (end - sample.at) / 60000), y = 8 + (height - 20) * (1 - Math.max(0, Math.min(100, value)) / 100);
        if (pen) ctx.lineTo(x, y); else ctx.moveTo(x, y); pen = true;
        ctx.fillStyle = ctx.strokeStyle; ctx.fillRect(x - 1, y - 1, 2, 2);
      }
      ctx.stroke();
    }
  }
  function draw() {
    if (!data || !visible()) return;
    for (const [key, metric] of Object.entries(metricElements)) drawGraph(metric.graph, [{ key, color: '--gold' }]);
    drawGraph(graph, [{ key: 'cpu', color: '--gold' }, { key: 'gpu', color: '--ok' }], true);
  }
  function details() {
    const dialog = modal('Telemetry details');
    if (!data) { dialog.append(node('p', '', 'Waiting for the first system sample.')); return; }
    dialog.append(node('p', 'workspace-description', 'System readings describe this machine. Remote provider models are labeled separately. Telemetry never loads a model or sends a chat request.'));
    dialog.append(table(['Reading', 'Value'], [['CPU', data.cpu.name], ['CPU utilization', percent(data.cpu.percent)], ['GPU', data.gpu.name],
      ['GPU utilization source', data.gpu.source], ['Dedicated GPU memory', bytes(data.gpu.dedicated)], ['Shared GPU memory', bytes(data.gpu.shared)],
      ['Physical RAM', bytes(data.ram.total)], ['Available RAM', bytes(data.ram.available)], ['Uptime', Math.floor(data.uptime / 3600) + 'h ' + Math.floor(data.uptime / 60 % 60) + 'm'],
      ['Last sample', new Date(data.at).toLocaleString()]]));
    if (data.models.length) dialog.append(node('h3', '', 'Provider-reported model memory'), table(['Model', 'RAM', 'VRAM', 'Context', 'Process'], data.models.map(m => [m.name, bytes(m.ram), bytes(m.vram), m.context?.toLocaleString() || 'Not reported', m.pid || 'Not reported'])));
    dialog.append(node('p', 'workspace-description', 'Sampling pauses when this dashboard is hidden. Charts contain measured samples only. Shared GPU memory is part of system RAM. Process working sets can count shared pages more than once.'));
    for (const note of data.notes) dialog.append(node('p', 'workspace-description', note));
    dialog.append(action('Configure model sources…', () => { dialog.close(); sourcesDialog(); }));
  }
  function processDialog() {
    const dialog = modal('Processes in memory');
    dialog.append(node('p', 'workspace-description', 'Largest 30 process working sets from the latest sample. Shared pages can appear in multiple processes. CPU is measured between samples.'));
    const sort = node('select'); sort.setAttribute('aria-label', 'Sort processes'); sort.append(new Option('Memory usage', 'ram'), new Option('CPU usage', 'cpu'));
    const list = node('div', 'telemetry-table-wrap');
    const update = () => list.replaceChildren(table(['Process', 'PID', 'RAM', 'CPU'], [...(data?.processes || [])].sort((a, b) => (b[sort.value] || 0) - (a[sort.value] || 0)).map(p => [p.name, p.pid, bytes(p.ram), percent(p.cpu)])));
    sort.onchange = update; dialog.append(sort, list); update();
  }
  async function sourcesDialog() {
    const dialog = modal('Telemetry sources');
    dialog.append(node('p', 'workspace-description', 'Read loaded-model state from your providers. Enter the server URL for Ollama or LM Studio, and the API base URL for Lemonade. Remote models are labeled remote; they are not counted as local RAM.'));
    const sources = await reachApi.telemetry.sources(); if (!dialog.isConnected) return;
    const form = node('form', 'workspace-form'), rows = node('div', 'telemetry-source-rows'); form.append(rows);
    function add(source = { type: 'ollama', url: '', enabled: true }) {
      if (rows.children.length >= 8) return;
      const row = node('div', 'telemetry-source-row'), check = node('input'), type = node('select'), url = node('input');
      check.type = 'checkbox'; check.checked = source.enabled; check.setAttribute('aria-label', 'Monitor this source');
      type.setAttribute('aria-label', 'Provider type'); type.append(new Option('Ollama', 'ollama'), new Option('LM Studio', 'lmstudio'), new Option('Lemonade', 'lemonade')); type.value = source.type;
      url.type = 'url'; url.required = true; url.value = source.url; url.placeholder = 'http://127.0.0.1:11434'; url.setAttribute('aria-label', 'Telemetry server URL');
      row.append(check, type, url, action('Remove', () => row.remove())); rows.append(row);
    }
    sources.forEach(add);
    form.append(action('Add source', () => add()));
    for (const source of data?.sources || []) form.append(node('p', 'workspace-description', `${source.provider} · ${source.url} · ${source.state === 'connected' ? source.models.length + ' loaded' : source.error}`));
    const status = node('p', 'workspace-description'); status.setAttribute('role', 'status');
    const save = node('button', 'gold', 'Save sources'); save.type = 'submit'; form.append(status, save); dialog.append(form);
    form.onsubmit = async e => { e.preventDefault(); save.disabled = true;
      try { const values = [...rows.children].map(row => ({ type: row.querySelector('select').value, url: row.querySelector('[type=url]').value, enabled: row.querySelector('[type=checkbox]').checked }));
        await reachApi.telemetry.saveSources(values); dialog.close(); clearTimeout(timer); timer = null; if (!pending) poll();
      } catch (error) { status.textContent = error.message; } finally { save.disabled = false; }
    };
  }
  new MutationObserver(sync).observe(chatLog, { childList: true });
  new MutationObserver(sync).observe($('#page-agents'), { attributes: true, attributeFilter: ['class'] });
  new MutationObserver(draw).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  new ResizeObserver(draw).observe(content);
  document.addEventListener('visibilitychange', sync);
  window.ReachTelemetry = { sync, reset() { forced = false; enabled = true; localStorage.setItem('reach.telemetry.enabled', 'true'); }, details };
  layout(); sync();
})();
