/*
 * SimpleREACH pages — assembly of the eight REACH panel renderers.
 * Exposes window.__reachPages: {dashboard, browser, endpoint, models, usage, logs,
 * settings, about}. Each render(container) returns a cleanup function.
 *
 * Renderers live in one file per page (pages-<id>.js) and register
 * themselves on window.__reachPageRegistry before this file loads.
 * Depends on window.__reachCore (reach-core.js) and
 * window.__reachPageWidgets (pages-common.js).
 */
(function initReachPages() {
    'use strict';

    const core = window.__reachCore;
    if (!core) {
        console.error('[signal-reach] reach-core.js missing — re-run install.');
        return;
    }

    const PAGE_DEFS = [
        { id: 'dashboard', icon: 'fa-gauge-high', label: 'Dashboard' },
        { id: 'browser', icon: 'fa-globe', label: 'Browser' },
        { id: 'endpoint', icon: 'fa-link', label: 'Endpoint' },
        { id: 'models', icon: 'fa-cubes', label: 'Models' },
        { id: 'usage', icon: 'fa-chart-column', label: 'Usage' },
        { id: 'logs', icon: 'fa-list', label: 'Logs' },
        { id: 'settings', icon: 'fa-sliders', label: 'Settings' },
        { id: 'about', icon: 'fa-circle-info', label: 'About' }
    ];

    const registry = window.__reachPageRegistry;
    if (!registry) {
        const err = new Error('[signal-reach] MissingPageRegistryError: '
            + 'window.__reachPageRegistry is undefined — the pages-<id>.js '
            + 'renderers did not run before reach-pages.js. Check the script '
            + 'load order (SCRIPT_SOURCES in tools/reach/__init__.py) or '
            + 're-run the installer.');
        err.name = 'MissingPageRegistryError';
        throw err;
    }

    const missing = PAGE_DEFS
        .filter((def) => typeof registry[def.id] !== 'function')
        .map((def) => def.id);
    if (missing.length) {
        const err = new Error('[signal-reach] MissingPagesError: renderers '
            + 'not registered for: ' + missing.join(', ')
            + ' — the pages-<id>.js files must load before reach-pages.js. '
            + 'Check SCRIPT_SOURCES in tools/reach/__init__.py.');
        err.name = 'MissingPagesError';
        throw err;
    }

    window.__reachPages = Object.freeze({
        defs: PAGE_DEFS,
        dashboard: registry.dashboard,
        browser: registry.browser,
        endpoint: registry.endpoint,
        models: registry.models,
        usage: registry.usage,
        logs: registry.logs,
        settings: registry.settings,
        about: registry.about
    });
})();
