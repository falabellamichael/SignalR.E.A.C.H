const $=id=>document.getElementById(id);
const status=message=>{for(const id of ['status','purchaseStatus'])if($(id))$(id).textContent=message;};
function bounded(promise,ms,message){let timer;return Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error(message)),ms);})]).finally(()=>clearTimeout(timer));}
try {
  const [{BrowserProvider,getAddress},{loadState,prepareOperation,validateOperation,checkReceipt},deployment]=await bounded(Promise.all([import('./ethers.mjs'),import('./operations.mjs'),fetch('./deployment.json').then(r=>{if(!r.ok)throw new Error('Deployment settings could not load.');return r.json();})]),15000,'Wallet tools did not load. Reload the page.');
  const providers=new Map();let wallet,busy=false,state,openQuote,buyQuote;
  let key=`rch-sale:${deployment.chainId}:${deployment.sale}:${deployment.account}`;
  async function api(resource,value){const response=await bounded(fetch(`./${resource}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(value)}),12000,'The local CLI service did not respond. Keep the terminal command running.');const data=await response.json();if(!response.ok)throw new Error(data.error||'The local CLI request failed.');return data;}
  async function persistRecord(record){await api('record',record);localStorage.setItem(key,JSON.stringify(record));}
  if(deployment.record)localStorage.setItem(key,JSON.stringify(deployment.record));
  if(deployment.amount)$('amount').value=deployment.amount;
  if(deployment.feeCeiling)$('fee').value=deployment.feeCeiling;
  if(['connect','buy'].includes(deployment.action))$('activationSection').hidden=true;
  if(['connect','open-sale'].includes(deployment.action))$('purchaseSection').hidden=true;
  const readRecord=()=>{const raw=localStorage.getItem(key);return raw?JSON.parse(raw):null;};
  const pending=()=>['requesting','submitted'].includes(readRecord()?.status);
  $('addresses').textContent=`RCH token: ${deployment.token}\nSale: ${deployment.sale}\nAccount: ${deployment.account||'Choose in MetaMask'}`;
  $('addresses').style.overflowWrap='anywhere';$('addresses').style.whiteSpace='pre-wrap';
  function controls(){
    const locked=pending(),purchaseBlocked=locked||!state||state.paused||state.closed||state.issuancePaused||state.canMint===false;
    $('connect').disabled=busy;$('estimateOpen').disabled=busy||locked||!state||!state.paused||state.closed||state.owner!==state.account;
    $('quoteBuy').disabled=busy||purchaseBlocked;$('sendOpen').disabled=busy||locked||!openQuote;$('sendBuy').disabled=busy||purchaseBlocked||!buyQuote;
    $('check').disabled=busy||!wallet||!readRecord();$('addToken').disabled=busy||!state;$('amount').disabled=busy||purchaseBlocked;$('fee').disabled=busy;
    $('purchaseReady').textContent=!state?'Connect your wallet above to enable this form.':locked?'A recorded transaction needs a receipt check. Use Check transaction and refresh below.':state.closed?'The sale is permanently closed.':state.paused?'The sale is paused. Complete activation above first.':state.issuancePaused||state.canMint===false?'RCH issuance is currently unavailable.':`Ready to buy. Your balance is ${state.eth} ETH; the quote reserves gas in addition to your purchase amount.`;
  }
  function invalidate(){state=undefined;openQuote=buyQuote=undefined;controls();status('Wallet or network changed. Connect and check status again.');}
  window.addEventListener('eip6963:announceProvider',event=>{const d=event.detail;if(d?.info?.rdns==='io.metamask'&&typeof d.provider?.request==='function')providers.set(d.info.uuid,d.provider);});
  const announce=()=>window.dispatchEvent(new Event('eip6963:requestProvider'));
  announce();
  async function select(){announce();if(!providers.size&&!window.ethereum)await new Promise(r=>setTimeout(r,400));const legacy=Array.isArray(window.ethereum?.providers)?window.ethereum.providers:[];const next=[...providers.values()][0]||[...legacy,window.ethereum].find(p=>p?.isMetaMask&&typeof p.request==='function');if(!next)throw new Error('Enable MetaMask in Opera and allow it on localhost, then reload.');if(wallet!==next){wallet?.removeListener?.('accountsChanged',invalidate);wallet?.removeListener?.('chainChanged',invalidate);wallet=next;wallet.on?.('accountsChanged',invalidate);wallet.on?.('chainChanged',invalidate);}}
  async function withProvider(fn){if(!wallet)throw new Error('Connect MetaMask first.');const provider=new BrowserProvider(wallet,'any',{cacheTimeout:-1});try{const accounts=await wallet.request({method:'eth_accounts'});if(!accounts[0])throw new Error('Unlock and connect your MetaMask account.');return await fn(provider,accounts[0]);}finally{provider.destroy();}}
  async function refresh(){
    state=await withProvider((p,a)=>loadState(p,deployment,a));
    const record=readRecord();
    if(record?.hash&&['requesting','submitted'].includes(record.status)){
      const result=await withProvider(p=>checkReceipt(p,deployment,record));
      if(result.status!=='pending'){record.status=result.status;record.receipt=result;await persistRecord(record);openQuote=buyQuote=undefined;$('result').textContent=`${result.message}\nActual gas fee: ${result.feeEth} ETH`;}
    }
    $('balances').textContent=`ETH balance: ${state.eth}\nRCH balance: ${state.rch}\nSale: ${state.closed?'closed permanently':state.paused?'paused':'open'}\nAI redemption: ${state.redemptionPaused?'paused':'enabled on chain'}`;
    if(!state.paused){$('openQuote').textContent='Sale is open. Activation is complete.';if(!buyQuote)$('buyQuote').textContent='Enter an ETH amount, then get a quote. The RCH output and gas fee will appear here.';}
  }
  function renderRecord(){const r=readRecord();if(r){$('pending').textContent=`${r.prepared.action==='open'?'Sale activation':'RCH purchase'}: ${r.status}. ${r.hash||'Check MetaMask Activity if the wallet response was interrupted.'}`;if(r.hash)$('hash').value=r.hash;}else{$('pending').textContent='No transaction requested by this page.';}}
  async function task(fn){if(busy)return;busy=true;try{controls();await fn();}catch(error){window.rchStage?.('request-error');const code=error.code??error.info?.error?.code;status(Number(code)===4001?'Request declined in MetaMask. No new submission was accepted.':Number(code)===-32002?'MetaMask already has a pending request. Open its toolbar icon.':error.shortMessage||error.message||String(error));}finally{busy=false;renderRecord();controls();}}
  function showQuote(id,q){$(id).textContent=`${q.action==='open'?'Open the sale to everyone':`Buy approximately ${q.expectedRch} RCH\nMinimum received: ${q.minimumRch} RCH\nQuote deadline: ${new Date(q.deadline*1000).toLocaleTimeString()}`}\nETH payment: ${q.amountEth}\nEstimated gas: ${q.estimatedFeeEth} ETH\nMaximum gas allowance: ${q.maximumFeeEth} ETH\nMaximum payment plus gas: ${q.maximumTotalEth} ETH\nBalance remaining at maximum: ${q.remainingEth} ETH`;$(id).scrollIntoView?.({block:'nearest'});}
  $('connect').onclick=async()=>{
    await task(async()=>{status('Waiting for MetaMask. Open its toolbar icon and approve the connection.');await select();const accounts=await bounded(wallet.request({method:'eth_requestAccounts'}),30000,'Open MetaMask and finish its pending connection prompt.');if(!accounts[0])throw new Error('Choose an account in MetaMask.');if(!deployment.account){deployment.account=getAddress(accounts[0]);key=`rch-sale:${deployment.chainId}:${deployment.sale}:${deployment.account}`;}
      await bounded(withProvider((p,a)=>loadState(p,deployment,a)),45000,'Ethereum status check timed out.');
      const saved=await api('wallet',{address:deployment.account});if(saved.record)localStorage.setItem(key,JSON.stringify(saved.record));
      await bounded(refresh(),45000,'Ethereum status check timed out.');status(pending()?'Connected. A previous transaction still needs checking below.':state.paused?'Connected. Estimate activation, then open the sale in MetaMask.':'Connected. The sale is open. Type an ETH amount below and press Enter or Get purchase quote.');});
    if(!$('amount').disabled){$('purchaseSection').scrollIntoView?.({block:'start',behavior:'smooth'});$('amount').focus?.({preventScroll:true});}
    if(state&&!pending()){
      if(deployment.action==='buy'&&!state.paused&&$('amount').value)await $('purchaseForm').onsubmit({preventDefault(){}});
      if(deployment.action==='open-sale'&&state.paused)await $('estimateOpen').onclick();
      if(deployment.action==='connect')status('Public wallet saved. Return to Projects and run rch status, rch balance, or rch quote with an ETH amount.');
    }
  };
  $('estimateOpen').onclick=()=>task(async()=>{openQuote=undefined;status('Estimating activation…');openQuote=await bounded(withProvider((p,a)=>prepareOperation(p,deployment,a,'open',undefined,$('fee').value.trim())),45000,'Activation estimate timed out.');showQuote('openQuote',openQuote);status('Activation estimate ready. Review it, then select Open sale in MetaMask.');});
  $('purchaseForm').onsubmit=async event=>{
    event.preventDefault();
    if($('quoteBuy').disabled)return;
    $('quoteBuy').textContent='Calculating quote…';
    try{await task(async()=>{buyQuote=undefined;const amount=$('amount').value.trim();if(!amount)throw new Error('Type an ETH amount in the field first, then choose Get purchase quote.');status('Calculating RCH output and checking gas…');$('buyQuote').textContent='Getting a live quote…';buyQuote=await bounded(withProvider((p,a)=>prepareOperation(p,deployment,a,'buy',amount,$('fee').value.trim())),45000,'Purchase quote timed out.');showQuote('buyQuote',buyQuote);status('Purchase quote ready. Review the RCH output, ETH payment, and gas before proceeding.');});}
    finally{$('quoteBuy').textContent='Get purchase quote';if(!buyQuote)$('buyQuote').textContent='No quote prepared. See the message immediately above.';}
  };
  async function submit(q){
    if(!q||pending())throw new Error('Prepare an estimate and resolve any pending transaction first.');
    const tx=await bounded(withProvider((p,a)=>validateOperation(p,deployment,a,q)),45000,'Final validation timed out. Prepare a fresh estimate.');
    const record={status:'requesting',prepared:q,requestedAt:new Date().toISOString()};await persistRecord(record);renderRecord();status('Review the transaction in MetaMask. This page will not confirm it for you.');
    try{record.hash=await wallet.request({method:'eth_sendTransaction',params:[tx]});record.status='submitted';localStorage.setItem(key,JSON.stringify(record));await persistRecord(record);openQuote=buyQuote=undefined;status('Submitted. The transaction hash is also printed in Projects. Use Check transaction and refresh, or rch tx HASH.');}
    catch(error){if(Number(error.code)===4001){await persistRecord({...record,status:'rejected'});localStorage.removeItem(key);}throw error;}
  }
  $('sendOpen').onclick=()=>task(()=>submit(openQuote));$('sendBuy').onclick=()=>task(()=>submit(buyQuote));
  $('amount').oninput=()=>{buyQuote=undefined;$('buyQuote').textContent='Amount changed. Get a fresh purchase quote.';status('Press Enter or choose Get purchase quote to calculate your RCH amount and gas.');controls();};$('fee').oninput=()=>{openQuote=buyQuote=undefined;controls();};
  $('check').onclick=()=>task(async()=>{const record=readRecord();if(!record)throw new Error('No transaction is recorded.');const hash=$('hash').value.trim();const result=await bounded(withProvider(p=>checkReceipt(p,deployment,{...record,hash})),45000,'Receipt check timed out. Check again later; do not resubmit.');if(result.status!=='pending'){record.hash=hash;record.status=result.status;record.receipt=result;await persistRecord(record);openQuote=buyQuote=undefined;await refresh();} $('result').textContent=`${result.message}\n${result.feeEth?'Actual gas fee: '+result.feeEth+' ETH':''}`;status(result.message+(result.status==='confirmed'&&record.prepared.action==='open'?' Enter an ETH amount to get a purchase quote.':''));});
  $('addToken').onclick=()=>task(async()=>{await withProvider((p,a)=>loadState(p,deployment,a));const added=await wallet.request({method:'wallet_watchAsset',params:{type:'ERC20',options:{address:deployment.token,symbol:'RCH',decimals:18}}});status(added?'RCH added to MetaMask’s token list.':'Token display request was not accepted.');});
  renderRecord();controls();status('Ready. Connect MetaMask to check your deployed RCH sale.');window.rchStage?.('ready');
} catch(error){status(`Page could not start: ${error.message}. Reload with Command+Shift+R.`);window.rchStage?.('startup-error');}
