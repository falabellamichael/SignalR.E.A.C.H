'use strict';

// Devin (subscription) console driver. Sign-in happens in a dedicated tray
// window with its own persistent session; the driver reads only the page DOM.
// app.devin.ai is an agent console: a prompt creates a session and Devin posts
// messages until the session settles — the last message block is the answer.
// Selectors are semantic and deliberately broad; the driver fails closed with
// a specific error when the console markup changes.
const { createSubscriptionBrowser } = require('./subscription-driver');

function createDevinBrowser(log = () => {}) {
    return createSubscriptionBrowser({
        name: 'Devin',
        homeUrl: 'https://app.devin.ai/',
        partition: 'persist:devin',
        allowedHosts: new Set([
            'app.devin.ai', 'auth.devin.ai', 'api.devin.ai',
            'accounts.google.com', 'login.microsoftonline.com', 'login.live.com'
        ]),
        composer: [
            'textarea[placeholder]', 'textarea',
            '[contenteditable="true"]', '[role="textbox"]'
        ],
        replies: [
            '[data-testid*="message" i]', '[class*="DevinMessage" i]',
            '[class*="message-content" i]', '[class*="chat-message" i]',
            '[class*="markdown" i]', '.markdown', '[role="article"]'
        ],
        busy: [
            '[data-testid*="stop" i]', 'button[aria-label*="stop" i]',
            '[class*="spinner" i]', '[role="progressbar"]', '[data-testid*="loading" i]'
        ],
        busyText: /working|thinking|running|in progress|processing|planning/i,
        signIn: /sign in|log in|create an account|get started|welcome back/i,
        readySelectors: [
            '[aria-label*="account" i]', '[aria-label*="profile" i]',
            '[class*="avatar" i]', 'img[alt*="avatar" i]', '[data-testid*="user" i]'
        ],
        settleMs: 15000,
        timeoutMs: 10 * 60 * 1000
    }, log);
}

module.exports = { createDevinBrowser };
