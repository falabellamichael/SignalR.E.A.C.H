import ganache from 'ganache';
import { BrowserProvider, Contract, ContractFactory, getAddress } from 'ethers';
import { compile } from '../../scripts/compile.mjs';

export const build = await compile({ includeTests: true });
export const price = 264964000000n;
export const floor = 100n * 10n ** 8n;
export const ceiling = 100000n * 10n ** 8n;
export const send = async (pending) => (await pending).wait();

export async function chain(t, { payerIsAdminAndBuyer = false, treasuryAddress } = {}) {
  const rpc = ganache.provider({ logging: { quiet: true }, chain: { chainId: 1337, hardfork: 'shanghai' }, wallet: { totalAccounts: 6 } });
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
  const token = await deploy('ReachCreditsLaunch', [await admin.getAddress(), treasuryTarget, await feed.getAddress(), 3600, floor, ceiling]);
  const sale = new Contract(await token.initialSale(), build.artifacts.ReachCreditsSale.abi, admin);
  const cleanup = async () => { provider.destroy(); await rpc.disconnect(); };
  if (t) t.after(cleanup);
  return { rpc, provider, signers, deployer, admin, buyer, rewardMinter, treasury, treasuryTarget, other, deploy, now, feed, token, sale, cleanup };
}
