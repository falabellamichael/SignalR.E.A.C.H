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
const composerIntents = window.ReachComposerIntents;
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
const composerSuggestionsEl = $('#composer-suggestions');
const composerSuggestionStatus = $('#composer-suggestion-status');
const backgroundAgentAlertsEl = $('#background-agent-alerts');
const composerAttachmentsEl = $('#composer-attachments');
let composerAttachments = [];
let composerIntentPending = false;
let composerSuggestionItems = [];
let composerSuggestionIndex = 0;
let composerSuggestionContext = null;
let composerCatalogRevision = 0;
let composerCatalog = [];
let composerModelsCache = { key: '', at: 0, items: [] };
const backgroundAgentGates = new Map();
let composerMentionRetry = null;
let composerOutputContextAgentId = null;
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

function renderBackgroundAgentGates() {
  backgroundAgentAlertsEl.replaceChildren();
  backgroundAgentAlertsEl.classList.toggle('hidden', !backgroundAgentGates.size);
  for (const gate of backgroundAgentGates.values()) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'background-agent-alert';
    button.title = `${gate.name} — ${gate.detail}`;
    const name = document.createElement('strong');
    name.textContent = gate.name;
    const state = document.createElement('span');
    state.textContent = gate.action || 'Open';
    button.append(name, state);
    button.onclick = async () => {
      backgroundAgentGates.delete(gate.agentId);
      renderBackgroundAgentGates();
      await showTab('agents');
      await selectAgent({ id: gate.agentId });
    };
    backgroundAgentAlertsEl.appendChild(button);
  }
}

function setBackgroundAgentGate(agentId, detail, { clear = false, action = 'Open' } = {}) {
  const id = String(agentId || '');
  if (!id) return;
  if (clear) backgroundAgentGates.delete(id);
  else {
    const known = agents.find(agent => agent.id === id);
    backgroundAgentGates.set(id, { agentId: id, name: known?.name || 'Background agent', detail: String(detail || 'Needs attention'), action });
    if (!known) void reachApi.agents.get(id).then(agent => {
      const gate = backgroundAgentGates.get(id);
      if (!agent || !gate) return;
      gate.name = agent.name || gate.name;
      renderBackgroundAgentGates();
    }).catch(() => {});
  }
  renderBackgroundAgentGates();
}

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
    const attention = ['waiting_input', 'waiting_edits', 'paused', 'failed', 'error'].includes(node.status);
    dot.className = 'tree-dot ' + (node.status === 'running' ? 'run' : attention ? 'attention' : node.messageCount ? 'ok' : 'idle');
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
  closeComposerSuggestions();
  invalidateComposerCatalog();
  if ([...openFiles.values()].some(f => f.dirty) && !await confirmAction('There are unsaved editor changes. Discard them and switch conversation?')) return;
  const revision = ++projectSelectionRevision;
  const selected = await reachApi.agents.get(a.id);
  if (!selected || revision !== projectSelectionRevision) return;
  setBackgroundAgentGate(selected.id, '', { clear: true });
  streamBubble = null;
  recoveryBubble = null;
  resetEditors();

  if (selected.dir && !await selectProject({
    name: [...$('#agent-project-select').options].find(o => o.value === selected.dir)?.textContent || selected.dir.split(/[\\/]/).pop(),
    dir: selected.dir,
  })) return;
  currentAgent = selected;
  composerAttachments = [];
  renderComposerAttachments();
  window.ReachActivity.select(currentAgent);
  agentNameEl.textContent = agentNameEl.title = currentAgent.name;
  const lineage = currentAgent.parentChatId ? ' · ⑂ branch' : '';
  agentMetaEl.textContent = `${currentAgent.dir} · ${currentAgent.model || 'default model'}${lineage}`;
  agentMetaEl.title = agentMetaEl.textContent;
  $('#agent-info-summary-name').textContent = currentAgent.name;
  $('#agent-info-summary-model').textContent = currentAgent.model || 'Default model';
  noAgent.classList.add('hidden');
  agentView.classList.remove('hidden');
  agentRunning = currentAgent.runState && currentAgent.runState.status === 'running';
  updateStatusPill();
  renderChatHistory();
  refreshContextStatus();
  renderTodos();
  renderPendingEdits();
  followChatTail(true);
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
  const summaryStatus = $('#agent-info-summary-status');
  summaryStatus.textContent = s;
  summaryStatus.dataset.status = s;
  $('#btn-agent-stop').classList.toggle('hidden', s !== 'running');
  $('#btn-agent-continue').classList.toggle('hidden', !['stopped', 'stalled', 'paused', 'waiting_edits'].includes(s));
  $('#btn-agent-continue').textContent = ['stopped', 'stalled'].includes(s) ? 'Start' : 'Continue';
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
// Capture this BEFORE changing content. Streaming must follow a reader at the
// bottom, but never drag someone away from a message or edit they are reading.
function shouldFollowChat() {
  return chatScroll.scrollHeight - chatScroll.clientHeight - chatScroll.scrollTop <= 24;
}
function followChatTail(follow) {
  if (follow) chatScroll.scrollTop = chatScroll.scrollHeight;
}

function timeStamp() {
  const d = new Date();
  return d.toTimeString().slice(0, 8);
}

function appendChatMessage(role, text, msgIndex = null) {
  const follow = role === 'user' || shouldFollowChat();
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
  followChatTail(follow);
  return div;
}

function appendToolCallMessage(tool, args) {
  const follow = shouldFollowChat();
  const div = document.createElement('div');
  div.className = 'chat-msg system tool-call-message';
  const content = document.createElement('span');
  content.className = 'tool-call-text';
  content.textContent = `→ ${tool}(${JSON.stringify(args)})`;
  div.appendChild(content);
  const ts = document.createElement('span');
  ts.className = 'msg-ts';
  ts.textContent = timeStamp();
  div.appendChild(ts);
  chatLog.appendChild(div);

  const lineHeight = Number.parseFloat(getComputedStyle(content).lineHeight) || 18;
  if (content.scrollHeight > lineHeight * 3 + 1) {
    const details = document.createElement('details');
    details.className = 'tool-call-dropdown';
    const summary = document.createElement('summary');
    summary.title = 'Show or hide the complete tool call';
    summary.appendChild(content);
    details.appendChild(summary);
    div.insertBefore(details, ts);
  }
  followChatTail(follow);
  return div;
}

function appendQuestion(question) {
  if (!question) return;
  const follow = shouldFollowChat();
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
  followChatTail(follow);
}

function appendToolCard(tool, ok, pending, error, result) {
  const follow = shouldFollowChat();
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
  followChatTail(follow);
}

const activeEditReviewGroups = new Map();

function appendReviewMeta(parent, label, value) {
  const item = document.createElement('span');
  item.className = 'edit-review-meta-item';
  const key = document.createElement('span');
  key.className = 'edit-review-meta-key';
  key.textContent = label;
  const text = document.createElement('span');
  text.textContent = value;
  item.append(key, text);
  parent.appendChild(item);
  return text;
}

function updateEditReviewGroup(group) {
  const cards = [...group.cards.values()];
  const pending = cards.filter(card => card.state === 'pending' || card.state === 'resolving').length;
  const accepted = cards.filter(card => card.state === 'accepted').length;
  const rejected = cards.filter(card => card.state === 'rejected').length;
  const added = cards.reduce((total, card) => total + Number(card.edit.stats?.added || 0), 0);
  const removed = cards.reduce((total, card) => total + Number(card.edit.stats?.removed || 0), 0);
  const contributors = new Set(cards.map(card => card.edit.memberName).filter(Boolean));

  group.count.textContent = `${cards.length} ${cards.length === 1 ? 'file' : 'files'}`;
  group.added.textContent = `+${added}`;
  group.removed.textContent = `−${removed}`;
  group.pending.textContent = pending ? `${pending} awaiting review` : `${accepted} accepted${rejected ? ` · ${rejected} rejected` : ''}`;
  const batchState = pending ? 'pending' : rejected && accepted ? 'mixed' : rejected ? 'rejected' : 'accepted';
  group.pending.className = `edit-review-state ${batchState}`;
  group.guidance.textContent = pending
    ? 'The run continues automatically after every pending file has a decision.'
    : 'All decisions submitted. The AI run is continuing automatically.';
  group.acceptAll.disabled = group.bulkBusy || !pending;
  group.rejectAll.disabled = group.bulkBusy || !pending;
  group.acceptAll.textContent = group.bulkBusy === 'accept' ? 'Accepting…' : 'Accept all';
  group.rejectAll.textContent = group.bulkBusy === 'reject' ? 'Rejecting…' : 'Reject all';
  group.contributorMeta.textContent = contributors.size
    ? `${contributors.size} ${contributors.size === 1 ? 'contributor' : 'contributors'}`
    : group.actor;
  for (const card of cards) {
    if (card.state !== 'pending') continue;
    card.acceptBtn.disabled = !!group.bulkBusy;
    card.rejectBtn.disabled = !!group.bulkBusy;
  }

  if (!pending) {
    group.element.classList.add('settled');
    if (activeEditReviewGroups.get(group.key) === group) activeEditReviewGroups.delete(group.key);
  }
}

async function resolveReviewCard(group, reviewCard, accepted, { refresh = true } = {}) {
  if (reviewCard.state !== 'pending') return { ok: false, skipped: true };
  reviewCard.state = 'resolving';
  reviewCard.element.classList.add('resolving');
  reviewCard.acceptBtn.disabled = true;
  reviewCard.rejectBtn.disabled = true;
  reviewCard.status.textContent = accepted ? 'Accepting…' : 'Rejecting…';
  reviewCard.status.className = 'edit-review-file-state pending';
  updateEditReviewGroup(group);

  let res;
  try {
    res = await group.resolve(reviewCard.edit.editId, accepted);
  } catch (error) {
    res = { ok: false, err: error.message };
  }

  reviewCard.element.classList.remove('resolving');
  if (!res?.ok) {
    reviewCard.state = 'pending';
    reviewCard.acceptBtn.disabled = false;
    reviewCard.rejectBtn.disabled = false;
    reviewCard.status.textContent = 'Needs review';
    reviewCard.status.className = 'edit-review-file-state pending';
    reviewCard.verdict.hidden = false;
    reviewCard.verdict.className = 'edit-verdict error';
    reviewCard.verdict.textContent = `Could not ${accepted ? 'accept' : 'reject'}: ${res?.err || 'Unknown error'}`;
    updateEditReviewGroup(group);
    return res || { ok: false };
  }

  const didAccept = !!res.accepted;
  reviewCard.state = didAccept ? 'accepted' : 'rejected';
  reviewCard.actions.remove();
  reviewCard.status.textContent = didAccept ? 'Accepted' : 'Rejected';
  reviewCard.status.className = `edit-review-file-state ${reviewCard.state}`;
  reviewCard.verdict.hidden = false;
  reviewCard.verdict.className = `edit-verdict ${reviewCard.state}`;
  reviewCard.verdict.textContent = didAccept ? 'Accepted — written to disk.' : 'Rejected — no files changed.';
  reviewCard.element.classList.add(reviewCard.state);
  updateEditReviewGroup(group);
  if (didAccept && refresh) await refreshFileTree();
  return res;
}

async function resolveAllReviewCards(group, accepted) {
  if (group.bulkBusy) return;
  const pending = [...group.cards.values()].filter(card => card.state === 'pending');
  if (!pending.length) return;
  group.bulkBusy = accepted ? 'accept' : 'reject';
  updateEditReviewGroup(group);
  let wroteFile = false;
  for (const card of pending) {
    const res = await resolveReviewCard(group, card, accepted, { refresh: false });
    if (res?.ok && res.accepted) wroteFile = true;
  }
  group.bulkBusy = null;
  updateEditReviewGroup(group);
  if (wroteFile) await refreshFileTree();
}

function createEditReviewGroup({ key, host, title, actor, resolve }) {
  const element = document.createElement('details');
  element.className = 'edit-review-group';
  element.open = true;
  element.dataset.reviewKey = key;

  const summary = document.createElement('summary');
  summary.className = 'edit-review-summary';
  const chevron = document.createElement('span');
  chevron.className = 'edit-review-chevron';
  chevron.setAttribute('aria-hidden', 'true');
  chevron.textContent = '›';
  const heading = document.createElement('span');
  heading.className = 'edit-review-heading';
  const eyebrow = document.createElement('span');
  eyebrow.className = 'edit-review-eyebrow';
  eyebrow.textContent = 'AI work · review required';
  const name = document.createElement('strong');
  name.textContent = title;
  heading.append(eyebrow, name);
  const summaryMeta = document.createElement('span');
  summaryMeta.className = 'edit-review-summary-meta';
  const count = document.createElement('span');
  count.className = 'edit-review-count';
  const added = document.createElement('span');
  added.className = 'diff-stat add';
  const removed = document.createElement('span');
  removed.className = 'diff-stat del';
  const pendingState = document.createElement('span');
  summaryMeta.append(count, added, removed, pendingState);
  summary.append(chevron, heading, summaryMeta);
  element.appendChild(summary);

  const content = document.createElement('div');
  content.className = 'edit-review-content';
  const toolbar = document.createElement('div');
  toolbar.className = 'edit-review-toolbar';
  const metadata = document.createElement('div');
  metadata.className = 'edit-review-metadata';
  appendReviewMeta(metadata, 'Source', actor);
  appendReviewMeta(metadata, 'Scope', 'Current review batch');
  const contributorMeta = appendReviewMeta(metadata, 'By', '');
  const bulkActions = document.createElement('div');
  bulkActions.className = 'edit-review-bulk-actions';
  const rejectAll = document.createElement('button');
  rejectAll.className = 'ghost small';
  rejectAll.textContent = 'Reject all';
  rejectAll.setAttribute('aria-label', `Reject every file in ${title}`);
  const acceptAll = document.createElement('button');
  acceptAll.className = 'gold small';
  acceptAll.textContent = 'Accept all';
  acceptAll.setAttribute('aria-label', `Accept every file in ${title}`);
  bulkActions.append(rejectAll, acceptAll);
  toolbar.append(metadata, bulkActions);
  const files = document.createElement('div');
  files.className = 'edit-review-files';
  const guidance = document.createElement('div');
  guidance.className = 'edit-review-guidance';
  guidance.setAttribute('aria-live', 'polite');
  content.append(toolbar, guidance, files);
  element.appendChild(content);
  host.appendChild(element);

  const group = {
    key, element, files, cards: new Map(), resolve, actor, count, added, removed,
    pending: pendingState, contributorMeta, guidance, acceptAll, rejectAll, bulkBusy: null,
  };
  acceptAll.onclick = () => resolveAllReviewCards(group, true);
  rejectAll.onclick = () => resolveAllReviewCards(group, false);
  activeEditReviewGroups.set(key, group);
  return group;
}

function ensureEditReviewGroup(options) {
  const active = activeEditReviewGroups.get(options.key);
  if ((active?.element.isConnected || active?.element.parentElement === options.host) && !active.element.classList.contains('settled')) return active;
  return createEditReviewGroup(options);
}

function appendEditCardToGroup(group, edit) {
  if (!edit?.editId || group.cards.has(edit.editId)) return group.cards.get(edit.editId)?.element || null;
  const card = document.createElement('details');
  card.className = 'edit-card edit-review-file';
  card.dataset.editId = edit.editId;

  const summary = document.createElement('summary');
  summary.className = 'edit-head';
  const chevron = document.createElement('span');
  chevron.className = 'edit-review-chevron';
  chevron.setAttribute('aria-hidden', 'true');
  chevron.textContent = '›';
  const operation = document.createElement('strong');
  operation.textContent = edit.isNew ? 'New file' : 'Edit';
  const filePath = document.createElement('span');
  filePath.className = 'edit-review-path';
  filePath.textContent = edit.path;
  filePath.title = edit.path;
  const add = document.createElement('span');
  add.className = 'diff-stat add';
  add.textContent = `+${Number(edit.stats?.added || 0)}`;
  const del = document.createElement('span');
  del.className = 'diff-stat del';
  del.textContent = `−${Number(edit.stats?.removed || 0)}`;
  const status = document.createElement('span');
  status.className = 'edit-review-file-state pending';
  status.textContent = 'Needs review';
  summary.append(chevron, operation, filePath, add, del);
  if (edit.memberName) {
    const member = document.createElement('span');
    member.className = 'chip dim';
    member.textContent = edit.memberName;
    summary.appendChild(member);
  }
  summary.appendChild(status);
  card.appendChild(summary);

  const detailMeta = document.createElement('div');
  detailMeta.className = 'edit-review-file-meta';
  appendReviewMeta(detailMeta, 'Operation', edit.isNew ? 'Create file' : 'Modify file');
  appendReviewMeta(detailMeta, 'AI', edit.memberName || group.actor);
  appendReviewMeta(detailMeta, 'Changes', `${Number(edit.stats?.added || 0)} added · ${Number(edit.stats?.removed || 0)} removed`);
  appendReviewMeta(detailMeta, 'Review ID', String(edit.editId).slice(-10));
  card.appendChild(detailMeta);

  const body = document.createElement('div');
  body.className = 'diff-body';
  for (const h of edit.hunks || []) {
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
  const rejectBtn = document.createElement('button');
  rejectBtn.className = 'ghost small';
  rejectBtn.textContent = 'Reject';
  const acceptBtn = document.createElement('button');
  acceptBtn.className = 'gold small';
  acceptBtn.textContent = 'Accept';
  actions.append(rejectBtn, acceptBtn);
  card.appendChild(actions);
  const verdict = document.createElement('div');
  verdict.className = 'edit-verdict';
  verdict.hidden = true;
  card.appendChild(verdict);

  const reviewCard = { element: card, edit, actions, acceptBtn, rejectBtn, verdict, status, state: 'pending' };
  acceptBtn.onclick = () => resolveReviewCard(group, reviewCard, true);
  rejectBtn.onclick = () => resolveReviewCard(group, reviewCard, false);
  group.cards.set(edit.editId, reviewCard);
  group.files.appendChild(card);
  updateEditReviewGroup(group);
  return card;
}

function appendEditCard(edit, { agent = currentAgent, host = chatLog } = {}) {
  if (!agent) return null;
  const follow = shouldFollowChat();
  const group = ensureEditReviewGroup({
    key: `agent:${agent.id}`,
    host,
    title: 'Proposed changes',
    actor: agent.name || 'AI agent',
    resolve: (editId, accepted) => reachApi.agents.resolveEdit(agent.id, editId, accepted),
  });
  const card = appendEditCardToGroup(group, edit);
  followChatTail(follow);
  return card;
}

function renderChatHistory() {
  for (const deck of chatLog.querySelectorAll('.team-deck')) {
    if (deck !== activeTeamRun?.wrap) deck._teamDeck?.dispose();
  }
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
    chatLog.prepend(activeTeamRun.wrap);
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

function attachmentSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.ceil(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function renderComposerAttachments() {
  if (composerMentionRetry && composerMentionRetry.attachmentsKey !== composerAttachmentKey(composerAttachments)) {
    composerMentionRetry = null;
  }
  composerAttachmentsEl.replaceChildren();
  composerAttachmentsEl.classList.toggle('hidden', !composerAttachments.length);
  for (const attachment of composerAttachments) {
    const chip = document.createElement('span');
    chip.className = 'composer-attachment';
    chip.title = `${attachment.name} · ${attachmentSize(attachment.size)}`;
    const label = document.createElement('span');
    label.textContent = attachment.name;
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.setAttribute('aria-label', `Remove ${attachment.name}`);
    remove.title = `Remove ${attachment.name}`;
    remove.textContent = '×';
    remove.onclick = () => {
      composerAttachments = composerAttachments.filter(item => item.attachmentId !== attachment.attachmentId);
      renderComposerAttachments();
    };
    chip.append(label, remove);
    composerAttachmentsEl.appendChild(chip);
  }
}

$('#btn-attach').onclick = async () => {
  if (!currentAgent || agentRunning || runningAgentIds.size || activeTeamRun && !activeTeamRun.paused) return;
  const result = await reachApi.agents.pickAttachments(currentAgent.id);
  if (!result.ok) { showNotice(result.err); return; }
  composerAttachments.push(...result.attachments);
  renderComposerAttachments();
  composerInput.focus();
};

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
  if (e.isComposing || e.keyCode === 229) return;
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    closeComposerSuggestions();
    sendComposer();
  }
});

async function sendComposer() {
  if (composerIntentPending) return;
  const raw = composerInput.value;
  const parsed = composerIntents.parse(raw);
  const explicitIntent = parsed.kind === 'command' || parsed.kind === 'mentions' || parsed.error
    || /^[\s]*[\/@]/.test(raw);
  if (explicitIntent) {
    const snapshot = {
      text: raw,
      attachments: [...composerAttachments],
      attachmentsKey: composerAttachmentKey(composerAttachments),
      contextAgentId: currentAgent?.id || '',
      contextAgentName: currentAgent?.name || '',
      contextProjectDir: currentAgent?.dir || agentProjectDir || '',
      teamRunId: activeTeamRun?.teamRunId || '',
      teamName: activeTeamRun?.team?.name || '',
      selectedTeamAgentId: selectedLiveMemberAgentId(),
    };
    composerIntentPending = true;
    composerOutputContextAgentId = snapshot.contextAgentId;
    closeComposerSuggestions();
    updateSendControl();
    try {
      if (parsed.error) {
        const shown = parsed.input || parsed.token || raw.trim().split(/\s+/)[0];
        throw new Error(`Unknown or malformed composer action “${shown}”. Type /help, or choose an @ target from the menu.`);
      }
      if (parsed.kind === 'command') {
        const consumesMessage = new Set(['say', 'message', 'reply', 'answer', 'team-message', 'team-add', 'team-run', 'agent-new', 'agent-message', 'agent-open']);
        if (snapshot.attachments.length && consumesMessage.has(parsed.id)) {
          throw new Error('This command targets another agent or changes views. Remove the current-chat attachments first; they have not been discarded.');
        }
        const outcome = await executeComposerCommand(parsed, snapshot);
        clearSuccessfulComposer(snapshot, { attachments: false, allowContextChange: outcome?.allowContextChange === true });
      } else {
        const retryContextKey = JSON.stringify({
          agentId: parsed.mentions.some(mention => ['current', 'model', 'default'].includes(mention.kind))
            ? snapshot.contextAgentId
            : '',
          projectDir: parsed.mentions.some(mention => mention.kind === 'persona' || mention.kind === 'any')
            ? snapshot.contextProjectDir
            : '',
        });
        const priorRetry = composerMentionRetry?.text === snapshot.text
          && composerMentionRetry?.attachmentsKey === snapshot.attachmentsKey
          ? composerMentionRetry
          : null;
        if (priorRetry && priorRetry.contextKey !== retryContextKey) {
          throw new Error('This exact draft was partly delivered from another chat or project. Return to that context to retry, or edit the draft to begin a new dispatch.');
        }
        const retry = priorRetry || {
          text: snapshot.text,
          attachmentsKey: snapshot.attachmentsKey,
          contextKey: retryContextKey,
          delivered: new Set(),
          routes: [],
        };
        try {
          await executeMentionRouting(parsed, snapshot, retry);
          composerMentionRetry = null;
          clearSuccessfulComposer(snapshot, { attachments: true });
        } catch (error) {
          if (retry.delivered.size
            && composerInput.value === snapshot.text
            && composerAttachmentKey(composerAttachments) === snapshot.attachmentsKey) {
            composerMentionRetry = retry;
            error.message += ` ${retry.delivered.size} target(s) already accepted this exact draft; Retry will skip them.`;
          }
          throw error;
        }
      }
    } catch (error) {
      commandOutput(`Command not sent: ${error.message}`, true);
    } finally {
      composerIntentPending = false;
      composerOutputContextAgentId = null;
      updateSendControl();
      composerInput.focus();
    }
    return;
  }
  if (agentRunning || runningAgentIds.size || (activeTeamRun && !activeTeamRun.paused)) {
    return stopAllRuns();
  }
  const text = raw.trim();
  if ((!text && !composerAttachments.length) || !currentAgent) return;
  const attachments = [...composerAttachments];
  const contextAgentId = currentAgent.id;
  const contextAgentName = currentAgent.name;
  const display = [text, attachments.length ? `Attachments: ${attachments.map(file => file.name).join(', ')}` : ''].filter(Boolean).join('\n\n');
  composerIntentPending = true;
  updateSendControl();
  try {
    const res = await reachApi.agents.send(contextAgentId, text, attachments.map(file => file.attachmentId));
    if (!res.ok) throw new Error(res.err);
    if (currentAgent?.id === contextAgentId) {
      clearSuccessfulComposer({ text: raw, attachments, contextAgentId }, { attachments: true });
      appendChatMessage('user', display);
      agentRunning = true;
      updateStatusPill('running');
    }
    loadAgentTree(); // auto-title + message count may have changed
  } catch (error) {
    // Keep the exact draft and attachment chips on every rejected or failed IPC
    // path. A transport exception must not leave the composer permanently busy.
    if (currentAgent?.id === contextAgentId) {
      updateStatusPill('paused', error.message);
      appendChatMessage('system', `Error: ${error.message}`);
    } else {
      setBackgroundAgentGate(contextAgentId, `Message failed: ${error.message}`, { action: 'Inspect' });
      showNotice(`${contextAgentName}: ${error.message}`);
    }
  } finally {
    composerIntentPending = false;
    updateSendControl();
  }
}

$('#btn-agent-stop').onclick = async () => {
  if (currentAgent) await reachApi.agents.stop(currentAgent.id);
};

function updateSendControl() {
  const busy = agentRunning || runningAgentIds.size > 0 || !!(activeTeamRun && !activeTeamRun.paused);
  const parsed = composerIntents.parse(composerInput.value);
  const explicitIntent = parsed.kind === 'command' || parsed.kind === 'mentions' || parsed.error
    || /^[\s]*[\/@]/.test(composerInput.value);
  const stopMode = busy && !explicitIntent;
  const button = $('#btn-send');
  button.textContent = stoppingAll ? 'Stopping…' : composerIntentPending ? 'Running…' : stopMode ? 'Stop' : parsed.kind === 'command' || parsed.error ? 'Run' : 'Send';
  button.title = stopMode ? 'Stop all active agents and pause the team' : parsed.kind === 'command' || parsed.error ? 'Run composer command' : 'Send message';
  button.classList.toggle('danger', stopMode);
  button.disabled = stoppingAll || composerIntentPending;
  $('#btn-attach').disabled = busy || !currentAgent || stoppingAll;
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
  const follow = shouldFollowChat();
  window.ReachActivity.ingest(ev);
  if (ev.type === 'run-state') {
    if (ev.status === 'running') runningAgentIds.add(ev.agentId);
    else runningAgentIds.delete(ev.agentId);
    updateSendControl();
  }
  if (!currentAgent || ev.agentId !== currentAgent.id) {
    if (ev.type === 'run-state') {
      if (ev.status === 'running') setBackgroundAgentGate(ev.agentId, '', { clear: true });
      else if (['waiting_input', 'waiting_edits', 'paused'].includes(ev.status)) {
        setBackgroundAgentGate(ev.agentId, ev.reason || ev.status.replace('_', ' '), { action: 'Respond' });
      } else if (ev.status === 'completed') {
        setBackgroundAgentGate(ev.agentId, 'Finished independently.', { action: 'Review' });
      } else if (['failed', 'error', 'stopped'].includes(ev.status)) {
        setBackgroundAgentGate(ev.agentId, ev.reason || ev.status, { action: 'Inspect' });
      }
      loadAgentTree();
    } else if (ev.type === 'message-end' && ev.question) {
      setBackgroundAgentGate(ev.agentId, ev.question, { action: 'Answer' });
      loadAgentTree();
    } else if (ev.type === 'error') {
      setBackgroundAgentGate(ev.agentId, ev.message || 'Run failed.', { action: 'Inspect' });
      loadAgentTree();
    } else if (ev.type === 'renamed' || ev.type === 'queued') loadAgentTree();
    return;
  }
  switch (ev.type) {
    case 'message-start':
      if (ev.role === 'assistant') {
        streamBubble = recoveryBubble?.isConnected ? recoveryBubble : document.createElement('div');
        recoveryBubble = null;
        streamBubble.innerHTML = '';
        streamBubble.dataset.raw = '';
        streamBubble.className = 'chat-msg assistant streaming';
        chatLog.appendChild(streamBubble);
      }
      break;
    case 'delta':
      if (streamBubble) {
        streamBubble.innerHTML = md.render((streamBubble.dataset.raw = (streamBubble.dataset.raw || '') + ev.text));
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
      appendToolCallMessage(ev.tool, ev.arguments);
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
  followChatTail(follow);
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
  if (!currentAgent || agentId !== currentAgent.id) {
    setBackgroundAgentGate(agentId, `${edit?.path || 'A file edit'} needs review.`, { action: 'Review' });
    loadAgentTree();
    return;
  }
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
/* Connection cards are built with createElement, never string interpolation:
 * escapeHtml() escapes & < > but NOT quotes, so interpolating an endpoint or
 * access key into a value="..." attribute would break on the first quote and
 * could inject markup. Setting .value on a created element has no such hole. */
let connDraft = [];        // working copy; only written to disk on Save
let connActiveId = '';
const CONN_MAX = 20;       // mirrors connections.cjs MAX_CONNECTIONS
/* Per-connection test results, keyed by connection id. Kept OUTSIDE the DOM so
 * a re-render (pool toggle, activation, Settings save) does not wipe the last
 * "OK · 812 ms" off a card — and so auto-test on panel open knows which rows
 * still need one. A row's entry is cleared the moment its URL or key is edited:
 * a result describing values that no longer exist is a lie, not a cache. */
const connStatus = new Map();   // id -> { text, cls }
const connTesters = [];         // rebuilt by renderConnections: [{ id, running, run }]

async function loadSettings() {
  const s = await reachApi.getSettings();
  $('#credential-storage-warning').textContent = s.credentialStorage?.warning || '';
  $('#credential-storage-warning').classList.toggle('hidden', !s.credentialStorage?.warning);
  $('#set-reach-cli').value = s.reachCli || '';
  // Draft from the normalized list so ids are stable and the active one is known.
  connDraft = (Array.isArray(s.connections) ? s.connections : []).map(c => ({ ...c }));
  connActiveId = s.activeConnection || (connDraft[0] ? connDraft[0].id : '');
  // Drop test results for connections that no longer exist (removed here, in
  // the status bar, or by a hand-edited settings.json).
  for (const id of [...connStatus.keys()]) {
    if (!connDraft.some(c => c.id === id)) connStatus.delete(id);
  }
  renderConnections();
  for (const control of $('#settings-connection').querySelectorAll('input, select, button')) {
    if (s.credentialStorage?.locked) control.disabled = true;
    else if (control.dataset.credentialLocked === 'true') control.disabled = false;
    control.dataset.credentialLocked = String(!!s.credentialStorage?.locked);
  }
}

function newConnId() {
  // Client-side placeholder id for an unsaved row; the main process assigns the
  // real one on save. Prefixed so it can never collide with a stored id.
  return 'draft_' + Math.random().toString(36).slice(2, 10);
}

function renderConnections() {
  const list = $('#conn-list');
  if (!list) return;
  list.replaceChildren();
  // Each card registers its test runner here so "Test all" and the panel's
  // auto-test can drive every row without re-querying handlers off the DOM.
  connTesters.length = 0;

  /* Clear a row's stored test result. Called the moment its URL or key changes:
   * the old "OK" described values the user just replaced, and a stale success
   * is worse than no result at all. */
  function clearConnStatus(id) {
    if (!connStatus.has(id)) return;
    connStatus.delete(id);
    const card = document.querySelector('#conn-list .conn-card[data-conn-id="' + id + '"]');
    const status = card && card.querySelector('.conn-status');
    if (status) { status.textContent = ''; status.classList.remove('ok', 'bad'); }
  }

  connDraft.forEach((c, i) => {
    const card = document.createElement('div');
    card.className = 'conn-card';
    card.dataset.connId = c.id;
    if (c.id === connActiveId) card.classList.add('active');

    // --- header: radio (active) + name + status pill ---
    const head = document.createElement('div');
    head.className = 'conn-head';

    const radio = document.createElement('input');
    radio.type = 'radio';
    radio.name = 'conn-active';
    radio.className = 'conn-radio';
    radio.checked = c.id === connActiveId;
    radio.title = 'Use this connection';
    radio.setAttribute('aria-label', `Use ${c.name || 'this connection'}`);
    radio.onchange = () => { connActiveId = c.id; renderConnections(); markUnsaved(); };
    head.appendChild(radio);

    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.className = 'conn-name';
    nameInput.value = c.name || '';
    nameInput.placeholder = 'Connection name';
    nameInput.spellcheck = false;
    nameInput.setAttribute('aria-label', 'Connection name');
    nameInput.oninput = () => { c.name = nameInput.value; markUnsaved(); };
    head.appendChild(nameInput);

    const badge = document.createElement('span');
    badge.className = 'conn-badge' + (c.id === connActiveId ? ' on' : '');
    badge.textContent = c.id === connActiveId ? 'Active' : 'Select';
    badge.title = c.id === connActiveId
      ? 'Active connection: used by chats, playground and refactor, and the fallback every team member can use.'
      : 'Click the radio to make this the active connection.';
    head.appendChild(badge);

    /* Pool toggle — click to include this connection in team runs, click again to
     * take it out. This is the multi-select the user asked for: several
     * connections can be in the pool at once, and Teams spreads members across
     * them. Kept separate from the radio because they answer different questions:
     * the radio picks THE active connection (one, always), this picks which
     * connections teams may use (many).
     *
     * The active connection cannot leave the pool — it is the fallback, and a
     * fallback that can be switched off is not a fallback. The last one in the
     * pool cannot leave either, or a spread team would have nowhere to run. Both
     * are enforced in the main process too; the checks here just explain instead
     * of letting a click appear to do nothing. */
    const isActive = c.id === connActiveId;
    const enabled = c.enabled !== false;
    const enabledCount = connDraft.filter(x => x.enabled !== false).length;
    const poolBtn = document.createElement('button');
    poolBtn.type = 'button';
    poolBtn.className = 'conn-pool' + (enabled ? ' on' : '');
    poolBtn.textContent = enabled ? '✓ In team pool' : 'Add to team pool';
    poolBtn.setAttribute('aria-pressed', String(enabled));
    poolBtn.dataset.connId = c.id;
    poolBtn.title = isActive
      ? 'The active connection is always in the team pool: it is the fallback.'
      : (enabled
        ? 'Click to stop teams using this connection.'
        : 'Click to let teams spread members onto this connection.');
    // Disabled only when the click is guaranteed to be refused, so the user gets a
    // reason from the title rather than a control that silently does nothing.
    poolBtn.disabled = isActive || (enabled && enabledCount <= 1);
    if (!isActive && enabled && enabledCount <= 1) poolBtn.title = 'At least one connection must stay in the team pool.';
    poolBtn.onclick = () => {
      if (isActive) return;
      const next = !(c.enabled !== false);
      if (!next && connDraft.filter(x => x.enabled !== false).length <= 1) {
        const st = $('#settings-status');
        if (st) st.textContent = 'At least one connection must stay in the team pool.';
        return;
      }
      c.enabled = next;
      renderConnections();
      markUnsaved();
    };
    head.appendChild(poolBtn);

    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'icon-btn conn-remove';
    removeBtn.textContent = '−';
    removeBtn.title = connDraft.length <= 1 ? 'At least one connection must remain' : 'Remove connection';
    removeBtn.disabled = connDraft.length <= 1;
    removeBtn.setAttribute('aria-label', `Remove ${c.name || 'connection'}`);
    removeBtn.onclick = () => {
      if (connDraft.length <= 1) return;
      connDraft.splice(i, 1);
      if (connActiveId === c.id) connActiveId = connDraft[0] ? connDraft[0].id : '';
      renderConnections();
      markUnsaved();
    };
    head.appendChild(removeBtn);
    card.appendChild(head);

    // --- body: endpoint, key, model ---
    const body = document.createElement('div');
    body.className = 'conn-body';

    const addField = (labelText, buildInput) => {
      const row = document.createElement('div');
      row.className = 'conn-field';
      const label = document.createElement('label');
      label.textContent = labelText;
      row.appendChild(label);
      row.appendChild(buildInput());
      body.appendChild(row);
    };

    // Keep a reference to the URL field so Browse and Test can read the value the
    // user is currently looking at. (c.endpoint is kept live by its oninput, but
    // reading the input directly is unambiguous and survives a re-render order
    // change; an earlier draft of this grabbed the MODEL input by mistake and
    // would have sent the model name as the endpoint.)
    let urlInput = null;

    addField('Base URL', () => {
      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'conn-url';
      input.value = c.endpoint || '';
      input.placeholder = 'https://your-endpoint.example.com/v1';
      input.spellcheck = false;
      input.oninput = () => { c.endpoint = input.value.trim(); clearConnStatus(c.id); markUnsaved(); };
      urlInput = input;
      return input;
    });

    addField('Access Key', () => {
      const wrap = document.createElement('div');
      wrap.className = 'row';
      const input = document.createElement('input');
      input.type = 'password';
      input.value = c.accessKey || '';
      input.placeholder = 'leave blank for none';
      input.autocomplete = 'off';
      input.spellcheck = false;
      input.oninput = () => { c.accessKey = input.value; clearConnStatus(c.id); markUnsaved(); };
      const reveal = document.createElement('button');
      reveal.type = 'button';
      reveal.className = 'ghost small';
      reveal.textContent = 'Show';
      reveal.onclick = () => {
        const showing = input.type === 'text';
        input.type = showing ? 'password' : 'text';
        reveal.textContent = showing ? 'Show' : 'Hide';
      };
      wrap.append(input, reveal);
      return wrap;
    });

    addField('Default model', () => {
      const wrap = document.createElement('div');
      wrap.className = 'row';
      const input = document.createElement('input');
      input.type = 'text';
      input.value = c.model || '';
      input.placeholder = 'click Browse to pick from this endpoint';
      input.spellcheck = false;
      input.oninput = () => { c.model = input.value.trim(); markUnsaved(); };
      const browse = document.createElement('button');
      browse.type = 'button';
      browse.className = 'ghost small';
      browse.textContent = 'Browse…';
      // Browse uses the URL CURRENTLY IN THE ROW, not the saved one: the user is
      // configuring this connection and may not have saved it yet. Listing from
      // the stored value would make the button appear broken on a new row.
      browse.onclick = () => openModelPicker({
        target: { endpoint: (urlInput ? urlInput.value : c.endpoint).trim(), accessKey: c.accessKey || '' },
        onPick: (id) => { c.model = id; input.value = id; markUnsaved(); },
        label: c.name || (urlInput ? urlInput.value : c.endpoint),
      });
      wrap.append(input, browse);
      return wrap;
    });

    // --- footer: per-row test ---
    /* One test path for the row button, "Test all" and the panel's auto-test.
     *
     * A SAVED row whose on-screen values still match the stored ones is pinged
     * BY ID (connections:ping → GET /models): that returns the round-trip
     * latency, which is also painted onto the status bar's latency chip when
     * this row is the active connection. An edited row — or an unsaved draft
     * row that has no id to ping yet — falls back to the ad-hoc models lookup,
     * which validates exactly the values on screen rather than the stored ones.
     *
     * Results are stored per connection id (connStatus) and restored on every
     * re-render, so a pool toggle or a save cannot wipe them; editing the URL
     * or key clears the entry (clearConnStatus). */
    const foot = document.createElement('div');
    foot.className = 'conn-foot';
    const testBtn = document.createElement('button');
    testBtn.type = 'button';
    testBtn.className = 'ghost small';
    testBtn.textContent = 'Test';
    const status = document.createElement('span');
    status.className = 'dim conn-status';
    const tester = { id: c.id, running: false, run: null };

    /* Write to this card's span AND the live one when they differ: a re-render
     * replaces the card's DOM mid-test, and a result that lands only on the
     * detached node would be invisible until the next render. */
    const setStatus = (text, cls, store = true) => {
      const apply = (el) => {
        if (!el) return;
        el.textContent = text;
        el.classList.remove('ok', 'bad');
        if (cls) el.classList.add(cls);
      };
      apply(status);
      const live = document.querySelector('#conn-list .conn-card[data-conn-id="' + c.id + '"] .conn-status');
      if (live && live !== status) apply(live);
      if (store) {
        if (text) connStatus.set(c.id, { text, cls: cls || '' });
        else connStatus.delete(c.id);
      }
    };

    const savedStatus = connStatus.get(c.id);
    if (savedStatus) setStatus(savedStatus.text, savedStatus.cls, false);

    tester.run = async () => {
      if (tester.running) return { ok: false, skipped: true };
      // Read urlInput, not a CSS query: the model field is ALSO type=text, so
      // `.conn-field input[type=text]` only works by accident of append order.
      const endpoint = (urlInput ? urlInput.value : (c.endpoint || '')).trim();
      if (!endpoint) { setStatus('Enter a Base URL first.', 'bad'); return { ok: false, err: 'no endpoint' }; }
      tester.running = true;
      testBtn.disabled = true;
      setStatus('Testing…', '', false);
      const stripSlash = value => String(value || '').trim().replace(/\/+$/, '');
      try {
        let earlier = null;
        try { earlier = await reachApi.connections.list(); } catch { /* fall back to the ad-hoc lookup */ }
        const rec = earlier && (earlier.connections || []).find(x => x.id === c.id);
        const unchanged = !!rec
          && stripSlash(rec.endpoint) === stripSlash(endpoint)
          && (rec.accessKey || '') === (c.accessKey || '');
        let result;
        if (unchanged) {
          const ping = await reachApi.connections.ping(c.id);
          const ok = !!(ping && ping.ok);
          if (ok) {
            const models = ping.models === null || ping.models === undefined ? '' : ` · ${ping.models} model(s)`;
            result = { ok: true, text: `OK · ${ping.latencyMs} ms${models}` };
          } else {
            result = { ok: false, text: `Failed · ${(ping && ping.err) || 'unreachable'}` };
          }
          // The latency chip speaks for the ACTIVE connection only.
          if (c.id === connActiveId) window.ReachWorkspaceShell?.setLatency(ok ? ping.latencyMs : null, ok);
        } else {
          const res = await reachApi.listModels({ endpoint, accessKey: c.accessKey || '' });
          result = res && res.ok
            ? { ok: true, text: `OK · ${res.models.length} model(s)` }
            : { ok: false, text: `Failed · ${(res && res.err) || 'unreachable'}` };
        }
        setStatus(result.text, result.ok ? 'ok' : 'bad');
        return result;
      } catch (e) {
        setStatus('Failed · ' + e.message, 'bad');
        return { ok: false, err: e.message };
      } finally {
        tester.running = false;
        testBtn.disabled = false;
      }
    };
    testBtn.onclick = () => { void tester.run(); };
    connTesters.push(tester);
    foot.append(testBtn, status);

    // Append order defines layout: head, then fields, then the Test footer.
    card.appendChild(body);
    card.appendChild(foot);
    list.appendChild(card);
  });

  const count = $('#conn-count');
  if (count) {
    const inPool = connDraft.filter(c => c.enabled !== false).length;
    // Two facts the user needs here: how many rows exist against the limit, and
    // how many of them teams may actually use.
    count.textContent = `${connDraft.length} of ${CONN_MAX} connection(s) · ${inPool} in team pool`;
  }
  const addBtn = $('#btn-add-connection');
  if (addBtn) addBtn.disabled = connDraft.length >= CONN_MAX;

  /* One line stating what the app is actually configured to use — the same fact
   * the status bar shows, painted from the DRAFT so edits appear before saving. */
  const summary = $('#conn-summary');
  if (summary) {
    const active = connDraft.find(c => c.id === connActiveId) || null;
    summary.textContent = active
      ? `Active: ${active.name || active.endpoint || 'connection'}${active.model ? ' — model ' + active.model : ' — no default model'}. Used by every conversation, the playground and the refactor workbench.`
      : 'No active connection yet. Add one below.';
  }
}

function markUnsaved() {
  const el = $('#settings-status');
  if (el && !el.dataset.savedRecently) el.textContent = 'Unsaved changes.';
}

/* Cross-surface mirror for the status bar's quick-switch (workspace-shell.js).
 *
 * The footer persists activation and model picks straight through the
 * connections IPC — this draft never sees those writes. Without the mirror the
 * draft would keep the OLD active id / model, and the next Save Settings would
 * silently write them back, reverting the switch the user just made.
 *
 * Deliberately minimal: only the fields the footer owns are copied, already
 * typed card edits stay untouched, and nothing is marked unsaved — the switch
 * is already on disk, the draft is just catching up to it. */
window.ReachSettingsDraft = {
  setActive(id) {
    if (!id || !connDraft.some(c => c.id === id)) return;
    connActiveId = id;
    if ($('#page-settings')?.classList.contains('active')) renderConnections();
  },
  setModel(id, model) {
    const row = connDraft.find(c => c.id === id);
    if (!row) return;
    row.model = model;
    if ($('#page-settings')?.classList.contains('active')) renderConnections();
  },
};

$('#btn-add-connection').onclick = () => {
  if (connDraft.length >= CONN_MAX) return;
  const c = { id: newConnId(), name: '', endpoint: '', accessKey: '', model: '', enabled: true };
  connDraft.push(c);
  // Activating the new row matches the old single-endpoint behaviour (you are
  // editing what you will use) and makes its Browse/Test target obvious.
  connActiveId = c.id;
  renderConnections();
  markUnsaved();
  const cards = document.querySelectorAll('#conn-list .conn-card');
  const last = cards[cards.length - 1];
  if (last) { const url = last.querySelector('.conn-field input[type=text]'); if (url) url.focus(); }
};

/* "Test all": ping every row with the values on screen, in parallel. Read-only
 * (GET /models), so it cannot cost tokens or mutate anything. Each row writes
 * its own status; nothing here waits on another row. */
{
  const testAllBtn = $('#btn-test-all');
  if (testAllBtn) testAllBtn.onclick = async () => {
    if (testAllBtn.disabled) return;
    testAllBtn.disabled = true;
    try { await Promise.allSettled(connTesters.map(t => t.run())); }
    finally { testAllBtn.disabled = false; }
  };
}

/* Auto-test hook for the Connection panel's open (called from settings.js):
 * test every rendered row that has no stored result yet, so the page never
 * looks the same whether or not any provider is reachable. Results persist per
 * connection id until that row is edited, so reopening does not re-ping. Rows
 * with no URL are skipped — there is nothing to test, and "Enter a Base URL
 * first." on an untouched new row is noise, not information. */
window.ReachConnPanel = {
  autoTest() {
    for (const tester of connTesters) {
      if (connStatus.has(tester.id)) continue;
      const card = document.querySelector('#conn-list .conn-card[data-conn-id="' + tester.id + '"]');
      const url = card && card.querySelector('.conn-url');
      if (!url || !url.value.trim()) continue;
      void tester.run();
    }
  },
};

$('#btn-save-settings').onclick = async () => {
  // Validate before writing: a row with no endpoint is unusable, and saving one
  // would silently drop it (normalize discards endpoint-less entries), which
  // would look like the app ate the user's input.
  const blanks = connDraft.filter(c => !String(c.endpoint || '').trim());
  const status = $('#settings-status');
  if (blanks.length) {
    status.textContent = `Enter a Base URL for ${blanks.length} connection(s), or remove the empty row(s).`;
    return;
  }
  const endpoints = connDraft.map(c => String(c.endpoint).trim().replace(/\/+$/, ''));
  const dupe = endpoints.find((e, i) => endpoints.indexOf(e) !== i);
  if (dupe) { status.textContent = `Two connections use the same endpoint: ${dupe}`; return; }
  if (!connDraft.some(c => c.id === connActiveId)) connActiveId = connDraft[0].id;

  const payload = {
    reachCli: $('#set-reach-cli').value.trim(),
    // Sending `connections` makes the list authoritative (see settings:save), so
    // the legacy endpoint/accessKey/model fields are recomputed from the active
    // row instead of being folded back into it.
    connections: connDraft.map(c => ({
      id: c.id, name: c.name, endpoint: String(c.endpoint).trim(),
      accessKey: c.accessKey || '', model: String(c.model || '').trim(),
      /* `enabled` must be sent explicitly: this object literal is the whole row,
       * so omitting it would reset every pool toggle on Save — and silently,
       * because normalizeSettings treats a missing field as enabled. */
      enabled: c.enabled !== false,
    })),
    activeConnection: connActiveId,
  };
  const res = await reachApi.saveSettings(payload);
  if (res && res.ok === false) { status.textContent = res.err || 'Could not save.'; return; }
  composerModelsCache = { key: '', at: 0, items: [] };
  invalidateComposerCatalog();
  // Re-read so the UI shows the ids and projection the main process settled on
  // (draft ids are replaced by real ones for new rows).
  await loadSettings();
  refreshStatus();
  // The status bar reads the same settings; repaint its chips so a switch or
  // model change saved here shows up immediately instead of lagging behind.
  window.ReachWorkspaceShell?.refreshEndpointChip();
  status.dataset.savedRecently = '1';
  status.textContent = 'Saved.';
  setTimeout(() => { status.textContent = ''; delete status.dataset.savedRecently; }, 2000);
};

// ---------- model picker ----------
/* `openModelPicker({target, onPick, label})` — or, for the legacy call sites,
 * `openModelPicker(inputEl)` which writes the chosen id into that input.
 *
 * `target` decides WHICH endpoint is queried:
 *   undefined            -> the active connection (playground, refactor, agent form)
 *   'conn_x'             -> that saved connection
 *   {endpoint, accessKey} -> an ad-hoc lookup for a row not yet saved
 * The modal states which connection the list came from, because with several
 * providers configured "Pick a Model" alone no longer says which one's models
 * these are — picking a model that the active endpoint does not serve would fail
 * at request time with a confusing error.
 */
let modelPickerPick = null;
async function openModelPicker(arg) {
  const modal = $('#model-modal');
  const choices = $('#model-choices');
  const search = $('#model-search');
  const source = $('#model-source');

  let target;
  let label = '';
  let pick;
  if (arg && typeof arg === 'object' && !(arg instanceof HTMLElement) && (arg.onPick || arg.target || arg.label)) {
    target = arg.target;
    label = arg.label || '';
    pick = arg.onPick;
  } else {
    const inputEl = arg;
    target = undefined;
    pick = (id) => {
      if (inputEl) {
        inputEl.value = id;
        inputEl.dispatchEvent(new Event('change', { bubbles: true }));
      }
    };
  }
  modelPickerPick = pick;

  search.value = '';
  if (source) source.textContent = label ? `From: ${label}` : '';
  choices.replaceChildren();
  const loading = document.createElement('div');
  loading.className = 'dim';
  loading.style.padding = '12px';
  loading.textContent = 'Loading models…';
  choices.appendChild(loading);
  modal.classList.remove('hidden');
  search.focus();

  const res = await reachApi.listModels(target);
  choices.replaceChildren();
  if (!res.ok) {
    const err = document.createElement('div');
    err.className = 'dim';
    err.style.padding = '12px';
    err.textContent = `Could not load models: ${res.err}`;
    choices.appendChild(err);
    if (source) source.textContent = label ? `From: ${label} — request failed` : '';
    return;
  }
  // Prefer the server's own name for the connection; it is authoritative for
  // saved rows and derived from the hostname for ad-hoc ones.
  if (source) source.textContent = `From: ${res.connectionName || label || 'the active connection'}`;

  const render = (filter) => {
    choices.replaceChildren();
    const filtered = res.models.filter(m => !filter || m.toLowerCase().includes(filter.toLowerCase()));
    if (!filtered.length) {
      const none = document.createElement('div');
      none.className = 'dim';
      none.style.padding = '12px';
      none.textContent = 'No matches.';
      choices.appendChild(none);
      return;
    }
    for (const id of filtered) {
      const btn = document.createElement('button');
      btn.className = 'model-choice';
      btn.textContent = id;
      btn.onclick = () => {
        if (modelPickerPick) modelPickerPick(id);
        modal.classList.add('hidden');
      };
      choices.appendChild(btn);
    }
  };
  render('');
  search.oninput = () => render(search.value.trim());
}
$('#btn-agent-set-browse').onclick = () => openModelPicker($('#agent-set-model'));
$('#btn-model-cancel').onclick = () => $('#model-modal').classList.add('hidden');

// ---------- Create page: custom agents (personas) + teams ----------
let personas = [];
let teams = [];
let roles = [];                // preset crew roles (agent/roles.cjs) — the dropdown catalog
let editingPersonaId = null;
let editingTeamId = null;
let teamBuilderMembers = [];   // [{personaId, roleId, role}] while the modal is open
let activeTeamRun = null;      // { teamRunId, cards: Map(index -> {el, out}) }
let teamDispatching = false;
let pendingTeamEvents = [];

async function loadCreatePage() {
  personas = await reachApi.personas.list();
  teams = await reachApi.teams.list();
  roles = await reachApi.roles.list();
  /* Load connections too, so a persona card can NAME the connection it is pinned
   * to instead of showing a bare id. Best-effort: if the list cannot load the
   * cards still render, they just fall back to the id. */
  await loadConnectionChoices();
  renderPersonaList();
  renderTeamList();
}

/** Connection display name for an id, or null when unknown/deleted. */
function connectionLabel(id) {
  if (!id) return null;
  const c = (connChoices || []).find(x => x.id === id);
  return c ? (c.name || c.endpoint) : null;
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
    /* Show the pin: without a chip, a persona locked to one provider looks
     * identical to one that follows the team spread, and the difference only
     * becomes visible mid-run. Name the connection rather than its id. */
    const pin = p.connectionId
      ? `<span class="chip pinned" title="Pinned to one connection">⇢ ${escapeHtml(connectionLabel(p.connectionId) || 'deleted connection')}</span>`
      : '';
    card.innerHTML = `<div class="persona-card-head"><strong>${escapeHtml(p.name)}</strong><span class="chip dim">${escapeHtml(p.model || 'default model')}</span>${pin}</div>`
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
    const roster = (t.members || []).map(m => escapeHtml(m.personaName) + (m.role ? ` <span class="dim">(${escapeHtml(m.role)})</span>` : '')).join(t.mode === 'chain' ? ' → ' : t.mode === 'links' ? ' ⇄ ' : ' · ');
    /* A spread team runs on several providers, so say so on the card — otherwise
     * two identical-looking crews behave differently at run time. */
    const spreadChip = t.spreadConnections === true
      ? '<span class="chip ok" title="Members spread across the enabled connections">⇶ multi-endpoint</span>'
      : '';
    /* Which contract the crew runs on is a behavior difference, so the card
     * carries it too (absent on legacy teams = JSON contract). */
    const protoChip = t.toolProtocol === 'native'
      ? '<span class="chip" title="Native OpenAI tool calls: member tool calls execute directly">native tools</span>'
      : '';
    card.innerHTML = `<div class="persona-card-head"><strong>${escapeHtml(t.name)}</strong><span class="chip ${t.mode === 'chain' ? 'pending' : t.mode === 'links' ? 'links' : 'ok'}">${t.mode}</span>${protoChip}${spreadChip}</div>`
      + `<div class="persona-card-prompt">${roster || '<span class="dim">no members</span>'}</div>`
      + `<div class="team-card-actions"><button class="ghost small" data-act="run">Run…</button><button class="ghost small" data-act="edit">Edit</button></div>`;
    card.querySelector('[data-act="edit"]').onclick = (e) => { e.stopPropagation(); openTeamModal(t); };
    card.querySelector('[data-act="run"]').onclick = (e) => { e.stopPropagation(); openTeamRunModal(t); };
    card.onclick = () => openTeamModal(t);
    el.appendChild(card);
  }
}

// ----- persona modal -----
/* Cache of the connection list for the persona/team pickers. Loaded on demand:
 * these modals open rarely and connections change in Settings, so a stale
 * in-memory list would offer ids that no longer exist. */
let connChoices = null;
async function loadConnectionChoices() {
  try {
    const res = await reachApi.connections.list();
    connChoices = (res && res.connections) || [];
  } catch { connChoices = []; }
  return connChoices;
}

/**
 * Fill a <select> with "blank + one option per connection".
 *
 * `includeDisabled` matters: a persona pin is a promise about WHERE it runs, so
 * it should survive a connection being switched out of the team pool — hiding it
 * would silently drop the user's pin when they next saved the persona. Team
 * spread, by contrast, only ever uses enabled connections, and its hint says so.
 */
function fillConnectionSelect(select, selectedId, { includeDisabled = true } = {}) {
  if (!select) return;
  select.replaceChildren();
  const auto = document.createElement('option');
  auto.value = '';
  auto.textContent = 'Automatic (team decides)';
  select.appendChild(auto);
  let matched = false;
  for (const c of connChoices || []) {
    if (!includeDisabled && c.enabled === false) continue;
    const opt = document.createElement('option');
    opt.value = c.id;
    const pool = c.enabled === false ? ' — not in team pool' : '';
    opt.textContent = `${c.name || c.endpoint}${pool}`;
    if (c.id === selectedId) { opt.selected = true; matched = true; }
    select.appendChild(opt);
  }
  /* A pin to a connection that has since been DELETED cannot be offered as an
   * option, but must not be silently discarded either — that would change where
   * the agent runs the moment the user saves an unrelated field. Show it as a
   * distinct stale entry so the choice is visible and deliberate. */
  if (selectedId && !matched) {
    const opt = document.createElement('option');
    opt.value = selectedId;
    opt.textContent = '(connection no longer exists)';
    opt.selected = true;
    select.appendChild(opt);
  }
  if (!selectedId) select.value = '';
}

async function openPersonaModal(p) {
  editingPersonaId = p ? p.id : null;
  $('#persona-modal-title').textContent = p ? 'Edit Custom Agent' : 'New Custom Agent';
  $('#persona-name').value = p ? p.name : '';
  $('#persona-model').value = p ? (p.model || '') : '';
  $('#persona-prompt').value = p ? (p.prompt || '') : '';
  await loadConnectionChoices();
  fillConnectionSelect($('#persona-connection'), p ? (p.connectionId || '') : '');
  $('#btn-persona-delete').classList.toggle('hidden', !p);
  $('#persona-modal').classList.remove('hidden');
  $('#persona-name').focus();
}
$('#btn-new-persona').onclick = () => openPersonaModal(null);
$('#btn-persona-cancel').onclick = () => $('#persona-modal').classList.add('hidden');
/* Browse must list the PINNED connection's models, not the active one's: model
 * ids are per-endpoint, so picking from the wrong list yields an id the pinned
 * provider rejects at request time. Clearing the pin returns to the active
 * connection, which is what "Automatic" will resolve to outside a team. */
$('#btn-persona-browse').onclick = () => {
  const pin = $('#persona-connection').value;
  const target = pin ? { connectionId: pin } : undefined;
  openModelPicker({
    target,
    label: pin
      ? `Models on ${(connChoices || []).find(c => c.id === pin)?.name || 'the pinned connection'}`
      : 'Models on the active connection',
    onPick: (id) => {
      const input = $('#persona-model');
      input.value = id;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    },
  });
};
$('#persona-connection').onchange = () => {
  /* Models belong to an endpoint, so the previously chosen id may not exist on
   * the newly pinned one. Clear it rather than leave a value that will 404 —
   * blank means "that connection's default", which is always valid. */
  $('#persona-model').value = '';
};
$('#btn-persona-save').onclick = async () => {
  const name = $('#persona-name').value.trim();
  if (!name) { $('#persona-name').focus(); return; }
  const patch = {
    name,
    model: $('#persona-model').value.trim(),
    prompt: $('#persona-prompt').value,
    connectionId: $('#persona-connection').value,
  };
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
async function openTeamModal(t) {
  editingTeamId = t ? t.id : null;
  $('#team-modal-title').textContent = t ? 'Edit Team' : 'New Team';
  $('#team-name').value = t ? t.name : '';
  $('#team-mode').value = t ? t.mode : 'parallel';
  /* Tool protocol: how members turn model output into tool calls. New teams
   * default to native (the endpoint's tool_calls run directly); the JSON
   * contract stays available for endpoints without native tool support. Older
   * teams report 'json' from the store unless they were switched over. */
  $('#team-protocol').value = t ? (t.toolProtocol === 'native' ? 'native' : 'json') : 'native';
  updateProtocolHint();
  teamBuilderMembers = t ? (t.members || []).map(m => ({ personaId: m.personaId, roleId: m.roleId || '', role: m.role || '' })) : [];
  $('#team-spread').checked = !!(t && t.spreadConnections === true);
  await loadConnectionChoices();
  fillRolePicker();
  updateSpreadHint();
  $('#btn-team-delete').classList.toggle('hidden', !t);
  renderTeamBuilder();
  $('#team-modal').classList.remove('hidden');
  $('#team-name').focus();
}

/* Explain what the spread toggle will actually do with the CURRENT pool and the
 * CURRENT roster. A bare checkbox labelled "spread across connections" leaves the
 * user guessing when only one connection is enabled, or when every member is
 * pinned — both cases where the toggle has no effect. Saying so here beats a
 * confusing run later. */
function updateSpreadHint() {
  const hint = $('#team-spread-hint');
  if (!hint) return;
  const on = $('#team-spread').checked;
  const pool = (connChoices || []).filter(c => c.enabled !== false);
  if (!on) {
    hint.textContent = 'Off: every unpinned member runs on the active connection (the fallback).';
    return;
  }
  if (pool.length <= 1) {
    hint.textContent = `On, but only ${pool.length} connection is in the team pool — enable more in Settings > Connections to actually spread.`;
    return;
  }
  const pinned = teamBuilderMembers.filter(m => {
    const p = personas.find(x => x.id === m.personaId);
    return !!(p && p.connectionId);
  }).length;
  const spread = teamBuilderMembers.length - pinned;
  hint.textContent = `On: ${spread} unpinned member(s) rotate across ${pool.length} pooled connections; ${pinned} pinned member(s) keep their own.`;
}
$('#team-spread').onchange = updateSpreadHint;
/* Say what the chosen tool protocol does at run time — the two options fail in
 * different places (a native endpoint without function-calling support vs a
 * model that drifts off the JSON contract). */
function updateProtocolHint() {
  const hint = $('#team-protocol-hint');
  if (!hint) return;
  hint.textContent = $('#team-protocol').value === 'native'
    ? 'Native: each member request advertises real OpenAI tools and the model\'s tool calls execute directly; task_complete ends the member. Needs a model with function-calling support on its endpoint.'
    : 'JSON contract: the model answers with one structured actions object — works on any endpoint that can follow instructions, no function-calling support needed.';
}
$('#team-protocol').onchange = updateProtocolHint;
/* Role picker helpers: the 20 presets (agent/roles.cjs) plus a free-text
 * fallback. A preset stores its id AND its name (older surfaces still show
 * `role`); Custom stores free text with no id; the runner turns either into
 * real role behavior on every run. */
function fillRoleOptions(sel, roleId = '', customText = '') {
  sel.innerHTML = '';
  const none = document.createElement('option');
  none.value = ''; none.textContent = 'no role';
  sel.appendChild(none);
  for (const r of roles) {
    const opt = document.createElement('option');
    opt.value = r.id; opt.textContent = r.name; opt.title = r.tagline;
    sel.appendChild(opt);
  }
  const custom = document.createElement('option');
  custom.value = '__custom';
  custom.textContent = customText && !roleId ? `Custom: ${String(customText).slice(0, 28)}` : 'Custom role…';
  sel.appendChild(custom);
  sel.value = roleId && roles.some(r => r.id === roleId) ? roleId : (customText ? '__custom' : '');
}

function fillRolePicker() {
  const pick = $('#team-member-role-pick');
  if (!pick) return;
  fillRoleOptions(pick);
  $('#team-member-role').disabled = true;
}

function renderTeamBuilder() {
  const el = $('#team-members');
  el.innerHTML = '';
  teamBuilderMembers.forEach((m, i) => {
    const p = personas.find(x => x.id === m.personaId);
    const row = document.createElement('div');
    row.className = 'team-member-row';
    row.innerHTML = `<span class="member-idx">${i + 1}</span><strong>${escapeHtml(p ? p.name : '(deleted)')}</strong>`;
    const roleSel = document.createElement('select');
    roleSel.className = 'row-role';
    roleSel.title = 'Crew role for this member — the role is behavior: it is injected into the member\'s prompt on every run.';
    fillRoleOptions(roleSel, m.roleId, m.role);
    roleSel.onchange = async () => {
      if (roleSel.value === '__custom') {
        const txt = await window.ReachDialogs.prompt('Custom role for this member (free text):', m.roleId ? '' : (m.role || ''));
        const text = String(txt || '').trim();
        if (text) { m.roleId = ''; m.role = text.slice(0, 120); }
      } else {
        const spec = roles.find(r => r.id === roleSel.value);
        m.roleId = spec ? spec.id : '';
        m.role = spec ? spec.name : '';
      }
      renderTeamBuilder();
    };
    row.appendChild(roleSel);
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
  // The hint counts pinned vs unpinned members, so it must be recomputed whenever
  // the roster changes — adding, removing or reordering can change both.
  updateSpreadHint();
}
$('#btn-new-team').onclick = () => openTeamModal(null);
$('#btn-team-cancel').onclick = () => $('#team-modal').classList.add('hidden');
$('#btn-team-add-member').onclick = () => {
  const personaId = $('#team-member-pick').value;
  if (!personaId) return;
  if (teamBuilderMembers.length >= 8) { showNotice('A team can have at most 8 members.'); return; }
  const pick = $('#team-member-role-pick').value;
  const spec = pick === '__custom' ? null : roles.find(r => r.id === pick);
  const custom = pick === '__custom' ? $('#team-member-role').value.trim() : '';
  teamBuilderMembers.push({
    personaId,
    roleId: spec ? spec.id : '',
    role: spec ? spec.name : custom.slice(0, 120),
  });
  $('#team-member-role').value = '';
  $('#team-member-role-pick').value = '';
  $('#team-member-role').disabled = true;
  renderTeamBuilder();
};
/* The free-text field only applies to the Custom choice. */
$('#team-member-role-pick').onchange = () => {
  const custom = $('#team-member-role-pick').value === '__custom';
  $('#team-member-role').disabled = !custom;
  if (custom) $('#team-member-role').focus();
};
$('#btn-team-save').onclick = async () => {
  const name = $('#team-name').value.trim();
  if (!name) { $('#team-name').focus(); return; }
  if (!teamBuilderMembers.length) { showNotice('Add at least one member.'); return; }
  const patch = {
    name,
    mode: $('#team-mode').value,
    toolProtocol: $('#team-protocol').value,
    members: teamBuilderMembers,
    spreadConnections: $('#team-spread').checked,
  };
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
  const roster = (t.members || []).map(m => m.personaName).join(t.mode === 'chain' ? ' → ' : t.mode === 'links' ? ' ⇄ ' : ' · ');
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
  // The run shows up in the conversation captured above; otherwise its cards
  // render standalone until that bound conversation is selected again.
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

/* Deployed team tabs hang from the top of the chat. Member DOM stays alive
 * behind each tab, preserving tool results and unanswered questions. */
function startTeamRunView(teamRunId, team, task, agentId = currentAgent?.id) {
  if (activeTeamRun) {
    activeTeamRun.stop.remove();
    activeTeamRun.deck.finish('stopped');
  }
  const run = { teamRunId, team, agentId, cards: new Map(), subCards: new Map(), buffer: new Map() };
  activeTeamRun = run;
  invalidateComposerCatalog();
  // Endpoint/model validation can take long enough for the user to navigate.
  // Never mount conversation A's team deck inside conversation B. The retained
  // deck DOM moves into its bound chat through renderChatHistory when selected.
  const boundToCurrent = !!agentId && currentAgent?.id === agentId;
  const host = boundToCurrent ? chatLog : noAgent;
  if (!boundToCurrent) { noAgent.classList.remove('hidden'); agentView.classList.add('hidden'); }
  run.deck = window.ReachTeamDeck.create({ team, task });
  run.banner = run.deck.banner;
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
  const wrap = run.deck.element;
  wrap._teamDeck = run.deck;
  wrap.dataset.teamRunId = teamRunId;
  host.prepend(wrap);
  activeTeamRun.wrap = wrap;
  updateSendControl();
  (currentAgent ? chatScroll : host).scrollTop = 0;
}

function teamCard(index, name, model) {
  if (!activeTeamRun) return null;
  let card = activeTeamRun.cards.get(index);
  if (card) { activeTeamRun.deck.identify(card, name, model); return card; }
  card = document.createElement('div');
  card.className = 'member-card';
  card.innerHTML = `<div class="member-head"><div class="member-identity"><strong class="member-name"></strong><span class="member-model"></span></div><span class="member-state dim">starting…</span><span class="member-meta"></span></div>`
    + `<div class="member-body"></div>`;
  activeTeamRun.cards.set(index, card);
  addMemberControl(card, activeTeamRun, { index });
  activeTeamRun.deck.add(card, { name, model });
  return card;
}

/* Spawned workers join the same rail and retain their own independent panel. */
function subCard(agentId, name, model, depth) {
  if (!activeTeamRun) return null;
  const run = activeTeamRun;
  if (!run.subCards) run.subCards = new Map();
  let card = run.subCards.get(agentId);
  if (card) { run.deck.identify(card, name, model); return card; }
  card = document.createElement('div');
  card.className = 'member-card subagent depth-' + Math.min(Number(depth) || 1, 2);
  card.dataset.agentId = agentId;
  card.innerHTML = `<div class="member-head"><div class="member-identity"><strong class="member-name"></strong><span class="member-model"></span></div><span class="member-state dim">spawned…</span><span class="member-meta"></span></div>`
    + `<div class="member-body"></div>`;
  run.subCards.set(agentId, card);
  addMemberControl(card, run, { agentId });
  run.deck.add(card, { name, model, worker: true });
  return card;
}

/* Keep a short-lived completion marker; the tab's status icon now conveys
 * completion. No colored panel outline or layout-flushing border animation. */
function flashMemberCard(card) {
  if (!card) return;
  clearTimeout(card._finishTimer);
  card.classList.add('just-finished');
  card._finishTimer = setTimeout(() => card.classList.remove('just-finished'), 1100);
}

function addMemberControl(card, run, { index = null, agentId = null }) {
  const button = document.createElement('button');
  button.className = 'ghost small member-control';
  button.textContent = 'Stop';
  button.title = 'Stop this agent';
  button.onclick = async () => {
    if (button.disabled) return;
    button.disabled = true;
    try {
      const res = await reachApi.teams.controlMember(run.teamRunId, index, agentId, card.dataset.paused === 'true');
      if (!res.ok) showNotice(res.err);
    } catch (error) { showNotice(error.message); }
    finally { button.disabled = card.dataset.finished === 'true' || card.dataset.wakePending === 'true'; }
  };
  card.querySelector('.member-head').appendChild(button);
}

function setMemberControl(card, paused, finished = false) {
  card.dataset.wakePending = 'false';
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

// ---------- @ targets + / commands ----------
let composerCatalogAt = 0;
let composerCatalogKey = '';
let composerCatalogPromise = null;
let composerCatalogPromiseKey = '';

function commandOutput(text, isError = false) {
  const message = String(text || '');
  if (composerOutputContextAgentId !== null && (currentAgent?.id || '') !== composerOutputContextAgentId) {
    showNotice(message);
    return;
  }
  if (currentAgent && chatLog) {
    const bubble = appendChatMessage('system', message);
    bubble.classList.toggle('bad', isError);
  } else {
    showNotice(message);
  }
}

function invalidateComposerCatalog() {
  composerCatalogRevision++;
  composerCatalogAt = 0;
  composerCatalogKey = '';
  composerCatalogPromise = null;
  composerCatalogPromiseKey = '';
}

function targetCandidate(kind, id, label, detail, data = {}) {
  const priority = kind === 'team' ? 0 : kind === 'agent' || kind === 'persona' ? 2 : kind === 'model' ? 3 : 4;
  return {
    kind, id, label, detail, data, priority,
    insert: composerIntents.mentionInsert(kind, label, id),
    search: `${kind}:${label} ${label} ${id} ${detail}`,
  };
}

async function loadComposerModelItems() {
  let settings = null;
  try { settings = await reachApi.getSettings(); } catch { /* listModels reports the actionable error */ }
  const requestedKey = `${String(settings?.activeConnection || '')}|${String(settings?.endpoint || '')}`;
  if (composerModelsCache.key === requestedKey && composerModelsCache.at && Date.now() - composerModelsCache.at <= 30000) {
    return composerModelsCache.items;
  }
  try {
    const result = await reachApi.listModels();
    const items = result?.ok ? (result.models || []).map(id => ({
      kind: 'model', id, label: id, detail: `Model · ${result.connectionName || 'active connection'}`,
      priority: 3,
      data: { id }, insert: composerIntents.mentionInsert('model', id), search: `model:${id} ${id}`,
    })) : [];
    const resultKey = (result?.connectionId || result?.endpoint)
      ? `${String(result?.connectionId || '')}|${String(result?.endpoint || '')}`
      : requestedKey;
    composerModelsCache = { key: resultKey, at: Date.now(), items };
    return items;
  } catch {
    return [];
  }
}

async function buildComposerCatalog({ includeModels = true } = {}) {
  const liveRunId = activeTeamRun?.teamRunId || '';
  const [savedAgents, savedPersonas, savedTeams, live] = await Promise.all([
    reachApi.agents.list(),
    reachApi.personas.list(),
    reachApi.teams.list(),
    liveRunId ? reachApi.teams.members(liveRunId).catch(() => null) : Promise.resolve(null),
  ]);
  const items = [];
  if (currentAgent) {
    items.push({
      kind: 'current', id: currentAgent.id, label: currentAgent.name || 'Current chat',
      priority: -1,
      detail: `Current chat · ${currentAgent.model || 'default model'}`, data: currentAgent,
      insert: '@current', search: `current ${currentAgent.name || ''}`,
    });
  }
  items.push({
    kind: 'default', id: 'default', label: 'Default model', detail: 'Clear a model override and inherit the active default',
    priority: 8,
    insert: '@default', search: 'default inherit model reset', data: {},
  });
  const liveMembers = liveRunId && activeTeamRun?.teamRunId === liveRunId && live?.ok ? live.agents || [] : [];
  for (const member of liveMembers) {
    const scopedId = `${liveRunId}/${member.agentId}`;
    items.push(targetCandidate('team', scopedId, member.name,
      `${member.origin === 'spawned' ? 'Run-only worker' : 'Live member'} · ${member.status} · ${member.model || 'default model'}`,
      { ...member, teamRunId: liveRunId }));
  }
  for (const agent of Array.isArray(savedAgents) ? savedAgents : []) {
    const project = String(agent.dir || '').split(/[\\/]/).filter(Boolean).at(-1) || 'no project';
    items.push(targetCandidate('agent', agent.id, agent.name,
      `${agent.status || 'idle'} · ${agent.model || 'default model'} · ${project}`, agent));
  }
  for (const persona of Array.isArray(savedPersonas) ? savedPersonas : []) {
    items.push(targetCandidate('persona', persona.id, persona.name,
      `Custom agent · ${persona.model || 'default model'}${persona.connectionId ? ' · pinned connection' : ''}`, persona));
  }
  for (const team of Array.isArray(savedTeams) ? savedTeams : []) {
    items.push(targetCandidate('team-template', team.id, team.name,
      `Saved team · ${team.mode} · ${(team.members || []).length} member${(team.members || []).length === 1 ? '' : 's'}`, team));
  }
  if (includeModels) {
    items.push(...await loadComposerModelItems());
  }
  return items;
}

function closeComposerSuggestions() {
  composerSuggestionItems = [];
  composerSuggestionIndex = 0;
  composerSuggestionContext = null;
  composerSuggestionsEl.replaceChildren();
  composerSuggestionsEl.classList.add('hidden');
  composerInput.setAttribute('aria-expanded', 'false');
  composerInput.removeAttribute('aria-activedescendant');
  composerSuggestionStatus.textContent = '';
}

function setComposerSuggestionIndex(index) {
  if (!composerSuggestionItems.length) return;
  composerSuggestionIndex = (index + composerSuggestionItems.length) % composerSuggestionItems.length;
  const options = [...composerSuggestionsEl.querySelectorAll('[role=option]')];
  options.forEach((option, optionIndex) => option.setAttribute('aria-selected', String(optionIndex === composerSuggestionIndex)));
  const active = options[composerSuggestionIndex];
  if (active) {
    composerInput.setAttribute('aria-activedescendant', active.id);
    active.scrollIntoView({ block: 'nearest' });
    const item = composerSuggestionItems[composerSuggestionIndex];
    composerSuggestionStatus.textContent = `${item.label}. ${item.detail || item.kind}. ${composerSuggestionIndex + 1} of ${composerSuggestionItems.length}.`;
  }
}

function commitComposerSuggestion(index = composerSuggestionIndex) {
  const item = composerSuggestionItems[index];
  if (!item || !composerSuggestionContext) return false;
  const replacement = composerIntents.replaceCompletion(composerInput.value, composerSuggestionContext, item.insert);
  composerInput.value = replacement.text;
  composerInput.setSelectionRange(replacement.cursor, replacement.cursor);
  closeComposerSuggestions();
  composerInput.dispatchEvent(new Event('input', { bubbles: true }));
  composerInput.focus();
  return true;
}

function renderComposerSuggestions(context) {
  if (!context) { closeComposerSuggestions(); return; }
  const previousContext = composerSuggestionContext;
  const previousItem = composerSuggestionItems[composerSuggestionIndex];
  const preserveKey = previousContext?.mode === context.mode
    && previousContext.commandId === context.commandId
    && previousContext.start === context.start
    && previousContext.end === context.end
    && previousContext.query === context.query
    && previousItem
    ? `${previousItem.kind}:${previousItem.id || previousItem.insert || previousItem.label}`
    : '';
  composerSuggestionContext = context;
  const commandKinds = composerIntents.COMMANDS.find(command => command.id === context.commandId)?.targetKinds || null;
  const mentionCatalog = context.commandId && commandKinds
    ? composerCatalog.filter(item => commandKinds.includes(item.kind))
    : composerCatalog.filter(item => ['team', 'agent', 'persona', 'current', 'model', 'default'].includes(item.kind));
  const items = context.mode === 'command'
    ? composerIntents.commandCandidates(context.query)
    : composerIntents.filterCandidates(mentionCatalog, context.query, composerIntents.MAX_SUGGESTIONS);
  composerSuggestionItems = items;
  composerSuggestionIndex = preserveKey
    ? Math.max(0, items.findIndex(item => `${item.kind}:${item.id || item.insert || item.label}` === preserveKey))
    : 0;
  composerSuggestionsEl.replaceChildren();
  composerSuggestionsEl.classList.remove('hidden');
  composerInput.setAttribute('aria-expanded', 'true');
  if (!items.length) {
    const empty = document.createElement('div');
    empty.className = 'composer-suggestion-empty dim';
    empty.textContent = context.mode === 'command' ? 'No matching command. Type /help for the command guide.' : 'No matching target.';
    composerSuggestionsEl.appendChild(empty);
    composerInput.removeAttribute('aria-activedescendant');
    composerSuggestionStatus.textContent = empty.textContent;
    return;
  }
  items.forEach((item, index) => {
    const option = document.createElement('button');
    option.type = 'button';
    option.className = 'composer-suggestion';
    option.id = `composer-suggestion-${index}`;
    option.setAttribute('role', 'option');
    option.setAttribute('aria-selected', String(index === composerSuggestionIndex));
    const label = document.createElement('span');
    label.className = 'composer-suggestion-label';
    const kind = document.createElement('span');
    kind.className = 'composer-suggestion-kind';
    kind.textContent = item.kind === 'team-template' ? 'team' : item.kind;
    const name = document.createElement('span');
    name.textContent = item.label;
    label.append(kind, name);
    const detail = document.createElement('span');
    detail.className = 'composer-suggestion-detail';
    detail.textContent = item.detail || '';
    option.append(label, detail);
    option.onmousedown = event => event.preventDefault();
    option.onmouseenter = () => setComposerSuggestionIndex(index);
    option.onclick = () => commitComposerSuggestion(index);
    composerSuggestionsEl.appendChild(option);
  });
  setComposerSuggestionIndex(composerSuggestionIndex);
}

async function refreshComposerSuggestions() {
  const context = composerIntents.completionContext(composerInput.value, composerInput.selectionStart);
  if (!context) { closeComposerSuggestions(); return; }
  if (context.mode === 'command') { renderComposerSuggestions(context); return; }
  const key = `${currentAgent?.id || ''}:${activeTeamRun?.teamRunId || ''}`;
  if (composerCatalogKey === key && Date.now() - composerCatalogAt < 2500 && composerCatalog.length) {
    renderComposerSuggestions(context);
    return;
  }
  const revision = ++composerCatalogRevision;
  composerSuggestionStatus.textContent = 'Loading targets…';
  try {
    // Local targets are useful immediately. Provider model discovery can take
    // seconds, so it enriches the still-open menu without blocking the first
    // usable result.
    if (!composerCatalogPromise || composerCatalogPromiseKey !== key) {
      composerCatalogPromiseKey = key;
      composerCatalogPromise = buildComposerCatalog({ includeModels: false }).finally(() => {
        if (composerCatalogPromiseKey === key) {
          composerCatalogPromise = null;
          composerCatalogPromiseKey = '';
        }
      });
    }
    const next = await composerCatalogPromise;
    if (revision !== composerCatalogRevision) return;
    composerCatalog = next;
    composerCatalogAt = Date.now();
    composerCatalogKey = key;
    let freshContext = composerIntents.completionContext(composerInput.value, composerInput.selectionStart);
    if (freshContext?.mode === 'mention') renderComposerSuggestions(freshContext);

    const modelItems = await loadComposerModelItems();
    if (revision !== composerCatalogRevision) return;
    composerCatalog = [...next, ...modelItems];
    composerCatalogAt = Date.now();
    freshContext = composerIntents.completionContext(composerInput.value, composerInput.selectionStart);
    if (freshContext?.mode === 'mention') renderComposerSuggestions(freshContext);
  } catch (error) {
    if (revision === composerCatalogRevision) composerSuggestionStatus.textContent = `Could not load targets: ${error.message}`;
  }
}

composerInput.addEventListener('input', () => {
  if (composerMentionRetry && composerInput.value !== composerMentionRetry.text) composerMentionRetry = null;
  refreshComposerSuggestions();
  updateSendControl();
});
composerInput.addEventListener('click', refreshComposerSuggestions);
composerInput.addEventListener('keyup', event => {
  if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') refreshComposerSuggestions();
});
composerInput.addEventListener('blur', closeComposerSuggestions);
composerInput.addEventListener('keydown', event => {
  if (event.isComposing || event.keyCode === 229 || composerSuggestionsEl.classList.contains('hidden')) return;
  if (event.key === 'ArrowDown') { event.preventDefault(); setComposerSuggestionIndex(composerSuggestionIndex + 1); }
  else if (event.key === 'ArrowUp') { event.preventDefault(); setComposerSuggestionIndex(composerSuggestionIndex - 1); }
  else if (event.key === 'Home') { event.preventDefault(); setComposerSuggestionIndex(0); }
  else if (event.key === 'End') { event.preventDefault(); setComposerSuggestionIndex(composerSuggestionItems.length - 1); }
  else if ((event.key === 'Enter' && !event.ctrlKey && !event.metaKey) || (event.key === 'Tab' && !event.shiftKey)) {
    if (composerSuggestionItems.length) { event.preventDefault(); commitComposerSuggestion(); }
    else closeComposerSuggestions();
  } else if (event.key === 'Escape') { event.preventDefault(); closeComposerSuggestions(); }
});
document.addEventListener('mousedown', event => {
  if (!composerSuggestionsEl.contains(event.target) && event.target !== composerInput) closeComposerSuggestions();
});

async function freshTargetCatalog(includeModels = false) {
  // Submission never trusts a possibly stale completion row. Re-read the
  // stores/run and resolve the stable id again immediately before IPC.
  return buildComposerCatalog({ includeModels });
}

function resolveTargetMention(mention, catalog, allowedKinds = null, contextAgent = null) {
  if (!mention || mention.error) throw new Error('Choose a valid @ target.');
  if (mention.kind === 'current') {
    if (allowedKinds && !allowedKinds.includes('current')) throw new Error('@current is not valid for this command.');
    const selected = contextAgent || currentAgent;
    if (!selected?.id) throw new Error('Open a conversation before using @current.');
    const fresh = catalog.find(item => (item.kind === 'agent' || item.kind === 'current') && item.id === selected.id);
    if (!fresh) throw new Error('The conversation that was current when you pressed Send no longer exists.');
    return { kind: 'current', id: selected.id, label: fresh.label || selected.name || 'Current chat', data: fresh.data || selected };
  }
  if (mention.kind === 'default') {
    if (allowedKinds && !allowedKinds.includes('default')) throw new Error('@default is not valid for this command.');
    return { kind: 'default', id: 'default', label: 'Default model', data: {} };
  }
  if (mention.kind === 'model') {
    if (allowedKinds && !allowedKinds.includes('model')) throw new Error('@model is not valid for this command.');
    return { kind: 'model', id: mention.selector, label: mention.selector, data: { id: mention.selector } };
  }
  const allowed = allowedKinds || (mention.kind === 'any' ? ['team', 'agent', 'persona'] : [mention.kind]);
  const kinds = mention.kind === 'any' ? allowed : allowed.filter(kind => kind === mention.kind);
  if (!kinds.length) throw new Error(`@${mention.kind} is not valid for this command.`);
  let matches = catalog.filter(item => kinds.includes(item.kind));
  if (mention.id) {
    matches = matches.filter(item => item.id === mention.id);
    if (!matches.length) throw new Error(`The selected ${mention.kind} no longer exists. Open the @ menu and choose it again.`);
  } else {
    const wanted = String(mention.selector || '').toLocaleLowerCase();
    matches = matches.filter(item => item.id.toLocaleLowerCase() === wanted || item.label.toLocaleLowerCase() === wanted);
    if (!matches.length) throw new Error(`No ${kinds.join(' or ')} matches “${mention.selector}”. Open the @ menu to see available targets.`);
    if (matches.length > 1) {
      const choices = matches.slice(0, 6).map(item => `${item.kind}: ${item.label}`).join(', ');
      throw new Error(`“${mention.selector}” is ambiguous (${choices}). Choose a specific row from the @ menu.`);
    }
  }
  return matches[0];
}

function parseTargetToken(value) {
  const mention = composerIntents.parseMentionValue(value);
  if (!mention || mention.error) throw new Error('The first argument must be an @ target chosen from the menu.');
  return mention;
}

function sameAttachments(before, after) {
  return before.length === after.length && before.every((item, index) => item.attachmentId === after[index]?.attachmentId);
}

function composerAttachmentKey(items) {
  return JSON.stringify((Array.isArray(items) ? items : []).map(item => String(item?.attachmentId || '')));
}

function clearSuccessfulComposer(snapshot, { attachments = false, allowContextChange = false } = {}) {
  // An async command must never erase text the user typed while it was in
  // flight or a draft now owned by another selected chat. Clear only the exact
  // snapshot that was accepted by main.
  const sameContext = allowContextChange || (currentAgent?.id || '') === (snapshot.contextAgentId || '');
  if (sameContext && composerInput.value === snapshot.text) {
    composerInput.value = '';
    composerInput.dispatchEvent(new Event('input', { bubbles: true }));
  }
  if (sameContext && attachments && sameAttachments(snapshot.attachments, composerAttachments)) {
    composerAttachments = [];
    renderComposerAttachments();
  }
}

async function setAgentModel(agentId, model) {
  const result = await reachApi.agents.update(agentId, { model });
  if (!result.ok) throw new Error(result.err);
  if (currentAgent?.id === agentId) {
    currentAgent = { ...currentAgent, ...result.agent };
    agentMetaEl.textContent = `${currentAgent.dir} · ${currentAgent.model || 'default model'}${currentAgent.parentChatId ? ' · ⑂ branch' : ''}`;
    $('#agent-info-summary-model').textContent = currentAgent.model || 'Default model';
    window.ReachWorkspace?.sync();
  }
  return result.agent;
}

async function dispatchToTargets(targets, message, {
  modelDirective = null,
  attachments = [],
  displayText = message,
  retryState = null,
  fallbackTarget = null,
  projectDir = '',
} = {}) {
  const unique = [];
  const seen = new Map();
  for (const target of targets) {
    const key = composerIntents.deliveryKey(target);
    if (!seen.has(key)) {
      seen.set(key, unique.length);
      unique.push(target);
    } else if (target.kind === 'current' && unique[seen.get(key)]?.kind === 'agent') {
      // Preserve current-chat attachment handling and local echo if aliases for
      // the same destination were both written in the leading mention block.
      unique[seen.get(key)] = target;
    }
  }
  if (!unique.length) {
    const fallback = fallbackTarget || (currentAgent
      ? { kind: 'current', id: currentAgent.id, label: currentAgent.name, data: currentAgent }
      : null);
    if (!fallback) throw new Error('Choose an @ target or open a conversation.');
    unique.push(fallback);
  }
  if (unique.length > 8) throw new Error('A single message can target at most 8 agents.');
  const deliveryKey = composerIntents.deliveryKey;
  const pendingTargets = retryState ? unique.filter(target => !retryState.delivered.has(deliveryKey(target))) : unique;
  if (attachments.length && (unique.length !== 1 || unique[0].kind !== 'current')) {
    throw new Error('Attachments stay with the current conversation. Remove them before messaging another agent.');
  }
  if (!String(message || '').trim() && modelDirective === null) throw new Error('A message is required.');
  if (modelDirective !== null && pendingTargets.some(target => target.kind === 'team')) {
    throw new Error('A live team member model cannot be changed mid-run. Add a run-only agent with --model instead.');
  }
  if (modelDirective !== null && String(message || '').trim()) {
    const busyTarget = pendingTargets.find(target => (target.kind === 'agent' || target.kind === 'current') && (
      runningAgentIds.has(target.id)
      || (target.kind === 'current' && currentAgent?.id === target.id && agentRunning)
      || target.data?.status === 'running'
      || target.data?.runState?.status === 'running'
    ));
    if (busyTarget) throw new Error(`${busyTarget.label} is already running. Set its model now, then send after the current run finishes.`);
  }

  const acknowledgements = [];
  for (let target of unique) {
    const originalDeliveryKey = deliveryKey(target);
    if (retryState?.delivered.has(originalDeliveryKey)) {
      acknowledgements.push(`${target.label}: already accepted`);
      continue;
    }
    if (target.kind === 'team') {
      if (!String(message || '').trim()) throw new Error('A team message is required.');
      if (!activeTeamRun || target.data?.teamRunId !== activeTeamRun.teamRunId) {
        throw new Error('That @team tag belongs to an earlier run. Choose the member again from the current @ menu.');
      }
      const result = await reachApi.teams.message(target.data.teamRunId, target.data.agentId, message);
      if (!result.ok) throw new Error(result.err);
      retryState?.delivered.add(originalDeliveryKey);
      acknowledgements.push(`${result.name || target.label}: ${result.delivered || 'delivered'}`);
      continue;
    }

    let agentId = target.id;
    let label = target.label;
    let createdForPersona = false;
    if (target.kind === 'persona') {
      const persona = target.data;
      const dir = projectDir || currentAgent?.dir || agentProjectDir;
      if (!dir) throw new Error('Select a project before starting a custom agent independently.');
      const chosenModel = modelDirective === '' ? '' : modelDirective || persona.model || '';
      const created = await reachApi.agents.create({
        dir,
        personaId: persona.id,
        ...(modelDirective === null ? {} : { modelOverride: chosenModel }),
      });
      if (!created.ok) throw new Error(created.err);
      agentId = created.agent.id;
      label = created.agent.name;
      createdForPersona = true;
      target = { ...target, kind: 'agent', id: agentId, data: created.agent };
    }
    if (target.kind !== 'agent' && target.kind !== 'current') throw new Error(`Cannot message @${target.kind} directly.`);
    try {
      if (modelDirective !== null) await setAgentModel(agentId, modelDirective);
      if (String(message || '').trim() || attachments.length) {
        const result = await reachApi.agents.send(agentId, message, target.kind === 'current' ? attachments.map(file => file.attachmentId) : []);
        if (!result.ok) throw new Error(result.err);
        if (target.kind === 'current' && currentAgent?.id === agentId) {
          const visible = [displayText, attachments.length ? `Attachments: ${attachments.map(file => file.name).join(', ')}` : ''].filter(Boolean).join('\n\n');
          appendChatMessage('user', visible);
          agentRunning = true;
          updateStatusPill('running');
        }
      }
      retryState?.delivered.add(originalDeliveryKey);
    } catch (error) {
      // Materialization and first dispatch are one user operation. If the new
      // chat never accepted its first message, remove that empty shell so a
      // safe retry cannot duplicate the custom agent.
      if (createdForPersona) await reachApi.agents.delete(agentId).catch(() => {});
      throw error;
    }
    acknowledgements.push(`${label}: ${String(message || '').trim() ? 'message accepted' : 'model updated'}`);
  }
  await loadAgentTree();
  invalidateComposerCatalog();
  return acknowledgements;
}

function liveCardForTarget(target) {
  if (!activeTeamRun || target?.kind !== 'team') return null;
  const agentId = target.data?.agentId;
  if (!agentId) return null;
  if (activeTeamRun.subCards?.has(agentId)) return activeTeamRun.subCards.get(agentId);
  const index = memberIndexFromAgentId(agentId);
  return index === null ? null : activeTeamRun.cards.get(index) || null;
}

function selectedLiveMember(catalog) {
  if (!activeTeamRun) return null;
  for (const [index, card] of activeTeamRun.cards) {
    if (!card.hidden) {
      const agentId = card.dataset.agentId || catalog.find(item => item.kind === 'team' && item.data?.agentId?.startsWith(`m${index}-`))?.data?.agentId;
      if (agentId) return catalog.find(item => item.kind === 'team' && item.data?.agentId === agentId) || null;
    }
  }
  for (const [agentId, card] of activeTeamRun.subCards || []) {
    if (!card.hidden) return catalog.find(item => item.kind === 'team' && item.data?.agentId === agentId) || null;
  }
  return null;
}

function selectedLiveMemberAgentId() {
  if (!activeTeamRun) return '';
  for (const card of activeTeamRun.cards.values()) {
    if (!card.hidden && card.dataset.agentId) return card.dataset.agentId;
  }
  for (const [agentId, card] of activeTeamRun.subCards || []) {
    if (!card.hidden) return agentId;
  }
  return '';
}

function submittedLiveMember(catalog, snapshot) {
  if (!snapshot?.teamRunId || !snapshot?.selectedTeamAgentId) return null;
  return catalog.find(item => item.kind === 'team'
    && item.data?.teamRunId === snapshot.teamRunId
    && item.data?.agentId === snapshot.selectedTeamAgentId) || null;
}

function formatBytes(value) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return 'unknown';
  const n = Number(value);
  return n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(1)} GB` : `${(n / 1024 ** 2).toFixed(1)} MB`;
}

function helpText(topic = '') {
  const query = String(topic || '').trim().toLowerCase().replace(/^\//, '');
  const commands = query
    ? composerIntents.COMMANDS.filter(command => `${command.path} ${(command.aliases || []).join(' ')} ${command.id}`.toLowerCase().includes(query))
    : composerIntents.COMMANDS;
  if (!commands.length) return `No command matches “${topic}”. Type /help for every command.`;
  return ['Composer commands', ...commands.map(command => `${command.usage}\n  ${command.description}`), '', 'Tip: start a draft with @ to route it to a live member, saved chat, custom agent, or model. Menu choices carry stable IDs even when names are duplicated.'].join('\n');
}

async function executeComposerCommand(parsed, snapshot = {}) {
  const remainder = parsed.remainder || '';
  if (parsed.command?.noArgs && remainder.trim()) throw new Error(`Usage: ${parsed.command.usage}`);
  const submittedAgent = snapshot.contextAgentId ? {
    id: snapshot.contextAgentId,
    name: snapshot.contextAgentName || 'Current chat',
    dir: snapshot.contextProjectDir || '',
  } : null;
  const catalogCommands = new Set([
    'message', 'reply', 'answer', 'agent-message', 'team-message', 'team-add', 'team-run',
    'team-list', 'agent-open', 'agent-list', 'agent-status',
  ]);
  const catalog = catalogCommands.has(parsed.id) ? await freshTargetCatalog(false) : [];
  switch (parsed.id) {
    case 'help':
      commandOutput(helpText(remainder));
      return;
    case 'say': {
      if (!submittedAgent) throw new Error('Open a conversation first.');
      if (!remainder.trim()) throw new Error(`Usage: ${parsed.command.usage}`);
      await dispatchToTargets(
        [{ kind: 'current', id: submittedAgent.id, label: submittedAgent.name, data: submittedAgent }],
        remainder,
        { displayText: remainder, projectDir: snapshot.contextProjectDir },
      );
      return;
    }
    case 'message':
    case 'agent-message':
    case 'team-message': {
      const split = composerIntents.takeTargetAndMessage(remainder, ['model']);
      if (!split.target) throw new Error(`Usage: ${parsed.command.usage}`);
      const allowed = parsed.id === 'team-message' ? ['team'] : parsed.id === 'agent-message' ? ['agent', 'persona', 'current'] : ['team', 'agent', 'persona', 'current'];
      const target = resolveTargetMention(parseTargetToken(split.target), catalog, allowed, submittedAgent);
      if (!split.message.trim()) throw new Error('A message is required after the target.');
      const model = composerIntents.optionValue(split.options, 'model');
      const ack = await dispatchToTargets([target], split.message, { modelDirective: model, projectDir: snapshot.contextProjectDir });
      commandOutput(`✓ ${ack.join(' · ')}`);
      return;
    }
    case 'reply': {
      let message = remainder;
      let target = null;
      const tokens = composerIntents.tokenize(remainder);
      if (tokens[0]?.value.startsWith('@')) {
        target = resolveTargetMention(parseTargetToken(tokens[0].value), catalog, ['team']);
        message = remainder.slice(tokens[0].end).replace(/^\s+/, '');
      } else target = submittedLiveMember(catalog, snapshot);
      message = composerIntents.stripDelimiter(message);
      if (!target) throw new Error('Select a live team tab or name one with @team.');
      if (!message.trim()) throw new Error('A reply is required.');
      if (liveCardForTarget(target)?.querySelector('.member-ask')) {
        throw new Error(`${target.label} is waiting for a structured answer. Use /answer so the paused turn resumes.`);
      }
      const ack = await dispatchToTargets([target], message);
      commandOutput(`✓ ${ack.join(' · ')}`);
      return;
    }
    case 'answer': {
      let message = remainder;
      let target = null;
      const tokens = composerIntents.tokenize(remainder);
      if (tokens[0]?.value.startsWith('@')) {
        target = resolveTargetMention(parseTargetToken(tokens[0].value), catalog, ['team']);
        message = remainder.slice(tokens[0].end).replace(/^\s+/, '');
      } else target = submittedLiveMember(catalog, snapshot);
      message = composerIntents.stripDelimiter(message);
      if (!target) throw new Error('Select the member that is waiting, or name one with @team.');
      if (!message.trim()) throw new Error('An answer is required.');
      if (!activeTeamRun || target.data?.teamRunId !== activeTeamRun.teamRunId) throw new Error('That member belongs to an earlier team run.');
      const result = await reachApi.teams.answerMember(target.data.teamRunId, target.data.agentId, message);
      if (!result.ok) throw new Error(result.err);
      const card = liveCardForTarget(target);
      card?.querySelector('.member-ask')?.remove();
      if (card) {
        card.classList.remove('waiting');
        card.querySelector('.member-state').textContent = 'answer delivered · resuming…';
      }
      commandOutput(`✓ Answer delivered to ${target.label}.`);
      return;
    }
    case 'team-add': {
      if (!snapshot.teamRunId) throw new Error('Start a team before adding a run-only agent.');
      const split = composerIntents.takeTargetAndMessage(remainder, ['model', 'role']);
      if (!split.target) throw new Error(`Usage: ${parsed.command.usage}`);
      const target = resolveTargetMention(parseTargetToken(split.target), catalog, ['persona', 'agent']);
      const model = composerIntents.optionValue(split.options, 'model');
      const role = composerIntents.optionValue(split.options, 'role');
      const result = await reachApi.teams.addAgent(snapshot.teamRunId, {
        ...(target.kind === 'persona' ? { personaId: target.id } : { agentId: target.id }),
        model: model || '',
        role: role || '',
        task: split.message,
      });
      if (!result.ok) throw new Error(result.err);
      invalidateComposerCatalog();
      commandOutput(`✓ ${result.name} joined ${snapshot.teamName || 'the team'} for this run only${result.model ? ` on ${result.model}` : ''}. ${result.note || ''}`);
      return;
    }
    case 'team-run': {
      const split = composerIntents.takeTargetAndMessage(remainder, []);
      if (!split.target || !split.message.trim()) throw new Error(`Usage: ${parsed.command.usage}`);
      const target = resolveTargetMention(parseTargetToken(split.target), catalog, ['team-template']);
      if (activeTeamRun && !activeTeamRun.paused) throw new Error('Pause or finish the active team before dispatching another.');
      teamDispatching = true;
      try {
        const result = await reachApi.teams.run(target.id, split.message, snapshot.contextProjectDir, snapshot.contextAgentId || null);
        if (!result.ok) throw new Error(result.err);
        await showTab('agents');
        startTeamRunView(result.teamRunId, target.data, split.message, snapshot.contextAgentId || null);
        for (const event of pendingTeamEvents) handleTeamEvent(event);
        pendingTeamEvents = [];
      } finally { teamDispatching = false; }
      commandOutput(`✓ ${target.label} dispatched.`);
      return;
    }
    case 'team-list': {
      const rows = catalog.filter(item => item.kind === 'team-template');
      commandOutput(rows.length ? ['Saved teams', ...rows.map(item => `• ${item.label} — ${item.detail}`)].join('\n') : 'No saved teams. Create one on the Create page.');
      return;
    }
    case 'team-status': {
      if (!snapshot.teamRunId) { commandOutput('No team is running.'); return; }
      const status = await reachApi.teams.members(snapshot.teamRunId);
      if (!status.ok) throw new Error(status.err);
      commandOutput([`${status.team} · ${status.mode} · ${status.paused ? 'paused' : 'active'} · ${status.count}/${status.maxAgents} agents`,
        ...(status.agents || []).map(member => `• ${member.name} [${member.origin}] — ${member.status} · ${member.model || 'default model'} · ${member.messagesReceived || 0} received${member.inbox ? ` · ${member.inbox} queued` : ''}`),
      ].join('\n'));
      return;
    }
    case 'team-pause':
    case 'team-stop': {
      if (!snapshot.teamRunId) throw new Error('No team is running.');
      const result = await reachApi.teams.stop(snapshot.teamRunId);
      if (!result.ok) throw new Error(result.err);
      commandOutput('✓ Team pause requested; its context is preserved.');
      return;
    }
    case 'team-resume': {
      if (!snapshot.teamRunId) throw new Error('No team is available to resume.');
      const result = await reachApi.teams.start(snapshot.teamRunId);
      if (!result.ok) throw new Error(result.err);
      commandOutput('✓ Team resume requested.');
      return;
    }
    case 'agent-new': {
      const split = composerIntents.takeTargetAndMessage(remainder, ['model']);
      if (!split.target) throw new Error(`Usage: ${parsed.command.usage}`);
      const dir = snapshot.contextProjectDir;
      if (!dir) throw new Error('Select a project first.');
      const model = composerIntents.optionValue(split.options, 'model');
      const result = await reachApi.agents.create(split.target, dir, model || '');
      if (!result.ok) throw new Error(result.err);
      if (split.message.trim()) {
        try {
          const sent = await reachApi.agents.send(result.agent.id, split.message);
          if (!sent.ok) throw new Error(sent.err);
        } catch (error) {
          await reachApi.agents.delete(result.agent.id).catch(() => {});
          throw error;
        }
      }
      invalidateComposerCatalog();
      await loadAgentTree();
      commandOutput(`✓ ${result.agent.name} created${split.message.trim() ? ' and started independently' : ''}. Use /agent open to switch to it.`);
      return;
    }
    case 'agent-open': {
      const token = composerIntents.singleArgument(remainder, parsed.command.usage);
      const target = resolveTargetMention(parseTargetToken(token.value), catalog, ['agent']);
      await selectAgent({ id: target.id });
      commandOutput(`Opened ${target.label}.`);
      return { allowContextChange: true };
    }
    case 'agent-list': {
      const rows = catalog.filter(item => item.kind === 'agent' || item.kind === 'persona');
      commandOutput(rows.length ? ['Agents', ...rows.map(item => `• ${item.label} [${item.kind}] — ${item.detail}`)].join('\n') : 'No saved conversations or custom agents.');
      return;
    }
    case 'agent-status': {
      const token = composerIntents.singleArgument(remainder, parsed.command.usage, { optional: true });
      let target;
      if (token) target = resolveTargetMention(parseTargetToken(token.value), catalog, ['agent', 'current'], submittedAgent);
      else if (submittedAgent) target = { kind: 'current', id: submittedAgent.id, label: submittedAgent.name };
      else throw new Error('Open or name an agent first.');
      const agent = await reachApi.agents.get(target.id);
      if (!agent) throw new Error('That conversation no longer exists.');
      commandOutput(`${agent.name}\nStatus: ${agent.runState?.status || 'idle'}\nModel: ${agent.model || 'default model'}\nMessages: ${(agent.messages || []).length}\nProject: ${agent.dir}`);
      return;
    }
    case 'model-current': {
      const settings = await reachApi.getSettings();
      const agent = submittedAgent ? await reachApi.agents.get(submittedAgent.id) : null;
      commandOutput(`Conversation: ${agent?.model || 'inherits default'}\nActive default: ${settings.model || 'not set'}\nConnection: ${settings.endpoint || 'not set'}`);
      return;
    }
    case 'model-list': {
      const result = await reachApi.listModels();
      if (!result.ok) throw new Error(result.err);
      const filter = remainder.trim().toLowerCase();
      const models = (result.models || []).filter(model => !filter || model.toLowerCase().includes(filter));
      commandOutput([`Models on ${result.connectionName || 'active connection'} (${models.length})`, ...models.slice(0, 100).map(model => `• ${model}`)].join('\n'));
      return;
    }
    case 'model-use': {
      if (!submittedAgent) throw new Error('Open a conversation first.');
      const token = composerIntents.singleArgument(remainder, parsed.command.usage);
      const modelId = composerIntents.modelIdFromToken(token?.raw || token?.value);
      if (!modelId) throw new Error(`Usage: ${parsed.command.usage}`);
      await setAgentModel(submittedAgent.id, modelId);
      commandOutput(`✓ ${submittedAgent.name} will use ${modelId}.`);
      return;
    }
    case 'model-reset': {
      if (!submittedAgent) throw new Error('Open a conversation first.');
      await setAgentModel(submittedAgent.id, '');
      commandOutput(`✓ ${submittedAgent.name} now inherits the active default model.`);
      return;
    }
    case 'model-default': {
      const token = composerIntents.singleArgument(remainder, parsed.command.usage);
      const modelId = composerIntents.modelIdFromToken(token?.raw || token?.value);
      if (!modelId) throw new Error(`Usage: ${parsed.command.usage}`);
      await reachApi.saveSettings({ model: modelId === 'default' ? '' : modelId });
      composerModelsCache = { key: '', at: 0, items: [] };
      commandOutput(`✓ Active connection default model set to ${modelId === 'default' ? 'automatic' : modelId}.`);
      return;
    }
    case 'telemetry-summary':
    case 'telemetry-cpu':
    case 'telemetry-gpu':
    case 'telemetry-memory':
    case 'telemetry-io':
    case 'telemetry-models':
    case 'telemetry-processes': {
      const sample = await reachApi.telemetry.sample();
      if (parsed.id === 'telemetry-models') {
        commandOutput([`Models in memory · sampled ${new Date(sample.at).toLocaleTimeString()}`,
          ...(sample.models || []).map(model => `• ${model.name} — ${model.provider}${model.local ? ' · local' : ' · remote'} · ${model.placement} · ${formatBytes(model.bytes)}`),
          ...((sample.models || []).length ? [] : ['No loaded models were reported by connected sources.']),
        ].filter(Boolean).join('\n'));
      } else if (parsed.id === 'telemetry-processes') {
        commandOutput([`Largest processes · sampled ${new Date(sample.at).toLocaleTimeString()}`,
          ...(sample.processes || []).slice(0, 15).map(process => `• ${process.name} (PID ${process.pid}) — ${formatBytes(process.ram)} RAM · ${process.cpu == null ? 'unknown' : Math.round(process.cpu) + '%'} CPU`),
        ].join('\n'));
      } else if (parsed.id === 'telemetry-cpu') {
        commandOutput(`CPU · sampled ${new Date(sample.at).toLocaleTimeString()}\n${sample.cpu?.name || 'unknown'}\nUtilization: ${sample.cpu?.percent == null ? 'unknown' : Math.round(sample.cpu.percent) + '%'}\nThreads: ${sample.cpu?.threads ?? 'unknown'}`);
      } else if (parsed.id === 'telemetry-gpu') {
        commandOutput(`GPU · sampled ${new Date(sample.at).toLocaleTimeString()}\n${sample.gpu?.name || 'unknown'}\nUtilization: ${sample.gpu?.utilization == null ? 'unknown' : Math.round(sample.gpu.utilization) + '%'}\nDedicated: ${formatBytes(sample.gpu?.dedicated)} / ${formatBytes(sample.gpu?.total)}\nShared: ${formatBytes(sample.gpu?.shared)}\nSource: ${sample.gpu?.source || 'unknown'}`);
      } else if (parsed.id === 'telemetry-memory') {
        commandOutput(`Memory · sampled ${new Date(sample.at).toLocaleTimeString()}\nRAM: ${formatBytes(sample.ram?.used)} / ${formatBytes(sample.ram?.total)} · ${formatBytes(sample.ram?.available)} available\nVRAM: ${formatBytes(sample.gpu?.dedicated)} / ${formatBytes(sample.gpu?.total)}\nLoaded models reported: ${(sample.models || []).length}`);
      } else if (parsed.id === 'telemetry-io') {
        commandOutput(`I/O · sampled ${new Date(sample.at).toLocaleTimeString()}\nNetwork: ↓ ${formatBytes(sample.network?.receive)}/s · ↑ ${formatBytes(sample.network?.send)}/s\nDisk: read ${formatBytes(sample.disk?.read)}/s · write ${formatBytes(sample.disk?.write)}/s`);
      } else {
        commandOutput([`System telemetry · sampled ${new Date(sample.at).toLocaleTimeString()}`,
          `CPU: ${sample.cpu?.percent == null ? 'unknown' : Math.round(sample.cpu.percent) + '%'} · ${sample.cpu?.name || 'unknown'}`,
          `GPU: ${sample.gpu?.utilization == null ? 'unknown' : Math.round(sample.gpu.utilization) + '%'} · ${sample.gpu?.name || 'unknown'}`,
          `RAM: ${formatBytes(sample.ram?.used)} / ${formatBytes(sample.ram?.total)} · ${formatBytes(sample.ram?.available)} available`,
          `VRAM: ${formatBytes(sample.gpu?.dedicated)} / ${formatBytes(sample.gpu?.total)}`,
          `Models reported: ${(sample.models || []).length} · Processes sampled: ${(sample.processes || []).length}`,
        ].join('\n'));
      }
      return;
    }
    case 'telemetry-sources': {
      const sources = await reachApi.telemetry.sources();
      commandOutput(['Telemetry sources', ...(sources || []).map(source => `• ${source.type} — ${source.enabled === false ? 'disabled' : 'enabled'} · ${source.url}`)].join('\n'));
      return;
    }
    case 'stop-all':
      await stopAllRuns();
      commandOutput('✓ Stop requested for active conversations; active teams are paused with context preserved.');
      return;
    default:
      throw new Error(`Command not implemented: ${parsed.command?.path || parsed.id}. Type /help.`);
  }
}

async function executeMentionRouting(parsed, snapshot, retryState = null) {
  const catalog = await freshTargetCatalog(false);
  const targets = [];
  let modelDirective = null;
  const submittedAgent = snapshot.contextAgentId ? {
    id: snapshot.contextAgentId,
    name: snapshot.contextAgentName || 'Current chat',
    dir: snapshot.contextProjectDir || '',
  } : null;
  for (const [mentionIndex, mention] of parsed.mentions.entries()) {
    const priorRoute = retryState?.routes?.[mentionIndex] || null;
    const priorKey = priorRoute ? composerIntents.deliveryKey(priorRoute) : '';
    // A retry of the exact unchanged draft must not depend on a target that
    // already accepted the message still being present in the live catalog.
    // Reuse only its inert identity here; dispatchToTargets skips it before
    // consulting mutable target data. Pending targets are always revalidated.
    if (priorRoute && retryState.delivered.has(priorKey)) {
      targets.push({ kind: priorRoute.kind, id: priorRoute.id, label: priorRoute.label, data: {} });
      continue;
    }
    const resolved = resolveTargetMention(mention, catalog, null, submittedAgent);
    if (resolved.kind === 'model') {
      if (modelDirective !== null) throw new Error('Use only one @model or @default directive.');
      modelDirective = resolved.id;
    } else if (resolved.kind === 'default') {
      if (modelDirective !== null) throw new Error('Use only one @model or @default directive.');
      modelDirective = '';
    } else {
      const resolvedKey = composerIntents.deliveryKey(resolved);
      if (priorRoute && priorKey !== resolvedKey) {
        throw new Error(`${priorRoute.label || 'A target'} changed while the first delivery was in flight. Edit the draft or choose the target again.`);
      }
      if (retryState && !priorRoute) {
        retryState.routes[mentionIndex] = { kind: resolved.kind, id: resolved.id, label: resolved.label };
      }
      targets.push(resolved);
    }
  }
  const fallbackTarget = targets.length || !submittedAgent
    ? null
    : resolveTargetMention({ kind: 'current' }, catalog, null, submittedAgent);
  const acknowledgements = await dispatchToTargets(targets, parsed.body, {
    modelDirective,
    attachments: snapshot.attachments,
    displayText: parsed.body,
    retryState,
    fallbackTarget,
    projectDir: snapshot.contextProjectDir,
  });
  const external = targets.some(target => target.kind !== 'current');
  if (external || !parsed.body.trim()) commandOutput(`✓ ${acknowledgements.join(' · ')}`);
}

function memberIndexFromAgentId(agentId) {
  const match = /^m(\d+)-/.exec(String(agentId || ''));
  return match ? Number(match[1]) : null;
}

function updateCrewComms(card, changes = {}) {
  if (!card) return;
  const counts = card._crewComms || { sent: 0, received: 0, inbox: 0 };
  Object.assign(counts, changes);
  card._crewComms = counts;
  card.dataset.crewMeta = `${counts.sent} sent · ${counts.received} received${counts.inbox ? ` · ${counts.inbox} queued` : ''}`;
  card._teamDeck?.update(card, card._teamActivity);
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
  if (!card.hidden) input.focus();
  return ask;
}

function handleTeamEvent(ev) {
  // A paused run may still be displayed while main tears it down and starts the
  // replacement. Buffer events for the not-yet-installed run instead of
  // dropping its fast start/done sequence against the old run id.
  if (teamDispatching && (!activeTeamRun || ev.teamRunId !== activeTeamRun.teamRunId)) {
    pendingTeamEvents.push(ev);
    return;
  }
  if (!activeTeamRun || ev.teamRunId !== activeTeamRun.teamRunId) return;
  const run = activeTeamRun;
  // Nurse telemetry is coordination metadata, not provider/tool activity.
  // Keep it out of member construction and the activity reducer so it cannot
  // fabricate a worker or make a genuinely silent request look active.
  if (ev.type === 'nurse') {
    run.deck.noteNurse(ev);
    return;
  }
  const activityCard = ev.type === 'subagent' && ev.agentId ? subCard(ev.agentId, ev.name, ev.model || '', ev.depth) : ev.index !== undefined ? teamCard(ev.index, ev.name, ev.model) : null;
  window.ReachActivity.team(ev, activityCard);
  switch (ev.type) {
    case 'start':
      for (const member of ev.members) {
        const card = teamCard(member.index, member.name, member.model);
        if (card) {
          card.dataset.agentId = member.agentId || '';
          card.dataset.role = member.role || '';
        }
      }
      invalidateComposerCatalog();
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
      if (card && (ev.retake || card.dataset.paused !== 'true')) {
        card.classList.remove('stalled', 'failed', 'done');
        setMemberControl(card, false, false);
        card.querySelector('.member-state').textContent = 'working…';
      }
      break;
    }
    case 'member-wake-queued': {
      const card = teamCard(ev.index, ev.name, ev.model);
      if (card) {
        card.dataset.wakePending = 'true';
        const button = card.querySelector('.member-control');
        button.textContent = 'Starting…';
        button.disabled = true;
        card.querySelector('.member-state').textContent = 'wake-up queued · waiting for team capacity';
      }
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
      } else if (ev.memberType === 'request-start') {
        state.textContent = `Waiting on ${ev.model || 'provider'} response headers…`;
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
            const follow = card.isConnected && !card.hidden && shouldFollowChat();
            body.textContent = run.buffer.get(ev.index) || '';
            followChatTail(follow);
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
        const terminalStatus = ev.status || (ev.ok ? 'completed' : 'error');
        card._teamDeck?.update(card, {
          startedAt: Date.now(), steps: [], count: 0,
          ...(card._teamActivity || {}),
          status: terminalStatus,
          reason: ev.error || '',
          endedAt: Date.now(),
        });
        setMemberControl(card, terminalStatus === 'stalled', terminalStatus !== 'stalled');
        clearTimeout(card._renderTimer);
        card.classList.remove('waiting');
        card.classList.remove('done', 'failed', 'stalled');
        card.classList.add(ev.ok ? 'done' : ev.status === 'stalled' ? 'stalled' : 'failed');
        // Completion remains visible on the tab even while another is open.
        if (ev.ok) flashMemberCard(card);
        card.querySelector('.member-state').textContent = ev.completionReason
          ? ev.completionReason
          : ev.ok ? `done (${ev.chars || 0} chars)` : `${ev.status || 'failed'}: ${ev.error || 'No completed answer.'}`;
      }
      break;
    }
    /* ---------- spawned workers (agent.spawn — Grok-Bot-style subagents) ---------- */
    case 'subagent': {
      if (ev.netType === 'agent-message') {
        const fromIndex = memberIndexFromAgentId(ev.from);
        const toIndex = memberIndexFromAgentId(ev.to);
        const fromCard = fromIndex === null ? run.subCards?.get(ev.from) : teamCard(fromIndex, ev.fromName || '', '');
        const toCard = toIndex === null ? run.subCards?.get(ev.to) : teamCard(toIndex, ev.toName || '', '');
        updateCrewComms(fromCard, { sent: ev.messagesSent || 0 });
        updateCrewComms(toCard, { received: ev.messagesReceived || 0, inbox: ev.inbox || 0 });
        if (fromCard) {
          const line = document.createElement('div');
          line.className = 'member-tool dim';
          line.textContent = ev.delivered === 'stalled-wake'
            ? `✉ waking stalled ${ev.toName} (${ev.chars} chars)`
            : `✉ ${['queued', 'pending-start', 'mailbox', 'mailbox-running'].includes(ev.delivered) ? 'queued for' : 'woke'} ${ev.toName} (${ev.chars} chars)`;
          fromCard.querySelector('.member-body')?.appendChild(line);
        }
        if (toCard && ev.delivered === 'stalled-wake') toCard.querySelector('.member-state').textContent = 'stalled · wake-up queued…';
        break;
      }
      const card = subCard(ev.agentId, ev.name, ev.model || '', ev.depth);
      if (!card) break;
      const body = card.querySelector('.member-body');
      const state = card.querySelector('.member-state');
      switch (ev.netType) {
        case 'agent-control':
          setMemberControl(card, ev.paused);
          break;
        case 'agent-created': {
          if (ev.queued || ev.status === 'queued') {
            card.classList.remove('running');
            setMemberControl(card, false, true);
            state.textContent = `queued for team capacity · ${ev.task ? ev.task.slice(0, 80) : 'waiting…'}`;
          } else {
            card.classList.add('running');
            setMemberControl(card, false, false);
            state.textContent = `spawned · ${ev.task ? ev.task.slice(0, 80) : 'working…'}`;
          }
          invalidateComposerCatalog();
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
            if (ev.status === 'completed') flashMemberCard(card);
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
    case 'links-round': {
      const nurseNames = new Set(ev.nurseWaking || []);
      const waking = (ev.waking || []).filter(name => !nurseNames.has(name));
      if (ev.silent || !waking.length) break;
      const note = document.createElement('div');
      note.className = 'chat-msg system';
      note.textContent = `🔗 Links round ${ev.round}: ${waking.join(', ')} got crew messages — ${ev.exchanges}/${ev.budget} exchanges used.`;
      run.wrap.appendChild(note);
      break;
    }
    case 'links-synthesis': {
      const note = document.createElement('div');
      note.className = 'chat-msg system';
      note.textContent = `🔗 Links: no completion was declared — ${ev.name} synthesizes the final answer (${ev.budgetSpent} crew messages used).`;
      run.wrap.appendChild(note);
      break;
    }
    case 'links-stall': {
      const note = document.createElement('div');
      note.className = 'chat-msg system';
      note.textContent = `🔗 Links: ${ev.name} stalled (${ev.error || 'no usable action'}) — press Start to wake it, or a teammate can send new work; the crew continues meanwhile.`;
      run.wrap.appendChild(note);
      break;
    }
    case 'links-revive': {
      const card = teamCard(ev.index, ev.name, ev.model || '');
      if (card) {
        card.classList.remove('stalled', 'failed');
        setMemberControl(card, false, false);
        card.querySelector('.member-state').textContent = `waking with ${ev.messages || 1} crew message${ev.messages === 1 ? '' : 's'}…`;
      }
      if (ev.silent || ev.source === 'nurse') break;
      const note = document.createElement('div');
      note.className = 'chat-msg system';
      note.textContent = `🔗 Links: ${ev.name} was stalled; a teammate sent new work, so it is waking for another bounded turn.`;
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
      for (const card of run.subCards.values()) clearTimeout(card._renderTimer);
      run.deck.finish(ev.stopped ? 'stopped' : 'completed');
      run.stop.remove();
      activeTeamRun = null;
      invalidateComposerCatalog();
      if (!composerSuggestionsEl.classList.contains('hidden')) refreshComposerSuggestions();
      updateSendControl();
      break;
    }
    case 'error': {
      const note = document.createElement('div');
      note.className = 'chat-msg system';
      note.textContent = 'Team error: ' + ev.message;
      run.wrap.appendChild(note);
      for (const card of run.cards.values()) clearTimeout(card._renderTimer);
      for (const card of run.subCards.values()) clearTimeout(card._renderTimer);
      run.deck.finish('error');
      run.stop.remove();
      activeTeamRun = null;
      invalidateComposerCatalog();
      if (!composerSuggestionsEl.classList.contains('hidden')) refreshComposerSuggestions();
      updateSendControl();
      break;
    }
  }
}
reachApi.teams.onEvent(handleTeamEvent);

// Team member edit reviews use the same grouped, nested dropdown as the main
// agent. The run id keeps simultaneous/later crews in distinct review batches.
reachApi.teams.onEditPending(({ teamRunId, edit }) => {
  const follow = shouldFollowChat();
  const host = activeTeamRun?.teamRunId === teamRunId ? activeTeamRun.deck.reviews : chatLog;
  const teamName = activeTeamRun?.team?.name || 'AI team';
  const group = ensureEditReviewGroup({
    key: `team:${teamRunId}`,
    host,
    title: `${teamName} proposed changes`,
    actor: teamName,
    resolve: (editId, accepted) => reachApi.teams.resolveEdit(editId, accepted),
  });
  appendEditCardToGroup(group, edit);
  if (chatScroll.contains(host)) followChatTail(follow);
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
