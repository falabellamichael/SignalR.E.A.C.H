const $=id=>document.getElementById(id);
const same=(a,b)=>a?.toLowerCase()===b?.toLowerCase();
let wallet,signer,address,plan,action,busy=false,pendingHash;
const status=message=>{$('status').textContent=message;};
const error=problem=>status((problem?.shortMessage||problem?.message||String(problem))+(pendingHash?` Transaction ${pendingHash} needs a receipt check before retrying.`:''));

function render(){
  const {market,state,liquidity}=plan;
  $('walletLine').textContent=`MetaMask: ${address||'not connected'}`;
  $('steps').hidden=state.newPool!==ethers.ZeroAddress;
  $('buyLine').hidden=state.newPool===ethers.ZeroAddress||state.newPoolLiquidity==='0';
  if(!$('buyLine').hidden){
    const url=new URL('https://app.uniswap.org/swap');
    url.searchParams.set('chain','mainnet');
    url.searchParams.set('inputCurrency',market.usdc);
    url.searchParams.set('outputCurrency',market.rch);
    $('buyLink').href=url.href;
    if($('result').textContent==='No transaction sent.')$('result').textContent=`Pool confirmed on Ethereum mainnet: ${state.newPool}`;
  }
  $('state').textContent=`Block ${state.block}\nOld NFT ${state.oldPositionId}: ${state.oldPositionLiquidity} liquidity\nRecoverable: ${state.collectible?`${state.collectible.rch} RCH + ${state.collectible.usdc} USDC`:'already withdrawn'}\nAccount 1: ${state.rch} RCH, ${state.usdc} USDC, ${state.payerEth} ETH\nReceiving wallet: ${state.ownerEth} ETH\nNew pool: ${state.newPool}\nActive liquidity: ${state.newPoolLiquidity}`;
  let title,description,label,progress,required;
  if(state.newPool!==ethers.ZeroAddress){
    action=null;progress='Finished';title=state.newPoolLiquidity==='0'?'Pool needs inspection':'People can buy RCH';
    description=state.newPoolLiquidity==='0'?'The pool exists but has no active liquidity. Stop and inspect it.':'The new pool has active liquidity. This market is still very thin and cannot price AI-credit redemption.';
    label='No further transaction';
  }else if(state.readyWithdraw){
    action='recover';progress='Step 1 of 4';title='Select the receiving wallet';
    description=`In MetaMask, select ${market.owner}. This transaction moves about ${state.collectible.usdc} USDC from the old position to Account 1. It also moves any RCH there.`;
    label='Review recovery in MetaMask';required=market.owner;
  }else if(state.readyMint){
    required=market.payer;
    if(BigInt(state.rchAllowance)<BigInt(liquidity.rchDesired)){
      action='approveRch';progress='Step 2 of 4';title='Switch to Account 1';
      description=`Select ${market.payer} in MetaMask. Approve exactly 142 RCH for the new pool position.`;
      label='Review 142 RCH approval';
    }else if(BigInt(state.usdcAllowance)<BigInt(liquidity.usdcDesired)){
      action='approveUsdc';progress='Step 3 of 4';title='Approve 1.42 USDC';
      description='Keep Account 1 selected. Approve exactly 1.42 USDC for the new pool position.';
      label='Review 1.42 USDC approval';
    }else{
      action='mint';progress='Step 4 of 4';title='Create the buyable pool';
      description='Keep Account 1 selected. Deposit 142 RCH and 1.42 USDC. The receiving wallet gets the new position NFT. Review the network fee in MetaMask.';
      label='Review pool creation';
    }
  }else{
    action=null;progress='Stopped';title='The wallet balances changed';
    description='The old position or the available USDC no longer matches the rehearsed plan. No transaction is ready.';
    label='No transaction available';
  }
  $('progress').textContent=progress;
  $('currentTitle').textContent=title;
  $('currentText').textContent=description;
  $('primary').textContent=label;
  $('primary').disabled=busy||!!pendingHash||!action||!signer||!same(address,required);
  if(pendingHash)status(`Transaction ${pendingHash} is unresolved. Use Check current status before retrying.`);
  else if(action&&!same(address,required))status(`Select wallet ${required} in MetaMask, then choose Connect or switch MetaMask wallet.`);
  else if(action)status('Ready for review. MetaMask will show the transaction and network fee before you sign.');
  else status(description);
}

async function load(){
  const response=await fetch('./plan.json',{cache:'no-store'});
  const data=await response.json();
  if(!response.ok)throw new Error(data.error||'Mainnet check failed.');
  plan=data;render();return data;
}

async function gasCheck(transaction){
  const estimate=await wallet.estimateGas(transaction);
  const gasLimit=estimate*12n/10n;
  const block=await wallet.getBlock('latest');
  if(!block?.baseFeePerGas)throw new Error('A live Ethereum base fee is unavailable. No transaction was sent.');
  const priority=ethers.parseUnits('0.01','gwei');
  const feeBudget=ethers.parseEther('0.001');
  const maxFeePerGas=block.baseFeePerGas*2n+priority<feeBudget/gasLimit
    ?block.baseFeePerGas*2n+priority:feeBudget/gasLimit;
  if(maxFeePerGas<block.baseFeePerGas+priority){
    throw new Error('Current Ethereum base fee exceeds the 0.001 ETH network-fee limit. No transaction was sent. Wait for lower gas.');
  }
  const maximum=gasLimit*maxFeePerGas;
  const balance=await wallet.getBalance(address);
  if(maximum+ethers.parseEther('0.0001')>balance){
    throw new Error(`Estimated maximum network fee: ${ethers.formatEther(maximum)} ETH; wallet balance: ${ethers.formatEther(balance)} ETH. No transaction was sent. Wait for lower gas or add ETH.`);
  }
  status(`Capped maximum network fee: ${ethers.formatEther(maximum)} ETH. Review the final amount in MetaMask.`);
  return {gasLimit,maxFeePerGas,maxPriorityFeePerGas:priority};
}

async function verifyMint(receipt,market){
  const transfer=new ethers.Interface(['event Transfer(address indexed from,address indexed to,uint256 indexed tokenId)']);
  const minted=receipt.logs.filter(log=>same(log.address,market.manager)).map(log=>{try{return transfer.parseLog(log);}catch{return null;}}).find(log=>log?.name==='Transfer'&&same(log.args.from,ethers.ZeroAddress)&&same(log.args.to,market.owner));
  if(!minted)throw new Error(`Pool transaction confirmed, but the expected position NFT was not found. Inspect ${receipt.hash}.`);
  const nft=new ethers.Contract(market.manager,['function ownerOf(uint256) view returns (address)'],wallet);
  const owner=await nft.ownerOf(minted.args.tokenId);
  if(!same(owner,market.owner))throw new Error(`New NFT ${minted.args.tokenId} has an unexpected owner. Inspect ${receipt.hash}.`);
  return {id:minted.args.tokenId.toString(),owner};
}

$('connect').onclick=async()=>{try{
  if(!window.ethereum)throw new Error('MetaMask is unavailable in this Edge tab.');
  wallet=new ethers.BrowserProvider(window.ethereum);
  const connected=await wallet.send('eth_accounts',[]);
  const required=plan?.state.readyWithdraw?plan.market.owner:plan?.market.payer;
  if(connected[0]&&required&&!same(connected[0],required)){
    await wallet.send('wallet_requestPermissions',[{eth_accounts:{}}]);
  }
  const accounts=await wallet.send('eth_requestAccounts',[]);
  if((await wallet.getNetwork()).chainId!==1n)throw new Error('Switch MetaMask to Ethereum mainnet.');
  if(!accounts[0])throw new Error('Select a wallet in MetaMask.');
  signer=await wallet.getSigner();address=await signer.getAddress();await load();
}catch(problem){error(problem);}};

$('primary').onclick=async()=>{try{
  if(busy||pendingHash)throw new Error('A transaction is already in progress.');
  const current=await load();
  if($('primary').disabled||!action)throw new Error('Select the wallet shown on the page first.');
  const selected=action;
  const transaction=selected==='recover'?current.withdrawal.transaction
    :selected==='approveRch'?{to:current.market.rch,from:address,value:'0x0',data:current.liquidity.approveRchData}
    :selected==='approveUsdc'?{to:current.market.usdc,from:address,value:'0x0',data:current.liquidity.approveUsdcData}
    :current.liquidity.transaction;
  busy=true;$('primary').disabled=true;
  const fees=await gasCheck(transaction);
  const sent=await signer.sendTransaction({...transaction,...fees});
  pendingHash=sent.hash;
  $('result').textContent=`Submitted: ${sent.hash}\nWaiting for confirmation…`;
  const receipt=await sent.wait();
  if(receipt.status!==1)throw new Error(`Transaction failed: ${sent.hash}`);
  let nft;
  if(selected==='mint')nft=await verifyMint(receipt,current.market);
  $('result').textContent=`Confirmed: ${sent.hash}${nft?`\nNew position NFT: ${nft.id}\nOwner: ${nft.owner}`:''}`;
  pendingHash=undefined;
  busy=false;
  await load();
}catch(problem){
  busy=false;
  if(!pendingHash){await load().catch(()=>{$('primary').disabled=true;});}
  error(problem);
}};

$('refresh').onclick=async()=>{try{
  if(pendingHash&&wallet){
    const receipt=await wallet.getTransactionReceipt(pendingHash);
    if(!receipt){status(`Transaction ${pendingHash} is still pending. Do not submit another one.`);return;}
    $('result').textContent=`${receipt.status===1?'Confirmed':'Failed'}: ${pendingHash}`;
    pendingHash=undefined;
  }
  await load();
}catch(problem){$('primary').disabled=true;error(problem);}};
window.ethereum?.on?.('accountsChanged',()=>{signer=undefined;address=undefined;$('primary').disabled=true;load().catch(error);});
window.ethereum?.on?.('chainChanged',()=>{signer=undefined;address=undefined;$('primary').disabled=true;load().catch(error);});
load().catch(problem=>{$('primary').disabled=true;error(problem);});
