const $ = id => document.getElementById(id);
const same = (a, b) => a?.toLowerCase() === b?.toLowerCase();
const pendingKey = 'rch-treasury-deployment-pending-v1';
let current, address, walletIssue, busy = false, feeKind, pollTimer, pollCount = 0;
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
const unsigned = () => !!pending && pending.phase !== 'submitted' && !pending.hash;
const validBatchId = value => typeof value === 'string' && value.length > 0 && value.length <= 8194;
const validHash = value => typeof value === 'string' && /^0x[0-9a-f]{64}$/i.test(value);
const preAcceptanceRejections = new Set([4001, -32601, -32602, 4100, 4200, 5700, 5710, 5740, 5750, 5760]);
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
  $('failedActivationReview').hidden = !(pending?.type === 'unpause' && pending.hash && !pending.callsId);
  $('discardFailedActivation').disabled = busy;
  $('readiness').textContent = current.deployment?.paused === false ? 'Redemption is enabled on Ethereum mainnet.'
    : current.backendReady ? 'The backend is ready for this deployment. You can review activation in MetaMask.'
    : 'The account backend must be configured and verified before activation.';
  if (current.transactionHash) $('result').textContent = `Deployment: ${current.transactionHash}\n${current.deployment ? `Verified contract: ${current.deployment.contractAddress}\nRuntime and all configured addresses match.` : 'Waiting for a confirmed receipt.'}`;
  if (pending?.callsId) $('result').textContent += `\nActivation wallet batch: ${pending.callsId}\nA wallet batch identifier is not an Ethereum transaction hash.`;
  if (current.activation) $('result').textContent += `\nVerified activation: ${current.activation.transactionHash}`;
}
async function requireSmartCalls() {
  const capabilities = await window.ethereum.request({ method: 'wallet_getCapabilities', params: [current.owner, ['0x1']] });
  if (capabilities?.['0x1']?.atomic?.status !== 'supported') {
    throw new Error('This account is a smart account, but MetaMask has not reported supported calls on Ethereum mainnet. No transaction was sent. Check MetaMask support for this account; the helper will not downgrade or upgrade it automatically.');
  }
}
async function feePlan(type) {
  feeKind = undefined;
  const plan = await api(type === 'deploy' ? 'plan.json' : 'unpause.json');
  if (plan.mode === 'wallet_sendCalls') {
    $('networkFee').textContent = `Smart account activation\nDirect contract-call estimate: ${plan.networkFee.directCallEstimateEth} ETH. This is not a maximum for MetaMask's smart-account transaction; its additional execution and relay costs are quoted by MetaMask.\nAccount 1 pending balance: ${plan.networkFee.balanceEth} ETH\nReview the complete fee in MetaMask before confirming. The helper supplies no transaction gas limit, fee cap, or nonce for this smart-account call.`;
    if (!walletIssue) await requireSmartCalls();
  } else $('networkFee').textContent = `${type === 'deploy' ? 'Deployment' : 'Activation'} maximum network fee: ${plan.networkFee.maximumEth} ETH\nAccount 1 pending balance: ${plan.networkFee.balanceEth} ETH\nGas limit: ${plan.networkFee.gasLimit}; maximum fee per gas: ${plan.networkFee.maxFeePerGasWei} wei\nQuoted: ${plan.networkFee.quotedAt}. This maximum is refreshed before MetaMask opens. The final fee can be lower.`;
  feeKind = type;
  return plan;
}
async function load(quoteFees = true) {
  current = await api('state.json');
  if (!pending && !current.activation && current.activationBatch && !current.activationBatch.resolved) {
    savePending({ type: 'unpause', phase: 'submitted', callsId: current.activationBatch.batchId });
  }
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
function queueActivationCheck() {
  if (pollTimer || pollCount >= 12 || pending?.type !== 'unpause' || pending.phase !== 'submitted') return;
  pollTimer = window.setTimeout(async () => {
    pollTimer = undefined; pollCount += 1;
    try { await check(); } catch (error) { failure(error); queueActivationCheck(); }
  }, 5000);
}
async function check() {
  pending = readPending();
  await load(false);
  let message;
  if (pending?.hash && pending.type === 'deploy') {
    const result = await api('record', { transactionHash: pending.hash });
    if (result.status === 'verified') savePending(null);
  } else if (pending?.callsId && pending.type === 'unpause') {
    if (walletIssue) { status(walletIssue); return; }
    const callsId = pending.callsId;
    let result;
    try { result = await window.ethereum.request({ method: 'wallet_getCallsStatus', params: [callsId] }); }
    catch (error) {
      if (error?.code === 5730) { render(); status(`MetaMask has not found activation batch ${callsId}. Its submission is uncertain. Check MetaMask before retrying; no second transaction was sent.`); return; }
      throw error;
    }
    if (result?.id !== callsId || !/^0x0*1$/i.test(result.chainId || '') || ![100, 200, 400, 500, 600].includes(result.status)) {
      throw new Error('MetaMask returned a mismatched or unknown activation batch status. The pending guard remains in place.');
    }
    const hashes = (result.receipts || []).map(receipt => receipt.transactionHash);
    if (!hashes.every(validHash) || hashes.length > 8) throw new Error('MetaMask returned an invalid activation receipt identifier.');
    savePending({ ...pending, phase: 'submitted' });
    await api('activation-batch', { batchId: callsId, status: result.status, transactionHashes: hashes });
    if (result.status === 400 && hashes.length === 0) {
      savePending(null);
      message = 'MetaMask reports the activation batch failed before execution and has no receipts. You may review a new attempt after checking the wallet details.';
    } else if (result.status === 500 && hashes.length > 0) {
      const failures = [];
      for (const hash of hashes) failures.push(await api('activation-record', { transactionHash: hash, batchId: callsId }));
      if (failures.every(item => item.status === 'failed')) {
        savePending(null); message = 'The activation batch failed in finalized Ethereum receipts. You may review a new attempt.';
      } else message = 'MetaMask reports failure, but finalized Ethereum failure has not been verified. The pending guard remains in place.';
    } else if (result.status >= 400) {
      message = `MetaMask reports activation status ${result.status}. Its result needs reconciliation; the pending guard remains in place. Recover the actual Ethereum receipt below. No replacement was sent.`;
    } else if (result.status === 200) {
      let verified;
      for (const hash of hashes) {
        const receipt = result.receipts.find(item => item.transactionHash === hash);
        if (receipt.status !== '0x1') throw new Error('MetaMask reported a failed receipt in the confirmed activation batch.');
        const confirmation = await api('activation-record', { transactionHash: hash, batchId: callsId });
        if (confirmation.status === 'verified') { verified = confirmation; break; }
      }
      if (verified) { savePending(null); message = `Activation verified on Ethereum: ${verified.transactionHash}`; }
      else message = 'MetaMask reports the batch confirmed. Waiting for the RPC to verify the activation event and current contract state.';
    } else message = `MetaMask is processing activation batch ${callsId}. Check current status after confirmation.`;
  } else if (pending?.hash && pending.type === 'unpause') {
    const result = await api('activation-record', { transactionHash: pending.hash });
    if (result.status === 'verified') { savePending(null); message = `Activation verified on Ethereum: ${result.transactionHash}`; }
    else if (result.status === 'failed') { savePending(null); message = `Activation failed in a finalized Ethereum receipt: ${result.transactionHash}. You may review a new attempt.`; }
    else message = `Activation ${pending.hash} is not yet verified on Ethereum. If MetaMask shows it failed, check whether its identifier is a wallet batch rather than a transaction hash and use activation recovery below. Do not submit again while its result is uncertain.`;
  }
  await load();
  status(message || (unsigned() ? 'A MetaMask review was already opened. Finish or cancel that request in MetaMask before starting another. If it was submitted, recover its transaction hash below.'
    : pending ? `Waiting for transaction ${pending.hash}. Check again after confirmation.` : walletIssue || (current.deployment ? 'On-chain configuration verified.' : 'Account 1 is connected. Ready to review deployment.')));
  queueActivationCheck();
}
$('connect').onclick = async () => { try {
  if (!window.ethereum) throw new Error('MetaMask is unavailable in this browser.');
  await window.ethereum.request({ method: 'eth_requestAccounts' });
  await load(); await verifyWallet(); render(); status('Account 1 connected on Ethereum mainnet.');
} catch (error) { failure(error); } };
async function review(type) {
  pending = readPending();
  if (busy || pending) return;
  pollCount = 0;
  busy = true; render();
  let requestId;
  try {
    await load(false); await verifyWallet();
    const plan = await feePlan(type);
    if (readPending()) throw new Error('Another wallet review is already pending. Check its status before continuing.');
    requestId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const smart = type === 'unpause' && plan.mode === 'wallet_sendCalls';
    const callsId = smart ? `0x${Array.from(crypto.getRandomValues(new Uint8Array(32)), byte => byte.toString(16).padStart(2, '0')).join('')}` : undefined;
    // Persist before opening MetaMask so a reload cannot silently queue another request.
    savePending({ type, phase: 'review', requestId, callsId, nonce: plan.transaction?.nonce, startedAt: new Date().toISOString() });
    render();
    // MetaMask displays the exact deployment/activation transaction and fee.
    // The helper never signs with or receives a private key.
    if (smart) {
      status('Review the smart-account activation and its complete network fee in MetaMask.');
      // EIP-5792 owns wrapper gas and nonce. Never fall back after an uncertain submission.
      const sent = await window.ethereum.request({ method: 'wallet_sendCalls', params: [{ version: '2.0.0', id: callsId,
        from: plan.from, chainId: plan.chainId, atomicRequired: true, calls: plan.calls }] });
      const returnedId = typeof sent === 'string' ? sent : sent?.id || sent?.batchId;
      if (!validBatchId(returnedId)) throw new Error('MetaMask did not return a usable batch identifier. Check the wallet; the pending guard remains in place.');
      savePending({ type, phase: 'submitted', callsId: returnedId });
      await api('activation-batch', { batchId: returnedId, status: 100, transactionHashes: [] });
    } else {
      status(`Review the transaction in MetaMask. Maximum network fee: ${plan.networkFee.maximumEth} ETH.`);
      const hash = await window.ethereum.request({ method: 'eth_sendTransaction', params: [plan.transaction] });
      $('result').textContent = `Submitted ${type}: ${hash}`;
      savePending({ type, phase: 'submitted', hash });
      if (type === 'deploy') await api('record', { transactionHash: hash });
    }
    await check();
  } catch (error) {
    if (preAcceptanceRejections.has(error?.code) && readPending()?.requestId === requestId && requestId) savePending(null);
    failure(error);
  }
  finally { busy = false; render(); }
}
$('deploy').onclick = () => review('deploy');
$('unpause').onclick = () => review('unpause');
$('refresh').onclick = () => { pollCount = 0; return check().catch(failure); };
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
$('recoverActivation').onclick = async () => { try {
  const hash = $('activationHash').value.trim();
  if (!validHash(hash)) throw new Error('Enter a complete Ethereum activation transaction hash.');
  const result = await api('activation-record', { transactionHash: hash });
  savePending(result.status === 'verified' ? null : { type: 'unpause', phase: 'submitted', hash });
  await check();
} catch (error) { failure(error); } };
$('recoverBatch').onclick = async () => { try {
  const callsId = $('batchId').value.trim();
  if (!validBatchId(callsId)) throw new Error('Enter the MetaMask activation batch identifier.');
  savePending({ type: 'unpause', phase: 'submitted', callsId });
  await check();
} catch (error) { failure(error); } };
$('discardFailedActivation').onclick = async () => { try {
  pending = readPending();
  if (busy || pending?.type !== 'unpause' || !pending.hash || pending.callsId) return;
  // Explicit user acknowledgement only; absence from the RPC never clears this guard.
  savePending(null);
  await check();
  status('The failed activation attempt was cleared from this page. This did not cancel or submit a transaction. Review a new activation only if MetaMask confirms the earlier attempt failed or was cancelled.');
} catch (error) { failure(error); } };
window.addEventListener('storage', event => {
  if (event.key === pendingKey) { pending = readPending(); render(); }
});
for (const event of ['accountsChanged', 'chainChanged']) window.ethereum?.on?.(event, () => {
  address = undefined; walletIssue = 'Checking the selected MetaMask account and network…'; render();
  check().catch(failure);
});
check().catch(failure);
