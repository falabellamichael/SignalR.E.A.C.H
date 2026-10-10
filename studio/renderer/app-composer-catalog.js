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
    option.title = composerIntents.suggestionTooltip(item);
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

