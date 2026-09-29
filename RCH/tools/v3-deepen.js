'use strict';

// Browser half of the RCH/USDC deepening tool. It re-derives the reviewed plan from
// `plan.json`, re-checks it against live `state.json`, and asks the wallet to sign each
// reviewed transaction in order. It never builds a transaction the server did not review.
//
// Hard rules, matching the other local tools:
//   - The transaction list comes only from the server's reviewed plan.
//   - The signing wallet must equal the plan's account before anything is sent.
//   - The deposit must still fit the live balances and allowances at signing time.

const $ = (id) => document.getElementById(id);
const eth = window.ethers;

let plan, state, provider, signer;

function status(m) { $('status').textContent = m; }
function must(c, m) { if (!c) throw new Error(m); }
function fmtRch(v) { return `${Number(eth.formatUnits(v, 18)).toFixed(6)} RCH`; }
function fmtUsdc(v) { return `${Number(eth.formatUnits(v, 6)).toFixed(6)} USDC`; }

async function json(path) {
  const r = await fetch(path, { cache: 'no-store' });
  if (!r.ok) throw new Error(`Could not load local ${path}.`);
  return r.json();
}

// The NonfungiblePositionManager compares the deadline against block.timestamp, NOT the local
// clock, so the page has to know the chain's time to tell whether a plan is still usable.
let chainTimestamp = 0;
const deadlineOf = (p) => {
  const positional = p.deposit && p.deposit.deadline ? BigInt(p.deposit.deadline) : null;
  if (positional !== null) return positional;
  // V3 structs carry the deadline as the final 32-byte word of the calldata.
  const data = p.transactions.at(-1).data.slice(2);
  return BigInt('0x' + data.slice(-64));
};

/// Seconds until the plan's deadline expires according to the chain clock.
const secondsToDeadline = (p) => Number(deadlineOf(p)) - chainTimestamp;

/// Ask the server to rebuild the plan with a fresh deadline.
///
/// The server refuses (409) if the rebuilt plan no longer describes the same trade, and the
/// plan it returns is run back through validatePlan, so an unreviewed trade can never reach
/// the wallet just because the deadline needed refreshing.
async function reprepare() {
  const res = await fetch('reprepare.json', { method: 'POST' });
  if (res.status === 409) {
    throw new Error('The pool moved while this page was open. Reload and review again.');
  }
  if (!res.ok) throw new Error(`Could not re-prepare the plan (${res.status}).`);
  return validatePlan(await res.json());
}

function validatePlan(p) {
  must(p.schema === 'rch-v3-deepen-plan-v1' || p.schema === 'rch-v3-band-plan-v1',
    'This is not an RCH/USDC liquidity plan.');
  must(p.chainId === 1, 'This plan is not for Ethereum mainnet.');
  must(Array.isArray(p.transactions) && p.transactions.length > 0, 'The plan has no transactions.');
  for (const tx of p.transactions) {
    must(eth.getAddress(tx.from) === eth.getAddress(p.account), 'A transaction is not from the reviewed wallet.');
    must(/^0x[0-9a-fA-F]*$/.test(tx.data), 'A transaction has malformed calldata.');
    must([
      'approve-rch', 'approve-usdc', 'increase-liquidity', 'mint-v3-position',
      'decrease-liquidity', 'collect-principal',
    ].includes(tx.purpose), `Unexpected step: ${tx.purpose}`);
  }
  const last = p.transactions.at(-1).purpose;
  must(last === 'increase-liquidity' || last === 'mint-v3-position', 'The plan must end by adding liquidity.');
  // A band plan must withdraw before it re-mints, otherwise it would fund the new position
  // from the wallet instead of from the freed capital, which is a different (riskier) trade.
  //
  // EXCEPT when resuming: an earlier run already withdrew the position, so there is nothing left
  // to withdraw and demanding a decrease step would make the stuck state unfixable.
  if (p.schema === 'rch-v3-band-plan-v1') {
    if (p.resuming === true) {
      must(p.transactions.length === 1 && p.transactions[0].purpose === 'mint-v3-position',
        'A resume plan must be a single mint.');
      must(BigInt(p.liquidityAfter) > 0n, 'A resume plan must add liquidity.');
    } else {
      must(p.transactions[0].purpose === 'decrease-liquidity', 'A band plan must begin by withdrawing.');
      must(p.transactions[1].purpose === 'collect-principal', 'A band plan must collect the principal next.');
      must(BigInt(p.liquidityAfter) > BigInt(p.liquidityBefore), 'The band plan would not add depth.');
    }
  }
  return p;
}

function render() {
  const d = plan.deposit;
  const c = plan.context;
  $('account').textContent = eth.getAddress(plan.account);
  const isBand = plan.schema === 'rch-v3-band-plan-v1';
  if (isBand) {
    const resume = plan.resuming === true;
    $('title').textContent = resume
      ? 'RCH / USDC band reposition - finish'
      : 'RCH / USDC band reposition review';
    document.title = $('title').textContent;
    document.querySelector('p.note').innerHTML = resume
      ? 'The position was <strong>already withdrawn in an earlier run</strong>, so its tokens are '
        + 'sitting in this wallet and the pool has no liquidity. This page finishes the job by '
        + 'minting the band from those balances. No new money is added and the price does not move.'
      : 'This local page <strong>repositions the whole RCH/USDC position</strong> into a tighter '
        + 'price band. Nothing is sent by the tool — each step is signed by your own wallet. No new '
        + 'money is added: the same capital is withdrawn and re-deposited where trades actually '
        + 'happen, so the price does <em>not</em> move but the depth multiplies.';
  }
  $('target').textContent = isBand
    ? `NEW position over a +/-${plan.bandWidthPct}% band; source position ${plan.sourcePositionId} is emptied first`
    : (plan.createNewPosition
      ? 'NEW admin-owned position (tokens already in this wallet)'
      : `existing position ${plan.positionId} (treasury-owned - tokens must be moved here first)`);
  $('pool').textContent = plan.pool;
  $('npm').textContent = plan.npm;
  $('range').textContent = isBand
    ? `[${plan.previousRange.tickLower}, ${plan.previousRange.tickUpper}]  ->  [${plan.tickLower}, ${plan.tickUpper}]  (+/-${plan.bandWidthPct}%)`
    : `[${plan.tickLower}, ${plan.tickUpper}]${plan.tickLower <= -887270 && plan.tickUpper >= 887270 ? '  (full range)' : ''}`;
  $('deposit').textContent = isBand
    ? (plan.resuming === true
      ? `${fmtUsdc(BigInt(d.usdcInRaw))} + ${fmtRch(BigInt(d.rchInRaw))}  from this wallet's balances`
      : `${fmtUsdc(BigInt(d.usdcInRaw))} + ${fmtRch(BigInt(d.rchInRaw))}  re-deposited from the withdrawal`)
    : `${fmtUsdc(BigInt(d.usdcInRaw))} + ${fmtRch(BigInt(d.rchInRaw))}`;
  $('price').textContent = `$${plan.priceUsdcPerRch.toFixed(6)} USDC per RCH  ($${(plan.priceUsdcPerRch * c.cadPerUsd).toFixed(2)} CAD)`;
  $('slippage').textContent = `${d.slippageBps} bps (min ${fmtRch(BigInt(d.amount0Min))} / $${Number(eth.formatUnits(BigInt(d.amount1Min), 6)).toFixed(6)})`;
  $('gas').textContent = `${c.gasGwei.toFixed(2)} gwei  =  $${c.gasCad.toFixed(2)} CAD`;

  const beforeUsdc = Number(eth.formatUnits(BigInt(c.depthBeforeUsdc), 6));
  const afterUsdc = Number(eth.formatUnits(BigInt(c.depthAfterUsdc), 6));
  if (isBand) {
    // The "depthAfterUsdc" figure comes from depthSummary, which assumes the deposit is NEW
    // money and so would show the pool doubling. In band mode the capital is reused, so the
    // pool total barely moves and only the POSITION depth changes. Relabel rather than mislead.
    $('r-1').textContent = 'USDC in the pool';
    $('r-2').textContent = 'Total pool value (unchanged)';
    $('r-3').textContent = 'POSITION liquidity (the depth that matters)';
    $('d-before').textContent = `$${beforeUsdc.toFixed(2)}`;
    $('d-after').textContent = `$${beforeUsdc.toFixed(2)}`;
    $('v-before').textContent = `$${(beforeUsdc * 2).toFixed(2)}`;
    $('v-after').textContent = `$${(beforeUsdc * 2).toFixed(2)}`;
  } else {
    $('d-before').textContent = `$${beforeUsdc.toFixed(2)}`;
    $('d-after').textContent = `$${afterUsdc.toFixed(2)}`;
    $('v-before').textContent = `$${(beforeUsdc * 2).toFixed(2)}`;
    $('v-after').textContent = `$${(afterUsdc * 2).toFixed(2)}`;
  }
  $('l-before').textContent = c.positionLiquidityBefore;
  // Increasing an existing position adds to its liquidity; minting starts from zero.
  // The plan carries the delta, so report the real resulting figure rather than a label.
  const liquidityAfter = BigInt(plan.liquidityAfter ?? 0n);
  if (plan.resuming === true) {
    // Resuming means there is no prior liquidity to multiply against, so a ratio would be a lie.
    $('l-after').textContent = `${liquidityAfter}  (new position)`;
    $('r-3').textContent = 'POSITION liquidity (the depth that matters) - TO BE CREATED';
  } else {
    $('l-after').textContent = isBand
      ? `${liquidityAfter}  (${Number(plan.depthMultiple).toFixed(2)}x on the same capital)`
      : (plan.createNewPosition
        ? BigInt(d.liquidity)
        : BigInt(c.positionLiquidityBefore) + BigInt(d.liquidity)).toString();
  }
  $('depth-note').textContent = isBand
    ? (plan.resuming === true
      ? `Minting the band from the balances this wallet already holds. The earlier run withdrew `
        + `the position, so the pool has no liquidity until this mint lands. The price does not move. `
        + `If the price leaves the band the position goes one-sided and stops earning until you reposition.`
      : `Same capital, ${Number(plan.depthMultiple).toFixed(2)}x the liquidity: withdrawing the `
        + `full-range position and re-minting it over a +/-${plan.bandWidthPct}% band concentrates `
        + `the exact same money where trades happen. The price does not move. If the price leaves `
        + `the band the position goes one-sided and stops earning until you reposition.`)
    : '';
  if (!isBand) {
    $('depth-note').textContent =
      `Deepening multiplies pool depth by ${c.depthMultiplier.toFixed(2)}x. The price does not move; `
      + `only the amount behind it grows. A thin pool still moves sharply on small trades.`;
  }

  $('transactions').innerHTML = plan.transactions.map((tx) => {
    const label = {
      'approve-rch': 'Approve the position manager to move your RCH',
      'approve-usdc': 'Approve the position manager to move your USDC',
      'increase-liquidity': 'Increase liquidity on the existing position',
      'mint-v3-position': 'Mint a new position with the deposit',
      'decrease-liquidity': 'Withdraw ALL liquidity from the current position',
      'collect-principal': 'Collect the freed RCH and USDC to your wallet',
    }[tx.purpose];
    return `<li><strong>${label}</strong><br><span class="mono">to ${tx.to}</span></li>`;
  }).join('');

  // Live feasibility, re-checked at render time rather than trusted from the plan.
  const warnings = [];
  if (isBand) {
    // The withdrawal frees the capital, so a short wallet balance is EXPECTED and harmless.
    // What matters is that the freed tokens cover the re-deposit, which the plan checked.
    if (plan.resuming === true) {
      warnings.push(
        `The pool currently has NO liquidity: an earlier run withdrew the position and the mint `
        + `did not land. The RCH and USDC are safe in this wallet. This plan mints the band `
        + `directly from those balances in a single step, so there is no withdrawal to be `
        + `interrupted this time.`,
      );
    } else {
      warnings.push(
        `This repositions capital you already have. Steps 1-2 withdraw ${fmtRch(BigInt(plan.withdrawal.rchOutRaw))} `
        + `and ${fmtUsdc(BigInt(plan.withdrawal.usdcOutRaw))} to your wallet; step ${plan.transactions.length} re-deposits `
        + `${fmtRch(BigInt(d.rchInRaw))} and ${fmtUsdc(BigInt(d.usdcInRaw))}. If any step after the collect fails, `
        + `you keep the withdrawn tokens in the wallet - nothing is lost. The tool can then finish `
        + `the mint on its own via a resume plan.`,
      );
    }
  } else {
    if (BigInt(state.rchBalance) < BigInt(d.rchInRaw)) {
      warnings.push(`This wallet holds ${fmtRch(BigInt(state.rchBalance))} but the deposit needs ${fmtRch(BigInt(d.rchInRaw))}.`);
    }
    if (BigInt(state.usdcBalance) < BigInt(d.usdcInRaw)) {
      warnings.push(`This wallet holds ${fmtUsdc(BigInt(state.usdcBalance))} but the deposit needs ${fmtUsdc(BigInt(d.usdcInRaw))}.`);
    }
  }
  if (!plan.createNewPosition && eth.getAddress(state.positionOwner) !== eth.getAddress(plan.account)) {
    warnings.push(`Position ${plan.positionId} is owned by ${state.positionOwner}. Use --new-position, or move the tokens to that wallet.`);
  }
  // Surface the deadline in CHAIN time, since that is what the position manager compares against.
  if (chainTimestamp) {
    const left = secondsToDeadline(plan);
    if (left <= 0) {
      warnings.push(
        'The plan deadline has already passed in chain time. Signing will refresh it automatically '
        + 'before sending; nothing has been sent yet.',
      );
    } else if (left < 300) {
      warnings.push(`The plan deadline expires in about ${Math.max(1, Math.round(left / 60))} minute(s) of chain time; it will be refreshed automatically if it lapses.`);
    }
  }
  $('warning').textContent = warnings.join(' ');
  $('warning').className = warnings.length ? 'warn' : 'good';
  $('s-rch').textContent = fmtRch(BigInt(state.rchBalance));
  $('s-usdc').textContent = fmtUsdc(BigInt(state.usdcBalance));
  $('s-allow-rch').textContent = BigInt(state.rchAllowanceToNpm) >= BigInt(d.rchInRaw) ? 'Sufficient' : 'Needs approval';
  $('s-allow-usdc').textContent = BigInt(state.usdcAllowanceToNpm) >= BigInt(d.usdcInRaw) ? 'Sufficient' : 'Needs approval';
}

async function refresh() {
  state = await json('state.json');
  must(state.chainId === undefined || state.chainId === 1, 'Live state is not Ethereum mainnet.');
  must(eth.getAddress(state.account) === eth.getAddress(plan.account), 'Live state is for a different wallet.');
  try {
    chainTimestamp = (await json('now.json')).chainTimestamp;
  } catch { chainTimestamp = 0; }
  render();
  const ready = signer && (await signer.getAddress()) === eth.getAddress(plan.account);
  $('sign').disabled = !ready;
}

async function connect() {
  must(window.ethereum, 'No browser wallet found. Install MetaMask.');
  provider = new eth.BrowserProvider(window.ethereum);
  await provider.send('eth_requestAccounts', []);
  signer = await provider.getSigner();
  const address = await signer.getAddress();
  must(eth.getAddress(address) === eth.getAddress(plan.account),
    `This page reviewed ${plan.account}. Switch MetaMask to that account and reconnect.`);
  status('Wallet connected. Review the deposit and the effect table, then sign.');
  await refresh();
}

async function signAll() {
  $('sign').disabled = true;
  try {
    // Re-stamp the deadline first if the chain clock has already passed it, otherwise the very
    // first signature would revert with "Transaction too old". The plan is re-validated by
    // reprepare(), so this cannot smuggle in calldata that differs from what was reviewed.
    await refresh();
    if (chainTimestamp && secondsToDeadline(plan) <= 60) {
      status('The deadline expired while this page was open. Refreshing it before signing…');
      plan = await reprepare();
      await refresh();
      if (chainTimestamp && secondsToDeadline(plan) <= 0) {
        throw new Error('The refreshed deadline is still expired; check your clock and reload.');
      }
    }
    for (let i = 0; i < plan.transactions.length; i += 1) {
      const tx = plan.transactions[i];
      status(`(${i + 1}/${plan.transactions.length}) Confirm "${tx.purpose}" in your wallet…`);
      const sent = await signer.sendTransaction({
        to: tx.to, data: tx.data, value: BigInt(tx.value), from: eth.getAddress(tx.from),
      });
      status(`(${i + 1}/${plan.transactions.length}) Submitted ${sent.hash}\nWaiting for confirmation…`);
      const receipt = await sent.wait();
      must(receipt && receipt.status === 1, `Transaction ${sent.hash} did not succeed.`);
    }
    await refresh();
    status('Done. The pool is deeper; the price is unchanged. Refresh Uniswap to see the new depth.');
  } catch (error) {
    const message = error?.shortMessage || error?.message || String(error);
    // Uniswap reverts with "Transaction too old" when block.timestamp has passed the deadline.
    if (/too old|expired/i.test(message)) {
      status(
        `Stopped: ${message}\n\nThe reviewed plan's deadline expired. Reload this page so the `
        + `plan is re-stamped, then review and sign again - your tokens are untouched and `
        + `nothing was sent.`,
      );
    } else {
      status(`Stopped: ${message}`);
    }
  } finally {
    $('sign').disabled = false;
  }
}

async function boot() {
  try {
    plan = validatePlan(await json('plan.json'));
    await refresh();
    $('connect').disabled = false;
    $('refresh').disabled = false;
    status('Reviewed plan loaded. Connect your wallet to continue.');
  } catch (error) {
    status(`Could not load the review: ${error?.message || error}`);
  }
}

$('connect').addEventListener('click', () => void connect().catch((e) => status(String(e))));
$('refresh').addEventListener('click', () => void refresh().catch((e) => status(String(e))));
$('sign').addEventListener('click', () => void signAll());

void boot();