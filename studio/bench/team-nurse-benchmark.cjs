'use strict';

/*
 * Deterministic virtual-time benchmark for the Links Team Nurse.
 *
 * This is deliberately not a wall-clock benchmark and never calls a provider.
 * A small declared corpus describes the post-initial Links recovery/synthesis
 * phase: evidence arrival, stalled members, user gates and scripted outcomes.
 * Initial request counts are included, but initial service durations and the
 * fanout barrier are outside this benchmark. Policies run against the same
 * event queue, so repeated executions are byte-for-byte reproducible.
 *
 * The search result means "fastest feasible policy on this corpus". General
 * precedence-constrained scheduling is not solved optimally by this script and
 * no universal-optimality claim should be inferred from its output.
 */

const {
  classifyFailure,
  recoveryScore,
} = require('../agent/team-nurse.cjs');

const SEARCH_SPACE = Object.freeze({
  minRecoveryScore: Object.freeze([6, 7, 8, 9, 10]),
  priorWakePenalty: Object.freeze([0]),
  maxAutoWakesPerMember: Object.freeze([1, 2, 3]),
});

const DEFAULT_FINALIZATION = Object.freeze({ collectionMs: 15, synthesisMs: 20 });

/* Scenario fields are data only. `succeedOnAttempt: null` means that recovery
 * never succeeds; it is useful for measuring retry suppression without making
 * the failed member part of the correctness goal. */
const SCENARIOS = Object.freeze([
  {
    id: 'parallel-ready-recoveries',
    description: 'Three independent evidence-backed recoveries should fill all three slots.',
    concurrency: 3,
    initialCalls: 4,
    gateAt: 0,
    requiredMembers: ['audit', 'build', 'verify'],
    members: [
      { id: 'audit', status: 'stalled', error: 'ordinary work failure', requiredFacts: ['audit-evidence'], wakeDurationMs: 90, succeedOnAttempt: 1 },
      { id: 'build', status: 'stalled', error: 'ordinary work failure', requiredFacts: ['build-evidence'], wakeDurationMs: 60, succeedOnAttempt: 1 },
      { id: 'verify', status: 'stalled', error: 'ordinary work failure', requiredFacts: ['verify-evidence'], wakeDurationMs: 30, succeedOnAttempt: 1 },
    ],
    evidence: [
      { at: 0, id: 'ev-audit', target: 'audit', fact: 'audit-evidence', source: 'Scout', sourceChars: 240 },
      { at: 0, id: 'ev-build', target: 'build', fact: 'build-evidence', source: 'Scout', sourceChars: 240 },
      { at: 0, id: 'ev-verify', target: 'verify', fact: 'verify-evidence', source: 'Scout', sourceChars: 240 },
    ],
  },
  {
    id: 'coalesced-dual-evidence',
    description: 'Two facts arriving together should produce one recovery call, not two partial calls.',
    concurrency: 2,
    initialCalls: 2,
    gateAt: 0,
    requiredMembers: ['reviewer'],
    members: [
      { id: 'reviewer', status: 'stalled', error: 'invalid action schema', requiredFacts: ['schema', 'trace'], wakeDurationMs: 70, succeedOnAttempt: 1 },
    ],
    evidence: [
      { at: 0, id: 'ev-schema', target: 'reviewer', fact: 'schema', source: 'Builder', sourceChars: 220 },
      { at: 0, id: 'ev-trace', target: 'reviewer', fact: 'trace', source: 'Tester', sourceChars: 220 },
    ],
  },
  {
    id: 'two-stage-required-recovery',
    description: 'One member legitimately needs two bounded wakes with fresh coordinator evidence.',
    concurrency: 2,
    initialCalls: 3,
    gateAt: 0,
    requiredMembers: ['fixer'],
    members: [
      { id: 'fixer', status: 'stalled', error: 'structured recovery produced an invalid action', requiredFacts: ['patch', 'verification'], wakeDurationMs: 30, succeedOnAttempt: 2 },
    ],
    evidence: [
      { at: 0, id: 'ev-patch', target: 'fixer', fact: 'patch', source: 'Coordinator', sourceChars: 320, sourceIsCoordinator: true },
      { at: 60, id: 'ev-verification', target: 'fixer', fact: 'verification', source: 'Coordinator', sourceChars: 320, sourceIsCoordinator: true },
    ],
  },
  {
    id: 'low-value-noise',
    description: 'A tiny generic note cannot repair an optional failed member and should not spend a call.',
    concurrency: 2,
    initialCalls: 2,
    gateAt: 60,
    requiredMembers: [],
    members: [
      { id: 'optional', status: 'stalled', error: 'ordinary work failure', requiredFacts: ['missing-real-evidence'], wakeDurationMs: 30, succeedOnAttempt: null },
    ],
    evidence: [
      { at: 0, id: 'ev-tiny-note', target: 'optional', fact: 'tiny-note', source: 'Peer', sourceChars: 40 },
    ],
  },
  {
    id: 'prior-wake-penalty',
    description: 'A second merely substantive protocol hint should be suppressed after one failed wake.',
    concurrency: 2,
    initialCalls: 2,
    gateAt: 100,
    requiredMembers: [],
    members: [
      { id: 'optional-protocol', status: 'stalled', error: 'invalid action protocol', requiredFacts: ['unavailable-proof'], wakeDurationMs: 20, succeedOnAttempt: null },
    ],
    evidence: [
      { at: 0, id: 'ev-protocol-1', target: 'optional-protocol', fact: 'hint-one', source: 'Peer', sourceChars: 220 },
      { at: 40, id: 'ev-protocol-2', target: 'optional-protocol', fact: 'hint-two', source: 'Peer', sourceChars: 220 },
    ],
  },
  {
    id: 'hard-and-user-gates',
    description: 'Auth/config failures and explicit user gates are never retried automatically.',
    concurrency: 3,
    initialCalls: 4,
    gateAt: 50,
    requiredMembers: [],
    members: [
      { id: 'auth', status: 'stalled', error: 'Endpoint returned HTTP 401: unauthorized', requiredFacts: [], wakeDurationMs: 10, succeedOnAttempt: null },
      { id: 'question', status: 'waiting_input', error: 'Which file should I inspect?', requiredFacts: [], wakeDurationMs: 10, succeedOnAttempt: null },
      { id: 'edits', status: 'waiting_edits', error: 'Review the proposed edits.', requiredFacts: [], wakeDurationMs: 10, succeedOnAttempt: null },
    ],
    evidence: [
      { at: 0, id: 'ev-auth', target: 'auth', fact: 'auth-note', source: 'Coordinator', sourceChars: 400, sourceIsCoordinator: true },
      { at: 0, id: 'ev-question', target: 'question', fact: 'guessed-answer', source: 'Peer', sourceChars: 400 },
      { at: 0, id: 'ev-edits', target: 'edits', fact: 'guessed-verdict', source: 'Peer', sourceChars: 400 },
    ],
  },
  {
    id: 'duplicate-evidence',
    description: 'The same evidence fingerprint delivered twice must result in exactly one wake.',
    concurrency: 2,
    initialCalls: 2,
    gateAt: 0,
    requiredMembers: ['dedupe-target'],
    members: [
      { id: 'dedupe-target', status: 'stalled', error: 'ordinary work failure', requiredFacts: ['fresh-proof'], wakeDurationMs: 40, succeedOnAttempt: 1 },
    ],
    evidence: [
      { at: 0, id: 'ev-proof', target: 'dedupe-target', fact: 'fresh-proof', source: 'Verifier', sourceChars: 260 },
      { at: 0, id: 'ev-proof', target: 'dedupe-target', fact: 'fresh-proof', source: 'Verifier', sourceChars: 260 },
    ],
  },
  {
    id: 'bounded-retry-storm',
    description: 'Fresh but unhelpful coordinator notes cannot create an unbounded retry storm.',
    concurrency: 2,
    initialCalls: 2,
    gateAt: 150,
    requiredMembers: [],
    members: [
      { id: 'storm', status: 'stalled', error: 'invalid action protocol', requiredFacts: ['never-arrives'], wakeDurationMs: 20, succeedOnAttempt: null },
    ],
    evidence: [
      { at: 0, id: 'ev-storm-1', target: 'storm', fact: 'storm-one', source: 'Coordinator', sourceChars: 300, sourceIsCoordinator: true },
      { at: 40, id: 'ev-storm-2', target: 'storm', fact: 'storm-two', source: 'Coordinator', sourceChars: 300, sourceIsCoordinator: true },
      { at: 80, id: 'ev-storm-3', target: 'storm', fact: 'storm-three', source: 'Coordinator', sourceChars: 300, sourceIsCoordinator: true },
    ],
  },
  {
    id: 'transport-exhaustion-guard',
    description: 'Transport recovery is already exhausted below the nurse, so evidence cannot trigger another provider call.',
    concurrency: 2,
    initialCalls: 2,
    gateAt: 50,
    requiredMembers: [],
    members: [
      { id: 'network-worker', status: 'stalled', error: 'ECONNRESET: connection closed', requiredFacts: ['retry-proof'], wakeDurationMs: 35, succeedOnAttempt: null },
    ],
    evidence: [
      { at: 0, id: 'ev-retry-proof', target: 'network-worker', fact: 'retry-proof', source: 'Peer', sourceChars: 240 },
    ],
  },
  {
    id: 'direct-synthesis-handoff',
    description: 'Completed results are placed directly in synthesis context without a collection model round.',
    concurrency: 2,
    initialCalls: 3,
    gateAt: 50,
    requiredMembers: [],
    members: [],
    evidence: [],
  },
]);

function clone(value) {
  return structuredClone(value);
}

function percentile(values, q) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * q) - 1)];
}

function formulaFor(policy) {
  return `3*stalled + 4*newEvidence + 2*protocol + 1*substantive + 1*coordinator - ${policy.priorWakePenalty}*priorWakes; wake>=${policy.minRecoveryScore}; maxWakes=${policy.maxAutoWakesPerMember}; providerOrTransport=-Infinity`;
}

function makePolicy(kind, overrides = {}) {
  if (kind === 'sequential-baseline') {
    return {
      id: kind,
      kind,
      coalesce: false,
      directSynthesisHandoff: false,
      maxDispatchAtOnce: 1,
      minRecoveryScore: Number.NEGATIVE_INFINITY,
      priorWakePenalty: 0,
      maxAutoWakesPerMember: Number.POSITIVE_INFINITY,
    };
  }
  return {
    id: kind,
    kind,
    coalesce: true,
    directSynthesisHandoff: true,
    maxDispatchAtOnce: Number.POSITIVE_INFINITY,
    ...overrides,
  };
}

function initMember(spec, index) {
  return {
    ...clone(spec),
    index,
    status: spec.status || 'stalled',
    failureKind: classifyFailure(spec.error),
    knownFacts: new Set(),
    inbox: [],
    priorWakes: 0,
    attempts: 0,
    readyAt: null,
    wakeKeys: new Set(),
    completedAt: spec.status === 'completed' ? 0 : null,
  };
}

function evidenceRank(evidence) {
  return [
    Number(evidence.at || 0),
    Number(evidence.sourceIsCoordinator === true),
    Number(evidence.sourceChars || 0),
    String(evidence.id || ''),
  ];
}

function compareEvidence(a, b) {
  const ar = evidenceRank(a), br = evidenceRank(b);
  for (let i = 0; i < ar.length - 1; i++) {
    if (ar[i] !== br[i]) return br[i] - ar[i];
  }
  return ar[3].localeCompare(br[3]);
}

function candidateFor(member, policy) {
  if (member.status !== 'stalled' || !member.inbox.length) return null;
  if (member.failureKind === 'hard-provider' || member.failureKind === 'transport') return null;
  if (member.priorWakes >= policy.maxAutoWakesPerMember) return null;
  const bestEvidence = [...member.inbox].sort(compareEvidence)[0];
  if (!bestEvidence) return null;
  const score = policy.kind === 'sequential-baseline'
    ? Number.POSITIVE_INFINITY
    : recoveryScore({
        failureKind: member.failureKind,
        priorWakes: member.priorWakes,
        sourceChars: bestEvidence.sourceChars,
        sourceIsCoordinator: bestEvidence.sourceIsCoordinator,
        hasNewEvidence: true,
      }, { priorWakePenalty: policy.priorWakePenalty });
  if (score < policy.minRecoveryScore) return null;
  return { member, bestEvidence, score, readyAt: member.readyAt ?? 0 };
}

function compareCandidates(a, b) {
  if (a.score !== b.score) return b.score - a.score;
  if (a.readyAt !== b.readyAt) return a.readyAt - b.readyAt;
  return a.member.index - b.member.index;
}

function scenarioCorrect(scenario, members, gateOpen, metrics) {
  const required = new Set(scenario.requiredMembers || []);
  const requiredDone = [...required].every(id => members.get(id)?.status === 'completed');
  return gateOpen && requiredDone && metrics.safetyViolations === 0;
}

function simulateScenario(rawScenario, policy) {
  const scenario = clone(rawScenario);
  const members = new Map((scenario.members || []).map((member, index) => [member.id, initMember(member, index)]));
  const capacity = Math.max(1, Number(scenario.concurrency) || 1);
  const finalization = { ...DEFAULT_FINALIZATION, ...(scenario.finalization || {}) };
  const seenEvidence = new Set();
  const events = [];
  let sequence = 0;
  let now = 0;
  let active = 0;
  let gateOpen = false;
  let completionAt = null;
  const trace = [];
  const metrics = {
    providerCalls: Number(scenario.initialCalls) || 0,
    wakeCalls: 0,
    failedRetries: 0,
    redundantWakes: 0,
    idleCapacityMs: 0,
    duplicateEvidenceSuppressed: 0,
    hardFailureWakes: 0,
    userGateWakes: 0,
    capacityViolations: 0,
    safetyViolations: 0,
  };

  const pushEvent = event => {
    events.push({ ...event, sequence: sequence++ });
  };
  for (const evidence of scenario.evidence || []) pushEvent({ type: 'evidence', at: Number(evidence.at) || 0, evidence });
  pushEvent({ type: 'gate', at: Number(scenario.gateAt) || 0 });

  const sortEvents = () => events.sort((a, b) => a.at - b.at || a.sequence - b.sequence);

  const candidates = () => [...members.values()]
    .map(member => candidateFor(member, policy))
    .filter(Boolean)
    .sort(policy.kind === 'sequential-baseline'
      ? ((a, b) => a.member.index - b.member.index || a.readyAt - b.readyAt)
      : compareCandidates);

  const dispatch = candidate => {
    const member = candidate.member;
    if (member.failureKind === 'hard-provider' || member.failureKind === 'transport') {
      metrics.hardFailureWakes++;
      metrics.safetyViolations++;
      return;
    }
    if (member.status === 'waiting_input' || member.status === 'waiting_edits') {
      metrics.userGateWakes++;
      metrics.safetyViolations++;
      return;
    }
    const delivered = policy.coalesce ? member.inbox.splice(0) : [member.inbox.shift()];
    member.readyAt = member.inbox.length ? Math.min(...member.inbox.map(item => item.at)) : null;
    for (const item of delivered) member.knownFacts.add(item.fact);
    const evidenceIds = delivered.map(item => item.id).sort();
    const wakeKey = `${member.id}:${evidenceIds.join(',')}:${member.priorWakes}`;
    if (member.wakeKeys.has(wakeKey) || !delivered.length) {
      metrics.redundantWakes++;
      metrics.safetyViolations++;
      return;
    }
    member.wakeKeys.add(wakeKey);
    member.priorWakes++;
    member.attempts++;
    member.status = 'running';
    active++;
    if (active > capacity) {
      metrics.capacityViolations++;
      metrics.safetyViolations++;
    }
    metrics.providerCalls++;
    metrics.wakeCalls++;
    const hasRequiredFacts = (member.requiredFacts || []).every(fact => member.knownFacts.has(fact));
    const succeeds = member.succeedOnAttempt !== null
      && member.succeedOnAttempt !== undefined
      && member.attempts >= member.succeedOnAttempt
      && hasRequiredFacts;
    const doneAt = now + Math.max(0, Number(member.wakeDurationMs) || 0);
    pushEvent({ type: 'wake-done', at: doneAt, memberId: member.id, succeeds, wake: member.attempts });
    trace.push({ at: now, action: 'wake', member: member.id, score: Number.isFinite(candidate.score) ? candidate.score : 'baseline', evidence: evidenceIds, wake: member.attempts });
  };

  const schedule = () => {
    const limit = Math.min(capacity, policy.maxDispatchAtOnce);
    while (active < limit) {
      const ready = candidates();
      if (!ready.length) break;
      dispatch(ready[0]);
    }
  };

  const finalizeIfCorrect = () => {
    if (!scenarioCorrect(scenario, members, gateOpen, metrics)) return false;
    if (!policy.directSynthesisHandoff) {
      metrics.providerCalls++;
      now += finalization.collectionMs;
      trace.push({ at: now, action: 'collection-round' });
    }
    metrics.providerCalls++;
    now += finalization.synthesisMs;
    completionAt = now;
    trace.push({ at: now, action: 'verified-complete' });
    return true;
  };

  let guard = 0;
  while (completionAt === null && guard++ < 10000) {
    sortEvents();
    if (!events.length) {
      schedule();
      sortEvents();
      if (!events.length) {
        finalizeIfCorrect();
        break;
      }
    }

    const nextAt = events[0].at;
    const readyCount = candidates().length;
    const usefulSlots = Math.max(0, Math.min(capacity, active + readyCount) - active);
    metrics.idleCapacityMs += usefulSlots * Math.max(0, nextAt - now);
    now = nextAt;
    const batch = [];
    while (events.length && events[0].at === now) batch.push(events.shift());

    for (const event of batch) {
      if (event.type === 'gate') {
        gateOpen = true;
        trace.push({ at: now, action: 'goal-gate-open' });
        continue;
      }
      if (event.type === 'evidence') {
        const evidence = event.evidence;
        const member = members.get(evidence.target);
        if (!member) throw new Error(`Scenario ${scenario.id} sends evidence to unknown member ${evidence.target}.`);
        const evidenceKey = `${evidence.target}:${evidence.id}`;
        if (seenEvidence.has(evidenceKey)) {
          metrics.duplicateEvidenceSuppressed++;
          trace.push({ at: now, action: 'duplicate-suppressed', member: evidence.target, evidence: evidence.id });
          continue;
        }
        seenEvidence.add(evidenceKey);
        member.inbox.push(evidence);
        if (member.readyAt === null) member.readyAt = now;
        trace.push({ at: now, action: 'evidence', member: evidence.target, evidence: evidence.id });
        continue;
      }
      if (event.type === 'wake-done') {
        const member = members.get(event.memberId);
        active = Math.max(0, active - 1);
        if (event.succeeds) {
          member.status = 'completed';
          member.completedAt = now;
          trace.push({ at: now, action: 'wake-succeeded', member: member.id, wake: event.wake });
        } else {
          member.status = 'stalled';
          metrics.failedRetries++;
          trace.push({ at: now, action: 'wake-failed', member: member.id, wake: event.wake });
        }
      }
    }

    if (finalizeIfCorrect()) break;
    schedule();
  }

  if (guard >= 10000) throw new Error(`Scenario ${scenario.id} exceeded the deterministic event guard.`);
  const correct = completionAt !== null && scenarioCorrect(scenario, members, gateOpen, metrics);
  return {
    id: scenario.id,
    correct,
    latencyMs: correct ? completionAt : null,
    ...metrics,
    memberStates: [...members.values()].map(member => ({ id: member.id, status: member.status, wakes: member.priorWakes, attempts: member.attempts })),
    trace,
  };
}

function aggregate(policy, scenarioResults) {
  const latencies = scenarioResults.filter(result => result.correct).map(result => result.latencyMs);
  const sum = key => scenarioResults.reduce((total, result) => total + Number(result[key] || 0), 0);
  return {
    policyId: policy.id,
    scenarios: scenarioResults.length,
    correctnessFailures: scenarioResults.filter(result => !result.correct).length,
    safetyViolations: sum('safetyViolations'),
    totalLatencyMs: latencies.reduce((total, value) => total + value, 0),
    p95LatencyMs: percentile(latencies, 0.95),
    maxLatencyMs: latencies.length ? Math.max(...latencies) : 0,
    providerCalls: sum('providerCalls'),
    wakeCalls: sum('wakeCalls'),
    failedRetries: sum('failedRetries'),
    redundantWakes: sum('redundantWakes'),
    idleCapacityMs: sum('idleCapacityMs'),
    duplicateEvidenceSuppressed: sum('duplicateEvidenceSuppressed'),
  };
}

function evaluatePolicy(policy, corpus = SCENARIOS) {
  const results = corpus.map(scenario => simulateScenario(scenario, policy));
  return { policy, metrics: aggregate(policy, results), results };
}

function rankVector(evaluation) {
  const m = evaluation.metrics;
  const p = evaluation.policy;
  return [
    m.correctnessFailures,
    m.safetyViolations,
    m.p95LatencyMs,
    m.totalLatencyMs,
    m.providerCalls,
    m.failedRetries,
    m.redundantWakes,
    m.idleCapacityMs,
    p.maxAutoWakesPerMember,
    -p.priorWakePenalty,
    p.minRecoveryScore,
  ];
}

function compareEvaluations(a, b) {
  const av = rankVector(a), bv = rankVector(b);
  for (let i = 0; i < av.length; i++) {
    if (av[i] !== bv[i]) return av[i] - bv[i];
  }
  return a.policy.id.localeCompare(b.policy.id);
}

function searchPolicies(corpus = SCENARIOS) {
  const candidates = [];
  for (const minRecoveryScore of SEARCH_SPACE.minRecoveryScore) {
    for (const priorWakePenalty of SEARCH_SPACE.priorWakePenalty) {
      for (const maxAutoWakesPerMember of SEARCH_SPACE.maxAutoWakesPerMember) {
        const id = `nurse-t${minRecoveryScore}-p${priorWakePenalty}-w${maxAutoWakesPerMember}`;
        const policy = makePolicy(id, { minRecoveryScore, priorWakePenalty, maxAutoWakesPerMember });
        candidates.push(evaluatePolicy(policy, corpus));
      }
    }
  }
  candidates.sort(compareEvaluations);
  return { chosen: candidates[0], candidates };
}

function buildReport() {
  const baseline = evaluatePolicy(makePolicy('sequential-baseline'));
  const search = searchPolicies();
  const chosen = search.chosen;
  if (chosen.metrics.correctnessFailures || chosen.metrics.safetyViolations) {
    throw new Error('No correctness-preserving Team Nurse policy exists in the declared search space.');
  }
  const bm = baseline.metrics, cm = chosen.metrics;
  const latencySaved = bm.totalLatencyMs - cm.totalLatencyMs;
  return {
    benchmark: 'team-nurse-virtual-v1',
    claim: 'Fastest feasible recovery policy on the declared deterministic post-initial corpus; not a universal optimality claim.',
    scope: 'Post-initial Links recovery and synthesis. Initial calls are counted; initial service durations and fanout scheduling are excluded.',
    deterministic: true,
    corpus: SCENARIOS.map(scenario => ({ id: scenario.id, description: scenario.description })),
    search: {
      candidates: search.candidates.length,
      dimensions: SEARCH_SPACE,
      correctnessGate: 'all required members complete; zero provider/transport, user-gate, duplicate-wake, or capacity violations',
      rank: ['correctnessFailures', 'safetyViolations', 'p95LatencyMs', 'totalLatencyMs', 'providerCalls', 'failedRetries', 'redundantWakes', 'idleCapacityMs', 'lowerMaxWakes'],
    },
    chosen: {
      policy: {
        minRecoveryScore: chosen.policy.minRecoveryScore,
        priorWakePenalty: chosen.policy.priorWakePenalty,
        maxAutoWakesPerMember: chosen.policy.maxAutoWakesPerMember,
        concurrent: true,
        coalesced: true,
        directSynthesisHandoff: true,
      },
      formula: formulaFor(chosen.policy),
      metrics: cm,
    },
    baseline: {
      policy: 'sequential, one evidence item per wake, collection round before synthesis',
      metrics: bm,
    },
    improvement: {
      totalLatencySavedMs: latencySaved,
      totalLatencyReductionPct: bm.totalLatencyMs ? Number((latencySaved * 100 / bm.totalLatencyMs).toFixed(2)) : 0,
      providerCallsSaved: bm.providerCalls - cm.providerCalls,
      wakeCallsSaved: bm.wakeCalls - cm.wakeCalls,
      failedRetriesAvoided: bm.failedRetries - cm.failedRetries,
      idleCapacityMsAvoided: bm.idleCapacityMs - cm.idleCapacityMs,
    },
    scenarios: chosen.results.map((result, index) => ({
      id: result.id,
      chosen: {
        correct: result.correct,
        latencyMs: result.latencyMs,
        providerCalls: result.providerCalls,
        wakeCalls: result.wakeCalls,
        failedRetries: result.failedRetries,
        idleCapacityMs: result.idleCapacityMs,
      },
      baseline: {
        correct: baseline.results[index].correct,
        latencyMs: baseline.results[index].latencyMs,
        providerCalls: baseline.results[index].providerCalls,
        wakeCalls: baseline.results[index].wakeCalls,
        failedRetries: baseline.results[index].failedRetries,
        idleCapacityMs: baseline.results[index].idleCapacityMs,
      },
    })),
  };
}

function stableReportJson() {
  return JSON.stringify(buildReport(), null, 2);
}

if (require.main === module) {
  const first = stableReportJson();
  const second = stableReportJson();
  if (first !== second) throw new Error('Team Nurse benchmark was not deterministic within one process.');
  const report = JSON.parse(first);
  console.log('Team Nurse deterministic virtual-time benchmark');
  console.log(report.claim);
  console.log(`Scope: ${report.scope}`);
  console.log(`Corpus: ${report.corpus.length} scenarios; grid: ${report.search.candidates} policies`);
  console.log(`Chosen formula: ${report.chosen.formula}`);
  console.log(`Chosen: ${report.chosen.metrics.totalLatencyMs}ms corpus latency, ${report.chosen.metrics.providerCalls} provider calls, ${report.chosen.metrics.wakeCalls} wakes, ${report.chosen.metrics.failedRetries} failed retries`);
  console.log(`Sequential baseline: ${report.baseline.metrics.totalLatencyMs}ms corpus latency, ${report.baseline.metrics.providerCalls} provider calls, ${report.baseline.metrics.wakeCalls} wakes, ${report.baseline.metrics.failedRetries} failed retries`);
  console.log(`Improvement: ${report.improvement.totalLatencyReductionPct}% latency, ${report.improvement.providerCallsSaved} provider calls, ${report.improvement.idleCapacityMsAvoided} idle-capacity-ms avoided`);
  console.log('REPORT_JSON ' + JSON.stringify(report));
}

module.exports = {
  SCENARIOS,
  SEARCH_SPACE,
  makePolicy,
  simulateScenario,
  evaluatePolicy,
  searchPolicies,
  buildReport,
  stableReportJson,
  formulaFor,
};
