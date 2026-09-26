'use strict';

const $ = id => document.getElementById(id);
const eth = window.ethers;
const purchaseWei = eth.parseEther('0.001');
const mainnetFeed = '0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419';
const feedAbi = [
  'function decimals() view returns(uint8)',
  'function description() view returns(string)',
  'function latestRoundData() view returns(uint80,int256,uint256,uint256,uint80)',
];
let plan, launchArtifact, saleArtifact, provider, selectedAddress, quoted;

function status(message) { $('status').textContent = message; }
function showTransaction(hash) {
  if (!/^0x[0-9a-f]{64}$/i.test(hash)) throw new Error('Wallet returned an invalid transaction hash.');
  $('transaction').textContent = `Transaction hash: ${hash}`;
}
function requireCondition(condition, message) { if (!condition) throw new Error(message); }
function address(value) { return eth.getAddress(value); }
function same(a, b) { return address(a) === address(b); }
async function json(path) {
  const response = await fetch(path, { cache: 'no-store' });
  if (!response.ok) throw new Error(`Could not load local ${path}.`);
  return response.json();
}
async function hashData(value) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('');
}
function planAge() { return Date.now() - Date.parse(plan.createdAt); }
function checkPlanAge() {
  requireCondition(Number.isFinite(planAge()) && planAge() >= 0 && planAge() <= 15 * 60 * 1000,
    'The deployment plan expired. Prepare a fresh plan before deploying.');
}

async function loadPlan() {
  [plan, launchArtifact, saleArtifact] = await Promise.all([
    json('/plan.json'), json('/launch-artifact.json'), json('/sale-artifact.json'),
  ]);
  const config = plan.config;
  requireCondition(plan.schema === 'rch-deployment-plan-v1' && config.chainId === 1 && plan.transaction.chainId === 1,
    'This is not an Ethereum mainnet RCH plan.');
  requireCondition(!same(config.deployer, config.treasury)
    && (same(config.admin, config.deployer) || same(config.admin, config.treasury)),
  'The payer and treasury must be separate, and the administrator must be one of those reviewed accounts.');
  requireCondition(same(config.feed, mainnetFeed), 'The ETH/USD feed differs from the reviewed mainnet feed.');
  requireCondition(same(plan.transaction.from, config.deployer) && Number.isSafeInteger(plan.transaction.nonce),
    'The deployment signer or nonce is invalid.');
  requireCondition(same(plan.tokenAddress, eth.getCreateAddress({ from: config.deployer, nonce: plan.transaction.nonce }))
    && same(plan.saleAddress, eth.getCreateAddress({ from: plan.tokenAddress, nonce: 1 })),
  'The predicted contract addresses do not match the deployment nonce.');
  requireCondition(await hashData(plan.transaction.data) === plan.dataHash,
    'The deployment transaction data differs from the reviewed hash.');
  const factory = new eth.ContractFactory(launchArtifact.abi, launchArtifact.bytecode);
  const built = await factory.getDeployTransaction(config.admin, config.treasury, config.feed,
    config.maxOracleAgeSeconds, eth.parseUnits(config.minEthUsd, 8), eth.parseUnits(config.maxEthUsd, 8));
  requireCondition(built.data.toLowerCase() === plan.transaction.data.toLowerCase(),
    'The deployment data does not match the compiled RCH contract and configured wallet.');
  const maximumFee = BigInt(plan.transaction.gasLimit) * BigInt(plan.transaction.maxFeePerGas);
  requireCondition(maximumFee <= eth.parseEther(config.maxDeploymentFeeEth)
    && eth.formatEther(maximumFee) === plan.maxCostEth,
  'The deployment fee exceeds the reviewed budget.');
  $('network').textContent = 'Ethereum mainnet (chain 1)';
  $('deployer').textContent = address(config.deployer);
  $('treasury').textContent = address(config.treasury);
  $('admin').textContent = address(config.admin);
  $('feed').textContent = address(config.feed);
  $('token').textContent = address(plan.tokenAddress);
  $('sale').textContent = address(plan.saleAddress);
  $('max-fee').textContent = `${plan.maxCostEth} ETH at the prepared gas limit and maximum fee`;
  $('created').textContent = plan.createdAt;
  $('source-hash').textContent = plan.sourceHash;
  $('connect').disabled = false;
  $('refresh').disabled = false;
  const savedHash = localStorage.getItem('rch-mainnet-deployment-hash');
  if (savedHash && /^0x[0-9a-f]{64}$/i.test(savedHash)) showTransaction(savedHash);
  status(planAge() > 15 * 60 * 1000
    ? 'The plan has expired. Prepare a fresh one before deploying. Existing deployed contracts can still be inspected.'
    : 'Review the plan, then connect MetaMask. No transaction has been sent.');
}

async function walletAccount(prompt) {
  requireCondition(window.ethereum?.request, 'Open this local page in Edge with MetaMask enabled.');
  const chain = await window.ethereum.request({ method: 'eth_chainId' });
  requireCondition(chain?.toLowerCase() === '0x1', 'Switch MetaMask to Ethereum mainnet.');
  const accounts = await window.ethereum.request({ method: prompt ? 'eth_requestAccounts' : 'eth_accounts' });
  requireCondition(Array.isArray(accounts) && accounts.length > 0, 'Connect a MetaMask account.');
  selectedAddress = address(accounts[0]);
  provider = new eth.BrowserProvider(window.ethereum);
  $('account').textContent = selectedAddress;
  $('buyer').textContent = same(selectedAddress, plan.config.deployer)
    ? selectedAddress : 'Select the deployment payer account in MetaMask';
  return selectedAddress;
}

async function saleState() {
  const code = await provider.getCode(plan.saleAddress);
  requireCondition(code !== '0x', 'The RCH sale is not deployed at the reviewed address.');
  const verified = await json('/state.json');
  requireCondition(verified.verified && same(verified.state.sale, plan.saleAddress),
    'The deployed sale does not match the locally reviewed RCH build.');
  const sale = new eth.Contract(plan.saleAddress, saleArtifact.abi, provider);
  requireCondition(same(await sale.treasury(), plan.config.treasury), 'The deployed sale treasury differs from your backup wallet.');
  requireCondition(same(await sale.rch(), plan.tokenAddress), 'The sale points to a different RCH token.');
  requireCondition(await sale.MIN_PURCHASE_WEI() === purchaseWei, 'The deployed sale has a different minimum payment.');
  return sale;
}

async function refreshButtons(preserveQuote = false) {
  $('deploy').disabled = true;
  $('open-sale').disabled = true;
  $('get-quote').disabled = true;
  $('buy').disabled = true;
  if (!preserveQuote) quoted = null;
  if (!selectedAddress || !provider) return;
  const code = await provider.getCode(plan.saleAddress);
  if (code === '0x') {
    if (localStorage.getItem('rch-mainnet-deployment-hash')) {
      status('A deployment transaction hash was saved. Resolve that transaction before attempting another deployment.');
      return false;
    }
    if (planAge() > 15 * 60 * 1000) {
      status('The deployment plan expired. Prepare a fresh plan before deploying.');
      return false;
    }
    $('deploy').disabled = !same(selectedAddress, plan.config.deployer) || planAge() > 15 * 60 * 1000;
    return true;
  }
  let sale;
  try { sale = await saleState(); }
  catch {
    status('Deployment verification is pending or unavailable. Keep its hash and refresh later.');
    return false;
  }
  if (same(selectedAddress, plan.config.admin)) {
    $('open-sale').disabled = await sale.paused() === false || await sale.saleClosed();
  }
  if (same(selectedAddress, plan.config.deployer) && !(await sale.paused()) && !(await sale.saleClosed())) {
    $('get-quote').disabled = false;
    $('buy').disabled = !quoted || Date.now() - quoted.at > 60000;
  }
  return true;
}

async function connect() {
  await walletAccount(true);
  if (await refreshButtons()) status(`Connected ${selectedAddress}. Review the enabled action and its MetaMask confirmation.`);
}

async function ensureDeploymentReady() {
  checkPlanAge();
  const account = await walletAccount(false);
  requireCondition(same(account, plan.config.deployer), 'Select the deployment payer account in MetaMask.');
  const nonce = await provider.getTransactionCount(account, 'pending');
  requireCondition(nonce === plan.transaction.nonce, 'The wallet nonce changed. Prepare and review a new deployment plan.');
  requireCondition(await provider.getCode(plan.tokenAddress) === '0x', 'The predicted token address is already occupied.');
  const fees = await provider.getFeeData();
  requireCondition(fees.maxFeePerGas !== null && fees.maxPriorityFeePerGas !== null,
    'MetaMask did not provide current Ethereum fee data.');
  const maximumFee = BigInt(plan.transaction.gasLimit) * fees.maxFeePerGas;
  requireCondition(maximumFee <= eth.parseEther(plan.config.maxDeploymentFeeEth),
    `The current maximum deployment fee exceeds the ${plan.config.maxDeploymentFeeEth} ETH budget. Prepare a new plan or wait for lower fees.`);
  requireCondition(await provider.getBalance(account) >= maximumFee,
    `The deployment payer needs at least ${eth.formatEther(maximumFee)} ETH for the current maximum deployment fee.`);
  $('max-fee').textContent = `${eth.formatEther(maximumFee)} ETH at the current MetaMask fee quote`;
  const feed = new eth.Contract(plan.config.feed, feedAbi, provider);
  const [decimals, description, round, block] = await Promise.all([
    feed.decimals(), feed.description(), feed.latestRoundData(), provider.getBlock('latest'),
  ]);
  requireCondition(decimals === 8n && description === 'ETH / USD', 'The mainnet price feed has the wrong identity.');
  const [roundId, price,, updatedAt, answeredInRound] = round;
  requireCondition(roundId > 0n && answeredInRound >= roundId && price > 0n
    && updatedAt > 0n && updatedAt <= BigInt(block.timestamp)
    && BigInt(block.timestamp) - updatedAt <= BigInt(plan.config.maxOracleAgeSeconds)
    && price >= eth.parseUnits(plan.config.minEthUsd, 8)
    && price <= eth.parseUnits(plan.config.maxEthUsd, 8),
  'The ETH/USD feed is stale, incomplete, or outside the configured bounds.');
  return fees;
}

async function sendTransaction(transaction) {
  const hash = await window.ethereum.request({ method: 'eth_sendTransaction', params: [transaction] });
  showTransaction(hash);
  return hash;
}

async function waitForSuccess(hash) {
  const receipt = await provider.waitForTransaction(hash, 1, 120000);
  requireCondition(receipt && receipt.status === 1, 'The transaction is pending or failed. Preserve its hash and check Etherscan.');
  return receipt;
}

async function deploy() {
  const fees = await ensureDeploymentReady();
  const tx = plan.transaction;
  const hash = await sendTransaction({
    from: address(tx.from), data: tx.data, value: '0x0',
    gas: eth.toBeHex(BigInt(tx.gasLimit)), nonce: eth.toBeHex(tx.nonce),
    maxFeePerGas: eth.toBeHex(fees.maxFeePerGas),
    maxPriorityFeePerGas: eth.toBeHex(fees.maxPriorityFeePerGas),
  });
  localStorage.setItem('rch-mainnet-deployment-hash', hash);
  try {
    const response = await fetch('/record', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ txHash: hash, dataHash: plan.dataHash }) });
    requireCondition(response.ok, 'The transaction was sent, but its local record could not be saved. Preserve the hash.');
  } catch (error) {
    status(error.message);
    return;
  }
  const receipt = await waitForSuccess(hash);
  requireCondition(same(receipt.contractAddress, plan.tokenAddress),
    'The deployment receipt has an unexpected token address. Preserve the hash and do not redeploy.');
  await refreshButtons();
  status(`Deployment included at ${plan.tokenAddress}. Wait for Ethereum finality, then refresh sale status before opening it.`);
}

async function openSale() {
  const account = await walletAccount(false);
  requireCondition(same(account, plan.config.admin), 'Select the administrator account in MetaMask.');
  const sale = await saleState();
  requireCondition(same(await sale.owner(), account) && await sale.paused() && !(await sale.saleClosed()),
    'This account cannot open the reviewed sale.');
  const hash = await sendTransaction({ from: account, to: address(plan.saleAddress),
    data: sale.interface.encodeFunctionData('unpause'), value: '0x0' });
  await waitForSuccess(hash);
  requireCondition(!(await sale.paused()), 'The sale remains paused. Preserve the transaction hash.');
  await refreshButtons();
  status('The RCH sale is open. Select the deployment payer account in MetaMask to purchase.');
}

async function liveQuote() {
  const account = await walletAccount(false);
  requireCondition(same(account, plan.config.deployer), 'Select the deployment payer account in MetaMask to buy.');
  const sale = await saleState();
  requireCondition(!(await sale.paused()) && !(await sale.saleClosed()), 'The sale is not open.');
  const [rchOut, ethUsd] = await sale.quote(purchaseWei);
  requireCondition(rchOut > 0n, 'The live quote produced no RCH.');
  quoted = { rchOut, ethUsd, at: Date.now() };
  $('quote').textContent = `${eth.formatUnits(rchOut, 18)} RCH`;
  $('eth-usd').textContent = `$${eth.formatUnits(ethUsd, 8)}`;
  $('buy').disabled = false;
  status('Review the quote and treasury address. It expires on this page after one minute.');
}

async function buy() {
  const account = await walletAccount(false);
  requireCondition(same(account, plan.config.deployer), 'Select the deployment payer account in MetaMask to buy.');
  requireCondition(quoted && Date.now() - quoted.at <= 60000, 'Get a fresh quote before buying.');
  const sale = await saleState();
  requireCondition(!(await sale.paused()) && !(await sale.saleClosed()), 'The sale is not open.');
  const [rchOut] = await sale.quote(purchaseWei);
  requireCondition(rchOut === quoted.rchOut, 'The price changed. Get and review a fresh quote.');
  const block = await provider.getBlock('latest');
  const minRchOut = rchOut * 9950n / 10000n;
  const deadline = block.timestamp + 600;
  const hash = await sendTransaction({ from: account, to: address(plan.saleAddress),
    value: eth.toBeHex(purchaseWei), data: sale.interface.encodeFunctionData('buy', [minRchOut, deadline]) });
  await waitForSuccess(hash);
  $('buy').disabled = true;
  status(`Purchase confirmed. Check RCH in the buyer account and ETH proceeds in ${address(plan.config.treasury)}.`);
}

function action(id, task) {
  $(id).addEventListener('click', async () => {
    const button = $(id);
    button.disabled = true;
    let succeeded = false;
    try { await task(); succeeded = true; }
    catch (error) { status(error.code === 4001 ? 'MetaMask request cancelled.' : error.message || 'Request failed.'); }
    finally { if (selectedAddress) await refreshButtons(id === 'get-quote' && succeeded).catch(error => status(error.message)); }
  });
}

action('connect', connect);
action('refresh', async () => {
  await walletAccount(false);
  if (await refreshButtons()) status('Sale state is current and matches the reviewed RCH build.');
});
action('deploy', deploy);
action('open-sale', openSale);
action('get-quote', liveQuote);
action('buy', buy);
window.ethereum?.on?.('accountsChanged', () => {
  selectedAddress = null; quoted = null; $('account').textContent = 'Account changed; connect again';
  $('buyer').textContent = 'Connect the buyer account';
  for (const id of ['deploy', 'open-sale', 'get-quote', 'buy']) $(id).disabled = true;
  status('MetaMask account changed. Click Connect MetaMask to review the available action.');
});
window.ethereum?.on?.('chainChanged', () => location.reload());
loadPlan().catch(error => status(error.message));
