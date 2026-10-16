'use strict';

// Each provider owns its sign-in and persistent browser session. This module
// never reads credentials/cookies or routes a request through CodeGPT agents.
const PROVIDERS = Object.freeze([
    Object.freeze({ id: 'claude', name: 'Claude', url: 'https://claude.ai/login' }),
    Object.freeze({ id: 'deepseek', name: 'DeepSeek', url: 'https://chat.deepseek.com/sign_in' }),
    Object.freeze({ id: 'zai', name: 'Z.ai / GLM', url: 'https://chat.z.ai/' }),
    Object.freeze({ id: 'minimax', name: 'MiniMax', url: 'https://agent.minimax.io/' }),
]);
const AUTH_HOSTS = new Set(['accounts.google.com', 'appleid.apple.com', 'account.apple.com',
    'login.microsoftonline.com', 'login.live.com']);

function allowedNavigation(provider, value) {
    try {
        const url = new URL(value);
        return url.protocol === 'https:' && !url.username && !url.password
            && (url.hostname === new URL(provider.url).hostname || AUTH_HOSTS.has(url.hostname));
    } catch (_) { return false; }
}

function createProviderLogins({ app, BrowserWindow }) {
    const windows = new Map();
    let quitting = false;
    app.on('before-quit', () => { quitting = true; });
    const list = () => PROVIDERS.map(provider => ({ ...provider,
        open: !!windows.get(provider.id) && !windows.get(provider.id).isDestroyed() }));

    async function open(id) {
        const provider = PROVIDERS.find(item => item.id === id);
        if (!provider) throw new Error('Unknown provider account.');
        await app.whenReady();
        let win = windows.get(id);
        if (!win || win.isDestroyed()) {
            const webPreferences = { partition: 'persist:direct-' + id,
                sandbox: true, contextIsolation: true, nodeIntegration: false };
            win = new BrowserWindow({ width: 1180, height: 860, show: true,
                title: provider.name + ' — SignalREACH', autoHideMenuBar: true, webPreferences });
            windows.set(id, win);
            win.webContents.setWindowOpenHandler(({ url }) => allowedNavigation(provider, url)
                ? { action: 'allow', overrideBrowserWindowOptions: { webPreferences } }
                : { action: 'deny' });
            win.webContents.on('will-navigate', (event, url) => {
                if (!allowedNavigation(provider, url)) event.preventDefault();
            });
            win.on('close', event => { if (!quitting) { event.preventDefault(); win.hide(); } });
            win.on('closed', () => { if (windows.get(id) === win) windows.delete(id); });
            await win.loadURL(provider.url);
        }
        win.show();
        win.focus();
        return { id, open: true };
    }
    return { list, open };
}

module.exports = { PROVIDERS, allowedNavigation, createProviderLogins };
