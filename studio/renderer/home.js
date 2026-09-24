'use strict';

/* Home keeps a small, disposable command console and endpoint tester. Both use
 * the existing main-process IPC paths, so credentials and subprocesses remain
 * outside the renderer. The endpoint transcript is display-only: every prompt
 * is sent as a separate one-shot completion. */
(() => {
  const $ = selector => document.querySelector(selector);
  const api = window.reach;
  const els = {
    project: $('#home-project-select'),
    projectPath: $('#home-project-path'),
    commandMode: $('#home-command-mode'),
    commandInput: $('#home-command-input'),
    commandRun: $('#home-command-run'),
    commandStop: $('#home-command-stop'),
    commandStatus: $('#home-command-status'),
    commandLog: $('#home-command-log'),
    projectsLink: $('#home-projects-link'),
    connection: $('#home-connection'),
    model: $('#home-model'),
    modelList: $('#home-model-list'),
    modelBrowse: $('#home-model-browse'),
    endpointPing: $('#home-endpoint-ping'),
    endpointStatus: $('#home-endpoint-status'),
    chatLog: $('#home-chat-log'),
    chatPrompt: $('#home-chat-prompt'),
    chatSend: $('#home-chat-send'),
    chatStop: $('#home-chat-stop'),
    playgroundLink: $('#home-playground-link'),
  };

  // The page is optional to older test fixtures that load individual scripts.
  if (!els.project || !els.connection || !els.chatLog) return;

  const command = { runId: null, starting: false, early: [], cliAvailable: false };
  const chat = { runId: null, running: false, firstChunk: false, response: null, pinging: false, browsing: false, modelConnectionId: '' };
  const MAX_LOG_LINES = 200;
  const MAX_CHAT_MESSAGES = 16;

  function status(el, message, state = '') {
    if (!el) return;
    el.textContent = message;
    el.dataset.state = state;
    el.classList.toggle('ok', state === 'success');
    el.classList.toggle('bad', state === 'error' || state === 'warning');
  }

  function setCommandControls() {
    const busy = command.starting || command.runId !== null;
    const hasProject = !!els.project.value;
    const hasInput = !!els.commandInput?.value.trim();
    const reachUnavailable = els.commandMode?.value === 'reach' && !command.cliAvailable;
    if (els.commandRun) els.commandRun.disabled = busy || !hasProject || !hasInput || reachUnavailable;
    if (els.commandStop) els.commandStop.disabled = command.runId === null;
    els.project.disabled = busy || !els.project.options.length;
    if (els.commandMode) els.commandMode.disabled = busy || !hasProject;
    if (els.commandInput) els.commandInput.disabled = busy || !hasProject;
    if (els.commandInput) els.commandInput.placeholder = els.commandMode?.value === 'reach'
      ? 'compile index.rsh' : 'npm test';
  }

  function setChatControls() {
    const hasConnection = !!window.ReachConnections?.current('home')?.endpoint;
    const hasModel = !!els.model?.value.trim();
    const hasPrompt = !!els.chatPrompt?.value.trim();
    if (els.chatSend) els.chatSend.disabled = chat.running || !hasConnection || !hasModel || !hasPrompt;
    if (els.chatStop) els.chatStop.disabled = !chat.running;
    if (els.endpointPing) els.endpointPing.disabled = chat.pinging || chat.browsing || chat.running || !hasConnection;
    if (els.modelBrowse) els.modelBrowse.disabled = chat.browsing || chat.pinging || chat.running || !hasConnection;
    if (els.connection) els.connection.disabled = chat.running || chat.pinging || chat.browsing || els.connection.options.length < 2;
    if (els.model) els.model.disabled = chat.running;
  }

  function selectedProject() {
    return els.project.value || '';
  }

  function syncProjectPath() {
    const dir = selectedProject();
    if (els.projectPath) els.projectPath.textContent = dir || 'Open a folder in Projects to get started.';
    if (!command.starting && command.runId === null) {
      if (!dir) status(els.commandStatus, 'Add a project to run commands.', 'muted');
      else if (els.commandMode?.value === 'reach' && !command.cliAvailable)
        status(els.commandStatus, 'Reach CLI unavailable. Configure it in Settings.', 'warning');
      else status(els.commandStatus, 'Ready in the selected project folder.', 'ready');
    }
    setCommandControls();
  }

  async function refreshProjects() {
    try {
      const projects = await api.getProjects();
      const previous = els.project.value;
      els.project.replaceChildren();
      for (const project of Array.isArray(projects) ? projects : []) {
        if (!project || typeof project.dir !== 'string' || !project.dir.trim()) continue;
        const option = document.createElement('option');
        option.value = project.dir;
        option.textContent = String(project.name || project.dir.split(/[\\/]/).pop() || project.dir);
        els.project.appendChild(option);
      }
      if ([...els.project.options].some(option => option.value === previous)) els.project.value = previous;
      syncProjectPath();
    } catch (error) {
      status(els.commandStatus, 'Could not load projects: ' + error.message, 'error');
      setCommandControls();
    }
  }

  async function refreshReachCli() {
    try {
      const version = await api.getVersion();
      command.cliAvailable = typeof version === 'string' && !version.startsWith('Optional Reach CLI unavailable.');
    } catch { command.cliAvailable = false; }
    syncProjectPath();
  }

  function logLine(kind, message) {
    if (!els.commandLog) return;
    els.commandLog.querySelector('.home-log-empty')?.remove();
    const line = document.createElement('div');
    const style = { prompt: 'sys', output: 'out', error: 'err', success: 'exit0' }[kind] || 'out';
    line.className = 'home-command-line ' + style;
    line.textContent = message;
    els.commandLog.appendChild(line);
    while (els.commandLog.children.length > MAX_LOG_LINES) els.commandLog.firstElementChild.remove();
    els.commandLog.scrollTop = els.commandLog.scrollHeight;
  }

  function commandEvent(event) {
    if (!event || event.runId !== command.runId) {
      // A very short process may emit output and exit before invoke returns.
      if (command.starting && command.early.length < 200) command.early.push(event);
      return;
    }
    if (event.type === 'output') {
      for (const line of String(event.data || '').split(/\r?\n/)) {
        if (line) logLine(event.channel === 'err' ? 'error' : 'output', line);
      }
      return;
    }
    if (event.type === 'exit') {
      const message = event.launchError ? 'Command could not start.'
        : event.stopped ? 'Command stopped.'
          : `Process exited with code ${event.code}.`;
      logLine(event.code === 0 ? 'success' : 'error', message);
      status(els.commandStatus, message, event.code === 0 ? 'success' : 'error');
      command.runId = null;
      setCommandControls();
    }
  }

  async function runCommand() {
    if (command.starting || command.runId !== null) return;
    const cwd = selectedProject();
    const text = els.commandInput?.value.trim() || '';
    const mode = els.commandMode?.value === 'reach' ? 'reach' : 'project';
    if (!cwd || !text) return;
    if (mode === 'reach' && !command.cliAvailable) {
      status(els.commandStatus, 'Reach CLI unavailable. Configure it in Settings.', 'warning');
      return;
    }
    // Match the Projects command bar: executable plus whitespace-separated
    // arguments, without shell evaluation or redirection.
    const args = text.split(/\s+/).filter(Boolean);
    if (mode === 'reach' && args[0] === 'reach') args.shift();
    if (!args.length) return;
    logLine('prompt', `$ ${mode === 'reach' ? 'reach ' : ''}${args.join(' ')}`);
    status(els.commandStatus, 'Running…', 'running');
    command.starting = true;
    command.early = [];
    setCommandControls();
    try {
      command.runId = mode === 'reach' ? await api.run(cwd, args) : await api.runProject(cwd, args);
      command.starting = false;
      for (const event of command.early.splice(0)) commandEvent(event);
      setCommandControls();
    } catch (error) {
      command.starting = false;
      command.early = [];
      const message = error?.message || 'Command could not start.';
      logLine('error', message);
      status(els.commandStatus, message, 'error');
      setCommandControls();
    }
  }

  async function stopCommand() {
    if (command.runId === null) return;
    status(els.commandStatus, 'Stopping command…', 'running');
    try { await api.kill(command.runId); }
    catch (error) { status(els.commandStatus, 'Could not stop command: ' + error.message, 'error'); }
  }

  function addChatMessage(role, text) {
    els.chatLog.querySelector('.home-log-empty')?.remove();
    const item = document.createElement('div');
    item.className = 'home-chat-message ' + role;
    const label = document.createElement('span');
    label.className = 'home-chat-role';
    label.textContent = role === 'user' ? 'You' : 'Endpoint';
    const body = document.createElement('div');
    body.className = 'home-chat-body';
    body.textContent = text;
    item.append(label, body);
    els.chatLog.appendChild(item);
    while (els.chatLog.children.length > MAX_CHAT_MESSAGES) els.chatLog.firstElementChild.remove();
    els.chatLog.scrollTop = els.chatLog.scrollHeight;
    return body;
  }

  function syncModel() {
    const selected = window.ReachConnections?.current('home');
    const connectionId = selected?.id || '';
    if (connectionId !== chat.modelConnectionId) {
      chat.modelConnectionId = connectionId;
      if (els.model) els.model.value = selected?.model || '';
      if (els.modelList) els.modelList.replaceChildren();
    } else if (els.model && !els.model.value && selected?.model) {
      els.model.value = selected.model;
    }
    if (!chat.running && !chat.pinging && !chat.browsing) {
      status(els.endpointStatus, selected?.endpoint
        ? 'Choose a model and send a prompt to test this endpoint.'
        : 'Configure an endpoint in Settings to test a model.', selected?.endpoint ? 'ready' : 'muted');
    }
    setChatControls();
  }

  async function refreshConnections() {
    try {
      await window.ReachConnections?.refresh('home');
      syncModel();
    } catch (error) {
      status(els.endpointStatus, 'Could not load connections: ' + error.message, 'error');
      setChatControls();
    }
  }

  async function browseModels() {
    if (chat.browsing || chat.pinging || chat.running) return;
    const connectionId = window.ReachConnections?.connectionId('home') || '';
    if (!connectionId) return;
    chat.browsing = true;
    setChatControls();
    status(els.endpointStatus, 'Loading models…', 'running');
    try {
      const result = await api.listModels(connectionId);
      if (window.ReachConnections?.connectionId('home') !== connectionId) return;
      if (!result?.ok) {
        status(els.endpointStatus, result?.err || 'Could not load models.', 'error');
        return;
      }
      if (els.modelList) {
        els.modelList.replaceChildren();
        for (const id of result.models || []) {
          if (typeof id === 'string' && id) els.modelList.appendChild(new Option(id, id));
        }
      }
      if (!els.model.value && result.models?.length) els.model.value = result.models[0];
      status(els.endpointStatus, `${result.models?.length || 0} model(s) available.`, 'success');
    } catch (error) {
      status(els.endpointStatus, 'Could not load models: ' + error.message, 'error');
    } finally {
      chat.browsing = false;
      setChatControls();
    }
  }

  async function pingEndpoint() {
    if (chat.pinging || chat.browsing || chat.running) return;
    const connectionId = window.ReachConnections?.connectionId('home') || '';
    if (!connectionId) return;
    chat.pinging = true;
    setChatControls();
    status(els.endpointStatus, 'Checking endpoint…', 'running');
    try {
      const result = await api.connections.ping(connectionId);
      if (window.ReachConnections?.connectionId('home') !== connectionId) return;
      if (!result?.ok) {
        status(els.endpointStatus, `Connection failed${result?.status ? ` (HTTP ${result.status})` : ''}: ${result?.err || 'Unknown error'}`, 'error');
        return;
      }
      const latency = Number.isFinite(result.latencyMs) ? ` · ${Math.round(result.latencyMs)} ms` : '';
      const count = Number.isFinite(result.models) ? ` · ${result.models} models` : '';
      status(els.endpointStatus, `Endpoint reachable${latency}${count}.`, 'success');
    } catch (error) {
      status(els.endpointStatus, 'Connection failed: ' + error.message, 'error');
    } finally {
      chat.pinging = false;
      setChatControls();
    }
  }

  async function sendPrompt() {
    if (chat.running) return;
    const connection = window.ReachConnections?.current('home');
    const connectionId = window.ReachConnections?.connectionId('home') || '';
    const model = els.model?.value.trim() || '';
    const prompt = els.chatPrompt?.value.trim() || '';
    if (!connection?.endpoint || !connectionId) {
      status(els.endpointStatus, 'Configure an endpoint in Settings first.', 'warning');
      return;
    }
    if (!model || !prompt) {
      status(els.endpointStatus, model ? 'Enter a prompt first.' : 'Choose a model first.', 'warning');
      return;
    }
    // The Playground handler builds a fresh messages array for each call. The
    // visible transcript is never passed to it or saved to a conversation.
    chat.runId = 'home_' + (globalThis.crypto?.randomUUID?.() || `${Date.now()}_${Math.random().toString(36).slice(2)}`);
    chat.running = true;
    chat.firstChunk = false;
    addChatMessage('user', prompt);
    chat.response = addChatMessage('assistant', 'Waiting for endpoint…');
    if (els.chatPrompt) els.chatPrompt.value = '';
    setChatControls();
    status(els.endpointStatus, 'Testing completion…', 'running');
    const runId = chat.runId;
    try {
      const result = await api.playground.run({ runId, connectionId, model, prompt, stream: true, maxTokens: 256 });
      // Another Home run may have started if this one was stopped and settled.
      if (chat.runId !== runId) return;
      if (!result?.ok) {
        const message = `${result?.cancelled ? 'Stopped' : 'Completion failed'}${result?.status ? ` (HTTP ${result.status})` : ''}: ${result?.err || 'Unknown error'}`;
        if (chat.response) chat.response.textContent = chat.firstChunk
          ? `${chat.response.textContent}\n[${message}]` : message;
        chat.response?.parentElement?.classList.add('error');
        status(els.endpointStatus, message, result?.cancelled ? 'muted' : 'error');
      } else {
        if (!chat.firstChunk && chat.response) chat.response.textContent = typeof result.text === 'string' && result.text ? result.text : 'No text returned.';
        const latency = Number.isFinite(result.latencyMs) ? ` · ${Math.round(result.latencyMs)} ms` : '';
        status(els.endpointStatus, `Completion received${latency}.`, 'success');
      }
    } catch (error) {
      if (chat.runId !== runId) return;
      const message = 'Completion failed: ' + error.message;
      if (!chat.firstChunk && chat.response) chat.response.textContent = message;
      chat.response?.parentElement?.classList.add('error');
      status(els.endpointStatus, message, 'error');
    } finally {
      if (chat.runId === runId) {
        chat.running = false;
        chat.response = null;
        chat.runId = null;
        setChatControls();
      }
    }
  }

  async function stopPrompt() {
    if (!chat.running || !chat.runId) return;
    status(els.endpointStatus, 'Stopping completion…', 'running');
    try { await api.playground.stop(chat.runId); }
    catch (error) { status(els.endpointStatus, 'Could not stop completion: ' + error.message, 'error'); }
  }

  function openPage(name, event) {
    event?.preventDefault();
    if (typeof showTab === 'function') showTab(name);
  }

  api.onOutput?.(event => commandEvent({ type: 'output', ...event }));
  api.onExit?.(event => commandEvent({ type: 'exit', ...event }));
  api.playground.onToken?.(event => {
    if (!event || event.runId !== chat.runId || typeof event.delta !== 'string' || !event.delta) return;
    if (!chat.firstChunk) {
      if (chat.response) chat.response.textContent = '';
      chat.firstChunk = true;
    }
    if (chat.response) chat.response.textContent += event.delta;
    els.chatLog.scrollTop = els.chatLog.scrollHeight;
  });

  window.ReachConnections?.bind('home', els.connection, { onChange: syncModel });
  els.project.addEventListener('change', syncProjectPath);
  els.commandMode?.addEventListener('change', syncProjectPath);
  els.commandInput?.addEventListener('input', setCommandControls);
  els.commandInput?.addEventListener('keydown', event => {
    if (event.key === 'Enter') { event.preventDefault(); runCommand(); }
  });
  els.commandRun?.addEventListener('click', runCommand);
  els.commandStop?.addEventListener('click', stopCommand);
  els.projectsLink?.addEventListener('click', event => openPage('projects', event));
  els.model?.addEventListener('input', setChatControls);
  els.chatPrompt?.addEventListener('input', setChatControls);
  els.chatPrompt?.addEventListener('keydown', event => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); sendPrompt(); }
  });
  els.modelBrowse?.addEventListener('click', browseModels);
  els.endpointPing?.addEventListener('click', pingEndpoint);
  els.chatSend?.addEventListener('click', sendPrompt);
  els.chatStop?.addEventListener('click', stopPrompt);
  els.playgroundLink?.addEventListener('click', event => openPage('playground', event));

  async function sync() {
    await Promise.allSettled([refreshProjects(), refreshReachCli(), refreshConnections()]);
    setCommandControls();
    setChatControls();
  }

  window.ReachHome = { sync };
  sync();
})();
