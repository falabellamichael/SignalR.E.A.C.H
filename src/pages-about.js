/*
 * SignalR.E.A.C.H pages — About renderer.
 * Registers window.__reachPageRegistry.about.
 * Depends on window.__reachCore (reach-core.js) and
 * window.__reachPageWidgets (pages-common.js).
 */
(function initReachPageAbout() {
    'use strict';

    const core = window.__reachCore;
    if (!core) {
        console.error('[signal-reach] reach-core.js missing — re-run install.');
        return;
    }
    const { el, toast } = core;
    const { pageHeader, kv } =
        window.__reachPageWidgets;

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
        copy.appendChild(el('p', 'reach-copy', 'SignalR.E.A.C.H adds a hosted OpenAI-compatible endpoint with unlimited gpt-4o to SimpleRAG — no key, no quotas, for everyone. Requests relay through OmniRoute\'s codegpt provider; the public tunnel only ever exposes the keyless relay surface.'));
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
        kv(dl, 'Plugin', 'SignalR.E.A.C.H v' + core.store.version);
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
            'SignalR.E.A.C.H logs requests into an optimized SQLite database for telemetry, rate limiting, and live presence analytics. Response caching reduces upstream calls for duplicate queries.'));

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

    window.__reachPageRegistry.about = renderAbout;
})();
