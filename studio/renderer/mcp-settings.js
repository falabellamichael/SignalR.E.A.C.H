// ---------- settings: MCP servers ----------
/* Same card/editor discipline as the Connections panel (app-settings.js):
 * createElement only — server commands, env values and headers are arbitrary
 * user text, and interpolating any of it into markup would be an injection
 * hole. The draft is a working copy; nothing is written until Save.
 *
 * The draft comes from mcp:list, not settings:get: the manager's sanitized
 * rows are the same configs the agent loop sees (ids already slugged,
 * entries already validated), so what the card shows is what will run. */
const MCP_MAX = 20;          // mirrors MAX_MCP_SERVERS in agent/mcp.cjs
const MCP_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;
const MCP_ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

let mcpDraft = [];           // [{ key, savedId, name, enabled, transport, ...text fields }]
let mcpEditingKey = '';
let mcpDirty = false;
let mcpRows = new Map();     // saved id -> status row from mcp:list
const mcpTestsRunning = new Set();
let mcpPollTimer = 0, mcpPollsLeft = 0;

/* Parse "KEY=value" lines (env) or "Name: value" lines (headers). Lenient
 * during editing — a half-typed line must not eat the field — but save()
 * re-checks strictly and refuses to write a line it would silently drop. */
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

/* The canonical config a draft row would save as, leniently parsed. Used for
 * the dirty check — if this equals the stored row's config, the card shows
 * live status; if it differs, the stored "ok" is about values that no longer
 * exist and the card says Unsaved instead. */
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
  if (!row.savedId) return true;    // never saved — always "unsaved"
  const stored = mcpRows.get(row.savedId);
  if (!stored) return true;         // stored row vanished (settings edited elsewhere)
  return JSON.stringify(mcpDraftConfig(row)) !== JSON.stringify(mcpStoredConfig(stored));
}

/* Test handshakes the SAVED config by id — mcp:test re-reads settings in main,
 * so it can only ever validate what's on disk. A row with unsaved edits has
 * nothing to test against; the button explains instead of silently testing
 * stale values. Evaluated at render AND repaint so an edit can't leave a live
 * Test button behind. */
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

/* Status text + pill class for a row. The dirty check runs first: any stored
 * status describes the SAVED config, so a card with unsaved edits shows
 * "Unsaved" even while its last handshake reported ok. */
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

function renderMcp() {
  const list = $('#mcp-list');
  if (!list) return;
  const editor = $('#mcp-editor');
  $('#mcp-workspace').appendChild(editor);
  list.replaceChildren();
  editor.replaceChildren();
  if (!mcpDraft.some(r => r.key === mcpEditingKey)) mcpEditingKey = '';
  editor.classList.toggle('hidden', !mcpEditingKey);
  $('#mcp-workspace').classList.toggle('editing', !!mcpEditingKey);
  $('#mcp-empty').hidden = mcpDraft.length > 0;

  mcpDraft.forEach((row, i) => {
    const card = document.createElement('div');
    card.className = 'conn-card';
    card.dataset.mcpKey = row.key;
    if (row.key === mcpEditingKey) card.classList.add('editing');
    const info = mcpRowStatus(row);

    const head = document.createElement('div');
    head.className = 'conn-head';
    const title = document.createElement('strong');
    title.className = 'conn-title';
    title.textContent = row.name || 'New server';
    title.title = title.textContent;
    head.appendChild(title);

    const pill = document.createElement('span');
    pill.className = 'conn-badge mcp-pill' + (info.pill ? ' ' + info.pill : '');
    pill.textContent = info.label;
    if (info.title) pill.title = info.title;
    head.appendChild(pill);

    const editBtn = document.createElement('button');
    editBtn.type = 'button';
    editBtn.className = 'ghost conn-edit';
    editBtn.setAttribute('aria-label', `Edit ${row.name || 'server'}`);
    editBtn.setAttribute('aria-controls', 'mcp-editor');
    editBtn.setAttribute('aria-expanded', String(row.key === mcpEditingKey));
    const editIcon = document.createElement('span');
    editIcon.className = 'conn-icon conn-icon-edit';
    editIcon.setAttribute('aria-hidden', 'true');
    editBtn.appendChild(editIcon);
    editBtn.onclick = () => {
      const closing = mcpEditingKey === row.key;
      mcpEditingKey = closing ? '' : row.key;
      renderMcp();
      if (closing) [...list.children].find(el => el.dataset.mcpKey === row.key)?.querySelector('.conn-edit')?.focus();
      else $('#mcp-editor input, #mcp-editor select')?.focus();
    };
    head.appendChild(editBtn);
    card.appendChild(head);

    const details = document.createElement('dl');
    details.className = 'conn-details';
    const dtTransport = document.createElement('dt'); dtTransport.textContent = 'Transport';
    const ddTransport = document.createElement('dd'); ddTransport.textContent = row.transport === 'http' ? 'HTTP' : 'stdio';
    const dtTarget = document.createElement('dt'); dtTarget.textContent = row.transport === 'http' ? 'URL' : 'Command';
    const ddTarget = document.createElement('dd');
    ddTarget.textContent = row.transport === 'http' ? (row.url || '—') : (row.command || '—');
    ddTarget.title = ddTarget.textContent;
    const dtTools = document.createElement('dt'); dtTools.textContent = 'Tools';
    const ddTools = document.createElement('dd');
    const st = mcpRows.get(row.savedId);
    const toolNames = st && Array.isArray(st.toolNames) ? st.toolNames : [];
    ddTools.textContent = !mcpRowDirty(row) && st && st.status === 'ok'
      ? (toolNames.length ? toolNames.join(', ') : 'none') : '—';
    ddTools.title = ddTools.textContent;
    details.append(dtTransport, ddTransport, dtTarget, ddTarget, dtTools, ddTools);
    card.appendChild(details);

    // --- body: the editable form (moved into the editor while editing) ---
    const body = document.createElement('div');
    body.className = 'conn-body';
    const addField = (labelText, buildInput) => {
      const field = document.createElement('div');
      field.className = 'conn-field';
      const label = document.createElement('label');
      label.textContent = labelText;
      const content = buildInput();
      const input = content.matches('input, select, textarea') ? content : content.querySelector('input, select, textarea');
      if (input) { input.id = `mcp-${i}-${body.children.length}`; label.htmlFor = input.id; }
      field.append(label, content);
      body.appendChild(field);
      return content;
    };
    const dirty = () => { mcpDirty = true; markMcpUnsaved(); };
    const repaint = () => {
      /* Keep the card's pill/summary live without a full re-render — a rebuild
       * mid-keystroke would steal focus. Values already live in `row`. The
       * Test button must re-evaluate too: an edit turns a live button into
       * one that would test stale stored config. */
      const live = [...list.children].find(el => el.dataset.mcpKey === row.key);
      if (!live) return;
      title.textContent = row.name || 'New server';
      title.title = title.textContent;
      const s = mcpRowStatus(row);
      const livePill = live.querySelector('.mcp-pill');
      if (livePill) { livePill.textContent = s.label; livePill.className = 'conn-badge mcp-pill' + (s.pill ? ' ' + s.pill : ''); }
      const liveStatus = live.querySelector('.conn-status');
      if (liveStatus) liveStatus.textContent = s.text;
      const liveTest = live.querySelector('.mcp-test');
      if (liveTest) {
        liveTest.disabled = !mcpTestable(row) || mcpTestsRunning.has(row.savedId);
        liveTest.title = mcpTestTitle(row);
      }
      ddTarget.textContent = row.transport === 'http' ? (row.url || '—') : (row.command || '—');
      ddTarget.title = ddTarget.textContent;
      if ($('#mcp-editor-title')) $('#mcp-editor-title').textContent = 'Edit ' + (row.name || 'server');
    };

    addField('Name', () => {
      const input = document.createElement('input');
      input.type = 'text'; input.value = row.name; input.spellcheck = false;
      input.placeholder = 'e.g. filesystem';
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
        renderMcp();   // transport decides which fields exist — rebuild needed
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

    // --- footer: status + enable toggle + test ---
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
        // Fold the result into the status map so the re-render paints from the
        // same source the pills use — including a failed IPC result.
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

/* Repaint only the dynamic bits (pill, status line, tools cell). Used when the
 * panel has focus: a full renderMcp() rebuilds the form and would steal focus
 * mid-keystroke, which is exactly when status polls land. */
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
    const st = mcpRows.get(row.savedId);
    const toolNames = st && Array.isArray(st.toolNames) ? st.toolNames : [];
    const toolsDd = card.querySelectorAll('.conn-details dd')[2];
    if (toolsDd) {
      toolsDd.textContent = !mcpRowDirty(row) && st && st.status === 'ok'
        ? (toolNames.join(', ') || 'none') : '—';
      toolsDd.title = toolsDd.textContent;
    }
  }
}

/* Refresh status rows without touching the draft. mcp:list kicks a fresh
 * handshake for enabled rows that are unknown/error/stale, so a follow-up
 * poll paints the result once the handshake lands. Returns whether any row
 * is still checking. */
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
    if (!checking) return;      // settled — refreshMcpStatus already painted
    mcpPollTimer = setTimeout(tick, 1200);
  };
  mcpPollTimer = setTimeout(tick, 1200);
}

/* Panel-open hook, mirroring ReachConnPanel.autoTest: reload the draft unless
 * the user has unsaved edits (a reload would eat them), then refresh status so
 * a reopened panel shows live state, not the handshake from last visit. */
window.ReachMcpPanel = {
  async open() {
    await refreshMcpStatus();
    if (!mcpDirty) {
      mcpDraft = [...mcpRows.values()].map(mcpDraftFromRow);
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
  /* Strict validation — sanitizeMcpServers would silently DROP a row with a
   * bad name/missing command, which looks exactly like the app ate the
   * user's input. Better to refuse here and say why. */
  for (const row of mcpDraft) {
    const label = row.name.trim() || '(unnamed)';
    if (!MCP_NAME_RE.test(row.name.trim())) {
      status.textContent = `"${label}" needs a name starting with a letter or digit (letters, digits, . _ -, max 64).`;
      return;
    }
    if (row.transport === 'http') {
      let parsed = null;
      try { parsed = new URL(row.url.trim()); } catch { /* handled below */ }
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
      mcpServers: mcpDraft.map(row => {
        if (row.transport === 'http') {
          return { name: row.name.trim(), enabled: row.enabled !== false, transport: 'http',
            url: row.url.trim(), headers: parseKvLines(row.headersText, ':').map };
        }
        return { name: row.name.trim(), enabled: row.enabled !== false, transport: 'stdio',
          command: row.command.trim(), args: argLines(row.argsText),
          env: parseKvLines(row.envText, '=').map, cwd: row.cwd.trim() };
      }),
    };
    const res = await reachApi.saveSettings(payload);
    if (res && res.ok === false) throw new Error(res.err || 'Could not save.');
    mcpDirty = false;
    // Re-list: names re-slug into ids in main, and changed configs come back
    // marked stale — the poll below reconnects them and repaints the result.
    await refreshMcpStatus();
    mcpDraft = [...mcpRows.values()].map(mcpDraftFromRow);
    renderMcp();
    pollMcpStatus();
    status.dataset.savedRecently = '1';
    status.textContent = 'Saved.';
    setTimeout(() => { status.textContent = ''; delete status.dataset.savedRecently; }, 2000);
  } catch (e) {
    status.textContent = e.message;
  } finally {
    button.disabled = false;
  }
};
