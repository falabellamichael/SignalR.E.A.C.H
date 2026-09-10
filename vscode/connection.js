'use strict';
const path = require('node:path');
const os = require('node:os');
const DEFAULT_ENDPOINT = 'https://gist.githubusercontent.com/falabellamichael/e261e0c31ad08c373bcd667b6982847a/raw/simple-reach-endpoint.txt';
let pointerCache;

async function resolveEndpoint(raw, request = fetch, depth = 0) {
    if (depth > 3) throw new Error('Endpoint pointer redirects in a loop.');
    let url = new URL(raw || DEFAULT_ENDPOINT);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Use an HTTP or HTTPS endpoint without embedded credentials.');
    if (url.hostname === 'gist.githubusercontent.com' || /\.txt(?:\/v1)?\/?$/.test(url.pathname)) {
        if (pointerCache?.raw === raw && Date.now() - pointerCache.time < 15000) return pointerCache.base;
        url.pathname = url.pathname.replace(/\/v1\/?$/, '');
        const response = await request(url.toString());
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

module.exports = { resolveEndpoint, trayDirectory, trayBinary, DEFAULT_ENDPOINT };
