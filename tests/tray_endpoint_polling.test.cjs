'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createEndpointClient, MODEL_POLL_INTERVAL_MS } = require('../copilot/tray/endpoint');

async function fixture(t, handler) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'reach-polling-'));
    const server = http.createServer(handler);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(async () => {
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
        fs.rmSync(directory, { recursive: true, force: true });
    });
    return { client: createEndpointClient(path.join(directory, 'settings.json')),
        base: `http://127.0.0.1:${server.address().port}` };
}

test('model discovery holds successful metadata for exactly five minutes', async t => {
    let now = 1000000;
    t.mock.method(Date, 'now', () => now);
    assert.equal(MODEL_POLL_INTERVAL_MS, 300000);
    let models = 0;
    let chats = 0;
    const { client, base } = await fixture(t, (req, res) => {
        if (req.url === '/v1/models') {
            models += 1;
            return res.end(JSON.stringify({ data: [{ id: 'demo' }] }));
        }
        chats += 1;
        req.resume();
        req.on('end', () => res.end(JSON.stringify({ choices: [{ message: { content: 'OK' } }] })));
    });
    client.saveSettings({ endpoint: base });
    await client.discover();
    for (const elapsed of [15000, 60000, 299999]) {
        now = 1000000 + elapsed;
        await client.discover();
    }
    assert.equal(models, 1);
    assert.equal(await client.chat(client.getSettings(), [{ role: 'user', content: 'synthetic' }]), 'OK');
    assert.equal(chats, 1);
    assert.equal(models, 1, 'chat uses cached metadata without delaying generation');
    now = 1300000;
    await client.discover();
    assert.equal(models, 2);
});

test('401 failures suppress rapid status, chat and forced retries, then recover', async t => {
    let now = 1000000;
    t.mock.method(Date, 'now', () => now);
    let count = 0;
    let fail = true;
    const { client, base } = await fixture(t, (_req, res) => {
        count += 1;
        if (fail) { res.writeHead(401); return res.end(JSON.stringify({ error: { message: 'synthetic auth refusal' } })); }
        res.end(JSON.stringify({ data: [{ id: 'recovered' }] }));
    });
    client.saveSettings({ endpoint: base });
    await assert.rejects(client.discover(), /HTTP 401/);
    for (const elapsed of [15000, 60000, 299999]) {
        now = 1000000 + elapsed;
        await assert.rejects(client.discover(), /HTTP 401/);
        await assert.rejects(client.discover(client.getSettings(), true), /HTTP 401/);
    }
    await assert.rejects(client.chat(client.getSettings(), [{ role: 'user', content: 'synthetic' }]), /HTTP 401/);
    assert.equal(count, 1);
    fail = false;
    now = 1300000;
    assert.deepEqual((await client.discover()).models, ['recovered']);
    assert.equal(count, 2);
});

test('concurrent discovery and switching between endpoints share one request per URL', async t => {
    let requests = 0;
    const responses = [];
    let notify;
    const bothStarted = new Promise(resolve => { notify = resolve; });
    const { client, base } = await fixture(t, (_req, res) => {
        requests += 1;
        responses.push(res);
        if (requests === 2) notify();
    });
    const a = { ...client.getSettings(), endpoint: base + '/a' };
    const b = { ...a, endpoint: base + '/b' };
    const pending = [client.discover(a), client.discover(b), client.discover(a, true), client.discover(b)];
    await bothStarted;
    assert.equal(requests, 2);
    responses.forEach(res => res.end(JSON.stringify({ data: [{ id: 'demo' }] })));
    await Promise.all(pending);
    await Promise.all([client.discover(a), client.discover(b)]);
    assert.equal(requests, 2);
});

test('model/provider settings edits preserve failure backoff; no-model failures are cached', async t => {
    let now = 1000000;
    t.mock.method(Date, 'now', () => now);
    let count = 0;
    const { client, base } = await fixture(t, (_req, res) => {
        count += 1;
        res.end(JSON.stringify({ data: [] }));
    });
    client.saveSettings({ endpoint: base });
    await assert.rejects(client.discover(), /no models/);
    now += 15000;
    client.saveSettings({ model: 'picked' });
    client.saveSettings({ provider: 'copilot' });
    client.saveSettings({ provider: 'endpoint' });
    await assert.rejects(client.discover(), /no models/);
    assert.equal(count, 1);
    now = 1300000;
    await assert.rejects(client.discover(), /no models/);
    assert.equal(count, 2);
});
