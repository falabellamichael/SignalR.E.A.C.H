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
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');
// Keep the existing Copilot session directory across source and packaged launches.
app.setPath('userData', path.join(app.getPath('appData'), 'signalreach-copilot-tray'));
const { createEndpointClient } = require('./endpoint');
const { economyModelFor, economyBridgeIds, economyCatalogInfo, refreshEconomyModels, ECONOMY_PREFIX, discoverCodegptApiPort } = require('./economy-models');
const endpoints = createEndpointClient(path.join(app.getPath('userData'), 'tray-settings.json'));
let clickTimer = null;
let isQuitting = false;

const BRIDGE_PORT = 21302;
const COPILOT_URL = 'https://m365.cloud.microsoft/chat';
const PARTITION = 'persist:copilot365';

const CHATGPT_URL = 'https://chatgpt.com';
const CHATGPT_PARTITION = 'persist:chatgpt';

const POLL_MS = 2000;
const PANEL_WIDTH = 360;
const PANEL_HEIGHT = 520;
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

// ChatGPT auth + app hosts
const CHATGPT_AUTH_HOSTS = [
    'auth0.openai.com', 'auth.openai.com', 'accounts.google.com',
    'login.microsoftonline.com', 'appleid.apple.com'
];
const CHATGPT_APP_HOSTS = [
    'chatgpt.com', 'chat.openai.com'
];

// CodeGPT (interactive economy models) — app + auth hosts
const CODEGPT_URL = 'https://app.codegpt.co/';
// The signed-in chat lives in the extension's LOCAL sidecar app (Next server
// on 54112). Its picker carries the full catalog including the unlimited
// economy rows (DeepSeek V4.1 Flash, GLM 5.3 Flash, Gemini 3.8 Flash, GPT 5.6
// Luna, ...), which the hosted web app does not offer. Drive the local page.
// The path is the EXTENSION DRIVER port, not the Next web-server port — and
// the extension re-allocates that driver port on every activation, so it is
// discovered live (economy-models.js) instead of pinned: a pinned port is how
// the page started answering with HTML instead of the chat backend.
const CODEGPT_SIDECAR_PORT = 54112;
const CODEGPT_CHAT_FALLBACK = 'http://localhost:54112/54113/';
async function codegptChatUrl({ force = false } = {}) {
    const driver = await discoverCodegptApiPort({ force });
    if (driver) return 'http://localhost:' + CODEGPT_SIDECAR_PORT + '/' + driver + '/';
    log('codegpt driver port not found — using fallback chat url');
    return CODEGPT_CHAT_FALLBACK;
}
const CODEGPT_PARTITION = 'persist:codegpt';
// Pinned DOM contract (local app, discovered live 2026-09-10): the chat
// composer; kept alongside the hosted-app shapes so either page can load.
const CODEGPT_COMPOSER_SELECTOR = 'textarea#inputMessage, textarea[placeholder="Enter your message"], textarea.mentions';
const CODEGPT_AUTH_HOSTS = [
    'accounts.google.com', 'accounts.youtube.com', 'myaccount.google.com',
    'github.com', 'appleid.apple.com', 'login.microsoftonline.com'
];
const CODEGPT_APP_HOSTS = [
    'app.codegpt.co', 'www.codegpt.co', 'codegpt.co',
    'localhost', '127.0.0.1' // the extension's local sidecar chat page
];
const LOG_FILE = process.platform === 'darwin'
    ? path.join(app.getPath('appData'), 'SignalREACH', 'copilot-tray.log')
    : path.join(process.env.LOCALAPPDATA || app.getPath('userData'), 'SignalREACH', 'copilot-tray.log');

const COMPOSER_SELECTOR =
    '#m365-chat-editor-target-element, textarea[data-testid="composer-input"]';
const REPLY_STOP_MARKERS = [
    'Message Copilot', 'Edit in a page', 'See related content',
    'Ask a follow-up', 'People also ask', 'Related searches'
];

// ChatGPT DOM selectors
const CHATGPT_COMPOSER_SELECTOR =
    '#prompt-textarea, div[contenteditable="true"][id="prompt-textarea"], textarea[placeholder*="Message"]';
const CHATGPT_SEND_SELECTOR =
    'button[data-testid="send-button"], button[aria-label="Send prompt"], form button[type="submit"]';

let tray = null;
let panel = null;
let panelReady = null;
let browserWin = null;
let chatgptWin = null;
let codegptWin = null;
let bridgeServer = null;
let lastReplyAt = 0;
let lastError = '';
// Which economy model the last CodeGPT request asked for, and which one the
// app's own API actually answered with (read off the intercepted response).
let lastCodegptRequested = '';
let lastCodegptServed = '';


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
function isChatgptAuthHost(url) {
    const h = hostOf(url);
    return CHATGPT_AUTH_HOSTS.some((a) => h === a || h.endsWith('.' + a));
}
function isChatgptAppHost(url) {
    const h = hostOf(url);
    return CHATGPT_APP_HOSTS.some((a) => h === a || h.endsWith('.' + a));
}

function configureSession(ses) {
    const defaultUA = `Mozilla/5.0 (${process.platform === 'darwin' ? 'Macintosh; Intel Mac OS X 10_15_7' : process.platform === 'linux' ? 'X11; Linux x86_64' : 'Windows NT 10.0; Win64; x64'}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36`;
    ses.setUserAgent(defaultUA);

    // Google OAuth rejects Chromium/Electron webviews ("This browser or app may not be secure"
    // redirecting to accounts.google.com/v3/signin/rejected) when using Chrome User-Agents
    // without matching client hints. Using a standard Firefox User-Agent without sec-ch-ua
    // headers on Google login hosts allows Google account sign-in to complete normally.
    const firefoxUA = process.platform === 'darwin'
        ? 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:134.0) Gecko/20100101 Firefox/134.0'
        : (process.platform === 'linux'
            ? 'Mozilla/5.0 (X11; Linux x86_64; rv:134.0) Gecko/20100101 Firefox/134.0'
            : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:134.0) Gecko/20100101 Firefox/134.0');

    try {
        ses.webRequest.onBeforeSendHeaders({ urls: ['*://accounts.google.com/*', '*://*.google.com/*'] }, (details, callback) => {
            delete details.requestHeaders['sec-ch-ua'];
            delete details.requestHeaders['sec-ch-ua-mobile'];
            delete details.requestHeaders['sec-ch-ua-platform'];
            details.requestHeaders['User-Agent'] = firefoxUA;
            callback({ cancel: false, requestHeaders: details.requestHeaders });
        });
    } catch (_) { /* if already attached */ }
}

function ensureBrowser() {
    if (browserWin && !browserWin.isDestroyed()) return browserWin;
    // Pin a normal desktop Chrome UA. The default Electron UA ("... Electron/x.y")
    // makes Microsoft's sign-in treat the client as an unrecognized app and can
    // force a re-auth redirect loop (the "keeps refreshing" the user hit).
    const ses = session.fromPartition(PARTITION);
    configureSession(ses);

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
    browserWin.on('close', (event) => {
        if (!isQuitting) { event.preventDefault(); hideBrowser(); }
    });
    browserWin.on('closed', () => { browserWin = null; });
    browserWin.loadURL(COPILOT_URL);
    // Install the shared tile up-front (not only on first show) so the
    // account/user icon is covered from the very first paint.
    void installControlTile(browserWin, {
        homeUrl: COPILOT_URL, accent: '#d4af37', homeTitle: 'Back to Copilot chat'
    });
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
    if (process.platform === 'darwin' && app.dock) {
        try { app.dock.show(); } catch (_) {}
    }
    win.show();
    win.focus();
    injectPageControls();
    refreshNativeMenus();
}

/* ---------------- ONE shared control tile for every page ------------------- */
// The same docked tile (⟳ reload · ⌂ home) is injected into ALL embedded chat
// windows (M365 Copilot, ChatGPT, CodeGPT). It is anchored FLUSH to the
// top-right corner of the page's top ribbon and sized big enough to fully
// block the account/user icon area — that icon must never peek out, on any
// page, at any time. The tile is a true BLOCKER: every click and wheel event
// that lands on it is swallowed — nothing underneath is reachable — while
// its own two buttons keep working. An in-page MutationObserver
// re-attaches the tile whenever the page's SPA re-render rips it out, and
// every inject rebuilds it, so the cover is ALWAYS on and always current.
function reachControlTileJs({ homeUrl, accent = '#d4af37', homeTitle = 'Back to chat' } = {}) {
    return `(() => {
    const HOST = document.body || document.documentElement;
    if (!HOST) return 'no-body';
    const build = () => {
        const bar = document.createElement('div');
        bar.id = '__reachCtl';
        bar.style.cssText = 'position:fixed;top:0;right:0;z-index:2147483647;' +
            'display:flex;align-items:center;gap:8px;box-sizing:border-box;' +
            'min-height:58px;min-width:156px;padding:8px 12px;' +
            'background:#1b1b1f;border:1px solid #3a3a44;border-top:none;border-right:none;' +
            'border-radius:0 0 0 16px;box-shadow:0 6px 18px rgba(0,0,0,.45);' +
            'font-family:Segoe UI,system-ui,sans-serif;pointer-events:auto;';
        const mk = (label, title, fn) => {
            const b = document.createElement('button');
            b.textContent = label; b.title = title;
            b.style.cssText = 'cursor:pointer;width:42px;height:42px;' +
                'padding:0;border:1px solid #44444e;background:#2b2b33;color:#e8e6e0;' +
                'border-radius:10px;font-size:20px;line-height:1;';
            b.onmouseenter = () => b.style.borderColor = ${JSON.stringify(accent)};
            b.onmouseleave = () => b.style.borderColor = '#44444e';
            b.onclick = (e) => { e.preventDefault(); e.stopPropagation(); fn(); };
            return b;
        };
        bar.appendChild(mk('⟳', 'Reload this page', () => location.reload()));
        bar.appendChild(mk('⌂', ${JSON.stringify(homeTitle)}, () => { location.href = ${JSON.stringify(homeUrl)}; }));
        // true blocker: the tile itself must swallow stray clicks and wheel
        // events — nothing under it is reachable (only the two buttons act).
        bar.addEventListener('click', (e) => { if (e.target === bar) { e.preventDefault(); e.stopPropagation(); } });
        bar.addEventListener('wheel', (e) => e.preventDefault(), { passive: false });
        return bar;
    };
    const old = document.getElementById('__reachCtl');
    if (old) old.remove();
    HOST.appendChild(build());
    window.__reachCtlBuild = build;   // newest builder wins for auto re-attach
    if (!window.__reachCtlWatch) {
        window.__reachCtlWatch = true;
        new MutationObserver(() => {
            if (!document.getElementById('__reachCtl')) {
                (document.body || document.documentElement)
                    .appendChild((window.__reachCtlBuild || build)());
            }
        }).observe(document.documentElement, { childList: true, subtree: true });
    }
    return 'injected';
})()`;
}

// Attach (or refresh) the shared tile on an embedded window and keep it fresh
// across every load and in-page navigation — the ONE fix used by all windows.
async function installControlTile(win, opts) {
    if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return;
    win.__ctlOpts = opts;  // latest wins: CodeGPT's home URL moves per activation
    const inject = () => {
        if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return;
        win.webContents.executeJavaScript(reachControlTileJs(win.__ctlOpts)).catch(() => {});
    };
    try {
        await win.webContents.executeJavaScript(reachControlTileJs(win.__ctlOpts));
    } catch (_) { /* page not ready yet */ }
    if (!win.__ctlHooked) {
        win.__ctlHooked = true;
        win.webContents.on('dom-ready', inject);             // cover from first paint
        win.webContents.on('did-finish-load', inject);       // full document load
        win.webContents.on('did-navigate-in-page', inject);  // SPA route swaps
    }
}

async function injectPageControls() {
    await installControlTile(browserWin, {
        homeUrl: COPILOT_URL, accent: '#d4af37', homeTitle: 'Back to Copilot chat'
    });
}

function hideBrowser() {
    if (browserWin && !browserWin.isDestroyed()) browserWin.hide();
    refreshNativeMenus();
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

/* ======================== ChatGPT invisible browser ======================== */

function ensureChatgpt() {
    if (chatgptWin && !chatgptWin.isDestroyed()) return chatgptWin;
    const ses = session.fromPartition(CHATGPT_PARTITION);
    configureSession(ses);

    chatgptWin = new BrowserWindow({
        width: 1180, height: 860, show: false,
        title: 'ChatGPT (SignalR.E.A.C.H)',
        autoHideMenuBar: true,
        webPreferences: {
            partition: CHATGPT_PARTITION,
            contextIsolation: true,
            nodeIntegration: false,
            backgroundThrottling: false
        }
    });

    chatgptWin.webContents.setWindowOpenHandler(({ url }) => {
        if (isChatgptAuthHost(url) || isChatgptAppHost(url)) {
            chatgptWin.loadURL(url);
            return { action: 'deny' };
        }
        shell.openExternal(url);
        return { action: 'deny' };
    });

    chatgptWin.webContents.on('did-navigate', (_e, url) => {
        log('chatgpt navigated: ' + url.slice(0, 100));
        if (isChatgptAppHost(url)) maybeAutoHideChatgpt();
    });
    chatgptWin.on('close', (event) => {
        if (!isQuitting) { event.preventDefault(); hideChatgpt(); }
    });
    chatgptWin.on('closed', () => { chatgptWin = null; });
    chatgptWin.loadURL(CHATGPT_URL);
    void installControlTile(chatgptWin, {
        homeUrl: CHATGPT_URL, accent: '#10a37f', homeTitle: 'Back to ChatGPT'
    });
    log('chatgpt invisible browser created (partition ' + CHATGPT_PARTITION + ')');
    return chatgptWin;
}

let chatgptAutoHideTimer = null;
function maybeAutoHideChatgpt() {
    if (!chatgptWin || chatgptWin.isDestroyed() || !chatgptWin.isVisible()) return;
    if (chatgptAutoHideTimer) clearTimeout(chatgptAutoHideTimer);
    chatgptAutoHideTimer = setTimeout(async () => {
        try {
            const snap = await chatgptSnapshot();
            if (snap.composer && !snap.signIn) {
                log('chatgpt sign-in complete — hiding window');
                hideChatgpt();
            }
        } catch (_) { /* not ready yet */ }
    }, 6000);
}

function showChatgpt() {
    const win = ensureChatgpt();
    if (process.platform === 'darwin' && app.dock) {
        try { app.dock.show(); } catch (_) {}
    }
    win.show();
    win.focus();
    injectChatgptControls();
    refreshNativeMenus();
}

async function injectChatgptControls() {
    await installControlTile(chatgptWin, {
        homeUrl: CHATGPT_URL, accent: '#10a37f', homeTitle: 'Back to ChatGPT'
    });
}

function hideChatgpt() {
    if (chatgptWin && !chatgptWin.isDestroyed()) chatgptWin.hide();
    refreshNativeMenus();
}

function reloadChatgpt() {
    const win = ensureChatgpt();
    win.webContents.loadURL(CHATGPT_URL);
}

async function signOutChatgpt() {
    hideChatgpt();
    if (chatgptWin && !chatgptWin.isDestroyed()) {
        chatgptWin.destroy();
        chatgptWin = null;
    }
    try {
        await session.fromPartition(CHATGPT_PARTITION).clearStorageData();
        log('chatgpt session cleared (signed out)');
    } catch (e) {
        log('chatgpt clearStorageData failed: ' + e.message);
    }
    ensureChatgpt();
}

/* ======================== CodeGPT invisible browser ======================== */
/* Interactive CodeGPT session (economy models — unlimited for Professional
 * members). The window drives the extension's LOCAL sidecar chat page
 * (http://localhost:54112/<port>/), which is the only place that offers the
 * economy model rows; the hosted web app does not list them. DOM contract is
 * pinned at runtime; debug it via GET http://127.0.0.1:21302/debug/dom. */

function isCodegptAuthHost(url) {
    const h = hostOf(url);
    return CODEGPT_AUTH_HOSTS.some((a) => h === a || h.endsWith('.' + a));
}
function isCodegptAppHost(url) {
    const h = hostOf(url);
    return CODEGPT_APP_HOSTS.some((a) => h === a || h.endsWith('.' + a));
}

function ensureCodegpt() {
    if (codegptWin && !codegptWin.isDestroyed()) return codegptWin;
    const ses = session.fromPartition(CODEGPT_PARTITION);
    configureSession(ses);

    codegptWin = new BrowserWindow({
        width: 1180, height: 860, show: false,
        title: 'CodeGPT (SignalR.E.A.C.H)',
        autoHideMenuBar: true,
        webPreferences: {
            partition: CODEGPT_PARTITION,
            contextIsolation: true,
            nodeIntegration: false,
            backgroundThrottling: false
        }
    });

    codegptWin.webContents.setWindowOpenHandler(({ url }) => {
        if (isCodegptAuthHost(url) || isCodegptAppHost(url)) {
            codegptWin.loadURL(url);
            return { action: 'deny' };
        }
        shell.openExternal(url);
        return { action: 'deny' };
    });

    codegptWin.webContents.on('did-navigate', (_e, url) => {
        log('codegpt navigated: ' + url.slice(0, 100));
        if (isCodegptAppHost(url)) maybeAutoHideCodegpt();
    });
    // Request logger (diagnostic): watch the app's own API traffic so failed
    // sends are visible server-side instead of guessing from the DOM.
    try {
        if (!ses.__reqLogHooked) {
            ses.__reqLogHooked = true;
            ses.webRequest.onBeforeRequest({ urls: ['*://api.codegpt.co/*', '*://*.codegpt.co/api/*'] }, (details, callback) => {
                if (details.method === 'POST') log('codegpt api POST ' + details.url.slice(0, 120));
                callback({ cancel: false });
            });
            ses.webRequest.onCompleted({ urls: ['*://api.codegpt.co/*', '*://*.codegpt.co/api/*'] }, (details) => {
                if (details.method === 'POST' && String(details.url).includes('playground')) {
                    log('codegpt api playground -> ' + details.statusCode + ' (' + details.url.slice(0, 90) + ')');
                } else if (details.method === 'POST' && details.statusCode >= 400) {
                    log('codegpt api POST failed ' + details.statusCode + ' ' + details.url.slice(0, 120));
                }
            });
        }
    } catch (_) { /* logger is best-effort */ }
    // CDP debugger: capture the playground stream's buffered response body.
    try {
        const dbg = codegptWin.webContents.debugger;
        if (!dbg.isAttached()) {
            dbg.attach('1.3');
            dbg.sendCommand('Network.enable');
            dbg.on('message', (_e, method, params) => {
                if (method === 'Network.responseReceived' && params.response
                        && String(params.response.url).includes('playground')) {
                    const rid = params.requestId;
                    setTimeout(() => {
                        dbg.sendCommand('Network.getResponseBody', { requestId: rid })
                            .then(r => { global.__cgPlaygroundBody = String(r.body || '').slice(0, 4000); })
                            .catch(() => { global.__cgPlaygroundBody = '(body unavailable yet)'; });
                    }, 2500);
                }
            });
            log('codegpt CDP network capture attached');
        }
    } catch (_) { /* best effort */ }
    codegptWin.on('close', (event) => {
        if (!isQuitting) { event.preventDefault(); hideCodegpt(); }
    });
    codegptWin.on('closed', () => { codegptWin = null; });
    codegptChatUrl().then((url) => {
        if (codegptWin && !codegptWin.isDestroyed()) {
            log('codegpt chat url: ' + url);
            codegptWin.webContents.loadURL(url);
            void installControlTile(codegptWin, {
                homeUrl: url, accent: '#d4af37', homeTitle: 'Back to CodeGPT chat'
            });
        }
    }).catch(() => {});
    log('codegpt invisible browser created (partition ' + CODEGPT_PARTITION + ')');
    return codegptWin;
}

let codegptAutoHideTimer = null;
let codegptKeepVisible = process.env.REACH_CODEGPT_VISIBLE === '1';   // diagnostic: keep the window visible to test streaming
function maybeAutoHideCodegpt() {
    if (codegptKeepVisible) return;
    if (!codegptWin || codegptWin.isDestroyed() || !codegptWin.isVisible()) return;
    if (codegptAutoHideTimer) clearTimeout(codegptAutoHideTimer);
    codegptAutoHideTimer = setTimeout(async () => {
        try {
            const snap = await codegptSnapshot();
            if (snap.composer && !snap.signIn) {
                log('codegpt sign-in complete — hiding window');
                hideCodegpt();
            }
        } catch (_) { /* not ready yet */ }
    }, 6000);
}

function showCodegpt() {
    const win = ensureCodegpt();
    if (process.platform === 'darwin' && app.dock) {
        try { app.dock.show(); } catch (_) {}
    }
    win.show();
    win.focus();
    injectCodegptControls();
    refreshNativeMenus();
}

async function injectCodegptControls() {
    if (!codegptWin || codegptWin.isDestroyed()) return;
    await installControlTile(codegptWin, {
        homeUrl: await codegptChatUrl(), accent: '#d4af37', homeTitle: 'Back to CodeGPT chat'
    });
}

function hideCodegpt() {
    if (codegptWin && !codegptWin.isDestroyed()) codegptWin.hide();
    refreshNativeMenus();
}

function reloadCodegpt() {
    const win = ensureCodegpt();
    // An explicit reload is the retry path after a failed load, so rescan the
    // driver port instead of trusting the cache.
    codegptChatUrl({ force: true }).then((url) => {
        if (win && !win.isDestroyed()) win.webContents.loadURL(url);
    }).catch(() => {});
}

async function signOutCodegpt() {
    hideCodegpt();
    if (codegptWin && !codegptWin.isDestroyed()) {
        codegptWin.destroy();
        codegptWin = null;
    }
    try {
        await session.fromPartition(CODEGPT_PARTITION).clearStorageData();
        log('codegpt session cleared (signed out)');
    } catch (e) {
        log('codegpt clearStorageData failed: ' + e.message);
    }
    ensureCodegpt();
}

/* ---------------------- CodeGPT page driving (discovery) ---------------------- */

// In-page hook: wrap fetch + XHR to capture the chat/playground response
// body into window.__reachCg — the assistant reply, verbatim.
const CODEGPT_HOOK_JS = `(() => {
    if (window.__reachHook) return 'already';
    window.__reachHook = true;
    const relevant = (url) => /playground|\\/api\\/runs(?:[/?]|$)/.test(String(url || ''));
    const grab = (url, status, body) => {
        if (relevant(url)) {
            window.__reachCg = { status, body: String(body), ts: Date.now(), pending: false,
                run: String(url).includes('/api/runs') };
        }
    };
    const of = window.fetch;
    window.fetch = async (...args) => {
        const url = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url) || '';
        const capture = relevant(url);
        if (capture) window.__reachCg = { pending: true, ts: Date.now() };
        try {
            const res = await of(...args);
            if (capture) res.clone().text().then(t => grab(url, res.status, t))
                .catch(e => grab(url, 502, JSON.stringify({ error: e.message })));
            return res;
        } catch (e) {
            if (capture) grab(url, 502, JSON.stringify({ error: e.message }));
            throw e;
        }
    };
    const OXHR = window.XMLHttpRequest;
    window.XMLHttpRequest = class extends OXHR {
        constructor() { super(); this.__url = ''; }
        open(...a) { this.__url = String(a[1] || ''); return super.open(...a); }
        send(...a) {
            this.addEventListener('load', () => {
                grab(this.__url, this.status, this.responseText);
            });
            return super.send(...a);
        }
    };
    return 'hooked';
})()`;

const CODEGPT_SNAPSHOT_JS = `(() => {
    const vis = (e) => !!(e.offsetWidth || e.offsetHeight);
    try {
        const editableSel = 'textarea, [contenteditable="true"], [role="textbox"]';
        const ed = [...document.querySelectorAll(editableSel)].filter(vis);
        // Pinned composer first; fall back to the last visible editable.
        const composerEl = document.querySelector(${JSON.stringify(CODEGPT_COMPOSER_SELECTOR)})
            || (ed.length ? ed[ed.length - 1] : null);
        const msgSel = '[class*="message" i], [class*="bubble" i], [class*="answer" i], ' +
            '[class*="response" i], [class*="markdown" i], [class*="prose" i], [class*="chat-result" i], ' +
            '[class*="conversation" i], [class*="whitespace-pre-wrap"], [data-testid*="message" i], [data-testid*="chat" i]';
        // The LOCAL app renders one div.message-block per message with an
        // explicit role class (div.message.user / div.message.assistant); the
        // hosted app uses looser containers. Prefer role-aware blocks.
        const roleBlocks = [...document.querySelectorAll('[class*="message-block" i]')].filter(vis);
        const roleAware = roleBlocks.length > 0;
        const roleOf = (m) => {
            const nodes = [m].concat([...m.querySelectorAll('*')].slice(0, 60));
            for (const n of nodes) {
                const cls = ' ' + String(n.className || '') + ' ';
                if (/\\sassistant\\s/.test(cls)) return 'assistant';
                if (/\\suser\\s/.test(cls)) return 'user';
            }
            return '';
        };
        let msgs;
        if (roleAware) {
            msgs = roleBlocks;
        } else {
            msgs = [...document.querySelectorAll(msgSel)].filter(vis)
                .filter(m => !m.querySelector('textarea, [contenteditable="true"]') && !m.closest('textarea, [contenteditable="true"]'));
        }
        const assistantMsgs = roleAware ? msgs.filter((m) => roleOf(m) === 'assistant') : msgs;
        const last = msgs.length ? msgs[msgs.length - 1] : null;
        // Prefer the LAST assistant container even while it is still empty —
        // that emptiness is "thinking", not "no reply yet". On pages without
        // role classes keep the old heuristic (user bubbles carry "user:").
        const nonEmpty = roleAware
            ? (assistantMsgs[assistantMsgs.length - 1] || null)
            : [...msgs].reverse().find(m => {
                const t = (m.innerText || '').trim();
                return t && !/^user:\\s/i.test(t);
            });
        let text = (nonEmpty ? nonEmpty.innerText : '').trim().slice(0, 12000);
        text = text.replace(/^assistant:\\s*/i, '');
        const stopBtn = [...document.querySelectorAll('button')].filter(vis)
            .some(b => /stop|halt|square/i.test((b.getAttribute('aria-label') || b.title || b.innerText || '')));
        const signIn = !composerEl && /Sign in|Log in|Continue with Google/i.test((document.body.innerText || '').slice(0, 3000));
        return JSON.stringify({
            snapVer: 9,
            text: text,
            textHead: text.slice(0, 40),
            count: msgs.length,
            assistantCount: assistantMsgs.length,
            roleAware: roleAware,
            composer: !!composerEl,
            apiReply: window.__reachCg || null,
            composerInfo: composerEl ? {
                tag: composerEl.tagName,
                cls: (composerEl.className || '').toString().slice(0, 80),
                id: composerEl.id || '',
                ph: composerEl.getAttribute('placeholder') || composerEl.getAttribute('aria-label') || ''
            } : null,
            edList: ed.map(e => ({
                tag: e.tagName,
                cls: (e.className || '').toString().slice(0, 70),
                id: e.id || '',
                ph: e.getAttribute('placeholder') || e.getAttribute('aria-label') || ''
            })),
            lastMsg: last ? {
                tag: last.tagName,
                cls: (last.className || '').toString().slice(0, 80),
                head: (last.innerText || '').replace(/\\s+/g, ' ').slice(0, 80)
            } : null,
            generating: stopBtn,
            signIn: signIn,
            url: location.href.slice(0, 140),
            bodyHead: (document.body.innerText || '').replace(/\\s+/g, ' ').slice(0, 300),
            sendButtons: [...document.querySelectorAll('button, [role="button"]')].filter(vis)
                .map(b => ({
                    tag: b.tagName,
                    cls: (b.className || '').toString().slice(0, 60),
                    text: (b.innerText || '').replace(/\\s+/g, ' ').slice(0, 30),
                    aria: b.getAttribute('aria-label') || '',
                    title: b.title || '',
                    type: b.getAttribute('type') || '',
                    disabled: !!b.disabled
                })).slice(0, 30),
            composerParent: composerEl ? (composerEl.closest('form') || composerEl.parentElement || { outerHTML: '' }).outerHTML.slice(0, 800) : '',
            chatDump: (() => {
                const nodes = [...document.querySelectorAll('*')].filter(e => {
                    const first = e.childNodes[0];
                    return first && first.nodeType === 3 && /user:/i.test(first.textContent || '');
                });
                if (!nodes.length) return '';
                const p = nodes[0].parentElement;
                return (p ? p.innerHTML : '').slice(0, 1800);
            })(),
            msgDump: msgs.slice(-6).map(m => ({
                cls: (m.className || '').toString().slice(0, 60),
                html: (m.innerHTML || '').replace(/\\s+/g, ' ').slice(0, 350)
            })),
            fiberKeys: (() => {
                let node = composerEl;
                const keys = [];
                for (let i = 0; i < 10 && node; i++) {
                    const fk = Object.keys(node).find(k => k.startsWith('__reactFiber$') || k.startsWith('__reactProps$'));
                    if (fk) {
                        const f = node[fk];
                        const props = f && (f.memoizedProps || f.props || {});
                        keys.push({ level: i, tag: node.tagName, cls: (node.className || '').toString().slice(0, 50),
                            propKeys: Object.keys(props || {}).filter(k => /change|value|enter|send|submit|key/i.test(k)).slice(0, 12) });
                    }
                    node = node.parentElement;
                }
                return keys;
            })()
        });
    } catch (err) {
        return JSON.stringify({
            error: err.message, text: '', count: 0, composer: false,
            generating: false, signIn: false, url: location.href.slice(0, 140)
        });
    }
})()`;

async function codegptSnapshot() {
    if (!codegptWin || codegptWin.isDestroyed()) throw new Error('codegpt browser closed');
    const raw = await codegptWin.webContents.executeJavaScript(CODEGPT_SNAPSHOT_JS);
    return JSON.parse(raw);
}

// Local /api/runs is NDJSON; only its final event is a completed reply.
// Do not return progress, private reasoning, old turns, or server errors as text.
function extractCodegptRunReply(body) {
    const events = String(body || '').split('\n').filter(line => line.trim()).map(line => {
        try { return JSON.parse(line); }
        catch (_) { throw new Error('CodeGPT returned an invalid run response. Check the extension API port (54113).'); }
    });
    const failure = events.find(event => event.t === 'error' || event.error);
    if (failure) throw new Error('CodeGPT: ' + (failure.message || failure.error?.message || failure.error || failure.text || 'run failed'));
    const final = events.filter(event => event.t === 'final').pop();
    if (!final || !final.done || final.pending || final.continueTurn) {
        throw new Error('CodeGPT did not finish the chat request (it may require approval in the CodeGPT window).');
    }
    const messages = final.messages || [];
    const lastUser = messages.map(message => message.role).lastIndexOf('user');
    const reply = messages.slice(lastUser + 1).filter(message => message.role === 'assistant').pop();
    const content = typeof reply?.content === 'string' ? reply.content : '';
    const answer = content.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
    if (!answer || /<think>/i.test(answer)) throw new Error('CodeGPT completed without an assistant answer.');
    return answer;
}

// Pull the assistant text out of the intercepted playground response.
function extractCodegptApiReply(body) {
    if (!body) return '';
    try {
        const data = JSON.parse(body);
        for (const ch of (data.choices || [])) {
            const c = ch.message && ch.message.content;
            if (typeof c === 'string' && c.trim()) return c.trim();
        }
        if (typeof data.content === 'string' && data.content.trim()) return data.content.trim();
        if (Array.isArray(data)) {
            for (const part of data) {
                if (typeof part === 'string') return part.trim();
            }
        }
        return '';
    } catch (_) { /* not JSON — SSE or plain text */ }
    // SSE-style: collect data: payloads, join their delta/content fields
    // (split on LF only; strip a trailing CR — see CRLF patch-tool pitfall)
    const lines = String(body).split('\n');
    const parts = [];
    for (let line of lines) {
        line = line.endsWith('\u000d') ? line.slice(0, -1) : line;
        const s = line.trim();
        if (!s.startsWith('data:')) continue;
        const payload = s.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        try {
            const d = JSON.parse(payload);
            for (const ch of (d.choices || [])) {
                const delta = ch.delta || ch.message || {};
                const c = delta.content;
                if (typeof c === 'string') parts.push(c);
            }
        } catch (_) { parts.push(payload); }
    }
    const joined = parts.join('');
    return joined.trim() || String(body).slice(0, 4000).trim();
}

async function debugCodegptDom() {
    if (!codegptWin || codegptWin.isDestroyed()) return { error: 'codegpt window not available' };
    const snap = await codegptSnapshot();
    return { ...snap, cdpBody: global.__cgPlaygroundBody || null };
}

async function checkCodegptSignedIn() {
    try {
        const snap = await codegptSnapshot();
        if (snap.composer) return { ok: true };
        if (isCodegptAuthHost(snap.url)) return { ok: false, why: 'signing in (auth in progress)' };
        if (snap.signIn) return { ok: false, why: 'not signed in' };
        if (isCodegptAppHost(snap.url)) {
            // Right page, composer not mounted yet — give it a bounded moment
            // instead of failing the send on a slow first paint.
            for (let wait = 0; wait < 20; wait += 1) {
                await sleep(800);
                try {
                    const s2 = await codegptSnapshot();
                    if (s2.composer) return { ok: true };
                    if (s2.signIn) return { ok: false, why: 'not signed in' };
                } catch (_) { /* page mid-navigation */ }
            }
            return { ok: false, why: 'chat page never finished loading' };
        }
        codegptWin.webContents.loadURL(await codegptChatUrl({ force: true }));
        await sleep(5000);
        const snap2 = await codegptSnapshot();
        if (snap2.composer) return { ok: true };
        return { ok: false, why: snap2.signIn ? 'not signed in' : 'no composer' };
    } catch (e) {
        return { ok: false, why: e.message };
    }
}

async function codegptSendEnter() {
    const wc = codegptWin.webContents;
    wc.sendInputEvent({ type: 'rawKeyDown', keyCode: 'Enter' });
    wc.sendInputEvent({ type: 'char', keyCode: '\r' });
    wc.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' });
}

async function codegptClickSend() {
    // The send control is icon-only: its visible text is exactly "Send" and it
    // carries no aria-label/title/type=submit. Matching is layered because this
    // UI has changed shape more than once:
    //   1. exact visible text "Send"                    (current local app)
    //   2. aria-label/title mentioning send|submit      (accessibility passes)
    //   3. last enabled button in the composer's row    (icon-only fallback)
    // The click is verified afterwards: a coordinate click that lands on a
    // stale overlay must not report success while the text stays put.
    //
    // NOTE: the injected source below deliberately avoids regex literals. It is
    // itself embedded in a template literal, and whitespace-collapsing via
    // split/filter/join needs no escape sequences, so nothing can be mangled
    // in transit through the template.
    const FINDER = `(() => {
        const vis = (e) => !!(e.offsetWidth || e.offsetHeight);
        const labelOf = (e) => ((e.innerText || e.getAttribute('aria-label') || e.title || '') + ' ')
            .split(' ').filter(Boolean).join(' ').trim();
        const all = [...document.querySelectorAll('button, [role="button"]')]
            .filter((e) => vis(e) && !e.disabled);
        // 1. exact visible text
        let btn = all.find((e) => labelOf(e) === 'Send');
        // 2. explicit send/submit affordance
        if (!btn) btn = all.find((e) => {
            const t = (e.getAttribute('aria-label') || '') + (e.title || '');
            return t.toLowerCase().indexOf('send') >= 0 || t.toLowerCase().indexOf('submit') >= 0;
        });
        // 3. icon-only fallback: last enabled button in the composer's row.
        if (!btn) {
            const composer = document.querySelector(${JSON.stringify(CODEGPT_COMPOSER_SELECTOR)});
            const row = composer && (composer.closest('form') || composer.parentElement);
            if (row) {
                const inRow = [...row.querySelectorAll('button, [role="button"]')]
                    .filter((e) => vis(e) && !e.disabled);
                if (inRow.length) btn = inRow[inRow.length - 1];
            }
        }
        if (!btn) return null;
        const r = btn.getBoundingClientRect();
        return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
    })()`;
    const wc = codegptWin.webContents;
    const box = await wc.executeJavaScript(FINDER).catch(() => null);
    if (!box) return false;
    // Real input first: this app ignores some synthetic clicks.
    wc.sendInputEvent({ type: 'mouseDown', x: box.x, y: box.y, button: 'left', clickCount: 1 });
    wc.sendInputEvent({ type: 'mouseUp', x: box.x, y: box.y, button: 'left', clickCount: 1 });
    await sleep(250);
    // Did it take? The composer must have emptied. If a stale overlay swallowed
    // the coordinate click, retry by clicking the element itself in-page.
    const stillFilled = await wc.executeJavaScript(`(() => {
        const ta = document.querySelector(${JSON.stringify(CODEGPT_COMPOSER_SELECTOR)});
        return !!ta && (ta.value || ta.innerText || '').trim().length > 0;
    })()`).catch(() => false);
    if (!stillFilled) return true;
    await wc.executeJavaScript(`(() => {
        const vis = (e) => !!(e.offsetWidth || e.offsetHeight);
        const labelOf = (e) => ((e.innerText || e.getAttribute('aria-label') || e.title || '') + ' ')
            .split(' ').filter(Boolean).join(' ').trim();
        const all = [...document.querySelectorAll('button, [role="button"]')]
            .filter((e) => vis(e) && !e.disabled);
        let btn = all.find((e) => labelOf(e) === 'Send');
        if (!btn) btn = all.find((e) => {
            const t = (e.getAttribute('aria-label') || '') + (e.title || '');
            return t.toLowerCase().indexOf('send') >= 0 || t.toLowerCase().indexOf('submit') >= 0;
        });
        if (!btn) {
            const composer = document.querySelector(${JSON.stringify(CODEGPT_COMPOSER_SELECTOR)});
            const row = composer && (composer.closest('form') || composer.parentElement);
            if (row) {
                const inRow = [...row.querySelectorAll('button, [role="button"]')]
                    .filter((e) => vis(e) && !e.disabled);
                if (inRow.length) btn = inRow[inRow.length - 1];
            }
        }
        if (btn) btn.click();
        return !!btn;
    })()`).catch(() => false);
    return true;
}

let codegptQueue = Promise.resolve();
function sendCodegptQueued(text, options = {}) {
    const queuedAt = Date.now();
    const result = codegptQueue.then(async () => {
        options.signal?.throwIfAborted();
        if (Date.now() - queuedAt > 60000) {
            log('codegpt queue: the previous request held this one for '
                + Math.round((Date.now() - queuedAt) / 1000) + 's');
        }
        return codegptSend(text, options);
    });
    codegptQueue = result.then(() => sleep(1500), () => sleep(1000));
    return result;
}

/* Switch to one economy model inside the signed-in CodeGPT app.
 *
 * Local sidecar app: the composer's model button carries
 * data-model-dropdown-trigger="true" and the open menu lists rows like
 * "GPT 5.6 Luna" (some behind "Show all N models"). The hosted web app uses
 * an "AI Model <current>" trigger instead; both shapes are handled.
 * We open that menu, click the entry for the requested model, then read the
 * trigger back to confirm the switch actually happened — a request never
 * silently passes as a model it is not. A UI change returns false; the caller
 * must reject the request rather than silently using another model.
 */
async function codegptSelectModel(engine) {
    if (!codegptWin || codegptWin.isDestroyed()) return false;
    const wanted = [engine.label, engine.id]
        .filter((value) => typeof value === 'string' && value.trim())
        .map((value) => value.toLowerCase());
    const helpers = `
        const vis = (e) => !!(e.offsetWidth || e.offsetHeight);
        const want = ${JSON.stringify(wanted)};
        const label = (e) => ((e.innerText || e.getAttribute('aria-label') || e.title || '') + ' ')
            .replace(/\\s+/g, ' ').trim().toLowerCase();
        const hit = (t) => !!t && want.some((w) => t.includes(w));
        // Trigger: the local app pins a data attribute on the composer's model
        // button; the hosted app labels its trigger "AI Model <current>".
        const trigger = () => {
            const local = [...document.querySelectorAll('button[data-model-dropdown-trigger="true"]')].filter(vis)[0];
            if (local) return local;
            return [...document.querySelectorAll('button, [role="button"], [aria-haspopup]')]
                .filter(vis).find((e) => label(e).startsWith('ai model'));
        };
        // Rows live inside the open menu when there is one; otherwise scan
        // the whole page (the hosted app keeps its rows loose).
        const menuEl = () => {
            const menus = [...document.querySelectorAll('[role="menu"], [role="listbox"], [data-radix-popper-content-wrapper]')]
                .filter(vis);
            return menus.length ? menus[menus.length - 1] : null;
        };
        const localApp = () => !!document.querySelector('button[data-model-dropdown-trigger="true"]');
        /* Radix opens on POINTERDOWN, and the app can sit under a hit-testing
         * layer that swallows coordinate clicks (observed 2026-09-11: real
         * input clicks did nothing at all, while a pointer sequence dispatched
         * on the element itself opened the menu and switched models). */
        const pressTrigger = (el) => {
            const base = { bubbles: true, cancelable: true, button: 0, pointerId: 1, pointerType: 'mouse', isPrimary: true };
            el.dispatchEvent(new PointerEvent('pointerdown', Object.assign({}, base, { buttons: 1 })));
            el.dispatchEvent(new PointerEvent('pointerup', Object.assign({}, base, { buttons: 0 })));
            return true;
        };
        /* Menu rows and plain app buttons act on click, so they get the full
         * sequence; the trigger must NOT (it toggles - the trailing click would
         * close what the pointerdown just opened). */
        const press = (el) => {
            pressTrigger(el);
            el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
            return true;
        };
        // The trigger TOGGLES: close an open menu before opening a fresh one.
        const dismissMenu = () => {
            const el = trigger();
            if (el && menuEl()) pressTrigger(el);
            return true;
        };
        // Rows are the entries that name a model; page chrome does not count.
        const modelish = /(gpt|claude|gemini|deepseek|glm|ox-|flash|sonnet|opus|mistral|grok|llama|minimax)/i;
        const rows = () => {
            // The local app renders rows inside the dropdown, so when no menu
            // is open REPORT NOTHING: a document-wide scan once "picked" a
            // chat message that merely mentioned a model name (2026-09-11).
            const scope = menuEl() || (localApp() ? null : document);
            if (!scope) return [];
            return [...scope.querySelectorAll('[role="option"], [role="menuitem"], li, button, [class*="item" i]')]
                .filter(e => vis(e) && e !== trigger()).map((e) => ({ el: e, text: label(e) }))
                .filter((row) => row.text && !row.text.startsWith('ai model') && row.text.length < 200
                    && modelish.test(row.text)
                    && !/show all|show fewer|manage models|\\+ add|approval|full access/.test(row.text));
        };
        // Some models sit behind the "Show all N models" expander.
        const expandAll = () => {
            const scope = menuEl() || document;
            const more = [...scope.querySelectorAll('button, [role="menuitem"], li')].filter(vis)
                .find((e) => /show all \\d+ models/i.test(label(e)));
            if (!more) return '';
            press(more);
            return label(more);
        };`;
    const exec = (js) => codegptWin.webContents.executeJavaScript(js)
        .catch((error) => ({ error: error.message }));
    try {
        for (let attempt = 1; attempt <= 3; attempt += 1) {
            const box = await exec(`(() => {
                ${helpers}
                const el = trigger();
                if (!el) return { error: 'no model menu on this page' };
                if (hit(label(el))) return { selected: true };
                const rect = el.getBoundingClientRect();
                return { x: Math.round(rect.x + rect.width / 2),
                         y: Math.round(rect.y + rect.height / 2) };
            })()`);
            if (box && box.selected) return true;
            if (!box || box.error) {
                log('codegpt model switch failed: ' + ((box && box.error) || 'no trigger'));
                return false;
            }
            // Exactly ONE open-interaction per attempt: this control toggles,
            // so a second interaction would open then close it. A menu left
            // open by an earlier attempt is dismissed first. Odd attempts
            // dispatch the synthesized pointer sequence (the shape this app
            // actually honours today); the even attempt falls back to real
            // input, in case a future build stops trusting untrusted events —
            // coordinate clicks cannot be relied on (see pressTrigger).
            await exec(`(() => { ${helpers} return dismissMenu(); })()`);
            await sleep(300);
            if (attempt % 2 === 1) {
                await exec(`(() => { ${helpers} const el = trigger(); if (!el) return false; return pressTrigger(el); })()`);
            } else {
                const wc = codegptWin.webContents;
                wc.sendInputEvent({ type: 'mouseDown', x: box.x, y: box.y, button: 'left', clickCount: 1 });
                wc.sendInputEvent({ type: 'mouseUp', x: box.x, y: box.y, button: 'left', clickCount: 1 });
            }

            // The list animates in; poll for real rows instead of guessing a delay.
            let entries = [];
            for (let wait = 0; wait < 12 && entries.length < 2; wait += 1) {
                await sleep(250);
                const found = await exec(`(() => { ${helpers} return rows().map((row) => row.text); })()`);
                if (Array.isArray(found) && found.length > entries.length) entries = found;
            }
            if (entries.length < 2) {
                log('codegpt model menu shows ' + entries.length + ' model row(s) after attempt '
                    + attempt + ' — retrying');
                await sleep(600);
                continue;
            }

            const pick = `(() => {
                ${helpers}
                const target = rows().find((row) => hit(row.text));
                if (!target) return null;
                press(target.el);
                return target.text;
            })()`;
            let picked = await exec(pick);
            if (!picked) {
                // Maybe the row hides behind "Show all N models" — expand, re-scan.
                const expanded = await exec(`(() => { ${helpers} return expandAll(); })()`);
                if (expanded) {
                    await sleep(800);
                    const found = await exec(`(() => { ${helpers} return rows().map((row) => row.text); })()`);
                    if (Array.isArray(found) && found.length > entries.length) entries = found;
                    picked = await exec(pick);
                }
            }
            if (!picked) {
                // Everything the menu really offers, so a mislabelled model is
                // diagnosable instead of looking like one that does not exist.
                log('codegpt model not in the menu [' + entries.length + ' rows: '
                    + entries.join(' | ').slice(0, 3000) + ']');
                await exec(`(() => { ${helpers} return dismissMenu(); })()`);
                await sleep(500);
                continue;
            }

            await sleep(600);
            const confirmed = await exec(`(() => { ${helpers} const el = trigger(); return el ? label(el) : ''; })()`);
            // `hit` exists only inside the injected page helpers — confirm in
            // the main process against the wanted labels instead.
            const ok = typeof confirmed === 'string'
                && wanted.some((value) => confirmed.includes(value));
            log('codegpt model switch ' + (ok ? 'confirmed: ' : 'unconfirmed: ')
                + String(picked).slice(0, 60) + ' -> ' + String(confirmed).slice(0, 80));
            if (ok) return true;
        }
        return false;
    } catch (error) {
        log('codegpt model switch error: ' + error.message);
        return false;
    }
}

// The model name the app's own API reports for the answer it just produced.
function codegptReplyModel(body) {
    try {
        const data = JSON.parse(String(body || ''));
        const value = data && (data.model || (data.data && data.data.model));
        return typeof value === 'string' ? value : '';
    } catch (_) {
        return '';
    }
}

/* Ask the CodeGPT page to stop its current generation.
 *
 * Used in two places: when a request fails (the app must not keep streaming
 * into the void) and when a NEW request finds the composer still busy — a
 * leftover stream holds the account's single economy session open, and
 * CodeGPT answers the next stream with ECONOMY_CONCURRENCY_LIMIT (429) until
 * it ends. Both need the same step and the same log line.
 */
async function codegptStopGeneration(why) {
    if (!codegptWin || codegptWin.isDestroyed()) return false;
    try {
        const clicked = await codegptWin.webContents.executeJavaScript(`(() => {
            const vis = (e) => !!(e.offsetWidth || e.offsetHeight);
            const label = (b) => ((b.getAttribute('aria-label') || '') + ' ' + (b.title || '') + ' '
                + (b.innerText || '')).trim().toLowerCase();
            const stop = [...document.querySelectorAll('button, [role="button"]')].filter(vis)
                .find((b) => /stop|halt|square|cancel/.test(label(b)));
            if (!stop) return '';
            stop.click();
            return label(stop).slice(0, 40);
        })()`).catch(() => '');
        log('codegpt stop' + (why ? ' (' + why + ')' : '') + ': '
            + (clicked ? 'clicked [' + clicked + ']' : 'no stop control found'));
        return !!clicked;
    } catch (_) {
        return false;
    }
}

async function codegptSend(text, { signal, model, label, onDelta } = {}) {
    if (!codegptWin || codegptWin.isDestroyed()) {
        showCodegpt();
        throw new Error('Opening the CodeGPT window. Please complete sign in and retry.');
    }
    const started = Date.now();
    const defaultModel = !model || model === ECONOMY_PREFIX || model === ECONOMY_PREFIX + '-gpt-4o-mini';
    const engine = economyModelFor(defaultModel ? economyBridgeIds()[1] : model);
    if (!engine) throw new Error('Unknown CodeGPT economy model: ' + model + '. Refresh the model list.');
    log('codegpt request started (' + text.length + ' chars' +
        (engine ? ', model=' + engine.id : ', default agent page') + ')');
    try {
        return await codegptSendRequest(text, signal, engine, label, onDelta);
    } catch (error) {
        await codegptStopGeneration('request failed');
        log('codegpt request failed: ' + (signal?.aborted ? 'cancelled' : error.message));
        throw error;
    } finally {
        log('codegpt request finished (' + Math.round((Date.now() - started) / 1000) + 's)');
    }
}

async function codegptSendRequest(text, signal, engine, label, onDelta) {
    const auth = await checkCodegptSignedIn();
    if (!auth.ok) {
        showCodegpt();
        throw new Error(auth.why + ' — opening the CodeGPT window. Please complete sign in and retry.');
    }

    // Economy models live behind the app's own model menu: the signed-in
    // session is the only place they are unlimited, and the public API refuses
    // to bind them to an agent. Switch the page first, then send.
    lastCodegptRequested = engine ? engine.id : '';
    lastCodegptServed = '';
    if (engine) {
        const switched = await codegptSelectModel(engine);
        if (!switched) throw new Error('CodeGPT could not select economy model ' + engine.id + '. No request was sent.');
        log('codegpt model switched to ' + engine.id + ' (' + (label || engine.label) + ')');
    }

    // Intercept the app's own chat API response in-page: the assistant reply
    // body is captured verbatim (fetch + XHR), sidestepping DOM guesswork.
    await codegptWin.webContents.executeJavaScript(CODEGPT_HOOK_JS).catch(() => {});
    const sendStart = Date.now();
    let readyDeadline = sendStart + 30000;
    let staleStopTried = false;
    while (true) {
        signal?.throwIfAborted();
        let snap;
        try { snap = await codegptSnapshot(); } catch (_) { snap = null; }
        if (snap && snap.composer && !snap.generating) break;
        if (Date.now() > readyDeadline) {
            if (snap && snap.composer && snap.generating && !staleStopTried) {
                // A prior stream is still running — the ghost of a cancelled
                // request. It holds the economy session open, so the page
                // would answer this send with a 429. Ask it to stop, then give
                // the page one more ready window before failing.
                staleStopTried = true;
                log('codegpt: previous stream is still generating — stopping it before this send');
                await codegptStopGeneration('stale stream before send');
                readyDeadline = Date.now() + 30000;
            } else {
                throw new Error('CodeGPT composer did not become ready. Reload the CodeGPT window.');
            }
        }
        await sleep(400);
    }

    const before = await codegptSnapshot();
    const wc = codegptWin.webContents;

    // React-controlled textarea: set the value through the native setter and
    // dispatch a bubbling input event so React's onChange registers it
    // (trusted insertText alone leaves React state empty and Send dead).
    const setRes = await wc.executeJavaScript(`(() => {
        const ta = document.querySelector(${JSON.stringify(CODEGPT_COMPOSER_SELECTOR)});
        if (!ta) return 'no composer';
        ta.focus();
        const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
        setter.call(ta, '');
        ta.dispatchEvent(new Event('input', { bubbles: true }));
        setter.call(ta, ${JSON.stringify(text)});
        ta.dispatchEvent(new Event('input', { bubbles: true }));
        return 'set';
    })()`).catch(e => 'err: ' + e.message);
    if (setRes !== 'set') throw new Error('CodeGPT composer unreachable: ' + setRes);
    await sleep(500);

    // Submit via the Send button (Enter alone proved unreliable on this app).
    const sendRes = await codegptClickSend();
    if (!sendRes) throw new Error('send failed — Send button not found/enabled after entering text');
    await sleep(1200);

    // Hard-fail instead of hanging forever when the message never left.
    const still2 = await wc.executeJavaScript(`(() => {
        const ta = document.querySelector(${JSON.stringify(CODEGPT_COMPOSER_SELECTOR)});
        return ta ? (ta.value || ta.innerText || '').trim() : '';
    })()`).catch(() => '');
    if (still2 && still2.includes(text.slice(0, 20))) {
        throw new Error('send failed — composer still holds the message (is the Send button reachable?)');
    }

    // Progressive streaming: the poll below already reads the growing reply
    // text, so forward each new suffix to the caller while it forms. Only a
    // suffix that extends what was already sent is forwarded — a late UI
    // re-render that rewrites the text wholesale must not scramble the view.
    let streamed = '';
    const emitProgress = (value) => {
        if (typeof onDelta !== 'function' || typeof value !== 'string' || !value) return;
        if (!value.startsWith(streamed)) return;
        const suffix = value.slice(streamed.length);
        if (!suffix) return;
        streamed = value;
        try { onDelta(suffix); } catch (_) { /* the client is gone */ }
    };
    let forming = null;
    let stable = 0;
    let completed = false;
    // No deadline: waiting on a live answer is agent work, and the old 180 s
    // kill fired mid-reply while the page was still reporting progress — that
    // is exactly how an "empty reply" reached the chat (2026-09-10,
    // deepseek-v4.1-flash: killed at 180 s, the identical retry finished in
    // 75 s). Only Stop / the client disconnecting (the AbortSignal) cancels
    // this loop. The captured run response, not DOM stability, determines
    // completion.
    let lastProgress = Date.now();
    let apiSeen = '';
    while (!completed) {
        signal?.throwIfAborted();
        await sleep(POLL_MS);
        let snap;
        try {
            snap = await codegptSnapshot();
        } catch (e) {
            log('codegpt poll error: ' + e.message);
            continue;
        }
        if (Date.now() - lastProgress >= 20000) {
            lastProgress = Date.now();
            log('codegpt still waiting (' + Math.round((Date.now() - sendStart) / 1000) + 's): '
                + 'msgs=' + snap.count + ' generating=' + !!snap.generating
                + ' apiReply=' + (snap.apiReply ? snap.apiReply.status : 'none')
                + ' replyChars=' + ((snap.text || '').length));
        }
        if (snap.signIn) throw new Error('signed out mid-conversation');
        // Stream the reply as the page forms it — BEFORE the completion
        // shortcuts below: the captured API reply only exists once the run has
        // finished, so waiting for it would defeat the whole point.
        if (snap.text && snap.text !== before.text) emitProgress(snap.text);
        if (snap.apiReply && snap.apiReply.ts >= sendStart) {
            if (snap.apiReply.pending) continue; // never mistake a stream pause for completion
            if (snap.apiReply.status >= 400) throw new Error('CodeGPT request failed (HTTP ' + snap.apiReply.status + ').');
            if (snap.apiReply.run) {
                const answer = extractCodegptRunReply(snap.apiReply.body);
                lastReplyAt = Date.now();
                log('codegpt reply: run capture (' + answer.length + ' chars)');
                return answer;
            }
        }
        // Record which model really answered (the app's API names it), so a
        // requested economy model that could not be switched shows up in the
        // log instead of silently passing as the requested one.
        if (snap.apiReply && snap.apiReply.ts >= sendStart - 500) {
            const body = String(snap.apiReply.body || '');
            // Log the app's API answering even when the body carries nothing
            // useful — that difference ("replied with an error" vs "never
            // replied") is the whole diagnosis when a wait drags on.
            const seen = snap.apiReply.status + '/' + body.length;
            if (seen !== apiSeen) {
                apiSeen = seen;
                log('codegpt api reply: status=' + snap.apiReply.status + ', ' + body.length
                    + ' chars, model=' + (codegptReplyModel(body) || 'unreported')
                    + (body ? ' — ' + body.slice(0, 160).replace(/\s+/g, ' ') : ''));
            }
            const served = codegptReplyModel(body);
            if (served && served !== lastCodegptServed) {
                lastCodegptServed = served;
                log('codegpt served model: ' + served);
            }
        }
        // API truth beats DOM heuristics — accept a fresh intercepted reply.
        const apiText = (snap.apiReply && snap.apiReply.ts >= sendStart - 500)
            ? extractCodegptApiReply(snap.apiReply.body) : '';
        if (apiText) {
            lastReplyAt = Date.now();
            log('codegpt reply: api text (' + apiText.length + ' chars)');
            return apiText;
        }
        // Role-aware pages: only a new ASSISTANT container (or changed reply
        // text) counts as progress — a freshly added user bubble must never
        // read as the reply.
        const isNew = (snap.roleAware
            ? snap.assistantCount > before.assistantCount
            : snap.count > before.count) ||
            (snap.text && snap.text !== before.text);
        if (!isNew) continue;
        if (!snap.text) continue;   // new element, still empty (assistant thinking)
        if (!forming) {
            forming = snap.text;
            stable = 0;
            continue;
        }
        if (snap.text === forming) {
            stable++;
            if (stable >= 2 && forming.length > 0 && !snap.generating) {
                completed = true;
                // Why did the DOM path win? Record the capture state — a live
                // capture (pending or fresh) means the run's own completion
                // signal was there and got missed; "none" means the hook was
                // not installed on this page at all.
                log('codegpt reply: DOM text (' + (forming || '').length + ' chars, idle ' + stable
                    + ' polls, capture=' + (snap.apiReply
                        ? (snap.apiReply.pending ? 'pending' : 'done/' + (snap.apiReply.run ? 'run' : 'other'))
                        : 'none')
                    + ', ts=' + (snap.apiReply ? (snap.apiReply.ts >= sendStart ? 'fresh' : 'stale') : 'n/a')
                    + ', generating=' + !!snap.generating + ')');
                break;
            }
        } else {
            forming = snap.text;
            stable = 0;
        }
    }
    lastReplyAt = Date.now();
    return forming;
}

/* ---------------------- ChatGPT page driving ---------------------- */

// Extract authored text blocks, preserving code fences and language labels.
function chatgptReplyText(root) {
    try {
        const selector = 'p, h1, h2, h3, h4, h5, h6, pre, ul, ol, blockquote, table';
        const controls = 'button, input, select, textarea, svg, iframe, [role="button"], [role="toolbar"], [aria-hidden="true"]';
        const widget = '[data-testid*="weather"], [data-testid*="widget"], [role="application"]';
        const blocks = [...root.querySelectorAll(selector)].filter(el => {
            const parent = el.parentElement && el.parentElement.closest(selector);
            return (!parent || !root.contains(parent)) && !el.closest(widget);
        });
        const parts = blocks.map(el => {
            const copy = el.cloneNode(true);
            copy.querySelectorAll(controls + ', ' + widget).forEach(node => node.remove());
            copy.querySelectorAll('br').forEach(node => node.replaceWith('\n'));
            copy.querySelectorAll('a[href]').forEach(link => {
                const href = link.getAttribute('href') || '';
                const label = (link.textContent || '').trim();
                if (/^https?:\/\//i.test(href) && label)
                    link.replaceWith('[' + label.replace(/^\[|\]$/g, '') + '](' + href + ')');
            });
            if (el.tagName === 'PRE') {
                const code = copy.querySelector('code');
                const languageClass = code && (code.className || '').match(/(?:^|\s)language-([\w+-]+)/);
                let language = languageClass ? languageClass[1] :
                    ((code && code.getAttribute('data-language')) || copy.getAttribute('data-language') || '');
                if (!language && code) {
                    const beforeCode = copy.textContent.slice(0, copy.textContent.indexOf(code.textContent)).trim();
                    if (/^[\w+-]+$/.test(beforeCode)) language = beforeCode;
                }
                if (!/^[\w+-]*$/.test(language)) language = '';
                const body = code ? code.textContent : copy.textContent;
                return '```' + language + '\n' + body.replace(/\n$/, '') + '\n```';
            }
            if (el.tagName === 'UL' || el.tagName === 'OL')
                copy.querySelectorAll('li').forEach((li, i) => li.prepend((el.tagName === 'OL' ? (i + 1) + '. ' : '- ')));
            return (copy.innerText || copy.textContent || '').trim();
        }).filter(Boolean);
        if (parts.length) return parts.join('\n\n');
        if (!root.querySelector(controls + ', ' + widget)) return (root.innerText || root.textContent || '').trim();
        return 'ChatGPT returned an interactive card without a text answer. Ask for a text-only summary.';
    } catch (_) {
        return (root.innerText || root.textContent || '').trim();
    }
}

const CHATGPT_SNAPSHOT_JS = `(() => {
    try {
        const vis = (e) => !!(e.offsetWidth || e.offsetHeight);

        const turns = [...document.querySelectorAll(
            '[data-message-author-role="assistant"]'
        )].filter(vis);
        let text = '';
        let count = turns.length;

        if (count) {
            const last = turns[turns.length - 1];
            const md = last.querySelector('.markdown, [class*="markdown"], .prose, [class*="prose"], .whitespace-pre-wrap');
            text = (${chatgptReplyText.toString()})(md || last);
        } else {
            const mds = [...document.querySelectorAll('.markdown, [class*="markdown"], .prose, [class*="prose"]')].filter(vis);
            count = mds.length;
            if (mds.length) text = (${chatgptReplyText.toString()})(mds[mds.length - 1]);
        }

        const composer = !!document.querySelector(${JSON.stringify(CHATGPT_COMPOSER_SELECTOR)});
        const signIn = !composer && /Log in|Sign up|Welcome back/i.test((document.querySelector('main') || document.body || {}).innerText || '');

        return JSON.stringify({
            text: text.slice(0, 12000),
            count: count,
            composer: composer,
            generating: !!document.querySelector('button[data-testid="stop-button"], button[aria-label="Stop generating"]'),
            challenge: false,
            signIn: signIn,
            url: location.href.slice(0, 140)
        });
    } catch (err) {
        return JSON.stringify({
            error: err.message,
            text: '',
            count: 0,
            composer: false,
            generating: false,
            challenge: false,
            signIn: false,
            url: location.href.slice(0, 140)
        });
    }
})()`;

async function chatgptSnapshot() {
    if (!chatgptWin || chatgptWin.isDestroyed()) throw new Error('chatgpt browser closed');
    const raw = await chatgptWin.webContents.executeJavaScript(CHATGPT_SNAPSHOT_JS);
    return JSON.parse(raw);
}

async function checkChatgptSignedIn() {
    try {
        const snap = await chatgptSnapshot();
        if (snap.composer) return { ok: true };
        if (isChatgptAuthHost(snap.url)) return { ok: false, why: 'signing in (auth in progress)' };
        if (snap.signIn) return { ok: false, why: 'not signed in' };
        if (isChatgptAppHost(snap.url)) return { ok: false, why: 'chat loading' };
        chatgptWin.webContents.loadURL(CHATGPT_URL);
        await sleep(5000);
        const snap2 = await chatgptSnapshot();
        if (snap2.composer) return { ok: true };
        return { ok: false, why: snap2.signIn ? 'not signed in' : 'no composer' };
    } catch (e) {
        return { ok: false, why: e.message };
    }
}

async function chatgptSendEnter() {
    const wc = chatgptWin.webContents;
    wc.sendInputEvent({ type: 'rawKeyDown', keyCode: 'Enter' });
    wc.sendInputEvent({ type: 'char', keyCode: '\r' });
    wc.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' });
}

async function chatgptClickSend() {
    const box = await chatgptWin.webContents.executeJavaScript(`(() => {
        const sel = ${JSON.stringify(CHATGPT_SEND_SELECTOR)};
        const b = [...document.querySelectorAll(sel)].find(e => e.offsetWidth && !e.disabled);
        if (!b) return null;
        try { b.click(); } catch (_) {}
        const r = b.getBoundingClientRect();
        return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
    })()`);
    if (!box) return false;
    const wc = chatgptWin.webContents;
    wc.sendInputEvent({ type: 'mouseDown', x: box.x, y: box.y, button: 'left', clickCount: 1 });
    wc.sendInputEvent({ type: 'mouseUp', x: box.x, y: box.y, button: 'left', clickCount: 1 });
    return true;
}

let chatgptQueue = Promise.resolve();
function sendChatgptQueued(text, options = {}) {
    const queuedAt = Date.now();
    const result = chatgptQueue.then(async () => {
        options.signal?.throwIfAborted();
        if (Date.now() - queuedAt > 60000) {
            log('chatgpt queue: the previous request held this one for '
                + Math.round((Date.now() - queuedAt) / 1000) + 's');
        }
        return chatgptSend(text, options);
    });
    chatgptQueue = result.then(() => sleep(1500), () => sleep(1000));
    return result;
}

async function chatgptSend(text, { signal, onDelta } = {}) {
    if (!chatgptWin || chatgptWin.isDestroyed()) {
        showChatgpt();
        throw new Error('Opening the ChatGPT window. Please complete sign in and retry.');
    }
    const started = Date.now();
    log('chatgpt request started (' + text.length + ' chars)');
    try {
        return await chatgptSendRequest(text, signal, onDelta);
    } catch (error) {
        if (chatgptWin && !chatgptWin.isDestroyed()) {
            chatgptWin.webContents.executeJavaScript(`(() => {
                const stop = document.querySelector('button[data-testid="stop-button"], button[aria-label="Stop generating"]');
                if (stop && stop.offsetWidth) stop.click();
            })()`).catch(() => {});
        }
        log('chatgpt request failed: ' + (signal?.aborted ? 'cancelled' : error.message));
        throw error;
    } finally {
        log('chatgpt request finished (' + Math.round((Date.now() - started) / 1000) + 's)');
    }
}

/* Ask the ChatGPT page to stop generating — the same stale-stream problem as
 * CodeGPT: a cancelled run keeps the page busy and every following send waits
 * behind it (or never sees a ready composer). */
async function chatgptStopGeneration(why) {
    if (!chatgptWin || chatgptWin.isDestroyed()) return false;
    try {
        const clicked = await chatgptWin.webContents.executeJavaScript(`(() => {
            const vis = (e) => !!(e.offsetWidth || e.offsetHeight);
            const stop = [...document.querySelectorAll('button')].filter(vis)
                .find((b) => b.getAttribute('data-testid') === 'stop-button'
                    || /stop generating/i.test(b.getAttribute('aria-label') || '')
                    || /stop|halt/i.test((b.innerText || '').trim()));
            if (!stop) return '';
            stop.click();
            return (stop.getAttribute('data-testid') || stop.getAttribute('aria-label') || stop.innerText || '')
                .trim().slice(0, 40);
        })()`).catch(() => '');
        log('chatgpt stop' + (why ? ' (' + why + ')' : '') + ': '
            + (clicked ? 'clicked [' + clicked + ']' : 'no stop control found'));
        return !!clicked;
    } catch (_) {
        return false;
    }
}

async function chatgptSendRequest(text, signal, onDelta) {
    const auth = await checkChatgptSignedIn();
    if (!auth.ok) {
        showChatgpt();
        throw new Error(auth.why + ' — opening the ChatGPT window. Please complete sign in and retry.');
    }

    // Wait for any prior generation or DOM transition to settle. No deadline —
    // a live answer may legitimately take as long as it takes — but a page
    // that stays busy is reported, and once asked to stop: a ghost of a
    // cancelled run would otherwise hold every following send hostage.
    let waiting = 0;
    let staleStopTried = false;
    while (true) {
        signal?.throwIfAborted();
        let snap;
        try { snap = await chatgptSnapshot(); } catch (_) { snap = null; }
        if (snap && snap.composer && !snap.generating) break;
        if (snap && snap.composer && snap.generating && !staleStopTried && waiting >= 30000) {
            staleStopTried = true;
            log('chatgpt: page still generating — stopping it before this send');
            await chatgptStopGeneration('stale stream before send');
        }
        if (waiting && waiting % 20000 === 0) {
            log('chatgpt still waiting for the page (' + Math.round(waiting / 1000) + 's): composer='
                + !!(snap && snap.composer) + ' generating=' + !!(snap && snap.generating));
        }
        await sleep(400);
        waiting += 400;
    }

    const before = await chatgptSnapshot();
    const wc = chatgptWin.webContents;

    // Focus composer and select any existing content in the composer only
    const focused = await wc.executeJavaScript(`(() => {
        const ta = document.querySelector(${JSON.stringify(CHATGPT_COMPOSER_SELECTOR)});
        if (!ta) return false;
        ta.focus();
        if (ta.tagName === 'TEXTAREA' || ta.tagName === 'INPUT') {
            ta.select();
        } else {
            const range = document.createRange();
            range.selectNodeContents(ta);
            const sel = window.getSelection();
            if (sel) {
                sel.removeAllRanges();
                sel.addRange(range);
            }
        }
        return document.activeElement === ta || ta.contains(document.activeElement);
    })()`).catch(() => false);
    if (!focused) throw new Error('ChatGPT composer not found/focusable');

    // Insert text once using trusted IME-style insertion
    await wc.insertText(text);
    await sleep(400);

    // Submit via Enter
    await chatgptSendEnter();
    await sleep(1200);

    // If text remains in composer, click the Send button
    const still = await wc.executeJavaScript(`(() => {
        const ta = document.querySelector(${JSON.stringify(CHATGPT_COMPOSER_SELECTOR)});
        return ta ? (ta.innerText || ta.textContent || ta.value || '').trim() : '';
    })()`).catch(() => '');
    if (still.length > 0) {
        log('chatgpt: Enter did not submit — clicking send button');
        await chatgptClickSend().catch(() => false);
        await sleep(800);
    }

    // Wait for a NEW reply, then for it to stabilise
    // Progressive streaming (same contract as codegptSendRequest).
    let streamed = '';
    const emitProgress = (value) => {
        if (typeof onDelta !== 'function' || typeof value !== 'string' || !value) return;
        if (!value.startsWith(streamed)) return;
        const suffix = value.slice(streamed.length);
        if (!suffix) return;
        streamed = value;
        try { onDelta(suffix); } catch (_) { /* the client is gone */ }
    };
    let forming = null;
    let stable = 0;
    let completed = false;
    while (!completed) {
        signal?.throwIfAborted();
        await sleep(POLL_MS);
        let snap;
        try {
            snap = await chatgptSnapshot();
        } catch (e) {
            log('chatgpt poll error: ' + e.message);
            continue;
        }
        if (snap.signIn) throw new Error('signed out mid-conversation');
        // Stream the reply as the page forms it (see codegptSendRequest).
        if (snap.text && snap.text !== before.text) emitProgress(snap.text);
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
            if (stable >= 2 && forming.length > 0 && !snap.generating) {
                completed = true;
                break;
            }
        } else {
            forming = snap.text;
            stable = 0;
        }
    }
    lastReplyAt = Date.now();
    return forming;
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

let copilotQueue = Promise.resolve();
function sendCopilotQueued(text, options = {}) {
    const queuedAt = Date.now();
    const result = copilotQueue.then(async () => {
        options.signal?.throwIfAborted();
        if (Date.now() - queuedAt > 60000) {
            log('copilot queue: the previous request held this one for '
                + Math.round((Date.now() - queuedAt) / 1000) + 's');
        }
        return copilotSend(text, options);
    });
    copilotQueue = result.catch(() => {});
    return result;
}

async function copilotSend(text, options = {}) {
    const signal = options?.signal;
    const onDelta = options?.onDelta;
    if (!browserWin || browserWin.isDestroyed()) {
        showBrowser();
        throw new Error('Open the Microsoft 365 session in the Copilot window, then retry.');
    }
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
    // Progressive streaming (same contract as codegptSendRequest).
    let streamed = '';
    const emitProgress = (value) => {
        if (typeof onDelta !== 'function' || typeof value !== 'string' || !value) return;
        if (!value.startsWith(streamed)) return;
        const suffix = value.slice(streamed.length);
        if (!suffix) return;
        streamed = value;
        try { onDelta(suffix); } catch (_) { /* the client is gone */ }
    };
    let forming = null;
    let stable = 0;
    while (true) {
        signal?.throwIfAborted();
        await sleep(POLL_MS);
        let snap;
        try { snap = await snapshot(); } catch (e) { log('poll error: ' + e.message); continue; }
        if (snap.challenge) throw new Error('challenge page during reply');
        if (snap.signIn) throw new Error('signed out mid-conversation');
        // Stream the reply as the page forms it (see codegptSendRequest).
        if (snap.text && snap.text !== before.text) emitProgress(snap.text);
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
    lastReplyAt = Date.now();
    return forming;
}

/* ------------------------------ bridge server ------------------------------ */

function startBridge() {
    if (bridgeServer) return;
    const { createBridgeHandler } = require('./bridge');
    bridgeServer = http.createServer(createBridgeHandler(sendCopilotQueued, sendChatgptQueued, sendCodegptQueued, () => {
        const prov = endpoints.getSettings().provider;
        const cVis = !!(browserWin && !browserWin.isDestroyed() && browserWin.isVisible());
        const gVis = !!(chatgptWin && !chatgptWin.isDestroyed() && chatgptWin.isVisible());
        const eVis = !!(codegptWin && !codegptWin.isDestroyed() && codegptWin.isVisible());
        return {
            ok: true, service: 'signalreach-tray', bridge: BRIDGE_PORT,
            codeVer: 'cg-bridge-12',
            provider: prov,
            copilotVisible: cVis,
            chatgptVisible: gVis,
            codegptVisible: eVis,
            browserVisible: prov === 'chatgpt' ? gVis : prov === 'codegpt' ? eVis : cVis,
            lastReplyAt, lastError
        };
    }, debugCodegptDom, log));
    bridgeServer.timeout = 0;
    bridgeServer.requestTimeout = 0;
    bridgeServer.headersTimeout = 0;
    bridgeServer.keepAliveTimeout = 0;
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
        ...(process.platform === 'darwin' ? { type: 'panel' } : {}),
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
        title: 'SignalREACH',
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
    if (process.platform === 'darwin') panel.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
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
    if (anchor && (anchor.width <= 0 || anchor.height <= 0)) anchor = null;
    const display = anchor
        ? screen.getDisplayNearestPoint({ x: anchor.x, y: anchor.y })
        : screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const area = display.workArea;
    let x = anchor
        ? Math.round(anchor.x + anchor.width / 2 - PANEL_WIDTH / 2)
        : Math.round(area.x + area.width - PANEL_WIDTH - 16);
    let y = Math.round(area.y + area.height - PANEL_HEIGHT - 8);
    if (process.platform === 'darwin') y = Math.max(area.y, anchor ? anchor.y + anchor.height : area.y) + 8;
    else if (anchor && anchor.y + anchor.height <= area.y + 2) y = area.y + 8;
    x = Math.max(area.x + 8, Math.min(x, area.x + area.width - PANEL_WIDTH - 8));
    y = Math.max(area.y + 8, Math.min(y, area.y + area.height - PANEL_HEIGHT - 8));
    win.setBounds({ x, y, width: PANEL_WIDTH, height: PANEL_HEIGHT });
}

async function togglePanel() {
    const win = panelWindow();
    if (win.isVisible()) { win.hide(); return; }
    await showPanel();
}

async function showPanel() {
    const win = panelWindow();
    if (panelReady) await panelReady;
    if (win.isDestroyed()) return;
    positionPanelNearTray();
    if (process.platform === 'darwin') win.show();
    else win.showInactive();
    win.focus();
}

function buildTrayMenu() {
    const visible = !!(browserWin && !browserWin.isDestroyed() && browserWin.isVisible());
    const chatgptVisible = !!(chatgptWin && !chatgptWin.isDestroyed() && chatgptWin.isVisible());
    const codegptVisible = !!(codegptWin && !codegptWin.isDestroyed() && codegptWin.isVisible());
    return Menu.buildFromTemplate([
        { label: 'Free model endpoints', type: 'radio', checked: endpoints.getSettings().provider === 'endpoint',
          click: () => { saveTraySettings({ provider: 'endpoint' }); openPanel(); } },
        { label: 'Microsoft 365 Copilot', type: 'radio', checked: endpoints.getSettings().provider === 'copilot',
          click: () => { saveTraySettings({ provider: 'copilot' }); openPanel(); } },
        { label: 'ChatGPT', type: 'radio', checked: endpoints.getSettings().provider === 'chatgpt',
          click: () => { saveTraySettings({ provider: 'chatgpt' }); openPanel(); } },
        { label: 'CodeGPT (economy)', type: 'radio', checked: endpoints.getSettings().provider === 'codegpt',
          click: () => { saveTraySettings({ provider: 'codegpt' }); openPanel(); } },
        { type: 'separator' },
        {
            label: visible ? 'Hide Browser \u2014 Copilot' : 'Show Browser \u2014 Copilot (sign in / verify)',
            click: () => {
                if (browserWin && !browserWin.isDestroyed() && browserWin.isVisible()) hideBrowser();
                else showBrowser();
                setTimeout(() => { refreshNativeMenus(); }, 100);
            }
        },
        {
            label: chatgptVisible ? 'Hide Browser \u2014 ChatGPT' : 'Show Browser \u2014 ChatGPT (sign in / verify)',
            click: () => {
                if (chatgptWin && !chatgptWin.isDestroyed() && chatgptWin.isVisible()) hideChatgpt();
                else showChatgpt();
                setTimeout(() => { refreshNativeMenus(); }, 100);
            }
        },
        {
            label: codegptVisible ? 'Hide Browser \u2014 CodeGPT' : 'Show Browser \u2014 CodeGPT (sign in / verify)',
            click: () => {
                if (codegptWin && !codegptWin.isDestroyed() && codegptWin.isVisible()) hideCodegpt();
                else showCodegpt();
                setTimeout(() => { refreshNativeMenus(); }, 100);
            }
        },
        { type: 'separator' },
        { label: 'Refresh Page  ⟳', click: () => {
            const win = ensureBrowser();
            win.webContents.reload();
        } },
        { label: 'Back to Home', click: reloadBrowser },
        { label: 'Sign Out (clear session)', click: () => { void signOutBrowser(); } },
        { type: 'separator' },
        {
            label: 'Open Tray Panel',
            click: openPanel
        },
        { label: 'Quit SignalREACH', click: () => app.quit() }
    ]);
}

function openPanel() {
    void showPanel().catch(error => log('Panel failed: ' + error.message));
}

function saveTraySettings(value) {
    const saved = endpoints.saveSettings(value);
    refreshNativeMenus();
    if (saved.provider === 'copilot') ensureBrowser();
    if (saved.provider === 'chatgpt') ensureChatgpt();
    if (saved.provider === 'codegpt') ensureCodegpt();
    if (panel && !panel.isDestroyed()) panel.webContents.send('settings-changed');
    return saved;
}

function refreshNativeMenus() {
    if (!tray) return;
    // On macOS an attached context menu consumes the status item's mouse-up.
    // Open it explicitly on right-click so left-click can open our panel.
    if (process.platform !== 'darwin') tray.setContextMenu(buildTrayMenu());
    if (process.platform === 'darwin' && app.dock) app.dock.setMenu(buildTrayMenu());
}

function createTray() {
    const iconPath = path.join(__dirname, 'tray-icon.png');
    let image = nativeImage.createFromPath(iconPath);
    if (image.isEmpty()) throw new Error('SignalREACH tray-icon.png is missing.');
    if (process.platform === 'darwin') image = image.resize({ width: 18, height: 18 });
    tray = new Tray(image);
    tray.setToolTip('SignalREACH — free endpoints, Copilot, and ChatGPT');
    refreshNativeMenus();
    if (process.platform === 'darwin') {
        tray.setIgnoreDoubleClickEvents(true);
        tray.on('right-click', () => tray.popUpContextMenu(buildTrayMenu()));
        Menu.setApplicationMenu(Menu.buildFromTemplate([
            { label: 'SignalREACH', submenu: [{ label: 'Open Tray Panel', accelerator: 'CmdOrCtrl+Shift+T', click: openPanel }, { role: 'quit' }] },
            { role: 'editMenu' }, { role: 'windowMenu' }
        ]));
    }
    tray.on('click', () => {
        if (process.platform === 'darwin' || process.platform === 'linux') {
            void togglePanel().catch(error => log('Panel failed: ' + error.message));
            return;
        }
        if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; showBrowser(); return; }
        clickTimer = setTimeout(() => { clickTimer = null; void togglePanel().catch(error => log(error.message)); }, 220);
    });
    log('tray created');
}

/* --------------------------------- web search ------------------------------- */
/* In-process DuckDuckGo HTML search + page-text fetch (no relay round-trip,
 * no new deps). Same SSRF hygiene as tools/reach_cli/websearch.py: only
 * public http(s) hosts, re-validated on every redirect. */

function _hostIsPublic(host) {
    if (!host) return Promise.resolve(false);
    host = String(host).replace(/^\[|\]$/g, '').toLowerCase();
    if (host === 'localhost') return Promise.resolve(false);
    return new Promise((resolve) => {
        require('node:dns').lookup(host, { all: true }, (err, addrs) => {
            if (err || !addrs || !addrs.length) return resolve(false);
            const ip = require('node:net').isIP;
            for (const a of addrs) {
                const v = a.address;
                if (/^(10\.|127\.|169\.254\.|192\.168\.|0\.|::1$|fc|fd|fe80)/i.test(v)) return resolve(false);
                if (/^172\.(1[6-9]|2\d|3[01])\./.test(v)) return resolve(false);
                if (ip(v) === 0) return resolve(false);
            }
            resolve(true);
        });
    });
}

function _fetchText(url, redirects, resolve, reject, signal) {
    let u;
    try { u = new URL(url); } catch (_) { return reject(new Error('bad url')); }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return reject(new Error('scheme'));
    _hostIsPublic(u.hostname).then((ok) => {
        if (signal.aborted) return reject(new Error('Web request timed out.'));
        if (!ok) return reject(new Error('unsafe host'));
        const lib = u.protocol === 'https:' ? https : http;
        const req = lib.get({
            hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80),
            path: u.pathname + u.search, method: 'GET',
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.9'
            },
            signal
        }, (res) => {
            const loc = res.headers.location;
            if (loc && res.statusCode >= 300 && res.statusCode < 400) {
                res.resume();
                if (redirects >= 5) return reject(new Error('too many redirects'));
                let next;
                try { next = new URL(loc, url).toString(); } catch (_) { return reject(new Error('bad redirect')); }
                return _fetchText(next, redirects + 1, resolve, reject, signal);
            }
            const ct = String(res.headers['content-type'] || '');
            if (!/text\/html|text\/plain|application\/xhtml/i.test(ct)) { res.resume(); return resolve(''); }
            let body = '';
            res.setEncoding('utf8');
            res.on('data', (c) => {
                body += c;
                if (body.length > 400000) { resolve(body.slice(0, 400000)); req.destroy(); }
            });
            res.on('error', reject);
            res.on('end', () => resolve(body));
        });
        req.on('error', (e) => reject(e));
    }).catch(reject);
}

function fetchPage(url, timeoutMs = 0) {
    const controller = new AbortController();
    let timer = null;
    return new Promise((resolve, reject) => {
        if (timeoutMs > 0) {
            timer = setTimeout(() => {
                controller.abort();
                reject(new Error('Web request timed out.'));
            }, timeoutMs);
        }
        _fetchText(url, 0, resolve, reject, controller.signal);
    }).finally(() => { if (timer) clearTimeout(timer); });
}

function stripTags(html) {
    return String(html || '')
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
        .replace(/\s+/g, ' ').trim();
}

function _parseDdg(html, count) {
    const results = [];
    const push = (href, title) => {
        if (results.length >= count) return;
        const um = /[?&]uddg=([^&]+)/.exec(href);
        if (um) { try { href = decodeURIComponent(um[1]); } catch (_) { /* keep */ } }
        else if (href.startsWith('//')) href = 'https:' + href;
        let u;
        try { u = new URL(href); } catch (_) { return; }
        if (u.protocol !== 'http:' && u.protocol !== 'https:') return;
        const host = u.hostname.toLowerCase();
        if (/duckduckgo\.com$/.test(host)) return;      // skip DDG internal links
        const t = stripTags(title).slice(0, 140);
        if (!t) return;
        if (results.some((r) => r.url === href)) return; // dedupe
        results.push({ title: t, url: href.slice(0, 500) });
    };
    // Primary: html.duckduckgo.com result links
    let m;
    const reA = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
    while ((m = reA.exec(html)) && results.length < count) push(m[1], m[2]);
    // Fallback: any redirect link carrying uddg= (lite + variant layouts)
    if (!results.length) {
        const reU = /<a[^>]*href="([^"]*uddg=[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
        while ((m = reU.exec(html)) && results.length < count) push(m[1], m[2]);
    }
    return results;
}

async function webSearch(query, count) {
    count = Math.max(1, Math.min(6, count || 4));
    // Try the full HTML endpoint first, then the lite endpoint — DDG rate-limits
    // and varies markup, so a single endpoint/selector is brittle.
    const searchEndpoints = [
        'https://duckduckgo.com/html/?q=',
        'https://lite.duckduckgo.com/lite/?q=',
        'https://html.duckduckgo.com/html/?q='
    ];
    for (const ep of searchEndpoints) {
        try {
            const html = await fetchPage(ep + encodeURIComponent(query));
            const results = _parseDdg(html, count);
            if (results.length) return results;
        } catch (_) { /* try next endpoint */ }
    }
    return [];
}

async function sendChatMessages(config, messages, onDelta) {
    let content;
    if (config.provider === 'endpoint') {
        content = await endpoints.chat(config, messages, onDelta);
    } else if (config.provider === 'chatgpt') {
        content = await sendChatgptQueued(messages.map(m => `${m.role}: ${m.content}`).join('\n\n'), { onDelta });
    } else if (config.provider === 'codegpt') {
        content = await sendCodegptQueued(messages.map(m => `${m.role}: ${m.content}`).join('\n\n'), { onDelta });
    } else {
        content = await sendCopilotQueued(messages.map(m => `${m.role}: ${m.content}`).join('\n\n'), { onDelta });
    }
    lastReplyAt = Date.now();
    lastError = '';
    return content;
}

/* ----------------------------------- IPC ----------------------------------- */

function installIpc() {
    // Only the local, sandboxed panel can invoke tray commands. The remote
    // Microsoft browser has no access to this settings/chat surface.
    const trusted = event => {
        if (!panel || panel.isDestroyed() || event.sender !== panel.webContents || event.senderFrame !== panel.webContents.mainFrame) {
            throw new Error('This command is only available from the SignalREACH tray panel.');
        }
    };
    const handle = (name, fn) => ipcMain.handle(name, (event, ...args) => { trusted(event); return fn(event, ...args); });
    const listen = (name, fn) => ipcMain.on(name, (event, ...args) => {
        try { trusted(event); fn(event, ...args); } catch (error) { log('Tray command failed: ' + error.message); }
    });
    handle('tray-settings', () => endpoints.getSettings());
    handle('tray-save-settings', (_event, value) => saveTraySettings(value));
    handle('tray-models', async () => endpoints.discover(endpoints.getSettings(), true));
    listen('hide-panel', () => { if (panel) panel.hide(); });
    handle('tray-status', async () => {
        const config = endpoints.getSettings();
        let auth;
        let models = [];
        let base = '';
        if (config.provider === 'endpoint') {
            try {
                const state = await endpoints.discover(config);
                models = state.models;
                base = state.base;
                auth = { ok: !config.model || models.includes(config.model), why: 'Choose an available model in Controls.' };
            } catch (error) { auth = { ok: false, why: error.message }; }
        } else if (config.provider === 'chatgpt') {
            auth = await checkChatgptSignedIn().catch(error => ({ ok: false, why: error.message }));
        } else if (config.provider === 'codegpt') {
            // The economy ids this bridge serves, so the panel can offer them.
            models = economyBridgeIds();
            auth = await checkCodegptSignedIn().catch(error => ({ ok: false, why: error.message }));
            if (auth.ok && config.model && !models.includes(config.model)) {
                auth = { ok: false, why: 'Choose an available CodeGPT economy model.' };
            }
        } else {
            auth = await checkSignedIn().catch(error => ({ ok: false, why: error.message }));
        }
        const isChatgpt = config.provider === 'chatgpt';
        const isCopilot = config.provider === 'copilot';
        const isCodegpt = config.provider === 'codegpt';
        const activeWin = isChatgpt ? chatgptWin : isCodegpt ? codegptWin : browserWin;
        return {
            ...config, models, base,
            signedIn: !!auth.ok, why: auth.ok ? '' : auth.why || '',
            bridgePort: BRIDGE_PORT, bridgeUp: !!bridgeServer,
            browserVisible: !!(activeWin && !activeWin.isDestroyed() && activeWin.isVisible()),
            chatgptVisible: !!(chatgptWin && !chatgptWin.isDestroyed() && chatgptWin.isVisible()),
            copilotVisible: !!(browserWin && !browserWin.isDestroyed() && browserWin.isVisible()),
            codegptVisible: !!(codegptWin && !codegptWin.isDestroyed() && codegptWin.isVisible()),
            codegptRequested: lastCodegptRequested,
            codegptServed: lastCodegptServed,
            lastReplyAt, lastError,
            url: config.provider === 'endpoint' ? base : (activeWin && !activeWin.isDestroyed() ? activeWin.webContents.getURL().slice(0, 120) : '')
        };
    });
    handle('tray-test', async (_ev, text) => {
        const t0 = Date.now();
        try {
            const content = await sendChatMessages(endpoints.getSettings(), [{ role: 'user', content: String(text || 'Say OK').slice(0, 500) }]);
            return { ok: true, content, ms: Date.now() - t0 };
        } catch (e) {
            return { ok: false, error: e.message, ms: Date.now() - t0 };
        }
    });
    // MiniChat: chat + web search only (improved on SimpleRAG's minichat).
    // When webSearch is on, ground the question with live DDG results + the
    // text of the top pages before asking Copilot — answer comes back with
    // the sources attached.
    handle('tray-chat', async (_ev, payload) => {
        const config = endpoints.getSettings();
        const p = payload || {};
        const message = String(p.message || '').slice(0, 4000).trim();
        if (!message) return { ok: false, error: 'empty message' };
        const history = Array.isArray(p.history) ? p.history.slice(-12) : [];
        const wantSearch = p.webSearch !== false;
        const t0 = Date.now();
        try {
            let sources = [];
            let searchNote = '';
            let grounding = '';
            if (wantSearch) {
                try {
                    sources = await webSearch(message, 4);
                } catch (e) {
                    searchNote = 'Web search unavailable (' + e.message + ')';
                }
                if (sources.length) {
                    // pull text from the top 2 pages for grounding
                    const pages = [];
                    for (const s of sources.slice(0, 2)) {
                        try {
                            const html = await fetchPage(s.url);
                            const txt = stripTags(html).slice(0, 2500);
                            if (txt.length > 120) pages.push('SOURCE [' + s.title + '] (' + s.url + '):\n' + txt);
                        } catch (_) { /* page unfetchable — link still listed */ }
                    }
                    grounding =
                        'Live web results for this question follow. Answer using them ' +
                        'and cite sources as [1], [2], etc. matching the list order.\n\n' +
                        sources.map((s, i) => '[' + (i + 1) + '] ' + s.title + ' — ' + s.url).join('\n') +
                        (pages.length ? '\n\n' + pages.join('\n\n') : '');
                    searchNote = 'Searched the web (' + sources.length + ' sources' +
                        (pages.length ? ', ' + pages.length + ' read' : '') + ')';
                } else if (!searchNote) {
                    searchNote = 'Web search returned no sources';
                }
            }
            if (panel && !panel.isDestroyed()) panel.webContents.send('chat-progress', { requestId: p.requestId, hint: 'Thinking…' });
            // Stream the reply into the panel while it forms: the senders
            // forward page/endpoint deltas through onDelta, which lands in the
            // renderer as chat-delta events (see panel.js).
            const onDelta = (text) => {
                if (panel && !panel.isDestroyed() && text) {
                    panel.webContents.send('chat-delta', { requestId: p.requestId, text: String(text) });
                }
            };
            const chatMessages = [
                ...(grounding ? [{ role: 'system', content: grounding }] : []),
                ...history.filter(m => m && ['user', 'assistant'].includes(m.role) && m.content)
                    .map(m => ({ role: m.role, content: String(m.content).slice(0, 1200) })),
                { role: 'user', content: message }
            ];
            const content = await sendChatMessages(config, chatMessages, onDelta);
            return {
                ok: true,
                content,
                sources,
                webSearch: wantSearch,
                searchNote,
                ms: Date.now() - t0
            };
        } catch (e) {
            lastError = e.message;
            return { ok: false, error: e.message, ms: Date.now() - t0 };
        }
    });
    listen('show-browser', () => {
        const p = endpoints.getSettings().provider;
        if (p === 'chatgpt') showChatgpt();
        else if (p === 'codegpt') showCodegpt();
        else showBrowser();
    });
    listen('hide-browser', () => {
        const p = endpoints.getSettings().provider;
        if (p === 'chatgpt') hideChatgpt();
        else if (p === 'codegpt') hideCodegpt();
        else hideBrowser();
    });
    // toggle: if the window is already open, hide it (panel buttons are
    // one-button show/hide so the user never has to hunt for the other action)
    listen('toggle-browser', () => {
        const p = endpoints.getSettings().provider;
        if (p === 'chatgpt') {
            if (chatgptWin && !chatgptWin.isDestroyed() && chatgptWin.isVisible()) hideChatgpt();
            else showChatgpt();
        } else if (p === 'codegpt') {
            if (codegptWin && !codegptWin.isDestroyed() && codegptWin.isVisible()) hideCodegpt();
            else showCodegpt();
        } else {
            if (browserWin && !browserWin.isDestroyed() && browserWin.isVisible()) hideBrowser();
            else showBrowser();
        }
    });
    listen('reload-browser', () => {
        const p = endpoints.getSettings().provider;
        if (p === 'chatgpt') reloadChatgpt();
        else if (p === 'codegpt') reloadCodegpt();
        else reloadBrowser();
    });
    listen('refresh-page', () => {
        const p = endpoints.getSettings().provider;
        if (p === 'chatgpt') { const win = ensureChatgpt(); win.webContents.reload(); }
        else if (p === 'codegpt') { const win = ensureCodegpt(); win.webContents.reload(); }
        else { const win = ensureBrowser(); win.webContents.reload(); }
    });
    listen('open-external', (_e, url) => {
        try {
            const u = new URL(String(url));
            if (u.protocol === 'http:' || u.protocol === 'https:') shell.openExternal(u.toString());
        } catch (_) { /* ignore bad url */ }
    });
    listen('sign-out', () => {
        const p = endpoints.getSettings().provider;
        if (p === 'chatgpt') void signOutChatgpt();
        else if (p === 'codegpt') void signOutCodegpt();
        else void signOutBrowser();
    });
    listen('quit', () => app.quit());
}

/* ------------------------------ resilience -------------------------------- */
// The tray is the host's browser-backed provider gateway: codegpt / chatgpt /
// copilot models are served through the in-process bridge, so if this process
// disappears silently every one of them goes dark the next time a client asks.
// (Seen 2026-09-21: the process vanished mid-heartbeat — no quit log, no crash
// report — and "the bridge runs dry" until a human restarts the tray.) Make
// every failure mode loud in the log, and heal what can be healed in place.

if (typeof process.on === 'function') {
    process.on('uncaughtException', (error) => {
        log('tray uncaught exception: ' + ((error && error.stack) || error));
    });
    process.on('unhandledRejection', (reason) => {
        log('tray unhandled rejection: ' + ((reason && reason.stack) || reason));
    });
}

// A renderer crash must not take its provider down for good: reload the page
// (sign-in lives in the partition, so it survives the reload) unless the page
// is crash-looping — then leave it down and say why.
const rendererCrashLog = [];
app.on('render-process-gone', (_event, webContents, details) => {
    let url = '';
    try { url = webContents.getURL(); } catch (_) { url = ''; }
    log('tray renderer gone: reason=' + details.reason + ' exitCode=' + details.exitCode
        + ' url=' + String(url).slice(0, 90));
    if (isQuitting || details.reason === 'clean-exit') return;
    const now = Date.now();
    const recent = rendererCrashLog.filter((ts) => now - ts < 5 * 60 * 1000);
    recent.push(now);
    rendererCrashLog.length = 0;
    rendererCrashLog.push(...recent);
    if (recent.length > 3) {
        log('tray renderer crash loop (' + recent.length + ' in 5 min) — leaving the page '
            + 'down; open the tray and sign in / reload by hand');
        return;
    }
    setTimeout(() => {
        try { if (!webContents.isDestroyed()) webContents.reload(); } catch (_) { /* gone */ }
    }, 1500);
});
app.on('child-process-gone', (_event, details) => {
    log('tray child process gone: type=' + details.type + ' reason=' + details.reason
        + (details.serviceName ? ' service=' + details.serviceName : ''));
});

/* ---------------------------------- boot ---------------------------------- */

// Host binding. The tray holds the signed-in CodeGPT session, so it must only
// run on the machine it was installed on — a copied tray folder cannot serve
// this account from someone else's PC. The Python side owns the authoritative
// fingerprint; this reads the record it writes so both agree on one source of
// truth instead of duplicating the machine-id logic.
function hostBindBlocked() {
    try {
        const dir = path.join(app.getPath('appData'), 'SignalREACH');
        const cfgPath = path.join(dir, 'config.json');
        if (!fs.existsSync(cfgPath)) return null;   // not installed as a host yet
        const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
        const system = (cfg && cfg.system) || {};
        if (system.host_bind === false) return null;  // explicitly opted out
        // A config still carrying sealed envelopes means the secrets are bound
        // to some host. If our own machine id is present in the marker the
        // install wrote, we are on that host.
        const expect = system.host_machine_hint;
        if (!expect) return null;   // legacy install, no binding recorded yet
        const os = require('node:os');
        const mine = (os.userInfo().username || '') + '@' + (os.hostname() || '');
        if (mine.trim() !== String(expect).trim()) {
            return 'This tray is bound to a different machine (' + expect + ').';
        }
    } catch (_e) { /* never block boot on a read error */ }
    return null;
}

const hostBlock = hostBindBlocked();

if (hostBlock) {
    log('host binding refused: ' + hostBlock);
    const { dialog } = require('electron');
    app.whenReady().then(() => {
        dialog.showErrorBox('SignalREACH — wrong machine',
            hostBlock + '\n\nInstall the tray on that PC, or re-run the installer here to re-bind.');
        app.exit(3);
    });
} else if (!app.requestSingleInstanceLock()) {
    app.quit();
} else {
    app.on('second-instance', openPanel);
    app.on('activate', () => { if (app.isReady()) openPanel(); });

    app.whenReady().then(() => {
        log('=== Copilot tray starting (pid ' + process.pid + ') ===');
        installIpc();
        startBridge();
        createTray();
        openPanel();
        // The economy list is CodeGPT's own live credits menu, so it is read
        // from the CodeGPT sidecar at startup and kept fresh — a model added or
        // retired on the plan shows up here without a code change.
        refreshEconomyModels().then((info) => {
            log('economy models: ' + info.count + ' from ' + info.source);
        }).catch(() => {});
        setInterval(() => {
            refreshEconomyModels({ force: true })
                .then((info) => log('economy models refreshed: ' + info.count + ' from ' + info.source))
                .catch(() => {});
        }, 5 * 60 * 1000);
        // Liveness + memory trail: when a long session ends abruptly this log
        // is the only record, so leave a heartbeat (RSS, window state) behind.
        setInterval(() => {
            const state = [['copilot', browserWin], ['chatgpt', chatgptWin], ['codegpt', codegptWin]]
                .map(([name, win]) => win && !win.isDestroyed()
                    ? name + (win.webContents.isCrashed() ? ':crashed' : ':ok') : name + ':none')
                .join(' ');
            log('tray alive: rss=' + Math.round(process.memoryUsage().rss / 1048576) + 'MB ' + state);
        }, 5 * 60 * 1000);
        const startProvider = endpoints.getSettings().provider;
        if (startProvider === 'copilot') ensureBrowser();
        if (startProvider === 'chatgpt') ensureChatgpt();
        if (startProvider === 'codegpt') ensureCodegpt();
        // sign-in check: if the session is dead, surface the window once so the
        // user can sign in (only at startup, never while running invisibly)
        setTimeout(async () => {
            const prov = endpoints.getSettings().provider;
            if (prov === 'copilot') {
                const auth = await checkSignedIn().catch(error => ({ ok: false, why: error.message }));
                if (!auth.ok) {
                    log('startup: ' + auth.why + ' — showing browser for sign-in');
                    showBrowser();
                    try {
                        new Notification({
                            title: 'SignalREACH',
                            body: 'Sign in to Microsoft 365 in the opened window — ' +
                                  'then it runs invisibly from the tray.'
                        }).show();
                    } catch (_) { /* notifications optional */ }
                } else {
                    log('startup: copilot signed in — staying invisible');
                }
            } else if (prov === 'chatgpt') {
                const auth = await checkChatgptSignedIn().catch(error => ({ ok: false, why: error.message }));
                if (!auth.ok) {
                    log('startup: chatgpt ' + auth.why + ' — showing browser for sign-in');
                    showChatgpt();
                    try {
                        new Notification({
                            title: 'SignalREACH',
                            body: 'Sign in to ChatGPT in the opened window — ' +
                                  'then it runs invisibly from the tray.'
                        }).show();
                    } catch (_) { /* notifications optional */ }
                } else {
                    log('startup: chatgpt signed in — staying invisible');
                }
            } else if (prov === 'codegpt') {
                const auth = await checkCodegptSignedIn().catch(error => ({ ok: false, why: error.message }));
                if (!auth.ok) {
                    log('startup: codegpt ' + auth.why + ' — showing browser for sign-in');
                    showCodegpt();
                    try {
                        new Notification({
                            title: 'SignalREACH',
                            body: 'Sign in to CodeGPT in the opened window — ' +
                                  'then it runs invisibly from the tray.'
                        }).show();
                    } catch (_) { /* notifications optional */ }
                } else {
                    log('startup: codegpt signed in — staying invisible');
                }
            }
        }, 8000);
    });

    // tray app: keep running with zero visible windows
    app.on('window-all-closed', (e) => { /* do NOT quit */ });

    app.on('before-quit', () => {
        isQuitting = true;
        clearTimeout(clickTimer);
        clearTimeout(autoHideTimer);
        clearTimeout(chatgptAutoHideTimer);
        if (tray) { tray.destroy(); tray = null; }
        try { if (bridgeServer) bridgeServer.close(); } catch (_) { /* noop */ }
        log('=== Copilot tray quitting ===');
    });
}
