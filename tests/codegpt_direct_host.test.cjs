const test = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const { once } = require('node:events');
const { createCodegptInference } = require('../copilot/tray/codegpt-inference');
const { createDirectHost, directRequest } = require('../copilot/tray/codegpt-direct-host.cjs');

test('agentless inference refuses included-agent routing before any agent lookup or dispatch', async () => {
    const sent = [];
    const infer = createCodegptInference({ allowAgents: false, request: async (url, _body, _headers, _signal, method) => {
        sent.push({ url, method });
        let value;
        if (url.endsWith('/api/session')) value = JSON.stringify({ accessToken: 'fixture-token' });
        else if (url.endsWith('/version')) value = '3.1.0';
        else if (url.endsWith('/me')) value = JSON.stringify({ metering: 'interactions' });
        else assert.fail('An agent endpoint must never be reached.');
        return Object.assign(Readable.from([Buffer.from(value)]), { statusCode: 200 });
    } });
    await assert.rejects(infer({ driverPort: 5000, model: 'fixture', provider: 'openai', includedInteractions: true,
        messages: [{ role: 'user', content: 'Hello' }] }), { code: 'CODEGPT_AGENT_ROUTE_DISABLED' });
    assert.equal(sent.length, 3);
    assert.ok(sent.every(item => item.method === 'GET' && !/agent/.test(item.url)));
    assert.throws(() => directRequest('https://api.codegpt.co/api/v1/chat/tools', { agentId: 'test' }, {}), /agent dispatch/);
    assert.throws(() => directRequest('https://api.codegpt.co/api/v1/chat/tools/codegpt', { agentId: 'test' }, {}), /agent dispatch/);
});

test('direct host rejects browser origins and unknown selectors and returns only the requested model', async t => {
    const sent = [];
    const server = createDirectHost({ models: [{ id: 'fixture-model', name: 'Fixture', enabled: true, provider: 'openai', aliases: [] }],
        driverPort: async () => 5000, inferImpl: async options => { sent.push(options); return '4'; } });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
    const base = 'http://127.0.0.1:' + server.address().port;
    const call = (model = 'fixture-model', extra = {}, headers = {}) => fetch(base + '/v1/chat/completions', {
        method: 'POST', headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify({ model, messages: [{ role: 'user', content: '2 + 2?' }], ...extra }),
    });
    assert.equal((await call('unknown')).status, 404);
    assert.equal((await call('fixture-model', {}, { origin: 'https://untrusted.example' })).status, 403);
    assert.equal((await call('fixture-model', { agentId: 'not-allowed' })).status, 400);
    assert.equal(sent.length, 0);
    const value = await (await call()).json();
    assert.equal(value.model, 'fixture-model'); assert.equal(value.choices[0].message.content, '4');
    const stream = await call('fixture-model', { stream: true });
    assert.match(stream.headers.get('content-type'), /text\/event-stream/); assert.match(await stream.text(), /\[DONE\]/);
    assert.ok(sent.every(item => item.includedInteractions === false && !Object.hasOwn(item, 'agentId')));
    const large = await call('fixture-model', { messages: Array.from({ length: 150 }, () => ({ role: 'user', content: 'x'.repeat(4000) })) });
    assert.equal(large.status, 200, 'application context must pass the old 32KB/128KB host limits');
    assert.equal(sent.at(-1).messages.length, 150);
    assert.equal(sent.at(-1).messages.reduce((sum, message) => sum + message.content.length, 0), 600000);
    assert.equal((await (await fetch(base + '/health')).json()).agents, false);
});

test('the default unlimited direct request releases capacity when its caller cancels', async t => {
    let started, cancelled;
    const arrival = new Promise(resolve => { started = resolve; });
    const cancellation = new Promise(resolve => { cancelled = resolve; });
    const server = createDirectHost({ models: [{ id: 'fixture', enabled: true }], driverPort: async () => 5000,
        inferImpl: async ({ signal }) => {
            started();
            return new Promise((_resolve, reject) => signal.addEventListener('abort', () => {
                cancelled(); reject(new Error('Cancelled')); }, { once: true }));
        } });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
    const base = 'http://127.0.0.1:' + server.address().port;
    const controller = new AbortController();
    const pending = fetch(base + '/v1/chat/completions', { method: 'POST', signal: controller.signal,
        headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'fixture', messages: [{ role: 'user', content: 'Wait' }] }) });
    await arrival; controller.abort(); await assert.rejects(pending);
    await cancellation; await new Promise(resolve => setImmediate(resolve));
    assert.equal((await (await fetch(base + '/health')).json()).active, 0);
});
