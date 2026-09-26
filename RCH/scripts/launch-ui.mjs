import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { JsonRpcProvider } from 'ethers';
import { compile, root } from './compile.mjs';
import { inspectDeployment, validateRpcUrl } from './workflow.mjs';

const port = 8765;
const planPath = resolve(root, 'private/mainnet-plan.json');
const recordPath = resolve(root, 'deployments/mainnet-deployment.json');
const plan = JSON.parse(await readFile(planPath, 'utf8'));
const build = await compile();
if (plan.config.chainId !== 1 || plan.sourceHash !== build.sourceHash) {
  throw new Error('The mainnet plan does not match the current RCH source. Prepare a new plan.');
}
const provider = new JsonRpcProvider(validateRpcUrl(process.env.RCH_RPC_URL, 1));
if ((await provider.getNetwork()).chainId !== 1n) throw new Error('RCH_RPC_URL must connect to Ethereum mainnet.');
const files = new Map([
  ['/', [resolve(root, 'tools/mainnet.html'), 'text/html; charset=utf-8']],
  ['/mainnet.js', [resolve(root, 'tools/mainnet.js'), 'application/javascript; charset=utf-8']],
  ['/ethers.js', [resolve(root, 'node_modules/ethers/dist/ethers.umd.min.js'), 'application/javascript; charset=utf-8']],
  ['/plan.json', [planPath, 'application/json; charset=utf-8']],
  ['/launch-artifact.json', [resolve(root, 'artifacts/ReachCreditsLaunch.json'), 'application/json; charset=utf-8']],
  ['/sale-artifact.json', [resolve(root, 'artifacts/ReachCreditsSale.json'), 'application/json; charset=utf-8']],
]);

const server = createServer(async (request, response) => {
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'no-referrer');
  if (!['127.0.0.1:8765', 'localhost:8765'].includes(request.headers.host)) {
    response.writeHead(403).end(); return;
  }
  if (request.url === '/state.json' && request.method === 'GET') {
    try {
      const record = JSON.parse(await readFile(recordPath, 'utf8'));
      if (record.txHash && record.plan?.dataHash !== plan.dataHash) throw new Error('Deployment record differs from plan.');
      const [receipt, finalized] = await Promise.all([
        provider.getTransactionReceipt(record.txHash), provider.getBlock('finalized'),
      ]);
      if (!receipt || receipt.status !== 1 || receipt.contractAddress !== plan.tokenAddress
        || !finalized || receipt.blockNumber > finalized.number) throw new Error('Deployment is not finalized.');
      const { state } = await inspectDeployment(provider, plan, build);
      response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ verified: true, state }));
    } catch {
      response.writeHead(409, { 'Content-Type': 'application/json' }).end('{"verified":false}');
    }
    return;
  }
  if (request.url === '/record' && request.method === 'POST') {
    if (request.headers.origin !== `http://${request.headers.host}` || request.headers['content-type'] !== 'application/json') {
      response.writeHead(403).end(); return;
    }
    try {
      let body = '';
      for await (const chunk of request) {
        body += chunk;
        if (body.length > 256) { response.writeHead(413).end(); return; }
      }
      const { txHash, dataHash } = JSON.parse(body);
      if (!/^0x[0-9a-f]{64}$/i.test(txHash) || !/^[0-9a-f]{64}$/i.test(dataHash)) {
        response.writeHead(400).end(); return;
      }
      if (plan.schema !== 'rch-deployment-plan-v1' || plan.dataHash !== dataHash) {
        response.writeHead(409).end(); return;
      }
      await mkdir(resolve(root, 'deployments'), { recursive: true });
      const record = { schema: 'rch-deployment-record-v1', state: 'submitted', txHash, plan };
      try { await writeFile(recordPath, JSON.stringify(record, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); }
      catch (error) {
        if (error.code !== 'EEXIST' || JSON.parse(await readFile(recordPath, 'utf8')).txHash !== txHash) {
          response.writeHead(409).end(); return;
        }
      }
      response.writeHead(200, { 'Content-Type': 'application/json' }).end('{"saved":true}');
    } catch {
      response.writeHead(500).end();
    }
    return;
  }
  if (request.method !== 'GET') { response.writeHead(405).end(); return; }
  const file = files.get(request.url);
  if (!file) { response.writeHead(404).end(); return; }
  try {
    const body = await readFile(file[0]);
    response.writeHead(200, { 'Content-Type': file[1] }).end(body);
  } catch {
    response.writeHead(500).end('Required local RCH plan or artifact is missing.');
  }
});
server.listen(port, '127.0.0.1', () => {
  process.stdout.write(`RCH launch review: http://127.0.0.1:${port}/\n`);
});
