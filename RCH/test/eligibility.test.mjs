import test from 'node:test';
import assert from 'node:assert/strict';
import { AccountStore, digest } from '../service/store.mjs';
import { createAccountService } from '../service/server.mjs';
import { accountAccess } from '../service/eligibility.mjs';
import { pgliteStores } from './helpers/pglite-store.mjs';

const pg=pgliteStores({requiredMigration:'_rch_account_eligibility.sql'});
for(const backend of ['sqlite','postgres']) test(`${backend}: transactional key eligibility and refundable RCH source accounting`,async t=>{
  let clock={now:1800000000000},store,update;
  const subscription={basic:{id:'basic-wallet',includedRequests:1500,priceUsdMicros:15000000},overageUsdMicrosPerRequest:10000,proEnabled:false};
  const models=[{id:'request',access:'requests',metered:true,bridge:{kind:'gpu',model:'google/gemma-4-12B-it-qat-q4_0-unquantized'}},{id:'tokens',metered:true},{id:'usd',metered:true,pricing:{inputUsdMicrosPerMillion:1000000,outputUsdMicrosPerMillion:1000000}}];
  if(backend==='sqlite'){
    store=new AccountStore(':memory:',{now:()=>clock.now,models,subscription});t.after(()=>store.close());
    update=async(id,fields)=>{const keys=Object.keys(fields);store.db.prepare(`UPDATE accounts SET ${keys.map(k=>`${k}=?`).join(',')} WHERE id=?`).run(...Object.values(fields),id);};
  }else{
    ({store,clock}=await pg.fresh({models,subscription}));
    update=async(id,fields)=>{const keys=Object.keys(fields);await pg.query(`UPDATE reach_accounts.accounts SET ${keys.map((k,i)=>`${k}=$${i+1}`).join(',')} WHERE id=$${keys.length+1}`,[...Object.values(fields),id]);};
  }
  const a=await store.ensureAccount('0x'+'1'.repeat(40));
  const denied=()=>assert.rejects(async()=>store.createApiKey(a.id,'Denied'),{code:'api_key_ineligible'});
  await denied(); // A verified wallet or its holdings does not grant keys.
  assert.equal(accountAccess(await store.account(a.id)).website,true);
  await update(a.id,{usd_prepaid:50000});await denied(); // Fiat-only credit.
  await update(a.id,{plan_id:'basic',plan_expires:clock.now+1000});
  await store.createApiKey(a.id,'Active subscription');
  clock.now+=1001;await denied();
  const redemption=await store.createRedemption(a.id,'1000000000000000000',100);
  await denied();
  await store.submitRedemption(redemption.redemptionId,redemption.ticket,'0x'+'2'.repeat(64));await denied();
  await store.creditRedemption(redemption.redemptionId,'confirmed-event');
  await store.creditRedemption(redemption.redemptionId,'confirmed-event');
  assert.equal((await store.account(a.id)).redemptionCredit.tokens,100);
  await store.createApiKey(a.id,'Confirmed RCH');
  const hold=await store.reserve(a.id,'token-hold','tokens','fingerprint',100);
  await denied();
  await store.release(hold.id);
  assert.equal((await store.account(a.id)).allowance.prepaidRemaining,100);
  await store.release(hold.id); // Idempotent release cannot duplicate source.
  assert.equal((await store.account(a.id)).redemptionCredit.tokens,100);
  await store.createApiKey(a.id,'Released RCH');
  const tokenPartial=await store.reserve(a.id,'token-partial','tokens','fingerprint',100);
  await store.settle(tokenPartial.id,{promptTokens:25,completionTokens:0,totalTokens:25});
  assert.equal((await store.account(a.id)).redemptionCredit.tokens,75);
  const spent=await store.reserve(a.id,'spent','tokens','fingerprint',50);
  await store.settle(spent.id,{promptTokens:75,completionTokens:0,totalTokens:75});
  await denied();
  await update(a.id,{prepaid:100,usd_prepaid:100000});await denied();
  const amount='1000000000000000000',address='0x'+'3'.repeat(40);
  const market=await store.createMarketRedemption(a.id,amount,{amount,creditUsdMicros:100,creditBudgetUsdMicros:5000000,
    expiresAtMs:(Math.floor(clock.now/1000)+120)*1000,issuedAt:Math.floor(clock.now/1000),deadline:Math.floor(clock.now/1000)+120,chainId:1,
    tokenAddress:address,treasuryAddress:address,redemptionContract:address,source:'test-executable',sourceBlock:12345});
  await denied();
  await store.submitRedemption(market.redemptionId,market.ticket,'0x'+'4'.repeat(64));await denied();
  await store.creditRedemption(market.redemptionId,'market-confirmed');
  await store.creditRedemption(market.redemptionId,'market-confirmed');
  assert.equal((await store.account(a.id)).redemptionCredit.usdMicros,100);
  // Holds preserve source; only unused RCH returns, never a fiat deposit.
  await store.createApiKey(a.id,'USD source');
  const usdHold=await store.reserveUsd(a.id,'usd-hold','usd','fingerprint',{promptTokens:100,completionTokens:0});
  await denied();
  await store.release(usdHold.id);
  assert.equal((await store.account(a.id)).redemptionCredit.usdMicros,100);
  const partial=await store.reserveUsd(a.id,'partial','usd','fingerprint',{promptTokens:200,completionTokens:0});
  const fiatHold=await store.reserveUsd(a.id,'fiat-only-hold','usd','fingerprint',{promptTokens:200,completionTokens:0});
  await store.release(fiatHold.id);
  assert.equal((await store.account(a.id)).redemptionCredit.usdMicros,0);
  await store.markUncertain(partial.id);
  await store.settle(partial.id,{promptTokens:40,completionTokens:0,totalTokens:40});
  await store.settle(partial.id,{promptTokens:40,completionTokens:0,totalTokens:40});
  assert.equal((await store.account(a.id)).redemptionCredit.usdMicros,60);
  const requestHold=await store.reserveRequest(a.id,'request-hold','request','fp');
  await denied();
  await store.releaseRequest(requestHold.id);
  await store.releaseRequest(requestHold.id);
  assert.equal((await store.account(a.id)).redemptionCredit.usdMicros,60);
  const requestRetry=await store.reserveRequest(a.id,'request-hold','request','fp');
  assert.equal(requestRetry.id,requestHold.id);
  await store.settleRequest(requestRetry.id,{contentType:'application/json; charset=utf-8',body:'{}'});
  await denied();
  const exhausted=await store.reserveUsd(a.id,'exhausted','usd','fingerprint',{promptTokens:100,completionTokens:0});
  await store.settle(exhausted.id,{promptTokens:100,completionTokens:0,totalTokens:100});
  await update(a.id,{usd_prepaid:200000});await denied();
});

test('existing email session is restricted dynamically; client purpose cannot bypass',async t=>{
  const now=1800000000000,store=new AccountStore(':memory:',{now:()=>now});
  const a=store.ensureEmailAccount('onboarding@example.com'),token='rch_session_'+'a'.repeat(64);
  store.db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(digest(token),a.id,now+3600000);
  const {server}=createAccountService({config:{origin:'https://reach.example',chainId:1,models:[],redemption:{enabled:false}},store,now:()=>now});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{await new Promise(resolve=>server.close(resolve));store.close();});
  const call=async(path,body)=>{const r=await fetch(`http://127.0.0.1:${server.address().port}${path}`,{method:body?'POST':'GET',headers:{authorization:`Bearer ${token}`,origin:'https://signalreach.com','content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});return {status:r.status,body:await r.json()};};
  const restricted=await call('/v1/account?purpose=desktop');
  assert.equal(restricted.status,200);assert.equal(restricted.body.access.website,false);
  assert.equal(restricted.body.access.onboarding,true);assert.equal(restricted.body.plan,undefined);assert.equal(restricted.body.credit,undefined);
  assert.equal((await call('/v1/account/api-keys',{name:'Bypass',purpose:'desktop'})).status,403);
  assert.equal((await call('/v1/models')).status,403);
  assert.equal((await call('/v1/billing/checkout',{kind:'top_up'})).status,403);
  assert.equal((await call('/v1/account/link-wallet',{})).status,200);
  store.db.prepare("UPDATE accounts SET plan_id='basic',plan_expires=? WHERE id=?").run(now+1,a.id);
  assert.equal((await call('/v1/account')).body.access.website,true);
  const key=await call('/v1/account/api-keys',{name:'Subscriber'});
  assert.equal(key.status,201);
  store.db.prepare('UPDATE accounts SET plan_expires=? WHERE id=?').run(now,a.id);
  assert.equal((await call('/v1/account')).body.access.website,false);
  assert.equal((await call('/v1/account/api-keys',{name:'Expired'})).status,403);
  assert.equal((await call('/v1/account/api-keys/revoke',{id:key.body.id})).status,200);
  assert.throws(()=>store.authenticateApiKey(key.body.key),{code:'api_key_invalid'});
  const other=store.ensureEmailAccount('other@example.com');
  store.db.prepare("UPDATE accounts SET plan_id='basic',plan_expires=? WHERE id=?").run(now+1000,other.id);
  const foreign=store.createApiKey(other.id,'Other account');
  assert.equal((await call('/v1/account/api-keys/revoke',{id:foreign.id})).status,404);
  assert.equal(store.authenticateApiKey(foreign.key).id,other.id);
});
