import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';
import { AccountStore, digest } from '../service/store.mjs';
import { SupabaseAccountStore } from '../service/supabase-store.mjs';
import { createAccountService } from '../service/server.mjs';
import { API_KEY_TTL_MS } from '../service/api-keys.mjs';

const NOW=1800000000000;
test('SQLite API keys persist hashes only, enforce ownership, limits, expiry and revocation', t=>{
  const dir=mkdtempSync(join(tmpdir(),'rch-api-keys-')),path=join(dir,'accounts.sqlite');
  let now=NOW,store=new AccountStore(path,{now:()=>now});
  t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
  const a=store.ensureEmailAccount('keys@example.com'),b=store.ensureEmailAccount('other@example.com');
  store.db.prepare("UPDATE accounts SET plan_id='basic',plan_expires=? WHERE id=?").run(NOW+2*API_KEY_TTL_MS,a.id);
  for(const name of [null,'',' ', 'a'.repeat(65),'bad\nname'])assert.throws(()=>store.createApiKey(a.id,name),{code:'invalid_api_key_name'});
  const created=store.createApiKey(a.id,' Laptop ');
  assert.match(created.key,/^rch_key_[a-f0-9]{64}$/);
  assert.equal(created.name,'Laptop');
  const operator=store.listOperatorApiKeys();
  assert.equal(operator.data[0].accountId,a.id);
  assert.equal(operator.data[0].prefix,created.prefix);
  assert.equal(operator.hasMore,false);
  assert.throws(()=>store.listOperatorApiKeys(-1),{code:'invalid_offset'});
  assert.equal(Date.parse(created.expiresAt)-Date.parse(created.createdAt),API_KEY_TTL_MS);
  const row=store.db.prepare('SELECT * FROM api_keys').get();
  assert.equal(row.hash,digest(created.key));
  assert.ok(!JSON.stringify(row).includes(created.key));
  assert.ok(!JSON.stringify(store.listApiKeys(a.id)).includes(created.key));
  assert.equal(store.authenticateApiKey(created.key).id,a.id);
  assert.throws(()=>store.authenticate(created.key),{code:'session_required'});
  assert.throws(()=>store.revokeApiKey(b.id,created.id),{code:'api_key_missing'});
  assert.deepEqual(store.listApiKeys(b.id),[]);
  store.close();store=new AccountStore(path,{now:()=>now});
  assert.equal(store.authenticateApiKey(created.key).id,a.id);
  for(let i=1;i<10;i++)store.createApiKey(a.id,`Key ${i}`);
  assert.throws(()=>store.createApiKey(a.id,'Eleventh'),{code:'api_key_limit'});
  const revoked=store.revokeApiKey(a.id,created.id);
  assert.equal(revoked.revokedAt,new Date(now).toISOString());
  assert.deepEqual(store.revokeApiKey(a.id,created.id),revoked);
  assert.throws(()=>store.authenticateApiKey(created.key),{code:'api_key_invalid'});
  const last=store.createApiKey(a.id,'Replacement');
  now+=API_KEY_TTL_MS;
  assert.throws(()=>store.authenticateApiKey(last.key),{code:'api_key_invalid'});
  assert.ok(store.createApiKey(a.id,'After expiry'));
});

test('HTTP management is session-only; model keys cannot enter auth, billing, account or wrong methods',async t=>{
  const store=new AccountStore(':memory:',{now:()=>NOW});
  const a=store.ensureEmailAccount('http@example.com'),token='rch_session_'+'a'.repeat(64);
  store.db.prepare("UPDATE accounts SET plan_id='basic',plan_expires=? WHERE id=?").run(NOW+3600000,a.id);
  store.db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(digest(token),a.id,NOW+3600000);
  const config={origin:'https://reach.example',chainId:1,models:[],redemption:{enabled:false}};
  const {server}=createAccountService({config,store,now:()=>NOW});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{await new Promise(resolve=>server.close(resolve));store.close();});
  const request=async(path,{method='GET',key=token,body}={})=>{
    const r=await fetch(`http://127.0.0.1:${server.address().port}${path}`,{method,headers:{authorization:`Bearer ${key}`,'content-type':'application/json',origin:'https://signalreach.com'},...(body?{body:JSON.stringify(body)}:{})});
    return {status:r.status,body:await r.json()};
  };
  assert.equal((await request('/v1/account/api-keys',{key:''})).status,401);
  const created=await request('/v1/account/api-keys',{method:'POST',body:{name:'Website'}});
  assert.equal(created.status,201);
  const key=created.body.key;
  const operatorUrl=`http://127.0.0.1:${server.address().port}/_reach/operator/api-keys`;
  const operator=await fetch(operatorUrl);
  assert.equal(operator.status,200);
  const operatorRows=await operator.json();
  assert.equal(operatorRows.data[0].id,created.body.id);
  assert.equal(operatorRows.data[0].accountId,a.id);
  assert.ok(!JSON.stringify(operatorRows).includes(key));
  assert.ok(!JSON.stringify(operatorRows).includes(digest(key)));
  for(const headers of [{origin:'https://signalreach.ca'},{'x-reach-client-ip':'203.0.113.9'},
      {'x-forwarded-for':'203.0.113.9'}]) {
    assert.equal((await fetch(operatorUrl,{headers})).status,403,JSON.stringify(headers));
  }
  const rebindingStatus=await new Promise((resolve,reject)=>{
    const req=httpRequest(operatorUrl,{headers:{host:'attacker.example'}},res=>{res.resume();res.on('end',()=>resolve(res.statusCode));});
    req.on('error',reject);req.end();
  });
  assert.equal(rebindingStatus,403);
  assert.equal((await request('/_reach/operator/api-keys',{key})).status,403);
  assert.deepEqual((await request('/v1/account/api-keys')).body,{data:[Object.fromEntries(Object.entries(created.body).filter(([k])=>k!=='key'))]});
  const models=await request('/v1/models',{key});
  assert.equal(models.status,200);
  assert.deepEqual(await request('/api/v1/models?client=lemonade',{key}),models);
  const available=await request('/api/v1/models?show_all=true',{key});
  assert.equal(available.status,200);
  assert.deepEqual(available.body.data,models.body.data.map(m=>({...m,downloaded:true})));
  assert.deepEqual(await request('/api/v1/models'),await request('/v1/models'));
  assert.equal((await request('/api/v1/models',{key:'rch_key_invalid'})).status,401);
  for(const [path,method]of [['/v1/account','GET'],['/v1/account/api-keys','GET'],['/v1/account/api-keys','POST'],['/v1/account/api-keys/revoke','POST'],['/v1/auth/logout','POST'],['/v1/auth/start','POST'],['/v1/billing/checkout','POST'],['/v1/models','POST'],['/v1/chat/completions','GET'],['/api/v1/models','POST'],['/api/v1/chat/completions','GET'],['/api/v1/account','GET'],['/api/v1/auth/start','POST']]){
    assert.equal((await request(path,{key,method,body:method==='POST'?{}:undefined})).status,403,path);
  }
  // A key reaches the chat gateway, not session authentication (empty model is invalid).
  const chat=await request('/v1/chat/completions',{key,method:'POST',body:{}});
  assert.notEqual(chat.status,401);
  assert.deepEqual(await request('/api/v1/chat/completions?client=lemonade',{key,method:'POST',body:{}}),chat);
  assert.equal((await request('/api/v1/account')).status,404);
  assert.equal((await request('/v1/account/api-keys/revoke',{method:'POST',body:{id:created.body.id}})).status,200);
  assert.equal((await request('/v1/models',{key})).status,401);
  assert.equal((await request('/api/v1/models',{key})).status,401);
});

test('Supabase adapter sends hashes, uses dedicated RPC, and maps safe errors',async()=>{
  const calls=[];let stored;
  const store=new SupabaseAccountStore({url:'https://project.supabase.co',secretKey:'sb_secret_'+'x'.repeat(32),now:()=>NOW,fetchImpl:async(url,options)=>{
    const body=JSON.parse(options.body);calls.push({url,body});
    const p=body.p_payload;
    if(body.p_operation==='create'){stored={...p,revoked:null};return {ok:true,json:async()=>({result:stored})};}
    if(body.p_operation==='list')return {ok:true,json:async()=>({result:[stored]})};
    if(body.p_operation==='revoke')return {ok:true,json:async()=>({result:{...stored,revoked:NOW}})};
    return {ok:false,json:async()=>({code:'P0001',message:'api_key_invalid'})};
  }});
  const key=await store.createApiKey('a'.repeat(64),'CI');
  assert.ok(calls[0].url.endsWith('/rpc/reach_api_key_store'));
  assert.equal(calls[0].body.p_payload.hash,digest(key.key));
  assert.ok(!JSON.stringify(calls).includes(key.key));
  assert.deepEqual(await store.listApiKeys('a'.repeat(64)),[Object.fromEntries(Object.entries(key).filter(([k])=>k!=='key'))]);
  assert.equal((await store.revokeApiKey('a'.repeat(64),key.id)).revokedAt,new Date(NOW).toISOString());
  await assert.rejects(store.authenticateApiKey(key.key),{status:401,code:'api_key_invalid'});
  const sql=readFileSync(new URL('../../supabase/migrations/20261017150000_rch_user_api_keys.sql',import.meta.url),'utf8');
  assert.match(sql,/enable row level security/);
  assert.match(sql,/revoke execute.*from public,anon,authenticated/);
  assert.match(sql,/for update/);
  assert.match(sql,/and account_id = v_account returning/);
});
