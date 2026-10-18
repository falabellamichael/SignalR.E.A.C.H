'use strict';
const path = require('node:path');
const os = require('node:os');
const DEFAULT_ENDPOINT = 'https://gist.githubusercontent.com/falabellamichael/e261e0c31ad08c373bcd667b6982847a/raw/simple-reach-endpoint.txt';
const DEFAULT_ACCOUNT_ORIGIN = 'https://unbent-semicolon-hermit.ngrok-free.dev';
let pointerCache;

// The hosted GPU service has a separate, metered account connection. A saved
// relay URL or the old endpoint pointer must not turn it into a custom provider.
function isReachEndpoint(raw, accountOrigin = DEFAULT_ACCOUNT_ORIGIN) {
    let url;
    try { url = new URL(raw); } catch { return false; }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return false;
    const pathname = url.pathname.replace(/\/+$/, '').replace(/\/v1$/, '');
    const pointer = new URL(DEFAULT_ENDPOINT);
    if (url.origin === pointer.origin && pathname === pointer.pathname) return true;
    if (pathname) return false;
    if (url.origin === DEFAULT_ACCOUNT_ORIGIN || url.origin === accountOrigin) return true;
    return (['localhost', '[::1]'].includes(url.hostname) || /^127(?:\.\d{1,3}){3}$/.test(url.hostname)
        || /^\[::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}\]$/i.test(url.hostname))
        && ['20777', '20978'].includes(url.port);
}

async function resolveEndpoint(raw, request = fetch, depth = 0) {
    if (depth > 3) throw new Error('Endpoint pointer redirects in a loop.');
    let url = new URL(raw || DEFAULT_ENDPOINT);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Use an HTTP or HTTPS endpoint without embedded credentials.');
    if (url.hostname === 'gist.githubusercontent.com' || /\.txt(?:\/v1)?\/?$/.test(url.pathname)) {
        if (pointerCache?.raw === raw && Date.now() - pointerCache.time < 15000) return pointerCache.base;
        url.pathname = url.pathname.replace(/\/v1\/?$/, '');
        const response = await request(url.toString(), { signal: AbortSignal.timeout(15000) });
        if (!response.ok) throw new Error(`Endpoint pointer returned HTTP ${response.status}`);
        const target = (await response.text()).trim();
        const base = await resolveEndpoint(target, request, depth + 1);
        pointerCache = { raw, time: Date.now(), base };
        return base;
    }
    url.pathname = url.pathname.replace(/\/+$/, '').replace(/\/v1$/, '') + '/v1';
    url.search = ''; url.hash = '';
    return url.toString().replace(/\/$/, '');
}

function trayDirectory(platform = process.platform, env = process.env, home = os.homedir()) {
    const base = platform === 'win32' ? env.LOCALAPPDATA || path.join(home, 'AppData', 'Local')
        : platform === 'darwin' ? path.join(home, 'Library', 'Application Support')
        : env.XDG_CONFIG_HOME || path.join(home, '.config');
    return path.join(base, 'SignalREACH', 'copilot', 'tray');
}
function trayBinary(dir, platform = process.platform) {
    const dist = path.join(dir, 'node_modules', 'electron', 'dist');
    return platform === 'darwin' ? path.join(dist, 'Electron.app', 'Contents', 'MacOS', 'Electron')
        : path.join(dist, platform === 'win32' ? 'electron.exe' : 'electron');
}

module.exports = { resolveEndpoint, trayDirectory, trayBinary, DEFAULT_ENDPOINT, DEFAULT_ACCOUNT_ORIGIN, isReachEndpoint };
