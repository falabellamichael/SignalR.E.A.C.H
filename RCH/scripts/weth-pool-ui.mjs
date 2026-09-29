// Local review server for creating the first RCH/WETH Uniswap V2 pair.
//
// Mirrors the existing `replacement-ui.mjs` conventions: a random per-run path prefix, a
// loopback-only bind, a strict Content-Security-Policy, and no address or key handling.
// The server only serves the reviewed plan and live read-only state. Every transaction is
// built in the page and signed by the operator's own wallet; this process never holds a key.
//
// Usage:
//   node scripts/weth-pool-ui.mjs --eth 0.00473041 --rch 9.166515
//   node scripts/weth-pool-ui.mjs --eth-usd-budget 11.50        (derive the crowd price)

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { JsonRpcProvider, formatEther, formatUnits, parseEther, parseUnits } from 'ethers';
import { root } from './compile.mjs';
import { openBrowser } from '../terminal/approval.mjs';
import {
  WETH, RCH, V2_FACTORY, V2_ROUTER,
  readPoolState, priceEthPerRchFromReserves, rchForTargetPrice,
} from './weth-pool.mjs';

const { values: options } = parseArgs({
  options: {
    eth: { type: 'string' },
    rch: { type: 'string' },
    'eth-usd-budget': { type: 'string' },
    account: { type: 'string' },
    'no-open': { type: 'boolean' },
    port: { type: 'string' },
  },
});

const port = Number(options.port ?? 8766);
if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error('Invalid --port.');

const rpcUrl = process.env.RCH_RPC_URL;
if (typeof rpcUrl !== 'string' || !/^https?:\/\//.test(rpcUrl)) {
  throw new Error('Set RCH_RPC_URL to an Ethereum mainnet HTTPS endpoint (read-only is fine).');
}
const provider = new JsonRpcProvider(rpcUrl);
if ((await provider.getNetwork()).chainId !== 1n) throw new Error('RCH_RPC_URL must be Ethereum mainnet.');

// A read-only price read so the operator can size the deposit against the live market.
const chainlink = '0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419';
const feedAbi = ['function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)'];
const { Contract } = await import('ethers');
const ethUsdE8 = (await new Contract(chainlink, feedAbi, provider).latestRoundData())[1];
const ethUsd = Number(ethUsdE8) / 1e8;

// Derive the ETH/RCH ratio. Either the operator states both amounts, or they give a USD
// budget and we pair at the live RCH/USDC price so the WETH pair opens at the same price.
import { readFileSync } from 'node:fs';
const manifest = JSON.parse(readFileSync(resolve(root, 'terminal/mainnet.json'), 'utf8'));
const { Decoder } = await import('ethers');
const usdcPoolAbi = ['function slot0() view returns (uint160,int24,uint16,uint16,uint16,uint8,bool)'];
const usdcPool = '0x2621d7b87776f9b4e72797d4e41e326916649124';
const sqrtPriceX96 = (await new Contract(usdcPool, usdcPoolAbi, provider).slot0())[0];
// RCH is token0 (18dp), USDC is token1 (6dp) in that pool.
const ratio = Number(sqrtPriceX96) / 2 ** 96;
const liveUsdPerRch = ratio * ratio * 1e12;

let ethInWei;
let rchInWei;
if (options.eth && options.rch) {
  ethInWei = parseEther(options.eth);
  rchInWei = parseUnits(options.rch, 18);
} else if (options['eth-usd-budget']) {
  const usd = Number(options['eth-usd-budget']);
  if (!Number.isFinite(usd) || usd <= 0) throw new Error('--eth-usd-budget must be a positive number.');
  const eth = usd / ethUsd;
  ethInWei = parseEther(eth.toFixed(18));
  // Pair at the live pool price so this pool opens where the USDC pool already trades.
  const targetWeiPerRch = BigInt(Math.round((liveUsdPerRch / ethUsd) * 1e18));
  rchInWei = rchForTargetPrice(ethInWei, targetWeiPerRch);
} else {
  throw new Error('Pass either --eth and --rch, or --eth-usd-budget.');
}

const account = options.account;
if (!account) throw new Error('Pass --account 0x… (the wallet that will sign every transaction).');

const { prepareWethPool } = await import('./weth-pool.mjs');
const reviewedPlan = await prepareWethPool(provider, { account, ethInWei, rchInWei, slippageBps: 500 });

// Fold the human-readable context into the plan the page renders.
reviewedPlan.market = {
  ethUsd,
  liveUsdPerRch,
  depositUsd: Number(formatEther(ethInWei)) * ethUsd,
  priceUsdPerRch: Number(formatEther(BigInt(reviewedPlan.priceEthPerRch))) * ethUsd,
};
reviewedPlan.addresses = { rch: RCH, weth: WETH, router: V2_ROUTER, factory: V2_FACTORY };

const token = randomBytes(24).toString('hex');
const prefix = `/${token}/`;
let origin;

const resources = new Map([
  ['', [resolve(root, 'tools/weth-pool.html'), 'text/html']],
  ['weth-pool.js', [resolve(root, 'tools/weth-pool.js'), 'text/javascript']],
  ['ethers.js', [resolve(root, 'node_modules/ethers/dist/ethers.umd.min.js'), 'text/javascript']],
]);

const server = createServer(async (request, response) => {
  const headers = {
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  };
  const send = (status, body, type = 'application/json') => {
    response.writeHead(status, { ...headers, 'Content-Type': `${type}; charset=utf-8` });
    response.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
  };
  if (request.headers.host !== new URL(origin).host || !request.url.startsWith(prefix)) {
    send(404, { error: 'Not found' });
    return;
  }
  const resource = request.url.slice(prefix.length);
  try {
    if (request.method === 'GET' && resource === 'plan.json') {
      send(200, reviewedPlan);
      return;
    }
    // Live state, recomputed per request so the page never shows stale balances.
    if (request.method === 'GET' && resource === 'state.json') {
      const state = await readPoolState(provider, { account });
      const price = state.pair ? priceEthPerRchFromReserves(state.pair) : null;
      send(200, {
        account,
        chainId: state.chainId,
        pairExists: state.pairExists,
        pairAddress: state.pairAddress,
        rchBalance: state.rchBalance,
        ethBalance: state.ethBalance,
        rchAllowanceToRouter: state.rchAllowanceToRouter,
        reserveRch: state.pair?.reserveRch ?? '0',
        reserveWeth: state.pair?.reserveWeth ?? '0',
        priceEthPerRch: price ? price.toString() : null,
        priceUsdPerRch: price ? Number(formatEther(price)) * ethUsd : null,
        lpTotalSupply: state.pair?.lpTotalSupply ?? '0',
        ethUsd,
      });
      return;
    }
    if (request.method !== 'GET') { send(405, { error: 'Method not allowed' }); return; }
    const file = resources.get(resource);
    if (!file) { send(404, { error: 'Not found' }); return; }
    const body = await readFile(file[0]);
    send(200, body, file[1]);
  } catch (error) {
    send(500, { error: String(error?.message ?? error).slice(0, 300) });
  }
});

await new Promise((done) => server.listen(port, '127.0.0.1', done));
origin = `http://127.0.0.1:${port}`;
const url = `${origin}${prefix}`;

process.stdout.write('RCH/WETH pool review\n');
process.stdout.write(`  ${url}\n\n`);
process.stdout.write(`  deposit      ${formatEther(ethInWei)} ETH + ${formatUnits(rchInWei, 18)} RCH\n`);
process.stdout.write(`  opens at     $${reviewedPlan.market.priceUsdPerRch.toFixed(4)} per RCH (live pool: $${liveUsdPerRch.toFixed(4)})\n`);
process.stdout.write(`  pair         ${reviewedPlan.pairAddress}${reviewedPlan.pairExists ? ' (already exists)' : ` (will be created at ${reviewedPlan.predictedPair})`}\n`);
process.stdout.write('\nEvery transaction is signed by your wallet. Close this window to stop the server.\n');

if (!options['no-open']) {
  try { await openBrowser(url); } catch { process.stdout.write('Open the URL above manually.\n'); }
}