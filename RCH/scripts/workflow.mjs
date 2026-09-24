import { writeFile, readFile } from 'node:fs/promises';
import { Contract, ContractFactory, getAddress, getCreateAddress, keccak256, parseEther, parseUnits, formatEther, formatUnits, ZeroAddress } from 'ethers';
import { sha256 } from './compile.mjs';

export class InputError extends Error {}
const fail = (message) => { throw new InputError(message); };
export const json = (value) => JSON.stringify(value, (_, v) => typeof v === 'bigint' ? v.toString() : v, 2) + '\n';
export const readJson = async (path) => JSON.parse(await readFile(path, 'utf8'));
export const feedAbi = [
  'function decimals() view returns(uint8)', 'function description() view returns(string)',
  'function latestRoundData() view returns(uint80,int256,uint256,uint256,uint80)',
];

export function configFrom(raw) {
  const fields = ['chainId', 'deployer', 'admin', 'treasury', 'feed', 'maxOracleAgeSeconds', 'minEthUsd', 'maxEthUsd', 'maxDeploymentFeeEth'];
  if (!raw || fields.some((key) => raw[key] === undefined) || Object.keys(raw).some((key) => !fields.includes(key))) fail('Configuration has missing or unknown fields. See config/example.json.');
  if (![1, 11155111, 1337, 31337].includes(raw.chainId)) fail('Only Ethereum mainnet, Sepolia, or local Ethereum chains are supported.');
  const config = { ...raw };
  for (const key of ['deployer', 'admin', 'treasury', 'feed']) {
    try { config[key] = getAddress(raw[key]); } catch { fail(`Invalid ${key} address.`); }
    if (config[key] === ZeroAddress) fail(`${key} must not be the zero address.`);
  }
  if (!Number.isSafeInteger(raw.maxOracleAgeSeconds) || raw.maxOracleAgeSeconds <= 0) fail('maxOracleAgeSeconds must be a positive integer.');
  for (const key of ['minEthUsd', 'maxEthUsd', 'maxDeploymentFeeEth']) {
    if (typeof raw[key] !== 'string' || !/^(0|[1-9][0-9]*)(\.[0-9]+)?$/.test(raw[key])) fail(`${key} must be a decimal string.`);
  }
  try {
    if (parseUnits(config.minEthUsd, 8) <= 0n || parseUnits(config.maxEthUsd, 8) <= parseUnits(config.minEthUsd, 8) || parseEther(config.maxDeploymentFeeEth) <= 0n) fail('Invalid oracle bounds or deployment fee budget.');
  } catch { fail('Invalid oracle bounds or deployment fee budget.'); }
  return config;
}

export function validateRpcUrl(url, chainId) {
  let parsed;
  try { parsed = new URL(url); } catch { fail('Set RCH_RPC_URL to the intended Ethereum RPC endpoint.'); }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
  if (!['http:', 'https:'].includes(parsed.protocol) || (!local && parsed.protocol !== 'https:')) fail('Remote RPC endpoints must use HTTPS.');
  if ([1337, 31337].includes(chainId) && !local) fail('Local-chain deployment must use a loopback RPC endpoint.');
  return url;
}

export async function prepare(provider, rawConfig, build) {
  const config = configFrom(rawConfig);
  if ((await provider.getNetwork()).chainId !== BigInt(config.chainId)) fail('RPC chain ID does not match the configuration.');
  if (await provider.getCode(config.feed) === '0x') fail('No oracle contract exists at the configured feed address.');
  const feed = new Contract(config.feed, feedAbi, provider);
  const [decimals, description, round, block] = await Promise.all([feed.decimals(), feed.description(), feed.latestRoundData(), provider.getBlock('latest')]);
  if (decimals !== 8n || description !== 'ETH / USD') fail('The oracle must report ETH / USD with eight decimals.');
  const [roundId, answer,, updatedAt, answeredInRound] = round;
  if (roundId === 0n || answeredInRound < roundId || answer <= 0n || updatedAt === 0n || updatedAt > BigInt(block.timestamp) || BigInt(block.timestamp) - updatedAt > BigInt(config.maxOracleAgeSeconds)) fail('The ETH/USD oracle round is invalid or stale.');
  if (answer < parseUnits(config.minEthUsd, 8) || answer > parseUnits(config.maxEthUsd, 8)) fail('The ETH/USD price is outside the configured bounds.');
  const nonce = await provider.getTransactionCount(config.deployer, 'pending');
  const tokenAddress = getCreateAddress({ from: config.deployer, nonce });
  const saleAddress = getCreateAddress({ from: tokenAddress, nonce: 1 });
  if ([config.admin, config.treasury].some((address) => [tokenAddress, saleAddress].includes(address))) fail('Administrator or treasury cannot be one of the new contracts.');
  const constructorArgs = [config.admin, config.treasury, config.feed, config.maxOracleAgeSeconds, parseUnits(config.minEthUsd, 8), parseUnits(config.maxEthUsd, 8)];
  const artifact = build.artifacts.ReachCreditsLaunch;
  const { data } = await new ContractFactory(artifact.abi, artifact.bytecode).getDeployTransaction(...constructorArgs);
  const gas = await provider.estimateGas({ from: config.deployer, data, value: 0n });
  const gasLimit = (gas * 120n + 99n) / 100n;
  const fees = await provider.getFeeData();
  if (fees.maxFeePerGas == null || fees.maxPriorityFeePerGas == null) fail('RPC did not provide EIP-1559 fee data.');
  const maxCost = gasLimit * fees.maxFeePerGas;
  if (maxCost > parseEther(config.maxDeploymentFeeEth)) fail('Estimated maximum deployment cost exceeds maxDeploymentFeeEth.');
  return {
    schema: 'rch-deployment-plan-v1', createdAt: new Date().toISOString(), config,
    compiler: build.compiler, sourceHash: build.sourceHash, dataHash: sha256(data),
    tokenAddress, saleAddress, oracle: { description, priceUsd: formatUnits(answer, 8), updatedAt: updatedAt.toString() },
    maxCostEth: formatEther(maxCost),
    transaction: { from: config.deployer, chainId: config.chainId, type: 2, nonce, data, value: '0', gasLimit: gasLimit.toString(), maxFeePerGas: fees.maxFeePerGas.toString(), maxPriorityFeePerGas: fees.maxPriorityFeePerGas.toString() },
  };
}

function sameRuntime(actual, artifact) {
  let expected = artifact.deployedBytecode.slice(2).toLowerCase();
  let received = actual.slice(2).toLowerCase();
  if (expected.length !== received.length || !received) return false;
  for (const refs of Object.values(artifact.immutableReferences)) {
    for (const { start, length } of refs) {
      const lo = start * 2, hi = lo + length * 2, zeros = '0'.repeat(length * 2);
      expected = expected.slice(0, lo) + zeros + expected.slice(hi);
      received = received.slice(0, lo) + zeros + received.slice(hi);
    }
  }
  return expected === received;
}

export async function inspectDeployment(provider, record, build, { initial = false } = {}) {
  const plan = record.plan ?? record;
  if (plan.schema !== 'rch-deployment-plan-v1' || plan.sourceHash !== build.sourceHash) fail('Deployment source hash does not match the current build.');
  const config = configFrom(plan.config);
  if ((await provider.getNetwork()).chainId !== BigInt(config.chainId)) fail('RPC chain ID does not match the deployment.');
  for (const [address, name] of [[plan.tokenAddress, 'ReachCreditsLaunch'], [plan.saleAddress, 'ReachCreditsSale']]) {
    if (!sameRuntime(await provider.getCode(address), build.artifacts[name])) fail(`Deployed ${name} code does not match the build.`);
  }
  const token = new Contract(plan.tokenAddress, build.artifacts.ReachCreditsLaunch.abi, provider);
  const sale = new Contract(plan.saleAddress, build.artifacts.ReachCreditsSale.abi, provider);
  if (await token.initialSale() !== plan.saleAddress || await sale.rch() !== plan.tokenAddress || await sale.ethUsdFeed() !== config.feed || await sale.treasury() !== config.treasury || await sale.maxOracleAge() !== BigInt(config.maxOracleAgeSeconds) || await sale.minEthUsdPriceE8() !== parseUnits(config.minEthUsd, 8) || await sale.maxEthUsdPriceE8() !== parseUnits(config.maxEthUsd, 8)) fail('Deployed contract settings do not match the plan.');
  const state = {
    token: plan.tokenAddress, sale: plan.saleAddress,
    administrator: await token.defaultAdmin(), saleOwner: await sale.owner(),
    salePaused: await sale.paused(), saleClosed: await sale.saleClosed(), issuancePaused: await token.issuancePaused(),
    saleCanMint: await token.hasRole(await token.SALE_MINTER_ROLE(), plan.saleAddress),
    supplyRch: formatUnits(await token.totalSupply(), 18),
  };
  if (initial && (state.administrator !== config.admin || state.saleOwner !== config.admin || !state.salePaused || state.saleClosed || state.issuancePaused || !state.saleCanMint || state.supplyRch !== '0.0')) fail('Initial deployment authority, supply, or sale state does not match the plan.');
  return { token, sale, state };
}

export async function broadcast(provider, plan, build, signer, out, confirmedChainId) {
  if (plan.schema !== 'rch-deployment-plan-v1' || confirmedChainId !== plan.config.chainId) fail('Explicit confirmation must match the plan chain ID.');
  if (await signer.getAddress() !== plan.config.deployer) fail('Signing account does not match the configured deployer.');
  const age = Date.now() - Date.parse(plan.createdAt);
  if (!Number.isFinite(age) || age < 0 || age > 15 * 60 * 1000) fail('Plan is expired; prepare a fresh plan before deploying.');
  const fresh = await prepare(provider, plan.config, build);
  for (const key of ['sourceHash', 'compiler', 'dataHash', 'tokenAddress', 'saleAddress']) {
    if (plan[key] !== fresh[key]) fail('Code or deployer nonce changed; prepare and review a new plan.');
  }
  // Reconstruct from the verified build. Never sign a transaction supplied by a plan file.
  const transaction = { ...fresh.transaction };
  delete transaction.from;
  if (await provider.getBalance(plan.config.deployer) < BigInt(transaction.gasLimit) * BigInt(transaction.maxFeePerGas)) fail('Deployer balance is below the estimated maximum fee.');
  const raw = await signer.signTransaction(transaction);
  const record = { schema: 'rch-deployment-record-v1', state: 'signed', txHash: keccak256(raw), plan: fresh };
  // Claim output before sending. Existing records prevent accidental duplicate broadcasts.
  await writeFile(out, json(record), { flag: 'wx', mode: 0o600 });
  try {
    const tx = await provider.broadcastTransaction(raw);
    record.state = 'pending';
    await writeFile(out, json(record), { mode: 0o600 });
    const receipt = await tx.wait(1, 120000);
    if (!receipt || receipt.status !== 1 || receipt.contractAddress !== fresh.tokenAddress) fail('Deployment receipt did not match the expected contract.');
    record.blockNumber = receipt.blockNumber;
    record.deployed = (await inspectDeployment(provider, record, build, { initial: true })).state;
    record.state = 'verified';
    await writeFile(out, json(record), { mode: 0o600 });
    return record;
  } catch (error) {
    record.state = 'needs-verification';
    await writeFile(out, json(record), { mode: 0o600 });
    throw new InputError('Deployment requires verification. Its transaction hash is saved in the output record; verify that record before sending another deployment.');
  }
}

export async function purchaseQuote(provider, record, build, eth, slippageBps = 50) {
  if (typeof eth !== 'string' || !/^(0|[1-9][0-9]*)(\.[0-9]{1,18})?$/.test(eth)) fail('ETH must be a decimal amount with at most 18 decimal places.');
  if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps > 500) fail('Slippage must be between 0 and 500 basis points.');
  const { sale, state } = await inspectDeployment(provider, record, build);
  if (state.salePaused || state.saleClosed || state.issuancePaused || !state.saleCanMint) fail('The sale is not accepting purchases.');
  const value = parseEther(eth);
  if (value <= 0n) fail('ETH payment must be positive.');
  const [amount, price] = await sale.quote(value);
  const minimum = amount * BigInt(10000 - slippageBps) / 10000n;
  if (minimum === 0n) fail('Payment is too small.');
  const deadline = (await provider.getBlock('latest')).timestamp + 600;
  return {
    expectedRch: formatUnits(amount, 18), minimumRch: formatUnits(minimum, 18), ethUsd: formatUnits(price, 8), deadline,
    transaction: { chainId: record.plan.config.chainId, to: state.sale, value: `0x${value.toString(16)}`, data: sale.interface.encodeFunctionData('buy', [minimum, deadline]) },
  };
}
