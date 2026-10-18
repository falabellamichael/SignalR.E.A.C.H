import { createServer } from 'node:http';
import { isIP } from 'node:net';
import { readFileSync } from 'node:fs';
import { getAddress, verifyMessage, hashMessage, Contract, JsonRpcProvider, FetchRequest } from 'ethers';
import { fail, digest } from './store.mjs';
import { createAccountStore } from './account-store.mjs';
import { accountAccess } from './eligibility.mjs';
import { createModelGateway } from './model-gateway.mjs';
import { hostedGpuModel, requestCapabilities } from './gpu-bridge.mjs';
import { createRedemptionService } from './redemption.mjs';
import { createTokenBalanceReader } from './token-balance.mjs';
import { isDelegatedEoaCode } from './treasury-redemption.mjs';
import { randomBytes } from 'node:crypto';
import { createResendMailer, createSupabaseOtpMailer, EMAIL_CODE_TTL_MS, emailCode, emailCodeHash, validEmailCode, normalizeEmail } from './email.mjs';
import { createPayPalClient, validPayPalTopUp } from './payments/paypal.mjs';
import { assertPlusPrice, recordPlusInvoice } from './payments/plus.mjs';
import { verifyStripeSignature, paymentFromStripeEvent, reversalFromStripeEvent, checkoutParams, validTopUpAmount, createStripeClient } from './payments/stripe.mjs';

export function signInMessage(origin, chainId, wallet, nonce, issuedAt, expiresAt, pathname = '/wallet/connect') {
  return `${new URL(origin).host} wants you to sign in with your Ethereum account:\n${wallet}\n\nConnect to REACH Studio. This signature only signs you in.\n\nURI: ${origin}${pathname}\nVersion: 1\nChain ID: ${chainId}\nNonce: ${nonce}\nIssued At: ${issuedAt}\nExpiration Time: ${expiresAt}`;
}
export async function verifyWallet(challenge, signature, provider, chainId) {
  if (typeof signature !== 'string' || !/^0x(?:[0-9a-fA-F]{2}){1,8192}$/.test(signature)) return false;
  if (provider) {
    if (Number((await provider.getNetwork()).chainId) !== chainId) fail(503,'wrong_chain','The authentication RPC is on the wrong chain.');
    const code = await provider.getCode(challenge.wallet);
    if (code !== '0x') {
      // EIP-7702 preserves the account's original signing key alongside its code.
      if (isDelegatedEoaCode(code)) {
        try {
          if (getAddress(verifyMessage(challenge.message,signature)) === getAddress(challenge.wallet)) return true;
        } catch { /* Contract signature validation remains available below. */ }
      }
      try {
        const wallet = new Contract(challenge.wallet,['function isValidSignature(bytes32,bytes) view returns (bytes4)'],provider);
        return (await wallet.isValidSignature(hashMessage(challenge.message),signature)).toLowerCase() === '0x1626ba7e';
      } catch { return false; }
    }
  }
  try { return getAddress(verifyMessage(challenge.message,signature)) === getAddress(challenge.wallet); }
  catch { return false; }
}
const json = (res,status,value) => { res.writeHead(status,{'content-type':'application/json; charset=utf-8'}); res.end(JSON.stringify(value)); };
async function readRaw(req) {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type']||'')) fail(415,'content_type','Use application/json.');
  let size=0; const chunks=[];
  for await(const chunk of req) { size+=chunk.length; if(size>524288) fail(413,'body_limit','Request is too large.'); chunks.push(chunk); }
  return Buffer.concat(chunks);
}
const parseObject=raw=>{
  let body; try { body=JSON.parse(raw.toString('utf8')); } catch { fail(400,'invalid_json','Invalid JSON body.'); }
  if(!body||typeof body!=='object'||Array.isArray(body)) fail(400,'invalid_body','Supply a JSON object.');return body;
};
const readBody=async req=>parseObject(await readRaw(req));
const staticAssets = new Map([
  ['/wallet/rch',['text/html; charset=utf-8','../../branding/index.html']],
  ['/wallet/rch-logo.png',['image/png','../../branding/rch-logo.png']],
  ['/wallet/rch-tokenlist.json',['application/json; charset=utf-8','../../branding/tokenlist.json']],
  ['/wallet/rch-add-token.js',['text/javascript; charset=utf-8','../../branding/add-token.js']],
  ['/wallet/connect',['text/html; charset=utf-8','wallet.html']],
  ['/wallet/redeem',['text/html; charset=utf-8','wallet.html']],
  ['/wallet/app.js',['text/javascript; charset=utf-8','wallet.js']],
  ['/wallet/email.js',['text/javascript; charset=utf-8','email.js']],
  ['/wallet/style.css',['text/css; charset=utf-8','wallet.css']],
  ['/billing/return',['text/html; charset=utf-8','billing.html']],
]);

export function createAccountService({config,store,provider,redemptionProvider,balanceProvider,fetchImpl,paymentFetch,paypalFetch,mailer,now=Date.now}) {
  let ownsStore=false,ownsProvider=false;
  if(!store) { store=createAccountStore(config,{now});ownsStore=true; }
  if(!provider&&config.authRpcUrl) { const request=new FetchRequest(config.authRpcUrl);request.timeout=15000;provider=new JsonRpcProvider(request);ownsProvider=true; }
  const gateway=createModelGateway({store,models:config.models,subscription:config.subscription,upstreamUrl:config.upstreamUrl,upstreamKey:config.upstreamKey,fetchImpl});
  const redemption=createRedemptionService({store,config,provider:redemptionProvider});
  const balances=createTokenBalanceReader({config,provider:balanceProvider});
  if(!mailer&&config.email?.resend)mailer=createResendMailer(config.email.resend);
  if(!mailer&&config.supabase)mailer=createSupabaseOtpMailer(config.supabase);
  const supabaseEmail=new Map();
  const stripe=config.payments?.stripe;
  const stripeClient=stripe?createStripeClient({secretKey:stripe.secretKey,...(paymentFetch?{fetchImpl:paymentFetch}:{})}):null;
  const paypal=config.payments?.paypal?createPayPalClient({...config.payments.paypal,now,...(paypalFetch?{fetchImpl:paypalFetch}:{})}):null;
  // Applies what a provider reported; both providers answer their webhook the same way.
  const record=async mapped=>{
    if(!mapped)return{received:true,ignored:'not_reach'};
    // A PayPal subscription's next billing date changes on renewal. A sale
    // already recorded keeps the immutable paid period from its ledger row.
    if(mapped.payment?.provider==='paypal'&&mapped.payment.kind==='subscription_period'){
      const existing=await store.paymentPeriod('paypal',mapped.payment.objectId);
      if(existing)mapped.payment={...mapped.payment,periodEnd:existing.periodEnd};
    }
    const result=mapped.payment?await store.applyPayment(mapped.payment):await store.applyReversal(mapped.reversal);
    if(!result&&mapped.reversal)fail(503,'payment_pending','The original payment is not recorded yet. Retry this notification.');
    return result?{received:true,status:result.status,duplicate:result.duplicate}:{received:true,ignored:'not_reach'};
  };
  const buckets=new Map(),emailSenders=new Map();
  const clientKey=req=>{
    const peer=req.socket.remoteAddress;
    const proxyIp=req.headers['x-reach-client-ip'];
    return ['127.0.0.1','::1','::ffff:127.0.0.1'].includes(peer)&&typeof proxyIp==='string'&&isIP(proxyIp)?proxyIp:peer||'unknown';
  };
  // Ten codes an hour per client, so one client cannot spend the service-wide
  // hourly email allowance and lock everyone else out of email sign-in.
  function emailLimit(req) {
    const key=clientKey(req),time=now(),previous=emailSenders.get(key);
    if(!previous||previous.expires<=time) {
      if(emailSenders.size>10000) for(const [k,v]of emailSenders) if(v.expires<=time)emailSenders.delete(k);
      emailSenders.set(key,{count:1,expires:time+3600000});return;
    }
    if(++previous.count>10)fail(429,'email_rate_limit','Too many codes were requested from this network. Try again in an hour.');
  }
  function rateLimit(req) {
    const key=clientKey(req);
    const time=now(), previous=buckets.get(key);
    if(!previous||previous.expires<=time) {
      if(buckets.size>10000) for(const [k,v]of buckets) if(v.expires<=time)buckets.delete(k);
      if(buckets.size>10000)fail(429,'busy','The service is busy.');
      buckets.set(key,{count:1,expires:time+60000});return;
    }
    if(++previous.count>180)fail(429,'rate_limit','Too many requests. Please wait one minute.');
  }
  const tokensPerRch=redemption.enabled&&redemption.mode!=='treasury'?1000000:null;
  const publicModel=m=>({id:m.id,name:m.name,provider:m.provider,...(m.access==='requests'?{access:'requests',capabilities:requestCapabilities(m),pricing:{unit:'request',includedRequests:config.subscription.basic.includedRequests,usdMicrosPerRequest:config.subscription.overageUsdMicrosPerRequest}}:m.pricing?{pricing:m.pricing}:{})});
  const publicConfig=()=>({enabled:true,serviceOrigin:config.origin,modelsRevision:digest(JSON.stringify(config.models)),chainId:config.chainId,tokenAddress:config.redemption?.tokenAddress||null,redemptionEnabled:redemption.enabled,redemptionMode:config.redemption?.mode||'burn',treasuryAddress:config.redemption?.treasuryAddress||null,tokensPerRch,redemptionModels:(config.models||[]).filter(m=>hostedGpuModel(m)&&m.metered===true&&(m.pricing||m.access==='requests')).map(publicModel),...(config.subscription?{subscription:{basic:{...config.subscription.basic},overageUsdMicrosPerRequest:config.subscription.overageUsdMicrosPerRequest,proEnabled:false,...(config.subscription.plus?{plus:{...config.subscription.plus}}:{})}}:{}),cardPayments:!!stripe,cardPlans:{basic:!!stripe?.basicPriceId,plus:!!stripe?.plusPriceId},paypalPayments:!!paypal,...(paypal?{paypalOrigin:paypal.pageOrigin}:{}),emailLogin:!!mailer,loginMethod:'ethereum-browser-wallet'});
  const accountView=async account=>{
    const access=accountAccess(account);
    if(!access.website)return {id:account.id,email:account.email,walletAddress:null,access};
    // An email-only subscriber has no wallet to read holdings from.
    return {...account,allowedModels:(account.allowedModels||[]).filter(hostedGpuModel),access,rchBalance:account.walletAddress?await balances.read(account.walletAddress):{status:'unconfigured'},redemption:{enabled:redemption.enabled,mode:config.redemption?.mode||'burn',treasuryAddress:config.redemption?.treasuryAddress||null,tokensPerRch,chainId:config.chainId}};
  };
  const server=createServer(async(req,res)=>{
    res.setHeader('cache-control','no-store');res.setHeader('x-content-type-options','nosniff');res.setHeader('referrer-policy','no-referrer');
    res.setHeader('content-security-policy',"default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
    try {
      const loginOrigins=new Set(['http://127.0.0.1:4173','http://localhost:4173','https://signalreach.com','https://www.signalreach.com','https://signalreach.ca','https://www.signalreach.ca','https://falabellamichael.github.io']);
      const origin=req.headers.origin;
      if(origin && origin!==config.origin && !loginOrigins.has(origin))fail(403,'origin_rejected','This origin is not permitted.');
      if(origin && loginOrigins.has(origin)){
        res.setHeader('access-control-allow-origin',origin);
        res.setHeader('vary','Origin');
        res.setHeader('access-control-allow-headers','authorization, content-type, ngrok-skip-browser-warning');
        res.setHeader('access-control-allow-methods','GET, POST, OPTIONS');
      }
      if(req.method==='OPTIONS'){res.writeHead(204);res.end();return;}
      // Proxy headers never choose the signature domain or identify a customer.
      const pathname=new URL(req.url,'http://service.invalid').pathname;
      const token=/^Bearer (\S+)$/.exec(req.headers.authorization||'')?.[1];
      const modelApiKey=token?.startsWith('rch_key_');
      if(modelApiKey && !((req.method==='GET'&&pathname==='/v1/models')||(req.method==='POST'&&pathname==='/v1/chat/completions'))) {
        fail(403,'api_key_scope','API keys can only list models and create chat completions.');
      }
      if(req.method==='GET'&&pathname==='/healthz') {json(res,200,{status:'ok',service:'reach-accounts'});return;}
      rateLimit(req);
      const asset=staticAssets.get(pathname);
      if(req.method==='GET'&&asset) {res.writeHead(200,{'content-type':asset[0]});res.end(readFileSync(new URL(`./public/${asset[1]}`,import.meta.url)));return;}
      if(req.method==='GET'&&pathname==='/v1/account/config') {json(res,200,publicConfig());return;}
      if(req.method==='POST'&&pathname==='/v1/billing/stripe/webhook') {
        // Authenticated by Stripe's signature over the exact bytes received, so
        // the body is verified before it is parsed. No session or origin applies.
        if(!stripe)fail(404,'not_found','Route not found.');
        const raw=await readRaw(req);
        if(!verifyStripeSignature(raw,req.headers['stripe-signature'],stripe.webhookSecret,now()))fail(400,'signature_invalid','The webhook signature is invalid.');
        const event=parseObject(raw),livemode=stripe.mode==='live';
        const plus=await recordPlusInvoice(event,{stripe,subscription:config.subscription,client:stripeClient,store});
        if(plus){json(res,200,plus.ignored?{received:true,ignored:plus.ignored}:{received:true,...plus.result});return;}
        const reversal=reversalFromStripeEvent(event,{livemode});
        if(reversal) {
          if(reversal.ignored){json(res,200,{received:true,ignored:reversal.ignored});return;}
          // Only a REACH Checkout or a REACH invoice can be reversed, and the store
          // still checks the ledger: a refund of anything else is not ours.
          const original=await stripeClient.findOriginal(reversal.paymentIntent);
          if(!original){json(res,200,{received:true,ignored:'not_reach'});return;}
          const plusReversal=typeof store.applyPlusReversal==='function'?await store.applyPlusReversal({objectId:reversal.reversal.objectId,eventId:reversal.reversal.eventId,kind:reversal.reversal.kind,originalObjectId:original.originalObjectId,amountMinor:event.data.object.amount,currency:event.data.object.currency}):null;
          if(plusReversal){json(res,200,{received:true,...plusReversal});return;}
          if(original.planId==='plus')fail(503,'payment_pending','The original Plus invoice is not recorded yet. Retry this notification.');
          if(event.data.object.currency!=='usd'){json(res,200,{received:true,ignored:'not_reach'});return;}
          const {planId:originalPlan,...legacyOriginal}=original;
          const result=await store.applyReversal({...reversal.reversal,...legacyOriginal});
          // Stripe does not guarantee delivery order. Keep an early REACH refund
          // retryable until its original payment is durably recorded.
          if(!result)fail(503,'payment_pending','The original payment is not recorded yet. Retry this notification.');
          json(res,200,{received:true,status:result.status,duplicate:result.duplicate});return;
        }
        const mapped=paymentFromStripeEvent(event,{basicPriceId:stripe.basicPriceId,livemode});
        if(mapped.ignored){json(res,200,{received:true,ignored:mapped.ignored});return;}
        // Recorded outcomes (applied, rejected, expired, superseded) all answer 200
        // so Stripe stops retrying; only a store failure or a conflict asks it to retry.
        const result=await store.applyPayment(mapped.payment);
        json(res,200,{received:true,status:result.status,duplicate:result.duplicate});return;
      }
      if(req.method==='POST'&&pathname==='/v1/billing/paypal/webhook') {
        if(!paypal)fail(404,'not_found','Route not found.');
        const event=parseObject(await readRaw(req));
        if(!await paypal.verifyWebhook(req.headers,event))fail(400,'signature_invalid','The webhook signature is invalid.');
        // Only PayPal's own copy of the object is used, never the event body.
        json(res,200,await record(await paypal.readEvent(event)));return;
      }
      if(req.method==='GET'&&pathname==='/v1/billing/paypal/return') {
        if(!paypal)fail(404,'not_found','Route not found.');
        // The customer lands here after approving a top-up. Capture now so the
        // credit appears at once; if this fails, the order-approved webhook
        // captures it instead. The page is the same either way.
        const orderId=new URL(req.url,'http://service.invalid').searchParams.get('token');
        try { const payment=await paypal.captureOrder(orderId,`paypal-return-${orderId}`);await record(payment&&{payment}); } catch { /* The webhook retries the capture. */ }
        res.writeHead(200,{'content-type':'text/html; charset=utf-8'});res.end(readFileSync(new URL('./public/billing.html',import.meta.url)));return;
      }
      const body=req.method==='POST'?await readBody(req):{};
      if(req.method==='POST'&&pathname==='/v1/auth/start') {
        const f=await store.startFlow(body.state,body.codeChallenge);json(res,200,{...f,loginUrl:`${config.origin}/wallet/connect#flow=${f.flowId}`});return;
      }
      if(req.method==='POST'&&pathname==='/v1/auth/challenge') {
        if(typeof body.address!=='string')fail(400,'wallet_required','Select an Ethereum wallet.');
        try{getAddress(body.address);}catch{fail(400,'wallet_invalid','Invalid wallet address.');}
        // The checked browser Origin binds the wallet message to the sign-in
        // page. Request bodies and proxy headers cannot choose its domain.
        const signInOrigin=origin||config.origin;
        json(res,200,await store.challenge(body.flowId,body.address,(...args)=>signInMessage(signInOrigin,config.chainId,...args,signInOrigin===config.origin?'/wallet/connect':'/login.html')));return;
      }
      if(req.method==='POST'&&pathname==='/v1/auth/verify') {
        const c=await store.getChallenge(body.flowId,body.challengeId);
        if(!await verifyWallet(c,body.signature,provider,config.chainId))fail(401,'signature_invalid','The wallet signature does not match this sign-in.');
        await store.authorize(body.flowId,body.challengeId);json(res,200,{status:'verified'});return;
      }
      if(req.method==='POST'&&pathname==='/v1/auth/email/start') {
        if(!mailer)fail(404,'not_found','Email sign-in is not configured on this service.');
        emailLimit(req);
        if(mailer.kind==='supabase'){
          if(typeof body.flowId!=='string'||!/^[a-f0-9]{64}$/.test(body.flowId))fail(400,'invalid_flow','Invalid sign-in flow.');
          await store.getFlow(body.flowId);
          const email=normalizeEmail(body.email), challengeId=randomBytes(32).toString('hex');
          await mailer.sendSignInCode({to:email});
          supabaseEmail.set(challengeId,{flowId:body.flowId,email,expires:now()+EMAIL_CODE_TTL_MS});
          json(res,200,{challengeId,expiresAt:new Date(now()+EMAIL_CODE_TTL_MS).toISOString()});return;
        }
        // The code is generated here and only its hash is stored. The email is
        // sent after the challenge commits, so a rate-limited request sends nothing.
        const code=emailCode(),challengeId=randomBytes(32).toString('hex');
        const created=await store.createEmailChallenge(body.flowId,body.email,challengeId,emailCodeHash(challengeId,code));
        await mailer.sendSignInCode({to:normalizeEmail(body.email),code,challengeId,host:new URL(config.origin).host});
        json(res,200,created);return;
      }
      if(req.method==='POST'&&pathname==='/v1/auth/email/verify') {
        if(!mailer)fail(404,'not_found','Route not found.');
        if(!validEmailCode(body.code))fail(400,'code_invalid','Enter the 8-digit code from the email.');
        if(typeof body.challengeId!=='string'||!/^[a-f0-9]{64}$/.test(body.challengeId))fail(400,'invalid_challenge','Invalid challenge.');
        if(mailer.kind==='supabase'){
          const pending=supabaseEmail.get(body.challengeId);
          if(!pending||pending.flowId!==body.flowId||pending.expires<=now())fail(410,'code_expired','This code is no longer valid. Request a new one.');
          if(!await mailer.verifyCode({email:pending.email,code:body.code}))fail(401,'code_invalid','That code is not right. Check the email and try again.');
          await store.createEmailChallenge(body.flowId,pending.email,body.challengeId,emailCodeHash(body.challengeId,body.code));
          supabaseEmail.delete(body.challengeId);
        }
        await store.verifyEmailChallenge(body.flowId,body.challengeId,emailCodeHash(body.challengeId,body.code));
        json(res,200,{status:'verified'});return;
      }
      if(req.method==='POST'&&pathname==='/v1/auth/exchange') {
        // Exchange commits the one-use proof and returns its account snapshot.
        // A second ledger read could fail after commit and strand the session.
        const session=await store.exchange(body.flowId,body.state,body.codeVerifier);json(res,session?200:202,session?{...session,account:await accountView(session.account)}:{status:'pending'});return;
      }
      if(req.method==='POST'&&pathname==='/v1/redemptions/details') {json(res,200,await redemption.details(body.redemptionId,body.ticket));return;}
      if(req.method==='POST'&&pathname==='/v1/redemptions/submit') {json(res,200,await redemption.submit(body.redemptionId,body.ticket,body.txHash));return;}
      const account=modelApiKey?await store.authenticateApiKey(token):await store.authenticate(token);
      // Re-evaluate access on every request, including sessions issued before
      // subscription expiry. Only identity linking and checkout are onboarding.
      if(!modelApiKey && !accountAccess(account).website && ![
        '/v1/account','/v1/account/link-wallet','/v1/account/link-email/start',
        '/v1/account/link-email/verify','/v1/billing/checkout','/v1/auth/logout',
        '/v1/account/api-keys/revoke',
      ].includes(pathname))fail(403,'website_access_required','An active subscription or verified connected wallet is required.');
      if(req.method==='POST'&&pathname==='/v1/billing/checkout'&&!accountAccess(account).website&&body.kind!=='subscription')
        fail(403,'website_access_required','Choose a subscription or connect a verified wallet.');
      if(req.method==='GET'&&pathname==='/v1/account/api-keys') {json(res,200,{data:await store.listApiKeys(account.id)});return;}
      if(req.method==='POST'&&pathname==='/v1/account/api-keys') {json(res,201,await store.createApiKey(account.id,body.name));return;}
      if(req.method==='POST'&&pathname==='/v1/account/api-keys/revoke') {json(res,200,await store.revokeApiKey(account.id,body.id));return;}
      if(req.method==='GET'&&pathname==='/v1/account') {json(res,200,await accountView(await store.account(account.id)));return;}
      if(req.method==='POST'&&pathname==='/v1/account/link-wallet') {
        const state=randomBytes(32).toString('base64url'), proof=randomBytes(32).toString('base64url').slice(0,43);
        const flow=await store.startFlow(state, proof);
        await store.bindFlowAccount(flow.flowId, account.id);
        json(res,200,{loginUrl:`${config.origin}/wallet/connect#flow=${flow.flowId}`});return;
      }
      if(req.method==='POST'&&pathname==='/v1/account/link-email/start') {
        if(!mailer)fail(404,'not_found','Email sign-in is not configured on this service.');
        emailLimit(req);
        const state=randomBytes(32).toString('base64url'), proof=randomBytes(32).toString('base64url').slice(0,43);
        const flow=await store.startFlow(state, proof);
        await store.bindFlowAccount(flow.flowId, account.id);
        const challengeId=randomBytes(32).toString('hex');
        if(mailer.kind==='supabase'){
          const email=normalizeEmail(body.email);
          await mailer.sendSignInCode({to:email});
          supabaseEmail.set(challengeId,{flowId:flow.flowId,email,expires:now()+EMAIL_CODE_TTL_MS});
          json(res,200,{challengeId,flowId:flow.flowId,expiresAt:new Date(now()+EMAIL_CODE_TTL_MS).toISOString()});return;
        }
        const code=emailCode();
        const created=await store.createEmailChallenge(flow.flowId, body.email, challengeId, emailCodeHash(challengeId, code));
        await mailer.sendSignInCode({to:normalizeEmail(body.email), code, challengeId, host:new URL(config.origin).host});
        json(res,200,{...created, flowId:flow.flowId});return;
      }
      if(req.method==='POST'&&pathname==='/v1/account/link-email/verify') {
        if(!mailer)fail(404,'not_found','Email sign-in is not configured on this service.');
        if(!validEmailCode(body.code))fail(400,'code_invalid','Enter the 8-digit code from the email.');
        const flow=await store.getFlow(body.flowId);
        if(flow.account_id!==account.id)fail(403,'origin_rejected','This sign-in does not belong to the connected account.');
        if(mailer.kind==='supabase'){
          const pending=supabaseEmail.get(body.challengeId);
          if(!pending||pending.flowId!==body.flowId||pending.expires<=now())fail(410,'code_expired','This code is no longer valid. Request a new one.');
          if(!await mailer.verifyCode({email:pending.email,code:body.code}))fail(401,'code_invalid','That code is not right. Check the email and try again.');
          await store.createEmailChallenge(body.flowId,pending.email,body.challengeId,emailCodeHash(body.challengeId,body.code));
          supabaseEmail.delete(body.challengeId);
        }
        await store.verifyEmailChallenge(body.flowId, body.challengeId, emailCodeHash(body.challengeId, body.code));
        json(res,200,await accountView(await store.account(account.id)));return;
      }
      if(req.method==='POST'&&pathname==='/v1/auth/logout') {await store.logout(token);json(res,200,{status:'disconnected'});return;}
      if(req.method==='POST'&&pathname==='/v1/billing/checkout') {
        const viaPayPal=body.provider==='paypal';
        const planId=body.planId??'basic';
        if(!['basic','plus'].includes(planId)||planId==='plus'&&(viaPayPal||body.kind!=='subscription'))fail(400,'invalid_checkout','Choose a supported subscription plan.');
        if(body.provider!==undefined&&!['stripe','paypal'].includes(body.provider))fail(400,'invalid_checkout','Choose card or PayPal.');
        if(viaPayPal?!paypal:!stripeClient)fail(503,'payments_unconfigured',viaPayPal?'PayPal is not configured on this service.':'Card payments are not configured on this service.');
        if(body.kind==='subscription') {
          // Renewals bill automatically; a second checkout would charge twice.
          if(account.plan?.status==='active')fail(409,'plan_active','A plan is already active on this account.');
          if(!viaPayPal){
            const priceId=planId==='plus'?stripe?.plusPriceId:stripe?.basicPriceId;
            if(!priceId)fail(503,'payments_unconfigured','This card subscription is not enabled on the service.');
            if(planId==='plus')assertPlusPrice(await stripeClient.readPrice(priceId),{priceId,policy:config.subscription?.plus,livemode:stripe.mode==='live'});
          }
        } else if(body.kind==='top_up') {
          if(!(viaPayPal?validPayPalTopUp:validTopUpAmount)(body.amountUsdMicros))fail(400,'invalid_amount','Choose a whole-cent top-up between $1 and $500.');
        } else fail(400,'invalid_checkout','Choose a subscription or a top-up.');
        if(viaPayPal){
          let intent=body.kind==='subscription'?await store.reserveSubscriptionCheckout(account.id,digest(JSON.stringify(['paypal',config.payments.paypal.mode,config.payments.paypal.basicPlanId,config.origin]))):null;
          let page;
          if(intent?.providerObjectId){
            const previous=await paypal.readCheckout(intent.providerObjectId,account.id);
            if(previous.replaceable){
              intent=await store.reserveSubscriptionCheckout(account.id,digest(JSON.stringify(['paypal',config.payments.paypal.mode,config.payments.paypal.basicPlanId,config.origin])),intent.id);
            } else page=previous;
          }
          if(!page){
            // PayPal retains create-subscription keys for 72 hours. An unknown
            // earlier result cannot be retried after that window without risking
            // another subscription. Known IDs are always read, never recreated.
            if(intent&&!intent.providerObjectId&&now()>=intent.expiresAt+71*3600000)fail(409,'checkout_pending','The earlier PayPal checkout requires reconciliation. Contact support.');
            page=await paypal.createCheckout({kind:body.kind,amountUsdMicros:body.amountUsdMicros,accountId:account.id,origin:config.origin},intent?{idempotencyKey:`rch-${intent.id.slice(0,32)}`}:{ });
            if(intent)await store.attachSubscriptionCheckout(account.id,intent.id,page.subscriptionId);
          }
          json(res,200,{url:page.url,expiresAt:page.expiresAt});return;
        }
        const fingerprint=digest(JSON.stringify([config.origin,planId==='plus'?stripe.plusPriceId:stripe.basicPriceId]));
        const previous=body.kind==='subscription'&&config.subscription?.plus?await store.subscriptionCheckout(account.id):null;
        let checkout;
        if(previous&&previous.expiresAt<=now()) {
          if(!previous.providerObjectId)fail(409,'checkout_pending','The earlier checkout has no stored provider reference and requires reconciliation. Contact support.');
          if(!/^cs_[A-Za-z0-9_]+$/.test(previous.providerObjectId))fail(409,'checkout_pending','The earlier provider checkout requires reconciliation before a card subscription can start. Contact support.');
          if(!await stripeClient.canReplaceCheckoutSession(previous.providerObjectId,now()))fail(409,'checkout_pending','The earlier subscription checkout is still awaiting confirmation. Refresh your account or contact support.');
          checkout=await store.reserveSubscriptionCheckout(account.id,fingerprint,previous.id);
        } else checkout=body.kind==='subscription'?await store.reserveSubscriptionCheckout(account.id,fingerprint):null;
        const create=()=>stripeClient.createCheckoutSession(checkoutParams({kind:body.kind,amountUsdMicros:body.amountUsdMicros,accountId:account.id,basicPriceId:stripe.basicPriceId,plusPriceId:stripe.plusPriceId,planId,checkoutId:checkout?.id,origin:config.origin,nowMs:checkout?checkout.expiresAt-3600000:now()}),checkout?{idempotencyKey:`reach-subscription-${checkout.id}`}:{ });
        let page=await create();
        if(checkout&&checkout.expiresAt<=now()) {
          if(!await stripeClient.canReplaceCheckoutSession(page.sessionId,now()))fail(409,'checkout_pending','The earlier subscription checkout is still awaiting confirmation. Refresh your account or contact support.');
          checkout=await store.reserveSubscriptionCheckout(account.id,fingerprint,checkout.id);
          page=await create();
        }
        if(checkout)await store.attachSubscriptionCheckout(account.id,checkout.id,page.sessionId);
        json(res,200,{url:page.url,expiresAt:page.expiresAt});return;

      }
      if(req.method==='POST'&&pathname==='/v1/billing/portal') {
        if(!stripeClient)fail(503,'payments_unconfigured','Card payments are not configured on this service.');
        const customerId=account.plan?.id==='plus'?await store.plusPortalCustomer(account.id):undefined;
        json(res,200,await stripeClient.createPortalSession({accountId:account.id,customerId,returnUrl:`${config.origin}/billing/return?portal=closed`}));return;
      }
      if(req.method==='GET'&&pathname==='/v1/billing/payments') {json(res,200,{data:await store.listPayments(account.id),reversals:await store.listReversals(account.id)});return;}
      if(req.method==='POST'&&pathname==='/v1/redemptions/start'&&!account.walletAddress)fail(409,'wallet_required','RCH redemption needs an account signed in with a wallet.');
      if(req.method==='POST'&&pathname==='/v1/redemptions/start') {json(res,200,await redemption.start(account,body.amountRch));return;}
      if(pathname==='/v1/models'||pathname==='/v1/chat/completions') {await gateway.handle(req,res,account,body);return;}
      fail(404,'not_found','Route not found.');
    } catch(error) {
      if(res.headersSent) {res.destroy();return;}
      const safe=Number.isInteger(error?.status)&&error.status>=400&&error.status<600&&/^[a-z_]{1,80}$/.test(error?.code);
      json(res,safe?error.status:500,{error:{code:safe?error.code:'service_error',message:safe?error.message:'The service could not complete this request.'}});
    }
  });
  server.requestTimeout=30000;server.headersTimeout=15000;
  let reconciling=false;
  const tick=async()=>{if(reconciling)return;reconciling=true;try{await store.pruneExpiredAuthentication();await redemption.reconcile();}catch{/* Retain durable pending intents for the next pass. */}finally{reconciling=false;}};
  const timer=setInterval(tick,30000);timer.unref();
  server.once('listening',tick);
  server.once('close',()=>{clearInterval(timer);redemption.close();balances.close();if(ownsProvider)provider.destroy();if(ownsStore)Promise.resolve().then(()=>store.close()).catch(()=>{});});
  const updateModels = models => {
    const next = structuredClone(models);
    gateway.replaceModels(next); // validate before touching either live catalog
    config.models = next;
    store.models = next;
  };
  return {server,store,redemption,config:publicConfig,updateModels};
}
