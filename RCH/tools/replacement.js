import { currentEip1559Fees } from './fees.mjs';

'use strict';

const $ = (id) => document.getElementById(id);
const eth = window.ethers;
const minimumEth = '0.001';
const perActionFeeCap = eth.parseEther('0.0005');
let plan, manifest, saleArtifact, tokenArtifact, provider, account, snapshot, quote;
let ready = false, busy = false;
let completedPurchaseMessage = '';
let pending = JSON.parse(localStorage.getItem('rch-replacement-pending') || 'null');

function status(message) { $('status').textContent = message; }
function same(a, b) { return eth.getAddress(a) === eth.getAddress(b); }
function button(id, disabled, label) { $(id).disabled = disabled; if (label) $(id).textContent = label; }
function showHash(action, hash) {
  const key = 'rch-replacement-hashes';
  const hashes = JSON.parse(localStorage.getItem(key) || '[]');
  if (!hashes.some((item) => item.hash === hash)) hashes.push({ action, hash });
  localStorage.setItem(key, JSON.stringify(hashes));
  const list = $('transactions');
  list.replaceChildren();
  for (const item of hashes) {
    const li = document.createElement('li');
    li.className = 'hash';
    li.textContent = `${item.action}: ${item.hash}`;
    list.append(li);
  }
}
async function json(path) {
  const response = await fetch(path, { cache: 'no-store' });
  if (!response.ok) throw new Error(`Could not load local ${path}.`);
  return response.json();
}
async function wallet(prompt = false) {
  if (!ready) throw new Error('The replacement plan has not been verified. Reload this page before connecting.');
  if (!window.ethereum?.request) throw new Error('Open this local page in Edge with MetaMask enabled.');
  const chainId = await window.ethereum.request({ method: 'eth_chainId' });
  if (chainId?.toLowerCase() !== '0x1') throw new Error('Switch MetaMask to Ethereum Mainnet.');
  const accounts = await window.ethereum.request({ method: prompt ? 'eth_requestAccounts' : 'eth_accounts' });
  if (!Array.isArray(accounts) || !accounts.length) throw new Error('Connect the buyer/admin wallet in MetaMask.');
  const selected = eth.getAddress(accounts[0]);
  if (!same(selected, plan.admin)) throw new Error(`Select the authorized buyer/admin wallet ${plan.admin} in MetaMask.`);
  account = selected;
  provider = new eth.BrowserProvider(window.ethereum);
  $('account').textContent = account;
  return account;
}
function checkPlan() {
  const now = Date.now(), created = Date.parse(plan.createdAt), expires = Date.parse(plan.expiresAt);
  if (!Number.isFinite(created) || !Number.isFinite(expires) || now < created || now > expires) {
    throw new Error('The replacement deployment plan expired. Restart the replacement command to prepare a fresh nonce and fee estimate.');
  }
}
async function load() {
  [plan, manifest, saleArtifact, tokenArtifact] = await Promise.all([
    json('plan.json'), json('mainnet.json'), json('sale-artifact.json'), json('launch-artifact.json'),
  ]);
  const originalSale = same(plan.oldSale, manifest.sale);
  const activatedSale = same(plan.expectedSale, manifest.sale)
    && manifest.initialSale && same(plan.oldSale, manifest.initialSale)
    && same(plan.treasury, manifest.treasury);
  if (plan.schema !== 'rch-sale-replacement-plan-v1' || plan.chainId !== 1
    || !same(plan.admin, plan.transaction.from) || (!originalSale && !activatedSale)
    || !same(plan.token, manifest.token) || !same(plan.treasury, '0x5b7a910cDF232543aCB7653D71d6B92f01d342C7')) {
    throw new Error('Replacement plan does not match the reviewed mainnet token, buyer, and GitHub treasury.');
  }
  const dataHash = eth.sha256(eth.toUtf8Bytes(plan.transaction.data));
  if (dataHash.toLowerCase() !== `0x${plan.dataHash}`.toLowerCase()) throw new Error('Deployment data hash does not match the plan.');
  const factory = new eth.ContractFactory(saleArtifact.abi, saleArtifact.bytecode);
  const rebuilt = await factory.getDeployTransaction(plan.token, plan.feed, plan.treasury, plan.admin,
    BigInt(plan.usdPriceE8PerRch), BigInt(plan.oracle.maxAgeSeconds), BigInt(plan.oracle.minEthUsdE8), BigInt(plan.oracle.maxEthUsdE8));
  if (rebuilt.data.toLowerCase() !== plan.transaction.data.toLowerCase()) throw new Error('Deployment data does not match the compiled sale artifact.');
  if (!same(plan.expectedSale, eth.getCreateAddress({ from: plan.admin, nonce: plan.transaction.nonce }))) {
    throw new Error('Predicted sale address does not match the reviewed wallet nonce.');
  }
  $('admin').textContent = plan.admin;
  $('treasury').textContent = plan.treasury;
  $('token').textContent = plan.token;
  $('old-sale').textContent = plan.oldSale;
  $('new-sale').textContent = plan.expectedSale;
  $('deployment-fee').textContent = `${plan.deploymentFee.maxCostEth} ETH maximum at the prepared fee`;
  $('expires').textContent = plan.expiresAt;
  for (const item of JSON.parse(localStorage.getItem('rch-replacement-hashes') || '[]')) showHash(item.action, item.hash);
  ready = true;
  button('connect', false);
  button('refresh', false);
  status('Review the buyer, treasury, sale addresses, and plan expiry. Connect MetaMask when ready. No transaction has been sent.');
  await refreshState();
}
async function refreshState() {
  if (!ready) return;
  snapshot = null;
  snapshot = await json('state.json');
  $('balance').textContent = `${snapshot.adminBalanceEth} ETH`;
  $('rch-balance').textContent = `${snapshot.buyerRch} RCH`;
  const labels = {
    deploy: 'Deploy paused replacement sale',
    'pause-old-sale': 'Pause current sale',
    'grant-new-sale-role': 'Authorize replacement sale to mint RCH',
    'open-new-sale': 'Open replacement sale',
    'revoke-old-sale-role': 'Remove old sale mint authority',
    'close-old-sale': 'Permanently close old sale',
    complete: 'Replacement is active',
  };
  const action = snapshot.nextAction;
  const pendingBlocked = Boolean(pending) || busy || !provider || !account;
  button('step', action === 'complete' || pendingBlocked, labels[action] || 'Refresh chain state');
  const canBuy = action === 'complete' && !pendingBlocked;
  button('get-quote', !canBuy, 'Get live 0.001 ETH quote');
  button('buy', !canBuy || !quote || Date.now() > quote.expiresAt, 'Buy 0.001 ETH of RCH');
  if (action === 'complete') {
    $('expires').textContent = 'Deployment completed; each purchase uses a fresh quote.';
    if (!account || !provider) {
      status('Replacement sale is active. Connect MetaMask, then get a fresh 0.001 ETH purchase quote.');
      return;
    }
    await activateManifest();
    if (quote && Date.now() <= quote.expiresAt) {
      status(`Replacement sale is active. Live quote ready for ${eth.formatUnits(quote.rchOut, 18)} RCH at ${minimumEth} ETH. Click Buy to continue.`);
    } else {
      status('Replacement sale is active. The old sale is closed and cannot mint. Get a fresh purchase quote.');
    }
  } else {
    const explanations = {
      deploy: 'The new sale will deploy paused; the current sale remains unchanged until deployment confirms.',
      'pause-old-sale': 'Pause the old sale before granting the replacement sale mint authority.',
      'grant-new-sale-role': 'The old sale is paused. Grant the replacement sale the RCH sale-mint role.',
      'open-new-sale': 'The replacement sale has mint authority. Open it while the old sale remains paused.',
      'revoke-old-sale-role': 'The replacement is open and the old sale remains paused. Remove the old sale mint role.',
      'close-old-sale': 'The old sale can no longer mint. Permanently close it to finish the cutover.',
    };
    status(explanations[action] || 'Refresh chain state before continuing.');
  }
}
async function activateManifest() {
  const response = await fetch('activate', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ admin: plan.admin, sale: plan.expectedSale }),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Could not update the active RCH sale record.');
}
async function checkPending() {
  pending = JSON.parse(localStorage.getItem('rch-replacement-pending') || 'null');
  if (!pending || !provider) return;
  const receipt = await provider.getTransactionReceipt(pending.hash);
  if (!receipt) throw new Error(`Transaction ${pending.hash} is pending or unknown. Do not submit another step; refresh after it confirms.`);
  if (receipt.status !== 1) {
    localStorage.removeItem('rch-replacement-pending');
    pending = null;
    throw new Error(`Transaction ${receipt.hash} failed. Refresh chain state before retrying.`);
  }
  showHash(pending.action, pending.hash);
  localStorage.removeItem('rch-replacement-pending');
  pending = null;
}
async function getLiveState() {
  await checkPending();
  snapshot = await json('state.json');
  return snapshot;
}
async function sendReviewed({ action, to, data, value = 0n, deploy = false }) {
  const s = await getLiveState();
  if (deploy && s.nextAction !== 'deploy') throw new Error('Deployment is no longer the next safe step. Refresh.');
  const requiredState = action === 'buy-0.001-ETH' ? 'complete' : action;
  if (!deploy && s.nextAction !== requiredState) throw new Error('On-chain state changed. Refresh before approving this step.');
  let gasLimit, nonce;
  const fees = await currentEip1559Fees(provider);
  if (deploy) {
    checkPlan();
    nonce = await provider.getTransactionCount(account, 'pending');
    if (nonce !== plan.transaction.nonce) throw new Error('Wallet nonce changed. Restart the replacement command to prepare a fresh plan.');
    if (await provider.getCode(plan.expectedSale) !== '0x') throw new Error('The predicted replacement address is occupied. Refresh and preserve the existing sale.');
    gasLimit = BigInt(plan.transaction.gasLimit);
    const estimate = await provider.estimateGas({ from: account, data: plan.transaction.data, value: 0n });
    if (estimate > gasLimit) throw new Error('Deployment gas estimate increased. Restart the replacement command for a fresh plan.');
  } else {
    const estimate = await provider.estimateGas({ from: account, to, data, value });
    gasLimit = (estimate * 120n + 99n) / 100n;
  }
  const maximumFee = gasLimit * fees.maxFeePerGas;
  if (maximumFee > perActionFeeCap) throw new Error(`Maximum gas fee ${eth.formatEther(maximumFee)} ETH exceeds the 0.0005 ETH per-step limit.`);
  const balance = await provider.getBalance(account);
  if (balance < value + maximumFee) throw new Error('The buyer/admin wallet lacks the transaction amount plus maximum gas.');
  const tx = {
    from: account, chainId: '0x1', value: eth.toBeHex(value), gas: eth.toBeHex(gasLimit),
    maxFeePerGas: eth.toBeHex(fees.maxFeePerGas), maxPriorityFeePerGas: eth.toBeHex(fees.maxPriorityFeePerGas),
    data,
  };
  if (to) tx.to = to;
  if (deploy) tx.nonce = eth.toBeHex(nonce);
  status(`Review ${action} in MetaMask. No transaction is sent unless you approve it there.`);
  const hash = await window.ethereum.request({ method: 'eth_sendTransaction', params: [tx] });
  pending = { action, hash };
  localStorage.setItem('rch-replacement-pending', JSON.stringify(pending));
  status(`MetaMask submitted ${action}. Waiting for ${hash} to confirm; do not repeat the step.`);
  const receipt = await provider.waitForTransaction(hash, 1, 120000);
  if (!receipt) throw new Error(`Transaction ${hash} has no confirmed receipt yet. Keep its hash and refresh later.`);
  if (receipt.status !== 1) {
    localStorage.removeItem('rch-replacement-pending');
    pending = null;
    throw new Error(`Transaction ${hash} failed. Refresh before taking another action.`);
  }
  if (deploy && !same(receipt.contractAddress, plan.expectedSale)) throw new Error('Deployment receipt created a different sale address. Preserve the hash and stop.');
  localStorage.removeItem('rch-replacement-pending');
  pending = null;
  showHash(action, hash);
  return receipt;
}
async function performStep() {
  await wallet(false);
  await checkPending();
  const s = await getLiveState();
  if (s.nextAction === 'deploy') {
    await sendReviewed({ action: 'deploy-replacement', data: plan.transaction.data, deploy: true });
  } else {
    const token = new eth.Contract(plan.token, tokenArtifact.abi, provider);
    const oldSale = new eth.Contract(plan.oldSale, saleArtifact.abi, provider);
    const newSale = new eth.Contract(plan.expectedSale, saleArtifact.abi, provider);
    let to, data;
    if (s.nextAction === 'pause-old-sale') { to = plan.oldSale; data = oldSale.interface.encodeFunctionData('pause'); }
    else if (s.nextAction === 'grant-new-sale-role') {
      to = plan.token;
      data = token.interface.encodeFunctionData('grantRole', [await token.SALE_MINTER_ROLE(), plan.expectedSale]);
    } else if (s.nextAction === 'open-new-sale') { to = plan.expectedSale; data = newSale.interface.encodeFunctionData('unpause'); }
    else if (s.nextAction === 'revoke-old-sale-role') {
      to = plan.token;
      data = token.interface.encodeFunctionData('revokeRole', [await token.SALE_MINTER_ROLE(), plan.oldSale]);
    } else if (s.nextAction === 'close-old-sale') { to = plan.oldSale; data = oldSale.interface.encodeFunctionData('closeSale'); }
    else throw new Error('No replacement action is available.');
    await sendReviewed({ action: s.nextAction, to, data });
  }
  await refreshState();
}
async function liveQuote() {
  await wallet(false);
  const s = await getLiveState();
  if (s.nextAction !== 'complete') throw new Error('Finish and verify the sale replacement before purchasing.');
  const sale = new eth.Contract(plan.expectedSale, saleArtifact.abi, provider);
  if (!same(await sale.treasury(), plan.treasury)) throw new Error('Live treasury does not match the GitHub wallet.');
  const minimum = await sale.MIN_PURCHASE_WEI();
  if (minimum !== eth.parseEther(minimumEth)) throw new Error('Replacement sale has an unexpected minimum.');
  const [rchOut, ethUsd] = await sale.quote(minimum);
  quote = { rchOut, ethUsd, expiresAt: Date.now() + 60000 };
  $('quote').textContent = `${eth.formatUnits(rchOut, 18)} RCH for ${minimumEth} ETH (about $${(Number(eth.formatUnits(ethUsd, 8)) * Number(minimumEth)).toFixed(2)} at this feed quote)`;
  button('buy', busy);
  status('Review the live RCH amount and GitHub treasury, then confirm the exact 0.001 ETH payment in MetaMask.');
}
async function buyMinimum() {
  await wallet(false);
  if (!quote || Date.now() > quote.expiresAt) throw new Error('Quote expired. Get a fresh quote before buying.');
  const s = await getLiveState();
  if (s.nextAction !== 'complete') throw new Error('Sale cutover changed. Refresh before buying.');
  const sale = new eth.Contract(plan.expectedSale, saleArtifact.abi, provider);
  if (!same(await sale.treasury(), plan.treasury) || await sale.paused() || await sale.saleClosed()) throw new Error('New sale is not open with the verified GitHub treasury.');
  const payment = eth.parseEther(minimumEth);
  const [rchOut, price] = await sale.quote(payment);
  if (rchOut !== quote.rchOut || price !== quote.ethUsd) throw new Error('Oracle quote changed. Review a fresh quote.');
  const block = await provider.getBlock('latest');
  const minimumRchOut = rchOut * 9950n / 10000n;
  const data = sale.interface.encodeFunctionData('buy', [minimumRchOut, block.timestamp + 600]);
  const beforeRch = await new eth.Contract(plan.token, tokenArtifact.abi, provider).balanceOf(account);
  const treasury = await sale.treasury();
  const beforeTreasuryEth = await provider.getBalance(treasury);
  const receipt = await sendReviewed({ action: 'buy-0.001-ETH', to: plan.expectedSale, data, value: payment });
  // A confirmed payment must never reuse its quote, even if a later check fails.
  quote = null;
  const parsed = receipt.logs.filter((log) => same(log.address, plan.expectedSale)).map((log) => {
    try { return sale.interface.parseLog(log); } catch { return null; }
  }).filter(Boolean);
  const purchased = parsed.find((event) => event.name === 'Purchased');
  const proceeds = parsed.find((event) => event.name === 'ProceedsWithdrawn');
  if (!purchased || !proceeds || !same(purchased.args.buyer, account)
    || purchased.args.ethPaid !== payment || purchased.args.rchReceived < minimumRchOut
    || !same(proceeds.args.treasury, treasury) || proceeds.args.amount !== payment) {
    throw new Error(`Purchase receipt ${receipt.hash} did not prove the expected RCH mint and 0.001 ETH treasury transfer. Keep this hash and stop.`);
  }
  const afterRch = await new eth.Contract(plan.token, tokenArtifact.abi, provider).balanceOf(account, { blockTag: receipt.blockNumber });
  const afterTreasuryEth = await provider.getBalance(treasury, receipt.blockNumber);
  if (afterRch - beforeRch !== purchased.args.rchReceived || afterTreasuryEth < beforeTreasuryEth + payment) {
    throw new Error(`Purchase receipt ${receipt.hash} is on-chain, but the final token or treasury balance check differed. Keep this hash and stop.`);
  }
  $('rch-balance').textContent = `${eth.formatUnits(afterRch, 18)} RCH`;
  quote = null;
  button('buy', true);
  button('get-quote', false);
  completedPurchaseMessage = `Purchase confirmed: ${eth.formatUnits(afterRch - beforeRch, 18)} RCH minted to ${account}; 0.001 ETH sent to treasury ${treasury}.`;
  status(completedPurchaseMessage);
}
function run(id, task) {
  $(id).addEventListener('click', async () => {
    if (busy || !ready) return;
    busy = true;
    for (const control of ['connect', 'refresh', 'step', 'get-quote', 'buy']) button(control, true);
    let finalStatus = '';
    try { await task(); }
    catch (error) { finalStatus = error.code === 4001 ? 'MetaMask request cancelled.' : error.message || 'Request failed.'; }
    finally {
      if (account && provider) {
        try { await refreshState(); }
        catch (error) { finalStatus ||= error.message || 'Could not refresh the replacement state.'; }
      }
      if (id === 'buy' && completedPurchaseMessage) {
        finalStatus = completedPurchaseMessage;
        completedPurchaseMessage = '';
      } else if (!finalStatus) finalStatus = $('status').textContent;
      busy = false;
      button('connect', !ready);
      button('refresh', !ready);
      if (account && provider && snapshot) {
        const canAct = !pending;
        const canBuy = canAct && snapshot.nextAction === 'complete';
        button('step', !canAct || snapshot.nextAction === 'complete');
        button('get-quote', !canBuy);
        button('buy', !canBuy || !quote || Date.now() > quote.expiresAt);
      }
      if (finalStatus) status(finalStatus);
    }
  });
}

run('connect', async () => { await wallet(true); await refreshState(); status(`Connected ${account}. Review the next step and its MetaMask prompt.`); });
run('refresh', async () => { await wallet(false); await refreshState(); });
run('step', performStep);
run('get-quote', liveQuote);
run('buy', buyMinimum);
window.ethereum?.on?.('accountsChanged', () => {
  account = null; provider = null; quote = null; snapshot = null;
  $('account').textContent = 'Account changed; reconnect';
  for (const id of ['refresh', 'step', 'get-quote', 'buy']) button(id, true);
  status('MetaMask account changed. Reconnect the authorized buyer/admin wallet.');
});
window.ethereum?.on?.('chainChanged', () => location.reload());
load().catch((error) => status(error.message || 'Could not load the replacement plan.'));
