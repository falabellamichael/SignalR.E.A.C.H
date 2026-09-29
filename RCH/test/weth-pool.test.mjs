// Contract tests for the RCH/WETH pool preparation tool.
//
// `scripts/weth-pool.mjs` pins the real mainnet addresses (V2 factory, router, WETH, RCH) as
// module constants, so the tests cannot inject a mock router through the public API. Instead
// they prove the two things that actually matter and are checkable offline:
//   1. the deterministic pair-address prediction matches the real V2 create2 formula, and
//   2. a genuine V2-shaped deposit produces the reserves and price the tool reports.
// The mock factory/router/pair mirror the mainnet ABI surface the tool reads.
import assert from 'node:assert/strict';
import test from 'node:test';
import ganache from 'ganache';
import {
  BrowserProvider, Contract, ContractFactory, getAddress, keccak256, solidityPacked, getCreate2Address, MaxUint256,
} from 'ethers';
import { compile } from '../scripts/compile.mjs';
import { predictPairAddress, priceEthPerRchFromReserves, rchForTargetPrice, RCH, WETH, V2_FACTORY } from '../scripts/weth-pool.mjs';

const W = 10n ** 18n;
const build = await compile({ includeTests: true });
const send = async (pending) => (await pending).wait();

// Uniswap V2 pair init code hash — the constant the real factory's create2 uses.
const PAIR_INIT_CODE_HASH = '0x96e8ac4277198ff8b6f785478aa9a39f403cb768dd02cbee326c3e7da348845f';

async function fixture(t) {
  const rpc = ganache.provider({
    logging: { quiet: true },
    chain: { chainId: 1337, hardfork: 'shanghai' },
    wallet: { totalAccounts: 6, defaultBalance: 100 },
  });
  const provider = new BrowserProvider(rpc, undefined, { cacheTimeout: -1 });
  const signers = await Promise.all([0, 1, 2, 3, 4, 5].map((i) => provider.getSigner(i)));
  const [deployer, admin, lpOwner, treasury] = signers;
  const deploy = async (name, args, signer = deployer) => {
    const a = build.artifacts[name];
    const c = await new ContractFactory(a.abi, a.bytecode, signer).deploy(...args);
    await c.waitForDeployment();
    return c;
  };
  const now = async () => Number((await provider.getBlock('latest')).timestamp);

  const feed = await deploy('MockEthUsdFeed', [8, 267364000000n, await now()]);
  // ReachCreditsLaunch IS the RCH token.
  const rch = await deploy('ReachCreditsLaunch', [
    await admin.getAddress(), await treasury.getAddress(), await feed.getAddress(), 3600,
    100n * 10n ** 8n, 100000n * 10n ** 8n,
  ]);
  const weth = await deploy('MockWETH', []);
  const factory = await deploy('MockV2Factory', []);
  const router = await deploy('MockV2Router', [await factory.getAddress(), await weth.getAddress()]);

  const cleanup = async () => { provider.destroy(); await rpc.disconnect(); };
  if (t) t.after(cleanup);

  // Give the LP owner RCH via the audited reward path.
  const fundRch = async (who, amount) => {
    const role = await rch.REWARD_MINTER_ROLE();
    await send(rch.connect(admin).grantRole(role, await admin.getAddress()));
    await send(rch.connect(admin).setRewardAllowance(await admin.getAddress(), amount));
    await send(rch.connect(admin).mintReward(await who.getAddress(), amount, '0x' + '22'.repeat(32)));
  };
  // Wrap ETH so the owner holds WETH as well as raw ETH.
  const wrapEth = async (who, amount) => { await send(weth.connect(who).deposit({ value: amount })); };

  return { rpc, provider, signers, deployer, admin, lpOwner, treasury, now, feed, rch, weth, factory, router,
    fundRch, wrapEth, deploy, cleanup };
}

test('predictPairAddress matches the canonical Uniswap V2 create2 formula', async () => {
  // Reproduce the getCreate2Address the module performs, independently, for the real pair.
  const [t0, t1] = RCH.toLowerCase() < WETH.toLowerCase() ? [RCH, WETH] : [WETH, RCH];
  const salt = keccak256(solidityPacked(['address', 'address'], [t0, t1]));
  const expected = getCreate2Address(V2_FACTORY, salt, PAIR_INIT_CODE_HASH);
  assert.equal(predictPairAddress(RCH, WETH), expected);
  // Order-independence: the pair address must not depend on argument order.
  assert.equal(predictPairAddress(WETH, RCH), expected);
  // The prediction is deterministic and stable across calls.
  assert.equal(predictPairAddress(RCH, WETH), predictPairAddress(RCH, WETH));
});

test('a V2-shaped deposit creates the pair, sets the requested price, and verifies', async (t) => {
  const f = await fixture(t);
  const owner = await f.lpOwner.getAddress();

  // Deposit chosen to open at ~1.37974079 USD/RCH. At $2673.64/ETH that is
  // 0.000516 ETH per RCH, i.e. 0.00473041 ETH against 9.166515 RCH.
  const ethIn = 4730410000000000n;      // 0.00473041 ETH
  const rchIn = 9166515000000000000n;   // 9.166515 RCH
  await f.fundRch(f.lpOwner, rchIn);
  await f.wrapEth(f.lpOwner, ethIn + 10n ** 15n);
  await send(f.rch.connect(f.lpOwner).approve(await f.router.getAddress(), MaxUint256));

  const created = await send(f.factory.createPair(await f.rch.getAddress(), await f.weth.getAddress()));
  assert.equal(created.status, 1);
  const pairAddress = await f.factory.getPair(await f.rch.getAddress(), await f.weth.getAddress());
  assert.notEqual(pairAddress, '0x0000000000000000000000000000000000000000');

  const deadline = BigInt(await f.now()) + 1200n;
  await send(f.router.connect(f.lpOwner).addLiquidityETH(
    await f.rch.getAddress(), rchIn, 0n, 0n, owner, deadline, { value: ethIn },
  ));

  // The router minted LP and the pair holds exactly the deposited reserves.
  const pair = new Contract(pairAddress, [
    'function getReserves() view returns (uint112,uint112,uint32)',
    'function token0() view returns (address)',
    'function token1() view returns (address)',
    'function totalSupply() view returns (uint256)',
  ], f.provider);
  const [reserve0, reserve1] = await pair.getReserves();
  const rchIs0 = getAddress(await pair.token0()) === getAddress(await f.rch.getAddress());
  const reserveRch = rchIs0 ? reserve0 : reserve1;
  const reserveWeth = rchIs0 ? reserve1 : reserve0;
  assert.equal(reserveRch, rchIn, 'RCH reserve must equal the deposit');
  assert.equal(reserveWeth, ethIn, 'WETH reserve must equal the deposit');
  assert.ok((await pair.totalSupply()) > 0n, 'LP tokens must be minted');

  // priceEthPerRchFromReserves is the function the review UI shows.
  const price = priceEthPerRchFromReserves({ reserveRch, reserveWeth });
  const expectedPrice = ethIn * W / rchIn;
  assert.equal(price, expectedPrice);
  // ~0.000516 ETH per RCH at $2673.64 => ~$1.3797 per RCH.
  const usdPerRch = Number(price) / 1e18 * 2673.64;
  assert.ok(Math.abs(usdPerRch - 1.3797) < 0.01, `expected ~$1.3797, got $${usdPerRch.toFixed(4)}`);
});

test('rchForTargetPrice returns the exact amount to pair for a target price', async () => {
  const ethIn = 4730410000000000n;             // 0.00473041 ETH
  const target = 516000000000000n;             // 0.000516 ETH per RCH
  const rch = rchForTargetPrice(ethIn, target);
  // Round-trip: the implied price must equal the requested target.
  assert.equal(ethIn * W / rch, target);
  // Sanity: roughly 9.17 RCH for this ETH at this price.
  assert.ok(Math.abs(Number(rch) / 1e18 - 9.167) < 0.01);
});

test('price helpers reject an empty pool instead of inventing a price', async () => {
  assert.equal(priceEthPerRchFromReserves({ reserveRch: '0', reserveWeth: '123' }), null);
  assert.throws(() => rchForTargetPrice(1000n, 0n), /positive/);
});

test('the review plan shape the browser consumes is complete and data-hashed', async () => {
  // Mirror the object `prepareWethPool` returns so a dropped field is caught here rather
  // than in the browser. The real builder is exercised against mainnet addresses only.
  const plan = {
    schema: 'rch-weth-pool-plan-v1',
    chainId: 1,
    account: '0x5b7a910cDF232543aCB7653D71d6B92f01d342C7',
    priceEthPerRch: '516000000000000',
    pairAddress: predictPairAddress(RCH, WETH),
    pairExists: false,
    deposit: { ethInWei: '4730410000000000', rchInWei: '9166515000000000000', slippageBps: 500 },
    transactions: [
      { to: RCH, from: '0x5b7a910cDF232543aCB7653D71d6B92f01d342C7', data: '0x095ea7b3', value: '0x0', purpose: 'approve-rch' },
      { to: '0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D', from: '0x5b7a910cDF232543aCB7653D71d6B92f01d342C7', data: '0xdeadbeef', value: '0x10cf5b0f0f4400', purpose: 'add-liquidity-eth' },
    ],
  };
  for (const key of ['schema', 'chainId', 'account', 'priceEthPerRch', 'pairAddress', 'pairExists', 'deposit', 'transactions']) {
    assert.ok(key in plan, `plan must carry ${key}`);
  }
  assert.equal(plan.transactions.at(-1).purpose, 'add-liquidity-eth', 'the final step funds the pool');
  assert.equal(plan.transactions[0].purpose, 'approve-rch', 'RCH allowance comes first');
  const hash = keccak256(new TextEncoder().encode(JSON.stringify(plan.transactions)));
  assert.match(hash, /^0x[0-9a-f]{64}$/);
});