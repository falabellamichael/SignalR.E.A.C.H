'use strict';

// Codex (ChatGPT subscription) console driver. Sign-in happens in a dedicated
// tray window with its own persistent session — separate from the chatgpt
// driver window even though the account is the same. chatgpt.com/codex is an
// agent console: a prompt creates a task, Codex reports progress, and the
// task's final block is the answer. Selectors are semantic and deliberately
// broad; the driver fails closed when the console markup changes.
const { createSubscriptionBrowser } = require('./subscription-driver');

function createCodexBrowser(log = () => {}) {
    return createSubscriptionBrowser({
        name: 'Codex',
        homeUrl: 'https://chatgpt.com/codex',
        partition: 'persist:codex',
        allowedHosts: new Set([
            'chatgpt.com', 'chat.openai.com',
            'auth.openai.com', 'auth0.openai.com', 'platform.openai.com',
            'accounts.google.com', 'login.microsoftonline.com', 'appleid.apple.com'
        ]),
        composer: [
            '#prompt-textarea', 'textarea[placeholder]', 'textarea',
            '[contenteditable="true"]', '[role="textbox"]'
        ],
        replies: [
            '[data-message-author-role="assistant"]', '[data-testid*="message" i]',
            '[class*="result" i]', '[class*="summary" i]',
            '[class*="markdown" i]', '.markdown', '.prose', '[role="article"]'
        ],
        busy: [
            'button[data-testid="stop-button"]', '[data-testid*="stop" i]',
            'button[aria-label*="stop" i]', '[class*="spinner" i]',
            '[role="progressbar"]', '[data-testid*="loading" i]'
        ],
        busyText: /working|thinking|running|in progress|processing|queued|executing/i,
        signIn: /log in|sign up|welcome back|create (an )?account/i,
        readySelectors: [
            '[data-testid="profile-button"]', '[data-testid*="profile" i]',
            '[aria-label*="account" i]', '[aria-label*="profile" i]', 'img[alt*="profile" i]'
        ],
        settleMs: 15000,
        timeoutMs: 10 * 60 * 1000
    }, log);
}

module.exports = { createCodexBrowser };
