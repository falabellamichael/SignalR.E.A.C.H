'use strict';

const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');
const { credentialOrigin, validKey } = require('./model-credentials');

const DEFAULT_POINTER = 'https://gist.githubusercontent.com/falabellamichael/e261e0c31ad08c373bcd667b6982847a/raw/simple-reach-endpoint.txt';
const DEFAULTS = { provider: 'endpoint', endpoint: DEFAULT_POINTER, model: '' };
const MODEL_POLL_INTERVAL_MS = 300000;

function endpointUrl(value) {
    const url = new URL(String(value).trim());
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
        throw new Error('Use an HTTP or HTTPS endpoint URL without embedded credentials.');
    }
    url.hash = '';
    return url;
}

function request(url, { body, timeout = 0, redirects = 3, authorization = null, authOrigin = null, onResponse = null } = {}) {
    url = endpointUrl(url);
    if (authorization && (!validKey(authorization) || url.protocol !== 'https:'
            || url.origin !== credentialOrigin(authOrigin) || body !== undefined
            || !url.pathname.endsWith('/v1/models') || url.search)) {
        throw new Error('Model credentials can only authenticate HTTPS model discovery at their bound origin.');
    }
    return new Promise((resolve, reject) => {
        const payload = body === undefined ? null : JSON.stringify(body);
        const transport = url.protocol === 'https:' ? https : http;
        const req = transport.request(url, {
            method: payload === null ? 'GET' : 'POST',
            headers: { Accept: 'application/json, text/plain', 'ngrok-skip-browser-warning': 'true',
                ...(authorization ? { Authorization: 'Bearer ' + authorization } : {}),
                ...(payload === null ? {} : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }) }
        }, res => {
            if (onResponse) onResponse(res.statusCode);
            if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
                res.resume();
                if (authorization) return reject(new Error('Authenticated model discovery redirects are blocked.'));
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
                    if (!authorization) { try { const data = JSON.parse(text); detail = data.error?.message || data.detail || ''; } catch (_) {} }
                    const error = new Error(`Endpoint returned HTTP ${res.statusCode}${detail ? ': ' + String(detail).slice(0, 240) : ''}`);
                    error.statusCode = res.statusCode;
                    reject(error);
                } else resolve(text);
            });
        });
        // timeout 0 (the default) means no timer at all: a model reply is not
        // something to cut off. Callers that must not hang pass a value.
        const timer = timeout > 0
            ? setTimeout(() => req.destroy(new Error('Endpoint request timed out.')), timeout)
            : null;
        req.on('close', () => { if (timer) clearTimeout(timer); });
        req.on('error', error => reject(authorization ? new Error('Authenticated model discovery transport failed.') : error));
        req.end(payload);
    });
}

/* Same transport as request(), but consumes a streaming reply: SSE deltas are
 * forwarded through onDelta as they arrive and the accumulated text is the
 * resolved value. A non-SSE (JSON) response is still accepted and unwrapped,
 * so an endpoint that ignores stream:true never looks like a hang. */
function requestStream(url, body, onDelta, { redirects = 3 } = {}) {
    url = endpointUrl(url);
    return new Promise((resolve, reject) => {
        const payload = JSON.stringify(body);
        const transport = url.protocol === 'https:' ? https : http;
        const req = transport.request(url, {
            method: 'POST',
            headers: { Accept: 'text/event-stream, application/json',
                'ngrok-skip-browser-warning': 'true',
                'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
        }, res => {
            if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
                res.resume();
                if (redirects <= 0) return reject(new Error('Unexpected endpoint redirect.'));
                resolve(requestStream(new URL(res.headers.location, url), body, onDelta, { redirects: redirects - 1 }));
                return;
            }
            if (res.statusCode < 200 || res.statusCode >= 300) {
                const chunks = [];
                res.on('data', c => chunks.push(c));
                res.on('end', () => {
                    const text = Buffer.concat(chunks).toString('utf8');
                    let detail = '';
                    try { const data = JSON.parse(text); detail = data.error?.message || data.detail || ''; } catch (_) { /* raw body below */ }
                    reject(new Error(`Endpoint returned HTTP ${res.statusCode}${detail ? ': ' + String(detail).slice(0, 240) : ''}`));
                });
                res.on('error', reject);
                return;
            }
            const isSse = /text\/event-stream/i.test(res.headers['content-type'] || '');
            let buffer = '';
            let streamed = '';
            if (!isSse) {
                // Contract says SSE but the endpoint may answer plain JSON.
                const chunks = [];
                let size = 0;
                res.on('data', c => { size += c.length; if (size > 8 * 1024 * 1024) res.destroy(new Error('Endpoint response is too large.')); else chunks.push(c); });
                res.on('error', reject);
                res.on('end', () => {
                    try {
                        const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
                        resolve(data.choices?.[0]?.message?.content || data.choices?.[0]?.delta?.content || '');
                    } catch (error) { reject(new Error('The endpoint did not return a usable reply.')); }
                });
                return;
            }
            res.setEncoding('utf8');
            res.on('data', chunk => {
                buffer += chunk;
                let idx;
                while ((idx = buffer.indexOf('\n')) >= 0) {
                    const line = buffer.slice(0, idx).trim();
                    buffer = buffer.slice(idx + 1);
                    if (!line.startsWith('data:')) continue;
                    const payloadText = line.slice(5).trim();
                    if (!payloadText || payloadText === '[DONE]') continue;
                    try {
                        const parsed = JSON.parse(payloadText);
                        const delta = parsed.choices?.[0]?.delta?.content ?? parsed.choices?.[0]?.message?.content;
                        if (typeof delta === 'string' && delta) {
                            streamed += delta;
                            if (onDelta) onDelta(delta);
                        }
                    } catch (_) { /* keepalive or partial line */ }
                }
            });
            res.on('error', reject);
            res.on('end', () => resolve(streamed));
        });
        // No timeout: a model reply is not something to cut off.
        req.on('error', reject);
        req.end(payload);
    });
}

/* Strict upstreams (vLLM/Qwen-class chat templates) accept exactly ONE system
 * message, and only at index 0: a second system — even one leading — is
 * answered with 400 "System message must be at the beginning." Callers may
 * stack systems (grounding, history, future features), so merge every system
 * message into a single leading one, preserving order, right before the
 * request leaves for the endpoint. */
function normalizeSystemMessages(messages) {
    if (!Array.isArray(messages) || !messages.length) return messages;
    let systems = 0;
    let firstAt = -1;
    for (let i = 0; i < messages.length; i += 1) {
        if (messages[i] && messages[i].role === 'system') {
            systems += 1;
            if (firstAt < 0) firstAt = i;
        }
    }
    if (systems === 0 || (systems === 1 && firstAt === 0)) return messages;
    const contents = [];
    const rest = [];
    for (const message of messages) {
        if (message && message.role === 'system') {
            const text = typeof message.content === 'string' ? message.content : '';
            if (text) contents.push(text);
        } else {
            rest.push(message);
        }
    }
    return contents.length
        ? [{ role: 'system', content: contents.join('\n\n') }, ...rest]
        : rest;
}

function createEndpointClient(settingsPath, { modelCredentials = null,
        clock = { now: () => Date.now(), setTimeout, clearTimeout } } = {}) {
    let settings = { ...DEFAULTS };
    try {
        const saved = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
        settings = validate({ ...settings, ...saved });
    } catch (_) { /* first run or invalid old settings */ }
    const cached = new Map();
    const inFlight = new Map();
    let generation = 0;
    let latestProbe = null;
    let attempts = 0;
    let lastSuccessAt = null;
    let pollingEnabled = false;
    let pollingRunning = false;
    let pollingTimer = null;
    let pollingDueAt = null;
    let pollingToken = 0;

    const discoveryKey = config => generation + '\0' + endpointUrl(config.endpoint).toString();
    function cancelPollingTimer() {
        pollingToken += 1;
        if (pollingTimer !== null) clock.clearTimeout(pollingTimer);
        pollingTimer = null;
        pollingDueAt = null;
    }
    function schedulePolling() {
        if (!pollingEnabled || pollingRunning) return;
        cancelPollingTimer();
        const config = getSettings();
        if (config.provider !== 'endpoint') return;
        const previous = cached.get(discoveryKey(config));
        const delay = previous ? Math.max(0, previous.at + MODEL_POLL_INTERVAL_MS - clock.now()) : 0;
        pollingDueAt = clock.now() + delay;
        const token = pollingToken;
        pollingTimer = clock.setTimeout(() => {
            if (!pollingEnabled || token !== pollingToken) return;
            pollingTimer = null;
            pollingDueAt = null;
            void pollOnce();
        }, delay);
        pollingTimer?.unref?.();
    }
    async function pollOnce() {
        if (!pollingEnabled || pollingRunning) return;
        pollingRunning = true;
        try {
            const config = getSettings();
            if (config.provider === 'endpoint') await discover(config, false, 'background');
        } catch (_) {
            // Discovery records sanitized errors and caches failures for five minutes.
        } finally {
            pollingRunning = false;
            schedulePolling();
        }
    }
    function startPolling() {
        if (pollingEnabled) return false;
        pollingEnabled = true;
        schedulePolling();
        return true;
    }
    function stopPolling() {
        pollingEnabled = false;
        cancelPollingTimer();
    }
    function resumePolling() {
        // An overdue poll runs once after wake, without replaying missed intervals.
        schedulePolling();
    }

    async function modelUrl(config = getSettings()) {
        let url = endpointUrl(config.endpoint);
        // Pointer/redirect discovery is always anonymous, before any vault read.
        if (url.hostname === 'gist.githubusercontent.com' || url.pathname.endsWith('.txt')) {
            url = endpointUrl((await request(url, { timeout: 15000 })).trim());
        }
        url.pathname = url.pathname.replace(/\/+$/, '').replace(/\/v1$/, '') + '/v1';
        url.search = '';
        return url;
    }
    async function modelOrigin(config = getSettings()) { return (await modelUrl(config)).origin; }
    function invalidateDiscovery() { generation += 1; cached.clear(); schedulePolling(); }
    function discoveryStatus() {
        return { intervalMs: MODEL_POLL_INTERVAL_MS, attempts, lastAttemptAt: latestProbe?.startedAt || null,
            lastCompletedAt: latestProbe?.completedAt || null, lastSuccessAt,
            httpStatus: latestProbe?.httpStatus || null, errorCode: latestProbe?.errorCode || '',
            lastTrigger: latestProbe?.trigger || null,
            nextEligibleAt: latestProbe?.completedAt ? latestProbe.completedAt + MODEL_POLL_INTERVAL_MS : null,
            backgroundPolling: { enabled: pollingEnabled, inFlight: pollingRunning, nextDueAt: pollingDueAt } };
    }

    function validate(value) {
        if (!['endpoint', 'copilot', 'chatgpt', 'codegpt', 'gemini'].includes(value.provider)) throw new Error('Choose Free endpoints, Microsoft 365 Copilot, ChatGPT, CodeGPT economy models, or Gemini.');
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
        // Provider/model edits must not reset the discovery retry interval.
        // Endpoint URLs have separate cache entries; explicit refresh remains available.
        schedulePolling();
        return getSettings();
    }
    async function discover(config = getSettings(), force = false, trigger = 'demand') {
        const key = discoveryKey(config);
        if (inFlight.has(key)) return inFlight.get(key);
        const previous = cached.get(key);
        if (previous && clock.now() - previous.at < MODEL_POLL_INTERVAL_MS
                && (!force || previous.error)) {
            // Cache failures too: status/UI refreshes must not hammer a broken
            // or unauthenticated endpoint. Even forced refresh respects this backoff.
            if (previous.error) throw previous.error;
            return previous.value;
        }
        const probe = { startedAt: clock.now(), completedAt: null, httpStatus: null, errorCode: '',
            trigger: trigger === 'background' ? 'background' : 'demand' };
        latestProbe = probe;
        attempts += 1;
        const promise = (async () => {
            const url = await modelUrl(config);
            const base = url.toString().replace(/\/$/, '');
            let authorization = modelCredentials ? await modelCredentials.forOrigin(url.origin) : null;
            let data;
            try {
                const response = await request(base + '/models', { timeout: 15000,
                    authorization, authOrigin: url.origin, onResponse: status => { probe.httpStatus = status; } });
                try { data = JSON.parse(response); }
                catch (_) { throw new Error('The endpoint returned invalid model metadata.'); }
                // An upstream must not reflect a supplied credential into UI metadata.
                if (authorization && (response.includes(authorization) || JSON.stringify(data).includes(JSON.stringify(authorization).slice(1, -1)))) throw new Error('The endpoint returned unsafe model metadata.');
            } finally { authorization = null; }
            const models = [...new Set((data.data || []).map(m => m?.id).filter(id => typeof id === 'string' && id))];
            if (!models.length) throw new Error('This endpoint returned no models.');
            const value = { base, models };
            probe.completedAt = clock.now();
            lastSuccessAt = probe.completedAt;
            cached.set(key, { at: probe.completedAt, value });
            return value;
        })().catch(error => {
            probe.completedAt = clock.now();
            probe.errorCode = error.statusCode === 401 || error.statusCode === 403 ? 'auth_refused' : 'discovery_failed';
            cached.set(key, { at: probe.completedAt, error });
            throw error;
        });
        inFlight.set(key, promise);
        try { return await promise; } finally {
            if (inFlight.get(key) === promise) inFlight.delete(key);
            schedulePolling();
        }
    }
    async function chat(config, messages, onDelta) {
        const { base, models } = await discover(config);
        const model = config.model || models[0];
        if (!models.includes(model)) throw new Error(`Model ${model} is no longer available. Choose a model in Controls.`);
        // One leading system message, whatever the caller stacked. Both the
        // streaming and the single-shot request go out normalized.
        const wireMessages = normalizeSystemMessages(messages);
        // No timeout: this is a model reply, not a metadata probe. With an
        // onDelta callback the reply streams: each content delta is forwarded
        // while the endpoint generates it.
        if (typeof onDelta === 'function') {
            const streamed = await requestStream(base + '/chat/completions',
                { model, messages: wireMessages, stream: true }, onDelta);
            if (typeof streamed !== 'string' || !streamed.trim()) throw new Error('The endpoint returned an empty reply.');
            return streamed;
        }
        const data = JSON.parse(await request(base + '/chat/completions', {
            body: { model, messages: wireMessages, stream: false }
        }));
        const content = data.choices?.[0]?.message?.content;
        if (typeof content !== 'string' || !content.trim()) throw new Error('The endpoint returned an empty reply.');
        return content;
    }
    return { getSettings, saveSettings, discover, chat, modelOrigin, invalidateDiscovery, discoveryStatus,
        startPolling, stopPolling, resumePolling };
}

module.exports = { createEndpointClient, endpointUrl, request, DEFAULT_POINTER, normalizeSystemMessages, MODEL_POLL_INTERVAL_MS };
