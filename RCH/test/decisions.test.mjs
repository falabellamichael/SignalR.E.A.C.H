import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createModelGateway } from '../service/model-gateway.mjs';

test('D1 decisions use standard allowance, authorization and native GPU route', async t => {
  const model = { id: 'd1-3b', provider: 'LiquidAI', metered: true, access: 'requests', bridge: {kind:'gpu', model:'LiquidAI/d1-3B'} };
  let dispatched = 0, settled = 0, released = 0;
  const store = {
    reserveRequest: async () => ({ id: 'r', fresh: true }),
    settleRequest: async () => { settled++; }, releaseRequest: async () => { released++; }, markRequestUncertain: async () => {},
  };
  const gateway = createModelGateway({ store, models: [model], subscription: { basic: { includedRequests: 10 }, overageUsdMicrosPerRequest: 0 },
    fetchImpl: async (url, options) => {
      dispatched++;
      assert.equal(url, 'http://127.0.0.1:18030/v1/decisions');
      assert.equal(JSON.parse(options.body).model, 'LiquidAI/d1-3B');
      if (process.env.REACH_TEST_LIVE_D1 === '1') return fetch(url, options);
      return new Response(JSON.stringify({ answers: { yes: {type:'noul', noul:0.95} }, usage:{input_tokens:30, output_tokens:0} }), {headers:{'content-type':'application/json'}});
    } });
  const server = createServer((req,res) => gateway.handle(req,res,{id:'user',allowedModels:req.headers['x-denied'] ? [] : [model]}));
  server.listen(0,'127.0.0.1'); await once(server,'listening');
  t.after(() => {server.closeAllConnections(); server.close();});
  const base = `http://127.0.0.1:${server.address().port}`;
  const body = {model:'d1-3b',state:'Paris is in France',questions:{yes:{type:'noul',instructions:'About France?'}}};
  const call = extra => fetch(base+'/v1/decisions',{method:'POST',headers:{'content-type':'application/json',...extra},body:JSON.stringify(body)});
  assert.equal((await call()).status,200);
  assert.equal(settled,1);
  assert.equal((await call({'x-denied':'1'})).status,403);
  assert.equal(dispatched,1);
  assert.equal(released,1);
  const catalog = await (await fetch(base+'/v1/models')).json();
  assert.equal(catalog.data[0].capabilities.decisions,true);
});
