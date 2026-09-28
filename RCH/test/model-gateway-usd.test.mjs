import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { AccountStore } from '../service/store.mjs';
import { createModelGateway } from '../service/model-gateway.mjs';

for (const exhaustCredit of [false,true]) test(`a treasury-funded account pays once and replays ${exhaustCredit?'after exhausting its credit':'with credit remaining'}`,async t=>{
  const now=1_800_000_000_000,wallet='0x'+'11'.repeat(20);
  const model={id:'rch-gpt-4o-mini',provider:'openai',metered:true,maxInputTokens:100,maxInputBytes:8000,maxOutputTokens:20,
    pricing:{inputUsdMicrosPerMillion:150000,outputUsdMicrosPerMillion:600000,cachedInputUsdMicrosPerMillion:75000}};
  const store=new AccountStore(':memory:',{models:[model],now:()=>now});t.after(()=>store.close());
  const account=store.ensureAccount(wallet);
  const initialCredit=exhaustCredit?27:199813,charge=exhaustCredit?27:18;
  const quote={amount:'10000000000000000000',creditUsdMicros:initialCredit,creditBudgetUsdMicros:5000000,
    issuedAt:now/1000,deadline:now/1000+300,expiresAtMs:now+300000,chainId:1,source:'test executable quote',
    tokenAddress:'0x'+'22'.repeat(20),treasuryAddress:'0x'+'33'.repeat(20),redemptionContract:'0x'+'44'.repeat(20)};
  const intent=store.createMarketRedemption(account.id,quote.amount,quote);
  store.submitRedemption(intent.redemptionId,intent.ticket,'0x'+'55'.repeat(32));
  store.creditRedemption(intent.redemptionId,'1:test-event:0');
  let calls=0;
  const gateway=createModelGateway({store,models:[model],upstreamUrl:'http://127.0.0.1:20777/v1',upstreamKey:'private-test-upstream-key',fetchImpl:async()=>{
    calls++;
    return new Response(JSON.stringify({id:'test-completion',object:'chat.completion',
      choices:[{index:0,message:{role:'assistant',content:'OK'},finish_reason:'stop'}],usage_source:'provider',
      usage:{prompt_tokens:100,completion_tokens:exhaustCredit?20:10,total_tokens:exhaustCredit?120:110,prompt_tokens_details:{cached_tokens:exhaustCredit?0:50}}}),
      {headers:{'content-type':'application/json','x-reach-metering':'provider-v1'}});
  }});
  const server=createServer((req,res)=>gateway.handle(req,res,store.account(account.id)));
  server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
  const call=()=>fetch(`http://127.0.0.1:${server.address().port}/v1/chat/completions`,{method:'POST',
    headers:{'content-type':'application/json','idempotency-key':'same-request'},
    body:JSON.stringify({model:model.id,messages:[{role:'user',content:'Reply OK'}]})});
  assert.equal(store.account(account.id).plan.status,'none');
  const first=await call();assert.equal(first.status,200);assert.equal((await first.json()).choices[0].message.content,'OK');
  assert.equal(store.account(account.id).credit.balanceMicros,initialCredit-charge);
  assert.equal(store.account(account.id).credit.reservedMicros,0);
  assert.equal(store.account(account.id).allowance.prepaidRemaining,0);
  const replay=await call();assert.equal(replay.status,200);assert.equal(replay.headers.get('x-reach-replayed'),'true');
  assert.equal(calls,1);assert.equal(store.account(account.id).credit.balanceMicros,initialCredit-charge);
});
