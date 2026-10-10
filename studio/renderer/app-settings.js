// ---------- settings ----------
/* Connection cards are built with createElement, never string interpolation:
 * escapeHtml() escapes & < > but NOT quotes, so interpolating an endpoint or
 * access key into a value="..." attribute would break on the first quote and
 * could inject markup. Setting .value on a created element has no such hole. */
let connDraft = [];        // working copy; only written to disk on Save
let connActiveId = '';
let connEditingId = '';    // Editing a tile never changes the active connection.
let jevClearRequested = false;
const CONN_MAX = 20;       // mirrors connections.cjs MAX_CONNECTIONS
/* Per-connection test results, keyed by connection id. Kept OUTSIDE the DOM so
 * a re-render (pool toggle, activation, Settings save) does not wipe the last
 * "OK · 812 ms" off a card — and so auto-test on panel open knows which rows
 * still need one. A row's entry is cleared the moment its URL or key is edited:
 * a result describing values that no longer exist is a lie, not a cache. */
const connStatus = new Map();   // id -> { text, cls }
const connTesters = [];         // rebuilt by renderConnections: [{ id, running, run }]
const connTestsRunning = new Set(); // Survives opening/closing an editor during a ping.

async function loadSettings() {
  const s = await reachApi.getSettings();
  document.documentElement.dataset.pageLayout = s.pageLayout === 'full-width' ? 'full-width' : 'page-sized';
  $('#set-page-sized').checked = document.documentElement.dataset.pageLayout === 'page-sized';
  $('#set-page-sized').disabled = s.credentialStorage?.locked === true;
  const credentialWarning = $('#credential-storage-warning');
  credentialWarning.textContent = s.credentialStorage?.warning || '';
  credentialWarning.classList.toggle('hidden', !s.credentialStorage?.warning);
  let credentialAck = $('#credential-storage-ack');
  if (!credentialAck && credentialWarning.parentElement) {
    credentialAck = document.createElement('button');
    credentialAck.id = 'credential-storage-ack';
    credentialAck.type = 'button';
    credentialAck.className = 'btn';
    credentialAck.textContent = 'I understand keys are stored without a system vault';
    credentialAck.addEventListener('click', () => {
      sessionStorage.setItem('reach-plaintext-ack', '1');
      credentialAck.hidden = true;
    });
    credentialWarning.insertAdjacentElement('afterend', credentialAck);
  }
  if (credentialAck) {
    credentialAck.hidden = !s.credentialStorage?.warning || sessionStorage.getItem('reach-plaintext-ack') === '1';
  }
  $('#set-reach-cli').value = s.reachCli || '';
  $('#set-jev-enabled').checked = s.jevEnabled === true;
  jevAutoDefault = s.jevAutoMode === true;
  $('#set-jev-auto-mode').checked = jevAutoDefault;
  window.ReachWorkspace?.syncControls();
  $('#set-jev-key').value = '';
  jevClearRequested = false;
  $('#btn-clear-jev-key').disabled = s.jevKeySource !== 'saved';
  $('#set-jev-key-status').textContent = s.jevKeySource === 'saved' ? 'A saved key is configured. Leave blank to keep it.'
    : s.jevKeySource === 'environment' ? 'Using TYPESAFE_API_KEY from the Studio process environment.'
      : 'Add a key to enable Jev calls. The key is not shown again after saving.';
  // Draft from the normalized list so ids are stable and the active one is known.
  connDraft = (Array.isArray(s.connections) ? s.connections : []).map(c => ({ ...c }));
  connActiveId = s.activeConnection || (connDraft[0] ? connDraft[0].id : '');
  // Drop test results for connections that no longer exist (removed here, in
  // the status bar, or by a hand-edited settings.json).
  for (const id of [...connStatus.keys()]) {
    if (!connDraft.some(c => c.id === id)) connStatus.delete(id);
  }
  renderConnections();
  for (const control of $('#settings-connection').querySelectorAll('input, select, button')) {
    if (s.credentialStorage?.locked) control.disabled = true;
    else if (control.dataset.credentialLocked === 'true') control.disabled = false;
    control.dataset.credentialLocked = String(!!s.credentialStorage?.locked);
  }
}
$('#set-jev-key').oninput = () => { jevClearRequested = false; };
$('#btn-clear-jev-key').onclick = () => {
  jevClearRequested = true;
  $('#set-jev-key').value = '';
  $('#set-jev-key-status').textContent = 'Saved key will be removed when you save Settings.';
};

function newConnId() {
  // Client-side placeholder id for an unsaved row; the main process assigns the
  // real one on save. Prefixed so it can never collide with a stored id.
  return 'draft_' + Math.random().toString(36).slice(2, 10);
}

function renderConnections() {
  const list = $('#conn-list');
  if (!list) return;
  const editor = $('#conn-editor');
  // The narrow layout nests this editor in its tile. Move it out before rebuilding.
  $('#conn-workspace').appendChild(editor);
  list.replaceChildren();
  editor.replaceChildren();
  if (!connDraft.some(c => c.id === connEditingId)) connEditingId = '';
  editor.classList.toggle('hidden', !connEditingId);
  $('#conn-workspace').classList.toggle('editing', !!connEditingId);
  // Each card registers its test runner here so "Test all" and the panel's
  // auto-test can drive every row without re-querying handlers off the DOM.
  connTesters.length = 0;

  /* Clear a row's stored test result. Called the moment its URL or key changes:
   * the old "OK" described values the user just replaced, and a stale success
   * is worse than no result at all. */
  function clearConnStatus(id) {
    connStatus.delete(id);
    const card = document.querySelector('#conn-list .conn-card[data-conn-id="' + id + '"]');
    const status = card && card.querySelector('.conn-status');
    if (status) { status.textContent = ''; status.classList.remove('ok', 'bad'); }
  }

  connDraft.forEach((c, i) => {
    const card = document.createElement('div');
    card.className = 'conn-card';
    card.dataset.connId = c.id;
    if (c.id === connActiveId) card.classList.add('active');
    if (c.id === connEditingId) card.classList.add('editing');

    // --- header: radio (active) + name + status pill ---
    const head = document.createElement('div');
    head.className = 'conn-head';

    const radio = document.createElement('input');
    radio.type = 'radio';
    radio.name = 'conn-active';
    radio.className = 'conn-radio';
    radio.checked = c.id === connActiveId;
    radio.title = 'Use this connection';
    radio.setAttribute('aria-label', `Use ${c.name || 'this connection'}`);
    radio.onchange = () => {
      connActiveId = c.id; c.enabled = true; renderConnections(); markUnsaved();
      [...list.children].find(el => el.dataset.connId === c.id)?.querySelector('.conn-radio')?.focus();
    };
    head.appendChild(radio);

    const title = document.createElement('strong');
    title.className = 'conn-title';
    head.appendChild(title);

    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.className = 'conn-name';
    nameInput.value = c.name || '';
    nameInput.readOnly = c.id === 'reach_hosted';
    nameInput.placeholder = 'Connection name';
    nameInput.spellcheck = false;
    nameInput.setAttribute('aria-label', 'Connection name');
    nameInput.oninput = () => { c.name = nameInput.value; syncSummary(); markUnsaved(); };

    const badge = document.createElement('span');
    badge.className = 'conn-badge' + (c.id === connActiveId ? ' on' : '');
    badge.textContent = c.id === connActiveId ? 'Active' : 'Select';
    badge.title = c.id === connActiveId
      ? 'Active connection: used by chats, playground and refactor, and the fallback every team member can use.'
      : 'Click the radio to make this the active connection.';
    if (c.id === connActiveId) head.appendChild(badge);

    const editBtn = document.createElement('button');
    editBtn.type = 'button';
    editBtn.className = 'ghost conn-edit';
    editBtn.setAttribute('aria-label', `Edit ${c.name || 'connection'}`);
    editBtn.setAttribute('aria-controls', 'conn-editor');
    editBtn.setAttribute('aria-expanded', String(c.id === connEditingId));
    const editIcon = document.createElement('span');
    editIcon.className = 'conn-icon conn-icon-edit';
    editIcon.setAttribute('aria-hidden', 'true');
    editBtn.appendChild(editIcon);
    editBtn.onclick = () => {
      const closing = connEditingId === c.id;
      connEditingId = closing ? '' : c.id;
      renderConnections();
      if (closing) [...list.children].find(el => el.dataset.connId === c.id)?.querySelector('.conn-edit')?.focus();
      else $('#conn-editor .conn-name')?.focus();
    };
    head.appendChild(editBtn);

    /* Pool toggle — click to include this connection in team runs, click again to
     * take it out. This is the multi-select the user asked for: several
     * connections can be in the pool at once, and Teams spreads members across
     * them. Kept separate from the radio because they answer different questions:
     * the radio picks THE active connection (one, always), this picks which
     * connections teams may use (many).
     *
     * The active connection cannot leave the pool — it is the fallback, and a
     * fallback that can be switched off is not a fallback. The last one in the
     * pool cannot leave either, or a spread team would have nowhere to run. Both
     * are enforced in the main process too; the checks here just explain instead
     * of letting a click appear to do nothing. */
    const isActive = c.id === connActiveId;
    const enabled = c.enabled !== false;
    const enabledCount = connDraft.filter(x => x.enabled !== false).length;
    const poolBtn = document.createElement('button');
    poolBtn.type = 'button';
    poolBtn.className = 'conn-pool' + (enabled ? ' on' : '');
    poolBtn.textContent = enabled ? 'In team pool' : 'Add to pool';
    poolBtn.setAttribute('aria-pressed', String(enabled));
    poolBtn.dataset.connId = c.id;
    poolBtn.title = isActive
      ? 'The active connection is always in the team pool: it is the fallback.'
      : (enabled
        ? 'Click to stop teams using this connection.'
        : 'Click to let teams spread members onto this connection.');
    // Disabled only when the click is guaranteed to be refused, so the user gets a
    // reason from the title rather than a control that silently does nothing.
    poolBtn.disabled = isActive || (enabled && enabledCount <= 1);
    if (!isActive && enabled && enabledCount <= 1) poolBtn.title = 'At least one connection must stay in the team pool.';
    poolBtn.onclick = () => {
      if (isActive) return;
      const next = !(c.enabled !== false);
      if (!next && connDraft.filter(x => x.enabled !== false).length <= 1) {
        const st = $('#settings-status');
        if (st) st.textContent = 'At least one connection must stay in the team pool.';
        return;
      }
      c.enabled = next;
      renderConnections();
      markUnsaved();
      [...list.children].find(el => el.dataset.connId === c.id)?.querySelector('.conn-pool')?.focus();
    };

    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'ghost small conn-remove';
    removeBtn.textContent = 'Remove connection';
    removeBtn.title = connDraft.length <= 1 ? 'At least one connection must remain' : 'Remove connection';
    removeBtn.disabled = connDraft.length <= 1 || c.id === 'reach_hosted';
    if (c.id === 'reach_hosted') removeBtn.title = 'Manage the REACH service from Home';
    removeBtn.setAttribute('aria-label', `Remove ${c.name || 'connection'}`);
    removeBtn.onclick = () => {
      if (connDraft.length <= 1) return;
      connDraft.splice(i, 1);
      if (connActiveId === c.id) {
        connActiveId = connDraft[0] ? connDraft[0].id : '';
        if (connDraft[0]) connDraft[0].enabled = true;
      }
      renderConnections();
      markUnsaved();
      $('#btn-add-connection').focus();
    };
    card.appendChild(head);

    const details = document.createElement('dl');
    details.className = 'conn-details';
    const modelLabel = document.createElement('dt');
    modelLabel.textContent = 'Model';
    const modelValue = document.createElement('dd');
    const hostLabel = document.createElement('dt');
    hostLabel.textContent = 'Host';
    const hostValue = document.createElement('dd');
    details.append(modelLabel, modelValue, hostLabel, hostValue);
    card.appendChild(details);
    function syncSummary() {
      title.textContent = c.name || 'New connection';
      title.title = title.textContent;
      modelValue.textContent = c.model || 'No default model';
      modelValue.title = modelValue.textContent;
      let host = 'Enter a Base URL';
      try { const url = new URL(c.endpoint); host = url.host + url.pathname.replace(/\/$/, ''); } catch { /* Avoid displaying credentials from malformed URLs. */ }
      hostValue.textContent = host;
      hostValue.title = host;
      radio.setAttribute('aria-label', `Use ${c.name || 'this connection'}`);
      editBtn.setAttribute('aria-label', `Edit ${c.name || 'connection'}`);
      if (c.id === connEditingId && $('#conn-editor-title')) $('#conn-editor-title').textContent = 'Edit ' + (c.name || 'connection');
    }
    syncSummary();

    // --- body: endpoint, key, model ---
    const body = document.createElement('div');
    body.className = 'conn-body';

    const addField = (labelText, buildInput) => {
      const row = document.createElement('div');
      row.className = 'conn-field';
      const label = document.createElement('label');
      label.textContent = labelText;
      row.appendChild(label);
      const content = buildInput();
      const input = content.matches('input') ? content : content.querySelector('input');
      if (input) {
        input.id = `conn-${i}-${body.children.length}`;
        label.htmlFor = input.id;
      }
      row.appendChild(content);
      body.appendChild(row);
    };

    addField('Name', () => nameInput);

    // Keep a reference to the URL field so Browse and Test can read the value the
    // user is currently looking at. (c.endpoint is kept live by its oninput, but
    // reading the input directly is unambiguous and survives a re-render order
    // change; an earlier draft of this grabbed the MODEL input by mistake and
    // would have sent the model name as the endpoint.)
    let urlInput = null;

    addField('Base URL', () => {
      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'conn-url';
      input.value = c.endpoint || '';
      input.readOnly = c.id === 'reach_hosted';
      input.placeholder = 'https://your-endpoint.example.com/v1';
      input.spellcheck = false;
      input.oninput = () => { c.endpoint = input.value.trim(); syncSummary(); clearConnStatus(c.id); markUnsaved(); };
      urlInput = input;
      return input;
    });

    addField('Access Key', () => {
      const wrap = document.createElement('div');
      wrap.className = 'row';
      const input = document.createElement('input');
      input.type = 'password';
      input.value = c.accessKey || '';
      input.placeholder = c.id === 'reach_hosted' ? 'Managed securely by wallet sign-in' : 'leave blank for none';
      input.disabled = c.id === 'reach_hosted';
      input.autocomplete = 'off';
      input.spellcheck = false;
      input.oninput = () => { c.accessKey = input.value; clearConnStatus(c.id); markUnsaved(); };
      const reveal = document.createElement('button');
      reveal.type = 'button';
      reveal.className = 'ghost small';
      reveal.textContent = 'Show';
      reveal.disabled = c.id === 'reach_hosted';
      reveal.onclick = () => {
        const showing = input.type === 'text';
        input.type = showing ? 'password' : 'text';
        reveal.textContent = showing ? 'Show' : 'Hide';
      };
      wrap.append(input, reveal);
      return wrap;
    });

    addField('Default model', () => {
      const wrap = document.createElement('div');
      wrap.className = 'row';
      const input = document.createElement('input');
      input.type = 'text';
      input.value = c.model || '';
      input.placeholder = 'click Browse to pick from this endpoint';
      input.spellcheck = false;
      input.className = 'conn-model';
      input.oninput = () => { c.model = input.value.trim(); syncSummary(); markUnsaved(); };
      const browse = document.createElement('button');
      browse.type = 'button';
      browse.className = 'ghost small';
      browse.textContent = 'Browse…';
      // Browse uses the URL CURRENTLY IN THE ROW, not the saved one: the user is
      // configuring this connection and may not have saved it yet. Listing from
      // the stored value would make the button appear broken on a new row.
      browse.onclick = () => openModelPicker({
        target: c.id === 'reach_hosted' ? { connectionId: c.id } : { endpoint: (urlInput ? urlInput.value : c.endpoint).trim(), accessKey: c.accessKey || '' },
        onPick: (id) => { c.model = id; input.value = id; syncSummary(); markUnsaved(); },
        label: c.name || (urlInput ? urlInput.value : c.endpoint),
      });
      wrap.append(input, browse);
      return wrap;
    });

    // --- footer: per-row test ---
    /* One test path for the row button, "Test all" and the panel's auto-test.
     *
     * A SAVED row whose on-screen values still match the stored ones is pinged
     * BY ID (connections:ping → GET /models): that returns the round-trip
     * latency, which is also painted onto the status bar's latency chip when
     * this row is the active connection. An edited row — or an unsaved draft
     * row that has no id to ping yet — falls back to the ad-hoc models lookup,
     * which validates exactly the values on screen rather than the stored ones.
     *
     * Results are stored per connection id (connStatus) and restored on every
     * re-render, so a pool toggle or a save cannot wipe them; editing the URL
     * or key clears the entry (clearConnStatus). */
    const foot = document.createElement('div');
    foot.className = 'conn-foot';
    const testBtn = document.createElement('button');
    testBtn.type = 'button';
    testBtn.className = 'ghost small conn-test';
    testBtn.textContent = 'Test';
    testBtn.disabled = connTestsRunning.has(c.id);
    const status = document.createElement('span');
    status.className = 'dim conn-status';
    const tester = { id: c.id, running: false, run: null };
    let testedEndpoint = '', testedKey = '';
    const stillCurrent = () => connDraft.some(row => row.id === c.id
      && String(row.endpoint || '').trim() === testedEndpoint && (row.accessKey || '') === testedKey);

    /* Write to this card's span AND the live one when they differ: a re-render
     * replaces the card's DOM mid-test, and a result that lands only on the
     * detached node would be invisible until the next render. */
    const setStatus = (text, cls, store = true) => {
      if (tester.running && !stillCurrent()) return;
      const apply = (el) => {
        if (!el) return;
        el.textContent = text;
        el.classList.remove('ok', 'bad');
        if (cls) el.classList.add(cls);
      };
      apply(status);
      const live = document.querySelector('#conn-list .conn-card[data-conn-id="' + c.id + '"] .conn-status');
      if (live && live !== status) apply(live);
      if (store) {
        if (text) connStatus.set(c.id, { text, cls: cls || '' });
        else connStatus.delete(c.id);
      }
    };

    const savedStatus = connStatus.get(c.id);
    if (savedStatus) setStatus(savedStatus.text, savedStatus.cls, false);
    else if (connTestsRunning.has(c.id)) setStatus('Testing…', '', false);

    tester.run = async () => {
      if (connTestsRunning.has(c.id)) return { ok: false, skipped: true };
      // Read urlInput, not a CSS query: the model field is ALSO type=text, so
      // `.conn-field input[type=text]` only works by accident of append order.
      const endpoint = (urlInput ? urlInput.value : (c.endpoint || '')).trim();
      if (!endpoint) { setStatus('Enter a Base URL first.', 'bad'); return { ok: false, err: 'no endpoint' }; }
      testedEndpoint = endpoint;
      testedKey = c.accessKey || '';
      tester.running = true;
      connTestsRunning.add(c.id);
      testBtn.disabled = true;
      setStatus('Testing…', '', false);
      const stripSlash = value => String(value || '').trim().replace(/\/+$/, '');
      try {
        let earlier = null;
        try { earlier = await reachApi.connections.list(); } catch { /* fall back to the ad-hoc lookup */ }
        const rec = earlier && (earlier.connections || []).find(x => x.id === c.id);
        const unchanged = !!rec
          && stripSlash(rec.endpoint) === stripSlash(endpoint)
          && (rec.accessKey || '') === testedKey;
        let result;
        if (unchanged) {
          const ping = await reachApi.connections.ping(c.id);
          const ok = !!(ping && ping.ok);
          if (ok) {
            const models = ping.models === null || ping.models === undefined ? '' : ` · ${ping.models} model(s)`;
            result = { ok: true, text: `OK · ${ping.latencyMs} ms${models}` };
          } else {
            result = { ok: false, text: `Failed · ${(ping && ping.err) || 'unreachable'}` };
          }
          // The latency chip speaks for the ACTIVE connection only.
          if (c.id === connActiveId && stillCurrent()) window.ReachWorkspaceShell?.setLatency(ok ? ping.latencyMs : null, ok);
        } else {
          const res = await reachApi.listModels({ endpoint, accessKey: testedKey });
          result = res && res.ok
            ? { ok: true, text: `OK · ${res.models.length} model(s)` }
            : { ok: false, text: `Failed · ${(res && res.err) || 'unreachable'}` };
        }
        setStatus(result.text, result.ok ? 'ok' : 'bad');
        return result;
      } catch (e) {
        setStatus('Failed · ' + e.message, 'bad');
        return { ok: false, err: e.message };
      } finally {
        tester.running = false;
        connTestsRunning.delete(c.id);
        testBtn.disabled = false;
        const liveCard = [...list.children].find(el => el.dataset.connId === c.id);
        const liveButton = liveCard?.querySelector('.conn-test');
        if (liveButton) liveButton.disabled = false;
        if (!stillCurrent()) clearConnStatus(c.id);
      }
    };
    testBtn.onclick = () => { void tester.run(); };
    connTesters.push(tester);
    foot.append(status, poolBtn, testBtn);

    // Keep the existing inputs and their handlers; only the edited form is visible.
    if (c.id === connEditingId) {
      const editorHead = document.createElement('div');
      editorHead.className = 'conn-editor-head';
      const heading = document.createElement('h3');
      heading.id = 'conn-editor-title';
      heading.textContent = 'Edit ' + (c.name || 'connection');
      const close = document.createElement('button');
      close.type = 'button';
      close.className = 'ghost small';
      close.textContent = 'Close';
      const closeEditor = () => {
        connEditingId = '';
        renderConnections();
        [...list.querySelectorAll('.conn-card')].find(el => el.dataset.connId === c.id)?.querySelector('.conn-edit')?.focus();
      };
      close.onclick = closeEditor;
      editor.onkeydown = event => {
        if (event.key === 'Escape') { event.preventDefault(); closeEditor(); }
      };
      editorHead.append(heading, close);
      const hint = document.createElement('p');
      hint.className = 'dim conn-editor-hint';
      hint.textContent = 'Changes apply when you press Save Settings.';
      editor.append(editorHead, body, hint, removeBtn);
    } else {
      body.hidden = true;
      card.appendChild(body);
    }
    card.appendChild(foot);
    list.appendChild(card);
  });

  const count = $('#conn-count');
  if (count) {
    const inPool = connDraft.filter(c => c.enabled !== false).length;
    // Two facts the user needs here: how many rows exist against the limit, and
    // how many of them teams may actually use.
    count.textContent = `${connDraft.length} of ${CONN_MAX} connection(s) · ${inPool} in team pool`;
  }
  const addBtn = $('#btn-add-connection');
  if (addBtn) addBtn.disabled = connDraft.length >= CONN_MAX;

  /* One line stating what the app is actually configured to use — the same fact
   * the status bar shows, painted from the DRAFT so edits appear before saving. */
  const summary = $('#conn-summary');
  if (summary) {
    const active = connDraft.find(c => c.id === connActiveId) || null;
    summary.textContent = active
      ? `Active: ${active.name || active.endpoint || 'connection'}${active.model ? ' — model ' + active.model : ' — no default model'}. Used by every conversation, the playground and the refactor workbench.`
      : 'No active connection yet. Add one below.';
  }
  layoutConnectionEditor();
}

function layoutConnectionEditor() {
  const workspace = $('#conn-workspace');
  const editor = $('#conn-editor');
  if (!workspace || !editor) return;
  const inline = workspace.clientWidth < 900;
  workspace.classList.toggle('inline-editor', inline);
  const card = [...$('#conn-list').children].find(el => el.dataset.connId === connEditingId);
  const parent = inline && card ? card : workspace;
  if (editor.parentElement !== parent) {
    // Moving the same form preserves typed values, Show/Hide state and focus.
    if (parent.moveBefore) parent.moveBefore(editor, null);
    else parent.appendChild(editor);
  }
}
let connLayoutFrame = 0;
new ResizeObserver(() => {
  cancelAnimationFrame(connLayoutFrame);
  connLayoutFrame = requestAnimationFrame(layoutConnectionEditor);
}).observe($('#settings-connection'));

function markUnsaved() {
  const el = $('#settings-status');
  if (el && !el.dataset.savedRecently) el.textContent = 'Unsaved changes.';
}

/* Cross-surface mirror for the status bar's quick-switch (workspace-shell.js).
 *
 * The footer persists activation and model picks straight through the
 * connections IPC — this draft never sees those writes. Without the mirror the
 * draft would keep the OLD active id / model, and the next Save Settings would
 * silently write them back, reverting the switch the user just made.
 *
 * Deliberately minimal: only the fields the footer owns are copied, already
 * typed card edits stay untouched, and nothing is marked unsaved — the switch
 * is already on disk, the draft is just catching up to it. */
window.ReachSettingsDraft = {
  setActive(id) {
    if (!id || !connDraft.some(c => c.id === id)) return;
    connActiveId = id;
    if ($('#page-settings')?.classList.contains('active')) renderConnections();
  },
  setModel(id, model) {
    const row = connDraft.find(c => c.id === id);
    if (!row) return;
    row.model = model;
    if ($('#page-settings')?.classList.contains('active')) renderConnections();
  },
};

$('#btn-add-connection').onclick = () => {
  if (connDraft.length >= CONN_MAX) return;
  const c = { id: newConnId(), name: '', endpoint: '', accessKey: '', model: '', enabled: true };
  connDraft.push(c);
  // Activating the new row matches the old single-endpoint behaviour (you are
  // editing what you will use) and makes its Browse/Test target obvious.
  connActiveId = c.id;
  connEditingId = c.id;
  renderConnections();
  markUnsaved();
  $('#conn-editor .conn-name')?.focus();
};

/* "Test all": ping every row with the values on screen, in parallel. Read-only
 * (GET /models), so it cannot cost tokens or mutate anything. Each row writes
 * its own status; nothing here waits on another row. */
{
  const testAllBtn = $('#btn-test-all');
  if (testAllBtn) testAllBtn.onclick = async () => {
    if (testAllBtn.disabled) return;
    testAllBtn.disabled = true;
    try { await Promise.allSettled(connTesters.map(t => t.run())); }
    finally { testAllBtn.disabled = false; }
  };
}

/* Auto-test hook for the Connection panel's open (called from settings.js):
 * test every rendered row that has no stored result yet, so the page never
 * looks the same whether or not any provider is reachable. Results persist per
 * connection id until that row is edited, so reopening does not re-ping. Rows
 * with no URL are skipped — there is nothing to test, and "Enter a Base URL
 * first." on an untouched new row is noise, not information. */
window.ReachConnPanel = {
  autoTest() {
    for (const tester of connTesters) {
      if (connStatus.has(tester.id)) continue;
      const connection = connDraft.find(c => c.id === tester.id);
      if (!connection?.endpoint?.trim()) continue;
      void tester.run();
    }
  },
};

$('#btn-save-settings').onclick = async () => {
  // Validate before writing: a row with no endpoint is unusable, and saving one
  // would silently drop it (normalize discards endpoint-less entries), which
  // would look like the app ate the user's input.
  const blanks = connDraft.filter(c => !String(c.endpoint || '').trim());
  const status = $('#settings-status');
  if (blanks.length) {
    status.textContent = `Enter a Base URL for ${blanks.length} connection(s), or remove the empty row(s).`;
    return;
  }
  const endpoints = connDraft.map(c => String(c.endpoint).trim().replace(/\/+$/, ''));
  const dupe = endpoints.find((e, i) => endpoints.indexOf(e) !== i);
  if (dupe) { status.textContent = `Two connections use the same endpoint: ${dupe}`; return; }
  if (!connDraft.some(c => c.id === connActiveId)) connActiveId = connDraft[0]?.id || '';

  const payload = {
    reachCli: $('#set-reach-cli').value.trim(),
    jevEnabled: $('#set-jev-enabled').checked,
    jevAutoMode: $('#set-jev-auto-mode').checked,
    ...(jevClearRequested ? { jevApiKeyAction: 'clear' } : $('#set-jev-key').value.trim() ? { jevApiKey: $('#set-jev-key').value.trim() } : {}),
    // Sending `connections` makes the list authoritative (see settings:save), so
    // the legacy endpoint/accessKey/model fields are recomputed from the active
    // row instead of being folded back into it.
    connections: connDraft.map(c => ({
      id: c.id, name: c.name, endpoint: String(c.endpoint).trim(),
      accessKey: c.accessKey || '', model: String(c.model || '').trim(),
      /* `enabled` must be sent explicitly: this object literal is the whole row,
       * so omitting it would reset every pool toggle on Save — and silently,
       * because normalizeSettings treats a missing field as enabled. */
      enabled: c.enabled !== false,
    })),
    activeConnection: connActiveId,
  };
  const res = await reachApi.saveSettings(payload);
  if (res && res.ok === false) { status.textContent = res.err || 'Could not save.'; return; }
  composerModelsCache = { key: '', at: 0, items: [] };
  invalidateComposerCatalog();
  // Re-read so the UI shows the ids and projection the main process settled on
  // (draft ids are replaced by real ones for new rows).
  await loadSettings();
  refreshStatus();
  // The status bar reads the same settings; repaint its chips so a switch or
  // model change saved here shows up immediately instead of lagging behind.
  window.ReachWorkspaceShell?.refreshEndpointChip();
  status.dataset.savedRecently = '1';
  status.textContent = 'Saved.';
  setTimeout(() => { status.textContent = ''; delete status.dataset.savedRecently; }, 2000);
};

