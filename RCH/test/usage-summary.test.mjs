import test from 'node:test';
import assert from 'node:assert/strict';
import { AccountStore, digest } from '../service/store.mjs';
import { recordedTokens, usagePeriod } from '../service/usage-summary.mjs';
import { createAccountService } from '../service/server.mjs';
import { pgliteStores } from './helpers/pglite-store.mjs';

const NOW = 1800000000000, FROM = NOW - 30 * 86400000;
const pg = pgliteStores({ requiredMigration: 'rch_usage_summary.sql' });
const payload = (input, output, cached=0) => ({usage_source:'provider',usage:{prompt_tokens:input,completion_tokens:output,total_tokens:input+output,prompt_tokens_details:{cached_tokens:cached}},choices:[{message:{content:'private answer never in statistics'}}]});
const replay = (input,output,cached=0) => JSON.stringify({contentType:'application/json; charset=utf-8',body:JSON.stringify(payload(input,output,cached))});

async function seed(insert, aid) {
  let n=0; const id=()=> (++n).toString(16).padStart(64,'0');
  const reservation={id:id(),account_id:aid,request_id:'metered',model:'model-a',fingerprint:'fp',amount:1000000,
    held_included:0,held_prepaid:0,held_rch:800000,status:'settled',created:NOW-100,currency:'USD',pricing_json:'{}',
    usage:JSON.stringify({promptTokens:100,completionTokens:50,totalTokens:150,chargedUsdMicros:400000,details:{prompt:{cached_tokens:25}}})};
  await insert('reservations',reservation);
  await insert('reservations',{...reservation,id:id(),request_id:'pending',status:'uncertain',usage:null});
  await insert('reservations',{...reservation,id:id(),request_id:'released',status:'released',usage:null});
  await insert('reservations',{...reservation,id:id(),request_id:'outside',created:FROM-1});
  await insert('request_reservations',{id:id(),account_id:aid,request_id:'request-priced',model:'model-a',fingerprint:'fp',
    included:0,charge_usd_micros:10000,held_rch:6000,status:'settled',created:NOW-100,replay:replay(200,60,50)});
  await insert('plus_requests',{id:id(),account_id:aid,request_id:'plus',model:'model-b',fingerprint:'fp',plan_version:'fixture',status:'settled',created:NOW-100,
    replay:JSON.stringify({contentType:'text/event-stream',body:'data: '+JSON.stringify(payload(300,90))+'\n\ndata: [DONE]\n\n'})});
  await insert('plus_requests',{id:id(),account_id:aid,request_id:'missing',model:'model-b',fingerprint:'fp',plan_version:'fixture',status:'settled',created:NOW-100,
    replay:JSON.stringify({contentType:'application/json; charset=utf-8',body:'{}'})});
  const payment=id();
  await insert('payments',{id:payment,provider:'stripe',event_id:'evt_fixture01',object_id:'in_fixture01',kind:'subscription_period',account_id:aid,
    amount_usd_micros:15000000,currency:'usd',period_end:NOW+86400000,status:'applied',fingerprint:'a'.repeat(64),created:NOW-1000});
  await insert('payment_reversals',{id:id(),provider:'stripe',event_id:'evt_refund01',object_id:'re_fixture01',kind:'refund',payment_id:payment,account_id:aid,
    amount_usd_micros:5000000,applied_usd_micros:5000000,currency:'usd',status:'applied',fingerprint:'b'.repeat(64),created:NOW-500});
  const plus=id();
  await insert('plus_payments',{id:plus,object_id:'in_plusFixture',event_id:'evt_plusFixture',account_id:aid,price_id:'price_fixture',amount_minor:2500,currency:'cad',
    period_end:NOW+86400000,status:'applied',fingerprint:'a'.repeat(64),created:NOW-1000,customer_id:'private-customer',subscription_id:'private-subscription',checkout_id:'private-checkout',session_id:'private-session'});
  await insert('plus_reversals',{id:id(),object_id:'re_plusFixture',kind:'refund',event_id:'evt_plusRefund',payment_id:plus,amount_minor:500,currency:'cad',status:'rejected',reason:'partial_reversal',fingerprint:'a'.repeat(64),created:NOW-500});
  await insert('redemptions',{id:'0x'+id(),account_id:aid,wallet:'0x'+'1'.repeat(40),amount:'10000000000000000000',usage_tokens:0,ticket_hash:'secret-fixture',expires:NOW+1000,status:'credited',created:NOW-100,usd_micros:2000000,quote_json:'{}'});
}
function sqliteInsert(store) { return async (table,row) => store.db.prepare(`INSERT INTO ${table} (${Object.keys(row).join(',')}) VALUES (${Object.keys(row).map(()=>'?').join(',')})`).run(...Object.values(row)); }

test('usage counters require complete measured usage, preserve cached subsets and never estimate from response text',()=>{
  assert.deepEqual(recordedTokens(null,replay(100,30,40)),{input:100,output:30,cached:40});
  assert.equal(recordedTokens(null,JSON.stringify({contentType:'application/json; charset=utf-8',body:JSON.stringify({...payload(1,2),usage_source:'estimated'})})),null);
  assert.equal(recordedTokens(null,'invalid'),null);
  assert.equal(recordedTokens(null,replay(1,2,3)),null);
  assert.equal(recordedTokens(null,JSON.stringify({body:'{"choices":[{"message":{"content":"long answer"}}]}'})),null);
  for(const pair of [[NOW,NOW],[NOW-367*86400000,NOW],[-1,NOW],[NOW-1,NOW+60001]])assert.throws(()=>usagePeriod(...pair,NOW),{code:'invalid_usage_period'});
});

test('SQLite and actual Postgres report identical spending, refunds, token coverage, periods and account isolation',async t=>{
  const sqlite=new AccountStore(':memory:',{now:()=>NOW});t.after(()=>sqlite.close());
  const local=sqlite.ensureEmailAccount('usage@example.test');
  await seed(sqliteInsert(sqlite),local.id);
  const expected=sqlite.usageSummary(local.id,FROM,NOW);
  assert.deepEqual(expected.requests,{completed:4,pending:1,released:1,measured:3});
  assert.deepEqual(expected.tokens,{input:600,output:200,cachedInput:75});
  assert.equal(expected.spending.creditUsdMicros,410000);
  assert.equal(expected.spending.rchUsdMicros,406000);
  assert.deepEqual(expected.spending.subscriptions,[{currency:'CAD',paidMicros:25000000,refundedMicros:5000000,netMicros:20000000},{currency:'USD',paidMicros:15000000,refundedMicros:5000000,netMicros:10000000}]);
  assert.deepEqual(expected.redemptions,{creditUsdMicros:2000000,tokenCredits:0,rchWei:'10000000000000000000'});
  assert.doesNotMatch(JSON.stringify(expected),/private|secret|answer|customer|fingerprint|wallet|account_id/);
  const other=sqlite.ensureEmailAccount('other@example.test');
  assert.equal(sqlite.usageSummary(other.id,FROM,NOW).requests.completed,0);
  const f=await pg.fresh({models:[]}); const remote=await f.store.ensureEmailAccount('usage@example.test');
  await seed(async(table,row)=>pg.query(`INSERT INTO reach_accounts.${table} (${Object.keys(row).join(',')}) VALUES (${Object.keys(row).map((_,i)=>'$'+(i+1)).join(',')})`,Object.values(row)),remote.id);
  assert.deepEqual(await f.store.usageSummary(remote.id,FROM,NOW),expected);
  // Historical incomplete payloads must not be counted differently by storage adapters.
  const stream = JSON.stringify({contentType:'text/event-stream',body:'data: '+JSON.stringify(payload(20,10,5))
    +'\n\ndata: '+JSON.stringify({usage_source:'provider',usage:{prompt_tokens:99}})+'\n\ndata: [DONE]\n'});
  for (const [usage, response] of [[null,stream],['broken',replay(4,3)],
    [JSON.stringify({promptTokens:'4',completionTokens:3,totalTokens:7}),replay(4,3)],
    [null,JSON.stringify({body:JSON.stringify({...payload(4,3),usage:{prompt_tokens:'4',completion_tokens:3,total_tokens:7}})})]]) {
    const actual = await pg.query('SELECT reach_accounts.usage_counters($1,$2) AS counters',[usage,response]);
    assert.deepEqual(actual.rows[0].counters,recordedTokens(usage,response));
  }
  const boundary = {id:'f'.repeat(64),account_id:local.id,request_id:'legacy-boundary',model:'legacy',fingerprint:'fp',amount:100,
    held_included:25,held_prepaid:75,held_rch:0,status:'settled',created:FROM,currency:'tokens',pricing_json:null,
    usage:JSON.stringify({promptTokens:40,completionTokens:20,totalTokens:60})};
  await sqliteInsert(sqlite)('reservations',boundary);
  await pg.query(`INSERT INTO reach_accounts.reservations (${Object.keys(boundary).join(',')}) VALUES (${Object.keys(boundary).map((_,i)=>'$'+(i+1)).join(',')})`,Object.values({...boundary,account_id:remote.id}));
  const changed = sqlite.usageSummary(local.id,FROM,NOW);
  assert.equal(changed.spending.unpricedCreditTokens,35);
  assert.equal(changed.requests.completed,5);
  assert.deepEqual(await f.store.usageSummary(remote.id,FROM,NOW),changed);
  // Start is inclusive; end is exclusive. Refunds beyond the end are excluded.
  assert.equal(sqlite.usageSummary(local.id,FROM,FROM+1).requests.completed,1);
  assert.deepEqual(await f.store.usageSummary(remote.id,FROM,FROM+1),sqlite.usageSummary(local.id,FROM,FROM+1));
  assert.equal(sqlite.usageSummary(local.id,FROM,NOW-500).spending.subscriptions[0].refundedMicros,0);
  assert.deepEqual(await f.store.usageSummary(remote.id,FROM,NOW-500),sqlite.usageSummary(local.id,FROM,NOW-500));
  sqlite.db.prepare('UPDATE plus_reversals SET amount_minor=5000').run();
  await pg.query('UPDATE reach_accounts.plus_reversals SET amount_minor=5000');
  const refunded=sqlite.usageSummary(local.id,FROM,NOW);
  assert.equal(refunded.spending.subscriptions[0].netMicros,0);
  assert.equal(refunded.spending.subscriptions[0].refundedMicros,25000000);
  assert.deepEqual(await f.store.usageSummary(remote.id,FROM,NOW),refunded);
  const stranger=await f.store.ensureEmailAccount('stranger@example.test');
  assert.equal((await f.store.usageSummary(stranger.id,FROM,NOW)).requests.completed,0);
  const rights=await pg.query("SELECT has_function_privilege('anon','public.reach_usage_summary(text,jsonb)','EXECUTE') AS anon,has_function_privilege('authenticated','public.reach_usage_summary(text,jsonb)','EXECUTE') AS authenticated,(SELECT prosecdef FROM pg_proc WHERE oid='public.reach_usage_summary(text,jsonb)'::regprocedure) AS definer");
  assert.deepEqual(rights.rows[0],{anon:false,authenticated:false,definer:false});
});

test('usage HTTP scope is read-only, follows the authenticated account, and never opens account management to API keys',async t=>{
  const store=new AccountStore(':memory:',{now:()=>NOW}); const a=store.ensureEmailAccount('api@example.test');
  store.db.prepare("UPDATE accounts SET plan_id='basic',plan_expires=? WHERE id=?").run(NOW+86400000,a.id);
  const key=store.createApiKey(a.id,'SimpleRAG').key;
  const session='rch_session_'+'a'.repeat(64);store.db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(digest(session),a.id,NOW+3600000);
  const {server}=createAccountService({store,config:{origin:'https://reach.example',chainId:1,models:[],redemption:{enabled:false}},now:()=>NOW});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(async()=>{await new Promise(resolve=>server.close(resolve));store.close();});
  const call=(path,token=key,method='GET')=>fetch(`http://127.0.0.1:${server.address().port}${path}`,{method,headers:{authorization:'Bearer '+token}});
  const response=await call('/v1/usage?accountId=some-other-account');assert.equal(response.status,200);
  assert.equal((await response.json()).requests.completed,0);
  assert.equal((await call('/v1/usage','')).status,401);
  assert.equal((await call('/v1/usage',key,'POST')).status,403);
  assert.equal((await call('/v1/billing/payments')).status,403);
  assert.equal((await call('/v1/account')).status,403);
  assert.equal((await call('/v1/usage?from=-1')).status,400);
  assert.equal((await call('/v1/usage',session)).status,200);
  assert.equal((await call('/api/v1/usage',key)).status,200);
});
