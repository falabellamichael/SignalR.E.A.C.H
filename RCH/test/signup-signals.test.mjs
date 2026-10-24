import { test } from 'node:test';
import assert from 'node:assert/strict';
import { signupSignals } from '../service/signup-signals.mjs';

test('remote clients cannot spoof signup IP using forwarded headers', () => {
  const result=signupSignals({socket:{remoteAddress:'203.0.113.9'},headers:{'x-reach-client-ip':'198.51.100.8','x-forwarded-for':'1.2.3.4'}},'a'.repeat(32));
  assert.equal(result.ip,'203.0.113.9');
  assert.equal(result.deviceId,'a'.repeat(32));
});
test('local relay supplies validated observed IP; malformed headers and device IDs are ignored', () => {
  assert.equal(signupSignals({socket:{remoteAddress:'127.0.0.1'},headers:{'x-reach-client-ip':'::ffff:198.51.100.8'}}).ip,'198.51.100.8');
  assert.deepEqual(signupSignals({socket:{remoteAddress:'::1'},headers:{'x-reach-client-ip':'bad'}},'hardware-fingerprint'),{ip:'::1',deviceId:null});
});
