const $ = (s) => document.querySelector(s);
const reachApi = window.reach;
const isMac = reachApi.platform === 'darwin';
if (isMac) {
  $('#composer-input').placeholder = $('#composer-input').placeholder.replace('Ctrl+', 'Cmd+');
  $('#btn-save-file').textContent = 'Save (Cmd+S)';
  $('#browser-new').title = 'New browser tab (Cmd+T)';
}
$('#set-reach-cli-help').textContent = reachApi.platform === 'win32'
  ? 'Optional Reach language toolchain: path inside WSL Ubuntu. Leave blank for /usr/local/bin/reach.'
  : 'Optional Reach language toolchain: executable path. Leave blank to find reach on PATH, including Homebrew and ~/.local/bin.';
const md = window.ReachMarkdown;
const showNotice = message => window.ReachDialogs.notice(message);
const confirmAction = message => window.ReachDialogs.confirm(message);

let currentProject = null;
let projectSelectionRevision = 0;
let activeRunId = null;
let currentAgent = null;
let agents = [];
let agentRunning = false;
const runningAgentIds = new Set();
let stoppingAll = false;

// ---------- editor state ----------
const openFiles = new Map(); // relPath -> { editor, el (tab), dirty, savedText }
let activeFile = null;

function hasUnsavedFilesOutside(dir) {
  return [...openFiles.values()].some(file => file.dir !== dir && file.dirty);
}

function resetEditors() {
  for (const file of openFiles.values()) { file.editor.destroy(); file.el.remove(); file.host.remove(); }
  openFiles.clear();
  activeFile = null;
  editorHost.innerHTML = '';
  editorEmpty.classList.remove('hidden');
  editorStatus.textContent = '';
  $('#btn-save-file').classList.add('hidden');
}

// ---------- elements ----------
const projectList = $('#project-list');
const wslStatus = $('#wsl-status');
const reachVersion = $('#reach-version');
const noProject = $('#no-project');
const projectView = $('#project-view');
const projectName = $('#project-name');
const projectPath = $('#project-path');
const logEl = $('#log');
const cmdInput = $('#cmd-input');
const modal = $('#modal');
const approvalModal = $('#approval-modal');
const noAgent = $('#no-agent');
const agentView = $('#agent-view');
const agentNameEl = $('#agent-name');
const agentMetaEl = $('#agent-meta');
const chatLog = $('#chat-log');
const chatScroll = $('#chat-scroll');
const composerInput = $('#composer-input');
const todosPanel = $('#agent-todos');
const todoList = $('#agent-todo-list');
const queuedIndicator = $('#queued-indicator');
const fileTreeEl = $('#file-tree');
const editorTabsEl = $('#editor-tabs');
const editorHost = $('#editor-host');
const editorEmpty = $('#editor-empty');
const editorStatus = $('#editor-status');

// ---------- tabs ----------
async function showTab(name) {
  const page = $('#page-' + name);
  // A rail view (workspace, playground, about) has no header tab. Without this
  // guard the null lookup below throws a TypeError and the page never shows.
  if (!page) return;
  const nextDir = drawerDir(name);
  if (hasUnsavedFilesOutside(nextDir) && !await confirmAction('There are unsaved editor changes. Discard them and switch project?')) return;
  for (const p of document.querySelectorAll('.page')) p.classList.remove('active');
  for (const tab of document.querySelectorAll('.tab')) tab.classList.remove('active');
  page.classList.add('active');
  $('#tab-' + name)?.classList.add('active');
  window.ReachWorkspace?.sync();
  window.ReachWorkspaceShell?.markRail();
  if (name === 'workspace') window.ReachWorkspaceDash?.sync();
  if (name === 'about') window.ReachAbout?.sync();
  if (name === 'refactor') window.ReachRefactor?.sync();
  return refreshFileTree();
}
$('#tab-projects').onclick = () => showTab('projects');
$('#tab-agents').onclick = () => showTab('agents');
$('#tab-create').onclick = () => showTab('create');

// ---------- projects page log ----------
function logLine(cls, text) {
  const div = document.createElement('div');
  div.className = cls;
  div.textContent = text;
  logEl.appendChild(div);
  logEl.scrollTop = logEl.scrollHeight;
}
function clearLog() { logEl.innerHTML = ''; }

reachApi.onOutput(({ runId, channel, data }) => {
  if (runId !== activeRunId) return;
  const cls = channel === 'err' ? 'err' : 'out';
  for (const line of data.split('\n')) {
    if (line === '') continue;
    logLine(cls, line);
  }
});
reachApi.onExit(({ runId, code }) => {
  if (runId !== activeRunId) return;
  logLine(code === 0 ? 'exit0' : 'exitn', `\u2014 process exited with code ${code} \u2014`);
  $('#btn-run').disabled = false;
  $('#btn-stop').classList.add('hidden');
  activeRunId = null;
});

// ---------- status ----------
async function refreshStatus() {
  const v = await reachApi.getVersion();
  if (v.startsWith('reach ')) {
    wslStatus.textContent = 'Reach CLI \u2713';
    wslStatus.className = 'chip ok';
    reachVersion.textContent = v;
    reachVersion.title = '';
  } else {
    wslStatus.textContent = 'CLI not configured';
    wslStatus.className = 'chip';
    reachVersion.textContent = 'Configure optional CLI in Settings';
    reachVersion.title = v;
  }
}

// ---------- projects ----------
async function loadProjectList() {
  const ps = await reachApi.getProjects();
  if (currentProject && !ps.some(p => p.dir === currentProject.dir)) ps.push(currentProject);
  projectList.innerHTML = '';
  for (const p of ps) {
    const li = document.createElement('li');
    li.textContent = p.name;
    li.title = p.dir;
    if (currentProject && currentProject.dir === p.dir) li.classList.add('active');
    li.onclick = () => selectProject(p);
    projectList.appendChild(li);
  }
}

async function selectProject(p) {
  const revision = ++projectSelectionRevision;
  if (hasUnsavedFilesOutside(p.dir)
      && !await confirmAction('There are unsaved editor changes. Discard them and switch project?')) {
    $('#agent-project-select').value = agentProjectDir || '';
    return false;
  }
  if (revision !== projectSelectionRevision) return false;
  const changed = currentProject?.dir !== p.dir;
  currentProject = p;
  agentProjectDir = p.dir;
  if (currentAgent && currentAgent.dir !== p.dir) {
    currentAgent = null;
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
  if (changed) {
    clearLog();
    logLine('sys', `Project: ${p.name}  (${p.dir})`);
  }
  await Promise.all([refreshFileTree(), loadProjectList(), loadAgentProjectSelect(), loadAgentTree()]);
  return revision === projectSelectionRevision;
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

async function execReach(args, sysLine) {
  if (!currentProject) return;
  if (activeRunId) { logLine('sys', 'Another command is still running. Stop it first.'); return; }
  if (sysLine) logLine('sys', `$ reach ${args.join(' ')}`);
  $('#btn-run').disabled = true;
  $('#btn-stop').classList.remove('hidden');
  activeRunId = await reachApi.run(currentProject.dir, args);
}

$('#btn-compile').onclick = () => execReach(['compile', 'index.rsh']);
$('#btn-clean').onclick = () => execReach(['clean']);
$('#btn-info').onclick = () => execReach(['info']);
$('#btn-folder').onclick = () => currentProject && reachApi.openDir(currentProject.dir);
$('#btn-run').onclick = () => {
  const t = cmdInput.value.trim();
  if (!t) return;
  const args = t.split(/\s+/).filter(Boolean);
  cmdInput.value = '';
  execReach(args);
};
$('#btn-stop').onclick = async () => {
  if (activeRunId) await reachApi.kill(activeRunId);
};
cmdInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('#btn-run').click();
});

$('#btn-open').onclick = async () => {
  const dir = await reachApi.pickDir();
  if (dir) await rememberProject(dir);
};

$('#btn-new').onclick = () => {
  $('#new-name').value = '';
  $('#new-parent').value = '';
  modal.classList.remove('hidden');
  $('#new-name').focus();
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
  modal.classList.add('hidden');
  const res = await reachApi.createProject(name, parent);
  if (!res.ok) {
    showNotice(`Could not create project: ${res.err}`);
    return;
  }
  await rememberProject(res.dir);
  activeRunId = res.runId;
  logLine('sys', `$ reach init`);
  $('#btn-run').disabled = true;
  $('#btn-stop').classList.remove('hidden');
};

// ---------- conversations (project-scoped, branching) ----------
let agentProjectDir = null;   // project the sidebar tree is scoped to
let agentTreeRevision = 0;

async function loadAgentProjectSelect() {
  const revision = projectSelectionRevision;
  // Options = remembered projects ∪ dirs that already have chats.
  const projects = await reachApi.getProjects();
  agents = await reachApi.agents.list();
  if (revision !== projectSelectionRevision) return;
  const dirs = new Set(projects.map(p => p.dir));
  if (currentProject) dirs.add(currentProject.dir);
  for (const a of agents) if (a.dir) dirs.add(a.dir);
  const select = $('#agent-project-select');
  const prev = agentProjectDir;
  select.innerHTML = '';
  const sorted = [...dirs].sort();
  for (const d of sorted) {
    const opt = document.createElement('option');
    opt.value = d;
    const p = projects.find(p => p.dir === d);
    opt.textContent = p ? p.name : d.split(/[\\/]/).pop();
    opt.title = d;
    select.appendChild(opt);
  }
  if (prev && dirs.has(prev)) { select.value = prev; agentProjectDir = prev; }
  else if (sorted.length) { agentProjectDir = sorted[0]; select.value = agentProjectDir; }
  else { agentProjectDir = null; }
}

$('#agent-project-select').onchange = async (e) => {
  const option = e.target.selectedOptions[0];
  if (option) await selectProject({ name: option.textContent, dir: option.value });
};

async function loadAgentTree() {
  const revision = ++agentTreeRevision;
  const treeEl = $('#agent-tree');
  treeEl.innerHTML = '';
  if (!agentProjectDir) {
    treeEl.innerHTML = '<div class="dim tree-empty">No project selected. Add one on the Projects page or pick a folder.</div>';
    return;
  }
  const dir = agentProjectDir;
  const res = await reachApi.agents.tree(dir);
  if (dir !== agentProjectDir || revision !== agentTreeRevision) return;
  if (!res.ok || !res.tree.length) {
    treeEl.innerHTML = '<div class="dim tree-empty">No conversations yet — start one below.</div>';
    return;
  }
  const renderNode = (node) => {
    const row = document.createElement('div');
    row.className = 'tree-node';
    row.style.paddingLeft = (6 + node.depth * 16) + 'px';
    const label = document.createElement('div');
    label.className = 'tree-label';
    const dot = document.createElement('span');
    dot.className = 'tree-dot ' + (node.status === 'running' ? 'run' : node.messageCount ? 'ok' : 'idle');
    label.appendChild(dot);
    const name = document.createElement('span');
    name.className = 'tree-name';
    name.textContent = node.depth > 0 ? '⑂ ' + node.name : node.name;
    name.title = `${node.messageCount} msgs · ${node.status}` + (node.forkIndex !== null ? ` · branched at message ${node.forkIndex}` : '');
    label.appendChild(name);
    const del = document.createElement('button');
    del.className = 'tree-delete';
    del.title = `Delete "${node.name}"`;
    del.setAttribute('aria-label', `Delete conversation "${node.name}"`);
    del.textContent = 'x';
    del.onclick = async (e) => {
      e.stopPropagation();
      await deleteAgentById(node.id, node.name);
    };
    label.appendChild(del);
    row.appendChild(label);
    row.onclick = () => selectAgent(node);
    if (currentAgent && currentAgent.id === node.id) row.classList.add('active');
    treeEl.appendChild(row);
    for (const child of node.children || []) renderNode(child);
  };
  for (const root of res.tree) renderNode(root);
}

async function selectAgent(a) {
  if ([...openFiles.values()].some(f => f.dirty) && !await confirmAction('There are unsaved editor changes. Discard them and switch conversation?')) return;
  const revision = ++projectSelectionRevision;
  const selected = await reachApi.agents.get(a.id);
  if (!selected || revision !== projectSelectionRevision) return;
  streamBubble = null;
  recoveryBubble = null;
  resetEditors();

  if (selected.dir && !await selectProject({
    name: [...$('#agent-project-select').options].find(o => o.value === selected.dir)?.textContent || selected.dir.split(/[\\/]/).pop(),
    dir: selected.dir,
  })) return;
  currentAgent = selected;
  window.ReachActivity.select(currentAgent);
  agentNameEl.textContent = agentNameEl.title = currentAgent.name;
  const lineage = currentAgent.parentChatId ? ' · ⑂ branch' : '';
  agentMetaEl.textContent = `${currentAgent.dir} · ${currentAgent.model || 'default model'}${lineage}`;
  agentMetaEl.title = agentMetaEl.textContent;
  noAgent.classList.add('hidden');
  agentView.classList.remove('hidden');
  agentRunning = currentAgent.runState && currentAgent.runState.status === 'running';
  updateStatusPill();
  renderChatHistory();
  refreshContextStatus();
  renderTodos();
  renderPendingEdits();
  window.ReachWorkspace?.sync();
  await refreshFileTree();
  await loadAgentTree();
}

/* Fork the current chat's history up to (and including) message index i.
 * The new branch opens immediately; the sidebar tree shows the stem. */
async function branchFromMessage(msgIndex) {
  if (!currentAgent) return;
  const res = await reachApi.agents.fork(currentAgent.id, msgIndex, null);
  if (!res.ok) { showNotice('Could not branch: ' + res.err); return; }
  await selectAgent(res.agent);
}

$('#btn-branch-chat').onclick = () => {
  if (!currentAgent) { showNotice('Select a conversation first.'); return; }
  branchFromMessage(-1); // fork the full history
};

function updateStatusPill(status, reason) {
  const pill = $('#agent-status');
  if (!currentAgent) return;
  const s = status || (agentRunning ? 'running' : (currentAgent.runState?.status || 'idle'));
  currentAgent.runState = { ...currentAgent.runState, status: s };
  pill.textContent = s;
  pill.className = 'chip ' + (s === 'running' ? 'pending' : s === 'completed' ? 'ok' : s === 'paused' || s === 'waiting_input' ? 'bad' : 'dim');
  $('#btn-agent-stop').classList.toggle('hidden', s !== 'running');
  $('#btn-agent-continue').classList.toggle('hidden', !['stopped', 'paused', 'waiting_edits'].includes(s));
  $('#btn-agent-continue').textContent = s === 'stopped' ? 'Start' : 'Continue';
  $('#btn-agent-compact').disabled = s === 'running';
  updateSendControl();
  if (reason) pill.title = reason;
}

function renderContextStatus(context) {
  if (!context) return;
  const last = context.lastCompression;
  const total = document.createElement('span');
  total.textContent = `Context ≈ ${context.estimatedTokens.toLocaleString()} tokens`;
  const extra = document.createElement('span');
  extra.className = 'context-extra';
  extra.textContent = ` · Auto ${context.automatic ? 'on' : 'off'}`
    + (last ? ` · Last compression ${Math.round((1 - last.after / last.before) * 100)}% smaller` : '');
  $('#agent-context').replaceChildren(total, extra);
  $('#agent-context').title = total.textContent + extra.textContent + '\nEstimated at three characters per token; provider counts vary.';
}
async function refreshContextStatus() {
  const id = currentAgent?.id;
  if (!id) return;
  const context = await reachApi.agents.context(id);
  if (currentAgent?.id === id) renderContextStatus(context);
}
$('#btn-agent-compact').onclick = async () => {
  if (!currentAgent || agentRunning) return;
  const id = currentAgent.id;
  $('#btn-agent-compact').disabled = true;
  const result = await reachApi.agents.compact(id);
  if (currentAgent?.id === id) {
    $('#btn-agent-compact').disabled = agentRunning;
    if (result.ok) renderContextStatus(result.context);
    else showNotice(result.err);
  }
};

$('#btn-agent-continue').onclick = async () => {
  if (!currentAgent || agentRunning) return;
  agentRunning = true;
  updateStatusPill('running');
  const res = await reachApi.agents.send(currentAgent.id, 'continue');
  if (!res.ok) { agentRunning = false; updateStatusPill('paused', res.err); showNotice(res.err); }
};

// ---------- chat rendering ----------
function timeStamp() {
  const d = new Date();
  return d.toTimeString().slice(0, 8);
}

function appendChatMessage(role, text, msgIndex = null) {
  const div = document.createElement('div');
  div.className = 'chat-msg ' + role;
  if (role === 'assistant') {
    div.innerHTML = md.render(text);
  } else {
    div.textContent = text;
  }
  const ts = document.createElement('span');
  ts.className = 'msg-ts';
  ts.textContent = timeStamp();
  div.appendChild(ts);
  // Fork anchor: branch the conversation from this point (user messages only).
  if (role === 'user' && msgIndex !== null) {
    const fork = document.createElement('button');
    fork.className = 'msg-fork';
    fork.textContent = '⑂';
    fork.title = 'Branch a new conversation from this point';
    fork.onclick = (e) => { e.stopPropagation(); branchFromMessage(msgIndex); };
    div.appendChild(fork);
  }
  chatLog.appendChild(div);
  chatScroll.scrollTop = chatScroll.scrollHeight;
  return div;
}

function appendQuestion(question) {
  if (!question) return;
  const card = document.createElement('div');
  card.className = 'chat-msg system';
  const label = document.createElement('p');
  label.textContent = question.question;
  card.appendChild(label);
  for (const option of question.options || []) {
    const button = document.createElement('button');
    button.className = 'ghost small';
    button.textContent = option;
    button.onclick = () => { composerInput.value = option; composerInput.dispatchEvent(new Event('input')); composerInput.focus(); };
    card.appendChild(button);
  }
  chatLog.appendChild(card);
}

function appendToolCard(tool, ok, pending, error, result) {
  const card = document.createElement('div');
  card.className = 'tool-card ' + (ok ? (pending ? 'pending' : 'ok') : 'err');
  const head = document.createElement('button');
  head.className = 'tool-head';
  head.innerHTML = `<span class="tool-icon">${ok ? (pending ? '◔' : '✓') : '✗'}</span> ${escapeHtml(tool)}${pending ? ' (awaiting review)' : ''}${error ? ' — ' + escapeHtml(error) : ''}`;
  card.appendChild(head);
  const body = document.createElement('div');
  body.className = 'tool-body hidden';
  body.textContent = result ? JSON.stringify(result, null, 2).slice(0, 4000) : '';
  card.appendChild(body);
  head.onclick = () => body.classList.toggle('hidden');
  chatLog.appendChild(card);
  chatScroll.scrollTop = chatScroll.scrollHeight;
}

function appendEditCard(edit) {
  const card = document.createElement('div');
  card.className = 'edit-card';
  card.dataset.editId = edit.editId;
  const head = document.createElement('div');
  head.className = 'edit-head';
  head.innerHTML = `<strong>${edit.isNew ? 'New file' : 'Edit'}</strong> ${escapeHtml(edit.path)} <span class="diff-stat add">+${edit.stats.added}</span> <span class="diff-stat del">−${edit.stats.removed}</span>`;
  card.appendChild(head);
  const body = document.createElement('div');
  body.className = 'diff-body';
  for (const h of edit.hunks) {
    const line = document.createElement('div');
    if (h.type === 'gap') {
      line.className = 'diff-line gap';
      line.textContent = `··· ${h.text} unchanged lines ···`;
    } else {
      line.className = 'diff-line ' + h.type;
      line.textContent = (h.type === 'add' ? '+ ' : h.type === 'del' ? '− ' : '  ') + h.text;
    }
    body.appendChild(line);
  }
  card.appendChild(body);
  const actions = document.createElement('div');
  actions.className = 'edit-actions';
  const acceptBtn = document.createElement('button');
  acceptBtn.className = 'gold small';
  acceptBtn.textContent = 'Accept';
  const rejectBtn = document.createElement('button');
  rejectBtn.className = 'ghost small';
  rejectBtn.textContent = 'Reject';
  actions.appendChild(acceptBtn);
  actions.appendChild(rejectBtn);
  card.appendChild(actions);
  acceptBtn.onclick = () => resolveEditCard(card, edit.editId, true);
  rejectBtn.onclick = () => resolveEditCard(card, edit.editId, false);
  chatLog.appendChild(card);
  chatScroll.scrollTop = chatScroll.scrollHeight;
}

async function resolveEditCard(card, editId, accepted) {
  if (!currentAgent) return;
  const res = await reachApi.agents.resolveEdit(currentAgent.id, editId, accepted);
  const actions = card.querySelector('.edit-actions');
  if (actions) actions.remove();
  const verdict = document.createElement('div');
  verdict.className = 'edit-verdict ' + (res.ok && res.accepted ? 'accepted' : 'rejected');
  verdict.textContent = res.ok ? (res.accepted ? 'Accepted — written to disk.' : 'Rejected.') : ('Error: ' + res.err);
  card.appendChild(verdict);
  card.classList.add(res.ok && res.accepted ? 'accepted' : 'rejected');
  if (res.ok && res.accepted) {
    // Refresh the tree + any open editor showing that file.
    await refreshFileTree();
  }
}

function renderChatHistory() {
  chatLog.innerHTML = '';
  if (!currentAgent || !currentAgent.messages) return;
  currentAgent.messages.forEach((m, idx) => {
    if (m.role === 'system' || m.role === 'developer') return;
    if (['recovery', 'recovery-attempt', 'tool-summary'].includes(m._reachMeta?.source)) return;
    if (m.role === 'tool') {
      appendToolCard(m.name || 'tool', !String(m.content).includes('→ error'), false,
        String(m.content).includes('→ error') ? 'error' : null, m.content);
    } else {
      const text = m._reachMeta?.display ?? m.content;
      if (text) appendChatMessage(m.role, text, m.role === 'user' ? idx : null);
      if (m._reachMeta?.question) appendQuestion(m._reachMeta.question);
    }
  });
  // A branch shows where it stems from.
  if (currentAgent.parentChatId && currentAgent.forkIndex !== null) {
    const note = document.createElement('div');
    note.className = 'chat-msg system';
    note.textContent = `⑂ branched from "${currentAgent.name.replace(/ \(branch \d+\)$/, '')}" at message ${currentAgent.forkIndex}`;
    chatLog.insertBefore(note, chatLog.firstChild);
  }
  if (activeTeamRun?.agentId === currentAgent.id) {
    chatLog.append(activeTeamRun.banner, activeTeamRun.wrap);
  }
}

function renderPendingEdits() {
  if (!currentAgent || !currentAgent.pendingEdits) return;
  for (const edit of Object.values(currentAgent.pendingEdits)) {
    appendEditCard(edit);
  }
}

function renderTodos() {
  if (!currentAgent || !currentAgent.todos || !currentAgent.todos.length) {
    todosPanel.classList.add('hidden');
    return;
  }
  todosPanel.classList.remove('hidden');
  todoList.innerHTML = '';
  for (const t of currentAgent.todos) {
    const li = document.createElement('li');
    li.textContent = t.text;
    li.className = 'todo-' + t.status;
    todoList.appendChild(li);
  }
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ---------- chat CRUD ----------
$('#btn-new-chat').onclick = async () => {
  if (!agentProjectDir) {
    // No project yet: let the user pick a folder to stem the chat from.
    const dir = await reachApi.pickDir();
    if (!dir) return;
    agentProjectDir = dir;
    const select = $('#agent-project-select');
    if (![...select.options].some(o => o.value === dir)) {
      const opt = document.createElement('option');
      opt.value = dir;
      opt.textContent = dir.split(/[\\/]/).pop();
      select.appendChild(opt);
    }
    select.value = dir;
  }
  const res = await reachApi.agents.create('Chat', agentProjectDir, '');
  if (!res.ok) { showNotice(`Could not create chat: ${res.err}`); return; }
  await selectAgent(res.agent);
  composerInput.focus();
};

$('#btn-send').onclick = sendComposer;
composerInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); sendComposer(); }
});

async function sendComposer() {
  if (agentRunning || runningAgentIds.size || (activeTeamRun && !activeTeamRun.paused)) {
    return stopAllRuns();
  }
  const text = composerInput.value.trim();
  if (!text || !currentAgent) return;
  composerInput.value = '';
  composerInput.dispatchEvent(new Event('input'));
  appendChatMessage('user', text);
  agentRunning = true;
  updateStatusPill('running');
  const res = await reachApi.agents.send(currentAgent.id, text);
  if (!res.ok) { agentRunning = false; updateStatusPill('paused', res.err); appendChatMessage('system', `Error: ${res.err}`); }
  loadAgentTree(); // auto-title + message count may have changed
}

$('#btn-agent-stop').onclick = async () => {
  if (currentAgent) await reachApi.agents.stop(currentAgent.id);
};

function updateSendControl() {
  const busy = agentRunning || runningAgentIds.size > 0 || !!(activeTeamRun && !activeTeamRun.paused);
  const button = $('#btn-send');
  button.textContent = stoppingAll ? 'Stopping…' : busy ? 'Stop' : 'Send';
  button.title = busy ? 'Stop all active agents and the team' : 'Send message';
  button.classList.toggle('danger', busy);
  button.disabled = stoppingAll;
  window.ReachWorkspace?.syncControls();
}

async function stopAllRuns() {
  if (stoppingAll) return;
  stoppingAll = true;
  updateSendControl();
  try {
    const res = await reachApi.teams.stopAll();
    if (!res.ok) showNotice(res.err);
  } catch (error) { showNotice(error.message); }
  finally { stoppingAll = false; updateSendControl(); }
}

async function deleteAgentById(id, name) {
  if (!await confirmAction(`Delete conversation "${name}" and its branches? This cannot be undone.`)) return;
  // Delete the whole subtree: children reference this chat as parent.
  const all = await reachApi.agents.list();
  const doomed = new Set([id]);
  for (let grew = true; grew;) {
    grew = false;
    for (const a of all) {
      if (a.parentChatId && doomed.has(a.parentChatId) && !doomed.has(a.id)) { doomed.add(a.id); grew = true; }
    }
  }
  for (const doomedId of doomed) await reachApi.agents.delete(doomedId);
  if (currentAgent && doomed.has(currentAgent.id)) {
    currentAgent = null;
    agentView.classList.add('hidden');
    noAgent.classList.remove('hidden');
  }
  await loadAgentTree();
}

$('#btn-agent-delete').onclick = async () => {
  if (!currentAgent) return;
  await deleteAgentById(currentAgent.id, currentAgent.name);
};

// ---------- agent events ----------
let streamBubble = null;
let recoveryBubble = null;
function handleAgentEvent(ev) {
  window.ReachActivity.ingest(ev);
  if (ev.type === 'run-state') {
    if (ev.status === 'running') runningAgentIds.add(ev.agentId);
    else runningAgentIds.delete(ev.agentId);
    updateSendControl();
  }
  if (!currentAgent || ev.agentId !== currentAgent.id) return;
  switch (ev.type) {
    case 'message-start':
      if (ev.role === 'assistant') {
        streamBubble = recoveryBubble?.isConnected ? recoveryBubble : document.createElement('div');
        recoveryBubble = null;
        streamBubble.innerHTML = '';
        streamBubble.dataset.raw = '';
        streamBubble.className = 'chat-msg assistant streaming';
        chatLog.appendChild(streamBubble);
        chatScroll.scrollTop = chatScroll.scrollHeight;
      }
      break;
    case 'delta':
      if (streamBubble) {
        streamBubble.innerHTML = md.render((streamBubble.dataset.raw = (streamBubble.dataset.raw || '') + ev.text));
        chatScroll.scrollTop = chatScroll.scrollHeight;
      }
      break;
    case 'message-end':
      if (streamBubble) {
        streamBubble.innerHTML = md.render(ev.content || '');
        if (!ev.content) streamBubble.classList.add('hidden');
        streamBubble.classList.remove('streaming');
        const ts = document.createElement('span');
        ts.className = 'msg-ts';
        ts.textContent = timeStamp();
        streamBubble.appendChild(ts);
        recoveryBubble = ev.provisional ? streamBubble : null;
        streamBubble = null;
      }
      if (ev.question) appendQuestion(ev.question);
      break;
    case 'message':
      if (ev.role === 'user') recoveryBubble = null;
      // Only render non-streamed messages (user messages we already render locally).
      if (ev.role === 'system') appendChatMessage('system', ev.content);
      break;
    case 'queued':
      queuedIndicator.textContent = `Queued (${ev.depth}): ${ev.text.slice(0, 80)}`;
      queuedIndicator.classList.remove('hidden');
      break;
    case 'tool-call':
      appendChatMessage('system', `→ ${ev.tool}(${JSON.stringify(ev.arguments)})`);
      break;
    case 'tool-result':
      appendToolCard(ev.tool, ev.ok, ev.pending, ev.error, ev.result);
      break;
    case 'run-state':
      if (ev.status !== 'running') recoveryBubble = null;
      agentRunning = ev.status === 'running';
      updateStatusPill(ev.status, ev.reason);
      if (ev.status !== 'running') refreshContextStatus();
      if (ev.status !== 'running') queuedIndicator.classList.add('hidden');
      if (ev.status === 'stopped' || ev.status === 'paused') {
        appendChatMessage('system', `Run ${ev.status}: ${ev.reason || ''}`);
      }
      loadAgentTree(); // status dots + message counts in the branch tree
      break;
    case 'renamed':
      // Auto-title from the first user message.
      if (currentAgent) { currentAgent.name = ev.name; agentNameEl.textContent = agentNameEl.title = ev.name; }
      loadAgentTree();
      break;
    case 'error':
      appendChatMessage('system', `Error: ${ev.message}`);
      agentRunning = false;
      updateStatusPill('error');
      loadAgentTree();
      break;
    case 'context-status':
      renderContextStatus(ev);
      break;
    case 'compaction-start':
      $('#agent-context').textContent = `Compressing context · segment ${ev.segment} of ${ev.total}…`;
      break;
    case 'compacted':
      appendChatMessage('system', `Context compacted (${ev.before} → ${ev.after} chars)`);
      break;
    case 'retry':
      appendChatMessage('system', `Retrying… ${ev.error}`);
      break;
  }
}
reachApi.agents.onEvent(handleAgentEvent);

reachApi.agents.onApprovalRequest(({ requestId, tool, arguments: args, help }) => {
  $('#approval-detail').textContent = `Agent wants to run ${tool}\n\n${help}\n\nArguments:\n${JSON.stringify(args, null, 2)}`;
  approvalModal.classList.remove('hidden');
  $('#btn-approval-yes').onclick = () => {
    reachApi.agents.respondApproval(requestId, true);
    approvalModal.classList.add('hidden');
  };
  $('#btn-approval-no').onclick = () => {
    reachApi.agents.respondApproval(requestId, false);
    approvalModal.classList.add('hidden');
  };
});

reachApi.agents.onEditPending(({ agentId, edit }) => {
  if (!currentAgent || agentId !== currentAgent.id) return;
  appendEditCard(edit);
});

// ---------- file drawer (right side, toggleable, follows context) ----------
const drawer = $('#file-drawer');
const drawerContext = $('#drawer-context');
let drawerOpen = true;

// Files, Projects, and the conversation sidebar share one selected project.
function drawerDir() {
  return currentProject?.dir || null;
}
function drawerAgentId() {
  return ($('#page-agents').classList.contains('active') && currentAgent) ? currentAgent.id : null;
}

function setDrawer(open) {
  drawerOpen = !!open;
  drawer.classList.toggle('closed', !drawerOpen);
  $('#btn-toggle-files').classList.toggle('active', drawerOpen);
  if (drawerOpen) refreshFileTree();
}
// The Files/Browser dropdown is wired by browser.js; Close still hides the drawer.
$('#btn-close-drawer').onclick = () => setDrawer(false);

// Narrow windows: the fixed 420px drawer would squeeze the chat to nothing.
// Auto-close below 1100px (once per crossing, so a manual reopen sticks
// until the window is resized across the threshold again).
let wasNarrow = false;
function applyWidthGuard() {
  const narrow = window.innerWidth < 1100;
  if (narrow && !wasNarrow && drawerOpen) setDrawer(false);
  wasNarrow = narrow;
}
window.addEventListener('resize', applyWidthGuard);
applyWidthGuard();

// ---------- Drawer size adjustment (horizontal + vertical split) ----------
function initDrawerResizers() {
  const resizerX = $('#drawer-resizer-x');
  const resizerY = $('#drawer-resizer-y');
  const fileTree = $('#file-tree');
  if (!resizerX || !resizerY || !drawer) return;

  const savedWidth = localStorage.getItem('reach:drawer-width');
  if (savedWidth) {
    const w = parseInt(savedWidth, 10);
    if (!isNaN(w) && w >= 260 && w <= window.innerWidth - 260) {
      drawer.style.width = w + 'px';
    }
  }

  const savedTreeHeight = localStorage.getItem('reach:drawer-tree-height');
  if (savedTreeHeight && fileTree) {
    const h = parseInt(savedTreeHeight, 10);
    if (!isNaN(h) && h >= 50 && h <= 800) {
      fileTree.style.height = h + 'px';
    }
  }

  // --- Horizontal Resize (drawer width) ---
  let isDraggingX = false;
  let startX = 0;
  let startWidth = 0;

  const onPointerMoveX = (e) => {
    if (!isDraggingX) return;
    const delta = startX - e.clientX;
    const minW = 260;
    const maxW = Math.max(minW, window.innerWidth - 260);
    const newW = Math.min(maxW, Math.max(minW, Math.round(startWidth + delta)));
    drawer.style.width = newW + 'px';
  };

  const onPointerUpX = (e) => {
    if (!isDraggingX) return;
    isDraggingX = false;
    document.body.classList.remove('resizing-x');
    resizerX.classList.remove('active');
    window.removeEventListener('pointermove', onPointerMoveX);
    window.removeEventListener('pointerup', onPointerUpX);
    window.removeEventListener('pointercancel', onPointerUpX);
    try { resizerX.releasePointerCapture(e.pointerId); } catch (_) {}
    const finalWidth = Math.round(drawer.getBoundingClientRect().width);
    localStorage.setItem('reach:drawer-width', finalWidth);
  };

  resizerX.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    isDraggingX = true;
    startX = e.clientX;
    startWidth = drawer.getBoundingClientRect().width;
    document.body.classList.add('resizing-x');
    resizerX.classList.add('active');
    try { resizerX.setPointerCapture(e.pointerId); } catch (_) {}
    window.addEventListener('pointermove', onPointerMoveX);
    window.addEventListener('pointerup', onPointerUpX);
    window.addEventListener('pointercancel', onPointerUpX);
  });

  resizerX.addEventListener('dblclick', () => {
    drawer.style.width = '420px';
    localStorage.removeItem('reach:drawer-width');
  });

  // --- Vertical Resize (split between file tree and editor) ---
  let isDraggingY = false;
  let startY = 0;
  let startTreeH = 0;

  const onPointerMoveY = (e) => {
    if (!isDraggingY) return;
    const delta = e.clientY - startY;
    const drawerH = drawer.getBoundingClientRect().height;
    const minH = 50;
    const maxH = Math.max(minH, drawerH - 220);
    const newH = Math.min(maxH, Math.max(minH, Math.round(startTreeH + delta)));
    fileTree.style.height = newH + 'px';
  };

  const onPointerUpY = (e) => {
    if (!isDraggingY) return;
    isDraggingY = false;
    document.body.classList.remove('resizing-y');
    resizerY.classList.remove('active');
    window.removeEventListener('pointermove', onPointerMoveY);
    window.removeEventListener('pointerup', onPointerUpY);
    window.removeEventListener('pointercancel', onPointerUpY);
    try { resizerY.releasePointerCapture(e.pointerId); } catch (_) {}
    const finalH = Math.round(fileTree.getBoundingClientRect().height);
    localStorage.setItem('reach:drawer-tree-height', finalH);
  };

  resizerY.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    isDraggingY = true;
    startY = e.clientY;
    startTreeH = fileTree.getBoundingClientRect().height;
    document.body.classList.add('resizing-y');
    resizerY.classList.add('active');
    try { resizerY.setPointerCapture(e.pointerId); } catch (_) {}
    window.addEventListener('pointermove', onPointerMoveY);
    window.addEventListener('pointerup', onPointerUpY);
    window.addEventListener('pointercancel', onPointerUpY);
  });

  resizerY.addEventListener('dblclick', () => {
    fileTree.style.height = '180px';
    localStorage.removeItem('reach:drawer-tree-height');
  });
}
initDrawerResizers();

let fileTreeGeneration = 0;
let fileTreeRoot = null;
const expandedFolders = new Set();

async function refreshFileTree() {
  const dir = drawerDir();
  const agentId = drawerAgentId();
  const generation = ++fileTreeGeneration;
  if (fileTreeRoot !== dir) {
    resetEditors();
    expandedFolders.clear();
    fileTreeRoot = dir;
  }
  fileTreeEl.innerHTML = '';
  if (!dir) {
    drawerContext.textContent = 'no project bound';
    return;
  }
  drawerContext.textContent = dir;
  async function loadFolder(host, directory = '', offset = 0) {
    const status = document.createElement('div');
    status.className = 'tree-empty dim';
    status.textContent = 'Loading…';
    host.appendChild(status);
    let res;
    try { res = await reachApi.files.tree(agentId, dir, directory, offset); }
    catch (error) { res = { ok: false, err: error.message }; }
    if (generation !== fileTreeGeneration) return false;
    status.remove();
    if (!res.ok) {
      const retry = document.createElement('button');
      retry.className = 'tree-entry file';
      retry.textContent = 'Could not list folder: ' + (res.err || 'unreadable') + ' — retry';
      retry.onclick = () => { retry.remove(); loadFolder(host, directory, offset); };
      host.appendChild(retry);
      return false;
    }
    for (const entry of res.tree) {
      const row = document.createElement('button');
      row.className = 'tree-entry ' + entry.type;
      row.style.paddingLeft = (8 + entry.depth * 14) + 'px';
      row.dataset.path = entry.path;
      row.title = entry.path;
      const name = entry.path.split('/').pop();
      if (entry.type === 'file') {
        row.textContent = name;
        row.onclick = () => openFile(entry.path);
        host.appendChild(row);
        continue;
      }
      const children = document.createElement('div');
      children.setAttribute('role', 'group');
      let open = expandedFolders.has(entry.path), loaded = false, loading = false;
      const update = () => {
        row.textContent = (open ? '▾ ' : '▸ ') + name;
        row.setAttribute('aria-expanded', String(open));
        children.hidden = !open;
      };
      const expand = async () => {
        if (loaded || loading) return;
        loading = true;
        loaded = await loadFolder(children, entry.path);
        loading = false;
      };
      row.onclick = () => {
        open = !open;
        if (open) expandedFolders.add(entry.path); else expandedFolders.delete(entry.path);
        update();
        if (open) expand();
      };
      update();
      host.append(row, children);
      if (open) expand();
    }
    if (!res.tree.length && !offset) {
      const empty = document.createElement('div');
      empty.className = 'tree-empty dim'; empty.textContent = 'Folder is empty'; host.appendChild(empty);
    }
    if (res.nextOffset !== null && res.nextOffset !== undefined) {
      const more = document.createElement('button');
      more.className = 'tree-entry file tree-more';
      more.textContent = `Show more (${res.total - res.nextOffset} remaining)`;
      more.onclick = () => { more.remove(); loadFolder(host, directory, res.nextOffset); };
      host.appendChild(more);
    }
    return true;
  }
  await loadFolder(fileTreeEl);
}

$('#btn-refresh-tree').onclick = refreshFileTree;

async function openFile(relPath) {
  const dir = drawerDir();
  const generation = fileTreeGeneration;
  if (!dir) return;
  if (openFiles.has(relPath)) {
    if (openFiles.get(relPath).dir === dir) { activateFile(relPath); return; }
    await closeFile(relPath);
    if (openFiles.has(relPath)) return; // Unsaved file from another project was kept.
  }
  const res = await reachApi.files.read(drawerAgentId(), relPath, dir);
  if (dir !== drawerDir() || generation !== fileTreeGeneration) return;
  if (openFiles.get(relPath)?.dir === dir) { activateFile(relPath); return; }
  if (!res.ok) { editorStatus.textContent = `Could not open ${relPath}: ${res.err}`; editorStatus.title = editorStatus.textContent; return; }

  const tab = document.createElement('div');
  tab.className = 'editor-tab';
  tab.innerHTML = `<span class="tab-name">${escapeHtml(relPath.split('/').pop())}</span><button class="tab-close" title="Close">×</button>`;
  tab.onclick = (e) => { if (!e.target.classList.contains('tab-close')) activateFile(relPath); };
  tab.querySelector('.tab-close').onclick = () => closeFile(relPath);
  editorTabsEl.appendChild(tab);

  const host = document.createElement('div');
  host.className = 'editor-instance hidden';
  editorHost.appendChild(host);

  const entry = {
    el: tab,
    host,
    dir,
    savedText: res.content,
    dirty: false,
    editor: null,
  };
  entry.editor = window.ReachEditor.create(host, {
    doc: res.content,
    filename: relPath,
    onChange: (text) => {
      entry.dirty = text !== entry.savedText;
      tab.classList.toggle('dirty', entry.dirty);
      $('#btn-save-file').classList.toggle('hidden', !entry.dirty);
      editorStatus.textContent = entry.dirty ? 'modified' : relPath;
    },
  });
  openFiles.set(relPath, entry);
  activateFile(relPath);
}

function activateFile(relPath) {
  activeFile = relPath;
  for (const [p, f] of openFiles) {
    f.el.classList.toggle('active', p === relPath);
    f.host.classList.toggle('hidden', p !== relPath);
  }
  editorEmpty.classList.toggle('hidden', openFiles.size > 0);
  const f = openFiles.get(relPath);
  if (f) {
    editorStatus.textContent = f.dirty ? 'modified' : relPath;
    $('#btn-save-file').classList.toggle('hidden', !f.dirty);
  }
}

async function closeFile(relPath) {
  const f = openFiles.get(relPath);
  if (!f) return;
  if (f.dirty && !await confirmAction(`${relPath} has unsaved changes. Close anyway?`)) return;
  f.editor.destroy();
  f.el.remove();
  f.host.remove();
  openFiles.delete(relPath);
  if (activeFile === relPath) {
    activeFile = null;
    const next = openFiles.keys().next();
    if (!next.done) activateFile(next.value);
    else { editorEmpty.classList.remove('hidden'); editorStatus.textContent = ''; }
  }
}

async function saveActiveFile() {
  if (!activeFile) return;
  const f = openFiles.get(activeFile);
  if (!f) return;
  const text = f.editor.getText();
  const res = await reachApi.files.write(drawerAgentId(), activeFile, text, f.dir);
  if (!res.ok) { editorStatus.textContent = 'save failed: ' + res.err; return; }
  f.savedText = text;
  f.dirty = false;
  f.el.classList.remove('dirty');
  $('#btn-save-file').classList.add('hidden');
  editorStatus.textContent = activeFile + ' — saved';
}

$('#btn-save-file').onclick = saveActiveFile;
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 's' && drawerOpen) {
    e.preventDefault();
    saveActiveFile();
  }
});

// ---------- settings ----------
async function loadSettings() {
  const s = await reachApi.getSettings();
  $('#set-endpoint').value = s.endpoint || '';
  $('#set-accesskey').value = s.accessKey || '';
  $('#set-model').value = s.model || '';
  $('#set-reach-cli').value = s.reachCli || '';
}
$('#btn-save-settings').onclick = async () => {
  const s = {
    reachCli: $('#set-reach-cli').value.trim(),
    endpoint: $('#set-endpoint').value.trim(),
    accessKey: $('#set-accesskey').value.trim(),
    model: $('#set-model').value.trim(),
  };
  await reachApi.saveSettings(s);
  refreshStatus();
  $('#settings-status').textContent = 'Saved.';
  setTimeout(() => { $('#settings-status').textContent = ''; }, 2000);
};

// ---------- model picker ----------
let modelPickerTarget = null;
async function openModelPicker(inputEl) {
  modelPickerTarget = inputEl;
  const modal = $('#model-modal');
  const choices = $('#model-choices');
  const search = $('#model-search');
  search.value = '';
  choices.innerHTML = '<div class="dim" style="padding:12px">Loading models…</div>';
  modal.classList.remove('hidden');
  search.focus();
  const res = await reachApi.listModels();
  choices.innerHTML = '';
  if (!res.ok) {
    choices.innerHTML = `<div class="dim" style="padding:12px">Could not load models: ${escapeHtml(res.err)}</div>`;
    return;
  }
  const render = (filter) => {
    choices.innerHTML = '';
    const filtered = res.models.filter(m => !filter || m.toLowerCase().includes(filter.toLowerCase()));
    if (!filtered.length) {
      choices.innerHTML = '<div class="dim" style="padding:12px">No matches.</div>';
      return;
    }
    for (const id of filtered) {
      const btn = document.createElement('button');
      btn.className = 'model-choice';
      btn.textContent = id;
      btn.onclick = () => {
        if (modelPickerTarget) {
          modelPickerTarget.value = id;
          modelPickerTarget.dispatchEvent(new Event('change', { bubbles: true }));
        }
        modal.classList.add('hidden');
      };
      choices.appendChild(btn);
    }
  };
  render('');
  search.oninput = () => render(search.value.trim());
}
$('#btn-browse-models').onclick = () => openModelPicker($('#set-model'));
$('#btn-agent-set-browse').onclick = () => openModelPicker($('#agent-set-model'));
$('#btn-model-cancel').onclick = () => $('#model-modal').classList.add('hidden');

// ---------- Create page: custom agents (personas) + teams ----------
let personas = [];
let teams = [];
let editingPersonaId = null;
let editingTeamId = null;
let teamBuilderMembers = [];   // [{personaId, role}] while the modal is open
let activeTeamRun = null;      // { teamRunId, cards: Map(index -> {el, out}) }
let teamDispatching = false;
let pendingTeamEvents = [];

async function loadCreatePage() {
  personas = await reachApi.personas.list();
  teams = await reachApi.teams.list();
  renderPersonaList();
  renderTeamList();
}

function renderPersonaList() {
  const el = $('#persona-list');
  el.innerHTML = '';
  if (!personas.length) {
    el.innerHTML = '<div class="dim tree-empty">No custom agents yet — create one to give a crew member its own model and instructions.</div>';
    return;
  }
  for (const p of personas) {
    const card = document.createElement('div');
    card.className = 'persona-card';
    card.innerHTML = `<div class="persona-card-head"><strong>${escapeHtml(p.name)}</strong><span class="chip dim">${escapeHtml(p.model || 'default model')}</span></div>`
      + `<div class="persona-card-prompt">${escapeHtml((p.prompt || 'No custom instructions.').slice(0, 140))}${(p.prompt || '').length > 140 ? '…' : ''}</div>`;
    card.onclick = () => openPersonaModal(p);
    el.appendChild(card);
  }
}

function renderTeamList() {
  const el = $('#team-list');
  el.innerHTML = '';
  if (!teams.length) {
    el.innerHTML = '<div class="dim tree-empty">No teams yet. Build one from your custom agents, then dispatch it from any conversation.</div>';
    return;
  }
  for (const t of teams) {
    const card = document.createElement('div');
    card.className = 'team-card';
    const roster = (t.members || []).map(m => escapeHtml(m.personaName) + (m.role ? ` <span class="dim">(${escapeHtml(m.role)})</span>` : '')).join(t.mode === 'chain' ? ' → ' : ' · ');
    card.innerHTML = `<div class="persona-card-head"><strong>${escapeHtml(t.name)}</strong><span class="chip ${t.mode === 'chain' ? 'pending' : 'ok'}">${t.mode}</span></div>`
      + `<div class="persona-card-prompt">${roster || '<span class="dim">no members</span>'}</div>`
      + `<div class="team-card-actions"><button class="ghost small" data-act="run">Run…</button><button class="ghost small" data-act="edit">Edit</button></div>`;
    card.querySelector('[data-act="edit"]').onclick = (e) => { e.stopPropagation(); openTeamModal(t); };
    card.querySelector('[data-act="run"]').onclick = (e) => { e.stopPropagation(); openTeamRunModal(t); };
    card.onclick = () => openTeamModal(t);
    el.appendChild(card);
  }
}

// ----- persona modal -----
function openPersonaModal(p) {
  editingPersonaId = p ? p.id : null;
  $('#persona-modal-title').textContent = p ? 'Edit Custom Agent' : 'New Custom Agent';
  $('#persona-name').value = p ? p.name : '';
  $('#persona-model').value = p ? (p.model || '') : '';
  $('#persona-prompt').value = p ? (p.prompt || '') : '';
  $('#btn-persona-delete').classList.toggle('hidden', !p);
  $('#persona-modal').classList.remove('hidden');
  $('#persona-name').focus();
}
$('#btn-new-persona').onclick = () => openPersonaModal(null);
$('#btn-persona-cancel').onclick = () => $('#persona-modal').classList.add('hidden');
$('#btn-persona-browse').onclick = () => openModelPicker($('#persona-model'));
$('#btn-persona-save').onclick = async () => {
  const name = $('#persona-name').value.trim();
  if (!name) { $('#persona-name').focus(); return; }
  const patch = { name, model: $('#persona-model').value.trim(), prompt: $('#persona-prompt').value };
  const res = editingPersonaId
    ? await reachApi.personas.update(editingPersonaId, patch)
    : await reachApi.personas.create(patch);
  if (!res.ok) { showNotice(res.err); return; }
  $('#persona-modal').classList.add('hidden');
  await loadCreatePage();
};
$('#btn-persona-delete').onclick = async () => {
  if (!editingPersonaId) return;
  if (!await confirmAction('Delete this custom agent? Teams using it will lose the member.')) return;
  await reachApi.personas.delete(editingPersonaId);
  $('#persona-modal').classList.add('hidden');
  await loadCreatePage();
};

// ----- team modal -----
function openTeamModal(t) {
  editingTeamId = t ? t.id : null;
  $('#team-modal-title').textContent = t ? 'Edit Team' : 'New Team';
  $('#team-name').value = t ? t.name : '';
  $('#team-mode').value = t ? t.mode : 'parallel';
  teamBuilderMembers = t ? (t.members || []).map(m => ({ personaId: m.personaId, role: m.role || '' })) : [];
  $('#btn-team-delete').classList.toggle('hidden', !t);
  renderTeamBuilder();
  $('#team-modal').classList.remove('hidden');
  $('#team-name').focus();
}
function renderTeamBuilder() {
  const el = $('#team-members');
  el.innerHTML = '';
  teamBuilderMembers.forEach((m, i) => {
    const p = personas.find(x => x.id === m.personaId);
    const row = document.createElement('div');
    row.className = 'team-member-row';
    row.innerHTML = `<span class="member-idx">${i + 1}</span><strong>${escapeHtml(p ? p.name : '(deleted)')}</strong><span class="dim">${escapeHtml(m.role || '')}</span>`;
    const up = document.createElement('button');
    up.className = 'ghost tiny'; up.textContent = '↑'; up.title = 'Move earlier';
    up.onclick = () => { if (i > 0) { [teamBuilderMembers[i - 1], teamBuilderMembers[i]] = [teamBuilderMembers[i], teamBuilderMembers[i - 1]]; renderTeamBuilder(); } };
    const down = document.createElement('button');
    down.className = 'ghost tiny'; down.textContent = '↓'; down.title = 'Move later';
    down.onclick = () => { if (i < teamBuilderMembers.length - 1) { [teamBuilderMembers[i + 1], teamBuilderMembers[i]] = [teamBuilderMembers[i], teamBuilderMembers[i + 1]]; renderTeamBuilder(); } };
    const rm = document.createElement('button');
    rm.className = 'ghost tiny danger'; rm.textContent = '✕';
    rm.onclick = () => { teamBuilderMembers.splice(i, 1); renderTeamBuilder(); };
    row.appendChild(up); row.appendChild(down); row.appendChild(rm);
    el.appendChild(row);
  });
  // Refresh the picker options.
  const pick = $('#team-member-pick');
  pick.innerHTML = '';
  for (const p of personas) {
    const opt = document.createElement('option');
    opt.value = p.id;
    opt.textContent = p.name + (p.model ? ` [${p.model}]` : '');
    pick.appendChild(opt);
  }
  if (!personas.length) {
    const opt = document.createElement('option');
    opt.textContent = '(create a custom agent first)';
    opt.value = '';
    pick.appendChild(opt);
  }
}
$('#btn-new-team').onclick = () => openTeamModal(null);
$('#btn-team-cancel').onclick = () => $('#team-modal').classList.add('hidden');
$('#btn-team-add-member').onclick = () => {
  const personaId = $('#team-member-pick').value;
  if (!personaId) return;
  if (teamBuilderMembers.length >= 8) { showNotice('A team can have at most 8 members.'); return; }
  teamBuilderMembers.push({ personaId, role: $('#team-member-role').value.trim() });
  $('#team-member-role').value = '';
  renderTeamBuilder();
};
$('#btn-team-save').onclick = async () => {
  const name = $('#team-name').value.trim();
  if (!name) { $('#team-name').focus(); return; }
  if (!teamBuilderMembers.length) { showNotice('Add at least one member.'); return; }
  const patch = { name, mode: $('#team-mode').value, members: teamBuilderMembers };
  const res = editingTeamId
    ? await reachApi.teams.update(editingTeamId, patch)
    : await reachApi.teams.create(patch);
  if (!res.ok) { showNotice(res.err); return; }
  $('#team-modal').classList.add('hidden');
  await loadCreatePage();
};
$('#btn-team-delete').onclick = async () => {
  if (!editingTeamId) return;
  if (!await confirmAction('Delete this team?')) return;
  await reachApi.teams.delete(editingTeamId);
  $('#team-modal').classList.add('hidden');
  await loadCreatePage();
};

// ----- team run -----
let pendingRunTeam = null;
function openTeamRunModal(t) {
  pendingRunTeam = t;
  const roster = (t.members || []).map(m => m.personaName).join(t.mode === 'chain' ? ' → ' : ' · ');
  $('#team-run-info').textContent = `${t.name} (${t.mode}): ${roster}` + (currentAgent ? ` · project ${currentAgent.dir}` : '');
  $('#team-run-task').value = '';
  $('#team-run-modal').classList.remove('hidden');
  $('#team-run-task').focus();
}
$('#btn-team-run-cancel').onclick = () => $('#team-run-modal').classList.add('hidden');

/* Dispatch a team from inside a conversation: pick the crew first. */
$('#btn-dispatch-team').onclick = async () => {
  if (!currentAgent) { showNotice('Open a conversation first.'); return; }
  await loadCreatePage();
  if (!teams.length) {
    showNotice('No teams yet — create one on the Create page first.');
    showTab('create');
    return;
  }
  if (teams.length === 1) { openTeamRunModal(teams[0]); return; }
  const labels = teams.map((t, i) => `${i + 1}. ${t.name} (${t.mode}, ${t.members.length} members)`).join('\n');
  const pick = await window.ReachDialogs.prompt('Which team?\n\n' + labels + '\n\nEnter the number:');
  const idx = parseInt(pick, 10) - 1;
  if (Number.isInteger(idx) && idx >= 0 && idx < teams.length) openTeamRunModal(teams[idx]);
};

$('#btn-team-run-go').onclick = async () => {
  const task = $('#team-run-task').value.trim();
  if (!task || !pendingRunTeam) return;
  if ((activeTeamRun && !activeTeamRun.paused) || teamDispatching) { showNotice('Stop the current team run or wait for it to finish first.'); return; }
  teamDispatching = true;
  const team = pendingRunTeam;
  const agent = currentAgent;
  $('#team-run-modal').classList.add('hidden');
  // The run shows up as member cards in the CURRENT conversation (if any);
  // otherwise switch to Agents with no chat selected — cards render standalone.
  try {
    const res = await reachApi.teams.run(team.id, task, agent?.dir, agent?.id);
    if (!res.ok) { showNotice('Could not run team: ' + res.err); return; }
    showTab('agents');
    startTeamRunView(res.teamRunId, team, task, agent?.id);
    for (const event of pendingTeamEvents) handleTeamEvent(event);
  } catch (error) {
    showNotice('Could not run team: ' + error.message);
  } finally {
    teamDispatching = false;
    pendingTeamEvents = [];
  }
};

/* Team run view: a banner + one live card per member, rendered into the
 * chat log of the current conversation (or the no-agent area if none). */
function startTeamRunView(teamRunId, team, task, agentId = currentAgent?.id) {
  if (activeTeamRun) {
    activeTeamRun.stop.remove();
    for (const button of activeTeamRun.wrap.querySelectorAll('.member-control')) button.disabled = true;
  }
  const run = { teamRunId, team, agentId, cards: new Map(), subCards: new Map(), buffer: new Map() };
  activeTeamRun = run;
  const host = currentAgent ? chatLog : noAgent;
  if (!currentAgent) { noAgent.classList.remove('hidden'); agentView.classList.add('hidden'); }
  const banner = document.createElement('div');
  banner.className = 'chat-msg system';
  banner.textContent = `⚡ Team run: ${team.name} (${team.mode}) — ${task.slice(0, 120)}`;
  run.banner = banner;
  const stop = document.createElement('button');
  stop.id = 'btn-stop-team';
  stop.className = 'danger small';
  stop.textContent = 'Stop team';
  stop.title = `Stop ${team.name}`;
  stop.onclick = async () => {
    stop.disabled = true;
    try {
      const res = await reachApi.teams[run.paused ? 'start' : 'stop'](teamRunId);
      if (!res.ok) showNotice(res.err);
    } catch (error) { showNotice(error.message); }
    finally { stop.disabled = false; }
  };
  document.querySelector('header .statusbar').prepend(stop);
  run.stop = stop;
  host.appendChild(banner);
  const wrap = document.createElement('div');
  wrap.className = 'team-run';
  wrap.dataset.teamRunId = teamRunId;
  host.appendChild(wrap);
  activeTeamRun.wrap = wrap;
  updateSendControl();
  host.scrollTop = host.scrollHeight;
}

function teamCard(index, name, model) {
  if (!activeTeamRun) return null;
  let card = activeTeamRun.cards.get(index);
  if (card) return card;
  card = document.createElement('div');
  card.className = 'member-card';
  card.innerHTML = `<div class="member-head"><span class="member-dot"></span><strong>${escapeHtml(name)}</strong><span class="dim">${escapeHtml(model || '')}</span><span class="member-state dim">starting…</span></div>`
    + `<div class="member-body"></div>`;
  activeTeamRun.wrap.appendChild(card);
  activeTeamRun.cards.set(index, card);
  addMemberControl(card, activeTeamRun, { index });
  return card;
}

/* Card for a SPAWNED worker (agent.spawn) — the Grok-Bot-style subagent.
 * Keyed by net agentId, visually nested under the crew with a ⑂ badge. */
function subCard(agentId, name, model, depth) {
  if (!activeTeamRun) return null;
  const run = activeTeamRun;
  if (!run.subCards) run.subCards = new Map();
  let card = run.subCards.get(agentId);
  if (card) return card;
  card = document.createElement('div');
  card.className = 'member-card subagent depth-' + Math.min(Number(depth) || 1, 2);
  card.innerHTML = `<div class="member-head"><span class="member-dot"></span><span class="sub-badge">⑂</span><strong>${escapeHtml(name)}</strong><span class="dim">${escapeHtml(model || '')}</span><span class="member-state dim">spawned…</span></div>`
    + `<div class="member-body"></div>`;
  run.wrap.appendChild(card);
  run.subCards.set(agentId, card);
  addMemberControl(card, run, { agentId });
  return card;
}

function addMemberControl(card, run, { index = null, agentId = null }) {
  const button = document.createElement('button');
  button.className = 'ghost small member-control';
  button.textContent = 'Stop';
  button.title = 'Stop this agent';
  button.onclick = async () => {
    button.disabled = true;
    try {
      const res = await reachApi.teams.controlMember(run.teamRunId, index, agentId, card.dataset.paused === 'true');
      if (!res.ok) showNotice(res.err);
    } catch (error) { showNotice(error.message); }
    finally { button.disabled = card.dataset.finished === 'true'; }
  };
  card.querySelector('.member-head').appendChild(button);
}

function setMemberControl(card, paused, finished = false) {
  card.dataset.paused = String(paused);
  card.dataset.finished = String(finished);
  card.classList.toggle('paused', paused);
  const button = card.querySelector('.member-control');
  button.textContent = paused ? 'Start' : 'Stop';
  button.title = paused ? 'Resume this agent with its saved context' : 'Stop this agent';
  button.disabled = finished;
  if (paused) card.querySelector('.member-state').textContent = 'stopped · ready to start';
  else if (!finished) card.querySelector('.member-state').textContent = 'resuming…';
}

/* Inline question box shared by roster members and spawned workers: the run
 * stays paused until the user answers (or skips, failing that agent). */
function attachAskBox(card, questionId, name, question) {
  const ask = document.createElement('div');
  ask.className = 'member-ask';
  const q = document.createElement('div');
  q.className = 'member-ask-q';
  q.textContent = `${name} asks: ${question || 'needs input'}`;
  ask.dataset.qid = questionId;
  const input = document.createElement('textarea');
  input.rows = 2;
  input.placeholder = 'Type an answer for this agent…';
  const row = document.createElement('div');
  row.className = 'member-ask-actions';
  const send = document.createElement('button');
  send.className = 'gold small';
  send.textContent = 'Answer';
  const skip = document.createElement('button');
  skip.className = 'ghost small';
  skip.textContent = 'Skip (fail agent)';
  row.appendChild(send); row.appendChild(skip);
  ask.appendChild(q); ask.appendChild(input); ask.appendChild(row);
  card.querySelector('.member-body').appendChild(ask);
  const finish = (answer) => {
    ask.remove();
    card.classList.remove('waiting');
    card.querySelector('.member-state').textContent = answer ? 'resuming…' : 'skipped';
    reachApi.teams.answerQuestion(questionId, answer || '');
  };
  send.onclick = () => finish(input.value.trim());
  skip.onclick = () => finish('');
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); finish(input.value.trim()); }
  });
  input.focus();
  return ask;
}

function handleTeamEvent(ev) {
  if (teamDispatching && !activeTeamRun) { pendingTeamEvents.push(ev); return; }
  if (!activeTeamRun || ev.teamRunId !== activeTeamRun.teamRunId) return;
  const run = activeTeamRun;
  const activityCard = ev.type === 'subagent' ? subCard(ev.agentId, ev.name, ev.model || '', ev.depth) : ev.index !== undefined ? teamCard(ev.index, ev.name, ev.model) : null;
  window.ReachActivity.team(ev, activityCard);
  switch (ev.type) {
    case 'start':
      for (const member of ev.members) teamCard(member.index, member.name, member.model);
      break;
    case 'control':
      run.paused = ev.paused;
      run.stop.textContent = ev.paused ? 'Start team' : 'Stop team';
      run.stop.title = ev.paused ? 'Resume unfinished team agents' : 'Stop team';
      updateSendControl();
      break;
    case 'member-control': {
      const card = teamCard(ev.index, ev.name, ev.model);
      if (card) setMemberControl(card, ev.paused);
      break;
    }
    case 'member-start': {
      const card = teamCard(ev.index, ev.name, ev.model);
      if (card && card.dataset.paused !== 'true') card.querySelector('.member-state').textContent = 'working…';
      break;
    }
    case 'member': {
      // Forwarded AgentLoop events for one member.
      const card = teamCard(ev.index, ev.name, ev.model);
      if (!card) break;
      const body = card.querySelector('.member-body');
      const state = card.querySelector('.member-state');
      if (ev.memberType === 'round') {
        state.textContent = `Round ${ev.round} · waiting for model…`;
      } else if (ev.memberType === 'reasoning') {
        state.textContent = `Model is thinking… (${ev.chars} characters received)`;
      } else if (ev.memberType === 'retry') {
        state.textContent = 'Retrying: ' + ev.error;
      } else if (ev.memberType === 'recovery') {
        state.textContent = 'Requesting a usable action response…';
      } else if (ev.memberType === 'error') {
        state.textContent = ev.message;
      } else if (ev.memberType === 'run-state') {
        state.textContent = card.dataset.paused === 'true' ? 'stopped · ready to start' : ev.status + (ev.reason ? ': ' + ev.reason : '');
      } else if (ev.memberType === 'message-start') {
        clearTimeout(card._renderTimer);
        card._renderTimer = null;
        run.buffer.set(ev.index, '');
      } else if (ev.memberType === 'delta') {
        const buf = ((run.buffer.get(ev.index) || '') + (ev.text || '')).slice(-30000);
        run.buffer.set(ev.index, buf);
        state.textContent = 'Receiving answer…';
        // Preview text cheaply while streaming; parse markdown once at end.
        // Capture this run, never a mutable global cleared by the done event.
        if (!card._renderTimer) {
          card._renderTimer = setTimeout(() => {
            card._renderTimer = null;
            body.textContent = run.buffer.get(ev.index) || '';
            body.parentElement.scrollTop = body.parentElement.scrollHeight;
          }, 100);
        }
      } else if (ev.memberType === 'message-end') {
        clearTimeout(card._renderTimer);
        card._renderTimer = null;
        if (ev.content !== undefined || ev.question) {
          const content = ev.content || ev.question?.question || '';
          run.buffer.set(ev.index, content);
          body.innerHTML = md.render(content.slice(0, 30000));
        }
      } else if (ev.memberType === 'tool-call') {
        state.textContent = `Running ${ev.tool}…`;
        const line = document.createElement('div');
        line.className = 'member-tool dim';
        line.textContent = `→ ${ev.tool}`;
        body.appendChild(line);
      } else if (ev.memberType === 'tool-result') {
        state.textContent = ev.pending ? 'Waiting for edit review' : `${ev.tool} finished`;
        const line = document.createElement('div');
        line.className = 'member-tool ' + (ev.ok ? 'ok' : 'bad');
        line.textContent = `${ev.ok ? '✓' : '✗'} ${ev.tool}${ev.error ? ': ' + ev.error : ''}`;
        body.appendChild(line);
      }
      break;
    }
    case 'member-waiting': {
      // Member paused for edit review; the edit cards arrive separately via
      // onEditPending. Just reflect the pause on the card.
      const card = teamCard(ev.index, ev.name, ev.model || '');
      if (card) {
        card.classList.add('waiting');
        card.querySelector('.member-state').textContent =
          `waiting — ${ev.edits.length} edit${ev.edits.length === 1 ? '' : 's'} need review`;
      }
      break;
    }
    case 'member-question': {
      const card = teamCard(ev.index, ev.name, ev.model || '');
      if (!card) break;
      card.classList.add('waiting');
      card.querySelector('.member-state').textContent = 'waiting for your answer…';
      attachAskBox(card, ev.questionId, ev.name, ev.question);
      break;
    }
    case 'member-resumed': {
      const card = teamCard(ev.index, ev.name, ev.model || '');
      if (card) {
        card.classList.remove('waiting', 'failed');
        card.querySelector('.member-state').textContent = 'resumed · working…';
      }
      break;
    }
    case 'member-done': {
      const card = teamCard(ev.index, ev.name, ev.model || '');
      if (card) {
        setMemberControl(card, false, true);
        clearTimeout(card._renderTimer);
        card.classList.remove('waiting');
        card.classList.add(ev.ok ? 'done' : 'failed');
        card.querySelector('.member-state').textContent = ev.ok ? `done (${ev.chars || 0} chars)` : `${ev.status || 'failed'}: ${ev.error || 'No completed answer.'}`;
      }
      break;
    }
    /* ---------- spawned workers (agent.spawn — Grok-Bot-style subagents) ---------- */
    case 'subagent': {
      const card = subCard(ev.agentId, ev.name, ev.model || '', ev.depth);
      if (!card) break;
      const body = card.querySelector('.member-body');
      const state = card.querySelector('.member-state');
      switch (ev.netType) {
        case 'agent-control':
          setMemberControl(card, ev.paused);
          break;
        case 'agent-created': {
          card.classList.add('running');
          state.textContent = `spawned · ${ev.task ? ev.task.slice(0, 80) : 'working…'}`;
          break;
        }
        case 'agent-state': {
          setMemberControl(card, false, ev.status !== 'running');
          if (ev.status === 'running') {
            card.classList.remove('done', 'failed', 'waiting');
            card.classList.add('running');
            state.textContent = 'working…';
          } else {
            clearTimeout(card._renderTimer);
            card.classList.remove('running', 'waiting');
            card.classList.add(ev.status === 'completed' ? 'done' : 'failed');
            state.textContent = ev.status === 'completed'
              ? `done (${ev.chars || 0} chars)`
              : `${ev.status}: ${ev.error || ''}`;
            if (ev.outputPreview) body.innerHTML = md.render(ev.outputPreview.slice(0, 30000));
          }
          break;
        }
        case 'agent-message': {
          const line = document.createElement('div');
          line.className = 'member-tool dim';
          line.textContent = `✉ ${ev.delivered === 'queued' ? 'queued for' : 'woke'} ${ev.toName} (${ev.chars} chars)`;
          body.appendChild(line);
          break;
        }
        case 'agent-waiting': {
          card.classList.add('waiting');
          state.textContent = `waiting — ${(ev.edits || []).length} edit(s) need review`;
          break;
        }
        case 'agent-question': {
          card.classList.add('waiting');
          state.textContent = 'waiting for your answer…';
          attachAskBox(card, ev.questionId, ev.name, ev.question);
          break;
        }
        case 'agent-resumed': {
          card.classList.remove('waiting', 'failed');
          state.textContent = 'resumed · working…';
          break;
        }
        // Forwarded AgentLoop stream events for the worker's own turn.
        case 'delta': {
          const buf = ((run.buffer.get('sub:' + ev.agentId) || '') + (ev.text || '')).slice(-30000);
          run.buffer.set('sub:' + ev.agentId, buf);
          state.textContent = 'Receiving answer…';
          if (!card._renderTimer) {
            card._renderTimer = setTimeout(() => {
              card._renderTimer = null;
              body.textContent = run.buffer.get('sub:' + ev.agentId) || '';
            }, 100);
          }
          break;
        }
        case 'tool-call': {
          state.textContent = `Running ${ev.tool}…`;
          const line = document.createElement('div');
          line.className = 'member-tool dim';
          line.textContent = `→ ${ev.tool}`;
          body.appendChild(line);
          break;
        }
        case 'tool-result': {
          const line = document.createElement('div');
          line.className = 'member-tool ' + (ev.ok ? 'ok' : 'bad');
          line.textContent = `${ev.ok ? '✓' : '✗'} ${ev.tool}${ev.error ? ': ' + ev.error : ''}`;
          body.appendChild(line);
          break;
        }
        case 'error': {
          state.textContent = ev.message;
          break;
        }
        default:
          break;
      }
      break;
    }
    case 'subagents-summary': {
      const note = document.createElement('div');
      note.className = 'chat-msg system';
      const okCount = (ev.agents || []).filter(a => a.status === 'completed').length;
      note.textContent = `⑂ Crew workers: ${okCount}/${ev.count} spawned agents completed.`;
      run.wrap.appendChild(note);
      break;
    }
    case 'chain-broken': {
      const note = document.createElement('div');
      note.className = 'chat-msg system';
      note.textContent = `⛓ Chain broken at ${ev.name}: ${ev.error || 'member failed'} — remaining members skipped.`;
      run.wrap.appendChild(note);
      break;
    }
    case 'done': {
      const note = document.createElement('div');
      note.className = 'chat-msg system';
      const okCount = (ev.results || []).filter(r => r.ok).length;
      note.textContent = `🏁 Team run ${ev.stopped ? 'stopped' : 'finished'}: ${okCount}/${(ev.results || []).length} members succeeded.`;
      run.wrap.appendChild(note);
      // Persist a compact record into the conversation history so a reload
      // still shows the run happened and what the crew answered.
      if (run.agentId && ev.answer) {
        const summary = `【Team ${(run.team || {}).name || ''} · ${ev.mode}】\n${String(ev.answer).slice(0, 12000)}`;
        if (currentAgent?.id === run.agentId) appendChatMessage('assistant', summary);
        reachApi.agents.appendNote(run.agentId, summary).catch(error => { note.textContent += ' Could not save: ' + error.message; });
      }
      for (const card of run.cards.values()) clearTimeout(card._renderTimer);
      run.stop.remove();
      activeTeamRun = null;
      updateSendControl();
      break;
    }
    case 'error': {
      const note = document.createElement('div');
      note.className = 'chat-msg system';
      note.textContent = 'Team error: ' + ev.message;
      run.wrap.appendChild(note);
      for (const card of run.cards.values()) clearTimeout(card._renderTimer);
      run.stop.remove();
      activeTeamRun = null;
      updateSendControl();
      break;
    }
  }
}
reachApi.teams.onEvent(handleTeamEvent);

// Team member edit review cards (members run on ephemeral stores).
reachApi.teams.onEditPending(({ teamRunId, edit }) => {
  const card = document.createElement('div');
  card.className = 'edit-card';
  const head = document.createElement('div');
  head.className = 'edit-head';
  head.innerHTML = `<strong>${edit.isNew ? 'New file' : 'Edit'}</strong> ${escapeHtml(edit.path)} <span class="diff-stat add">+${edit.stats.added}</span> <span class="diff-stat del">−${edit.stats.removed}</span>`
    + (edit.memberName ? ` <span class="chip dim">${escapeHtml(edit.memberName)}</span>` : '');
  card.appendChild(head);
  const body = document.createElement('div');
  body.className = 'diff-body';
  for (const h of edit.hunks) {
    const line = document.createElement('div');
    if (h.type === 'gap') { line.className = 'diff-line gap'; line.textContent = `··· ${h.text} unchanged lines ···`; }
    else { line.className = 'diff-line ' + h.type; line.textContent = (h.type === 'add' ? '+ ' : h.type === 'del' ? '− ' : '  ') + h.text; }
    body.appendChild(line);
  }
  card.appendChild(body);
  const actions = document.createElement('div');
  actions.className = 'edit-actions';
  const acceptBtn = document.createElement('button');
  acceptBtn.className = 'gold small'; acceptBtn.textContent = 'Accept';
  const rejectBtn = document.createElement('button');
  rejectBtn.className = 'ghost small'; rejectBtn.textContent = 'Reject';
  actions.appendChild(acceptBtn); actions.appendChild(rejectBtn);
  card.appendChild(actions);
  const resolve = async (accepted) => {
    const res = await reachApi.teams.resolveEdit(edit.editId, accepted);
    actions.remove();
    const verdict = document.createElement('div');
    verdict.className = 'edit-verdict ' + (res.ok && res.accepted ? 'accepted' : 'rejected');
    verdict.textContent = res.ok ? (res.accepted ? 'Accepted — written to disk.' : 'Rejected.') : ('Error: ' + res.err);
    card.appendChild(verdict);
    card.classList.add(res.ok && res.accepted ? 'accepted' : 'rejected');
    if (res.ok && res.accepted) refreshFileTree();
  };
  acceptBtn.onclick = () => resolve(true);
  rejectBtn.onclick = () => resolve(false);
  const host = (activeTeamRun && activeTeamRun.wrap) ? activeTeamRun.wrap : chatLog;
  host.appendChild(card);
  host.scrollTop = host.scrollHeight;
});

// ---------- boot ----------
(async () => {
  refreshStatus();
  loadProjectList();
  await loadAgentProjectSelect();
  const option = $('#agent-project-select').selectedOptions[0];
  if (option) await selectProject({ name: option.textContent, dir: option.value });
  else await loadAgentTree();
  await loadCreatePage();
  loadSettings();
})();
