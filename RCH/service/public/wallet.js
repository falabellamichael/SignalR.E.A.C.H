'use strict';
const $ = id => document.getElementById(id);
const params = new URLSearchParams(location.hash.slice(1));
const redeemMode = location.pathname === '/wallet/redeem';
const flowId = params.get('flow');
const redemptionId = params.get('id'), ticket = params.get('ticket');
let busy = false;
let challenge = null, selectedAddress = null, redemption = null, config = null;
let approvalHash = null;
const approvalStorageKey = 'reach-redemption-approval:' + redemptionId;
let submittedHash = null;
const submittedStorageKey = 'reach-redemption-transaction:' + redemptionId;
const transactionHash = value => /^0x[0-9a-f]{64}$/i.test(value || '') ? value : null;
const pendingStorageKey = 'reach-redemption-wallet-request:' + redemptionId;
const callsId = value => typeof value === 'string' && value.length > 0 && value.length <= 8194 && !/[\u0000-\u001f]/.test(value) ? value : null;
let pendingOperation = null, callPollTimer = null, callPolls = 0;
try {
  approvalHash = transactionHash(sessionStorage.getItem(approvalStorageKey));
  submittedHash = transactionHash(sessionStorage.getItem(submittedStorageKey));
  const pending = JSON.parse(sessionStorage.getItem(pendingStorageKey) || 'null');
  if(pending && ['approval','redemption'].includes(pending.kind) && ['calls','transaction'].includes(pending.method)
    && /^0x[0-9a-f]+$/i.test(pending.chainId || '') && /^0x[0-9a-f]{40}$/i.test(pending.from || '')
    && /^0x[0-9a-f]{40}$/i.test(pending.to || '') && (pending.method==='transaction' || callsId(pending.id))) pendingOperation=pending;
} catch { /* Hashes can still be recovered from the wallet. */ }
$('origin').textContent = location.origin;
async function api(path, body) {
  const response = await fetch(path, { method: body ? 'POST' : 'GET', credentials:'omit', redirect:'error',
    headers: {'ngrok-skip-browser-warning':'1', ...(body ? {'Content-Type':'application/json'} : {})},
    ...(body ? {body:JSON.stringify(body)} : {}) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error?.message || 'REACH could not complete this request.');
  return data;
}
const status = message => { $('status').textContent=message; };
async function wallet(chainId, expectedAddress) {
  if (!window.ethereum?.request) throw new Error('Open this page in a browser with an Ethereum wallet extension.');
  const chain = '0x'+Number(chainId).toString(16);
  if ((await window.ethereum.request({method:'eth_chainId'})).toLowerCase() !== chain) {
    await window.ethereum.request({method:'wallet_switchEthereumChain',params:[{chainId:chain}]});
  }
  const accounts = await window.ethereum.request({method:'eth_requestAccounts'});
  if (!/^0x[0-9a-f]{40}$/i.test(accounts?.[0]||'')) throw new Error('Choose an Ethereum account.');
  if (expectedAddress && accounts[0].toLowerCase() !== expectedAddress.toLowerCase()) throw new Error('Select the wallet shown for this redemption.');
  return accounts[0];
}
const formatUsd = value => {
  const micros = BigInt(value), fraction = (micros % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '').padEnd(2, '0');
  return 'US$' + (micros / 1_000_000n).toLocaleString() + '.' + fraction;
};
const treasuryMode = value => value?.mode === 'treasury';
const quoteIdentity = value => JSON.stringify([value?.mode, value?.amountRch, value?.creditUsdMicros,
  value?.treasuryAddress, value?.expiresAt, value?.walletAddress, value?.chainId]);
function safeQuote(value) {
  if (!treasuryMode(value)) return value?.chainId !== 1;
  const observed = Date.parse(value.quote?.observedAt), expires = Date.parse(value.expiresAt);
  return Number.isSafeInteger(value.creditUsdMicros) && value.creditUsdMicros > 0
    && /^0x[0-9a-f]{40}$/i.test(value.treasuryAddress || '')
    && typeof value.quote?.source === 'string' && value.quote.source.trim().length > 0
    && Number.isFinite(observed) && observed <= Date.now() + 30_000
    && Number.isFinite(expires) && expires > Date.now();
}
function canAct(value) {
  return !!value && value.status !== 'credited' && (pendingOperation || approvalHash
    || !value.txHash && !submittedHash && safeQuote(value) && (!!value.approvalTransaction || !!value.transaction));
}
function renderRedemption(value) {
  redemption=value;$('details').hidden=false;$('recovery').hidden=value.status==='credited';
  $('address').textContent=value.walletAddress;
  const treasury = treasuryMode(value);
  $('quote-details').hidden=!treasury;
  $('amount').textContent=treasury
    ? `${value.amountRch} RCH → ${Number.isSafeInteger(value.creditUsdMicros) && value.creditUsdMicros > 0 ? formatUsd(value.creditUsdMicros) : 'Unavailable'} AI credit`
    : `${value.amountRch} RCH → ${Number(value.usageTokens).toLocaleString()} AI usage tokens`;
  $('primary').textContent=pendingOperation ? pendingOperation.kind==='approval'?'Check RCH approval':'Check redemption' : treasury
    ? approvalHash ? 'Check RCH approval' : value.approvalTransaction ? `Approve ${value.amountRch} RCH` : 'Redeem RCH for AI credit'
    : 'Burn RCH for usage credit';
  $('primary').disabled=busy||!canAct(value);
  if(treasury) {
    $('treasury').textContent=value.treasuryAddress || 'Unavailable';
    const observed=Date.parse(value.quote?.observedAt), expires=Date.parse(value.expiresAt);
    $('quote-source').textContent=[value.quote?.source, Number.isFinite(observed)?'Observed '+new Date(observed).toLocaleString():'Quote time unavailable'].filter(Boolean).join(' · ');
    $('quote-expiry').textContent=Number.isFinite(expires)?'Quote expires '+new Date(expires).toLocaleString()+'.':'Quote expiry unavailable.';
    $('notice').textContent='Redemption transfers the quoted RCH amount to the treasury shown above. Approval permits that amount; the separate redemption transaction adds the quoted US dollar credit after Ethereum finality. Each transaction requires network gas.';
  }
  if(value.txHash || submittedHash)$('txHash').value=value.txHash || submittedHash;
  if(value.status==='credited') {
    submittedHash=null;
    clearPending();
    try { sessionStorage.removeItem(submittedStorageKey); } catch { /* Optional recovery cache. */ }
  }
  const reasons={already_submitted:'Transaction submitted. REACH is checking finality.',intent_expired:'This signing request expired. You can still recover a transaction that was already sent.'};
  status(value.status==='credited'?'AI credit confirmed. Return to Studio and refresh your account.':pendingOperation
    ?'A wallet request is pending. Check its status before starting another transaction.' :submittedHash&&!value.txHash
    ?'Your redemption transaction is saved below. Choose “Check transaction” to resume credit verification.'
    :value.message||reasons[value.signingUnavailableReason]
    ||(!safeQuote(value)?'A valid, unexpired market quote is required. Start a new redemption from Studio.'
      :treasury?'Review the RCH amount, US dollar credit, treasury, and expiry before continuing.':'Review the amount. Your wallet will request approval for a permanent token burn.'));
}
function savePending(value) {
  // Persist before opening the wallet so reloads never turn an uncertain request
  // into a second write. A call ID is not an Ethereum transaction hash.
  sessionStorage.setItem(pendingStorageKey,JSON.stringify(value));pendingOperation=value;
}
function clearPending() {
  pendingOperation=null;
  try { sessionStorage.removeItem(pendingStorageKey); } catch { /* A stale recovery entry remains safe. */ }
  if(callPollTimer)clearTimeout(callPollTimer);callPollTimer=null;
}
function queueCallPoll() {
  if(callPollTimer || pendingOperation?.method!=='calls' || callPolls>=20)return;
  callPollTimer=setTimeout(async()=>{
    callPollTimer=null;
    if(busy){queueCallPoll();return;}
    busy=true;$('primary').disabled=true;callPolls++;
    try { await checkPendingOperation(); }
    catch { status('Wallet status is temporarily unavailable. Your request is saved; use “Check” to resume.'); }
    finally {busy=false;$('primary').disabled=!canAct(redemption);}
  },3000);
}
async function sendWalletTransaction(value,address,transaction,kind) {
  let capabilities;
  try { capabilities=await window.ethereum.request({method:'wallet_getCapabilities',params:[address,[transaction.chainId]]}); }
  catch(error) {
    if(![-32601,4200].includes(Number(error.code)))throw error;
    capabilities={};
  }
  const atomic=capabilities?.[transaction.chainId]?.atomic?.status;
  const smart=value.walletMode==='eip7702';
  if(smart && atomic!=='supported')throw new Error('This smart account must support wallet call requests on Ethereum. No transaction was submitted; reconnect the supported wallet account.');
  if(!safeQuote(value))throw new Error('This quote expired before the wallet request. Start a new redemption from Studio.');
  const operation={kind,method:smart?'calls':'transaction',chainId:transaction.chainId,from:address,to:transaction.to,id:null};
  if(smart)operation.id='0x'+Array.from(crypto.getRandomValues(new Uint8Array(32)),b=>b.toString(16).padStart(2,'0')).join('');
  callPolls=0;savePending(operation);
  let result;
  try {
    result=await window.ethereum.request(smart?{method:'wallet_sendCalls',params:[{version:'2.0.0',id:operation.id,
      from:address,chainId:transaction.chainId,atomicRequired:true,calls:[{to:transaction.to,data:transaction.data,value:transaction.value}]}]}
      :{method:'eth_sendTransaction',params:[{...transaction,from:address}]});
  } catch(error) {
    const code=Number(error.code);
    // EIP-5792 rejects these requests before submission. Duplicate IDs (5720)
    // and generic/internal errors can refer to an existing send, so retain them.
    if([4001,-32601,-32602,4100,4200,5700,5710,5740,5750,5760].includes(code)) {
      clearPending();
      if(code===4001)throw error;
      throw new Error('The wallet rejected this request before submission. Check the connected account and network, then review the action again.');
    }
    throw new Error('The wallet request outcome is uncertain. It is saved for recovery; check the wallet status before trying another transaction.');
  }
  if(smart) {
    const id=callsId(typeof result==='string'?result:result?.id) || callsId(result?.batchId);
    if(!id)throw new Error('The wallet returned no call ID. The request remains saved; check its status before retrying.');
    savePending({...operation,id});renderRedemption(value);queueCallPoll();
    return null;
  }
  const hash=transactionHash(result);
  if(!hash)throw new Error('The wallet returned no Ethereum transaction hash. Check the saved wallet request before retrying.');
  return hash;
}
async function checkPendingOperation() {
  const pending=pendingOperation;if(!pending)return;
  if(pending.method!=='calls') { status('The wallet request has no confirmed transaction hash. Check the wallet activity; paste an actual redemption transaction hash below to recover. A second request will not be sent.');return; }
  const result=await window.ethereum.request({method:'wallet_getCallsStatus',params:[pending.id]});
  if(result?.id!==pending.id || !/^0x[0-9a-f]+$/i.test(result.chainId || '') || BigInt(result.chainId)!==BigInt(pending.chainId)
    || !Number.isInteger(result.status))throw new Error('Wallet status did not match the saved request and network. The request is still pending.');
  if(result.status>=100 && result.status<200) { status('Wallet request is pending on Ethereum. Its call ID is saved; no second transaction will be sent.');queueCallPoll();return; }
  let safeToRetry=result.status===400 && (result.receipts===undefined || Array.isArray(result.receipts) && result.receipts.length===0);
  if(result.status===500 && Array.isArray(result.receipts) && result.receipts.length>0) {
    safeToRetry=await failedCallsFinal(result.receipts,pending.chainId);
    if(!safeToRetry) { status('The wallet reports a failed request. REACH is waiting for its failed transaction receipts to become final before allowing another request.');queueCallPoll();return; }
  }
  if(safeToRetry) {
    const fresh=await api('/v1/redemptions/details',{redemptionId,ticket});clearPending();renderRedemption(fresh);
    status(safeQuote(fresh)?'The previous wallet request failed without redeeming RCH. Review the quote and choose the action again to retry.'
      :'The previous wallet request failed without redeeming RCH. This quote expired; start a new redemption in Studio.');return;
  }
  if(result.status!==200) { status('The wallet reports a failed or incomplete request. Check its activity and any transaction receipt before starting a new redemption. This request remains saved.');return; }
  if(result.atomic!==true || !Array.isArray(result.receipts) || !result.receipts.length)throw new Error('The wallet has not supplied a complete confirmed receipt. Keep this page for recovery.');
  if(!result.receipts.every(receipt=>receipt.status==='0x1' && transactionHash(receipt.transactionHash)
    && transactionHash(receipt.blockHash) && /^0x[0-9a-f]+$/i.test(receipt.blockNumber || ''))) {
    throw new Error('The wallet receipt is incomplete or not successful. The request is saved for recovery.');
  }
  const receipts=result.receipts;
  const matches=receipts.length===1?receipts:receipts.filter(receipt=>receipt.logs?.some(log=>log.address?.toLowerCase()===pending.to.toLowerCase()));
  if(matches.length!==1)throw new Error('The wallet returned ambiguous receipts. Keep this request and recover the exact transaction hash from wallet activity.');
  const hash=matches[0].transactionHash;
  if(pending.kind==='approval') {
    approvalHash=hash;sessionStorage.setItem(approvalStorageKey,hash);clearPending();
    await checkApproval();
  } else {
    submittedHash=hash;sessionStorage.setItem(submittedStorageKey,hash);$('txHash').value=hash;clearPending();
    redemption.transaction=null;redemption.approvalTransaction=null;await checkTransaction();
  }
}
async function failedCallsFinal(receipts,chainId) {
  const current=await window.ethereum.request({method:'eth_chainId'});
  if(BigInt(current)!==BigInt(chainId))return false;
  const finalized=BigInt(chainId)===1n?await window.ethereum.request({method:'eth_getBlockByNumber',params:['finalized',false]}):null;
  for(const expected of receipts) {
    if(expected.status!=='0x0'||!transactionHash(expected.transactionHash)||!transactionHash(expected.blockHash)
      ||!/^0x[0-9a-f]+$/i.test(expected.blockNumber || ''))return false;
    const receipt=await window.ethereum.request({method:'eth_getTransactionReceipt',params:[expected.transactionHash]});
    if(!receipt||![0,'0x0'].includes(receipt.status)||receipt.transactionHash?.toLowerCase()!==expected.transactionHash.toLowerCase()
      ||receipt.blockHash?.toLowerCase()!==expected.blockHash.toLowerCase()||BigInt(receipt.blockNumber)!==BigInt(expected.blockNumber))return false;
    const block=await window.ethereum.request({method:'eth_getBlockByNumber',params:[expected.blockNumber,false]});
    if(block?.hash?.toLowerCase()!==expected.blockHash.toLowerCase())return false;
    if(BigInt(chainId)===1n && (!finalized||!transactionHash(finalized.hash)||!/^0x[0-9a-f]+$/i.test(finalized.number || '')
      ||BigInt(finalized.number)<BigInt(expected.blockNumber)))return false;
  }
  return true;
}
function clearApproval() {
  approvalHash=null;
  try { sessionStorage.removeItem(approvalStorageKey); } catch { /* Optional recovery cache. */ }
}
async function checkApproval() {
  const receipt=await window.ethereum.request({method:'eth_getTransactionReceipt',params:[approvalHash]});
  if(!receipt) { status('Approval is pending on Ethereum. Check again after it confirms.');return; }
  const succeeded=receipt.status==='0x1'||receipt.status===1;
  const fresh=await api('/v1/redemptions/details',{redemptionId,ticket});
  clearApproval();renderRedemption(fresh);
  $('approval-status').textContent=succeeded?'RCH approval confirmed.':'RCH approval failed. No RCH was redeemed.';
  if(succeeded && fresh.transaction && safeQuote(fresh))status('Approval confirmed. Review the quote, then choose “Redeem RCH for AI credit” to complete redemption.');
}
async function checkTransaction() {
  const hash=transactionHash($('txHash').value.trim());
  if(hash && redemption) {
    redemption.transaction=null;redemption.approvalTransaction=null;submittedHash=hash;
    try { sessionStorage.setItem(submittedStorageKey,hash); } catch { /* The visible hash remains available for manual recovery. */ }
  }
  const result = await api('/v1/redemptions/submit',{redemptionId,ticket,txHash:$('txHash').value.trim()});
  if(result.status==='credited') {
    redemption.status='credited';submittedHash=null;clearPending();$('recovery').hidden=true;
    try { sessionStorage.removeItem(submittedStorageKey); } catch { /* Optional recovery cache. */ }
  }
  const problems={transaction_failed:'This transaction failed. No credit was issued. Submit the hash of a successful replacement, or start a new redemption in Studio.',transaction_mismatch:'This transaction does not match your redemption. Check and correct the transaction hash after the previous transaction is final.',redemption_event_mismatch:'This transaction does not contain the expected RCH redemption. Check the transaction hash or contact the service operator.',credit_limit:'The redemption needs account reconciliation. Keep this transaction hash and contact the service operator.',redemption_rate_mismatch:'The configured RCH conversion changed. Keep this transaction hash for operator reconciliation.'};
  status(result.status==='credited'?'Usage credit confirmed. Return to Studio and refresh.':problems[result.reason]||(['transaction_pending','awaiting_finality'].includes(result.reason)?'Transaction saved. REACH will credit your account after finality. You can safely close this page.':'Verification is temporarily unavailable. Your transaction hash is saved and REACH will retry. Keep the hash for recovery.'));
  $('primary').disabled=true;
}
$('recover').addEventListener('click',async()=>{ if(busy)return;busy=true;$('recover').disabled=true;$('primary').disabled=true;try{await checkTransaction();}catch(e){status(e.message);}finally{busy=false;$('recover').disabled=false;$('primary').disabled=!canAct(redemption);} });
$('primary').addEventListener('click',async()=>{
  if(busy)return;busy=true;
  $('primary').disabled=true;$('recover').disabled=true;
  try {
    if(redeemMode) {
      if(pendingOperation) { await wallet(redemption.chainId,redemption.walletAddress);await checkPendingOperation();return; }
      if(approvalHash) { await wallet(redemption.chainId,redemption.walletAddress);await checkApproval();return; }
      const previousIdentity=quoteIdentity(redemption);
      const value=await api('/v1/redemptions/details',{redemptionId,ticket});renderRedemption(value);
      if(!canAct(value))return;
      if(previousIdentity!==quoteIdentity(value)) { status('The quote changed. Review the updated amount and credit, then continue.');return; }
      const address=await wallet(value.chainId,value.walletAddress);
      if(!safeQuote(value)) { renderRedemption(value);return; }
      const transaction=value.approvalTransaction || value.transaction;
      const txHash=await sendWalletTransaction(value,address,transaction,value.approvalTransaction?'approval':'redemption');
      if(!txHash)return;
      if(value.approvalTransaction) {
        approvalHash=txHash;
        try { sessionStorage.setItem(approvalStorageKey,txHash); } catch { /* Optional recovery cache. */ }
        clearPending();
        $('approval-status').textContent='Approval transaction: '+txHash;
        renderRedemption(value);status('Approval submitted. Check its confirmation before redeeming.');return;
      }
      // Keep the hash visible for manual recovery even if the service is temporarily unavailable.
      $('txHash').value=txHash;$('recovery').hidden=false;
      submittedHash=transactionHash(txHash);
      try { if(submittedHash)sessionStorage.setItem(submittedStorageKey,submittedHash); } catch { /* The visible hash remains available. */ }
      clearPending();
      $('primary').disabled=true;redemption.transaction=null;
      await checkTransaction();return;
    }
    if(!challenge) {
      selectedAddress=await wallet(config.chainId);
      challenge=await api('/v1/auth/challenge',{flowId,address:selectedAddress});
      $('message').textContent=challenge.message;$('message').hidden=false;
      $('primary').textContent='Sign in with wallet';status('Review the sign-in message, then sign it in your wallet.');return;
    }
    const current=await wallet(config.chainId,selectedAddress);
    const encoded='0x'+Array.from(new TextEncoder().encode(challenge.message),b=>b.toString(16).padStart(2,'0')).join('');
    const signature=await window.ethereum.request({method:'personal_sign',params:[encoded,current]});
    await api('/v1/auth/verify',{flowId,challengeId:challenge.challengeId,signature});
    status('Wallet verified. Return to REACH Studio to finish connecting.');
    $('primary').hidden=true;
  } catch(e) {
    if(redeemMode && pendingOperation && redemption)renderRedemption(redemption);
    status(e.code===4001?'Wallet request cancelled. No new approval was submitted.':e.message||'The wallet request could not be completed.');
  }
  finally { busy=false;$('recover').disabled=false;$('primary').disabled=redeemMode?!canAct(redemption):false; }
});
(async()=>{
  try {
    config=await api('/v1/account/config');
    if(redeemMode) {
      $('title').textContent='Redeem REACH Credits';$('intro').textContent='Convert RCH into usage credit for eligible REACH models.';
      $('notice').textContent='Review the quoted credit and redemption terms before signing. Credit appears after the service verifies the final transaction. Network gas is paid separately.';
      if(!redemptionId||!ticket)throw new Error('Start redemption from your connected account in Studio.');
      renderRedemption(await api('/v1/redemptions/details',{redemptionId,ticket}));
      queueCallPoll();
    } else if(!flowId)throw new Error('Start wallet sign-in from REACH Studio.');
  } catch(e) {status(e.message);$('primary').disabled=true;}
})();
