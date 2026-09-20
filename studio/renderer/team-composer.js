'use strict';

// The main half of the pill changes routing; the arrow only opens options.
(() => {
  const toggle = $('#team-chat-toggle'), arrow = $('#team-chat-menu-button');
  const menu = $('#team-chat-menu'), select = $('#team-chat-select');
  const history = $('#team-chat-history'), recipient = $('#team-chat-recipient');
  let saving = false, selectedConversation = null, refreshVersion = 0;

  function config() {
    return { enabled: false, teamId: '', useHistory: true, liveTarget: 'coordinator', ...currentAgent?.settings?.teamChat };
  }
  function selectedTeam() { return teams.find(team => team.id === config().teamId) || (!config().teamId ? teams[0] : null); }
  function liveRun() { return activeTeamRun?.agentId === currentAgent?.id ? activeTeamRun : null; }
  function close(restoreFocus = false) {
    menu.classList.add('hidden'); arrow.setAttribute('aria-expanded', 'false');
    if (restoreFocus) arrow.focus();
  }
  function sync() {
    if (selectedConversation !== currentAgent?.id) { selectedConversation = currentAgent?.id; close(); }
    const settings = config(), team = selectedTeam(), live = liveRun();
    const disabled = !currentAgent || saving || composerIntentPending;
    toggle.disabled = arrow.disabled = disabled;
    toggle.setAttribute('aria-checked', String(settings.enabled));
    toggle.querySelector('span').textContent = settings.enabled ? `Teams · ${team?.name || 'Choose team'}` : 'Teams';
    toggle.title = settings.enabled ? `Team chat on: ${team?.name || 'choose a team'}. Click to return to individual chat.` : 'Turn on team chat for normal messages.';
    toggle.setAttribute('aria-label', toggle.title);
    const signature = JSON.stringify(teams.map(t => [t.id, t.name, t.mode]));
    if (select.dataset.signature !== signature) {
      select.replaceChildren(...teams.map(t => new Option(`${t.name} · ${t.mode}`, t.id)));
      if (!teams.length) select.append(new Option('No saved teams', ''));
      select.dataset.signature = signature;
    }
    select.value = team?.id || '';
    select.disabled = disabled || !!live;
    history.checked = settings.useHistory !== false;
    recipient.value = settings.liveTarget;
    history.disabled = recipient.disabled = disabled;
    $('#team-chat-description').textContent = team ? `${team.members.length} members · ${team.mode}. Each member uses its configured model and connection.` : 'Create a team, or choose an available team if the previous one was deleted.';
    $('#team-chat-live-status').textContent = live
      ? `${live.team.name} is ${live.paused ? 'paused; messages stay queued until Resume' : 'active'}. ${live.team.mode === 'links' ? 'Normal messages go to the recipient above.' : 'Send a follow-up once this run finishes.'}`
      : 'Your next message starts a team turn. Teams stays on when the turn finishes.';
    $('#team-chat-pause').hidden = !live;
    $('#team-chat-pause').disabled = disabled;
    $('#team-chat-pause').textContent = live?.paused ? 'Resume team' : 'Pause team';
    $('#team-chat-edit').disabled = disabled || !team || !!live;
    if (settings.enabled) {
      composerInput.placeholder = `Message ${team?.name || 'your team'}… (${isMac ? 'Cmd' : 'Ctrl'}+Enter sends)`;
      $('#composer-model').textContent = 'Team models';
      $('#composer-model').title = 'Team members use their own models. Use Edit team to change the roster or its connections.';
      $('#composer-model').disabled = true;
    } else composerInput.placeholder = `Start with @ to route, or / for commands… (${isMac ? 'Cmd' : 'Ctrl'}+Enter sends)`;
  }
  async function save(patch) {
    if (!currentAgent || saving) return;
    const id = currentAgent.id, next = { ...config(), ...patch };
    saving = true; updateSendControl();
    try {
      const result = await reachApi.agents.update(id, { settings: { teamChat: next } });
      if (!result.ok) throw new Error(result.err);
      if (currentAgent?.id === id) currentAgent.settings = { ...currentAgent.settings, teamChat: next };
    } catch (error) { showNotice(error.message); }
    finally { saving = false; updateSendControl(); }
  }
  async function open() {
    if (!currentAgent) return;
    const id = currentAgent.id, revision = ++refreshVersion;
    closeComposerSuggestions();
    try {
      const saved = await reachApi.teams.list();
      if (currentAgent?.id !== id || revision !== refreshVersion) return;
      teams = saved; sync();
      menu.classList.remove('hidden'); arrow.setAttribute('aria-expanded', 'true');
      (select.disabled ? history : select).focus();
    } catch (error) { showNotice(error.message); }
  }
  toggle.onclick = async () => {
    const team = selectedTeam();
    if (!config().enabled && !team) return open();
    await save({ enabled: !config().enabled, teamId: team?.id || config().teamId });
  };
  arrow.onclick = () => menu.classList.contains('hidden') ? open() : close(true);
  $('#team-chat-close').onclick = () => close(true);
  select.onchange = () => save({ teamId: select.value });
  history.onchange = () => save({ useHistory: history.checked });
  recipient.onchange = () => save({ liveTarget: recipient.value });
  $('#team-chat-manage').onclick = () => { close(); showTab('create'); };
  $('#team-chat-edit').onclick = () => { const team = selectedTeam(); close(); if (team) openTeamModal(team); };
  $('#team-chat-pause').onclick = async () => {
    const live = liveRun(); if (!live) return;
    try { const res = await reachApi.teams[live.paused ? 'start' : 'stop'](live.teamRunId); if (!res.ok) throw new Error(res.err); }
    catch (error) { showNotice(error.message); }
  };
  document.addEventListener('pointerdown', event => {
    if (!menu.contains(event.target) && !event.target.closest('.team-composer-pill')) close();
  });
  menu.addEventListener('keydown', event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true); } });

  async function send(raw) {
    if (saving) return;
    const agent = currentAgent, settings = config(), team = selectedTeam(), run = liveRun();
    if (!agent || !raw.trim()) return;
    if (!team) { await open(); return; }
    if (composerAttachments.length) { showNotice('Team chat currently accepts text. Remove the attachments or turn Teams off; your draft and files are still here.'); return; }
    const snapshot = { text: raw, contextAgentId: agent.id, attachments: [] };
    const target = settings.liveTarget === 'selected' ? selectedLiveMemberAgentId() : '';
    composerIntentPending = true; updateSendControl(); close();
    try {
      if (activeTeamRun && !run) throw new Error('Another conversation has the active team. Open that conversation or finish its run first.');
      if (run) {
        if (run.team.id !== team.id) throw new Error('Finish the active team before choosing another team.');
        if (settings.liveTarget === 'selected' && !target) throw new Error('Select a live member tab to receive your message.');
        const result = await reachApi.teams.followup({ teamRunId: run.teamRunId, teamId: team.id, agentId: agent.id, target, message: raw.trim() });
        if (!result.ok) throw new Error(result.err);
        if (currentAgent?.id === agent.id) appendChatMessage('user', raw.trim());
      } else {
        if (agentRunning || runningAgentIds.has(agent.id)) throw new Error('Wait for this conversation to finish before starting the team.');
        teamDispatching = true;
        const result = await reachApi.teams.run(team.id, raw.trim(), agent.dir, agent.id, settings.useHistory !== false);
        if (!result.ok) throw new Error(result.err);
        startTeamRunView(result.teamRunId, team, raw.trim(), agent.id);
        for (const event of pendingTeamEvents) handleTeamEvent(event);
      }
      clearSuccessfulComposer(snapshot, { attachments: false });
      await loadAgentTree();
    } catch (error) {
      showNotice(`Team message not sent: ${error.message}`);
    } finally {
      teamDispatching = false; pendingTeamEvents = [];
      composerIntentPending = false; updateSendControl();
    }
  }
  window.ReachTeamComposer = { sync, open, send, saving: () => saving, enabled: () => config().enabled === true };
  sync();
})();
