'use strict';
(() => {
  const { node, action } = window.ReachWorkspace;
  const panel = node('section');
  panel.id = 'singular-panel';
  panel.setAttribute('aria-label', 'Info conversation details');

  // === LEFT COLUMN: Conversation, Performance, GitHub, Actions ===
  const colLeft = node('div', 'singular-col-info');

  const title = node('h2', '', 'Select a conversation');
  const status = node('p', 'singular-status');
  colLeft.append(node('span', 'singular-eyebrow', 'Info / workspace'), title, status);

  const fields = {};
  function section(label, entries) {
    const details = node('details', 'singular-details'); details.open = true;
    const list = node('dl');
    for (const [key, name] of entries) {
      fields[key] = node('dd', '', 'Not reported');
      list.append(node('dt', '', name), fields[key]);
    }
    details.append(node('summary', '', label), list); colLeft.append(details);
    return details;
  }

  section('Conversation', [['model', 'Model'], ['directory', 'Workpath'], ['messages', 'Messages'], ['tasks', 'Tasks completed'], ['edits', 'Pending edits']]);
  const performance = section('Performance', [['cpu', 'CPU usage'], ['gpu', 'GPU usage'], ['ram', 'RAM used'], ['vram', 'VRAM used'], ['device', 'GPU device']]);
  performance.append(node('p', 'singular-perf-note', 'This machine only. These readings do not measure a remote subscription GPU or model generation speed.'));
  const stamp = node('p', 'singular-perf-stamp', 'Waiting for a sample.');
  stamp.setAttribute('role', 'status');
  performance.append(stamp);

  // GitHub & Repository
  const githubSection = node('details', 'singular-details singular-github');
  githubSection.open = true;
  const githubSummary = node('summary', '', 'GitHub & Repository');
  const githubBody = node('div', 'singular-github-body');
  githubSection.append(githubSummary, githubBody);
  colLeft.append(githubSection);

  // Actions footer
  const actions = node('div', 'singular-actions');
  actions.append(
    action('Files', () => selectDrawerPanel('files')),
    action('Browser', () => selectDrawerPanel('browser')),
    action('Plugins / MCP', () => {
      if (typeof openSettingsPanel === 'function') openSettingsPanel('mcp');
      else if (typeof showTab === 'function') showTab('settings');
    }),
    action('Telemetry details', () => window.ReachTelemetry.details())
  );
  colLeft.append(actions);

  // === RIGHT COLUMN: Team / Bots ===
  const colRight = node('section', 'singular-col-team singular-team');
  const teamHead = node('div', 'singular-team-head');
  const teamTitle = node('h3', '', 'Team');
  const teamBadge = node('span', 'singular-team-badge');
  teamHead.append(teamTitle, teamBadge);

  const teamLinkRow = node('div', 'singular-team-link-row');
  const teamNote = node('p', 'singular-team-note', 'No team linked to this conversation.');
  const teamList = node('div', 'singular-team-list');
  colRight.append(teamHead, teamLinkRow, teamNote, teamList);

  panel.append(colLeft, colRight);
  drawer.append(panel);

  const menu = action('Info', () => selectDrawerPanel('singular'));
  menu.id = 'btn-show-singular';
  menu.setAttribute('role', 'menuitem');
  $('#drawer-menu').prepend(menu);

  let timer = null, pending = false, lastSample = 0;
  function visible() { return drawerOpen && drawerPanel === 'singular' && !document.hidden; }
  function set(key, value) {
    const text = String(value);
    if (fields[key] && fields[key].textContent !== text) fields[key].textContent = text;
  }
  const percent = value => Number.isFinite(value) ? Math.round(value) + '%' : 'Not reported';
  const bytes = value => Number.isFinite(value) ? (value / 1024 ** 3).toFixed(1) + ' GB' : 'Not reported';

  function conversation() {
    const agent = currentAgent;
    title.textContent = agent?.name || 'Select a conversation';
    status.textContent = agent ? 'Single conversation / ' + (agent.runState?.status || 'idle') : 'Open a conversation to inspect its details.';
    set('model', agent?.model || 'Default model');
    set('directory', agent?.dir || 'No workpath');
    set('messages', agent?.messages?.length ?? 0);
    const tasks = agent?.todos || [];
    set('tasks', tasks.filter(task => task.status === 'completed').length + ' / ' + tasks.length);
    set('edits', Object.keys(agent?.pendingEdits || {}).length);
    if (Date.now() - teamAt >= 3000) {
      teamAt = Date.now();
      renderTeam(agent);
      renderGit(agent);
    }
  }

  let teamToken = 0, teamAt = 0, teamSig = '';
  const activityTiles = [];
  let nextActionAt = Infinity;
  function syncTeamVisibility() {
    const enabled = currentAgent?.settings?.teamChat?.enabled === true;
    teamList.classList.toggle('hidden', !enabled);
    teamBadge.classList.toggle('hidden', !enabled);
    if (!enabled) {
      teamNote.textContent = 'Teams is off. Turn it on to show your bots.';
      teamNote.hidden = false;
    }
  }
  function updateTeamActivity(agent) {
    nextActionAt = Infinity;
    const now = Date.now();
    const latest = typeof teamConversationViews !== 'undefined' ? teamConversationViews.get(agent?.id) : null;
    for (const tile of activityTiles) {
      // Member indices are valid only for the roster captured by this run.
      const run = latest?.team?.id === tile.teamId && latest.team.members?.[tile.index]?.personaId === tile.personaId
        && (latest.team.members[tile.index].role || '') === tile.role ? latest : null;
      const card = run?.cards.get(tile.index);
      const state = card?._teamActivity;
      const summary = state ? window.ReachActivityState.summary(state) : null;
      const put = (element, text) => { if (element.textContent !== text) element.textContent = text; };
      put(tile.headline, summary?.title || (run ? 'Queued - waiting to start' : 'Idle - no current activity'));
      put(tile.detail, summary?.detail || (run ? 'Waiting for this member to receive work.' : 'Start a team task to see this agent\'s activity here.'));
      put(tile.task, run?.task || 'No task in this session.');
      tile.card.dataset.activity = state?.status || (run ? 'queued' : 'idle');
      const action = window.ReachMemberDesigns.actionFor(state || (run ? { status: 'queued' } : null), now);
      window.ReachMemberDesigns.applyAction(tile.portrait, action);
      if (state && action !== 'idle' && ['completed', 'error', 'failed', 'paused', 'stopped', 'stalled'].includes(state.status)) {
        nextActionAt = Math.min(nextActionAt, (state.endedAt ?? state.updatedAt) + 1500);
      }
      const recent = (state?.steps || []).slice(-4).map(step => [step.title, step.note].filter(Boolean).join(' - ')).join('\n');
      put(tile.recent, recent || 'No activity reported yet.');
    }
  }
  function renderTeam(agent) {
    const token = ++teamToken;
    const linked = agent?.settings?.teamChat?.teamId;

    reachApi.teams.list().then(teams => {
      if (token !== teamToken) return;
      const allTeams = teams || [];

      // Update team link/switch controls
      if (agent && allTeams.length > 0) {
        teamLinkRow.replaceChildren();
        const sel = node('select', 'singular-team-select');
        const defaultOpt = node('option', '', 'Choose a team…');
        defaultOpt.value = '';
        sel.appendChild(defaultOpt);
        for (const t of allTeams) {
          const opt = node('option', '', t.name || 'Team');
          opt.value = t.id;
          if (t.id === linked) opt.selected = true;
          sel.appendChild(opt);
        }
        if (linked) sel.value = linked;

        const btn = node('button', 'ghost small', linked ? 'Switch' : 'Link');
        btn.onclick = async () => {
          if (!sel.value) {
            agent.settings = { ...agent.settings, teamChat: { ...agent.settings?.teamChat, enabled: false, teamId: '' } };
          } else {
            agent.settings = { ...agent.settings, teamChat: { ...agent.settings?.teamChat, enabled: true, teamId: sel.value } };
          }
          await reachApi.agents.update(agent.id, { settings: agent.settings });
          syncTeamVisibility();
          teamAt = 0;
          renderTeam(agent);
        };
        teamLinkRow.append(sel, btn);
        teamLinkRow.hidden = false;
      } else {
        teamLinkRow.hidden = true;
      }

      if (!agent || !linked || agent.settings?.teamChat?.enabled !== true) {
        activityTiles.length = 0;
        teamSig = '';
        teamList.replaceChildren();
        teamBadge.textContent = '';
        teamTitle.textContent = 'Team';
        teamNote.textContent = agent ? agent.settings?.teamChat?.enabled === true ? 'No team assigned to this chat.' : 'Teams is off. Turn it on to show your bots.' : 'Open a conversation to view its team.';
        teamNote.hidden = false;
        return;
      }

      const team = allTeams.find(item => item.id === linked);
      if (!team) {
        activityTiles.length = 0;
        teamSig = '';
        teamTitle.textContent = 'Team';
        teamBadge.textContent = '';
        teamNote.textContent = 'The linked team was removed.';
        teamNote.hidden = false;
        teamList.replaceChildren();
        return;
      }

      teamTitle.textContent = team.name || 'Team';
      const count = (team.members || []).length;
      teamBadge.textContent = `${count} member${count === 1 ? '' : 's'}`;
      const sig = JSON.stringify([agent.id, team.id, team.mode, team.toolProtocol, team.spreadConnections, team.members]);
      if (sig === teamSig) { updateTeamActivity(agent); return; }
      teamSig = sig;
      activityTiles.length = 0;
      teamList.replaceChildren();
      teamNote.hidden = true;

      for (const [index, member] of (team.members || []).entries()) {
        const design = window.ReachMemberDesigns.resolve(member);
        const card = node('article', 'singular-member');
        const face = node('span', 'singular-member-face');
        face.innerHTML = window.ReachMemberDesigns.svg(design.id, 64);

        const copy = node('div', 'singular-member-copy');
        const topRow = node('div', 'singular-member-top');
        topRow.append(node('strong', '', member.personaName || 'Member'));

        const roleText = member.role || 'General-purpose agent';
        copy.append(topRow, node('span', 'singular-member-role', roleText));
        const facts = node('dl', 'singular-member-facts');
        const fact = (label, value) => { facts.append(node('dt', '', label), node('dd', '', value)); };
        fact('Model', member.personaModel || 'Inherits chat model');
        copy.append(facts);
        const activity = node('details', 'singular-member-activity');
        const headline = node('summary');
        const detail = node('p');
        const task = node('p');
        const recent = node('p', 'singular-member-recent');
        activity.append(headline, detail, node('strong', '', 'Current task'), task, node('strong', '', 'Recent activity'), recent);
        activityTiles.push({ portrait: face.querySelector('svg'), teamId: team.id, personaId: member.personaId, role: member.role || '', index, card, headline, detail, task, recent });
        card.append(activity);
        card.append(face, copy);
        teamList.append(card);
      }
      updateTeamActivity(agent);

      if (!team.members?.length) {
        teamNote.textContent = 'This team has no members yet.';
        teamNote.hidden = false;
      }
    }).catch(error => {
      if (token !== teamToken) return;
      teamNote.textContent = 'Team unavailable: ' + error.message;
      teamNote.hidden = false;
    });
  }

  let gitToken = 0;
  function renderGit(agent) {
    const token = ++gitToken;
    const dir = agent?.dir;
    if (!dir) {
      githubBody.innerHTML = '<p class="dim" style="margin:0;font-size:11.5px;">No active project directory.</p>';
      return;
    }

    reachApi.git.info(dir).then(info => {
      if (token !== gitToken) return;
      githubBody.replaceChildren();

      const dl = node('dl');
      const addRow = (term, valNode) => {
        const dt = node('dt', '', term);
        const dd = node('dd');
        if (typeof valNode === 'string') dd.textContent = valNode;
        else dd.appendChild(valNode);
        dl.append(dt, dd);
      };

      if (info.isGit) {
        if (info.repoSlug) {
          const repoLink = node('a', 'text-link', info.repoSlug);
          repoLink.href = `https://github.com/${info.repoSlug}`;
          repoLink.target = '_blank';
          repoLink.onclick = e => { e.preventDefault(); reachApi.browser.command('new', { url: repoLink.href }); };
          addRow('Repository', repoLink);
        } else if (info.remoteUrl) {
          addRow('Remote', info.remoteUrl.replace(/^.*github\.com[:/]/, 'github.com/'));
        }

        addRow('Branch', info.branch || 'main');
        addRow('Working tree', info.modifiedCount ? `${info.modifiedCount} modified file(s)` : 'Clean');
        if (info.lastCommit) addRow('Last commit', info.lastCommit);
      } else {
        addRow('Git status', 'Not a git repository');
      }
      githubBody.appendChild(dl);

      // Auth / Connection status
      const authRow = node('div', 'singular-github-auth');
      if (info.githubConnected) {
        const userLabel = info.githubUser ? `@${info.githubUser}` : 'GitHub API';
        const pill = node('span', 'conn-badge ok', `✓ Connected (${userLabel})`);
        const sub = node('span', 'dim', 'Agent tools enabled');
        sub.style.fontSize = '11px';
        authRow.append(pill, sub);
      } else {
        const pill = node('span', 'conn-badge off', 'GitHub not connected');
        const connectBtn = node('button', 'ghost small', 'Connect in App Connections');
        connectBtn.onclick = () => {
          if (typeof openSettingsPanel === 'function') openSettingsPanel('apps');
          else if (typeof showTab === 'function') showTab('settings');
        };
        authRow.append(pill, connectBtn);
      }
      githubBody.appendChild(authRow);
    }).catch(() => {
      if (token !== gitToken) return;
      githubBody.innerHTML = '<p class="dim" style="margin:0;font-size:11.5px;">Git inspection unavailable.</p>';
    });
  }

  async function sample() {
    pending = true;
    try {
      const data = await reachApi.telemetry.sample();
      set('cpu', percent(data.cpu?.percent));
      set('gpu', percent(data.gpu?.utilization));
      set('ram', bytes(data.ram?.used));
      set('vram', bytes(data.gpu?.dedicated));
      set('device', data.gpu?.name || 'Not reported');
      stamp.textContent = 'Updated ' + new Date(data.at).toLocaleTimeString();
    } catch (error) {
      for (const key of ['cpu', 'gpu', 'ram', 'vram', 'device']) set(key, 'Unavailable');
      stamp.textContent = 'Telemetry unavailable: ' + error.message;
    } finally {
      pending = false;
      lastSample = Date.now();
    }
  }

  function sync() {
    clearTimeout(timer); timer = null;
    syncTeamVisibility();
    if (!visible()) return;
    conversation();
    updateTeamActivity(currentAgent);
    if (!pending && Date.now() - lastSample >= 3000) sample();
    timer = setTimeout(sync, Math.min(1000, Math.max(1, nextActionAt - Date.now())));
  }

  new MutationObserver(sync).observe(drawer, { attributes: true, attributeFilter: ['class', 'data-panel'] });
  document.addEventListener('visibilitychange', sync);
  document.addEventListener('reach-team-settings-changed', () => { teamAt = 0; sync(); });
  sync();
})();
