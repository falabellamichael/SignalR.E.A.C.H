'use strict';

const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_POINTER = 'https://gist.githubusercontent.com/falabellamichael/e261e0c31ad08c373bcd667b6982847a/raw/simple-reach-endpoint.txt';
const DEFAULTS = { provider: 'endpoint', endpoint: DEFAULT_POINTER, model: '' };

function endpointUrl(value) {
    const url = new URL(String(value).trim());
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
        throw new Error('Use an HTTP or HTTPS endpoint URL without embedded credentials.');
    }
    url.hash = '';
    return url;
}

function request(url, { body, timeout = 0, redirects = 3 } = {}) {
    url = endpointUrl(url);
    return new Promise((resolve, reject) => {
        const payload = body === undefined ? null : JSON.stringify(body);
        const transport = url.protocol === 'https:' ? https : http;
        const req = transport.request(url, {
            method: payload === null ? 'GET' : 'POST',
            headers: { Accept: 'application/json, text/plain', 'ngrok-skip-browser-warning': 'true',
                ...(payload === null ? {} : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }) }
        }, res => {
            if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
                res.resume();
                if (payload !== null || redirects <= 0) return reject(new Error('Unexpected endpoint redirect.'));
                resolve(request(new URL(res.headers.location, url), { timeout, redirects: redirects - 1 }));
                return;
            }
            const chunks = [];
            let size = 0;
            res.on('data', chunk => {
                size += chunk.length;
                if (size > 8 * 1024 * 1024) { res.destroy(new Error('Endpoint response is too large.')); return; }
                chunks.push(chunk);
            });
            res.on('error', reject);
            res.on('end', () => {
                const text = Buffer.concat(chunks).toString('utf8');
                if (res.statusCode < 200 || res.statusCode >= 300) {
                    let detail = '';
                    try { const data = JSON.parse(text); detail = data.error?.message || data.detail || ''; } catch (_) {}
                    reject(new Error(`Endpoint returned HTTP ${res.statusCode}${detail ? ': ' + String(detail).slice(0, 240) : ''}`));
                } else resolve(text);
            });
        });
        // timeout 0 (the default) means no timer at all: a model reply is not
        // something to cut off. Callers that must not hang pass a value.
        const timer = timeout > 0
            ? setTimeout(() => req.destroy(new Error('Endpoint request timed out.')), timeout)
            : null;
        req.on('close', () => { if (timer) clearTimeout(timer); });
        req.on('error', reject);
        req.end(payload);
    });
}

function createEndpointClient(settingsPath) {
    let settings = { ...DEFAULTS };
    try {
        const saved = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
        settings = validate({ ...settings, ...saved });
    } catch (_) { /* first run or invalid old settings */ }
    let cached = null;
    let inFlight = null;

    function validate(value) {
        if (!['endpoint', 'copilot', 'chatgpt', 'codegpt'].includes(value.provider)) throw new Error('Choose Free endpoints, Microsoft 365 Copilot, ChatGPT, or CodeGPT economy models.');
        const endpoint = endpointUrl(value.endpoint || DEFAULT_POINTER).toString();
        return { provider: value.provider, endpoint, model: String(value.model || '').trim().slice(0, 200) };
    }
    function getSettings() { return { ...settings }; }
    function saveSettings(value) {
        const next = validate({ ...settings, ...value });
        fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
        const temp = settingsPath + '.tmp';
        fs.writeFileSync(temp, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
        fs.renameSync(temp, settingsPath);
        settings = next;
        cached = null;
        return getSettings();
    }
    async function discover(config = getSettings(), force = false) {
        const key = config.endpoint;
        if (!force && cached?.key === key && Date.now() - cached.at < 15000) return cached.value;
        if (inFlight?.key === key) return inFlight.promise;
        const promise = (async () => {
            let url = endpointUrl(config.endpoint);
            // The published pointer follows tunnel changes without manual edits.
            // Discovery is a metadata probe, so it keeps a bounded wait — only
            // model generation runs without a timeout.
            if (url.hostname === 'gist.githubusercontent.com' || url.pathname.endsWith('.txt')) {
                url = endpointUrl((await request(url, { timeout: 15000 })).trim());
            }
            url.pathname = url.pathname.replace(/\/+$/, '').replace(/\/v1$/, '') + '/v1';
            url.search = '';
            const base = url.toString().replace(/\/$/, '');
            const data = JSON.parse(await request(base + '/models', { timeout: 15000 }));
            const models = [...new Set((data.data || []).map(m => m?.id).filter(id => typeof id === 'string' && id))];
            if (!models.length) throw new Error('This endpoint returned no models.');
            const value = { base, models };
            cached = { key, at: Date.now(), value };
            return value;
        })();
        inFlight = { key, promise };
        try { return await promise; } finally { if (inFlight?.promise === promise) inFlight = null; }
    }
    async function chat(config, messages) {
        const { base, models } = await discover(config);
        const model = config.model || models[0];
        if (!models.includes(model)) throw new Error(`Model ${model} is no longer available. Choose a model in Controls.`);
        // No timeout: this is a model reply, not a metadata probe.
        const data = JSON.parse(await request(base + '/chat/completions', {
            body: { model, messages, stream: false }
        }));
        const content = data.choices?.[0]?.message?.content;
        if (typeof content !== 'string' || !content.trim()) throw new Error('The endpoint returned an empty reply.');
        return content;
    }
    return { getSettings, saveSettings, discover, chat };
}

module.exports = { createEndpointClient, endpointUrl, request, DEFAULT_POINTER };
