// ---------- projects page command tabs ----------
const MAX_PROJECT_COMMAND_LINES = 4000;
function projectCommandState(dir) {
  if (!projectCommandStates.has(dir)) projectCommandStates.set(dir, { tabs: [], activeId: null, nextIndex: 1 });
  return projectCommandStates.get(dir);
}
function saveVisibleCommandDraft() {
  if (!visibleCommandTab) return;
  visibleCommandTab.draft = cmdInput.value;
  visibleCommandTab.mode = cmdMode.value;
}
function selectedCommandTab() {
  if (!currentProject) return null;
  const state = projectCommandState(currentProject.dir);
  return state.tabs.find(tab => tab.id === state.activeId) || null;
}
function newProjectCommandTab(dir, { draft = '', mode = 'project' } = {}) {
  const state = projectCommandState(dir);
  const tab = {
    id: ++projectCommandTabSeq, dir, ordinal: state.nextIndex, label: `Terminal ${state.nextIndex++}`,
    draft, mode, lines: [], status: 'ready', runId: null, command: ''
  };
  state.tabs.push(tab);
  if (currentProject?.dir === dir) selectCommandTab(tab);
  return tab;
}
function ensureProjectCommandTab(dir) {
  const state = projectCommandState(dir);
  return state.tabs.find(tab => tab.id === state.activeId)
    || state.tabs[0]
    || newProjectCommandTab(dir);
}
function commandTabStateText(tab) {
  return ({ ready: 'Ready', starting: 'Starting…', running: 'Running', stopping: 'Stopping…',
    stopped: 'Stopped', success: 'Finished', failed: 'Failed' })[tab.status] || 'Ready';
}
function renderCommandLog() {
  logEl.replaceChildren();
  if (!visibleCommandTab) return;
  const fragment = document.createDocumentFragment();
  for (const line of visibleCommandTab.lines) {
    const div = document.createElement('div');
    div.className = line.cls;
    div.textContent = line.text;
    fragment.appendChild(div);
  }
  logEl.appendChild(fragment);
  logEl.scrollTop = logEl.scrollHeight;
}
function renderCommandTabs() {
  const tabListHadFocus = commandTabsEl.contains(document.activeElement);
  const focusedTabId = document.activeElement?.id;
  const scrollLeft = commandTabsEl.scrollLeft;
  commandTabsEl.replaceChildren();
  const state = currentProject && projectCommandState(currentProject.dir);
  for (const tab of state?.tabs || []) {
    const wrap = document.createElement('div');
    wrap.className = 'project-command-tab-wrap';
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'project-command-tab';
    button.id = `project-command-tab-${tab.id}`;
    button.setAttribute('role', 'tab');
    button.setAttribute('aria-controls', 'log');
    button.setAttribute('aria-selected', String(tab === visibleCommandTab));
    button.title = `${tab.dir}\n${tab.command || tab.label}\n${commandTabStateText(tab)}`;
    const dot = document.createElement('span');
    dot.className = `project-command-tab-dot ${tab.status}`;
    dot.setAttribute('aria-hidden', 'true');
    const label = document.createElement('span');
    label.className = 'project-command-tab-label';
    label.textContent = tab.label;
    button.append(dot, label);
    button.onclick = () => selectCommandTab(tab);
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'project-command-tab-close';
    close.textContent = '×';
    const busy = ['starting', 'running', 'stopping'].includes(tab.status);
    close.title = busy ? 'Stop this command before closing its tab' : `Close ${tab.label}`;
    close.setAttribute('aria-label', close.title);
    close.onclick = () => closeProjectCommandTab(tab);
    wrap.append(button, close);
    commandTabsEl.appendChild(wrap);
  }
  commandTabsEl.scrollLeft = scrollLeft;
  const tab = visibleCommandTab;
  if (tab) logEl.setAttribute('aria-labelledby', `project-command-tab-${tab.id}`);
  else logEl.removeAttribute('aria-labelledby');
  commandTabStatusEl.textContent = tab
    ? `${tab.command || tab.label} · ${commandTabStateText(tab)} · ${tab.dir}`
    : '';
  const canStop = !!tab && ['starting', 'running', 'stopping'].includes(tab.status);
  $('#btn-stop').classList.toggle('hidden', !canStop);
  $('#btn-stop').disabled = !tab?.runId || tab.status === 'stopping';
  if (tabListHadFocus) {
    ((focusedTabId && commandTabsEl.querySelector(`#${focusedTabId}`))
      || commandTabsEl.querySelector('[role="tab"][aria-selected="true"]'))?.focus({ preventScroll: true });
  }
}
function selectCommandTab(tab) {
  if (!tab || currentProject?.dir !== tab.dir) return;
  saveVisibleCommandDraft();
  projectCommandState(tab.dir).activeId = tab.id;
  visibleCommandTab = tab;
  cmdMode.value = tab.mode;
  cmdInput.value = tab.draft;
  syncCommandMode();
  renderCommandTabs();
  renderCommandLog();
}
function closeProjectCommandTab(tab) {
  if (['starting', 'running', 'stopping'].includes(tab.status)) {
    selectCommandTab(tab);
    appendProjectCommandLine(tab, 'sys', 'Stop this command before closing its tab.');
    return;
  }
  const state = projectCommandState(tab.dir);
  const index = state.tabs.indexOf(tab);
  if (index < 0) return;
  state.tabs.splice(index, 1);
  if (tab === visibleCommandTab) {
    visibleCommandTab = null;
    const next = state.tabs[Math.min(index, state.tabs.length - 1)] || newProjectCommandTab(tab.dir);
    selectCommandTab(next);
  } else if (currentProject?.dir === tab.dir) renderCommandTabs();
}
function appendProjectCommandLine(tab, cls, text) {
  if (!tab) return;
  tab.lines.push({ cls, text });
  const overflow = tab.lines.length - MAX_PROJECT_COMMAND_LINES;
  if (overflow > 0) tab.lines.splice(0, overflow);
  if (tab !== visibleCommandTab) return;
  const nearBottom = logEl.scrollHeight - logEl.clientHeight - logEl.scrollTop < 40;
  if (overflow > 0) renderCommandLog();
  else {
    const div = document.createElement('div');
    div.className = cls;
    div.textContent = text;
    logEl.appendChild(div);
    if (nearBottom) logEl.scrollTop = logEl.scrollHeight;
  }
}
function logLine(cls, text) {
  appendProjectCommandLine(visibleCommandTab, cls, text);
}
function bufferProjectCommandEvent(event) {
  if (!projectCommandPending.size && !projectCommandCreating) return;
  const events = projectCommandEarlyEvents.get(event.runId) || [];
  if (events.length < 200) events.push(event);
  projectCommandEarlyEvents.set(event.runId, events);
  if (projectCommandEarlyEvents.size > 40) projectCommandEarlyEvents.delete(projectCommandEarlyEvents.keys().next().value);
}
function showRunEvent(event) {
  const tab = projectCommandRuns.get(event.runId);
  if (!tab) { bufferProjectCommandEvent(event); return; }
  if (event.type === 'output') {
    const cls = event.channel === 'err' ? 'err' : 'out';
    for (const line of event.data.split('\n')) if (line) appendProjectCommandLine(tab, cls, line);
    return;
  }
  const message = event.launchError ? '— command could not start —'
    : event.stopped ? '— command stopped —'
      : `— process exited with code ${event.code} —`;
  appendProjectCommandLine(tab, event.code === 0 && !event.stopped ? 'exit0' : 'exitn', message);
  tab.status = event.stopped ? 'stopped' : event.code === 0 ? 'success' : 'failed';
  tab.runId = null;
  projectCommandRuns.delete(event.runId);
  if (currentProject?.dir === tab.dir) renderCommandTabs();
}
function registerProjectCommandRun(tab, runId) {
  tab.runId = runId;
  tab.status = 'running';
  projectCommandRuns.set(runId, tab);
  for (const event of projectCommandEarlyEvents.get(runId) || []) showRunEvent(event);
  projectCommandEarlyEvents.delete(runId);
  if (currentProject?.dir === tab.dir) renderCommandTabs();
}
reachApi.onOutput(event => showRunEvent({ type: 'output', ...event }));
reachApi.onExit(event => showRunEvent({ type: 'exit', ...event }));

// ---------- status ----------
async function refreshStatus() {
  const v = await reachApi.getVersion();
  reachCliAvailable = !v.startsWith('Native Reach compiler unavailable.');
  if (reachCliAvailable) {
    wslStatus.textContent = 'Reach compiler \u2713';
    wslStatus.className = 'chip ok';
    reachVersion.textContent = v;
    reachVersion.title = '';
  } else {
    wslStatus.textContent = 'Reach compiler unavailable';
    wslStatus.className = 'chip';
    reachVersion.textContent = 'Configure native reachc in Settings';
    reachVersion.title = v;
  }
}

// ---------- projects ----------
const removingProjects = new Set();
async function loadProjectList() {
  const ps = await reachApi.getProjects();
  // An open chat/editor can outlive its saved shortcut. Do not resurrect it.
  projectList.innerHTML = '';
  for (const p of ps) {
    const li = document.createElement('li');
    const label = document.createElement('button');
    label.type = 'button';
    label.className = 'project-open';
    label.title = p.dir;
    const word = String(p.name || '').trim().split(/\s+/)[0] || '';
    const brief = document.createElement('span');
    brief.className = 'project-brief';
    brief.dataset.word = word;
    brief.textContent = word;
    brief.setAttribute('aria-hidden', 'true');
    const fullName = document.createElement('span');
    fullName.className = 'project-name';
    fullName.textContent = p.name;
    label.append(brief, fullName);
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'project-remove';
    remove.textContent = '×';
    remove.title = 'Remove from Projects (keep files on disk)';
    remove.setAttribute('aria-label', `Remove "${p.name}" from Projects`);
    remove.disabled = removingProjects.has(p.dir);
    remove.onclick = event => {
      event.stopPropagation();
      return removeRememberedProject(p, remove);
    };
    li.append(label, remove);
    li.title = p.dir;
    if (currentProject && currentProject.dir === p.dir) li.classList.add('active');
    li.onclick = () => selectProject(p);
    projectList.appendChild(li);
  }
}

async function removeRememberedProject(project, button) {
  if (removingProjects.has(project.dir)) return;
  removingProjects.add(project.dir);
  try {
    if (!await confirmAction(`Remove "${project.name}" from Projects? This only removes the saved shortcut. Files, conversations, and open work are kept. You can add it again with Open Folder.`)) return;
    const restoreFocus = document.activeElement === button;
    button.disabled = true;
    const result = await reachApi.removeProject(project.dir);
    if (!result.ok) throw new Error(result.err || 'Could not remove project.');
    await Promise.all([loadProjectList(), loadAgentProjectSelect()]);
    if (restoreFocus && $('#page-projects').classList.contains('active')) {
      (projectList.querySelector('.project-open') || $('#btn-open')).focus();
    }
  } catch (error) {
    await showNotice(`Could not remove project: ${error.message}`);
  } finally {
    removingProjects.delete(project.dir);
    button.disabled = false;
  }
}

async function selectProject(p, { openDraft = true } = {}) {
  const revision = ++projectSelectionRevision;
  if (hasUnsavedFilesOutside(p.dir)
      && !await confirmAction('There are unsaved editor changes. Discard them and switch project?')) {
    $('#agent-project-select').value = agentProjectDir || '';
    return false;
  }
  if (revision !== projectSelectionRevision) return false;
  const changed = currentProject?.dir !== p.dir;
  if (changed) saveVisibleCommandDraft();
  currentProject = p;
  agentProjectDir = p.dir;
  // Keep Home's mini Projects runner pointed at the active workspace folder.
  window.ReachCurrentProjectDir = p.dir;
  window.dispatchEvent(new CustomEvent('reach:project-selected', { detail: { dir: p.dir } }));
  if (currentAgent && currentAgent.dir !== p.dir) {
    rememberNewChatDraft();
    currentAgent = null;
    syncSelectedTeamRun();
    agentRunning = false;
    streamBubble = null;
    recoveryBubble = null;
    agentView.classList.add('hidden');
    noAgent.classList.remove('hidden');
  }
  projectName.textContent = p.name;
  projectPath.textContent = p.dir;
  noProject.classList.add('hidden');
  projectView.classList.remove('hidden');
  if (changed || visibleCommandTab?.dir !== p.dir) selectCommandTab(ensureProjectCommandTab(p.dir));
  await Promise.all([refreshFileTree(), loadProjectList(), loadAgentProjectSelect(), loadAgentTree()]);
  if (revision !== projectSelectionRevision) return false;
  if (openDraft && !currentAgent) await selectNewChat();
  return true;
}

async function rememberProject(dir) {
  const ps = await reachApi.getProjects();
  const name = dir.split(/[\\/]/).pop();
  const existing = ps.find((p) => p.dir === dir);
  let list;
  if (existing) list = ps;
  else list = [{ name, dir }, ...ps].slice(0, 20);
  await reachApi.saveProjects(list);
  await selectProject({ name, dir });
}

function syncCommandMode() {
  const reachMode = cmdMode.value === 'reach';
  cmdPrompt.textContent = reachMode ? 'Reach' : '$';
  cmdInput.placeholder = reachMode ? 'e.g. compile index.rsh' : 'e.g. npm --prefix studio test';
  cmdHint.textContent = reachMode
    ? 'Native Reach: select a Reach DApp project or run init here; then compile index.rsh and run index.rsh with Ganache on 127.0.0.1:8545.'
    : 'Runs a program in this project folder. RCH: rch help (install once with npm --prefix RCH run install:cli). No shell pipes or redirects.';
}
cmdMode.onchange = syncCommandMode;
syncCommandMode();

async function execCommand(args, mode, { newTab = false, draft = '' } = {}) {
  if (!currentProject) return false;
  if (mode === 'reach' && !reachCliAvailable && args[0] !== 'clean') {
    logLine('err', 'Native Reach compiler is unavailable. Build reachc and set its path in Settings → Connection.');
    return false;
  }
  let tab = selectedCommandTab();
  if (newTab || !tab || ['starting', 'running', 'stopping'].includes(tab.status)) {
    tab = newProjectCommandTab(currentProject.dir, { draft, mode });
  }
  tab.mode = mode;
  tab.command = mode === 'reach' ? `Native Reach · ${args.join(' ')}` : `$ ${args.join(' ')}`;
  tab.label = `${mode === 'reach' ? `Reach ${args[0]}` : args[0].split(/[\\/]/).pop()} · ${tab.ordinal}`;
  tab.status = 'starting';
  appendProjectCommandLine(tab, 'sys', tab.command);
  if (currentProject?.dir === tab.dir) renderCommandTabs();
  projectCommandPending.add(tab);
  try {
    const runId = mode === 'reach'
      ? await reachApi.run(tab.dir, args)
      : await reachApi.runProject(tab.dir, args);
    registerProjectCommandRun(tab, runId);
    return tab;
  } catch (error) {
    tab.status = 'failed';
    appendProjectCommandLine(tab, 'err', error.message || 'Command could not start.');
    if (currentProject?.dir === tab.dir) renderCommandTabs();
    return false;
  } finally {
    projectCommandPending.delete(tab);
    if (!projectCommandPending.size && !projectCommandCreating) projectCommandEarlyEvents.clear();
  }
}

$('#btn-compile').onclick = async () => {
  const project = currentProject;
  if (!project) return;
  if (reachCliAvailable) {
    const files = await reachApi.listFiles(project.dir);
    if (currentProject?.dir !== project.dir) return;
    if (!files.includes('index.rsh')) {
      logLine('err', 'This project has no index.rsh. Open a Reach DApp project or choose a source file in Native Reach mode.');
      return;
    }
  }
  await execCommand(['compile', 'index.rsh'], 'reach');
};
$('#btn-clean').onclick = () => execCommand(['clean'], 'reach');
$('#btn-info').onclick = () => execCommand(['info'], 'reach');
$('#btn-folder').onclick = () => currentProject && reachApi.openDir(currentProject.dir);
async function runInputCommand(newTab = false) {
  const text = cmdInput.value.trim();
  if (!text) { cmdInput.focus(); return; }
  let args;
  try { args = window.ReachCommandLine.parse(text); }
  catch (error) { logLine('err', error.message); return; }
  const mode = cmdMode.value === 'reach' ? 'reach' : 'project';
  if (mode === 'reach' && ['reach', 'reachc'].includes(args[0])) args.shift();
  if (!args.length) return;
  const originalTab = visibleCommandTab;
  const tab = await execCommand(args, mode, { newTab, draft: text });
  if (tab) {
    if (tab.draft.trim() === text) tab.draft = '';
    if (originalTab !== tab && originalTab?.draft.trim() === text) originalTab.draft = '';
    if (visibleCommandTab === tab && cmdInput.value.trim() === text) cmdInput.value = '';
  }
}
$('#btn-run').onclick = () => runInputCommand();
$('#btn-stop').onclick = async () => {
  const tab = visibleCommandTab;
  if (!tab?.runId) return;
  tab.status = 'stopping';
  renderCommandTabs();
  const killed = await reachApi.kill(tab.runId);
  if (!killed && tab.runId) { tab.status = 'running'; renderCommandTabs(); }
};
$('#project-tab-add').onclick = () => {
  if (!currentProject) return;
  newProjectCommandTab(currentProject.dir, { mode: cmdMode.value });
  cmdInput.focus();
};
commandTabsEl.addEventListener('keydown', event => {
  if (event.target.getAttribute('role') !== 'tab') return;
  const tabs = projectCommandState(currentProject.dir).tabs;
  const index = tabs.findIndex(tab => `project-command-tab-${tab.id}` === event.target.id);
  if (index < 0) return;
  const next = event.key === 'ArrowRight' ? tabs[(index + 1) % tabs.length]
    : event.key === 'ArrowLeft' ? tabs[(index - 1 + tabs.length) % tabs.length]
      : event.key === 'Home' ? tabs[0]
        : event.key === 'End' ? tabs[tabs.length - 1] : null;
  if (!next) return;
  event.preventDefault();
  selectCommandTab(next);
  commandTabsEl.querySelector(`#project-command-tab-${next.id}`)?.focus();
});
function closeProjectRunMenu() {
  runMenuEl.classList.add('hidden');
  $('#btn-run-options').setAttribute('aria-expanded', 'false');
}
$('#btn-run-options').onclick = event => {
  event.stopPropagation();
  const opening = runMenuEl.classList.contains('hidden');
  runMenuEl.classList.toggle('hidden', !opening);
  $('#btn-run-options').setAttribute('aria-expanded', String(opening));
  if (opening) $('#btn-run-new-tab').focus();
};
$('#btn-run-new-tab').onclick = event => {
  event.stopPropagation();
  closeProjectRunMenu();
  runInputCommand(true);
};
$('#btn-run-empty-tab').onclick = event => {
  event.stopPropagation();
  closeProjectRunMenu();
  $('#project-tab-add').click();
};
runMenuEl.addEventListener('keydown', event => {
  if (event.key === 'Escape') { closeProjectRunMenu(); $('#btn-run-options').focus(); }
});
document.addEventListener('click', event => {
  if (!event.target.closest('.project-run-split')) closeProjectRunMenu();
  // Dismiss open message-action trays when clicking elsewhere (wings too, so
  // clicking a wing icon does not close it before its handler runs).
  if (!event.target.closest('.msg-actions') && !event.target.closest('.msg-wing') && !event.target.closest('.msg-translate-pop')) {
    for (const other of document.querySelectorAll('.msg-actions.expanded')) collapseMessageTray(other);
  }
  // The translate popover closes on an outside click, but never when the click
  // is on the action that toggles it (its own handler decides that).
  if (!event.target.closest('.msg-translate-pop') && !event.target.closest('.msg-translate')) {
    closeTranslatePopovers();
  }
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape') {
    for (const other of document.querySelectorAll('.msg-actions.expanded')) collapseMessageTray(other);
    closeTranslatePopovers();
  }
});
cmdInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') { event.preventDefault(); $('#btn-run').click(); }
});

$('#btn-open').onclick = async () => {
  const dir = await reachApi.pickDir();
  if (dir) await rememberProject(dir);
};

$('#btn-new').onclick = () => {
  $('#new-name').value = '';
  $('#new-parent').value = '';
  $('#new-kind').value = 'general';
  $('#btn-create').textContent = 'Create Project';
  modal.classList.remove('hidden');
  $('#new-name').focus();
};
$('#new-kind').onchange = () => {
  $('#btn-create').textContent = $('#new-kind').value === 'reach' ? 'Create & Init' : 'Create Project';
};
$('#btn-cancel').onclick = () => modal.classList.add('hidden');
$('#btn-pick-parent').onclick = async () => {
  const dir = await reachApi.pickDir();
  if (dir) $('#new-parent').value = dir;
};
$('#btn-create').onclick = async () => {
  const name = $('#new-name').value.trim();
  const parent = $('#new-parent').value.trim();
  if (!name) { $('#new-name').focus(); return; }
  if (!parent) { $('#btn-pick-parent').click(); return; }
  const kind = $('#new-kind').value === 'reach' ? 'reach' : 'general';
  if (kind === 'reach' && !reachCliAvailable) {
    await showNotice('Configure a native Reach compiler in Settings before initializing a Reach DApp. General projects need no compiler.');
    return;
  }
  modal.classList.add('hidden');
  if (kind === 'reach') projectCommandCreating++;
  try {
    let res;
    try { res = await reachApi.createProject(name, parent, kind); }
    catch (error) { res = { ok: false, err: error.message }; }
    if (!res.ok) {
      showNotice(`Could not create project: ${res.err}`);
      return;
    }
    await rememberProject(res.dir);
    if (res.runId != null) {
      const tab = ensureProjectCommandTab(res.dir);
      tab.mode = 'reach';
      tab.command = 'Native Reach · init';
      tab.label = 'Reach init';
      tab.status = 'starting';
      appendProjectCommandLine(tab, 'sys', tab.command);
      registerProjectCommandRun(tab, res.runId);
    } else {
      logLine('sys', `Created project folder: ${res.dir}`);
    }
  } finally {
    if (kind === 'reach') projectCommandCreating--;
    if (!projectCommandPending.size && !projectCommandCreating) projectCommandEarlyEvents.clear();
  }
};

