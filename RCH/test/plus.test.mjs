import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { randomBytes, createHash, createHmac } from 'node:crypto';
import { Wallet } from 'ethers';
import { AccountStore } from '../service/store.mjs';
import { createAccountService, signInMessage } from '../service/server.mjs';
import { validateConfig } from '../service/config.mjs';
import { checkoutParams, verifyStripeSignature } from '../service/payments/stripe.mjs';
import { PLUS_DEFAULTS, assertPlusPrice, plusInvoice } from '../service/payments/plus.mjs';
import { readAccountSnapshot } from '../service/account-import.mjs';
import { checkStripe, STRIPE_EVENTS } from '../service/payments/preflight.mjs';

const example=JSON.parse(readFileSync(new URL('../config/subscription-bridges.example.json',import.meta.url)));
const subscription={...example.subscription,plus:{...PLUS_DEFAULTS}};
const models=[example.models.find(m=>m.metered===true)];
const NOW=1_800_000_000_000,DAY=86400000,PRICE='price_plusFixture01',BASIC='price_basicFixture01';
const KEY='rk_test_'+'x'.repeat(32),SECRET='whsec_'+'y'.repeat(32);
export const goodPrice={id:PRICE,active:true,livemode:false,type:'recurring',currency:'cad',unit_amount:2500,
  tax_behavior:'inclusive',billing_scheme:'per_unit',recurring:{interval:'month',interval_count:1,usage_type:'licensed'}};
const CHECKOUT='a'.repeat(64);
const invoice=(accountId,over={})=>({customer:'cus_plusFixture01',id:'in_plus0001',status:'paid',paid:true,amount_paid:2500,total:2500,total_excluding_tax:2212,currency:'cad',
  parent:{subscription_details:{subscription:'sub_plusFixture01',metadata:{reach_account_id:accountId,reach_kind:'subscription_period',reach_plan_id:'plus',reach_checkout_id:CHECKOUT}}},
  lines:{data:[{quantity:1,pricing:{price_details:{price:PRICE}},period:{start:NOW/1000,end:(NOW+30*DAY)/1000}}]},...over});
const event=(type,object,over={})=>({id:'evt_plus0001',type,livemode:false,data:{object},...over});
const sign=(raw,now=NOW,secret=SECRET)=>{const t=Math.floor(now/1000);return `t=${t},v1=${createHmac('sha256',secret).update(`${t}.${raw}`).digest('hex')}`;};
const replay={contentType:'application/json; charset=utf-8',body:'{"choices":[]}'};

test('Plus price checks native currency, exact amount, mode, interval, fixed licensed billing and inclusive tax',()=>{
  const check=p=>assertPlusPrice(p,{priceId:PRICE,policy:PLUS_DEFAULTS,livemode:false});
  check(goodPrice);
  for(const change of [{id:BASIC},{livemode:true},{active:false},{currency:'usd'},{unit_amount:1500},{tax_behavior:'exclusive'},
    {type:'one_time'},{billing_scheme:'tiered'},{transform_quantity:{divide_by:10}},
    {recurring:{...goodPrice.recurring,interval:'year'}},{recurring:{...goodPrice.recurring,interval_count:2}},
    {recurring:{...goodPrice.recurring,usage_type:'metered'}},{recurring:{...goodPrice.recurring,trial_period_days:7}}])
    assert.throws(()=>check({...goodPrice,...change}),{code:'plus_price_mismatch'});
});
test('Plus invoices require paid verified price metadata and exact native gross amount, regardless of inclusive tax split',()=>{
  const options={priceId:PRICE,policy:PLUS_DEFAULTS,livemode:false};
  const paid=invoice('acct_fixture01');
  assert.equal(plusInvoice(event('invoice.paid',paid),options).payment.amountMinor,2500);
  assert.equal(plusInvoice(event('invoice.paid',paid),options).payment.currency,'cad');
  for(const change of [{amount_paid:0},{status:'open'},{paid:false},{paid_out_of_band:true},{currency:'usd'},{total:1500},
    {lines:{data:[{...paid.lines.data[0],quantity:2}]}},{lines:{data:[{...paid.lines.data[0],proration:true}]}},
    {lines:{has_more:true,data:paid.lines.data}},{lines:{data:[{...paid.lines.data[0],pricing:{price_details:{price:BASIC}}}]}}])
    assert.throws(()=>plusInvoice(event('invoice.paid',{...paid,...change}),options),{code:'invalid_plus_invoice'});
  for(const type of ['checkout.session.completed','invoice.payment_failed','customer.subscription.deleted'])assert.equal(plusInvoice(event(type,paid),options),null);
  assert.equal(plusInvoice(event('invoice.paid',paid,{livemode:true}),options).ignored,'wrong_mode');
  assert.throws(()=>plusInvoice(event('invoice.paid',paid),{...options,priceId:undefined}),{code:'plus_unconfigured'});
});
test('Plus config is opt-in, uses a separate Price ID and never embeds credentials or activates from a name',()=>{
  const raw={origin:'https://reach.example',port:20978,database:'accounts.sqlite',chainId:1,upstreamUrl:'http://127.0.0.1:20777/v1',upstreamKeyEnv:'REACH_UPSTREAM_KEY',models,subscription,
    payments:{stripe:{mode:'test',secretKeyEnv:'STRIPE_SECRET_KEY',webhookSecretEnv:'STRIPE_WEBHOOK_SECRET',plusPriceId:PRICE}}};
  const env={REACH_UPSTREAM_KEY:'test-only-host-credential',STRIPE_SECRET_KEY:KEY,STRIPE_WEBHOOK_SECRET:SECRET};
  assert.equal(validateConfig(raw,process.cwd(),env).payments.stripe.plusPriceId,PRICE);
  assert.throws(()=>validateConfig({...raw,payments:{stripe:{...raw.payments.stripe,plusPriceId:BASIC,basicPriceId:BASIC}}},process.cwd(),env),/distinct Stripe Plus/);
  assert.throws(()=>validateConfig({...raw,subscription:{...subscription,plus:{...PLUS_DEFAULTS,unlimited:1500}}},process.cwd(),env),/unlimited usage/);
  const params=checkoutParams({kind:'subscription',planId:'plus',checkoutId:CHECKOUT,accountId:'acct_fixture01',plusPriceId:PRICE,basicPriceId:BASIC,origin:raw.origin,nowMs:NOW});
  assert.equal(params.line_items[0].price,PRICE);assert.equal(params.subscription_data.metadata.reach_plan_id,'plus');
  assert.equal(params.mode,'subscription');assert.equal(params.line_items[0].quantity,1);
  assert.equal('automatic_tax' in params,false);
});

function fixture(t,{enablePlus=true}={}){
  let now=NOW;
  const store=new AccountStore(':memory:',{models,subscription,now:()=>now}),calls=[];
  let fetchedInvoice,checkoutSession,sessionOverride={};
  const paymentFetch=async(url,init)=>{
    const u=new URL(url);calls.push({path:u.pathname,method:init.method,body:init.body?new URLSearchParams(init.body):null});
    let value;
    if(u.pathname===`/v1/prices/${PRICE}`)value=goodPrice;
    else if(u.pathname==='/v1/checkout/sessions'&&init.method==='POST'){
      const params=new URLSearchParams(init.body);checkoutSession={id:'cs_test_plus01',mode:'subscription',status:'complete',payment_status:'paid',livemode:false,
        customer:'cus_plusFixture01',subscription:'sub_plusFixture01',client_reference_id:params.get('client_reference_id'),
        metadata:Object.fromEntries(['reach_account_id','reach_kind','reach_plan_id','reach_checkout_id'].map(key=>[key,params.get(`metadata[${key}]`)]))};
      value={id:checkoutSession.id,url:'https://checkout.stripe.com/c/pay/plus-fixture',expires_at:now/1000+3600};
    }
    else if(u.pathname==='/v1/checkout/sessions/cs_test_plus01')value={...checkoutSession,...sessionOverride};
    else if(u.pathname==='/v1/billing_portal/sessions')value={url:'https://billing.stripe.com/p/session/fixture'};
    else if(u.pathname==='/v1/checkout/sessions')value={data:[]};
    else if(u.pathname==='/v1/invoice_payments')value={data:[{invoice:'in_plus0001',payment:{type:'payment_intent',payment_intent:'pi_plus0001'}}]};
    else if(u.pathname==='/v1/invoices/in_plus0001')value=fetchedInvoice;
    else throw new Error('Unexpected mocked Stripe path');
    return new Response(JSON.stringify(value),{headers:{'content-type':'application/json'}});
  };
  const config={origin:'http://127.0.0.1:20978',chainId:1,models,subscription,upstreamUrl:'http://127.0.0.1:20777/v1',upstreamKey:'test-only-host-credential',redemption:{enabled:false},payments:{stripe:{mode:'test',basicPriceId:BASIC,...(enablePlus?{plusPriceId:PRICE}:{}),secretKey:KEY,webhookSecret:SECRET}}};
  const {server}=createAccountService({config,store,paymentFetch,now:()=>now});
  const ready=new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));t.after(()=>store.close());
  const signIn=(wallet=Wallet.createRandom())=>{
    const state=randomBytes(32).toString('base64url'),verifier=randomBytes(32).toString('base64url');
    const flow=store.startFlow(state,createHash('sha256').update(verifier).digest('base64url'));
    const challenge=store.challenge(flow.flowId,wallet.address,(...args)=>signInMessage(config.origin,1,...args));
    store.authorize(flow.flowId,challenge.challengeId);return store.exchange(flow.flowId,state,verifier);
  };
  const call=async(method,path,{token,body,raw,signature}={})=>{
    await ready;const res=await fetch(`http://127.0.0.1:${server.address().port}${path}`,{method,headers:{...(token?{Authorization:`Bearer ${token}`} : {}),...(body||raw?{'Content-Type':'application/json'}:{}),...(signature?{'Stripe-Signature':signature}:{})},...(body||raw?{body:raw??JSON.stringify(body)}:{})});
    return {status:res.status,body:await res.json()};
  };
  const webhook=async evt=>{if(evt.type==='invoice.paid')fetchedInvoice=evt.data.object;const raw=JSON.stringify(evt);return call('POST','/v1/billing/stripe/webhook',{raw,signature:sign(raw,now)});};
  const paidInvoice=(accountId,over={})=>{const row=store.db.prepare('SELECT id FROM subscription_checkouts WHERE account_id=?').get(accountId);
    const value=invoice(accountId);value.parent.subscription_details.metadata.reach_checkout_id=row?.id || CHECKOUT;return {...value,...over};};
  return {store,calls,call,webhook,signIn,invoice:paidInvoice,start:session=>call('POST','/v1/billing/checkout',{token:session.accessToken,body:{kind:'subscription',planId:'plus'}}),
    session:value=>{sessionOverride=value;},setInvoice:value=>{fetchedInvoice=value;},advance:ms=>{now+=ms;}};
}
test('authenticated Plus checkout uses the server Price ID, while redirects and failed/cancelled events grant no access',async t=>{
  const f=fixture(t),s=f.signIn();
  assert.equal((await f.call('POST','/v1/billing/checkout',{body:{kind:'subscription',planId:'plus'}})).status,401);
  const result=await f.call('POST','/v1/billing/checkout',{token:s.accessToken,body:{kind:'subscription',planId:'plus',priceId:BASIC}});
  assert.equal(result.status,200);assert.match(result.body.url,/^https:\/\/checkout.stripe.com\//);
  assert.equal(f.calls.find(c=>c.method==='POST').body.get('line_items[0][price]'),PRICE);
  for(const type of ['checkout.session.completed','invoice.payment_failed','customer.subscription.deleted'])await f.webhook(event(type,{...invoice(s.account.id),mode:'subscription'}));
  assert.equal(f.store.account(s.account.id).plan.status,'none');
  const publicConfig=(await f.call('GET','/v1/account/config')).body;
  assert.equal(publicConfig.cardPlans.plus,true);assert.equal(publicConfig.subscription.plus.currency,'cad');
  assert.doesNotMatch(JSON.stringify(publicConfig),/rk_test_|whsec_|price_/);
});
test('raw-body signatures, expiry, invoice idempotency and tenant binding protect Plus grants',async t=>{
  const f=fixture(t),s=f.signIn();await f.start(s);const evt=event('invoice.paid',f.invoice(s.account.id)),raw=JSON.stringify(evt);
  assert.equal(verifyStripeSignature(Buffer.from(raw),sign(raw),SECRET,NOW),true);
  for(const signature of [sign(raw,NOW,'whsec_'+'z'.repeat(32)),sign(raw,NOW-301000),sign(raw+' '), 't=1,v1=bad']){
    const result=await f.call('POST','/v1/billing/stripe/webhook',{raw,signature});assert.equal(result.status,400);
  }
  assert.equal(f.store.account(s.account.id).plan.status,'none');
  assert.equal((await f.webhook(evt)).body.status,'applied');
  assert.equal((await f.webhook({...evt,id:'evt_redelivery02'})).body.duplicate,true);
  assert.equal(f.store.account(s.account.id).plan.id,'plus');
  const other=f.signIn();const altered=event('invoice.paid',invoice(other.account.id));
  assert.equal((await f.webhook(altered)).status,409);assert.equal(f.store.account(other.account.id).plan.status,'none');
  assert.equal(f.store.listPayments(other.account.id).length,0);
  const receipt=f.store.listPayments(s.account.id)[0];assert.equal(receipt.amountMinor,2500);assert.equal(receipt.currency,'cad');assert.equal('amountUsdMicros' in receipt,false);
  assert.doesNotMatch(JSON.stringify(receipt),/in_plus|evt_plus|price_plus/);
});
test('Plus remains unlimited beyond Basic quota without wallet charges; failures, repeats, expiry and refunds are durable',async t=>{
  const f=fixture(t),s=f.signIn();await f.start(s);await f.webhook(event('invoice.paid',f.invoice(s.account.id)));
  f.store.db.prepare('UPDATE accounts SET usd_prepaid=90000,prepaid=123 WHERE id=?').run(s.account.id);
  for(let i=0;i<1605;i++){const r=f.store.reserveRequest(s.account.id,`req-${i}`,models[0].id,`fp-${i}`);f.store.settleRequest(r.id,replay);}
  let a=f.store.account(s.account.id);assert.equal(a.requestAllowance.unlimited,true);assert.equal(a.requestAllowance.remaining,null);
  assert.equal(a.requestAllowance.includedLimit,null);assert.equal(a.requestAllowance.overageUsdMicrosPerRequest,0);assert.equal(a.requestAllowance.completed,1605);
  assert.equal(a.credit.balanceMicros,90000);assert.equal(a.allowance.prepaidRemaining,123);
  const r=f.store.reserveRequest(s.account.id,'req-0',models[0].id,'fp-0');assert.equal(r.fresh,false);f.store.settleRequest(r.id,replay);
  assert.equal(f.store.account(s.account.id).requestAllowance.completed,1605);
  const failed=f.store.reserveRequest(s.account.id,'failed',models[0].id,'same');f.store.releaseRequest(failed.id);
  const retry=f.store.reserveRequest(s.account.id,'failed',models[0].id,'same');assert.equal(retry.id,failed.id);
  f.store.markRequestUncertain(retry.id);assert.throws(()=>f.store.releaseRequest(retry.id),{code:'reservation_closed'});
  assert.equal(f.store.unsettledReservations(s.account.id).length,1);
  assert.throws(()=>f.store.reserveRequest(s.account.id,'req-0',models[0].id,'different'),{code:'idempotency_conflict'});
  await f.webhook(event('invoice.payment_failed',invoice(s.account.id)));await f.webhook(event('customer.subscription.deleted',{}));
  assert.equal(f.store.account(s.account.id).plan.status,'active');
  f.advance(30*DAY+1);a=f.store.account(s.account.id);assert.equal(a.plan.status,'expired');assert.equal(a.allowedModels.length,0);
  assert.throws(()=>f.store.reserveRequest(s.account.id,'after-expiry',models[0].id,'expired'),{code:'subscription_expired'});
  assert.equal(a.credit.balanceMicros,90000);
});
test('Plus refuses unbound invoices and mismatched Checkout customer, subscription, account, mode and payment state',async t=>{
  const f=fixture(t),s=f.signIn();
  assert.equal((await f.webhook(event('invoice.paid',invoice(s.account.id)))).status,503);
  assert.equal(f.store.account(s.account.id).plan.status,'none');
  await f.start(s);const paid=f.invoice(s.account.id);
  for(const change of [{customer:undefined},{parent:{subscription_details:{...paid.parent.subscription_details,subscription:undefined}}}]){
    assert.equal((await f.webhook(event('invoice.paid',{...paid,...change}))).status,400);
  }
  for(const change of [{customer:'cus_otherCustomer'},{subscription:'sub_otherSubscription'},{client_reference_id:'acct_otherAccount'},
    {status:'open'},{payment_status:'unpaid'},{mode:'payment'},{livemode:true},{metadata:{...paid.parent.subscription_details.metadata,reach_checkout_id:'f'.repeat(64)}}]){
    f.session(change);assert.equal((await f.webhook(event('invoice.paid',paid))).status,409);
    assert.equal(f.store.account(s.account.id).plan.status,'none');
  }
  f.session({});assert.equal((await f.webhook(event('invoice.paid',paid))).body.status,'applied');
  const portal=await f.call('POST','/v1/billing/portal',{token:s.accessToken,body:{customerId:'cus_attacker'}});
  assert.equal(portal.status,200);assert.equal(f.calls.find(c=>c.path==='/v1/billing_portal/sessions').body.get('customer'),'cus_plusFixture01');
  assert.equal(f.calls.some(c=>c.path==='/v1/subscriptions/search'),false);
});
test('expired stored card checkouts can switch Basic and Plus without recreating stale sessions',async t=>{
  for(const [first,next] of [['basic','plus'],['plus','basic'],['plus','plus']]){
    await t.test(`${first} to ${next}`,async t=>{
      const f=fixture(t),wallet=Wallet.createRandom();let s=f.signIn(wallet);
      const checkout=planId=>f.call('POST','/v1/billing/checkout',{token:s.accessToken,body:{kind:'subscription',planId}});
      assert.equal((await checkout(first)).status,200);const old=f.store.subscriptionCheckout(s.account.id);
      assert.equal(old.providerObjectId,'cs_test_plus01');f.advance(2*DAY);s=f.signIn(wallet);
      f.session({status:'complete',subscription:{id:'sub_plusFixture01',status:'canceled',current_period_end:(NOW+DAY)/1000}});
      assert.equal((await checkout(next)).status,200);assert.notEqual(f.store.subscriptionCheckout(s.account.id).id,old.id);
      const posts=f.calls.filter(c=>c.path==='/v1/checkout/sessions'&&c.method==='POST');assert.equal(posts.length,2);
      assert.ok(Number(posts[1].body.get('expires_at'))>(NOW+2*DAY)/1000);
      assert.equal(posts[1].body.get('line_items[0][price]'),next==='plus'?PRICE:BASIC);
    });
  }
});
test('expired unknown or still-paying checkouts require reconciliation before a replacement',async t=>{
  const f=fixture(t),wallet=Wallet.createRandom();let s=f.signIn(wallet);await f.start(s);f.advance(2*DAY);s=f.signIn(wallet);
  assert.equal((await f.start(s)).status,409);assert.equal(f.calls.filter(c=>c.method==='POST').length,1);
  f.store.db.prepare('UPDATE subscription_checkouts SET provider_object_id=NULL WHERE account_id=?').run(s.account.id);
  assert.equal((await f.start(s)).status,409);assert.equal(f.calls.filter(c=>c.method==='POST').length,1);
});
test('Plus renewal keeps its historical binding and old refunds, duplicate invoices and disputes cannot cross periods',async t=>{
  const f=fixture(t),s=f.signIn();await f.start(s);const paid=f.invoice(s.account.id);
  await f.webhook(event('invoice.paid',paid));f.advance(30*DAY);
  const renewed={...paid,id:'in_plusRenewal02',lines:{data:[{...paid.lines.data[0],period:{start:(NOW+30*DAY)/1000,end:(NOW+60*DAY)/1000}}]}};
  // The receipt retains the binding even if the single pending-intent slot changes later.
  f.store.db.prepare('DELETE FROM subscription_checkouts WHERE account_id=?').run(s.account.id);
  assert.equal((await f.webhook(event('invoice.paid',renewed,{id:'evt_renewal02'}))).body.status,'applied');
  const reversal={objectId:'re_oldPeriod',eventId:'evt_oldRefund',originalObjectId:paid.id,kind:'refund',currency:'cad',amountMinor:2500};
  assert.equal(f.store.applyPlusReversal(reversal).reason,'period_not_current');
  assert.equal(f.store.account(s.account.id).requestAllowance.unlimited,true);
  const late={...paid,id:'in_latePeriod03',lines:{data:[{...paid.lines.data[0],period:{start:(NOW+DAY)/1000,end:(NOW+31*DAY)/1000}}]}};
  assert.equal((await f.webhook(event('invoice.paid',late,{id:'evt_latePeriod'}))).body.status,'superseded');
  assert.equal(f.store.applyPlusReversal({...reversal,objectId:'dp_currentPeriod',eventId:'evt_disputeCurrent',kind:'dispute',originalObjectId:renewed.id}).status,'applied');
  assert.equal((await f.webhook(event('invoice.paid',renewed,{id:'evt_duplicateRenewal'}))).body.duplicate,true);
  assert.equal(f.store.account(s.account.id).plan.status,'expired');assert.equal(f.store.account(s.account.id).credit.balanceMicros,0);
});
test('a current Plus refund revokes only the paid plan and duplicates cannot touch wallet credit',async t=>{
  const f=fixture(t),s=f.signIn();await f.start(s);await f.webhook(event('invoice.paid',f.invoice(s.account.id)));
  const raw={objectId:'re_plus0001',eventId:'evt_refund001',kind:'refund',originalObjectId:'in_plus0001',amountMinor:2500,currency:'cad'};
  assert.equal(f.store.applyPlusReversal(raw).status,'applied');assert.equal(f.store.applyPlusReversal({...raw,eventId:'evt_refund002'}).duplicate,true);
  assert.equal(f.store.account(s.account.id).plan.status,'expired');assert.equal(f.store.account(s.account.id).credit.balanceMicros,0);
});
test('verified CAD refund webhooks retry until their invoice is recorded and then revoke once',async t=>{
  const f=fixture(t),s=f.signIn();await f.start(s);const paid=f.invoice(s.account.id);f.setInvoice(paid);
  const refund=event('refund.created',{id:'re_webhook001',status:'succeeded',amount:2500,currency:'cad',payment_intent:'pi_plus0001'});
  assert.equal((await f.webhook(refund)).status,503);
  await f.webhook(event('invoice.paid',paid));
  assert.equal((await f.webhook(refund)).body.status,'applied');
  assert.equal((await f.webhook({...refund,id:'evt_refundAgain'})).body.duplicate,true);
  assert.equal(f.store.account(s.account.id).plan.status,'expired');
});
test('Basic entitlements and USD top-ups retain their existing rules alongside Plus',t=>{
  const store=new AccountStore(':memory:',{models,subscription,now:()=>NOW});t.after(()=>store.close());
  const a=store.ensureEmailAccount('basic@example.test');
  const paid={provider:'stripe',eventId:'evt_basic001',objectId:'in_basic001',accountId:a.id,kind:'subscription_period',amountUsdMicros:15000000,currency:'usd',periodEnd:NOW+30*DAY};
  assert.equal(store.applyPayment(paid).status,'applied');assert.equal(store.account(a.id).plan.id,'basic-wallet');
  assert.equal(store.requestAllowance(a.id).includedLimit,1500);assert.equal(store.requestAllowance(a.id).overageUsdMicrosPerRequest,10000);
  store.applyPayment({...paid,objectId:'cs_topup001',kind:'top_up',periodEnd:null,amountUsdMicros:2000000});
  assert.equal(store.account(a.id).credit.balanceMicros,2000000);assert.equal(store.account(a.id).allowance.prepaidRemaining,0);
});
test('Plus policy alone stays unavailable until its exact Price ID is configured',async t=>{
  const f=fixture(t,{enablePlus:false}),s=f.signIn();
  const config=(await f.call('GET','/v1/account/config')).body;
  assert.equal(config.cardPlans.plus,false);assert.equal(config.cardPlans.basic,true);
  assert.equal((await f.call('POST','/v1/billing/checkout',{token:s.accessToken,body:{kind:'subscription',planId:'plus'}})).status,503);
  assert.equal(f.calls.length,0);assert.equal(f.store.account(s.account.id).plan.status,'none');
});
test('an old plan named Plus cannot acquire unlimited access without its verified receipt',t=>{
  const store=new AccountStore(':memory:',{models,subscription,now:()=>NOW});t.after(()=>store.close());
  const a=store.ensureEmailAccount('legacy-plus@example.test');
  store.grantPlan({accountId:a.id,grantId:'old-plus-grant',planId:'plus',name:'Plus',tokens:0,models:[models[0].id],expiresAt:NOW+DAY});
  assert.equal(store.requestAllowance(a.id).unlimited,false);
  assert.throws(()=>store.reserveRequest(a.id,'not-paid',models[0].id,'fp'),{code:'subscription_expired'});
});
test('Plus receipts and request replays survive a SQLite restart and legacy snapshot export refuses to drop them',()=>{
  const directory=mkdtempSync(join(tmpdir(),'reach-plus-test-')),file=join(directory,'accounts.sqlite');
  let store;
  try{
    store=new AccountStore(file,{models,subscription,now:()=>NOW});const a=store.ensureEmailAccount('restart@example.test');
    const p=plusInvoice(event('invoice.paid',invoice(a.id)),{priceId:PRICE,policy:PLUS_DEFAULTS,livemode:false}).payment;
    const intent=store.reserveSubscriptionCheckout(a.id,'b'.repeat(64));store.attachSubscriptionCheckout(a.id,intent.id,'cs_test_plus01');p.checkoutId=intent.id;p.sessionId='cs_test_plus01';
    store.applyPlusPayment(p);const r=store.reserveRequest(a.id,'persistent',models[0].id,'fp');store.settleRequest(r.id,replay);store.close();
    store=new AccountStore(file,{models,subscription,now:()=>NOW});assert.equal(store.applyPlusPayment({...p,eventId:'evt_restart01'}).duplicate,true);
    assert.equal(store.reserveRequest(a.id,'persistent',models[0].id,'fp').fresh,false);assert.equal(store.account(a.id).requestAllowance.unlimited,true);
    assert.throws(()=>readAccountSnapshot(file),/cannot preserve .* records/);
  }finally{store?.close();assert.equal(dirname(directory),tmpdir());rmSync(directory,{recursive:true,force:true});}
});
test('Plus preflight uses only mocked reads and rejects a mismatched configured currency',async()=>{
  const calls=[],origin='https://reach.example';let price=goodPrice;
  const fetchImpl=async(url,init)=>{calls.push(init.method);const path=new URL(url).pathname;return new Response(JSON.stringify(path.startsWith('/v1/prices/')?price:path==='/v1/webhook_endpoints'?{data:[{url:origin+'/v1/billing/stripe/webhook',status:'enabled',enabled_events:STRIPE_EVENTS}]}:{data:[{active:true,is_default:true,livemode:false,features:{subscription_cancel:{enabled:true}}}]}));};
  const stripe={mode:'test',plusPriceId:PRICE,secretKey:KEY};
  assert.equal((await checkStripe(stripe,{origin,plusPolicy:PLUS_DEFAULTS,fetchImpl}))[0].status,'ok');
  price={...goodPrice,currency:'usd'};assert.equal((await checkStripe(stripe,{origin,plusPolicy:PLUS_DEFAULTS,fetchImpl}))[0].status,'problem');
  assert.ok(calls.every(method=>method==='GET'));
});
