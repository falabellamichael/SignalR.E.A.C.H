// Consolidated verification status for the RCH token and its sale.
const TOKEN = '0x6Cfb2531696f99Cd4511F281aBECe4b6a67c3792';
const SALE = '0xF6aE4b2c3611fd93A879c0F9dDd00C2083E7BE31';

async function routescanAbi(name, addr) {
  const u = `https://api.routescan.io/v2/network/mainnet/evm/1/etherscan/api?module=contract&action=getabi&address=${addr}`;
  try {
    const r = await fetch(u);
    const j = await r.json();
    const ok = j.status === '1' && j.result && j.result.startsWith('[');
    console.log(`${name.padEnd(6)} Routescan ABI: ${ok ? 'AVAILABLE (verified)' : 'not available'}  [${j.message}]`);
    if (ok) {
      const abi = JSON.parse(j.result);
      console.log(`       ${abi.length} ABI entries -- e.g. ${abi.slice(0, 5).map((x) => x.name || x.type).join(', ')}`);
    }
  } catch (e) {
    console.log(`${name.padEnd(6)} Routescan: error ${e.message}`);
  }
}

async function sourcify(name, addr) {
  try {
    const r = await fetch(`https://sourcify.dev/server/v2/contract/1/${addr}?fields=all`);
    const j = await r.json();
    console.log(`${name.padEnd(6)} Sourcify: match=${j.match} runtime=${j.runtimeMatch} at ${j.verifiedAt}`);
  } catch (e) {
    console.log(`${name.padEnd(6)} Sourcify: error ${e.message}`);
  }
}

console.log('=== RCH TOKEN ' + TOKEN + ' ===');
await sourcify('token', TOKEN);
await routescanAbi('token', TOKEN);
console.log('');
console.log('=== RCH SALE ' + SALE + ' ===');
await sourcify('sale', SALE);
await routescanAbi('sale', SALE);
console.log('');
console.log('=== PUBLIC LINKS ===');
console.log('Sourcify  : https://sourcify.dev/#/lookup/' + TOKEN);
console.log('Routescan : https://routescan.io/address/' + TOKEN + '?chainid=1');
console.log('Etherscan : https://etherscan.io/address/' + TOKEN);