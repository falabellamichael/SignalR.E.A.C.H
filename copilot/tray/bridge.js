'use strict';

const { economyBridgeId, economyBridgeIds, economyModels, isEconomyModel } = require('./economy-models');

// Everything this bridge can serve. The bare `codegpt-eco` (and the legacy
// `codegpt-eco-gpt-4o-mini` id) both mean "the open CodeGPT agent page";
// `codegpt-eco-<economy id>` names one specific economy model. The economy half
// is read per call because it is discovered live from the CodeGPT sidecar.
function bridgeModels() {
    return [
        { id: 'copilot-chat', owned_by: 'microsoft-365' },
        { id: 'chatgpt-chat', owned_by: 'openai' },
        { id: 'gemini-chat', owned_by: 'google-gemini-web' },
        ...economyBridgeIds().map((id) => ({ id, owned_by: 'codegpt-eco' })),
        { id: 'codegpt-eco-gpt-4o-mini', owned_by: 'codegpt-eco', legacy: true },
    ];
}

function modelLabel(id) {
    const entry = economyModels().find((model) => economyBridgeId(model.id) === id);
    return entry ? entry.label : '';
}

// The Copilot bridge keeps its own provider, regardless of the tray's current
// MiniChat selection. VS Code uses this OpenAI-compatible surface directly.
function createBridgeHandler(sendCopilot, sendChatgpt, sendCodegpt, health, debugCodegptDom, log, sendGemini) {
    // Requests run one-at-a-time per provider (the pages are single-session).
    // `note` writes diagnostics into the tray log so a request stuck behind a
    // stalled predecessor is visible instead of looking like a dead bridge.
    const note = typeof log === 'function' ? log : () => {};
    const queues = { copilot: Promise.resolve(), chatgpt: Promise.resolve(), codegpt: Promise.resolve(), gemini: Promise.resolve() };
    return (req, res) => {
        const json = (code, data, headers = {}) => {
            res.writeHead(code, { 'Content-Type': 'application/json', ...headers });
            res.end(JSON.stringify(data));
        };
        if (req.headers.origin) return json(403, { error: { message: 'Use the local extension host to access this bridge.' } });
        if (req.method === 'GET' && ['/health', '/status'].includes(req.url)) return json(200, health());
        if (req.method === 'GET' && req.url === '/debug/dom') {
            return Promise.resolve().then(() => debugCodegptDom ? debugCodegptDom() : null)
                .then(dump => json(200, dump || { error: 'codegpt window not available' }))
                .catch(err => json(500, { error: err.message }));
        }
        if (req.method === 'GET' && req.url === '/v1/models') {
            return json(200, { object: 'list', data: bridgeModels().map((model) => ({ ...model, object: 'model' })) });
        }
        const openai = req.url === '/v1/chat/completions';
        if (req.method !== 'POST' || ![ '/', '/send', '/v1/chat/completions' ].includes(req.url)) return json(404, { error: { message: 'Not found' } });
        const chunks = [];
        let size = 0;
        req.on('data', chunk => { size += chunk.length; if (size > 2e6) req.destroy(); else chunks.push(chunk); });
        req.on('end', () => {
            let body;
            let text;
            try {
                body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
                const messages = Array.isArray(body.messages) ? body.messages : [];
                if (messages.some(m => Array.isArray(m.content))) throw new Error('The Copilot bridge accepts text only. Remove image attachments and retry.');
                text = messages.length ? messages.filter(m => ['system', 'developer', 'user', 'assistant', 'tool'].includes(m.role) && typeof m.content === 'string')
                    .map(m => `${m.role}: ${m.content}`).join('\n\n') : String(body.text || '');
                if (!text.trim()) throw new Error('Message is empty.');
                if (openai && body.model && !bridgeModels().some((entry) => entry.id === body.model)) throw new Error('This bridge serves copilot-chat, chatgpt-chat, gemini-chat, and the codegpt-eco models.');
            } catch (error) { return json(400, { error: { message: error.message } }); }
            const model = openai ? String(body.model || 'copilot-chat') : 'copilot-chat';
            const useChatgpt = model === 'chatgpt-chat';
            const useGemini = model === 'gemini-chat';
            const useCodegpt = !useChatgpt && isEconomyModel(model);
            const provider = useCodegpt ? 'codegpt' : useChatgpt ? 'chatgpt' : useGemini ? 'gemini' : 'copilot';
            const controller = new AbortController();
            res.on('close', () => { if (!res.writableEnded) controller.abort(); });
            const queuedAt = Date.now();
            queues[provider] = queues[provider].then(async () => {
                if (res.destroyed) return;
                if (Date.now() - queuedAt > 30000) {
                    note('bridge: ' + provider + ' request waited '
                        + Math.round((Date.now() - queuedAt) / 1000) + 's behind the previous one');
                }
                const start = Date.now();
                let keepalive;
                const stream = openai && body.stream === true;
                const id = 'chatcmpl-reach-' + start;
                const activeModel = provider === 'chatgpt' ? 'chatgpt-chat'
                    : provider === 'gemini' ? 'gemini-chat' : provider === 'codegpt' ? model : 'copilot-chat';
                const base = { id, created: Math.floor(start / 1000), model: activeModel };
                const event = data => { if (!res.destroyed) res.write('data: ' + JSON.stringify(data) + '\n\n'); };
                // Browser pages can expose provisional DOM text. Content stays
                // buffered until the sender returns a verified final answer;
                // reasoning and activity events may still arrive live.
                let streamed = '';
                let roleSent = false;
                const onDelta = (delta) => {
                    if (typeof delta !== 'string' || !delta) return;
                    streamed += delta;
                    event({ ...base, object: 'chat.completion.chunk', choices: [{ index: 0, delta: roleSent ? { content: delta } : { role: 'assistant', content: delta }, finish_reason: null }] });
                    roleSent = true;
                };
                // Reasoning / activity lines (the CodeGPT agent's progress
                // labels and tool events) ride a separate field: text-only
                // clients ignore it, VS Code-style clients render it as
                // thinking while the answer forms.
                const onReasoning = (delta) => {
                    if (typeof delta !== 'string' || !delta) return;
                    event({ ...base, object: 'chat.completion.chunk', choices: [{ index: 0, delta: { reasoning_content: delta }, finish_reason: null }] });
                };
                try {
                    if (stream) {
                        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
                        res.flushHeaders();
                        keepalive = setInterval(() => { if (!res.destroyed) res.write(': waiting for browser provider\n\n'); }, 10000);
                    }
                    const sender = provider === 'codegpt' ? sendCodegpt : provider === 'chatgpt' ? sendChatgpt
                        : provider === 'gemini' ? sendGemini : sendCopilot;
                    if (typeof sender !== 'function') throw new Error('Gemini browser bridge is unavailable in this tray build.');
                    // The requested model rides along so the CodeGPT sender can
                    // pick that economy model out of the signed-in session.
                    // Every browser page can expose provisional DOM text before
                    // the verified answer, including CodeGPT's "Reasoned for" header.
                    // Keep reasoning live, then send only the settled final answer.
                    const content = await sender(text, { signal: controller.signal, model, label: modelLabel(model), onDelta: undefined, onReasoning: stream ? onReasoning : undefined });
                    if (res.destroyed) return;
                    if (typeof content !== 'string' || !content.trim()) throw new Error('The browser provider returned no final answer.');
                    if (!openai) return json(200, { ok: true, content, ms: Date.now() - start });
                    if (!stream) return json(200, { ...base, object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }] });
                    // Whatever the deltas did not carry (a sender without
                    // partials, or a tail that only exists in the final text)
                    // goes out here, so the accumulated stream is the answer.
                    //
                    // The live text and the final text do NOT always prefix-
                    // match: the page renders markdown away (backticks), shows
                    // a "Reasoned for …" thinking header, and multi-message
                    // runs switch which block the DOM exposes mid-answer. When
                    // that happens the old code silently dropped everything
                    // after the first chunk — the client saw a one-line
                    // preamble and the stream just stopped (2026-09-21:
                    // "the bridge just stops working"). Never lose the answer:
                    // if the streamed text already ends with the finished
                    // answer, leave it; otherwise append the missing part
                    // (whole answer when nothing overlaps).
                    if (content) {
                        if (content.startsWith(streamed)) {
                            const rest = content.slice(streamed.length);
                            if (rest) onDelta(rest);
                        } else {
                            const norm = (value) => String(value)
                                .replace(/[`*_~#>\[\]()]/g, '').replace(/\s+/g, ' ').trim();
                            const out = norm(streamed);
                            const fin = norm(content);
                            const tail = Math.min(60, fin.length);
                            const alreadyThere = fin && out.endsWith(fin.slice(fin.length - tail));
                            if (!alreadyThere) {
                                let overlap = 0;
                                const cap = Math.min(streamed.length, content.length, 2000);
                                for (let i = cap; i > 0; i -= 1) {
                                    if (content.startsWith(streamed.slice(streamed.length - i))) {
                                        overlap = i;
                                        break;
                                    }
                                }
                                const rest = content.slice(overlap);
                                note('bridge: final answer did not extend the live stream — appended from '
                                    + overlap + '/' + content.length + ' chars');
                                if (rest) onDelta(rest);
                            }
                        }
                    }
                    event({ ...base, object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
                    res.end('data: [DONE]\n\n');
                } catch (error) {
                    if (res.destroyed) return;
                    const providerError = provider === 'codegpt' && error?.provider === 'codegpt';
                    const detail = providerError ? {
                        code: error.code,
                        status: error.status,
                        provider: 'codegpt',
                        message: error.message,
                        retryable: error.retryable,
                        ...(error.retryAfterSeconds ? { retryAfterSeconds: error.retryAfterSeconds } : {}),
                    } : { message: error?.message || 'Provider request failed.' };
                    if (stream) { event({ error: detail }); res.end('data: [DONE]\n\n'); }
                    else {
                        const status = providerError && error.status === 429 ? 429 : 502;
                        const headers = status === 429 && detail.retryAfterSeconds
                            ? { 'Retry-After': String(detail.retryAfterSeconds) } : {};
                        json(status, { ok: false, error: openai ? detail : detail.message }, headers);
                    }
                } finally { clearInterval(keepalive); }
            }).catch((error) => {
                note('bridge: ' + provider + ' request aborted: ' + ((error && error.message) || error));
            });
        });
    };
}

module.exports = { createBridgeHandler };
