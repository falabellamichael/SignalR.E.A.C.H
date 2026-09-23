#!/usr/bin/env bash
# Fast, dependency-free baseline snapshot for docs/AGENT_ENGINE_IMPROVEMENTS.md.
# Engine scope only: counts studio/agent/*.cjs, never node_modules, dist or user data.
#
# Every number printed here is quoted in that document. If a number moves, fix the
# prose in the same change — that is the one rule both plans share.
set -euo pipefail
cd "$(dirname "$0")/.."
node <<'NODE'
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const read = f => fs.readFileSync(f, 'utf8');
const report = (label, value) => console.log(label.padEnd(48), value);

/* Strip comments and string-literal noise before graph/marker analysis, so a
 * require mentioned inside a doc-comment is never mistaken for an edge (the
 * code-tools.cjs self-cycle that a naive scan reports is exactly that). */
const stripComments = src => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^(?:[^'"`\n]*?)\/\/.*$/gm, '');

report('HEAD', execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim());

/* ---- engine size ---- */
const files = fs.readdirSync('studio/agent').filter(n => n.endsWith('.cjs'));
const raw = Object.fromEntries(files.map(n => [n, read('studio/agent/' + n)]));
const code = Object.fromEntries(files.map(n => [n, stripComments(raw[n])]));
const sizes = files.map(name => ({ name, lines: raw[name].split('\n').length - 1 }))
  .sort((a, b) => b.lines - a.lines);
report('Engine modules', files.length);
report('Engine lines (total)', sizes.reduce((sum, f) => sum + f.lines, 0));
for (const f of sizes.slice(0, 5)) report('  largest: ' + f.name, f.lines);

/* ---- tests ---- */
const testFiles = fs.readdirSync('studio/test').filter(n => n.endsWith('.test.cjs'));
report('Unit test files', testFiles.length);
const touching = testFiles.filter(t => /require\(['"][^'"]*agent\/[\w.-]+\.cjs['"]\)/.test(read('studio/test/' + t)));
report('Test files requiring >=1 engine module', `${touching.length} / ${testFiles.length}`);
const engineReqs = new Set();
for (const t of testFiles) {
  for (const m of read('studio/test/' + t).matchAll(/require\(['"][^'"]*agent\/([\w.-]+\.cjs)['"]\)/g)) engineReqs.add(m[1]);
}
const noTest = files.filter(f => !engineReqs.has(f));
report('Engine modules no test requires directly', `${noTest.length} (${noTest.join(', ')})`);

/* ---- budgets schema ---- */
const budgetsKeys = new Set([...read('studio/agent/budgets.cjs').matchAll(/^\s*\['(\w+)'/gm)].map(m => m[1]));
report('Budgets schema fields', budgetsKeys.size);

/* ---- policy constants: is it live, and does a budget field actually govern it? ---- */
/* `via` names the budgets field that reaches this constant, or null when the
 * constant can only be changed by editing engine source. A constant whose only
 * occurrence is its declaration is dead code, not policy. */
const POLICY = [
  ['agent-loop.cjs', 'retry limit (isTransientTransportError branch)', 'retryLimit', false],
  ['agent-loop.cjs', 'retry delay (budget-driven, was a 1500 ms literal)', 'retryBaseMs', false],
  ['agent-net.cjs', 'MAX_AGENTS', 'maxAgents', false],
  ['agent-net.cjs', 'MAX_DEPTH', 'maxDepth', false],
  ['agent-net.cjs', 'SUBAGENT_MAX_ROUNDS', 'subagentMaxRounds', false],
  ['agent-net.cjs', 'DEFAULT_AWAIT_TIMEOUT', 'awaitTimeoutMs', false],
  ['agent-net.cjs', 'MAX_WORKER_KEY_CHARS', 'workerKeyChars', false],
  ['agent-net.cjs', 'TRANSCRIPT_MESSAGES', 'transcriptMessages', false],
  ['agent-net.cjs', 'TRANSCRIPT_CHARS', 'transcriptChars', false],
  ['agent-net.cjs', 'OUTPUT_PREVIEW', 'outputPreviewChars', false],
  ['agent-net.cjs', 'MAX_OPERATOR_MESSAGES_PER_AGENT', 'operatorMessagesPerAgent', false],
  ['agent-net.cjs', 'MAX_OPERATOR_CHARS_PER_AGENT', 'operatorCharsPerAgent', false],
  ['team-runner.cjs', 'PARALLEL_CONCURRENCY', 'teamConcurrency', false],
  ['team-runner.cjs', 'MAX_RESUME_CYCLES', 'resumeCycles', false],
  ['team-runner.cjs', 'RELAY_CHAR_BUDGET', 'relayChars', false],
  ['team-runner.cjs', 'TEAM_REQUEST_TIMEOUT_MS', 'requestTimeoutMs', false],
  ['team-runner.cjs', 'LINKS_RATE', 'linksRate', false],
  ['team-runner.cjs', 'MAX_LINK_ROUNDS', 'maxLinkRounds', false],
  ['team-runner.cjs', 'MEMBER_LINK_TURNS', 'memberLinkTurns', false],
  ['team-runner.cjs', 'LINKS_COMPLETION_GRACE_MS', 'linksCompletionGraceMs', false],
  ['test-loop.cjs', 'DEFAULT_MAX_ATTEMPTS', 'maxAttempts', false],
  ['test-loop.cjs', 'DEFAULT_NO_PROGRESS_LIMIT', 'noProgressLimit', false],
  ['test-loop.cjs', 'MAX_OUTPUT_CHARS', 'gateOutputChars', false],
];
const dead = [], unHomed = [], homed = [], badHome = [];
for (const [file, name, via, knownDead] of POLICY) {
  const token = name.includes(' ') ? null : name;
  const uses = token ? (code[file].match(new RegExp('\\b' + token + '\\b', 'g')) || []).length : 2;
  if (knownDead || (token && uses <= 1)) { dead.push(`${file}:${token}`); continue; }
  if (via) {
    /* A `via` is only a real home if that key exists in the budgets schema. A
     * typo used to read as "homed" while governing nothing. */
    if (!budgetsKeys.has(via)) badHome.push(`${token}->${via} (no such budgets field)`);
    else homed.push(`${token}->${via}`);
  } else unHomed.push(`${file}:${name}`);
}
report('Declared-but-never-read constants (dead)', dead.length + ' -> ' + dead.join(', '));
report('Policy constants HOMED in budgets', homed.length);
report('Homed via a budgets key that does not exist', badHome.length + (badHome.length ? ' -> ' + badHome.join(', ') : ''));
report('Live constants with NO budgets home', unHomed.length);
for (const u of unHomed) console.log('   un-homed:', u);

/* ---- markers and logging ---- */
const grepCount = re => files.reduce((sum, f) => sum + (code[f].match(re) || []).length, 0);
report('TODO/FIXME/HACK/XXX in engine', grepCount(/\b(TODO|FIXME|HACK|XXX)\b/g));
report('console.* in engine', grepCount(/console\./g));
report('Retry-After handling in engine (E1)', grepCount(/retry-after/i));
report('Time-based outbound rate gate (E2)', grepCount(/\bacquireRateSlot\b/g));

/* ---- require graph: cycles, and which edges are top-level (not lazy) ---- */
const graph = {};
for (const f of files) {
  graph[f] = new Set([...code[f].matchAll(/require\('\.\/([\w.-]+\.cjs)'\)/g)].map(m => m[1]));
}
const cycles = new Set();
const seen = new Set(), stack = [];
const walk = n => {
  if (stack.includes(n)) { cycles.add(stack.slice(stack.indexOf(n)).concat(n).join(' -> ')); return; }
  if (seen.has(n)) return;
  seen.add(n); stack.push(n);
  for (const m of graph[n] || []) if (graph[m]) walk(m);
  stack.pop();
};
for (const n of Object.keys(graph)) walk(n);
const cycleList = [...cycles].sort();
report('Static require cycles in engine', cycleList.length);
let lazyEdges = 0, topEdges = 0;
/* An edge is LAZY when the require sits inside a function body (indented). */
const edgeKind = (from, to) => {
  const re = new RegExp("require\\('\\./" + to.replace(/\./g, '\\.') + "'\\)");
  const line = code[from].split('\n').find(l => re.test(l)) || '';
  return /^\s/.test(line) ? 'lazy' : 'top-level';
};
for (const c of cycleList) {
  const parts = c.split(' -> ');
  const kinds = [];
  for (let i = 0; i < parts.length - 1; i++) kinds.push(edgeKind(parts[i], parts[i + 1]));
  const lazy = kinds.filter(k => k === 'lazy').length;
  lazyEdges += lazy; topEdges += kinds.length - lazy;
  const nodes = parts.length - 1;
  console.log(`   cycle (${nodes} node${nodes > 1 ? 's' : ''}, ${lazy} lazy edge${lazy === 1 ? '' : 's'}): ${c}`);
}
report('Cycle edges: lazy / top-level', `${lazyEdges} / ${topEdges}`);
report('Cycles with NO lazy edge (unsafe)', cycleList.filter(c => {
  const p = c.split(' -> ');
  return p.slice(0, -1).every((from, i) => edgeKind(from, p[i + 1]) === 'top-level');
}).length);

/* ---- engine -> renderer coupling (E9) ---- */
let rendererRefs = 0;
for (const f of files) rendererRefs += (code[f].match(/require\('\.\.\/renderer\//g) || []).length;
report('Engine modules requiring ../renderer', rendererRefs);

/* ---- tool registry ---- */
const TOOLS = require('./studio/agent/tool-registry.cjs').TOOLS;
report('Registered tools', Object.keys(TOOLS).length);
report('Tools declaring a params schema (E4)', Object.values(TOOLS).filter(t => t && t.params).length);
report('Exec-class tools', Object.values(TOOLS).filter(t => t && t.class === 'exec').length);

/* ---- audit events written by engine production code (E7) ---- */
const prodWriters = [];
for (const f of files) {
  for (const m of code[f].matchAll(/event:\s*'([^']+)'/g)) prodWriters.push(`${f}:${m[1]}`);
  for (const m of code[f].matchAll(/auditEvent\([^,]+,\s*'([^']+)'/g)) prodWriters.push(`${f}:${m[1]}`);
}
for (const m of stripComments(read('studio/main.mjs')).matchAll(/auditEvent\([^,]+,\s*'([^']+)'/g)) prodWriters.push(`main.mjs:${m[1]}`);
report('Audit event kinds in engine code', prodWriters.join(', '));

console.log('\nVerification (not run by this snapshot):');
console.log('cd studio && npm test');
console.log('cd studio && npm run test:coverage');
NODE
