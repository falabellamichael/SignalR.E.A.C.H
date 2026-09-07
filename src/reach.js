/*
 * SimpleREACH — page controller entrypoint.
 *
 * REACH = RAG Endpoint & AI Chat Host.
 *
 * Registers with SimpleRAG's public extension host
 * (window.RAGWorkspaceExtensions) using the page-controller contract, and
 * renders one app-bar page: endpoint status, the hosted public URL, and
 * usage snippets. The page talks to the local relay on 127.0.0.1:20777 when
 * it is present and always resolves the canonical public endpoint through
 * the pointer gist.
 *
 * Everything lives under the reach-* class prefix and the simple-reach.*
 * storage keys. No SimpleRAG source file is modified; the only host state
 * written is this plugin's own entry in localStorage ragworkspace_plugins.
 */
(function registerSimpleReach() {
    'use strict';

    const PLUGIN_ID = 'simple-reach';
    const PAGE_ID = 'simple-reach.reach-page';
    const APP_ID = 'reach';
    const HOST_STORAGE_KEY = 'ragworkspace_plugins';
    const CONTROLLER_DISPOSE_KEY = '__simpleReachControllerDispose';
    const LOCAL_STATUS_URL = 'http://127.0.0.1:20777/status';
    const ENDPOINT_POINTER = 'https://gist.githubusercontent.com/falabellamichael/e261e0c31ad08c373bcd667b6982847a/raw/simple-reach-endpoint.txt';
    const REPO_URL = 'https://github.com/falabellamichael/SimpleREACH';
    const MODEL_ID = 'gpt-4o';
    const POINTER_TTL_MS = 60000;
    const POLL_INTERVAL_MS = 15000;

    const MANIFEST = window.__simpleReachManifest;
    if (!MANIFEST || typeof MANIFEST !== 'object') {
        console.error('[simple-reach] manifest.js did not load — re-run "python tools/reach.py install".');
        return;
    }

    /* Say WHY the page is missing, on the page itself (inline styles: if the
     * host bundle failed, our own stylesheet may not have loaded either). */
    function showBootFailure(title, detail) {
        try {
            if (typeof document === 'undefined' || !document.body) return;
            if (document.getElementById('simple-reach-boot-failure')) return;
            const panel = document.createElement('div');
            panel.id = 'simple-reach-boot-failure';
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
        console.error('[simple-reach] the SimpleRAG extension host is unavailable.');
        showBootFailure(
            "SimpleREACH could not start: SimpleRAG's extension host is not available.",
            'This usually means SimpleRAG\'s own bundle failed to load. Check the console, '
            + 'then reload. If the console is clean, re-run "python tools/reach.py install".'
        );
        return;
    }

    // Idempotence: a development re-evaluation keeps the live controller.
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
            // Explicit disablement is authoritative: only repair absent metadata.
            if (!Object.prototype.hasOwnProperty.call(existing, 'enabled')) { existing.enabled = true; changed = true; }
            if (!Object.prototype.hasOwnProperty.call(existing, 'status')) { existing.status = 'running'; changed = true; }
            if (existing.runtimeBacked !== true) { existing.runtimeBacked = true; changed = true; }
            if (!existing.runtimePage) { existing.runtimePage = APP_ID; changed = true; }
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
            repository: REPO_URL,
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
    // Runtime state
    // ------------------------------------------------------------------
    const runtime = {
        context: null,
        mounted: false,
        pollTimer: null,
        local: null,          // relay /status snapshot or null
        pointerUrl: null,     // canonical public endpoint (gist)
        pointerAt: 0,
        testing: false,
        lastTest: null        // {ok, text}
    };

    function hostElements() {
        const ctx = runtime.context;
        if (ctx && ctx.elements && ctx.elements.settingsContainer) {
            return ctx.elements.settingsContainer;
        }
        return document.getElementById('settings-container')
            || document.getElementById('settingsContainer');
    }

    function escapeText(value) {
        const el = document.createElement('span');
        el.textContent = String(value == null ? '' : value);
        return el.innerHTML;
    }

    function fetchJson(url, timeoutMs, parseRaw) {
        const controller = typeof AbortController === 'function' ? new AbortController() : null;
        const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
        return fetch(url, { signal: controller ? controller.signal : undefined })
            .then(res => {
                if (!res.ok) throw new Error('HTTP ' + res.status);
                return res.text();
            })
            .then(text => (parseRaw ? text.trim() : JSON.parse(text)))
            .catch(err => { throw err; })
            .finally(() => { if (timer) clearTimeout(timer); });
    }

    // ------------------------------------------------------------------
    // Page DOM
    // ------------------------------------------------------------------
    function pageMarkup() {
        return [
            '<div class="reach-hero">',
            '  <div class="reach-hero-badge">REACH</div>',
            '  <div class="reach-hero-copy">',
            '    <h1 class="reach-title">SimpleREACH</h1>',
            '    <p class="reach-tagline">RAG Endpoint &amp; AI Chat Host — hosted OpenAI-compatible endpoint with unlimited gpt-4o. No key. No quotas. For everyone.</p>',
            '  </div>',
            '</div>',
            '<div class="reach-grid">',
            '  <section class="reach-card reach-card-wide">',
            '    <header class="reach-card-head">',
            '      <h2>Public endpoint</h2>',
            '      <span class="reach-badge reach-badge-live" id="reach-pointer-badge">resolving…</span>',
            '    </header>',
            '    <div class="reach-url-row">',
            '      <code class="reach-url" id="reach-public-url">resolving…</code>',
            '      <button class="reach-btn" data-reach-copy>Copy</button>',
            '    </div>',
            '    <div class="reach-meta-row">',
            '      <span class="reach-chip">model: gpt-4o</span>',
            '      <span class="reach-chip">streaming ✓</span>',
            '      <span class="reach-chip">unlimited · free</span>',
            '      <span class="reach-chip">no API key</span>',
            '    </div>',
            '    <div class="reach-result" id="reach-test-result" hidden></div>',
            '    <footer class="reach-card-foot">',
            '      <button class="reach-btn reach-btn-primary" data-reach-test>Test endpoint</button>',
            '      <span class="reach-hint">fires a 1-token completion through the public URL</span>',
            '    </footer>',
            '  </section>',
            '  <section class="reach-card">',
            '    <header class="reach-card-head">',
            '      <h2>Local relay</h2>',
            '      <span class="reach-dot" id="reach-relay-dot"></span>',
            '    </header>',
            '    <dl class="reach-kv">',
            '      <dt>Server</dt><dd id="reach-relay-state">checking…</dd>',
            '      <dt>Port</dt><dd>20777</dd>',
            '      <dt>Upstream</dt><dd id="reach-upstream-state">OmniRoute :20128</dd>',
            '      <dt>Requests served</dt><dd id="reach-relay-count">—</dd>',
            '      <dt>Uptime</dt><dd id="reach-relay-uptime">—</dd>',
            '    </dl>',
            '  </section>',
            '  <section class="reach-card reach-card-wide">',
            '    <header class="reach-card-head"><h2>Use it anywhere</h2></header>',
            '    <div class="reach-usage-tabs">',
            '      <button class="reach-tab reach-tab-active" data-reach-tab="curl">curl</button>',
            '      <button class="reach-tab" data-reach-tab="python">Python</button>',
            '      <button class="reach-tab" data-reach-tab="simplerag">SimpleRAG</button>',
            '    </div>',
            '<pre class="reach-snippet" id="reach-snippet-curl"><code>curl REACH_URL/v1/chat/completions \\\n  -H "Content-Type: application/json" \\\n  -d \'{"model":"gpt-4o","messages":[{"role":"user","content":"Hello!"}]}\'</code></pre>',
            '<pre class="reach-snippet" id="reach-snippet-python" hidden><code>from openai import OpenAI\n\nclient = OpenAI(\n    base_url="REACH_URL/v1",\n    api_key="not-needed",\n)\nreply = client.chat.completions.create(\n    model="gpt-4o",\n    messages=[{"role": "user", "content": "Hello!"}],\n)\nprint(reply.choices[0].message.content)</code></pre>',
            '<div class="reach-snippet reach-snippet-steps" id="reach-snippet-simplerag" hidden><ol>',
            '  <li>Open <strong>Endpoint settings</strong> in SimpleRAG.</li>',
            '  <li>Add an <strong>OpenAI-compatible</strong> endpoint.</li>',
            '  <li><strong>Base URL:</strong> <code>REACH_URL/v1</code></li>',
            '  <li><strong>Model:</strong> <code>gpt-4o</code> — leave the API key blank.</li>',
            '  <li>Save, then pick it as your active chat model.</li>',
            '</ol></div>',
            '  </section>',
            '  <section class="reach-card reach-card-wide reach-foot-card">',
            '    <p class="reach-footnote">',
            '      REACH = <strong>R</strong>AG <strong>E</strong>ndpoint &amp; <strong>A</strong>I <strong>C</strong>hat <strong>H</strong>ost.',
            '      Relay runs locally on the host machine and is exposed through a tunnel;',
            '      availability rides on the host’s free codegpt tier. MIT — ',
            '      <a class="reach-link" href="' + REPO_URL + '" target="_blank" rel="noopener">' + REPO_URL + '</a> — by Michael Anthony Falabella.',
            '    </p>',
            '  </section>',
            '</div>'
        ].join('\n');
    }

    function buildPage() {
        const container = hostElements();
        if (!container) return;
        if (container.querySelector('.reach-page')) return;
        const root = document.createElement('div');
        root.className = 'reach-page';
        root.innerHTML = pageMarkup();
        container.appendChild(root);
        bindEvents(root);
        refreshAll();
        startPolling();
    }

    function removePageDom() {
        const container = hostElements();
        if (container) {
            const root = container.querySelector('.reach-page');
            if (root) root.remove();
        }
    }

    function bindEvents(root) {
        const copyBtn = root.querySelector('[data-reach-copy]');
        if (copyBtn) copyBtn.addEventListener('click', onCopy);

        const testBtn = root.querySelector('[data-reach-test]');
        if (testBtn) testBtn.addEventListener('click', onTest);

        const tabs = root.querySelectorAll('[data-reach-tab]');
        const panels = {
            curl: root.querySelector('#reach-snippet-curl'),
            python: root.querySelector('#reach-snippet-python'),
            simplerag: root.querySelector('#reach-snippet-simplerag')
        };
        tabs.forEach(tab => tab.addEventListener('click', () => {
            tabs.forEach(t => t.classList.remove('reach-tab-active'));
            tab.classList.add('reach-tab-active');
            Object.keys(panels).forEach(key => {
                if (panels[key]) panels[key].hidden = key !== tab.dataset.reachTab;
            });
        }));
    }

    function startPolling() {
        if (runtime.pollTimer) return;
        runtime.pollTimer = setInterval(refreshAll, POLL_INTERVAL_MS);
    }

    function stopPolling() {
        if (runtime.pollTimer) {
            clearInterval(runtime.pollTimer);
            runtime.pollTimer = null;
        }
    }

    // ------------------------------------------------------------------
    // Rendering
    // ------------------------------------------------------------------
    function refreshAll() {
        fetchJson(LOCAL_STATUS_URL, 2500)
            .then(snap => { runtime.local = snap; renderLocal(); })
            .catch(() => { runtime.local = null; renderLocal(); });
        const now = Date.now();
        if (!runtime.pointerUrl || now - runtime.pointerAt > POINTER_TTL_MS) {
            fetchJson(ENDPOINT_POINTER, 8000, true)
                .then(url => {
                    if (url) {
                        runtime.pointerUrl = url;
                        runtime.pointerAt = Date.now();
                    }
                })
                .catch(() => { /* keep the last known URL */ })
                .finally(renderPointer);
        } else {
            renderPointer();
        }
    }

    function renderPointer() {
        const urlEl = document.getElementById('reach-public-url');
        const badgeEl = document.getElementById('reach-pointer-badge');
        if (!urlEl) return;
        const url = runtime.pointerUrl;
        if (url) {
            urlEl.textContent = url;
            if (badgeEl) {
                badgeEl.textContent = '● LIVE';
                badgeEl.className = 'reach-badge reach-badge-live';
            }
        } else {
            urlEl.textContent = 'resolving… (endpoint pointer unreachable)';
            if (badgeEl) {
                badgeEl.textContent = 'OFFLINE';
                badgeEl.className = 'reach-badge reach-badge-off';
            }
        }
        const snippets = document.querySelectorAll('.reach-page pre code, .reach-page .reach-snippet-steps code');
        snippets.forEach(code => {
            if (url && code.textContent.indexOf('REACH_URL') !== -1) {
                code.textContent = code.textContent.split('REACH_URL').join(url);
            }
        });
    }

    function renderLocal() {
        const stateEl = document.getElementById('reach-relay-state');
        const dotEl = document.getElementById('reach-relay-dot');
        const upstreamEl = document.getElementById('reach-upstream-state');
        const countEl = document.getElementById('reach-relay-count');
        const uptimeEl = document.getElementById('reach-relay-uptime');
        const snap = runtime.local;
        if (!snap) {
            if (stateEl) stateEl.textContent = 'offline (this machine) — hosted endpoint still works';
            if (dotEl) dotEl.className = 'reach-dot reach-dot-off';
            if (upstreamEl) upstreamEl.textContent = 'n/a';
            return;
        }
        if (stateEl) stateEl.textContent = 'running';
        if (dotEl) dotEl.className = 'reach-dot reach-dot-on';
        if (upstreamEl) {
            upstreamEl.textContent = snap.upstream_ok
                ? 'OmniRoute ok · ' + escapeText(snap.upstream_model)
                : 'OmniRoute DOWN · relay cannot serve';
        }
        if (countEl) countEl.textContent = String(snap.requests_served || 0);
        if (uptimeEl) uptimeEl.textContent = fmtUptime(snap.uptime_s || 0);
    }

    function fmtUptime(seconds) {
        seconds = Math.max(0, Math.floor(seconds));
        const h = Math.floor(seconds / 3600);
        const m = Math.floor((seconds % 3600) / 60);
        const s = seconds % 60;
        if (h) return h + 'h ' + m + 'm';
        if (m) return m + 'm ' + s + 's';
        return s + 's';
    }

    // ------------------------------------------------------------------
    // Actions
    // ------------------------------------------------------------------
    function copyText(text) {
        if (navigator.clipboard && navigator.clipboard.writeText) {
            return navigator.clipboard.writeText(text).then(() => true).catch(() => false);
        }
        try {
            const ta = document.createElement('textarea');
            ta.value = text;
            ta.style.cssText = 'position:fixed;opacity:0;';
            document.body.appendChild(ta);
            ta.select();
            const ok = document.execCommand('copy');
            ta.remove();
            return Promise.resolve(ok);
        } catch (_e) {
            return Promise.resolve(false);
        }
    }

    function onCopy() {
        const url = runtime.pointerUrl;
        if (!url) return;
        copyText(url).then(ok => flashButton('[data-reach-copy]', ok ? 'Copied ✓' : 'Copy failed'));
    }

    function flashButton(selector, label) {
        const btn = document.querySelector(selector);
        if (!btn) return;
        const original = btn.textContent;
        btn.textContent = label;
        setTimeout(() => { btn.textContent = original; }, 1600);
    }

    function onTest() {
        if (runtime.testing) return;
        const url = runtime.pointerUrl;
        const resultEl = document.getElementById('reach-test-result');
        if (!url) {
            if (resultEl) {
                resultEl.hidden = false;
                resultEl.className = 'reach-result reach-result-error';
                resultEl.textContent = 'No public URL yet — is the tunnel up?';
            }
            return;
        }
        runtime.testing = true;
        if (resultEl) {
            resultEl.hidden = false;
            resultEl.className = 'reach-result';
            resultEl.textContent = 'Calling ' + url + '/v1/chat/completions …';
        }
        const payload = {
            model: MODEL_ID,
            messages: [{ role: 'user', content: 'Reply with exactly: REACH OK' }],
            max_tokens: 24
        };
        fetch(url + '/v1/chat/completions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        })
            .then(res => res.json().then(data => ({ ok: res.ok, data: data })))
            .then(({ ok, data }) => {
                runtime.lastTest = { ok: ok, text: '' };
                if (ok && data.choices && data.choices[0] && data.choices[0].message) {
                    runtime.lastTest.text = String(data.choices[0].message.content || '');
                    if (resultEl) {
                        resultEl.className = 'reach-result reach-result-ok';
                        resultEl.textContent = '✓ ' + runtime.lastTest.text;
                    }
                } else {
                    const message = data && data.error && data.error.message
                        ? data.error.message : JSON.stringify(data).slice(0, 300);
                    if (resultEl) {
                        resultEl.className = 'reach-result reach-result-error';
                        resultEl.textContent = '✗ ' + message;
                    }
                }
            })
            .catch(err => {
                if (resultEl) {
                    resultEl.className = 'reach-result reach-result-error';
                    resultEl.textContent = '✗ ' + err.message;
                }
            })
            .finally(() => { runtime.testing = false; });
    }

    // ------------------------------------------------------------------
    // Page controller (host contract)
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
            buildPage();
            refreshAll();
            startPolling();
        },

        renderNav(context) {
            runtime.context = context || runtime.context;
        },

        renderRibbon(context) {
            runtime.context = context || runtime.context;
        },

        renderList(context) {
            runtime.context = context || runtime.context;
        },

        renderPage(context) {
            runtime.context = context || runtime.context;
            renderPageNow();
        },

        deactivate() {
            runtime.mounted = false;
            stopPolling();
        },

        unmount() {
            runtime.mounted = false;
            stopPolling();
            removePageDom();
            window[CONTROLLER_DISPOSE_KEY] = null;
            if (window.simpleReach) delete window.simpleReach;
        }
    };

    function renderPageNow() {
        if (!runtime.mounted) buildPage();
        refreshAll();
    }

    // ------------------------------------------------------------------
    // Register with the host (script-load time)
    // ------------------------------------------------------------------
    host.registerController({
        pluginId: PLUGIN_ID,
        capabilities: MANIFEST.frontend.capabilities.slice(),
        extensionType: 'assistant',
        commandMeta: {
            'simpleReach.openPage': { icon: 'fa-satellite-dish', contexts: ['reach'], featured: true, keywords: ['reach', 'gpt-4o', 'endpoint', 'hosting', 'free'] }
        },
        commands: {
            'simpleReach.openPage': () => {
                if (typeof window.setApp === 'function') window.setApp(APP_ID);
            }
        },
        exporters: {},
        pages: { [PAGE_ID]: controller }
    });

    host.registerManifest(MANIFEST);

    // Seed the host record NOW, at script-load time — app.bundle.js defers its
    // loadPluginsFromStorage() read to DOMContentLoaded, which fires after this
    // injected script runs.
    ensureHostRecord();

    // Global handle for tests and the host command dispatcher.
    window.simpleReach = Object.freeze({
        pluginId: PLUGIN_ID,
        pageId: PAGE_ID,
        appId: APP_ID,
        version: MANIFEST.version,
        ensureHostRecord: ensureHostRecord
    });
    window[CONTROLLER_DISPOSE_KEY] = controller.unmount;
})();
