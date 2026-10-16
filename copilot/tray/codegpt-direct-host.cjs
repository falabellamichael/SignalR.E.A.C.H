'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { createCodegptInference, requestHttp } = require('./codegpt-inference');
const { discoverCodegptApiPort } = require('./economy-models');

function directRequest(url, body, headers, signal, method = 'POST') {
    if ((method === 'POST' && url !== 'https://api.codegpt.co/api/v1/chat/tools/codegpt')
        || /\/agents?(?:[/?-]|$)/i.test(url) || body && Object.hasOwn(body, 'agentId')) {
        throw Object.assign(new Error('CodeGPT agent dispatch is disabled.'), { status: 503, code: 'CODEGPT_AGENT_ROUTE_DISABLED' });
    }
    return requestHttp(url, body, headers, signal, method);
}

const infer = createCodegptInference({ request: directRequest, allowAgents: false,
    providerError: (_value, status) => Object.assign(new Error('CodeGPT did not complete the selected direct model request.'),
        { status: status >= 400 ? status : 502, code: 'CODEGPT_DIRECT_REJECTED' }) });

function createDirectHost({ models, inferImpl = infer, driverPort = discoverCodegptApiPort, timeoutMs = 180000 } = {}) {
    const registry = new Map(models.filter(model => model.enabled).map(model => [model.id, model]));
    let active = 0;
    const server = http.createServer(async (req, res) => {
        const json = (status, value) => { if (!res.destroyed && !res.writableEnded) {
            res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(value));
        } };
        if (req.headers.origin) return json(403, { error: { code: 'origin_rejected', message: 'Use the account service.' } });
        if (req.method === 'GET' && req.url === '/health') return json(200, { status: 'ready', service: 'codegpt-direct', agents: false, active, models: [...registry.keys()] });
        if (req.method === 'GET' && req.url === '/v1/models') return json(200, { object: 'list', data: [...registry.values()].map(model => ({ id: model.id, name: model.name, object: 'model', owned_by: 'codegpt' })) });
        if (req.method !== 'POST' || req.url !== '/v1/chat/completions') return json(404, { error: { code: 'not_found' } });
        const controller = new AbortController();
        const cancel = () => { if (!res.writableEnded) controller.abort(); };
        res.once('close', cancel);
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        let counted = false;
        try {
            if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) return json(415, { error: { code: 'content_type' } });
            let size = 0; const chunks = [];
            for await (const chunk of req) { size += chunk.length; if (size > 131072) return json(413, { error: { code: 'request_too_large' } }); chunks.push(chunk); }
            let body; try { body = JSON.parse(Buffer.concat(chunks)); } catch (_) { return json(400, { error: { code: 'invalid_json' } }); }
            const model = registry.get(body?.model);
            if (!model) return json(404, { error: { code: 'model_unavailable' } });
            if (Object.keys(body).some(key => !['model', 'messages', 'stream', 'max_tokens', 'max_completion_tokens'].includes(key))
                || !Array.isArray(body.messages) || body.messages.length < 1 || body.messages.length > 100
                || body.messages.some(message => !message || !['system', 'developer', 'user', 'assistant'].includes(message.role)
                    || typeof message.content !== 'string' || Object.keys(message).some(key => !['role', 'content'].includes(key)))
                || Buffer.byteLength(JSON.stringify(body.messages)) > 32000) return json(400, { error: { code: 'text_only' } });
            if (active >= 1) return json(429, { error: { code: 'capacity' } });
            active++; counted = true;
            const answer = await inferImpl({ driverPort: await driverPort(), model: model.id, provider: model.provider,
                includedInteractions: false, modelAliases: model.aliases, messages: body.messages, signal: controller.signal });
            if (typeof answer !== 'string' || !answer.trim() || Buffer.byteLength(answer) > 512000) throw new Error('Invalid direct completion.');
            const envelope = { id: 'chatcmpl-codegpt-direct-' + randomUUID(), model: model.id, created: Math.floor(Date.now() / 1000) };
            if (body.stream === true) {
                if (!res.destroyed) { res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
                    res.end('data: ' + JSON.stringify({ ...envelope, object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: answer }, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n'); }
            } else json(200, { ...envelope, object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: answer }, finish_reason: 'stop' }] });
        } catch (error) {
            json(controller.signal.aborted ? 408 : 502, { error: { code: controller.signal.aborted ? 'request_cancelled' : error.code === 'CODEGPT_AGENT_ROUTE_DISABLED' ? 'agent_route_disabled' : 'codegpt_unavailable',
                message: 'The selected CodeGPT model did not complete. Check CodeGPT sign-in and model access.' } });
        } finally { clearTimeout(timer); res.off('close', cancel); if (counted) active--; }
    });
    server.requestTimeout = 30000; server.headersTimeout = 15000;
    return server;
}

if (require.main === module) {
    const { models } = JSON.parse(fs.readFileSync(path.join(__dirname, 'codegpt-direct-models.json'), 'utf8'));
    const server = createDirectHost({ models });
    server.on('error', () => { console.error('CodeGPT direct host could not listen.'); process.exitCode = 1; });
    server.listen(21304, '127.0.0.1', () => console.info('CodeGPT direct host ready on loopback:21304; agents disabled.'));
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { server.close(); server.closeIdleConnections(); });
}

module.exports = { createDirectHost, directRequest };
