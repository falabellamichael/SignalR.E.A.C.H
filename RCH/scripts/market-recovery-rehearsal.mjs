// Read-only mainnet fork rehearsal. Never sends a mainnet transaction.
import ganache from 'ganache';
import {BrowserProvider,Contract,Interface,parseUnits,formatUnits,ZeroAddress} from 'ethers';
import {MARKET} from './market-plan.mjs';
import {RECOVERY,buildWithdrawalPlan,buildLiquidityPlan} from './market-recovery-plan.mjs';

const fork=ganache.provider({
  fork:{url:process.env.RCH_RPC_URL||'https://ethereum-rpc.publicnode.com',blockNumber:26072906},
  wallet:{unlockedAccounts:[MARKET.payer,MARKET.owner]},
  logging:{quiet:true},
});
const provider=new BrowserProvider(fork);
const ercAbi=['function balanceOf(address) view returns (uint256)','function approve(address,uint256) returns (bool)'];
const manager=new Contract(MARKET.manager,['function positions(uint256) view returns (uint96,address,address,address,uint24,int24,int24,uint128,uint256,uint256,uint128,uint128)','function ownerOf(uint256) view returns (address)'],provider);
const rch=new Contract(MARKET.rch,ercAbi,provider);
const usdc=new Contract(MARKET.usdc,ercAbi,provider);
const factory=new Contract(MARKET.factory,['function getPool(address,address,uint24) view returns (address)'],provider);
const quoter=new Contract('0xb27308f9F90D607463bb33eA1BeBb41C27CE5AB6',[
  'function quoteExactInputSingle(address,address,uint24,uint256,uint160) returns (uint256)',
],provider);
const receipts=[];
try{
  for(const address of [MARKET.payer,MARKET.owner]){
    await fork.request({method:'evm_setAccountBalance',params:[address,'0xDE0B6B3A7640000']});
  }
  const owner=await provider.getSigner(MARKET.owner);
  const payer=await provider.getSigner(MARKET.payer);
  const old=await manager.positions(RECOVERY.oldPositionId);
  const initialRch=await rch.balanceOf(MARKET.payer);
  const {chainId:_withdrawChain,...withdrawTx}=buildWithdrawalPlan(old[7]).transaction;
  receipts.push(await (await owner.sendTransaction(withdrawTx)).wait());
  const recovered=await usdc.balanceOf(MARKET.payer);
  const pool=await factory.getPool(MARKET.rch,MARKET.usdc,RECOVERY.newFee);
  if(pool!==ZeroAddress)throw new Error(`Fee-tier ${RECOVERY.newFee} pool already exists: ${pool}`);
  const plan=buildLiquidityPlan();
  if(recovered<BigInt(plan.usdcDesired))throw new Error('Recovery yielded too little USDC for the new position.');
  receipts.push(await (await payer.sendTransaction({to:MARKET.rch,data:plan.approveRchData})).wait());
  receipts.push(await (await payer.sendTransaction({to:MARKET.usdc,data:plan.approveUsdcData})).wait());
  const {chainId:_mintChain,...mintTx}=plan.transaction;
  receipts.push(await (await payer.sendTransaction(mintTx)).wait());
  const newPool=await factory.getPool(MARKET.rch,MARKET.usdc,RECOVERY.newFee);
  const poolContract=new Contract(newPool,['function liquidity() view returns (uint128)'],provider);
  const activeLiquidity=await poolContract.liquidity();
  const rchAfter=await rch.balanceOf(MARKET.payer);
  const usdcAfter=await usdc.balanceOf(MARKET.payer);
  const quotes=[];
  for(const usdcInput of ['0.01','0.1','1','10']){
    const out=await quoter.quoteExactInputSingle.staticCall(MARKET.usdc,MARKET.rch,RECOVERY.newFee,parseUnits(usdcInput,6),0);
    quotes.push({usdcIn:usdcInput,rchOut:formatUnits(out,18)});
  }
  console.log(JSON.stringify({forkBlock:await provider.getBlockNumber(),recoveredUsdc:formatUnits(recovered,6),newPool,
    activeLiquidity:activeLiquidity.toString(),spentRch:formatUnits(initialRch-rchAfter,18),
    leftover:{rch:formatUnits(rchAfter,18),usdc:formatUnits(usdcAfter,6)},
    gasUsed:receipts.map(x=>x.gasUsed.toString()),quotes},null,2));
}finally{
  await fork.disconnect();
}
