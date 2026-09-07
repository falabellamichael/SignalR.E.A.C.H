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

    const PAGE_DEFS = [
        { id: 'dashboard', icon: 'fa-gauge-high', label: 'Dashboard' },
        { id: 'endpoint', icon: 'fa-link', label: 'Endpoint' },
        { id: 'models', icon: 'fa-cubes', label: 'Models' },
        { id: 'usage', icon: 'fa-chart-column', label: 'Usage' },
        { id: 'logs', icon: 'fa-list', label: 'Logs' },
        { id: 'settings', icon: 'fa-sliders', label: 'Settings' },
        { id: 'about', icon: 'fa-circle-info', label: 'About' }
    ];

    function pageHeader(icon, title, subtitle) {
        const head = el('div', 'reach-page-head');
        const iconEl = el('div', 'reach-page-head-icon');
        const i = el('i', 'fa-solid ' + icon);
        iconEl.appendChild(i);
        const copy = el('div', 'reach-page-head-copy');
        copy.appendChild(el('h1', 'reach-page-title', title));
        if (subtitle) copy.appendChild(el('p', 'reach-page-sub', subtitle));
        head.appendChild(iconEl);
        head.appendChild(copy);
        return head;
    }

    function statTile(label, value, sub, tone) {
        const tile = el('div', 'reach-tile' + (tone ? ' reach-tile-' + tone : ''));
        tile.appendChild(el('div', 'reach-tile-label', label));
        tile.appendChild(el('div', 'reach-tile-value', value));
        if (sub) tile.appendChild(el('div', 'reach-tile-sub', sub));
        return tile;
    }

    function emptyNote(text) {
        const note = el('div', 'reach-empty');
        note.appendChild(el('i', 'fa-regular fa-circle-question'));
        note.appendChild(el('span', null, text));
        return note;
    }

    /* ------------------------------------------------------------- DASHBOARD */
    function renderDashboard(container) {
        container.appendChild(pageHeader('fa-gauge-high', 'Dashboard',
            'Live health of the hosted endpoint, the relay, and the upstream.'));
        const body = el('div', 'reach-dash');
        container.appendChild(body);
        let timer = null;

        function draw() {
            const snap = core.store.local;
            if (!snap) {
                body.innerHTML = '';
                const offline = el('div', 'reach-banner reach-banner-off');
                offline.appendChild(el('strong', null, 'Relay offline on this machine. '));
                offline.appendChild(document.createTextNode(
                    'The hosted endpoint keeps working as long as the relay + tunnel run somewhere — '
                    + 'but live stats are unavailable right now. Check Settings → Tunnel.'));
                body.appendChild(offline);
                return;
            }
            const today = snap.today || {};
            const tiles = el('div', 'reach-tiles');
            tiles.appendChild(statTile('Requests today', core.fmtNum(today.requests),
                'all clients', ''));
            tiles.appendChild(statTile('Tokens today', core.fmtNum((today.tokens_in || 0) + (today.tokens_out || 0)),
                core.fmtNum(today.tokens_in || 0) + ' in · ' + core.fmtNum(today.tokens_out || 0) + ' out'));
            tiles.appendChild(statTile('Avg latency', core.fmtLatency(today.avg_latency_ms),
                'p95 ' + core.fmtLatency(snap.p95_latency_ms)));
            tiles.appendChild(statTile('Errors today', core.fmtNum(today.errors),
                core.fmtNum(today.rate_limited || 0) + ' rate-limited', (today.errors || 0) > 0 ? 'bad' : 'good'));

            const grid = el('div', 'reach-dash-grid');
            grid.appendChild(dashCard('Public endpoint', () => {
                const wrap = el('div', 'reach-card-body');
                const row = el('div', 'reach-url-row');
                const code = el('code', 'reach-url', core.store.pointerUrl || 'resolving…');
                row.appendChild(code);
                const copyBtn = el('button', 'reach-btn', 'Copy');
                copyBtn.addEventListener('click', () => {
                    if (core.store.pointerUrl) {
                        core.copyText(core.store.pointerUrl).then(ok => toast(ok ? 'Copied ✓' : 'Copy failed', ok ? 'ok' : 'error'));
                    }
                });
                row.appendChild(copyBtn);
                wrap.appendChild(row);
                const meta = el('div', 'reach-meta-row');
                meta.appendChild(chip('model: ' + (snap.models || ['gpt-4o']).join(', ')));
                meta.appendChild(chip('streaming ✓'));
                meta.appendChild(chip('no API key'));
                if (snap.access_required) meta.appendChild(chip('access key required', 'warn'));
                wrap.appendChild(meta);
                const foot = el('div', 'reach-card-foot');
                const testBtn = el('button', 'reach-btn reach-btn-primary', 'Test endpoint');
                testBtn.addEventListener('click', () => runPublicTest(testBtn, wrap));
                foot.appendChild(testBtn);
                const hint = el('span', 'reach-hint', '1-token completion through the public URL');
                foot.appendChild(hint);
                wrap.appendChild(foot);
                const result = el('div', 'reach-result', '');
                result.hidden = true;
                wrap.appendChild(result);
                return wrap;
            }));

            grid.appendChild(dashCard('Relay', () => {
                const wrap = el('div', 'reach-card-body');
                const dl = el('dl', 'reach-kv');
                kv(dl, 'Status', 'running v' + snap.version, snap.ok ? 'ok' : 'bad');
                kv(dl, 'Port', String(snap.port || 20777));
                kv(dl, 'Uptime', core.fmtUptime(snap.uptime_s));
                kv(dl, 'Tunnel', core.store.local ? (snap.public_url_source || 'ngrok') : 'offline');
                kv(dl, 'Rate limiting', snap.rate_limits && snap.rate_limits.enabled ? 'on' : 'off');
                wrap.appendChild(dl);
                return wrap;
            }));

            grid.appendChild(dashCard('Upstream (OmniRoute)', () => {
                const wrap = el('div', 'reach-card-body');
                const dl = el('dl', 'reach-kv');
                kv(dl, 'Health', snap.upstream_ok ? 'healthy' : 'DOWN',
                    snap.upstream_ok ? 'ok' : 'bad');
                kv(dl, 'Circuit', snap.circuit_open ? 'OPEN (cool-down)' : 'closed',
                    snap.circuit_open ? 'bad' : 'ok');
                kv(dl, 'URL', String(snap.upstream || '—'));
                wrap.appendChild(dl);
                return wrap;
            }));

            grid.appendChild(dashCard('Quick actions', () => {
                const wrap = el('div', 'reach-card-body');
                const rows = el('div', 'reach-actions');
                rows.appendChild(actionBtn('fa-cloud-arrow-up', 'Publish URL to pointer gist',
                    () => publishNow().then(() => toast('Published ✓', 'ok'))));
                rows.appendChild(actionBtn('fa-trash-can', 'Clear request log',
                    () => core.relayFetch('/_reach/logs', { method: 'DELETE' }, 5000)
                        .then(() => toast('Log cleared ✓', 'ok'))));
                rows.appendChild(actionBtn('fa-rotate', 'Refresh now',
                    () => { core.refreshLocal().then(draw); toast('Refreshed', 'info'); }));
                wrap.appendChild(rows);
                return wrap;
            }));

            body.innerHTML = '';
            body.appendChild(tiles);
            body.appendChild(grid);
        }

        draw();
        timer = setInterval(() => core.refreshLocal().then(draw), 10000);
        return () => { if (timer) clearInterval(timer); };
    }

    function chip(label, tone) {
        const c = el('span', 'reach-chip' + (tone ? ' reach-chip-' + tone : ''));
        c.textContent = label;
        return c;
    }

    function kv(dl, key, value, tone) {
        dl.appendChild(el('dt', null, key));
        const dd = el('dd', tone ? 'reach-kv-' + tone : null, value);
        dl.appendChild(dd);
    }

    function dashCard(title, bodyFn) {
        const card = el('section', 'reach-card');
        const head = el('header', 'reach-card-head');
        head.appendChild(el('h2', null, title));
        card.appendChild(head);
        card.appendChild(bodyFn());
        return card;
    }

    function actionBtn(icon, label, onClick) {
        const btn = el('button', 'reach-btn reach-btn-block');
        const i = el('i', 'fa-solid ' + icon);
        i.style.width = '18px';
        btn.appendChild(i);
        btn.appendChild(document.createTextNode(' ' + label));
        btn.addEventListener('click', () => {
            btn.disabled = true;
            Promise.resolve().then(onClick).finally(() => { btn.disabled = false; });
        });
        return btn;
    }

    function publishNow() {
        return core.relayFetch('/_reach/publish', { method: 'POST' }, 30000)
            .then(res => res.json().then(data => ({ ok: res.ok, data: data })))
            .then(({ ok, data }) => {
                if (!ok) throw new Error((data && data.error) || 'publish failed');
                return data.public_url;
            });
    }

    function runPublicTest(btn, wrap) {
        const url = core.store.pointerUrl;
        const result = wrap.querySelector('.reach-result');
        if (!url) {
            result.hidden = false;
            result.className = 'reach-result reach-result-error';
            result.textContent = 'No public URL yet — is the tunnel up?';
            return;
        }
        result.hidden = false;
        result.className = 'reach-result';
        result.textContent = 'Calling ' + url + '/v1/chat/completions …';
        btn.disabled = true;
        core.relayFetch('/_reach/test', undefined, 60000)
            .then(res => res.json())
            .then(data => {
                result.className = 'reach-result ' + (data.ok ? 'reach-result-ok' : 'reach-result-error');
                result.textContent = data.ok
                    ? '✓ upstream replied in ' + core.fmtLatency(data.latency_ms) + ': ' + esc(data.reply)
                    : '✗ ' + esc(data.error);
            })
            .catch(err => {
                result.className = 'reach-result reach-result-error';
                result.textContent = '✗ ' + err.message;
            })
            .finally(() => { btn.disabled = false; });
    }

    /* -------------------------------------------------------------- ENDPOINT */
    function renderEndpoint(container) {
        container.appendChild(pageHeader('fa-link', 'Endpoint',
            'The OpenAI-compatible surface. Use it from anything that speaks OpenAI.'));
        const body = el('div', 'reach-stack');
        container.appendChild(body);

        const urlCard = el('section', 'reach-card');
        urlCard.appendChild(el('header', 'reach-card-head', 'Base URL'));
        const urlRow = el('div', 'reach-url-row');
        const urlCode = el('code', 'reach-url', core.store.pointerUrl ? core.store.pointerUrl + '/v1' : 'resolving…');
        urlRow.appendChild(urlCode);
        const copyBtn = el('button', 'reach-btn', 'Copy');
        copyBtn.addEventListener('click', () => {
            if (core.store.pointerUrl) {
                core.copyText(core.store.pointerUrl + '/v1').then(ok => toast(ok ? 'Copied ✓' : 'Copy failed', ok ? 'ok' : 'error'));
            }
        });
        urlRow.appendChild(copyBtn);
        urlCard.appendChild(urlRow);
        const meta = el('div', 'reach-meta-row');
        meta.appendChild(chip('model: gpt-4o'));
        meta.appendChild(chip('unlimited · free'));
        meta.appendChild(chip('no API key'));
        urlCard.appendChild(meta);
        body.appendChild(urlCard);

        const addCard = el('section', 'reach-card');
        addCard.appendChild(el('header', 'reach-card-head', 'One-click SimpleRAG hookup'));
        const addBody = el('div', 'reach-card-body');
        addBody.appendChild(el('p', 'reach-copy', 'Register this endpoint in SimpleRAG\'s endpoint list (idempotent — re-running just refreshes it).'));
        const addFoot = el('div', 'reach-card-foot');
        const addBtn = el('button', 'reach-btn reach-btn-primary', 'Add to SimpleRAG');
        addBtn.addEventListener('click', () => {
            const url = core.store.pointerUrl;
            if (!url) { toast('No public URL yet', 'error'); return; }
            addBtn.disabled = true;
            addBtn.textContent = 'Adding…';
            fetch(core.API_BASE + '/model-endpoints', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    name: 'SimpleREACH (REACH)',
                    base_url: url + '/v1',
                    api_key: '',
                    default_model: 'gpt-4o'
                })
            })
                .then(res => res.json().then(data => ({ ok: res.ok, data: data })))
                .then(({ ok, data }) => {
                    if (ok) {
                        toast('Added ✓ — pick "SimpleREACH (REACH)" as your active model', 'ok');
                    } else {
                        toast('Add failed: ' + esc((data && data.detail) || 'unknown error'), 'error');
                    }
                })
                .catch(err => toast('Add failed: ' + err.message, 'error'))
                .finally(() => { addBtn.disabled = false; addBtn.textContent = 'Add to SimpleRAG'; });
        });
        addFoot.appendChild(addBtn);
        addBody.appendChild(addFoot);
        addCard.appendChild(addBody);
        body.appendChild(addCard);

        const docsCard = el('section', 'reach-card');
        docsCard.appendChild(el('header', 'reach-card-head', 'Routes'));
        const table = el('table', 'reach-table');
        table.innerHTML = '<thead><tr><th>Method</th><th>Path</th><th>Description</th></tr></thead><tbody>' +
            '<tr><td>GET</td><td><code>/health</code></td><td>liveness + status (never gated)</td></tr>' +
            '<tr><td>GET</td><td><code>/v1/models</code></td><td>enabled model aliases</td></tr>' +
            '<tr><td>POST</td><td><code>/v1/chat/completions</code></td><td>chat — stream &amp; non-stream, rate-limited</td></tr>' +
            '<tr><td>GET</td><td><code>/status</code></td><td>rich status snapshot</td></tr>' +
            '</tbody>';
        docsCard.appendChild(table);
        body.appendChild(docsCard);

        const usageCard = el('section', 'reach-card');
        usageCard.appendChild(el('header', 'reach-card-head', 'Code snippets'));
        const tabs = el('div', 'reach-usage-tabs');
        ['curl', 'python', 'javascript', 'simplerag'].forEach((tab, idx) => {
            const b = el('button', 'reach-tab' + (idx === 0 ? ' reach-tab-active' : ''), tab === 'simplerag' ? 'SimpleRAG' : tab);
            b.dataset.tab = tab;
            b.addEventListener('click', () => {
                tabs.querySelectorAll('.reach-tab').forEach(t => t.classList.remove('reach-tab-active'));
                b.classList.add('reach-tab-active');
                usageCard.querySelectorAll('.reach-snippet').forEach(s => { s.hidden = s.dataset.snip !== tab; });
            });
            tabs.appendChild(b);
        });
        usageCard.appendChild(tabs);
        const U = () => (core.store.pointerUrl || 'https://YOUR-PUBLIC-URL');
        const renderedUrl = U();
        const snips = [
            { id: 'curl', text: 'curl ' + renderedUrl + '/v1/chat/completions \\\n  -H "Content-Type: application/json" \\\n  -d \'{"model":"gpt-4o","messages":[{"role":"user","content":"Hello!"}]}\'' },
            { id: 'python', text: 'from openai import OpenAI\n\nclient = OpenAI(base_url="' + renderedUrl + '/v1", api_key="not-needed")\nreply = client.chat.completions.create(\n    model="gpt-4o",\n    messages=[{"role": "user", "content": "Hello!"}],\n)\nprint(reply.choices[0].message.content)' },
            { id: 'javascript', text: 'const res = await fetch("' + renderedUrl + '/v1/chat/completions", {\n  method: "POST",\n  headers: { "Content-Type": "application/json" },\n  body: JSON.stringify({ model: "gpt-4o",\n    messages: [{ role: "user", content: "Hello!" }] }),\n});\nconst data = await res.json();\nconsole.log(data.choices[0].message.content);' },
            { id: 'simplerag', text: '1. Endpoint settings → add OpenAI-compatible\n2. Base URL: ' + renderedUrl + '/v1\n3. Model: gpt-4o\n4. API key: leave blank\n5. Save + select as active model\n(or just hit "Add to SimpleRAG" above)' }
        ];
        snips.forEach(s => {
            const pre = el('pre', 'reach-snippet');
            pre.dataset.snip = s.id;
            pre.hidden = s.id !== 'curl';
            pre.appendChild(el('code', null, s.text));
            usageCard.appendChild(pre);
        });
        body.appendChild(usageCard);

        core.refreshPointer().then(() => {
            const fresh = core.store.pointerUrl;
            if (!fresh || fresh === renderedUrl) {
                urlCode.textContent = fresh ? fresh + '/v1' : urlCode.textContent;
                return;
            }
            urlCode.textContent = fresh + '/v1';
            usageCard.querySelectorAll('.reach-snippet code').forEach(code => {
                code.textContent = code.textContent.split(renderedUrl).join(fresh);
            });
        });
        return () => {};
    }

    /* ---------------------------------------------------------------- MODELS */
    function renderModels(container) {
        container.appendChild(pageHeader('fa-cubes', 'Models',
            'Public aliases and their upstream codegpt targets. Toggles apply instantly.'));
        const body = el('div', 'reach-stack');
        container.appendChild(body);
        let timer = null;

        function draw() {
            const cfg = core.store.settings;
            body.innerHTML = '';
            const card = el('section', 'reach-card');
            card.appendChild(el('header', 'reach-card-head', 'Served aliases'));
            if (!cfg || !cfg.models) {
                card.appendChild(emptyNote('Relay offline — cannot read the model table.'));
                body.appendChild(card);
                return;
            }
            const table = el('table', 'reach-table');
            table.innerHTML = '<thead><tr><th>Public alias</th><th>Upstream model</th><th>Enabled</th><th></th><th></th></tr></thead>';
            const tbody = document.createElement('tbody');
            const entries = Object.entries(cfg.models).sort((a, b) => a[0].localeCompare(b[0]));
            entries.forEach(([alias, spec]) => {
                const tr = document.createElement('tr');
                tr.appendChild(el('td', null, alias));
                tr.appendChild(el('td', null, spec.upstream));
                const toggleTd = document.createElement('td');
                const toggle = el('label', 'reach-switch');
                const input = document.createElement('input');
                input.type = 'checkbox';
                input.checked = !!spec.enabled;
                input.addEventListener('change', () => {
                    core.saveSettings({ models: { [alias]: { enabled: input.checked } } })
                        .then(({ ok, data }) => {
                            if (ok) { toast('Model toggled ✓', 'ok'); core.loadSettings(); }
                            else toast('Failed: ' + esc((data && data.error && data.error.message) || ''), 'error');
                        });
                });
                const slider = el('span', 'reach-switch-slider');
                toggle.appendChild(input);
                toggle.appendChild(slider);
                toggleTd.appendChild(toggle);
                tr.appendChild(toggleTd);
                const editTd = document.createElement('td');
                const edit = el('button', 'reach-btn', 'Edit');
                edit.title = 'Open the full per-model editor in Settings';
                edit.addEventListener('click', () => {
                    core.prefsSet('model-edit', alias);
                    if (window.simpleReach && typeof window.simpleReach.switchPage === 'function') {
                        window.simpleReach.switchPage('settings', true);
                    }
                });
                editTd.appendChild(edit);
                tr.appendChild(editTd);
                const rmTd = document.createElement('td');
                const rm = el('button', 'reach-btn reach-btn-danger', 'Remove');
                rm.addEventListener('click', () => {
                    if (Object.keys(cfg.models).length <= 1) { toast('Keep at least one alias', 'error'); return; }
                    // alias -> null is the removal sentinel in the settings merge
                    core.saveSettings({ models: { [alias]: null } }).then(({ ok, data }) => {
                        if (ok) {
                            toast('Removed ' + alias, 'ok');
                            core.loadSettings().then(draw);
                        } else {
                            toast('Failed: ' + esc((data && data.error && data.error.message) || ''), 'error');
                        }
                    });
                });
                rmTd.appendChild(rm);
                tr.appendChild(rmTd);
                tbody.appendChild(tr);
            });
            table.appendChild(tbody);
            card.appendChild(table);
            body.appendChild(card);

            const addCard = el('section', 'reach-card');
            addCard.appendChild(el('header', 'reach-card-head', 'Add alias'));
            const form = el('form', 'reach-form');
            form.addEventListener('submit', e => {
                e.preventDefault();
                const alias = aliasInput.value.trim();
                const upstream = upstreamInput.value.trim();
                if (!alias || !upstream) { toast('Both fields are required', 'error'); return; }
                core.saveSettings({ models: { [alias]: { upstream: upstream, enabled: true } } })
                    .then(({ ok, data }) => {
                        if (ok) {
                            toast('Alias added ✓', 'ok');
                            core.loadSettings().then(draw);
                        } else {
                            toast('Failed: ' + esc((data && data.error && data.error.message) || ''), 'error');
                        }
                    });
            });
            const row = el('div', 'reach-form-row');
            const aliasInput = document.createElement('input');
            aliasInput.placeholder = 'public alias (e.g. gpt-4o-mini)';
            aliasInput.className = 'reach-input';
            const upstreamInput = document.createElement('input');
            upstreamInput.placeholder = 'upstream (e.g. codegpt/codegpt-gpt-4o-mini)';
            upstreamInput.className = 'reach-input';
            row.appendChild(aliasInput);
            row.appendChild(upstreamInput);
            const submit = el('button', 'reach-btn reach-btn-primary', 'Add');
            submit.type = 'submit';
            row.appendChild(submit);
            form.appendChild(row);
            addCard.appendChild(form);
            addCard.appendChild(el('p', 'reach-copy', 'Upstream ids live in OmniRoute\'s /v1/models catalog.'));
            body.appendChild(addCard);
        }

        core.loadSettings().then(draw);
        timer = setInterval(() => core.loadSettings().then(draw), 30000);
        return () => { if (timer) clearInterval(timer); };
    }

    /* ----------------------------------------------------------------- USAGE */
    function renderUsage(container) {
        container.appendChild(pageHeader('fa-chart-column', 'Live Usage & Telemetry',
            'Real-time event stream, client presence, throughput velocity, and latency analytics.'));
        const body = el('div', 'reach-stack');
        container.appendChild(body);

        // State
        let timer = null;
        let clockTimer = null;
        let isPaused = false;
        let cadenceMs = 2500;
        let activeFilter = 'all';
        let clientFilter = '';
        let showPresence = core.prefsGet('show_client_presence', '1') === '1';
        let seenLogIds = new Set();
        let logsCache = [];
        let clientsCache = [];
        let isInitialMount = true;
        let lastTickAt = Date.now();
        let prevReqCount = null;
        let prevTokCount = null;

        // 1. Build Persistent DOM Skeleton
        // ---- Live HUD ----
        const hud = el('div', 'reach-live-hud');
        const statusGroup = el('div', 'reach-live-status-group');
        const liveDot = el('div', 'reach-live-dot');
        const liveMeta = el('div', 'reach-live-meta');
        const titleRow = el('div', 'reach-live-title-row');
        const liveTitle = el('span', 'reach-live-title', 'LIVE TELEMETRY');
        const liveBadge = el('span', 'reach-live-badge', 'STREAMING');
        titleRow.appendChild(liveTitle);
        titleRow.appendChild(liveBadge);
        const liveSub = el('span', 'reach-live-sub', 'Polling every 2.5s · Instant velocity tracking');
        liveMeta.appendChild(titleRow);
        liveMeta.appendChild(liveSub);
        statusGroup.appendChild(liveDot);
        statusGroup.appendChild(liveMeta);
        hud.appendChild(statusGroup);

        const controls = el('div', 'reach-live-controls');

        // Toggle Option: Live Client Presence
        const presenceToggleWrap = el('label', 'reach-toggle-wrap' + (showPresence ? ' active' : ''));
        const presenceCheckbox = document.createElement('input');
        presenceCheckbox.type = 'checkbox';
        presenceCheckbox.checked = showPresence;
        presenceCheckbox.addEventListener('change', () => {
            showPresence = presenceCheckbox.checked;
            core.prefsSet('show_client_presence', showPresence ? '1' : '0');
            presenceSection.style.display = showPresence ? 'flex' : 'none';
            if (showPresence) presenceToggleWrap.classList.add('active');
            else presenceToggleWrap.classList.remove('active');
        });
        presenceToggleWrap.appendChild(presenceCheckbox);
        presenceToggleWrap.appendChild(document.createTextNode('👥 Live Users'));
        controls.appendChild(presenceToggleWrap);

        // Cadence Selector
        const cadenceWrap = el('div', 'reach-cadence-selector');
        const cadenceOptions = [
            { label: '1s Turbo', ms: 1000 },
            { label: '2.5s Live', ms: 2500 },
            { label: '5s Normal', ms: 5000 },
            { label: '15s Eco', ms: 15000 }
        ];
        const cadenceBtns = [];
        cadenceOptions.forEach(opt => {
            const btn = el('button', 'reach-cadence-btn' + (opt.ms === cadenceMs ? ' active' : ''), opt.label);
            btn.addEventListener('click', () => {
                cadenceMs = opt.ms;
                cadenceBtns.forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                liveSub.textContent = 'Polling every ' + (opt.ms / 1000).toFixed(1) + 's · Instant velocity tracking';
                resetTimer();
            });
            cadenceBtns.push(btn);
            cadenceWrap.appendChild(btn);
        });
        controls.appendChild(cadenceWrap);

        const pauseBtn = el('button', 'reach-btn reach-btn-sm', 'Pause');
        pauseBtn.addEventListener('click', () => {
            isPaused = !isPaused;
            if (isPaused) {
                liveDot.classList.add('paused');
                liveBadge.textContent = 'PAUSED';
                liveBadge.style.background = 'rgba(255, 176, 32, 0.18)';
                liveBadge.style.color = '#ffd37a';
                liveBadge.style.borderColor = 'rgba(255, 176, 32, 0.4)';
                pauseBtn.textContent = 'Resume';
            } else {
                liveDot.classList.remove('paused');
                liveBadge.textContent = 'STREAMING';
                liveBadge.style.background = 'rgba(46, 204, 113, 0.16)';
                liveBadge.style.color = '#7ce8a0';
                liveBadge.style.borderColor = 'rgba(46, 204, 113, 0.35)';
                pauseBtn.textContent = 'Pause';
                tick(true);
            }
        });
        controls.appendChild(pauseBtn);

        const refreshBtn = el('button', 'reach-btn reach-btn-sm', '');
        const refreshIcon = el('i', 'fa-solid fa-rotate');
        refreshBtn.appendChild(refreshIcon);
        refreshBtn.title = 'Refresh immediately';
        refreshBtn.addEventListener('click', () => {
            refreshIcon.classList.add('fa-spin');
            tick(true).finally(() => setTimeout(() => refreshIcon.classList.remove('fa-spin'), 600));
        });
        controls.appendChild(refreshBtn);
        hud.appendChild(controls);
        body.appendChild(hud);

        // ---- KPI Tiles ----
        const tiles = el('div', 'reach-tiles');
        const reqTile = statTile('Requests (24h)', '—', '0.0 req/s live');
        const tokTile = statTile('Tokens out (24h)', '—', '0 in · 0 out');
        const latTile = statTile('Avg Latency (Today)', '—', 'p95 —');
        const errTile = statTile('Error Rate', '0%', '0 rate-limited', 'good');
        tiles.appendChild(reqTile);
        tiles.appendChild(tokTile);
        tiles.appendChild(latTile);
        tiles.appendChild(errTile);
        body.appendChild(tiles);

        // ---- Active Client Presence Section (Toggleable) ----
        const presenceSection = el('section', 'reach-presence-section');
        presenceSection.style.display = showPresence ? 'flex' : 'none';

        const presenceHead = el('div', 'reach-presence-head');
        const presTitleWrap = el('div', 'reach-presence-title-wrap');
        const presIcon = el('i', 'fa-solid fa-users-viewfinder');
        presIcon.style.color = '#ffd37a';
        presTitleWrap.appendChild(presIcon);
        presTitleWrap.appendChild(el('h3', 'reach-presence-title', 'Live Client Presence'));
        const presCountBadge = el('span', 'reach-presence-count', '0 active');
        presTitleWrap.appendChild(presCountBadge);
        presenceHead.appendChild(presTitleWrap);

        const presActions = el('div', 'reach-live-controls');
        const clearFilterBtn = el('button', 'reach-btn reach-btn-sm', 'Show All Clients');
        clearFilterBtn.style.display = 'none';
        clearFilterBtn.addEventListener('click', () => {
            clientFilter = '';
            clearFilterBtn.style.display = 'none';
            renderPresenceCards();
            renderFeedList();
        });
        presActions.appendChild(clearFilterBtn);
        presenceHead.appendChild(presActions);
        presenceSection.appendChild(presenceHead);

        const presenceGrid = el('div', 'reach-presence-grid');
        presenceSection.appendChild(presenceGrid);
        body.appendChild(presenceSection);

        // ---- Live Request Feed Card ----
        const feedCard = el('section', 'reach-feed-card');
        const feedHead = el('div', 'reach-feed-head');
        const titleWrap = el('div', 'reach-feed-title-wrap');
        const feedIcon = el('i', 'fa-solid fa-bolt', '');
        feedIcon.style.color = '#ffd37a';
        titleWrap.appendChild(feedIcon);
        titleWrap.appendChild(el('h3', 'reach-feed-title', 'Live Request Feed'));
        const feedCountBadge = el('span', 'reach-feed-count', '0 events');
        titleWrap.appendChild(feedCountBadge);
        feedHead.appendChild(titleWrap);

        const feedActions = el('div', 'reach-feed-actions');
        const filtersWrap = el('div', 'reach-feed-filters');
        const filterDefs = [
            { id: 'all', label: 'All' },
            { id: '200', label: '200 OK' },
            { id: '429', label: '429 Limited' },
            { id: 'err', label: 'Errors' },
            { id: 'stream', label: 'Streams' }
        ];
        const filterChips = [];
        filterDefs.forEach(f => {
            const chip = el('button', 'reach-feed-chip' + (f.id === activeFilter ? ' active' : ''), f.label);
            chip.addEventListener('click', () => {
                activeFilter = f.id;
                filterChips.forEach(c => c.classList.remove('active'));
                chip.classList.add('active');
                renderFeedList();
            });
            filterChips.push(chip);
            filtersWrap.appendChild(chip);
        });
        feedActions.appendChild(filtersWrap);

        const clearFeedBtn = el('button', 'reach-btn reach-btn-sm', 'Clear View');
        clearFeedBtn.addEventListener('click', () => {
            logsCache = [];
            feedList.innerHTML = '';
            feedCountBadge.textContent = '0 events';
            renderFeedList();
        });
        feedActions.appendChild(clearFeedBtn);
        feedHead.appendChild(feedActions);
        feedCard.appendChild(feedHead);

        // Client Filter Banner inside Feed Card
        const clientFilterBanner = el('div', 'reach-client-filter-banner');
        clientFilterBanner.style.display = 'none';
        feedCard.appendChild(clientFilterBanner);

        const feedList = el('div', 'reach-feed-list');
        feedCard.appendChild(feedList);
        body.appendChild(feedCard);

        // ---- Hourly Charts ----
        const reqChartCard = el('section', 'reach-card');
        reqChartCard.appendChild(el('header', 'reach-card-head', 'Requests per hour (last 24h)'));
        const reqChart = el('div', 'reach-chart');
        reqChartCard.appendChild(reqChart);
        body.appendChild(reqChartCard);

        const tokChartCard = el('section', 'reach-card');
        tokChartCard.appendChild(el('header', 'reach-card-head', 'Tokens out per hour (last 24h)'));
        const tokChart = el('div', 'reach-chart');
        tokChartCard.appendChild(tokChart);
        body.appendChild(tokChartCard);

        // ---- Grid: Model Share & Top Clients ----
        const grid = el('div', 'reach-dash-grid');

        // By Model Card
        const byModelCard = el('section', 'reach-card');
        byModelCard.appendChild(el('header', 'reach-card-head', 'Model Traffic Distribution (Today)'));
        const shareBarWrap = el('div', 'reach-model-share-wrap');
        const shareBar = el('div', 'reach-model-share-bar');
        const shareLegend = el('div', 'reach-model-legend');
        shareBarWrap.appendChild(shareBar);
        shareBarWrap.appendChild(shareLegend);
        byModelCard.appendChild(shareBarWrap);

        const modelTable = el('table', 'reach-table');
        modelTable.innerHTML = '<thead><tr><th>Model</th><th>Share</th><th>Requests</th><th>In</th><th>Out</th></tr></thead>';
        const modelTbody = document.createElement('tbody');
        modelTable.appendChild(modelTbody);
        byModelCard.appendChild(modelTable);
        grid.appendChild(byModelCard);

        // Top Clients Card
        const clientsCard = el('section', 'reach-card');
        clientsCard.appendChild(el('header', 'reach-card-head', 'Top Clients (Today)'));
        const clientsTable = el('table', 'reach-table');
        clientsTable.innerHTML = '<thead><tr><th>Client IP</th><th>Requests</th><th>Tokens out</th></tr></thead>';
        const clientsTbody = document.createElement('tbody');
        clientsTable.appendChild(clientsTbody);
        clientsCard.appendChild(clientsTable);
        grid.appendChild(clientsCard);

        body.appendChild(grid);

        // ---- Presence Helpers ----
        function getClientPresence(lastSeenStr) {
            if (!lastSeenStr) return { status: 'dormant', text: 'Dormant', diffSec: 999999 };
            const t = new Date(lastSeenStr.length === 19 ? lastSeenStr : lastSeenStr);
            const diffSec = Math.max(0, Math.floor((Date.now() - t.getTime()) / 1000));
            if (diffSec < 60) {
                return { status: 'active', text: 'Online Now (' + diffSec + 's ago)', diffSec: diffSec };
            }
            if (diffSec < 300) {
                return { status: 'idle', text: 'Idle (' + Math.floor(diffSec / 60) + 'm ago)', diffSec: diffSec };
            }
            return { status: 'dormant', text: 'Dormant (' + core.fmtAgo(lastSeenStr) + ')', diffSec: diffSec };
        }

        function getClientLabel(ip) {
            if (ip === '127.0.0.1' || ip === '::1' || ip === 'localhost') {
                return '🖥️ Localhost Session';
            }
            if (ip === '142.186.13.229') {
                return '🤖 DeepSeek / Remote Peer';
            }
            return '🌐 Remote Client (' + ip + ')';
        }

        function renderPresenceCards() {
            presenceGrid.innerHTML = '';
            if (clientFilter) {
                clearFilterBtn.style.display = 'inline-flex';
                clearFilterBtn.textContent = 'Reset Filter (' + clientFilter + ')';
                clientFilterBanner.innerHTML = '';
                const bannerText = el('span', null, '');
                bannerText.innerHTML = '<i class="fa-solid fa-filter"></i> Filtering live events for: <strong>' + clientFilter + '</strong>';
                clientFilterBanner.appendChild(bannerText);

                const unfilterBtn = document.createElement('button');
                unfilterBtn.textContent = 'Clear Filter';
                unfilterBtn.addEventListener('click', () => {
                    clientFilter = '';
                    clearFilterBtn.style.display = 'none';
                    renderPresenceCards();
                    renderFeedList();
                });
                clientFilterBanner.appendChild(unfilterBtn);
                clientFilterBanner.style.display = 'flex';
            } else {
                clearFilterBtn.style.display = 'none';
                clientFilterBanner.style.display = 'none';
            }

            if (!clientsCache.length) {
                const empty = el('div', 'reach-feed-empty', 'No client connections detected today yet.');
                presenceGrid.appendChild(empty);
                presCountBadge.textContent = '0 active';
                return;
            }

            let activeCount = 0;
            clientsCache.forEach(c => {
                const pres = getClientPresence(c.last_seen);
                if (pres.status === 'active') activeCount++;

                const card = el('div', 'reach-presence-card' + (clientFilter === c.ip ? ' selected' : ''));
                card.addEventListener('click', () => {
                    clientFilter = (clientFilter === c.ip) ? '' : c.ip;
                    renderPresenceCards();
                    renderFeedList();
                });

                // Top row: Dot + Name + Status Pill
                const topRow = el('div', 'reach-presence-card-top');
                const userWrap = el('div', 'reach-presence-user-wrap');
                const dot = el('span', 'reach-presence-status-dot ' + pres.status);
                userWrap.appendChild(dot);
                const name = el('span', 'reach-presence-name', getClientLabel(c.ip));
                name.title = c.ip;
                userWrap.appendChild(name);
                topRow.appendChild(userWrap);

                const pill = el('span', 'reach-presence-pill ' + pres.status, pres.text);
                topRow.appendChild(pill);
                card.appendChild(topRow);

                // IP & UA Row
                const ipRow = el('div', 'reach-presence-ip-row');
                const ipCode = el('span', null, c.ip);
                ipRow.appendChild(ipCode);

                const copyBtn = el('button', 'reach-presence-btn', '');
                copyBtn.innerHTML = '<i class="fa-regular fa-copy"></i> Copy';
                copyBtn.title = 'Copy IP address';
                copyBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    core.copyText(c.ip).then(ok => core.toast(ok ? 'IP copied ✓' : 'Copy failed', ok ? 'ok' : 'error'));
                });
                ipRow.appendChild(copyBtn);
                card.appendChild(ipRow);

                if (c.user_agent) {
                    const uaEl = el('div', 'reach-presence-ua', c.user_agent);
                    uaEl.title = c.user_agent;
                    card.appendChild(uaEl);
                }

                // Stats Grid
                const statsGrid = el('div', 'reach-presence-stats-grid');
                const s1 = el('div', 'reach-presence-stat-item');
                s1.appendChild(el('span', 'reach-presence-stat-val', core.fmtNum(c.requests || 0)));
                s1.appendChild(el('span', 'reach-presence-stat-lbl', 'Requests'));
                statsGrid.appendChild(s1);

                const s2 = el('div', 'reach-presence-stat-item');
                s2.appendChild(el('span', 'reach-presence-stat-val', core.fmtNum(c.tokens_out || 0)));
                s2.appendChild(el('span', 'reach-presence-stat-lbl', 'Tokens Out'));
                statsGrid.appendChild(s2);

                const s3 = el('div', 'reach-presence-stat-item');
                const errCount = c.errors || 0;
                const errVal = el('span', 'reach-presence-stat-val', errCount > 0 ? (errCount + ' err') : '100%');
                if (errCount > 0) errVal.style.color = '#ff8f7a';
                s3.appendChild(errVal);
                s3.appendChild(el('span', 'reach-presence-stat-lbl', errCount > 0 ? 'Errors' : 'Success'));
                statsGrid.appendChild(s3);
                card.appendChild(statsGrid);

                // Footer: Last model + Filter button
                const foot = el('div', 'reach-presence-footer');
                const modelBadge = el('span', 'reach-presence-model-badge');
                modelBadge.innerHTML = '<i class="fa-solid fa-cube"></i> ' + (c.last_model || '—');
                foot.appendChild(modelBadge);

                const filterBtn = el('button', 'reach-presence-btn' + (clientFilter === c.ip ? ' active' : ''));
                filterBtn.innerHTML = clientFilter === c.ip ? '<i class="fa-solid fa-check"></i> Filtered' : '<i class="fa-solid fa-filter"></i> Filter Feed';
                filterBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    clientFilter = (clientFilter === c.ip) ? '' : c.ip;
                    renderPresenceCards();
                    renderFeedList();
                });
                foot.appendChild(filterBtn);
                card.appendChild(foot);

                presenceGrid.appendChild(card);
            });

            presCountBadge.textContent = activeCount + ' online · ' + clientsCache.length + ' total';
        }

        // ---- Feed Rendering & Filtering ----
        function filterMatch(entry) {
            if (clientFilter && entry.ip !== clientFilter) return false;
            if (activeFilter === '200') return entry.status === 200;
            if (activeFilter === '429') return entry.status === 429;
            if (activeFilter === 'err') return entry.status >= 400;
            if (activeFilter === 'stream') return !!entry.stream;
            return true;
        }

        function buildFeedItem(entry, isNew) {
            const row = el('div', 'reach-feed-item' + (isNew ? ' reach-feed-item-new' : ''));

            // 1. Time
            const timeStr = (entry.ts || '').includes('T') ? entry.ts.split('T')[1].slice(0, 8) : core.fmtTime(entry.ts);
            const tsSpan = el('span', 'reach-feed-ts', timeStr);
            tsSpan.title = entry.ts || '';
            row.appendChild(tsSpan);

            // 2. Status Badge
            let statusClass = 'reach-feed-status-200';
            let statusText = String(entry.status || 200);
            if (entry.status === 429) {
                statusClass = 'reach-feed-status-429';
                statusText = '429 LMT';
            } else if (entry.status >= 400) {
                statusClass = 'reach-feed-status-err';
                statusText = (entry.status || 'ERR') + ' ERR';
            } else {
                statusText = statusText + ' OK';
            }
            const statusBadge = el('span', 'reach-feed-status ' + statusClass, statusText);
            row.appendChild(statusBadge);

            // 3. Model
            const modelSpan = el('span', 'reach-feed-model');
            const modelIcon = el('i', 'fa-solid fa-cube');
            modelSpan.appendChild(modelIcon);
            modelSpan.appendChild(document.createTextNode(' ' + (entry.model || 'unknown')));
            modelSpan.title = (entry.model || '') + ' → ' + (entry.upstream_model || '');
            row.appendChild(modelSpan);

            // 4. Latency
            const lat = entry.latency_ms;
            let latClass = 'reach-feed-lat-mid';
            if (lat != null) {
                if (lat < 600) latClass = 'reach-feed-lat-fast';
                else if (lat > 2500) latClass = 'reach-feed-lat-slow';
            }
            const latSpan = el('span', 'reach-feed-lat ' + latClass, core.fmtLatency(lat));
            row.appendChild(latSpan);

            // 5. Tokens
            let tokText = '—';
            if (entry.tokens_in != null || entry.tokens_out != null) {
                tokText = core.fmtNum(entry.tokens_in || 0) + ' in / ' + core.fmtNum(entry.tokens_out || 0) + ' out';
            } else if (entry.stream) {
                tokText = 'streaming';
            }
            const tokSpan = el('span', 'reach-feed-tokens', tokText);
            row.appendChild(tokSpan);

            // 6. Meta: stream/cache/ip
            const metaWrap = el('div', 'reach-feed-meta');
            if (entry.stream) {
                const strTag = el('span', 'reach-feed-stream-tag', '⚡ stream');
                metaWrap.appendChild(strTag);
            }
            if (entry.cached) {
                const cTag = el('span', 'reach-feed-cache-tag', '💾 hit');
                metaWrap.appendChild(cTag);
            }
            const ipSpan = el('span', 'reach-feed-ip', entry.ip || '—');
            metaWrap.appendChild(ipSpan);
            if (entry.error) {
                const errIcon = el('i', 'fa-solid fa-triangle-exclamation');
                errIcon.style.color = '#ff8f7a';
                errIcon.title = entry.error;
                metaWrap.appendChild(errIcon);
            }
            row.appendChild(metaWrap);

            return row;
        }

        function renderFeedList() {
            feedList.innerHTML = '';
            const filtered = logsCache.filter(filterMatch);
            feedCountBadge.textContent = filtered.length + ' event' + (filtered.length === 1 ? '' : 's');
            if (!filtered.length) {
                const empty = el('div', 'reach-feed-empty', 'No requests match current filter.');
                feedList.appendChild(empty);
                return;
            }
            filtered.forEach(item => {
                feedList.appendChild(buildFeedItem(item, false));
            });
        }

        // ---- Chart Bar Updater ----
        function updateChartBars(chartEl, series, valueKey, color) {
            chartEl.innerHTML = '';
            const seriesCopy = series.slice(-24);
            const max = Math.max(1, ...seriesCopy.map(s => s[valueKey] || 0));
            seriesCopy.forEach(s => {
                const col = el('div', 'reach-chart-col');
                const bar = el('div', 'reach-chart-bar' + (color ? ' reach-chart-' + color : ''));
                const val = s[valueKey] || 0;
                bar.style.height = Math.max(2, Math.round((val / max) * 100)) + '%';
                col.appendChild(bar);
                col.appendChild(el('span', 'reach-chart-x', core.fmtHour(s.hour)));

                // Rich Tooltip
                const tooltip = el('div', 'reach-chart-tooltip');
                tooltip.appendChild(el('strong', null, core.fmtHour(s.hour) + ' (' + s.hour.slice(0, 10) + ')'));
                tooltip.appendChild(el('span', null, core.fmtNum(val) + ' ' + valueKey));
                if (s.errors != null && s.errors > 0) {
                    const errLine = el('span', null, s.errors + ' error' + (s.errors === 1 ? '' : 's'));
                    errLine.style.color = '#ff8f7a';
                    tooltip.appendChild(errLine);
                }
                col.appendChild(tooltip);
                chartEl.appendChild(col);
            });
        }

        // ---- Main Data Tick ----
        function tick(force) {
            if (isPaused && !force) return Promise.resolve();

            return Promise.all([
                core.relayFetch('/_reach/stats', undefined, 4000).then(r => (r.ok ? r.json() : null)),
                core.relayFetch('/_reach/logs?limit=40', undefined, 4000).then(r => (r.ok ? r.json() : null))
            ]).then(([snap, logsData]) => {
                if (!snap) return;
                const stats = snap.stats || {};
                const today = snap.today || stats.today || {};
                const hourly = stats.hourly || [];
                const byModel = stats.by_model || [];
                const topClients = stats.top_clients || [];

                // Velocity computation
                const now = Date.now();
                const dt = Math.max(0.8, (now - lastTickAt) / 1000);
                lastTickAt = now;
                const curReq = today.requests || 0;
                const curTok = (today.tokens_in || 0) + (today.tokens_out || 0);

                let velocityRps = '0.0';
                let velocityTps = 0;
                if (prevReqCount !== null) {
                    const dReq = Math.max(0, curReq - prevReqCount);
                    velocityRps = (dReq / dt).toFixed(1);
                    const dTok = Math.max(0, curTok - prevTokCount);
                    velocityTps = Math.round(dTok / dt);
                }
                prevReqCount = curReq;
                prevTokCount = curTok;

                // Update KPI Tiles
                const total24hReq = hourly.reduce((a, h) => a + (h.requests || 0), 0);
                const total24hTok = hourly.reduce((a, h) => a + (h.tokens_out || 0), 0);

                const reqValNode = reqTile.querySelector('.reach-tile-value');
                const reqSubNode = reqTile.querySelector('.reach-tile-sub');
                if (reqValNode) reqValNode.textContent = core.fmtNum(total24hReq);
                if (reqSubNode) {
                    reqSubNode.innerHTML = core.fmtNum(curReq) + ' today <span class="reach-velocity-badge">' + velocityRps + ' req/s</span>';
                }

                const tokValNode = tokTile.querySelector('.reach-tile-value');
                const tokSubNode = tokTile.querySelector('.reach-tile-sub');
                if (tokValNode) tokValNode.textContent = core.fmtNum(total24hTok);
                if (tokSubNode) {
                    tokSubNode.textContent = core.fmtNum(today.tokens_in || 0) + ' in · ' + core.fmtNum(today.tokens_out || 0) + ' out' + (velocityTps > 0 ? ' (' + velocityTps + ' tps)' : '');
                }

                const latValNode = latTile.querySelector('.reach-tile-value');
                const latSubNode = latTile.querySelector('.reach-tile-sub');
                if (latValNode) latValNode.textContent = core.fmtLatency(today.avg_latency_ms);
                if (latSubNode) latSubNode.textContent = 'p95 ' + core.fmtLatency(snap.p95_latency_ms || today.avg_latency_ms);

                const errValNode = errTile.querySelector('.reach-tile-value');
                const errSubNode = errTile.querySelector('.reach-tile-sub');
                const errRate = curReq ? Math.round(100 * (today.errors || 0) / curReq) : 0;
                if (errValNode) errValNode.textContent = errRate + '%';
                if (errSubNode) errSubNode.textContent = core.fmtNum(today.rate_limited || 0) + ' rate-limited';
                errTile.className = 'reach-tile' + (errRate > 0 ? ' reach-tile-bad' : ' reach-tile-good');

                // Update Client Presence Cache (Merge topClients + fresh logs)
                const clientMap = new Map();
                topClients.forEach(c => {
                    clientMap.set(c.ip, {
                        ip: c.ip,
                        requests: c.requests || 0,
                        tokens_in: c.tokens_in || 0,
                        tokens_out: c.tokens_out || 0,
                        errors: c.errors || 0,
                        last_seen: c.last_seen || null,
                        last_model: c.last_model || null,
                        user_agent: c.user_agent || null
                    });
                });

                if (logsData && Array.isArray(logsData.logs)) {
                    logsData.logs.forEach(l => {
                        if (!l.ip) return;
                        const existing = clientMap.get(l.ip);
                        if (!existing) {
                            clientMap.set(l.ip, {
                                ip: l.ip,
                                requests: 1,
                                tokens_in: l.tokens_in || 0,
                                tokens_out: l.tokens_out || 0,
                                errors: (l.status >= 400) ? 1 : 0,
                                last_seen: l.ts,
                                last_model: l.model,
                                user_agent: l.user_agent
                            });
                        } else {
                            if (!existing.last_seen || l.ts > existing.last_seen) {
                                existing.last_seen = l.ts;
                                existing.last_model = l.model;
                                if (l.user_agent) existing.user_agent = l.user_agent;
                            }
                        }
                    });
                }
                clientsCache = Array.from(clientMap.values()).sort((a, b) => (b.last_seen || '').localeCompare(a.last_seen || ''));
                renderPresenceCards();

                // Update Live Feed with incoming items
                if (logsData && Array.isArray(logsData.logs)) {
                    const newLogs = logsData.logs;
                    if (isInitialMount) {
                        logsCache = newLogs;
                        newLogs.forEach(l => seenLogIds.add(l.id));
                        renderFeedList();
                    } else {
                        // Find freshly arrived items that weren't in seenLogIds
                        const freshItems = [];
                        newLogs.forEach(l => {
                            if (!seenLogIds.has(l.id)) {
                                freshItems.push(l);
                                seenLogIds.add(l.id);
                            }
                        });
                        if (freshItems.length > 0) {
                            logsCache = freshItems.concat(logsCache).slice(0, 100);
                            // Prepend matching fresh items to the live feed with flash effect
                            const emptyPlaceholder = feedList.querySelector('.reach-feed-empty');
                            if (emptyPlaceholder) emptyPlaceholder.remove();

                            freshItems.reverse().forEach(fresh => {
                                if (filterMatch(fresh)) {
                                    const elRow = buildFeedItem(fresh, true);
                                    feedList.insertBefore(elRow, feedList.firstChild);
                                }
                            });
                            // Cap visible elements to 50
                            while (feedList.children.length > 50) {
                                feedList.lastChild.remove();
                            }
                            const currentFilteredCount = logsCache.filter(filterMatch).length;
                            feedCountBadge.textContent = currentFilteredCount + ' event' + (currentFilteredCount === 1 ? '' : 's');
                        }
                    }
                }

                // Update 24h Hourly Charts
                updateChartBars(reqChart, hourly, 'requests', 'gold');
                updateChartBars(tokChart, hourly, 'tokens_out', 'green');

                // Update Model Traffic Share Bar & Table
                const totalModelReq = byModel.reduce((sum, m) => sum + (m.requests || 0), 0) || 1;
                shareBar.innerHTML = '';
                shareLegend.innerHTML = '';
                modelTbody.innerHTML = '';

                const colors = ['#ffd37a', '#62d8ea', '#ba8fff', '#7ce8a0', '#ff8f7a'];
                byModel.forEach((m, idx) => {
                    const pct = Math.max(0, Math.round(((m.requests || 0) / totalModelReq) * 100));
                    const segColor = colors[idx % colors.length];

                    // Segment
                    if (pct > 0) {
                        const seg = el('div', 'reach-model-share-seg reach-model-seg-' + (idx % 5));
                        seg.style.width = pct + '%';
                        seg.title = m.model + ': ' + pct + '% (' + core.fmtNum(m.requests) + ' reqs)';
                        shareBar.appendChild(seg);
                    }

                    // Legend item
                    const leg = el('div', 'reach-model-legend-item');
                    const dot = el('span', 'reach-model-legend-dot');
                    dot.style.background = segColor;
                    leg.appendChild(dot);
                    leg.appendChild(document.createTextNode(m.model + ' (' + pct + '%)'));
                    shareLegend.appendChild(leg);

                    // Table row
                    const tr = document.createElement('tr');
                    tr.appendChild(el('td', null, m.model));
                    tr.appendChild(el('td', null, pct + '%'));
                    tr.appendChild(el('td', null, core.fmtNum(m.requests)));
                    tr.appendChild(el('td', null, core.fmtNum(m.tokens_in)));
                    tr.appendChild(el('td', null, core.fmtNum(m.tokens_out)));
                    modelTbody.appendChild(tr);
                });
                if (!byModel.length) {
                    const tr = document.createElement('tr');
                    const td = el('td', 'reach-copy', 'No traffic today yet');
                    td.colSpan = 5;
                    tr.appendChild(td);
                    modelTbody.appendChild(tr);
                }

                // Update Top Clients Table
                clientsTbody.innerHTML = '';
                topClients.forEach(c => {
                    const tr = document.createElement('tr');
                    tr.appendChild(el('td', null, c.ip));
                    tr.appendChild(el('td', null, core.fmtNum(c.requests)));
                    tr.appendChild(el('td', null, core.fmtNum(c.tokens_out)));
                    clientsTbody.appendChild(tr);
                });
                if (!topClients.length) {
                    const tr = document.createElement('tr');
                    const td = el('td', 'reach-copy', 'No client connections today yet');
                    td.colSpan = 3;
                    tr.appendChild(td);
                    clientsTbody.appendChild(tr);
                }

                isInitialMount = false;
            }).catch(err => {
                liveDot.classList.add('error');
                liveBadge.textContent = 'OFFLINE';
                liveBadge.style.background = 'rgba(231, 76, 60, 0.16)';
                liveBadge.style.color = '#ff8f7a';
                liveBadge.style.borderColor = 'rgba(231, 76, 60, 0.35)';
            });
        }

        function resetTimer() {
            if (timer) clearInterval(timer);
            timer = setInterval(() => tick(false), cadenceMs);
        }

        tick(true);
        resetTimer();

        // 1-second interval to update relative timestamps smoothly
        clockTimer = setInterval(() => {
            if (!isPaused && showPresence && clientsCache.length) {
                renderPresenceCards();
            }
        }, 2000);

        return () => {
            if (timer) clearInterval(timer);
            if (clockTimer) clearInterval(clockTimer);
        };
    }

    /* ------------------------------------------------------------------ LOGS */
    function renderLogs(container) {
        container.appendChild(pageHeader('fa-list', 'Logs',
            'Recent requests through the relay (local store).'));
        const body = el('div', 'reach-stack');
        container.appendChild(body);
        let timer = null;
        let limit = 100;
        let statusFilter = '';
        let modelFilter = '';

        function draw() {
            const params = new URLSearchParams({ limit: String(limit) });
            if (statusFilter) params.set('status', statusFilter);
            if (modelFilter) params.set('model', modelFilter);
            core.relayFetch('/_reach/logs?' + params.toString(), undefined, 4000)
                .then(res => (res.ok ? res.json() : Promise.reject(new Error('HTTP ' + res.status))))
                .then(data => {
                    const logs = data.logs || [];
                    body.innerHTML = '';
                    const toolbar = el('div', 'reach-toolbar');
                    const statusSel = document.createElement('select');
                    statusSel.className = 'reach-input reach-input-sm';
                    ['', '2*', '4*', '429', '5*'].forEach(v => {
                        const opt = document.createElement('option');
                        opt.value = v;
                        opt.textContent = v === '' ? 'All statuses' : v;
                        if (v === statusFilter) opt.selected = true;
                        statusSel.appendChild(opt);
                    });
                    statusSel.addEventListener('change', () => { statusFilter = statusSel.value; draw(); });
                    toolbar.appendChild(statusSel);
                    const modelInput = document.createElement('input');
                    modelInput.className = 'reach-input reach-input-sm';
                    modelInput.placeholder = 'model filter (gpt-4o*)';
                    modelInput.value = modelFilter;
                    modelInput.addEventListener('change', () => { modelFilter = modelInput.value.trim(); draw(); });
                    toolbar.appendChild(modelInput);
                    const refreshBtn = el('button', 'reach-btn', 'Refresh');
                    refreshBtn.addEventListener('click', draw);
                    toolbar.appendChild(refreshBtn);
                    const clearBtn = el('button', 'reach-btn reach-btn-danger', 'Clear');
                    clearBtn.addEventListener('click', () => {
                        core.relayFetch('/_reach/logs', { method: 'DELETE' }, 5000)
                            .then(() => { toast('Cleared ✓', 'ok'); draw(); });
                    });
                    toolbar.appendChild(clearBtn);
                    const count = el('span', 'reach-hint', logs.length + ' rows');
                    toolbar.appendChild(count);
                    body.appendChild(toolbar);

                    const table = el('table', 'reach-table reach-table-logs');
                    table.innerHTML = '<thead><tr><th>Time</th><th>IP</th><th>Model</th><th>Status</th><th>Latency</th><th>In</th><th>Out</th><th>Error</th></tr></thead>';
                    const tbody = document.createElement('tbody');
                    logs.forEach(entry => {
                        const tr = document.createElement('tr');
                        tr.appendChild(el('td', 'reach-nowrap', core.fmtTime(entry.ts)));
                        tr.appendChild(el('td', null, entry.ip || '?'));
                        tr.appendChild(el('td', null, entry.model || '—'));
                        const statusTd = el('td', null, String(entry.status || '—'));
                        if (entry.status >= 500) statusTd.className = 'reach-kv-bad';
                        else if (entry.status >= 400) statusTd.className = 'reach-kv-warn';
                        else statusTd.className = 'reach-kv-ok';
                        tr.appendChild(statusTd);
                        tr.appendChild(el('td', null, core.fmtLatency(entry.latency_ms)));
                        tr.appendChild(el('td', null, entry.tokens_in == null ? '·' : core.fmtNum(entry.tokens_in)));
                        tr.appendChild(el('td', null, entry.tokens_out == null ? '·' : core.fmtNum(entry.tokens_out)));
                        tr.appendChild(el('td', 'reach-err', entry.error || ''));
                        tbody.appendChild(tr);
                    });
                    if (!logs.length) {
                        const tr = document.createElement('tr');
                        const td = el('td', 'reach-copy', 'No matching requests');
                        td.colSpan = 8;
                        tr.appendChild(td);
                        tbody.appendChild(tr);
                    }
                    table.appendChild(tbody);
                    body.appendChild(table);
                })
                .catch(err => {
                    body.innerHTML = '';
                    body.appendChild(el('div', 'reach-banner reach-banner-off', 'Logs unavailable: ' + err.message));
                });
        }

        draw();
        timer = setInterval(draw, 10000);
        return () => { if (timer) clearInterval(timer); };
    }

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
        const exportBtn = el('button', 'reach-btn', 'Export');
        const importBtn = el('button', 'reach-btn', 'Import');
        const importInput = document.createElement('input');
        importInput.type = 'file';
        importInput.accept = '.json,application/json';
        importInput.style.display = 'none';
        const resetBtn = el('button', 'reach-btn reach-btn-danger', 'Reset defaults');
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
            const rm = el('button', 'reach-btn reach-btn-danger', 'Remove');
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
            const submit = el('button', 'reach-btn reach-btn-primary', 'Add');
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
            const clearCacheBtn = el('button', 'reach-btn', 'Clear cache');
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
            const pubBtn = el('button', 'reach-btn', 'Publish now');
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
        facts.appendChild(el('header', 'reach-card-head', 'Facts'));
        const dl = el('dl', 'reach-kv');
        kv(dl, 'Plugin', 'SimpleREACH v' + core.store.version);
        kv(dl, 'Repository', core.REPO_URL);
        kv(dl, 'License', 'MIT');
        kv(dl, 'Author', 'Michael Anthony Falabella');
        kv(dl, 'Relay', 'stdlib-only Python — no dependencies');
        kv(dl, 'Plugin install', 'local-extension registry — zero SimpleRAG files touched');
        facts.appendChild(dl);
        body.appendChild(facts);

        const privacy = el('section', 'reach-card');
        privacy.appendChild(el('header', 'reach-card-head', 'Privacy & availability'));
        privacy.appendChild(el('p', 'reach-copy', 'Requests are logged locally (IP, model, tokens, latency) for the Usage and Logs pages and pruned on the configured retention. The OmniRoute key never leaves this machine. Availability rides on the host\'s free codegpt tier — rate limits in Settings keep it fair for everyone.'));
        body.appendChild(privacy);

        return () => {};
    }

    window.__reachPages = Object.freeze({
        defs: PAGE_DEFS,
        dashboard: renderDashboard,
        endpoint: renderEndpoint,
        models: renderModels,
        usage: renderUsage,
        logs: renderLogs,
        settings: renderSettings,
        about: renderAbout
    });
})();
