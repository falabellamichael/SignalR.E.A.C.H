import {Contract,getAddress,keccak256,formatEther,formatUnits,parseEther,toQuantity} from './ethers.mjs';
import {recentPriorityFee} from './fees.mjs';

export async function loadState(provider, deployment, selected) {
  const account=getAddress(selected);
  if(account!==deployment.account)throw new Error(`Select your account ${deployment.account} in MetaMask.`);
  if((await provider.getNetwork()).chainId!==BigInt(deployment.chainId))throw new Error('Select Ethereum Mainnet in MetaMask.');
  const [tokenCode,saleCode]=await Promise.all([provider.getCode(deployment.token),provider.getCode(deployment.sale)]);
  if(keccak256(tokenCode)!==deployment.tokenCodeHash||keccak256(saleCode)!==deployment.saleCodeHash)throw new Error('Contract code does not match your verified deployment.');
  const token=new Contract(deployment.token,deployment.tokenAbi,provider),sale=new Contract(deployment.sale,deployment.saleAbi,provider);
  const [linkedSale,linkedToken,treasury,owner,paused,closed,issuancePaused,canMint,ethBalance,rchBalance,redemptionPaused]=await Promise.all([
    token.initialSale(),sale.rch(),sale.treasury(),sale.owner(),sale.paused(),sale.saleClosed(),token.issuancePaused(),token.hasRole(await token.SALE_MINTER_ROLE(),deployment.sale),provider.getBalance(account),token.balanceOf(account),token.redemptionPaused(),
  ]);
  if(linkedSale!==deployment.sale||linkedToken!==deployment.token||treasury!==deployment.treasury)throw new Error('Contract links or treasury do not match the deployment.');
  return {account,owner,paused,closed,issuancePaused,canMint,ethBalance:ethBalance.toString(),rchBalance:rchBalance.toString(),redemptionPaused,eth:formatEther(ethBalance),rch:formatUnits(rchBalance,18)};
}

async function terms(provider,deployment,state,action,amount,minimum,deadline) {
  const sale=new Contract(deployment.sale,deployment.saleAbi,provider);
  if(state.closed)throw new Error('The sale has been permanently closed.');
  if(state.issuancePaused||!state.canMint)throw new Error('RCH issuance is not enabled for this sale.');
  if(action==='open'){
    if(state.owner!==state.account)throw new Error('Only the current sale owner can open purchases.');
    if(!state.paused)throw new Error('The sale is already open.');
    await sale.quote(parseEther('1')); // Validate the oracle before preparing activation.
    return {value:0n,data:sale.interface.encodeFunctionData('unpause'),amountEth:'0'};
  }
  if(action!=='buy')throw new Error('Unknown operation.');
  if(state.paused)throw new Error('Open the sale and wait for confirmation before requesting a purchase quote.');
  if(typeof amount!=='string'||!/^(0|[1-9][0-9]*)(\.[0-9]{1,18})?$/.test(amount))throw new Error('Enter an ETH amount with up to 18 decimal places.');
  const value=parseEther(amount);
  if(value<=0n)throw new Error('Enter a purchase amount greater than zero.');
  const [expected]=await sale.quote(value);
  const block=await provider.getBlock('latest');
  const min=minimum===undefined?expected*9950n/10000n:BigInt(minimum);
  const expiry=deadline===undefined?block.timestamp+600:deadline;
  if(min<=0n||expected<min)throw new Error('The quote moved below your minimum. Request a new quote.');
  if(!Number.isSafeInteger(expiry)||expiry<=block.timestamp)throw new Error('Purchase quote expired. Request a new quote.');
  return {value,data:sale.interface.encodeFunctionData('buy',[min,expiry]),amountEth:formatEther(value),expectedRch:formatUnits(expected,18),minimumRch:formatUnits(min,18),minimumBaseUnits:min.toString(),deadline:expiry};
}

export async function prepareOperation(provider,deployment,selected,action,amount,feeCeiling) {
  if(!/^(0|[1-9][0-9]*)(\.[0-9]{1,18})?$/.test(feeCeiling)||parseEther(feeCeiling)<=0n)throw new Error('Enter a positive maximum gas fee in ETH.');
  const state=await loadState(provider,deployment,selected);
  const values=await terms(provider,deployment,state,action,amount);
  const [gasEstimate,block,history,nonce]=await Promise.all([
    provider.estimateGas({from:state.account,to:deployment.sale,value:values.value,data:values.data}),provider.getBlock('latest'),provider.send('eth_feeHistory',['0x5','latest',[50]]),provider.getTransactionCount(state.account,'pending'),
  ]);
  if(block.baseFeePerGas==null)throw new Error('Network fee information is missing.');
  const gas=(gasEstimate*120n+99n)/100n,tip=recentPriorityFee(history),maxFee=2n*block.baseFeePerGas+tip,maximum=gas*maxFee;
  if(maximum>parseEther(feeCeiling))throw new Error(`Maximum gas fee ${formatEther(maximum)} ETH exceeds the selected ${feeCeiling} ETH limit.`);
  const total=values.value+maximum;
  if(total>BigInt(state.ethBalance))throw new Error(`This requires ${formatEther(total)} ETH including maximum gas. Your balance is ${state.eth} ETH. Enter a smaller purchase amount or refresh when fees fall.`);
  return {action,createdAt:Date.now(),amountEth:values.amountEth,expectedRch:values.expectedRch,minimumRch:values.minimumRch,minimumBaseUnits:values.minimumBaseUnits,deadline:values.deadline,feeCeiling,estimatedFeeEth:formatEther(gasEstimate*(block.baseFeePerGas+tip)),maximumFeeEth:formatEther(maximum),maximumTotalEth:formatEther(total),remainingEth:formatEther(BigInt(state.ethBalance)-total),transaction:{from:state.account,to:deployment.sale,chainId:toQuantity(deployment.chainId),type:'0x2',nonce:toQuantity(nonce),value:toQuantity(values.value),data:values.data,gas:toQuantity(gas),maxFeePerGas:toQuantity(maxFee),maxPriorityFeePerGas:toQuantity(tip)}};
}

export async function validateOperation(provider,deployment,selected,prepared) {
  if(!prepared||Date.now()-prepared.createdAt>120000||prepared.createdAt>Date.now())throw new Error('The estimate expired. Prepare a fresh estimate.');
  const state=await loadState(provider,deployment,selected);
  const values=await terms(provider,deployment,state,prepared.action,prepared.amountEth,prepared.minimumBaseUnits,prepared.deadline);
  const tx=prepared.transaction;
  if(tx.from!==state.account||tx.to!==deployment.sale||BigInt(tx.chainId)!==BigInt(deployment.chainId)||tx.data!==values.data||BigInt(tx.value)!==values.value)throw new Error('Prepared transaction does not match the reviewed operation.');
  const [nonce,estimate,block]=await Promise.all([provider.getTransactionCount(state.account,'pending'),provider.estimateGas({from:tx.from,to:tx.to,data:tx.data,value:values.value}),provider.getBlock('latest')]);
  if(BigInt(nonce)!==BigInt(tx.nonce))throw new Error('Your wallet nonce changed. Prepare a fresh estimate.');
  if(estimate>BigInt(tx.gas)||block.baseFeePerGas+BigInt(tx.maxPriorityFeePerGas)>BigInt(tx.maxFeePerGas))throw new Error('Gas requirements increased. Prepare a fresh estimate.');
  const maximum=BigInt(tx.gas)*BigInt(tx.maxFeePerGas);
  if(maximum>parseEther(prepared.feeCeiling)||maximum+values.value>BigInt(state.ethBalance))throw new Error('The transaction exceeds your fee limit or current balance.');
  return tx;
}

export async function checkReceipt(provider,deployment,record) {
  if(!/^0x[0-9a-f]{64}$/i.test(record.hash||''))throw new Error('Paste the public transaction hash from MetaMask Activity.');
  if((await provider.getNetwork()).chainId!==BigInt(deployment.chainId))throw new Error('Select Ethereum Mainnet.');
  const [receipt,actual]=await Promise.all([provider.getTransactionReceipt(record.hash),provider.getTransaction(record.hash)]);
  if(!actual)return {status:'pending',message:'Transaction not found yet. Check MetaMask Activity; do not resubmit.'};
  const expected=record.prepared.transaction;
  if(actual.from!==expected.from||actual.to!==expected.to||actual.data!==expected.data||actual.value!==BigInt(expected.value)||actual.nonce!==Number(BigInt(expected.nonce)))throw new Error('This hash is a different transaction. Keep the original request record and check MetaMask Activity.');
  if(!receipt)return {status:'pending',message:'Transaction is pending. Wait and check again.'};
  return {status:receipt.status===1?'confirmed':'failed',message:receipt.status===1?'Transaction confirmed.':'Transaction failed on chain. Gas was charged; refresh before trying again.',blockNumber:receipt.blockNumber,feeEth:formatEther(receipt.fee)};
}
