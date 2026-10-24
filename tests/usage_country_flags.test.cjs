'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function fixture(fetchImpl = async () => ({ ok: true, json: async () => ({ country: 'IT' }) })) {
  const source = fs.readFileSync(path.join(__dirname, '../src/pages-usage.js'), 'utf8');
  const marker = '    /* ----------------------------------------------------------------- USAGE */';
  assert.ok(source.includes(marker));
  const requests = [];
  const node = (tag, cls, text = '') => ({ tag, className: cls, textContent: text,
    children: [], attributes: {}, handlers: {}, isConnected: true,
    setAttribute(key, value) { this.attributes[key] = value; },
    addEventListener(name, handler) { this.handlers[name] = handler; },
    appendChild(child) { this.children.push(child); },
  });
  const window = { __reachCore: { el: node }, __reachPageWidgets: {}, __reachPageRegistry: {} };
  vm.runInNewContext(source.replace(marker,
    'window.countryTest = { publicClientIp, clientCountry, countryFlag };\n' + marker), {
    window, console, URL, Intl, AbortController, setTimeout, clearTimeout,
    document: { createElement: tag => node(tag) },
    fetch: async (url, options) => { requests.push({ url, options }); return fetchImpl(url, options); },
  });
  return { ...window.countryTest, requests };
}

test('local, private, invalid, reserved and mapped private addresses never leave the machine', () => {
  const f = fixture();
  for (const ip of ['localhost', '127.0.0.1', '10.0.0.1', '172.16.1.1', '172.31.255.255',
    '192.168.1.1', '169.254.10.1', '100.64.0.1', '0.0.0.0', '224.0.0.1', '255.255.255.255',
    '192.0.2.10', '198.51.100.1', '203.0.113.4', '198.18.0.1', '999.1.1.1',
    '::', '::1', 'fc00::1', 'fe80::1', '2001:db8::1', '::ffff:192.168.1.1', '::ffff:c0a8:101',
    'example.com', '8.8.8.8/../../private', '<img src=x onerror=alert(1)>']) {
    assert.equal(f.countryFlag(ip), null, ip);
  }
  assert.equal(f.requests.length, 0);
  assert.equal(f.publicClientIp('195.231.96.123'), '195.231.96.123');
  assert.equal(f.publicClientIp('::ffff:8.8.8.8'), '8.8.8.8');
  assert.equal(f.publicClientIp('2001:4860:4860::8888'), '2001:4860:4860::8888');
});

test('polling and new tiles share a single credential-free country lookup', async () => {
  const f = fixture();
  const first = f.countryFlag('195.231.96.123');
  const second = f.countryFlag('195.231.96.123');
  await f.clientCountry('195.231.96.123');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].url, 'https://api.country.is/195.231.96.123');
  assert.equal(f.requests[0].options.credentials, 'omit');
  assert.equal(f.requests[0].options.referrerPolicy, 'no-referrer');
  assert.equal(f.requests[0].options.headers, undefined);
  for (const badge of [first, second]) {
    assert.equal(badge.children[0].src, 'https://flagcdn.com/40x30/it.png');
    assert.equal(badge.children[0].alt, 'Italy flag');
    assert.match(badge.title, /Italy \(IT\).*Approximate/);
  }
});

test('lookup failures and invalid country data are cached and keep a neutral badge', async () => {
  for (const fetchImpl of [async () => { throw new Error('Offline'); },
    async () => ({ ok: false }), async () => ({ ok: true, json: async () => ({ country: '../bad' }) })]) {
    const f = fixture(fetchImpl);
    const badge = f.countryFlag('8.8.8.8');
    assert.equal(await f.clientCountry('8.8.8.8'), '');
    f.countryFlag('8.8.8.8');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.requests.length, 1);
    assert.equal(badge.textContent, '🌐');
    assert.equal(badge.title, 'IP country unavailable');
    assert.equal(badge.children.length, 0);
  }
});

test('lookups are bounded and a detached tile is not updated', async () => {
  let active = 0, peak = 0;
  const releases = [];
  const f = fixture(async () => {
    active++; peak = Math.max(peak, active);
    await new Promise(resolve => releases.push(resolve)); active--;
    return { ok: true, json: async () => ({ country: 'US' }) };
  });
  const detached = f.countryFlag('8.8.8.8'); detached.isConnected = false;
  const work = ['1.1.1.1', '9.9.9.9', '8.8.4.4', '1.0.0.1'].map(ip => f.clientCountry(ip));
  assert.equal(f.requests.length, 3);
  while (releases.length) { releases.shift()(); await new Promise(resolve => setImmediate(resolve)); }
  await Promise.all(work);
  assert.equal(peak, 3); assert.equal(detached.children.length, 0);
});

test('a failed image uses a neutral globe without changing the known country', async () => {
  const f = fixture(); const badge = f.countryFlag('195.231.96.123');
  await f.clientCountry('195.231.96.123');
  badge.children[0].handlers.error();
  assert.equal(badge.textContent, '🌐'); assert.match(badge.title, /Italy/);
});
