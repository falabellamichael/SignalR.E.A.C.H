/*
 * SimpleREACH pages — Dashboard renderer.
 * Registers window.__reachPageRegistry.dashboard.
 * Depends on window.__reachCore (reach-core.js) and
 * window.__reachPageWidgets (pages-common.js).
 */
(function initReachPageDashboard() {
    'use strict';

    const core = window.__reachCore;
    if (!core) {
        console.error('[simple-reach] reach-core.js missing — re-run install.');
        return;
    }
    const { el, toast } = core;
    const { pageHeader, statTile, chip, kv, publishNow } =
        window.__reachPageWidgets;

    /* ------------------------------------------------------------- DASHBOARD */
    /* ------------------------------------------------------------- DASHBOARD */
    function renderDashboard(container) {
        container.appendChild(pageHeader('fa-gauge-high', 'Dashboard',
            'Live health of the hosted endpoint, the relay, and the upstream.'));
        const body = el('div', 'reach-dash');
        container.appendChild(body);
        let timer = null;

        // References for zero-flicker in-place updates
        let dom = null;

        function buildDashboardDOM() {
            body.innerHTML = '';

            // Stat tiles
            const tiles = el('div', 'reach-tiles');
            const tileReqs = statTile('Requests today', '—', 'all clients', '');
            const tileTokens = statTile('Tokens today', '—', '0 in · 0 out', '');
            const tileSpeed = statTile('Tokens / sec', '—', 'live generation', 'good');
            const tileLatency = statTile('Avg latency', '—', 'p95 —', '');
            const tileErrors = statTile('Errors today', '—', '0 rate-limited', 'good');
            tiles.appendChild(tileReqs);
            tiles.appendChild(tileTokens);
            tiles.appendChild(tileSpeed);
            tiles.appendChild(tileLatency);
            tiles.appendChild(tileErrors);
            body.appendChild(tiles);

            // Dashboard Grid
            const grid = el('div', 'reach-dash-grid');

            // Card 1: Public Endpoint
            const cEndpoint = dashCard('Public endpoint', () => {
                const wrap = el('div', 'reach-card-body');
                const row = el('div', 'reach-url-row');
                const code = el('code', 'reach-url', core.store.pointerUrl || 'resolving…');
                row.appendChild(code);
                const copyBtn = el('button', 'reach-btn reach-btn-sm', 'Copy');
                copyBtn.addEventListener('click', () => {
                    if (core.store.pointerUrl) {
                        core.copyText(core.store.pointerUrl).then(ok => toast(ok ? 'Copied ✓' : 'Copy failed', ok ? 'ok' : 'error'));
                    }
                });
                row.appendChild(copyBtn);
                wrap.appendChild(row);

                const meta = el('div', 'reach-meta-row');
                const metaModel = chip('model: gpt-4o');
                const metaStream = chip('streaming ✓');
                const metaAuth = chip('no API key');
                meta.appendChild(metaModel);
                meta.appendChild(metaStream);
                meta.appendChild(metaAuth);
                wrap.appendChild(meta);

                const foot = el('div', 'reach-card-foot');
                const testBtn = el('button', 'reach-btn reach-btn-primary reach-btn-sm', 'Test endpoint');
                testBtn.addEventListener('click', () => runPublicTest(testBtn, wrap));
                foot.appendChild(testBtn);
                const hint = el('span', 'reach-hint', '1-token test through public tunnel');
                foot.appendChild(hint);
                wrap.appendChild(foot);

                const result = el('div', 'reach-result', '');
                result.hidden = true;
                wrap.appendChild(result);
                return wrap;
            });
            grid.appendChild(cEndpoint);

            // Card 2: Relay
            const cRelay = dashCard('Relay', () => {
                const wrap = el('div', 'reach-card-body');
                const dl = el('dl', 'reach-kv');
                kv(dl, 'Status', 'checking…', 'ok');
                kv(dl, 'Port', ':20777');
                kv(dl, 'Uptime', '—');
                kv(dl, 'Tunnel', 'checking…');
                kv(dl, 'Rate limiting', 'on');
                wrap.appendChild(dl);
                return wrap;
            });
            grid.appendChild(cRelay);

            // Card 3: Upstream (OmniRoute) with Live Ping Meter
            const cUpstream = dashCard('Upstream (OmniRoute)', () => {
                const wrap = el('div', 'reach-card-body');
                const dl = el('dl', 'reach-kv');
                kv(dl, 'Health', 'checking…', 'ok');
                kv(dl, 'Circuit', 'closed', 'ok');
                kv(dl, 'Target', '127.0.0.1:20128');
                wrap.appendChild(dl);

                // Meter Bar
                const meterLabelRow = el('div', 'reach-stat-meta-row');
                meterLabelRow.appendChild(el('span', 'reach-hint', 'Upstream Responsiveness'));
                const meterVal = el('span', 'reach-hint', '—');
                meterVal.id = 'reach-dash-meter-val';
                meterLabelRow.appendChild(meterVal);
                wrap.appendChild(meterLabelRow);

                const meterBar = el('div', 'reach-meter-bar');
                const meterFill = el('div', 'reach-meter-fill');
                meterFill.style.width = '30%';
                meterBar.appendChild(meterFill);
                wrap.appendChild(meterBar);

                const foot = el('div', 'reach-card-foot');
                const pingBtn = el('button', 'reach-btn reach-btn-sm reach-btn-primary');
                pingBtn.innerHTML = '<i class="fa-solid fa-bolt"></i> Ping Upstream';
                foot.appendChild(pingBtn);
                const pingTag = el('span', 'reach-hint', 'Direct check via /_reach/test');
                foot.appendChild(pingTag);
                wrap.appendChild(foot);

                pingBtn.addEventListener('click', () => {
                    pingBtn.disabled = true;
                    pingTag.textContent = 'Pinging…';
                    core.relayFetch('/_reach/test', { method: 'POST' }, 20000)
                        .then(r => r.json())
                        .then(d => {
                            if (d.ok) {
                                pingTag.textContent = '✓ ' + core.fmtLatency(d.latency_ms) + ' (' + (d.model || 'gpt-4o') + ')';
                                toast('Upstream reachable: ' + core.fmtLatency(d.latency_ms), 'ok');
                                if (meterFill) meterFill.style.width = Math.min(100, Math.max(10, Math.round(d.latency_ms / 15))) + '%';
                            } else {
                                pingTag.textContent = '✗ ' + (d.error || 'Failed');
                                toast('Upstream test: ' + (d.error || 'Failed'), 'error');
                            }
                        })
                        .catch(err => {
                            pingTag.textContent = '✗ ' + err.message;
                            toast('Ping failed: ' + err.message, 'error');
                        })
                        .finally(() => { pingBtn.disabled = false; });
                });

                return wrap;
            });
            grid.appendChild(cUpstream);

            // Card 4: Quick Navigation Jumps
            const cJumps = dashCard('Quick Jumps', () => {
                const wrap = el('div', 'reach-card-body');
                const jumpGrid = el('div', 'reach-dash-jump-grid');

                const jumps = [
                    { id: 'endpoint', icon: 'fa-terminal', label: 'API Playground' },
                    { id: 'models', icon: 'fa-cubes', label: 'Model Aliases' },
                    { id: 'usage', icon: 'fa-chart-column', label: 'Live Feeds' },
                    { id: 'logs', icon: 'fa-list', label: 'Request Logs' }
                ];

                jumps.forEach(j => {
                    const btn = el('button', 'reach-dash-jump-btn');
                    btn.innerHTML = '<i class="fa-solid ' + j.icon + '"></i><span>' + j.label + '</span>';
                    btn.addEventListener('click', () => {
                        if (window.simpleReach && typeof window.simpleReach.switchPage === 'function') {
                            window.simpleReach.switchPage(j.id, true);
                        }
                    });
                    jumpGrid.appendChild(btn);
                });
                wrap.appendChild(jumpGrid);

                const actRow = el('div', 'reach-actions');
                actRow.style.marginTop = '6px';
                actRow.appendChild(actionBtn('fa-cloud-arrow-up', 'Publish pointer URL',
                    () => publishNow().then(() => toast('Published ✓', 'ok'))));
                actRow.appendChild(actionBtn('fa-trash-can', 'Clear request log',
                    () => core.relayFetch('/_reach/logs', { method: 'DELETE' }, 5000)
                        .then(() => toast('Log cleared ✓', 'ok'))));
                wrap.appendChild(actRow);

                return wrap;
            });
            grid.appendChild(cJumps);

            body.appendChild(grid);

            dom = {
                tileReqs,
                tileTokens,
                tileSpeed,
                tileLatency,
                tileErrors,
                urlCode: cEndpoint.querySelector('code.reach-url'),
                metaModel: cEndpoint.querySelectorAll('.reach-chip')[0],
                relayDl: cRelay.querySelector('dl.reach-kv'),
                upstreamDl: cUpstream.querySelector('dl.reach-kv'),
                meterFill: cUpstream.querySelector('.reach-meter-fill'),
                meterVal: cUpstream.querySelector('#reach-dash-meter-val')
            };
        }

        function update() {
            const snap = core.store.local;
            if (!snap) {
                if (!body.querySelector('.reach-banner-off')) {
                    body.innerHTML = '';
                    const offline = el('div', 'reach-banner reach-banner-off');
                    offline.appendChild(el('strong', null, 'Relay offline on this machine. '));
                    offline.appendChild(document.createTextNode(
                        'The hosted endpoint keeps working as long as the relay + tunnel run somewhere — '
                        + 'but live stats are unavailable right now. Check Settings → Tunnel.'));
                    body.appendChild(offline);
                    dom = null;
                }
                return;
            }

            // If not built yet, construct once
            if (!dom || !body.querySelector('.reach-dash-grid')) {
                buildDashboardDOM();
            }

            const today = snap.today || {};

            // Patch tiles in-place without flicker
            const reqVal = dom.tileReqs.querySelector('.reach-tile-value');
            if (reqVal) reqVal.textContent = core.fmtNum(today.requests);

            const tokVal = dom.tileTokens.querySelector('.reach-tile-value');
            const tokSub = dom.tileTokens.querySelector('.reach-tile-sub');
            if (tokVal) tokVal.textContent = core.fmtNum((today.tokens_in || 0) + (today.tokens_out || 0));
            if (tokSub) tokSub.textContent = core.fmtNum(today.tokens_in || 0) + ' in · ' + core.fmtNum(today.tokens_out || 0) + ' out';

            const speedVal = dom.tileSpeed ? dom.tileSpeed.querySelector('.reach-tile-value') : null;
            const speedSub = dom.tileSpeed ? dom.tileSpeed.querySelector('.reach-tile-sub') : null;
            const liveTps = (today.tokens_per_sec != null && today.tokens_per_sec > 0)
                ? today.tokens_per_sec
                : (snap.tokens_per_sec || 0);
            if (speedVal) speedVal.textContent = liveTps > 0 ? (liveTps + ' tps') : '—';
            if (speedSub) speedSub.textContent = liveTps > 0 ? '⚡ live generation' : 'awaiting traffic';

            const latVal = dom.tileLatency.querySelector('.reach-tile-value');
            const latSub = dom.tileLatency.querySelector('.reach-tile-sub');
            if (latVal) latVal.textContent = core.fmtLatency(today.avg_latency_ms);
            if (latSub) latSub.textContent = 'p95 ' + core.fmtLatency(snap.p95_latency_ms);

            const errVal = dom.tileErrors.querySelector('.reach-tile-value');
            const errSub = dom.tileErrors.querySelector('.reach-tile-sub');
            if (errVal) errVal.textContent = core.fmtNum(today.errors);
            if (errSub) errSub.textContent = core.fmtNum(today.rate_limited || 0) + ' rate-limited';
            dom.tileErrors.className = 'reach-tile ' + ((today.errors || 0) > 0 ? 'reach-tile-bad' : 'reach-tile-good');

            // Patch URL code
            if (dom.urlCode) {
                dom.urlCode.textContent = core.store.pointerUrl || ('http://127.0.0.1:' + (snap.port || 20777) + '/v1');
            }
            if (dom.metaModel && snap.models) {
                dom.metaModel.textContent = 'models: ' + snap.models.join(', ');
            }

            // Patch Relay KV
            if (dom.relayDl) {
                const dds = dom.relayDl.querySelectorAll('dd');
                if (dds[0]) {
                    dds[0].textContent = 'running v' + snap.version;
                    dds[0].className = snap.ok ? 'reach-kv-ok' : 'reach-kv-bad';
                }
                if (dds[1]) dds[1].textContent = ':' + (snap.port || 20777);
                if (dds[2]) dds[2].textContent = core.fmtUptime(snap.uptime_s);
                if (dds[3]) dds[3].textContent = snap.public_url_source || 'ngrok';
                if (dds[4]) dds[4].textContent = (snap.rate_limits && snap.rate_limits.enabled) ? 'on' : 'off';
            }

            // Patch Upstream KV
            if (dom.upstreamDl) {
                const dds = dom.upstreamDl.querySelectorAll('dd');
                if (dds[0]) {
                    dds[0].textContent = snap.upstream_ok ? 'healthy' : 'DOWN';
                    dds[0].className = snap.upstream_ok ? 'reach-kv-ok' : 'reach-kv-bad';
                }
                if (dds[1]) {
                    dds[1].textContent = snap.circuit_open ? 'OPEN (cool-down)' : 'closed';
                    dds[1].className = snap.circuit_open ? 'reach-kv-bad' : 'reach-kv-ok';
                }
                if (dds[2]) dds[2].textContent = String(snap.upstream || '127.0.0.1:20128');
            }

            // Patch Upstream Meter
            if (dom.meterVal) {
                dom.meterVal.textContent = core.fmtLatency(today.avg_latency_ms);
            }
            if (dom.meterFill && today.avg_latency_ms) {
                dom.meterFill.style.width = Math.min(100, Math.max(15, Math.round(today.avg_latency_ms / 20))) + '%';
            }
        }

        update();
        timer = setInterval(() => core.refreshLocal().then(update), 8000);
        return () => { if (timer) clearInterval(timer); };
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

    window.__reachPageRegistry.dashboard = renderDashboard;
})();
