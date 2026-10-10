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

function relativeTime(ts) {
  const n = Number(ts);
  if (!Number.isFinite(n) || n <= 0) return '';
  const delta = Date.now() - n;
  if (delta < 45000) return 'now';
  const mins = Math.round(delta / 60000);
  if (mins < 60) return `${mins}m`;
  const hours = Math.round(mins / 60);
  if (hours < 36) return `${hours}h`;
  const days = Math.round(hours / 24);
  if (days < 14) return `${days}d`;
  const d = new Date(n);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

function shortStatus(status) {
  switch (status) {
    case 'running': return 'run';
    case 'waiting_input':
    case 'waiting_edits':
    case 'waiting_approval': return 'wait';
    case 'paused': return 'pause';
    case 'failed':
    case 'error': return 'err';
    case 'stopped': return 'stop';
    case 'completed': return 'done';
    default: return 'idle';
  }
}

async function loadAgentTree() {
  const revision = ++agentTreeRevision;
  const treeEl = $('#agent-tree');
  treeEl.innerHTML = '';
  const draftRow = document.createElement('div');
  draftRow.className = 'tree-node';
  const draftButton = document.createElement('button');
  draftButton.id = 'tree-new-chat';
  draftButton.className = 'tree-label tree-new-chat';
  draftButton.type = 'button';
  draftButton.textContent = 'New Chat';
  draftButton.onclick = () => selectNewChat();
  draftRow.appendChild(draftButton);
  const markDraft = () => {
    const selected = !currentAgent || currentAgent.draft === true;
    draftRow.classList.toggle('active', selected);
    if (selected) draftButton.setAttribute('aria-current', 'page');
    else draftButton.removeAttribute('aria-current');
  };
  markDraft();
  treeEl.appendChild(draftRow);
  if (!agentProjectDir) {
    const hint = document.createElement('div');
    hint.className = 'dim tree-empty';
    hint.textContent = 'Choose a project when you send your first message.';
    treeEl.appendChild(hint);
    return;
  }
  const dir = agentProjectDir;
  const res = await reachApi.agents.tree(dir);
  if (dir !== agentProjectDir || revision !== agentTreeRevision) return;
  if (!res.ok || !res.tree.length) {
    return;
  }
  const renderNode = (node) => {
    if (currentAgent?.id === node.id && currentAgent.draft) {
      delete currentAgent.draft;
      newChatDrafts.delete(node.id);
      currentAgent.name = node.name;
      agentNameEl.textContent = agentNameEl.title = node.name;
      $('#agent-info-summary-name').textContent = node.name;
    }
    const row = document.createElement('div');
    row.className = 'tree-node';
    row.style.paddingLeft = (6 + node.depth * 16) + 'px';
    const label = document.createElement('div');
    label.className = 'tree-label';
    const dot = document.createElement('span');
    const attention = ['waiting_input', 'waiting_edits', 'paused', 'failed', 'error'].includes(node.status);
    dot.className = 'tree-dot ' + (node.status === 'running' ? 'run' : attention ? 'attention' : node.messageCount ? 'ok' : 'idle');
    label.appendChild(dot);
    const brief = document.createElement('span');
    brief.className = 'tree-brief';
    const word = String(node.name || '').trim().split(/\s+/)[0] || '';
    brief.dataset.word = word;
    brief.textContent = word;
    brief.setAttribute('aria-hidden', 'true');
    label.appendChild(brief);
    const name = document.createElement('span');
    name.className = 'tree-name';
    name.textContent = node.depth > 0 ? '⑂ ' + node.name : node.name;
    name.title = `${node.messageCount} msgs · ${node.status}` + (node.forkIndex !== null ? ` · branched at message ${node.forkIndex}` : '');
    label.appendChild(name);
    const meta = document.createElement('span');
    const tone = node.status === 'running' ? 'run' : attention ? 'attention' : node.messageCount ? 'ok' : 'idle';
    meta.className = 'tree-meta ' + tone;
    const statusText = shortStatus(node.status);
    const timeText = relativeTime(node.updatedAt || node.createdAt);
    if (statusText) {
      const statusEl = document.createElement('span');
      statusEl.className = 'tree-status';
      statusEl.textContent = statusText;
      meta.appendChild(statusEl);
    }
    if (timeText) {
      if (statusText) {
        const sep = document.createElement('span');
        sep.className = 'tree-sep';
        sep.textContent = ' · ';
        meta.appendChild(sep);
      }
      const timeEl = document.createElement('span');
      timeEl.className = 'tree-time';
      timeEl.textContent = timeText;
      meta.appendChild(timeEl);
    }
    meta.title = name.title;
    label.title = node.name;
    label.appendChild(meta);
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
  for (const root of [...res.tree].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))) renderNode(root);
  markDraft();
  window.ReachWorkspace?.syncControls();
}

function rememberNewChatDraft() {
  if (currentAgent?.draft) newChatDrafts.set(currentAgent.id, {
    text: composerInput.value, attachments: [...composerAttachments],
  });
}

async function selectAgent(a, { preserveEditors = false } = {}) {
  closeComposerSuggestions();
  invalidateComposerCatalog();
  if (!preserveEditors && [...openFiles.values()].some(f => f.dirty) && !await confirmAction('There are unsaved editor changes. Discard them and switch conversation?')) return;
  const revision = ++projectSelectionRevision;
  const selected = await reachApi.agents.get(a.id);
  if (!selected || revision !== projectSelectionRevision) return;
  if (jevAutoRoutingAgentId && jevAutoRoutingAgentId !== selected.id) {
    jevAutoCancelled = true;
    await reachApi.agents.stop(jevAutoRoutingAgentId);
    if (revision !== projectSelectionRevision) return;
  }
  const leavingDraft = currentAgent?.draft;
  setBackgroundAgentGate(selected.id, '', { clear: true });
  streamBubble = null;
  recoveryBubble = null;
  if (!preserveEditors) resetEditors();

  if (selected.dir && !await selectProject({
    name: [...$('#agent-project-select').options].find(o => o.value === selected.dir)?.textContent || selected.dir.split(/[\\/]/).pop(),
    dir: selected.dir,
  }, { openDraft: false })) return;
  rememberNewChatDraft();
  currentAgent = selected;
  syncSelectedTeamRun();
  const draft = selected.draft ? newChatDrafts.get(selected.id) : null;
  if (selected.draft || leavingDraft) composerInput.value = draft?.text || '';
  composerAttachments = draft?.attachments || [];
  queuedIndicator.classList.add('hidden');
  renderComposerAttachments();
  window.ReachActivity.select(currentAgent);
  agentNameEl.textContent = agentNameEl.title = currentAgent.draft ? 'New Chat' : currentAgent.name;
  const lineage = currentAgent.parentChatId ? ' · ⑂ branch' : '';
  agentMetaEl.textContent = `${currentAgent.dir} · ${currentAgent.model || 'default model'}${lineage}`;
  agentMetaEl.title = agentMetaEl.textContent;
  $('#agent-info-summary-name').textContent = agentNameEl.textContent;
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
  if (!currentAgent || currentAgent.draft) return;
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
  $('#btn-agent-continue').classList.toggle('hidden', currentAgent.draft || !['stopped', 'stalled', 'paused', 'waiting_edits'].includes(s));
  $('#btn-agent-continue').textContent = ['stopped', 'stalled'].includes(s) ? 'Start' : 'Continue';
  $('#btn-agent-compact').disabled = currentAgent.draft || s === 'running';
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

