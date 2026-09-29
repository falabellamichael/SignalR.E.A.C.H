// Verify any repo-compiled contract on Sourcify (v2 API, no key required).
// Usage: node scripts/sourcify-verify.mjs <address> <contractIdentifier>
//   e.g. node scripts/sourcify-verify.mjs 0x6Cfb...392 contracts/ReachCreditsLaunch.sol:ReachCreditsLaunch
import fs from 'node:fs';

const ADDR = process.argv[2];
const CONTRACT = process.argv[3];
if (!ADDR || !CONTRACT) {
  console.error('usage: node scripts/sourcify-verify.mjs <address> <path/File.sol:ContractName>');
  process.exit(1);
}

const CHAIN = 1;
const bi = JSON.parse(fs.readFileSync('artifacts/build-info.json', 'utf8'));
const solverVersion = bi.solcLongVersion || '0.8.37+commit.f401782d';

console.log('address   :', ADDR);
console.log('contract  :', CONTRACT);
console.log('solc      :', solverVersion);
console.log('sources   :', Object.keys(bi.input.sources).length);

// Already verified?
const existing = await fetch(`https://sourcify.dev/server/v2/contract/${CHAIN}/${ADDR}?fields=all`);
const prev = await existing.json();
if (prev.match) {
  console.log('\nalready verified:', prev.match, 'at', prev.verifiedAt);
  process.exit(0);
}

const r = await fetch(`https://sourcify.dev/server/v2/verify/${CHAIN}/${ADDR}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    stdJsonInput: bi.input,
    compilerVersion: solverVersion,
    contractIdentifier: CONTRACT,
  }),
});
const submitted = await r.json();
console.log('\nsubmitted  :', r.status, JSON.stringify(submitted));
if (!submitted.verificationId) process.exit(1);

const id = submitted.verificationId;
for (let i = 0; i < 40; i++) {
  const jr = await fetch(`https://sourcify.dev/server/v2/verify/${id}`);
  const j = await jr.json();
  if (j.isJobCompleted) {
    console.log('\ncompleted in', j.compilationTime, 'ms');
    console.log('match     :', j.contract?.match, '| runtime:', j.contract?.runtimeMatch);
    console.log('verifiedAt:', j.contract?.verifiedAt, '| matchId:', j.contract?.matchId);
    const ext = j.externalVerifications || {};
    for (const [name, v] of Object.entries(ext)) {
      console.log(`  ${name.padEnd(11)}: ${v.error ? 'ERROR ' + v.error.slice(0, 90) : (v.statusUrl ? 'submitted' : JSON.stringify(v).slice(0, 90))}`);
    }
    break;
  }
  await new Promise((res) => setTimeout(res, 3000));
}