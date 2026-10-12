'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const https = require('node:https');
const http = require('node:http');
const { EventEmitter } = require('node:events');
const { Readable } = require('node:stream');
const { createModelCredentialStore, credentialOrigin } = require('../copilot/tray/model-credentials');
const { createEndpointClient, request } = require('../copilot/tray/endpoint');

function vault(t, options = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reach-vault-synthetic-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const file = path.join(dir, 'model-key.json');
    const wrappingKey = crypto.randomBytes(32);
    const safeStorage = {
        isEncryptionAvailable: () => true,
        getSelectedStorageBackend: () => 'dpapi',
        encryptString: value => {
            const iv = crypto.randomBytes(12);
            const cipher = crypto.createCipheriv('aes-256-gcm', wrappingKey, iv);
            const ciphertext = Buffer.concat([cipher.update(value), cipher.final()]);
            return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
        },
        decryptString: bytes => {
            const decipher = crypto.createDecipheriv('aes-256-gcm', wrappingKey, bytes.subarray(0, 12));
            decipher.setAuthTag(bytes.subarray(12, 28));
            return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString();
        }, ...options.safeStorage
    };
    const store = createModelCredentialStore({ file, safeStorage, prompt: options.prompt || (async () => 'synthetic-model-key-for-tests') });
    return { store, file, dir, safeStorage };
}
function fakeHttps(t, response, calls) {
    t.mock.method(https, 'request', (url, options, callback) => {
        calls.push({ url: url.toString(), options });
        const req = new EventEmitter();
        req.end = () => queueMicrotask(() => {
            const data = typeof response === 'function' ? response(calls.length) : response;
            const res = Readable.from([Buffer.from(data.body || '')]);
            res.statusCode = data.status || 200;
            res.headers = data.headers || {};
            res.on('end', () => req.emit('close'));
            callback(res);
        });
        req.destroy = error => { req.emit('error', error); req.emit('close'); };
        return req;
    });
}
test('synthetic native entry stores only encrypted payload and returns nonsecret status', async t => {
    const { store, file } = vault(t);
    assert.equal(await store.promptForOrigin('https://relay.example'), true);
    assert.equal(store.forOrigin('https://relay.example'), 'synthetic-model-key-for-tests');
    assert.equal(fs.readFileSync(file, 'utf8').includes('synthetic-model-key-for-tests'), false);
    assert.deepEqual(store.status(), { configured: true, origin: 'https://relay.example', secureStorageAvailable: true, locked: false });
    assert.equal(JSON.stringify(store.status()).includes('encryptedPayload'), false);
});
test('unavailable and basic_text vaults fail closed before asking for a key', async t => {
    for (const override of [{ isEncryptionAvailable: () => false }, { getSelectedStorageBackend: () => 'basic_text' }]) {
        let prompted = false;
        const { store, file } = vault(t, { safeStorage: override, prompt: async () => { prompted = true; return 'synthetic'; } });
        await assert.rejects(store.promptForOrigin('https://relay.example'), /unavailable/);
        assert.equal(prompted, false);
        assert.equal(fs.existsSync(file), false);
    }
});
test('Cancel and encryption failure preserve the existing encrypted credential', async t => {
    let answer = 'synthetic-old-key';
    const { store, file, safeStorage } = vault(t, { prompt: async () => answer });
    await store.promptForOrigin('https://relay.example');
    const before = fs.readFileSync(file);
    answer = null;
    assert.equal(await store.promptForOrigin('https://relay.example'), false);
    assert.deepEqual(fs.readFileSync(file), before);
    answer = 'synthetic-new-key';
    safeStorage.encryptString = () => { throw new Error('synthetic vault failure'); };
    await assert.rejects(store.promptForOrigin('https://relay.example'), /unavailable/);
    assert.deepEqual(fs.readFileSync(file), before);
});
test('origin mismatch, tampered origin and corrupted ciphertext cannot retarget a stored key', async t => {
    const { store, file } = vault(t);
    await store.promptForOrigin('https://relay.example');
    assert.throws(() => store.forOrigin('https://other.example'), /another HTTPS origin/);
    const record = JSON.parse(fs.readFileSync(file));
    record.origin = 'https://other.example';
    fs.writeFileSync(file, JSON.stringify(record));
    assert.throws(() => store.forOrigin('https://other.example'), /could not be unlocked/);
    record.origin = 'https://relay.example';
    record.encryptedPayload = Buffer.from('synthetic-corrupt-ciphertext').toString('base64');
    fs.writeFileSync(file, JSON.stringify(record));
    assert.throws(() => store.forOrigin('https://relay.example'), /could not be unlocked/);
});
test('native enrollment refuses insecure origins, URL credentials and invalid header values', async t => {
    for (const origin of ['http://relay.example', 'https://user:pass@relay.example', 'https://relay.example/path', 'https://relay.example/?key=synthetic']) {
        assert.throws(() => credentialOrigin(origin), /HTTPS origin/);
    }
    const { store, file } = vault(t, { prompt: async () => 'synthetic\nunsafe' });
    await assert.rejects(store.promptForOrigin('https://relay.example'), /valid relay API key/);
    assert.equal(fs.existsSync(file), false);
});
test('pointer fetch is anonymous; only bound HTTPS models receives Authorization', async t => {
    const { store, dir } = vault(t);
    await store.promptForOrigin('https://relay.example');
    let pointerAuthorization = 'not-called';
    const server = http.createServer((req, res) => { pointerAuthorization = req.headers.authorization; res.end('https://relay.example'); });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
    const calls = [];
    fakeHttps(t, { body: JSON.stringify({ data: [{ id: 'demo' }] }) }, calls);
    const client = createEndpointClient(path.join(dir, 'settings.json'), { modelCredentials: store });
    client.saveSettings({ endpoint: `http://127.0.0.1:${server.address().port}/pointer.txt` });
    assert.equal(await client.modelOrigin(), 'https://relay.example');
    assert.equal(calls.length, 0, 'enrollment resolves metadata only');
    const result = await client.discover();
    assert.deepEqual(result.models, ['demo']);
    assert.equal(pointerAuthorization, undefined);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://relay.example/v1/models');
    assert.equal(calls[0].options.headers.Authorization, 'Bearer synthetic-model-key-for-tests');
    assert.equal(JSON.stringify(client.getSettings()).includes('synthetic-model-key-for-tests'), false);
    assert.equal(JSON.stringify(client.discoveryStatus()).includes('synthetic-model-key-for-tests'), false);
});
test('authenticated redirect never sends a second request, even to the same origin', async t => {
    const { store, dir } = vault(t);
    await store.promptForOrigin('https://relay.example');
    const calls = [];
    fakeHttps(t, { status: 302, headers: { location: 'https://relay.example/other' } }, calls);
    const client = createEndpointClient(path.join(dir, 'settings.json'), { modelCredentials: store });
    client.saveSettings({ endpoint: 'https://relay.example' });
    await assert.rejects(client.discover(), /redirects are blocked/);
    await assert.rejects(client.discover(client.getSettings(), true), /redirects are blocked/);
    assert.equal(calls.length, 1);
});
test('transport refuses HTTP, different origin and chat authorization before opening a socket', t => {
    const options = { authorization: 'synthetic', authOrigin: 'https://relay.example' };
    assert.throws(() => request('http://relay.example/v1/models', options), /only authenticate/);
    assert.throws(() => request('https://other.example/v1/models', options), /only authenticate/);
    assert.throws(() => request('https://relay.example/v1/chat/completions', { ...options, body: {} }), /only authenticate/);
});
test('authenticated error bodies and reflected secrets cannot reach discovery errors or metadata', async t => {
    const { store, dir } = vault(t);
    await store.promptForOrigin('https://relay.example');
    const calls = [];
    fakeHttps(t, n => n === 1
        ? { status: 401, body: JSON.stringify({ error: { message: 'synthetic-model-key-for-tests' } }) }
        : { body: JSON.stringify({ data: [{ id: 'synthetic-model-key-for-tests' }] }) }, calls);
    const client = createEndpointClient(path.join(dir, 'settings.json'), { modelCredentials: store });
    client.saveSettings({ endpoint: 'https://relay.example' });
    await assert.rejects(client.discover(), error => error.message === 'Endpoint returned HTTP 401');
    assert.equal(client.discoveryStatus().errorCode, 'auth_refused');
    client.invalidateDiscovery();
    await assert.rejects(client.discover(), /unsafe model metadata/);
    assert.equal(JSON.stringify(client.discoveryStatus()).includes('synthetic-model-key-for-tests'), false);
});
test('confirmed key update clears old 401 backoff without a paid chat request', async t => {
    const { store, dir } = vault(t);
    const calls = [];
    fakeHttps(t, n => n === 1 ? { status: 401 } : { body: JSON.stringify({ data: [{ id: 'demo' }] }) }, calls);
    const client = createEndpointClient(path.join(dir, 'settings.json'), { modelCredentials: store });
    client.saveSettings({ endpoint: 'https://relay.example' });
    await assert.rejects(client.discover(), /HTTP 401/);
    await store.promptForOrigin('https://relay.example');
    client.invalidateDiscovery();
    assert.deepEqual((await client.discover()).models, ['demo']);
    assert.equal(calls.length, 2);
    assert.ok(calls.every(call => call.options.method === 'GET' && call.url.endsWith('/v1/models')));
});
test('JSON-escaped synthetic credentials cannot be reflected into model IDs', async t => {
    const synthetic = 'synthetic-quoted-"-key';
    const { store, dir } = vault(t, { prompt: async () => synthetic });
    await store.promptForOrigin('https://relay.example');
    const calls = [];
    fakeHttps(t, { body: JSON.stringify({ data: [{ id: synthetic }] }) }, calls);
    const client = createEndpointClient(path.join(dir, 'settings.json'), { modelCredentials: store });
    client.saveSettings({ endpoint: 'https://relay.example' });
    await assert.rejects(client.discover(), /unsafe model metadata/);
});
