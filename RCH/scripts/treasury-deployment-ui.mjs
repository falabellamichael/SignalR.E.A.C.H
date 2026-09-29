import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { resolve, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Contract, ContractFactory, JsonRpcProvider, getAddress, getCreateAddress, keccak256, formatEther, parseEther, ZeroAddress } from 'ethers';
import { compile, root } from './compile.mjs';
import { validateRpcUrl } from './workflow.mjs';

export const DEPLOYMENT = Object.freeze({ chainId: 1,
  token: '0x6Cfb2531696f99Cd4511F281aBECe4b6a67c3792',
  treasury: '0x5b7a910cDF232543aCB7653D71d6B92f01d342C7',
  owner: '0xDa68602c9d65337C75BF0593972d9731895592e3',
  // Credit bounds now live IN the contract, so every quote is bounded on-chain and not only by
  // the service. These mirror the pilot's intended $0.01 floor and $1 ceiling in micro-dollars;
  // raising them later is a deliberate, visible redeployment.
  minCreditUsdMicros: 10_000n,
  maxCreditUsdMicros: 1_000_000n });
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
const json = value => JSON.stringify(value, (_, v) => typeof v === 'bigint' ? v.toString() : v, 2);
const txHash = value => typeof value === 'string' && /^0x[0-9a-f]{64}$/i.test(value);
const batchId = value => typeof value === 'string' && value.length > 0 && value.length <= 8194;

export function activationWalletMode(code) {
  if (code === '0x') return 'eoa';
  if (code.toLowerCase() === '0xef010063c0c19a282a1b52b07dd5a65b58948a07dae32b') return 'eip7702';
  throw new Error('Account 1 has an unsupported contract or delegation code. No activation transaction was prepared.');
}

export function smartActivationPlan({ contractAddress, data, estimatedGas, maxFeePerGas, balance }) {
  if (typeof estimatedGas !== 'bigint' || estimatedGas <= 0n || typeof maxFeePerGas !== 'bigint' || maxFeePerGas <= 0n
      || typeof balance !== 'bigint' || balance < 0n) throw new Error('RPC did not return a usable activation estimate.');
  return { mode: 'wallet_sendCalls', from: DEPLOYMENT.owner, chainId: '0x1',
    calls: [{ to: contractAddress, data, value: '0x0' }], networkFee: { kind: 'smart-account-estimate',
      directCallEstimateEth: formatEther(estimatedGas * maxFeePerGas), balanceEth: formatEther(balance), quotedAt: new Date().toISOString() } };
}

export function activationReceiptMatches(receipt, canonicalBlock, contractAddress, contractInterface) {
  if (receipt?.status !== 1 || !same(receipt.blockHash, canonicalBlock?.hash)) return false;
  return receipt.logs.some(log => {
    if (!same(log.address, contractAddress)) return false;
    try {
      const event = contractInterface.parseLog(log);
      return event?.name === 'Unpaused' && same(event.args.account, DEPLOYMENT.owner);
    } catch { return false; }
  });
}

export function networkFeePlan({ estimatedGas, maxFeePerGas, maxPriorityFeePerGas, baseFeePerGas, balance, value = 0n, maxCostWei }) {
  for (const [name, amount] of Object.entries({ estimatedGas, maxFeePerGas, maxPriorityFeePerGas, baseFeePerGas, balance, value })) {
    if (typeof amount !== 'bigint' || amount < 0n) throw new Error(`RPC returned an invalid ${name}. Refresh the fee estimate.`);
  }
  if (estimatedGas === 0n || maxFeePerGas === 0n || maxPriorityFeePerGas > maxFeePerGas
      || maxFeePerGas < baseFeePerGas + maxPriorityFeePerGas) throw new Error('RPC returned an unusable EIP-1559 fee estimate. Refresh before reviewing.');
  if (maxCostWei !== undefined && (typeof maxCostWei !== 'bigint' || maxCostWei <= 0n)) throw new Error('Network fee cap must be a positive ETH amount.');
  const gas = (estimatedGas * 120n + 99n) / 100n;
  const maximumCost = gas * maxFeePerGas;
  if (maxCostWei !== undefined && maximumCost > maxCostWei) throw new Error(`Maximum network fee ${formatEther(maximumCost)} ETH exceeds the configured fee cap ${formatEther(maxCostWei)} ETH.`);
  if (balance < value + maximumCost) throw new Error(`Account 1 needs at most ${formatEther(value + maximumCost)} ETH for this transaction, but its pending balance is ${formatEther(balance)} ETH. No wallet request was sent.`);
  const hex = amount => `0x${amount.toString(16)}`;
  return { transaction: { type: '0x2', gas: hex(gas), maxFeePerGas: hex(maxFeePerGas), maxPriorityFeePerGas: hex(maxPriorityFeePerGas) },
    networkFee: { maximumEth: formatEther(maximumCost), maximumWei: maximumCost.toString(),
      gasLimit: gas.toString(), maxFeePerGasWei: maxFeePerGas.toString(), maxPriorityFeePerGasWei: maxPriorityFeePerGas.toString(),
      balanceEth: formatEther(balance), capEth: maxCostWei === undefined ? null : formatEther(maxCostWei), quotedAt: new Date().toISOString() } };
}

export function sameRuntime(actual, artifact) {
  let expected = artifact.deployedBytecode.slice(2).toLowerCase();
  let received = actual.slice(2).toLowerCase();
  if (!received || received.length !== expected.length) return false;
  for (const refs of Object.values(artifact.immutableReferences || {})) {
    for (const { start, length } of refs) {
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(length) || start < 0 || length < 1 || (start + length) * 2 > expected.length) return false;
      const lo = start * 2, hi = lo + length * 2, zeros = '0'.repeat(length * 2);
      expected = expected.slice(0, lo) + zeros + expected.slice(hi);
      received = received.slice(0, lo) + zeros + received.slice(hi);
    }
  }
  return expected === received;
}

export function readinessMatches(ready, address, quoteSigner, now = Date.now()) {
  const age = now - Date.parse(ready?.checkedAt);
  return ready?.backendReady === true && ready.chainId === 1 && same(ready.contractAddress, address)
    && same(ready.token, DEPLOYMENT.token) && same(ready.treasury, DEPLOYMENT.treasury)
    && same(ready.quoteSigner, quoteSigner) && Number.isFinite(age) && age >= 0 && age <= 3_600_000;
}

export function allowedRequest(req, origin, prefix) {
  if (req.headers.host !== new URL(origin).host || !req.url?.startsWith(prefix)
      || !['127.0.0.1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress)
      || req.headers.forwarded || req.headers['x-forwarded-for'] || req.headers['x-forwarded-host']) return false;
  if (req.headers.origin && req.headers.origin !== origin) return false;
  if (req.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(req.headers['sec-fetch-site'])) return false;
  if (req.method === 'POST' && (req.headers.origin !== origin
      || req.headers['content-type'] !== 'application/json')) return false;
  return ['GET', 'POST'].includes(req.method);
}

export async function startTreasuryDeployment({ quoteSigner, rpcUrl, readinessFile, port = 0, maxCostWei }) {
  quoteSigner = getAddress(quoteSigner);
  if (quoteSigner === ZeroAddress) throw new Error('Supply the quote signer PUBLIC address.');
  if (readinessFile && !isAbsolute(readinessFile)) throw new Error('Readiness file must use an absolute host path.');
  const provider = new JsonRpcProvider(validateRpcUrl(rpcUrl, 1));
  const build = await compile();
  const artifact = JSON.parse(await readFile(resolve(root, 'artifacts/ReachTreasuryRedemption.json'), 'utf8'));
  const buildInfo = JSON.parse(await readFile(resolve(root, 'artifacts/build-info.json'), 'utf8'));
  if (buildInfo.sourceHash !== build.sourceHash || artifact.bytecode !== build.artifacts.ReachTreasuryRedemption.bytecode
      || artifact.deployedBytecode !== build.artifacts.ReachTreasuryRedemption.deployedBytecode
      || json(artifact.immutableReferences) !== json(build.artifacts.ReachTreasuryRedemption.immutableReferences)) {
    throw new Error('Compiled treasury artifact is stale. Run npm run compile in RCH.');
  }
  if ((await provider.getNetwork()).chainId !== 1n) throw new Error('RPC must be Ethereum mainnet.');
  const tokenRecord = JSON.parse(await readFile(resolve(root, 'terminal/mainnet.json'), 'utf8'));
  if (keccak256(await provider.getCode(DEPLOYMENT.token)) !== tokenRecord.tokenCodeHash) throw new Error('RCH token code does not match the recorded deployment.');
  const factory = new ContractFactory(artifact.abi, artifact.bytecode);
  const { data } = await factory.getDeployTransaction(DEPLOYMENT.owner, DEPLOYMENT.token, DEPLOYMENT.treasury,
    quoteSigner, DEPLOYMENT.minCreditUsdMicros, DEPLOYMENT.maxCreditUsdMicros);
  const recordPath = resolve(root, 'deployments/mainnet-treasury-redemption.json');
  let record;
  try { record = JSON.parse(await readFile(recordPath, 'utf8')); }
  catch (e) { if (e.code !== 'ENOENT') throw e; }
  if (record && (record.sourceHash !== build.sourceHash || !same(record.quoteSigner, quoteSigner)
      || record.deploymentDataHash !== keccak256(data))) throw new Error('Saved deployment record belongs to another build or signer. Inspect it before continuing.');
  let writing = false;
  async function save(next, first = false) {
    await mkdir(resolve(root, 'deployments'), { recursive: true });
    await writeFile(recordPath, `${json(next)}\n`, { mode: 0o600, flag: first ? 'wx' : 'w' });
    record = next;
  }
  async function inspect(address) {
    const code = await provider.getCode(address);
    if (!sameRuntime(code, artifact)) throw new Error('Deployment runtime differs from compiled treasury contract.');
    const c = new Contract(address, artifact.abi, provider);
    // Verify the bounds too, not just identity: a deployment with looser bounds than reviewed
    // would still pass an identity-only check while granting more credit than intended.
    const [token, treasury, signer, owner, paused, minCredit, maxCredit] = await Promise.all([
      c.token(), c.treasury(), c.quoteSigner(), c.owner(), c.paused(),
      c.minCreditUsdMicros(), c.maxCreditUsdMicros(),
    ]);
    if (!same(token, DEPLOYMENT.token) || !same(treasury, DEPLOYMENT.treasury)
      || !same(signer, quoteSigner) || !same(owner, DEPLOYMENT.owner)) throw new Error('Deployment immutable values or owner differ from the reviewed configuration.');
    if (minCredit !== DEPLOYMENT.minCreditUsdMicros || maxCredit !== DEPLOYMENT.maxCreditUsdMicros) {
      throw new Error('Deployment credit bounds differ from the reviewed configuration.');
    }
    return { contractAddress: address, token, treasury, quoteSigner: signer, owner, paused,
      minCreditUsdMicros: minCredit.toString(), maxCreditUsdMicros: maxCredit.toString(),
      runtimeCodeHash: keccak256(code) };
  }
  async function ready(address) {
    if (!readinessFile || !address) return false;
    try { return readinessMatches(JSON.parse(await readFile(readinessFile, 'utf8')), address, quoteSigner); }
    catch { return false; }
  }
  async function verifyDeployment(hash) {
    const [tx, receipt] = await Promise.all([provider.getTransaction(hash), provider.getTransactionReceipt(hash)]);
    if (!tx) throw new Error('Transaction is not visible to the RPC yet. Keep the hash and check again.');
    if (!same(tx.from, DEPLOYMENT.owner) || tx.to !== null || tx.chainId !== 1n || tx.value !== 0n || tx.data !== data) {
      throw new Error('Transaction does not match the reviewed mainnet treasury deployment.');
    }
    const address = getCreateAddress({ from: tx.from, nonce: tx.nonce });
    const next = { schema: 'rch-treasury-deployment-v1', ...DEPLOYMENT, quoteSigner,
      compiler: build.compiler, sourceHash: build.sourceHash, deploymentDataHash: keccak256(data),
      transactionHash: hash, contractAddress: address, status: 'pending' };
    if (receipt) {
      if (receipt.status !== 1 || !same(receipt.contractAddress, address)) throw new Error('Deployment transaction failed or its contract address differs.');
      next.state = await inspect(address);
      next.status = 'verified'; next.blockNumber = receipt.blockNumber; next.blockHash = receipt.blockHash;
      next.verifiedAt = new Date().toISOString();
      next.artifact = artifact;
    }
    return next;
  }
  async function state() {
    let deployed;
    if (record) {
      const verified = await verifyDeployment(record.transactionHash);
      if (record.status !== 'verified' && verified.status === 'verified') await save(verified);
      deployed = verified.state;
    }
    return { ...DEPLOYMENT, quoteSigner, sourceHash: build.sourceHash, compiler: build.compiler,
      deployment: deployed || null, transactionHash: record?.transactionHash || null,
      activation: record?.activation || null, activationBatch: record?.activationBatch || null,
      deploymentPending: !!record && !deployed, backendReady: await ready(deployed?.contractAddress),
      balanceEth: formatEther(await provider.getBalance(DEPLOYMENT.owner)) };
  }
  async function deploymentPlan() {
    if (record) throw new Error('A deployment transaction is already recorded. Check its receipt instead of deploying again.');
    const plan = await transactionPlan({ from: DEPLOYMENT.owner, data, value: 0n });
    const nonce = Number(BigInt(plan.transaction.nonce));
    return { ...await state(), predictedAddress: getCreateAddress({ from: DEPLOYMENT.owner, nonce }),
      ...plan };
  }
  async function transactionPlan(transaction) {
    const [nonce, estimatedGas, feeData, block, balance] = await Promise.all([
      provider.getTransactionCount(DEPLOYMENT.owner, 'pending'), provider.estimateGas(transaction),
      provider.getFeeData(), provider.getBlock('latest'), provider.getBalance(DEPLOYMENT.owner, 'pending'),
    ]);
    const fees = networkFeePlan({ estimatedGas, maxFeePerGas: feeData.maxFeePerGas,
      maxPriorityFeePerGas: feeData.maxPriorityFeePerGas, baseFeePerGas: block?.baseFeePerGas, balance, maxCostWei });
    return { networkFee: fees.networkFee, transaction: { ...transaction, value: '0x0', chainId: '0x1',
      nonce: `0x${nonce.toString(16)}`, ...fees.transaction } };
  }
  async function activationPlan(current) {
    const transaction = { from: DEPLOYMENT.owner, to: current.deployment.contractAddress,
      value: 0n, data: factory.interface.encodeFunctionData('unpause') };
    if (activationWalletMode(await provider.getCode(DEPLOYMENT.owner)) === 'eoa') return transactionPlan(transaction);
    const [estimatedGas, feeData, balance] = await Promise.all([provider.estimateGas(transaction),
      provider.getFeeData(), provider.getBalance(DEPLOYMENT.owner, 'pending')]);
    // A delegated wallet may wrap this call. Its wrapper gas and nonce belong to the wallet.
    return smartActivationPlan({ contractAddress: transaction.to, data: transaction.data,
      estimatedGas, maxFeePerGas: feeData.maxFeePerGas, balance });
  }
  async function verifyActivation(hash, callsId) {
    if (!record || record.status !== 'verified') throw new Error('Verify the deployment before its activation.');
    const receipt = await provider.getTransactionReceipt(hash);
    if (!receipt) return { status: 'pending', transactionHash: hash };
    const block = await provider.getBlock(receipt.blockNumber);
    if (!same(receipt.blockHash, block?.hash)) throw new Error('Activation receipt is not in the current canonical chain.');
    if (receipt.status === 0) {
      const finalized = await provider.getBlock('finalized');
      if (!finalized || receipt.blockNumber > finalized.number) return { status: 'pending', transactionHash: hash };
      if (callsId && record.activationBatch?.batchId === callsId) {
        const failedHashes = [...new Set([...(record.activationBatch.failedHashes || []), hash])];
        const hashes = record.activationBatch.transactionHashes;
        await save({ ...record, activationBatch: { ...record.activationBatch, failedHashes,
          resolved: hashes.length > 0 && hashes.every(item => failedHashes.includes(item)) } });
      }
      return { status: 'failed', transactionHash: hash };
    }
    if (!activationReceiptMatches(receipt, block, record.contractAddress, factory.interface)) {
      throw new Error('This canonical receipt does not contain a successful treasury Unpaused event for Account 1.');
    }
    const onChain = await inspect(record.contractAddress);
    if (onChain.paused) throw new Error('The activation receipt exists, but the contract is currently paused.');
    const activation = { status: 'verified', transactionHash: hash, batchId: callsId || null,
      blockNumber: receipt.blockNumber, blockHash: receipt.blockHash, verifiedAt: new Date().toISOString() };
    await save({ ...record, activation, state: onChain });
    return activation;
  }
  const prefix = `/${randomBytes(24).toString('hex')}/`;
  let origin;
  const files = new Map([
    ['', ['tools/treasury-deployment.html', 'text/html']],
    ['treasury-deployment.js', ['tools/treasury-deployment.js', 'text/javascript']],
    ['ethers.js', ['node_modules/ethers/dist/ethers.umd.min.js', 'text/javascript']],
  ]);
  const server = createServer(async (req, res) => {
    const headers = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer',
      'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'" };
    const send = (code, body, type = 'application/json') => { res.writeHead(code, { ...headers, 'content-type': `${type}; charset=utf-8` }); res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : json(body)); };
    if (!allowedRequest(req, origin, prefix)) { send(403, { error: 'Local same-origin review only.' }); return; }
    const name = req.url.slice(prefix.length);
    try {
      if (req.method === 'GET') {
        if (name === 'state.json') { send(200, await state()); return; }
        if (name === 'plan.json') { send(200, await deploymentPlan()); return; }
        if (name === 'unpause.json') {
          const current = await state();
          if (!current.backendReady || !current.deployment?.paused) throw new Error('Backend readiness has not been confirmed for this paused deployment.');
          send(200, await activationPlan(current)); return;
        }
        const file = files.get(name);
        if (!file) { send(404, { error: 'Not found.' }); return; }
        send(200, await readFile(resolve(root, file[0])), file[1]); return;
      }
      if (!['record', 'activation-record', 'activation-batch'].includes(name)) { send(404, { error: 'Not found.' }); return; }
      if (writing) { send(409, { error: 'Receipt verification is already in progress.' }); return; }
      writing = true;
      try {
        let body = '';
        for await (const chunk of req) { body += chunk; if (Buffer.byteLength(body) > (name === 'record' ? 512 : 16384)) throw new Error('Receipt request is too large.'); }
        const request = JSON.parse(body);
        if (name === 'activation-batch') {
          if (!record || record.status !== 'verified' || !batchId(request.batchId) || ![100, 200, 400, 500, 600].includes(request.status)
              || !Array.isArray(request.transactionHashes) || request.transactionHashes.length > 8 || !request.transactionHashes.every(txHash)
              || Object.keys(request).some(k => !['batchId', 'status', 'transactionHashes'].includes(k))) throw new Error('Supply a wallet batch identifier, status, and up to eight receipt hashes.');
          // Wallet-reported status is recovery metadata, never evidence of activation.
          const previous = record.activationBatch?.batchId === request.batchId ? record.activationBatch : {};
          await save({ ...record, activationBatch: { ...previous, ...request,
            resolved: previous.resolved === true || (request.status === 400 && request.transactionHashes.length === 0), updatedAt: new Date().toISOString() } });
          send(200, { saved: true }); return;
        }
        if (name === 'activation-record') {
          if (!txHash(request.transactionHash) || (request.batchId !== undefined && !batchId(request.batchId))
              || Object.keys(request).some(k => !['transactionHash', 'batchId'].includes(k))) throw new Error('Supply an activation transaction hash and optional wallet batch identifier.');
          send(200, await verifyActivation(request.transactionHash, request.batchId)); return;
        }
        if (!txHash(request.transactionHash) || Object.keys(request).some(k => k !== 'transactionHash')) throw new Error('Supply only the deployment transaction hash.');
        if (record && record.transactionHash !== request.transactionHash) throw new Error('A different deployment transaction is already recorded.');
        const verified = await verifyDeployment(request.transactionHash);
        await save({ ...record, ...verified }, !record);
        send(200, { saved: true, status: verified.status, contractAddress: verified.contractAddress });
      } finally { writing = false; }
    } catch (error) { send(409, { error: error.shortMessage || error.message || 'Verification failed.' }); }
  });
  server.requestTimeout = 15000; server.headersTimeout = 10000;
  await new Promise((accept, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', accept); });
  origin = `http://127.0.0.1:${server.address().port}`;
  return { server, provider, url: `${origin}${prefix}`, recordPath };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), options = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!['--quote-signer', '--readiness-file', '--port', '--max-network-fee-eth'].includes(args[i]) || !args[i + 1]) throw new Error('Use --quote-signer PUBLIC_ADDRESS [--readiness-file ABSOLUTE_PATH] [--port NUMBER] [--max-network-fee-eth ETH].');
    options[args[i]] = args[i + 1];
  }
  const port = options['--port'] === undefined ? 0 : Number(options['--port']);
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) throw new Error('Invalid port.');
  const maxCostWei = options['--max-network-fee-eth'] === undefined ? undefined : parseEther(options['--max-network-fee-eth']);
  if (maxCostWei !== undefined && maxCostWei <= 0n) throw new Error('Network fee cap must be a positive ETH amount.');
  const app = await startTreasuryDeployment({ quoteSigner: options['--quote-signer'], readinessFile: options['--readiness-file'],
    rpcUrl: process.env.RCH_RPC_URL || 'https://ethereum-rpc.publicnode.com', port, maxCostWei });
  console.log(`RCH treasury deployment review: ${app.url}`);
  console.log(`Deployment record: ${app.recordPath}`);
  process.on('SIGINT', () => { app.server.close(); app.provider.destroy(); });
}
