/*
 * SignalR.E.A.C.H — page controller entrypoint.
 *
 * REACH = RAG Endpoint & AI Chat Host.
 *
 * Implements SimpleRAG's native 3-column architecture via window.RAGWorkspaceExtensions:
 *   - Panel 1 (#nav-pane): Navigation options (Dashboard, Endpoint, Models, Usage, Logs, Settings, About)
 *   - Panel 2 (#list-pane): Stationary controls & settings (Relay status, ping test, hookup, rate limits)
 *   - Panel 3 (#settings-container): Dynamic main content pane corresponding to Panel 1 selection
 *
 * Falls back gracefully to the self-contained 2-column shell if SimpleRAG's 3-panel DOM is unavailable.
 */
(function registerSignalReach() {
    'use strict';

    const PLUGIN_ID = 'signal-reach';
    const PAGE_ID = 'signal-reach.reach-page';
    const APP_ID = 'reach';
    const HOST_STORAGE_KEY = 'ragworkspace_plugins';
    const CONTROLLER_DISPOSE_KEY = '__signalReachControllerDispose';

    const MANIFEST = window.__signalReachManifest || window.__simpleReachManifest;
    const core = window.__reachCore;
    const pages = window.__reachPages;

    if (!MANIFEST || typeof MANIFEST !== 'object') {
        console.error('[signal-reach] manifest.js did not load — re-run "python tools/reach.py install".');
        return;
    }
    if (!core || !pages) {
        console.error('[signal-reach] package incomplete — re-run "python tools/reach.py install".');
        return;
    }

    function showBootFailure(title, detail) {
        try {
            if (typeof document === 'undefined' || !document.body) return;
            if (document.getElementById('signal-reach-boot-failure')) return;
            const panel = document.createElement('div');
            panel.id = 'signal-reach-boot-failure';
            panel.setAttribute('role', 'alert');
            panel.style.cssText = 'margin:18px;padding:14px 16px;max-width:720px;'
                + 'background:#2a1410;border:1px solid #7c2d12;border-radius:8px;'
                + 'color:#ffd7cc;font-family:inherit;font-size:14px;line-height:1.5;';
            const head = document.createElement('div');
            head.style.cssText = 'font-weight:700;margin-bottom:6px;';
            head.textContent = title;
            const body = document.createElement('div');
            body.style.opacity = '0.85';
            body.textContent = detail;
            panel.appendChild(head);
            panel.appendChild(body);
            document.body.appendChild(panel);
        } catch (_e) { /* never let diagnostics break the host */ }
    }

    const host = window.RAGWorkspaceExtensions;
    if (!host || typeof host.registerController !== 'function' || typeof host.registerManifest !== 'function') {
        console.error('[signal-reach] the SimpleRAG extension host is unavailable.');
        showBootFailure(
            "SignalR.E.A.C.H could not start: SimpleRAG's extension host is not available.",
            'This usually means SimpleRAG\'s own bundle failed to load. Check the console, '
            + 'then reload. If the console is clean, re-run "python tools/reach.py install".'
        );
        return;
    }

    const priorDispose = window[CONTROLLER_DISPOSE_KEY];
    if (typeof priorDispose === 'function'
        || (window.simpleReach && window.simpleReach.pluginId === PLUGIN_ID)) {
        return;
    }

    // ------------------------------------------------------------------
    // Host plugin record (localStorage ragworkspace_plugins)
    // ------------------------------------------------------------------
    function readHostRecords() {
        try {
            const raw = localStorage.getItem(HOST_STORAGE_KEY);
            const parsed = raw ? JSON.parse(raw) : [];
            return { error: null, records: Array.isArray(parsed) ? parsed : [], raw: raw };
        } catch (err) {
            return { error: String(err), records: null, raw: null };
        }
    }

    function writeHostRecords(records) {
        try {
            localStorage.setItem(HOST_STORAGE_KEY, JSON.stringify(records));
            return true;
        } catch (_e) {
            return false;
        }
    }

    function ensureHostRecord() {
        const snapshot = readHostRecords();
        if (snapshot.error || !snapshot.records) {
            console.warn('[simple-reach] refusing to touch the host plugin registry:', snapshot.error);
            return false;
        }
        const records = snapshot.records.map(r => (r && typeof r === 'object')
            ? Object.assign({}, r) : r);
        const existing = records.find(r => r && r.id === PLUGIN_ID);
        if (existing) {
            let changed = false;
            if (!Object.prototype.hasOwnProperty.call(existing, 'enabled')) { existing.enabled = true; changed = true; }
            if (!Object.prototype.hasOwnProperty.call(existing, 'status')) { existing.status = 'running'; changed = true; }
            if (existing.runtimeBacked !== true) { existing.runtimeBacked = true; changed = true; }
            if (!existing.runtimePage) { existing.runtimePage = APP_ID; changed = true; }
            if (existing.version !== MANIFEST.version) { existing.version = MANIFEST.version; changed = true; }
            return !changed || writeHostRecords(records);
        }
        records.push({
            id: PLUGIN_ID,
            name: MANIFEST.name,
            publisher: (MANIFEST.publisher && MANIFEST.publisher.name) || 'Michael Anthony Falabella',
            author: (MANIFEST.publisher && MANIFEST.publisher.name) || 'Michael Anthony Falabella',
            version: MANIFEST.version,
            description: MANIFEST.description,
            longDescription: MANIFEST.description,
            icon: 'fa-satellite-dish',
            tone: 'accent',
            category: 'AI Endpoints',
            permissions: (MANIFEST.permissions || []).map(p => ({
                id: p.id,
                scope: p.reason || '',
                mode: p.required ? 'Required' : 'Optional',
                risk: 'Low'
            })),
            enabled: true,
            status: 'running',
            installedAt: new Date().toISOString(),
            installMethod: 'Local extension registry',
            source: 'local-file',
            sourceLabel: 'Local extension registry',
            repository: core.REPO_URL,
            isolation: 'inline',
            verified: false,
            signed: false,
            checksum: true,
            runtimeBacked: true,
            pluginType: 'assistant',
            runtimePage: APP_ID,
            contributions: {
                pages: [{
                    id: PAGE_ID,
                    title: MANIFEST.contributes.pages[0].title,
                    location: 'app-bar',
                    icon: MANIFEST.contributes.pages[0].icon,
                    offlineCapable: true
                }]
            }
        });
        return writeHostRecords(records);
    }

    // ------------------------------------------------------------------
    // Runtime state & DOM helpers
    // ------------------------------------------------------------------
    const runtime = {
        context: null,
        mounted: false,
        pollTimer: null,
        cleanupPage: null,
        activePage: core.store.page || core.prefsGet('page', 'dashboard'),
        accentColor: core.prefsGet('accent_color', '#ffb020')
    };

    const ACCENT_PRESETS = [
        { name: 'Amber Gold', hex: '#ffb020' },
        { name: 'Cyber Cyan', hex: '#00e5ff' },
        { name: 'Neon Emerald', hex: '#00e676' },
        { name: 'Electric Purple', hex: '#b388ff' },
        { name: 'Sunset Coral', hex: '#ff5252' },
        { name: 'Synth Pink', hex: '#ff4081' }
    ];

    function hexToRgb(hex) {
        let clean = (hex || '').replace('#', '');
        if (clean.length === 3) {
            clean = clean.split('').map(c => c + c).join('');
        }
        if (clean.length !== 6) return { r: 255, g: 176, b: 32 };
        const num = parseInt(clean, 16);
        return {
            r: (num >> 16) & 255,
            g: (num >> 8) & 255,
            b: num & 255
        };
    }

    function applyAccentColor(hex) {
        if (!hex || !/^#[0-9a-fA-F]{3,6}$/.test(hex)) return;
        const rgb = hexToRgb(hex);
        // Contrast luminance calculation: if bright, use dark text on solid buttons, else white
        const lum = (0.299 * rgb.r + 0.587 * rgb.g + 0.114 * rgb.b) / 255;
        const textColor = lum > 0.55 ? '#101418' : '#ffffff';

        // Lighten by 28% for light text accents
        const lightHex = '#' + [rgb.r, rgb.g, rgb.b].map(x => {
            const v = Math.min(255, Math.round(x + (255 - x) * 0.28));
            return v.toString(16).padStart(2, '0');
        }).join('');

        const vars = {
            '--reach-accent': hex,
            '--reach-accent-light': lightHex,
            '--reach-accent-glow': `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.45)`,
            '--reach-accent-bg': `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.14)`,
            '--reach-accent-border': `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.38)`,
            '--reach-accent-text': textColor
        };

        // CRITICAL: Scoped EXCLUSIVELY to SimpleREACH containers — NEVER touches body, :root, or SimpleRAG
        const targets = document.querySelectorAll(
            '.reach-page, .reach-shell, .reach-stationary-panel, .reach-toast, #reach-page'
        );
        targets.forEach(node => {
            for (const [key, val] of Object.entries(vars)) {
                node.style.setProperty(key, val);
            }
        });

        core.prefsSet('accent_color', hex);
        runtime.accentColor = hex;
    }

    function hostElements() {
        const ctx = runtime.context;
        const elObj = (ctx && ctx.elements) || {};
        return {
            navTitle: elObj.navTitle || document.getElementById('nav-title') || document.querySelector('.nav-title'),
            navFolderList: elObj.navFolderList || document.getElementById('nav-folder-list'),
            listTitle: elObj.listTitle || document.getElementById('list-title'),
            listContent: elObj.listContent || document.getElementById('list-content'),
            settingsContainer: elObj.settingsContainer || document.getElementById('settings-container') || document.getElementById('settingsContainer'),
            readingContent: elObj.readingContent || document.querySelector('.reading-content')
        };
    }

    function isThreePanelMode() {
        const els = hostElements();
        return Boolean(els.navFolderList && els.listContent && els.settingsContainer);
    }

    // ------------------------------------------------------------------
    // Panel 1: Navigation Pane (#nav-folder-list)
    // ------------------------------------------------------------------
    function renderNav(context, hostApi) {
        runtime.context = context || runtime.context;
        const els = hostElements();
        if (els.navTitle) {
            els.navTitle.textContent = 'SignalR.E.A.C.H';
        }
        if (els.navFolderList) {
            els.navFolderList.setAttribute('aria-label', 'SignalR.E.A.C.H navigation');
        }

        const ctx = runtime.context;
        if (ctx && ctx.state) {
            if (!pages.defs.some(d => d.id === ctx.state.folder)) {
                ctx.state.folder = runtime.activePage || core.prefsGet('page', 'dashboard');
            }
        }

        const addFolder = (hostApi && typeof hostApi.addFolder === 'function')
            ? hostApi.addFolder
            : (typeof context?.addFolder === 'function' ? context.addFolder : null);

        if (addFolder) {
            pages.defs.forEach(def => {
                let count = null;
                if (def.id === 'models' && core.store.settings && core.store.settings.models) {
                    count = Object.keys(core.store.settings.models).length;
                }
                addFolder(def.id, def.icon, def.label, count);
            });
        }
    }

    // ------------------------------------------------------------------
    // Panel 2: Stationary Controls & Settings (#list-content)
    // ------------------------------------------------------------------
    function renderStationaryPanel(container) {
        let panel = container.querySelector('.reach-stationary-panel');
        if (panel) {
            updateStationaryValues(panel);
            return;
        }

        container.innerHTML = '';
        panel = core.el('div', 'reach-stationary-panel');
        container.appendChild(panel);
        applyAccentColor(runtime.accentColor);

        // --- Card 1: Relay Status & Live Controls ---
        const c1 = core.el('div', 'reach-stat-card');
        const c1Head = core.el('div', 'reach-stat-card-head');
        const c1Status = core.el('div', 'reach-stat-status-row');
        const dot = core.el('span', 'reach-dot reach-dot-off');
        dot.id = 'reach-stat-dot';
        const title = core.el('span', 'reach-stat-status-title', 'Relay Offline');
        title.id = 'reach-stat-title';
        c1Status.appendChild(dot);
        c1Status.appendChild(title);
        c1Head.appendChild(c1Status);
        const portBadge = core.el('span', 'reach-badge reach-badge-live', ':20777');
        portBadge.id = 'reach-stat-port';
        c1Head.appendChild(portBadge);
        c1.appendChild(c1Head);

        const metaRow = core.el('div', 'reach-stat-meta-row');
        const uptimeEl = core.el('span', 'reach-hint', 'Uptime: checking…');
        uptimeEl.id = 'reach-stat-uptime';
        const upstreamHint = core.el('span', 'reach-hint', 'OmniRoute :20128');
        upstreamHint.id = 'reach-stat-upstream-hint';
        metaRow.appendChild(uptimeEl);
        metaRow.appendChild(upstreamHint);
        c1.appendChild(metaRow);

        const actRow = core.el('div', 'reach-stat-actions-row');
        const pingBtn = core.el('button', 'reach-btn reach-btn-primary reach-btn-sm');
        pingBtn.id = 'reach-stat-ping-btn';
        pingBtn.innerHTML = '<i class="fa-solid fa-bolt"></i> Ping Test';
        const restartBtn = core.el('button', 'reach-btn reach-btn-sm');
        restartBtn.id = 'reach-stat-restart-btn';
        restartBtn.innerHTML = '<i class="fa-solid fa-rotate"></i> Restart';
        const refreshBtn = core.el('button', 'reach-btn reach-btn-sm');
        refreshBtn.id = 'reach-stat-refresh-btn';
        refreshBtn.innerHTML = '<i class="fa-solid fa-arrows-rotate"></i>';
        actRow.appendChild(pingBtn);
        actRow.appendChild(restartBtn);
        actRow.appendChild(refreshBtn);
        c1.appendChild(actRow);

        const pingResult = core.el('div', 'reach-result reach-stat-ping-result');
        pingResult.id = 'reach-stat-ping-result';
        pingResult.hidden = true;
        c1.appendChild(pingResult);
        panel.appendChild(c1);

        // --- Card 2: Public Endpoint & 1-Click SimpleRAG Hookup ---
        const c2 = core.el('div', 'reach-stat-card');
        const c2Head = core.el('div', 'reach-stat-card-head');
        const c2Title = core.el('div', 'reach-stat-card-title');
        c2Title.innerHTML = '<i class="fa-solid fa-link"></i> Endpoint';
        const copyBtn = core.el('button', 'reach-btn reach-btn-sm');
        copyBtn.id = 'reach-stat-copy-btn';
        copyBtn.innerHTML = '<i class="fa-regular fa-copy"></i> Copy';
        c2Head.appendChild(c2Title);
        c2Head.appendChild(copyBtn);
        c2.appendChild(c2Head);

        const urlBox = core.el('div', 'reach-stat-url-box', 'http://127.0.0.1:20777/v1');
        urlBox.id = 'reach-stat-url-box';
        c2.appendChild(urlBox);

        const hookupRow = core.el('div', 'reach-stat-actions-row');
        const hookupBtn = core.el('button', 'reach-btn reach-btn-primary reach-btn-block');
        hookupBtn.id = 'reach-stat-hookup-btn';
        hookupBtn.innerHTML = '<i class="fa-solid fa-plug"></i> 1-Click Add to SimpleRAG';
        hookupRow.appendChild(hookupBtn);
        c2.appendChild(hookupRow);
        panel.appendChild(c2);

        // --- Card 2b: REACH Theme Accent Color (Scoped to SimpleREACH only) ---
        const cTheme = core.el('div', 'reach-stat-card');
        const cThemeHead = core.el('div', 'reach-stat-card-head');
        const cThemeTitle = core.el('div', 'reach-stat-card-title');
        cThemeTitle.innerHTML = '<i class="fa-solid fa-palette"></i> REACH Accent';
        const resetThemeBtn = core.el('button', 'reach-btn reach-btn-sm', 'Default');
        cThemeHead.appendChild(cThemeTitle);
        cThemeHead.appendChild(resetThemeBtn);
        cTheme.appendChild(cThemeHead);

        const swatchesWrap = core.el('div', 'reach-theme-swatches');
        const currentAccent = runtime.accentColor || core.prefsGet('accent_color', '#ffb020');

        ACCENT_PRESETS.forEach(preset => {
            const swatch = core.el('button', 'reach-swatch' + (currentAccent.toLowerCase() === preset.hex.toLowerCase() ? ' active' : ''));
            swatch.style.backgroundColor = preset.hex;
            swatch.title = preset.name + ' (' + preset.hex + ')';
            swatch.dataset.hex = preset.hex;
            swatch.addEventListener('click', () => {
                swatchesWrap.querySelectorAll('.reach-swatch').forEach(s => s.classList.remove('active'));
                swatch.classList.add('active');
                colorInput.value = preset.hex;
                applyAccentColor(preset.hex);
                core.toast('REACH Accent: ' + preset.name, 'info');
            });
            swatchesWrap.appendChild(swatch);
        });

        // Custom Color Picker input
        const pickerWrap = core.el('div', 'reach-swatch-picker-wrap');
        pickerWrap.title = 'Custom Accent Color';
        const colorInput = document.createElement('input');
        colorInput.type = 'color';
        colorInput.value = currentAccent;
        colorInput.addEventListener('input', (e) => {
            const val = e.target.value;
            swatchesWrap.querySelectorAll('.reach-swatch').forEach(s => s.classList.remove('active'));
            applyAccentColor(val);
        });
        colorInput.addEventListener('change', (e) => {
            core.toast('Custom accent: ' + e.target.value, 'ok');
        });
        pickerWrap.appendChild(colorInput);
        swatchesWrap.appendChild(pickerWrap);
        cTheme.appendChild(swatchesWrap);

        resetThemeBtn.addEventListener('click', () => {
            swatchesWrap.querySelectorAll('.reach-swatch').forEach(s => s.classList.remove('active'));
            const first = swatchesWrap.querySelector('[data-hex="#ffb020"]');
            if (first) first.classList.add('active');
            colorInput.value = '#ffb020';
            applyAccentColor('#ffb020');
            core.toast('Accent reset to Amber Gold ✓', 'ok');
        });

        panel.appendChild(cTheme);

        // --- Card 3: Stationary Settings & Knobs ---
        const c3 = core.el('div', 'reach-stat-card');
        const c3Head = core.el('div', 'reach-stat-card-head');
        const c3Title = core.el('div', 'reach-stat-card-title');
        c3Title.innerHTML = '<i class="fa-solid fa-sliders"></i> Relay Settings';
        const saveSettingsBtn = core.el('button', 'reach-btn reach-btn-primary reach-btn-sm', 'Save');
        saveSettingsBtn.id = 'reach-stat-save-settings-btn';
        c3Head.appendChild(c3Title);
        c3Head.appendChild(saveSettingsBtn);
        c3.appendChild(c3Head);

        // Row A: Rate Limiter Toggle
        const setRow1 = core.el('div', 'reach-stat-setting-row');
        const setLbl1 = core.el('div', 'reach-stat-setting-label');
        setLbl1.appendChild(core.el('span', null, 'Rate Limiter'));
        setLbl1.appendChild(core.el('span', 'reach-hint', 'Token-bucket per IP'));
        const switchLabel = core.el('label', 'reach-switch');
        const switchInput = core.el('input');
        switchInput.type = 'checkbox';
        switchInput.id = 'reach-stat-rate-limit-toggle';
        switchInput.checked = true;
        const switchSlider = core.el('span', 'reach-switch-slider');
        switchLabel.appendChild(switchInput);
        switchLabel.appendChild(switchSlider);
        setRow1.appendChild(setLbl1);
        setRow1.appendChild(switchLabel);
        c3.appendChild(setRow1);

        // Row B: Per-IP RPM
        const setRow2 = core.el('div', 'reach-stat-setting-row');
        const setLbl2 = core.el('div', 'reach-stat-setting-label');
        setLbl2.appendChild(core.el('span', null, 'Per-IP RPM'));
        setLbl2.appendChild(core.el('span', 'reach-hint', 'Requests / minute'));
        const rpmInput = core.el('input', 'reach-input reach-input-sm reach-stat-input');
        rpmInput.type = 'number';
        rpmInput.id = 'reach-stat-rpm-input';
        rpmInput.min = '1';
        rpmInput.max = '1000';
        rpmInput.value = '60';
        setRow2.appendChild(setLbl2);
        setRow2.appendChild(rpmInput);
        c3.appendChild(setRow2);

        // Row C: Max Concurrency
        const setRow3 = core.el('div', 'reach-stat-setting-row');
        const setLbl3 = core.el('div', 'reach-stat-setting-label');
        setLbl3.appendChild(core.el('span', null, 'Max Concurrency'));
        setLbl3.appendChild(core.el('span', 'reach-hint', 'Parallel requests'));
        const concInput = core.el('input', 'reach-input reach-input-sm reach-stat-input');
        concInput.type = 'number';
        concInput.id = 'reach-stat-concurrency-input';
        concInput.min = '1';
        concInput.max = '64';
        concInput.value = '8';
        setRow3.appendChild(setLbl3);
        setRow3.appendChild(concInput);
        c3.appendChild(setRow3);

        panel.appendChild(c3);

        // --- Card 4: Upstream Routing ---
        const c4 = core.el('div', 'reach-stat-card');
        const c4Head = core.el('div', 'reach-stat-card-head');
        const c4Title = core.el('div', 'reach-stat-card-title');
        c4Title.innerHTML = '<i class="fa-solid fa-route"></i> Upstream';
        const upstreamBadge = core.el('span', 'reach-badge reach-badge-live', 'OmniRoute OK');
        upstreamBadge.id = 'reach-stat-upstream-badge';
        c4Head.appendChild(c4Title);
        c4Head.appendChild(upstreamBadge);
        c4.appendChild(c4Head);

        const dl = core.el('dl', 'reach-kv');
        dl.innerHTML = '<dt>Target</dt><dd>127.0.0.1:20128</dd>'
            + '<dt>Provider</dt><dd>codegpt (gpt-4o)</dd>'
            + '<dt>Aliases</dt><dd>gpt-4o, gpt-4o-mini</dd>';
        c4.appendChild(dl);
        panel.appendChild(c4);

        // --- Card 5: Live Activity Today ---
        const c5 = core.el('div', 'reach-stat-card');
        const c5Head = core.el('div', 'reach-stat-card-head');
        const c5Title = core.el('div', 'reach-stat-card-title');
        c5Title.innerHTML = '<i class="fa-solid fa-chart-simple"></i> Activity Today';
        const viewLogsBtn = core.el('button', 'reach-btn reach-btn-sm', 'Full Logs →');
        viewLogsBtn.id = 'reach-stat-view-logs-btn';
        c5Head.appendChild(c5Title);
        c5Head.appendChild(viewLogsBtn);
        c5.appendChild(c5Head);

        const grid3 = core.el('div', 'reach-stat-grid-3');
        const mkMini = (val, lbl, id) => {
            const wrap = core.el('div', 'reach-stat-mini-tile');
            const v = core.el('div', 'reach-stat-mini-val', val);
            v.id = id;
            wrap.appendChild(v);
            wrap.appendChild(core.el('div', 'reach-stat-mini-lbl', lbl));
            return wrap;
        };
        const grid4 = core.el('div', 'reach-stat-grid-4');
        grid4.appendChild(mkMini('0', 'Reqs', 'reach-stat-mini-reqs'));
        grid4.appendChild(mkMini('0', 'Tokens', 'reach-stat-mini-tokens'));
        grid4.appendChild(mkMini('—', 'Tok/s', 'reach-stat-mini-tps'));
        grid4.appendChild(mkMini('0ms', 'Avg Lat', 'reach-stat-mini-latency'));
        c5.appendChild(grid4);
        panel.appendChild(c5);

        // --- Event Listeners ---
        pingBtn.addEventListener('click', () => {
            pingBtn.disabled = true;
            pingResult.hidden = false;
            pingResult.className = 'reach-result';
            pingResult.textContent = 'Pinging upstream via /_reach/test …';
            core.relayFetch('/_reach/test', { method: 'POST' }, 20000)
                .then(res => res.json())
                .then(data => {
                    pingResult.className = 'reach-result ' + (data.ok ? 'reach-result-ok' : 'reach-result-error');
                    pingResult.textContent = data.ok
                        ? '✓ ' + core.fmtLatency(data.latency_ms) + ' (' + (data.model || 'gpt-4o') + '): ' + (data.reply || 'OK')
                        : '✗ ' + (data.error || 'Test failed');
                })
                .catch(err => {
                    pingResult.className = 'reach-result reach-result-error';
                    pingResult.textContent = '✗ ' + err.message;
                })
                .finally(() => { pingBtn.disabled = false; });
        });

        restartBtn.addEventListener('click', () => {
            restartBtn.disabled = true;
            core.toast('Restarting relay…', 'info');
            core.relayFetch('/_reach/restart', { method: 'POST' }, 8000)
                .then(() => {
                    setTimeout(() => {
                        core.refreshLocal().then(() => {
                            updateStationaryValues(panel);
                            core.toast('Relay restarted ✓', 'ok');
                        });
                    }, 1200);
                })
                .catch(err => core.toast('Restart: ' + err.message, 'error'))
                .finally(() => { restartBtn.disabled = false; });
        });

        refreshBtn.addEventListener('click', () => {
            core.refreshLocal().then(() => {
                updateStationaryValues(panel);
                core.toast('Refreshed', 'info');
            });
        });

        copyBtn.addEventListener('click', () => {
            const text = urlBox.textContent;
            if (text) {
                core.copyText(text).then(ok => core.toast(ok ? 'Endpoint copied ✓' : 'Copy failed', ok ? 'ok' : 'error'));
            }
        });

        hookupBtn.addEventListener('click', () => {
            const url = core.store.pointerUrl || ('http://127.0.0.1:' + ((core.store.local && core.store.local.port) || 20777));
            hookupBtn.disabled = true;
            hookupBtn.textContent = 'Adding…';
            fetch(core.API_BASE + '/model-endpoints', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    name: 'SignalR.E.A.C.H (gpt-4o)',
                    base_url: url + '/v1',
                    api_key: '',
                    default_model: 'gpt-4o'
                })
            })
                .then(res => res.json().then(data => ({ ok: res.ok, data })))
                .then(({ ok, data }) => {
                    if (ok) {
                        core.toast('Added to SimpleRAG ✓ — select SignalR.E.A.C.H in Model Settings', 'ok');
                    } else {
                        core.toast('Hookup: ' + (data?.detail || 'failed'), 'error');
                    }
                })
                .catch(err => core.toast('Hookup failed: ' + err.message, 'error'))
                .finally(() => {
                    hookupBtn.disabled = false;
                    hookupBtn.innerHTML = '<i class="fa-solid fa-plug"></i> 1-Click Add to SimpleRAG';
                });
        });

        saveSettingsBtn.addEventListener('click', () => {
            saveSettingsBtn.disabled = true;
            saveSettingsBtn.textContent = 'Saving…';
            const patch = {
                rate_limit_enabled: switchInput.checked,
                rate_limit_per_minute: parseInt(rpmInput.value, 10) || 60,
                max_concurrency: parseInt(concInput.value, 10) || 8
            };
            core.saveSettings(patch)
                .then(res => {
                    if (res.ok) {
                        core.toast('Settings applied ✓', 'ok');
                    } else {
                        core.toast('Save failed: ' + (res.data?.error?.message || 'status ' + res.status), 'error');
                    }
                })
                .catch(err => core.toast('Save error: ' + err.message, 'error'))
                .finally(() => {
                    saveSettingsBtn.disabled = false;
                    saveSettingsBtn.textContent = 'Save';
                });
        });

        viewLogsBtn.addEventListener('click', () => {
            switchPage('logs');
        });

        // Hydrate initial values
        updateStationaryValues(panel);
        core.loadSettings().then(cfg => {
            if (!cfg) return;
            if (typeof cfg.rate_limit_enabled === 'boolean') switchInput.checked = cfg.rate_limit_enabled;
            if (cfg.rate_limit_per_minute) rpmInput.value = cfg.rate_limit_per_minute;
            if (cfg.max_concurrency) concInput.value = cfg.max_concurrency;
        });
    }

    function updateStationaryValues(panel) {
        if (!panel) return;
        const snap = core.store.local;
        const dot = panel.querySelector('#reach-stat-dot');
        const title = panel.querySelector('#reach-stat-title');
        const port = panel.querySelector('#reach-stat-port');
        const uptime = panel.querySelector('#reach-stat-uptime');
        const upstreamBadge = panel.querySelector('#reach-stat-upstream-badge');
        const urlBox = panel.querySelector('#reach-stat-url-box');
        const miniReqs = panel.querySelector('#reach-stat-mini-reqs');
        const miniTokens = panel.querySelector('#reach-stat-mini-tokens');
        const miniTps = panel.querySelector('#reach-stat-mini-tps');
        const miniLatency = panel.querySelector('#reach-stat-mini-latency');

        if (snap) {
            if (dot) dot.className = 'reach-dot ' + (snap.upstream_ok ? 'reach-dot-on' : 'reach-dot-warn');
            if (title) title.textContent = snap.upstream_ok ? 'Relay Active' : 'Relay Active (Upstream Issue)';
            if (port) port.textContent = ':' + (snap.port || 20777);
            if (uptime) uptime.textContent = 'Uptime: ' + core.fmtUptime(snap.uptime_s || 0);
            if (upstreamBadge) {
                upstreamBadge.className = 'reach-badge ' + (snap.upstream_ok ? 'reach-badge-live' : 'reach-badge-off');
                upstreamBadge.textContent = snap.upstream_ok ? 'OmniRoute OK' : 'OmniRoute DOWN';
            }
            const today = snap.today || {};
            if (miniReqs) miniReqs.textContent = core.fmtNum(today.requests);
            if (miniTokens) miniTokens.textContent = core.fmtNum((today.tokens_in || 0) + (today.tokens_out || 0));
            const speed = (today.tokens_per_sec != null && today.tokens_per_sec > 0)
                ? today.tokens_per_sec
                : (snap.tokens_per_sec || 0);
            if (miniTps) miniTps.textContent = speed > 0 ? (speed + ' tps') : '—';
            if (miniLatency) miniLatency.textContent = core.fmtLatency(today.avg_latency_ms);
        } else {
            if (dot) dot.className = 'reach-dot reach-dot-off';
            if (title) title.textContent = 'Relay Offline';
            if (port) port.textContent = ':20777';
            if (uptime) uptime.textContent = 'Uptime: —';
            if (upstreamBadge) {
                upstreamBadge.className = 'reach-badge reach-badge-off';
                upstreamBadge.textContent = 'Offline';
            }
        }

        if (urlBox) {
            urlBox.textContent = core.store.pointerUrl
                ? core.store.pointerUrl + '/v1'
                : 'http://127.0.0.1:' + ((snap && snap.port) || 20777) + '/v1';
        }
    }

    // ------------------------------------------------------------------
    // Panel 3: Reading Pane Content (#settings-container)
    // ------------------------------------------------------------------
    function renderPageInContainer(container, pageId) {
        if (typeof runtime.cleanupPage === 'function') {
            try { runtime.cleanupPage(); } catch (_e) { /* page cleanup must not cascade */ }
            runtime.cleanupPage = null;
        }

        container.innerHTML = '';
        const root = core.el('div', 'reach-page reach-panel3');
        const content = core.el('main', 'reach-content');
        root.appendChild(content);
        container.appendChild(root);
        applyAccentColor(runtime.accentColor);

        const renderer = pages[pageId];
        if (typeof renderer === 'function') {
            runtime.cleanupPage = renderer(content) || null;
        }
        content.scrollTop = 0;
    }

    // ------------------------------------------------------------------
    // Fallback Shell (for standalone or environments lacking 3 panels)
    // ------------------------------------------------------------------
    function buildShell() {
        const els = hostElements();
        const container = els.settingsContainer;
        if (!container) return null;
        if (container.querySelector('.reach-shell')) return container.querySelector('.reach-page');

        container.innerHTML = '';
        const root = document.createElement('div');
        root.className = 'reach-page';
        root.innerHTML = '<div class="reach-shell">'
            + '  <nav class="reach-menu" aria-label="SignalR.E.A.C.H">'
            + '    <div class="reach-menu-brand">'
            + '      <div class="reach-hero-badge">REACH</div>'
            + '      <div class="reach-menu-brand-copy">'
            + '        <div class="reach-menu-brand-name">SignalR.E.A.C.H</div>'
            + '        <div class="reach-menu-brand-sub">v' + MANIFEST.version + '</div>'
            + '      </div>'
            + '    </div>'
            + '    <div class="reach-menu-items"></div>'
            + '    <div class="reach-menu-foot">'
            + '      <span class="reach-dot" id="reach-relay-dot"></span>'
            + '      <span id="reach-relay-label">checking relay…</span>'
            + '    </div>'
            + '  </nav>'
            + '  <main class="reach-content" id="reach-content"></main>'
            + '</div>';
        container.appendChild(root);
        applyAccentColor(runtime.accentColor);

        const items = root.querySelector('.reach-menu-items');
        pages.defs.forEach(def => {
            const item = document.createElement('button');
            item.className = 'reach-menu-item';
            item.dataset.page = def.id;
            item.title = def.label;
            const icon = document.createElement('i');
            icon.className = 'fa-solid ' + def.icon;
            icon.setAttribute('aria-hidden', 'true');
            item.appendChild(icon);
            item.appendChild(document.createElement('span')).textContent = def.label;
            item.addEventListener('click', () => switchPage(def.id));
            items.appendChild(item);
        });
        return root;
    }

    function switchPage(pageId, force) {
        if (!force && pageId === runtime.activePage && runtime.cleanupPage) return;
        runtime.activePage = pageId;
        core.store.page = pageId;
        core.prefsSet('page', pageId);

        if (runtime.context && runtime.context.state) {
            runtime.context.state.folder = pageId;
        }

        if (isThreePanelMode()) {
            const els = hostElements();
            if (els.settingsContainer) {
                renderPageInContainer(els.settingsContainer, pageId);
            }
            if (els.navFolderList) {
                const items = els.navFolderList.querySelectorAll('.nav-item');
                pages.defs.forEach((def, idx) => {
                    if (items[idx]) {
                        items[idx].classList.toggle('active', def.id === pageId);
                    }
                });
            }
        } else {
            const root = document.querySelector('.reach-page');
            if (root) {
                root.querySelectorAll('.reach-menu-item').forEach(item => {
                    item.classList.toggle('reach-menu-active', item.dataset.page === pageId);
                });
            }
            const content = document.getElementById('reach-content');
            if (content) {
                if (typeof runtime.cleanupPage === 'function') {
                    try { runtime.cleanupPage(); } catch (_e) { }
                    runtime.cleanupPage = null;
                }
                content.innerHTML = '';
                const renderer = pages[pageId];
                if (typeof renderer === 'function') {
                    runtime.cleanupPage = renderer(content) || null;
                }
                content.scrollTop = 0;
            }
        }
    }

    function renderOfflineBanner() {
        const label = document.getElementById('reach-relay-label');
        const dot = document.getElementById('reach-relay-dot');
        if (!label || !dot) return;
        if (core.store.local) {
            dot.className = 'reach-dot reach-dot-on';
            label.textContent = 'relay up · :' + (core.store.local.port || 20777)
                + (core.store.local.upstream_ok ? '' : ' · upstream DOWN');
            if (!core.store.local.upstream_ok) dot.className = 'reach-dot reach-dot-warn';
        } else {
            dot.className = 'reach-dot reach-dot-off';
            label.textContent = 'relay offline (this machine)';
        }
    }

    function startPolling() {
        if (runtime.pollTimer) return;
        const tick = () => core.refreshLocal().then(() => {
            const panel = document.querySelector('.reach-stationary-panel');
            if (panel) updateStationaryValues(panel);
            renderOfflineBanner();
            if (core.store.pointerAt === 0) {
                core.refreshPointer().then(() => {
                    if (panel) updateStationaryValues(panel);
                });
            }
        });
        tick();
        runtime.pollTimer = setInterval(tick, 15000);
    }

    function stopPolling() {
        if (runtime.pollTimer) {
            clearInterval(runtime.pollTimer);
            runtime.pollTimer = null;
        }
    }

    // ------------------------------------------------------------------
    // Page controller (SimpleRAG host contract)
    // ------------------------------------------------------------------
    const controller = {
        appId: APP_ID,

        mount(context) {
            runtime.context = context || runtime.context;
            ensureHostRecord();
        },

        activate(context) {
            runtime.context = context || runtime.context;
            runtime.mounted = true;
            const saved = core.prefsGet('page', 'dashboard');
            runtime.activePage = pages.defs.some(d => d.id === saved) ? saved : 'dashboard';
            if (runtime.context && runtime.context.state) {
                runtime.context.state.folder = runtime.activePage;
            }
            startPolling();
        },

        onFolderChanged(contextOrId, maybeId) {
            const id = typeof maybeId === 'string' ? maybeId : (typeof contextOrId === 'string' ? contextOrId : '');
            const folder = id || (runtime.context?.state?.folder) || 'dashboard';
            if (pages.defs.some(d => d.id === folder)) {
                switchPage(folder);
            }
        },

        renderNav(context, hostApi) {
            renderNav(context, hostApi);
        },

        renderRibbon(context, hostApi) {
            runtime.context = context || runtime.context;
            if (hostApi && typeof hostApi.addBtn === 'function') {
                hostApi.addBtn('reach-btn-ping', 'fa-bolt', 'Ping Test', false, () => {
                    const pingBtn = document.getElementById('reach-stat-ping-btn');
                    if (pingBtn) pingBtn.click();
                    else core.toast('Pinging…', 'info');
                });
                hostApi.addBtn('reach-btn-refresh', 'fa-rotate', 'Refresh', false, () => {
                    core.refreshLocal().then(() => core.toast('Refreshed', 'info'));
                });
            }
        },

        renderList(context) {
            runtime.context = context || runtime.context;
            const els = hostElements();
            if (els.listTitle) {
                els.listTitle.textContent = 'Relay & Controls';
            }
            if (els.listContent) {
                renderStationaryPanel(els.listContent);
            }
        },

        renderPage(context) {
            runtime.context = context || runtime.context;
            const targetPage = (runtime.context?.state?.folder) || runtime.activePage || core.prefsGet('page', 'dashboard');
            const pageId = pages.defs.some(d => d.id === targetPage) ? targetPage : 'dashboard';
            runtime.activePage = pageId;

            if (isThreePanelMode()) {
                const els = hostElements();
                if (els.settingsContainer) {
                    renderPageInContainer(els.settingsContainer, pageId);
                }
            } else {
                if (!runtime.mounted) {
                    buildShell();
                }
                switchPage(pageId, true);
            }
            if (!runtime.pollTimer) {
                startPolling();
            }
        },

        deactivate() {
            runtime.mounted = false;
            stopPolling();
        },

        unmount() {
            runtime.mounted = false;
            stopPolling();
            if (typeof runtime.cleanupPage === 'function') {
                try { runtime.cleanupPage(); } catch (_e) { }
                runtime.cleanupPage = null;
            }
            const els = hostElements();
            if (els.settingsContainer) {
                const root = els.settingsContainer.querySelector('.reach-page');
                if (root) root.remove();
            }
            window[CONTROLLER_DISPOSE_KEY] = null;
            window.__simpleReachControllerDispose = null;
            if (window.signalReach) delete window.signalReach;
            if (window.simpleReach) delete window.simpleReach;
        }
    };

    // ------------------------------------------------------------------
    // Register with the host (script-load time)
    // ------------------------------------------------------------------
    host.registerController({
        pluginId: PLUGIN_ID,
        capabilities: MANIFEST.frontend.capabilities.slice(),
        extensionType: 'assistant',
        commandMeta: {
            'signalReach.openPage': { icon: 'fa-satellite-dish', contexts: ['reach'], featured: true, keywords: ['reach', 'gpt-4o', 'endpoint', 'hosting', 'free', 'relay'] },
            'simpleReach.openPage': { icon: 'fa-satellite-dish', contexts: ['reach'], featured: true, keywords: ['reach', 'gpt-4o', 'endpoint', 'hosting', 'free', 'relay'] }
        },
        commands: {
            'signalReach.openPage': () => {
                if (typeof window.setApp === 'function') window.setApp(APP_ID);
            },
            'simpleReach.openPage': () => {
                if (typeof window.setApp === 'function') window.setApp(APP_ID);
            }
        },
        exporters: {},
        pages: { [PAGE_ID]: controller }
    });

    host.registerManifest(MANIFEST);
    ensureHostRecord();

    window.signalReach = window.simpleReach = Object.freeze({
        pluginId: PLUGIN_ID,
        pageId: PAGE_ID,
        appId: APP_ID,
        version: MANIFEST.version,
        ensureHostRecord: ensureHostRecord,
        switchPage: switchPage,
        controller: controller
    });
    window[CONTROLLER_DISPOSE_KEY] = controller.unmount;
    window.__simpleReachControllerDispose = controller.unmount;
})();
