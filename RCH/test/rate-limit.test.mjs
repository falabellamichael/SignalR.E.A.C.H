import test from 'node:test';
import assert from 'node:assert/strict';
import { AccountStore } from '../service/store.mjs';
import { createAccountService } from '../service/server.mjs';

test('Discord polling cannot exhaust model and account requests; both limits still apply', async t => {
  let now = 1_800_000_000_000;
  const store = new AccountStore(':memory:', { now: () => now });
  const config = { origin: 'https://reach.example', chainId: 1, models: [], redemption: { enabled: false } };
  const { server } = createAccountService({ config, store, now: () => now });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); store.close(); });
  const request = async (path, method = 'GET') => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
      method, headers: { 'content-type': 'application/json', 'x-reach-client-ip': '203.0.113.9' },
      ...(method === 'POST' ? { body: '{}' } : {}),
    });
    return { status: response.status, retryAfter: response.headers.get('retry-after'), body: await response.json() };
  };
  for (let i = 0; i < 180; i++) {
    const poll = await request('/oauth/discord/chat-poll', 'POST');
    assert.equal(poll.status, 401, 'polls still require authentication');
  }
  now += 5000;
  const limited = await request('/oauth/discord/chat-poll', 'POST');
  assert.equal(limited.status, 429);
  assert.equal(limited.body.error.code, 'rate_limit');
  assert.equal(limited.retryAfter, '55');
  assert.equal((await request('/v1/chat/completions', 'POST')).status, 401,
    'model requests reach authentication despite exhausted polls');
  for (let i = 0; i < 179; i++) assert.equal((await request('/v1/account/config')).status, 200);
  assert.equal((await request('/v1/account/config')).status, 429, 'ordinary request limits remain enforced');
  now += 55000;
  assert.equal((await request('/oauth/discord/chat-poll', 'POST')).status, 401, 'poll bucket resets at its deadline');
  assert.equal((await request('/v1/account/config')).status, 429, 'newer ordinary bucket has not reset early');
  now += 5000;
  assert.equal((await request('/v1/account/config')).status, 200);
});
