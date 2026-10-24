/* Opt-in Gemma workspace. Files stay local; requests use the visitor's REACH session. */
(() => {
  'use strict';
  const ORIGIN = 'https://unbent-semicolon-hermit.ngrok-free.dev';
  const MODEL = 'gemma-4-12b-qat', STORAGE = 'signalreach.website-workspace.v1';
  function mount() {
    const core = globalThis.SignalREACHWorkspaceCore;
    const studio = document.querySelector('.studio-window'), panel = document.querySelector('#preview-workspace');
    if (!core || !studio || !panel) return () => {};
    const lifetime = new AbortController(), signal = lifetime.signal;
    const history = [];
    const on = (node, name, fn) => node.addEventListener(name, fn, {signal});
    const el = (tag, cls, text) => { const node = document.createElement(tag); node.className = cls || ''; if (text !== undefined) node.textContent = text; return node; };
    const button = text => { const node = el('button', 'gemma-button', text); node.type = 'button'; return node; };
    let files; try { files = core.restore(localStorage.getItem(STORAGE)); } catch (_) { files = {...core.starter}; }
    let enabled = false, destroyed = false, active = 'index.html', edit = null, request = null, frame = null, channel = '', composing = false, previewTimer = 0, knownToken = '';
    let previewStorage = {};
    try { const stored = JSON.parse(localStorage.getItem('signalreach.website-preview.v1') || '{}'); if (validStorage(stored)) previewStorage = stored; } catch (_) {}
    const original = [...panel.children].map(node => [node, node.hidden]);
    const pill = studio.querySelector('.window-bar > .pill'), oldPill = pill?.textContent;
    const hint = studio.parentElement.querySelector('.preview-hint'), oldHint = hint?.innerHTML;
    const footer = studio.querySelector('.window-footer'), oldFooter = footer?.innerHTML;
    const caption = studio.parentElement.querySelector('.preview-caption'), oldCaption = caption?.textContent;
    const toggle = button('Try Gemma'); toggle.classList.add('gemma-toggle'); toggle.setAttribute('role', 'switch'); toggle.setAttribute('aria-checked', 'false'); toggle.setAttribute('aria-controls', 'gemma-workspace');
    studio.querySelector('.window-bar').append(toggle);
    const workspace = el('div', 'gemma-workspace'); workspace.id = 'gemma-workspace'; workspace.hidden = true;
    const explorer = el('aside', 'gemma-explorer'); explorer.setAttribute('aria-label', 'AI website files');
    const fileCount = el('p'), fileList = el('div', 'gemma-file-list');
    explorer.append(el('strong', '', 'YOUR PROJECT'), fileCount, fileList);
    let fileButtons = [];
    const reset = button('Start over'); explorer.append(reset, el('p', 'gemma-small', 'Saved in this browser. Ask Gemma to build your idea and create the files it needs. No uploads.'));
    const center = el('section', 'gemma-center'); center.setAttribute('aria-label', 'Website source and preview');
    const bar = el('div', 'gemma-bar'), fileTitle = el('strong', '', active), viewCode = button('Code'), run = button('Preview website');
    bar.append(fileTitle, viewCode, run);
    const source = el('pre', 'gemma-source'); source.tabIndex = 0; source.setAttribute('aria-label', 'Read-only website source');
    const preview = el('div', 'gemma-preview'); preview.hidden = true;
    const previewStatus = el('p', 'gemma-small', 'Select Preview website to run the starter.'); previewStatus.setAttribute('role', 'status');
    center.append(bar, source, preview, previewStatus);
    const chat = el('section', 'gemma-chat'); chat.setAttribute('aria-label', 'Build with Gemma');
    const header = el('div', 'gemma-bar'); header.append(el('strong', '', 'Build with Gemma 12B'));
    const login = el('a', 'gemma-button', 'Sign in'); login.href = 'login.html'; header.append(login);
    const log = el('div', 'gemma-log'); log.setAttribute('role', 'log'); log.setAttribute('aria-live', 'polite'); log.tabIndex = 0;
    const thinking = el('div', 'gemma-thinking'); thinking.hidden = true; thinking.setAttribute('role', 'status');
    const thinkingTrack = el('span', 'gemma-thinking-track'); thinkingTrack.setAttribute('aria-hidden', 'true');
    thinking.append(el('span', '', 'Thinking...'), thinkingTrack);
    const review = el('div', 'gemma-review'); review.hidden = true;
    const form = el('form', 'gemma-form');
    const label = el('label', '', 'Describe your website or the next change'); label.htmlFor = 'gemma-prompt';
    const input = el('textarea'); input.id = 'gemma-prompt'; input.maxLength = core.maxPrompt; input.rows = 3; input.required = true; input.placeholder = 'Build a landing page for a neighbourhood bakery…';
    input.setAttribute('aria-describedby', 'gemma-context-note');
    const actions = el('div', 'gemma-bar'), send = button('Ask Gemma'), stop = button('Stop'); send.type = 'submit'; stop.hidden = true;
    actions.append(send, stop);
    const status = el('p', 'gemma-small'); status.setAttribute('role', 'status');
    const note = el('p', 'gemma-small', 'Your prompt and generated project files go to REACH when you send. Your account’s model access and usage limits apply. No uploads; keep secrets out.'); note.id = 'gemma-context-note';
    form.append(label, input, actions, status, note); chat.append(header, log, thinking, review, form);
    workspace.append(explorer, center, chat); panel.append(workspace);
    function session() { try { return JSON.parse(sessionStorage.getItem('signalreach.account.session') || 'null')?.accessToken || ''; } catch (_) { return ''; } }
    function accountState(resetStatus = false) {
      const token = session(); login.hidden = Boolean(token);
      if (resetStatus || !status.textContent || token !== knownToken) status.textContent = token ? 'Ready · Requests use your REACH account' : 'Sign in to REACH, then return here to build with Gemma.';
      knownToken = token; send.disabled = Boolean(request) || !token;
    }
    function welcome() { history.length = 0; log.replaceChildren(el('p', '', 'What would you like to build? Ask Gemma for a website, app, game, design, theme, or a change to your project. Review the generated files, then apply and preview. No uploads needed.')); }
    function addMessage(text, role = '') {
      const node = el('p', role === 'user' ? 'gemma-user' : '', text); log.append(node);
      if (role === 'error') { node.classList.add('gemma-error'); node.setAttribute('role', 'alert'); }
      while (log.children.length > 16) log.firstElementChild.remove(); log.scrollTop = log.scrollHeight;
    }
    function save() {
      try { localStorage.setItem(STORAGE, JSON.stringify({version:1, files})); return true; }
      catch (_) { status.textContent = 'Changes are in this tab only; browser storage is unavailable.'; return false; }
    }
    function showFile(name) {
      if (!Object.hasOwn(files, name)) name = Object.keys(files)[0];
      clearTimeout(previewTimer); frame?.remove(); frame = null; channel = '';
      active = name; source.textContent = files[name]; source.hidden = false; preview.hidden = true; fileTitle.textContent = name;
      previewStatus.textContent = 'Read-only source · Ask Gemma to make changes, then preview.';
      fileButtons.forEach(node => node.setAttribute('aria-pressed', String(node.dataset.projectFile === name)));
    }
    function renderFiles() {
      fileList.replaceChildren(); fileButtons = Object.keys(files).map(name => {
        const node = button(name); node.dataset.projectFile = name; node.title = name;
        node.onclick = () => showFile(name); fileList.append(node); return node;
      }); fileCount.textContent = `${fileButtons.length} files · AI edits`;
    }
    function clearReview() { edit = null; review.replaceChildren(); review.hidden = true; }
    function stopRequest(message = 'Stopped. No files were changed. The server may still count a request already accepted.') {
      if (!request) return;
      const pending = request; request = null; pending.abort(); setBusy(false); status.textContent = message;
    }
    function setBusy(value) {
      thinking.hidden = !value;
      send.disabled = value || !session(); input.disabled = value; reset.disabled = value; stop.hidden = !value;
      log.setAttribute('aria-busy', String(value));
    }
    function showReview(proposed) {
      clearReview(); edit = proposed;
      if (!edit.changed.length) return;
      review.hidden = false; review.append(el('strong', '', `Review ${edit.changed.length} changed file${edit.changed.length === 1 ? '' : 's'}`));
      for (const name of edit.changed) {
        const details = el('details'), summary = el('summary', '', name);
        details.append(summary, el('p', 'gemma-small', Object.hasOwn(files, name) ? 'Current' : 'New file'), el('pre', '', files[name] || ''), el('p', 'gemma-small', 'Proposed'), el('pre', '', edit.files[name])); review.append(details);
      }
      const apply = button('Apply changes'), discard = button('Discard'); review.append(apply, discard);
      on(apply, 'click', () => {
        try { files = core.apply(edit, files); clearReview(); renderFiles(); showFile(active); status.textContent = 'Changes applied. Your preview is updating.'; save(); runPreview(); }
        catch (error) { clearReview(); status.textContent = error.message; }
      });
      on(discard, 'click', () => { clearReview(); status.textContent = 'Proposal discarded. Your files are unchanged.'; });
    }
    async function api(path, token, abortSignal, body) {
      const response = await fetch(ORIGIN + path, {method:body ? 'POST' : 'GET', signal:abortSignal, credentials:'omit', cache:'no-store', redirect:'error',
        headers:{'ngrok-skip-browser-warning':'true', Authorization:`Bearer ${token}`, ...(body ? {'Content-Type':'application/json'} : {})}, ...(body ? {body:JSON.stringify(body)} : {})});
      return core.readJSON(response);
    }
    async function ask(event) {
      event.preventDefault(); if (!enabled || request || composing) return;
      const token = session(); if (!token) { accountState(); return; }
      let messages, rawReply = '';
      try { messages = core.messages(input.value, files, history); } catch (error) { status.textContent = error.message; addMessage(error.message, 'error'); return; }
      const prompt = input.value.trim(), base = core.snapshot(files), pending = new AbortController(); request = pending;
      clearReview(); setBusy(true); addMessage(prompt, 'user'); status.textContent = 'Checking REACH model access…';
      try {
        await api('/v1/account', token, pending.signal);
        if (pending.signal.aborted) return;
        const catalog = await api('/v1/models', token, pending.signal);
        const model = catalog?.data?.find(model => model.id === MODEL);
        if (!model) throw new Error('Gemma is not currently available to this account.');
        if (Number.isFinite(model.max_input_bytes) && new TextEncoder().encode(JSON.stringify(messages)).length > model.max_input_bytes) throw new Error('This project is too large for the model’s current context limit. Start over with a smaller website.');
        if (pending.signal.aborted || session() !== token) throw new Error('Your sign-in changed. Please send your request again.');
        status.textContent = 'Gemma is building a proposal…';
        const result = await api('/v1/chat/completions', token, pending.signal, {model:MODEL, messages, stream:false});
        if (!enabled || destroyed || request !== pending || pending.signal.aborted) return;
        if (session() !== token) throw new Error('Your sign-in changed. No files were changed.');
        if (core.snapshot(files) !== base) throw new Error('The website changed during this request. Please try again.');
        rawReply = core.completion(result);
        const proposed = core.proposal(rawReply, files);
        history.push({role:'user',content:prompt},{role:'assistant',content:proposed.message}); if (history.length > 8) history.splice(0,history.length-8);
        addMessage((proposed.changed.length ? 'Changes ready for review. Apply them below to update your preview.' : 'No files changed.') + (proposed.message ? '\n\n' + proposed.message : '')); showReview(proposed); input.value = '';
        status.textContent = proposed.changed.length ? 'Review the proposed files, then apply or discard.' : 'Gemma replied without changing any files.';
      } catch (error) {
        if (request === pending && !pending.signal.aborted) {
          status.textContent = error instanceof TypeError ? 'Could not reach REACH. Check your connection and try again.' : error.message;
          addMessage(status.textContent, 'error');
          if (rawReply) { const details = el('details', 'gemma-raw-reply'); details.append(el('summary', '', 'Read Gemma’s reply'), el('pre', '', rawReply)); log.append(details); }
        }
      } finally {
        if (request === pending) { request = null; setBusy(false); }
      }
    }
    function validStorage(value) { return value && typeof value === 'object' && !Array.isArray(value) && Object.values(value).every(item => typeof item === 'string') && JSON.stringify(value).length <= 262144; }
    function runPreview(entry) {
      if (!enabled) return;
      entry = entry || (/\.html?$/i.test(active) ? active : Object.hasOwn(files, 'index.html') ? 'index.html' : Object.keys(files).find(name => /\.html?$/i.test(name)));
      if (!entry || !core.validPath(entry) || !Object.hasOwn(files, entry)) { previewStatus.textContent = 'Ask Gemma to create an HTML entry page to preview this project.'; return; }
      core.validate(files); frame?.remove(); channel = crypto.randomUUID();
      frame = document.createElement('iframe'); frame.title = 'Your website preview'; frame.setAttribute('sandbox', 'allow-scripts'); frame.referrerPolicy = 'no-referrer';
      frame.setAttribute('allow', "camera 'none'; microphone 'none'; geolocation 'none'; clipboard-read 'none'; clipboard-write 'none'");
      frame.dataset.entry = entry; frame.src = 'assets/workspace-preview.html?v=20261023-edits'; preview.replaceChildren(frame); preview.hidden = false; source.hidden = true; fileTitle.textContent = entry + ' · Preview';
      previewStatus.textContent = 'Loading isolated preview…';
      clearTimeout(previewTimer);
      previewTimer = setTimeout(() => { if (frame) previewStatus.textContent = 'The preview could not start. Try Preview website again.'; }, 10000);
    }
    on(window, 'message', event => {
      if (!enabled || !frame || event.source !== frame.contentWindow || event.origin !== 'null') return;
      if (event.data?.type === 'reach-preview-ready') frame.contentWindow.postMessage({type:'reach-preview-render', files:core.validate(files), entry:frame.dataset.entry, storage:previewStorage, channel}, '*');
      if (event.data?.type === 'reach-preview-status' && event.data.channel === channel && typeof event.data.text === 'string') { clearTimeout(previewTimer); previewStatus.textContent = event.data.text.slice(0,300); }
      if (event.data?.type === 'reach-preview-navigate' && event.data.channel === channel && core.validPath(event.data.path) && Object.hasOwn(files, event.data.path) && /\.html?$/i.test(event.data.path)) runPreview(event.data.path);
      if (event.data?.type === 'reach-preview-storage' && event.data.channel === channel && validStorage(event.data.storage)) { previewStorage = event.data.storage; try { localStorage.setItem('signalreach.website-preview.v1', JSON.stringify(previewStorage)); } catch (_) {} }
    });
    function setEnabled(value) {
      stopRequest(); enabled = value; clearReview(); toggle.setAttribute('aria-checked', String(value)); toggle.textContent = value ? 'Try Gemma · On' : 'Try Gemma';
      workspace.hidden = !value; panel.classList.toggle('gemma-enabled', value);
      original.forEach(([node, hidden]) => { node.hidden = value || hidden; });
      if (pill) pill.textContent = value ? 'Your browser workspace' : oldPill;
      if (caption) caption.textContent = value ? 'LIVE GEMMA · YOUR BROWSER PROJECT' : oldCaption;
      if (hint) { if (value) hint.textContent = 'Ask Gemma to build your idea. Review the generated files, apply, and preview. No uploads.'; else hint.innerHTML = oldHint; }
      if (footer) { if (value) footer.textContent = 'Browser-local project · AI edits only · Isolated website preview'; else footer.innerHTML = oldFooter; }
      if (value) { document.querySelector('[data-preview="workspace"]')?.click(); welcome(); renderFiles(); showFile(active); accountState(true); }
      else { clearTimeout(previewTimer); frame?.remove(); frame = null; }
    }
    on(toggle, 'click', () => setEnabled(!enabled)); on(form, 'submit', ask); on(stop, 'click', () => stopRequest());
    on(input, 'compositionstart', () => { composing = true; }); on(input, 'compositionend', () => { composing = false; });
    on(workspace, 'keydown', event => { if (event.key === 'Escape' && request) { event.preventDefault(); stopRequest(); } });
    on(viewCode, 'click', () => showFile(active)); on(run, 'click', () => runPreview());
    on(reset, 'click', () => { if (!confirm('Replace this browser’s project with the starter?')) return; files = {...core.starter}; previewStorage = {}; try { localStorage.removeItem('signalreach.website-preview.v1'); } catch (_) {} clearReview(); frame?.remove(); frame = null; renderFiles(); showFile(active); welcome(); status.textContent = 'Starter restored.'; save(); });
    on(window, 'focus', () => { if (enabled && !request) accountState(); });
    return () => { destroyed = true; setEnabled(false); lifetime.abort(); workspace.remove(); toggle.remove(); };
  }
  globalThis.SignalREACHWorkspaceUI = Object.freeze({mount});
})();
