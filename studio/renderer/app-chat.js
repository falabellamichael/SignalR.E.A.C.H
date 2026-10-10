function timeStamp() {
  const d = new Date();
  return d.toTimeString().slice(0, 8);
}

function messageResendBusy() {
  return agentRunning || runningAgentIds.has(currentAgent?.id) || composerIntentPending || stoppingAll
    || currentAgent?.runState?.status === 'waiting_edits'
    || !!(activeTeamRun && !activeTeamRun.paused) || window.ReachTeamComposer?.saving();
}

// Transcript modules share callbacks, while app.js retains conversation/run state.
const messageTranslation = window.ReachMessageTranslation.create({
  window, document, localStorage, chatLog, md, reachApi, showNotice,
  getCurrentAgent: () => currentAgent,
  scheduleBrowserLayout: () => scheduleBrowserLayout?.(),
});
const { TRANSLATE_TARGET_KEY, TRANSLATE_POS_KEY, MSG_FURNITURE } = messageTranslation;
// Forwarding declarations retain both identifier calls and window helper APIs.
function savedTranslatePos() {
  return messageTranslation.savedTranslatePos();
}
function closeTranslatePopovers(except = null) {
  return messageTranslation.closeTranslatePopovers(except);
}
function translateModules() {
  return messageTranslation.translateModules();
}
function placeTranslatePopover(pop, bubble, anchor, pos) {
  return messageTranslation.placeTranslatePopover(pop, bubble, anchor, pos);
}
function bubbleBodyNodes(bubble) {
  return messageTranslation.bubbleBodyNodes(bubble);
}
function detachBubbleBody(bubble) {
  return messageTranslation.detachBubbleBody(bubble);
}
function insertBubbleBody(bubble, frag) {
  return messageTranslation.insertBubbleBody(bubble, frag);
}
function renderTranslatedBody(out, role) {
  return messageTranslation.renderTranslatedBody(out, role);
}
function updateTranslationTag(bubble) {
  return messageTranslation.updateTranslationTag(bubble);
}
function showBubbleTranslation(bubble, variant) {
  return messageTranslation.showBubbleTranslation(bubble, variant);
}
function clearBubbleTranslation(bubble) {
  return messageTranslation.clearBubbleTranslation(bubble);
}
function applyBubbleTranslation(bubble, out, fromName, toName, role) {
  return messageTranslation.applyBubbleTranslation(bubble, out, fromName, toName, role);
}
function openTranslatePopover(bubble, anchor, text, role) {
  return messageTranslation.openTranslatePopover(bubble, anchor, text, role);
}


const messageActions = window.ReachMessageActions.create({
  window, document, localStorage, chatLog, chatScroll, composerInput, reachApi,
  showNotice, confirmAction, escapeHtml, openTranslatePopover, messageResendBusy,
  getCurrentAgent: () => currentAgent,
  setComposerIntentPending: value => { composerIntentPending = value; },
  setAgentRunning: value => { agentRunning = value; },
  updateSendControl, appendChatMessage, updateStatusPill, loadAgentTree, renderTodos,
});
const { dismissThoughtPreview } = messageActions;
function attachThoughtPreview(button, text) {
  return messageActions.attachThoughtPreview(button, text);
}
function appendThoughtIndicator(bubble, thought) {
  return messageActions.appendThoughtIndicator(bubble, thought);
}
function updateMessageActions() {
  return messageActions.updateMessageActions();
}
function messageActionIcon(action) {
  return messageActions.messageActionIcon(action);
}
function pinnedMessagesKey(agentId) {
  return messageActions.pinnedMessagesKey(agentId);
}
function getPinnedMessages(agentId) {
  return messageActions.getPinnedMessages(agentId);
}
function isMessagePinned(agentId, messageKey) {
  return messageActions.isMessagePinned(agentId, messageKey);
}
function togglePinnedMessage(agentId, messageKey, text, role) {
  return messageActions.togglePinnedMessage(agentId, messageKey, text, role);
}
function speakMessage(text, button) {
  return messageActions.speakMessage(text, button);
}
function collapseMessageTray(actions) {
  return messageActions.collapseMessageTray(actions);
}
function updateWingFade(wing) {
  return messageActions.updateWingFade(wing);
}
function layoutMessageTray(actions, bubble, role) {
  return messageActions.layoutMessageTray(actions, bubble, role);
}
function makeMessageActionButton({ cls, title, icon, onClick, dataset }) {
  return messageActions.makeMessageActionButton({ cls, title, icon, onClick, dataset });
}
function appendMessageActions(bubble, role, text, msgIndex = null, provisional = false, messageKey = '') {
  return messageActions.appendMessageActions(bubble, role, text, msgIndex, provisional, messageKey);
}


function appendChatMessage(role, text, msgIndex = null, thought = '', messageKey = '') {
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
  if (role === 'assistant') appendThoughtIndicator(div, thought);
  appendMessageActions(div, role, text, msgIndex, false, messageKey);
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

function formatElapsed(ms) {
  if (ms == null || !Number.isFinite(Number(ms))) return '';
  const n = Math.max(0, Number(ms));
  if (n < 1000) return `${Math.round(n)}ms`;
  if (n < 10000) return `${(n / 1000).toFixed(1)}s`;
  return `${Math.round(n / 1000)}s`;
}

function formatClock(at) {
  const d = at ? new Date(at) : new Date();
  if (Number.isNaN(d.getTime())) return timeStamp();
  return d.toTimeString().slice(0, 8);
}

function toolBodyText(result) {
  if (result == null || result === '') return '';
  if (typeof result === 'string') return result.slice(0, 4000);
  if (typeof result === 'object') {
    const { record, ...rest } = result;
    return JSON.stringify(rest, null, 2).slice(0, 4000);
  }
  return String(result).slice(0, 4000);
}

function appendToolCard(tool, ok, pending, error, result, meta = {}) {
  const follow = shouldFollowChat();
  const card = document.createElement('div');
  card.className = 'tool-card ' + (ok ? (pending ? 'pending' : 'ok') : 'err');
  const head = document.createElement('button');
  head.className = 'tool-head';
  head.type = 'button';

  const icon = document.createElement('span');
  icon.className = 'tool-icon';
  icon.textContent = ok ? (pending ? '◔' : '✓') : '✗';
  const name = document.createElement('span');
  name.className = 'tool-name';
  name.textContent = tool || 'tool';
  const detail = document.createElement('span');
  detail.className = 'tool-meta';
  const bits = [];
  if (meta.headline) bits.push(meta.headline);
  if (pending) bits.push('awaiting review');
  else if (error) bits.push(String(error).slice(0, 80));
  detail.textContent = bits.join(' · ');
  const time = document.createElement('span');
  time.className = 'tool-time';
  const elapsed = formatElapsed(meta.elapsedMs);
  time.textContent = [elapsed, meta.at ? formatClock(meta.at) : ''].filter(Boolean).join(' · ');
  head.append(icon, name, detail, time);
  const summary = [tool || 'tool', detail.textContent, time.textContent].filter(Boolean).join(' · ');
  head.title = summary;
  head.setAttribute('aria-label', summary);

  card.appendChild(head);
  const body = document.createElement('div');
  body.className = 'tool-body hidden';
  body.textContent = toolBodyText(result);
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
  if (edit.engineReview) appendReviewMeta(detailMeta, 'Engine review', `Risk ${edit.engineReview.risk}/100 · ${edit.engineReview.why.join(', ')} (heuristic)`);
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
  dismissThoughtPreview?.();
  for (const deck of [...teamDeckSlot.querySelectorAll(':scope > .team-deck'), ...chatLog.querySelectorAll(':scope > .team-deck')]) {
    deck._teamDeck?.unmount();
    if (![...teamConversationViews.values()].some(run => run.wrap === deck)) deck._teamDeck?.dispose();
  }
  teamDeckSlot.replaceChildren();
  chatLog.innerHTML = '';
  if (!currentAgent || !currentAgent.messages) { window.ReachActivity.setTeamVisible(false); return; }
  currentAgent.messages.forEach((m, idx) => {
    if (m.role === 'system' || m.role === 'developer') return;
    if (['recovery', 'recovery-attempt', 'tool-summary'].includes(m._reachMeta?.source)) return;
    if (m.role === 'tool') {
      appendToolCard(m.name || 'tool', !String(m.content).includes('→ error'), false,
        String(m.content).includes('→ error') ? 'error' : null, m.content, {
          headline: m._reachMeta?.headline,
          elapsedMs: m._reachMeta?.elapsedMs,
          at: m._reachMeta?.at,
        });
    } else {
      const text = m._reachMeta?.display ?? m.content;
      if (text) appendChatMessage(m.role, text, idx, m._reachMeta?.thought, m._reachMessageKey);
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
  placeSelectedTeamDeck();
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
  todoList.textContent = '';
  for (const t of currentAgent.todos) {
    const li = document.createElement('li');
    li.className = 'todo-' + (t.status || 'pending');
    const fold = document.createElement('details');
    fold.className = 'todo-fold';
    const summary = document.createElement('summary');
    summary.textContent = t.text || '';
    fold.appendChild(summary);
    li.appendChild(fold);
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
  if (!currentAgent || agentRunning || runningAgentIds.has(currentAgent.id) || activeTeamRun && !activeTeamRun.paused) return;
  const id = currentAgent.id;
  const result = await reachApi.agents.pickAttachments(id);
  if (!result.ok) { showNotice(result.err); return; }
  if (currentAgent?.id !== id) {
    const draft = newChatDrafts.get(id);
    if (draft) draft.attachments.push(...result.attachments);
    return;
  }
  composerAttachments.push(...result.attachments);
  renderComposerAttachments();
  composerInput.focus();
};

// ---------- chat CRUD ----------
async function selectNewChat() {
  const revision = ++projectSelectionRevision;
  try {
    // Drafts support the same model, team and attachment controls as saved chats,
    // but stay out of history and off disk until a message is submitted.
    const res = await reachApi.agents.create('Chat', agentProjectDir || '', '', { draft: true });
    if (revision !== projectSelectionRevision) return;
    if (!res.ok) throw new Error(res.err);
    if (res.agent.id !== currentAgent?.id) await selectAgent(res.agent, { preserveEditors: true });
    else {
      noAgent.classList.add('hidden');
      agentView.classList.remove('hidden');
      window.ReachWorkspace?.sync();
    }
    composerInput.focus();
  } catch (error) { showNotice(`Could not open New Chat: ${error.message}`); }
}
$('#btn-new-chat').onclick = selectNewChat;

async function prepareDraftProject() {
  if (!currentAgent?.draft || currentAgent.dir) return true;
  const id = currentAgent.id;
  composerIntentPending = true; updateSendControl();
  try {
    const dir = await reachApi.pickDir();
    if (!dir || currentAgent?.id !== id) return false;
    const res = await reachApi.agents.update(id, { dir });
    if (!res.ok) throw new Error(res.err);
    if (currentAgent?.id !== id) return false;
    currentAgent.dir = dir;
    await rememberProject(dir);
    if (currentAgent?.id !== id) return false;
    agentMetaEl.textContent = `${dir} · ${currentAgent.model || 'default model'}`;
    agentMetaEl.title = agentMetaEl.textContent;
    return true;
  } catch (error) { showNotice(error.message); return false; }
  finally { composerIntentPending = false; updateSendControl(); }
}

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
  if (jevAutoRoutingAgentId) {
    jevAutoCancelled = true;
    await reachApi.agents.stop(jevAutoRoutingAgentId);
    return;
  }
  if (composerIntentPending || window.ReachTeamComposer?.saving()) return;
  const raw = composerInput.value;
  const parsed = composerIntents.parse(raw);
  const explicitIntent = parsed.kind === 'command' || parsed.kind === 'mentions' || parsed.error
    || /^[\s]*[\/@]/.test(raw);
  if (currentAgent?.draft && !currentAgent.dir) {
    let needsProject = !explicitIntent && !!(raw.trim() || composerAttachments.length);
    if (parsed.kind === 'mentions' && !parsed.error && parsed.body.trim()) {
      const kinds = parsed.mentions.map(mention => mention.kind);
      needsProject = kinds.some(kind => ['current', 'persona'].includes(kind))
        || kinds.every(kind => ['model', 'default'].includes(kind));
    } else if (parsed.kind === 'command' && !parsed.error && parsed.remainder.trim()) {
      needsProject = ['say', 'team-run', 'agent-new'].includes(parsed.id);
      if (['message', 'agent-message'].includes(parsed.id)) {
        try {
          const split = composerIntents.takeTargetAndMessage(parsed.remainder, ['model']);
          needsProject = !!split.message.trim() && ['current', 'persona'].includes(composerIntents.parseMentionValue(split.target)?.kind);
        } catch { /* The command handler below reports malformed arguments. */ }
      }
    }
    if (needsProject && !await prepareDraftProject()) return;
  }
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
  if (window.ReachTeamComposer?.enabled() && raw.trim()) {
    return window.ReachTeamComposer.send(raw);
  }
  if (agentRunning || runningAgentIds.has(currentAgent?.id) || (activeTeamRun && !activeTeamRun.paused)) {
    return stopConversationRuns();
  }
  const text = raw.trim();
  if ((!text && !composerAttachments.length) || !currentAgent) return;
  const attachments = [...composerAttachments];
  const contextAgentId = currentAgent.id;
  const contextAgentName = currentAgent.name;
  const display = [text, attachments.length ? `Attachments: ${attachments.map(file => file.name).join(', ')}` : ''].filter(Boolean).join('\n\n');
  composerIntentPending = true;
  updateSendControl();
  let autoTeamDispatch = false;
  try {
    let plan = null;
    if (jevAutoModeEnabled()) {
      jevAutoCancelled = false;
      jevAutoRoutingAgentId = contextAgentId;
      updateSendControl();
      plan = await reachApi.agents.autoPlan(contextAgentId, text, { hasAttachments: attachments.length > 0 });
      if (jevAutoCancelled || currentAgent?.id !== contextAgentId) return;
      if (!plan.ok) throw new Error(plan.err || 'Auto selection failed.');
      if (!plan.token) jevAutoRoutingAgentId = null;
      const status = $('#jev-auto-status');
      status.dataset.agentId = contextAgentId;
      status.textContent = jevAutoDescription(plan);
      status.title = plan.usage ? `Jev used ${plan.usage.inputTokens} input and ${plan.usage.outputTokens} output tokens.` : plan.cached ? 'Reused a previous Jev decision.' : '';
      status.classList.remove('hidden');
      updateSendControl();
    }
    if (plan?.kind === 'team' && plan.team) {
      autoTeamDispatch = true;
      teamDispatching = true;
      const res = await reachApi.teams.run(plan.team.id, text, currentAgent.dir, contextAgentId,
        currentAgent.settings?.teamChat?.useHistory !== false, { autoToken: plan.token });
      if (!res.ok) throw new Error(res.err);
      startTeamRunView(res.teamRunId, plan.team, text, contextAgentId, { autoRouted: true });
      for (const event of pendingTeamEvents) handleTeamEvent(event);
      if (currentAgent?.id === contextAgentId) {
        delete currentAgent.draft;
        newChatDrafts.delete(contextAgentId);
        clearSuccessfulComposer({ text: raw, attachments, contextAgentId }, { attachments: true });
      }
      await loadAgentTree();
      return;
    }
    const res = await reachApi.agents.send(contextAgentId, text, attachments.map(file => file.attachmentId), { autoToken: plan?.token });
    if (!res.ok) throw new Error(res.err);
    if (currentAgent?.id === contextAgentId) {
      if (res.draft === false) { delete currentAgent.draft; newChatDrafts.delete(contextAgentId); }
      clearSuccessfulComposer({ text: raw, attachments, contextAgentId }, { attachments: true });
      appendChatMessage('user', display, res.messageIndex, '', res.messageKey);
      agentRunning = true;
      updateStatusPill('running');
    }
    loadAgentTree(); // auto-title + message count may have changed
  } catch (error) {
    if (jevAutoCancelled) return;
    // Keep the exact draft and attachment chips on every rejected or failed IPC
    // path. A transport exception must not leave the composer permanently busy.
    if (currentAgent?.id === contextAgentId) {
      updateStatusPill(currentAgent.draft ? 'idle' : 'paused', error.message);
      appendChatMessage('system', `Error: ${error.message}`);
    } else {
      setBackgroundAgentGate(contextAgentId, `Message failed: ${error.message}`, { action: 'Inspect' });
      showNotice(`${contextAgentName}: ${error.message}`);
    }
  } finally {
    jevAutoRoutingAgentId = null;
    jevAutoCancelled = false;
    if (autoTeamDispatch) { teamDispatching = false; pendingTeamEvents = []; earlyTeamEdits.clear(); }
    composerIntentPending = false;
    updateSendControl();
  }
}

$('#btn-agent-stop').onclick = async () => {
  if (currentAgent) await reachApi.agents.stop(currentAgent.id);
};

function updateSendControl() {
  const routing = jevAutoRoutingAgentId === currentAgent?.id && !!jevAutoRoutingAgentId;
  const busy = agentRunning || runningAgentIds.has(currentAgent?.id) || !!(activeTeamRun && !activeTeamRun.paused);
  const parsed = composerIntents.parse(composerInput.value);
  const explicitIntent = parsed.kind === 'command' || parsed.kind === 'mentions' || parsed.error
    || /^[\s]*[\/@]/.test(composerInput.value);
  const teamMessage = window.ReachTeamComposer?.enabled() && composerInput.value.trim();
  const stopMode = busy && !explicitIntent && !teamMessage;
  const command = parsed.kind === 'command' || (parsed.error && /^\s*\//.test(composerInput.value));
  const button = $('#btn-send');
  button.textContent = stoppingAll ? 'Stopping…' : routing ? 'Stop' : composerIntentPending ? 'Running…' : stopMode ? 'Stop' : command ? 'Run' : 'Send';
  button.title = stopMode ? 'Stop this conversation and pause its team' : command ? 'Run composer command' : teamMessage ? 'Send to the selected team' : 'Send message';
  if (routing) button.title = 'Stop automatic selection';
  button.classList.toggle('danger', stopMode || routing);
  button.disabled = stoppingAll || (composerIntentPending && !routing) || window.ReachTeamComposer?.saving();
  $('#btn-attach').disabled = busy || !currentAgent || stoppingAll;
  updateMessageActions();
  window.ReachWorkspace?.syncControls();
}

async function stopConversationRuns() {
  if (stoppingAll) return;
  const agentId = currentAgent?.id, run = activeTeamRun;
  stoppingAll = true; updateSendControl();
  try {
    const results = await Promise.all([
      ...(agentId ? [reachApi.agents.stop(agentId)] : []),
      ...(run ? [reachApi.teams.stop(run.teamRunId)] : []),
    ]);
    for (const result of results) if (!result.ok) showNotice(result.err);
  } catch (error) { showNotice(error.message); }
  finally { stoppingAll = false; updateSendControl(); }
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
  for (const doomedId of doomed) {
    const result = await reachApi.agents.delete(doomedId);
    if (!result.ok) { showNotice(result.err || 'Could not delete conversation.'); await loadAgentTree(); return; }
    runningAgentIds.delete(doomedId);
    setBackgroundAgentGate(doomedId, '', { clear: true });
    discardTeamConversation(doomedId);
  }
  if (currentAgent && doomed.has(currentAgent.id)) {
    newChatDrafts.delete(currentAgent.id);
    currentAgent = null;
    agentRunning = false;
    streamBubble = recoveryBubble = null;
    composerInput.value = '';
    composerAttachments = [];
    await selectNewChat();
  }
  syncSelectedTeamRun();
  await loadAgentTree();
}

$('#btn-agent-delete').onclick = async () => {
  if (!currentAgent || currentAgent.draft) return;
  await deleteAgentById(currentAgent.id, currentAgent.name);
};

// ---------- agent events ----------
let streamBubble = null;
let recoveryBubble = null;
/* The last rate-limit line shown in the transcript. A crew shares one pace per
 * provider, so several members can hit the same limit in a row; the line is
 * emitted with an identical note each time, so comparing it dedupes the burst
 * without suppressing a genuinely new wait (a shorter or longer one). */
let lastRateLimitNote = null;
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
        // A reused recovery bubble drops its DOM but a stale translation state
        // would hold fragments of the old message — forget it with the nodes.
        streamBubble._translate = null;
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
        if (!ev.content && !ev.thought) streamBubble.classList.add('hidden');
        streamBubble.classList.remove('streaming');
        if (!ev.provisional) appendThoughtIndicator(streamBubble, ev.thought);
        const ts = document.createElement('span');
        ts.className = 'msg-ts';
        ts.textContent = timeStamp();
        streamBubble.appendChild(ts);
        appendMessageActions(streamBubble, 'assistant', ev.content || '', null, ev.provisional);
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
      appendToolCard(ev.tool, ev.ok, ev.pending, ev.error, ev.result, {
        headline: ev.headline, elapsedMs: ev.elapsedMs, at: Date.now(),
      });
      break;
    case 'run-state':
      if (ev.status !== 'running') recoveryBubble = null;
      /* A fresh run may report the same limit again; the earlier line was in a
       * previous run's context, so it must not suppress the new one. */
      if (ev.status === 'running') lastRateLimitNote = null;
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
      if (currentAgent) {
        if (ev.draft === false) { delete currentAgent.draft; newChatDrafts.delete(currentAgent.id); }
        currentAgent.name = ev.name;
        agentNameEl.textContent = agentNameEl.title = ev.name;
        $('#agent-info-summary-name').textContent = ev.name;
      }
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
    /*
     * A provider rate limit is waiting, not failing, so it is reported as its
     * own kind of line. It is DEDUPED: a crew sharing one pace can hit the limit
     * several times in a row, and one line per attempt would bury the
     * conversation. The activity trail still shows every occurrence — that is
     * where repetition is informative; the transcript only needs to say it once.
     */
    case 'rate-limit': {
      const note = ev.note || 'The provider is rate limiting this crew; requests will retry at a slower pace.';
      if (lastRateLimitNote !== note) {
        lastRateLimitNote = note;
        appendChatMessage('system', note);
      }
      break;
    }
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

