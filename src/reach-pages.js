/*
 * SimpleREACH pages — renderers for the seven REACH panels.
 * Exposes window.__reachPages: {dashboard, endpoint, models, usage, logs,
 * settings, about}. Each render(container) returns a cleanup function.
 * Depends on window.__reachCore (reach-core.js).
 */
(function initReachPages() {
    'use strict';

    const core = window.__reachCore;
    if (!core) {
        console.error('[simple-reach] reach-core.js missing — re-run install.');
        return;
    }
    const { el, esc, toast } = core;
    const { pageHeader, emptyNote, kv, publishNow } =
        window.__reachPageWidgets;

    const PAGE_DEFS = [
        { id: 'dashboard', icon: 'fa-gauge-high', label: 'Dashboard' },
        { id: 'endpoint', icon: 'fa-link', label: 'Endpoint' },
        { id: 'models', icon: 'fa-cubes', label: 'Models' },
        { id: 'usage', icon: 'fa-chart-column', label: 'Usage' },
        { id: 'logs', icon: 'fa-list', label: 'Logs' },
        { id: 'settings', icon: 'fa-sliders', label: 'Settings' },
        { id: 'about', icon: 'fa-circle-info', label: 'About' }
    ];

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
            grid.appendChild(mf('select', 'fallback', 'Fallback alias', [
                { value: '__null__', label: 'none' },
                ...aliases.filter(a => a !== alias).map(a => ({ value: a, label: a }))
            ], 'Tried when the upstream fails (non-stream).'));
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

        function draw() {
            body.innerHTML = '';
            if (!draft) {
                body.appendChild(emptyNote('Relay offline — settings cannot be loaded.'));
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
            upstreamInput.placeholder = 'upstream (e.g. codegpt/codegpt-gpt-4o-mini)';
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
                'Clients send X-Reach-Key (or Bearer).'));
            ac.appendChild(buildInput('password', 'access', 'access_key', 'Access key',
                'Blank keeps the current key; min 6 chars when required.'));
            ac.appendChild(buildInput('csv', 'access', 'ip_allowlist', 'IP allowlist',
                'Empty = everyone. Loopback is always allowed.'));
            ac.appendChild(buildInput('csv', 'access', 'ip_blocklist', 'IP blocklist'));
            ac.appendChild(buildInput('text', 'access', 'cors_origins', 'CORS origins',
                '"*" or comma-separated origins.'));

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
            const pubBtn = el('button', 'reach-btn reach-btn-sm', 'Publish now');
            pubBtn.addEventListener('click', () => publishNow()
                .then(() => toast('Published ✓', 'ok'))
                .catch(e => toast(e.message, 'error')));
            ho.appendChild(pubBtn);

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

    /* ----------------------------------------------------------------- ABOUT */
    function renderAbout(container) {
        container.appendChild(pageHeader('fa-circle-info', 'About',
            'REACH — RAG Endpoint & AI Chat Host.'));
        const body = el('div', 'reach-stack');
        container.appendChild(body);

        const hero = el('section', 'reach-card');
        const heroBody = el('div', 'reach-about-hero');
        heroBody.appendChild(el('div', 'reach-hero-badge reach-hero-badge-lg', 'REACH'));
        const copy = el('div', null);
        copy.appendChild(el('p', 'reach-copy', 'SimpleREACH adds a hosted OpenAI-compatible endpoint with unlimited gpt-4o to SimpleRAG — no key, no quotas, for everyone. Requests relay through OmniRoute\'s codegpt provider; the public tunnel only ever exposes the keyless relay surface.'));
        copy.appendChild(el('p', 'reach-copy', 'REACH = RAG Endpoint & AI Chat Host'));
        heroBody.appendChild(copy);
        hero.appendChild(heroBody);
        body.appendChild(hero);

        const arch = el('section', 'reach-card');
        arch.appendChild(el('header', 'reach-card-head', 'Architecture'));
        const flow = el('pre', 'reach-snippet reach-flow');
        flow.appendChild(el('code', null,
            'any OpenAI client\n      │\n      ▼\nhttps://<tunnel>/v1   (public · no auth · CORS *)\n      │\n      ▼\nreachd.py :20777      (loopback relay · stdlib only)\n      │  injects OmniRoute key server-side\n      │  pins alias → codegpt/codegpt-gpt-4o\n      │  rate limits · access key · analytics\n      ▼\nOmniRoute :20128/v1\n      ▼\ncodegpt free tier (gpt-4o)'));
        arch.appendChild(flow);
        body.appendChild(arch);

        const facts = el('section', 'reach-card');
        facts.appendChild(el('header', 'reach-card-head', 'Facts & Runtime Telemetry'));
        const dl = el('dl', 'reach-kv');
        kv(dl, 'Plugin', 'SimpleREACH v' + core.store.version);
        kv(dl, 'Repository', core.REPO_URL);
        kv(dl, 'License', 'MIT');
        kv(dl, 'Author', 'Michael Anthony Falabella');
        kv(dl, 'Relay Process', 'Python 3 stdlib — PID /:20777');
        kv(dl, 'Upstream Route', 'OmniRoute :20128 (codegpt tier)');
        kv(dl, 'Tunnel Provider', (core.store.local && core.store.local.public_url_source) || 'ngrok');
        kv(dl, 'Active Accent', core.prefsGet('accent_color', '#ffb020'));
        kv(dl, 'Plugin Isolation', 'Zero SimpleRAG host files touched — scoped theme engine');
        facts.appendChild(dl);
        body.appendChild(facts);

        // Database Maintenance Card
        const dbCard = el('section', 'reach-card');
        dbCard.appendChild(el('header', 'reach-card-head', 'Database & Cache Maintenance'));
        const dbBody = el('div', 'reach-card-body');
        dbBody.appendChild(el('p', 'reach-copy',
            'SimpleREACH logs requests into an optimized SQLite database for telemetry, rate limiting, and live presence analytics. Response caching reduces upstream calls for duplicate queries.'));

        const dbActions = el('div', 'reach-stat-actions-row');
        dbActions.style.marginTop = '8px';

        const flushCacheBtn = el('button', 'reach-btn reach-btn-sm');
        flushCacheBtn.innerHTML = '<i class="fa-solid fa-broom"></i> Flush Response Cache';
        flushCacheBtn.addEventListener('click', () => {
            flushCacheBtn.disabled = true;
            core.relayFetch('/_reach/cache/clear', { method: 'POST' }, 5000)
                .then(r => r.json())
                .then(d => {
                    toast(d.cleared ? 'Cache flushed ✓' : 'Flush failed', d.cleared ? 'ok' : 'error');
                })
                .catch(e => toast('Cache flush: ' + e.message, 'error'))
                .finally(() => { flushCacheBtn.disabled = false; });
        });

        const clearLogsBtn = el('button', 'reach-btn reach-btn-danger reach-btn-sm');
        clearLogsBtn.innerHTML = '<i class="fa-solid fa-trash-can"></i> Vacuum & Prune Logs';
        clearLogsBtn.addEventListener('click', () => {
            if (!confirm('Are you sure you want to clear all request telemetry and logs?')) return;
            clearLogsBtn.disabled = true;
            core.relayFetch('/_reach/logs', { method: 'DELETE' }, 6000)
                .then(() => toast('Database logs pruned & vacuumed ✓', 'ok'))
                .catch(e => toast('Log prune: ' + e.message, 'error'))
                .finally(() => { clearLogsBtn.disabled = false; });
        });

        dbActions.appendChild(flushCacheBtn);
        dbActions.appendChild(clearLogsBtn);
        dbBody.appendChild(dbActions);
        dbCard.appendChild(dbBody);
        body.appendChild(dbCard);

        const privacy = el('section', 'reach-card');
        privacy.appendChild(el('header', 'reach-card-head', 'Privacy & availability'));
        privacy.appendChild(el('p', 'reach-copy', 'Requests are logged locally (IP, model, tokens, latency) for the Usage and Logs pages and pruned on the configured retention. The OmniRoute key never leaves this machine. Availability rides on the host\'s free codegpt tier — rate limits in Settings keep it fair for everyone.'));
        body.appendChild(privacy);

        return () => {};
    }

    const registry = window.__reachPageRegistry;

    window.__reachPages = Object.freeze({
        defs: PAGE_DEFS,
        dashboard: registry.dashboard,
        endpoint: registry.endpoint,
        models: registry.models,
        usage: registry.usage,
        logs: registry.logs,
        settings: renderSettings,
        about: renderAbout
    });
})();
