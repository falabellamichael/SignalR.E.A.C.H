'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const https = require('node:https');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createEndpointClient, MODEL_POLL_INTERVAL_MS } = require('../copilot/tray/endpoint');

const settle = async () => { await new Promise(setImmediate); await new Promise(setImmediate); };
function fakeClock() {
    let now = 1000000;
    let serial = 0;
    const timers = new Map();
    const clock = {
        now: () => now,
        setTimeout(callback, delay) { const id = ++serial; timers.set(id, { callback, at: now + delay }); return id; },
        clearTimeout(id) { timers.delete(id); },
        timers,
        jump(milliseconds) { now += milliseconds; },
        async advance(milliseconds = 0) {
            now += milliseconds;
            for (let turns = 0; turns < 20; turns += 1) {
                const next = [...timers].filter(([, timer]) => timer.at <= now).sort((a, b) => a[1].at - b[1].at)[0];
                if (!next) return;
                timers.delete(next[0]);
                next[1].callback();
                await settle();
            }
            assert.fail('timer catch-up burst or spin');
        }
    };
    return clock;
}

function fixture(t, reply = () => ({ status: 200 })) {
    const tempRoot = path.resolve(os.tmpdir());
    const directory = fs.mkdtempSync(path.join(tempRoot, 'reach-background-polling-'));
    const clock = fakeClock();
    const calls = [];
    const held = [];
    t.mock.method(https, 'request', (url, options, onResponse) => {
        const call = { url: String(url), method: options.method, authorization: options.headers.Authorization, at: clock.now() };
        calls.push(call);
        const outcome = reply(calls.length);
        const req = new EventEmitter();
        req.setTimeout = () => req;
        req.destroy = error => { req.emit('error', error); req.emit('close'); };
        req.end = () => {
            const respond = () => {
                const res = new EventEmitter();
                res.statusCode = outcome.status || 200;
                res.headers = {};
                onResponse(res);
                queueMicrotask(() => {
                    res.emit('data', Buffer.from(outcome.body || JSON.stringify({ data: [{ id: 'synthetic-model' }] })));
                    res.emit('end');
                    req.emit('close');
                });
            };
            if (outcome.hold) held.push(respond);
            else queueMicrotask(respond);
        };
        return req;
    });
    const client = createEndpointClient(path.join(directory, 'settings.json'), {
        clock,
        modelCredentials: { async forOrigin(origin) { assert.equal(origin, 'https://relay.example'); return 'synthetic-background-key'; } }
    });
    client.saveSettings({ endpoint: 'https://relay.example' });
    t.after(() => {
        client.stopPolling();
        assert.equal(path.dirname(path.resolve(directory)), tempRoot);
        fs.rmSync(directory, { recursive: true, force: true });
    });
    return { client, clock, calls, held };
}

test('background discovery repeats every 300 seconds without UI, status or chat calls', async t => {
    const { client, clock, calls } = fixture(t);
    assert.equal(MODEL_POLL_INTERVAL_MS, 300000);
    assert.equal(client.startPolling(), true);
    assert.equal(client.startPolling(), false, 'repeated startup cannot create a second poller');
    assert.equal(clock.timers.size, 1);
    await clock.advance();
    assert.equal(calls.length, 1);
    await clock.advance(299999);
    assert.equal(calls.length, 1);
    await clock.advance(1);
    assert.equal(calls.length, 2);
    await clock.advance(300000);
    assert.deepEqual(calls.map(call => call.at), [1000000, 1300000, 1600000]);
    assert.ok(calls.every(call => call.method === 'GET' && call.url === 'https://relay.example/v1/models' && call.authorization === 'Bearer synthetic-background-key'));
    assert.equal(client.discoveryStatus().backgroundPolling.enabled, true);
    assert.equal(client.discoveryStatus().lastTrigger, 'background');
    assert.equal(JSON.stringify(client.discoveryStatus()).includes('synthetic-background-key'), false);
});

test('idle background failures back off for 300 seconds and recover without UI activity', async t => {
    const { client, clock, calls } = fixture(t, number => ({ status: number === 1 ? 401 : 200 }));
    client.startPolling();
    await clock.advance();
    assert.equal(client.discoveryStatus().errorCode, 'auth_refused');
    await clock.advance(299999);
    assert.equal(calls.length, 1);
    await clock.advance(1);
    assert.equal(calls.length, 2);
    assert.equal(client.discoveryStatus().httpStatus, 200);
    assert.equal(client.discoveryStatus().errorCode, '');
});

test('slow polling coalesces UI and wake calls with no overlapping or duplicate requests', async t => {
    const { client, clock, calls, held } = fixture(t, () => ({ hold: true }));
    client.startPolling();
    await clock.advance();
    const uiRequests = [client.discover(), client.discover(client.getSettings(), true)];
    client.resumePolling();
    client.startPolling();
    await clock.advance(900000);
    assert.equal(calls.length, 1);
    assert.equal(clock.timers.size, 0, 'no timer is rearmed while a poll is pending');
    held.shift()();
    await Promise.all(uiRequests);
    await settle();
    assert.equal(clock.timers.size, 1);
    assert.equal(client.discoveryStatus().backgroundPolling.nextDueAt, clock.now() + 300000);
    await clock.advance(299999);
    assert.equal(calls.length, 1);
    await clock.advance(1);
    assert.equal(calls.length, 2);
    held.shift()();
    await settle();
});

test('wake performs one overdue refresh, ignores stale timer callbacks and skips missed intervals', async t => {
    const { client, clock, calls } = fixture(t);
    client.startPolling();
    await clock.advance();
    const staleCallback = [...clock.timers.values()][0].callback;
    clock.jump(3600000);
    client.resumePolling();
    client.resumePolling();
    staleCallback();
    await clock.advance();
    assert.equal(calls.length, 2);
    assert.equal(clock.timers.size, 1);
    await clock.advance(299999);
    assert.equal(calls.length, 2);
    await clock.advance(1);
    assert.equal(calls.length, 3);
});

test('provider changes pause polling and preserve cached failure backoff on return', async t => {
    const { client, clock, calls } = fixture(t, () => ({ status: 401 }));
    client.startPolling();
    await clock.advance();
    client.saveSettings({ provider: 'copilot' });
    assert.equal(clock.timers.size, 0);
    await clock.advance(15000);
    client.saveSettings({ provider: 'endpoint', model: 'chosen-model' });
    await clock.advance(284999);
    assert.equal(calls.length, 1);
    await clock.advance(1);
    assert.equal(calls.length, 2);
});

test('normal discoveries reschedule the single poller from completion rather than firing early', async t => {
    const { client, clock, calls } = fixture(t);
    client.startPolling();
    await clock.advance();
    await clock.advance(15000);
    await client.discover(client.getSettings(), true);
    assert.equal(calls.length, 2);
    assert.equal(clock.timers.size, 1);
    await clock.advance(285000);
    assert.equal(calls.length, 2, 'old timer was replaced after manual metadata refresh');
    await clock.advance(15000);
    assert.equal(calls.length, 3);
});

test('stop prevents rearming after a pending poll completes and invalidation schedules only one refresh', async t => {
    const { client, clock, calls, held } = fixture(t, () => ({ hold: true }));
    client.startPolling();
    await clock.advance();
    client.stopPolling();
    held.shift()();
    await settle();
    assert.equal(clock.timers.size, 0);
    await clock.advance(600000);
    assert.equal(calls.length, 1);
    client.startPolling();
    client.invalidateDiscovery();
    client.invalidateDiscovery();
    assert.equal(clock.timers.size, 1);
    await clock.advance();
    assert.equal(calls.length, 2);
    held.shift()();
    await settle();
});

test('credential cache invalidation waits for the pending background request before one fresh poll', async t => {
    const { client, clock, calls, held } = fixture(t, () => ({ hold: true }));
    client.startPolling();
    await clock.advance();
    client.invalidateDiscovery();
    client.invalidateDiscovery();
    client.resumePolling();
    await clock.advance(10000);
    assert.equal(calls.length, 1);
    held.shift()();
    await settle();
    assert.equal(clock.timers.size, 1);
    await clock.advance();
    assert.equal(calls.length, 2, 'old-generation metadata must not satisfy the refreshed credential generation');
    held.shift()();
    await settle();
    assert.equal(clock.timers.size, 1);
});
