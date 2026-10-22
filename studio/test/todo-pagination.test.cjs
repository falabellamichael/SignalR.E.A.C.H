'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execute } = require('../agent/extra-apps.cjs');

const GRAPH = 'https://graph.microsoft.com';
const LISTS_PATH = '/v1.0/me/todo/lists';
const LIST_ID = 'fixture daily/list+=';
const TASKS_PATH = `${LISTS_PATH}/${encodeURIComponent(LIST_ID)}/tasks`;
const CONFIG = { enabled: true, accessToken: 'fixture-oauth-access', expiresAt: Date.now() + 3600000 };

function fixture(...pages) {
  const requests = [];
  const options = { fetchImpl: async (url, init) => {
    requests.push(String(url));
    assert.equal(init.method, 'GET');
    assert.equal(init.redirect, 'error');
    assert.ok(pages.length, 'unexpected additional Graph request');
    return new Response(JSON.stringify(pages.shift()), { headers: { 'content-type': 'application/json' } });
  } };
  return { requests, read: args => execute('todo', { ...args, operation: 'read' }, CONFIG, options) };
}

test('todo.read exposes and follows task-list pagination without changing its cursor query', async () => {
  const nextLink = `${GRAPH}${LISTS_PATH}?$skiptoken=fixture%2Btoken%3D%3D&$top=17&custom=a+b%2fc`;
  const first = [{ id: 'fixture-first-list', displayName: 'First list' }];
  const second = [{ id: 'fixture-second-list', displayName: 'Second list' }];
  const { read, requests } = fixture({ value: first, '@odata.nextLink': nextLink }, { value: second });

  assert.deepEqual(await read({ limit: 2 }), { lists: first, hasMore: true, nextLink });
  const firstRequest = new URL(requests[0]);
  assert.equal(firstRequest.pathname, LISTS_PATH);
  assert.equal(firstRequest.searchParams.get('$top'), '2');
  assert.deepEqual(await read({ nextLink, limit: 1 }), { lists: second, hasMore: false, nextLink: null });
  assert.equal(requests[1], nextLink, 'continuation query must remain verbatim; limit applies only to first pages');
});

for (const selector of ['list', 'listId']) {
  test(`todo.read ${selector} exposes and follows selected-list task pagination`, async () => {
    const nextLink = `${GRAPH}${TASKS_PATH}?$skiptoken=fixture%2Fcursor%3D&$top=20`;
    const first = [{ id: 'fixture-first-task', title: 'First task', status: 'notStarted' }];
    const second = [{ id: 'fixture-second-task', title: 'Second task', status: 'notStarted' }];
    const { read, requests } = fixture({ value: first, '@odata.nextLink': nextLink }, { value: second });

    assert.deepEqual(await read({ [selector]: LIST_ID, limit: 20 }), { tasks: first, hasMore: true, nextLink });
    assert.equal(new URL(requests[0]).pathname, TASKS_PATH);
    assert.deepEqual(await read({ [selector]: LIST_ID, nextLink, limit: 1 }), { tasks: second, hasMore: false, nextLink: null });
    assert.equal(requests[1], nextLink);
  });
}

test('todo.read accepts equivalent opaque list IDs encoded per path segment', async () => {
  const nextLink = `${GRAPH}${TASKS_PATH.replace('%2B', '+').replace('%3D', '=')}?$skiptoken=fixture%2btoken%3d`;
  const { read, requests } = fixture({ value: [], '@odata.nextLink': nextLink }, { value: [] });
  assert.deepEqual(await read({ listId: LIST_ID }), { tasks: [], hasMore: true, nextLink });
  assert.deepEqual(await read({ listId: LIST_ID, nextLink }), { tasks: [], hasMore: false, nextLink: null });
  assert.equal(requests[1], nextLink);
});

test('todo.read bounds first-page sizes to 1-20 and uses the existing default', async () => {
  for (const [args, expected] of [[{ limit: -4 }, '1'], [{ limit: 99 }, '20'], [{ limit: 3.9 }, '3'], [{}, '5']]) {
    const { read, requests } = fixture({ value: [] });
    assert.deepEqual(await read(args), { lists: [], hasMore: false, nextLink: null });
    assert.equal(new URL(requests[0]).searchParams.get('$top'), expected);
  }
});

test('todo.read accepts an empty final task page as empty without claiming further pages', async () => {
  const { read } = fixture({ value: [] });
  assert.deepEqual(await read({ list: LIST_ID, listId: LIST_ID }), { tasks: [], hasMore: false, nextLink: null });
});

test('todo.read rejects unsafe or mismatched input continuation URLs before any fetch', async () => {
  const wrongPaths = [
    `${LISTS_PATH}/fixture-other-list/tasks`,
    '/v1.0/me/messages',
    '/beta/me/todo/lists',
    `${LISTS_PATH}/`,
    `${TASKS_PATH}/fixture-task`,
  ];
  const unsafe = [
    `http://graph.microsoft.com${LISTS_PATH}?$skiptoken=x`,
    `https://graph.microsoft.com.evil.invalid${LISTS_PATH}?$skiptoken=x`,
    `https://evil.invalid${LISTS_PATH}?$skiptoken=x`,
    `https://graph.microsoft.com:444${LISTS_PATH}?$skiptoken=x`,
    `https://fixture-user@graph.microsoft.com${LISTS_PATH}?$skiptoken=x`,
    `https://fixture-user:fixture-password@graph.microsoft.com${LISTS_PATH}?$skiptoken=x`,
    `${GRAPH}${LISTS_PATH}?$skiptoken=x#fragment`,
    `${GRAPH}${LISTS_PATH}#`,
    `${LISTS_PATH}?$skiptoken=x`,
    ...wrongPaths.map(path => `${GRAPH}${path}?$skiptoken=x`),
    '', '   ', null, 42, false, {}, [],
  ];
  const { read, requests } = fixture();
  for (const nextLink of unsafe) {
    await assert.rejects(() => read({ nextLink }), undefined, `invalid catalog continuation ${JSON.stringify(nextLink)}`);
  }
  await assert.rejects(() => read({ nextLink: `${GRAPH}${TASKS_PATH}?$skiptoken=x` }), 'task cursor requires its list selector');
  await assert.rejects(() => read({ listId: LIST_ID, nextLink: `${GRAPH}${LISTS_PATH}?$skiptoken=x` }), 'catalog cursor cannot read tasks');
  await assert.rejects(() => read({ listId: LIST_ID, nextLink: `${GRAPH}${LISTS_PATH}/fixture-other-list/tasks?$skiptoken=x` }), 'cursor cannot switch the selected list');
  await assert.rejects(() => read({ listId: LIST_ID, list: 'fixture-other-list', nextLink: `${GRAPH}${TASKS_PATH}?$skiptoken=x` }), 'cursor cannot bypass conflicting selectors');
  assert.equal(requests.length, 0);
});

test('todo.read validates provider continuation URLs instead of exposing unsafe cursors', async () => {
  const invalidCursors = [
    `http://graph.microsoft.com${TASKS_PATH}?$skiptoken=x`,
    `https://evil.invalid${TASKS_PATH}?$skiptoken=x`,
    `https://fixture-user@graph.microsoft.com${TASKS_PATH}?$skiptoken=x`,
    `${GRAPH}${TASKS_PATH}?$skiptoken=x#fragment`,
    `${GRAPH}${LISTS_PATH}/fixture-other-list/tasks?$skiptoken=x`,
    `${GRAPH}${LISTS_PATH}?$skiptoken=x`,
    '/v1.0/me/todo/lists',
    42, {}, [],
  ];
  for (const nextLink of invalidCursors) {
    const { read, requests } = fixture({ value: [{ id: 'fixture-task' }], '@odata.nextLink': nextLink });
    await assert.rejects(() => read({ listId: LIST_ID }), undefined, `invalid provider continuation ${JSON.stringify(nextLink)}`);
    assert.equal(requests.length, 1, 'invalid provider cursor must not trigger another request');
  }
});

test('todo.read rejects missing or nonarray Microsoft collections instead of reporting an empty list', async () => {
  for (const page of [{}, { value: null }, { value: {} }, { value: 'unexpected' }, { value: 42 }]) {
    for (const args of [{}, { listId: LIST_ID }]) {
      const { read, requests } = fixture(page);
      await assert.rejects(() => read(args));
      assert.equal(requests.length, 1);
    }
  }
});
