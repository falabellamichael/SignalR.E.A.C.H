// ---------- Create page: custom agents (personas) + teams ----------
let personas = [];
let teams = [];
let roles = [];                // preset crew roles (agent/roles.cjs) — the dropdown catalog
let editingPersonaId = null;
let editingTeamId = null;
let teamBuilderMembers = [];   // [{personaId, roleId, role}] while the modal is open
let activeTeamRun = null;      // Selected chat's live run, never another chat's.
const teamRunViews = new Map(); // Live event routing by teamRunId, including background chats.
const teamConversationViews = new Map(); // Latest deck retained per conversation.
let teamDispatching = false;
let pendingTeamEvents = [];
const earlyTeamEdits = new Map();

function discardTeamConversation(agentId) {
  const run = teamConversationViews.get(agentId);
  if (!run) return;
  teamRunViews.delete(run.teamRunId); teamConversationViews.delete(agentId);
  run.stop.remove(); run.deck.dispose(); run.wrap.remove();
  syncSelectedTeamRun();
}

function syncSelectedTeamRun() {
  const selected = teamConversationViews.get(currentAgent?.id || null);
  activeTeamRun = selected && !selected.deck.ended ? selected : null;
  for (const run of teamConversationViews.values()) {
    run.stop?.remove();
    if (run !== selected) run.deck.unmount();
  }
  if (activeTeamRun?.stop) document.querySelector('header .statusbar').prepend(activeTeamRun.stop);
  placeSelectedTeamDeck();
  invalidateComposerCatalog();
}

function placeSelectedTeamDeck() {
  const selected = currentAgent ? teamConversationViews.get(currentAgent.id) : null;
  const inSlot = !!selected && (selected === activeTeamRun || currentAgent.settings?.teamChat?.enabled === true);
  for (const deck of teamDeckSlot.querySelectorAll(':scope > .team-deck')) {
    if (deck !== selected?.wrap || !inSlot) { deck._teamDeck?.unmount(); deck.remove(); }
  }
  window.ReachActivity.setTeamVisible(inSlot);
  if (!selected) return;
  const host = inSlot ? teamDeckSlot : chatLog;
  if (selected.wrap.parentElement !== host) host.prepend(selected.wrap);
  if (inSlot) selected.deck.mount(chatScroll);
  else selected.deck.unmount();
}

async function loadCreatePage() {
  personas = await reachApi.personas.list();
  teams = await reachApi.teams.list();
  const recoverableRuns = await reachApi.teams.recoverable().catch(() => []);
  roles = await reachApi.roles.list();
  /* Load connections too, so a persona card can NAME the connection it is pinned
   * to instead of showing a bare id. Best-effort: if the list cannot load the
   * cards still render, they just fall back to the id. */
  await loadConnectionChoices();
  renderPersonaList();
  renderTeamList();
  renderRecoverableTeamRuns(recoverableRuns);
  window.ReachTeamComposer?.sync();
}

function renderRecoverableTeamRuns(runs) {
  const el = $('#team-recovery-list');
  el.replaceChildren();
  for (const run of runs) {
    const card = document.createElement('div');
    card.className = 'team-card';
    const heading = document.createElement('strong');
    heading.textContent = `${run.manifest?.team?.name || 'Crew'} · recoverable run`;
    const note = document.createElement('div');
    note.className = 'persona-card-prompt';
    note.textContent = `${run.manifest?.task || 'Crew task'}\n${run.members.length} saved member turn(s) · ${run.messages.length} crew message(s) · ${run.evidence.length} tool result(s)`;
    const button = document.createElement('button');
    button.className = 'ghost small';
    button.textContent = 'Harvest partial results';
    button.onclick = async () => {
      const recovered = await reachApi.teams.harvest(run.runId);
      if (!recovered.ok) { note.textContent = recovered.err || 'The crew journal could not be read.'; return; }
      let pre = card.querySelector('pre');
      if (!pre) { pre = document.createElement('pre'); pre.className = 'team-recovery-output'; card.append(pre); }
      pre.textContent = [
        `Original task: ${recovered.manifest.task}`,
        recovered.members.map(member => `${member.name} (${member.status})\n${member.output || teamErrorSummary(member.error) || '(no answer yet)'}`).join('\n\n'),
        recovered.messages.map(message => `${message.from} → ${message.to}: ${message.message}`).join('\n'),
        recovered.evidence.map(item => `${item.agentId}: ${item.tool} ${item.ok ? 'ok' : 'failed'}${item.path ? ` ${item.path}` : ''}${item.decision ? ` (${item.decision})` : ''}`).join('\n'),
      ].filter(Boolean).join('\n\n').slice(0, 100000);
    };
    card.append(heading, note, button);
    el.append(card);
  }
}

/** Connection display name for an id, or null when unknown/deleted. */
function connectionLabel(id) {
  if (!id) return null;
  const c = (connChoices || []).find(x => x.id === id);
  return c ? (c.name || c.endpoint) : null;
}

function renderPersonaList() {
  /* The create workbench owns the markup; this keeps the data loading, the
   * connection naming and the modals here, where the rest of the app state
   * lives. See create-page.js. */
  window.ReachCreatePage.renderAgents(personas, { connectionLabel, edit: openPersonaModal, teams, roles, connections: connChoices || [] });
}

function renderTeamList() {
  window.ReachCreatePage.renderTeams(teams, { edit: openTeamModal, run: openTeamRunModal, roles, connections: connChoices || [] });
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

/* ----- SOUL.md + MEMORY.md editors (per agent) ----- */
/* The two files only exist for a SAVED agent, because their directory is keyed
 * by the persona id. So a brand-new agent starts from the scaffolds (rendered
 * for the name being typed) and both files are written when the persona is
 * first saved; an existing agent loads its real files. */
let personaFileCaps = { soul: 8000, memory: 16000 };
/* The scaffold TEXT, cached. Named distinctly from personaFileDefaults(),
   which ASKS main for it — a variable and a function cannot share a name. */
let personaFileScaffold = { soul: '', memory: '' };
let personaFilesDirty = false;

function setPersonaFilesStatus(text) {
  const el = $('#persona-files-status');
  if (el) el.textContent = text || '';
}

function updatePersonaFileCounts() {
  const soul = $('#persona-soul'), memory = $('#persona-memory');
  const soulEl = $('#persona-soul-count'), memoryEl = $('#persona-memory-count');
  if (soulEl) soulEl.textContent = `${soul.value.length} / ${personaFileCaps.soul}`;
  if (memoryEl) memoryEl.textContent = `${memory.value.length} / ${personaFileCaps.memory}`;
}

/** Load the scaffolds once (used for a new agent and for Restore). */
async function personaFileDefaults(name, role) {
  try {
    const res = await reachApi.soul.defaults(name || 'Agent', role || '');
    if (res?.ok) personaFileScaffold = { soul: res.soul || '', memory: res.memory || '' };
  } catch { /* keep whatever scaffolds we already have */ }
  return personaFileScaffold;
}

async function loadPersonaFiles(persona) {
  const soul = $('#persona-soul'), memory = $('#persona-memory');
  soul.value = '';
  memory.value = '';
  personaFilesDirty = false;
  if (!persona) {
    const defaults = await personaFileDefaults($('#persona-name').value.trim());
    soul.value = defaults.soul;
    memory.value = defaults.memory;
    setPersonaFilesStatus('Created when you save this agent.');
    updatePersonaFileCounts();
    return;
  }
  try {
    const [soulRes, memRes] = await Promise.all([
      reachApi.soul.get(persona.id, 'soul'),
      reachApi.soul.get(persona.id, 'memory'),
    ]);
    if (soulRes?.caps) personaFileCaps = soulRes.caps;
    soul.value = soulRes?.text || '';
    memory.value = memRes?.text || '';
    const exists = soulRes?.exists || {};
    const missing = [];
    if (!exists.soul) missing.push('SOUL.md');
    if (!exists.memory) missing.push('MEMORY.md');
    setPersonaFilesStatus(missing.length ? `${missing.join(' and ')} missing — save to create it.` : '');
  } catch (e) {
    setPersonaFilesStatus('Could not read agent files: ' + (e?.message || e));
  }
  updatePersonaFileCounts();
}

/** True when the two textareas differ from what was loaded. */
function personaFilesChanged(persona) {
  if (!persona) return true;
  return personaFilesDirty;
}

async function savePersonaFiles(personaId) {
  const soul = $('#persona-soul').value;
  const memory = $('#persona-memory').value;
  const results = await Promise.all([
    reachApi.soul.set(personaId, 'soul', soul),
    reachApi.soul.set(personaId, 'memory', memory),
  ]);
  const failed = results.filter(r => !r?.ok);
  if (failed.length) {
    setPersonaFilesStatus('Could not save: ' + (failed[0].err || 'unknown error'));
    return false;
  }
  personaFilesDirty = false;
  const truncated = results.some(r => r.truncated);
  setPersonaFilesStatus(truncated ? 'Saved (trimmed to the size cap).' : 'Saved.');
  updatePersonaFileCounts();
  return true;
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
  const files = $('#persona-files');
  if (files) files.open = false;
  await loadPersonaFiles(p);
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
for (const id of ['#persona-soul', '#persona-memory']) {
  $(id).addEventListener('input', () => {
    personaFilesDirty = true;
    setPersonaFilesStatus('Unsaved changes.');
    updatePersonaFileCounts();
  });
}
/* A new agent's scaffolds carry the name, so re-render them while the name is
 * still being typed — but NEVER once the user has touched the fields, and never
 * for an existing agent (that would overwrite real writing on the next load). */
$('#persona-name').addEventListener('input', async () => {
  if (editingPersonaId || personaFilesDirty) return;
  const defaults = await personaFileDefaults($('#persona-name').value.trim());
  $('#persona-soul').value = defaults.soul;
  $('#persona-memory').value = defaults.memory;
  updatePersonaFileCounts();
});
$('#btn-persona-files-reset').onclick = async () => {
  const label = editingPersonaId ? 'Restore the scaffold text? This replaces what is in both boxes.'
    : 'Reset both boxes to the scaffold text?';
  if (!await confirmAction(label)) return;
  const defaults = await personaFileDefaults($('#persona-name').value.trim());
  $('#persona-soul').value = defaults.soul;
  $('#persona-memory').value = defaults.memory;
  personaFilesDirty = true;
  setPersonaFilesStatus('Scaffolds restored — save to write them.');
  updatePersonaFileCounts();
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
  /* The persona id only exists after this save, so the files are written here
   * rather than with the rest of the modal state. An EXISTING agent is only
   * rewritten when its boxes actually changed, so a plain "rename" cannot
   * clobber a soul or memory the user edited outside the app. */
  const personaId = res.persona?.id || editingPersonaId;
  if (personaId && personaFilesChanged(res.persona || null)) {
    const ok = await savePersonaFiles(personaId);
    if (!ok) return;
  }
  $('#persona-modal').classList.add('hidden');
  window.ReachCreatePage.select('agents', personaId);
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
  window.ReachCreatePage.select('teams', res.team?.id || editingTeamId);
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
  await window.ReachTeamComposer.open();
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
    earlyTeamEdits.clear();
  }
};

/* Deployed team tabs hang from the top of the chat. Member DOM stays alive
 * behind each tab, preserving tool results and unanswered questions. */
function startTeamRunView(teamRunId, team, task, agentId = currentAgent?.id, { autoRouted = false } = {}) {
  const previous = teamConversationViews.get(agentId || null);
  if (previous) {
    previous.stop.remove();
    previous.deck.finish('stopped');
    teamRunViews.delete(previous.teamRunId);
  }
  const run = { teamRunId, team, task, agentId, cards: new Map(), subCards: new Map(), buffer: new Map() };
  invalidateComposerCatalog();
  // Endpoint/model validation can take long enough for the user to navigate.
  // Never mount conversation A's team deck inside conversation B. The retained
  // deck DOM moves into its bound chat through renderChatHistory when selected.
  const boundToCurrent = !!agentId && currentAgent?.id === agentId;
  if (boundToCurrent && team.id) {
    if (!autoRouted) currentAgent.settings = { ...currentAgent.settings, teamChat: { ...currentAgent.settings?.teamChat, enabled: true, teamId: team.id } };
    appendChatMessage('user', task);
  }
  const host = boundToCurrent ? teamDeckSlot : !agentId ? noAgent : null;
  if (!boundToCurrent && !currentAgent) { noAgent.classList.remove('hidden'); agentView.classList.add('hidden'); }
  const teamKey = team.id || `${team.name}:${team.mode}`;
  const existing = previous?.wrap.dataset.teamKey === teamKey ? previous.wrap : null;
  if (previous && !existing) { previous.deck.dispose(); previous.wrap.remove(); }
  for (const wrap of host?.querySelectorAll(':scope > .team-deck') || []) wrap._teamDeck?.unmount();
  run.deck = existing?._teamDeck || window.ReachTeamDeck.create({ team, task });
  if (existing) run.deck.restart({ team, task });
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
  run.stop = stop;
  const wrap = run.deck.element;
  wrap._teamDeck = run.deck;
  wrap._retainTeamView = true;
  wrap.dataset.teamRunId = teamRunId;
  wrap.dataset.teamKey = teamKey;
  wrap.dataset.conversationId = agentId || '';
  host?.prepend(wrap);
  run.wrap = wrap;
  teamRunViews.set(teamRunId, run);
  teamConversationViews.set(agentId || null, run);
  syncSelectedTeamRun();
  for (const edit of earlyTeamEdits.get(teamRunId) || []) handleTeamEditPending({ teamRunId, edit });
  earlyTeamEdits.delete(teamRunId);
  updateSendControl();
  if (host) {
    const scroller = boundToCurrent ? chatScroll : host;
    scroller.scrollTop = 0;
    if (!boundToCurrent) run.deck.mount(scroller);
  }
}

function teamCard(index, name, model, run = activeTeamRun) {
  if (!run) return null;
  let card = run.cards.get(index);
  if (card) { run.deck.identify(card, name, model); return card; }
  card = document.createElement('div');
  card.className = 'member-card';
  card.innerHTML = `<div class="member-head"><div class="member-identity"><strong class="member-name"></strong><span class="member-model"></span></div><span class="member-state dim">starting…</span><span class="member-meta"></span></div>`
    + `<div class="member-body"></div>`;
  run.cards.set(index, card);
  addMemberControl(card, run, { index });
  run.deck.add(card, { name, model });
  return card;
}

/* Spawned workers join the same rail and retain their own independent panel. */
function subCard(agentId, name, model, depth, run = activeTeamRun) {
  if (!run) return null;
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

