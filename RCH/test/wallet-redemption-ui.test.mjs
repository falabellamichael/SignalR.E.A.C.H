import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';

const source = await readFile(new URL('../service/public/wallet.js', import.meta.url), 'utf8');
const walletAddress = '0x' + '11'.repeat(20), treasuryAddress = '0x' + '22'.repeat(20);
const tokenAddress = '0x' + '33'.repeat(20), contractAddress = '0x' + '44'.repeat(20);
const approvalHash = '0x' + 'aa'.repeat(32), redemptionHash = '0x' + 'bb'.repeat(32);
const approval = { to: tokenAddress, data: '0xapprove-exact-amount', value: '0x0', chainId: '0x1' };
const redeem = { to: contractAddress, data: '0xredeem-signed-quote', value: '0x0', chainId: '0x1' };

async function fixture(changes = {}, options = {}) {
  const elements = new Map(), sent = [], submitted = [], calls = [], requests = [], timers = new Map();
  const saved = new Map(options.saved || []);
  let receipt = null, callsStatus = null, timerId = 0, blocks = {};
  let details = { mode: 'treasury', status: 'created', walletAddress, treasuryAddress, chainId: 1,
    amountRch: '10', creditUsdMicros: 300, expiresAt: new Date(Date.now() + 600000).toISOString(),
    quote: { source: 'Verified market quote', observedAt: new Date().toISOString() }, approvalTransaction: approval, transaction: null, ...changes };
  const element = id => {
    if (!elements.has(id)) elements.set(id, { hidden: false, disabled: false, value: '', textContent: '',
      events: {}, addEventListener(name, callback) { this.events[name] = callback; } });
    return elements.get(id);
  };
  const ethereum = { request: async ({ method, params }) => {
    requests.push({method,params});
    if (method === 'eth_chainId') return '0x1';
    if (method === 'eth_requestAccounts') return [walletAddress];
    if (method === 'wallet_getCapabilities') {
      if(options.capabilityError)throw options.capabilityError;
      return {'0x1': {atomic:{status:options.atomic || 'unsupported'}}};
    }
    if (method === 'wallet_sendCalls') {
      calls.push(params[0]);
      if(options.sendCallsError)throw options.sendCallsError;
      return options.sendCallsResult || {id:params[0].id};
    }
    if (method === 'wallet_getCallsStatus') return callsStatus || {id:params[0],chainId:'0x1',status:100};
    if (method === 'eth_getTransactionReceipt') return receipt;
    if (method === 'eth_getBlockByNumber') return blocks[params[0]] || null;
    if (method === 'eth_sendTransaction') { sent.push(params[0]); return params[0].to === tokenAddress ? approvalHash : redemptionHash; }
    throw new Error('Unexpected wallet method ' + method);
  } };
  const context = vm.createContext({ document: { getElementById: element }, window: { ethereum },
    location: { pathname: '/wallet/redeem', hash: '#id=fixture&ticket=fixture', origin: 'https://reach.example' },
    sessionStorage: { getItem: key => saved.get(key), setItem: (key, value) => saved.set(key, value), removeItem: key => saved.delete(key) },
    URLSearchParams, TextEncoder, Date, console, crypto:webcrypto,
    setTimeout: callback => { timers.set(++timerId,callback);return timerId; }, clearTimeout:id => timers.delete(id),
    fetch: async (path, options) => {
      if (path.endsWith('/config')) return { ok: true, json: async () => ({ chainId: 1, redemptionMode: 'treasury' }) };
      if (path.endsWith('/details')) return { ok: true, json: async () => ({ ...details }) };
      if (path.endsWith('/submit')) { submitted.push(JSON.parse(options.body)); return { ok: true, json: async () => ({ status: 'pending', reason: 'awaiting_finality' }) }; }
      throw new Error('Unexpected API ' + path);
    } });
  vm.runInContext(source, context);
  await new Promise(resolve => setImmediate(resolve));
  return { element, sent, submitted, saved, calls, requests, timers, click: () => element('primary').events.click(), recover: () => element('recover').events.click(),
    update: value => { details = { ...details, ...value }; }, confirm: value => { receipt = value; },
    callsConfirm: value => { callsStatus = value; }, setBlocks: value => { blocks=value; },
    poll: async () => { const next=timers.entries().next().value;if(next){timers.delete(next[0]);await next[1]();} } };
}

test('treasury redemption shows exact subcent USD credit and requires separate approval and redemption', async () => {
  const f = await fixture();
  assert.match(f.element('amount').textContent, /10 RCH → US\$0\.0003 AI credit/);
  assert.equal(f.element('treasury').textContent, treasuryAddress);
  assert.equal(f.element('primary').textContent, 'Approve 10 RCH');
  await f.click();
  assert.equal(f.sent.length, 1); assert.equal(f.sent[0].to, tokenAddress); assert.equal(f.submitted.length, 0);
  assert.equal(f.element('primary').textContent, 'Check RCH approval');
  await f.click(); assert.equal(f.sent.length, 1); assert.match(f.element('status').textContent, /pending/);
  f.confirm({ status: '0x1' }); f.update({ approvalTransaction: null, transaction: redeem });
  await f.click(); assert.equal(f.sent.length, 1, 'approval confirmation never broadcasts a redemption');
  assert.equal(f.element('primary').textContent, 'Redeem RCH for AI credit');
  await f.click(); assert.equal(f.sent.length, 2); assert.equal(f.sent[1].to, contractAddress);
  assert.equal(f.submitted[0].txHash, redemptionHash); assert.equal(f.element('primary').disabled, true);
});

test('failed approval does not submit redemption and can be retried', async () => {
  const f = await fixture(); await f.click(); f.confirm({ status: '0x0' }); await f.click();
  assert.equal(f.sent.length, 1); assert.equal(f.submitted.length, 0);
  assert.equal(f.element('primary').textContent, 'Approve 10 RCH');
  assert.match(f.element('approval-status').textContent, /failed/);
});

test('changed credit requires another review before opening the wallet', async () => {
  const f = await fixture(); f.update({ creditUsdMicros: 250 }); await f.click();
  assert.equal(f.sent.length, 0); assert.match(f.element('status').textContent, /quote changed/);
  assert.match(f.element('amount').textContent, /US\$0\.00025/);
  await f.click(); assert.equal(f.sent.length, 1);
});

test('missing market evidence, expired quotes and legacy mainnet burns never open a transaction', async () => {
  for (const change of [{ creditUsdMicros: 0 }, { creditUsdMicros: 0.5 }, { treasuryAddress: '' },
    { quote: { source: '', observedAt: new Date().toISOString() } }, { expiresAt: new Date(Date.now() - 1000).toISOString() },
    { mode: 'legacy', approvalTransaction: null, transaction: redeem, usageTokens: 1000000 }]) {
    const f = await fixture(change); assert.equal(f.element('primary').disabled, true);
    await f.click(); assert.equal(f.sent.length, 0);
  }
});

test('reload restores a broadcast transaction hash and prevents a second wallet transaction', async () => {
  const f = await fixture({ approvalTransaction: null, transaction: redeem });
  await f.click();
  assert.equal(f.saved.get('reach-redemption-transaction:fixture'), redemptionHash);
  // The server may still return an unsigned intent if the page lost connectivity
  // immediately after broadcast. The local recovery hash must take precedence.
  const restored = await fixture({ approvalTransaction: null, transaction: redeem }, { saved: [...f.saved] });
  assert.equal(restored.element('txHash').value, redemptionHash);
  assert.equal(restored.element('primary').disabled, true);
  assert.match(restored.element('status').textContent, /saved below/);
  await restored.click(); assert.equal(restored.sent.length, 0);
  await restored.recover(); assert.equal(restored.submitted[0].txHash, redemptionHash);
});

const confirmedCalls = (id,hash,extra={}) => ({version:'2.0.0',id,chainId:'0x1',status:200,atomic:true,
  receipts:[{status:'0x1',transactionHash:hash,blockHash:'0x'+'cc'.repeat(32),blockNumber:'0x123',logs:[]}],...extra});

test('delegated smart wallet uses separate call IDs and only submits the mined redemption transaction hash', async () => {
  const f=await fixture({walletMode:'eip7702'},{atomic:'supported'});
  await f.click();
  assert.equal(f.calls.length,1);assert.equal(f.sent.length,0);assert.equal(f.submitted.length,0);
  assert.equal(f.calls[0].version,'2.0.0');assert.equal(f.calls[0].calls.length,1);
  assert.equal(f.calls[0].calls[0].to,tokenAddress);assert.equal(f.calls[0].atomicRequired,true);
  await f.poll();assert.equal(f.calls.length,1);assert.match(f.element('status').textContent,/pending/);
  f.callsConfirm(confirmedCalls(f.calls[0].id,approvalHash));f.confirm({status:'0x1'});
  f.update({approvalTransaction:null,transaction:redeem});await f.poll();
  assert.equal(f.calls.length,1,'approval status cannot dispatch redemption');
  assert.equal(f.element('primary').textContent,'Redeem RCH for AI credit');
  await f.click();assert.equal(f.calls.length,2);assert.equal(f.calls[1].calls[0].to,contractAddress);
  assert.equal(f.submitted.length,0,'a call ID must never be submitted as a transaction hash');
  f.callsConfirm(confirmedCalls(f.calls[1].id,redemptionHash));await f.poll();
  assert.equal(f.submitted[0].txHash,redemptionHash);assert.equal(f.sent.length,0);
});

test('smart call recovery survives reload and quote expiry without a second send', async () => {
  const f=await fixture({walletMode:'eip7702',approvalTransaction:null,transaction:redeem},{atomic:'supported'});
  await f.click();const saved=[...f.saved],id=f.calls[0].id;
  const restored=await fixture({walletMode:'eip7702',approvalTransaction:null,transaction:null,expiresAt:new Date(Date.now()-1000).toISOString()},
    {atomic:'supported',saved});
  assert.equal(restored.element('primary').disabled,false,'expired quotes still permit status reads');
  restored.callsConfirm(confirmedCalls(id,redemptionHash));await restored.poll();
  assert.equal(restored.submitted[0].txHash,redemptionHash);assert.equal(restored.calls.length,0);assert.equal(restored.sent.length,0);
});

test('uncertain smart call send never falls back or resubmits, including after reload', async () => {
  const f=await fixture({walletMode:'eip7702'},{atomic:'supported',sendCallsError:{code:-32000,message:'Disconnected'}});
  await f.click();assert.equal(f.calls.length,1);assert.equal(f.sent.length,0);
  assert.match(f.element('status').textContent,/outcome is uncertain/);
  await f.click();assert.equal(f.calls.length,1);assert.equal(f.sent.length,0);
  const restored=await fixture({walletMode:'eip7702'},{atomic:'supported',saved:[...f.saved]});
  await restored.click();assert.equal(restored.calls.length,0);assert.equal(restored.sent.length,0);
});

test('wallet capabilities cannot silently upgrade a plain wallet or downgrade a delegated wallet', async () => {
  const plain=await fixture({walletMode:'eoa'},{atomic:'ready'});await plain.click();
  assert.equal(plain.sent.length,1);assert.equal(plain.calls.length,0);
  for(const options of [{atomic:'ready'},{atomic:'unsupported'},{capabilityError:{code:-32601,message:'Unsupported'}}]){
    const smart=await fixture({walletMode:'eip7702'},options);await smart.click();
    assert.equal(smart.sent.length,0);assert.equal(smart.calls.length,0);
  }
});

test('mismatched chain, call ID, failed status and incomplete receipts never credit or resend', async () => {
  for(const change of [{chainId:'0x2'},{id:'different-batch'},{status:500},{status:600},{atomic:false},
    {receipts:[]},{receipts:[{status:'0x1',transactionHash:redemptionHash}]}]){
    const f=await fixture({walletMode:'eip7702',approvalTransaction:null,transaction:redeem},{atomic:'supported'});
    await f.click();f.callsConfirm(confirmedCalls(f.calls[0].id,redemptionHash,change));await f.click();
    assert.equal(f.submitted.length,0);assert.equal(f.calls.length,1);assert.equal(f.sent.length,0);
    assert(f.saved.has('reach-redemption-wallet-request:fixture'));
  }
});

test('a hash-shaped return from wallet_sendCalls remains a call ID until receipts confirm it', async () => {
  const callId='0x'+'dd'.repeat(32);
  const f=await fixture({walletMode:'eip7702',approvalTransaction:null,transaction:redeem},{atomic:'supported',sendCallsResult:callId});
  await f.click();assert.equal(f.submitted.length,0);
  assert.equal(JSON.parse(f.saved.get('reach-redemption-wallet-request:fixture')).id,callId);
  f.callsConfirm(confirmedCalls(callId,redemptionHash));await f.click();
  assert.equal(f.submitted[0].txHash,redemptionHash);
});

test('terminal offchain failure allows a new explicit review without automatically resending', async () => {
  const f=await fixture({walletMode:'eip7702'},{atomic:'supported'});await f.click();
  f.callsConfirm({id:f.calls[0].id,chainId:'0x1',status:400,receipts:[]});await f.click();
  assert.equal(f.calls.length,1);assert.equal(f.saved.has('reach-redemption-wallet-request:fixture'),false);
  assert.equal(f.element('primary').textContent,'Approve 10 RCH');assert.match(f.element('status').textContent,/failed without redeeming/);
  await f.click();assert.equal(f.calls.length,2);assert.equal(f.sent.length,0);
});

test('terminal onchain failure only permits explicit retry after independently verified final failure', async () => {
  const f=await fixture({walletMode:'eip7702'},{atomic:'supported'});await f.click();
  const failed={status:'0x0',transactionHash:approvalHash,blockHash:'0x'+'cc'.repeat(32),blockNumber:'0x123'};
  f.callsConfirm({id:f.calls[0].id,chainId:'0x1',status:500,receipts:[failed]});f.confirm(failed);
  f.setBlocks({'0x123':{hash:failed.blockHash,number:'0x123'},finalized:{hash:'0x'+'ee'.repeat(32),number:'0x122'}});
  await f.click();assert(f.saved.has('reach-redemption-wallet-request:fixture'));assert.equal(f.calls.length,1);
  f.setBlocks({'0x123':{hash:failed.blockHash,number:'0x123'},finalized:{hash:failed.blockHash,number:'0x123'}});
  await f.click();assert.equal(f.saved.has('reach-redemption-wallet-request:fixture'),false);assert.equal(f.calls.length,1);
  await f.click();assert.equal(f.calls.length,2);
});

test('known pre-submission call rejection permits review again while duplicate or unknown writes stay guarded', async () => {
  for(const code of [4001,-32601,-32602,4100,4200,5700,5710,5740,5750,5760]) {
    const f=await fixture({walletMode:'eip7702'},{atomic:'supported',sendCallsError:{code,message:'Rejected'}});
    await f.click();assert.equal(f.calls.length,1);assert.equal(f.sent.length,0);
    assert.equal(f.saved.has('reach-redemption-wallet-request:fixture'),false,'known code '+code);
    assert.equal(f.element('primary').disabled,false);
  }
  for(const code of [5720,-32000,-32603]) {
    const f=await fixture({walletMode:'eip7702'},{atomic:'supported',sendCallsError:{code,message:'Unknown outcome'}});
    await f.click();await f.click();assert.equal(f.calls.length,1);assert.equal(f.sent.length,0);
    assert(f.saved.has('reach-redemption-wallet-request:fixture'),'unknown code '+code);
  }
});
