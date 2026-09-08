/* SignalR.E.A.C.H Copilot tray — custom invisible browser + system tray.
 *
 * Architecture (tray UI pattern copied from SimpleRAG's electron_app/tray.js):
 *   - An INVISIBLE Electron BrowserWindow (show:false) is our own custom
 *     browser: a real Chromium render context (passes Copilot's bot checks,
 *     unlike headless), with a persistent session partition — sign in to
 *     Microsoft 365 ONCE via the tray's "Show Copilot window", then it stays
 *     signed in forever and never needs to be visible again.
 *   - The bridge HTTP server (:21302) lives IN this process: the shim
 *     (copilot_shim.py :21301) POSTs here; we drive the page via
 *     webContents (insertText + trusted sendInputEvent), exactly the input
 *     path proven by the CDP bridge v3.
 *   - Tray: left click = popover panel (status, test chat, controls);
 *     right click = native menu. Chrome/CDP/junction are all gone.
 */
'use strict';

const {
    app, BrowserWindow, Menu, Notification, Tray,
    ipcMain, nativeImage, screen, session, shell
} = require('electron');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const BRIDGE_PORT = 21302;
const COPILOT_URL = 'https://copilot.cloud.microsoft/';
const PARTITION = 'persist:copilot365';
const REPLY_TIMEOUT_MS = 180000;
const POLL_MS = 2000;
const PANEL_WIDTH = 330;
const PANEL_HEIGHT = 470;
// Microsoft hosts that are part of the auth flow — never navigate AWAY from
// these while the user is signing in (that was the "keeps refreshing" loop).
const AUTH_HOSTS = [
    'login.microsoftonline.com', 'login.live.com', 'login.microsoft.com',
    'account.live.com', 'account.microsoft.com', 'signup.live.com',
    'aadcdn.msauth.net', 'aadcdn.msftauth.net', 'logincdn.msauth.net'
];
// Hosts where the Copilot chat UI actually runs (composer is present here).
const APP_HOSTS = [
    'copilot.cloud.microsoft', 'm365.cloud.microsoft', 'copilot.microsoft.com',
    'www.bing.com', 'copilot.cloud.microsoft.us'
];
const LOG_FILE = path.join(
    process.env.LOCALAPPDATA || app.getPath('userData'),
    'SignalREACH', 'copilot-tray.log');

const COMPOSER_SELECTOR =
    '#m365-chat-editor-target-element, textarea[data-testid="composer-input"]';
const REPLY_STOP_MARKERS = [
    'Message Copilot', 'Edit in a page', 'See related content',
    'Ask a follow-up', 'People also ask', 'Related searches'
];

let tray = null;
let panel = null;
let panelReady = null;
let browserWin = null;
let bridgeServer = null;
let lastReplyAt = 0;
let lastError = '';
let queue = Promise.resolve();

/* --------------------------------- logging -------------------------------- */

function log(msg) {
    const line = new Date().toISOString().slice(11, 19) + ' ' + msg;
    try {
        fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
        fs.appendFileSync(LOG_FILE, line + '\n');
    } catch (_) { /* best effort */ }
    console.log(line);
}

/* --------------------------- invisible browser ---------------------------- */

function hostOf(url) {
    try { return new URL(url).hostname.toLowerCase(); } catch (_) { return ''; }
}
function isAuthHost(url) {
    const h = hostOf(url);
    return AUTH_HOSTS.some((a) => h === a || h.endsWith('.' + a));
}
function isAppHost(url) {
    const h = hostOf(url);
    return APP_HOSTS.some((a) => h === a || h.endsWith('.' + a));
}

function ensureBrowser() {
    if (browserWin && !browserWin.isDestroyed()) return browserWin;
    // Pin a normal desktop Chrome UA. The default Electron UA ("... Electron/x.y")
    // makes Microsoft's sign-in treat the client as an unrecognized app and can
    // force a re-auth redirect loop (the "keeps refreshing" the user hit).
    const ses = session.fromPartition(PARTITION);
    ses.setUserAgent(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
        '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36');

    browserWin = new BrowserWindow({
        width: 1180,
        height: 860,
        show: false,                 // THE invisible browser
        title: 'Copilot (SignalR.E.A.C.H)',
        autoHideMenuBar: true,
        webPreferences: {
            partition: PARTITION,
            contextIsolation: true,
            nodeIntegration: false,
            backgroundThrottling: false   // keep timers/ws alive while hidden
        }
    });

    // IMPORTANT: do NOT hijack navigation. The M365 sign-in flow is a chain of
    // real redirects (login.microsoftonline -> login.live -> fido -> back to
    // copilot...). Forcing loadURL() mid-chain is what made the window keep
    // "refreshing" and the user could never finish credentials. Let the page
    // navigate itself; only handle brand-new windows (window.open).
    browserWin.webContents.setWindowOpenHandler(({ url }) => {
        // Keep everything in THIS window so the auth session/cookies stay in
        // one place — but never force a URL (that was the loop). Just adopt it.
        if (isAuthHost(url) || isAppHost(url)) {
            browserWin.loadURL(url);
            return { action: 'deny' };
        }
        // external link (docs, terms): open in the user's real browser
        shell.openExternal(url);
        return { action: 'deny' };
    });

    // When the auth flow completes, Electron lands back on an APP host with a
    // composer — auto-hide the window so it returns to invisible on its own.
    browserWin.webContents.on('did-navigate', (_e, url) => {
        log('navigated: ' + url.slice(0, 100));
        if (isAppHost(url)) maybeAutoHideAfterSignIn();
    });
    browserWin.on('closed', () => { browserWin = null; });
    browserWin.loadURL(COPILOT_URL);
    log('invisible browser created (partition ' + PARTITION + ')');
    return browserWin;
}

// After sign-in the flow returns to an app host; once the composer exists and
// the user hasn't interacted for a moment, hide the window back to invisible.
let autoHideTimer = null;
function maybeAutoHideAfterSignIn() {
    if (!browserWin || browserWin.isDestroyed() || !browserWin.isVisible()) return;
    if (autoHideTimer) clearTimeout(autoHideTimer);
    autoHideTimer = setTimeout(async () => {
        try {
            const snap = await snapshot();
            if (snap.composer && !snap.signIn) {
                log('sign-in complete (composer present) — hiding window');
                hideBrowser();
            }
        } catch (_) { /* not ready yet */ }
    }, 6000);
}

function showBrowser() {
    const win = ensureBrowser();
    win.show();
    win.focus();
    injectPageControls();
}

// Floating control bar injected into the sign-in window so the user can
// refresh / go home / hide WITHOUT the page's own redirect loop interfering.
const CONTROLS_JS = `(() => {
    if (document.getElementById('__reachCtl')) return 'already';
    const bar = document.createElement('div');
    bar.id = '__reachCtl';
    bar.style.cssText = 'position:fixed;top:10px;right:10px;z-index:2147483647;' +
        'display:flex;gap:6px;background:rgba(27,27,31,.92);border:1px solid #3a3a44;' +
        'border-radius:8px;padding:5px 6px;font-family:Segoe UI,system-ui,sans-serif;' +
        'box-shadow:0 4px 14px rgba(0,0,0,.4);';
    const mk = (label, title, fn) => {
        const b = document.createElement('button');
        b.textContent = label; b.title = title;
        b.style.cssText = 'cursor:pointer;border:1px solid #44444e;background:#2b2b33;' +
            'color:#e8e6e0;border-radius:6px;padding:5px 9px;font-size:13px;line-height:1;';
        b.onmouseenter = () => b.style.borderColor = '#d4af37';
        b.onmouseleave = () => b.style.borderColor = '#44444e';
        b.onclick = (e) => { e.preventDefault(); e.stopPropagation(); fn(); };
        return b;
    };
    bar.appendChild(mk('⟳', 'Reload this page', () => location.reload()));
    bar.appendChild(mk('⌂', 'Back to Copilot chat', () => { location.href = ${JSON.stringify(COPILOT_URL)}; }));
    (document.body || document.documentElement).appendChild(bar);
    return 'injected';
})()`;

async function injectPageControls() {
    if (!browserWin || browserWin.isDestroyed()) return;
    try {
        await browserWin.webContents.executeJavaScript(CONTROLS_JS);
    } catch (_) { /* page not ready */ }
    // re-inject on each navigation while visible (page reloads wipe it)
    if (!browserWin.__ctlHooked) {
        browserWin.__ctlHooked = true;
        browserWin.webContents.on('did-finish-load', () => {
            if (browserWin && !browserWin.isDestroyed() && browserWin.isVisible()) {
                browserWin.webContents.executeJavaScript(CONTROLS_JS).catch(() => {});
            }
        });
    }
}

function hideBrowser() {
    if (browserWin && !browserWin.isDestroyed()) browserWin.hide();
}

function reloadBrowser() {
    const win = ensureBrowser();
    win.webContents.loadURL(COPILOT_URL);
}

async function signOutBrowser() {
    hideBrowser();
    if (browserWin && !browserWin.isDestroyed()) {
        browserWin.destroy();
        browserWin = null;
    }
    try {
        await session.fromPartition(PARTITION).clearStorageData();
        log('session cleared (signed out)');
    } catch (e) {
        log('clearStorageData failed: ' + e.message);
    }
    ensureBrowser();
}

/* ------------------------------ page driving ------------------------------ */
// Same DOM contract as bridge v3 (proven against live M365):
// reply text lives in .fai-CopilotMessage__content; markers as fallback.

const SNAPSHOT_JS = `(() => {
    const vis = (e) => !!(e.offsetWidth || e.offsetHeight);
    const stops = ${JSON.stringify(REPLY_STOP_MARKERS)};
    const trimStops = (s) => {
        for (const stop of stops) {
            const i = s.indexOf(stop);
            if (i >= 0) s = s.slice(0, i);
        }
        return s.replace(/\\s+/g, ' ').trim();
    };

    const contents = [...document.querySelectorAll('.fai-CopilotMessage__content')].filter(vis);
    let text = '';
    let count = contents.length;

    if (count) {
        text = trimStops(contents[contents.length - 1].innerText || '');
    } else {
        const body = document.body.innerText || '';
        const marker = 'Copilot said:';
        let idx = body.indexOf(marker);
        while (idx >= 0) { count++; idx = body.indexOf(marker, idx + marker.length); }
        const last = body.lastIndexOf(marker);
        if (last >= 0) text = trimStops(body.slice(last + marker.length));
        if (!text) {
            const msgs = [...document.querySelectorAll('[data-testid*="chat-message"]')].filter(vis);
            if (msgs.length) {
                count = Math.max(count, msgs.length);
                text = trimStops(msgs[msgs.length - 1].innerText || '');
            }
        }
    }

    const composer = !!document.querySelector(${JSON.stringify(COMPOSER_SELECTOR)});
    const challenge = !!document.querySelector(
        'iframe[src*="challenge"], iframe[src*="turnstile"], [id*="KmsiCheckbox"]');
    const signIn = /Sign in to your account|Sign in with a work or school/i
            .test(document.body.innerText || '') && !composer;

    return JSON.stringify({
        text: text.slice(0, 12000),
        count: count,
        composer: composer,
        challenge: challenge,
        signIn: signIn,
        url: location.href.slice(0, 140)
    });
})()`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function snapshot() {
    if (!browserWin || browserWin.isDestroyed()) throw new Error('browser closed');
    const raw = await browserWin.webContents.executeJavaScript(SNAPSHOT_JS);
    return JSON.parse(raw);
}

async function checkSignedIn() {
    try {
        const snap = await snapshot();
        if (snap.composer) return { ok: true };                 // signed in & on chat
        if (isAuthHost(snap.url)) return { ok: false, why: 'signing in (auth in progress)' };
        if (snap.signIn) return { ok: false, why: 'not signed in' };
        if (snap.challenge) return { ok: false, why: 'challenge page' };
        // On the app host but no composer yet — DON'T navigate away (the auth
        // flow may be mid-redirect; forcing a reload caused the refresh loop).
        if (isAppHost(snap.url)) return { ok: false, why: 'chat loading' };
        // Somewhere unexpected (marketing landing etc.) — go to the app once.
        browserWin.webContents.loadURL(COPILOT_URL);
        await sleep(5000);
        const snap2 = await snapshot();
        if (snap2.composer) return { ok: true };
        return { ok: false, why: snap2.signIn ? 'not signed in' : 'no composer' };
    } catch (e) {
        return { ok: false, why: e.message };
    }
}

async function sendEnter() {
    const wc = browserWin.webContents;
    // trusted key events (the v3 CDP path that Copilot's send pipeline accepts)
    wc.sendInputEvent({ type: 'rawKeyDown', keyCode: 'Enter' });
    wc.sendInputEvent({ type: 'char', keyCode: '\r' });
    wc.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' });
}

async function clickSendButton() {
    // fallback: trusted mouse click on the send button
    const box = await browserWin.webContents.executeJavaScript(`(() => {
        const sel = 'button[data-testid*="send"], button[aria-label*="Send"], button[type="submit"]';
        const b = [...document.querySelectorAll(sel)].find(e => e.offsetWidth && !e.disabled);
        if (!b) return null;
        const r = b.getBoundingClientRect();
        return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
    })()`);
    if (!box) return false;
    const wc = browserWin.webContents;
    wc.sendInputEvent({ type: 'mouseDown', x: box.x, y: box.y, button: 'left', clickCount: 1 });
    wc.sendInputEvent({ type: 'mouseUp', x: box.x, y: box.y, button: 'left', clickCount: 1 });
    return true;
}

async function copilotSend(text) {
    const auth = await checkSignedIn();
    if (!auth.ok) throw new Error(auth.why + ' — use tray menu: Show Copilot window');

    const before = await snapshot();
    const wc = browserWin.webContents;

    const focused = await wc.executeJavaScript(`(() => {
        const ta = document.querySelector(${JSON.stringify(COMPOSER_SELECTOR)});
        if (!ta) return false;
        ta.focus();
        return document.activeElement === ta ||
               ta.contains(document.activeElement) ||
               (ta.shadowRoot && ta.shadowRoot.activeElement);
    })()`);
    if (!focused) throw new Error('composer not found/focusable');

    await wc.insertText(text);          // trusted IME-style insertion
    await sleep(300);
    await sendEnter();
    await sleep(1200);

    // did the message actually go? if composer still holds the text, click Send
    const still = await wc.executeJavaScript(`(() => {
        const ta = document.querySelector(${JSON.stringify(COMPOSER_SELECTOR)});
        return ta ? (ta.innerText || ta.value || '').trim().slice(0, 40) : '';
    })()`);
    if (still && still.includes(text.slice(0, 20))) {
        log('Enter did not send — clicking send button');
        await clickSendButton();
    }

    // wait for a NEW reply, then for it to stop growing
    const deadline = Date.now() + REPLY_TIMEOUT_MS;
    let forming = null;
    let stable = 0;
    while (Date.now() < deadline) {
        await sleep(POLL_MS);
        let snap;
        try { snap = await snapshot(); } catch (e) { log('poll error: ' + e.message); continue; }
        if (snap.challenge) throw new Error('challenge page during reply');
        if (snap.signIn) throw new Error('signed out mid-conversation');
        const isNew = snap.count > before.count ||
            (snap.text && snap.text !== before.text);
        if (!isNew) continue;
        if (!forming) {
            forming = snap.text;
            stable = 0;
            continue;
        }
        if (snap.text === forming) {
            stable++;
            if (stable >= 2 && forming.length > 0) break;   // settled
        } else {
            forming = snap.text;
            stable = 0;
        }
    }
    if (!forming) throw new Error('timeout waiting for Copilot reply');
    lastReplyAt = Date.now();
    return forming;
}

/* ------------------------------ bridge server ------------------------------ */

function startBridge() {
    if (bridgeServer) return;
    bridgeServer = http.createServer((req, res) => {
        const send = (code, obj) => {
            const body = JSON.stringify(obj);
            res.writeHead(code, {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*'
            });
            res.end(body);
        };
        if (req.method === 'GET' && (req.url === '/health' || req.url === '/status')) {
            return send(200, {
                ok: true, service: 'copilot-tray', bridge: BRIDGE_PORT,
                signedIn: null, lastReplyAt, lastError,
                browserVisible: !!(browserWin && !browserWin.isDestroyed() && browserWin.isVisible())
            });
        }
        if (req.method !== 'POST' || (req.url !== '/' && req.url !== '/send')) {
            return send(404, { ok: false, error: 'not found' });
        }
        let raw = '';
        req.on('data', (c) => { raw += c; if (raw.length > 2e6) req.destroy(); });
        req.on('end', () => {
            let text = '';
            try {
                const body = JSON.parse(raw || '{}');
                const msgs = body.messages || [];
                const lastUser = [...msgs].reverse().find((m) => m.role === 'user');
                text = String((lastUser && lastUser.content) || body.text || '').slice(0, 8000);
            } catch (e) {
                return send(400, { ok: false, error: 'bad json: ' + e.message });
            }
            if (!text.trim()) return send(400, { ok: false, error: 'empty message' });
            // serialize: one conversation turn at a time
            queue = queue.then(async () => {
                const t0 = Date.now();
                try {
                    const content = await copilotSend(text);
                    log('reply ok (' + (Date.now() - t0) + 'ms, ' + content.length + ' chars)');
                    send(200, { ok: true, content, ms: Date.now() - t0 });
                } catch (e) {
                    lastError = e.message;
                    log('reply FAILED: ' + e.message);
                    send(502, { ok: false, error: e.message });
                }
            });
        });
    });
    bridgeServer.on('error', (e) => {
        log('bridge bind error: ' + e.message);
        bridgeServer = null;
    });
    bridgeServer.listen(BRIDGE_PORT, '127.0.0.1', () =>
        log('bridge listening on 127.0.0.1:' + BRIDGE_PORT));
}

/* --------------------------------- tray UI --------------------------------- */
// popover panel pattern copied from SimpleRAG electron_app/tray.js:
// frameless, skipTaskbar, alwaysOnTop, auto-hide on blur, positioned near tray

function panelWindow() {
    if (panel && !panel.isDestroyed()) return panel;
    panel = new BrowserWindow({
        width: PANEL_WIDTH,
        height: PANEL_HEIGHT,
        frame: false,
        resizable: false,
        maximizable: false,
        minimizable: false,
        fullscreenable: false,
        skipTaskbar: true,
        show: false,
        alwaysOnTop: true,
        title: 'SignalR.E.A.C.H Copilot',
        icon: path.join(__dirname, 'tray-icon.png'),
        backgroundColor: '#1b1b1f',
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true
        }
    });
    const ref = panel;
    panel.on('blur', () => {
        if (ref && !ref.isDestroyed()) ref.hide();
    });
    panel.on('closed', () => { if (panel === ref) { panel = null; panelReady = null; } });
    panel.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    panelReady = panel.loadFile(path.join(__dirname, 'panel.html'));
    return panel;
}

function positionPanelNearTray() {
    const win = panelWindow();
    let anchor = null;
    try { anchor = tray ? tray.getBounds() : null; } catch (_) { anchor = null; }
    const display = anchor
        ? screen.getDisplayNearestPoint({ x: anchor.x, y: anchor.y })
        : screen.getPrimaryDisplay();
    const area = display.workArea;
    let x = anchor
        ? Math.round(anchor.x + anchor.width / 2 - PANEL_WIDTH / 2)
        : Math.round(area.x + area.width - PANEL_WIDTH - 16);
    let y = Math.round(area.y + area.height - PANEL_HEIGHT - 8);
    if (anchor && anchor.y + anchor.height <= area.y + 2) y = anchor.y + 8;
    x = Math.max(area.x + 8, Math.min(x, area.x + area.width - PANEL_WIDTH - 8));
    y = Math.max(area.y + 8, Math.min(y, area.y + area.height - PANEL_HEIGHT - 8));
    win.setBounds({ x, y, width: PANEL_WIDTH, height: PANEL_HEIGHT });
}

async function togglePanel() {
    const win = panelWindow();
    if (win.isVisible()) { win.hide(); return; }
    if (panelReady) await panelReady;
    if (win.isDestroyed()) return;
    positionPanelNearTray();
    win.showInactive();
    win.focus();
}

function buildTrayMenu() {
    return Menu.buildFromTemplate([
        { label: 'Show Copilot Window (sign in / verify)', click: showBrowser },
        { label: 'Hide Copilot Window', click: hideBrowser },
        { type: 'separator' },
        { label: 'Refresh Page  ⟳', click: () => {
            const win = ensureBrowser();
            win.webContents.reload();
        } },
        { label: 'Back to Copilot Home', click: reloadBrowser },
        { label: 'Sign Out (clear session)', click: () => { void signOutBrowser(); } },
        { type: 'separator' },
        {
            label: 'Open Tray Panel',
            click: () => { void togglePanel(); }
        },
        { label: 'Quit Copilot Bridge', click: () => app.quit() }
    ]);
}

function createTray() {
    const iconPath = path.join(__dirname, 'tray-icon.png');
    let image = nativeImage.createFromPath(iconPath);
    if (image.isEmpty()) {
        // fallback: 16x16 gold dot so the tray is never invisible
        image = nativeImage.createEmpty();
    }
    tray = new Tray(image);
    tray.setToolTip('SignalR.E.A.C.H — Copilot bridge (invisible browser)');
    tray.setContextMenu(buildTrayMenu());
    let clickTimer = null;
    tray.on('click', () => {
        // single click: panel; double click: show the browser window
        if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; showBrowser(); return; }
        clickTimer = setTimeout(() => { clickTimer = null; void togglePanel(); }, 220);
    });
    log('tray created');
}

/* ----------------------------------- IPC ----------------------------------- */

function installIpc() {
    ipcMain.handle('tray-status', async () => {
        const auth = await checkSignedIn().catch((e) => ({ ok: false, why: e.message }));
        return {
            signedIn: !!auth.ok,
            why: auth.why || '',
            bridgePort: BRIDGE_PORT,
            bridgeUp: !!bridgeServer,
            browserVisible: !!(browserWin && !browserWin.isDestroyed() && browserWin.isVisible()),
            lastReplyAt,
            lastError,
            url: (browserWin && !browserWin.isDestroyed())
                ? browserWin.webContents.getURL().slice(0, 120) : ''
        };
    });
    ipcMain.handle('tray-test', async (_ev, text) => {
        const t0 = Date.now();
        try {
            const content = await copilotSend(String(text || 'Say OK').slice(0, 500));
            return { ok: true, content, ms: Date.now() - t0 };
        } catch (e) {
            return { ok: false, error: e.message, ms: Date.now() - t0 };
        }
    });
    ipcMain.on('show-browser', showBrowser);
    ipcMain.on('hide-browser', hideBrowser);
    ipcMain.on('reload-browser', reloadBrowser);
    ipcMain.on('refresh-page', () => {
        const win = ensureBrowser();
        win.webContents.reload();
    });
    ipcMain.on('sign-out', () => { void signOutBrowser(); });
    ipcMain.on('quit', () => app.quit());
}

/* ---------------------------------- boot ---------------------------------- */

if (!app.requestSingleInstanceLock()) {
    app.quit();
} else {
    app.on('second-instance', () => { void togglePanel(); });

    app.whenReady().then(() => {
        log('=== Copilot tray starting (pid ' + process.pid + ') ===');
        installIpc();
        startBridge();
        ensureBrowser();
        createTray();
        // sign-in check: if the session is dead, surface the window once so the
        // user can sign in (only at startup, never while running invisibly)
        setTimeout(async () => {
            const auth = await checkSignedIn();
            if (!auth.ok) {
                log('startup: ' + auth.why + ' — showing browser for sign-in');
                showBrowser();
                try {
                    new Notification({
                        title: 'SignalR.E.A.C.H Copilot',
                        body: 'Sign in to Microsoft 365 in the opened window — ' +
                              'then it runs invisibly from the tray.'
                    }).show();
                } catch (_) { /* notifications optional */ }
            } else {
                log('startup: signed in — staying invisible');
            }
        }, 8000);
    });

    // tray app: keep running with zero visible windows
    app.on('window-all-closed', (e) => { /* do NOT quit */ });

    app.on('before-quit', () => {
        try { if (bridgeServer) bridgeServer.close(); } catch (_) { /* noop */ }
        log('=== Copilot tray quitting ===');
    });
}
