'use strict';

/* Reach Studio — silent heuristic nurse for Links teams.
 *
 * This is deliberately NOT another model. It spends no inference request on
 * supervision and has no chat turn of its own. It watches terminal member
 * state between Links rounds, moves already-produced evidence to a recoverable
 * stalled member, and prepares one bounded evidence packet for synthesis.
 *
 * Bounded recovery formula (validated by the committed Nurse scenario corpus):
 *   3 stalled + 4 new evidence + 2 protocol
 *   + 1 substantive source + 1 coordinator source - 3 per prior nurse wake
 *   Wake at >= 8. Provider/config/transport failures are -Infinity because
 *   AgentLoop has already spent its bounded transport retries.
 *
 * The novelty gate and two-wake cap matter more than a timer: they prevent a
 * dead provider from becoming a retry storm while making useful recovery
 * event-driven (zero polling interval).
 */

/* E1: a provider that is merely rate limiting must PAUSE a member, not
 * quarantine it for the rest of the run. Rate-limit evidence is therefore split
 * out before the hard-failure test and given its own recoverable class.
 *
 * The predicate is imported rather than re-written: retry.cjs already owns the
 * definition of "the provider is telling us to slow down", and a second regex
 * here would drift from it. It is deliberately narrow — an explicit 429, a
 * Retry-After instruction, or literal rate-limit wording — because the bare
 * `503` in HARD_FAILURE_RE is a locked contract (agent.test.cjs proves a 503
 * provider route quarantines).
 *
 * retry.cjs is a leaf (no engine imports), so this cannot create a cycle. */
const { isRateLimitEvidence } = require('./retry.cjs');
const HARD_FAILURE_RE = /(?:endpoint returned http\s+[45]\d\d|\b(?:401|403|404|408|422|429|500|502|503|504)\b|quota|rate[ -]?limit|no backend|model[^\n]*(?:not found|unavailable)|service unavailable|invalid[^\n]*(?:api[ -]?key|access[ -]?key|token)|unauthori[sz]ed|forbidden|billing|insufficient[^\n]*(?:credit|fund)|model request exceeded|request timed out|timeout[^\n]*seconds)/i;
const TRANSIENT_FAILURE_RE = /(?:econn|fetch failed|socket|network|connection (?:closed|reset)|temporar)/i;
const PROTOCOL_FAILURE_RE = /(?:usable action|structured recovery|invalid[^\n]*action|action[^\n]*(?:schema|protocol)|round limit|executable actions)/i;

const DEFAULT_NURSE_POLICY = Object.freeze({
  minRecoveryScore: 8,
  maxAutoWakesPerMember: 2,
  maxSourceChars: 5000,
  maxSynthesisChars: 18000,
  priorWakePenalty: 3,
});

const NURSE_FORMULA = '3*stalled + 4*newEvidence + 2*protocol + 1*substantive + 1*coordinator - 3*priorWakes; wake>=8; providerOrTransport=-Infinity; rateLimited=recoverable';

/*
 * Order matters. Rate-limit evidence is checked FIRST because HARD_FAILURE_RE
 * also matches `429` and `rate limit`, and a rate limit is the one "hard" text
 * that is genuinely temporary: quarantining on it throws away a perfectly good
 * crew member for a condition that clears on its own.
 *
 * A `503` with no rate-limit evidence still falls through to hard-provider, so
 * a dead provider route is not retried forever by the Nurse.
 */
function classifyFailure(error) {
  const text = String(error || '');
  if (isRateLimitEvidence({ message: text })) {
    // AgentLoop has already spent its bounded provider retries by the time a
    // terminal diagnostic reaches the Nurse. Do not wake a member into the
    // same provider limit again; the bounded run has now failed hard.
    if (/retry limit reached/i.test(text)) return 'hard-provider';
    return 'rate-limited';
  }
  if (HARD_FAILURE_RE.test(text)) return 'hard-provider';
  if (PROTOCOL_FAILURE_RE.test(text)) return 'protocol';
  if (TRANSIENT_FAILURE_RE.test(text)) return 'transport';
  return 'recoverable';
}

function fingerprint(value) {
  const text = String(value || '');
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function recoveryScore({ failureKind, priorWakes = 0, sourceChars = 0, sourceIsCoordinator = false, hasNewEvidence = false } = {}, policy = DEFAULT_NURSE_POLICY) {
  if (failureKind === 'hard-provider' || failureKind === 'transport' || !hasNewEvidence) return Number.NEGATIVE_INFINITY;
  // E1: a rate limit is recoverable, so it is scored like protocol work. The
  // status is also marked so the UI can explain WHY a member paused.
  return 3
    + 4
    + (failureKind === 'protocol' ? 2 : 0)
    + (sourceChars >= 160 ? 1 : 0)
    + (sourceIsCoordinator ? 1 : 0)
    - priorWakes * policy.priorWakePenalty;
}

class TeamNurse {
  constructor({ personas = [], team = {}, net = null, emit = () => {}, policy = null, enabled = true } = {}) {
    this.personas = personas;
    this.team = team;
    this.net = net;
    this.emit = emit;
    this.enabled = enabled !== false;
    this.policy = { ...DEFAULT_NURSE_POLICY, ...(policy || {}) };
    this.wakes = new Map();
    this.deliveries = new Set();
    this.quarantined = new Set();
    this.stats = { pulses: 0, stagedWakes: 0, wakeStarted: 0, wakeSucceeded: 0, handoffs: 0, quarantined: 0, suppressed: 0 };
  }

  _agentId(index) {
    const persona = this.personas[index];
    return persona ? `m${index}-${persona.id}` : '';
  }

  _isCoordinator(index) {
    return (this.team.members?.[index] || {}).roleId === 'coordinator';
  }

  _sourcePacket(targetIndex, results, failureKind, priorWakes) {
    const candidates = (results || [])
      .map((result, index) => ({ result, index }))
      .filter(({ result, index }) => index !== targetIndex && result?.ok && String(result.output || '').trim())
      .map(({ result, index: fallbackIndex }) => {
        const index = Number.isInteger(result.index) ? result.index : fallbackIndex;
        const output = String(result.output || '').trim();
        const sourceIsCoordinator = this._isCoordinator(index);
        return {
          ...result,
          index,
          output,
          sourceIsCoordinator,
          score: recoveryScore({
            failureKind,
            priorWakes,
            sourceChars: output.length,
            sourceIsCoordinator,
            hasNewEvidence: true,
          }, this.policy),
        };
      });
    candidates.sort((a, b) => {
      if (a.score !== b.score) return b.score - a.score;
      const time = Number(b.completedAt || 0) - Number(a.completedAt || 0);
      if (time) return time;
      return a.index - b.index;
    });
    const seenContent = new Set();
    const distinct = candidates.filter(source => {
      const key = fingerprint(source.output);
      if (seenContent.has(key)) return false;
      seenContent.add(key);
      return true;
    });
    if (!distinct.length) return null;

    const blocks = [];
    const includedSources = [];
    const evidenceParts = [];
    let chars = 0;
    for (const source of distinct) {
      const label = `FROM ${source.name || `member ${source.index + 1}`}\n`;
      const available = this.policy.maxSourceChars - chars - label.length;
      if (available <= 0) break;
      const deliveredEvidence = source.output.slice(0, available);
      const block = label + deliveredEvidence;
      blocks.push(block);
      includedSources.push(source);
      evidenceParts.push(deliveredEvidence);
      chars += block.length + 2;
    }
    if (!blocks.length) return null;
    const output = blocks.join('\n\n');
    return {
      sources: includedSources,
      anchor: includedSources[0],
      output,
      chars,
      sourceIsCoordinator: includedSources.some(source => source.sourceIsCoordinator),
      evidenceKey: fingerprint(evidenceParts.join('\n\u241e\n')),
    };
  }

  _recoveryMessage(targetIndex, packet, error) {
    const target = this.personas[targetIndex];
    const sourceNames = packet.sources.map(source => source.name || `member ${source.index + 1}`).join(', ');
    return [
      'TEAM NURSE RECOVERY — silent orchestration handoff.',
      `Your previous turn stalled: ${String(error || 'no usable completed action').slice(0, 800)}`,
      `New completed evidence from ${sourceNames}:`,
      packet.output,
      `Resume the original task as ${target?.name || 'this team member'}. Use the new evidence, do only the remaining useful work, and send concrete results to the peer who needs them. Do not repeat the failed response.`,
    ].join('\n\n');
  }

  stageRecoveries({ results = [], stalled = new Map(), turns = [], maxTurns = Infinity } = {}) {
    this.stats.pulses++;
    if (!this.enabled || !this.net) return [];
    if (this.net.paused) {
      if (stalled.size) this.stats.suppressed += stalled.size;
      return [];
    }
    const planned = [];
    for (const [index, error] of stalled) {
      const agentId = this._agentId(index);
      const rec = this.net.agents.get(agentId);
      if (!rec) continue;
      if (rec.control?.paused || ['waiting_input', 'waiting_edits', 'stopped'].includes(rec.status)) {
        this.stats.suppressed++;
        continue;
      }
      if ((rec.inbox || []).length) {
        this.stats.suppressed++;
        continue; // a real teammate already supplied a better, intentional wake
      }
      const priorWakes = this.wakes.get(index) || 0;
      if (priorWakes >= this.policy.maxAutoWakesPerMember || Number(turns[index] || 0) >= maxTurns) {
        this.stats.suppressed++;
        continue;
      }
      const failureKind = classifyFailure(error);
      if (failureKind === 'hard-provider' || failureKind === 'transport') {
        if (!this.quarantined.has(index)) {
          this.quarantined.add(index);
          this.stats.quarantined++;
          this.emit('nurse', { action: 'quarantine', index, name: this.personas[index]?.name || rec.name, failureKind });
        }
        continue;
      }
      const packet = this._sourcePacket(index, results, failureKind, priorWakes);
      if (!packet) continue; // retrying without new information is churn, not nursing
      const evidenceId = `${index}:${packet.evidenceKey}`;
      if (this.deliveries.has(evidenceId)) {
        this.stats.suppressed++;
        continue;
      }
      const score = recoveryScore({
        failureKind,
        priorWakes,
        sourceChars: packet.chars,
        sourceIsCoordinator: packet.sourceIsCoordinator,
        hasNewEvidence: true,
      }, this.policy);
      if (score < this.policy.minRecoveryScore) {
        this.stats.suppressed++;
        continue;
      }
      const message = this._recoveryMessage(index, packet, error);
      rec.inbox = rec.inbox || [];
      rec.inbox.push(message);
      rec.messagesReceived++;
      this.deliveries.add(evidenceId);
      this.wakes.set(index, priorWakes + 1);
      this.stats.stagedWakes++;
      const action = {
        action: 'wake-staged', index, name: this.personas[index]?.name || rec.name,
        sourceIndex: packet.anchor.index, sourceName: packet.anchor.name,
        sourceNames: packet.sources.map(source => source.name), failureKind, score,
        inbox: rec.inbox.length, nurseWakes: priorWakes + 1,
      };
      planned.push(action);
      this.emit('nurse', action);
    }
    return planned;
  }

  recordWakeStarted(index) {
    this.stats.wakeStarted++;
    this.emit('nurse', { action: 'wake-started', index, name: this.personas[index]?.name || '', nurseWakes: this.wakes.get(index) || 0 });
  }

  recordWakeResult(index, result) {
    if (result?.ok) this.stats.wakeSucceeded++;
    this.emit('nurse', {
      action: result?.ok ? 'wake-succeeded' : 'wake-failed',
      index,
      name: this.personas[index]?.name || '',
      status: result?.status || 'unknown',
      nurseWakes: this.wakes.get(index) || 0,
    });
  }

  synthesisHandoff(results = [], stalled = new Map(), workers = [], pendingMail = []) {
    if (!this.enabled) return '';
    const blocks = [];
    for (let index = 0; index < results.length; index++) {
      const result = results[index];
      if (!result) continue;
      if (result.ok && String(result.output || '').trim()) {
        blocks.push(`【${result.name} · completed】\n${String(result.output).slice(0, this.policy.maxSourceChars)}`);
      } else {
        const error = stalled.get(index) || result.error || 'no completed answer';
        blocks.push(`【${result.name} · ${result.status || 'failed'}】\nUnavailable: ${String(error).slice(0, 1000)}`);
      }
    }
    for (const worker of workers || []) {
      if (worker?.status !== 'completed' || !String(worker.output || '').trim()) continue;
      blocks.push(`【${worker.name || worker.agentId || 'Worker'} · completed worker】\n${String(worker.output).slice(0, this.policy.maxSourceChars)}`);
    }
    for (const pending of pendingMail || []) {
      const messages = (pending?.messages || []).map(String).filter(Boolean).join('\n\n');
      if (!messages) continue;
      blocks.push(`【${pending.name || 'Member'} · queued crew information】\n${messages.slice(0, this.policy.maxSourceChars)}`);
    }
    if (!blocks.length) return '';
    const kept = [];
    let chars = 0;
    for (let index = blocks.length - 1; index >= 0; index--) {
      const block = blocks[index];
      if (chars + block.length > this.policy.maxSynthesisChars && kept.length) continue;
      kept.unshift(block);
      chars += block.length;
    }
    this.stats.handoffs += kept.length;
    this.emit('nurse', { action: 'handoff', count: kept.length, chars, silent: true });
    return `TEAM NURSE HANDOFF — current member results are supplied directly so you do not need an agent.list/status round merely to collect them:\n\n${kept.join('\n\n')}`;
  }

  meta() {
    return { enabled: this.enabled, formula: NURSE_FORMULA, policy: { ...this.policy }, ...this.stats };
  }
}

module.exports = {
  TeamNurse,
  DEFAULT_NURSE_POLICY,
  NURSE_FORMULA,
  classifyFailure,
  recoveryScore,
  fingerprint,
};
