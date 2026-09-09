'use strict';

// The Copilot bridge keeps its own provider, regardless of the tray's current
// MiniChat selection. VS Code uses this OpenAI-compatible surface directly.
function createBridgeHandler(sendCopilot, health) {
    let queue = Promise.resolve();
    return (req, res) => {
        const json = (code, data) => {
            res.writeHead(code, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(data));
        };
        if (req.headers.origin) return json(403, { error: { message: 'Use the local extension host to access this bridge.' } });
        if (req.method === 'GET' && ['/health', '/status'].includes(req.url)) return json(200, health());
        if (req.method === 'GET' && req.url === '/v1/models') {
            return json(200, { object: 'list', data: [{ id: 'copilot-chat', object: 'model', owned_by: 'microsoft-365' }] });
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
                text = messages.length ? messages.filter(m => ['system', 'user', 'assistant'].includes(m.role) && typeof m.content === 'string')
                    .map(m => `${m.role}: ${m.content}`).join('\n\n') : String(body.text || '');
                if (!text.trim()) throw new Error('Message is empty.');
                if (openai && body.model && body.model !== 'copilot-chat') throw new Error('This bridge serves copilot-chat.');
            } catch (error) { return json(400, { error: { message: error.message } }); }
            queue = queue.then(async () => {
                if (res.destroyed) return;
                const start = Date.now();
                let keepalive;
                const stream = openai && body.stream === true;
                const id = 'chatcmpl-reach-' + start;
                const base = { id, created: Math.floor(start / 1000), model: 'copilot-chat' };
                const event = data => { if (!res.destroyed) res.write('data: ' + JSON.stringify(data) + '\n\n'); };
                try {
                    if (stream) {
                        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
                        res.flushHeaders();
                        keepalive = setInterval(() => { if (!res.destroyed) res.write(': waiting for Copilot\n\n'); }, 10000);
                    }
                    const content = await sendCopilot(text);
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
