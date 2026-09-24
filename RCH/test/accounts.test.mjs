import test from 'node:test';
import assert from 'node:assert/strict';
import { Wallet } from 'ethers';
import { randomBytes,createHash } from 'node:crypto';
import { mkdtempSync,rmSync,statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AccountStore } from '../service/store.mjs';
import { createAccountService,signInMessage,verifyWallet } from '../service/server.mjs';
import { validateConfig } from '../service/config.mjs';

const model={id:'free/measured',name:'Measured route',provider:'free endpoint',metered:true,maxInputTokens:50,maxInputBytes:4096,maxOutputTokens:50};
const wallet=Wallet.createRandom();
const config={origin:'http://127.0.0.1:20978',chainId:1,models:[model],upstreamUrl:'http://127.0.0.1:20777/v1',upstreamKey:'host-only-test-credential',redemption:{enabled:false}};
const proof=()=>{const verifier=randomBytes(32).toString('base64url');return{verifier,state:randomBytes(32).toString('base64url'),challenge:createHash('sha256').update(verifier).digest('base64url')};};
function setup(t) {let time=1700000000000;const store=new AccountStore(':memory:',{models:[model],now:()=>time});t.after(()=>store.close());return{store,advance:n=>{time+=n;},grant:(tokens=500,grantId='grant-initial')=>store.grantPlan({wallet:wallet.address,grantId,planId:'pro',name:'Pro',models:[model.id],tokens,expiresAt:time+3600000})};}

test('PKCE, one-use wallet challenge and account identity survive multiple devices',async t=>{
  const {store}=setup(t),p=proof(),f=store.startFlow(p.state,p.challenge);
  assert.equal(store.exchange(f.flowId,p.state,p.verifier),null);
  assert.throws(()=>store.exchange(f.flowId,'x'.repeat(43),p.verifier),{code:'invalid_proof'});
  const c=store.challenge(f.flowId,wallet.address,(...args)=>signInMessage(config.origin,1,...args));
  assert.equal(await verifyWallet({...c,wallet:wallet.address},await wallet.signMessage(c.message),null,1),true);
  assert.equal(await verifyWallet({...c,wallet:wallet.address},await Wallet.createRandom().signMessage(c.message),null,1),false);
  assert.equal(await verifyWallet({...c,wallet:wallet.address,message:c.message.replace(config.origin,'https://evil.example')},await wallet.signMessage(c.message),null,1),false);
  store.authorize(f.flowId,c.challengeId);
  assert.throws(()=>store.authorize(f.flowId,c.challengeId),{code:'challenge_expired'});
  const session=store.exchange(f.flowId,p.state,p.verifier);
  assert.equal(session.account.walletAddress,wallet.address);assert.equal(session.account.plan.status,'none');
  assert.equal(store.authenticate(session.accessToken).id,session.account.id);
  assert.throws(()=>store.exchange(f.flowId,p.state,p.verifier),{code:'flow_expired'});
  assert.equal(store.db.prepare('SELECT hash FROM sessions').get().hash.includes(session.accessToken),false);
  store.logout(session.accessToken);assert.throws(()=>store.authenticate(session.accessToken),{code:'session_expired'});
});
test('expired flows, superseded challenges, and wrong-chain contract verification fail',async t=>{
 const {store,advance}=setup(t),p=proof(),f=store.startFlow(p.state,p.challenge);
 const make=(...args)=>signInMessage(config.origin,1,...args);
 const first=store.challenge(f.flowId,wallet.address,make),second=store.challenge(f.flowId,wallet.address,make);
 assert.throws(()=>store.getChallenge(f.flowId,first.challengeId),{code:'challenge_expired'});
 await assert.rejects(verifyWallet({...second,wallet:wallet.address},'0x1234',{getNetwork:async()=>({chainId:2n})},1),{code:'wrong_chain'});
 advance(600001);assert.throws(()=>store.getFlow(f.flowId),{code:'flow_expired'});
});
test('shared reservations settle once; duplicates conflict and overspending records debt',t=>{
 const{store,grant}=setup(t),a=grant(100);
 const r=store.reserve(a.id,'req1',model.id,'abc',60);
 assert.throws(()=>store.reserve(a.id,'req2',model.id,'def',60),{code:'allowance_exhausted'});
 assert.equal(store.reserve(a.id,'req1',model.id,'abc',60).fresh,false);
 assert.throws(()=>store.reserve(a.id,'req1',model.id,'other',60),{code:'idempotency_conflict'});
 store.settle(r.id,{promptTokens:10,completionTokens:20,totalTokens:30});
 store.settle(r.id,{promptTokens:10,completionTokens:20,totalTokens:30});assert.equal(store.account(a.id).allowance.includedRemaining,70);
 const over=store.reserve(a.id,'req3',model.id,'ghi',50);
 store.settle(over.id,{promptTokens:80,completionTokens:20,totalTokens:100});
 assert.equal(store.account(a.id).allowance.debt,30);assert.equal(store.account(a.id).allowance.totalRemaining,0);
 assert.throws(()=>store.reserve(a.id,'req4',model.id,'jkl',1),{code:'usage_debt'});
});
test('late refunds do not inflate a renewed plan; uncertain dispatch stays held',t=>{
 const{store,grant}=setup(t),a=grant(100),r=store.reserve(a.id,'old',model.id,'x',80);
 grant(200,'grant-renewal');store.settle(r.id,{promptTokens:5,completionTokens:5,totalTokens:10});
 assert.equal(store.account(a.id).allowance.includedRemaining,200);
 const r2=store.reserve(a.id,'uncertain',model.id,'y',50);store.markUncertain(r2.id,'upstream_timeout');
 assert.throws(()=>store.release(r2.id),{code:'reservation_closed'});assert.equal(store.account(a.id).allowance.reserved,50);
 store.settle(r2.id,{promptTokens:2,completionTokens:3,totalTokens:5});assert.equal(store.account(a.id).allowance.includedRemaining,195);
});
test('plan grants and redeemed usage are durable, idempotent and separated',t=>{
 const folder=mkdtempSync(join(tmpdir(),'reach-accounts-'));t.after(()=>rmSync(folder,{recursive:true,force:true}));
 const path=join(folder,'accounts.sqlite');let store=new AccountStore(path,{models:[model]});
 const grant={wallet:wallet.address,grantId:'grant-durable',planId:'pro',name:'Pro',models:[model.id],tokens:100,expiresAt:Date.now()+3600000};
 const a=store.grantPlan(grant);assert.equal(store.grantPlan(grant).id,a.id);
 assert.throws(()=>store.grantPlan({...grant,tokens:500}),{code:'grant_conflict'});
 const intent=store.createRedemption(a.id,'1000000000000000000',1000000);
 assert.throws(()=>store.creditRedemption(intent.redemptionId,'event1'),{code:'redemption_not_pending'});
 store.submitRedemption(intent.redemptionId,intent.ticket,'0x'+'11'.repeat(32));store.creditRedemption(intent.redemptionId,'event1');store.close();
 store=new AccountStore(path,{models:[model]});t.after(()=>store.close());store.creditRedemption(intent.redemptionId,'event1');
 assert.equal(store.account(a.id).allowance.prepaidRemaining,1000000);assert.equal(store.account(a.id).allowance.includedRemaining,100);
 assert.equal(statSync(path).mode&0o777,0o600);
});
test('service rejects foreign origins, protects account endpoints, and completes browser-to-Studio sign-in',async t=>{
 const{store}=setup(t);const {server}=createAccountService({config,store});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}));
 const base=`http://127.0.0.1:${server.address().port}`;
 const post=async(path,body,headers={})=>{const r=await fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(body)});return{status:r.status,body:await r.json()};};
 assert.equal((await fetch(base+'/v1/account')).status,401);
 assert.equal((await post('/v1/auth/start',{}, {Origin:'https://evil.example'})).status,403);
 assert.equal((await fetch(base+'/wallet/connect')).headers.get('content-security-policy').includes("frame-ancestors 'none'"),true);
 const p=proof(),f=await post('/v1/auth/start',{state:p.state,codeChallenge:p.challenge});
 assert.equal(f.status,200);assert.equal(new URL(f.body.loginUrl).origin,config.origin);
 const c=await post('/v1/auth/challenge',{flowId:f.body.flowId,address:wallet.address});
 assert.equal((await post('/v1/auth/verify',{flowId:f.body.flowId,challengeId:c.body.challengeId,signature:await wallet.signMessage(c.body.message)})).status,200);
 const result=await post('/v1/auth/exchange',{flowId:f.body.flowId,state:p.state,codeVerifier:p.verifier});assert.equal(result.status,200);
 const headers={Authorization:'Bearer '+result.body.accessToken};
 assert.equal((await fetch(base+'/v1/account',{headers})).status,200);
 assert.equal((await post('/v1/redemptions/start',{amountRch:'1'},headers)).status,503);
 assert.equal((await post('/v1/auth/logout',{},headers)).status,200);
 assert.equal((await fetch(base+'/v1/account',{headers})).status,401);
});
test('production config disallows plaintext public origin, arbitrary bind, inline secrets and unknown fields',()=>{
 const raw={...config,port:20978,database:'private/db.sqlite',upstreamKeyEnv:'REACH_TEST_KEY'};delete raw.upstreamKey;
 const env={REACH_TEST_KEY:'host-only-test-credential'};
 assert.equal(validateConfig(raw,process.cwd(),env).origin,config.origin);
 for(const change of [{origin:'http://example.com'},{listenHost:'0.0.0.0'},{upstreamKey:'secret'},{redemption:{enabled:true}},{mispelled:true}])assert.throws(()=>validateConfig({...raw,...change},process.cwd(),env));
});
