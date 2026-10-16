import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pgliteStores } from './helpers/pglite-store.mjs';
import { PLUS_DEFAULTS } from '../service/payments/plus.mjs';
const example=JSON.parse(readFileSync(new URL('../config/subscription-bridges.example.json',import.meta.url)));
const models=[example.models.find(m=>m.metered)],subscription={...example.subscription,plus:{...PLUS_DEFAULTS}};
const pg=pgliteStores({requiredMigration:'reach_plus_unlimited.sql'});
const replay={contentType:'application/json; charset=utf-8',body:'{}'};
async function fixture(){const f=await pg.fresh({models,subscription});const account=await f.store.ensureEmailAccount('plus@example.test');
 const intent=await f.store.reserveSubscriptionCheckout(account.id,'b'.repeat(64));await f.store.attachSubscriptionCheckout(account.id,intent.id,'cs_test_plus01');
 const payment={customerId:'cus_plusFixture01',subscriptionId:'sub_plusFixture01',checkoutId:intent.id,sessionId:'cs_test_plus01',provider:'stripe',eventId:'evt_plus0001',objectId:'in_plus0001',accountId:account.id,planId:'plus',priceId:'price_plusFixture01',amountMinor:2500,currency:'cad',periodEnd:f.clock.now+30*86400000};return {...f,account,payment};}
test('Postgres Plus grants, native CAD receipts, tenant isolation and invoice replay match SQLite',async()=>{
 const f=await fixture();assert.equal((await f.store.applyPlusPayment(f.payment)).status,'applied');
 assert.equal((await f.store.applyPlusPayment({...f.payment,eventId:'evt_repeat02'})).duplicate,true);
 const other=await f.store.ensureEmailAccount('other@example.test');
 await assert.rejects(()=>f.store.applyPlusPayment({...f.payment,accountId:other.id}),{code:'payment_conflict'});
 assert.equal((await f.store.account(f.account.id)).plan.id,'plus');assert.equal((await f.store.account(other.id)).plan.status,'none');
 const receipt=(await f.store.listPayments(f.account.id))[0];assert.equal(receipt.amountMinor,2500);assert.equal(receipt.currency,'cad');assert.equal('amountUsdMicros' in receipt,false);
 const wrong=await f.store.applyPlusPayment({...f.payment,objectId:'in_wrong001',amountMinor:1500});assert.equal(wrong.status,'rejected');
});
test('Postgres Plus has no quota or overage and cannot silently spend wallet credit after expiry',async()=>{
 const f=await fixture();await f.store.applyPlusPayment(f.payment);await f.setCredit({accountId:f.account.id,prepaid:90000,debt:0});
 // Completion count is descriptive: it has no constraint or entitlement gate.
 await pg.query("INSERT INTO reach_accounts.plus_requests(id,account_id,request_id,model,fingerprint,plan_version,status,created) SELECT lpad(to_hex(i),64,'0'),$1,'past-'||i,$2,'fp', $3,'settled',$4 FROM generate_series(1,1601) i",[f.account.id,models[0].id,(await f.store.accountById(f.account.id)).plan_version,f.clock.now]);
 const request=await f.store.reserveRequest(f.account.id,'beyond-quota',models[0].id,'fp');await f.store.settleRequest(request.id,replay);await f.store.settleRequest(request.id,replay);
 let a=await f.store.account(f.account.id);assert.equal(a.requestAllowance.completed,1602);assert.equal(a.requestAllowance.remaining,null);assert.equal(a.requestAllowance.unlimited,true);assert.equal(a.credit.balanceMicros,90000);
 const retry=await f.store.reserveRequest(f.account.id,'beyond-quota',models[0].id,'fp');assert.equal(retry.fresh,false);
 f.clock.now=f.payment.periodEnd+1;assert.equal((await f.store.account(f.account.id)).allowedModels.length,0);
 await assert.rejects(()=>f.store.reserveRequest(f.account.id,'expired',models[0].id,'fp'),{code:'subscription_expired'});
 assert.equal((await f.store.account(f.account.id)).credit.balanceMicros,90000);
});
test('Postgres Plus failure recovery, uncertain holds, refunds and Basic compatibility remain isolated',async()=>{
 const f=await fixture();await f.store.applyPlusPayment(f.payment);
 const r=await f.store.reserveRequest(f.account.id,'retry',models[0].id,'fp');await f.store.releaseRequest(r.id);assert.equal((await f.store.reserveRequest(f.account.id,'retry',models[0].id,'fp')).id,r.id);
 await f.store.markRequestUncertain(r.id);await assert.rejects(()=>f.store.releaseRequest(r.id),{code:'reservation_closed'});
 assert.equal((await f.store.unsettledReservations(f.account.id)).length,1);
 const reversal={objectId:'re_plus0001',eventId:'evt_refund001',originalObjectId:f.payment.objectId,kind:'refund',currency:'cad',amountMinor:2500};
 assert.equal((await f.store.applyPlusReversal(reversal)).status,'applied');assert.equal((await f.store.applyPlusReversal({...reversal,eventId:'evt_refund002'})).duplicate,true);
 assert.equal((await f.store.account(f.account.id)).plan.status,'expired');
 const basic=await f.store.ensureEmailAccount('basic@example.test');await f.store.applyPayment({provider:'stripe',eventId:'evt_basic001',objectId:'in_basic001',kind:'subscription_period',accountId:basic.id,amountUsdMicros:15000000,currency:'usd',periodEnd:f.clock.now+86400000});
 assert.equal((await f.store.requestAllowance(basic.id)).includedLimit,1500);
 const denied=await pg.query("SELECT has_function_privilege('anon','public.reach_plus_store(text,jsonb)','EXECUTE') AS allowed");assert.equal(denied.rows[0].allowed,false);
});
test('Postgres cannot turn an old Plus name into a paid entitlement and keeps new tables private',async()=>{
 const f=await fixture();await f.store.grantPlan({accountId:f.account.id,grantId:'old-plus-grant',planId:'plus',name:'Plus',models:[models[0].id],tokens:0,expiresAt:f.clock.now+86400000});
 assert.equal((await f.store.requestAllowance(f.account.id)).unlimited,false);
 await assert.rejects(()=>f.store.reserveRequest(f.account.id,'not-paid',models[0].id,'fp'),{code:'subscription_expired'});
 const tables=await pg.query("SELECT relname,relrowsecurity FROM pg_class JOIN pg_namespace ON pg_namespace.oid=relnamespace WHERE nspname='reach_accounts' AND relname IN ('plus_payments','plus_reversals','plus_requests')");
 assert.equal(tables.rows.length,3);assert.ok(tables.rows.every(row=>row.relrowsecurity));
 const permissions=await pg.query("SELECT has_table_privilege('anon','reach_accounts.plus_payments','SELECT') AS read,has_table_privilege('authenticated','reach_accounts.plus_requests','UPDATE') AS write,(SELECT prosecdef FROM pg_proc WHERE oid='public.reach_plus_store(text,jsonb)'::regprocedure) AS definer");
 assert.deepEqual(permissions.rows[0],{read:false,write:false,definer:false});
});
test('Postgres requires a stored Checkout and immutable customer/subscription binding, matching SQLite',async()=>{
 const f=await fixture();
 const pending=await f.store.subscriptionCheckout(f.account.id);assert.equal(pending.id,f.payment.checkoutId);assert.equal(pending.providerObjectId,f.payment.sessionId);
 await assert.rejects(()=>f.store.applyPlusPayment({...f.payment,checkoutId:'f'.repeat(64)}),{code:'plus_checkout_pending'});
 await assert.rejects(()=>f.store.applyPlusPayment({...f.payment,sessionId:'cs_otherSession'}),{code:'payment_conflict'});
 assert.equal((await f.store.account(f.account.id)).plan.status,'none');
 await f.store.applyPlusPayment(f.payment);
 assert.equal((await f.store.plusCheckout(f.payment)).sessionId,f.payment.sessionId);
 assert.equal(await f.store.plusPortalCustomer(f.account.id),f.payment.customerId);
 for(const change of [{customerId:'cus_otherCustomer'},{subscriptionId:'sub_otherSubscription'},{checkoutId:'f'.repeat(64)}])
   await assert.rejects(()=>f.store.applyPlusPayment({...f.payment,...change,objectId:'in_wrongBinding'}),{code:'payment_conflict'});
 assert.equal((await f.store.account(f.account.id)).requestAllowance.unlimited,true);
});
test('Postgres renewal survives pending-intent rotation; old refunds preserve newer access and duplicate invoices cannot restore a dispute',async()=>{
 const f=await fixture();await f.store.applyPlusPayment(f.payment);f.clock.now+=30*86400000;
 await pg.query('DELETE FROM reach_accounts.subscription_checkouts WHERE account_id=$1',[f.account.id]);
 const renewal={...f.payment,eventId:'evt_renewal02',objectId:'in_renewal02',periodEnd:f.clock.now+30*86400000};
 assert.equal((await f.store.applyPlusPayment(renewal)).status,'applied');
 const oldRefund={objectId:'re_oldPeriod',eventId:'evt_oldRefund',originalObjectId:f.payment.objectId,kind:'refund',currency:'cad',amountMinor:2500};
 assert.equal((await f.store.applyPlusReversal(oldRefund)).reason,'period_not_current');
 assert.equal((await f.store.account(f.account.id)).requestAllowance.unlimited,true);
 assert.equal((await f.store.applyPlusPayment({...f.payment,objectId:'in_latePeriod',periodEnd:f.clock.now+86400000})).status,'superseded');
 assert.equal((await f.store.applyPlusReversal({...oldRefund,objectId:'dp_currentPeriod',eventId:'evt_currentDispute',originalObjectId:renewal.objectId,kind:'dispute'})).status,'applied');
 assert.equal((await f.store.applyPlusPayment({...renewal,eventId:'evt_duplicateRenewal'})).duplicate,true);
 assert.equal((await f.store.account(f.account.id)).plan.status,'expired');assert.equal((await f.store.account(f.account.id)).credit.balanceMicros,0);
});
