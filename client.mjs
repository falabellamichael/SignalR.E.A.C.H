function bounded(promise,ms,message){let timer;return Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error(message)),ms);})]).finally(()=>clearTimeout(timer));}
const unresolved=record=>['requesting','submitted'].includes(record?.status);
export function mountCheckout({window,document,ethers,operations,manifest}) {
  const {BrowserProvider,getAddress}=ethers;
  const {loadState,prepareOperation,validateOperation,checkReceipt}=operations;
  const $=id=>document.getElementById(id);
  const providers=new Map();
  let wallet,account,state,quote,record,busy=false,generation=0,wrongChain=false;
  const storage=window.localStorage;
  const keyFor=address=>`rch-checkout:${manifest.chainId}:${manifest.sale}:${address}`;
  const deployment=address=>({...manifest,account:address});
  const status=message=>{$('status').textContent=message;};
  const loadRecord=address=>{
    const raw=storage.getItem(keyFor(address));
    if(!raw)return null;
    try {
      const result=JSON.parse(raw);
      if(!result?.prepared?.transaction || !['requesting','submitted','confirmed','failed','rejected'].includes(result.status))throw Error();
      return result;
    } catch {throw Error('The saved purchase record cannot be read. Check MetaMask Activity before starting another purchase.');}
  };
  const saveRecord=(address,value)=>{
    // Write before contacting the wallet. Failure leaves sending disabled.
    storage.setItem(keyFor(address),JSON.stringify(value));
    if(account===address)record=value;
  };
  function render(){
    const blocked=!state||state.paused||state.closed||state.issuancePaused||!state.canMint||unresolved(record);
    $('connect').disabled=busy;$('switch').hidden=!wrongChain;$('switch').disabled=busy;
    $('amount').disabled=busy||blocked;$('fee').disabled=busy;
    $('quote').disabled=busy||blocked;$('buy').disabled=busy||blocked||!quote;
    $('check').disabled=busy||!account||!record;$('addToken').disabled=busy||!state;
    $('review').hidden=!quote;
    $('account').textContent=account||'Not connected';
    $('balance').textContent=state?`${state.eth} ETH · ${state.rch} RCH`:'Connect to see your ETH and RCH balances.';
    $('activity').textContent=!record?'No purchase recorded for this wallet in this browser.':record.status==='requesting'?'Wallet request awaiting resolution. Check MetaMask Activity; do not repeat the purchase.':record.status==='submitted'?'Purchase submitted. Check the receipt below.':record.status==='confirmed'?`Purchase confirmed.${record.receipt?.feeEth?' Actual gas: '+record.receipt.feeEth+' ETH.':''}`:record.status==='failed'?`Transaction failed.${record.receipt?.feeEth?' Gas charged: '+record.receipt.feeEth+' ETH.':''} Review the failure before trying again.`:'Request declined in the wallet.';
    const hash=record?.hash;
    $('transactionLink').hidden=!/^0x[0-9a-f]{64}$/i.test(hash||'');
    if(!$('transactionLink').hidden)$('transactionLink').href=`https://etherscan.io/tx/${hash}`;
    if(hash)$('hash').value=hash;
  }
  const checkContext=epoch=>{if(epoch!==generation)throw Error('Wallet, network or purchase inputs changed. Reconnect and request a fresh quote.');};
  async function task(fn){
    if(busy)return;
    busy=true;render();
    try{await fn();}catch(error){
      const code=Number(error.code??error.info?.error?.code);
      status(code===4001?'Request declined in MetaMask.':code===-32002?'MetaMask has a pending request. Open MetaMask to resolve it.':error.shortMessage||error.message||'The request failed.');
    }finally{busy=false;render();}
  }
  function invalidate(){generation++;state=quote=undefined;wrongChain=false;render();status('Wallet or network changed. Reconnect to refresh your balance and quote.');}
  function onAnnouncement(event){const data=event.detail;if(data?.info?.rdns==='io.metamask'&&typeof data.provider?.request==='function')providers.set(data.info.uuid,data.provider);}
  window.addEventListener('eip6963:announceProvider',onAnnouncement);
  const announce=()=>window.dispatchEvent(new window.Event('eip6963:requestProvider'));
  async function selectWallet(){
    announce();
    if(!providers.size&&!window.ethereum)await new Promise(resolve=>setTimeout(resolve,400));
    const legacy=Array.isArray(window.ethereum?.providers)?window.ethereum.providers:[];
    const next=[...providers.values()][0]||[...legacy,window.ethereum].find(provider=>provider?.isMetaMask&&typeof provider.request==='function');
    if(!next)throw Error('Open this page in MetaMask’s mobile browser, or enable the MetaMask extension for this site and reload.');
    if(next!==wallet){wallet?.removeListener?.('accountsChanged',invalidate);wallet?.removeListener?.('chainChanged',invalidate);wallet=next;wallet.on?.('accountsChanged',invalidate);wallet.on?.('chainChanged',invalidate);}
  }
  async function withProvider(address,fn){
    if(!wallet||!address)throw Error('Connect MetaMask first.');
    const selected=await bounded(wallet.request({method:'eth_accounts'}),15000,'MetaMask did not respond. Open MetaMask and reconnect.');
    if(!selected[0]||getAddress(selected[0])!==address)throw Error('The selected wallet changed. Reconnect before continuing.');
    const provider=new BrowserProvider(wallet,'any',{cacheTimeout:-1});
    try{return await bounded(fn(provider,deployment(address)),45000,'Ethereum checks timed out. Reconnect and try again; no new transaction was requested.');}finally{provider.destroy();}
  }
  async function refresh(address,epoch){
    const fresh=await withProvider(address,(provider,d)=>loadState(provider,d,address));
    checkContext(epoch);state=fresh;
    status(unresolved(record)?'A previous purchase needs a receipt check.':state.closed?'The sale is permanently closed.':state.paused?'Purchases are paused by the sale operator.':state.issuancePaused||!state.canMint?'Token issuance is currently unavailable.':'Connected. Enter an ETH amount to get a live quote.');
  }
  $('connect').onclick=()=>task(async()=>{
    quote=state=undefined;status('Open MetaMask and approve the connection.');
    await selectWallet();
    const accounts=await bounded(wallet.request({method:'eth_requestAccounts'}),60000,'Connection is still pending in MetaMask. Open the wallet to resolve it.');
    if(!accounts[0])throw Error('Select an Ethereum account in MetaMask.');
    account=getAddress(accounts[0]);const epoch=++generation;
    record=loadRecord(account);$('hash').value=record?.hash||'';
    const chain=await wallet.request({method:'eth_chainId'});checkContext(epoch);
    wrongChain=BigInt(chain)!==BigInt(manifest.chainId);
    if(wrongChain)throw Error('Select Ethereum Mainnet to purchase RCH.');
    await refresh(account,epoch);
  });
  $('switch').onclick=()=>task(async()=>{
    await wallet.request({method:'wallet_switchEthereumChain',params:[{chainId:'0x1'}]});
    invalidate();status('Ethereum selected. Connect again to refresh your wallet.');
  });
  const clearQuote=()=>{generation++;quote=undefined;render();status('Purchase inputs changed. Get a fresh quote.');};
  $('amount').oninput=clearQuote;$('fee').oninput=clearQuote;
  $('purchaseForm').onsubmit=event=>{event.preventDefault();if($('quote').disabled)return;return task(async()=>{
    quote=undefined;const epoch=generation,address=account;
    record=loadRecord(address);if(unresolved(record))throw Error('Resolve the previous purchase first.');
    status('Checking the sale, price, balance and network fees…');
    const prepared=await withProvider(address,(provider,d)=>prepareOperation(provider,d,address,'buy',$('amount').value.trim(),$('fee').value.trim()));
    checkContext(epoch);quote=prepared;
    for(const[id,value]of Object.entries({rch:quote.expectedRch,minimum:quote.minimumRch+' RCH',payment:quote.amountEth+' ETH',gas:quote.estimatedFeeEth+' ETH',maxGas:quote.maximumFeeEth+' ETH',total:quote.maximumTotalEth+' ETH',deadline:new Date(quote.deadline*1000).toLocaleTimeString()}))$(id).textContent=value;
    status('Quote ready. Review the amounts, then continue to MetaMask. No ETH has been spent.');
  });};
  $('buy').onclick=()=>task(async()=>{
    if(!quote||!account||unresolved(record))throw Error('Get a fresh quote and resolve any pending purchase first.');
    if(!window.navigator.locks?.request)throw Error('This browser cannot safely coordinate purchases across tabs. Use a current MetaMask-compatible browser.');
    const address=account,epoch=generation,prepared=quote,sendingWallet=wallet;
    await window.navigator.locks.request(keyFor(address),{ifAvailable:true},async lock=>{
      if(!lock)throw Error('Another tab is reviewing a purchase for this wallet. Finish that request first.');
      checkContext(epoch);record=loadRecord(address);
      if(unresolved(record))throw Error('A previous wallet request still needs checking.');
      status('Rechecking your quote before opening MetaMask…');
      const tx=await withProvider(address,(provider,d)=>validateOperation(provider,d,address,prepared));
      checkContext(epoch);
      const selected=await sendingWallet.request({method:'eth_accounts'});
      const chain=await sendingWallet.request({method:'eth_chainId'});
      checkContext(epoch);
      if(!selected[0]||getAddress(selected[0])!==address||BigInt(chain)!==1n)throw Error('Wallet or network changed. Reconnect and get a fresh quote.');
      const intent={status:'requesting',prepared,requestedAt:new Date().toISOString()};
      saveRecord(address,intent);quote=undefined;render();status('Review and confirm the purchase in MetaMask.');
      try{
        const hash=await bounded(sendingWallet.request({method:'eth_sendTransaction',params:[tx]}),120000,'Wallet response timed out. This purchase remains unresolved; check MetaMask Activity and enter its transaction hash.');
        if(!/^0x[0-9a-f]{64}$/i.test(hash||''))throw Error('The wallet response did not include a transaction hash. Check MetaMask Activity.');
        saveRecord(address,{...intent,status:'submitted',hash});
        status('Purchase submitted. Check its receipt below. Confirmation can take time.');
      }catch(error){
        if(Number(error.code)===4001)saveRecord(address,{...intent,status:'rejected'});
        throw error;
      }
    });
  });
  $('check').onclick=()=>task(async()=>{
    const address=account,epoch=generation,previous=loadRecord(address);
    if(!previous)throw Error('There is no saved purchase for this wallet in this browser.');
    const hash=$('hash').value.trim()||previous.hash;
    status('Checking the transaction on Ethereum…');
    const receipt=await withProvider(address,(provider,d)=>checkReceipt(provider,d,{...previous,hash}));
    checkContext(epoch);
    if(receipt.status!=='pending'){
      saveRecord(address,{...previous,hash,status:receipt.status,receipt});quote=undefined;
      await refresh(address,epoch);
    }
    status(receipt.message);
  });
  $('addToken').onclick=()=>task(async()=>{
    const epoch=generation,address=account;
    await withProvider(address,(provider,d)=>loadState(provider,d,address));checkContext(epoch);
    const added=await wallet.request({method:'wallet_watchAsset',params:{type:'ERC20',options:{address:manifest.token,symbol:'RCH',decimals:18}}});
    status(added?'RCH added to your MetaMask token list.':'Token display request declined.');
  });
  const onStorage=event=>{if(account&&event.key===keyFor(account)){invalidate();status('Purchase activity changed in another tab. Reconnect to load its latest status.');}};
  window.addEventListener('storage',onStorage);
  for(const[id,address]of [['tokenLink',manifest.token],['saleLink',manifest.sale]])$(id).href=`https://etherscan.io/address/${address}`;
  announce();render();status('Ready. Connect MetaMask to get started.');
  return {destroy(){wallet?.removeListener?.('accountsChanged',invalidate);wallet?.removeListener?.('chainChanged',invalidate);window.removeEventListener('eip6963:announceProvider',onAnnouncement);window.removeEventListener('storage',onStorage);}};
}
