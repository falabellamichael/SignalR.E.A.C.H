import { createServer } from 'node:http';
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { resolve, dirname, sep } from 'node:path';
import { parseArgs } from 'node:util';
import { Contract, formatEther, formatUnits, getAddress, keccak256 } from 'ethers';
import { compile, root, sha256 } from './compile.mjs';
import { createProvider } from '../terminal/rpc.mjs';
import { openBrowser } from '../terminal/approval.mjs';
import { prepareSaleReplacement, readReplacementState, nextReplacementAction, resumeSaleReplacement } from './sale-replacement.mjs';

const { values: options } = parseArgs({ options: { resume: { type: 'string' }, 'no-open': { type: 'boolean' } } });
const admin = getAddress('0xDa68602c9d65337C75BF0593972d9731895592e3');
const treasury = getAddress('0x5b7a910cDF232543aCB7653D71d6B92f01d342C7');
const manifestPath = resolve(root, 'terminal/mainnet.json');
const manifestText = await readFile(manifestPath, 'utf8');
const manifestHash = sha256(manifestText);
const deployment = JSON.parse(manifestText);
const build = await compile();
const provider = createProvider(process.env.RCH_RPC_URL);
const planPath = options.resume ? resolve(root, options.resume) : resolve(root, 'private', `replacement-sale-${Date.now()}.json`);
if (!planPath.startsWith(root + sep)) throw new Error('Unsafe replacement plan path.');
const plan = options.resume
  ? await resumeSaleReplacement(provider, deployment, JSON.parse(await readFile(planPath, 'utf8')), build, { admin, treasury })
  : await prepareSaleReplacement(provider, { ...deployment, account: admin }, treasury, build);
if (!options.resume) {
  await mkdir(dirname(planPath), { recursive: true });
  await writeFile(planPath, `${JSON.stringify(plan, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
}

const token = randomBytes(24).toString('hex');
const prefix = `/${token}/`;
let origin;
const resources = new Map([
  ['', [resolve(root, 'tools/replacement.html'), 'text/html']],
  ['replacement.js', [resolve(root, 'tools/replacement.js'), 'text/javascript']],
  ['fees.mjs', [resolve(root, 'terminal/public/fees.mjs'), 'text/javascript']],
  ['ethers.js', [resolve(root, 'node_modules/ethers/dist/ethers.umd.min.js'), 'text/javascript']],
  ['plan.json', [planPath, 'application/json']],
  ['mainnet.json', [manifestPath, 'application/json']],
]);

const server = createServer(async (request, response) => {
  const headers = {
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  };
  const send = (status, body, type = 'application/json') => {
    response.writeHead(status, { ...headers, 'Content-Type': `${type}; charset=utf-8` });
    response.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
  };
  if (request.headers.host !== new URL(origin).host || !request.url.startsWith(prefix)) {
    send(404, { error: 'Not found' });
    return;
  }
  const resource = request.url.slice(prefix.length);
  try {
    if (request.method === 'GET' && resource === 'state.json') {
      const state = await readReplacementState(provider, plan, build);
      const [adminBalance, newSaleCode, buyerRch] = await Promise.all([
        provider.getBalance(admin), provider.getCode(plan.expectedSale),
        new Contract(plan.token, build.artifacts.ReachCreditsLaunch.abi, provider).balanceOf(admin),
      ]);
      const latestBlock = await provider.getBlock('latest');
      send(200, {
        state,
        nextAction: nextReplacementAction(state),
        blockNumber: latestBlock.number,
        adminBalanceEth: formatEther(adminBalance),
        buyerRch: formatUnits(buyerRch, 18),
        newCodeHash: newSaleCode === '0x' ? null : keccak256(newSaleCode),
      });
      return;
    }
    if (request.method === 'POST' && resource === 'activate') {
      if (request.headers.origin !== origin || !String(request.headers['content-type']).startsWith('application/json')) {
        send(403, { error: 'Request origin rejected' });
        return;
      }
      let raw = '';
      for await (const chunk of request) {
        raw += chunk;
        if (raw.length > 2048) { send(413, { error: 'Request too large' }); return; }
      }
      const input = JSON.parse(raw);
      if (input.admin !== admin || input.sale !== plan.expectedSale) { send(400, { error: 'Sale identity does not match the plan.' }); return; }
      const state = await readReplacementState(provider, plan, build);
      if (nextReplacementAction(state) !== 'complete') { send(409, { error: 'Replacement sale cutover is not complete.' }); return; }

      const latestText = await readFile(manifestPath, 'utf8');
      const latest = JSON.parse(latestText);
      const code = await provider.getCode(plan.expectedSale);
      if (!code.startsWith('0x') || code === '0x') { send(409, { error: 'Replacement sale bytecode is missing.' }); return; }
      const replacementCodeHash = keccak256(code);
      if (latest.sale === plan.expectedSale && latest.initialSale === plan.oldSale
        && latest.treasury === plan.treasury && latest.token === plan.token
        && latest.saleCodeHash === replacementCodeHash) {
        send(200, { updated: true, alreadyActive: true, sale: latest.sale, treasury: latest.treasury, saleCodeHash: latest.saleCodeHash });
        return;
      }
      if (sha256(latestText) !== manifestHash || latest.sale !== plan.oldSale || latest.token !== plan.token) {
        send(409, { error: 'The tracked mainnet manifest changed. Preserve it and update the replacement sale manually.' });
        return;
      }
      latest.initialSale = latest.initialSale || latest.sale;
      latest.sale = plan.expectedSale;
      latest.treasury = plan.treasury;
      latest.saleCodeHash = replacementCodeHash;
      const tempPath = resolve(root, 'terminal', `.mainnet-${randomBytes(8).toString('hex')}.tmp`);
      await writeFile(tempPath, `${JSON.stringify(latest, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
      await rename(tempPath, manifestPath);
      send(200, { updated: true, sale: latest.sale, treasury: latest.treasury, saleCodeHash: latest.saleCodeHash });
      return;
    }
    if (request.method !== 'GET') { send(405, { error: 'Method not allowed' }); return; }
    if (resource === 'sale-artifact.json') { send(200, build.artifacts.ReachCreditsSale); return; }
    if (resource === 'launch-artifact.json') { send(200, build.artifacts.ReachCreditsLaunch); return; }
    const file = resources.get(resource);
    if (!file) { send(404, { error: 'Not found' }); return; }
    send(200, await readFile(file[0]), file[1]);
  } catch (error) {
    send(400, { error: error.shortMessage || error.message || 'Request failed.' });
  }
});

server.requestTimeout = 15000;
server.headersTimeout = 10000;
await new Promise((resolveListen, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolveListen);
});
origin = `http://127.0.0.1:${server.address().port}`;
const url = `${origin}${prefix}`;
process.stdout.write(`RCH treasury replacement review: ${url}\nPlan: ${planPath}\nPredicted sale: ${plan.expectedSale}\nMax deployment cost: ${plan.deploymentFee.maxCostEth} ETH\nExpires: ${plan.expiresAt}\n`);
try { if (!options['no-open']) await openBrowser(url, 'edge'); }
catch { process.stdout.write('Open the printed review URL in Edge with MetaMask enabled.\n'); }

const timer = setTimeout(() => {
  process.stdout.write('Replacement review session expired. Close it after preserving any transaction hash.\n');
  server.close();
  server.closeAllConnections();
  provider.destroy();
}, 30 * 60 * 1000);
timer.unref();
server.once('close', () => { clearTimeout(timer); provider.destroy(); });
