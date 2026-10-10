import { Contract, ContractFactory, getAddress, getCreateAddress, formatEther, keccak256, ZeroAddress } from 'ethers';
import { sha256 } from './compile.mjs';

const fail = (message) => { throw new Error(message); };

function sameRuntime(actual, artifact) {
  let expected = artifact.deployedBytecode.slice(2).toLowerCase();
  let received = actual.slice(2).toLowerCase();
  if (!received || expected.length !== received.length) return false;
  for (const refs of Object.values(artifact.immutableReferences)) {
    for (const { start, length } of refs) {
      const lo = start * 2, hi = lo + length * 2, zeros = '0'.repeat(length * 2);
      expected = expected.slice(0, lo) + zeros + expected.slice(hi);
      received = received.slice(0, lo) + zeros + received.slice(hi);
    }
  }
  return expected === received;
}

export async function prepareSaleReplacement(provider, deployment, treasuryInput, build, { allowTestChains = false } = {}) {
  const treasury = getAddress(treasuryInput);
  if (treasury === ZeroAddress) fail('Replacement treasury cannot be the zero address.');
  if ((await provider.getNetwork()).chainId !== BigInt(deployment.chainId)) fail('RPC chain ID does not match the deployment.');
  if (deployment.chainId !== 1 && !allowTestChains) fail('Sale replacement is restricted to Ethereum mainnet.');

  const [tokenCode, oldSaleCode] = await Promise.all([
    provider.getCode(deployment.token), provider.getCode(deployment.sale),
  ]);
  if (keccak256(tokenCode) !== deployment.tokenCodeHash || keccak256(oldSaleCode) !== deployment.saleCodeHash) {
    fail('Existing token or sale bytecode does not match the pinned mainnet deployment.');
  }

  const token = new Contract(deployment.token, deployment.tokenAbi, provider);
  const oldSale = new Contract(deployment.sale, deployment.saleAbi, provider);
  const [admin, initialSale, owner, oldTreasury, feed, maxOracleAge, minPrice, maxPrice, paused, closed,
    issuancePaused, role, balance] = await Promise.all([
    token.defaultAdmin(), token.initialSale(), oldSale.owner(), oldSale.treasury(), oldSale.ethUsdFeed(),
    oldSale.maxOracleAge(), oldSale.minEthUsdPriceE8(), oldSale.maxEthUsdPriceE8(), oldSale.paused(),
    oldSale.saleClosed(), token.issuancePaused(), token.hasRole(await token.SALE_MINTER_ROLE(), deployment.sale),
    provider.getBalance(deployment.account ?? deployment.treasury),
  ]);
  const payer = getAddress(deployment.account ?? admin);
  if (payer !== admin || owner !== admin) fail('The connected payer must own the sale and administer RCH.');
  if (initialSale !== deployment.sale) fail('The configured sale is already a replacement. Use the active-sale migration record.');
  if (treasury === getAddress(oldTreasury)) fail('Replacement treasury is already active.');
  if (closed || issuancePaused || !role) fail('The current sale is closed or cannot mint RCH.');
  await oldSale.quote(1n);
  const usdPriceE8PerRch = await currentSaleUsdPrice(oldSale);

  const nonce = await provider.getTransactionCount(payer, 'pending');
  const artifact = build.artifacts.ReachCreditsSale;
  const deployTx = await new ContractFactory(artifact.abi, artifact.bytecode).getDeployTransaction(
    deployment.token, feed, treasury, admin, usdPriceE8PerRch, maxOracleAge, minPrice, maxPrice,
  );
  const estimatedGas = await provider.estimateGas({ from: payer, data: deployTx.data, value: 0n });
  const gasLimit = (estimatedGas * 120n + 99n) / 100n;
  const fees = await provider.getFeeData();
  if (fees.maxFeePerGas == null || fees.maxPriorityFeePerGas == null) fail('RPC did not provide EIP-1559 fee data.');
  const maximumCost = gasLimit * fees.maxFeePerGas;
  if (balance < maximumCost) fail('The admin wallet cannot cover the estimated replacement-sale deployment fee.');

  const plan = {
    schema: 'rch-sale-replacement-plan-v1',
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
    chainId: deployment.chainId,
    sourceHash: build.sourceHash,
    compiler: build.compiler,
    dataHash: sha256(deployTx.data),
    oldSale: deployment.sale,
    oldSaleCodeHash: deployment.saleCodeHash,
    token: deployment.token,
    tokenCodeHash: deployment.tokenCodeHash,
    admin,
    treasury,
    feed,
    usdPriceE8PerRch: usdPriceE8PerRch.toString(),
    oracle: { maxAgeSeconds: maxOracleAge.toString(), minEthUsdE8: minPrice.toString(), maxEthUsdE8: maxPrice.toString() },
    expectedSale: getCreateAddress({ from: payer, nonce }),
    oldSaleState: { paused, closed, hasSaleMinterRole: role, tokenIssuancePaused: issuancePaused },
    deploymentFee: {
      gasEstimate: estimatedGas.toString(), gasLimit: gasLimit.toString(),
      maxFeePerGas: fees.maxFeePerGas.toString(), maxCostEth: formatEther(maximumCost),
      payerBalanceEth: formatEther(balance),
    },
    transaction: {
      from: payer, chainId: 1, nonce, type: 2, value: '0x0', data: deployTx.data,
      gasLimit: gasLimit.toString(), maxFeePerGas: fees.maxFeePerGas.toString(),
      maxPriorityFeePerGas: fees.maxPriorityFeePerGas.toString(),
    },
  };
  return plan;
}

export async function readReplacementState(provider, plan, build) {
  if ((await provider.getNetwork()).chainId !== BigInt(plan.chainId)) fail('RPC chain ID does not match the replacement plan.');
  const token = new Contract(plan.token, build.artifacts.ReachCreditsLaunch.abi, provider);
  const oldSale = new Contract(plan.oldSale, build.artifacts.ReachCreditsSale.abi, provider);
  const [tokenCode, oldSaleCode, admin, initialSale, oldOwner, oldTreasury, issuancePaused,
    oldPaused, oldClosed, oldRole, newCode] = await Promise.all([
    provider.getCode(plan.token), provider.getCode(plan.oldSale), token.defaultAdmin(), token.initialSale(),
    oldSale.owner(), oldSale.treasury(), token.issuancePaused(), oldSale.paused(), oldSale.saleClosed(),
    token.hasRole(await token.SALE_MINTER_ROLE(), plan.oldSale), provider.getCode(plan.expectedSale),
  ]);
  if (keccak256(tokenCode) !== plan.tokenCodeHash
    || keccak256(oldSaleCode) !== plan.oldSaleCodeHash) {
    fail('The current token or sale runtime is not the one reviewed for this migration.');
  }
  if (admin !== plan.admin || oldOwner !== plan.admin || oldTreasury === plan.treasury || initialSale !== plan.oldSale) {
    fail('Live admin, current sale, or treasury no longer matches the replacement plan.');
  }
  if (issuancePaused) fail('Token issuance is paused; stop the migration and review the token state.');

  const state = {
    token: plan.token, oldSale: plan.oldSale, newSale: plan.expectedSale,
    admin, oldTreasury, treasury: plan.treasury, oldPaused, oldClosed, oldRole, issuancePaused,
    deployed: newCode !== '0x',
  };
  if (state.deployed) {
    if (!sameRuntime(newCode, build.artifacts.ReachCreditsSale)) fail('Unexpected bytecode exists at the predicted replacement address.');
    const replacement = new Contract(plan.expectedSale, build.artifacts.ReachCreditsSale.abi, provider);
    const [rch, feed, treasury, owner, newPaused, newClosed, newRole, newPrice] = await Promise.all([
      replacement.rch(), replacement.ethUsdFeed(), replacement.treasury(), replacement.owner(),
      replacement.paused(), replacement.saleClosed(), token.hasRole(await token.SALE_MINTER_ROLE(), plan.expectedSale),
      replacement.usdPriceE8PerRch(),
    ]);
    if (rch !== plan.token || feed !== plan.feed || treasury !== plan.treasury || owner !== plan.admin
      || newPrice.toString() !== plan.usdPriceE8PerRch) {
      fail('Replacement contract settings do not match the reviewed treasury and RCH token.');
    }
    if (newClosed) fail('The replacement sale is closed and cannot be activated.');
    state.newPaused = newPaused;
    state.newClosed = newClosed;
    state.newRole = newRole;
  }
  state.complete = state.deployed && state.oldClosed && !state.oldRole && !state.newPaused && state.newRole;
  return state;
}

// The replacement keeps the live sale's USD price per RCH. The pinned mainnet
// sale predates the constructor argument and exposes it as the constant
// USD_PRICE_E8_PER_RCH; newer sales expose usdPriceE8PerRch.
async function currentSaleUsdPrice(sale) {
  const getter = ['usdPriceE8PerRch', 'USD_PRICE_E8_PER_RCH'].find(name => {
    try { return sale.interface.getFunction(name) !== null; } catch { return false; }
  });
  if (!getter) fail('The current sale does not expose its USD price per RCH.');
  const price = await sale[getter]();
  if (typeof price !== 'bigint' || price <= 0n) fail('The current sale reported an invalid USD price per RCH.');
  return price;
}

export async function resumeSaleReplacement(provider, deployment, plan, build, { admin, treasury }) {
  if (plan.schema !== 'rch-sale-replacement-plan-v1' || plan.chainId !== deployment.chainId
    || plan.sourceHash !== build.sourceHash || plan.token !== deployment.token
    || plan.tokenCodeHash !== deployment.tokenCodeHash || plan.admin !== getAddress(admin)
    || plan.treasury !== getAddress(treasury) || plan.transaction.from !== plan.admin
    || sha256(plan.transaction.data) !== plan.dataHash) {
    fail('Saved replacement plan does not match the reviewed token, accounts, or compiled source.');
  }
  const original = deployment.sale === plan.oldSale && deployment.saleCodeHash === plan.oldSaleCodeHash;
  const activated = deployment.sale === plan.expectedSale && deployment.initialSale === plan.oldSale
    && deployment.treasury === plan.treasury;
  if (!original && !activated) fail('Saved replacement plan does not match the active mainnet sale record.');
  const rebuilt = await new ContractFactory(build.artifacts.ReachCreditsSale.abi, build.artifacts.ReachCreditsSale.bytecode)
    .getDeployTransaction(plan.token, plan.feed, plan.treasury, plan.admin, BigInt(plan.usdPriceE8PerRch),
      BigInt(plan.oracle.maxAgeSeconds), BigInt(plan.oracle.minEthUsdE8), BigInt(plan.oracle.maxEthUsdE8));
  if (rebuilt.data !== plan.transaction.data
    || getCreateAddress({ from: plan.admin, nonce: plan.transaction.nonce }) !== plan.expectedSale) {
    fail('Saved replacement deployment data or predicted address does not match the reviewed plan.');
  }
  const state = await readReplacementState(provider, plan, build);
  if (!state.deployed) fail('Saved replacement has not deployed. Prepare a fresh deployment plan.');
  if (activated && keccak256(await provider.getCode(plan.expectedSale)) !== deployment.saleCodeHash) {
    fail('Active replacement bytecode does not match the pinned mainnet sale.');
  }
  return plan;
}

export function nextReplacementAction(state) {
  if (!state.deployed) return 'deploy';
  if (!state.oldPaused) return 'pause-old-sale';
  if (!state.newRole) return 'grant-new-sale-role';
  if (state.newPaused) return 'open-new-sale';
  if (state.oldRole) return 'revoke-old-sale-role';
  if (!state.oldClosed) return 'close-old-sale';
  return 'complete';
}

export function sameDeployedSaleRuntime(actual, artifact) { return sameRuntime(actual, artifact); }
