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
    commandRunMore: $('#home-command-run-more'),
    commandRunMenu: $('#home-command-run-menu'),
    commandRunNewTab: $('#home-command-run-new-tab'),
    commandTabs: $('#home-command-tabs'),
    commandNewTab: $('#home-command-new-tab'),
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

  const command = { sessions: [], activeId: null, nextId: 1, early: [], cliAvailable: false };
  let linkedProjectDir = window.ReachCurrentProjectDir || '';
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

  function isNativeClean(text) {
    try {
      const args = window.ReachCommandLine.parse(text || '');
      if (['reach', 'reachc'].includes(args[0])) args.shift();
      return args[0] === 'clean';
    } catch { return false; }
  }

  function activeSession() {
    return command.sessions.find(session => session.id === command.activeId) || null;
  }

  function saveDraft() {
    const session = activeSession();
    if (!session) return;
    session.cwd = els.project.value || '';
    session.mode = els.commandMode?.value === 'reach' ? 'reach' : 'project';
    session.input = els.commandInput?.value || '';
  }

  function setCommandControls() {
    const session = activeSession();
    const hasProject = !!els.project.value;
    const hasInput = !!els.commandInput?.value.trim();
    const reachUnavailable = els.commandMode?.value === 'reach' && !command.cliAvailable && !isNativeClean(els.commandInput?.value);
    const canStart = hasProject && hasInput && !reachUnavailable;
    if (els.commandRun) els.commandRun.disabled = !canStart;
    if (els.commandRunMore) els.commandRunMore.disabled = !canStart;
    if (els.commandRunNewTab) els.commandRunNewTab.disabled = !canStart;
    if (els.commandStop) els.commandStop.disabled = !session?.runId || session.stopping;
    els.project.disabled = !els.project.options.length;
    if (els.commandMode) els.commandMode.disabled = !hasProject;
    if (els.commandInput) els.commandInput.disabled = !hasProject;
    if (els.commandInput) els.commandInput.placeholder = els.commandMode?.value === 'reach'
      ? 'compile index.rsh' : 'npm test';
  }

  function renderTabs() {
    if (!els.commandTabs) return;
    els.commandTabs.replaceChildren();
    for (const session of command.sessions) {
      const wrap = document.createElement('div');
      wrap.className = 'home-command-tab-wrap';
      const tab = document.createElement('button');
      tab.type = 'button';
      tab.className = 'home-command-tab';
      tab.role = 'tab';
      tab.dataset.sessionId = String(session.id);
      tab.dataset.state = session.starting || session.runId !== null ? 'running' : session.statusState;
      tab.setAttribute('aria-selected', String(session.id === command.activeId));
      tab.setAttribute('aria-label', `${session.title}: ${session.statusText}`);
      tab.title = `${session.title} — ${session.statusText}`;
      const dot = document.createElement('span');
      dot.className = 'home-command-tab-dot';
      dot.setAttribute('aria-hidden', 'true');
      const label = document.createElement('span');
      label.className = 'home-command-tab-label';
      label.textContent = session.title;
      tab.append(dot, label);
      tab.addEventListener('click', () => selectSession(session.id));
      tab.addEventListener('keydown', event => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        const index = command.sessions.indexOf(session);
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? command.sessions.length - 1
          : (index + (event.key === 'ArrowRight' ? 1 : -1) + command.sessions.length) % command.sessions.length;
        selectSession(command.sessions[next].id);
        els.commandTabs.querySelector(`[data-session-id="${command.sessions[next].id}"]`)?.focus();
      });
      const close = document.createElement('button');
      close.type = 'button';
      close.className = 'home-command-tab-close';
      close.textContent = '×';
      close.setAttribute('aria-label', `Close ${session.title}`);
      close.title = session.starting || session.runId !== null ? 'Stop this command before closing its tab' : `Close ${session.title}`;
      close.disabled = session.starting || session.runId !== null;
      close.addEventListener('click', () => closeSession(session.id));
      wrap.append(tab, close);
      els.commandTabs.appendChild(wrap);
    }
  }

  function renderLog() {
    if (!els.commandLog) return;
    const session = activeSession();
    els.commandLog.replaceChildren();
    if (!session?.lines.length) {
      const empty = document.createElement('span');
      empty.className = 'home-log-empty';
      empty.textContent = 'Command output will appear here.';
      els.commandLog.appendChild(empty);
    } else {
      for (const line of session.lines) appendLogElement(line.kind, line.message);
    }
    els.commandLog.scrollTop = els.commandLog.scrollHeight;
    status(els.commandStatus, session?.statusText || 'Ready', session?.statusState || 'ready');
  }

  function appendLogElement(kind, message) {
    const line = document.createElement('div');
    const style = { prompt: 'sys', output: 'out', error: 'err', success: 'exit0' }[kind] || 'out';
    line.className = 'home-command-line ' + style;
    line.textContent = message;
    els.commandLog.appendChild(line);
  }

  function selectSession(id) {
    if (command.activeId === id) return;
    saveDraft();
    const session = command.sessions.find(item => item.id === id);
    if (!session) return;
    command.activeId = id;
    if ([...els.project.options].some(option => option.value === session.cwd)) els.project.value = session.cwd;
    else session.cwd = els.project.value || '';
    if (els.commandMode) els.commandMode.value = session.mode;
    if (els.commandInput) els.commandInput.value = session.input;
    closeRunMenu();
    renderTabs();
    renderLog();
    syncProjectPath();
  }

  function createSession({ copyInput = false } = {}) {
    saveDraft();
    const prior = activeSession();
    const id = command.nextId++;
    const session = {
      id, title: `Terminal ${id}`, cwd: prior?.cwd || els.project.value || '',
      mode: prior?.mode || els.commandMode?.value || 'project',
      input: copyInput ? (prior?.input || '') : '', runId: null,
      starting: false, stopping: false, lines: [],
      statusText: 'Ready in the selected project folder.', statusState: 'ready',
    };
    command.sessions.push(session);
    command.activeId = null;
    selectSession(id);
    return session;
  }

  function closeSession(id) {
    const session = command.sessions.find(item => item.id === id);
    if (!session || session.starting || session.runId !== null) return;
    const index = command.sessions.indexOf(session);
    command.sessions.splice(index, 1);
    if (command.activeId === id) {
      command.activeId = null;
      if (command.sessions.length) selectSession(command.sessions[Math.min(index, command.sessions.length - 1)].id);
      else createSession();
    } else renderTabs();
  }

  function closeRunMenu() {
    if (els.commandRunMenu) els.commandRunMenu.hidden = true;
    els.commandRunMore?.setAttribute('aria-expanded', 'false');
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
    saveDraft();
    const session = activeSession();
    if (session && !session.starting && session.runId === null && !session.lines.length) {
      if (!dir) {
        session.statusText = 'Add a project to run commands.';
        session.statusState = 'muted';
      } else if (els.commandMode?.value === 'reach' && !command.cliAvailable && !isNativeClean(els.commandInput?.value)) {
        session.statusText = 'Native Reach compiler unavailable. Set reachc in Settings.';
        session.statusState = 'warning';
      } else {
        session.statusText = 'Ready in the selected project folder.';
        session.statusState = 'ready';
      }
      status(els.commandStatus, session.statusText, session.statusState);
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
      const preferred = linkedProjectDir || previous;
      if ([...els.project.options].some(option => option.value === preferred)) els.project.value = preferred;
      else if ([...els.project.options].some(option => option.value === previous)) els.project.value = previous;
      syncProjectPath();
    } catch (error) {
      status(els.commandStatus, 'Could not load projects: ' + error.message, 'error');
      setCommandControls();
    }
  }

  async function refreshReachCli() {
    try {
      const version = await api.getVersion();
      command.cliAvailable = typeof version === 'string' && !version.startsWith('Native Reach compiler unavailable.');
    } catch { command.cliAvailable = false; }
    syncProjectPath();
  }

  function logLine(session, kind, message) {
    if (!session) return;
    session.lines.push({ kind, message });
    while (session.lines.length > MAX_LOG_LINES) session.lines.shift();
    if (session.id !== command.activeId || !els.commandLog) return;
    els.commandLog.querySelector('.home-log-empty')?.remove();
    appendLogElement(kind, message);
    while (els.commandLog.children.length > MAX_LOG_LINES) els.commandLog.firstElementChild.remove();
    els.commandLog.scrollTop = els.commandLog.scrollHeight;
  }

  function commandEvent(event) {
    if (!event?.runId) return;
    const session = command.sessions.find(item => item.runId === event.runId);
    if (!session) {
      // A short process may emit output and exit before invoke returns.
      if (command.sessions.some(item => item.starting) && command.early.length < 500) command.early.push(event);
      return;
    }
    if (event.type === 'output') {
      for (const line of String(event.data || '').split(/\r?\n/)) {
        if (line) logLine(session, event.channel === 'err' ? 'error' : 'output', line);
      }
      return;
    }
    if (event.type === 'exit') {
      const message = event.launchError ? 'Command could not start.'
        : event.stopped ? 'Command stopped.'
          : `Process exited with code ${event.code}.`;
      logLine(session, event.code === 0 ? 'success' : 'error', message);
      session.statusText = message;
      session.statusState = event.code === 0 ? 'success' : 'error';
      session.runId = null;
      session.stopping = false;
      if (session.id === command.activeId) {
        status(els.commandStatus, message, session.statusState);
        setCommandControls();
      }
      renderTabs();
    }
  }

  async function runCommand(session = activeSession()) {
    if (!session || session.starting || session.runId !== null) return;
    if (session.id === command.activeId) saveDraft();
    const cwd = session.cwd;
    const text = session.input.trim();
    const mode = session.mode;
    if (!cwd || !text) return;
    // Match the Projects command bar: quote-aware argv, without a shell.
    let args;
    try { args = window.ReachCommandLine.parse(text); }
    catch (error) {
      logLine(session, 'error', error.message);
      session.statusText = error.message;
      session.statusState = 'error';
      if (session.id === command.activeId) status(els.commandStatus, error.message, 'error');
      renderTabs();
      return;
    }
    if (mode === 'reach' && ['reach', 'reachc'].includes(args[0])) args.shift();
    if (!args.length) return;
    if (mode === 'reach' && !command.cliAvailable && args[0] !== 'clean') {
      session.statusText = 'Native Reach compiler unavailable. Set reachc in Settings.';
      session.statusState = 'warning';
      if (session.id === command.activeId) status(els.commandStatus, session.statusText, 'warning');
      renderTabs();
      return;
    }
    session.title = text.length > 22 ? `${text.slice(0, 21)}…` : text;
    logLine(session, 'prompt', mode === 'reach' ? `Native Reach · ${args.join(' ')}` : `$ ${args.join(' ')}`);
    session.statusText = 'Running…';
    session.statusState = 'running';
    session.starting = true;
    if (session.id === command.activeId) {
      status(els.commandStatus, 'Running…', 'running');
      setCommandControls();
    }
    renderTabs();
    try {
      const runId = mode === 'reach' ? await api.run(cwd, args) : await api.runProject(cwd, args);
      session.runId = runId;
      session.starting = false;
      const early = command.early.filter(event => event.runId === runId);
      command.early = command.early.filter(event => event.runId !== runId);
      for (const event of early) commandEvent(event);
      if (!command.sessions.some(item => item.starting)) command.early.length = 0;
      if (session.id === command.activeId) setCommandControls();
      renderTabs();
    } catch (error) {
      session.starting = false;
      if (!command.sessions.some(item => item.starting)) command.early.length = 0;
      const message = error?.message || 'Command could not start.';
      logLine(session, 'error', message);
      session.statusText = message;
      session.statusState = 'error';
      if (session.id === command.activeId) {
        status(els.commandStatus, message, 'error');
        setCommandControls();
      }
      renderTabs();
    }
  }

  async function stopCommand() {
    const session = activeSession();
    if (!session?.runId || session.stopping) return;
    session.stopping = true;
    session.statusText = 'Stopping command…';
    session.statusState = 'running';
    status(els.commandStatus, session.statusText, 'running');
    setCommandControls();
    renderTabs();
    try { await api.kill(session.runId); }
    catch (error) {
      session.stopping = false;
      session.statusText = 'Could not stop command: ' + error.message;
      session.statusState = 'error';
      status(els.commandStatus, session.statusText, 'error');
      setCommandControls();
      renderTabs();
    }
  }

  function runPrimaryCommand() {
    const session = activeSession();
    if (session?.starting || session?.runId !== null) {
      void runCommand(createSession({ copyInput: true }));
    } else void runCommand();
  }

  function runInNewTab() {
    if (els.commandRunNewTab?.disabled) return;
    closeRunMenu();
    const session = createSession({ copyInput: true });
    void runCommand(session);
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
  els.project.addEventListener('change', () => {
    linkedProjectDir = '';
    syncProjectPath();
  });
  window.addEventListener('reach:project-selected', event => {
    linkedProjectDir = String(event.detail?.dir || '');
    void refreshProjects();
  });
  els.commandMode?.addEventListener('change', syncProjectPath);
  els.commandInput?.addEventListener('input', syncProjectPath);
  els.commandInput?.addEventListener('keydown', event => {
    if (event.key === 'Enter') { event.preventDefault(); closeRunMenu(); runPrimaryCommand(); }
  });
  els.commandRun?.addEventListener('click', () => { closeRunMenu(); runPrimaryCommand(); });
  els.commandRunMore?.addEventListener('click', event => {
    event.stopPropagation();
    const open = !els.commandRunMenu.hidden;
    els.commandRunMenu.hidden = open;
    els.commandRunMore.setAttribute('aria-expanded', String(!open));
  });
  els.commandRunNewTab?.addEventListener('click', runInNewTab);
  els.commandNewTab?.addEventListener('click', () => createSession());
  document.addEventListener('click', event => {
    if (!event.target.closest('.home-run-split')) closeRunMenu();
  });
  document.addEventListener('keydown', event => { if (event.key === 'Escape') closeRunMenu(); });
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
  createSession();
  sync();
})();
