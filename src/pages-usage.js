/*
 * SignalR.E.A.C.H pages — Usage renderer.
 * Registers window.__reachPageRegistry.usage.
 * Depends on window.__reachCore (reach-core.js) and
 * window.__reachPageWidgets (pages-common.js).
 */
(function initReachPageUsage() {
    'use strict';

    const core = window.__reachCore;
    if (!core) {
        console.error('[signal-reach] reach-core.js missing — re-run install.');
        return;
    }
    const { el, toast } = core;
    const { pageHeader, statTile } =
        window.__reachPageWidgets;

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

    window.__reachPageRegistry.usage = renderUsage;
})();
