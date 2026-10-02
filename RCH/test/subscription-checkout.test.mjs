import test, {before,after} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PGlite} from '@electric-sql/pglite';
import {AccountStore} from '../service/store.mjs';
import {SupabaseAccountStore} from '../service/supabase-store.mjs';
const NOW=1_800_000_000_123, fingerprint='a'.repeat(64);
const models=[{id:'bridge-chat',metered:true,access:'requests',bridge:{kind:'tray',model:'chatgpt-chat'}}];
const subscription={basic:{id:'basic-wallet',includedRequests:1500,priceUsdMicros:15000000},overageUsdMicrosPerRequest:10000,proEnabled:false};
let db;
before(async()=>{
  db=await PGlite.create();
  await db.exec('CREATE ROLE anon NOINHERIT; CREATE ROLE authenticated NOINHERIT; CREATE ROLE service_role NOINHERIT BYPASSRLS;');
  const dir=new URL('../../supabase/migrations/',import.meta.url);
  for(const name of (await readdir(dir)).filter(n=>n.endsWith('.sql')).sort()) await db.exec(await readFile(new URL(name,dir),'utf8'));
});
after(async()=>db.close());
async function postgres(now){
  const tables=(await db.query("SELECT tablename FROM pg_tables WHERE schemaname='reach_accounts'")).rows;
  await db.exec('TRUNCATE '+tables.map(t=>'reach_accounts."'+t.tablename+'"').join(',')+' CASCADE');
  return new SupabaseAccountStore({url:'https://checkout-fixture.supabase.co',secretKey:'sb_secret_offline_fixture_0000000000',models,subscription,now,
    fetchImpl:async(url,init)=>{
      const rpc=new URL(url).pathname.split('/').pop();
      assert.ok(['reach_checkout_store','reach_account_store','reach_request_store'].includes(rpc));
      const {p_operation,p_payload}=JSON.parse(init.body);
      try{
        const value=await db.transaction(async tx=>{await tx.exec('SET LOCAL ROLE service_role');return (await tx.query('SELECT public.'+rpc+'($1::text,$2::jsonb) AS value',[p_operation,JSON.stringify(p_payload)])).rows[0].value;});
        return new Response(JSON.stringify(value),{status:200});
      }catch(e){if(e.code!=='P0001')console.error('Offline checkout RPC error:',e.code,e.message);return new Response(JSON.stringify({code:e.code,message:e.message}),{status:400});}
    }});
}
for(const label of ['sqlite','postgres'])test(label+': checkout intents survive retries, refuse active plans and rotate only after expiry',async t=>{
  let clock=NOW;
  const store=label==='sqlite'?new AccountStore(':memory:',{models,subscription,now:()=>clock}):await postgres(()=>clock);
  t.after(()=>store.close());
  const account=await store.ensureAccount('0x'+'11'.repeat(20));
  const first=await store.reserveSubscriptionCheckout(account.id,fingerprint);
  assert.match(first.id,/^[a-f0-9]{64}$/); assert.equal(first.expiresAt,(Math.floor(NOW/1000)+3600)*1000);
  clock+=5000;
  assert.deepEqual(await store.reserveSubscriptionCheckout(account.id,fingerprint),first);
  await assert.rejects(async()=>store.reserveSubscriptionCheckout(account.id,'b'.repeat(64)),{code:'checkout_pending'});
  assert.equal((await store.attachSubscriptionCheckout(account.id,first.id,'I-SUB1')).providerObjectId,'I-SUB1');
  assert.equal((await store.reserveSubscriptionCheckout(account.id,fingerprint)).providerObjectId,'I-SUB1');
  await assert.rejects(async()=>store.attachSubscriptionCheckout(account.id,first.id,'I-OTHER'),{code:'checkout_pending'});
  const other=await store.ensureAccount('0x'+'22'.repeat(20));
  assert.notEqual((await store.reserveSubscriptionCheckout(other.id,fingerprint)).id,first.id);
  clock=first.expiresAt;
  assert.deepEqual(await store.reserveSubscriptionCheckout(account.id,fingerprint),{...first,providerObjectId:'I-SUB1'},'expiry alone cannot authorize a second subscription');
  const next=await store.reserveSubscriptionCheckout(account.id,fingerprint,first.id);assert.notEqual(next.id,first.id);assert.equal(next.providerObjectId,undefined);
  await assert.rejects(async()=>store.attachSubscriptionCheckout(account.id,first.id,'I-SUB1'),{code:'checkout_pending'});
  assert.deepEqual(await store.reserveSubscriptionCheckout(account.id,fingerprint,first.id),next,'a stale concurrent replacement cannot rotate the newer intent');
  await store.grantPlan({wallet:account.wallet,grantId:'checkout-grant-1',planId:'basic-wallet',name:'Basic',models:['bridge-chat'],tokens:0,expiresAt:clock+86400000});
  await assert.rejects(async()=>store.reserveSubscriptionCheckout(account.id,fingerprint),{code:'plan_active'});
});
test('SQLite checkout intent survives a real close/reopen',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'reach-checkout-'));
  t.after(async()=>{store.close();await rm(dir,{recursive:true,force:true});});
  const path=join(dir,'account.sqlite');const opts={models,subscription,now:()=>NOW};
  let store=new AccountStore(path,opts);const a=store.ensureAccount('0x'+'33'.repeat(20));const first=store.reserveSubscriptionCheckout(a.id,fingerprint);store.close();
  store=new AccountStore(path,opts);assert.deepEqual(store.reserveSubscriptionCheckout(a.id,fingerprint),first);
});
