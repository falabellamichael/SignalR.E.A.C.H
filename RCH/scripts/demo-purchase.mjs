import assert from 'node:assert/strict';
import { formatEther, formatUnits, parseEther } from 'ethers';
import { chain, send } from '../test/helpers/chain.mjs';

const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== '--treasury')) {
  throw new Error('Usage: npm run demo:purchase -- --treasury PUBLIC_ADDRESS');
}
const f = await chain(undefined, { payerIsAdminAndBuyer: true, treasuryAddress: args[1] });
try {
  const payer = await f.deployer.getAddress();
  const treasury = f.treasuryTarget;
  const payment = parseEther('0.001');
  const treasuryBefore = await f.provider.getBalance(treasury);
  const openReceipt = await send(f.sale.unpause());
  const [rchOut, ethUsd] = await f.sale.quote(payment);
  const purchaseReceipt = await send(f.sale.connect(f.buyer).buy(rchOut, await f.now() + 600, { value: payment }));
  const treasuryAfter = await f.provider.getBalance(treasury);
  const buyerRch = await f.token.balanceOf(payer);
  const saleEth = await f.provider.getBalance(await f.sale.getAddress());

  assert.equal(openReceipt.status, 1);
  assert.equal(purchaseReceipt.status, 1);
  assert.equal(treasuryAfter - treasuryBefore, payment);
  assert.equal(buyerRch, rchOut);
  assert.equal(saleEth, 0n);

  console.log('Local Ethereum chain 1337; these addresses and test ETH are not on mainnet.');
  console.log(`Payer, administrator, buyer: ${payer}`);
  console.log(`Treasury: ${treasury}`);
  console.log(`RCH token: ${await f.token.getAddress()}`);
  console.log(`Sale: ${await f.sale.getAddress()}`);
  console.log(`Open transaction: ${openReceipt.hash}`);
  console.log(`Purchase transaction: ${purchaseReceipt.hash}`);
  console.log(`Payment: ${formatEther(payment)} test ETH at $${formatUnits(ethUsd, 8)}/ETH`);
  console.log(`Buyer received: ${formatUnits(buyerRch, 18)} RCH`);
  console.log(`Treasury received: ${formatEther(treasuryAfter - treasuryBefore)} test ETH`);
  console.log(`Sale retained: ${formatEther(saleEth)} test ETH`);
  console.log('Verified: purchase and treasury transfer succeeded together.');
} finally {
  await f.cleanup();
}
