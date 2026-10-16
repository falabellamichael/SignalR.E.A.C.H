const test=require('node:test'),assert=require('node:assert/strict');
const view=require('../renderer/account-view.js');
const {publicAccount,publicConfig}=require('../agent/hosted-account.cjs');
test('Studio shows native CAD Plus terms and unlimited usage without a fabricated finite allowance',()=>{
 const config=publicConfig({subscription:{basic:{id:'basic-wallet',includedRequests:1500,priceUsdMicros:15000000},overageUsdMicrosPerRequest:10000,plus:{id:'plus',name:'REACH Subscription Plus',currency:'cad',amountMinor:2500,interval:'month',intervalCount:1,taxBehavior:'inclusive',unlimited:true}},cardPayments:true,cardPlans:{basic:false,plus:true}});
 assert.equal(config.subscription.plus.currency,'cad');assert.equal(config.subscription.plus.amountMinor,'2500');assert.equal(config.cardPlans.plus,true);
 const account=publicAccount({plan:{id:'plus',name:'REACH Subscription Plus',status:'active'},requestAllowance:{plusActive:true,unlimited:true,basicActive:false,includedLimit:null,remaining:null,completed:999999,reserved:2,overageUsdMicrosPerRequest:0},allowedModels:[{id:'model',access:'requests',pricing:{unit:'request',unlimited:true,includedRequests:null,usdMicrosPerRequest:0}}],credit:{currency:'USD',balanceMicros:0,reservedMicros:0,debtMicros:0}});
 assert.equal(account.requestAllowance.remaining,null);assert.equal(account.allowedModels[0].pricing.unlimited,true);
 const model=view.derive({status:'connected',account,config,secureStorageAvailable:true});
 assert.equal(model.usable,true);assert.equal(model.plan,'REACH Subscription Plus');assert.equal(model.counts.includedRemaining,'Unlimited');assert.equal(model.counts.totalRemaining,'No overage');assert.match(model.usageSummary,/No monthly request quota/);
 assert.match(view.modelPrice(account.allowedModels[0]),/Unlimited/);
 const expired=view.derive({status:'connected',config,account:{...account,plan:{...account.plan,status:'expired'},requestAllowance:{...account.requestAllowance,plusActive:false,unlimited:false},credit:{...account.credit,balanceMicros:999999}}});
 assert.equal(expired.usable,false);assert.match(expired.plan,/expired/);
});
test('Studio permanent Plus control sends planId plus and follows service and entitlement readiness',async()=>{
 const fs=require('node:fs'),vm=require('node:vm');
 const ids=new Map(),calls=[];let clones=0,notify;
 const element=()=>({value:'',textContent:'',dataset:{},hidden:false,disabled:false,listeners:{},
  addEventListener(type,fn){this.listeners[type]=fn;},setAttribute(){},replaceChildren(){},appendChild(){},
  after(){},cloneNode(){clones++;return element();},
  parentElement:{querySelector(){return {textContent:''};}},
  set id(value){this._id=value;ids.set(value,this);},get id(){return this._id;}});
 const get=id=>{if(!ids.has(id))ids.set(id,element());return ids.get(id);};
 const config={cardPayments:true,cardPlans:{basic:true,plus:true},subscription:{basic:{priceUsdMicros:15000000},plus:{id:'plus',name:'REACH Subscription Plus',currency:'cad',amountMinor:2500,unlimited:true}}};
 let state={status:'connected',secureStorageAvailable:true,config,account:{plan:{status:'none'},allowedModels:[],requestAllowance:{basicActive:false,remaining:0},credit:{currency:'USD',balanceMicros:0,reservedMicros:0,debtMicros:0}}};
 const api={get:async()=>state,onState:fn=>{notify=fn;},subscribe:async(...args)=>{calls.push(args);return {ok:true};}};
 const window={reach:{account:api},ReachAccountView:view,addEventListener(){}};
 const document={getElementById:get,createElement:element,visibilityState:'visible'};
 vm.runInNewContext(fs.readFileSync(require.resolve('../renderer/account.js'),'utf8'),{window,document,setInterval:()=>1,clearInterval(){},console});
 await Promise.resolve();await Promise.resolve();notify(state);notify(state);
 assert.equal(clones,0);const button=get('home-card-subscribe-plus');assert.match(button.textContent,/CAD\s*25\.00/);assert.equal(button.disabled,false);
 assert.match(get('home-card-plan-detail').textContent,/CAD25\.00 per month, tax included/);
 await button.listeners.click();assert.deepEqual(calls,[['stripe','plus']]);
 state={...state,account:{...state.account,plan:{id:'plus',name:'REACH Subscription Plus',status:'active'},requestAllowance:{plusActive:true,unlimited:true,basicActive:false,includedLimit:null,remaining:null,completed:9000,reserved:0,overageUsdMicrosPerRequest:0}}};
 notify(state);assert.equal(get('home-account-plan-status').textContent,'PLUS');assert.match(button.textContent,/is active.*Unlimited/);assert.equal(button.disabled,true);assert.equal(clones,0);
 assert.equal(get('home-card-paypal-note').hidden,true);
 state={...state,account:{...state.account,plan:{id:'plus',status:'expired'},requestAllowance:{plusActive:false,unlimited:false,basicActive:false,remaining:0}}};
 notify(state);assert.equal(get('home-card-manage').hidden,false);assert.equal(button.disabled,false);
 get('home-card-amount').value='20';state={...state,config:{...config,cardPayments:false}};notify(state);
 assert.equal(button.disabled,true);assert.equal(button.hidden,true);assert.equal(get('home-card-subscribe').hidden,true);assert.equal(get('home-card-wallet-topup').hidden,true);
 assert.equal(get('home-card-badge').textContent,'NOT ENABLED');assert.match(get('home-card-status').textContent,/setup is pending/);assert.doesNotMatch(get('home-card-plan-detail').textContent,/Subscribe to Basic/);
 assert.equal(get('home-card-amount').value,'20');
 state={...state,config};notify(state);assert.doesNotMatch(get('home-card-status').textContent,/not enabled/);
 state={...state,account:{...state.account,plan:{id:'basic-wallet',status:'active'},requestAllowance:{basicActive:true,remaining:1500}}};notify(state);assert.equal(button.disabled,true);
 assert.equal(get('home-card-wallet-topup').hidden,false);assert.equal(get('home-card-amount').value,'20');assert.equal(get('home-card-subscribe').hidden,false);
 state={...state,status:'disconnected',account:null};notify(state);assert.equal(get('home-card-badge').textContent,'SIGN IN');assert.equal(button.disabled,true);
 state={...state,status:'connected',config:{...config,cardPlans:{basic:false,plus:false},subscription:{basic:config.subscription.basic}},account:{plan:{status:'none'}}};notify(state);assert.doesNotMatch(get('home-card-plan-detail').textContent,/Basic/);assert.equal(button.hidden,true);assert.equal(get('home-card-subscribe').hidden,true);
 const html=fs.readFileSync(require.resolve('../renderer/index.html'),'utf8');
 assert.equal((html.match(/id="home-card-subscribe-plus"/g)||[]).length,1);
});

test('Studio accepts only the agreed CAD25 monthly inclusive unlimited Plus policy',()=>{
 const plus={id:'plus',name:'REACH Subscription Plus',currency:'cad',amountMinor:2500,interval:'month',intervalCount:1,taxBehavior:'inclusive',unlimited:true};
 const raw={cardPayments:true,cardPlans:{basic:false,plus:true},subscription:{basic:{id:'basic-wallet'},plus}};
 assert.equal(publicConfig(raw).cardPlans.plus,true);
 for(const patch of [{currency:'usd'},{amountMinor:2499},{amountMinor:'2500.0'},{interval:'year'},{intervalCount:2},{taxBehavior:'exclusive'},{unlimited:false}]){
  const result=publicConfig({...raw,subscription:{...raw.subscription,plus:{...plus,...patch}}});
  assert.equal(result.subscription.plus,undefined);assert.equal(result.cardPlans.plus,false);
 }
});

test('Plus checkout uses authenticated REACH checkout and refuses unavailable or mismatched plans without a provider request',async t=>{
 const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
 const {createHostedAccount}=require('../agent/hosted-account.cjs');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'reach-plus-client-'));
 t.after(()=>{assert.equal(path.dirname(dir),os.tmpdir());fs.rmSync(dir,{recursive:true,force:true});});
 const plus={id:'plus',name:'REACH Subscription Plus',currency:'cad',amountMinor:2500,interval:'month',intervalCount:1,taxBehavior:'inclusive',unlimited:true};
 let config={enabled:true,cardPayments:true,cardPlans:{basic:false,plus:true},subscription:{basic:{id:'basic-wallet'},plus}};
 const sent=[],opened=[],fixtureToken='local-fixture-session-never-a-provider-key';
 const account={id:'fixture',walletAddress:'0x0000000000000000000000000000000000000001',plan:{status:'none'}};
 const fetchImpl=async(url,init)=>{
  const route=new URL(url).pathname;
  const body=route==='/v1/account/config'?config:route==='/v1/auth/start'?{flowId:'fixture-flow',loginUrl:'https://reach.test/wallet/connect',expiresAt:new Date(Date.now()+120000).toISOString()}
   :route==='/v1/auth/exchange'?{accessToken:fixtureToken,expiresAt:new Date(Date.now()+3600000).toISOString(),account}
   :route==='/v1/billing/checkout'?(sent.push({body:JSON.parse(init.body),auth:init.headers.Authorization}),{url:'https://checkout.stripe.com/c/pay/cs_test_fixture'})
   :account;
  return {ok:true,status:200,json:async()=>body};
 };
 const manager=createHostedAccount({file:path.join(dir,'account.json'),safeStorage:{isEncryptionAvailable:()=>true,getSelectedStorageBackend:()=> 'fixture-vault',encryptString:value=>Buffer.from(value),decryptString:bytes=>bytes.toString()},fetchImpl,openExternal:async url=>opened.push(url)});
 await manager.configure('https://reach.test');await manager.connect();await manager.poll();
 await manager.subscribe('stripe','plus');assert.deepEqual(sent,[{body:{kind:'subscription',planId:'plus'},auth:'Bearer '+fixtureToken}]);
 assert.equal(opened.at(-1),'https://checkout.stripe.com/c/pay/cs_test_fixture');
 await assert.rejects(manager.subscribe(),/Basic checkout is not enabled/);
 assert.throws(()=>manager.subscribe('paypal','plus'),/supported subscription/);
 config={...config,cardPlans:{basic:false,plus:false}};await manager.refresh();await assert.rejects(manager.subscribe('stripe','plus'),/Plus checkout is not enabled/);
 config={...config,cardPlans:{basic:false,plus:true},subscription:{...config.subscription,plus:{...plus,currency:'usd'}}};await manager.refresh();await assert.rejects(manager.subscribe('stripe','plus'),/Plus checkout is not enabled/);
 config={...config,cardPayments:false,subscription:{...config.subscription,plus}};await manager.refresh();await assert.rejects(manager.subscribe('stripe','plus'),/Card payments are not enabled/);
 assert.equal(sent.length,1);assert.doesNotMatch(JSON.stringify(manager.state()),new RegExp(fixtureToken));
});
