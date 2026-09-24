#!/usr/bin/env node
/**
 * SimpleDAPP's Node frontend for the agreement contract in index.rsh.
 *
 * Modes:
 *   demo   Run Alice and Bob together with funded local Ganache accounts.
 *   alice  Deploy using REACH_ALICE_SECRET (or a named environment variable).
 *   bob    Attach using REACH_BOB_SECRET and a saved contract-info file.
 *
 * From Reach Studio, pass frontend arguments after `--`, for example:
 *   run index.rsh -- demo --proposal 42 --tolerance 5 --response 45
 *   run index.rsh -- alice --proposal 42 --tolerance 5
 *   run index.rsh -- bob --response 45
 * Run `run index.rsh -- --help` for all options.
 */

import { createHash } from 'node:crypto';
import { access, readFile, stat, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectDir = dirname(fileURLToPath(import.meta.url));
const sourceFile = resolve(projectDir, 'index.rsh');
const backendFile = resolve(projectDir, 'build/index.main.mjs');
const schema = 'reach-simpledapp-agreement-v1';
const maxInput = 10_000;
const defaultInfoFile = resolve(projectDir, 'contract-info.json');

function help() {
  return `SimpleDAPP agreement frontend

Usage:
  node index.mjs [demo|alice|bob] [options]
  run index.rsh -- [demo|alice|bob] [options]    (Reach Studio, Native Reach)

Modes:
  demo   Create two funded test accounts and run both roles on local Ganache.
  alice  Deploy the contract, write its info file, and wait for Bob.
  bob    Read Alice's info file and attach to her contract.

Contract inputs (whole numbers from 0 to ${maxInput}):
  --proposal N          Alice's proposed value (default: 42)
  --tolerance N         Largest accepted difference (default: 5)
  --response N          Bob's response (default: 45)

Connection and account options:
  --rpc-url URL         Ethereum RPC endpoint (default: ETH_NODE_URI or local Ganache)
  --expect-chain-id N   Refuse a connection to another chain ID
  --test-balance N      Test currency per funded devnet account (default: 100)
  --devnet-test-account  Create a funded local account in alice/bob mode
  --account-env NAME    Read a private key from this environment variable
  --mnemonic-env NAME   Read a mnemonic from this environment variable instead
  --allow-live          Permit alice/bob on ETH-live (never enables demo)

Output and control:
  --info-file PATH      Contract info path (default for alice/bob: contract-info.json)
  --report-file PATH    Write a JSON session report; refuses to overwrite a file
  --timeout-seconds N   Exit if the run is still waiting after N seconds
  --skip-verification   Skip compiled-contract verification before Bob attaches
  --json                Emit newline-delimited JSON events instead of text
  --help                Print this help

Alice and Bob read REACH_ALICE_SECRET / REACH_BOB_SECRET by default. Secrets are
read from the environment and never printed or saved in the info/report files.
Start Ganache separately for ETH-devnet, then compile index.rsh before running.
`;
}

function wholeNumber(raw, label, max = maxInput) {
  if (!/^(0|[1-9][0-9]*)$/.test(String(raw))) {
    throw new Error(`${label} must be a whole number from 0 to ${max}.`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value > max) {
    throw new Error(`${label} must be a whole number from 0 to ${max}.`);
  }
  return value;
}

function parseArgs(argv) {
  const options = {
    mode: 'demo', proposal: 42, tolerance: 5, response: 45,
    testBalance: '100', rpcUrl: null, expectedChainId: null,
    accountEnv: null, mnemonicEnv: null, infoFile: null, reportFile: null,
    timeoutSeconds: null, allowLive: false, skipVerification: false,
    devnetTestAccount: false, json: false, help: false,
  };
  const values = new Map([
    ['--proposal', 'proposal'], ['--tolerance', 'tolerance'],
    ['--response', 'response'], ['--test-balance', 'testBalance'],
    ['--rpc-url', 'rpcUrl'], ['--expect-chain-id', 'expectedChainId'],
    ['--account-env', 'accountEnv'], ['--mnemonic-env', 'mnemonicEnv'],
    ['--info-file', 'infoFile'], ['--report-file', 'reportFile'],
    ['--timeout-seconds', 'timeoutSeconds'],
  ]);
  const flags = new Map([
    ['--allow-live', 'allowLive'], ['--skip-verification', 'skipVerification'],
    ['--devnet-test-account', 'devnetTestAccount'],
    ['--json', 'json'], ['--help', 'help'],
  ]);
  let modeSeen = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const split = arg.indexOf('=');
      const name = split < 0 ? arg : arg.slice(0, split);
      if (flags.has(name)) {
        if (split >= 0) throw new Error(`${name} does not take a value.`);
        options[flags.get(name)] = true;
      } else if (values.has(name)) {
        const value = split < 0 ? argv[++i] : arg.slice(split + 1);
        if (value === undefined || value === '' || value.startsWith('--')) {
          throw new Error(`${name} needs a value.`);
        }
        options[values.get(name)] = value;
      } else {
        throw new Error(`Unknown option: ${name}. Use --help for available options.`);
      }
    } else if (!modeSeen && ['demo', 'alice', 'bob'].includes(arg)) {
      options.mode = arg;
      modeSeen = true;
    } else {
      throw new Error(`Unknown mode or extra argument: ${arg}. Use --help.`);
    }
  }
  if (options.help) return options;

  options.proposal = wholeNumber(options.proposal, 'proposal');
  options.tolerance = wholeNumber(options.tolerance, 'tolerance');
  options.response = wholeNumber(options.response, 'response');
  if (!/^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,18})?$/.test(options.testBalance) || Number(options.testBalance) <= 0) {
    throw new Error('test-balance must be a positive decimal amount.');
  }
  if (options.expectedChainId !== null) {
    options.expectedChainId = wholeNumber(options.expectedChainId, 'expect-chain-id', 4_294_967_295);
  }
  if (options.timeoutSeconds !== null) {
    options.timeoutSeconds = wholeNumber(options.timeoutSeconds, 'timeout-seconds', 86_400);
    if (options.timeoutSeconds === 0) throw new Error('timeout-seconds must be at least 1.');
  }
  if (options.accountEnv && options.mnemonicEnv) {
    throw new Error('Choose either --account-env or --mnemonic-env.');
  }
  for (const [label, name] of [['account-env', options.accountEnv], ['mnemonic-env', options.mnemonicEnv]]) {
    if (name && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      throw new Error(`${label} must name an environment variable.`);
    }
  }
  if (options.mode === 'demo' && (options.accountEnv || options.mnemonicEnv || options.devnetTestAccount)) {
    throw new Error('demo creates local test accounts; account options apply to alice/bob modes.');
  }
  if (options.devnetTestAccount && (options.accountEnv || options.mnemonicEnv)) {
    throw new Error('--devnet-test-account cannot be combined with account secret options.');
  }
  if (options.rpcUrl) {
    let parsed;
    try { parsed = new URL(options.rpcUrl); } catch { /* handled below */ }
    if (!parsed || !['http:', 'https:'].includes(parsed.protocol)) {
      throw new Error('rpc-url must be an HTTP or HTTPS URL.');
    }
  }
  options.infoFile = options.infoFile ? resolve(options.infoFile)
    : options.mode === 'demo' ? null : defaultInfoFile;
  options.reportFile = options.reportFile ? resolve(options.reportFile) : null;
  if (options.infoFile && options.reportFile && options.infoFile === options.reportFile) {
    throw new Error('info-file and report-file must use different paths.');
  }
  return options;
}

function plain(value) {
  if (typeof value === 'bigint') return value.toString();
  if (value && typeof value === 'object') {
    if (value._isBigNumber) return value.toString();
    if (Array.isArray(value)) return value.map(plain);
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, plain(item)]));
  }
  return value;
}

function makeReporter(json) {
  const events = [];
  function event(type, details = {}) {
    const item = { at: new Date().toISOString(), type, ...plain(details) };
    events.push(item);
    if (json) {
      process.stdout.write(`${JSON.stringify(item)}\n`);
    } else {
      const fields = Object.entries(details).map(([key, value]) => `${key}=${JSON.stringify(plain(value))}`);
      process.stdout.write(`${item.at} ${type}${fields.length ? `  ${fields.join(' ')}` : ''}\n`);
    }
    return item;
  }
  return { event, events };
}

function rpcHost(uri) {
  try { return new URL(uri).host; } catch { return '(provider default)'; }
}

async function backendWithFingerprint() {
  let sourceStat;
  let backendStat;
  try {
    [sourceStat, backendStat] = await Promise.all([stat(sourceFile), stat(backendFile)]);
  } catch {
    throw new Error('Missing index.rsh or build/index.main.mjs. Run compile index.rsh first.');
  }
  if (backendStat.mtimeMs + 1000 < sourceStat.mtimeMs) {
    throw new Error('The Reach source is newer than its compiled backend. Run compile index.rsh again.');
  }
  const fingerprint = createHash('sha256').update(await readFile(backendFile)).digest('hex');
  const backend = await import('./build/index.main.mjs');
  if (typeof backend.Alice !== 'function' || typeof backend.Bob !== 'function') {
    throw new Error('The compiled backend needs Alice and Bob participants. Recompile index.rsh.');
  }
  return { backend, fingerprint };
}

async function writeJsonNew(file, value) {
  try {
    await writeFile(file, `${JSON.stringify(plain(value), null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (error.code === 'EEXIST') throw new Error(`${file} already exists. Choose a new path to preserve the previous run.`);
    throw error;
  }
}

async function ensureNewOutput(file) {
  if (!file) return;
  try {
    await stat(file);
    throw new Error(`${file} already exists. Choose a new path to preserve the previous run.`);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  await access(dirname(file), constants.W_OK);
}

async function readInfo(file, expected, fingerprint) {
  const fileStat = await stat(file);
  if (fileStat.size > 1_000_000) throw new Error('Contract info file is unexpectedly large.');
  const record = JSON.parse(await readFile(file, 'utf8'));
  if (record?.schema !== schema || record.contractInfo === undefined) {
    throw new Error('Contract info file is not a SimpleDAPP agreement record.');
  }
  if (record.connector !== expected.connector || record.chainId !== expected.chainId) {
    throw new Error(`Contract info targets ${record.connector} chain ${record.chainId}; connected to ${expected.connector} chain ${expected.chainId}.`);
  }
  if (record.backendSha256 !== fingerprint) {
    throw new Error('The local compiled backend differs from Alice\'s backend. Use matching source and recompile.');
  }
  return record;
}

function makeInteract(role, options, reporter, outcomes, stdlib) {
  const seeOutcome = (proposed, tolerance, response, difference, accepted) => {
    const outcome = {
      role,
      proposed: proposed.toString(),
      tolerance: tolerance.toString(),
      response: response.toString(),
      difference: difference.toString(),
      accepted: Boolean(accepted),
    };
    outcomes.push(outcome);
    reporter.event('outcome', outcome);
  };
  const common = { ...stdlib.hasRandom, seeOutcome };
  if (role === 'Alice') {
    return {
      ...common,
      getProposedValue: () => { reporter.event('input', { role, proposed: options.proposal }); return options.proposal; },
      getTolerance: () => { reporter.event('input', { role, tolerance: options.tolerance }); return options.tolerance; },
    };
  }
  return {
    ...common,
    getResponse: () => { reporter.event('input', { role, response: options.response }); return options.response; },
  };
}

async function accountForRole(stdlib, role, options, connector) {
  if (options.devnetTestAccount) {
    if (connector !== 'ETH-devnet') throw new Error('--devnet-test-account requires ETH-devnet.');
    const url = new URL(process.env.ETH_NODE_URI);
    if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
      throw new Error('--devnet-test-account requires a loopback Ganache RPC URL.');
    }
    return stdlib.newTestAccount(stdlib.parseCurrency(options.testBalance));
  }
  const name = options.accountEnv || options.mnemonicEnv || `REACH_${role.toUpperCase()}_SECRET`;
  const secret = process.env[name];
  if (!secret) throw new Error(`${role} needs ${name} in the environment, or --devnet-test-account on local Ganache. Private keys are never accepted as CLI arguments.`);
  return options.mnemonicEnv
    ? stdlib.newAccountFromMnemonic(secret)
    : stdlib.newAccountFromSecret(secret);
}

async function accountSummary(stdlib, role, account, reporter) {
  const address = stdlib.formatAddress(account);
  const balance = stdlib.formatCurrency(await stdlib.balanceOf(account), 6);
  reporter.event('account', { role, address, balance, unit: stdlib.standardUnit });
  return { role, address, balance, unit: stdlib.standardUnit };
}

function firstDeployment(ctc, aliceRun) {
  return Promise.race([
    ctc.getInfo(),
    aliceRun.then(
      () => { throw new Error('Alice finished before publishing contract info.'); },
      error => { throw new Error(`Alice backend failed before deployment: ${error.message}`); },
    ),
  ]);
}

async function main(options, reporter) {
  const connector = process.env.REACH_CONNECTOR_MODE || 'ETH-devnet';
  if (!['ETH-devnet', 'ETH-live'].includes(connector)) {
    throw new Error('This frontend currently supports ETH-devnet and ETH-live. Select Ethereum in Native Reach.');
  }
  if (options.mode === 'demo' && connector !== 'ETH-devnet') {
    throw new Error('demo funds new test accounts and is available only on ETH-devnet.');
  }
  if (connector === 'ETH-live' && !options.allowLive) {
    throw new Error('ETH-live sends real transactions. Pass --allow-live to run alice/bob there.');
  }
  if (options.rpcUrl) process.env.ETH_NODE_URI = options.rpcUrl;
  if (!process.env.ETH_NODE_URI && connector === 'ETH-devnet') {
    process.env.ETH_NODE_URI = 'http://127.0.0.1:8545';
  }
  process.env.REACH_CONNECTOR_MODE = connector;
  if (options.mode === 'demo') {
    const url = new URL(process.env.ETH_NODE_URI);
    if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
      throw new Error('demo requires a loopback Ganache RPC URL.');
    }
  }

  // The stdlib's faucet notice goes to stdout; keep --json machine-readable.
  if (options.json) process.env.REACH_NO_WARN = '1';
  const [{ loadStdlib }, { backend, fingerprint }] = await Promise.all([
    import('@reach-sh/stdlib'), backendWithFingerprint(),
  ]);
  const stdlib = loadStdlib(process.env);
  const provider = await stdlib.getProvider();
  const network = await provider.getNetwork();
  const chainId = Number(network.chainId);
  if (!Number.isSafeInteger(chainId)) throw new Error('The Ethereum provider returned an invalid chain ID.');
  if (options.expectedChainId !== null && chainId !== options.expectedChainId) {
    throw new Error(`Expected chain ID ${options.expectedChainId}, connected to ${chainId}.`);
  }
  if (options.mode === 'demo' && chainId !== 1337 && options.expectedChainId === null) {
    throw new Error(`demo expected local Ganache chain ID 1337, found ${chainId}. Use --expect-chain-id to accept another local devnet.`);
  }
  const networkInfo = { connector, chainId, rpcHost: rpcHost(process.env.ETH_NODE_URI), backendSha256: fingerprint };
  reporter.event('connected', { mode: options.mode, connector, chainId, rpcHost: networkInfo.rpcHost, backend: fingerprint.slice(0, 12) });
  const outcomes = [];
  let contractInfo;
  let accounts = [];

  if (options.mode === 'demo') {
    const balance = stdlib.parseCurrency(options.testBalance);
    const [alice, bob] = await stdlib.newTestAccounts(2, balance);
    accounts = [
      await accountSummary(stdlib, 'Alice', alice, reporter),
      await accountSummary(stdlib, 'Bob', bob, reporter),
    ];
    const aliceCtc = alice.contract(backend);
    const aliceRun = backend.Alice(aliceCtc, makeInteract('Alice', options, reporter, outcomes, stdlib));
    contractInfo = await firstDeployment(aliceCtc, aliceRun);
    reporter.event('deployed', { contractInfo });
    if (options.infoFile) {
      await writeJsonNew(options.infoFile, { schema, ...networkInfo, contractInfo, createdAt: new Date().toISOString() });
      reporter.event('info-written', { path: options.infoFile });
    }
    const bobCtc = bob.contract(backend, Promise.resolve(contractInfo));
    const bobRun = backend.Bob(bobCtc, makeInteract('Bob', options, reporter, outcomes, stdlib));
    await Promise.all([aliceRun, bobRun]);
  } else if (options.mode === 'alice') {
    const alice = await accountForRole(stdlib, 'Alice', options, connector);
    accounts = [await accountSummary(stdlib, 'Alice', alice, reporter)];
    const ctc = alice.contract(backend);
    const aliceRun = backend.Alice(ctc, makeInteract('Alice', options, reporter, outcomes, stdlib));
    contractInfo = await firstDeployment(ctc, aliceRun);
    await writeJsonNew(options.infoFile, { schema, ...networkInfo, contractInfo, createdAt: new Date().toISOString() });
    reporter.event('deployed', { contractInfo, infoFile: options.infoFile, waitingFor: 'Bob' });
    await aliceRun;
  } else {
    const record = await readInfo(options.infoFile, networkInfo, fingerprint);
    contractInfo = record.contractInfo;
    const bob = await accountForRole(stdlib, 'Bob', options, connector);
    accounts = [await accountSummary(stdlib, 'Bob', bob, reporter)];
    if (!options.skipVerification) {
      await stdlib.verifyContract(contractInfo, backend);
      reporter.event('verified', { contractInfo });
    }
    const ctc = bob.contract(backend, Promise.resolve(contractInfo));
    await backend.Bob(ctc, makeInteract('Bob', options, reporter, outcomes, stdlib));
  }

  if (outcomes.length !== (options.mode === 'demo' ? 2 : 1)) {
    throw new Error('The expected outcome callback did not run. Recompile index.rsh and confirm the backend matches this frontend.');
  }
  if (options.mode === 'demo' && JSON.stringify(outcomes[0], (key, value) => key === 'role' ? undefined : value)
      !== JSON.stringify(outcomes[1], (key, value) => key === 'role' ? undefined : value)) {
    throw new Error('Alice and Bob reported different outcomes.');
  }
  reporter.event('complete', { mode: options.mode, accepted: outcomes[0].accepted, contractInfo });
  for (const account of accounts) {
    const address = account.address;
    const balance = stdlib.formatCurrency(await stdlib.balanceOf(address), 6);
    reporter.event('final-balance', { role: account.role, address, balance, unit: stdlib.standardUnit });
  }
  return { schema, mode: options.mode, ...networkInfo, contractInfo, accounts, outcomes, completedAt: new Date().toISOString() };
}

let reporter;
let options;
let watchdog;
try {
  options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(help());
  } else {
    reporter = makeReporter(options.json);
    await Promise.all([
      ensureNewOutput(options.mode === 'bob' ? null : options.infoFile),
      ensureNewOutput(options.reportFile),
    ]);
    if (options.timeoutSeconds) {
      watchdog = setTimeout(() => {
        reporter.event('timeout', { seconds: options.timeoutSeconds });
        process.exit(124);
      }, options.timeoutSeconds * 1000);
      watchdog.unref();
    }
    const report = await main(options, reporter);
    if (options.reportFile) {
      await writeJsonNew(options.reportFile, { ...report, events: reporter.events });
      reporter.event('report-written', { path: options.reportFile });
    }
  }
} catch (error) {
  if (reporter) reporter.event('error', { message: error.message });
  else process.stderr.write(`Error: ${error.message}\n`);
  process.exitCode = 1;
  // A rejected participant promise can leave the other role polling the node.
  setTimeout(() => process.exit(1), 1000).unref();
} finally {
  if (watchdog) clearTimeout(watchdog);
}
