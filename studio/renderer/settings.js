// Settings stay in normal page flow: menus navigate, forms never trap focus.
let budgetSchema = null;
document.getElementById('btn-engine-report').onclick = async () => {
  try { document.getElementById('engine-report').textContent = JSON.stringify(await reachApi.engines.report(), null, 2); }
  catch (error) { document.getElementById('engine-report').textContent = 'Engine report unavailable: ' + error.message; }
};
let budgetGlobal = {};
let settingsAgent = null;

function closeSettingsMenus() {
  document.querySelectorAll('.settings-dropdown').forEach(el => el.classList.add('hidden'));
  for (const id of ['tab-settings', 'btn-agent-settings']) $('#' + id).setAttribute('aria-expanded', 'false');
}
for (const id of ['tab-settings', 'btn-agent-settings']) {
  const trigger = $('#' + id), menu = $('#' + id + '-menu');
  trigger.onclick = () => {
    const opening = menu.classList.contains('hidden');
    closeSettingsMenus();
    if (opening) { menu.classList.remove('hidden'); trigger.setAttribute('aria-expanded', 'true'); }
  };
  trigger.onkeydown = e => {
    if (e.key === 'ArrowDown') { e.preventDefault(); closeSettingsMenus(); menu.classList.remove('hidden'); trigger.setAttribute('aria-expanded', 'true'); menu.querySelector('button').focus(); }
  };
  menu.onkeydown = e => {
    const buttons = [...menu.querySelectorAll('button')];
    if (e.key === 'Escape') { e.preventDefault(); closeSettingsMenus(); trigger.focus(); }
    if (['ArrowDown', 'ArrowUp'].includes(e.key)) { e.preventDefault(); buttons[(buttons.indexOf(document.activeElement) + (e.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length].focus(); }
  };
}
document.addEventListener('click', e => { if (!e.target.closest('.settings-menu')) closeSettingsMenus(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeSettingsMenus(); });

async function openSettingsPanel(panel) {
  closeSettingsMenus();
  await showTab('settings');
  if (!$('#page-settings').classList.contains('active')) return;
  document.querySelectorAll('.settings-content').forEach(el => el.classList.toggle('hidden', el.id !== 'settings-' + panel));
  document.querySelectorAll('.settings-nav button').forEach(el => {
    el.classList.toggle('active', el.dataset.settingsPanel === panel);
    el.setAttribute('aria-current', el.dataset.settingsPanel === panel ? 'page' : 'false');
  });
  if (panel === 'connection') {
    // Live status, not a page that looks identical whether or not a provider is
    // reachable: test every row that has no result yet (read-only GET /models;
    // results persist per row until it is edited, so reopening does not re-ping).
    window.ReachConnPanel?.autoTest?.();
  }
  settingsAgent = currentAgent ? await reachApi.agents.get(currentAgent.id) : null;
  if (panel === 'conversation') {
    $('#agent-settings-context').textContent = settingsAgent ? `${settingsAgent.name} · ${settingsAgent.dir}` : 'Select a conversation in Agents to change its settings.';
    $('#agent-set-name').value = settingsAgent?.name || '';
    $('#agent-set-model').value = settingsAgent?.model || '';
    $('#agent-set-approvals').value = settingsAgent?.settings?.approvals || 'prompt';
    $('#agent-set-review').checked = settingsAgent?.settings?.reviewEdits !== false;
    for (const el of $('#settings-conversation').querySelectorAll('input, select, button')) el.disabled = !settingsAgent;
    $('#agent-settings-status').textContent = '';
  }
  if (panel === 'budgeting') {
    budgetSchema ||= await reachApi.getBudgetSchema();
    budgetGlobal = await reachApi.getSettings();
    $('#budget-scope option[value="conversation"]').disabled = !settingsAgent;
    $('#budget-scope option[value="conversation"]').textContent = settingsAgent ? `${settingsAgent.name} and its teams` : 'Select a conversation first';
    if (!settingsAgent) $('#budget-scope').value = 'global';
    renderBudgetScope();
  }
}
document.querySelectorAll('[data-settings-panel]').forEach(button => {
  button.onclick = () => openSettingsPanel(button.dataset.settingsPanel).catch(e => showNotice(e.message));
});

function fillBudgetFields(values) {
  const host = $('#budget-fields');
  host.replaceChildren();
  for (const group of [...new Set(budgetSchema.fields.map(f => f.group))]) {
    const section = document.createElement('fieldset'), legend = document.createElement('legend');
    legend.textContent = group; section.append(legend);
    for (const field of budgetSchema.fields.filter(f => f.group === group)) {
      const item = document.createElement('div'); item.className = 'budget-field';
      const label = document.createElement('label'); label.htmlFor = 'budget-' + field.key; label.textContent = field.label;
      const input = document.createElement('input'); input.id = label.htmlFor; input.dataset.budgetKey = field.key;
      input.type = field.type === 'boolean' ? 'checkbox' : 'number';
      if (field.type === 'boolean') input.checked = values[field.key];
      else { input.value = values[field.key]; input.min = field.min; input.max = 2147483647; input.step = 1; input.required = true; }
      const help = document.createElement('p'); help.id = input.id + '-help'; help.className = 'dim'; help.textContent = field.help + (field.globalOnly ? ' Change this in global budgets.' : '');
      input.setAttribute('aria-describedby', help.id);
      item.append(label, input, help); section.append(item);
    }
    host.append(section);
  }
  updateBudgetEnabled();
}
function renderBudgetScope() {
  const local = $('#budget-scope').value === 'conversation';
  const legacy = !budgetGlobal.budgets && local && settingsAgent ? { maxRounds: settingsAgent.settings.maxRounds ?? 40, maxTokens: settingsAgent.settings.maxTokens ?? 4096 } : {};
  $('#budget-inherit-label').classList.toggle('hidden', !local);
  $('#budget-inherit').checked = !settingsAgent?.settings?.budgetOverrides;
  $('#budget-status').textContent = '';
  $('#budget-preset-status').textContent = 'Choose a preset or customize each value below, then save.';
  fillBudgetFields({ ...budgetSchema.defaults, ...legacy, ...budgetGlobal.budgets, ...(local ? settingsAgent?.settings?.budgetOverrides : {}) });
}
function updateBudgetEnabled() {
  const inherited = $('#budget-scope').value === 'conversation' && $('#budget-inherit').checked;
  $('#budget-fields').querySelectorAll('input').forEach(el => el.disabled = inherited || ($('#budget-scope').value === 'conversation' && budgetSchema.fields.find(f => f.key === el.dataset.budgetKey)?.globalOnly));
  document.querySelectorAll('[data-budget-preset]').forEach(el => el.disabled = inherited);
}
$('#budget-scope').onchange = renderBudgetScope;
$('#budget-inherit').onchange = () => {
  if ($('#budget-inherit').checked) fillBudgetFields({ ...budgetSchema.defaults, ...budgetGlobal.budgets });
  updateBudgetEnabled();
};
document.querySelectorAll('[data-budget-preset]').forEach(button => {
  button.onclick = () => {
    fillBudgetFields(budgetSchema.presets[button.dataset.budgetPreset]);
    $('#budget-preset-status').textContent = `${button.textContent} selected. Save budgets to apply.`;
    $('#budget-status').textContent = 'Unsaved changes';
  };
});
$('#budget-form').onsubmit = e => e.preventDefault();
$('#budget-form').oninput = () => { $('#budget-status').textContent = 'Unsaved changes'; };
$('#btn-save-budgets').onclick = async () => {
  if (!$('#budget-form').reportValidity()) return;
  const button = $('#btn-save-budgets'); button.disabled = true;
  try {
    const budgets = Object.fromEntries(budgetSchema.fields.map(f => [f.key, f.type === 'boolean' ? $('#budget-' + f.key).checked : Number($('#budget-' + f.key).value)]));
    if ($('#budget-scope').value === 'conversation') {
      if (!settingsAgent) throw new Error('Select a conversation first.');
      for (const field of budgetSchema.fields.filter(f => f.globalOnly)) delete budgets[field.key];
      const result = await reachApi.agents.update(settingsAgent.id, { settings: { budgetOverrides: $('#budget-inherit').checked ? null : budgets } });
      if (!result.ok) throw new Error(result.err);
      settingsAgent = result.agent;
      if (currentAgent?.id === settingsAgent.id) currentAgent = settingsAgent;
    } else {
      const result = await reachApi.saveSettings({ budgets });
      if (!result.ok) throw new Error(result.err);
      budgetGlobal = { ...budgetGlobal, budgets };
    }
    $('#budget-status').textContent = 'Saved. Applies to new runs; current runs keep their starting budgets.';
  } catch (e) { $('#budget-status').textContent = e.message; }
  finally { button.disabled = false; }
};
$('#btn-agent-set-cancel').onclick = () => showTab('agents');
$('#btn-agent-set-save').onclick = async () => {
  if (!settingsAgent) return;
  try {
    const result = await reachApi.agents.update(settingsAgent.id, {
      name: $('#agent-set-name').value.trim(), model: $('#agent-set-model').value.trim(),
      settings: { approvals: $('#agent-set-approvals').value, reviewEdits: $('#agent-set-review').checked },
    });
    if (!result.ok) throw new Error(result.err);
    settingsAgent = result.agent;
    if (currentAgent?.id === settingsAgent.id) {
      currentAgent = settingsAgent;
      agentNameEl.textContent = settingsAgent.name;
      agentMetaEl.textContent = `${settingsAgent.dir} · ${settingsAgent.model || 'Default model'}`;
    }
    await loadAgentTree();
    $('#agent-settings-status').textContent = 'Saved. Model changes apply to the next run.';
  } catch (e) { $('#agent-settings-status').textContent = e.message; }
};
