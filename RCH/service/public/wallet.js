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
try {
  approvalHash = transactionHash(sessionStorage.getItem(approvalStorageKey));
  submittedHash = transactionHash(sessionStorage.getItem(submittedStorageKey));
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
  return !!value && value.status !== 'credited' && !value.txHash && !submittedHash && safeQuote(value)
    && (!!approvalHash || !!value.approvalTransaction || !!value.transaction);
}
function renderRedemption(value) {
  redemption=value;$('details').hidden=false;$('recovery').hidden=value.status==='credited';
  $('address').textContent=value.walletAddress;
  const treasury = treasuryMode(value);
  $('quote-details').hidden=!treasury;
  $('amount').textContent=treasury
    ? `${value.amountRch} RCH → ${Number.isSafeInteger(value.creditUsdMicros) && value.creditUsdMicros > 0 ? formatUsd(value.creditUsdMicros) : 'Unavailable'} AI credit`
    : `${value.amountRch} RCH → ${Number(value.usageTokens).toLocaleString()} AI usage tokens`;
  $('primary').textContent=treasury
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
    try { sessionStorage.removeItem(submittedStorageKey); } catch { /* Optional recovery cache. */ }
  }
  const reasons={already_submitted:'Transaction submitted. REACH is checking finality.',intent_expired:'This signing request expired. You can still recover a transaction that was already sent.'};
  status(value.status==='credited'?'AI credit confirmed. Return to Studio and refresh your account.':submittedHash&&!value.txHash
    ?'Your redemption transaction is saved below. Choose “Check transaction” to resume credit verification.'
    :value.message||reasons[value.signingUnavailableReason]
    ||(!safeQuote(value)?'A valid, unexpired market quote is required. Start a new redemption from Studio.'
      :treasury?'Review the RCH amount, US dollar credit, treasury, and expiry before continuing.':'Review the amount. Your wallet will request approval for a permanent token burn.'));
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
    redemption.status='credited';submittedHash=null;$('recovery').hidden=true;
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
      if(approvalHash) { await wallet(redemption.chainId,redemption.walletAddress);await checkApproval();return; }
      const previousIdentity=quoteIdentity(redemption);
      const value=await api('/v1/redemptions/details',{redemptionId,ticket});renderRedemption(value);
      if(!canAct(value))return;
      if(previousIdentity!==quoteIdentity(value)) { status('The quote changed. Review the updated amount and credit, then continue.');return; }
      const address=await wallet(value.chainId,value.walletAddress);
      if(!safeQuote(value)) { renderRedemption(value);return; }
      const transaction=value.approvalTransaction || value.transaction;
      const txHash=await window.ethereum.request({method:'eth_sendTransaction',params:[{...transaction,from:address}]});
      if(value.approvalTransaction) {
        approvalHash=txHash;
        try { sessionStorage.setItem(approvalStorageKey,txHash); } catch { /* Optional recovery cache. */ }
        $('approval-status').textContent='Approval transaction: '+txHash;
        renderRedemption(value);status('Approval submitted. Check its confirmation before redeeming.');return;
      }
      // Keep the hash visible for manual recovery even if the service is temporarily unavailable.
      $('txHash').value=txHash;$('recovery').hidden=false;
      submittedHash=transactionHash(txHash);
      try { if(submittedHash)sessionStorage.setItem(submittedStorageKey,submittedHash); } catch { /* The visible hash remains available. */ }
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
  } catch(e) { status(e.code===4001?'Wallet request cancelled. No new approval was submitted.':e.message||'The wallet request could not be completed.'); }
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
    } else if(!flowId)throw new Error('Start wallet sign-in from REACH Studio.');
  } catch(e) {status(e.message);$('primary').disabled=true;}
})();
