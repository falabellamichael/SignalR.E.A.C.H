'use strict';

const path = require('node:path');
const { mkdirSync } = require('node:fs');
const { app, BrowserWindow, ipcMain } = require('electron');
const { createProviderLogins } = require('./direct-providers');

// A separate app profile leaves the running tray, its drafts and existing
// signed-in ChatGPT/Copilot/Gemini sessions untouched.
const profile = path.join(app.getPath('appData'), 'signalreach-direct-providers');
mkdirSync(profile, { recursive: true });
app.setPath('userData', profile);
let dashboard;
if (!app.requestSingleInstanceLock()) app.quit();
else {
    app.on('second-instance', () => { dashboard?.show(); dashboard?.focus(); });
    app.whenReady().then(async () => {
        const providers = createProviderLogins({ app, BrowserWindow });
        dashboard = new BrowserWindow({ width: 620, height: 650, minWidth: 500, minHeight: 520,
            title: 'SignalREACH — Provider accounts', autoHideMenuBar: true,
            backgroundColor: '#10141e', webPreferences: { contextIsolation: true,
                nodeIntegration: false, sandbox: true, preload: path.join(__dirname, 'direct-login-preload.js') } });
        dashboard.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
        dashboard.webContents.on('will-navigate', event => event.preventDefault());
        const trusted = event => {
            if (event.sender !== dashboard.webContents || event.senderFrame !== dashboard.webContents.mainFrame) {
                throw new Error('Provider account controls are available only in the setup window.');
            }
        };
        ipcMain.handle('provider-logins:list', event => { trusted(event); return providers.list(); });
        ipcMain.handle('provider-logins:open', async (event, id) => {
            trusted(event);
            try { return await providers.open(id); }
            catch (_) { return { id, error: 'The provider window could not open. Try again from this setup window.' }; }
        });
        dashboard.on('closed', () => { dashboard = null; app.quit(); });
        await dashboard.loadFile(path.join(__dirname, 'direct-login.html'));
        console.info('Provider accounts window loaded.');
        if (process.argv.includes('--open-all')) {
            for (const provider of providers.list()) {
                try { await providers.open(provider.id); console.info('Opened ' + provider.name + ' account window.'); }
                catch (_) { console.warn('Could not load ' + provider.name + '; reopen it from Provider accounts.'); }
            }
        }
    });
}
