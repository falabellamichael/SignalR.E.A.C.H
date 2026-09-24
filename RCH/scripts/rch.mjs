import { parseArgs } from 'node:util';
import { writeFile } from 'node:fs/promises';
import { JsonRpcProvider, Wallet } from 'ethers';
import { createWallet, walletInfo, checkWallet, unlockWallet, changeWalletPassword, verifyWalletBackup, importWalletBackup, WalletError } from './wallet.mjs';
import { choosePassword, hiddenPassword } from './wallet-password.mjs';
import { compile, writeBuild } from './compile.mjs';
import { InputError, readJson, json, configFrom, validateRpcUrl, prepare, broadcast, inspectDeployment, purchaseQuote } from './workflow.mjs';

const help = `RCH wallet, deployment and quote tools (no Docker)
  npm run rch -- wallet-create [--wallet primary]
  npm run rch -- wallet-info [--wallet primary]
  npm run rch -- wallet-check [--wallet primary]
  npm run rch -- wallet-password [--wallet primary] [--out /path/to/backup.json]
  npm run rch -- wallet-verify-backup --file /path/to/backup.json [--address 0x...]
  npm run rch -- wallet-import --file /path/to/backup.json [--wallet primary]
  npm run rch -- prepare --config config.json --out plan.json
  npm run rch -- deploy --plan plan.json --out deployment.json --broadcast --confirm-chain 11155111 [--wallet primary]
  npm run rch -- verify --manifest deployment.json
  npm run rch -- quote --manifest deployment.json --eth 0.004 [--slippage-bps 50]

Wallet commands are offline and never send transactions. Local storage uses macOS Keychain.
Password entry requires a real Terminal; wallet-verify-backup needs only the file and password.
Set RCH_RPC_URL for chain commands. deploy --wallet unlocks the named local wallet;
without --wallet, only deploy --broadcast reads RCH_DEPLOYER_KEY.
prepare produces unsigned deployment data and compiler/source evidence.
deploy requires a fresh plan, a matching signer and chain, and a fee budget.
quote produces unsigned purchase data valid for ten minutes. Gas is additional.
`;
let provider;
try {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    help: { type: 'boolean' }, file: { type: 'string' }, address: { type: 'string' }, wallet: { type: 'string' }, config: { type: 'string' }, out: { type: 'string' },
    plan: { type: 'string' }, manifest: { type: 'string' }, eth: { type: 'string' },
    broadcast: { type: 'boolean' }, 'confirm-chain': { type: 'string' }, 'slippage-bps': { type: 'string' },
  } });
  const command = positionals[0];
  if (values.help || !command) { process.stdout.write(help); }
  else if (['wallet-password', 'wallet-verify-backup', 'wallet-import'].includes(command)) {
    const allowed = command === 'wallet-password' ? ['wallet', 'out'] : command === 'wallet-import' ? ['wallet', 'file'] : ['file', 'address'];
    if (positionals.length !== 1 || Object.keys(values).some((key) => !allowed.includes(key))) throw new InputError('Invalid wallet options. Use --help. Passwords must be entered at the hidden Terminal prompt.');
    if (command !== 'wallet-password' && !values.file) throw new InputError('A backup --file is required.');
    const name = values.wallet ?? 'primary';
    if (command === 'wallet-password') {
      const info = await walletInfo(name);
      process.stderr.write(`Changing the encrypted file password for ${info.address}. Your wallet address stays the same.\n`);
    }
    const password = command === 'wallet-password' ? await choosePassword() : await hiddenPassword('Backup file password (typing is hidden): ');
    try {
      const result = command === 'wallet-password' ? await changeWalletPassword(name, password, { out: values.out })
        : command === 'wallet-import' ? await importWalletBackup(name, values.file, password)
        : await verifyWalletBackup(values.file, password, values.address);
      process.stdout.write(json(result));
    } finally { password.fill(0); }
  }
  else if (['wallet-create', 'wallet-info', 'wallet-check'].includes(command)) {
    if (positionals.length !== 1 || Object.keys(values).some((key) => key !== 'wallet')) throw new InputError('Wallet commands accept only --wallet with a local wallet name.');
    const operation = { 'wallet-create': createWallet, 'wallet-info': walletInfo, 'wallet-check': checkWallet }[command];
    process.stdout.write(json(await operation(values.wallet ?? 'primary')));
  } else {
    if (values.wallet && command !== 'deploy') throw new InputError('--wallet is only used by wallet commands and deploy.');
    if (positionals.length !== 1 || !['prepare', 'deploy', 'verify', 'quote'].includes(command)) throw new InputError('Unknown command. Use --help.');
    if (command === 'deploy' && (!values.broadcast || !/^[0-9]+$/.test(values['confirm-chain'] || ''))) throw new InputError('Deployment requires --broadcast and --confirm-chain with the intended chain ID.');
    let record, config;
    if (command === 'prepare') {
      if (!values.config || !values.out) throw new InputError('prepare needs --config and a new --out path.');
      config = configFrom(await readJson(values.config));
    } else {
      const path = command === 'deploy' ? values.plan : values.manifest;
      if (!path) throw new InputError(`${command} needs ${command === 'deploy' ? '--plan' : '--manifest'}.`);
      record = await readJson(path);
      config = configFrom((record.plan ?? record).config);
    }
    if (command === 'deploy' && !values.out) throw new InputError('deploy needs a new --out path for the transaction record.');
    provider = new JsonRpcProvider(validateRpcUrl(process.env.RCH_RPC_URL, config.chainId));
    const build = await compile();
    if (command === 'prepare') {
      const plan = await prepare(provider, config, build);
      await writeBuild(build);
      await writeFile(values.out, json(plan), { flag: 'wx', mode: 0o600 });
      process.stdout.write(json({ plan: values.out, chainId: config.chainId, token: plan.tokenAddress, sale: plan.saleAddress, maxCostEth: plan.maxCostEth, sourceHash: plan.sourceHash, saleStartsPaused: true }));
    } else if (command === 'deploy') {
      if (values.wallet && process.env.RCH_DEPLOYER_KEY) throw new InputError('Choose --wallet or RCH_DEPLOYER_KEY, not both.');
      if (!values.wallet && !/^0x[0-9a-fA-F]{64}$/.test(process.env.RCH_DEPLOYER_KEY || '')) throw new InputError('Use --wallet with a local wallet name, or set RCH_DEPLOYER_KEY locally; never put a private key in command arguments.');
      const signer = values.wallet ? await unlockWallet(values.wallet) : new Wallet(process.env.RCH_DEPLOYER_KEY);
      const deployed = await broadcast(provider, record, build, signer, values.out, Number(values['confirm-chain']));
      process.stdout.write(json({ manifest: values.out, txHash: deployed.txHash, ...deployed.deployed }));
    } else if (command === 'verify') {
      if (!record.txHash || !record.plan) throw new InputError('verify expects a deployment record with a transaction hash.');
      const receipt = await provider.getTransactionReceipt(record.txHash);
      if (!receipt) throw new InputError('Transaction is still pending or unknown. Do not redeploy until it is resolved.');
      if (receipt.status !== 1 || receipt.contractAddress !== record.plan.tokenAddress) throw new InputError('Deployment transaction failed or created an unexpected address.');
      process.stdout.write(json((await inspectDeployment(provider, record, build)).state));
    } else {
      if (!values.eth) throw new InputError('quote needs --eth.');
      process.stdout.write(json(await purchaseQuote(provider, record, build, values.eth, values['slippage-bps'] === undefined ? 50 : Number(values['slippage-bps']))));
    }
  }
} catch (error) {
  const message = (error instanceof InputError || error instanceof WalletError) ? error.message
    : error.code === 'EEXIST' ? 'Output file already exists. Preserve its transaction record and verify it before retrying.'
    : error.code === 'ENOENT' ? 'A required file was not found. Check the supplied paths.'
    : error.code?.startsWith('ERR_PARSE_ARGS') ? 'Invalid command options. Use --help.'
    : 'Build, RPC, or file operation failed. Check configuration and RPC availability; inspect any saved deployment record before retrying.';
  process.stderr.write(`RCH: ${message}\n`);
  process.exitCode = 1;
} finally { provider?.destroy(); }
