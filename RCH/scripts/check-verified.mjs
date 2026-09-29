// Check whether Etherscan / Routescan list the RCH token as source-verified.
const a = '0x6Cfb2531696f99Cd4511F281aBECe4b6a67c3792';
const marks = [
  'Contract Source Code Verified',
  'Contract Source Code Not Verified',
  'Similar Match',
  'Source Code Verified',
];

async function check(name, url) {
  try {
    const r = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
    });
    const h = await r.text();
    console.log(name, '-> http', r.status, 'len', h.length);
    for (const m of marks) {
      if (h.includes(m)) console.log('    HIT:', m);
    }
    const neg = h.includes('Not Verified');
    console.log('    shows "Not Verified":', neg);
  } catch (e) {
    console.log(name, '-> failed:', e.message);
  }
}

await check('Etherscan', 'https://etherscan.io/address/' + a);
await check('Routescan', 'https://routescan.io/address/' + a + '?chainid=1');
await check('Sourcify UI', 'https://sourcify.dev/#/lookup/' + a);