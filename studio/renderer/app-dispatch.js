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
      } finally { teamDispatching = false; pendingTeamEvents = []; earlyTeamEdits.clear(); }
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

