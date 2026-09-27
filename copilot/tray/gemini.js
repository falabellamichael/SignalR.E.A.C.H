'use strict';

// Gemini DOM adapter for the same tray browser used by ChatGPT and Copilot.
// Its persistent session is separate from every other provider.
// REACH reads only the Gemini page DOM, never account cookies or OAuth tokens.
const { app, session, shell } = require('electron');

const GEMINI_URL = 'https://gemini.google.com/app';
const GEMINI_PARTITION = 'persist:gemini';
const GEMINI_COMPOSER_SELECTOR = 'rich-textarea [contenteditable="true"], .ql-editor[contenteditable="true"], [role="textbox"][contenteditable="true"], textarea[aria-label*="prompt" i]';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function safePageUrl(value) {
    try { const url = new URL(value); return url.origin + url.pathname; }
    catch (_) { return ''; }
}

// Preserve code fences in replies used by REACH Agent mode. A plain innerText
// snapshot removes the fences around JSON actions and makes them unusable.
function geminiReplyText(root) {
    const selector = 'p, h1, h2, h3, h4, h5, h6, pre, ul, ol, blockquote, table';
    const controls = 'button, input, select, textarea, svg, iframe, [role="button"], [role="toolbar"], [aria-hidden="true"]';
    const thinking = '[data-test-id*="thinking"], [data-testid*="thinking"], [aria-label*="thinking" i], details';
    const codeFence = pre => {
        const code = pre.querySelector('code');
        const languageClass = code && (code.className || '').match(/(?:^|\s)language-([\w+-]+)/);
        const language = languageClass ? languageClass[1] :
            ((code && code.getAttribute('data-language')) || pre.getAttribute('data-language') || '');
        const safeLanguage = /^[\w+-]*$/.test(language) ? language : '';
        const body = code ? code.textContent : pre.textContent;
        return '```' + safeLanguage + '\n' + body.replace(/\n$/, '') + '\n```';
    };
    const blocks = [root, ...root.querySelectorAll(selector)].filter(el => {
        if (!el.matches(selector) || el.closest(thinking)) return false;
        const parent = el.parentElement?.closest(selector);
        return !parent || !root.contains(parent);
    });
    const parts = blocks.map(el => {
        const copy = el.cloneNode(true);
        copy.querySelectorAll(controls + ', ' + thinking).forEach(node => node.remove());
        copy.querySelectorAll('br').forEach(node => node.replaceWith('\n'));
        copy.querySelectorAll('a[href]').forEach(link => {
            const href = link.getAttribute('href') || '';
            const label = (link.textContent || '').trim();
            if (/^https?:\/\//i.test(href) && label) link.replaceWith('[' + label + '](' + href + ')');
        });
        if (el.tagName === 'PRE') return codeFence(copy);
        copy.querySelectorAll('pre').forEach(pre => pre.replaceWith('\n' + codeFence(pre) + '\n'));
        if (el.tagName === 'UL' || el.tagName === 'OL') {
            copy.querySelectorAll('li').forEach((li, i) => li.prepend(el.tagName === 'OL' ? (i + 1) + '. ' : '- '));
        }
        return (copy.innerText || copy.textContent || '').trim();
    }).filter(Boolean);
    if (parts.length) return parts.join('\n\n');
    const copy = root.cloneNode(true);
    copy.querySelectorAll(controls + ', ' + thinking).forEach(node => node.remove());
    copy.querySelectorAll('pre').forEach(pre => pre.replaceWith('\n' + codeFence(pre) + '\n'));
    return (copy.innerText || copy.textContent || '').trim();
}

function createGeminiBrowser(_userDataDir, log, {
    createProviderWindow, installControlTile, waitForProviderWindow,
    replaceComposerText, sendProviderEnter, refreshNativeMenus
}) {
    let win = null;
    let quitting = false;
    let lastError = '';
    let lastUrl = '';
    let lastVisible = false;
    let lastReady = false;
    let autoHideTimer = null;
    const controls = { homeUrl: GEMINI_URL, accent: '#4285f4', homeTitle: 'Back to Gemini' };
    app.on('before-quit', () => { quitting = true; clearTimeout(autoHideTimer); });

    function maybeAutoHideAfterSignIn() {
        if (!win || win.isDestroyed() || !win.isVisible()) return;
        clearTimeout(autoHideTimer);
        autoHideTimer = setTimeout(async () => {
            try {
                if ((await snapshot()).ready) {
                    log('gemini sign-in complete — hiding window');
                    await hide();
                }
            } catch (_) { /* page still loading */ }
        }, 6000);
    }

    async function ensure({ launch = true } = {}) {
        if (win && !win.isDestroyed()) return win;
        if (!launch) throw new Error('Open Gemini from the SignalREACH tray to sign in.');
        await app.whenReady();
        if (win && !win.isDestroyed()) return win;
        const browser = createProviderWindow('Gemini (SignalR.E.A.C.H)', GEMINI_PARTITION);
        win = browser;
        browser.webContents.setWindowOpenHandler(({ url }) => {
            let host = '';
            try { host = new URL(url).hostname; } catch (_) { /* external link */ }
            if (host === 'gemini.google.com' || host === 'accounts.google.com') {
                void browser.loadURL(url).catch(() => { lastError = 'Gemini sign-in page failed to load.'; });
            } else if (/^https?:\/\//i.test(url)) {
                void shell.openExternal(url).catch(() => { lastError = 'External link failed to open.'; });
            }
            return { action: 'deny' };
        });
        browser.webContents.on('did-navigate', (_event, url) => {
            lastUrl = safePageUrl(url);
            lastReady = false;
            if (lastUrl.startsWith('https://gemini.google.com/')) maybeAutoHideAfterSignIn();
        });
        browser.webContents.on('did-navigate-in-page', (_event, url) => {
            lastUrl = safePageUrl(url);
        });
        browser.on('close', event => {
            if (!quitting) {
                event.preventDefault();
                void hide();
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
        void browser.loadURL(GEMINI_URL).catch(() => {
            lastError = 'Gemini page failed to load.';
            log(lastError);
        });
        void installControlTile(browser, controls);
        lastError = '';
        log('gemini in-tray browser created (partition ' + GEMINI_PARTITION + ')');
        return browser;
    }

    async function evaluate(expression, { launch = true } = {}) {
        const browser = await ensure({ launch });
        if (browser.webContents.isDestroyed()) throw new Error('Gemini browser closed.');
        let timer;
        try {
            return await Promise.race([
                browser.webContents.executeJavaScript(expression),
                new Promise((_, reject) => {
                    timer = setTimeout(() => reject(new Error('Gemini page did not respond within 10 seconds.')), 10000);
                })
            ]);
        } finally { clearTimeout(timer); }
    }

    // Gemini Apps is not a documented automation surface. Prefer semantic
    // attributes and named custom elements, and fail closed when they change.
    const snapshotScript = `(() => {
        const visible = el => !!(el && el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden');
        const composer = [...document.querySelectorAll(${JSON.stringify(GEMINI_COMPOSER_SELECTOR)})].find(visible);
        const replies = (['model-response', '[data-test-id="model-response"]', '.response-container']
            .map(selector => [...document.querySelectorAll(selector)].filter(visible))
            .find(items => items.length) || []);
        const users = [...document.querySelectorAll('user-query, [data-test-id="user-query"], [data-testid="user-message"]')].filter(visible);
        const reply = replies.at(-1);
        const answer = reply && ([...reply.querySelectorAll('message-content, .model-response-text, .response-content')].filter(visible).at(-1) || reply);
        const text = answer ? (${geminiReplyText.toString()})(answer) : '';
        const busy = [...document.querySelectorAll('button')].some(button => visible(button) && !button.disabled && /stop (response|generating)|cancel response/i.test(button.getAttribute('aria-label') || button.innerText || ''))
            || !!(reply && reply.querySelector('[aria-busy="true"], [role="progressbar"]'));
        const onGemini = location.hostname === 'gemini.google.com';
        const signInRequired = [...document.querySelectorAll('a, button, [role="button"]')]
            .some(el => visible(el) && (/^sign in$/i.test((el.innerText || el.textContent || '').trim())
                || /^sign in(?: to .+)?$/i.test((el.getAttribute('aria-label') || '').trim())));
        const signedInEvidence = [...document.querySelectorAll('a[aria-label], button[aria-label], img[alt]')]
            .some(el => visible(el) && /google account|profile (?:photo|picture)|account menu/i.test(
                el.getAttribute('aria-label') || el.getAttribute('alt') || ''));
        const rejectedPath = location.hostname === 'accounts.google.com'
            && location.pathname.includes('/signin/rejected');
        const rejectedText = location.hostname === 'accounts.google.com'
            && /couldn.t sign you in/i.test((document.body && document.body.innerText) || '')
            && /browser or app may not be secure/i.test((document.body && document.body.innerText) || '');
        return { ready: onGemini && !!composer && !signInRequired && !rejectedPath && !rejectedText,
            composer: onGemini && !!composer, signIn: signInRequired || location.hostname === 'accounts.google.com',
            challenge: rejectedPath || rejectedText,
            signInRequired, signedInEvidence, count: replies.length, userCount: users.length,
            composerText: composer ? (composer.innerText || composer.value || composer.textContent || '').trim() : '',
            text, busy, insecureBrowser: rejectedPath || rejectedText,
            url: location.origin + location.pathname };
    })()`;

    async function snapshot({ launch = true } = {}) {
        const state = await evaluate(snapshotScript, { launch });
        lastUrl = safePageUrl(state?.url);
        lastReady = !!state?.ready && !state.insecureBrowser;
        return state || { ready: false, count: 0, userCount: 0, composerText: '', text: '', busy: false, insecureBrowser: false, url: lastUrl };
    }

    async function show() {
        const browser = await ensure();
        if (process.platform === 'darwin' && app.dock) {
            try { app.dock.show(); } catch (_) { /* optional */ }
        }
        browser.show();
        browser.focus();
        await installControlTile(browser, controls);
        refreshNativeMenus();
        lastVisible = true;
        lastError = '';
    }

    async function hide() {
        if (win && !win.isDestroyed()) win.hide();
        lastVisible = false;
        refreshNativeMenus();
    }

    async function isVisible() {
        lastVisible = !!(win && !win.isDestroyed() && win.isVisible());
        return lastVisible;
    }

    async function reload() { (await ensure()).webContents.reload(); }
    async function home() { await (await ensure()).loadURL(GEMINI_URL); }
    async function signOut() {
        clearTimeout(autoHideTimer);
        if (win && !win.isDestroyed()) win.destroy();
        win = null;
        await session.fromPartition(GEMINI_PARTITION).clearStorageData();
        lastReady = false;
        lastVisible = false;
        lastUrl = '';
        lastError = '';
        await ensure();
    }

    async function status() {
        try {
            const state = await snapshot({ launch: false });
            const why = state.insecureBrowser
                ? 'Google blocked sign-in in the SignalREACH browser. Gemini requests cannot use this session; open Gemini in a supported browser for manual use.'
                : state.signInRequired ? 'Sign in to Gemini in the SignalREACH browser before sending requests.'
                : state.ready ? '' : lastUrl.startsWith('https://accounts.google.com/')
                    ? 'Finish Google sign-in in the SignalREACH browser.'
                    : 'Gemini composer is unavailable. Open Gemini from the tray to sign in or check the web app.';
            if (state.ready) lastError = '';
            return { ok: !!state.ready && !state.insecureBrowser, why, visible: await isVisible(), url: lastUrl };
        } catch (error) {
            lastError = error.message;
            return { ok: false, why: error.message, visible: await isVisible(), url: lastUrl };
        }
    }

    async function sendRequest(text, { signal, onDelta } = {}) {
        const prompt = String(text || '').trim();
        if (!prompt) throw new Error('Gemini prompt is empty.');
        if (signal?.aborted) throw new Error('Gemini request cancelled.');
        await waitForProviderWindow(ensure, snapshot, show, 'Gemini', signal);
        const browser = await ensure();
        let before = await snapshot();
        let waiting = 0;
        while (before.busy) {
            signal?.throwIfAborted();
            if (waiting === 30000) await stopGeneration();
            if (waiting >= 90000) throw new Error('Gemini composer stayed busy for 90 seconds. Check its window and retry.');
            await sleep(400);
            waiting += 400;
            before = await snapshot();
        }
        await replaceComposerText(browser.webContents, GEMINI_COMPOSER_SELECTOR, prompt, 'Gemini');
        // Match ChatGPT/Copilot: trust the editor insertion, then verify the
        // submit. Rich-text innerText need not equal the original multiline text.
        await sleep(400);
        signal?.throwIfAborted();
        sendProviderEnter(browser.webContents);
        await sleep(1200);
        const accepted = state => state.userCount > before.userCount || state.count > before.count
            || (state.composer && !state.composerText);
        let state = await snapshot();
        // The same Enter-first, Send-button fallback as ChatGPT and Copilot.
        // Do not click again after the page has already accepted this request.
        if (!accepted(state) && !state.busy) {
            signal?.throwIfAborted();
            log('gemini: Enter did not submit — clicking send button');
            const sendButton = await evaluate(`(() => {
            const editor = [...document.querySelectorAll(${JSON.stringify(GEMINI_COMPOSER_SELECTOR)})]
                .find(e => e.getClientRects().length);
            if (!editor) return null;
            const box = editor.getBoundingClientRect();
            const button = [...document.querySelectorAll('button')].find(e => {
                if (!e.getClientRects().length || e.disabled) return false;
                const label = (e.getAttribute('aria-label') || e.getAttribute('title') || '').trim();
                if (!/^send(?: (?:message|prompt))?$/i.test(label) && e.getAttribute('data-test-id') !== 'send-button') return false;
                const rect = e.getBoundingClientRect();
                const gapX = Math.max(box.left - rect.right, rect.left - box.right, 0);
                const gapY = Math.max(box.top - rect.bottom, rect.top - box.bottom, 0);
                return gapX <= 120 && gapY <= 120;
            });
            if (!button) return null;
            const rect = button.getBoundingClientRect();
            button.click();
            return { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) };
        })()`);
            if (!sendButton) throw new Error('Gemini did not expose an enabled Send button. Check its window.');
            await sleep(400);
            state = await snapshot();
            if (!accepted(state) && !state.busy) {
                browser.webContents.sendInputEvent({ type: 'mouseDown', x: sendButton.x, y: sendButton.y, button: 'left', clickCount: 1 });
                browser.webContents.sendInputEvent({ type: 'mouseUp', x: sendButton.x, y: sendButton.y, button: 'left', clickCount: 1 });
            }
        }
        // Never resend blindly: a slow page can accept the first attempt even
        // when a reply has not appeared. Require a visible submission signal.
        let submitted = accepted(state);
        for (let attempt = 0; attempt < 10 && !submitted; attempt++) {
            if (signal?.aborted) throw new Error('Gemini request cancelled.');
            await sleep(400);
            const state = await snapshot();
            submitted = accepted(state);
            if (submitted) break;
        }
        if (!submitted) throw new Error('Gemini did not visibly submit the prompt. Check the SignalREACH browser; the draft was left in place.');
        log('gemini message submitted');
        const deadline = Date.now() + 180000;
        let lastText = '';
        let streamed = '';
        let stableSince = 0;
        while (Date.now() < deadline) {
            if (signal?.aborted) throw new Error('Gemini request cancelled.');
            await sleep(650);
            const state = await snapshot();
            const fresh = state.count > before.count
                || (state.text && state.text !== before.text);
            if (!fresh || !state.text || /^thinking\s*\.?\.?.?$/i.test(state.text)) continue;
            if (state.text !== lastText) { lastText = state.text; stableSince = Date.now(); }
            if (typeof onDelta === 'function' && state.text.startsWith(streamed)) {
                const delta = state.text.slice(streamed.length);
                streamed = state.text;
                if (delta) { try { onDelta(delta); } catch (_) { /* client gone */ } }
            }
            if (state.busy) stableSince = Date.now();
            // Gemini has no documented completion event. If its Stop control
            // is absent, a longer quiet period avoids returning a paused draft.
            if (!state.busy && Date.now() - stableSince >= 12000) {
                log('gemini browser reply complete (' + lastText.length + ' chars)');
                return lastText;
            }
        }
        throw new Error(lastText ? 'Gemini response did not finish within three minutes.' : 'Gemini did not return an answer within three minutes. Check the SignalREACH browser.');
    }

    async function stopGeneration() {
        if (!win || win.isDestroyed()) return;
        await evaluate(`(() => {
            const stop = [...document.querySelectorAll('button')].find(button =>
                button.getClientRects().length && !button.disabled &&
                /stop (response|generating)|cancel response/i.test(button.getAttribute('aria-label') || button.innerText || ''));
            if (stop) stop.click();
        })()`, { launch: false }).catch(() => {});
    }

    async function send(text, options) {
        const started = Date.now();
        log('gemini request started');
        try {
            const answer = await sendRequest(text, options);
            lastError = '';
            return answer;
        } catch (error) {
            lastError = error.message;
            await stopGeneration();
            log('gemini request failed: ' + error.message);
            throw error;
        } finally {
            log('gemini request finished (' + Math.round((Date.now() - started) / 1000) + 's)');
        }
    }

    return { ensure, show, hide, isVisible, reload, home, signOut, status, send,
        health: () => ({ connected: !!(win && !win.isDestroyed()), ready: lastReady,
            visible: !!(win && !win.isDestroyed() && win.isVisible()), lastError, url: lastUrl }) };
}

module.exports = { createGeminiBrowser };
