'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { OPERATIONS, params, buildTools } = require('../agent/connection-operations.cjs');
const { TOOLS } = require('../agent/tool-registry.cjs');
const { companionSettings } = require('../agent/companion-chat.cjs');

test('every expanded operation is registered, schema-backed, and writes require approval', async () => {
  const calls = [];
  const tools = buildTools(async (...args) => { calls.push(args); return { id: 'result' }; });
  for (const [name, [method, route, fields]] of Object.entries(OPERATIONS)) {
    assert.ok(TOOLS[name], name);
    assert.deepEqual(TOOLS[name].params, params(name), name);
    assert.equal(TOOLS[name].approval, method !== 'GET' && name !== 'notion.query', name);
    const args = Object.fromEntries([...route.matchAll(/\{(\w+)\}/g)].map(m => [m[1], 'id with spaces']));
    if (fields.length) args.body = { [fields[0]]: 'fixture-value' };
    const result = await tools[name].execute(args, { getPlugins: () => ({}) });
    assert.equal(result.ok, true);
    assert.equal(calls.at(-1)[3].method, method);
    assert.ok(!calls.at(-1)[2].includes(' '));
  }
});

test('expanded operations reject invalid selectors and unsupported bodies before dispatch', async () => {
  let count = 0;
  const tools = buildTools(async () => { count++; });
  await assert.rejects(tools['todo.delete'].execute({list:'..',id:'task'}, {}), /valid list/);
  await assert.rejects(tools['slack.send'].execute({body:{url:'https://evil.test'}}, {}), /Unsupported body/);
  await assert.rejects(tools['drive.list'].execute({query:{url:'https://evil.test'}}, {}), /Unsupported query/);
  assert.equal(count, 0);
});

test('companion discovers implemented connected tools instead of an incomplete hardcoded list', () => {
  const plugins = Object.fromEntries(['weather','gmail','outlook','github','calendar','drive','slack','notion','discord','todo'].map(id => [id,{enabled:true}]));
  const settings = companionSettings({}, plugins);
  for (const name of ['github.create_pr','github.workflows','todo.delete','calendar.create','drive.copy','slack.send','notion.query','gmail.labels','outlook.folders']) {
    assert.ok(TOOLS[name], name);
    assert.ok(!settings.disabledTools.includes(name), name);
  }
  assert.ok(companionSettings({disabledTools:['slack.send']},plugins).disabledTools.includes('slack.send'));
  plugins.slack.enabled = false;
  assert.ok(companionSettings({},plugins).disabledTools.includes('slack.send'));
});

test('HTTP 204 task deletion is a success rather than a JSON parsing failure', async () => {
  const { request } = require('../agent/extra-apps.cjs');
  const result = await request('todo',{enabled:true,token:'fixture'},'me/todo/lists/list/tasks/task',{
    method:'DELETE',fetchImpl:async (url, options) => {
      assert.equal(url.origin,'https://graph.microsoft.com');
      assert.equal(options.redirect,'error');
      return {ok:true,status:204,text:async()=>''};
    }
  });
  assert.deepEqual(result,{completed:true});
});

test('on-demand help exposes complete app operation parameters without enabling disabled tools', async () => {
  const result = await TOOLS.tool_help.execute({topic:'calendar.create'}, {});
  assert.equal(result.tool.approval, true);
  assert.match(result.tool.help, /summary, description, start, end/);
  assert.ok(result.tool.params.some(field => field.name === 'body' && field.required));
  const hidden = await TOOLS.tool_help.execute({topic:'calendar.create'}, {
    agentId:'a', agentStore:{get:()=>({settings:{disabledTools:['calendar.create']}})},
  });
  assert.equal(hidden.tool, undefined);
});

test('Discord sends suppress mentions and hosted connections cannot invoke bot-token tools', async () => {
  let captured;
  const tool = buildTools(async (_id,_config,_route,options) => {captured=options;return {id:'result'};})['discord.send'];
  await tool.execute({channel:'channel-id',body:{content:'@everyone hello'}},{getPlugins:()=>({discord:{token:'fixture'}})});
  assert.deepEqual(captured.body.allowed_mentions,{parse:[],replied_user:false});
  const settings = companionSettings({}, {discord:{enabled:true,accessToken:'fixture'}});
  assert.ok(settings.disabledTools.includes('discord.send'));
  assert.ok(!settings.disabledTools.includes('discord.read'));
});
