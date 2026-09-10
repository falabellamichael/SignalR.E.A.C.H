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
let bridgeServer = null;
let lastReplyAt = 0;
let lastError = '';


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

const CHATGPT_CONTROLS_JS = `(() => {
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
        b.onmouseenter = () => b.style.borderColor = '#10a37f';
        b.onmouseleave = () => b.style.borderColor = '#44444e';
        b.onclick = (e) => { e.preventDefault(); e.stopPropagation(); fn(); };
        return b;
    };
    bar.appendChild(mk('⟳', 'Reload this page', () => location.reload()));
    bar.appendChild(mk('⌂', 'Back to ChatGPT', () => { location.href = ${JSON.stringify(CHATGPT_URL)}; }));
    (document.body || document.documentElement).appendChild(bar);
    return 'injected';
})()`;

async function injectChatgptControls() {
    if (!chatgptWin || chatgptWin.isDestroyed()) return;
    try {
        await chatgptWin.webContents.executeJavaScript(CHATGPT_CONTROLS_JS);
    } catch (_) { /* page not ready */ }
    if (!chatgptWin.__ctlHooked) {
        chatgptWin.__ctlHooked = true;
        chatgptWin.webContents.on('did-finish-load', () => {
            if (chatgptWin && !chatgptWin.isDestroyed() && chatgptWin.isVisible()) {
                chatgptWin.webContents.executeJavaScript(CHATGPT_CONTROLS_JS).catch(() => {});
            }
        });
    }
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
    const result = chatgptQueue.then(async () => {
        options.signal?.throwIfAborted();
        return chatgptSend(text, options);
    });
    chatgptQueue = result.then(() => sleep(1500), () => sleep(1000));
    return result;
}

async function chatgptSend(text, { signal } = {}) {
    if (!chatgptWin || chatgptWin.isDestroyed()) {
        showChatgpt();
        throw new Error('Opening the ChatGPT window. Please complete sign in and retry.');
    }
    const started = Date.now();
    log('chatgpt request started (' + text.length + ' chars)');
    try {
        return await chatgptSendRequest(text, signal);
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

async function chatgptSendRequest(text, signal) {
    const auth = await checkChatgptSignedIn();
    if (!auth.ok) {
        showChatgpt();
        throw new Error(auth.why + ' — opening the ChatGPT window. Please complete sign in and retry.');
    }

    // Wait for any prior generation or DOM transition to settle
    while (true) {
        signal?.throwIfAborted();
        let snap;
        try { snap = await chatgptSnapshot(); } catch (_) { snap = null; }
        if (snap && snap.composer && !snap.generating) break;
        await sleep(400);
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
    const result = copilotQueue.then(async () => {
        options.signal?.throwIfAborted();
        return copilotSend(text, options);
    });
    copilotQueue = result.catch(() => {});
    return result;
}

async function copilotSend(text, options = {}) {
    const signal = options?.signal;
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
    let forming = null;
    let stable = 0;
    while (true) {
        signal?.throwIfAborted();
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
    lastReplyAt = Date.now();
    return forming;
}

/* ------------------------------ bridge server ------------------------------ */

function startBridge() {
    if (bridgeServer) return;
    const { createBridgeHandler } = require('./bridge');
    bridgeServer = http.createServer(createBridgeHandler(sendCopilotQueued, sendChatgptQueued, () => {
        const prov = endpoints.getSettings().provider;
        const cVis = !!(browserWin && !browserWin.isDestroyed() && browserWin.isVisible());
        const gVis = !!(chatgptWin && !chatgptWin.isDestroyed() && chatgptWin.isVisible());
        return {
            ok: true, service: 'signalreach-tray', bridge: BRIDGE_PORT,
            provider: prov,
            copilotVisible: cVis,
            chatgptVisible: gVis,
            browserVisible: prov === 'chatgpt' ? gVis : cVis,
            lastReplyAt, lastError
        };
    }));
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
    return Menu.buildFromTemplate([
        { label: 'Free model endpoints', type: 'radio', checked: endpoints.getSettings().provider === 'endpoint',
          click: () => { saveTraySettings({ provider: 'endpoint' }); openPanel(); } },
        { label: 'Microsoft 365 Copilot', type: 'radio', checked: endpoints.getSettings().provider === 'copilot',
          click: () => { saveTraySettings({ provider: 'copilot' }); openPanel(); } },
        { label: 'ChatGPT', type: 'radio', checked: endpoints.getSettings().provider === 'chatgpt',
          click: () => { saveTraySettings({ provider: 'chatgpt' }); openPanel(); } },
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

async function sendChatMessages(config, messages) {
    let content;
    if (config.provider === 'endpoint') {
        content = await endpoints.chat(config, messages);
    } else if (config.provider === 'chatgpt') {
        content = await sendChatgptQueued(messages.map(m => `${m.role}: ${m.content}`).join('\n\n'));
    } else {
        content = await sendCopilotQueued(messages.map(m => `${m.role}: ${m.content}`).join('\n\n'));
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
        } else {
            auth = await checkSignedIn().catch(error => ({ ok: false, why: error.message }));
        }
        const isChatgpt = config.provider === 'chatgpt';
        const isCopilot = config.provider === 'copilot';
        const activeWin = isChatgpt ? chatgptWin : browserWin;
        return {
            ...config, models, base,
            signedIn: !!auth.ok, why: auth.ok ? '' : auth.why || '',
            bridgePort: BRIDGE_PORT, bridgeUp: !!bridgeServer,
            browserVisible: !!(activeWin && !activeWin.isDestroyed() && activeWin.isVisible()),
            chatgptVisible: !!(chatgptWin && !chatgptWin.isDestroyed() && chatgptWin.isVisible()),
            copilotVisible: !!(browserWin && !browserWin.isDestroyed() && browserWin.isVisible()),
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
            const chatMessages = [
                ...(grounding ? [{ role: 'system', content: grounding }] : []),
                ...history.filter(m => m && ['user', 'assistant'].includes(m.role) && m.content)
                    .map(m => ({ role: m.role, content: String(m.content).slice(0, 1200) })),
                { role: 'user', content: message }
            ];
            const content = await sendChatMessages(config, chatMessages);
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
        if (p === 'chatgpt') showChatgpt(); else showBrowser();
    });
    listen('hide-browser', () => {
        const p = endpoints.getSettings().provider;
        if (p === 'chatgpt') hideChatgpt(); else hideBrowser();
    });
    // toggle: if the window is already open, hide it (panel buttons are
    // one-button show/hide so the user never has to hunt for the other action)
    listen('toggle-browser', () => {
        const p = endpoints.getSettings().provider;
        if (p === 'chatgpt') {
            if (chatgptWin && !chatgptWin.isDestroyed() && chatgptWin.isVisible()) hideChatgpt();
            else showChatgpt();
        } else {
            if (browserWin && !browserWin.isDestroyed() && browserWin.isVisible()) hideBrowser();
            else showBrowser();
        }
    });
    listen('reload-browser', () => {
        const p = endpoints.getSettings().provider;
        if (p === 'chatgpt') reloadChatgpt(); else reloadBrowser();
    });
    listen('refresh-page', () => {
        const p = endpoints.getSettings().provider;
        if (p === 'chatgpt') { const win = ensureChatgpt(); win.webContents.reload(); }
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
        if (p === 'chatgpt') void signOutChatgpt(); else void signOutBrowser();
    });
    listen('quit', () => app.quit());
}

/* ---------------------------------- boot ---------------------------------- */

if (!app.requestSingleInstanceLock()) {
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
        const startProvider = endpoints.getSettings().provider;
        if (startProvider === 'copilot') ensureBrowser();
        if (startProvider === 'chatgpt') ensureChatgpt();
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
