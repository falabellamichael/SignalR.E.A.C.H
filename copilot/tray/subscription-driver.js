'use strict';

/* Shared driver for subscription "agent console" providers (Devin, Codex).
 * Unlike a chat page, these consoles accept one prompt, run an agent for a
 * while, and settle on a final message. Sign-in happens in a dedicated
 * tray-owned window; the persistent session is separate from every other
 * provider and the driver reads only the page DOM — never cookies or tokens.
 * Agent consoles are not documented automation surfaces: selectors prefer
 * semantic attributes and every step fails closed with a specific error. */
const { app, BrowserWindow, session, shell } = require('electron');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function safePageUrl(value) {
    try { const url = new URL(value); return url.origin + url.pathname; }
    catch (_) { return ''; }
}

// Preserve code fences: agent answers are usually patches/markdown and a plain
// innerText snapshot destroys the fences an agent-mode client relies on.
function agentReplyText(root) {
    const selector = 'p, h1, h2, h3, h4, h5, h6, pre, ul, ol, blockquote, table, li';
    const controls = 'button, input, select, textarea, svg, iframe, [role="button"], [role="toolbar"], [aria-hidden="true"]';
    const codeFence = pre => {
        const code = pre.querySelector('code');
        const languageClass = code && (code.className || '').match(/(?:^|\s)language-([\w+-]+)/);
        const language = languageClass ? languageClass[1] :
            ((code && code.getAttribute('data-language')) || pre.getAttribute('data-language') || '');
        const safeLanguage = /^[\w+-]*$/.test(language) ? language : '';
        const body = code ? code.textContent : pre.textContent;
        return '```' + safeLanguage + '\n' + body.replace(/\n$/, '') + '\n```';
    };
    const copy = root.cloneNode(true);
    copy.querySelectorAll(controls).forEach(node => node.remove());
    copy.querySelectorAll('br').forEach(node => node.replaceWith('\n'));
    copy.querySelectorAll('pre').forEach(pre => pre.replaceWith('\n' + codeFence(pre) + '\n'));
    const blocks = [copy, ...copy.querySelectorAll(selector)].filter(el => {
        if (!el.matches(selector)) return false;
        const parent = el.parentElement?.closest(selector);
        return !parent || !copy.contains(parent);
    });
    const parts = blocks.map(el => (el.innerText || el.textContent || '').trim()).filter(Boolean);
    return (parts.length ? parts.join('\n\n') : (copy.innerText || copy.textContent || '')).trim();
}

/* config: {
 *   name           display name, e.g. 'Devin'
 *   homeUrl        console landing page, e.g. 'https://app.devin.ai/'
 *   partition      persist:<id> session partition
 *   allowedHosts   hosts the window may navigate to (provider + SSO)
 *   composer       CSS selectors for the prompt box (first visible wins)
 *   replies        CSS selectors for agent answer blocks (last visible wins)
 *   busy           CSS selectors that signal the agent is still working
 *   busyText       /regex/ matched against visible status/indicator labels
 *   signIn         /regex/ matched against the page body to detect a login wall
 *   readySelectors CSS selectors proving a signed-in console (profile/menu)
 *   settleMs       quiet period (no text change, not busy) before the answer is final
 *   timeoutMs      overall request cap — agent runs take minutes
 * } */
function createSubscriptionBrowser(config, log = () => {}) {
    let win = null;
    let quitting = false;
    let lastError = '';
    let lastUrl = '';
    let lastVisible = false;
    let lastReady = false;
    app.on('before-quit', () => { quitting = true; });

    const hostAllowed = value => {
        try { return config.allowedHosts.has(new URL(value).hostname); }
        catch (_) { return false; }
    };

    async function ensure({ launch = true } = {}) {
        if (win && !win.isDestroyed()) return win;
        if (!launch) throw new Error('Open ' + config.name + ' from the SignalREACH tray to sign in.');
        await app.whenReady();
        if (win && !win.isDestroyed()) return win;
        const browser = new BrowserWindow({
            width: 1180, height: 860, show: false,
            title: config.name + ' (SignalREACH)', autoHideMenuBar: true,
            webPreferences: {
                partition: config.partition,
                contextIsolation: true, nodeIntegration: false,
                sandbox: true, backgroundThrottling: false
            }
        });
        win = browser;
        browser.webContents.setWindowOpenHandler(({ url }) => {
            if (hostAllowed(url)) {
                void browser.loadURL(url).catch(() => { lastError = config.name + ' sign-in page failed to load.'; });
            } else if (/^https?:\/\//i.test(url)) {
                void shell.openExternal(url).catch(() => { lastError = 'External link failed to open.'; });
            }
            return { action: 'deny' };
        });
        browser.webContents.on('will-navigate', (event, url) => {
            if (!hostAllowed(url)) event.preventDefault();
        });
        browser.webContents.on('did-navigate', (_event, url) => {
            lastUrl = safePageUrl(url);
            lastReady = false;
        });
        browser.webContents.on('did-navigate-in-page', (_event, url) => {
            lastUrl = safePageUrl(url);
        });
        browser.on('close', event => {
            if (!quitting) {
                event.preventDefault();
                browser.hide();
                lastVisible = false;
            }
        });
        browser.on('show', () => { lastVisible = true; });
        browser.on('hide', () => { lastVisible = false; });
        browser.on('closed', () => {
            if (win !== browser) return;
            win = null;
            lastVisible = false;
            lastReady = false;
        });
        void browser.loadURL(config.homeUrl).catch(() => {
            lastError = config.name + ' page failed to load.';
            log(lastError);
        });
        lastError = '';
        log(config.name.toLowerCase() + ' in-tray browser created (partition ' + config.partition + ')');
        return browser;
    }

    async function evaluate(expression, { launch = true } = {}) {
        const browser = await ensure({ launch });
        if (browser.webContents.isDestroyed()) throw new Error(config.name + ' browser closed.');
        let timer;
        try {
            return await Promise.race([
                browser.webContents.executeJavaScript(expression),
                new Promise((_, reject) => {
                    timer = setTimeout(() => reject(new Error(config.name + ' page did not respond within 10 seconds.')), 10000);
                })
            ]);
        } finally { clearTimeout(timer); }
    }

    const snapshotScript = `(() => {
        const visible = el => !!(el && el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden');
        const pick = selectors => selectors.map(sel => [...document.querySelectorAll(sel)].filter(visible)).find(items => items.length) || [];
        const composers = pick(${JSON.stringify(config.composer)});
        const composer = composers[0];
        const replies = pick(${JSON.stringify(config.replies)});
        const reply = replies.at(-1);
        const text = reply ? (${agentReplyText.toString()})(reply) : '';
        const busyBySelector = pick(${JSON.stringify(config.busy)}).length > 0;
        const busyByText = (() => {
            const rx = ${config.busyText.toString()};
            return [...document.querySelectorAll('[role="status"], [class*="status" i], [class*="progress" i], [data-testid*="status"], [data-testid*="loading"]')]
                .some(el => visible(el) && rx.test((el.innerText || el.textContent || '').slice(0, 200)));
        })();
        const bodyText = ((document.querySelector('main') || document.body || {}).innerText || '').slice(0, 6000);
        const signIn = !composer && ${config.signIn.toString()}.test(bodyText);
        const signedInEvidence = pick(${JSON.stringify(config.readySelectors)}).length > 0;
        return {
            ready: !!composer && !signIn,
            signIn, signedInEvidence,
            count: replies.length,
            composerText: composer ? (composer.innerText || composer.value || composer.textContent || '').trim() : '',
            text, busy: busyBySelector || busyByText,
            url: location.origin + location.pathname
        };
    })()`;

    async function snapshot({ launch = true } = {}) {
        const state = await evaluate(snapshotScript, { launch });
        lastUrl = safePageUrl(state?.url) || lastUrl;
        lastReady = !!state?.ready;
        return state || { ready: false, signIn: false, signedInEvidence: false, count: 0, composerText: '', text: '', busy: false, url: lastUrl };
    }

    async function show() {
        const browser = await ensure();
        browser.show();
        browser.focus();
        lastVisible = true;
        lastError = '';
    }

    async function hide() {
        if (win && !win.isDestroyed()) win.hide();
        lastVisible = false;
    }

    async function isVisible() {
        lastVisible = !!(win && !win.isDestroyed() && win.isVisible());
        return lastVisible;
    }

    async function reload() { (await ensure()).webContents.reload(); }
    async function home() { await (await ensure()).loadURL(config.homeUrl); }
    async function signOut() {
        if (win && !win.isDestroyed()) win.destroy();
        win = null;
        await session.fromPartition(config.partition).clearStorageData();
        lastReady = false;
        lastVisible = false;
        lastUrl = '';
        lastError = '';
    }

    async function status() {
        try {
            const state = await snapshot({ launch: false });
            const why = state.signIn ? 'Sign in to ' + config.name + ' in the SignalREACH browser before sending requests.'
                : state.ready ? ''
                : lastUrl && !hostAllowed(lastUrl) ? 'Finish sign-in in the SignalREACH browser.'
                : config.name + ' prompt box is unavailable. Open ' + config.name + ' from the tray to sign in or check the console.';
            if (state.ready) lastError = '';
            return { ok: !!state.ready, why, visible: await isVisible(), url: lastUrl };
        } catch (error) {
            lastError = error.message;
            return { ok: false, why: error.message, visible: await isVisible(), url: lastUrl };
        }
    }

    async function sendRequest(text, { signal, onReasoning } = {}) {
        const prompt = String(text || '').trim();
        if (!prompt) throw new Error(config.name + ' prompt is empty.');
        if (signal?.aborted) throw new Error(config.name + ' request cancelled.');
        const browser = await ensure();
        await show();
        browser.webContents.focus();
        const before = await snapshot();
        if (!before.ready) {
            throw new Error(before.signIn
                ? 'Sign in to ' + config.name + ' in the SignalREACH browser before sending requests.'
                : config.name + ' is not ready. Sign in or open the console in the SignalREACH browser.');
        }
        if (before.composerText) throw new Error(config.name + ' has an unsent draft. Clear or send it in the SignalREACH browser before using the bridge.');
        const focused = await evaluate(`(() => {
            const selectors = ${JSON.stringify(config.composer)};
            const el = selectors.map(sel => [...document.querySelectorAll(sel)]).flat().find(e => e.getClientRects().length);
            if (!el) return false;
            el.focus(); return document.activeElement === el || el.contains(document.activeElement);
        })()`);
        if (!focused) throw new Error(config.name + ' prompt box changed. Refresh the ' + config.name + ' page.');
        await browser.webContents.insertText(prompt);
        let inserted;
        for (let attempt = 0; attempt < 5; attempt++) {
            await sleep(100);
            inserted = await snapshot();
            if (inserted.composerText.replace(/\r\n?/g, '\n') === prompt.replace(/\r\n?/g, '\n')) break;
        }
        if (inserted.composerText.replace(/\r\n?/g, '\n') !== prompt.replace(/\r\n?/g, '\n')) {
            throw new Error(config.name + ' did not accept the prompt in its composer. Check the SignalREACH browser.');
        }
        const sendButton = await evaluate(`(() => {
            const selectors = ${JSON.stringify(config.composer)};
            const editor = selectors.map(sel => [...document.querySelectorAll(sel)]).flat().find(e => e.getClientRects().length);
            if (!editor) return null;
            const box = editor.getBoundingClientRect();
            const button = [...document.querySelectorAll('button, [role="button"]')].find(e => {
                if (!e.getClientRects().length || e.disabled || e.getAttribute('aria-disabled') === 'true') return false;
                const label = [e.getAttribute('aria-label'), e.getAttribute('title'), e.getAttribute('data-testid'), e.innerText].filter(Boolean).join(' ');
                if (!/send|submit|create (session|task)|start|launch|→|arrow/i.test(label)) return false;
                const rect = e.getBoundingClientRect();
                const gapX = Math.max(box.left - rect.right, rect.left - box.right, 0);
                const gapY = Math.max(box.top - rect.bottom, rect.top - box.bottom, 0);
                return gapX <= 160 && gapY <= 160;
            });
            if (!button) return null;
            const rect = button.getBoundingClientRect();
            return { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) };
        })()`);
        if (sendButton) {
            browser.webContents.sendInputEvent({ type: 'mouseDown', x: sendButton.x, y: sendButton.y, button: 'left', clickCount: 1 });
            browser.webContents.sendInputEvent({ type: 'mouseUp', x: sendButton.x, y: sendButton.y, button: 'left', clickCount: 1 });
        } else {
            browser.webContents.sendInputEvent({ type: 'rawKeyDown', keyCode: 'Enter' });
            browser.webContents.sendInputEvent({ type: 'char', keyCode: '\r' });
            browser.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' });
        }
        // Agent consoles take seconds to accept a submission (a new session or
        // task page has to load). Require a visible signal — a reply block, a
        // busy indicator, a cleared composer or a URL move — before waiting.
        let submitted = false;
        for (let attempt = 0; attempt < 25; attempt++) {
            if (signal?.aborted) throw new Error(config.name + ' request cancelled.');
            await sleep(400);
            const state = await snapshot();
            submitted = state.count > before.count || state.busy
                || (inserted.composerText && !state.composerText)
                || (state.url && before.url && state.url !== before.url);
            if (submitted) break;
        }
        if (!submitted) throw new Error(config.name + ' did not visibly submit the prompt. Check the SignalREACH browser; the draft was left in place.');
        const deadline = Date.now() + config.timeoutMs;
        let lastText = '';
        let stableSince = 0;
        let lastProgressNote = 0;
        while (Date.now() < deadline) {
            if (signal?.aborted) throw new Error(config.name + ' request cancelled.');
            await sleep(1000);
            const state = await snapshot();
            if (state.text && state.text !== lastText) { lastText = state.text; stableSince = Date.now(); }
            if (state.busy) stableSince = Date.now();
            if (typeof onReasoning === 'function' && state.busy && Date.now() - lastProgressNote > 20000) {
                lastProgressNote = Date.now();
                onReasoning(config.name + ' is working… ' + (state.text ? state.text.slice(0, 80) : ''));
            }
            // Agent consoles have no documented completion event. Once the
            // busy signal clears and the text stops changing for settleMs,
            // the last visible answer block is the finished result.
            if (lastText && !state.busy && Date.now() - stableSince >= config.settleMs) {
                log(config.name.toLowerCase() + ' reply complete (' + lastText.length + ' chars)');
                return lastText;
            }
        }
        throw new Error(lastText
            ? config.name + ' response did not finish in time.'
            : config.name + ' did not return an answer. Check the SignalREACH browser.');
    }

    async function send(text, options) {
        try {
            const answer = await sendRequest(text, options);
            lastError = '';
            return answer;
        } catch (error) {
            lastError = error.message;
            throw error;
        }
    }

    return { ensure, show, hide, isVisible, reload, home, signOut, status, send,
        health: () => ({ connected: !!(win && !win.isDestroyed()), ready: lastReady,
            visible: !!(win && !win.isDestroyed() && win.isVisible()), lastError, url: lastUrl }) };
}

module.exports = { createSubscriptionBrowser };
