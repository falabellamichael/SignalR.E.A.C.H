import {Interface,parseUnits} from 'ethers';
import {MARKET} from './market-plan.mjs';

export const RECOVERY=Object.freeze({
  oldPool:'0x245Bb5E69641FBb90c5284577439e3FA4b445629',
  oldPositionId:1374637,
  newPool:'0x2621d7b87776f9B4e72797D4E41E326916649124',
  newPositionId:1374664,
  newFee:500,
  newTickLower:-887270,
  newTickUpper:887270,
  sqrtPriceX96:'7922816251426433759354',
  rchDesired:parseUnits('142',18).toString(),
  usdcDesired:parseUnits('1.42',6).toString(),
  startingUsdcPerRch:'0.01',
});

export const recoveryManagerInterface=new Interface([
  'function decreaseLiquidity((uint256 tokenId,uint128 liquidity,uint256 amount0Min,uint256 amount1Min,uint256 deadline)) payable returns (uint256,uint256)',
  'function collect((uint256 tokenId,address recipient,uint128 amount0Max,uint128 amount1Max)) payable returns (uint256,uint256)',
  'function createAndInitializePoolIfNecessary(address,address,uint24,uint160) payable returns (address)',
  'function mint((address token0,address token1,uint24 fee,int24 tickLower,int24 tickUpper,uint256 amount0Desired,uint256 amount1Desired,uint256 amount0Min,uint256 amount1Min,address recipient,uint256 deadline)) payable returns (uint256,uint128,uint256,uint256)',
  'function multicall(bytes[]) payable returns (bytes[])',
]);

const maxUint128=(1n<<128n)-1n;
const deadlineFor=now=>{
  if(!Number.isSafeInteger(now)||now<=0)throw new Error('Invalid plan time.');
  return now+20*60;
};

export function buildWithdrawalPlan(liquidity,now=Math.floor(Date.now()/1000)){
  const amount=BigInt(liquidity);
  if(amount<=0n||amount>maxUint128)throw new Error('Old position has no withdrawable liquidity.');
  const deadline=deadlineFor(now);
  const remove=recoveryManagerInterface.encodeFunctionData('decreaseLiquidity',[{
    tokenId:RECOVERY.oldPositionId,liquidity:amount,amount0Min:0,amount1Min:0,deadline,
  }]);
  const collect=recoveryManagerInterface.encodeFunctionData('collect',[{
    tokenId:RECOVERY.oldPositionId,recipient:MARKET.payer,amount0Max:maxUint128,amount1Max:maxUint128,
  }]);
  return {deadline,transaction:{to:MARKET.manager,from:MARKET.owner,chainId:'0x1',value:'0x0',
    data:recoveryManagerInterface.encodeFunctionData('multicall',[[remove,collect]])}};
}

export function buildLiquidityPlan(now=Math.floor(Date.now()/1000)){
  const deadline=deadlineFor(now);
  const rch=BigInt(RECOVERY.rchDesired);
  const usdc=BigInt(RECOVERY.usdcDesired);
  const init=recoveryManagerInterface.encodeFunctionData('createAndInitializePoolIfNecessary',[
    MARKET.rch,MARKET.usdc,RECOVERY.newFee,RECOVERY.sqrtPriceX96,
  ]);
  const mint=recoveryManagerInterface.encodeFunctionData('mint',[{
    token0:MARKET.rch,token1:MARKET.usdc,fee:RECOVERY.newFee,
    tickLower:RECOVERY.newTickLower,tickUpper:RECOVERY.newTickUpper,
    amount0Desired:rch,amount1Desired:usdc,
    amount0Min:rch*995n/1000n,amount1Min:usdc*995n/1000n,
    recipient:MARKET.owner,deadline,
  }]);
  const erc20=new Interface(['function approve(address spender,uint256 amount) returns (bool)']);
  return {deadline,rchDesired:RECOVERY.rchDesired,usdcDesired:RECOVERY.usdcDesired,
    approveRchData:erc20.encodeFunctionData('approve',[MARKET.manager,rch]),
    approveUsdcData:erc20.encodeFunctionData('approve',[MARKET.manager,usdc]),
    transaction:{to:MARKET.manager,from:MARKET.payer,chainId:'0x1',value:'0x0',
      data:recoveryManagerInterface.encodeFunctionData('multicall',[[init,mint]])}};
}
