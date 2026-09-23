'use strict';

/* Reach Studio — the agent network ("crew net").
 *
 * Grok-Bot-style agent-driven collaboration. In Grok Bot any agent can
 * create_agent, send_message, get_agent_status, read_agent_transcript and
 * await a peer; workers run ASYNC in the background while the caller keeps
 * going. This module is the Reach Studio equivalent: one AgentNet per crew
 * run, owning every live agent in it (roster members + agents they spawn).
 *
 * Design constraint that shaped this file: AgentLoop builds its tool context
 * from an explicit literal, so injecting a net through the loop would mean
 * editing agent-loop.cjs on every change. Instead agents are REGISTERED here
 * by id and collab tools resolve the net with netForAgent(ctx.agentId). That
 * keeps the collaboration layer additive — no loop edits, no cycle.
 *
 * Guardrails (an unbounded spawn graph is how a crew burns an endpoint):
 *   MAX_AGENTS   hard cap on live agents in one net (also the concurrency
 *                ceiling — a semaphore gate would let awaiters starve the
 *                peers they wait for, so population is bounded instead)
 *   MAX_DEPTH    subagents may spawn subagents, but only this deep
 *   SUBAGENT_MAX_ROUNDS  tighter round budget than an interactive chat
 *   await cycle detection + timeout, so A↔B cannot deadlock a run
 */

/* sha1 is used by workerSoulKey to bound an over-long identity key down to the
 * store's key cap. It is a length-bounding digest, not a security primitive. */
const crypto = require('node:crypto');

const { parseAgentResponse } = require('./agent-response.cjs');
const { runToTerminal } = require('./pause-resume.cjs');

const { cap } = require('./budgets.cjs');

const MAX_AGENTS = 12;
const MAX_DEPTH = 2;
const SUBAGENT_MAX_ROUNDS = 12;
const DEFAULT_AWAIT_TIMEOUT = 120000;
const TRANSCRIPT_MESSAGES = 40;
const TRANSCRIPT_CHARS = 4000;
const OUTPUT_PREVIEW = 4000;
const MAX_OPERATOR_MESSAGES_PER_AGENT = 20;
const MAX_OPERATOR_CHARS_PER_AGENT = 40000;
/* Mirrors agent-soul.cjs MAX_KEY_CHARS: the store refuses a longer key. */
const MAX_WORKER_KEY_CHARS = 64;

/*
 * E14: every constant above is now the DEFAULT of a budgets-schema field, so a
 * user can change how much transcript a peer sees, how much queued guidance a
 * member may hold, and how long a worker identity key may be — without editing
 * engine source. Resolving through one helper keeps the defaults byte-identical
 * for a caller that passes no budgets (every test and every pre-feature path).
 *
 * 0 maps to the schema's "no application cap" (cap → Infinity), consistent with
 * the rest of budgets.cjs.
 */
function budgetLimit(budgets, key, fallback) {
  const value = budgets ? budgets[key] : undefined;
  return Number.isSafeInteger(value) ? cap(value) : fallback;
}

/* Links-mode completion declaration: a member ends a message (or its final
 * answer) with this line to say the WHOLE task is done. Scanned on every
 * member-to-member message and on every harvested output. */
const LINKS_COMPLETE_RE = /links\s*:\s*complete/i;
function linksCompleteIn(text) {
  return LINKS_COMPLETE_RE.test(String(text || ''));
}

/* Strip the run-control fence: relay only what a human would read. */
function cleanOutput(text) {
  try {
    const parsed = parseAgentResponse(text);
    return (parsed.display || parsed.confirm?.question || '').trim();
  } catch {
    return String(text || '').trim();
  }
}

/*
 * The identity key for a SPAWNED worker's OWN SOUL.md + MEMORY.md.
 *
 * Derived from (parent identity, worker name) rather than from the run-scoped
 * net id, because memory is only worth writing if the same worker can read it
 * back: a helper named "Auditor" spawned by persona P finds its own notes on
 * the next run, while an "Auditor" under a different persona is a different
 * agent with a different history. Keying on the net id would make every memory
 * write unreadable one run later.
 *
 * Returns '' when the parent has no identity: two crews must never end up
 * sharing one memory file, so no key is invented in that case and the worker
 * simply runs without soul files, as it did before this feature. The result
 * always satisfies sanitizeAgentKey — leading alphanumeric, one segment, no
 * '..', within the store's cap — so it can never escape <root>/agents.
 */
function workerSoulKey(parentKey, name, keyChars = MAX_WORKER_KEY_CHARS) {
  const parent = String(parentKey || '').trim();
  if (!parent) return '';
  /* E14: the cap is a budgets field (workerKeyChars) defaulting to the old
   * constant, so a caller without budgets behaves exactly as before. It is
   * clamped to at least the suffix so the slice below cannot invert. */
  const limit = Math.max(suffixFloor(name), Number(keyChars) || MAX_WORKER_KEY_CHARS);
  const slug = String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'worker';
  const suffix = `-worker-${slug}`;
  const full = parent + suffix;
  if (full.length <= limit) return full;
  /* Long persona ids are normal eventually, so bound deterministically with a
   * digest of the FULL key: the name-derived tail stays stable, and two long
   * parents with identical prefixes still get different keys. */
  const digest = crypto.createHash('sha1').update(full).digest('hex').slice(0, 8);
  return parent.slice(0, Math.max(0, limit - suffix.length - 9)) + suffix + '-' + digest;
}

/* The shortest cap that can still carry a suffix plus its digest. */
function suffixFloor(name) {
  const slug = String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'worker';
  return `-worker-${slug}`.length + 9;
}

/* agentId -> net lives in a leaf module shared with AgentLoop. */
const { netForAgent, registerNet, unregisterNet } = require('./net-registry.cjs');

const FINISHED = new Set(['completed', 'failed', 'stopped', 'abandoned', 'stalled', 'skipped']);
const { diagnosticLog } = require('./diagnostic-log.cjs');

class AgentNet {
  constructor({
    teamRunId = '',
    teamName = 'crew',
    endpoint,
    accessKey = '',
    defaultModel = '',
    projectDir = '',
    reachExecutor = null,
    browserExecutor = null,
    sendEvent = () => {},
    requestApproval = null,
    requestEditReview = null,
    awaitEditResolution = null,
    requestMemberAnswer = null,
    requestTimeoutMs = 180000,
    budgets = null,
    agentSettings = {},
    jev = null,
    featureMask = null,
    maxAgents = MAX_AGENTS,
    maxDepth = MAX_DEPTH,
    awaitTimeoutMs = DEFAULT_AWAIT_TIMEOUT,
    onSettled = () => {},
    onActivity = () => {},
    auditLog = null,
    logger = null,
    capabilityStore = null,
    journal = null,
    /* Native (OpenAI) tool-calling protocol for spawned workers: set by the
     * TeamRunner from the team's toolProtocol so a native crew's helpers run
     * on the same contract as their parent. */
    nativeTools = false,
    /* Links mode: roster members that finished a turn accept messages into
     * their inbox instead of refusing them (the TeamRunner's Links rounds wake
     * them up). Off by default so parallel/chain behaviour is unchanged. */
    rosterMailbox = false,
    /* Links mode exchange budget: total member-to-member messages allowed in
     * the run (3× a chain's rate). Null = unlimited (all other modes). */
    linkBudget = null,
    /* SOUL.md + MEMORY.md store (agent/agent-soul.cjs). Members read their own
     * persona's files; this is also what lets anything they spawn own its own
     * pair. Null keeps pre-feature behaviour (no soul files, no memory tool). */
    soulStore = null,
  } = {}) {
    this.budgets = budgets;
    // E14: policy caps resolved once per net (see budgetLimit above).
    this.limits = {
      transcriptMessages: budgetLimit(budgets, 'transcriptMessages', TRANSCRIPT_MESSAGES),
      transcriptChars: budgetLimit(budgets, 'transcriptChars', TRANSCRIPT_CHARS),
      outputPreview: budgetLimit(budgets, 'outputPreviewChars', OUTPUT_PREVIEW),
      operatorMessages: budgetLimit(budgets, 'operatorMessagesPerAgent', MAX_OPERATOR_MESSAGES_PER_AGENT),
      operatorChars: budgetLimit(budgets, 'operatorCharsPerAgent', MAX_OPERATOR_CHARS_PER_AGENT),
      workerKeyChars: budgetLimit(budgets, 'workerKeyChars', MAX_WORKER_KEY_CHARS),
    };
    this.agentSettings = agentSettings;
    this.jev = jev;
    this.featureMask = featureMask;
    // Subagents run tools too, so they share the same security audit log.
    this.auditLog = auditLog;
    this.logger = logger;
    this.capabilityStore = capabilityStore;
    this.journal = journal;
    this.soulStore = soulStore;
    this.nativeTools = !!nativeTools;
    this.onSettled = onSettled;
    this.onActivity = onActivity;
    this.teamRunId = teamRunId;
    this.teamName = teamName;
    this.endpoint = endpoint;
    this.accessKey = accessKey;
    this.defaultModel = defaultModel;
    this.projectDir = projectDir;
    this.reachExecutor = reachExecutor;
    this.browserExecutor = browserExecutor;
    this.sendEvent = sendEvent;
    this.requestApproval = requestApproval;
    this.requestEditReview = requestEditReview;
    this.awaitEditResolution = awaitEditResolution;
    this.requestMemberAnswer = requestMemberAnswer;
    this.requestTimeoutMs = budgets?.requestTimeoutMs ?? requestTimeoutMs;
    this.maxAgents = budgets ? cap(budgets.maxAgents) : Math.max(1, Number(maxAgents) || MAX_AGENTS);
    this.maxDepth = budgets ? cap(budgets.maxDepth) : Math.max(0, Number.isInteger(maxDepth) ? maxDepth : MAX_DEPTH);
    this.awaitTimeoutMs = budgets ? cap(budgets.awaitTimeoutMs) : Number(awaitTimeoutMs) || DEFAULT_AWAIT_TIMEOUT;
    this.agents = new Map();   // agentId -> record
    this.awaiting = new Map(); // callerId -> targetId (cycle detection)
    this.spawnedEdits = new Map(); // agentId -> [edit] awaiting review
    this.tasks = [];           // background run promises
    this.activeTasks = new Map(); // spawned agentId -> current background promise
    this.stopped = false;
    this.paused = false;
    this._stopDeferred = null;
    this.seq = 0;
    this.rosterMailbox = rosterMailbox === true;
    this.linkBudget = linkBudget == null ? null : Math.max(1, Number(linkBudget) || 1);
    this.linkSends = 0;
    this.linksComplete = null;
  }

  /* Resolves when stop() fires so pause waits can race it and unwind. */
  _stopSignal() {
    if (!this._stopDeferred) {
      let resolve;
      const p = new Promise(r => { resolve = r; });
      this._stopDeferred = { promise: p, resolve };
    }
    return this._stopDeferred.promise;
  }

  _emit(netType, payload = {}) {
    if (['agent-created', 'agent-message', 'agent-state'].includes(netType)) {
      const event = netType === 'agent-message' ? 'handoff'
        : netType === 'agent-state' && payload.status === 'stalled' ? 'stall' : netType;
      diagnosticLog(this.logger, { event, teamRunId: this.teamRunId,
        agentId: payload.agentId, status: payload.status, at: payload.at ?? Date.now() });
    }
    this.sendEvent('team:event', { teamRunId: this.teamRunId, type: 'subagent', netType, ...payload, at: payload.at ?? Date.now() });
  }

  /* Register an agent the net did not create itself (a roster member). The
   * caller owns its loop; the net only tracks and routes messages to it. */
  register({ agentId, name, model = '', prompt = '', depth = 0, parentId = null, loop, store, task = '', soulKey = '', connectionId = '' }) {
    const rec = {
      id: agentId,
      name: String(name || agentId),
      model: model || this.defaultModel || '',
      prompt: String(prompt || ''),
      depth: Number(depth) || 0,
      parentId: parentId || null,
      origin: 'roster',
      loop,
      store,
      /* The identity whose SOUL.md/MEMORY.md this member reads. Anything it
       * spawns derives its OWN key from this, so a worker becomes its own
       * agent with its own memory instead of a second writer to the member's. */
      soulKey: String(soulKey || ''),
      connectionId: String(connectionId || ''),
      status: 'running',
      output: '',
      error: null,
      task: String(task || ''),
      startedAt: Date.now(),
      finishedAt: null,
      messagesSent: 0,
      messagesReceived: 0,
    };
    this.agents.set(agentId, rec);
    registerNet(agentId, this);
    return rec;
  }

  /* Pre-register a roster member BEFORE its loop exists, so the whole crew is
   * visible to agent.list / agent.send / agent.status from the first turn
   * (chain mode runs members later; they must still be addressable). */
  preRegister({ agentId, name, model = '', prompt = '', depth = 0, task = '', endpoint = '', accessKey = '', soulKey = '', connectionId = '' }) {
    if (this.agents.has(agentId)) return this.agents.get(agentId);
    const rec = {
      id: agentId,
      name: String(name || agentId),
      model: model || this.defaultModel || '',
      prompt: String(prompt || ''),
      depth: Number(depth) || 0,
      parentId: null,
      origin: 'roster',
      loop: null,
      store: null,
      status: 'pending',
      output: '',
      error: null,
      task: String(task || ''),
      /* Per-agent routing. A team member may be pinned to a different provider
       * than the crew default, and anything IT spawns must inherit that provider
       * — otherwise a helper spawned by a member on provider B silently runs on
       * A, where its model may not exist. Empty means "use the network default".
       * accessKey is never emitted in any event or log. */
      endpoint: String(endpoint || ''),
      accessKey: String(accessKey || ''),
      connectionId: String(connectionId || ''),
      /* Identity key for this member (its persona id). Held from the first
       * turn so a worker spawned before the member's loop exists still derives
       * its own key from the right agent. */
      soulKey: String(soulKey || ''),
      startedAt: Date.now(),
      finishedAt: null,
      messagesSent: 0,
      messagesReceived: 0,
    };
    this.agents.set(agentId, rec);
    registerNet(agentId, this);
    return rec;
  }

  /* Attach the live loop+store once a pre-registered member starts. */
  attach(agentId, loop, store, soulKey = '') {
    const rec = this.agents.get(agentId);
    if (!rec) return null;
    rec.loop = loop;
    rec.store = store;
    /* Late-bound identity: a caller that built the loop itself (TeamRunner) may
     * only learn the persona key here. An empty value never CLEARS a key that
     * preRegister already set. */
    if (soulKey) rec.soulKey = String(soulKey);
    return rec;
  }

  _resolve(agentId, callerId) {
    const wanted = String(agentId || '').trim();
    if (!wanted) return null;
    if (this.agents.has(wanted)) return this.agents.get(wanted);
    // Allow addressing a peer by name — models reliably know names, and an
    // opaque net id is easy to garble. Ambiguous names are refused, not guessed.
    const byName = [...this.agents.values()].filter(a => a.name.toLowerCase() === wanted.toLowerCase() && a.id !== callerId);
    if (byName.length === 1) return byName[0];
    if (byName.length > 1) return { ambiguous: byName.map(a => ({ agentId: a.id, name: a.name })) };
    return null;
  }

  _notFound(agentId) {
    const known = [...this.agents.values()].map(a => `${a.name} (${a.id})`).join(', ') || 'none';
    return { ok: false, error: `No agent "${agentId}" in this crew. Known agents: ${known}.` };
  }

  _trackTask(agentId, promise) {
    const tracked = Promise.resolve(promise).finally(() => {
      if (this.activeTasks.get(agentId) === tracked) this.activeTasks.delete(agentId);
    });
    this.activeTasks.set(agentId, tracked);
    this.tasks.push(tracked);
    return tracked;
  }

  depthOf(agentId) {
    return this.agents.get(agentId)?.depth || 0;
  }

  /* Spawn a background worker. Returns immediately with an id — the caller
   * keeps working and can poll (agent.status), await, or message it. */

  startSpawned(agentId) {
    if (this.stopped) return { ok: false, error: 'The crew run is stopped.' };
    if (this.paused) return { ok: false, error: 'The crew is paused by the user.' };
    const rec = this.agents.get(String(agentId || ''));
    if (!rec || rec.origin !== 'spawned') return this._notFound(agentId);
    if (!rec.operatorAdded || rec.status !== 'queued') {
      return { ok: false, error: `${rec.name} is not a queued operator-added helper.`, status: rec.status };
    }
    rec.status = 'starting';
    rec.startedAt = Date.now();
    const prompt = String(rec.queuedPrompt || rec.task || 'Continue the assigned team task.');
    rec.queuedPrompt = '';
    this._trackTask(rec.id, this._run(rec.id, prompt));
    return { ok: true, agentId: rec.id, name: rec.name, status: rec.status };
  }

  /* Terminal Links transitions must not leave admitted helpers permanently
   * queued. Mark them as skipped without ever issuing a model request. */
  cancelQueuedSpawned(agentId, reason = 'The team finalized before this helper started.') {
    const rec = this.agents.get(String(agentId || ''));
    if (!rec || rec.origin !== 'spawned' || !rec.operatorAdded || rec.status !== 'queued') return false;
    if (rec.control) rec.control.finished = true;
    rec.status = 'skipped';
    rec.error = String(reason || 'The team finalized before this helper started.');
    rec.finishedAt = Date.now();
    this.journal?.append('member-turn', { agentId: id, name: rec.name, model: rec.model,
      spawned: true, ok: rec.status === 'completed', status: rec.status,
      output: rec.output, error: rec.error, completedAt: rec.finishedAt });
    this._emit('agent-state', {
      agentId: rec.id, name: rec.name, status: rec.status,
      chars: 0, error: rec.error, outputPreview: '',
    });
    this.onSettled();
    return true;
  }

  /* One background turn. No semaphore: awaiting happens INSIDE a turn, so a
   * gate would let N awaiters starve the peers they wait for. MAX_AGENTS
   * bounds the total live population instead — the real resource ceiling. */
  async _run(id, prompt) {
    const rec = this.agents.get(id);
    if (!rec) return;
    if (this.stopped) { this._settle(id, 'stopped', 'Stopped by you.'); return; }
    rec.control.finished = false;
    rec.status = 'running';
    rec.finishedAt = null;
    this._emit('agent-state', { agentId: id, name: rec.name, status: 'running' });
    try {
      // Same pause/resume driver as TeamRunner members: a worker that proposes
      // an edit or asks a question pauses visibly and resumes on the verdict.
      const end = await runToTerminal({
        loop: rec.loop,
        store: rec.store,
        agentId: id,
        firstPrompt: prompt,
        control: rec.control,
        maxCycles: cap(this.budgets?.resumeCycles ?? 6),
        isStopped: () => this.stopped,
        stopSignal: () => this._stopSignal(),
        getPendingEdits: () => this.spawnedEdits.get(id) || [],
        clearPendingEdits: () => this.spawnedEdits.set(id, []),
        awaitEditResolution: this.awaitEditResolution,
        requestMemberAnswer: this.requestMemberAnswer
          ? (q) => this.requestMemberAnswer({ ...q, agentId: id, name: rec.name, model: rec.model, subagent: true })
          : null,
        onWaiting: (edits) => this._emit('agent-waiting', {
          agentId: id, name: rec.name, status: 'waiting_edits',
          edits: edits.map(e => ({ editId: e.editId, path: e.path, stats: e.stats })),
        }),
        onQuestion: (questionId, question) => this._emit('agent-question', { agentId: id, name: rec.name, questionId, question }),
        onResumed: (cycle, status) => this._emit('agent-resumed', { agentId: id, name: rec.name, cycle, status }),
      });
      this._settle(id, null, end.error || null);
    } catch (e) {
      this._settle(id, 'failed', e.message);
    }
  }

  _settle(id, forceStatus = null, forceError = null) {
    const rec = this.agents.get(id);
    if (!rec) return;
    if (rec.control) rec.control.finished = true;
    const runState = rec.store.get(id).runState;
    const output = cleanOutput(rec.store.lastAssistantText(id));
    if (output) rec.output = output;
    const loopStatus = runState?.status || 'unknown';
    rec.status = forceStatus
      || (this.stopped ? 'stopped' : (loopStatus === 'completed' && !forceError ? 'completed' : 'failed'));
    rec.error = rec.status === 'completed' ? null
      : (forceError || runState?.reason || `Agent ${loopStatus}; no completed answer.`);
    rec.finishedAt = Date.now();
    this._emit('agent-state', {
      agentId: id, name: rec.name, status: rec.status,
      chars: rec.output.length, error: rec.error,
      outputPreview: rec.output.slice(0, this.limits.outputPreview),
    });
    this.onSettled();
  }

  /* Deliver a message to a peer. Running peer → queued into its loop (the
   * loop's own running flag decides); idle peer → woken for a new turn. */


  list(callerId) {
    const agents = [...this.agents.values()].map(a => ({
      agentId: a.id, name: a.name, model: a.model, origin: a.origin, depth: a.depth,
      status: a.status, parentId: a.parentId, spawnedBy: a.spawnedBy || null,
      isSelf: a.id === callerId,
      task: a.task.slice(0, 300),
      chars: a.output.length,
      messagesSent: a.messagesSent,
      messagesReceived: a.messagesReceived,
      inbox: (a.inbox || []).length,
    }));
    const stalled = agents.filter(a => a.status === 'stalled');
    return {
      ok: true,
      team: this.teamName,
      count: agents.length,
      maxAgents: this.maxAgents,
      agents,
      guidance: stalled.length
        ? `Stalled members can be retried. Send one a concrete instruction with agent.send; Links will wake it for a bounded recovery turn.`
        : undefined,
    };
  }

  /* Self-check before claiming done: the caller's own plan, recent work and
   * unfinished todos. Mirrors Grok Bot's reflect tool. */
  reflect(callerId) {
    const rec = this.agents.get(callerId);
    if (!rec) return this._notFound(callerId);
    const state = rec.store.get(rec.id);
    const open = (state.todos || []).filter(t => (t.status || '') !== 'completed' && (t.status || '') !== 'cancelled');
    const recent = state.messages
      .filter(m => m && (m.role === 'user' || m.role === 'assistant'))
      .slice(-6)
      .map(m => `[${m.role}] ${cleanOutput(m.content).slice(0, 1200)}`);
    const peers = [...this.agents.values()]
      .filter(a => a.id !== callerId)
      .map(a => `${a.name}: ${a.status}${a.output ? ` (${a.output.length} chars)` : ''}`);
    return {
      ok: true,
      agent: rec.name,
      status: rec.status,
      openTodos: open.map(t => t.text || t.content || ''),
      unfinishedWork: open.length > 0,
      recentTranscript: recent,
      crew: peers,
      guidance: open.length
        ? 'You still have unfinished checklist items. Complete them (or cancel with a reason) before reporting done.'
        : 'No open checklist items. Verify your claims against real tool output before reporting done.',
    };
  }

  /* Tear down: abort every live loop and unregister ids. */
  stop() {
    this.stopped = true;
    for (const rec of this.agents.values()) {
      if (rec.loop) { try { rec.loop.stop(); } catch { /* already torn down */ } }
      if (!FINISHED.has(rec.status)) {
        rec.status = 'stopped';
        rec.error = rec.error || 'Stopped by you.';
        rec.finishedAt = Date.now();
      }
    }
    if (this._stopDeferred) this._stopDeferred.resolve();
  }

  workersPaused() {
    return [...this.agents.values()].filter(r => r.origin === 'spawned').every(r => r.control?.finished || r.control?.paused);
  }

  pause() {
    this.paused = true;
    for (const rec of this.agents.values()) {
      if (rec.origin === 'spawned' && rec.status !== 'queued') rec.control?.pause();
    }
  }

  resume() {
    this.paused = false;
    for (const rec of this.agents.values()) {
      if (rec.origin === 'spawned' && rec.status !== 'queued') rec.control?.resume();
    }
  }

  controlWorker(id, start) {
    const rec = this.agents.get(id);
    if (rec?.origin !== 'spawned' || !rec.control || rec.control.finished) throw new Error('No unfinished worker with this id.');
    if (rec.status === 'queued') throw new Error('This helper is queued for team capacity and has not started yet.');
    if (start) { this.paused = false; rec.control.resume(); }
    else rec.control.pause();
  }

  /* Update a REGISTERED (roster) member's record when its runner finishes it.
   * No subagent event: the renderer tracks roster members by index, and an
   * agent-state emit would spawn a phantom worker card. */
  syncMember(agentId, update = {}) {
    const rec = this.agents.get(agentId);
    if (!rec || rec.origin !== 'roster') return;
    const { status, error, output } = update;
    rec.status = status;
    if (Object.hasOwn(update, 'error')) rec.error = error ?? null;
    if (output) rec.output = output;
    rec.finishedAt = Date.now();
  }

  hasActiveSpawned() {
    return [...this.agents.values()].some(rec =>
      rec.origin === 'spawned'
      && (rec.status === 'starting' || rec.status === 'running')
      && this.activeTasks.has(rec.id));
  }

  /* Await already-paid-for background work without unregistering the crew.
   * Links calls this at a quiet boundary before buying a synthesis request.
   * Re-scan after each batch because a worker may spawn a child while ending. */
  async drainActiveSpawned() {
    let waited = 0;
    for (let pass = 0; pass < 8; pass++) {
      const active = [...this.agents.values()]
        .filter(rec => rec.origin === 'spawned' && (rec.status === 'starting' || rec.status === 'running'))
        .map(rec => this.activeTasks.get(rec.id))
        .filter(Boolean);
      if (!active.length) break;
      waited += active.length;
      await Promise.allSettled(active);
    }
    return waited;
  }

  /* Wait for background work to drain, then release the id registry. Workers
   * can spawn workers, so keep awaiting until the task list stops growing. */
  async settle() {
    for (let pass = 0; pass < 8; pass++) {
      const before = this.tasks.length;
      await Promise.allSettled(this.tasks);
      if (this.tasks.length === before) break;
    }
    for (const id of this.agents.keys()) unregisterNet(id);
  }

  snapshot() {
    return [...this.agents.values()].map(a => ({
      agentId: a.id, name: a.name, model: a.model, origin: a.origin, depth: a.depth,
      parentId: a.parentId, status: a.status, chars: a.output.length, error: a.error,
      output: a.output.slice(0, this.limits.outputPreview),
    }));
  }
}

Object.assign(AgentNet.prototype,
  require('./team-spawn.cjs')({ workerSoulKey, SUBAGENT_MAX_ROUNDS }),
  require('./team-message.cjs')({ FINISHED, linksCompleteIn }),
  require('./team-transcript.cjs')({ FINISHED, cleanOutput }));

module.exports = {
  AgentNet,
  netForAgent,
  cleanOutput,
  linksCompleteIn,
  LINKS_COMPLETE_RE,
  workerSoulKey,
  MAX_AGENTS,
  MAX_DEPTH,
  MAX_WORKER_KEY_CHARS,
  SUBAGENT_MAX_ROUNDS,
};
