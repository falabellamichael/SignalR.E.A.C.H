'use strict';
const $ = id => document.getElementById(id);
const params = new URLSearchParams(location.hash.slice(1));
const redeemMode = location.pathname === '/wallet/redeem';
const flowId = params.get('flow');
const redemptionId = params.get('id'), ticket = params.get('ticket');
let busy = false;
let challenge = null, selectedAddress = null, redemption = null, config = null;
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
function renderRedemption(value) {
  redemption=value;$('details').hidden=false;$('recovery').hidden=value.status==='credited';
  $('address').textContent=value.walletAddress;
  $('amount').textContent=`${value.amountRch} RCH → ${Number(value.usageTokens).toLocaleString()} AI usage tokens`;
  $('primary').textContent='Burn RCH for usage credit';
  $('primary').disabled=busy||!value.transaction;
  if(value.txHash)$('txHash').value=value.txHash;
  const reasons={already_submitted:'Transaction submitted. REACH is checking finality.',intent_expired:'This signing request expired. You can still recover a transaction that was already sent.',plan_required:'An active subscription is required to begin a new redemption.'};
  status(value.status==='credited'?'Usage credit confirmed. Return to Studio and refresh your account.':value.message||reasons[value.signingUnavailableReason]||'Review the amount. Your wallet will request approval for a permanent token burn.');
}
async function checkTransaction() {
  if(/^0x[0-9a-f]{64}$/i.test($('txHash').value.trim()) && redemption) redemption.transaction=null;
  const result = await api('/v1/redemptions/submit',{redemptionId,ticket,txHash:$('txHash').value.trim()});
  const problems={transaction_failed:'This transaction failed. No credit was issued. Submit the hash of a successful replacement, or start a new redemption in Studio.',transaction_mismatch:'This transaction does not match your redemption. Check and correct the transaction hash after the previous transaction is final.',redemption_event_mismatch:'This transaction does not contain the expected RCH burn. Check the transaction hash or contact the service operator.',credit_limit:'The burn needs account reconciliation. Keep this transaction hash and contact the service operator.',redemption_rate_mismatch:'The configured RCH conversion changed. Keep this transaction hash for operator reconciliation.'};
  status(result.status==='credited'?'Usage credit confirmed. Return to Studio and refresh.':problems[result.reason]||(['transaction_pending','awaiting_finality'].includes(result.reason)?'Transaction saved. REACH will credit your account after finality. You can safely close this page.':'Verification is temporarily unavailable. Your transaction hash is saved and REACH will retry. Keep the hash for recovery.'));
  $('primary').disabled=true;
}
$('recover').addEventListener('click',async()=>{ if(busy)return;busy=true;$('recover').disabled=true;$('primary').disabled=true;try{await checkTransaction();}catch(e){status(e.message);}finally{busy=false;$('recover').disabled=false;$('primary').disabled=!redemption?.transaction;} });
$('primary').addEventListener('click',async()=>{
  if(busy)return;busy=true;
  $('primary').disabled=true;$('recover').disabled=true;
  try {
    if(redeemMode) {
      const value=await api('/v1/redemptions/details',{redemptionId,ticket});renderRedemption(value);
      if(!value.transaction)return;
      const address=await wallet(value.chainId,value.walletAddress);
      const txHash=await window.ethereum.request({method:'eth_sendTransaction',params:[{from:address,...value.transaction}]});
      // Keep the hash visible for manual recovery even if the service is temporarily unavailable.
      $('txHash').value=txHash;$('recovery').hidden=false;
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
  finally { busy=false;$('recover').disabled=false;$('primary').disabled=redeemMode?!redemption?.transaction:false; }
});
(async()=>{
  try {
    config=await api('/v1/account/config');
    if(redeemMode) {
      $('title').textContent='Redeem REACH Credits';$('intro').textContent='Convert RCH into usage credit for the models included in your active subscription.';
      $('notice').textContent='This transaction permanently burns RCH and requires network gas. Credit appears after the service verifies the final transaction. Model requests then spend your usage allowance.';
      if(!redemptionId||!ticket)throw new Error('Start redemption from your connected account in Studio.');
      renderRedemption(await api('/v1/redemptions/details',{redemptionId,ticket}));
    } else if(!flowId)throw new Error('Start wallet sign-in from REACH Studio.');
  } catch(e) {status(e.message);$('primary').disabled=true;}
})();
