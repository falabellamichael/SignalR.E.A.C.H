const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PROVIDERS, allowedNavigation, createProviderLogins } = require('../copilot/tray/direct-providers');

test('direct sign-in allows only its own provider and ordinary OAuth destinations', () => {
    for (const provider of PROVIDERS) {
        assert.equal(allowedNavigation(provider, provider.url), true);
        assert.equal(allowedNavigation(provider, 'https://accounts.google.com/signin'), true);
        for (const url of ['http://claude.ai/', 'https://claude.ai.evil.example/', 'file:///C:/private',
            'javascript:alert(1)', 'https://user:password@accounts.google.com/', 'https://codegpt.co/']) {
            assert.equal(allowedNavigation(provider, url), false);
        }
    }
});

test('each provider has an isolated sandbox and reopening preserves the same window and page', async () => {
    const app = new EventEmitter(); app.whenReady = async () => {};
    const created = [];
    class BrowserWindow extends EventEmitter {
        constructor(options) { super(); this.options = options; this.webContents = new EventEmitter();
            this.webContents.setWindowOpenHandler = handler => { this.popup = handler; }; created.push(this); }
        isDestroyed() { return false; }
        async loadURL(url) { this.loaded = url; this.loads = (this.loads || 0) + 1; }
        show() {} focus() {} hide() { this.hidden = true; }
    }
    const logins = createProviderLogins({ app, BrowserWindow });
    await assert.rejects(logins.open('unknown-provider'));
    for (const provider of PROVIDERS) { await logins.open(provider.id); await logins.open(provider.id); }
    assert.equal(created.length, 4);
    assert.equal(new Set(created.map(win => win.options.webPreferences.partition)).size, 4);
    for (const [index, win] of created.entries()) {
        assert.equal(win.loads, 1); assert.equal(win.loaded, PROVIDERS[index].url);
        assert.equal(win.options.webPreferences.nodeIntegration, false);
        assert.equal(win.options.webPreferences.contextIsolation, true);
        assert.equal(win.options.webPreferences.sandbox, true);
        assert.equal(win.options.webPreferences.preload, undefined);
        assert.deepEqual(win.popup({ url: 'https://codegpt.co/' }), { action: 'deny' });
        let prevented = false;
        win.emit('close', { preventDefault() { prevented = true; } });
        assert.equal(prevented, true); assert.equal(win.hidden, true);
    }
    assert.ok(logins.list().every(provider => provider.open));
    app.emit('before-quit');
    let prevented = false;
    created[0].emit('close', { preventDefault() { prevented = true; } });
    assert.equal(prevented, false);
});
