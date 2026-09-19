/*
 * SignalR.E.A.C.H pages — Settings renderer.
 * Registers window.__reachPageRegistry.settings.
 * Depends on window.__reachCore (reach-core.js) and
 * window.__reachPageWidgets (pages-common.js).
 */
(function initReachPageSettings() {
    'use strict';

    const core = window.__reachCore;
    if (!core) {
        console.error('[signal-reach] reach-core.js missing — re-run install.');
        return;
    }
    const { el, esc, toast } = core;
    const { pageHeader, emptyNote, publishNow, copyText } =
        window.__reachPageWidgets;

    /* -------------------------------------------------------------- SETTINGS */
    function renderSettings(container) {
        container.appendChild(pageHeader('fa-sliders', 'Settings',
            'Everything about the endpoint: relay, request policy, per-model '
            + 'tuning, rate limits, access, caching, observability, hosting.'));
        const body = el('div', 'reach-stack');
        container.appendChild(body);
        const saveBar = el('div', 'reach-save-bar');
        const saveBtn = el('button', 'reach-btn reach-btn-primary', 'Save settings');
        const dirtyNote = el('span', 'reach-hint', '');
        saveBar.appendChild(saveBtn);
        saveBar.appendChild(dirtyNote);
        const exportBtn = el('button', 'reach-btn reach-btn-sm', 'Export');
        const importBtn = el('button', 'reach-btn reach-btn-sm', 'Import');
        const importInput = document.createElement('input');
        importInput.type = 'file';
        importInput.accept = '.json,application/json';
        importInput.style.display = 'none';
        const resetBtn = el('button', 'reach-btn reach-btn-danger reach-btn-sm', 'Reset defaults');
        saveBar.appendChild(exportBtn);
        saveBar.appendChild(importBtn);
        saveBar.appendChild(importInput);
        saveBar.appendChild(resetBtn);
        container.appendChild(saveBar);
        let draft = null;   // deep copy of the loaded settings (masked keys kept)

        function markDirty(dirty) {
            core.store.dirty = dirty;
            dirtyNote.textContent = dirty ? 'unsaved changes' : 'all changes saved';
            saveBtn.disabled = !dirty;
        }

        // ---- generic field builders (section/key paths) ----
        function fieldGet(section, key) {
            return section ? draft[section][key] : draft[key];
        }

        function fieldSet(section, key, value) {
            if (section) draft[section][key] = value;
            else draft[key] = value;
            markDirty(true);
        }

        function buildInput(kind, section, key, label, help, opts) {
            const wrap = el('label', 'reach-field');
            wrap.appendChild(el('span', 'reach-field-label', label));
            let node;
            if (kind === 'select') {
                node = document.createElement('select');
                (opts || []).forEach(opt => {
                    const o = document.createElement('option');
                    o.value = opt.value;
                    o.textContent = opt.label;
                    if (String(fieldGet(section, key)) === String(opt.value)) o.selected = true;
                    node.appendChild(o);
                });
                node.addEventListener('change', () => fieldSet(section, key,
                    node.value === '__null__' ? null : node.value));
            } else if (kind === 'textarea') {
                node = document.createElement('textarea');
                node.rows = 3;
                node.value = fieldGet(section, key) || '';
                node.addEventListener('input', () => fieldSet(section, key, node.value));
            } else {
                node = document.createElement('input');
                if (kind === 'checkbox') {
                    node.type = 'checkbox';
                    node.checked = !!fieldGet(section, key);
                    node.addEventListener('change', () => fieldSet(section, key, node.checked));
                } else if (kind === 'number') {
                    node.type = 'number';
                    node.step = (opts && opts.step) || 1;
                    node.value = fieldGet(section, key);
                    node.addEventListener('input', () => fieldSet(section, key,
                        node.step === 'any' || String(node.step).includes('.')
                            ? parseFloat(node.value) || 0 : parseInt(node.value, 10) || 0));
                } else if (kind === 'password') {
                    node.type = 'password';
                    node.placeholder = fieldGet(section, key) ? '•••••••• (unchanged)' : 'not set';
                    node.addEventListener('input', () => {
                        if (node.value.trim()) fieldSet(section, key, node.value.trim());
                    });
                } else if (kind === 'csv') {
                    node.type = 'text';
                    node.value = (fieldGet(section, key) || []).join(', ');
                    node.placeholder = 'comma-separated, e.g. 1.2.3.4, 5.6.7.8';
                    node.addEventListener('input', () => fieldSet(section, key,
                        node.value.split(',').map(s => s.trim()).filter(Boolean)));
                } else {
                    node.type = 'text';
                    node.value = fieldGet(section, key) == null ? '' : fieldGet(section, key);
                    node.addEventListener('input', () => {
                        const raw = node.value.trim();
                        fieldSet(section, key, raw === '' && (opts && opts.nullable) ? null : raw);
                    });
                }
            }
            node.className = 'reach-input';
            wrap.appendChild(node);
            if (help) wrap.appendChild(el('span', 'reach-field-help', help));
            return wrap;
        }

        function section(title, icon, hint) {
            const card = el('section', 'reach-card');
            const head = el('header', 'reach-card-head');
            const h2 = el('h2', null, title);
            if (icon) {
                const i = el('i', 'fa-solid ' + icon);
                i.style.width = '18px';
                head.appendChild(i);
            }
            head.appendChild(h2);
            card.appendChild(head);
            if (hint) card.appendChild(el('p', 'reach-copy', hint));
            const grid = el('div', 'reach-form-grid');
            card.appendChild(grid);
            body.appendChild(card);
            return grid;
        }

        function pick(label, key, options, help, nullableLabel) {
            const opts = [{ value: '__null__', label: nullableLabel || '—' }]
                .concat(options.map(v => ({ value: v, label: v })));
            return buildInput('select', null, key, label, help, opts);
        }

        // ---- per-model editor ----
        function modelEditor(alias) {
            const spec = draft.models[alias] || {};
            const card = el('section', 'reach-card reach-model-card');
            card.id = 'reach-model-' + alias;
            const head = el('header', 'reach-card-head');
            const titleWrap = el('div', 'reach-model-head');
            titleWrap.appendChild(el('strong', null, alias));
            if (spec.description) {
                titleWrap.appendChild(el('span', 'reach-model-desc', spec.description));
            }
            head.appendChild(titleWrap);
            const controls = el('div', 'reach-model-controls');
            const pubToggle = el('label', 'reach-switch');
            const pubInput = document.createElement('input');
            pubInput.type = 'checkbox';
            pubInput.checked = !!spec.public;
            pubInput.title = 'Public (listed + callable externally)';
            pubInput.addEventListener('change', () => { spec.public = pubInput.checked; markDirty(true); });
            const pubSlider = el('span', 'reach-switch-slider');
            pubToggle.appendChild(pubInput);
            pubToggle.appendChild(pubSlider);
            controls.appendChild(pubToggle);
            const enToggle = el('label', 'reach-switch');
            const enInput = document.createElement('input');
            enInput.type = 'checkbox';
            enInput.checked = !!spec.enabled;
            enInput.title = 'Enabled';
            enInput.addEventListener('change', () => { spec.enabled = enInput.checked; markDirty(true); });
            const enSlider = el('span', 'reach-switch-slider');
            enToggle.appendChild(enInput);
            enToggle.appendChild(enSlider);
            controls.appendChild(enToggle);
            const rm = el('button', 'reach-btn reach-btn-danger reach-btn-sm', 'Remove');
            rm.addEventListener('click', () => {
                if (Object.keys(draft.models).length <= 1) { toast('Keep at least one alias', 'error'); return; }
                delete draft.models[alias];
                markDirty(true);
                draw();
            });
            controls.appendChild(rm);
            head.appendChild(controls);
            card.appendChild(head);

            const grid = el('div', 'reach-form-grid');
            const mf = (kind, key, label, help, opts) => {
                const wrap = el('label', 'reach-field');
                wrap.appendChild(el('span', 'reach-field-label', label));
                let node;
                if (kind === 'select') {
                    node = document.createElement('select');
                    opts.forEach(opt => {
                        const o = document.createElement('option');
                        o.value = opt.value;
                        o.textContent = opt.label;
                        if (String(spec[key] == null ? '__null__' : spec[key]) === String(opt.value)) o.selected = true;
                        node.appendChild(o);
                    });
                    node.addEventListener('change', () => {
                        spec[key] = node.value === '__null__' ? null : node.value;
                        markDirty(true);
                    });
                } else if (kind === 'textarea') {
                    node = document.createElement('textarea');
                    node.rows = 2;
                    node.value = spec[key] || '';
                    node.addEventListener('input', () => { spec[key] = node.value; markDirty(true); });
                } else if (kind === 'checkbox') {
                    node = document.createElement('input');
                    node.type = 'checkbox';
                    node.checked = !!spec[key];
                    node.addEventListener('change', () => { spec[key] = node.checked; markDirty(true); });
                } else {
                    node = document.createElement('input');
                    if (kind === 'number') {
                        node.type = 'number';
                        node.step = (opts && opts.step) || 1;
                        node.value = spec[key] == null ? '' : spec[key];
                        node.addEventListener('input', () => {
                            const parsed = node.step === 'any' ? parseFloat(node.value)
                                : parseInt(node.value, 10);
                            spec[key] = isNaN(parsed) ? null : parsed;
                            markDirty(true);
                        });
                    } else {
                        node.type = 'text';
                        node.value = spec[key] == null ? '' : spec[key];
                        node.addEventListener('input', () => {
                            const raw = node.value.trim();
                            spec[key] = raw === '' ? null : raw;
                            markDirty(true);
                        });
                    }
                }
                node.className = 'reach-input';
                wrap.appendChild(node);
                if (help) wrap.appendChild(el('span', 'reach-field-help', help));
                return wrap;
            };
            const aliases = Object.keys(draft.models);
            grid.appendChild(mf('text', 'upstream', 'Upstream model id'));
            grid.appendChild(mf('text', 'description', 'Description'));
            // NOTE: mf signature is (kind, key, label, help, opts) — the
            // options array is the FIFTH arg. Passing it fourth made
            // opts.forEach crash on a string and took down the whole
            // Settings page for any install with model aliases.
            grid.appendChild(mf('select', 'fallback', 'Fallback alias',
                'Tried when the upstream fails (non-stream).', [
                { value: '__null__', label: 'none' },
                ...aliases.filter(a => a !== alias).map(a => ({ value: a, label: a }))
            ]));
            grid.appendChild(mf('number', 'context_window', 'Context window'));
            grid.appendChild(mf('checkbox', 'strip_trailing_roles', 'Strip trailing role turns',
                'Truncates fake "User:"/"Assistant:" transcript continuations some upstream routes leak.'));
            grid.appendChild(mf('number', 'temperature', 'Default temperature', 'null = passthrough (client controls it).', { step: 'any' }));
            grid.appendChild(mf('number', 'temperature_min', 'Temperature min', 'Clamp window.', { step: 'any' }));
            grid.appendChild(mf('number', 'temperature_max', 'Temperature max', 'Clamp window.', { step: 'any' }));
            grid.appendChild(mf('number', 'max_tokens', 'Default max tokens', 'null = passthrough.'));
            grid.appendChild(mf('number', 'max_tokens_cap', 'Max tokens cap', 'Hard cap on requests (0 = off).'));
            grid.appendChild(mf('textarea', 'system_prompt', 'Injected system prompt', 'Prepended to every request for this alias.'));
            const rlWrap = el('div', 'reach-form-grid reach-model-rl');
            const rpmField = el('label', 'reach-field');
            rpmField.appendChild(el('span', 'reach-field-label', 'Per-model RPM'));
            const rpmInput = document.createElement('input');
            rpmInput.type = 'number';
            rpmInput.className = 'reach-input';
            rpmInput.value = (spec.rate_limits || {}).rpm || 0;
            rpmInput.addEventListener('input', () => {
                spec.rate_limits = spec.rate_limits || { rpm: 0, tokens_day: 0 };
                spec.rate_limits.rpm = parseInt(rpmInput.value, 10) || 0;
                markDirty(true);
            });
            rpmField.appendChild(rpmInput);
            rpmField.appendChild(el('span', 'reach-field-help', '0 = inherit global.'));
            rlWrap.appendChild(rpmField);
            const tdField = el('label', 'reach-field');
            tdField.appendChild(el('span', 'reach-field-label', 'Per-model tokens/day'));
            const tdInput = document.createElement('input');
            tdInput.type = 'number';
            tdInput.className = 'reach-input';
            tdInput.value = (spec.rate_limits || {}).tokens_day || 0;
            tdInput.addEventListener('input', () => {
                spec.rate_limits = spec.rate_limits || { rpm: 0, tokens_day: 0 };
                spec.rate_limits.tokens_day = parseInt(tdInput.value, 10) || 0;
                markDirty(true);
            });
            tdField.appendChild(tdInput);
            tdField.appendChild(el('span', 'reach-field-help', '0 = inherit global.'));
            rlWrap.appendChild(tdField);
            grid.appendChild(rlWrap);
            const toggles = el('div', 'reach-toggle-row');
            const stT = el('label', 'reach-check');
            const stI = document.createElement('input');
            stI.type = 'checkbox';
            stI.checked = !!spec.allow_stream;
            stI.addEventListener('change', () => { spec.allow_stream = stI.checked; markDirty(true); });
            stT.appendChild(stI);
            stT.appendChild(document.createTextNode(' Streaming'));
            const tlT = el('label', 'reach-check');
            const tlI = document.createElement('input');
            tlI.type = 'checkbox';
            tlI.checked = !!spec.allow_tools;
            tlI.addEventListener('change', () => { spec.allow_tools = tlI.checked; markDirty(true); });
            tlT.appendChild(tlI);
            tlT.appendChild(document.createTextNode(' Tool calls'));
            toggles.appendChild(stT);
            toggles.appendChild(tlT);
            grid.appendChild(toggles);
            card.appendChild(grid);
            body.appendChild(card);
        }

        function showNewKeyModal(keyObj) {
            const overlay = el('div', 'reach-modal-overlay');
            const dialog = el('div', 'reach-modal-dialog');
            dialog.innerHTML = '<header class="reach-card-head">'
                + '<h3 style="margin:0;font-size:15px;display:flex;align-items:center;gap:8px;">'
                + '<i class="fa-solid fa-key" style="color:var(--reach-accent-light, #ffd37a);"></i>'
                + '<span>Client API Key Generated</span>'
                + '</h3>'
                + '</header>'
                + '<div class="reach-card-body" style="padding:16px;">'
                + '<p class="reach-copy" style="margin-top:0;">Key Name: <strong>' + esc(keyObj.name || 'Client') + '</strong> &nbsp;·&nbsp; ID: <code>' + esc(keyObj.id || '') + '</code></p>'
                + '<div style="background:rgba(255, 176, 32, 0.12);border:1px solid rgba(255, 176, 32, 0.35);padding:10px 12px;border-radius:8px;margin-bottom:12px;">'
                + '<p class="reach-copy" style="margin:0;font-size:12px;color:var(--reach-accent-light, #ffd37a);font-weight:600;">'
                + '<i class="fa-solid fa-triangle-exclamation" style="margin-right:6px;"></i>Please copy and store this key now. You will not be able to view the full token again!'
                + '</p>'
                + '</div>'
                + '<div class="reach-url-row" style="margin:12px 0;">'
                + '<code class="reach-url" id="new-client-token" style="word-break:break-all;font-size:13px;user-select:all;">' + esc(keyObj.key || '') + '</code>'
                + '</div>'
                + '<p class="reach-hint" style="margin-bottom:0;">Use in clients via <code>Authorization: Bearer ' + esc(keyObj.key ? keyObj.key.slice(0, 14) + '…' : '') + '</code> or <code>X-Reach-Key</code>.</p>'
                + '</div>';
            const foot = el('div', 'reach-card-foot');
            const copyBtn = el('button', 'reach-btn reach-btn-primary reach-btn-sm');
            copyBtn.innerHTML = '<i class="fa-regular fa-copy"></i> Copy Key';
            copyBtn.addEventListener('click', () => {
                copyText(keyObj.key).then(ok => toast(ok ? 'Key copied to clipboard ✓' : 'Copy failed', ok ? 'ok' : 'error'));
            });
            const closeBtn = el('button', 'reach-btn reach-btn-sm', 'Done');
            closeBtn.addEventListener('click', () => {
                overlay.remove();
            });
            foot.appendChild(copyBtn);
            foot.appendChild(closeBtn);
            dialog.appendChild(foot);
            overlay.appendChild(dialog);
            document.body.appendChild(overlay);
        }

        // One-click onboarding for a machine that is NOT this one. It mints a
        // named client key, turns on access-key enforcement, and prints the
        // ready-to-paste Base URL + key. Nothing account-bound ever leaves this
        // host: the remote client only receives an address and a random token.
        function showRemoteClientModal(info) {
            const overlay = el('div', 'reach-modal-overlay');
            const dialog = el('div', 'reach-modal-dialog');
            const snippet =
                'Base URL:  ' + info.baseUrl + '\n'
                + 'API key:   ' + info.key + '\n'
                + 'Model:     ' + info.model + '\n';
            dialog.innerHTML = '<header class="reach-card-head">'
                + '<h3 style="margin:0;font-size:15px;display:flex;align-items:center;gap:8px;">'
                + '<i class="fa-solid fa-laptop-code" style="color:var(--reach-accent-light, #ffd37a);"></i>'
                + '<span>Remote Client Ready</span>'
                + '</h3>'
                + '</header>'
                + '<div class="reach-card-body" style="padding:16px;">'
                + '<p class="reach-copy" style="margin-top:0;">Give these three lines to <strong>' + esc(info.name || 'the client') + '</strong>. They reach only the models you marked public — never your CodeGPT session, your Google sign-in, or your OmniRoute key.</p>'
                + '<div style="background:rgba(255, 176, 32, 0.12);border:1px solid rgba(255, 176, 32, 0.35);padding:10px 12px;border-radius:8px;margin-bottom:12px;">'
                + '<p class="reach-copy" style="margin:0;font-size:12px;color:var(--reach-accent-light, #ffd37a);font-weight:600;">'
                + '<i class="fa-solid fa-triangle-exclamation" style="margin-right:6px;"></i>Save the key now — it is not shown again. Revoke it any time from the key list.'
                + '</p>'
                + '</div>'
                + '<pre class="reach-url" id="remote-client-snippet" style="white-space:pre-wrap;word-break:break-all;font-size:12.5px;user-select:all;margin:12px 0;">' + esc(snippet) + '</pre>'
                + '<p class="reach-hint" style="margin-bottom:0;">Any OpenAI-compatible client works (Cursor, LibreChat, Postman, the VS Code extension). Streaming is supported.</p>'
                + '</div>';
            const foot = el('div', 'reach-card-foot');
            const copyBtn = el('button', 'reach-btn reach-btn-primary reach-btn-sm');
            copyBtn.innerHTML = '<i class="fa-regular fa-copy"></i> Copy All';
            copyBtn.addEventListener('click', () => {
                copyText(snippet).then(ok => toast(ok ? 'Client details copied ✓' : 'Copy failed', ok ? 'ok' : 'error'));
            });
            // Revoke straight from here, so a key handed out by mistake can be
            // killed without hunting for it in the list. Deletes server-side via
            // DELETE /_reach/keys/<id>, then refreshes the list. The modal stays
            // open showing the (now dead) details until dismissed.
            const revokeBtn = el('button', 'reach-btn reach-btn-sm');
            revokeBtn.innerHTML = '<i class="fa-solid fa-ban"></i> Revoke Key';
            if (!info.id) revokeBtn.disabled = true;
            revokeBtn.addEventListener('click', () => {
                if (!info.id) return;
                if (!confirm('Revoke this client key? \"' + (info.name || 'Remote PC') + '\" will lose access immediately.')) return;
                revokeBtn.disabled = true;
                core.relayFetch('/_reach/keys/' + encodeURIComponent(info.id), { method: 'DELETE' })
                    .then(res => res.json().then(data => ({ ok: res.ok, data })))
                    .then(({ ok, data }) => {
                        if (!ok) throw new Error((data && data.error && data.error.message) || 'revoke failed');
                        revokeBtn.innerHTML = '<i class="fa-solid fa-check"></i> Revoked';
                        toast('Client key revoked ✓', 'ok');
                        if (info.onRevoked) info.onRevoked();
                    })
                    .catch(err => { revokeBtn.disabled = false; toast('Error: ' + err.message, 'error'); });
            });
            const closeBtn = el('button', 'reach-btn reach-btn-sm', 'Done');
            closeBtn.addEventListener('click', () => overlay.remove());
            foot.appendChild(copyBtn);
            foot.appendChild(revokeBtn);
            foot.appendChild(closeBtn);
            dialog.appendChild(foot);
            overlay.appendChild(dialog);
            document.body.appendChild(overlay);
        }

        // The one-click "Remote Client" flow. Resolves the reachable Base URL
        // (pinned override, live tunnel, or loopback), mints a key server-side,
        // and turns on key_required so that token is the only way in.
        //
        // The keys list is deliberately NOT patched back: /_reach/keys already
        // persisted the new key, and GET masks existing tokens, so echoing the
        // array would overwrite real keys with masked placeholders.
        function addRemoteClient(btn, nameInput, firstModel, rerender) {
            const name = (nameInput && nameInput.value.trim()) || 'Remote PC';
            const snap = core.store.local || {};
            const base = (draft.public_url_override || snap.public_url || '').trim()
                || ('http://' + (core.store.host || '127.0.0.1') + ':' + (draft.port || 20777));
            const baseUrl = base.replace(/\/+$/, '') + '/v1';
            btn.disabled = true;
            core.relayFetch('/_reach/keys', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: name })
            })
                .then(res => res.json().then(data => ({ ok: res.ok, data })))
                .then(({ ok, data }) => {
                    if (!ok || !data.created || !data.key) {
                        throw new Error((data && data.error && data.error.message) || 'could not create key');
                    }
                    draft.access = draft.access || {};
                    // Enforce the key so the freshly minted token is required.
                    // The key list is NOT echoed back: /_reach/keys already saved
                    // it, and GET masks existing tokens — re-patching would
                    // overwrite real keys with masked placeholders.
                    draft.access.key_required = true;
                    draft.access.cors_origins = draft.access.cors_origins || '*';
                    if (rerender) rerender();
                    const patch = { access: { key_required: true, cors_origins: draft.access.cors_origins || '*' } };
                    return core.saveSettings(patch).then(({ ok: saved, data: sdata }) => {
                        if (!saved) {
                            throw new Error((sdata && sdata.error && sdata.error.message) || 'settings save failed');
                        }
                        markDirty(false);
                        if (nameInput) nameInput.value = '';
                        showRemoteClientModal({
                            name: name,
                            id: (data.key && data.key.id) || '',
                            baseUrl: baseUrl,
                            key: (data.key && data.key) || '',
                            model: firstModel || 'gpt-4o',
                            onRevoked: () => { if (rerender) rerender(); }
                        });
                        toast('Remote client ready ✓', 'ok');
                    });
                })
                .catch(err => toast('Error: ' + err.message, 'error'))
                .finally(() => { btn.disabled = false; });
        }

        function draw() {
            body.innerHTML = '';
            if (!draft) {
                body.appendChild(emptyNote(core.store.local && core.store.local.connection_mode === 'hosted'
                    ? 'SignalREACH is connected. Hosting settings are managed on the SignalREACH host.'
                    : 'Relay offline — settings cannot be loaded.'));
                saveBtn.disabled = true;
                return;
            }
            const modelAliases = Object.keys(draft.models);

            // 1. Relay
            const relay = section('Relay', 'fa-server', 'Core listener + upstream connection.');
            relay.appendChild(buildInput('number', null, 'port', 'Port', 'Applies on relay restart.'));
            relay.appendChild(buildInput('select', null, 'host', 'Bind host',
                'Keep 127.0.0.1 — the tunnel handles public traffic.',
                [{ value: '127.0.0.1', label: '127.0.0.1' },
                 { value: 'localhost', label: 'localhost' },
                 { value: '0.0.0.0', label: '0.0.0.0 (all interfaces)' }]));
            relay.appendChild(buildInput('text', null, 'omniroute_url', 'OmniRoute URL'));
            relay.appendChild(buildInput('password', null, 'omniroute_key', 'OmniRoute API key',
                'Blank keeps the current key.'));
            relay.appendChild(buildInput('number', null, 'upstream_timeout_s', 'Upstream timeout (s)', '10–3600.'));
            relay.appendChild(buildInput('number', null, 'stream_timeout_s', 'Stream timeout (s)', 'Hung keepalive streams free their slot after this.'));
            relay.appendChild(buildInput('number', null, 'max_concurrency', 'Max concurrent upstream calls', '1–64.'));
            relay.appendChild(buildInput('number', null, 'health_check_interval_s', 'Health check interval (s)', 'How often the upstream is probed.'));

            // 2. Upstream & failover
            const up = section('Upstream & failover', 'fa-shield-halved', 'Retry, circuit breaker, and fallback behavior.');
            up.appendChild(buildInput('number', null, 'upstream_retries', 'Upstream retries', 'Extra attempts on 5xx/unreachable (non-stream).'));
            up.appendChild(buildInput('number', null, 'retry_delay_ms', 'Retry delay (ms)'));
            up.appendChild(buildInput('number', null, 'circuit_threshold', 'Circuit threshold', 'Consecutive failures before cool-down.'));
            up.appendChild(buildInput('number', null, 'circuit_cooldown_s', 'Circuit cool-down (s)'));

            // 3. Request handling
            const rq = section('Request handling', 'fa-arrow-right-to-bracket', 'Every chat request passes through this policy before the upstream.');
            rq.appendChild(buildInput('select', 'request', 'default_model', 'Default model',
                'Used when a client omits model.',
                modelAliases.map(a => ({ value: a, label: a }))));
            rq.appendChild(buildInput('checkbox', 'request', 'default_stream', 'Stream by default',
                'When the client omits the stream flag.'));
            rq.appendChild(buildInput('number', 'request', 'max_messages', 'Max messages'));
            rq.appendChild(buildInput('number', 'request', 'max_input_chars', 'Max input chars'));
            rq.appendChild(buildInput('number', 'request', 'max_tokens_cap', 'Global max-tokens cap', '0 = off; per-model caps apply too.'));
            rq.appendChild(buildInput('number', 'request', 'temperature_min', 'Temperature min', null, { step: 'any' }));
            rq.appendChild(buildInput('number', 'request', 'temperature_max', 'Temperature max', null, { step: 'any' }));
            rq.appendChild(buildInput('textarea', 'request', 'inject_system_prompt',
                'Global system prompt', 'Prepended to every request (model prompt wins).'));
            rq.appendChild(buildInput('checkbox', 'request', 'allow_tools', 'Allow tool calls',
                'Strips tools/tool_choice when off.'));
            rq.appendChild(buildInput('checkbox', 'request', 'allow_response_format', 'Allow response_format (JSON mode)'));
            rq.appendChild(buildInput('checkbox', 'request', 'allow_logprobs', 'Allow logprobs'));
            rq.appendChild(buildInput('csv', 'request', 'blocked_fields', 'Blocked fields',
                'Request fields to reject or strip (e.g. seed, stop, logit_bias).'));
            rq.appendChild(buildInput('checkbox', 'request', 'reject_blocked', 'Reject blocked fields (400)',
                'Off = silently strip them; on = refuse the request.'));

            // 4. Models
            const mo = section('Models', 'fa-cubes',
                'Per-alias tuning. The Models page links here for editing.');
            modelAliases.sort().forEach(modelEditor);
            const addCard = el('section', 'reach-card');
            addCard.appendChild(el('header', 'reach-card-head', 'Add alias'));
            const form = el('form', 'reach-form');
            form.addEventListener('submit', e => {
                e.preventDefault();
                const alias = aliasInput.value.trim();
                const upstream = upstreamInput.value.trim();
                if (!alias || !upstream) { toast('Both fields are required', 'error'); return; }
                if (draft.models[alias]) { toast('Alias already exists', 'error'); return; }
                const template = Object.values(draft.models)[0] || {};
                draft.models[alias] = Object.assign({}, template,
                    { upstream: upstream, description: '', temperature: null, max_tokens: null,
                      fallback: null, system_prompt: '', rate_limits: { rpm: 0, tokens_day: 0 } });
                markDirty(true);
                draw();
            });
            const row = el('div', 'reach-form-row');
            const aliasInput = document.createElement('input');
            aliasInput.placeholder = 'alias (e.g. gpt-4o-mini)';
            aliasInput.className = 'reach-input';
            const upstreamInput = document.createElement('input');
            upstreamInput.placeholder = 'upstream (e.g. codegpt/codegpt-gpt-4o-mini, or bridge/codegpt-eco-ox-alpha)';
            upstreamInput.className = 'reach-input';
            row.appendChild(aliasInput);
            row.appendChild(upstreamInput);
            const submit = el('button', 'reach-btn reach-btn-primary reach-btn-sm', 'Add');
            submit.type = 'submit';
            row.appendChild(submit);
            form.appendChild(row);
            addCard.appendChild(form);
            body.appendChild(addCard);
            mo.appendChild(addCard);

            // 5. Rate limits
            const rl = section('Rate limits', 'fa-gauge', 'Fair-use guards for the free upstream.');
            rl.appendChild(buildInput('checkbox', 'rate_limits', 'enabled', 'Enable rate limiting'));
            rl.appendChild(buildInput('number', 'rate_limits', 'per_ip_rpm', 'Per-IP requests / minute'));
            rl.appendChild(buildInput('number', 'rate_limits', 'per_ip_tokens_day', 'Per-IP tokens / day', '0 disables.'));
            rl.appendChild(buildInput('number', 'rate_limits', 'global_rpm', 'Global requests / minute'));
            rl.appendChild(buildInput('number', 'rate_limits', 'global_tokens_day', 'Global tokens / day', '0 disables.'));
            rl.appendChild(buildInput('number', 'rate_limits', 'burst', 'Burst allowance'));
            rl.appendChild(buildInput('number', 'rate_limits', 'max_prompt_tokens', 'Max prompt tokens', 'Reject oversized prompts (0 = off).'));

            // 6. Access & security
            const ac = section('Access & security', 'fa-key', 'Who may call the endpoint and from where.');
            ac.appendChild(buildInput('checkbox', 'access', 'key_required', 'Require access key',
                'Clients send X-Reach-Key (or Bearer). Turn this off only if you want anyone with the URL to use the relay.'));
            ac.appendChild(buildInput('checkbox', 'access', 'local_bypass', 'Local tools skip the key',
                'Tools on this machine (panel, VS Code, Studio) need no key. Turn off if a reverse proxy that adds no X-Forwarded-For sits in front of the relay.'));
            ac.appendChild(buildInput('password', 'access', 'access_key', 'Access key',
                'Blank keeps the current key; min 6 chars when required.'));
            ac.appendChild(buildInput('csv', 'access', 'ip_allowlist', 'IP allowlist',
                'Empty = everyone. Addresses or CIDR ranges. Genuine local clients are always allowed.'));
            ac.appendChild(buildInput('csv', 'access', 'ip_blocklist', 'IP blocklist'));
            ac.appendChild(buildInput('csv', 'access', 'trusted_proxies', 'Trusted proxies',
                'Reverse-proxy addresses whose X-Forwarded-For is believed. The local tunnel is always trusted; leave empty otherwise.'));
            ac.appendChild(buildInput('number', 'access', 'auth_fail_limit', 'Failed attempts before lockout',
                'Per client IP, for wrong keys and admin tokens. 0 disables the lockout.'));
            ac.appendChild(buildInput('number', 'access', 'auth_lockout_s', 'Lockout length (seconds)'));
            ac.appendChild(buildInput('text', 'access', 'cors_origins', 'CORS origins',
                '"*" or comma-separated origins.'));

            // 6b. Client API Keys (sk-reach)
            const keysCard = el('section', 'reach-card');
            const kHead = el('header', 'reach-card-head');
            kHead.innerHTML = '<div style="display:flex;align-items:center;gap:8px;">'
                + '<i class="fa-solid fa-id-card-clip" style="color:var(--reach-accent-light, #ffd37a);"></i>'
                + '<span>Client API Keys (sk-reach)</span>'
                + '</div>';
            keysCard.appendChild(kHead);
            keysCard.appendChild(el('p', 'reach-copy',
                'Generate standardized sk-reach tokens for external tools (Postman, Cursor, LibreChat, teammates). SignalR.E.A.C.H authenticates external clients using these keys while securely routing upstream on the fly without revealing your OmniRoute credentials.'));

            const keysBody = el('div', 'reach-card-body');
            keysCard.appendChild(keysBody);

            const keysList = el('div', 'reach-keys-list');
            keysBody.appendChild(keysList);

            function renderKeysList() {
                keysList.innerHTML = '';
                const keys = (draft.access && draft.access.keys) || [];
                if (!keys.length) {
                    keysList.appendChild(emptyNote('No client API keys generated yet. Create one below.'));
                } else {
                    const table = el('table', 'reach-table');
                    table.innerHTML = '<thead><tr><th>Name</th><th>Key ID</th><th>Token</th><th>Status</th><th>Last Used</th><th>Actions</th></tr></thead>';
                    const tbody = document.createElement('tbody');
                    keys.forEach((k, idx) => {
                        const tr = document.createElement('tr');
                        const tdName = el('td', null);
                        tdName.appendChild(el('strong', null, k.name || 'Client'));

                        const tdId = el('td', null);
                        tdId.appendChild(el('code', 'reach-code-sm', k.id || '—'));

                        const tdToken = el('td', null);
                        const tokDisplay = k.preview || k.masked_key || (k.key ? (k.key.length > 18 ? k.key.slice(0, 14) + '…' : k.key) : '—');
                        tdToken.appendChild(el('code', 'reach-code-sm', tokDisplay));

                        const tdStatus = el('td', null);
                        const enToggle = el('label', 'reach-switch');
                        const enInput = document.createElement('input');
                        enInput.type = 'checkbox';
                        enInput.checked = k.enabled !== false;
                        enInput.title = enInput.checked ? 'Enabled' : 'Disabled';
                        enInput.addEventListener('change', () => {
                            k.enabled = enInput.checked;
                            markDirty(true);
                            renderKeysList();
                        });
                        const enSlider = el('span', 'reach-switch-slider');
                        enToggle.appendChild(enInput);
                        enToggle.appendChild(enSlider);
                        tdStatus.appendChild(enToggle);

                        const tdUsed = el('td', 'reach-hint', (k.last_used_at ? k.last_used_at.slice(0, 10) : 'never'));

                        const tdActions = el('td', null);
                        const actWrap = el('div', 'reach-actions-row');

                        const copyBtn = el('button', 'reach-btn reach-btn-sm', 'Copy');
                        copyBtn.type = 'button';
                        copyBtn.title = 'Copy token';
                        copyBtn.addEventListener('click', () => {
                            if (k.key && !k.key.includes('…') && !k.key.startsWith('set (')) {
                                copyText(k.key).then(ok => toast(ok ? 'Key copied ✓' : 'Copy failed', ok ? 'ok' : 'error'));
                            } else {
                                toast('Full secret key is hidden for security. Create a new key if lost.', 'warn');
                            }
                        });
                        actWrap.appendChild(copyBtn);

                        const delBtn = el('button', 'reach-btn reach-btn-danger reach-btn-sm', 'Revoke');
                        delBtn.type = 'button';
                        delBtn.title = 'Revoke client key';
                        delBtn.addEventListener('click', () => {
                            if (confirm('Revoke client key "' + (k.name || k.id) + '"? Calls with this key will fail.')) {
                                draft.access.keys.splice(idx, 1);
                                markDirty(true);
                                renderKeysList();
                                toast('Key revoked (click "Save settings" to commit)', 'ok');
                            }
                        });
                        actWrap.appendChild(delBtn);
                        tdActions.appendChild(actWrap);

                        tr.appendChild(tdName);
                        tr.appendChild(tdId);
                        tr.appendChild(tdToken);
                        tr.appendChild(tdStatus);
                        tr.appendChild(tdUsed);
                        tr.appendChild(tdActions);
                        tbody.appendChild(tr);
                    });
                    table.appendChild(tbody);
                    keysList.appendChild(table);
                }
            }

            renderKeysList();

            const newKeyBar = el('div', 'reach-card-foot');
            const keyNameInput = document.createElement('input');
            keyNameInput.className = 'reach-input reach-input-sm';
            keyNameInput.placeholder = 'Key name (e.g. WhiteShadow, Cursor, Postman)';
            keyNameInput.style.maxWidth = '280px';

            const createKeyBtn = el('button', 'reach-btn reach-btn-primary reach-btn-sm');
            createKeyBtn.innerHTML = '<i class="fa-solid fa-plus"></i> Generate Client Key';
            createKeyBtn.type = 'button';
            createKeyBtn.addEventListener('click', () => {
                const name = keyNameInput.value.trim() || 'Client';
                createKeyBtn.disabled = true;
                core.relayFetch('/_reach/keys', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ name: name })
                })
                    .then(res => res.json().then(data => ({ ok: res.ok, data })))
                    .then(({ ok, data }) => {
                        if (ok && data.created && data.key) {
                            keyNameInput.value = '';
                            draft.access = draft.access || {};
                            draft.access.keys = draft.access.keys || [];
                            draft.access.keys.push(data.key);
                            renderKeysList();
                            showNewKeyModal(data.key);
                            toast('Client key generated ✓', 'ok');
                        } else {
                            toast('Failed to create key: ' + ((data && data.error && data.error.message) || 'unknown error'), 'error');
                        }
                    })
                    .catch(err => toast('Error: ' + err.message, 'error'))
                    .finally(() => { createKeyBtn.disabled = false; });
            });

            newKeyBar.appendChild(keyNameInput);
            newKeyBar.appendChild(createKeyBtn);
            const remoteBtn = el('button', 'reach-btn reach-btn-sm');
            remoteBtn.innerHTML = '<i class="fa-solid fa-share-nodes"></i> Add Remote Client';
            remoteBtn.type = 'button';
            remoteBtn.title = 'Mint a key, require it, and show the paste-ready Base URL for another PC.';
            remoteBtn.addEventListener('click', () => {
                const firstPublic = Object.keys(draft.models || {}).find(
                    alias => draft.models[alias] && draft.models[alias].enabled
                        && draft.models[alias].public !== false) || 'gpt-4o';
                addRemoteClient(remoteBtn, keyNameInput, firstPublic, () => {
                    renderKeysList();
                    draw();
                });
            });
            newKeyBar.appendChild(remoteBtn);
            keysCard.appendChild(newKeyBar);
            body.appendChild(keysCard);

            // 7. Caching
            const ca = section('Caching', 'fa-bolt', 'Repeat identical prompts are served from the relay cache.');
            ca.appendChild(buildInput('checkbox', 'cache', 'enabled', 'Enable response cache', 'Non-stream requests only.'));
            ca.appendChild(buildInput('number', 'cache', 'ttl_s', 'Cache TTL (s)'));
            ca.appendChild(buildInput('number', 'cache', 'max_entries', 'Max entries (LRU)'));
            ca.appendChild(buildInput('checkbox', 'cache', 'match_temperature', 'Temperature-sensitive keys',
                'Different temperatures never share a cached reply.'));
            const cacheStats = el('div', 'reach-card-foot');
            const clearCacheBtn = el('button', 'reach-btn reach-btn-sm', 'Clear cache');
            clearCacheBtn.addEventListener('click', () => {
                core.relayFetch('/_reach/cache/clear', { method: 'POST' }, 5000)
                    .then(() => toast('Cache cleared ✓', 'ok'));
            });
            cacheStats.appendChild(clearCacheBtn);
            const snap = core.store.local;
            if (snap && snap.cache) {
                cacheStats.appendChild(el('span', 'reach-hint',
                    'live: ' + snap.cache.entries + ' entries · ' + snap.cache.hits
                    + ' hits · ' + snap.cache.misses + ' misses'));
            }
            ca.appendChild(cacheStats);

            // 8. Observability
            const ob = section('Observability', 'fa-chart-line', 'What gets recorded and for how long.');
            ob.appendChild(buildInput('select', 'data', 'log_level', 'Log level',
                null, [{ value: 'none', label: 'none' },
                       { value: 'errors', label: 'errors only' },
                       { value: 'normal', label: 'normal' },
                       { value: 'verbose', label: 'verbose (bodies)' }]));
            ob.appendChild(buildInput('number', 'data', 'log_retention_days', 'Log retention (days)', '1–365; pruned hourly.'));
            ob.appendChild(buildInput('checkbox', 'data', 'log_bodies', 'Store body snippets',
                'Truncated request/response bodies for debugging.'));

            // 9. Hosting
            const ho = section('Hosting', 'fa-tower-broadcast', 'Tunnel + endpoint pointer publishing.');
            ho.appendChild(buildInput('select', null, 'tunnel', 'Tunnel',
                null, [{ value: 'ngrok', label: 'ngrok' },
                       { value: 'cloudflared', label: 'cloudflared' },
                       { value: 'none', label: 'none (local only)' }]));
            ho.appendChild(buildInput('text', null, 'public_url_override', 'Public URL override',
                'Pin a URL (https://…) — otherwise auto-discovered from the tunnel.',
                { nullable: true }));
            ho.appendChild(buildInput('checkbox', 'publish', 'enabled', 'Publish URL to the pointer gist'));
            ho.appendChild(buildInput('number', 'publish', 'interval_min', 'Republish interval (min)', '0 = on change only.'));

            // Pointer publication status (PRD: publication timestamp, live
            // status badge, direct gist link, single-click revoke/update).
            const pubStatus = el('div', 'reach-card-foot reach-pointer-status');
            const pubBadge = el('span', 'reach-chip', 'checking…');
            const pubTime = el('span', 'reach-hint', '');
            const gistLink = document.createElement('a');
            gistLink.className = 'reach-hint';
            gistLink.href = 'https://gist.github.com/' + 'falabellamichael/e261e0c31ad08c373bcd667b6982847a';
            gistLink.target = '_blank';
            gistLink.rel = 'noopener noreferrer';
            gistLink.textContent = 'Open pointer gist ↗';
            pubStatus.appendChild(pubBadge);
            pubStatus.appendChild(pubTime);
            pubStatus.appendChild(gistLink);
            ho.appendChild(pubStatus);

            function refreshPubStatus() {
                core.refreshLocal().then(snap => {
                    const s = snap || core.store.local || {};
                    const publishedAt = s.last_published_at;
                    const url = s.public_url || core.store.pointerUrl;
                    if (publishedAt) {
                        pubBadge.className = 'reach-chip reach-chip-live';
                        pubBadge.textContent = 'published ✓';
                        pubTime.textContent = 'Last publish: ' + core.fmtAgo(publishedAt)
                            + (url ? ' — ' + url : '');
                    } else if (url) {
                        pubBadge.className = 'reach-chip reach-chip-warn';
                        pubBadge.textContent = 'not published';
                        pubTime.textContent = 'Public URL discovered (' + (s.public_url_source || 'tunnel')
                            + ') but not pushed to the gist this session.';
                    } else {
                        pubBadge.className = 'reach-chip';
                        pubBadge.textContent = 'no public URL';
                        pubTime.textContent = 'Start a tunnel or set an override to publish.';
                    }
                });
            }
            refreshPubStatus();

            const pubBtnRow = el('div', 'reach-card-foot');
            const pubBtn = el('button', 'reach-btn reach-btn-sm', 'Publish now');
            pubBtn.addEventListener('click', () => {
                pubBtn.disabled = true;
                publishNow()
                    .then(d => {
                        toast('Published ✓ ' + ((d && d.public_url) || ''), 'ok');
                        refreshPubStatus();
                    })
                    .catch(e => toast(e.message, 'error'))
                    .finally(() => { pubBtn.disabled = false; });
            });
            const revokeBtn = el('button', 'reach-btn reach-btn-danger reach-btn-sm', 'Revoke pointer');
            revokeBtn.addEventListener('click', () => {
                window.__reachPageWidgets.confirmDialog({
                    title: 'Revoke the published pointer URL?',
                    message: 'The pointer gist will be blanked. Remote clients that discover this relay through the pointer will no longer find it. Republish at any time with "Publish now".',
                    confirmLabel: 'Revoke',
                    danger: true
                }).then(ok => {
                    if (!ok) return;
                    revokeBtn.disabled = true;
                    core.relayFetch('/_reach/publish/revoke', { method: 'POST' }, 30000)
                        .then(res => res.json().then(d => ({ ok: res.ok, d: d })))
                        .then(({ ok: resOk, d }) => {
                            toast(resOk ? 'Pointer revoked ✓' : ('Revoke failed: ' + (d.error || '?')), resOk ? 'ok' : 'error');
                            refreshPubStatus();
                        })
                        .catch(e => toast('Revoke failed: ' + e.message, 'error'))
                        .finally(() => { revokeBtn.disabled = false; });
                });
            });
            pubBtnRow.appendChild(pubBtn);
            pubBtnRow.appendChild(revokeBtn);
            ho.appendChild(pubBtnRow);

            // 10. System
            const sy = section('System', 'fa-gears', 'Danger zone — think before toggling.');
            sy.appendChild(buildInput('checkbox', 'system', 'allow_remote_admin', 'Allow remote admin API',
                'Exposes /_reach/* beyond loopback. DANGEROUS.'));
            sy.appendChild(buildInput('number', 'system', 'log_rotation_mb', 'Log rotation (MB)'));

            markDirty(false);

            // deep-link from the Models page: scroll to the requested alias
            const editPref = core.prefsGet('model-edit', '');
            if (editPref) {
                core.prefsSet('model-edit', '');
                const target = document.getElementById('reach-model-' + editPref);
                if (target) {
                    target.scrollIntoView({ behavior: 'smooth', block: 'start' });
                    target.classList.add('reach-model-flash');
                    setTimeout(() => target.classList.remove('reach-model-flash'), 1600);
                }
            }
        }

        // ---- export / import / reset ----
        exportBtn.addEventListener('click', () => {
            const copy = JSON.parse(JSON.stringify(draft || {}));
            if (copy.omniroute_key && copy.omniroute_key.startsWith('set (')) delete copy.omniroute_key;
            if (copy.access && copy.access.access_key && copy.access.access_key.startsWith('set (')) {
                copy.access = Object.assign({}, copy.access);
                delete copy.access.access_key;
            }
            const blob = new Blob([JSON.stringify(copy, null, 2)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = 'simplereach-settings.json';
            a.click();
            URL.revokeObjectURL(url);
            toast('Settings exported (keys excluded)', 'info');
        });
        importBtn.addEventListener('click', () => importInput.click());
        importInput.addEventListener('change', () => {
            const file = importInput.files && importInput.files[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = () => {
                try {
                    const parsed = JSON.parse(String(reader.result));
                    if (!parsed || typeof parsed !== 'object') throw new Error('not an object');
                    core.saveSettings(parsed).then(({ ok, data }) => {
                        if (ok) {
                            toast('Imported ✓', 'ok');
                            core.loadSettings().then(cfg => { draft = JSON.parse(JSON.stringify(cfg)); draw(); });
                        } else {
                            toast('Import failed: ' + esc((data && data.error && data.error.message) || ''), 'error');
                        }
                    });
                } catch (err) {
                    toast('Import failed: ' + err.message, 'error');
                } finally {
                    importInput.value = '';
                }
            };
            reader.readAsText(file);
        });
        resetBtn.addEventListener('click', () => {
            if (!confirm('Reset ALL settings to defaults? The OmniRoute key and access key are kept.')) return;
            core.relayFetch('/_reach/reset', { method: 'POST' }, 6000)
                .then(res => res.json())
                .then(data => {
                    if (data.saved) {
                        toast('Reset ✓ (keys kept)', 'ok');
                        core.loadSettings().then(cfg => {
                            draft = JSON.parse(JSON.stringify(cfg));
                            draw();
                        });
                    } else {
                        toast('Reset failed', 'error');
                    }
                });
        });

        saveBtn.addEventListener('click', () => {
            if (!draft) return;
            const patch = JSON.parse(JSON.stringify(draft));
            if (patch.omniroute_key && typeof patch.omniroute_key === 'string'
                && patch.omniroute_key.startsWith('set (')) delete patch.omniroute_key;
            if (patch.access && typeof patch.access.access_key === 'string'
                && patch.access.access_key.startsWith('set (')) delete patch.access.access_key;
            core.saveSettings(patch).then(({ ok, data }) => {
                if (ok) {
                    toast('Settings saved ✓', 'ok');
                    core.store.settings = data.settings || draft;
                    markDirty(false);
                } else {
                    toast('Save failed: ' + esc((data && data.error && data.error.message) || ''), 'error');
                }
            }).catch(err => toast('Save failed: ' + err.message, 'error'));
        });

        core.loadSettings().then(cfg => {
            if (cfg) draft = JSON.parse(JSON.stringify(cfg));
            draw();
        });
        return () => {};
    }

    window.__reachPageRegistry.settings = renderSettings;
})();
