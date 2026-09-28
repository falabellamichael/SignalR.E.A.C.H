import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
import {JsonRpcProvider,Contract,ZeroAddress,formatEther,formatUnits,keccak256} from 'ethers';
import {MARKET,buildMarketPlan,factoryInterface,erc20Interface} from './market-plan.mjs';

const provider=new JsonRpcProvider(process.env.RCH_RPC_URL||'https://ethereum-rpc.publicnode.com',MARKET.chainId);
const deployment=JSON.parse(await readFile(new URL('../terminal/mainnet.json',import.meta.url),'utf8'));
if((await provider.getNetwork()).chainId!==1n)throw new Error('RPC is not Ethereum mainnet.');
const [tokenCode,managerCode,factoryCode,ownerCode]=await Promise.all([
  provider.getCode(MARKET.rch),provider.getCode(MARKET.manager),provider.getCode(MARKET.factory),provider.getCode(MARKET.owner),
]);
if(keccak256(tokenCode)!==deployment.tokenCodeHash||managerCode==='0x'||factoryCode==='0x'||ownerCode!=='0x')throw new Error('Market contract or recipient verification failed.');
const token=new Contract(MARKET.rch,erc20Interface,provider);
const factory=new Contract(MARKET.factory,factoryInterface,provider);
async function liveState(){
  const [pool,balance,allowance,eth,block]=await Promise.all([
    factory.getPool(MARKET.rch,MARKET.usdc,MARKET.fee),token.balanceOf(MARKET.payer),
    token.allowance(MARKET.payer,MARKET.manager),provider.getBalance(MARKET.payer),provider.getBlockNumber(),
  ]);
  return {pool,block,rch:formatUnits(balance,18),eth:formatEther(eth),allowance:allowance.toString(),ready:pool===ZeroAddress&&balance>=BigInt(buildMarketPlan().rchRequired)&&eth>0n};
}
const startup=await liveState();
if(startup.pool!==ZeroAddress)throw new Error('This fee-tier pool already exists. Stop and review its live price before adding liquidity.');
if(!startup.ready)throw new Error('The paying wallet lacks RCH or ETH for this position.');

const prefix=`/${randomBytes(20).toString('hex')}/`;
const files=new Map([
  ['',[new URL('../tools/market.html',import.meta.url),'text/html']],
  ['market.js',[new URL('../tools/market.js',import.meta.url),'text/javascript']],
  ['ethers.js',[new URL('../node_modules/ethers/dist/ethers.umd.min.js',import.meta.url),'text/javascript']],
]);
let origin;
const server=createServer(async(req,res)=>{
  const headers={'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"};
  const send=(status,body,type='application/json')=>{res.writeHead(status,{...headers,'Content-Type':type+'; charset=utf-8'});res.end(typeof body==='string'||Buffer.isBuffer(body)?body:JSON.stringify(body));};
  if(req.headers.host!==new URL(origin).host||!req.url.startsWith(prefix)||req.method!=='GET'){send(404,{error:'Not found'});return;}
  const name=req.url.slice(prefix.length);
  try{
    if(name==='plan.json'){const state=await liveState();if(state.pool!==ZeroAddress)throw new Error('Pool now exists; review before continuing.');send(200,buildMarketPlan());return;}
    if(name==='state.json'){send(200,await liveState());return;}
    const file=files.get(name);if(!file){send(404,{error:'Not found'});return;}
    send(200,await readFile(file[0]),file[1]);
  }catch(error){send(409,{error:error.shortMessage||error.message||'Market check failed'});}
});
server.requestTimeout=15000;server.headersTimeout=10000;
await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
origin=`http://127.0.0.1:${server.address().port}`;
console.log(`RCH market review: ${origin}${prefix}`);
console.log(`Payer: ${MARKET.payer}\nPosition owner: ${MARKET.owner}\nRCH allocation: ${MARKET.rchAmount}\nCurrent balance: ${startup.rch} RCH, ${startup.eth} ETH\nNo transaction has been signed or sent.`);
process.on('SIGINT',()=>{server.close();provider.destroy();});
