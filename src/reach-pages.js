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
            table.innerHTML = '<thead><tr><th>Public alias</th><th>Upstream model</th><th>Enabled</th><th></th></tr></thead>';
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
        container.appendChild(pageHeader('fa-chart-column', 'Usage',
            'Traffic through the public endpoint — requests, tokens, latency.'));
        const body = el('div', 'reach-stack');
        container.appendChild(body);
        let timer = null;

        function bars(title, series, valueKey, color) {
            const card = el('section', 'reach-card');
            card.appendChild(el('header', 'reach-card-head', title));
            const chart = el('div', 'reach-chart');
            const max = Math.max(1, ...series.map(s => s[valueKey] || 0));
            const seriesCopy = series.slice(-24);
            seriesCopy.forEach(s => {
                const col = el('div', 'reach-chart-col');
                const bar = el('div', 'reach-chart-bar' + (color ? ' reach-chart-' + color : ''));
                bar.style.height = Math.max(2, Math.round(((s[valueKey] || 0) / max) * 100)) + '%';
                bar.title = core.fmtHour(s.hour) + ': ' + core.fmtNum(s[valueKey]) + ' ' + valueKey;
                col.appendChild(bar);
                col.appendChild(el('span', 'reach-chart-x', core.fmtHour(s.hour)));
                chart.appendChild(col);
            });
            card.appendChild(chart);
            return card;
        }

        function draw() {
            core.relayFetch('/_reach/stats', undefined, 4000)
                .then(res => (res.ok ? res.json() : Promise.reject(new Error('HTTP ' + res.status))))
                .then(snap => {
                    const stats = snap.stats || {};
                    const today = snap.today || stats.today || {};
                    body.innerHTML = '';
                    const tiles = el('div', 'reach-tiles');
                    tiles.appendChild(statTile('Requests (24h)', core.fmtNum((stats.hourly || []).reduce((a, h) => a + h.requests, 0))));
                    tiles.appendChild(statTile('Tokens out (24h)', core.fmtNum((stats.hourly || []).reduce((a, h) => a + h.tokens_out, 0))));
                    tiles.appendChild(statTile('Avg latency (today)', core.fmtLatency(today.avg_latency_ms)));
                    tiles.appendChild(statTile('Error rate', ((today.requests || 0) ? Math.round(100 * today.errors / today.requests) : 0) + '%',
                        core.fmtNum(today.rate_limited || 0) + ' rate-limited', (today.errors || 0) > 0 ? 'bad' : 'good'));
                    body.appendChild(tiles);
                    body.appendChild(bars('Requests per hour (last 24h)', stats.hourly || [], 'requests', 'gold'));
                    body.appendChild(bars('Tokens out per hour (last 24h)', stats.hourly || [], 'tokens_out', 'green'));

                    const grid = el('div', 'reach-dash-grid');
                    const byModel = el('section', 'reach-card');
                    byModel.appendChild(el('header', 'reach-card-head', 'By model (today)'));
                    const table = el('table', 'reach-table');
                    table.innerHTML = '<thead><tr><th>Model</th><th>Requests</th><th>Tokens in</th><th>Tokens out</th></tr></thead>';
                    const tbody = document.createElement('tbody');
                    (stats.by_model || []).forEach(m => {
                        const tr = document.createElement('tr');
                        tr.appendChild(el('td', null, m.model));
                        tr.appendChild(el('td', null, core.fmtNum(m.requests)));
                        tr.appendChild(el('td', null, core.fmtNum(m.tokens_in)));
                        tr.appendChild(el('td', null, core.fmtNum(m.tokens_out)));
                        tbody.appendChild(tr);
                    });
                    if (!(stats.by_model || []).length) {
                        tbody.appendChild(el('tr', null, ''));
                        tbody.lastChild.appendChild(el('td', 'reach-copy', 'No traffic today yet'));
                    }
                    table.appendChild(tbody);
                    byModel.appendChild(table);
                    grid.appendChild(byModel);

                    const clients = el('section', 'reach-card');
                    clients.appendChild(el('header', 'reach-card-head', 'Top clients (today)'));
                    const ctable = el('table', 'reach-table');
                    ctable.innerHTML = '<thead><tr><th>Client IP</th><th>Requests</th><th>Tokens out</th></tr></thead>';
                    const cbody = document.createElement('tbody');
                    (stats.top_clients || []).forEach(c => {
                        const tr = document.createElement('tr');
                        tr.appendChild(el('td', null, c.ip));
                        tr.appendChild(el('td', null, core.fmtNum(c.requests)));
                        tr.appendChild(el('td', null, core.fmtNum(c.tokens_out)));
                        cbody.appendChild(tr);
                    });
                    if (!(stats.top_clients || []).length) {
                        cbody.appendChild(el('tr', null, ''));
                        cbody.lastChild.appendChild(el('td', 'reach-copy', 'No clients yet'));
                    }
                    ctable.appendChild(cbody);
                    clients.appendChild(ctable);
                    grid.appendChild(clients);
                    body.appendChild(grid);
                })
                .catch(err => {
                    body.innerHTML = '';
                    body.appendChild(el('div', 'reach-banner reach-banner-off',
                        'Stats unavailable: ' + err.message));
                });
        }

        draw();
        timer = setInterval(draw, 15000);
        return () => { if (timer) clearInterval(timer); };
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
            'Relay configuration — saved locally, applied instantly.'));
        const body = el('div', 'reach-stack');
        container.appendChild(body);
        const saveBar = el('div', 'reach-save-bar');
        const saveBtn = el('button', 'reach-btn reach-btn-primary', 'Save settings');
        const dirtyNote = el('span', 'reach-hint', '');
        saveBar.appendChild(saveBtn);
        saveBar.appendChild(dirtyNote);
        container.appendChild(saveBar);
        let draft = null;   // current draft (deep copy of settings)
        let base = null;    // last loaded settings

        function markDirty(dirty) {
            core.store.dirty = dirty;
            dirtyNote.textContent = dirty ? 'unsaved changes' : 'all changes saved';
            saveBtn.disabled = !dirty;
        }

        function fieldGet(section, key) {
            return section ? draft[section][key] : draft[key];
        }

        function fieldSet(section, key, value) {
            if (section) draft[section][key] = value;
            else draft[key] = value;
        }

        function input(kind, section, key, label, help) {
            const wrap = el('label', 'reach-field');
            wrap.appendChild(el('span', 'reach-field-label', label));
            const node = document.createElement(kind === 'textarea' ? 'textarea' : 'input');
            node.className = 'reach-input';
            if (kind === 'checkbox') {
                node.type = 'checkbox';
                node.checked = !!fieldGet(section, key);
                node.addEventListener('change', () => {
                    fieldSet(section, key, node.checked);
                    markDirty(true);
                });
            } else if (kind === 'number') {
                node.type = 'number';
                node.value = fieldGet(section, key);
                node.addEventListener('input', () => {
                    fieldSet(section, key, parseInt(node.value, 10) || 0);
                    markDirty(true);
                });
            } else if (kind === 'password') {
                node.type = 'password';
                node.placeholder = fieldGet(section, key) ? '•••••••• (unchanged)' : 'not set';
                node.addEventListener('input', () => {
                    if (node.value.trim()) {
                        fieldSet(section, key, node.value.trim());
                        markDirty(true);
                    }
                });
            } else {
                node.type = 'text';
                node.value = fieldGet(section, key);
                node.addEventListener('input', () => {
                    fieldSet(section, key, node.value.trim());
                    markDirty(true);
                });
            }
            wrap.appendChild(node);
            if (help) wrap.appendChild(el('span', 'reach-field-help', help));
            return wrap;
        }

        function select(section, key, label, options, help) {
            const wrap = el('label', 'reach-field');
            wrap.appendChild(el('span', 'reach-field-label', label));
            const node = document.createElement('select');
            node.className = 'reach-input';
            options.forEach(opt => {
                const o = document.createElement('option');
                o.value = opt;
                o.textContent = opt;
                if (fieldGet(section, key) === opt) o.selected = true;
                node.appendChild(o);
            });
            node.addEventListener('change', () => {
                fieldSet(section, key, node.value);
                markDirty(true);
            });
            wrap.appendChild(node);
            if (help) wrap.appendChild(el('span', 'reach-field-help', help));
            return wrap;
        }

        function section(title, icon) {
            const card = el('section', 'reach-card');
            const head = el('header', 'reach-card-head');
            const i = el('i', 'fa-solid ' + icon);
            i.style.width = '18px';
            head.appendChild(el('h2', null, title));
            card.appendChild(head);
            const grid = el('div', 'reach-form-grid');
            card.appendChild(grid);
            body.appendChild(card);
            return grid;
        }

        function draw() {
            body.innerHTML = '';
            if (!draft) {
                body.appendChild(emptyNote('Relay offline — settings cannot be loaded.'));
                saveBtn.disabled = true;
                return;
            }
            const relay = section('Relay', 'fa-server');
            relay.appendChild(input('number', null, 'port', 'Port', 'Applies on relay restart.'));
            relay.appendChild(select(null, null, 'host', 'Bind host', ['127.0.0.1', 'localhost', '0.0.0.0'], 'Keep 127.0.0.1 — the tunnel handles public traffic.'));
            relay.appendChild(input('text', null, 'omniroute_url', 'OmniRoute URL'));
            relay.appendChild(input('password', null, 'omniroute_key', 'OmniRoute API key', 'Blank keeps the current key.'));
            relay.appendChild(input('number', null, 'upstream_timeout_s', 'Upstream timeout (s)', '10–3600.'));

            const tun = section('Hosting / tunnel', 'fa-tower-broadcast');
            tun.appendChild(select(null, null, 'tunnel', 'Tunnel', ['ngrok', 'cloudflared', 'none']));
            tun.appendChild(input('text', null, 'public_url_override', 'Public URL override', 'Pinned URL (https://…) — otherwise auto-discovered from the tunnel.'));
            tun.appendChild(input('checkbox', 'publish', 'enabled', 'Auto-publish URL to the pointer gist', 'Everyone resolves the endpoint through the pointer.'));
            const pubBtn = el('button', 'reach-btn', 'Publish now');
            pubBtn.addEventListener('click', () => publishNow().then(() => toast('Published ✓', 'ok')).catch(e => toast(e.message, 'error')));
            tun.appendChild(pubBtn);

            const rl = section('Rate limits', 'fa-gauge');
            rl.appendChild(input('checkbox', 'rate_limits', 'enabled', 'Enable rate limiting', 'Protects the free upstream from abuse.'));
            rl.appendChild(input('number', 'rate_limits', 'per_ip_rpm', 'Per-IP requests / minute'));
            rl.appendChild(input('number', 'rate_limits', 'per_ip_tokens_day', 'Per-IP tokens / day', '0 disables the daily budget.'));
            rl.appendChild(input('number', 'rate_limits', 'global_rpm', 'Global requests / minute'));
            rl.appendChild(input('number', 'rate_limits', 'burst', 'Burst allowance'));

            const access = section('Access', 'fa-key');
            access.appendChild(input('checkbox', 'access', 'key_required', 'Require access key', 'Clients then send X-Reach-Key (or Bearer).'));
            access.appendChild(input('password', 'access', 'access_key', 'Access key', 'Blank keeps the current key; min 6 chars when required.'));

            const data = section('Data', 'fa-database');
            data.appendChild(input('number', 'data', 'log_retention_days', 'Log retention (days)', '1–365; pruned hourly.'));
            const clearBtn = el('button', 'reach-btn reach-btn-danger', 'Clear request log now');
            clearBtn.addEventListener('click', () => {
                core.relayFetch('/_reach/logs', { method: 'DELETE' }, 5000)
                    .then(() => toast('Cleared ✓', 'ok'));
            });
            data.appendChild(clearBtn);

            markDirty(false);
        }

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
                    base = draft;
                    core.store.settings = data.settings || draft;
                    markDirty(false);
                } else {
                    toast('Save failed: ' + esc((data && data.error && data.error.message) || ''), 'error');
                }
            }).catch(err => toast('Save failed: ' + err.message, 'error'));
        });

        core.loadSettings().then(cfg => {
            if (cfg) {
                base = cfg;
                draft = JSON.parse(JSON.stringify(cfg));
            }
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
