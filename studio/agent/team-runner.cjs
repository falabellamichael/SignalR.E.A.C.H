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
 *              budget is 3× a chain crew's exchange rate (3·(N−1) messages).
 *
 * Pause handling is what makes this a working multiagent runtime instead of a
 * batch script: a member that pauses for edit review (waiting_edits) or asks
 * a question (waiting_input) does NOT fail the run. The runner surfaces the
 * pause, waits for the user's decision, then RESUMES that member with the
 * outcome — up to MAX_RESUME_CYCLES per member.
 */

const { AgentLoop } = require('./agent-loop.cjs');
const { MemoryStore } = require('./memory-store.cjs');
const { RunControl } = require('./run-control.cjs');
const { parseAgentResponse } = require('./agent-response.cjs');
const { AgentNet } = require('./agent-net.cjs');
const { linksCompleteIn } = require('./agent-net.cjs');
const { TeamNurse } = require('./team-nurse.cjs');
const { getRole } = require('./roles.cjs');
const { runToTerminal, MAX_RESUME_CYCLES: DRIVER_MAX_CYCLES } = require('./pause-resume.cjs');

const { resolveBudgets, cap } = require('./budgets.cjs');

const PARALLEL_CONCURRENCY = 3;
const MAX_RESUME_CYCLES = 6;
const RELAY_CHAR_BUDGET = 24000;

/* Links mode: the crew conversation allowance is 3× what a chain run would
 * exchange (N−1 serial handoffs) — "triple the chain rate" — and every member
 * may be re-woken for at most MEMBER_LINK_TURNS extra turns to answer its
 * inbox. MAX_LINK_ROUNDS is a hard safety stop on top of both. */
const LINKS_RATE = 3;
const MAX_LINK_ROUNDS = 12;
const MEMBER_LINK_TURNS = 4;
const LINKS_COMPLETION_GRACE_MS = 250;
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
  constructor({ team, personas, roles = [], task, projectDir, endpoint, accessKey, defaultModel, memberConnections = null, reachExecutor, browserExecutor, sendEvent, requestApproval, requestEditReview, requestTimeoutMs, awaitEditResolution, requestMemberAnswer, concurrency = PARALLEL_CONCURRENCY, budgets = null, agentSettings = {}, auditLog = null, jev = null, featureMask = null }) {
    this.agentSettings = agentSettings;
    this.jev = jev;
    this.featureMask = featureMask;
    this.budgets = budgets;
    // Shared security audit log: every member runs tools, so every member's
    // sandbox denials must be recorded, not just the orchestrator's.
    this.auditLog = auditLog;
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
    this._linksMeta = null;      // rounds / exchanges / completedBy telemetry
    this._linksSuperseded = new Map(); // live peers cancelled after another member completes
    this._linksConclusionTimer = null; // short grace for productive in-flight peers
    this.nurse = null;             // heuristic, no-model Links supervisor
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
      nativeTools: this.nativeTools,
      /* Links owns the crew conversation: roster members accept messages
       * between turns, and the total exchange count is capped at 3× a chain
       * crew's rate. Both options are inert in the other modes. */
      rosterMailbox: mode === 'links',
      linkBudget: mode === 'links' ? LINKS_RATE * Math.max(1, this.personas.length - 1) : null,
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

    this._emit('done', {
      mode,
      stopped: this.stopped,
      results: results.map(r => ({ index: r.index, name: r.name, ok: r.ok, status: r.status || null, error: r.error || null,
        completionReason: r.completionReason || null, chars: (r.output || '').length })),
      // The crew answer: chain → last successful output; parallel → all outputs.
      answer: mode === 'chain'
        ? (results.length && results[results.length - 1].ok ? results[results.length - 1].output : '')
        : mode === 'links'
          ? (this._linksAnswer || results.map(r => `【${r.name}】\n${r.ok ? r.output : '(failed: ' + (r.error || 'unknown') + ')'}`).join('\n\n'))
          : results.map(r => `【${r.name}】\n${r.ok ? r.output : '(failed: ' + (r.error || 'unknown') + ')'}`).join('\n\n'),
      links: mode === 'links' ? (this._linksMeta || null) : null,
    });
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
    const budget = LINKS_RATE * Math.max(1, this.personas.length - 1);
    const peers = this.personas.length - 1;
    return [
      `LINKS MODE — an open peer network, not a pipeline. You have ${peers} peer(s).`,
      '- Talk to peers at ANY time: agent.send (by name) to ask, hand off, review or challenge; agent.status to check on someone; agent.await to block for a peer\'s answer; agent.list for the whole crew.',
      `- Budget: the crew gets ${budget} messages in total (3× what a chain crew would exchange). Spend them where they change the outcome — send what a peer needs EARLY, and prefer one complete message over three fragments.`,
      '- Decide among yourselves: no fixed order. If you need a peer\'s work, message them; if you are blocked, say exactly what would unblock you.',
      '- The task ends when a member declares completion: include the exact line "LINKS: COMPLETE" in a message or in your final answer, once the WHOLE task is done and verified against real evidence. Normally the Coordinator declares; any member may if the Coordinator is absent.',
      '- If the network goes quiet before that, the crew will be asked for a final synthesis — so leave your best evidence in your answers.',
    ].join('\n');
  }

  /* Shared pause/resume drive for one member turn — the first turn and every
   * Links wake-up use the same callbacks, so resume behaviour cannot diverge. */
  async _drive(key, index, persona, model, prompt, control) {
    const store = this.memberStores.get(key);
    const messageBoundary = store.get(key).messages.length;
    const end = await runToTerminal({
      loop: this.loops.get(key),
      store,
      agentId: key,
      firstPrompt: prompt,
      control,
      maxCycles: cap(this.budgets?.resumeCycles ?? MAX_RESUME_CYCLES),
      isStopped: () => this.stopped,
      stopSignal: () => this._stopSignal(),
      getPendingEdits: () => this.memberEdits.get(key) || [],
      clearPendingEdits: () => this.memberEdits.set(key, []),
      awaitEditResolution: this.awaitEditResolution,
      requestMemberAnswer: this.requestMemberAnswer
        ? (q) => this.requestMemberAnswer({ ...q, agentId: key, index, name: persona.name, model })
        : null,
      onWaiting: (edits) => this._emit('member-waiting', {
        index, name: persona.name, status: 'waiting_edits',
        edits: edits.map(e => ({ editId: e.editId, path: e.path, stats: e.stats })),
      }),
      onQuestion: (questionId, question) => this._emit('member-question', { index, name: persona.name, questionId, question }),
      onResumed: (cycle, status) => this._emit('member-resumed', { index, name: persona.name, cycle, status }),
    });
    return { ...end, messageBoundary };
  }

  async _runMember(persona, index, prompt, { keep = false } = {}) {
    const key = `m${index}-${persona.id}`;
    const store = new MemoryStore();
    Object.assign(store.get(key).settings, structuredClone(this.agentSettings));
    /* THIS is the per-member routing that makes Teams the multi-endpoint case.
     * Before this, every member shared one endpoint/accessKey and only the model
     * varied, so a member whose model lived on another provider would 404.
     * _memberConn falls back to the team-wide values when nothing was resolved,
     * so single-endpoint teams behave exactly as they did. */
    const conn = this._memberConn(index);
    const model = conn.model;
    const loop = new AgentLoop({
      agentId: key,
      store,
      endpoint: conn.endpoint,
      accessKey: conn.accessKey,
      model,
      projectDir: this.projectDir,
      reachExecutor: this.reachExecutor,
      browserExecutor: this.browserExecutor,
      personaPrompt: persona.prompt || '',
      requestTimeoutMs: this.requestTimeoutMs,
      budgets: this.budgets,
      jev: this.jev,
      featureMask: this.featureMask,
      auditLog: this.auditLog,
      nativeTools: this.nativeTools,
      sendEvent: (_channel, payload) => {
        // Tag every loop event with member identity and forward it.
        // Field order matters: spread the inner event FIRST, then override
        // type/index/name — otherwise the inner type clobbers 'member'.
        if (!payload || payload.agentId !== key) return;
        const { agentId, ...rest } = payload;
        this.sendEvent('team:event', {
          ...rest,
          teamRunId: this.teamRunId,
          type: 'member',
          memberType: rest.type,
          index,
          name: persona.name,
          model,
        });
      },
      requestApproval: this.requestApproval
        ? (payload) => this.requestApproval({ ...payload, memberName: persona.name, memberIndex: index })
        : undefined,
      requestEditReview: this.requestEditReview
        ? (edit) => {
            // Track per member so the pause resolver knows what to await.
            const list = this.memberEdits.get(key) || [];
            list.push(edit);
            this.memberEdits.set(key, list);
            this.requestEditReview({ ...edit, memberName: persona.name, memberIndex: index, memberKey: key });
          }
        : undefined,
    });
    this.loops.set(key, loop);
    const control = this.controls[index];
    control.loop = loop;
    this.memberStores.set(key, store);
    // Join the crew net: attach the live loop to the pre-registered record so
    // peers can message/await it, and deliver anything buffered while pending.
    let fullPrompt = prompt;
    if (this.net) {
      const rec = this.net.attach(key, loop, store);
      if (rec) {
        rec.control = control;
        rec.status = control.paused ? 'paused' : 'running';
        const inbox = rec.inbox || [];
        rec.inbox = [];
        if (inbox.length) {
          fullPrompt = `${prompt}\n\nMESSAGES WAITING FOR YOU (from crew members, deliver before finishing):\n${inbox.join('\n\n')}`;
        }
      }
    }
    this._emit('member-start', { index, name: persona.name, model, role: this.roleOf(index), promptChars: fullPrompt.length });
    let last = { index, name: persona.name, model, ok: false, output: '', status: 'error', error: 'member did not run' };
    try {
      const end = await this._drive(key, index, persona, model, fullPrompt, control);
      last = this._asLinksResult(this._harvest(key, store, persona, index, model, end.error, end.messageBoundary));
      last.completedAt = Date.now();
      this._emit('member-done', { index, name: persona.name, ok: last.ok, chars: last.output.length, status: last.status, error: last.error, completionReason: last.completionReason });
      return last;
    } catch (e) {
      last = this._asLinksResult({ index, name: persona.name, model, ok: false, output: '', status: 'error', error: e.message });
      last.completedAt = Date.now();
      this._emit('member-done', { index, name: persona.name, ok: false, status: last.status, error: e.message });
      return last;
    } finally {
      control.finished = true;
      /* Links rounds re-use the member's loop/store across wake-ups; single
       * turn modes release them here as always. */
      if (!keep) {
        this.loops.delete(key);
        this.memberStores.delete(key);
      }
      // Keep the crew net's view of this member truthful so peers that
      // agent.status / agent.await it see the real terminal state.
      if (this.net) {
        this.net.syncMember(key, { status: last.status, error: last.error, output: last.output });
      }
      this.updatePausedState();
    }
  }

  /* Read the member's terminal state + cleaned answer out of its store.
   * driverError: the pause/resume driver's failure reason, if any (it knows
   * why a resume chain ended; runState alone can't tell those apart). */
  _harvest(key, store, persona, index, model, driverError = null, messageBoundary = 0) {
    const output = cleanOutput(assistantTextSince(store, key, messageBoundary));
    if (output && linksCompleteIn(output) && !this._linkDeclared) {
      this._linkDeclared = { by: persona.name, index };
      this._concludeLinkPeers(key, persona.name);
    }
    const completedByPeer = this._linksSuperseded.get(key);
    if (completedByPeer) {
      return {
        index, name: persona.name, model, ok: true, output,
        status: 'completed', error: null,
        completionReason: `Links completed by ${completedByPeer}`,
      };
    }
    const runState = store.get(key).runState;
    const status = runState?.status || 'unknown';
    const ok = !this.stopped && !!output && status === 'completed' && !driverError;
    const error = ok
      ? null
      : (this.stopped ? 'Stopped by you.' : driverError || runState?.reason || `Member ${status}; no completed answer.`);
    return { index, name: persona.name, model, ok, output, status, error, question: runState?.reason || null };
  }

  /* A failed Links turn is terminal for that turn, but not permanently dead:
   * peers can see the stalled status and revive it by sending new instructions.
   * User waits and explicit Stop retain their distinct meanings. */
  _asLinksResult(result) {
    if (this.team.mode !== 'links' || !result || result.ok) return result;
    if (['waiting_input', 'waiting_edits', 'stopped'].includes(result.status)) return result;
    return { ...result, status: 'stalled' };
  }

  /* ---------- LINKS mode: the peer network ---------- */

  _operatorHelpers(status) {
    if (!this.net) return [];
    return [...this.net.agents.values()].filter(rec =>
      rec.origin === 'spawned'
      && rec.operatorAdded === true
      && (!status || rec.status === status));
  }

  _activeOperatorHelperCount() {
    const terminal = new Set(['completed', 'failed', 'stopped', 'abandoned', 'stalled', 'skipped']);
    return this._operatorHelpers().filter(rec =>
      !terminal.has(rec.status) && this.net.activeTasks.has(rec.id)).length;
  }

  _cancelQueuedOperatorAgents(reason) {
    if (!this.net?.cancelQueuedSpawned) return 0;
    let cancelled = 0;
    for (const rec of this._operatorHelpers('queued')) {
      if (this.net.cancelQueuedSpawned(rec.id, reason)) cancelled++;
    }
    return cancelled;
  }

  /* A completion declaration is terminal for the whole peer network, but an
   * immediate abort can cut off a peer between a successful tool result and
   * its final response. Give active peers one short grace window, then abort
   * anything still hanging (including endpoints that never send headers).
   * This is not a user Stop and is reported as successful team completion. */
  _concludeLinkPeers(declarerKey, declarerName, { includeDeclarer = false } = {}) {
    // Completion is terminal for operator admission too. Do not accept mail or
    // launch paid helper work during the short grace used only to harvest
    // already-running peers.
    this.acceptingRuntimeAgents = false;
    this._cancelQueuedOperatorAgents('Links completed before this helper started.');
    if (this._linksConclusionTimer) return;
    this._linksConclusionTimer = setTimeout(() => {
      this._linksConclusionTimer = null;
      for (const [key, loop] of this.loops) {
        if ((!includeDeclarer && key === declarerKey) || !loop.running) continue;
        this._linksSuperseded.set(key, declarerName);
        loop.stop();
      }
    }, LINKS_COMPLETION_GRACE_MS);
  }

  /* Completion declared? By a member in its own answer (this._linkDeclared)
   * or in a message to a peer (net.linksComplete set on send). */
  _linksDone() {
    return this._linkDeclared || (this.net ? this.net.linksComplete : null);
  }

  /* Drain a member's Links inbox (messages that arrived between its turns). */
  _takeLinkInbox(index) {
    if (!this.net) return [];
    const rec = this.net.agents.get(`m${index}-${this.personas[index].id}`);
    if (!rec || !Array.isArray(rec.inbox) || !rec.inbox.length) return [];
    const box = rec.inbox.slice();
    rec.inbox = [];
    return box;
  }

  _restoreLinkInbox(index, messages) {
    if (!this.net || !messages?.length) return;
    const rec = this.net.agents.get(`m${index}-${this.personas[index].id}`);
    if (!rec) return;
    rec.inbox = [...messages, ...(rec.inbox || [])];
  }

  /* Wake a member for one more Links turn, re-using the SAME loop + store so
   * the member keeps its full conversation and everything it learned. */
  async _wakeMember(index, inbox, { synthesize = false, note = '', handoff = '' } = {}) {
    const persona = this.personas[index];
    const key = `m${index}-${persona.id}`;
    const store = this.memberStores.get(key);
    const conn = this._memberConn(index);
    if (!store || !this.loops.has(key)) {
      return { index, name: persona.name, model: conn.model, ok: false, output: '', status: 'error', error: 'Member loop was not kept alive for the Links round.' };
    }
    const control = this.controls[index];
    control.finished = false;
    // A queued Links batch may outlive the first active wake. If the user
    // pauses while another slot is still pending, do not let that later item
    // begin a provider request just because its previous turn was marked
    // finished (RunControl.pause intentionally ignores finished controls).
    if (this.userPaused) control.pause();
    await control.wait(() => this._stopSignal());
    if (this.stopped) {
      control.finished = true;
      return { index, name: persona.name, model: conn.model, ok: false, output: '', status: 'stopped', error: 'Stopped by you.', completedAt: Date.now(), wakeDeferred: true };
    }
    const parts = [`Original task:\n${this.task}`, this._crewContext(index, 'links')];
    const role = this._roleBlock(index);
    if (role) parts.push(role);
    parts.push(this._linksBlock());
    if (synthesize) {
      if (handoff) {
        parts.push(handoff);
        parts.push(`${note} You are asked for the FINAL SYNTHESIS: use the Team Nurse handoff above as the current crew state. Call agent.list / agent.status only if something is genuinely missing, then write the definitive answer to the original task now. State clearly what is DONE (with evidence), what is NOT, and what each unfinished piece still needs.`);
      } else {
        parts.push(`${note} You are asked for the FINAL SYNTHESIS: use the real crew state and agent.list / agent.status to collect any missing peer results, then write the definitive answer to the original task now. State clearly what is DONE (with evidence), what is NOT, and what each unfinished piece still needs.`);
      }
    } else {
      parts.push(`LINK MESSAGES from the crew (deliver on them, then continue your role's work):\n${inbox.join('\n\n')}`);
    }
    const prompt = parts.filter(Boolean).join('\n\n');
    this._emit('member-start', { index, name: persona.name, model: conn.model, role: this.roleOf(index), promptChars: prompt.length, retake: true });
    if (this.net) {
      const rec = this.net.agents.get(key);
      if (rec) rec.status = control.paused ? 'paused' : 'running';
    }
    let last;
    try {
      const end = await this._drive(key, index, persona, conn.model, prompt, control);
      last = this._asLinksResult(this._harvest(key, store, persona, index, conn.model, end.error, end.messageBoundary));
    } catch (e) {
      last = this._asLinksResult({ index, name: persona.name, model: conn.model, ok: false, output: '', status: 'error', error: e.message });
    }
    last.completedAt = Date.now();
    this._emit('member-done', { index, name: persona.name, ok: last.ok, chars: last.output.length, status: last.status, error: last.error, completionReason: last.completionReason, retake: true });
    if (this.net) this.net.syncMember(key, { status: last.status, error: last.error, output: last.output });
    control.finished = true;
    this.updatePausedState();
    return last;
  }

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
  async _linksRun() {
    const n = this.personas.length;
    const budget = LINKS_RATE * Math.max(1, n - 1);
    const results = new Array(n);
    const turns = new Array(n).fill(0);
    // A failed turn stalls the member. Peers carry on, but an explicit message
    // to that member is a bounded recovery signal: the next Links round wakes
    // it with the new instruction instead of silently leaving mail undelivered.
    const stalled = new Map();
    const nurse = new TeamNurse({
      personas: this.personas,
      team: this.team,
      net: this.net,
      enabled: this.team.nurse !== false,
      policy: this.team.nursePolicy || null,
      emit: (_type, payload) => this._emit('nurse', { ...payload, nurseType: payload.action, silent: true }),
    });
    this.nurse = nurse;
    const noteStall = (index, error) => {
      stalled.set(index, error || 'member stalled');
      this.net?.syncMember(`m${index}-${this.personas[index].id}`, { status: 'stalled', error: stalled.get(index) });
      this._emit('links-stall', { index, name: this.personas[index].name, error: stalled.get(index) });
    };

    /* One event-driven pool owns both initial turns and Links wake-ups. The old
     * pair of mapWithConcurrency barriers left fast, recoverable members idle
     * behind one unrelated provider timeout. Here every settlement immediately
     * pulses the Nurse and refills any free slot, while the same concurrency,
     * message, round, and per-member turn caps remain in force. */
    const maxTurns = MEMBER_LINK_TURNS + 1;
    const jobQueue = this.personas.map((_, index) => ({ kind: 'initial', index, generation: 0 }));
    const activeJobs = new Map();
    const memberBusy = new Set();
    const queuedWake = new Set();
    const operatorWakes = new Set();
    const memberGeneration = new Array(n).fill(0);
    let nextJobId = 0;
    let rounds = 0;
    let seenActivityVersion = this._linksActivityVersion;
    // Alternate helper and roster admission when both are queued. This lets a
    // newly-added specialist join promptly without starving the fixed roster.
    let preferOperatorHelper = true;

    const failedJobResult = (index, error) => ({
      index,
      name: this.personas[index].name,
      model: this._memberConn(index).model,
      ok: false,
      output: '',
      status: this.stopped ? 'stopped' : 'stalled',
      error: error?.message || String(error || 'Links member job failed.'),
      completedAt: Date.now(),
    });

    const queueReadyWakes = (triggerGeneration = 0) => {
      if (this.stopped || this._linksDone()) return 0;
      const queued = [];
      for (let index = 0; index < n; index++) {
        // A pending roster member consumes its mail in the initial prompt. A
        // busy or already-queued member keeps accumulating mail for one bounded
        // coalesced follow-up rather than starting a concurrent turn.
        if (!turns[index] || turns[index] >= maxTurns || memberBusy.has(index) || queuedWake.has(index)) continue;
        const rec = this.net?.agents.get(`m${index}-${this.personas[index].id}`);
        if (!rec?.inbox?.length) continue;
        const generation = Math.max(memberGeneration[index] + 1, triggerGeneration + 1);
        if (generation > MAX_LINK_ROUNDS) continue; // preserve over-cap mail for status/diagnostics
        const job = { kind: 'wake', index, generation };
        jobQueue.push(job);
        queuedWake.add(index);
        queued.push(job);
      }
      if (queued.length) rounds = Math.max(rounds, ...queued.map(job => job.generation));
      return queued.length;
    };

    const launchJob = (job) => {
      const { index } = job;
      if (this.stopped || this._linksDone() || memberBusy.has(index)) return false;

      let box = [];
      let nurseWake = false;
      let reviving = false;
      if (job.kind === 'initial') {
        if (turns[index]) return false;
        turns[index] = 1;
      } else {
        queuedWake.delete(index);
        operatorWakes.delete(index);
        if (!turns[index] || turns[index] >= maxTurns || job.generation > MAX_LINK_ROUNDS) return false;
        // Drain only when the slot is actually reserved. Until this point the
        // inbox stays visible to the Nurse, coalesces new mail, and survives a
        // Stop/completion without any restoration bookkeeping.
        box = this._takeLinkInbox(index);
        if (!box.length) return false;
        nurseWake = box.some(message => String(message).startsWith('TEAM NURSE RECOVERY'));
        reviving = stalled.has(index);
        this._emit('links-round', {
          round: job.generation,
          waking: [this.personas[index].name],
          nurseWaking: nurseWake ? [this.personas[index].name] : [],
          silent: nurseWake,
          exchanges: this.net ? this.net.linkSends : 0,
          budget,
        });
        if (reviving) {
          stalled.delete(index);
          this._emit('links-revive', { index, name: this.personas[index].name, messages: box.length, source: nurseWake ? 'nurse' : 'peer', silent: nurseWake });
        }
        if (nurseWake) nurse.recordWakeStarted(index);
        turns[index]++;
      }

      memberBusy.add(index);
      memberGeneration[index] = Math.max(memberGeneration[index], job.generation);
      const jobId = ++nextJobId;
      job.nurse = nurseWake;
      const running = (async () => {
        if (job.kind === 'initial') {
          return this._runMember(this.personas[index], index, this._memberPrompt(index, 'links', []), { keep: true });
        }
        const result = await this._wakeMember(index, box);
        if (result?.wakeDeferred) this._restoreLinkInbox(index, box);
        return result;
      })();
      const tracked = Promise.resolve(running)
        .then(result => ({ type: 'settled', jobId, job, result }))
        .catch(error => ({ type: 'settled', jobId, job, result: failedJobResult(index, error) }));
      activeJobs.set(jobId, tracked);
      return true;
    };

    const pump = () => {
      let launched = 0;
      while (!this.stopped && !this.userPaused && this.acceptingRuntimeAgents && !this._linksDone()
        && activeJobs.size + this._activeOperatorHelperCount() < this.concurrency) {
        const queuedHelper = this._operatorHelpers('queued')[0] || null;
        const tryHelper = queuedHelper && (preferOperatorHelper || !jobQueue.length);
        if (tryHelper) {
          const started = this.net.startSpawned(queuedHelper.id);
          if (!started.ok) break;
          preferOperatorHelper = false;
          launched++;
          continue;
        }
        if (jobQueue.length) {
          if (launchJob(jobQueue.shift())) {
            preferOperatorHelper = true;
            launched++;
          }
          continue;
        }
        if (queuedHelper) {
          const started = this.net.startSpawned(queuedHelper.id);
          if (!started.ok) break;
          preferOperatorHelper = false;
          launched++;
          continue;
        }
        break;
      }
      return launched;
    };
    this._linksPump = pump;
    this._requestLinksWake = index => {
      if (!this.running || this.stopped || !this.acceptingRuntimeAgents || this._linksDone()) {
        throw new Error('The team run is finalizing. Start a new team run to retry this member.');
      }
      if (this.userPaused) throw new Error('Start the team before waking this stalled member.');
      if (turns[index] >= maxTurns || memberGeneration[index] >= MAX_LINK_ROUNDS) {
        throw new Error('This member reached its recovery limit. Start a new team run to retry it.');
      }
      // Coalesce repeated clicks and existing recovery mail into one scheduled
      // turn. Never run a second loop outside the team's concurrency pool.
      if (operatorWakes.has(index) || queuedWake.has(index)) return;
      operatorWakes.add(index);
      const result = this.messageMember(`m${index}-${this.personas[index].id}`,
        'The user pressed Start to wake you after a stall. Resume your original task using your saved context. Take a concrete next action, or explain any blocker that still needs user input.');
      if (!result.ok) { operatorWakes.delete(index); throw new Error(result.error); }
      this._emit('member-wake-queued', { index, name: this.personas[index].name });
    };

    const settleJob = ({ jobId, job, result }) => {
      activeJobs.delete(jobId);
      memberBusy.delete(job.index);
      results[job.index] = result || failedJobResult(job.index, 'Member returned no result.');
      memberGeneration[job.index] = Math.max(memberGeneration[job.index], job.generation);
      if (job.nurse) nurse.recordWakeResult(job.index, results[job.index]);
      if (results[job.index]?.status === 'stalled') noteStall(job.index, results[job.index].error);
      else stalled.delete(job.index);
    };

    const pulse = (triggerGeneration = 0) => {
      if (this.stopped || this._linksDone()) return;
      nurse.stageRecoveries({ results, stalled, turns, maxTurns });
      queueReadyWakes(triggerGeneration);
      pump();
    };

    pump();
    for (;;) {
      if (this.stopped || this._linksDone()) {
        // Existing Stop/conclusion-grace handling unwinds running loops. Never
        // launch queued work after the terminal signal, but do harvest anything
        // that was already in flight so result state remains truthful.
        if (!activeJobs.size) break;
        settleJob(await Promise.race(activeJobs.values()));
        continue;
      }

      pulse(0);
      if (activeJobs.size) {
        const activityWait = this._waitForLinksActivity(seenActivityVersion)
          .then(({ version, activity }) => ({ type: 'activity', version, activity }));
        const event = await Promise.race([...activeJobs.values(), activityWait]);
        if (event.type === 'activity') {
          seenActivityVersion = Math.max(seenActivityVersion, event.version);
          const senderIndex = event.activity?.from
            ? this.personas.findIndex((persona, index) => `m${index}-${persona.id}` === event.activity.from)
            : -1;
          pulse(senderIndex >= 0 ? memberGeneration[senderIndex] : 0);
          continue;
        }
        settleJob(event);
        pulse(event.job.generation);
        continue;
      }

      // `pump` can discard a stale queued job (for example, an inbox consumed
      // by its initial turn). Re-scan before declaring the roster quiescent.
      pulse(0);
      if (activeJobs.size || jobQueue.length) {
        pump();
        if (activeJobs.size) continue;
      }

      // A roster member may have delegated useful work and finished before its
      // worker. Await already-paid work (event-driven, no polling); its mail or
      // completed output is then considered before paying for synthesis.
      if (this.net) await this.net.drainActiveSpawned();
      if (!this.stopped && !this._linksDone()) {
        // A very fast helper can settle between drainActiveSpawned's final
        // scan and this continuation. Its onSettled hook may already have
        // launched a roster job, so always re-pump and inspect the whole pool
        // before declaring Links quiescent.
        pulse(0);
        if (activeJobs.size || jobQueue.length
          || this._activeOperatorHelperCount()
          || this._operatorHelpers('queued').length) continue;
      }
      break;
    }

    // Completion/Stop may deliberately leave not-yet-started initial jobs.
    // Keep the result array dense so final event serialization cannot trip on
    // sparse entries, and keep the network roster consistent for diagnostics.
    for (let index = 0; index < n; index++) {
      if (results[index]) continue;
      const result = {
        index,
        name: this.personas[index].name,
        model: this._memberConn(index).model,
        ok: false,
        output: '',
        status: this.stopped ? 'stopped' : 'skipped',
        error: this.stopped ? 'Stopped by you.' : 'Links completed before this member started.',
        completedAt: Date.now(),
      };
      results[index] = result;
      this.net?.syncMember(`m${index}-${this.personas[index].id}`, { status: result.status, error: result.error, output: '' });
    }
    this._linksActivityDeferred = null;

    // The roster is quiescent. Do not accept an operator helper after this
    // boundary: Links may now synthesize/finalize and cannot safely enroll new
    // work in the answer it is already constructing.
    this.acceptingRuntimeAgents = false;
    this._linksPump = null;
    this._requestLinksWake = null;
    this._cancelQueuedOperatorAgents('Links finalized before this helper started.');

    // Synthesis reuses (and then replaces) a roster result. Retain every
    // usable pre-synthesis answer so a failed synthesis cannot erase it.
    const preSynthesisOkResults = results.filter(result => result?.ok && result.output);
    let synthesized = null;
    let synthIndex = -1;
    if (!this.stopped && !this._linksDone()) {
      synthIndex = this._synthesisIndex();
      const viable = [...Array(n).keys()].filter(i => results[i]?.ok && results[i]?.status === 'completed' && !stalled.has(i));
      if (!viable.includes(synthIndex)) {
        const coordinator = viable.find(i => (this.team.members[i] || {}).roleId === 'coordinator');
        synthIndex = coordinator ?? (viable.length ? viable[viable.length - 1] : -1);
      }
      if (synthIndex >= 0) {
        const note = (this.net && this.net.linkSends >= budget)
          ? 'The crew has spent its full Links exchange budget (3× the chain rate).'
          : 'The crew has gone quiet without a completion declaration.';
        const stallNote = stalled.size
          ? ` Note: ${[...stalled.keys()].map(i => this.personas[i].name).join(', ')} stalled and produced no usable work — cover that gap or state it as missing.`
          : '';
        const workerResults = this.net
          ? this.net.snapshot().filter(worker => worker.origin === 'spawned')
          : [];
        const pendingMail = this.net
          ? this.personas.map((persona, index) => {
              const rec = this.net.agents.get(`m${index}-${persona.id}`);
              return rec?.inbox?.length ? { name: persona.name, messages: rec.inbox.slice() } : null;
            }).filter(Boolean)
          : [];
        const handoff = nurse.synthesisHandoff(results, stalled, workerResults, pendingMail);
        synthesized = await this._wakeMember(synthIndex, [], { synthesize: true, note: note + stallNote, handoff });
        results[synthIndex] = synthesized;
        this._emit('links-synthesis', { index: synthIndex, name: this.personas[synthIndex].name, budgetSpent: this.net ? this.net.linkSends : 0, nurseHandoffs: nurse.meta().handoffs });
      }
    }

    const done = this._linksDone();
    const declarerResult = results.find(r => r && r.ok && linksCompleteIn(r.output));
    const declarationMessage = done?.message ? cleanOutput(done.message) : '';
    const okResults = results.filter(r => r && r.ok);
    const fallbackResults = synthesized && !synthesized.ok ? preSynthesisOkResults : okResults;
    this._linksAnswer = (declarerResult && declarerResult.output)
      || declarationMessage
      || (synthesized && synthesized.ok && synthesized.output)
      || (fallbackResults.length
        ? fallbackResults.map(r => `【${r.name}】\n${r.output}`).join('\n\n')
        : results.filter(Boolean).map(r => `【${r.name}】\n(failed: ${r.error || 'unknown'})`).join('\n\n'));
    this._linksMeta = {
      rounds,
      budget,
      exchanges: this.net ? this.net.linkSends : 0,
      completedBy: done && done.by ? done.by : (synthesized?.ok && synthIndex >= 0 ? this.personas[synthIndex].name : null),
      synthesized: !!synthesized?.ok,
      synthesisAttempted: !!synthesized,
      stalled: stalled.size,
      nurse: nurse.meta(),
    };
    return results;
  }

  stop() {
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

  /* Join-this-run-only helper. It is intentionally a spawned network worker,
   * not a mutation of the fixed saved roster: parallel/chain/Links schedulers
   * snapshot roster indexes at dispatch. The worker still has tools, its own
   * tab/control, direct team messaging, and is awaited before run finalization;
   * Links synthesis also incorporates spawned-worker results. */
  addRuntimeAgent({ name, model = '', prompt = '', task = '', role = '', endpoint = '', accessKey = '' } = {}) {
    if (this.team.mode !== 'links') return { ok: false, error: 'Run-only agents can join Links teams. Parallel and chain teams have a fixed result roster.' };
    if (!this.net || !this.running || this.stopped || !this.acceptingRuntimeAgents || this._linksDone()) return { ok: false, error: 'The team run is finalizing and is no longer accepting agents.' };
    if (this.paused || this.userPaused) return { ok: false, error: 'Resume the team before adding an agent.' };
    const roleText = String(role || '').trim();
    const instructions = [String(prompt || '').trim(), roleText ? `YOUR ROLE ON THIS RUN: ${roleText}` : ''].filter(Boolean).join('\n\n');
    const assignment = String(task || '').trim() || `Join ${this.team.name} and help complete its active task:\n${this.task}`;
    const result = this.net.spawn({
      name, model, prompt: instructions, task: assignment,
      parentId: null, depth: 0, callerName: 'You', endpoint, accessKey,
      deferStart: true, operatorAdded: true,
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

module.exports = { TeamRunner, cleanOutput, boundedRelay, mapWithConcurrency, PARALLEL_CONCURRENCY, MAX_RESUME_CYCLES, LINKS_RATE, MAX_LINK_ROUNDS, MEMBER_LINK_TURNS, TEAM_REQUEST_TIMEOUT_MS };
