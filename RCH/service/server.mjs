import { createServer } from 'node:http';
import { isIP } from 'node:net';
import { readFileSync } from 'node:fs';
import { getAddress, verifyMessage, hashMessage, Contract, JsonRpcProvider, FetchRequest } from 'ethers';
import { fail, modelUsdPricing } from './store.mjs';
import { createAccountStore } from './account-store.mjs';
import { createModelGateway } from './model-gateway.mjs';
import { createRedemptionService } from './redemption.mjs';
import { createTokenBalanceReader } from './token-balance.mjs';
import { isDelegatedEoaCode } from './treasury-redemption.mjs';

export function signInMessage(origin, chainId, wallet, nonce, issuedAt, expiresAt) {
  return `${new URL(origin).host} wants you to sign in with your Ethereum account:\n${wallet}\n\nConnect to REACH Studio. This signature only signs you in.\n\nURI: ${origin}/wallet/connect\nVersion: 1\nChain ID: ${chainId}\nNonce: ${nonce}\nIssued At: ${issuedAt}\nExpiration Time: ${expiresAt}`;
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
async function readBody(req) {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type']||'')) fail(415,'content_type','Use application/json.');
  let size=0; const chunks=[];
  for await(const chunk of req) { size+=chunk.length; if(size>524288) fail(413,'body_limit','Request is too large.'); chunks.push(chunk); }
  let body; try { body=JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { fail(400,'invalid_json','Invalid JSON body.'); }
  if(!body||typeof body!=='object'||Array.isArray(body)) fail(400,'invalid_body','Supply a JSON object.');return body;
}
const staticAssets = new Map([
  ['/wallet/rch',['text/html; charset=utf-8','../../branding/index.html']],
  ['/wallet/rch-logo.png',['image/png','../../branding/rch-logo.png']],
  ['/wallet/rch-tokenlist.json',['application/json; charset=utf-8','../../branding/tokenlist.json']],
  ['/wallet/rch-add-token.js',['text/javascript; charset=utf-8','../../branding/add-token.js']],
  ['/wallet/connect',['text/html; charset=utf-8','wallet.html']],
  ['/wallet/redeem',['text/html; charset=utf-8','wallet.html']],
  ['/wallet/app.js',['text/javascript; charset=utf-8','wallet.js']],
  ['/wallet/style.css',['text/css; charset=utf-8','wallet.css']],
]);

export function createAccountService({config,store,provider,redemptionProvider,balanceProvider,fetchImpl,now=Date.now}) {
  let ownsStore=false,ownsProvider=false;
  if(!store) { store=createAccountStore(config,{now});ownsStore=true; }
  if(!provider&&config.authRpcUrl) { const request=new FetchRequest(config.authRpcUrl);request.timeout=15000;provider=new JsonRpcProvider(request);ownsProvider=true; }
  const gateway=createModelGateway({store,models:config.models,upstreamUrl:config.upstreamUrl,upstreamKey:config.upstreamKey,fetchImpl});
  const redemption=createRedemptionService({store,config,provider:redemptionProvider});
  const balances=createTokenBalanceReader({config,provider:balanceProvider});
  const buckets=new Map();
  function rateLimit(req) {
    const peer=req.socket.remoteAddress;
    const proxyIp=req.headers['x-reach-client-ip'];
    const key=['127.0.0.1','::1','::ffff:127.0.0.1'].includes(peer)&&typeof proxyIp==='string'&&isIP(proxyIp)?proxyIp:peer||'unknown';
    const time=now(), previous=buckets.get(key);
    if(!previous||previous.expires<=time) {
      if(buckets.size>10000) for(const [k,v]of buckets) if(v.expires<=time)buckets.delete(k);
      if(buckets.size>10000)fail(429,'busy','The service is busy.');
      buckets.set(key,{count:1,expires:time+60000});return;
    }
    if(++previous.count>180)fail(429,'rate_limit','Too many requests. Please wait one minute.');
  }
  const tokensPerRch=redemption.enabled&&redemption.mode!=='treasury'?1000000:null;
  const publicConfig=()=>({enabled:true,serviceOrigin:config.origin,chainId:config.chainId,tokenAddress:config.redemption?.tokenAddress||null,redemptionEnabled:redemption.enabled,redemptionMode:config.redemption?.mode||'burn',treasuryAddress:config.redemption?.treasuryAddress||null,tokensPerRch,redemptionModels:(config.models||[]).filter(m=>m.metered===true&&modelUsdPricing(m,now())).map(m=>({id:m.id,name:m.name,provider:m.provider,pricing:modelUsdPricing(m,now())})),loginMethod:'ethereum-browser-wallet'});
  const accountView=async account=>{
    return {...account,rchBalance:await balances.read(account.walletAddress),redemption:{enabled:redemption.enabled,mode:config.redemption?.mode||'burn',treasuryAddress:config.redemption?.treasuryAddress||null,tokensPerRch,chainId:config.chainId}};
  };
  const server=createServer(async(req,res)=>{
    res.setHeader('cache-control','no-store');res.setHeader('x-content-type-options','nosniff');res.setHeader('referrer-policy','no-referrer');
    res.setHeader('content-security-policy',"default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
    try {
      if(req.headers.origin && req.headers.origin!==config.origin)fail(403,'origin_rejected','This origin is not permitted.');
      // Proxy headers never choose the signature domain or identify a customer.
      const pathname=new URL(req.url,'http://service.invalid').pathname;
      if(req.method==='GET'&&pathname==='/healthz') {json(res,200,{status:'ok',service:'reach-accounts'});return;}
      rateLimit(req);
      const asset=staticAssets.get(pathname);
      if(req.method==='GET'&&asset) {res.writeHead(200,{'content-type':asset[0]});res.end(readFileSync(new URL(`./public/${asset[1]}`,import.meta.url)));return;}
      if(req.method==='GET'&&pathname==='/v1/account/config') {json(res,200,publicConfig());return;}
      const body=req.method==='POST'?await readBody(req):{};
      if(req.method==='POST'&&pathname==='/v1/auth/start') {
        const f=await store.startFlow(body.state,body.codeChallenge);json(res,200,{...f,loginUrl:`${config.origin}/wallet/connect#flow=${f.flowId}`});return;
      }
      if(req.method==='POST'&&pathname==='/v1/auth/challenge') {
        if(typeof body.address!=='string')fail(400,'wallet_required','Select an Ethereum wallet.');
        try{getAddress(body.address);}catch{fail(400,'wallet_invalid','Invalid wallet address.');}
        json(res,200,await store.challenge(body.flowId,body.address,(...args)=>signInMessage(config.origin,config.chainId,...args)));return;
      }
      if(req.method==='POST'&&pathname==='/v1/auth/verify') {
        const c=await store.getChallenge(body.flowId,body.challengeId);
        if(!await verifyWallet(c,body.signature,provider,config.chainId))fail(401,'signature_invalid','The wallet signature does not match this sign-in.');
        await store.authorize(body.flowId,body.challengeId);json(res,200,{status:'verified'});return;
      }
      if(req.method==='POST'&&pathname==='/v1/auth/exchange') {
        // Exchange commits the one-use proof and returns its account snapshot.
        // A second ledger read could fail after commit and strand the session.
        const session=await store.exchange(body.flowId,body.state,body.codeVerifier);json(res,session?200:202,session?{...session,account:await accountView(session.account)}:{status:'pending'});return;
      }
      if(req.method==='POST'&&pathname==='/v1/redemptions/details') {json(res,200,await redemption.details(body.redemptionId,body.ticket));return;}
      if(req.method==='POST'&&pathname==='/v1/redemptions/submit') {json(res,200,await redemption.submit(body.redemptionId,body.ticket,body.txHash));return;}
      const token=/^Bearer (\S+)$/.exec(req.headers.authorization||'')?.[1];
      const account=await store.authenticate(token);
      if(req.method==='GET'&&pathname==='/v1/account') {json(res,200,await accountView(await store.account(account.id)));return;}
      if(req.method==='POST'&&pathname==='/v1/auth/logout') {await store.logout(token);json(res,200,{status:'disconnected'});return;}
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
  return {server,store,redemption,config:publicConfig};
}
