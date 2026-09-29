'use strict';

// Browser half of the local RCH/WETH pool tool. It re-derives the plan from `plan.json`,
// re-validates it against `state.json`, and asks the wallet to sign each reviewed
// transaction in order. It never constructs a transaction the server did not review.
//
// Deliberate constraints:
//   - The transaction list comes only from the server's reviewed plan.
//   - The address is checked against the plan before any signing.
//   - Nothing is signed until the deposit still fits the live balance.

const $ = (id) => document.getElementById(id);
const eth = window.ethers;

let plan, state, provider, signer, address;

function status(message) { $('status').textContent = message; }

function requireCondition(condition, message) {
  if (!condition) throw new Error(message);
}

function fmtEth(v) { return `${Number(eth.formatEther(v)).toFixed(8)} ETH`; }
function fmtRch(v) { return `${Number(eth.formatUnits(v, 18)).toFixed(6)} RCH`; }

async function json(path) {
  const response = await fetch(path, { cache: 'no-store' });
  if (!response.ok) throw new Error(`Could not load local ${path}.`);
  return response.json();
}

/// The reviewed plan is the single source of truth for what may be signed.
function validatePlan(p) {
  requireCondition(p.schema === 'rch-weth-pool-plan-v1', 'This is not an RCH/WETH pool plan.');
  requireCondition(p.chainId === 1, 'This plan is not for Ethereum mainnet.');
  requireCondition(Array.isArray(p.transactions) && p.transactions.length > 0, 'The plan has no transactions.');
  for (const tx of p.transactions) {
    requireCondition(eth.getAddress(tx.from) === eth.getAddress(p.account), 'A transaction is not from the reviewed wallet.');
    requireCondition(/^0x[0-9a-fA-F]*$/.test(tx.data), 'A transaction has malformed calldata.');
    requireCondition(['approve-rch', 'add-liquidity-eth'].includes(tx.purpose), `Unexpected step: ${tx.purpose}`);
  }
  requireCondition(p.transactions.at(-1).purpose === 'add-liquidity-eth', 'The plan must end by funding the pool.');
  return p;
}

function render() {
  const d = plan.deposit;
  $('account').textContent = eth.getAddress(plan.account);
  $('rch').textContent = plan.addresses.rch;
  $('weth').textContent = plan.addresses.weth;
  $('router').textContent = plan.addresses.router;
  $('pair').textContent = `${plan.pairAddress}${plan.pairExists ? '  (already exists)' : '  (will be created)'}`;
  $('deposit').textContent = `${fmtEth(BigInt(d.ethInWei))} + ${fmtRch(BigInt(d.rchInWei))}`;
  $('price').textContent = `$${plan.market.priceUsdPerRch.toFixed(4)} per RCH (${eth.formatEther(BigInt(plan.priceEthPerRch))} ETH/RCH)`;
  $('live-price').textContent = `$${plan.market.liveUsdPerRch.toFixed(4)} per RCH  (ETH/USD $${plan.market.ethUsd.toFixed(2)})`;
  $('slippage').textContent = `${d.slippageBps} bps (min ${fmtRch(BigInt(d.minRch))} / ${fmtEth(BigInt(d.minEth))})`;
  $('gas').textContent = `${fmtEth(BigInt(plan.gas.maxCostWei))} maximum`;

  $('transactions').innerHTML = plan.transactions.map((tx) => {
    const label = tx.purpose === 'approve-rch'
      ? 'Approve the router to move your RCH'
      : 'Add liquidity (creates the pair, sends ETH)';
    return `<li><strong>${label}</strong><br><span class="mono">to ${tx.to}</span><br><span class="mono">value ${tx.value === '0x0' ? '0' : Number(BigInt(tx.value)) / 1e18} ETH</span></li>`;
  }).join('');

  const depositEth = BigInt(d.ethInWei);
  const gas = BigInt(plan.gas.maxCostWei);
  const balance = BigInt(state.ethBalance);
  if (balance < depositEth + gas) {
    $('warning').textContent = `Not enough ETH: this deposit needs ${fmtEth(depositEth + gas)} including gas, but the wallet holds ${fmtEth(balance)}.`;
  } else if (plan.market.priceUsdPerRch !== 0 && Math.abs(plan.market.priceUsdPerRch - plan.market.liveUsdPerRch) > plan.market.liveUsdPerRch * 0.25) {
    $('warning').textContent = `The opening price differs from the live RCH/USDC pool by more than 25%. That is a deliberate choice only if you mean it.`;
  } else {
    $('warning').textContent = '';
  }

  $('s-rch').textContent = fmtRch(BigInt(state.rchBalance));
  $('s-eth').textContent = fmtEth(balance);
  $('s-allowance').textContent = BigInt(state.rchAllowanceToRouter) >= BigInt(d.rchInWei)
    ? 'Sufficient' : 'Needs approval (step 1)';
  $('s-exists').textContent = state.pairExists ? 'Yes' : 'No — this will create it';
  $('s-res-rch').textContent = fmtRch(BigInt(state.reserveRch));
  $('s-res-weth').textContent = fmtEth(BigInt(state.reserveWeth));
  $('s-lp').textContent = state.lpTotalSupply;
}

async function refresh() {
  state = await json('state.json');
  requireCondition(state.chainId === 1, 'Live state is not Ethereum mainnet.');
  requireCondition(eth.getAddress(state.account) === eth.getAddress(plan.account), 'Live state is for a different wallet.');
  render();
  const ready = signer && (await signer.getAddress()) === eth.getAddress(plan.account);
  $('sign').disabled = !ready;
}

async function connect() {
  requireCondition(window.ethereum, 'No browser wallet found. Install MetaMask.');
  provider = new eth.BrowserProvider(window.ethereum);
  await provider.send('eth_requestAccounts', []);
  signer = await provider.getSigner();
  address = await signer.getAddress();
  requireCondition(eth.getAddress(address) === eth.getAddress(plan.account),
    `This page reviewed ${plan.account}. Switch MetaMask to that account and reconnect.`);
  status('Wallet connected. Review the deposit, then sign both transactions.');
  await refresh();
}

/// Sign each reviewed transaction in order. The plan is re-read from the server between
/// steps so a failure cannot silently skip the approve or double-send the deposit.
async function signAll() {
  $('sign').disabled = true;
  try {
    for (let i = 0; i < plan.transactions.length; i += 1) {
      const tx = plan.transactions[i];
      status(`(${i + 1}/${plan.transactions.length}) Confirm "${tx.purpose}" in your wallet…`);
      const sent = await signer.sendTransaction({
        to: tx.to,
        data: tx.data,
        value: BigInt(tx.value),
        from: eth.getAddress(tx.from),
      });
      status(`(${i + 1}/${plan.transactions.length}) Submitted ${sent.hash}\nWaiting for confirmation…`);
      const receipt = await sent.wait();
      requireCondition(receipt && receipt.status === 1, `Transaction ${sent.hash} did not succeed.`);
    }
    await refresh();
    status(`Done. The pair is ${plan.pairAddress} — it should now appear in Uniswap with a live price.`);
  } catch (error) {
    status(`Stopped: ${error?.shortMessage || error?.message || error}`);
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