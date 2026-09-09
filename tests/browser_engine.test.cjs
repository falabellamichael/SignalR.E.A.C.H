'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { publicIp, parseUrl, dimension, inputEvent } = require('../server/browser-engine/main.cjs');

test('browser engine blocks local, reserved, mapped and transition IP addresses', () => {
  for (const address of ['0.0.0.0', '10.20.30.40', '127.0.0.1', '100.64.0.1',
    '169.254.169.254', '172.16.0.1', '192.168.1.1', '192.0.2.1', '198.19.1.1',
    '198.51.100.1', '203.0.113.1', '224.0.0.1', '255.255.255.255', '::', '::1',
    'fc00::1', 'fe80::1', 'ff02::1', '::ffff:127.0.0.1', '64:ff9b::7f00:1',
    '2002:7f00:1::', '2001:0:1::1', '2001:db8::1', '3fff::1', 'bad']) {
    assert.equal(publicIp(address), false, address);
  }
  for (const address of ['8.8.8.8', '1.1.1.1', '142.250.1.1', '2606:4700:4700::1111',
    '2001:4860:4860::8888', '2a00:1450:4001:800::200e']) assert.equal(publicIp(address), true, address);
});

test('browser engine normalizes URLs before checking local destinations', () => {
  for (const url of ['file:///C:/secret', 'javascript:alert(1)', 'data:text/html,hi',
    'http://test.localhost/', 'http://box.local/',
    'http://[::ffff:7f00:1]/', 'http://user:password@example.com/', 'http://example.com/\n',
    'https://example.com\\@localhost', 'ws://example.com/']) assert.throws(() => parseUrl(url), url);
  assert.equal(parseUrl('https://example.com/a?q=hello+world#part').url, 'https://example.com/a?q=hello+world#part');
  assert.equal(parseUrl('wss://example.com/live', true).host, 'example.com');
  // Loopback hosts are allowed (local dev servers are a first-class use case).
  assert.equal(parseUrl('http://localhost/').url, 'http://localhost/');
  assert.equal(parseUrl('http://localhost:18111/comfy/').url, 'http://localhost:18111/comfy/');
  assert.equal(parseUrl('http://127.0.0.1:18111/x').host, '127.0.0.1');
  assert.equal(parseUrl('http://[::1]/').host, '::1');
});

test('browser engine validates input, strips unused fields and contains coordinates', () => {
  assert.deepEqual(inputEvent({ type: 'mouseDown', x: -10, y: 900, button: 'left',
    clickCount: 1, executable: 'ignored', modifiers: ['control'] }, 800, 600),
  { type: 'mouseDown', modifiers: ['control'], x: 0, y: 599, button: 'left', clickCount: 1 });
  assert.deepEqual(inputEvent({ type: 'keyDown', keyCode: 'Enter' }, 800, 600), { type: 'keyDown', keyCode: 'Enter' });
  assert.equal(inputEvent({ type: 'mouseWheel', x: 2, y: 2, deltaY: -120 }, 800, 600).deltaY, -120);
  for (const event of [{ type: 'executeJavaScript' }, { type: 'mouseDown', x: NaN, y: 1 },
    { type: 'mouseDown', x: 1, y: 1, button: 'other' },
    { type: 'mouseWheel', x: 1, y: 1, deltaY: Infinity },
    { type: 'keyDown', keyCode: 'Enter', modifiers: ['invalid'] },
    { type: 'keyDown', keyCode: '' }]) assert.throws(() => inputEvent(event, 800, 600));
});

test('browser engine bounds viewport allocation', () => {
  assert.equal(dimension(undefined, 800, 2400), 800);
  assert.equal(dimension(2400, 800, 2400), 2400);
  for (const value of [0, 99, 2401, NaN, 100.1, '800']) assert.throws(() => dimension(value, 800, 2400));
});
