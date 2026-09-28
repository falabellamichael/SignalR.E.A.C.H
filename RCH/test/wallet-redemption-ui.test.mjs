import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../service/public/wallet.js', import.meta.url), 'utf8');
const walletAddress = '0x' + '11'.repeat(20), treasuryAddress = '0x' + '22'.repeat(20);
const tokenAddress = '0x' + '33'.repeat(20), contractAddress = '0x' + '44'.repeat(20);
const approvalHash = '0x' + 'aa'.repeat(32), redemptionHash = '0x' + 'bb'.repeat(32);
const approval = { to: tokenAddress, data: '0xapprove-exact-amount', value: '0x0', chainId: '0x1' };
const redeem = { to: contractAddress, data: '0xredeem-signed-quote', value: '0x0', chainId: '0x1' };

async function fixture(changes = {}, options = {}) {
  const elements = new Map(), sent = [], submitted = [];
  const saved = new Map(options.saved || []);
  let receipt = null;
  let details = { mode: 'treasury', status: 'created', walletAddress, treasuryAddress, chainId: 1,
    amountRch: '10', creditUsdMicros: 300, expiresAt: new Date(Date.now() + 600000).toISOString(),
    quote: { source: 'Verified market quote', observedAt: new Date().toISOString() }, approvalTransaction: approval, transaction: null, ...changes };
  const element = id => {
    if (!elements.has(id)) elements.set(id, { hidden: false, disabled: false, value: '', textContent: '',
      events: {}, addEventListener(name, callback) { this.events[name] = callback; } });
    return elements.get(id);
  };
  const ethereum = { request: async ({ method, params }) => {
    if (method === 'eth_chainId') return '0x1';
    if (method === 'eth_requestAccounts') return [walletAddress];
    if (method === 'eth_getTransactionReceipt') return receipt;
    if (method === 'eth_sendTransaction') { sent.push(params[0]); return params[0].to === tokenAddress ? approvalHash : redemptionHash; }
    throw new Error('Unexpected wallet method ' + method);
  } };
  const context = vm.createContext({ document: { getElementById: element }, window: { ethereum },
    location: { pathname: '/wallet/redeem', hash: '#id=fixture&ticket=fixture', origin: 'https://reach.example' },
    sessionStorage: { getItem: key => saved.get(key), setItem: (key, value) => saved.set(key, value), removeItem: key => saved.delete(key) },
    URLSearchParams, TextEncoder, Date, console, fetch: async (path, options) => {
      if (path.endsWith('/config')) return { ok: true, json: async () => ({ chainId: 1, redemptionMode: 'treasury' }) };
      if (path.endsWith('/details')) return { ok: true, json: async () => ({ ...details }) };
      if (path.endsWith('/submit')) { submitted.push(JSON.parse(options.body)); return { ok: true, json: async () => ({ status: 'pending', reason: 'awaiting_finality' }) }; }
      throw new Error('Unexpected API ' + path);
    } });
  vm.runInContext(source, context);
  await new Promise(resolve => setImmediate(resolve));
  return { element, sent, submitted, saved, click: () => element('primary').events.click(), recover: () => element('recover').events.click(),
    update: value => { details = { ...details, ...value }; }, confirm: value => { receipt = value; } };
}

test('treasury redemption shows exact subcent USD credit and requires separate approval and redemption', async () => {
  const f = await fixture();
  assert.match(f.element('amount').textContent, /10 RCH → US\$0\.0003 AI credit/);
  assert.equal(f.element('treasury').textContent, treasuryAddress);
  assert.equal(f.element('primary').textContent, 'Approve 10 RCH');
  await f.click();
  assert.equal(f.sent.length, 1); assert.equal(f.sent[0].to, tokenAddress); assert.equal(f.submitted.length, 0);
  assert.equal(f.element('primary').textContent, 'Check RCH approval');
  await f.click(); assert.equal(f.sent.length, 1); assert.match(f.element('status').textContent, /pending/);
  f.confirm({ status: '0x1' }); f.update({ approvalTransaction: null, transaction: redeem });
  await f.click(); assert.equal(f.sent.length, 1, 'approval confirmation never broadcasts a redemption');
  assert.equal(f.element('primary').textContent, 'Redeem RCH for AI credit');
  await f.click(); assert.equal(f.sent.length, 2); assert.equal(f.sent[1].to, contractAddress);
  assert.equal(f.submitted[0].txHash, redemptionHash); assert.equal(f.element('primary').disabled, true);
});

test('failed approval does not submit redemption and can be retried', async () => {
  const f = await fixture(); await f.click(); f.confirm({ status: '0x0' }); await f.click();
  assert.equal(f.sent.length, 1); assert.equal(f.submitted.length, 0);
  assert.equal(f.element('primary').textContent, 'Approve 10 RCH');
  assert.match(f.element('approval-status').textContent, /failed/);
});

test('changed credit requires another review before opening the wallet', async () => {
  const f = await fixture(); f.update({ creditUsdMicros: 250 }); await f.click();
  assert.equal(f.sent.length, 0); assert.match(f.element('status').textContent, /quote changed/);
  assert.match(f.element('amount').textContent, /US\$0\.00025/);
  await f.click(); assert.equal(f.sent.length, 1);
});

test('missing market evidence, expired quotes and legacy mainnet burns never open a transaction', async () => {
  for (const change of [{ creditUsdMicros: 0 }, { creditUsdMicros: 0.5 }, { treasuryAddress: '' },
    { quote: { source: '', observedAt: new Date().toISOString() } }, { expiresAt: new Date(Date.now() - 1000).toISOString() },
    { mode: 'legacy', approvalTransaction: null, transaction: redeem, usageTokens: 1000000 }]) {
    const f = await fixture(change); assert.equal(f.element('primary').disabled, true);
    await f.click(); assert.equal(f.sent.length, 0);
  }
});

test('reload restores a broadcast transaction hash and prevents a second wallet transaction', async () => {
  const f = await fixture({ approvalTransaction: null, transaction: redeem });
  await f.click();
  assert.equal(f.saved.get('reach-redemption-transaction:fixture'), redemptionHash);
  // The server may still return an unsigned intent if the page lost connectivity
  // immediately after broadcast. The local recovery hash must take precedence.
  const restored = await fixture({ approvalTransaction: null, transaction: redeem }, { saved: [...f.saved] });
  assert.equal(restored.element('txHash').value, redemptionHash);
  assert.equal(restored.element('primary').disabled, true);
  assert.match(restored.element('status').textContent, /saved below/);
  await restored.click(); assert.equal(restored.sent.length, 0);
  await restored.recover(); assert.equal(restored.submitted[0].txHash, redemptionHash);
});
