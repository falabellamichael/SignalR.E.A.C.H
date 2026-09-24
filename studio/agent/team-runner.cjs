'use strict';

/* Reach Studio — team (crew) orchestration.
 *
 * A team run executes a task through 1..N persona members. Every member runs
 * through the REAL AgentLoop (same tools, run-control protocol, edit review
 * and approval flows) against an ephemeral MemoryStore, so a member is a full
 * agent — not a one-shot completion.
 *
 *   parallel — every member receives the SAME task plus crew awareness (who
 *              else is working, and their role) so outputs complement rather
 *              duplicate. Members run concurrently up to PARALLEL_CONCURRENCY
 *              (a WSL/CPU guard: 8 members each spawning `reach compile` at
 *              once would thrash).
 *   chain    — members run in roster order. Each member receives the FULL
 *              accumulated crew transcript (bounded), not just the previous
 *              hop, so a documenter still sees the auditor's findings.
 *
 *   links    — an open PEER NETWORK: members fan out like parallel, then
 *              talk to each other directly (agent.send/status/await) across
 *              rounds of the runner's wake loop — deciding among themselves
 *              who does what next — until a member declares the task complete
 *              ("LINKS: COMPLETE") or the exchange budget is spent. The
 *              message allowance comes from Settings > Budgeting > Teams.
 *
 * Pause handling is what makes this a working multiagent runtime instead of a
 * batch script: a member that pauses for edit review (waiting_edits) or asks
 * a question (waiting_input) does NOT fail the run. The runner surfaces the
 * pause, waits for the user's decision, then RESUMES that member with the
 * outcome — up to MAX_RESUME_CYCLES per member.
 */

const { RunControl } = require('./run-control.cjs');
const { parseAgentResponse } = require('./agent-response.cjs');
const { AgentNet } = require('./agent-net.cjs');
const { linksCompleteIn } = require('./agent-net.cjs');
const { getRole } = require('./roles.cjs');
const { TeamNurse } = require('./team-nurse.cjs');

const { resolveBudgets, defaults: budgetDefaults, cap } = require('./budgets.cjs');

const PARALLEL_CONCURRENCY = 3;
const MAX_RESUME_CYCLES = 6;
const RELAY_CHAR_BUDGET = 24000;

/* Peer wake turns remain bounded independently of the configured message
 * allowance. Nurse handoffs do not spend peer wake turns; automatic recovery
 * retains its separate novelty gate and per-member recovery cap. */
const LINKS_RATE = 3; // Legacy export; active limits now come from budgets.
const MAX_LINK_ROUNDS = 12;
const MEMBER_LINK_TURNS = 4;
const LINKS_COMPLETION_GRACE_MS = 250;

/*
 * E14: the four Links constants above were previously readable only by editing
 * this file — team-runner already honoured budgets.teamConcurrency and
 * budgets.resumeCycles, so a user who selected "heavy" budgets still got a
 * 12-round cap and 4 turns per member. Each constant is now the DEFAULT of a
 * budgets field, so behaviour is byte-identical until someone changes one.
 *
 * maxLinkRounds / memberLinkTurns / linksRate are hard caps whose 0 means
 * "no cap" (cap() → Infinity). linksCompletionGraceMs keeps 0 as a literal
 * zero — a 0 ms grace is a legitimate "stop peers immediately" choice.
 */
function linksPolicy(budgets) {
  const pick = (key, fallback) => (Number.isSafeInteger(budgets?.[key]) ? budgets[key] : fallback);
  return {
    rate: pick('linksRate', LINKS_RATE),
    maxRounds: cap(pick('maxLinkRounds', MAX_LINK_ROUNDS)),
    memberTurns: cap(pick('memberLinkTurns', MEMBER_LINK_TURNS)),
    graceMs: pick('linksCompletionGraceMs', LINKS_COMPLETION_GRACE_MS),
  };
}
/* Interactive chats may wait forever when requestTimeoutMs is 0. A crew cannot:
 * one silent provider would otherwise prevent every other member from reaching
 * the Links wake/synthesis phase. Preserve any explicit positive deadline and
 * give unlimited settings a finite team-only fallback. */
const TEAM_REQUEST_TIMEOUT_MS = 180000;

/* The stored assistant message keeps its raw agent_status fence; relay only
 * the human-visible text so the next member in a chain gets clean context. */
function cleanOutput(text) {
  try {
    const parsed = parseAgentResponse(text);
    return (parsed.display || parsed.confirm?.question || '').trim();
  } catch {
    return String(text || '').trim();
  }
}

/* A kept-alive Links member has assistant messages from earlier turns. Harvest
 * only the answer produced after the current send/wake began, otherwise a
 * failed provider request can accidentally reuse an older successful answer. */
function assistantTextSince(store, agentId, messageBoundary) {
  const messages = store.get(agentId).messages || [];
  for (let i = messages.length - 1; i >= Math.max(0, messageBoundary); i--) {
    const message = messages[i];
    if (message?.role === 'assistant' && typeof message.content === 'string' && message.content.trim()) {
      return message.content.trim();
    }
  }
  return '';
}

/* Keep the most recent entries within the relay budget. Dropping the OLDEST
 * is right for a pipeline: the latest handoff is what the next member builds
 * on, and the head of the transcript is the raw task (already included). */
function boundedRelay(entries, budget = RELAY_CHAR_BUDGET) {
  const out = [];
  let chars = 0;
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (chars + e.length > cap(budget) && out.length) break;
    out.unshift(e);
    chars += e.length;
  }
  return out.join('\n\n');
}

/* Run `items` through `worker` with at most `limit` in flight. Preserves
 * result order (index-aligned) regardless of completion order. */
async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  const runners = new Array(Math.min(limit, items.length)).fill(0).map(async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await worker(items[i], i);
    }
  });
  await Promise.all(runners);
  return results;
}

class TeamRunner {
  constructor({ team, personas, roles = [], task, projectDir, endpoint, accessKey, defaultModel, memberConnections = null, capabilityStore = null, journal = null, reachExecutor, browserExecutor, sendEvent, requestApproval, requestEditReview, requestTimeoutMs, awaitEditResolution, requestMemberAnswer, concurrency = PARALLEL_CONCURRENCY, budgets = null, agentSettings = {}, auditLog = null, logger = null, jev = null, featureMask = null, soulStore = null }) {
    // SOUL.md + MEMORY.md store (agent/agent-soul.cjs). Every member reads ITS
    // OWN persona's files, keyed by persona id, so one persona carries one soul
    // and one memory into every crew it joins. Null keeps pre-feature behaviour.
    this.soulStore = soulStore;
    this.agentSettings = agentSettings;
    this.jev = jev;
    this.featureMask = featureMask;
    this.budgets = budgets;
    // E14: resolved once per run so every Links read site agrees.
    this.links = linksPolicy(budgets);
    // Shared security audit log: every member runs tools, so every member's
    // sandbox denials must be recorded, not just the orchestrator's.
    this.auditLog = auditLog;
    this.logger = logger;
    this.team = team;
    /* Native tool protocol (OpenAI tool_calls) vs the universal JSON contract.
     * Absent/legacy teams stay on the JSON contract. */
    this.nativeTools = team.toolProtocol === 'native';
    this.personas = personas;            // resolved persona objects in roster order
    this.roles = Array.isArray(roles) ? roles : [];
    this.task = String(task || '');
    this.projectDir = projectDir || '';
    this.endpoint = endpoint;
    this.accessKey = accessKey;
    this.defaultModel = defaultModel;
    /* Per-member endpoint/key/model, resolved ONCE by main.mjs (which owns
     * settings) via agent/team-connections.cjs and indexed by roster position.
     * Teams are the one place that may use MULTIPLE endpoints; the runner itself
     * stays settings-free and just consumes what it is handed. Null (the default,
     * and what direct-construction tests pass) means "one endpoint for the whole
     * crew", the pre-feature behaviour. */
    this.memberConnections = Array.isArray(memberConnections) ? memberConnections : null;
    this.capabilityStore = capabilityStore;
    this.journal = journal;
    this.reachExecutor = reachExecutor;
    this.browserExecutor = browserExecutor;
    this.sendEvent = sendEvent;
    this.requestApproval = requestApproval;
    this.requestEditReview = requestEditReview;
    const requestedTimeout = budgets?.requestTimeoutMs ?? requestTimeoutMs;
    this.requestTimeoutMs = Number.isFinite(requestedTimeout) && requestedTimeout > 0
      ? requestedTimeout
      : TEAM_REQUEST_TIMEOUT_MS;
    this.awaitEditResolution = awaitEditResolution;
    this.requestMemberAnswer = requestMemberAnswer;
    this.concurrency = budgets ? cap(budgets.teamConcurrency) : Math.max(1, Number(concurrency) || PARALLEL_CONCURRENCY);
    this.loops = new Map();              // memberKey -> AgentLoop
    this.memberStores = new Map();       // memberKey -> MemoryStore (for resume)
    this.memberEdits = new Map();        // memberKey -> [edit] proposed this pause cycle
    this.stopped = false;
    this.paused = false;
    this.userPaused = false;
    this.controls = this.personas.map((persona, index) => new RunControl(null, paused => {
      this.net?.syncMember(`m${index}-${persona.id}`, { status: paused ? 'paused' : 'running' });
      this._emit('member-control', { index, name: persona.name, paused });
    }));
    this.running = true;
    this.acceptingRuntimeAgents = false;
    // Resolves when stop() is called so pause waits can race it and unwind.
    this._stopDeferred = null;
    this._linkDeclared = null;   // member declared LINKS: COMPLETE in its answer
    this._linksAnswer = null;    // final crew answer for links runs
    this._linksPreviousSuccesses = []; // usable turns retained if synthesis fails
    this._linksMeta = null;      // rounds / exchanges / completedBy telemetry
    this._linksSuperseded = new Map(); // live peers cancelled after another member completes
    this._linksConclusionTimer = null; // short grace for productive in-flight peers
    this.nurse = null;             // message courier and heuristic supervisor
    this._linksActivityVersion = 0; // event-driven scheduler pulse (no polling timer)
    this._linksActivityLast = null;
    this._linksActivityDeferred = null;
    // Installed only while the Links work-conserving scheduler is alive. An
    // operator-added helper asks this pump for capacity instead of starting an
    // independent AgentNet task outside the roster semaphore.
    this._linksPump = null;
    this._requestLinksWake = null;
  }

  _stopSignal() {
    if (!this._stopDeferred) {
      let resolve;
      const p = new Promise(r => { resolve = r; });
      this._stopDeferred = { promise: p, resolve };
    }
    return this._stopDeferred.promise;
  }

  _signalLinksActivity(activity = {}) {
    this._linksActivityVersion++;
    this._linksActivityLast = activity;
    if (this._linksActivityDeferred) {
      const deferred = this._linksActivityDeferred;
      this._linksActivityDeferred = null;
      deferred.resolve({ version: this._linksActivityVersion, activity });
    }
  }

  _waitForLinksActivity(afterVersion = 0) {
    if (this._linksActivityVersion > afterVersion) {
      return Promise.resolve({ version: this._linksActivityVersion, activity: this._linksActivityLast });
    }
    if (!this._linksActivityDeferred) {
      let resolve;
      const promise = new Promise(r => { resolve = r; });
      this._linksActivityDeferred = { promise, resolve };
    }
    return this._linksActivityDeferred.promise;
  }

  _emit(type, payload = {}) {
    if (type === 'nurse') this.journal?.append('nurse-action', { action: payload.action, index: payload.index, name: payload.name, status: payload.status });
    this.sendEvent('team:event', { teamRunId: this.teamRunId, type, ...payload, at: payload.at ?? Date.now() });
  }

  /**
   * Endpoint / key / model for ONE roster position.
   *
   * Every place that starts or describes a member must go through this, so the
   * `start` event, preRegister and the AgentLoop can never disagree about where a
   * member is running — a mismatch there is invisible until a model 404s.
   *
   * Falls back to the team-wide values when no resolution was supplied (direct
   * construction in tests) or when a member has no usable resolution.
   */
  _memberConn(index) {
    const resolved = this.memberConnections ? this.memberConnections[index] : null;
    if (resolved && resolved.endpoint) {
      return {
        endpoint: resolved.endpoint,
        accessKey: resolved.accessKey || '',
        model: resolved.model || this.defaultModel || 'gpt-4o-mini',
        connectionName: resolved.connectionName || '',
        reason: resolved.reason || '',
      };
    }
    /* Fallback: one endpoint for the whole crew (no resolution supplied, or the
     * member's resolved endpoint was unusable). This must reproduce the
     * PRE-feature model rule — persona.model || defaultModel — because a persona
     * model override is not the same thing as an endpoint resolution: direct
     * callers (and older tests) pass personas with their own models and expect
     * each member to keep it. Dropping it here was the bug that sent every
     * member the team default. */
    const persona = this.personas[index] || null;
    const personaModel = persona ? String(persona.model || '').trim() : '';
    return {
      endpoint: this.endpoint,
      accessKey: this.accessKey,
      model: personaModel || this.defaultModel || 'gpt-4o-mini',
      connectionName: '',
      reason: '',
    };
  }

  roleOf(index) {
    const member = this.team.members[index] || {};
    const spec = getRole(member.roleId);
    return String(member.role || (spec ? spec.name : '') || this.roles[index] || '').trim();
  }

  /* The preset role record (agent/roles.cjs) for a roster position, if set. */
  roleSpecOf(index) {
    const member = this.team.members[index] || {};
    return getRole(member.roleId);
  }

  /* The block that makes a role DO something: the preset protocol, or a
   * directive built from the free-text label — custom roles are behaviors
   * too, not adjectives. Empty for members with no role at all. */
  _roleBlock(index) {
    const spec = this.roleSpecOf(index);
    if (spec) return `YOUR CREW ROLE — ${spec.name} (${spec.tagline}):\n${spec.protocol}`;
    const label = this.roleOf(index);
    if (label) {
      return `YOUR CREW ROLE — ${label}:\nTake this role literally: do the work a ${label} does and produce the artifact a ${label} produces. Coordinate with the other members when your work touches theirs.`;
    }
    return '';
  }

  /* Crew awareness: who else is on the run and what they're for. Without
   * this, parallel members duplicate each other and chain members don't know
   * they're mid-pipeline. */
  _crewContext(index, mode) {
    const roster = this.personas.map((p, i) => {
      const role = this.roleOf(i);
      return `- ${p.name}${role ? ` (${role})` : ''}${i === index ? '  ← YOU' : ''}`;
    }).join('\n');
    const role = this.roleOf(index);
    const you = `You are ${this.personas[index].name}${role ? `, and your role on this crew is: ${role}` : ''}.`;
    const shape = mode === 'chain'
      ? 'You are one member of a crew working in sequence. Earlier members\' work is included below as handoffs — build on it, do not redo it, and do not repeat their output verbatim. Finish YOUR part completely; a later member continues from your answer.'
      : mode === 'links'
        ? 'You are one member of a crew on an OPEN PEER NETWORK. All members work simultaneously and talk to each other directly — asking, handing off, reviewing, challenging — deciding among yourselves who does what next. There is no fixed order: keep peers unblocked, put what they need in front of them, and drive the task to completion together.'
        : 'You are one member of a crew working the SAME task simultaneously. Produce your own complete, self-contained answer from your own perspective and role. Do not assume another member covers a part of it, and do not reference work you cannot see.';
    return `CREW CONTEXT (this run has ${this.personas.length} members, mode: ${mode}):\n${roster}\n\n${you}\n${shape}`;
  }

  async run(teamRunId) {
    this.teamRunId = teamRunId;
    const mode = this.team.mode === 'links' ? 'links' : this.team.mode === 'chain' ? 'chain' : 'parallel';
    this.journal?.append('manifest', { runId: teamRunId, team: { id: this.team.id, name: this.team.name, mode },
      task: this.task, projectDir: this.projectDir,
      members: this.personas.map((persona, index) => ({ id: persona.id, name: persona.name,
        prompt: persona.prompt || '', model: this._memberConn(index).model, role: this.roleOf(index) })) });
    // One network per crew run: roster members register into it, and any of
    // them may spawn/message/await peers through the agent.* collab tools.
    this.net = new AgentNet({
      agentSettings: this.agentSettings,
      jev: this.jev,
      featureMask: this.featureMask,
      teamRunId,
      teamName: this.team.name,
      onSettled: () => {
        // A finished operator helper releases one of the shared Links slots.
        // Refill it immediately rather than waiting for an unrelated roster
        // event. Model-created workers are not counted by this scheduler.
        if (this._linksPump) this._linksPump();
        this.updatePausedState();
        this._signalLinksActivity({ type: 'worker-settled' });
      },
      onActivity: activity => {
        if (mode === 'links' && activity?.linksComplete) {
          this._concludeLinkPeers(activity.from, activity.fromName || String(activity.from || 'crew member'), { includeDeclarer: true });
        }
        if (mode === 'links' && activity?.type === 'operator-helper-queued' && this._linksPump) {
          this._linksPump();
        }
        this._signalLinksActivity(activity);
      },
      endpoint: this.endpoint,
      accessKey: this.accessKey,
      defaultModel: this.defaultModel,
      projectDir: this.projectDir,
      reachExecutor: this.reachExecutor,
      browserExecutor: this.browserExecutor,
      sendEvent: this.sendEvent,
      requestApproval: this.requestApproval,
      requestEditReview: this.requestEditReview,
      awaitEditResolution: this.awaitEditResolution,
      requestMemberAnswer: this.requestMemberAnswer,
      requestTimeoutMs: this.requestTimeoutMs,
      budgets: this.budgets,
      auditLog: this.auditLog,
      logger: this.logger,
      capabilityStore: this.capabilityStore,
      journal: this.journal,
      nativeTools: this.nativeTools,
      /* SOUL.md + MEMORY.md store. Handed to the net so anything a member
       * SPAWNS owns its own pair, derived from the member's persona key — a
       * spawned worker is a full agent, not a second writer to its parent's
       * memory. Null-safe: without a store the worker runs exactly as before. */
      soulStore: this.soulStore,
      /* Links retains roster mail between turns; every crew shares the
       * configured allowance for agent-to-agent messages. */
      rosterMailbox: mode === 'links',
      linkBudget: this.budgets?.messageHandoffs ?? budgetDefaults.messageHandoffs,
    });
    this.nurse = new TeamNurse({
      personas: this.personas, team: this.team, net: this.net,
      enabled: this.team.nurse !== false, policy: this.team.nursePolicy || null,
      emit: (_type, payload) => this._emit('nurse', { ...payload, nurseType: payload.action, silent: true }),
    });
    this.acceptingRuntimeAgents = true;
    this._emit('start', {
      teamName: this.team.name,
      mode,
      /* model comes from _memberConn so the header shows the model each member
       * will ACTUALLY use on its own endpoint, not the team-wide default. */
      members: this.personas.map((p, i) => {
        const conn = this._memberConn(i);
        return {
          index: i,
          agentId: `m${i}-${p.id}`,
          name: p.name,
          model: conn.model,
          role: this.roleOf(i),
          // Lets the UI show "on <connection>" per member, and explain why a pin
          // was ignored (reason: stale-pin / disabled-pin). Never the key.
          connectionName: conn.connectionName,
          connectionReason: conn.reason,
        };
      }),
      task: this.task,
    });
    // Pre-register the whole roster so every member can see and address its
    // peers from its FIRST turn (agent.list / agent.send / agent.status),
    // even chain members that have not started yet.
    this.personas.forEach((p, i) => {
      const conn = this._memberConn(i);
      this.net.preRegister({
        agentId: `m${i}-${p.id}`,
        name: p.name,
        model: conn.model,
        prompt: p.prompt || '',
        depth: 0,
        task: this.task,
        /* Hand the member's routing to the network so anything this member
         * spawns inherits its provider. Without this the subagent would fall
         * back to the crew default endpoint, where the member's model may not
         * exist. The key travels in-process only and is never emitted. */
        endpoint: conn.endpoint,
        accessKey: conn.accessKey,
        ...(conn.connectionId ? { connectionId: conn.connectionId } : {}),
        /* The member's OWN identity (its persona id, not the run-scoped
         * `m<i>-<id>` key): a worker it spawns derives its own key from this,
         * and the roster position must never change which files an agent owns. */
        soulKey: p.id,
      });
    });

    const results = [];
    try {
      if (mode === 'parallel') {
        const settled = await mapWithConcurrency(this.personas, this.concurrency, (p, i) =>
          this._runMember(p, i, this._memberPrompt(i, mode, [])));
        for (const r of settled) results.push(r);
      } else if (mode === 'links') {
        const settled = await this._linksRun();
        for (const r of settled) results.push(r);
      } else {
        const handoffs = [];
        for (let i = 0; i < this.personas.length; i++) {
          if (this.stopped) break;
          const r = await this._runMember(this.personas[i], i, this._memberPrompt(i, mode, handoffs));
          results.push(r);
          if (!r.ok) {
            this._emit('chain-broken', { index: i, name: this.personas[i].name, error: r.error });
            break; // a failed link stops the relay; partial results are kept
          }
          handoffs.push(this._handoffEntry(i, r.output));
        }
      }
      this.acceptingRuntimeAgents = false;
      this._cancelQueuedOperatorAgents('The team finalized before this helper started.');
    } catch (e) {
      this._emit('error', { message: e.message });
    } finally {
      this.acceptingRuntimeAgents = false;
      this._linksPump = null;
      this._requestLinksWake = null;
      this._cancelQueuedOperatorAgents(this.stopped
        ? 'Stopped by you before this helper started.'
        : 'The team finalized before this helper started.');
      // Let members' spawned workers finish, then release the id registry.
      if (this.net) {
        if (!this.stopped) {
          try { await this.net.settle(); } catch { /* workers already torn down */ }
        } else {
          this.net.stop();
        }
        const spawned = this.net.snapshot().filter(s => s.origin === 'spawned');
        if (spawned.length) this._emit('subagents-summary', { count: spawned.length, agents: spawned });
      }
      this.running = false;
    }

    const usableByIndex = new Map();
    for (const result of [...(mode === 'links' ? this._linksPreviousSuccesses : []), ...results]) {
      if (result?.ok && String(result.output || '').trim()) usableByIndex.set(result.index, result);
    }
    const successfulCount = usableByIndex.size;
    const failedCount = results.filter(result => !result.ok && !(mode === 'links'
      && this._linksDone() && result.status === 'skipped')).length;
    const outcome = this.stopped ? 'stopped' : !successfulCount ? 'failed'
      : failedCount ? 'partial' : 'completed';
    // Provider diagnostics belong to member status, never to assistant text.
    // In particular, an all-failed Links run must not manufacture an answer.
    const answer = this.stopped || !successfulCount ? '' : mode === 'chain'
      ? [...results].reverse().find(result => result.ok && result.output)?.output || ''
      : mode === 'links' ? this._linksAnswer || [...usableByIndex.values()]
        .map(result => `【${result.name}】\n${result.output}`).join('\n\n')
        : results.filter(result => result.ok && result.output)
          .map(result => `【${result.name}】\n${result.output}`).join('\n\n');
    this._emit('done', {
      mode,
      stopped: this.stopped,
      outcome,
      successfulCount,
      failedCount,
      results: results.map(r => ({ index: r.index, name: r.name, ok: r.ok, status: r.status || null, error: r.error || null,
        completionReason: r.completionReason || null, chars: (r.output || '').length })),
      answer,
      links: mode === 'links' ? (this._linksMeta || null) : null,
    });
    this.journal?.append('complete', { stopped: this.stopped, memberCount: results.length });
    return results;
  }

  _handoffEntry(index, output) {
    const p = this.personas[index];
    const role = this.roleOf(index);
    return `HANDOFF FROM ${p.name}${role ? ` (${role})` : ''} — crew member ${index + 1}/${this.personas.length}:\n${output}`;
  }

  _memberPrompt(index, mode, handoffs) {
    const parts = [this.task, this._crewContext(index, mode)];
    const role = this._roleBlock(index);
    if (role) parts.push(role);
    if (mode === 'links') parts.push(this._linksBlock());
    if (mode === 'chain' && handoffs.length) {
      parts.push(boundedRelay(handoffs, this.budgets?.relayChars ?? RELAY_CHAR_BUDGET));
    }
    return parts.filter(Boolean).join('\n\n');
  }

  /* Links protocol: the rules of the peer network. Rendering per member so the
   * budget line carries the actual number the crew has to spend. */
  _linksBlock() {
    const budget = cap(this.budgets?.messageHandoffs ?? budgetDefaults.messageHandoffs);
    const peers = this.personas.length - 1;
    return [
      `LINKS MODE — an open peer network, not a pipeline. You have ${peers} peer(s).`,
      '- Talk to peers at ANY time: agent.send (by name) to ask, hand off, review or challenge; agent.status to check on someone; agent.await to block for a peer\'s answer; agent.list for the whole crew.',
      `- Budget: ${Number.isFinite(budget) ? budget + ' agent message handoffs for the whole crew' : 'no application cap on agent message handoffs'}. Nurse and user guidance are exempt. Send what a peer needs EARLY, and prefer one complete message over three fragments.`,
      '- Decide among yourselves: no fixed order. If you need a peer\'s work, message them; if you are blocked, say exactly what would unblock you.',
      '- The task ends when a member declares completion: include the exact line "LINKS: COMPLETE" in a message or in your final answer, once the WHOLE task is done and verified against real evidence. Normally the Coordinator declares; any member may if the Coordinator is absent.',
      '- If the network goes quiet before that, the crew will be asked for a final synthesis — so leave your best evidence in your answers.',
    ].join('\n');
  }

  /* Shared pause/resume drive for one member turn — the first turn and every
   * Links wake-up use the same callbacks, so resume behaviour cannot diverge. */

  /* A failed Links turn is terminal for that turn, but not permanently dead:
   * peers can see the stalled status and revive it by sending new instructions.
   * User waits and explicit Stop retain their distinct meanings. */

  /* Drain a member's Links inbox (messages that arrived between its turns). */

  /* Who synthesizes when nobody declared? The Coordinator if one exists,
   * else the member that talked the most, else the last of the roster. */
  _synthesisIndex() {
    for (let i = 0; i < this.personas.length; i++) {
      if ((this.team.members[i] || {}).roleId === 'coordinator') return i;
    }
    let best = this.personas.length - 1;
    let bestSent = -1;
    if (this.net) {
      for (let i = 0; i < this.personas.length; i++) {
        const rec = this.net.agents.get(`m${i}-${this.personas[i].id}`);
        const sent = rec ? rec.messagesSent : 0;
        if (sent > bestSent) { bestSent = sent; best = i; }
      }
    }
    return best;
  }

  /* The Links engine: fan out like parallel, then keep the conversation
   * alive. Rounds wake exactly the members that have mail; the run ends when
   * completion is declared, the exchange budget is spent, or the network goes
   * quiet (then the Coordinator / busiest member synthesizes the answer). */

  stop() {
    require('./audit-event.cjs').auditEvent(this.auditLog, 'crew.stop', { allowed: true,
      detail: { teamId: this.team?.id || null } });
    this.stopped = true;
    this._signalLinksActivity({ type: 'stop' });
    if (this._linksConclusionTimer) {
      globalThis.clearTimeout(this._linksConclusionTimer);
      this._linksConclusionTimer = null;
    }
    for (const loop of this.loops.values()) loop.stop();
    if (this.net) this.net.stop();
    if (this._stopDeferred) this._stopDeferred.resolve();
  }

  pause() {
    this.userPaused = true;
    this.paused = true;
    for (const control of this.controls) control.pause();
    this.net?.pause();
    this._emit('control', { paused: true });
  }

  resume() {
    this.userPaused = false;
    this.paused = false;
    for (const control of this.controls) control.resume();
    this.net?.resume();
    this._signalLinksActivity({ type: 'resume' });
    this._emit('control', { paused: false });
  }

  controlMember(index, start) {
    if (!Number.isInteger(index) || !this.controls[index]) throw new Error('Team member not found.');
    const control = this.controls[index];
    const rec = this.net?.agents.get(`m${index}-${this.personas[index].id}`);
    if (start && rec?.status === 'stalled') {
      if (!this._requestLinksWake) throw new Error('The team run is no longer accepting recovery turns. Start a new team run.');
      return this._requestLinksWake(index);
    }
    if (control.finished) throw new Error('This member has already finished.');
    if (start) { if (this.net) this.net.paused = false; control.resume(); }
    else control.pause();
    this.updatePausedState();
  }

  members() {
    if (!this.net) return { ok: false, error: 'The team network has not started yet.' };
    const snapshot = this.net.list('__user__');
    return {
      ...snapshot,
      mode: this.team.mode,
      running: this.running && !this.stopped,
      paused: this.paused,
      teamRunId: this.teamRunId,
    };
  }

  messageMember(target, message) {
    if (!this.net || !this.running || this.stopped || !this.acceptingRuntimeAgents || this.team.mode === 'links' && this._linksDone()) return { ok: false, error: 'The team run is finalizing and is no longer accepting messages.' };
    return this.net.sendFromUser({ to: target, message });
  }

  steerMember(target, message, options) {
    if (!this.running || this.stopped || !this.acceptingRuntimeAgents || this.team.mode === 'links' && this._linksDone()) return { ok: false, error: 'The team is finalizing. Your message remains queued.' };
    const member = this.net?.agents.get(target);
    if (this.paused || this.userPaused || member?.control?.paused) return { ok: false, error: 'Team or member is paused. Resume it before steering.' };
    return this.nurse.carryUserMessage(target, message, {
      ...options,
      wake: (rec, packet) => {
        if (this.team.mode !== 'links' || !this._linksPump || rec.origin !== 'roster') return { ok: false, error: 'The Nurse will deliver this when the member starts working.' };
        rec.inbox.push(packet);
        this._signalLinksActivity({ type: 'nurse-user-mail', agentId: rec.id });
        return { ok: true };
      },
    });
  }

  /* Join-this-run-only helper. It is intentionally a spawned network worker,
   * not a mutation of the fixed saved roster: parallel/chain/Links schedulers
   * snapshot roster indexes at dispatch. The worker still has tools, its own
   * tab/control, direct team messaging, and is awaited before run finalization;
   * Links synthesis also incorporates spawned-worker results. */
  addRuntimeAgent({ name, model = '', prompt = '', task = '', role = '', endpoint = '', accessKey = '', connectionId = '', soulKey = '' } = {}) {
    if (this.team.mode !== 'links') return { ok: false, error: 'Run-only agents can join Links teams. Parallel and chain teams have a fixed result roster.' };
    if (!this.net || !this.running || this.stopped || !this.acceptingRuntimeAgents || this._linksDone()) return { ok: false, error: 'The team run is finalizing and is no longer accepting agents.' };
    if (this.paused || this.userPaused) return { ok: false, error: 'Resume the team before adding an agent.' };
    const roleText = String(role || '').trim();
    const instructions = [String(prompt || '').trim(), roleText ? `YOUR ROLE ON THIS RUN: ${roleText}` : ''].filter(Boolean).join('\n\n');
    const assignment = String(task || '').trim() || `Join ${this.team.name} and help complete its active task:\n${this.task}`;
    const result = this.net.spawn({
      name, model, prompt: instructions, task: assignment,
      parentId: null, depth: 0, callerName: 'You', endpoint, accessKey,
      ...(connectionId ? { connectionId } : {}),
      deferStart: true, operatorAdded: true,
      /* A helper adopted FROM a saved persona joins with that persona's own
       * soul and memory: it is the agent the user created, not an anonymous
       * worker. Empty (a hand-typed name) lets the net derive its own key. */
      soulKey,
    });
    if (result.ok) {
      if (this._linksPump) this._linksPump();
      this._signalLinksActivity({ type: 'operator-agent-added', agentId: result.agentId });
    }
    if (!result.ok) return result;
    const liveStatus = this.net.agents?.get(result.agentId)?.status || result.status || '';
    const stillQueued = liveStatus ? liveStatus === 'queued' : result.queued === true;
    return {
      ...result,
      status: liveStatus || (stillQueued ? 'queued' : 'starting'),
      queued: stillQueued,
      transient: true,
      note: stillQueued
        ? 'Joined this run only and queued for team capacity; the saved team roster is unchanged.'
        : 'Joined this run only and started in an available team slot; the saved team roster is unchanged.',
    };
  }

  updatePausedState() {
    this.paused = this.controls.every(c => c.finished || c.paused) && (!this.net || this.net.workersPaused());
    this._emit('control', { paused: this.paused });
  }
}

Object.assign(TeamRunner.prototype,
  require('./team-member-driver.cjs')({ cleanOutput, assistantTextSince, linksCompleteIn, MAX_RESUME_CYCLES }),
  require('./team-inbox.cjs'),
  require('./team-links-loop.cjs')({ cleanOutput, linksCompleteIn }));

module.exports = { TeamRunner, cleanOutput, boundedRelay, mapWithConcurrency, PARALLEL_CONCURRENCY, MAX_RESUME_CYCLES, LINKS_RATE, MAX_LINK_ROUNDS, MEMBER_LINK_TURNS, TEAM_REQUEST_TIMEOUT_MS };
