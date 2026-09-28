import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
import {JsonRpcProvider,Contract,ZeroAddress,formatEther,formatUnits,keccak256} from 'ethers';
import {MARKET,erc20Interface,factoryInterface} from './market-plan.mjs';
import {RECOVERY,recoveryManagerInterface,buildWithdrawalPlan,buildLiquidityPlan} from './market-recovery-plan.mjs';

const provider=new JsonRpcProvider(process.env.RCH_RPC_URL||'https://ethereum-rpc.publicnode.com',MARKET.chainId);
const deployment=JSON.parse(await readFile(new URL('../terminal/mainnet.json',import.meta.url),'utf8'));
if((await provider.getNetwork()).chainId!==1n)throw new Error('RPC is not Ethereum mainnet.');
const [tokenCode,managerCode,factoryCode]=await Promise.all([
  provider.getCode(MARKET.rch),provider.getCode(MARKET.manager),provider.getCode(MARKET.factory),
]);
if(keccak256(tokenCode)!==deployment.tokenCodeHash||managerCode==='0x'||factoryCode==='0x')throw new Error('Market contract verification failed.');

const token=new Contract(MARKET.rch,erc20Interface,provider);
const usdc=new Contract(MARKET.usdc,erc20Interface,provider);
const manager=new Contract(MARKET.manager,[
  ...recoveryManagerInterface.fragments,
  'function ownerOf(uint256) view returns (address)',
  'function positions(uint256) view returns (uint96,address,address,address,uint24,int24,int24,uint128,uint256,uint256,uint128,uint128)',
],provider);
const factory=new Contract(MARKET.factory,factoryInterface,provider);
const poolAbi=['function liquidity() view returns (uint128)'];
const createPlan=()=>buildLiquidityPlan();

async function liveState(){
  const [block,owner,position,oldPool,newPool,rchBalance,usdcBalance,payerEth,ownerEth,rchAllowance,usdcAllowance]=await Promise.all([
    provider.getBlockNumber(),manager.ownerOf(RECOVERY.oldPositionId),manager.positions(RECOVERY.oldPositionId),
    factory.getPool(MARKET.rch,MARKET.usdc,MARKET.fee),factory.getPool(MARKET.rch,MARKET.usdc,RECOVERY.newFee),token.balanceOf(MARKET.payer),
    usdc.balanceOf(MARKET.payer),provider.getBalance(MARKET.payer),provider.getBalance(MARKET.owner),
    token.allowance(MARKET.payer,MARKET.manager),usdc.allowance(MARKET.payer,MARKET.manager),
  ]);
  if(owner!==MARKET.owner||oldPool!==RECOVERY.oldPool||position[2]!==MARKET.rch||position[3]!==MARKET.usdc||position[4]!==3000n)throw new Error('Existing position identity changed.');
  if(newPool!==ZeroAddress){
    if(newPool!==RECOVERY.newPool)throw new Error('New pool address changed.');
    const [newOwner,newPosition]=await Promise.all([manager.ownerOf(RECOVERY.newPositionId),manager.positions(RECOVERY.newPositionId)]);
    if(newOwner!==MARKET.owner||newPosition[2]!==MARKET.rch||newPosition[3]!==MARKET.usdc||
      newPosition[4]!==BigInt(RECOVERY.newFee)||newPosition[5]!==BigInt(RECOVERY.newTickLower)||
      newPosition[6]!==BigInt(RECOVERY.newTickUpper))throw new Error('New position identity changed.');
  }
  const newPoolLiquidity=newPool===ZeroAddress?'0':(await new Contract(newPool,poolAbi,provider).liquidity()).toString();
  let collectible;
  if(position[7]>0n&&newPool===ZeroAddress){
    const withdrawal=buildWithdrawalPlan(position[7]);
    const calls=Array.from(recoveryManagerInterface.decodeFunctionData('multicall',withdrawal.transaction.data)[0]);
    const result=await manager.multicall.staticCall(calls,{from:MARKET.owner});
    const amounts=recoveryManagerInterface.decodeFunctionResult('collect',result[1]);
    collectible={rch:formatUnits(amounts[0],18),usdc:formatUnits(amounts[1],6),usdcBaseUnits:amounts[1].toString()};
  }
  const plan=createPlan();
  return {block,payer:MARKET.payer,owner:MARKET.owner,oldPool:RECOVERY.oldPool,
    oldPositionId:RECOVERY.oldPositionId,oldPositionLiquidity:position[7].toString(),collectible,
    newPool,newPoolLiquidity,rch:formatUnits(rchBalance,18),usdc:formatUnits(usdcBalance,6),
    payerEth:formatEther(payerEth),ownerEth:formatEther(ownerEth),
    rchAllowance:rchAllowance.toString(),usdcAllowance:usdcAllowance.toString(),
    readyWithdraw:newPool===ZeroAddress&&position[7]>0n&&BigInt(collectible?.usdcBaseUnits||0)>=BigInt(plan.usdcDesired),
    readyMint:newPool===ZeroAddress&&position[7]===0n&&rchBalance>=BigInt(plan.rchDesired)&&usdcBalance>=BigInt(plan.usdcDesired),
  };
}

const startup=await liveState();
if(startup.newPool===ZeroAddress&&!startup.readyWithdraw&&!startup.readyMint)throw new Error('The old position or wallet balances do not match the rehearsed recovery.');

const prefix=`/${randomBytes(20).toString('hex')}/`;
const files=new Map([
  ['',[new URL('../tools/market-recovery.html',import.meta.url),'text/html']],
  ['market-recovery.js',[new URL('../tools/market-recovery.js',import.meta.url),'text/javascript']],
  ['ethers.js',[new URL('../node_modules/ethers/dist/ethers.umd.min.js',import.meta.url),'text/javascript']],
]);
let origin;
const server=createServer(async(req,res)=>{
  const headers={'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer',
    'Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"};
  const send=(status,body,type='application/json')=>{res.writeHead(status,{...headers,'Content-Type':type+'; charset=utf-8'});res.end(typeof body==='string'||Buffer.isBuffer(body)?body:JSON.stringify(body));};
  if(req.headers.host!==new URL(origin).host||!req.url.startsWith(prefix)||req.method!=='GET'){send(404,{error:'Not found'});return;}
  const name=req.url.slice(prefix.length);
  try{
    if(name==='plan.json'){
      const state=await liveState();
      send(200,{market:{...MARKET,...RECOVERY},state,
        withdrawal:state.readyWithdraw?buildWithdrawalPlan(state.oldPositionLiquidity):null,
        liquidity:state.newPool===ZeroAddress?buildLiquidityPlan():null});return;
    }
    if(name==='state.json'){send(200,await liveState());return;}
    const file=files.get(name);if(!file){send(404,{error:'Not found'});return;}
    send(200,await readFile(file[0]),file[1]);
  }catch(error){send(409,{error:error.shortMessage||error.message||'Market check failed'});}
});
server.requestTimeout=15000;server.headersTimeout=10000;
await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
origin=`http://127.0.0.1:${server.address().port}`;
console.log(`RCH recovery review: ${origin}${prefix}`);
console.log(`Old NFT owner: ${MARKET.owner}\nLiquidity payer: ${MARKET.payer}\nOld USDC claim: ${startup.collectible?.usdc||'withdrawn'}\nNew pool: ${startup.newPool}`);
process.on('SIGINT',()=>{server.close();provider.destroy();});
