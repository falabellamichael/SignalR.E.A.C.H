// Run with the browser-automation skill runner, using about:blank as the URL.
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

export default async function (page) {
    const root = resolve(import.meta.dirname, '..');
    const settings = JSON.parse(execFileSync('python', ['-c',
        'import json, sys; sys.path.insert(0, "server"); from reachd.settings_schema import DEFAULT_SETTINGS; print(json.dumps(DEFAULT_SETTINGS))'
    ], { cwd: root, encoding: 'utf8' }));
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: '<html><head><title>Admin layout QA</title></head><body></body></html>' }));
    await page.goto('http://admin-layout.test/');
    await page.setContent('<style>html,body{margin:0;height:100%;font-family:"Segoe UI",sans-serif;background:#171c23;color:#e3e8ef}#settings-container{height:100%;overflow:auto}*{box-sizing:border-box}</style><main id="settings-container"><div class="reach-page reach-panel3"><div class="reach-content"></div></div></main>');
    for (const file of ['reach.css', 'reach-components.css', 'reach-telemetry.css', 'reach-tools.css', 'reach-theme.css', 'reach-responsive.css', 'reach-browser.css']) {
        await page.addStyleTag({ content: readFileSync(resolve(root, 'src', file), 'utf8') });
    }
    await page.evaluate(source => (0, eval)(source), readFileSync(resolve(root, 'src/reach-core.js'), 'utf8'));
    await page.evaluate(settings => {
        const core = window.__reachCore = { ...window.__reachCore };
        core.store.settings = settings;
        core.store.localChecked = true;
        core.store.local = { port: 20777, models: Object.keys(settings.models), today: { requests: 1250, tokens_in: 120000, tokens_out: 30000 }, uptime_s: 7200 };
        core.store.pointerUrl = 'https://example.test/long-endpoint-name';
        core.loadSettings = async () => settings;
        core.refreshLocal = async () => core.store.local;
        core.supervisorStatus = async () => 'ok';
        core.relayFetch = async path => ({ ok: true, json: async () => path.includes('stats')
            ? { today: core.store.local.today, models: {}, clients: [], hourly: [] }
            : { logs: Array.from({ length: 30 }, (_, i) => ({ id: i, ts: Date.now() / 1000, model: 'example-model-with-a-long-alias', ip: '192.168.100.100', status: 200, latency_ms: 123, tokens_in: 120, tokens_out: 40 })), entries: [], keys: [] } });
    }, settings);
    for (const file of ['pages-common.js', 'pages-dashboard.js', 'browser-engine.js', 'pages-browser.js', 'pages-endpoint.js', 'pages-models.js', 'pages-usage.js', 'pages-logs.js', 'pages-settings.js', 'pages-about.js', 'reach-pages.js']) {
        await page.evaluate(source => (0, eval)(source), readFileSync(resolve(root, 'src', file), 'utf8'));
    }
    const results = [];
    for (const [width, height, theme] of [[1200, 640, 'dark'], [650, 640, 'dark'], [360, 640, 'dark'], [360, 360, 'light']]) {
        await page.setViewportSize({ width: 1440, height });
        await page.evaluate(({ width, theme }) => {
            document.querySelector('#settings-container').style.width = width + 'px';
            document.documentElement.dataset.workspaceColorScheme = theme;
            document.body.style.background = theme === 'light' ? '#f5f1e9' : '#171c23';
            document.body.style.color = theme === 'light' ? '#24282e' : '#e3e8ef';
        }, { width, theme });
        for (const name of ['dashboard', 'browser', 'endpoint', 'models', 'usage', 'logs', 'settings', 'about']) {
            await page.evaluate(name => {
                window.qaCleanup?.();
                const container = document.querySelector('.reach-content');
                container.replaceChildren();
                container.className = 'reach-content';
                window.qaCleanup = window.__reachPages[name](container);
            }, name);
            await page.waitForTimeout(100);
            results.push(await page.evaluate(({ name, width, height, theme }) => {
                const host = document.querySelector('#settings-container');
                const overflow = [...document.querySelectorAll('.reach-content *')].filter(el => {
                    if (!el.getClientRects().length || el.scrollWidth <= el.clientWidth + 2) return false;
                    const style = getComputedStyle(el);
                    return ['DIV', 'FORM', 'SECTION', 'HEADER'].includes(el.tagName) && style.overflowX === 'visible';
                }).map(el => el.className);
                host.scrollTop = host.scrollHeight;
                return { name, width, height, theme, horizontalOverflow: host.scrollWidth > host.clientWidth + 2, scrollable: host.scrollHeight <= host.clientHeight || host.scrollTop > 0, overflow };
            }, { name, width, height, theme }));
        }
    }
    await page.screenshot({ path: resolve(root, '.tmp/admin-about.png'), fullPage: true });
    const failures = results.filter(result => result.horizontalOverflow || !result.scrollable || result.overflow.length);
    if (errors.length || failures.length) throw new Error(JSON.stringify({ failures, errors }));
    return { checked: results.length, results, errors };
}
