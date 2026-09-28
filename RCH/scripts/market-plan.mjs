import {Interface, getAddress, parseUnits} from 'ethers';

export const MARKET=Object.freeze({
  chainId:1,
  payer:getAddress('0xDa68602c9d65337C75BF0593972d9731895592e3'),
  owner:getAddress('0x5b7a910cDF232543aCB7653D71d6B92f01d342C7'),
  rch:getAddress('0x6Cfb2531696f99Cd4511F281aBECe4b6a67c3792'),
  usdc:getAddress('0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'),
  factory:getAddress('0x1F98431c8aD98523631AE4a59f267346ea31F984'),
  manager:getAddress('0xC36442b4a4522E871399CD717aBDD847Ab11FE88'),
  fee:3000,
  rchAmount:'100',
});

export const factoryInterface=new Interface(['function getPool(address,address,uint24) view returns (address)']);
export const erc20Interface=new Interface(['function balanceOf(address) view returns (uint256)','function allowance(address,address) view returns (uint256)','function approve(address,uint256) returns (bool)']);
export const managerInterface=new Interface([
  'function createAndInitializePoolIfNecessary(address,address,uint24,uint160) payable returns (address)',
  'function mint((address token0,address token1,uint24 fee,int24 tickLower,int24 tickUpper,uint256 amount0Desired,uint256 amount1Desired,uint256 amount0Min,uint256 amount1Min,address recipient,uint256 deadline)) payable returns (uint256,uint128,uint256,uint256)',
  'function multicall(bytes[]) payable returns (bytes[])',
  'event Transfer(address indexed from,address indexed to,uint256 indexed tokenId)',
]);

// Fixed RCH-only position calculated with the Uniswap v3 SDK and exercised on a local mainnet fork.
// The starting raw USDC/RCH ratio is 10,000 / 10^18, or $0.01 per RCH.
const POSITION=Object.freeze({
  sqrtPriceX96:'7922816251426433759354',
  tickLower:-322320,
  tickUpper:-315420,
  amount0Desired:'99999999999999692169',
  amount0Min:'99999999999996782948',
  initialPriceUsdcPerRch:'0.01',
  lowerPriceUsdcPerRch:'0.0100581966',
  upperPriceUsdcPerRch:'0.0200524911',
});

export function buildMarketPlan(now=Math.floor(Date.now()/1000)){
  if(!Number.isSafeInteger(now)||now<=0)throw new Error('Invalid plan time.');
  if(BigInt(POSITION.amount0Desired)>parseUnits(MARKET.rchAmount,18)||BigInt(POSITION.amount0Min)>BigInt(POSITION.amount0Desired))throw new Error('RCH cap invariant failed.');
  const deadline=now+20*60;
  const init=managerInterface.encodeFunctionData('createAndInitializePoolIfNecessary',[
    MARKET.rch,MARKET.usdc,MARKET.fee,POSITION.sqrtPriceX96,
  ]);
  const mint=managerInterface.encodeFunctionData('mint',[{
    token0:MARKET.rch,token1:MARKET.usdc,fee:MARKET.fee,
    tickLower:POSITION.tickLower,tickUpper:POSITION.tickUpper,
    amount0Desired:POSITION.amount0Desired,amount1Desired:0,
    amount0Min:POSITION.amount0Min,amount1Min:0,
    recipient:MARKET.owner,deadline,
  }]);
  const data=managerInterface.encodeFunctionData('multicall',[[init,mint]]);
  const decoded=managerInterface.parseTransaction({data});
  const decodedMint=managerInterface.parseTransaction({data:decoded.args[0][1]});
  if(decoded?.name!=='multicall'||decoded.args[0].length!==2||decodedMint?.name!=='mint'||getAddress(decodedMint.args[0].recipient)!==MARKET.owner||decodedMint.args[0].amount1Desired!==0n)throw new Error('Mint recipient or token amounts changed.');
  return {
    ...MARKET,...POSITION,deadline,
    rchRequired:POSITION.amount0Desired,usdcRequired:'0',
    approveData:erc20Interface.encodeFunctionData('approve',[MARKET.manager,POSITION.amount0Desired]),
    transaction:{to:MARKET.manager,data,value:'0x0',from:MARKET.payer,chainId:'0x1'},
  };
}
