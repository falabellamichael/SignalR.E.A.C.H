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
function createBridgeHandler(sendCopilot, sendChatgpt, sendCodegpt, health, debugCodegptDom) {
    const queues = { copilot: Promise.resolve(), chatgpt: Promise.resolve(), codegpt: Promise.resolve() };
    return (req, res) => {
        const json = (code, data) => {
            res.writeHead(code, { 'Content-Type': 'application/json' });
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
                if (openai && body.model && !bridgeModels().some((entry) => entry.id === body.model)) throw new Error('This bridge serves copilot-chat, chatgpt-chat, and the codegpt-eco models.');
            } catch (error) { return json(400, { error: { message: error.message } }); }
            const model = openai ? String(body.model || 'copilot-chat') : 'copilot-chat';
            const useChatgpt = model === 'chatgpt-chat';
            const useCodegpt = !useChatgpt && isEconomyModel(model);
            const provider = useCodegpt ? 'codegpt' : useChatgpt ? 'chatgpt' : 'copilot';
            const controller = new AbortController();
            res.on('close', () => { if (!res.writableEnded) controller.abort(); });
            queues[provider] = queues[provider].then(async () => {
                if (res.destroyed) return;
                const start = Date.now();
                let keepalive;
                const stream = openai && body.stream === true;
                const id = 'chatcmpl-reach-' + start;
                const activeModel = provider === 'chatgpt' ? 'chatgpt-chat' : provider === 'codegpt' ? model : 'copilot-chat';
                const base = { id, created: Math.floor(start / 1000), model: activeModel };
                const event = data => { if (!res.destroyed) res.write('data: ' + JSON.stringify(data) + '\n\n'); };
                try {
                    if (stream) {
                        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
                        res.flushHeaders();
                        keepalive = setInterval(() => { if (!res.destroyed) res.write(': waiting for browser provider\n\n'); }, 10000);
                    }
                    const sender = provider === 'codegpt' ? sendCodegpt : provider === 'chatgpt' ? sendChatgpt : sendCopilot;
                    // The requested model rides along so the CodeGPT sender can
                    // pick that economy model out of the signed-in session.
                    const content = await sender(text, { signal: controller.signal, model, label: modelLabel(model) });
                    if (res.destroyed) return;
                    if (!openai) return json(200, { ok: true, content, ms: Date.now() - start });
                    if (!stream) return json(200, { ...base, object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }] });
                    event({ ...base, object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason: null }] });
                    event({ ...base, object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
                    res.end('data: [DONE]\n\n');
                } catch (error) {
                    if (res.destroyed) return;
                    if (stream) { event({ error: { message: error.message } }); res.end('data: [DONE]\n\n'); }
                    else json(502, { ok: false, error: openai ? { message: error.message } : error.message });
                } finally { clearInterval(keepalive); }
            }).catch(() => {});
        });
    };
}

module.exports = { createBridgeHandler };
