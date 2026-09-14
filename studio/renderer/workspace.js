'use strict';
(() => {
  const featureLabels = { agent: 'Agent', workspace: 'Workspace', think: 'Think', web: 'Web', terminal: 'Terminal' };
  const descriptions = {
    agent: 'Allow the agent to use tools. Off means a direct chat response with no tool execution.',
    workspace: 'Allow project file reads, edits and commands. Off blocks new access; previously shared conversation context remains.',
    think: 'Allow normal model reasoning. Off requests brief answers and disables Qwen thinking when supported. Provider limitations still apply.',
    web: 'Allow web search and in-app browser tools. This controls agent access; you can still browse manually.',
    terminal: 'Allow shell and Reach CLI commands. Existing approval and edit-review rules still apply. Turning off blocks subsequent commands.',
  };
  let saving = false, modelAgentId = null;
  const buttons = new Map(), host = $('#composer-tools');
  function node(tag, className, text) { const el = document.createElement(tag); el.className = className || ''; if (text !== undefined) el.textContent = text; return el; }
  function action(label, click) { const button = node('button', 'ghost small', label); button.type = 'button'; button.onclick = click; return button; }
  for (const [key, label] of Object.entries(featureLabels)) {
    const button = action(label, async () => {
      if (!currentAgent || saving) return;
      const features = { ...currentAgent.settings?.features, [key]: currentAgent.settings?.features?.[key] === false };
      await save(currentAgent.id, { settings: { features } });
    });
    button.classList.add('feature-switch'); button.title = descriptions[key];
    button.setAttribute('role', 'switch'); button.setAttribute('aria-label', label);
    buttons.set(key, button); host.appendChild(button);
  }
  host.append(action('Tools…', () => options('tools')), action('Permissions…', () => options('permissions')));
  host.addEventListener('wheel', e => { if (host.scrollWidth > host.clientWidth && !e.ctrlKey && !e.metaKey) { e.preventDefault(); host.scrollLeft += Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY; } }, { passive: false });

  function syncControls() {
    for (const [key, button] of buttons) {
      button.setAttribute('aria-checked', String(currentAgent?.settings?.features?.[key] !== false));
      button.disabled = !currentAgent || saving;
    }
    for (const button of host.querySelectorAll('button:not(.feature-switch)')) button.disabled = !currentAgent || saving;
    $('#composer-model').textContent = (currentAgent?.model || 'Default model') + ' ▾';
    $('#composer-model').title = currentAgent?.model || 'Choose a model for this conversation';
    $('#composer-model').disabled = !currentAgent || saving;
    $('#btn-clear-chat').disabled = !currentAgent || saving || agentRunning || !!activeTeamRun;
  }
  function sync() { syncControls(); window.ReachTelemetry?.sync(); }
  async function save(id, patch) {
    if (saving) return false;
    saving = true; syncControls();
    try {
      const result = await reachApi.agents.update(id, patch);
      if (!result.ok) throw new Error(result.err);
      if (currentAgent?.id === id) {
        currentAgent = { ...currentAgent, ...result.agent };
        agentMetaEl.textContent = `${currentAgent.dir} · ${currentAgent.model || 'default model'}`;
        refreshContextStatus();
      }
      return true;
    } catch (error) { showNotice(error.message); return false; }
    finally { saving = false; sync(); }
  }
  function modal(title) {
    const prior = document.activeElement, dialog = node('dialog', 'app-dialog modal-box workspace-dialog');
    dialog.setAttribute('aria-label', title);
    const heading = node('div', 'workspace-dialog-head');
    heading.append(node('h2', '', title), action('Close', () => dialog.close()));
    dialog.append(heading); document.body.append(dialog);
    dialog.addEventListener('close', () => { dialog.remove(); if (prior?.isConnected) prior.focus(); }, { once: true });
    dialog.showModal(); return dialog;
  }
  async function options(kind) {
    if (!currentAgent) return;
    const id = currentAgent.id, settings = structuredClone(currentAgent.settings || {});
    const dialog = modal(kind === 'tools' ? 'Tools for this conversation' : 'Conversation permissions');
    dialog.append(node('p', 'workspace-description', 'Applies to this conversation, its team members and their workers. Changes take effect before the next tool executes.'));
    const form = node('form', 'workspace-form'); dialog.append(form);
    if (kind === 'tools') {
      const schema = await reachApi.agents.toolSchema();
      if (!dialog.isConnected) return;
      const search = node('input'); search.type = 'search'; search.placeholder = 'Find a tool…'; search.setAttribute('aria-label', 'Find a tool'); form.append(search);
      const list = node('div', 'tool-options'); form.append(list);
      for (const tool of schema) {
        const label = node('label', 'tool-option'), input = node('input'); input.type = 'checkbox'; input.value = tool.name; input.checked = !settings.disabledTools?.includes(tool.name);
        const description = node('span'); description.append(node('strong', '', tool.name), node('small', '', tool.help));
        label.append(input, description, node('span', 'tool-tier', tool.class)); list.append(label);
      }
      search.oninput = () => { for (const label of list.children) label.hidden = !label.textContent.toLowerCase().includes(search.value.toLowerCase()); };
      form.append(node('p', 'workspace-description', 'The composer switches can block a whole group even when an individual tool is enabled here.'));
      form.onsubmit = async e => { e.preventDefault(); const disabledTools = [...list.querySelectorAll('input:not(:checked)')].map(input => input.value); if (await save(id, { settings: { disabledTools } })) dialog.close(); };
    } else {
      const label = node('label', '', 'Command approvals'), approvals = node('select'); label.htmlFor = 'workspace-approvals'; approvals.id = label.htmlFor;
      approvals.append(new Option('Ask before running commands', 'prompt'), new Option('Allow reads; ask before commands', 'auto-read'), new Option('Automatically approve commands', 'auto-all'));
      approvals.value = settings.approvals || 'prompt'; form.append(label, approvals);
      const review = node('label', 'workspace-check'), input = node('input'); input.type = 'checkbox'; input.checked = settings.reviewEdits !== false;
      review.append(input, document.createTextNode('Review file edits before applying')); form.append(review);
      const note = node('p', 'workspace-description');
      const describe = () => { note.textContent = approvals.value === 'auto-all' ? 'Enabled commands can run without asking you. Terminal off still blocks commands.' : 'Commands require your approval. Reading files does not execute commands.'; };
      approvals.onchange = describe; describe(); form.append(note);
      form.append(action('Open budgeting settings', () => { dialog.close(); openSettingsPanel('budgeting'); }));
      form.onsubmit = async e => { e.preventDefault(); if (await save(id, { settings: { approvals: approvals.value, reviewEdits: input.checked } })) dialog.close(); };
    }
    const submit = node('button', 'gold', 'Save'); submit.type = 'submit'; form.append(submit);
  }
  $('#composer-model').onclick = () => { modelAgentId = currentAgent?.id; openModelPicker($('#composer-model-value')); };
  $('#composer-model-value').onchange = async e => { if (modelAgentId && currentAgent?.id === modelAgentId) await save(modelAgentId, { model: e.target.value }); };
  $('#btn-clear-chat').onclick = async () => {
    const id = currentAgent?.id; if (!id || saving) return;
    if (!await confirmAction('Clear this conversation and start fresh? Messages, its plan and pending edits will be removed. Project files, settings and other conversations are kept.')) return;
    if (currentAgent?.id !== id) return;
    const result = await reachApi.agents.clear(id);
    if (!result.ok) { showNotice(result.err); return; }
    composerInput.value = ''; queuedIndicator.classList.add('hidden');
    window.ReachTelemetry?.reset();
    await selectAgent(result.agent); composerInput.focus(); sync();
  };
  window.ReachWorkspace = { sync, syncControls, modal, node, action };
  sync();
})();
