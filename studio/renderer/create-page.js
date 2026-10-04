/* Create library: presentation and selection only. The existing app owns all
 * persistence, agent editors, team editors, recovery and run dispatch. */
(() => {
  'use strict';
  const q = selector => document.querySelector(selector);
  let library = 'teams';
  const selected = { teams: null, agents: null };
  let agents = [], teams = [], agentActions = {}, teamActions = {};

  function node(tag, className, text) {
    const el = document.createElement(tag);
    if (className) el.className = className;
    if (text !== undefined) el.textContent = text;
    return el;
  }
  function icon(name) {
    const el = node('i', `create-icon icon-${name}`);
    el.setAttribute('aria-hidden', 'true');
    return el;
  }
  function monogram(name) {
    const el = node('span', 'create-monogram', Array.from(name || '?')[0].toUpperCase());
    el.setAttribute('aria-hidden', 'true');
    return el;
  }
  function action(label, name, handler, primary = false) {
    const el = node('button', primary ? 'ghost create-primary-action' : 'ghost');
    el.type = 'button';
    el.append(icon(name), document.createTextNode(label));
    el.onclick = handler;
    return el;
  }
  function modeChip(mode) {
    return node('span', `create-mode mode-${['links', 'parallel', 'chain'].includes(mode) ? mode : 'parallel'}`,
      mode === 'links' ? 'Links' : mode === 'chain' ? 'Chain' : 'Parallel');
  }
  function field(label, value) {
    const el = node('div', 'create-field');
    el.append(node('span', 'create-field-label', label), node('span', 'create-field-value', value));
    return el;
  }
  function connection(agent, team) {
    if (agent?.connectionId) return agentActions.connectionLabel?.(agent.connectionId) || 'Deleted connection';
    return team?.spreadConnections ? 'Automatic · team pool' : 'Active connection';
  }
  function reconcile(kind, items) {
    if (!items.some(item => item.id === selected[kind])) selected[kind] = items[0]?.id || null;
  }
  function select(kind, id) {
    library = kind;
    selected[kind] = id;
    render();
  }
  function switchLibrary(kind) {
    library = kind;
    render();
  }
  function renderList(kind, items) {
    const host = q(kind === 'teams' ? '#team-list' : '#persona-list');
    host.replaceChildren();
    if (!items.length) {
      const empty = node('div', 'create-library-empty');
      empty.append(node('strong', '', kind === 'teams' ? 'Your first team starts here.' : 'Give an agent its own purpose.'),
        node('p', '', kind === 'teams' ? 'Create custom agents, then bring them together in a team.' : 'Choose a name, model and custom instructions.'));
      host.append(empty);
      return;
    }
    for (const item of items) {
      const row = node('button', `create-library-item ${kind === 'teams' ? 'team-card' : 'persona-card'}`);
      row.type = 'button';
      row.dataset.id = item.id;
      row.setAttribute('aria-pressed', String(item.id === selected[kind]));
      const copy = node('span', 'create-library-copy');
      copy.append(node('strong', '', item.name));
      if (kind === 'teams') {
        copy.append(node('span', 'create-library-description', (item.members || []).map(member => member.personaName).join(' · ') || 'No members yet'));
        row.append(copy, modeChip(item.mode));
      } else {
        copy.append(node('span', 'create-library-description', item.model || 'Default model'));
        row.append(monogram(item.name), copy);
      }
      row.onclick = () => select(kind, item.id);
      host.append(row);
    }
  }
  function detailHeading(item, kind) {
    const head = node('div', 'create-detail-heading');
    const title = node('div', 'create-detail-title');
    title.append(node('h2', '', item.name));
    if (kind === 'teams') title.append(modeChip(item.mode));
    const actions = node('div', 'create-detail-actions');
    actions.append(action(kind === 'teams' ? 'Edit team' : 'Edit agent', 'pencil', () => {
      if (kind === 'teams') teamActions.edit?.(item); else agentActions.edit?.(item);
    }));
    if (kind === 'teams') actions.append(action('Run team', 'play', () => teamActions.run?.(item), true));
    head.append(title, actions);
    return head;
  }
  function teamDetail(team) {
    const host = q('#create-detail');
    host.append(detailHeading(team, 'teams'));
    const explanation = team.mode === 'chain' ? 'Members work in order, passing each answer to the next.'
      : team.mode === 'links' ? 'Members can exchange messages while working on the task.'
        : 'Every member gets the same task and works at the same time.';
    host.append(node('p', 'create-detail-description', explanation));
    const roster = node('ol', `create-roster roster-${team.mode || 'parallel'}`);
    for (const member of team.members || []) {
      const agent = agents.find(candidate => candidate.id === member.personaId);
      const row = node('li', 'create-member');
      const identity = node('div', 'create-member-identity');
      const copy = node('div', 'create-member-copy');
      copy.append(node('strong', '', member.personaName || agent?.name || 'Missing agent'), node('span', '', member.role || 'Team member'));
      identity.append(monogram(member.personaName || agent?.name), copy);
      row.append(identity, field('Model', agent?.model || 'Default model'), field('Connection', connection(agent, team)));
      if (!agent) row.append(node('p', 'create-member-warning', 'This agent is unavailable. Edit the team to update its members.'));
      roster.append(row);
      if (team.mode === 'chain' || team.mode === 'links') {
        const connector = node('li', 'create-roster-connector');
        connector.setAttribute('aria-hidden', 'true');
        connector.append(icon(team.mode === 'chain' ? 'arrow-down' : 'arrows-down-up'));
        roster.append(connector);
      }
    }
    if (roster.lastElementChild?.classList.contains('create-roster-connector')) roster.lastElementChild.remove();
    if (!team.members?.length) host.append(node('p', 'create-detail-description', 'Add custom agents to give this team its members.'));
    host.append(roster);
    const footer = node('div', 'create-detail-footer');
    const metadata = node('div', 'create-metadata');
    const protocol = node('span');
    protocol.append(icon('wrench'), document.createTextNode(team.toolProtocol === 'native' ? 'Native tools' : 'JSON tools'));
    const routing = node('span');
    routing.append(icon('plugs'), document.createTextNode(team.spreadConnections ? 'Multiple endpoints' : 'Active connection'));
    metadata.append(protocol, routing);
    footer.append(metadata, node('p', '', 'Edit the team to change roles, members and how they work together.'));
    host.append(footer);
  }
  function agentDetail(agent) {
    const host = q('#create-detail');
    host.append(detailHeading(agent, 'agents'), node('p', 'create-detail-description', 'A reusable agent with its own instructions, model and connection.'));
    const identity = node('div', 'create-agent-overview');
    identity.append(monogram(agent.name), field('Model', agent.model || 'Default model'), field('Connection', connection(agent)));
    const instructions = node('div', 'create-instructions');
    instructions.append(node('h3', '', 'Custom instructions'), node('p', '', agent.prompt || 'No custom instructions yet.'));
    const footer = node('div', 'create-detail-footer');
    footer.append(node('p', '', 'Edit the agent to update its instructions, model, connection, SOUL.md or MEMORY.md.'));
    host.append(identity, instructions, footer);
  }
  function render() {
    const focusedRow = document.activeElement?.closest('.create-library-item');
    const focusId = focusedRow?.dataset.id;
    const focusKind = focusedRow?.closest('#team-list') ? 'teams' : 'agents';
    const scrollTop = q('.create-library-scroll').scrollTop;
    for (const kind of ['teams', 'agents']) {
      const active = library === kind;
      const tab = q(`#create-tab-${kind}`);
      tab.setAttribute('aria-selected', String(active));
      tab.tabIndex = active ? 0 : -1;
      q(`#create-${kind}-panel`).classList.toggle('hidden', !active);
    }
    q('#create-recovery').classList.toggle('hidden', library !== 'teams');
    renderList('teams', teams);
    renderList('agents', agents);
    if (focusId) {
      const list = q(focusKind === 'teams' ? '#team-list' : '#persona-list');
      [...list.children].find(row => row.dataset.id === focusId)?.focus({ preventScroll: true });
    }
    q('.create-library-scroll').scrollTop = scrollTop;
    const host = q('#create-detail');
    host.replaceChildren();
    const item = (library === 'teams' ? teams : agents).find(candidate => candidate.id === selected[library]);
    if (item) {
      if (library === 'teams') teamDetail(item); else agentDetail(item);
    } else {
      const empty = node('div', 'create-detail-empty');
      empty.append(node('h2', '', library === 'teams' ? 'Build your first team' : 'Create your first agent'),
        node('p', '', library === 'teams' ? 'Bring your custom agents together and choose how they work.' : 'Give an agent a name and instructions for the work you want it to do.'),
        action(library === 'teams' ? 'New team' : 'New agent', 'plus', () => q(library === 'teams' ? '#btn-new-team' : '#btn-new-persona').click(), true));
      host.append(empty);
    }
  }
  for (const kind of ['teams', 'agents']) {
    const tab = q(`#create-tab-${kind}`);
    tab.onclick = () => switchLibrary(kind);
    tab.onkeydown = event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const next = event.key === 'Home' ? 'teams' : event.key === 'End' ? 'agents' : kind === 'teams' ? 'agents' : 'teams';
      switchLibrary(next);
      q(`#create-tab-${next}`).focus();
    };
  }
  window.ReachCreatePage = {
    renderAgents(items, actions) { agents = items; agentActions = actions; reconcile('agents', agents); render(); },
    renderTeams(items, actions) { teams = items; teamActions = actions; reconcile('teams', teams); render(); },
    select,
  };
})();
