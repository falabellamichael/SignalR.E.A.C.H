// Local review server for deepening the live RCH/USDC Uniswap V3 pool.
//
// Mirrors the conventions of `replacement-ui.mjs` and `weth-pool-ui.mjs`: a random per-run
// path prefix, a loopback-only bind, a strict Content-Security-Policy, and no key handling.
// The server serves the reviewed plan plus live read-only state only. Every transaction is
// built in the page and signed by the operator's own wallet.
//
// Two funding paths, because they cost different amounts of gas:
//   --new-position  (Path 2, default) mints an ADMIN-owned position. The RCH and USDC are
//                   already in that wallet, so nothing needs moving: 2 approvals + 1 mint.
//   (default off)   Path 1 grows the TREASURY-owned band position (see POSITION_ID in
//                   v3-deepen.mjs), which requires the tokens to be in the treasury:
//                   3 moves + 2 approvals + 1 call.
//   --position <id> review a different treasury position than the pinned default, e.g. the
//                   successor after the next band rotation.
//
// Usage:
//   node scripts/v3-deepen-ui.mjs --account 0xDa68… --usdc 11.794184 --new-position
//   node scripts/v3-deepen-ui.mjs --account 0x5b7a… --usdc 10 [--position 1375302]

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { JsonRpcProvider, formatUnits, parseUnits, getAddress, Contract } from 'ethers';
import { root } from './compile.mjs';
import { openBrowser } from '../terminal/approval.mjs';
import {
  RCH, USDC, NPM, POOL, POSITION_ID,
  readPositionState, prepareDeepen, prepareBandReposition, depthSummary,
} from './v3-deepen.mjs';
import { readGasReport, formatReport } from './gas-watch.mjs';

const { values: options } = parseArgs({
  options: {
    account: { type: 'string' },
    usdc: { type: 'string' },
    band: { type: 'string' },
    position: { type: 'string' },
    'new-position': { type: 'boolean' },
    slippage: { type: 'string' },
    'no-open': { type: 'boolean' },
    port: { type: 'string' },
  },
});

const rpcUrl = process.env.RCH_RPC_URL;
if (typeof rpcUrl !== 'string' || !/^https?:\/\//.test(rpcUrl)) {
  throw new Error('Set RCH_RPC_URL to an Ethereum mainnet HTTPS endpoint (read-only is fine).');
}
const provider = new JsonRpcProvider(rpcUrl);
if ((await provider.getNetwork()).chainId !== 1n) throw new Error('RCH_RPC_URL must be Ethereum mainnet.');

if (!options.account) throw new Error('Pass --account 0x… (the wallet that will sign).');
const account = getAddress(options.account);

// Two distinct modes:
//   --band <pct>  withdraw the whole position and re-mint it into a +/-pct band (no new money)
//   --usdc <amt>  simply add more liquidity at the existing range
const bandWidthPct = options.band === undefined ? null : Number(options.band);
if (bandWidthPct !== null) {
  if (!Number.isFinite(bandWidthPct) || bandWidthPct <= 0 || bandWidthPct >= 100) {
    throw new Error('--band must be a percentage between 0 and 100, exclusive (e.g. --band 20).');
  }
  if (options.usdc !== undefined) throw new Error('Use either --band or --usdc, not both.');
}
if (bandWidthPct === null && !options.usdc) throw new Error('Pass --usdc <amount>, or --band <pct> to reposition.');
const usdcInRaw = options.usdc ? parseUnits(options.usdc, 6) : 0n;
const slippageBps = options.slippage ? Number(options.slippage) : 200;
if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps > 5000) throw new Error('--slippage must be 0-5000 bps.');
const createNewPosition = options['new-position'] === true;
// Which treasury position to grow (or withdraw). Defaults to the pinned live band; the flag
// exists so a future rotation does not silently review the wrong (or an emptied) position.
let positionId = POSITION_ID;
if (options.position !== undefined) {
  if (!/^[1-9][0-9]*$/.test(options.position)) throw new Error('--position must be a positive integer position id.');
  positionId = BigInt(options.position);
}

const port = Number(options.port ?? 8767);
if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error('Invalid --port.');

// Live read-only context for the review.
const before = await readPositionState(provider, { account, positionId });
const gasReport = await readGasReport(provider, { ethBalanceWei: await provider.getBalance(account) });

let reviewedPlan;
try {
  reviewedPlan = bandWidthPct === null
    ? await prepareDeepen(provider, { account, usdcInRaw, slippageBps, createNewPosition, positionId })
    : await prepareBandReposition(provider, {
      account, widthPct: bandWidthPct, slippageBps, createNewPosition, positionId,
    });
} catch (error) {
  process.stderr.write(`\nThe deposit cannot be prepared yet:\n  ${error.message}\n\n`);
  process.stderr.write('Current gas and balances:\n');
  process.stderr.write(formatReport(gasReport) + '\n');
  process.exit(1);
}

// Pool depth before/after, so the effect is shown rather than assumed.
const poolContracts = {
  rch: new Contract(RCH, ['function balanceOf(address) view returns (uint256)'], provider),
  usdc: new Contract(USDC, ['function balanceOf(address) view returns (uint256)'], provider),
};
const [poolRch, poolUsdc] = await Promise.all([
  poolContracts.rch.balanceOf(POOL), poolContracts.usdc.balanceOf(POOL),
]);
const depth = depthSummary(
  { reserveRch: poolRch.toString(), reserveUsdc: poolUsdc.toString() },
  reviewedPlan,
);
// In band mode the capital is REUSED, not added, so the pool total barely changes. The metric
// that matters is the position's own liquidity, which is where the depth actually comes from.
// A RESUME has no prior liquidity to compare against, so a ratio would divide by zero.
const isBand = reviewedPlan.mode === 'band';
const isResume = reviewedPlan.resuming === true;
const liquidityMultiple = isBand && !isResume
  ? Number(reviewedPlan.liquidityAfter) / Number(reviewedPlan.liquidityBefore)
  : null;

reviewedPlan.context = {
  usdcPerRch: reviewedPlan.priceUsdcPerRch,
  cadPerUsd: 1.42,
  depthBeforeUsdc: poolUsdc.toString(),
  depthAfterUsdc: depth.usdcAfter,
  depthMultiplier: depth.multiplier,
  gasGwei: gasReport.gwei,
  ethUsd: gasReport.ethUsd,
  gasCad: reviewedPlan.gas.maxCostWei
    ? (Number(reviewedPlan.gas.maxCostWei) / 1e18) * gasReport.ethUsd * 1.42
    : null,
  positionLiquidityBefore: before.liquidity,
  positionOwner: before.positionOwner,
  liquidityMultiple,
};

// Components are compared as arrays, never as concatenated strings: concatenation would let
// different addresses collide and bypass the bind. The remote address is checked against BOTH
// the IPv4 and IPv4-mapped-IPv6 forms because a dual-stack listener may report either.
const isLoopback = (address) => {
  if (typeof address !== 'string') return true;
  const normalized = address.startsWith('::ffff:') ? address.slice(7) : address;
  return normalized === '127.0.0.1' || normalized === '::1' || normalized === 'localhost';
};
const allowedOrigins = new Set([
  `http://127.0.0.1:${port}`,
  `http://localhost:${port}`,
  `http://[::1]:${port}`,
]);

/// Rebuild the reviewed plan so a stale deadline can be replaced with a fresh one.
///
/// The deadline is frozen into the calldata and the NonfungiblePositionManager reverts with
/// "Transaction too old" once block.timestamp passes it, so a page left open past the window
/// must be able to mint a current plan instead of forcing a restart.
const rebuildPlan = () => (bandWidthPct === null
  ? prepareDeepen(provider, { account, usdcInRaw, slippageBps, createNewPosition })
  : prepareBandReposition(
    provider, { account, widthPct: bandWidthPct, slippageBps, createNewPosition },
  ));

const token = randomBytes(24).toString('hex');
const prefix = `/${token}/`;
const resources = new Map([
  ['', [resolve(root, 'tools/v3-deepen.html'), 'text/html']],
  ['v3-deepen.js', [resolve(root, 'tools/v3-deepen.js'), 'text/javascript']],
  ['ethers.js', [resolve(root, 'node_modules/ethers/dist/ethers.umd.min.js'), 'text/javascript']],
]);

const server = createServer(async (request, response) => {
  const headers = {
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    // connect-src 'self' still permits the plan round-trip because the page and the API share
    // one loopback origin; no external host is reachable from the page either way.
    'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  };
  const send = (status, body, type = 'application/json') => {
    response.writeHead(status, { ...headers, 'Content-Type': `${type}; charset=utf-8` });
    response.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
  };
  const requestPath = (request.url ?? '').split('?')[0];
  if ((request.headers.host ?? '').toLowerCase() !== `127.0.0.1:${port}`.toLowerCase() || !requestPath.startsWith(prefix)) {
    send(404, { error: 'Not found' });
    return;
  }
  const resource = requestPath.slice(prefix.length);
  try {
    if (request.method === 'GET' && resource === 'plan.json') { send(200, reviewedPlan); return; }
    if (request.method === 'GET' && resource === 'plan-fresh.json') {
      const fresh = await rebuildPlan();
      fresh.context = reviewedPlan.context;
      send(200, fresh);
      return;
    }
    if (request.method === 'GET' && resource === 'now.json') {
      // The chain's clock, not the server's, is what the deadline is compared against.
      const block = await provider.getBlock('latest');
      send(200, { chainTimestamp: Number(block.timestamp), serverTime: Math.floor(Date.now() / 1000) });
      return;
    }
    if (request.method === 'POST' && resource === 'reprepare.json') {
      // Allow re-stamping only from our own page on loopback. Chrome sends Origin on POST;
      // browsers omit it on GET, which is why the read routes above do not check it.
      const origin = request.headers.origin;
      if (!isLoopback(request.socket.remoteAddress) || (origin !== undefined && !allowedOrigins.has(origin))) {
        send(403, { error: 'Refused' });
        return;
      }
      const fresh = await rebuildPlan();
      fresh.context = reviewedPlan.context;
      // Promote the fresh plan only when it describes the same trade as the reviewed one.
      const sameTrade = fresh.transactions.length === reviewedPlan.transactions.length
        && fresh.transactions.every((tx, i) => tx.purpose === reviewedPlan.transactions[i].purpose)
        && fresh.tickLower === reviewedPlan.tickLower
        && fresh.tickUpper === reviewedPlan.tickUpper;
      if (!sameTrade) {
        send(409, { error: 'The pool moved; reload the page and review again.' });
        return;
      }
      reviewedPlan = fresh;
      send(200, fresh);
      return;
    }
    if (request.method === 'GET' && resource === 'state.json') {
      const state = await readPositionState(provider, { account });
      const [r, u] = await Promise.all([
        poolContracts.rch.balanceOf(POOL), poolContracts.usdc.balanceOf(POOL),
      ]);
      send(200, {
        account,
        positionLiquidity: state.liquidity,
        positionOwner: state.positionOwner,
        rchBalance: state.rchBalance,
        usdcBalance: state.usdcBalance,
        rchAllowanceToNpm: state.rchAllowanceToNpm,
        usdcAllowanceToNpm: state.usdcAllowanceToNpm,
        poolRch: r.toString(),
        poolUsdc: u.toString(),
      });
      return;
    }
    if (request.method !== 'GET') { send(405, { error: 'Method not allowed' }); return; }
    const file = resources.get(resource);
    if (!file) { send(404, { error: 'Not found' }); return; }
    send(200, await readFile(file[0]), file[1]);
  } catch (error) {
    send(500, { error: String(error?.message ?? error).slice(0, 300) });
  }
});

await new Promise((done) => server.listen(port, '127.0.0.1', done));
const url = `http://127.0.0.1:${port}${prefix}`;

const targetLabel = isBand
  ? `new position; source ${positionId} is emptied`
  : (createNewPosition ? 'NEW admin-owned position' : `existing position ${positionId} (treasury-owned)`);
process.stdout.write('RCH/USDC pool deepening review\n');
process.stdout.write(`  ${url}\n\n`);
process.stdout.write(`  account      ${account}\n`);
process.stdout.write(`  mode         ${isResume
  ? `BAND reposition +/-${reviewedPlan.bandWidthPct}% - RESUMING (mint only; the position was already withdrawn)`
  : (isBand ? `BAND reposition +/-${reviewedPlan.bandWidthPct}% (withdraw then re-mint, no new money)` : 'ADD liquidity at the existing range')}\n`);
process.stdout.write(`  target       ${targetLabel}\n`);
if (isBand) {
  process.stdout.write(`  range        [${reviewedPlan.previousRange.tickLower}, ${reviewedPlan.previousRange.tickUpper}] -> [${reviewedPlan.tickLower}, ${reviewedPlan.tickUpper}]\n`);
  if (isResume) {
    // Nothing is withdrawn on a resume: the tokens are already in the wallet.
    process.stdout.write('  withdraw     nothing - the position is already empty\n');
  } else {
    process.stdout.write(`  withdraw     ${formatUnits(BigInt(reviewedPlan.withdrawal.rchOutRaw), 18)} RCH + ${formatUnits(BigInt(reviewedPlan.withdrawal.usdcOutRaw), 6)} USDC\n`);
  }
  process.stdout.write(`  re-deposit   ${formatUnits(BigInt(reviewedPlan.deposit.rchInRaw), 18)} RCH + ${formatUnits(BigInt(reviewedPlan.deposit.usdcInRaw), 6)} USDC\n`);
  process.stdout.write(isResume
    ? `  depth        liquidity 0 -> ${reviewedPlan.liquidityAfter} (restores a tradeable pool in ONE step)\n`
    : `  depth        liquidity ${reviewedPlan.liquidityBefore} -> ${reviewedPlan.liquidityAfter} (${liquidityMultiple.toFixed(2)}x on the SAME capital)\n`);
} else {
  process.stdout.write(`  deposit      ${formatUnits(usdcInRaw, 6)} USDC + ${formatUnits(BigInt(reviewedPlan.deposit.rchInRaw), 18)} RCH\n`);
  process.stdout.write(`  depth        $${(Number(depth.usdcAfter) / 1e6 * 2).toFixed(2)} after (${depth.multiplier.toFixed(2)}x)\n`);
}
process.stdout.write(`  price        $${reviewedPlan.priceUsdcPerRch.toFixed(4)} USDC/RCH (unchanged by the deposit)\n`);
process.stdout.write(`  gas          ${gasReport.gwei.toFixed(2)} gwei = $${reviewedPlan.context.gasCad.toFixed(2)} CAD\n`);
process.stdout.write(`  steps        ${reviewedPlan.transactions.map((t) => t.purpose).join(' -> ')}\n\n`);
process.stdout.write('Every transaction is signed by your wallet. Close this window to stop the server.\n');

if (!options['no-open']) {
  try { await openBrowser(url); } catch { process.stdout.write('Open the URL above manually.\n'); }
}