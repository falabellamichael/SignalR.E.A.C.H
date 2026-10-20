import { createHardhatRuntimeEnvironment } from 'hardhat/hre';
import { BrowserProvider, HDNodeWallet, Mnemonic, Contract, ContractFactory, getAddress } from 'ethers';
import { compile } from '../../scripts/compile.mjs';

export const build = await compile({ includeTests: true });
export const price = 264964000000n;
export const floor = 100n * 10n ** 8n;
export const ceiling = 100000n * 10n ** 8n;
// USD price per whole RCH in 8 decimals for the test sale: $1.38, matching the live market
// price. Well above the $0.01 (1_000_000) the contract used to hardcode, so a fixture that
// accidentally keeps the old price would fail rather than pass.
export const saleUsdPriceE8 = 138_000_000n;
export const send = async (pending) => (await pending).wait();

// In-process Hardhat Network (EDR) chain: chainId 1337, shanghai, 6 funded accounts from the
// standard Hardhat test mnemonic. getInitialAccounts() mirrors the old ganache helper shape.
const mnemonic = 'test test test test test test test test test test test junk';
const keys = Array.from({ length: 6 }, (_, i) => HDNodeWallet.fromMnemonic(Mnemonic.fromPhrase(mnemonic), `m/44'/60'/0'/0/${i}`));
async function hardhatProvider() {
  const hre = await createHardhatRuntimeEnvironment({ networks: { rch: { type: 'edr-simulated', chainId: 1337, hardfork: 'shanghai',
    accounts: { mnemonic, count: 6 } } } });
  const connection = await hre.network.connect({ network: 'rch' });
  const rpc = connection.provider;
  rpc.getInitialAccounts = () => Object.fromEntries(keys.map((k) => [k.address.toLowerCase(), { secretKey: k.privateKey }]));
  rpc.disconnect = () => connection.close();
  return rpc;
}

export async function chain(t, { payerIsAdminAndBuyer = false, treasuryAddress } = {}) {
  const rpc = await hardhatProvider();
  const provider = new BrowserProvider(rpc, undefined, { cacheTimeout: -1 });
  const signers = await Promise.all([0, 1, 2, 3, 4, 5].map((i) => provider.getSigner(i)));
  const [deployer, adminSigner, buyerSigner, rewardMinter, treasury, other] = signers;
  const admin = payerIsAdminAndBuyer ? deployer : adminSigner;
  const buyer = payerIsAdminAndBuyer ? deployer : buyerSigner;
  const treasuryTarget = treasuryAddress ? getAddress(treasuryAddress) : await treasury.getAddress();
  const deploy = async (name, args = [], signer = deployer) => {
    const artifact = build.artifacts[name];
    const contract = await new ContractFactory(artifact.abi, artifact.bytecode, signer).deploy(...args);
    await contract.waitForDeployment();
    return contract;
  };
  const now = async () => Number((await provider.getBlock('latest')).timestamp);
  const feed = await deploy('MockEthUsdFeed', [8, price, await now()]);
  const token = await deploy('ReachCreditsLaunch', [await admin.getAddress(), treasuryTarget, await feed.getAddress(), saleUsdPriceE8, 3600, floor, ceiling]);
  const sale = new Contract(await token.initialSale(), build.artifacts.ReachCreditsSale.abi, admin);
  const cleanup = async () => { provider.destroy(); await rpc.disconnect(); };
  if (t) t.after(cleanup);
  return { rpc, provider, signers, deployer, admin, buyer, rewardMinter, treasury, treasuryTarget, other, deploy, now, feed, token, sale, cleanup };
}
