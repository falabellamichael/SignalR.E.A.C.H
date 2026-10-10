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
  if (card.isConnected && !card.hidden && chatLog.contains(card)) input.focus();
  return ask;
}

function teamErrorSummary(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (/ECONOMY_CONCURRENCY_LIMIT/i.test(raw)) {
    return 'CodeGPT Economy allows one active stream per account. Wait for the other stream to finish, then retry this request.';
  }
  const objectAt = raw.indexOf('{');
  if (objectAt >= 0) {
    const prefix = raw.slice(0, objectAt).trim().replace(/:\s*$/, '');
    try {
      const data = JSON.parse(raw.slice(objectAt));
      const detail = [data?.aiErrorMessage, data?.errorMessage, data?.error?.aiErrorMessage,
        data?.error?.errorMessage, data?.error?.message, data?.error, data?.message]
        .find(message => typeof message === 'string' && message.trim());
      return (detail ? `${prefix ? prefix + ': ' : ''}${detail.trim()}`
        : `${prefix ? prefix + ': ' : ''}The provider returned an error. Check its connection and retry.`).slice(0, 320);
    } catch {
      return `${prefix ? prefix + ': ' : ''}The provider returned an unreadable error. Check its connection and retry.`.slice(0, 320);
    }
  }
  return raw.slice(0, 320);
}

function memberToolLine(ev) {
  const mark = ev.ok ? '✓' : '✗';
  const elapsed = formatElapsed(ev.elapsedMs);
  const error = ev.error ? teamErrorSummary(ev.error) : '';
  return [mark, ev.tool || 'tool', ev.headline, elapsed, error && !ev.ok ? error : ''].filter(Boolean).join('  ');
}

function handleTeamEvent(ev) {
  if (ev.type === 'queue-run-started') {
    startTeamRunView(ev.teamRunId, ev.team, ev.task, ev.agentId);
    return;
  }
  // A paused run may still be displayed while main tears it down and starts the
  // replacement. Buffer events for the not-yet-installed run instead of
  // dropping its fast start/done sequence against the old run id.
  if (teamDispatching && !teamRunViews.has(ev.teamRunId)) {
    pendingTeamEvents.push(ev);
    return;
  }
  const run = teamRunViews.get(ev.teamRunId);
  if (!run) return;
  const memberCard = (index, name, model) => teamCard(index, name, model, run);
  const workerCard = (agentId, name, model, depth) => subCard(agentId, name, model, depth, run);
  // Nurse telemetry is coordination metadata, not provider/tool activity.
  // Keep it out of member construction and the activity reducer so it cannot
  // fabricate a worker or make a genuinely silent request look active.
  if (ev.type === 'nurse') {
    run.deck.noteNurse(ev);
    return;
  }
  const activityCard = ev.type === 'subagent' && ev.agentId ? workerCard(ev.agentId, ev.name, ev.model || '', ev.depth) : ev.index !== undefined ? memberCard(ev.index, ev.name, ev.model) : null;
  const hasProviderError = ['member-done', 'links-stall', 'chain-broken', 'error'].includes(ev.type)
    || ev.type === 'member' && ['retry', 'error', 'run-state', 'message-end', 'rate-limit', 'tool-result'].includes(ev.memberType)
    || ev.type === 'subagent' && ['error', 'agent-state', 'message-end', 'rate-limit', 'tool-result'].includes(ev.netType);
  window.ReachActivity.team(hasProviderError ? {
    ...ev,
    ...(ev.error ? { error: teamErrorSummary(ev.error) } : {}),
    ...(ev.reason ? { reason: teamErrorSummary(ev.reason) } : {}),
    ...(ev.message ? { message: teamErrorSummary(ev.message) } : {}),
    ...(ev.note && (ev.memberType === 'rate-limit' || ev.netType === 'rate-limit') ? { note: teamErrorSummary(ev.note) } : {}),
  } : ev, activityCard);
  switch (ev.type) {
    case 'start':
      for (const member of ev.members) {
        const card = memberCard(member.index, member.name, member.model);
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
      const card = memberCard(ev.index, ev.name, ev.model);
      if (card) setMemberControl(card, ev.paused);
      break;
    }
    case 'member-start': {
      const card = memberCard(ev.index, ev.name, ev.model);
      if (card && (ev.retake || card.dataset.paused !== 'true')) {
        card.classList.remove('stalled', 'failed', 'done');
        setMemberControl(card, false, false);
        card.querySelector('.member-state').textContent = 'working…';
      }
      break;
    }
    case 'member-wake-queued': {
      const card = memberCard(ev.index, ev.name, ev.model);
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
      const card = memberCard(ev.index, ev.name, ev.model);
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
        state.textContent = 'Retrying: ' + teamErrorSummary(ev.error);
      } else if (ev.memberType === 'recovery') {
        state.textContent = 'Requesting a usable action response…';
      } else if (ev.memberType === 'error') {
        state.textContent = teamErrorSummary(ev.message);
      } else if (ev.memberType === 'run-state') {
        state.textContent = card.dataset.paused === 'true' ? 'stopped · ready to start' : ev.status + (ev.reason ? ': ' + teamErrorSummary(ev.reason) : '');
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
        line.textContent = memberToolLine(ev);
        body.appendChild(line);
      }
      break;
    }
    case 'member-waiting': {
      // Member paused for edit review; the edit cards arrive separately via
      // onEditPending. Just reflect the pause on the card.
      const card = memberCard(ev.index, ev.name, ev.model || '');
      if (card) {
        card.classList.add('waiting');
        card.querySelector('.member-state').textContent =
          `waiting — ${ev.edits.length} edit${ev.edits.length === 1 ? '' : 's'} need review`;
      }
      break;
    }
    case 'member-question': {
      const card = memberCard(ev.index, ev.name, ev.model || '');
      if (!card) break;
      card.classList.add('waiting');
      card.querySelector('.member-state').textContent = 'waiting for your answer…';
      attachAskBox(card, ev.questionId, ev.name, ev.question);
      break;
    }
    case 'member-resumed': {
      const card = memberCard(ev.index, ev.name, ev.model || '');
      if (card) {
        card.classList.remove('waiting', 'failed');
        card.querySelector('.member-state').textContent = 'resumed · working…';
      }
      break;
    }
    case 'member-done': {
      const card = memberCard(ev.index, ev.name, ev.model || '');
      if (card) {
        const terminalStatus = ev.status || (ev.ok ? 'completed' : 'error');
        card._teamDeck?.update(card, {
          startedAt: Date.now(), steps: [], count: 0,
          ...(card._teamActivity || {}),
          status: terminalStatus,
          reason: teamErrorSummary(ev.error),
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
          : ev.ok ? `done (${ev.chars || 0} chars)` : `${ev.status || 'failed'}: ${teamErrorSummary(ev.error) || 'No completed answer.'}`;
      }
      break;
    }
    /* ---------- spawned workers (agent.spawn — Grok-Bot-style subagents) ---------- */
    case 'subagent': {
      if (ev.netType === 'agent-message') {
        const fromIndex = memberIndexFromAgentId(ev.from);
        const toIndex = memberIndexFromAgentId(ev.to);
        const fromCard = fromIndex === null ? run.subCards?.get(ev.from) : memberCard(fromIndex, ev.fromName || '', '');
        const toCard = toIndex === null ? run.subCards?.get(ev.to) : memberCard(toIndex, ev.toName || '', '');
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
      const card = workerCard(ev.agentId, ev.name, ev.model || '', ev.depth);
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
              : `${ev.status}: ${teamErrorSummary(ev.error)}`;
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
          line.textContent = memberToolLine(ev);
          body.appendChild(line);
          break;
        }
        case 'error': {
          state.textContent = teamErrorSummary(ev.message);
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
      note.textContent = `⛓ Chain broken at ${ev.name}: ${teamErrorSummary(ev.error) || 'member failed'} — remaining members skipped.`;
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
      note.textContent = `🔗 Links: ${ev.name} stalled (${teamErrorSummary(ev.error) || 'no usable action'}) — press Start to wake it, or a teammate can send new work; the crew continues meanwhile.`;
      run.wrap.appendChild(note);
      break;
    }
    case 'links-revive': {
      const card = memberCard(ev.index, ev.name, ev.model || '');
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
      note.setAttribute('role', 'status');
      const total = (ev.results || []).length;
      const okCount = Number.isInteger(ev.successfulCount) ? ev.successfulCount : (ev.results || []).filter(r => r.ok).length;
      const outcome = ev.outcome || (ev.stopped ? 'stopped' : ev.answer?.trim()
        ? okCount === total ? 'completed' : 'partial' : 'failed');
      note.textContent = outcome === 'failed'
        ? `Team could not produce an answer (${okCount}/${total} members answered). Review member errors and check the connections before retrying.`
        : outcome === 'partial'
          ? `Team returned a partial answer (${okCount}/${total} members answered). Review the failed members before continuing.`
          : `🏁 Team run ${outcome === 'stopped' ? 'stopped' : 'finished'}: ${okCount}/${total} members answered.`;
      if (outcome === 'failed' || outcome === 'partial') {
        const connections = document.createElement('button');
        connections.type = 'button';
        connections.className = 'ghost small';
        connections.textContent = 'Check connections';
        connections.onclick = () => openSettingsPanel('connection').catch(error => showNotice(error.message));
        note.append(' ', connections);
        if (run.agentId) {
          const restore = document.createElement('button');
          restore.type = 'button';
          restore.className = 'ghost small';
          restore.textContent = 'Restore request';
          restore.title = 'Put the original request back in the composer without sending it';
          restore.onclick = () => {
            if (currentAgent?.id !== run.agentId) return showNotice('Open the original conversation to restore this request.');
            if (composerInput.value.trim()) return showNotice('Your unsent draft is intact. Clear it before restoring this request.');
            composerInput.value = run.task;
            composerInput.dispatchEvent(new Event('input', { bubbles: true }));
            composerInput.focus();
          };
          note.append(' ', restore);
        }
      }
      if (outcome === 'completed' && run.team?.id && run.agentId) note.textContent += ' Send a follow-up with Teams on to continue this conversation.';
      run.wrap.appendChild(note);
      // Persist a compact record into the conversation history so a reload
      // still shows the run happened and what the crew answered.
      if (run.agentId && ['completed', 'partial'].includes(outcome) && ev.answer?.trim()) {
        const answerNote = `【Team ${(run.team || {}).name || ''} · ${ev.mode}】\n${String(ev.answer).slice(0, 12000)}`;
        const summary = outcome === 'partial' ? `Partial team result (${okCount}/${total} members answered)\n${answerNote}` : answerNote;
        if (currentAgent?.id === run.agentId) appendChatMessage('assistant', summary);
        if (!ev.historySaved) reachApi.agents.appendNote(run.agentId, summary).catch(error => { note.append(' Could not save: ' + error.message); });
      }
      for (const card of run.cards.values()) clearTimeout(card._renderTimer);
      for (const card of run.subCards.values()) clearTimeout(card._renderTimer);
      run.deck.finish(outcome === 'failed' ? 'error' : outcome);
      run.stop.remove();
      teamRunViews.delete(run.teamRunId);
      syncSelectedTeamRun();
      invalidateComposerCatalog();
      if (!composerSuggestionsEl.classList.contains('hidden')) refreshComposerSuggestions();
      updateSendControl();
      break;
    }
    case 'error': {
      const note = document.createElement('div');
      note.className = 'chat-msg system';
      note.textContent = 'Team error: ' + teamErrorSummary(ev.message);
      run.wrap.appendChild(note);
      for (const card of run.cards.values()) clearTimeout(card._renderTimer);
      for (const card of run.subCards.values()) clearTimeout(card._renderTimer);
      run.deck.finish('error');
      run.stop.remove();
      teamRunViews.delete(run.teamRunId);
      syncSelectedTeamRun();
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
function handleTeamEditPending({ teamRunId, edit }) {
  const run = teamRunViews.get(teamRunId);
  if (!run) {
    if (teamDispatching) {
      const edits = earlyTeamEdits.get(teamRunId) || [];
      edits.push(edit); earlyTeamEdits.set(teamRunId, edits);
    }
    return;
  }
  const follow = shouldFollowChat();
  const host = run.deck.reviews;
  const teamName = run.team?.name || 'AI team';
  const group = ensureEditReviewGroup({
    key: `team:${teamRunId}`,
    host,
    title: `${teamName} proposed changes`,
    actor: teamName,
    resolve: (editId, accepted) => reachApi.teams.resolveEdit(editId, accepted),
  });
  appendEditCardToGroup(group, edit);
  if (chatScroll.contains(host)) followChatTail(follow);
}
reachApi.teams.onEditPending(handleTeamEditPending);

// ---------- boot ----------
(async () => {
  refreshStatus();
  loadProjectList();
  await loadAgentProjectSelect();
  const option = $('#agent-project-select').selectedOptions[0];
  if (option) await selectProject({ name: option.textContent, dir: option.value });
  else await selectNewChat();
  await loadCreatePage();
  loadSettings();
})();
