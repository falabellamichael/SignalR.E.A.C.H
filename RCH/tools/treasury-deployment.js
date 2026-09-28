const $ = id => document.getElementById(id);
const same = (a, b) => a?.toLowerCase() === b?.toLowerCase();
const pendingKey = 'rch-treasury-deployment-pending-v1';
let current, address, walletIssue, busy = false, feeKind;
let pending;
function readPending() {
  try { return JSON.parse(localStorage.getItem(pendingKey) || 'null'); }
  catch { return { phase: 'review', type: 'unknown' }; }
}
pending = readPending();
function savePending(next) {
  if (next) localStorage.setItem(pendingKey, JSON.stringify(next)); else localStorage.removeItem(pendingKey);
  pending = next;
}
const unsigned = () => !!pending && !pending.hash;
const status = text => { $('status').textContent = text; };
const failure = error => status(error?.shortMessage || error?.message || String(error));
async function api(path, body) {
  const response = await fetch(`./${path}`, { cache: 'no-store', ...(body ? {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  } : {}) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Mainnet verification failed.');
  return data;
}
function render() {
  if (!current) return;
  $('wallet').textContent = walletIssue || `MetaMask: ${address} on Ethereum mainnet`;
  $('configuration').textContent = `Network: Ethereum mainnet\nPayer and owner: ${current.owner}\nRCH token: ${current.token}\nReceiving treasury: ${current.treasury}\nQuote signer: ${current.quoteSigner}\nAccount 1 ETH: ${current.balanceEth}\nContract: ${current.deployment?.contractAddress || 'not yet verified'}\nPaused: ${current.deployment ? current.deployment.paused : 'starts paused'}`;
  $('deploy').disabled = busy || !!pending || !!walletIssue || feeKind !== 'deploy' || !same(address, current.owner) || !!current.transactionHash;
  $('unpause').disabled = busy || !!pending || !!walletIssue || feeKind !== 'unpause' || !same(address, current.owner) || !current.backendReady || current.deployment?.paused !== true;
  $('unsignedReview').hidden = !unsigned();
  $('cancelledReview').disabled = busy;
  $('readiness').textContent = current.deployment?.paused === false ? 'Redemption is enabled on Ethereum mainnet.'
    : current.backendReady ? 'The backend is ready for this deployment. You can review activation in MetaMask.'
    : 'The account backend must be configured and verified before activation.';
  if (current.transactionHash) $('result').textContent = `Deployment: ${current.transactionHash}\n${current.deployment ? `Verified contract: ${current.deployment.contractAddress}\nRuntime and all configured addresses match.` : 'Waiting for a confirmed receipt.'}`;
}
async function feePlan(type) {
  feeKind = undefined;
  const plan = await api(type === 'deploy' ? 'plan.json' : 'unpause.json');
  $('networkFee').textContent = `${type === 'deploy' ? 'Deployment' : 'Activation'} maximum network fee: ${plan.networkFee.maximumEth} ETH\nAccount 1 pending balance: ${plan.networkFee.balanceEth} ETH\nGas limit: ${plan.networkFee.gasLimit}; maximum fee per gas: ${plan.networkFee.maxFeePerGasWei} wei\nQuoted: ${plan.networkFee.quotedAt}. This maximum is refreshed before MetaMask opens. The final fee can be lower.`;
  feeKind = type;
  return plan;
}
async function load(quoteFees = true) {
  current = await api('state.json');
  await restoreWallet();
  if (quoteFees && !pending) {
    const type = !current.transactionHash ? 'deploy' : current.backendReady && current.deployment?.paused ? 'unpause' : null;
    if (type) {
      try { await feePlan(type); }
      catch (error) { $('networkFee').textContent = error.message; render(); throw error; }
    } else { feeKind = undefined; $('networkFee').textContent = 'No transaction is ready for review.'; }
  }
  render(); return current;
}
async function restoreWallet() {
  address = undefined;
  walletIssue = undefined;
  if (!window.ethereum) {
    walletIssue = 'MetaMask is not available in this browser. Open this page in Edge with MetaMask installed and enabled.';
    return;
  }
  try {
    // Read existing authorization only; connection prompts require the Connect button.
    const [accounts, chain] = await Promise.all([window.ethereum.request({ method: 'eth_accounts' }), window.ethereum.request({ method: 'eth_chainId' })]);
    address = accounts[0];
    if (chain !== '0x1') walletIssue = 'MetaMask is on another network. Select Ethereum mainnet, then check current status.';
    else if (!address) walletIssue = 'MetaMask is available but no account is connected. Unlock MetaMask and click Connect MetaMask.';
    else if (!same(address, current.owner)) walletIssue = `MetaMask has ${address} selected. Select Account 1 (${current.owner}), then check current status.`;
  } catch (error) {
    walletIssue = `Could not read MetaMask's current account: ${error?.message || String(error)}. Unlock MetaMask and check current status.`;
  }
}
async function verifyWallet() {
  await restoreWallet();
  if (walletIssue) throw new Error(walletIssue);
}
async function check() {
  pending = readPending();
  if (pending?.hash && pending.type === 'deploy') {
    const result = await api('record', { transactionHash: pending.hash });
    if (result.status === 'verified') savePending(null);
  } else if (pending?.hash && pending.type === 'unpause') {
    const receipt = await window.ethereum?.request({ method: 'eth_getTransactionReceipt', params: [pending.hash] });
    if (receipt) {
      const hash = pending.hash;
      savePending(null);
      if (receipt.status !== '0x1') throw new Error(`Activation failed: ${hash}`);
    }
  }
  await load();
  status(unsigned() ? 'A MetaMask review was already opened. Finish or cancel that request in MetaMask before starting another. If it was submitted, recover its transaction hash below.'
    : pending ? `Waiting for transaction ${pending.hash}. Check again after confirmation.` : walletIssue || (current.deployment ? 'On-chain configuration verified.' : 'Account 1 is connected. Ready to review deployment.'));
}
$('connect').onclick = async () => { try {
  if (!window.ethereum) throw new Error('MetaMask is unavailable in this browser.');
  await window.ethereum.request({ method: 'eth_requestAccounts' });
  await load(); await verifyWallet(); render(); status('Account 1 connected on Ethereum mainnet.');
} catch (error) { failure(error); } };
async function review(type) {
  pending = readPending();
  if (busy || pending) return;
  busy = true; render();
  let requestId;
  try {
    await load(false); await verifyWallet();
    const plan = await feePlan(type);
    if (readPending()) throw new Error('Another wallet review is already pending. Check its status before continuing.');
    requestId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    // Persist before opening MetaMask so a reload cannot silently queue another request.
    savePending({ type, phase: 'review', requestId, nonce: plan.transaction.nonce, startedAt: new Date().toISOString() });
    render();
    // MetaMask displays the exact deployment/activation transaction and fee.
    // The helper never signs with or receives a private key.
    status(`Review the transaction in MetaMask. Maximum network fee: ${plan.networkFee.maximumEth} ETH.`);
    const hash = await window.ethereum.request({ method: 'eth_sendTransaction', params: [plan.transaction] });
    $('result').textContent = `Submitted ${type}: ${hash}`;
    savePending({ type, phase: 'submitted', hash });
    if (type === 'deploy') await api('record', { transactionHash: hash });
    await check();
  } catch (error) {
    if (error?.code === 4001 && readPending()?.requestId === requestId && requestId) savePending(null);
    failure(error);
  }
  finally { busy = false; render(); }
}
$('deploy').onclick = () => review('deploy');
$('unpause').onclick = () => review('unpause');
$('refresh').onclick = () => check().catch(failure);
$('recover').onclick = async () => { try {
  const hash = $('hash').value.trim();
  if (!/^0x[0-9a-f]{64}$/i.test(hash)) throw new Error('Enter a complete Ethereum transaction hash.');
  const result = await api('record', { transactionHash: hash });
  savePending(result.status === 'verified' ? null : { type: 'deploy', phase: 'submitted', hash });
  await check();
} catch (error) { failure(error); } };
$('cancelledReview').onclick = async () => {
  pending = readPending();
  if (busy || !unsigned()) return;
  try { savePending(null); await check(); }
  catch (error) { failure(error); }
};
window.addEventListener('storage', event => {
  if (event.key === pendingKey) { pending = readPending(); render(); }
});
for (const event of ['accountsChanged', 'chainChanged']) window.ethereum?.on?.(event, () => {
  address = undefined; walletIssue = 'Checking the selected MetaMask account and network…'; render();
  check().catch(failure);
});
check().catch(failure);
