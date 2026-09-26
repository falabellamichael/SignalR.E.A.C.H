import { id, parseEther, parseUnits, formatUnits } from 'ethers';
import { chain, send } from '../test/helpers/chain.mjs';

const f = await chain();
try {
  console.log('Ephemeral local Ethereum demonstration; no Docker or external RPC.');
  console.log(`RCH: ${await f.token.getAddress()}\nSale: ${await f.sale.getAddress()}`);
  await send(f.sale.unpause());
  // Use $2,500/ETH so the $10 purchase is exact and easy to inspect.
  await send(f.feed.setAnswer(2500n * 10n ** 8n, await f.now()));
  const payment = parseEther('0.004');
  const [output] = await f.sale.quote(payment);
  const bought = await send(f.sale.connect(f.buyer).buy(output, await f.now() + 600, { value: payment }));
  console.log(`Purchase: 0.004 test ETH ($10 at the mock quote) -> ${formatUnits(output, 18)} RCH`);
  console.log(`Purchase transaction: ${bought.hash}`);
  const operator = await f.rewardMinter.getAddress();
  await send(f.token.connect(f.admin).grantRole(await f.token.REWARD_MINTER_ROLE(), operator));
  await send(f.token.connect(f.admin).setRewardAllowance(operator, parseUnits('25', 18)));
  await send(f.token.connect(f.rewardMinter).mintReward(await f.buyer.getAddress(), parseUnits('5', 18), id('local-demo-reward-1')));
  console.log(`Reward: 5 RCH; remaining operator allowance: ${formatUnits(await f.token.rewardAllowance(operator), 18)} RCH`);
  await send(f.token.connect(f.buyer).transfer(await f.other.getAddress(), parseUnits('1', 18)));
  console.log('Transfer: 1 RCH sent to another wallet.');
  await send(f.sale.closeSale());
  console.log(`Total supply: ${formatUnits(await f.token.totalSupply(), 18)} RCH; proceeds delivered during purchase; sale closed.`);
  console.log('Usage conversion: 1 RCH -> 1,000,000 AI usage tokens. Live hosted redemption remains disabled.');
} finally { await f.cleanup(); }
