const $=id=>document.getElementById(id);
const plan=await (await fetch('./plan.json',{cache:'no-store'})).json();
let wallet,signer,address,live;
const status=message=>{$('status').textContent=message;};
const error=problem=>{
  const message=problem?.shortMessage||problem?.message||String(problem);
  status(/already pending|coalesce error/i.test(message)?'A MetaMask request is already pending. Open MetaMask in Edge and finish or reject it before trying again.':message);
};
const same=(a,b)=>a?.toLowerCase()===b?.toLowerCase();
function renderPlan(){
  const data=[
    ['Pays and signs',plan.payer],['Receives position NFT',plan.owner],
    ['RCH offered',`${plan.rchAmount} RCH (at most)`],['USDC required','0'],
    ['Starting price',`${plan.initialPriceUsdcPerRch} USDC/RCH`],
    ['Selling range',`${plan.lowerPriceUsdcPerRch}–${plan.upperPriceUsdcPerRch} USDC/RCH`],
    ['Position manager',plan.manager],['RCH token',plan.rch],['USDC token',plan.usdc],
  ];
  for(const [label,value] of data){const term=document.createElement('dt'),description=document.createElement('dd');term.textContent=label;description.textContent=value;$('details').append(term,description);}
}
async function refresh(){
  const response=await fetch('./state.json',{cache:'no-store'});live=await response.json();
  if(!response.ok)throw new Error(live.error||'Mainnet check failed.');
  $('state').textContent=`Block ${live.block}\nPaying wallet: ${live.rch} RCH, ${live.eth} ETH\nPool: ${live.pool}\nConnected: ${address||'none'}`;
  const correct=!!signer&&same(address,plan.payer)&&live.ready&&same(live.pool,ethers.ZeroAddress);
  $('approve').disabled=!correct||BigInt(live.allowance)>=BigInt(plan.rchRequired);
  $('create').disabled=!correct||BigInt(live.allowance)<BigInt(plan.rchRequired);
  if(!live.ready)status('The market check is no longer ready. Refresh before signing.');
  else if(address&&!same(address,plan.payer))status('Select the paying wallet in MetaMask.');
  else if(correct)status($('create').disabled?'Approval is ready for review.':'Pool creation is ready for review.');
}
renderPlan();
try{await refresh();}catch(problem){error(problem);}
$('connect').onclick=async()=>{try{
  if(!window.ethereum)throw new Error('MetaMask is not available in this Edge tab.');
  wallet=new ethers.BrowserProvider(window.ethereum);
  const accounts=await wallet.send('eth_requestAccounts',[]);
  const network=await wallet.getNetwork();
  if(network.chainId!==1n)throw new Error('Switch MetaMask to Ethereum mainnet.');
  if(!same(accounts[0],plan.payer))throw new Error(`Select the paying wallet ${plan.payer} in MetaMask.`);
  signer=await wallet.getSigner();address=await signer.getAddress();await refresh();
}catch(problem){error(problem);}};
$('approve').onclick=async()=>{try{
  await refresh();if($('approve').disabled)throw new Error('Approval is not currently available.');
  const transaction=await signer.sendTransaction({to:plan.rch,data:plan.approveData,value:0});
  $('result').textContent=`RCH approval submitted: ${transaction.hash}\nWaiting for confirmation…`;
  const receipt=await transaction.wait();if(receipt.status!==1)throw new Error('RCH approval failed.');
  $('result').textContent=`RCH approval confirmed: ${transaction.hash}`;await refresh();
}catch(problem){error(problem);}};
$('create').onclick=async()=>{try{
  const response=await fetch('./plan.json',{cache:'no-store'});const current=await response.json();
  if(!response.ok)throw new Error(current.error||'Pool check failed.');
  if(!same(current.owner,plan.owner)||!same(current.payer,plan.payer)||current.rchRequired!==plan.rchRequired)throw new Error('Market plan changed. Reload and review it.');
  await refresh();if($('create').disabled)throw new Error('Pool creation is not currently available.');
  const transaction=await signer.sendTransaction(current.transaction);
  $('result').textContent=`Pool creation submitted: ${transaction.hash}\nWaiting for confirmation…`;
  const receipt=await transaction.wait();if(receipt.status!==1)throw new Error('Pool creation failed.');
  const transfer=new ethers.Interface(['event Transfer(address indexed from,address indexed to,uint256 indexed tokenId)']);
  const minted=receipt.logs.filter(log=>same(log.address,plan.manager)).map(log=>{try{return transfer.parseLog(log);}catch{return null;}}).find(log=>log?.name==='Transfer'&&same(log.args.from,ethers.ZeroAddress)&&same(log.args.to,plan.owner));
  if(!minted)throw new Error(`Transaction confirmed but the expected position recipient was not found. Verify ${transaction.hash} on a block explorer.`);
  $('result').textContent=`Pool and position confirmed.\nTransaction: ${transaction.hash}\nPosition NFT: ${minted.args.tokenId}\nOwner: ${plan.owner}`;
  $('approve').disabled=true;$('create').disabled=true;status('Position created and recipient verified.');
}catch(problem){error(problem);}};
window.ethereum?.on?.('accountsChanged',()=>{signer=undefined;address=undefined;refresh().catch(error);});
window.ethereum?.on?.('chainChanged',()=>{signer=undefined;address=undefined;refresh().catch(error);});
