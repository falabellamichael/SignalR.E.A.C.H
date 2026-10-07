/* Create library: presentation and selection only. The existing app owns all
 * persistence, agent editors, team editors, recovery and run dispatch. */
(() => {
  'use strict';
  const q = selector => document.querySelector(selector);
  let library = 'teams';
  const selected = { teams: null, agents: null };
  let agents = [], teams = [], agentActions = {}, teamActions = {};
  const catalog = { roles: [], connections: [] };

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
  function modeName(mode) {
    return mode === 'links' ? 'Links' : mode === 'chain' ? 'Chain' : 'Parallel';
  }
  function modeChip(mode) {
    return node('span', `create-mode mode-${['links', 'parallel', 'chain'].includes(mode) ? mode : 'parallel'}`, modeName(mode));
  }
  function roleSpec(member) {
    return catalog.roles.find(role => role.id === member?.roleId) || null;
  }
  function connectionInfo(id) {
    if (!id) return { label: 'Automatic', pinned: false, stale: false, enabled: true };
    const found = catalog.connections.find(connection => connection.id === id);
    if (!found) return { label: 'Missing connection', pinned: true, stale: true, enabled: false };
    return { label: found.name || found.endpoint, pinned: true, stale: false, enabled: found.enabled !== false };
  }
  function shortModel(model) {
    const text = String(model || '').trim();
    return text || 'Default model';
  }
  function unique(values) {
    return [...new Set(values.filter(Boolean))];
  }
  function when(ts) {
    const time = Number(ts);
    if (!Number.isFinite(time) || time <= 0) return '';
    const minutes = Math.round((Date.now() - time) / 60000);
    if (minutes < 1) return 'Updated just now';
    if (minutes < 60) return `Updated ${minutes}m ago`;
    const hours = Math.round(minutes / 60);
    if (hours < 48) return `Updated ${hours}h ago`;
    return `Updated ${new Date(time).toLocaleDateString()}`;
  }
  function teamUsage(agentId) {
    const rows = [];
    for (const team of teams) {
      for (const member of team.members || []) {
        if (member.personaId === agentId) rows.push({ team, member });
      }
    }
    return rows;
  }
  function haystack(kind, item) {
    if (kind === 'teams') {
      return [item.name, item.mode, item.toolProtocol, ...(item.members || []).flatMap(member => [member.personaName, member.role, member.personaModel])].join(' ').toLowerCase();
    }
    return [item.name, item.model, item.prompt, connectionInfo(item.connectionId).label].join(' ').toLowerCase();
  }
  function visible(kind, items) {
    const text = (q('#create-filter')?.value || '').trim().toLowerCase();
    return text ? items.filter(item => haystack(kind, item).includes(text)) : items;
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
    const shown = visible(kind, items);
    host.replaceChildren();
    if (!items.length) {
      const empty = node('div', 'create-library-empty');
      empty.append(node('strong', '', kind === 'teams' ? 'No teams yet' : 'No agents yet'),
        node('p', '', kind === 'teams' ? 'A team runs saved agents together.' : 'An agent is a name, model, connection and instructions.'));
      host.append(empty);
      return;
    }
    if (!shown.length) {
      host.append(node('div', 'create-library-empty', 'Nothing matches that filter.'));
      return;
    }
    for (const item of shown) {
      const row = node('button', `create-library-item ${kind === 'teams' ? 'team-card' : 'persona-card'}`);
      row.type = 'button';
      row.dataset.id = item.id;
      row.setAttribute('aria-pressed', String(item.id === selected[kind]));
      const copy = node('span', 'create-library-copy');
      copy.append(node('strong', '', item.name));
      if (kind === 'teams') {
        const members = item.members || [];
        const missing = members.filter(member => member.personaName === '(deleted)' || !agents.some(agent => agent.id === member.personaId)).length;
        const models = unique(members.map(member => member.personaModel));
        const meta = [`${members.length}`, modeName(item.mode), item.toolProtocol === 'native' ? 'Native' : 'JSON'];
        meta.push(missing ? `${missing} missing` : (models.length ? `${models.length} model${models.length === 1 ? '' : 's'}` : 'Default model'));
        copy.append(node('span', 'create-library-description', meta.join(' · ')));
        row.append(copy, modeChip(item.mode));
      } else {
        const used = teamUsage(item.id).length;
        copy.append(node('span', 'create-library-description', `${shortModel(item.model)} · ${connectionInfo(item.connectionId).label} · ${used} team${used === 1 ? '' : 's'}`));
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
    if (kind === 'teams') title.append(modeChip(item.mode), node('span', 'create-detail-count', `${(item.members || []).length} members`));
    const actions = node('div', 'create-detail-actions');
    actions.append(action(kind === 'teams' ? 'Edit team' : 'Edit agent', 'pencil', () => {
      if (kind === 'teams') teamActions.edit?.(item); else agentActions.edit?.(item);
    }));
    if (kind === 'teams') actions.append(action('Run team', 'play', () => teamActions.run?.(item), true));
    head.append(title, actions);
    return head;
  }
  function fact(label, value, warn = false) {
    const el = node('div', warn ? 'create-fact is-warn' : 'create-fact');
    el.append(node('span', '', label), node('strong', '', value));
    return el;
  }
  function teamDetail(team) {
    const host = q('#create-detail');
    const members = team.members || [];
    const resolved = members.map(member => ({ member, agent: agents.find(agent => agent.id === member.personaId) }));
    const missing = resolved.filter(row => !row.agent).length;
    const models = unique(resolved.map(row => shortModel(row.agent?.model || row.member.personaModel)));
    const pins = resolved.map(row => connectionInfo(row.agent?.connectionId || row.member.personaConnectionId));
    const pinned = pins.filter(pin => pin.pinned && !pin.stale).length;
    const stale = pins.filter(pin => pin.stale).length;
    const pool = catalog.connections.filter(connection => connection.enabled !== false);
    const modeLine = team.mode === 'chain' ? 'Each answer is passed to the next member.'
      : team.mode === 'links' ? 'Members can message each other during the task.'
        : 'Every member receives the same task at the same time.';
    const protocol = team.toolProtocol === 'native' ? 'Native function calls' : 'JSON action contract';
    const rotating = Math.max(0, members.length - pinned - stale);
    let routing = pinned ? `Active connection · ${pinned} pinned` : 'Active connection';
    if (team.spreadConnections && pool.length <= 1) routing = `Spread on · ${pool.length} connection in the pool`;
    else if (team.spreadConnections && rotating) routing = `Spread on · ${rotating} rotate across ${pool.length} · ${pinned} pinned`;
    else if (team.spreadConnections) routing = `Spread on · all ${pinned} members stay on their pinned connection`;
    host.append(detailHeading(team, 'teams'));
    const facts = node('div', 'create-facts');
    facts.append(
      fact('Work', modeLine),
      fact('Tools', protocol),
      fact('Routing', routing, team.spreadConnections && pool.length <= 1),
      fact('Models', models.join(', ') || 'Default model'),
    );
    if (missing || stale) facts.append(fact('Needs attention', [missing ? `${missing} missing agent${missing === 1 ? '' : 's'}` : '', stale ? `${stale} missing connection${stale === 1 ? '' : 's'}` : ''].filter(Boolean).join(' · '), true));
    host.append(facts);
    const roster = node('div', `create-roster roster-${team.mode || 'parallel'}`);
    const headRow = node('div', 'create-roster-head');
    for (const label of ['#', 'Agent', 'Role', 'Model', 'Connection']) headRow.append(node('span', '', label));
    roster.append(headRow);
    resolved.forEach((row, index) => {
      const spec = roleSpec(row.member);
      const roleName = row.member.role || spec?.name || 'No role';
      const link = connectionInfo(row.agent?.connectionId || row.member.personaConnectionId);
      const line = node('div', row.agent ? 'create-member' : 'create-member is-missing');
      const who = node('div', 'create-member-copy');
      who.append(node('strong', '', row.member.personaName || row.agent?.name || 'Missing agent'));
      const role = node('div', 'create-member-copy');
      const roleLabel = node('strong', '', roleName);
      if (spec?.tagline) roleLabel.title = spec.tagline;
      role.append(roleLabel);
      if (spec?.tagline) role.append(node('span', '', spec.tagline));
      const endpoint = node('span', link.stale || link.enabled === false ? 'is-warn' : '', link.pinned ? link.label : 'Automatic');
      if (link.pinned && link.enabled === false) endpoint.title = 'Pinned, but this connection is not in the team pool';
      line.append(node('span', 'create-index', String(index + 1)), who, role, node('span', '', shortModel(row.agent?.model || row.member.personaModel)), endpoint);
      roster.append(line);
    });
    if (!members.length) host.append(node('p', 'create-detail-note', 'This team has no members.'));
    host.append(roster);
  }
  function agentDetail(agent) {
    const host = q('#create-detail');
    const link = connectionInfo(agent.connectionId);
    const used = teamUsage(agent.id);
    const prompt = String(agent.prompt || '');
    host.append(detailHeading(agent, 'agents'));
    const facts = node('div', 'create-facts');
    facts.append(
      fact('Model', shortModel(agent.model)),
      fact('Connection', link.pinned ? link.label : 'Automatic — the team chooses', link.stale || link.enabled === false),
      fact('Instructions', prompt ? `${prompt.length.toLocaleString()} characters` : 'None'),
      fact('Used by', used.length ? `${used.length} team${used.length === 1 ? '' : 's'}` : 'No team'),
    );
    const updated = when(agent.updatedAt);
    if (updated) facts.append(fact('Saved', updated));
    host.append(facts);
    const usage = node('div', 'create-usage');
    usage.append(node('h3', '', 'Teams'));
    if (!used.length) usage.append(node('p', '', 'Not assigned to a team.'));
    else {
      const list = node('div', 'create-usage-list');
      for (const row of used) {
        const button = node('button', 'ghost create-usage-row');
        button.type = 'button';
        button.append(node('strong', '', row.team.name), node('span', '', `${modeName(row.team.mode)} · ${row.member.role || 'No role'}`));
        button.onclick = () => select('teams', row.team.id);
        list.append(button);
      }
      usage.append(list);
    }
    const instructions = node('div', 'create-instructions');
    instructions.append(node('h3', '', 'Instructions'), node('p', '', prompt || 'No custom instructions yet.'));
    host.append(usage, instructions);
  }
  function render() {
    const focusedRow = document.activeElement?.closest('.create-library-item');
    const focusId = focusedRow?.dataset.id;
    const focusKind = focusedRow?.closest('#team-list') ? 'teams' : 'agents';
    const scrollTop = q('.create-library-scroll')?.scrollTop || 0;
    q('#create-summary').textContent = `${teams.length} team${teams.length === 1 ? '' : 's'} · ${agents.length} agent${agents.length === 1 ? '' : 's'}`;
    q('#create-teams-count').textContent = String(teams.length);
    q('#create-agents-count').textContent = String(agents.length);
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
    const scroller = q('.create-library-scroll');
    if (scroller) scroller.scrollTop = scrollTop;
    const host = q('#create-detail');
    host.replaceChildren();
    const item = (library === 'teams' ? teams : agents).find(candidate => candidate.id === selected[library]);
    if (item) {
      if (library === 'teams') teamDetail(item); else agentDetail(item);
    } else {
      const empty = node('div', 'create-detail-empty');
      empty.append(node('h2', '', library === 'teams' ? 'No team selected' : 'No agent selected'),
        node('p', '', library === 'teams' ? 'Save agents first, then assign each one a role, model and connection.' : 'An agent keeps its instructions, model and connection so a team can reuse it.'),
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
  q('#create-filter')?.addEventListener('input', render);
  function rememberCatalog(actions) {
    if (Array.isArray(actions?.roles)) catalog.roles = actions.roles;
    if (Array.isArray(actions?.connections)) catalog.connections = actions.connections;
  }
  window.ReachCreatePage = {
    renderAgents(items, actions) { agents = items; agentActions = actions || {}; if (Array.isArray(actions?.teams)) teams = actions.teams; rememberCatalog(actions); reconcile('agents', agents); render(); },
    renderTeams(items, actions) { teams = items; teamActions = actions || {}; rememberCatalog(actions); reconcile('teams', teams); render(); },
    select,
  };
})();
