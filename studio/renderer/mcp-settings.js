// ---------- settings: Plugins & MCP servers ----------
/* Integrations for GitHub, Gmail, Outlook and external Model Context Protocol
 * (MCP) servers. The draft is a working copy; nothing is written until Save.
 */
const MCP_MAX = 20;          // mirrors MAX_MCP_SERVERS in agent/mcp.cjs
const MCP_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;
const MCP_ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

let mcpDraft = [];           // [{ key, savedId, name, enabled, transport, ...text fields }]
let mcpEditingKey = '';
let mcpDirty = false;
let mcpSettingsRevision = '';
let mcpRows = new Map();     // saved id -> status row from mcp:list
const mcpTestsRunning = new Set();
let mcpPollTimer = 0, mcpPollsLeft = 0;

let pluginDraft = {
  github: { enabled: true, token: '', username: '' },
  gmail: { enabled: true, email: '', password: '' },
  outlook: { enabled: true, email: '', password: '' },
};
const pluginStatuses = new Map(); // pluginId -> { text, pill, note }

function parseKvLines(text, sep) {
  const out = {}, bad = [];
  for (const raw of String(text || '').split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const at = line.indexOf(sep);
    if (at < 1) { bad.push(line); continue; }
    const key = line.slice(0, at).trim(), value = line.slice(at + 1).trim();
    if (!key) { bad.push(line); continue; }
    out[key] = value;
  }
  return { map: out, bad };
}
function kvToText(map, sep) {
  return Object.entries(map || {}).map(([k, v]) => `${k}${sep} ${v}`).join('\n');
}
function argLines(text) {
  return String(text || '').split('\n').map(l => l.trim()).filter(Boolean);
}

function mcpDraftConfig(row) {
  const base = { name: row.name.trim(), enabled: row.enabled !== false, transport: row.transport };
  if (row.transport === 'http') {
    return { ...base, url: row.url.trim(), headers: parseKvLines(row.headersText, ':').map };
  }
  return { ...base,
    command: row.command.trim(), args: argLines(row.argsText),
    env: parseKvLines(row.envText, '=').map, cwd: row.cwd.trim() };
}
function mcpStoredConfig(row) {
  const base = { name: row.name, enabled: row.enabled !== false, transport: row.transport };
  if (row.transport === 'http') return { ...base, url: row.url || '', headers: row.headers || {} };
  return { ...base, command: row.command || '', args: row.args || [], env: row.env || {}, cwd: row.cwd || '' };
}
function mcpRowDirty(row) {
  if (!row.savedId) return true;
  const stored = mcpRows.get(row.savedId);
  if (!stored) return true;
  return JSON.stringify(mcpDraftConfig(row)) !== JSON.stringify(mcpStoredConfig(stored));
}

function mcpTestable(row) {
  return !!row.savedId && !mcpRowDirty(row) && row.enabled !== false;
}
function mcpTestTitle(row) {
  if (!row.savedId) return 'Save before testing';
  if (mcpRowDirty(row)) return 'Save these changes before testing';
  if (row.enabled === false) return 'Enable the server to test it';
  return 'Handshake now and list tools';
}

function mcpDraftFromRow(row) {
  return {
    key: row.id, savedId: row.id,
    name: row.name || '', enabled: row.enabled !== false,
    transport: row.transport === 'http' ? 'http' : 'stdio',
    command: row.command || '', argsText: (row.args || []).join('\n'),
    envText: kvToText(row.env, '='), cwd: row.cwd || '',
    url: row.url || '', headersText: kvToText(row.headers, ':'),
  };
}
function mcpNewKey() {
  return 'draft_' + Math.random().toString(36).slice(2, 10);
}

function mcpRowStatus(row) {
  if (!row.savedId) return { text: 'Not saved yet', pill: '', label: 'New' };
  if (mcpRowDirty(row)) return { text: 'Save to apply these changes', pill: '', label: 'Unsaved' };
  if (row.enabled === false) return { text: 'Disabled — saved but not connected', pill: 'off', label: 'Disabled' };
  const st = mcpRows.get(row.savedId) || { status: 'unknown' };
  if (st.status === 'checking') return { text: 'Connecting…', pill: 'checking', label: 'Checking' };
  if (st.status === 'ok') {
    const tools = Array.isArray(st.tools) ? st.tools.length : (st.tools || 0);
    return {
      text: `Connected · ${tools} tool(s) · ${st.latencyMs} ms` + (st.stale ? ' · config changed, will reconnect' : ''),
      pill: 'ok', label: st.stale ? 'Changed' : 'OK',
      title: (st.toolNames || []).join(', ') || '',
    };
  }
  if (st.status === 'error') {
    return { text: st.error || 'Connection failed', pill: 'bad', label: st.stale ? 'Changed' : 'Error' };
  }
  return { text: 'Connects on first agent run', pill: '', label: 'Idle' };
}

/* ------------------------------------------------------------------- Plugins Grid */

function renderPlugins() {
  const grid = $('#plugins-grid');
  if (!grid) return;
  grid.replaceChildren();

  const defs = [
    {
      id: 'github',
      name: 'GitHub',
      tagline: 'Repository inspection, issue search, commits & pull requests for AI agents.',
      fields: [
        { key: 'token', label: 'Personal Access Token', type: 'password', placeholder: 'ghp_... (or gh CLI auth)' },
        { key: 'username', label: 'GitHub Username (optional)', type: 'text', placeholder: 'auto-detected on test' },
      ],
      docUrl: 'https://github.com/settings/tokens',
    },
    {
      id: 'gmail',
      name: 'Gmail',
      tagline: 'Use Connections to sign in with your own Google account. Sending requires separate permission and approval.',
      fields: [
        { key: 'email', label: 'Gmail Address', type: 'email', placeholder: 'yourname@gmail.com' },
        { key: 'password', label: 'OAuth access token (optional advanced setup)', type: 'password', placeholder: 'Leave blank to keep saved credential' },
      ],
      docUrl: 'https://developers.google.com/workspace/gmail/api/quickstart/nodejs',
    },
    {
      id: 'outlook',
      name: 'Outlook / Microsoft 365',
      tagline: 'Email tools for Outlook, Hotmail, and Microsoft 365 work accounts.',
      fields: [
        { key: 'email', label: 'Outlook Address', type: 'email', placeholder: 'user@outlook.com or work email' },
        { key: 'password', label: 'Microsoft Graph OAuth token (Mail.Read)', type: 'password', placeholder: 'Leave blank to keep saved credential' },
      ],
      docUrl: 'https://developer.microsoft.com/en-us/graph/graph-explorer',
    },
  ];

  for (const def of defs) {
    const data = pluginDraft[def.id] || { enabled: true };
    const card = document.createElement('div');
    card.className = 'plugin-card';
    card.dataset.pluginId = def.id;

    const head = document.createElement('div');
    head.className = 'plugin-card-head';
    const title = document.createElement('span');
    title.className = 'plugin-card-title';
    title.textContent = def.name;

    const statusPill = document.createElement('span');
    const cachedStatus = pluginStatuses.get(def.id);
    const hasCreds = data.credentialConfigured || (def.id === 'github' ? (data.token || data.username) : (data.email && data.password));
    if (cachedStatus) {
      statusPill.className = 'conn-badge ' + (cachedStatus.pill || '');
      statusPill.textContent = cachedStatus.label || cachedStatus.text;
    } else if (hasCreds) {
      statusPill.className = 'conn-badge ok';
      statusPill.textContent = def.id === 'github' && data.username ? `@${data.username}` : 'Configured';
    } else {
      statusPill.className = 'conn-badge off';
      statusPill.textContent = 'Not configured';
    }
    head.append(title, statusPill);

    const desc = document.createElement('p');
    desc.className = 'plugin-card-desc';
    desc.textContent = def.tagline;

    const fieldsWrap = document.createElement('div');
    fieldsWrap.className = 'plugin-card-fields';

    for (const f of def.fields) {
      const lbl = document.createElement('label');
      lbl.textContent = f.label;
      const inp = document.createElement('input');
      inp.type = f.type;
      inp.placeholder = f.placeholder;
      inp.value = data[f.key] || '';
      inp.spellcheck = false;
      inp.oninput = () => {
        data[f.key] = inp.value;
        mcpDirty = true;
        markMcpUnsaved();
      };
      fieldsWrap.append(lbl, inp);
    }

    const toggleRow = document.createElement('label');
    toggleRow.className = 'check';
    toggleRow.style.fontSize = '12px';
    toggleRow.style.margin = '4px 0 0';
    const toggleInp = document.createElement('input');
    toggleInp.type = 'checkbox';
    toggleInp.checked = data.enabled !== false;
    toggleInp.onchange = () => {
      data.enabled = toggleInp.checked;
      mcpDirty = true;
      markMcpUnsaved();
    };
    const toggleSpan = document.createElement('span');
    toggleSpan.textContent = 'Enable tools for agents';
    toggleRow.append(toggleInp, toggleSpan);
    fieldsWrap.appendChild(toggleRow);

    const foot = document.createElement('div');
    foot.className = 'plugin-card-foot';

    const testBtn = document.createElement('button');
    testBtn.type = 'button';
    testBtn.className = 'ghost small';
    testBtn.textContent = 'Test connection';
    testBtn.onclick = async () => {
      testBtn.disabled = true;
      statusPill.className = 'conn-badge checking';
      statusPill.textContent = 'Testing…';
      try {
        const res = await reachApi.plugins.test(def.id, data);
        if (res.ok) {
          if (def.id === 'github' && res.user?.login) {
            data.username = res.user.login;
            pluginStatuses.set('github', { pill: 'ok', label: `@${res.user.login}`, text: `Connected as @${res.user.login}` });
          } else {
            pluginStatuses.set(def.id, { pill: 'ok', label: 'Connected', text: 'Connection OK' });
          }
        } else {
          pluginStatuses.set(def.id, { pill: 'bad', label: 'Failed', text: res.err || 'Test failed' });
        }
      } catch (e) {
        pluginStatuses.set(def.id, { pill: 'bad', label: 'Error', text: e.message });
      } finally {
        testBtn.disabled = false;
        renderPlugins();
      }
    };

    foot.append(testBtn);
    card.append(head, desc, fieldsWrap, foot);
    grid.appendChild(card);
  }
}

/* ------------------------------------------------------------------- MCP Render */

function renderMcp() {
  renderPlugins();
  const list = $('#mcp-list');
  const editor = $('#mcp-editor');
  const empty = $('#mcp-empty');
  if (!list || !editor) return;

  const active = mcpDraft.find(r => r.key === mcpEditingKey);
  editor.classList.toggle('hidden', !active);
  editor.innerHTML = '';
  list.innerHTML = '';
  if (empty) empty.hidden = mcpDraft.length > 0;

  const dirty = () => { mcpDirty = true; markMcpUnsaved(); };
  const repaint = () => { if ($('#settings-mcp')?.contains(document.activeElement)) paintMcpLive(); else renderMcp(); };

  mcpDraft.forEach((row, i) => {
    const card = document.createElement('div');
    card.className = 'conn-card mcp-card' + (row.key === mcpEditingKey ? ' active' : '');
    card.dataset.mcpKey = row.key;

    const head = document.createElement('div');
    head.className = 'conn-head';
    const title = document.createElement('span');
    title.className = 'conn-title';
    title.textContent = row.name.trim() || '(unnamed server)';
    if (!row.name.trim()) title.classList.add('dim');

    const info = mcpRowStatus(row);
    const pill = document.createElement('span');
    pill.className = 'conn-badge mcp-pill' + (info.pill ? ' ' + info.pill : '');
    pill.textContent = info.label;
    if (info.title) pill.title = info.title;

    head.append(title, pill);
    card.appendChild(head);

    const body = document.createElement('div');
    body.className = 'conn-body';

    const addField = (labelText, build) => {
      const field = document.createElement('div'); field.className = 'conn-field';
      const label = document.createElement('label'); label.textContent = labelText;
      const content = build();
      if (content.id !== undefined) { content.id = `mcp-${i}-${body.children.length}`; label.htmlFor = content.id; }
      field.append(label, content); body.appendChild(field);
    };

    addField('Name', () => {
      const input = document.createElement('input');
      input.type = 'text'; input.value = row.name; input.spellcheck = false;
      input.placeholder = 'e.g. filesystem, github, fetch';
      input.oninput = () => { row.name = input.value; dirty(); repaint(); };
      return input;
    });

    addField('Transport', () => {
      const select = document.createElement('select');
      for (const [value, text] of [['stdio', 'stdio — Studio runs the command'], ['http', 'HTTP — Streamable HTTP endpoint']]) {
        const opt = document.createElement('option');
        opt.value = value; opt.textContent = text;
        select.appendChild(opt);
      }
      select.value = row.transport;
      select.onchange = () => {
        row.transport = select.value;
        dirty();
        renderMcp();
        $('#mcp-editor input')?.focus();
      };
      return select;
    });

    const stdioFields = document.createElement('div');
    stdioFields.className = 'conn-body mcp-transport-fields';
    const httpFields = document.createElement('div');
    httpFields.className = 'conn-body mcp-transport-fields';
    const syncTransportFields = () => {
      stdioFields.hidden = row.transport !== 'stdio';
      httpFields.hidden = row.transport !== 'http';
    };

    {
      const wrap = stdioFields;
      const add = (labelText, build) => {
        const field = document.createElement('div'); field.className = 'conn-field';
        const label = document.createElement('label'); label.textContent = labelText;
        const content = build();
        if (content.id !== undefined) { content.id = `mcp-${i}-s-${wrap.children.length}`; label.htmlFor = content.id; }
        field.append(label, content); wrap.appendChild(field);
      };
      add('Command', () => {
        const input = document.createElement('input');
        input.type = 'text'; input.value = row.command; input.spellcheck = false;
        input.placeholder = 'npx, uvx, or an absolute path';
        input.oninput = () => { row.command = input.value; dirty(); repaint(); };
        return input;
      });
      add('Arguments (one per line)', () => {
        const ta = document.createElement('textarea');
        ta.rows = 3; ta.value = row.argsText; ta.spellcheck = false;
        ta.placeholder = '-y\n@modelcontextprotocol/server-filesystem\n/path/to/dir';
        ta.oninput = () => { row.argsText = ta.value; dirty(); };
        return ta;
      });
      add('Environment (KEY=value per line)', () => {
        const ta = document.createElement('textarea');
        ta.rows = 3; ta.value = row.envText; ta.spellcheck = false;
        ta.placeholder = 'API_KEY=…';
        ta.oninput = () => { row.envText = ta.value; dirty(); };
        return ta;
      });
      add('Working directory (optional)', () => {
        const input = document.createElement('input');
        input.type = 'text'; input.value = row.cwd; input.spellcheck = false;
        input.placeholder = 'defaults to the Studio process directory';
        input.oninput = () => { row.cwd = input.value; dirty(); };
        return input;
      });
    }
    {
      const wrap = httpFields;
      const add = (labelText, build) => {
        const field = document.createElement('div'); field.className = 'conn-field';
        const label = document.createElement('label'); label.textContent = labelText;
        const content = build();
        if (content.id !== undefined) { content.id = `mcp-${i}-h-${wrap.children.length}`; label.htmlFor = content.id; }
        field.append(label, content); wrap.appendChild(field);
      };
      add('URL', () => {
        const input = document.createElement('input');
        input.type = 'text'; input.value = row.url; input.spellcheck = false;
        input.placeholder = 'https://server.example.com/mcp';
        input.oninput = () => { row.url = input.value; dirty(); repaint(); };
        return input;
      });
      add('Headers (Name: value per line)', () => {
        const ta = document.createElement('textarea');
        ta.rows = 3; ta.value = row.headersText; ta.spellcheck = false;
        ta.placeholder = 'Authorization: Bearer …';
        ta.oninput = () => { row.headersText = ta.value; dirty(); };
        return ta;
      });
    }
    syncTransportFields();
    body.append(stdioFields, httpFields);

    const foot = document.createElement('div');
    foot.className = 'conn-foot';
    const status = document.createElement('span');
    status.className = 'dim conn-status' + (info.pill === 'ok' ? ' ok' : info.pill === 'bad' ? ' bad' : '');
    status.textContent = info.text;
    if (info.title) status.title = info.title;

    const enableBtn = document.createElement('button');
    enableBtn.type = 'button';
    enableBtn.className = 'conn-pool' + (row.enabled !== false ? ' on' : '');
    enableBtn.textContent = row.enabled !== false ? 'Enabled' : 'Disabled';
    enableBtn.setAttribute('aria-pressed', String(row.enabled !== false));
    enableBtn.title = row.enabled !== false
      ? 'Connected on demand; its tools appear in agent runs. Click to disable.'
      : 'Saved but never connected. Click to enable.';
    enableBtn.onclick = () => {
      row.enabled = row.enabled === false;
      dirty();
      renderMcp();
      [...list.children].find(el => el.dataset.mcpKey === row.key)?.querySelector('.conn-pool')?.focus();
    };

    const testBtn = document.createElement('button');
    testBtn.type = 'button';
    testBtn.className = 'ghost small mcp-test';
    testBtn.textContent = 'Test';
    testBtn.disabled = !mcpTestable(row) || mcpTestsRunning.has(row.savedId);
    testBtn.title = mcpTestTitle(row);
    testBtn.onclick = async () => {
      if (!mcpTestable(row) || mcpTestsRunning.has(row.savedId)) return;
      mcpTestsRunning.add(row.savedId);
      status.textContent = 'Connecting…';
      testBtn.disabled = true;
      try {
        const res = await reachApi.mcp.test(row.savedId);
        const s = res && res.ok ? res.status : null;
        const prev = mcpRows.get(row.savedId) || {};
        mcpRows.set(row.savedId, s
          ? { ...prev, ...s, stale: false }
          : { ...prev, status: 'error', error: (res && res.err) || 'Connection failed' });
        renderMcp();
      } catch (e) {
        status.textContent = 'Failed · ' + e.message;
        status.className = 'dim conn-status bad';
      } finally {
        mcpTestsRunning.delete(row.savedId);
        const live = [...list.children].find(el => el.dataset.mcpKey === row.key);
        const btn = live?.querySelector('.mcp-test');
        if (btn) btn.disabled = false;
      }
    };
    foot.append(status, enableBtn, testBtn);

    if (row.key === mcpEditingKey) {
      const editorHead = document.createElement('div');
      editorHead.className = 'conn-editor-head';
      const heading = document.createElement('h3');
      heading.id = 'mcp-editor-title';
      heading.textContent = 'Edit ' + (row.name || 'server');
      const close = document.createElement('button');
      close.type = 'button';
      close.className = 'ghost small';
      close.textContent = 'Close';
      const closeEditor = () => {
        mcpEditingKey = '';
        renderMcp();
        [...list.querySelectorAll('.conn-card')].find(el => el.dataset.mcpKey === row.key)?.querySelector('.conn-edit')?.focus();
      };
      close.onclick = closeEditor;
      editor.onkeydown = event => {
        if (event.key === 'Escape') { event.preventDefault(); closeEditor(); }
      };
      editorHead.append(heading, close);
      const hint = document.createElement('p');
      hint.className = 'dim conn-editor-hint';
      hint.textContent = 'Changes apply when you press Save.';
      const removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.className = 'ghost small conn-remove';
      removeBtn.textContent = 'Remove server';
      removeBtn.setAttribute('aria-label', `Remove ${row.name || 'server'}`);
      removeBtn.onclick = () => {
        mcpDraft.splice(i, 1);
        mcpEditingKey = '';
        dirty();
        renderMcp();
        $('#btn-add-mcp').focus();
      };
      editor.append(editorHead, body, hint, removeBtn);
    } else {
      body.hidden = true;
      card.appendChild(body);
    }
    card.appendChild(foot);
    list.appendChild(card);
  });

  const count = $('#mcp-count');
  if (count) {
    const enabled = mcpDraft.filter(r => r.enabled !== false).length;
    count.textContent = `${mcpDraft.length} of ${MCP_MAX} server(s) · ${enabled} enabled`;
  }
  const addBtn = $('#btn-add-mcp');
  if (addBtn) addBtn.disabled = mcpDraft.length >= MCP_MAX;
  layoutMcpEditor();
}

function layoutMcpEditor() {
  const workspace = $('#mcp-workspace');
  const editor = $('#mcp-editor');
  if (!workspace || !editor) return;
  const inline = workspace.clientWidth < 900;
  workspace.classList.toggle('inline-editor', inline);
  const card = [...$('#mcp-list').children].find(el => el.dataset.mcpKey === mcpEditingKey);
  const parent = inline && card ? card : workspace;
  if (editor.parentElement !== parent) {
    if (parent.moveBefore) parent.moveBefore(editor, null);
    else parent.appendChild(editor);
  }
}
let mcpLayoutFrame = 0;
new ResizeObserver(() => {
  cancelAnimationFrame(mcpLayoutFrame);
  mcpLayoutFrame = requestAnimationFrame(layoutMcpEditor);
}).observe($('#settings-mcp'));

function markMcpUnsaved() {
  const el = $('#mcp-status');
  if (el && !el.dataset.savedRecently) el.textContent = 'Unsaved changes.';
}

function paintMcpLive() {
  for (const row of mcpDraft) {
    const card = [...$('#mcp-list').children].find(el => el.dataset.mcpKey === row.key);
    if (!card) continue;
    const info = mcpRowStatus(row);
    const pill = card.querySelector('.mcp-pill');
    if (pill) {
      pill.textContent = info.label;
      pill.className = 'conn-badge mcp-pill' + (info.pill ? ' ' + info.pill : '');
      if (info.title) pill.title = info.title;
    }
    const status = card.querySelector('.conn-status');
    if (status) {
      status.textContent = info.text;
      status.className = 'dim conn-status' + (info.pill === 'ok' ? ' ok' : info.pill === 'bad' ? ' bad' : '');
      if (info.title) status.title = info.title;
    }
  }
}

async function refreshMcpStatus() {
  let res;
  try { res = await reachApi.mcp.list(); } catch { return; }
  const servers = res && res.ok ? res.servers || [] : [];
  mcpRows = new Map(servers.map(r => [r.id, r]));
  if ($('#settings-mcp')?.contains(document.activeElement)) paintMcpLive();
  else renderMcp();
  return servers.some(r => r.status === 'checking');
}
function pollMcpStatus() {
  clearTimeout(mcpPollTimer);
  mcpPollsLeft = 6;
  const tick = async () => {
    if (mcpPollsLeft-- <= 0) { renderMcp(); return; }
    const checking = await refreshMcpStatus();
    if (!checking) return;
    mcpPollTimer = setTimeout(tick, 1200);
  };
  mcpPollTimer = setTimeout(tick, 1200);
}

window.ReachMcpPanel = {
  async open() {
    const settings = !mcpDirty ? await reachApi.getSettings() : null;
    await refreshMcpStatus();
    if (!mcpDirty) {
      mcpSettingsRevision = settings?.settingsRevisions?.mcp || '';
      mcpDraft = [...mcpRows.values()].map(mcpDraftFromRow);
      if (settings?.plugins) {
        pluginDraft = {
          github: { enabled: true, token: '', username: '', ...(settings.plugins.github || {}) },
          gmail: { enabled: true, email: '', password: '', ...(settings.plugins.gmail || {}) },
          outlook: { enabled: true, email: '', password: '', ...(settings.plugins.outlook || {}) },
        };
      }
      if (!mcpDraft.some(r => r.key === mcpEditingKey)) mcpEditingKey = '';
      renderMcp();
    }
    pollMcpStatus();
  },
};

$('#btn-add-mcp').onclick = () => {
  if (mcpDraft.length >= MCP_MAX) return;
  const row = {
    key: mcpNewKey(), savedId: '', name: '', enabled: true, transport: 'stdio',
    command: '', argsText: '', envText: '', cwd: '', url: '', headersText: '',
  };
  mcpDraft.push(row);
  mcpEditingKey = row.key;
  mcpDirty = true;
  markMcpUnsaved();
  renderMcp();
  $('#mcp-editor input')?.focus();
};

$('#btn-save-mcp').onclick = async () => {
  const status = $('#mcp-status');
  for (const row of mcpDraft) {
    const label = row.name.trim() || '(unnamed)';
    if (!MCP_NAME_RE.test(row.name.trim())) {
      status.textContent = `"${label}" needs a name starting with a letter or digit (letters, digits, . _ -, max 64).`;
      return;
    }
    if (row.transport === 'http') {
      let parsed = null;
      try { parsed = new URL(row.url.trim()); } catch {}
      if (!parsed || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')) {
        status.textContent = `"${label}" needs a valid http(s) URL.`;
        return;
      }
      const { bad } = parseKvLines(row.headersText, ':');
      if (bad.length) { status.textContent = `"${label}" header line "${bad[0]}" needs "Name: value".`; return; }
    } else {
      if (!row.command.trim()) { status.textContent = `"${label}" needs a command to run.`; return; }
      if (row.command.trim().length > 256) { status.textContent = `"${label}" command is over 256 characters.`; return; }
      const args = argLines(row.argsText);
      if (args.length > 32 || args.some(a => a.length > 1024)) {
        status.textContent = `"${label}" has too many arguments (max 32) or one over 1024 characters.`;
        return;
      }
      const { map: env, bad } = parseKvLines(row.envText, '=');
      if (bad.length) { status.textContent = `"${label}" env line "${bad[0]}" needs "KEY=value".`; return; }
      const badKey = Object.keys(env).find(k => !MCP_ENV_KEY_RE.test(k));
      if (badKey) { status.textContent = `"${label}" env name "${badKey}" must start with a letter or underscore.`; return; }
    }
  }
  const button = $('#btn-save-mcp');
  button.disabled = true;
  try {
    const payload = {
      ...(mcpSettingsRevision ? { settingsScope: 'mcp', settingsRevision: mcpSettingsRevision } : {}),
      mcpServers: mcpDraft.map(row => {
        if (row.transport === 'http') {
          return { name: row.name.trim(), enabled: row.enabled !== false, transport: 'http',
            url: row.url.trim(), headers: parseKvLines(row.headersText, ':').map };
        }
        return { name: row.name.trim(), enabled: row.enabled !== false, transport: 'stdio',
          command: row.command.trim(), args: argLines(row.argsText),
          env: parseKvLines(row.envText, '=').map, cwd: row.cwd.trim() };
      }),
      // App connections have their own editor and shared credential store.
      // This panel must not write its hidden, partial legacy plugin draft.
    };
    const res = await reachApi.saveSettings(payload);
    mcpDirty = false;
    mcpSettingsRevision = res?.settingsRevision || '';
    status.dataset.savedRecently = 'true';
    status.textContent = 'Saved.';
    setTimeout(() => { delete status.dataset.savedRecently; status.textContent = ''; }, 3000);
    await refreshMcpStatus();
    pollMcpStatus();
  } catch (e) {
    status.textContent = 'Save failed: ' + e.message;
  } finally {
    button.disabled = false;
  }
};
