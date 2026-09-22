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

const { AgentLoop } = require('./agent-loop.cjs');
const { MemoryStore } = require('./memory-store.cjs');
const { RunControl } = require('./run-control.cjs');
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
function workerSoulKey(parentKey, name) {
  const parent = String(parentKey || '').trim();
  if (!parent) return '';
  const slug = String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'worker';
  const suffix = `-worker-${slug}`;
  const full = parent + suffix;
  if (full.length <= MAX_WORKER_KEY_CHARS) return full;
  /* Long persona ids are normal eventually, so bound deterministically with a
   * digest of the FULL key: the name-derived tail stays stable, and two long
   * parents with identical prefixes still get different keys. */
  const digest = crypto.createHash('sha1').update(full).digest('hex').slice(0, 8);
  return parent.slice(0, MAX_WORKER_KEY_CHARS - suffix.length - 9) + suffix + '-' + digest;
}

/* agentId -> net, so collab tools can find their network from tool context. */
const NET_BY_AGENT = new Map();
function netForAgent(agentId) { return NET_BY_AGENT.get(agentId) || null; }

const FINISHED = new Set(['completed', 'failed', 'stopped', 'abandoned', 'stalled', 'skipped']);

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
    this.agentSettings = agentSettings;
    this.jev = jev;
    this.featureMask = featureMask;
    // Subagents run tools too, so they share the same security audit log.
    this.auditLog = auditLog;
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
    this.sendEvent('team:event', { teamRunId: this.teamRunId, type: 'subagent', netType, ...payload, at: payload.at ?? Date.now() });
  }

  /* Register an agent the net did not create itself (a roster member). The
   * caller owns its loop; the net only tracks and routes messages to it. */
  register({ agentId, name, model = '', prompt = '', depth = 0, parentId = null, loop, store, task = '', soulKey = '' }) {
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
    NET_BY_AGENT.set(agentId, this);
    return rec;
  }

  /* Pre-register a roster member BEFORE its loop exists, so the whole crew is
   * visible to agent.list / agent.send / agent.status from the first turn
   * (chain mode runs members later; they must still be addressable). */
  preRegister({ agentId, name, model = '', prompt = '', depth = 0, task = '', endpoint = '', accessKey = '', soulKey = '' }) {
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
    NET_BY_AGENT.set(agentId, this);
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
  spawn({ name, model = '', prompt = '', task, parentId = null, depth = 0, callerName = '', endpoint = '', accessKey = '', deferStart = false, operatorAdded = false, soulKey: explicitSoulKey = '' }) {
    if (this.stopped) return { ok: false, error: 'The crew run is stopped.' };
    if (this.paused) return { ok: false, error: 'The crew is paused by the user.' };
    const cleanTask = String(task || '').trim();
    if (!cleanTask) return { ok: false, error: 'A task is required to spawn an agent.' };
    if (!String(name || '').trim()) return { ok: false, error: 'A name is required to spawn an agent.' };
    if (this.agents.size >= this.maxAgents) {
      return { ok: false, error: `Crew size limit reached (${this.maxAgents} agents). Await or message an existing agent instead of spawning another.` };
    }
    const childDepth = Number(depth) || 0;
    if (childDepth > this.maxDepth) {
      return { ok: false, error: `Subagent depth limit reached (${this.maxDepth}). Delegate to an existing agent instead of spawning deeper.` };
    }

    const id = `net-${(++this.seq).toString(36)}-${Date.now().toString(36)}`;
    const store = new MemoryStore();
    Object.assign(store.get(id).settings, structuredClone(this.agentSettings));

    /* Inherit the PARENT's routing, not the network default.
     *
     * A team member can be pinned to a provider other than the crew default, and
     * the helpers it spawns must run there too — otherwise they land on an
     * endpoint that may not even have the model. Inheriting the parent's MODEL as
     * well (when the caller did not name one) matters for the same reason:
     * this.defaultModel is the team/global default, which is a valid id on the
     * DEFAULT provider and may be nonsense on the parent's.
     *
     * Grandchildren inherit too, because the child's record stores what it got. */
    const parentRec = parentId ? (this.agents.get(parentId) || null) : null;
    // Main/TeamRunner may supply a resolved route for a user-added helper. The
    // renderer never sees the key. Model-created workers omit these fields and
    // retain the established parent-inheritance rule.
    const useEndpoint = String(endpoint || '') || (parentRec && parentRec.endpoint) || this.endpoint;
    const useAccessKey = String(accessKey || '') || (parentRec && parentRec.accessKey) || this.accessKey;
    const useModel = String(model || '').trim()
      || (parentRec && parentRec.model)
      || this.defaultModel
      || 'gpt-4o-mini';
    /* This worker's OWN SOUL.md + MEMORY.md.
     *
     * A spawned worker is a full agent — same loop, same tools, same review
     * flow as its parent — so it owns its own persona file and its own memory
     * rather than appending to the agent that spawned it. See workerSoulKey for
     * why the key is derived from (parent identity, name) and not from the
     * run-scoped net id. */
    const workerName = String(name).trim();
    /* An explicitly supplied identity wins over the derived one.
     *
     * That is the operator-added-helper case: a user joins a saved persona to
     * a running crew, and it should arrive WITH that persona's soul and memory
     * — it IS the agent they created on the Create page — rather than as an
     * anonymous worker with files of its own under a derived name. A supplied
     * key is only honoured when the store itself accepts it (paths() returns
     * null for a key it would refuse), so a tampered or foreign id degrades to
     * the derived key instead of naming another agent's directory. */
    const requestedKey = String(explicitSoulKey || '').trim();
    const requestedOk = requestedKey && (!this.soulStore || typeof this.soulStore.paths !== 'function'
      || this.soulStore.paths(requestedKey) !== null);
    const soulKey = requestedOk ? requestedKey : workerSoulKey(parentRec && parentRec.soulKey, workerName);
    if (this.soulStore && soulKey) {
      try {
        /* Best-effort, exactly like TeamRunner's member scaffold: a soul that
         * cannot be written must never fail a spawn. */
        this.soulStore.scaffold(soulKey, {
          name: workerName,
          /* The caller's `prompt` IS this worker's role. First line only, and
           * bounded: the template renders it as ONE bullet in Identity. */
          role: String(prompt || '').trim().split(/\r?\n/)[0].slice(0, 200),
        });
      } catch { /* soul files are best-effort; never break a spawn over them */ }
    }
    const loop = new AgentLoop({
      agentId: id,
      store,
      endpoint: useEndpoint,
      accessKey: useAccessKey,
      model: useModel,
      projectDir: this.projectDir,
      reachExecutor: this.reachExecutor,
      browserExecutor: this.browserExecutor,
      personaPrompt: String(prompt || ''),
      /* Its own identity, so the `memory` tool resolves ITS directory and the
       * prompt carries ITS soul — never another agent's. */
      soulStore: this.soulStore,
      soulKey,
      nativeTools: this.nativeTools,
      requestTimeoutMs: this.requestTimeoutMs,
      budgets: this.budgets ? { ...this.budgets, maxRounds: this.budgets.subagentMaxRounds } : null,
      jev: this.jev,
      featureMask: this.featureMask,
      auditLog: this.auditLog,
      requestApproval: this.requestApproval
        ? (payload) => this.requestApproval({ ...payload, memberName: name, subagent: true })
        : undefined,
      requestEditReview: this.requestEditReview
        ? (edit) => {
            this.spawnedEdits.set(id, [...(this.spawnedEdits.get(id) || []), edit]);
            this.requestEditReview({ ...edit, memberName: name, subagent: true, memberKey: id });
          }
        : undefined,
      sendEvent: (_channel, payload) => {
        if (!payload || payload.agentId !== id) return;
        const { agentId, ...rest } = payload;
        this.sendEvent('team:event', {
          ...rest,
          teamRunId: this.teamRunId,
          type: 'subagent',
          netType: rest.type,
          agentId: id,
          name: String(name),
          model: useModel,
          depth: childDepth,
          parentId: parentId || null,
        });
      },
    });
    // Tighter budget than an interactive chat: a worker has one job.
    store.get(id).settings.maxRounds = SUBAGENT_MAX_ROUNDS;

    const queuedForTeam = deferStart === true && operatorAdded === true;
    const rec = {
      id, name: String(name).trim(), model: useModel, prompt: String(prompt || ''),
      depth: childDepth, parentId: parentId || null, origin: 'spawned',
      loop, store, status: queuedForTeam ? 'queued' : 'starting', output: '', error: null, task: cleanTask,
      // Stored so a grandchild inherits the same provider (see spawn()).
      endpoint: useEndpoint || '', accessKey: useAccessKey || '',
      /* Its own identity key, so anything THIS worker spawns derives from it. */
      soulKey,
      startedAt: Date.now(), finishedAt: null, messagesSent: 0, messagesReceived: 0,
      spawnedBy: callerName || null,
      // Only user-added Links helpers opt into the TeamRunner's roster
      // semaphore. Model-created workers intentionally retain their established
      // asynchronous behavior so agent.await graphs cannot starve one another.
      operatorAdded: queuedForTeam,
      queuedPrompt: queuedForTeam ? cleanTask : '',
    };
    this.agents.set(id, rec);
    rec.control = new RunControl(loop, paused => {
      rec.status = paused ? 'paused' : 'running';
      this._emit('agent-control', { agentId: id, name: rec.name, paused });
    });
    NET_BY_AGENT.set(id, this);
    this._emit('agent-created', {
      agentId: id, name: rec.name, model: useModel, depth: childDepth,
      parentId: rec.parentId, spawnedBy: rec.spawnedBy, task: cleanTask,
      status: rec.status, queued: queuedForTeam,
    });
    if (!queuedForTeam) this._trackTask(id, this._run(id, cleanTask));
    return {
      ok: true, agentId: id, name: rec.name, model: useModel, depth: childDepth,
      task: cleanTask, async: true, queued: queuedForTeam,
    };
  }

  /* Start a worker that was deliberately admitted without running. This is
   * used only by the Links scheduler for operator-added helpers, keeping that
   * work inside the configured roster concurrency cap. */
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
      outputPreview: rec.output.slice(0, OUTPUT_PREVIEW),
    });
    this.onSettled();
  }

  /* Deliver a message to a peer. Running peer → queued into its loop (the
   * loop's own running flag decides); idle peer → woken for a new turn. */
  _emitDelivery(sender, rec, from, text, delivered, { fromName = '', source = 'agent' } = {}) {
    this._emit('agent-message', {
      from,
      fromName: sender ? sender.name : (fromName || String(from)),
      source,
      to: rec.id,
      toName: rec.name,
      chars: text.length,
      delivered,
      inbox: (rec.inbox || []).length,
      messagesSent: sender ? sender.messagesSent : 0,
      messagesReceived: rec.messagesReceived,
    });
  }

  send({ from, to, message, fromName = '', source = 'agent', countAgainstBudget = true, allowCompletion = true, exact = false }) {
    if (this.stopped) return { ok: false, error: 'The crew run is stopped.' };
    const text = String(message || '').trim();
    if (!text) return { ok: false, error: 'A message is required.' };
    // Renderer/operator routes carry a main-validated stable id and must never
    // fall back to a display name. Model-facing peer tools retain name lookup.
    const rec = exact ? this.agents.get(String(to || '')) : this._resolve(to, from);
    if (!rec) return this._notFound(to);
    if (rec.ambiguous) return { ok: false, error: `"${to}" matches several agents: ${rec.ambiguous.map(a => a.agentId).join(', ')}. Address one by id.`, candidates: rec.ambiguous };
    if (rec.id === from) return { ok: false, error: 'An agent cannot message itself.' };

    /* Reject a terminal recipient before touching quota, message counters, or
     * the LINKS completion sentinel. Links roster mail is the deliberate
     * exception: completed/stalled roster members remain addressable because
     * TeamRunner owns their bounded wake-up accounting. */
    const linksRosterMailbox = rec.origin === 'roster' && this.rosterMailbox;
    if (!linksRosterMailbox && rec.origin === 'roster' && FINISHED.has(rec.status)) {
      return { ok: false, error: `${rec.name} already finished (${rec.status}) and its answer is part of the crew's results. It cannot be woken.` };
    }
    if (!linksRosterMailbox && FINISHED.has(rec.status) && rec.status !== 'completed') {
      return { ok: false, error: `${rec.name} already ${rec.status}${rec.error ? ': ' + rec.error : ''}. It cannot be woken.`, status: rec.status };
    }

    /* Links budget: bound the total crew conversation (3× a chain's rate). */
    if (countAgainstBudget && this.linkBudget != null && this.linkSends >= this.linkBudget) {
      return { ok: false, error: `Link budget reached (${this.linkBudget} crew messages = 3× a chain's exchange rate). Finish with what the crew has; ask the Coordinator to declare completion.` };
    }

    if (source === 'user') {
      const messages = Number(rec.operatorMessages || 0);
      const chars = Number(rec.operatorChars || 0);
      if (messages >= MAX_OPERATOR_MESSAGES_PER_AGENT || chars + text.length > MAX_OPERATOR_CHARS_PER_AGENT) {
        return {
          ok: false,
          error: `Operator mailbox limit reached for ${rec.name} (${MAX_OPERATOR_MESSAGES_PER_AGENT} messages or ${MAX_OPERATOR_CHARS_PER_AGENT.toLocaleString()} characters). Wait for it to process the current guidance.`,
          code: 'operator-queue-full',
        };
      }
      rec.operatorMessages = messages + 1;
      rec.operatorChars = chars + text.length;
    }

    const sender = this.agents.get(from);
    if (sender) sender.messagesSent++;
    rec.messagesReceived++;

    /* The Links completion declaration can also travel as a message. */
    const senderName = sender ? sender.name : (fromName || String(from));
    if (allowCompletion && linksCompleteIn(text) && !this.linksComplete) {
      this.linksComplete = { by: senderName, to: rec.name, message: text };
      /* A message declaration is terminal even though its sender is still in a
       * tool turn. Tell the runner immediately so it can apply the same short
       * completion grace used for declarations in final answers. */
      try {
        this.onActivity({
          type: 'links-complete',
          agentId: rec.id,
          from,
          fromName: senderName,
          linksComplete: true,
        });
      } catch { /* scheduler hook is advisory */ }
    }

    const prefixed = source === 'user'
      ? `MESSAGE FROM ${senderName} (the user directing this crew):\n${text}`
      : `MESSAGE FROM ${senderName} (a crew member):\n${text}`;
    if (linksRosterMailbox) {
      /* Links owns roster scheduling. Coalesce ALL peer mail in the roster
       * inbox—even while its loop is running—so the bounded Links wake loop
       * accounts for one follow-up turn instead of AgentLoop secretly draining
       * each queued message as an uncounted conversation. */
      rec.inbox = rec.inbox || [];
      rec.inbox.push(prefixed);
      if (countAgainstBudget) this._bumpLink();
      const delivered = rec.status === 'stalled' ? 'stalled-wake'
        : !rec.loop ? 'pending-start'
          : rec.loop.running ? 'mailbox-running'
            : 'mailbox';
      this._emitDelivery(sender, rec, from, text, delivered, { fromName: senderName, source });
      /* Wake the Links scheduler without polling. A roster member can finish
       * while another peer is still working, leaving spare capacity; mailbox
       * arrival is therefore a scheduling event in its own right. */
      try { this.onActivity({ type: 'roster-mail', agentId: rec.id, from, delivered }); } catch { /* scheduler hook is advisory */ }
      return {
        ok: true,
        delivered,
        agentId: rec.id,
        name: rec.name,
        status: rec.status,
        inbox: rec.inbox.length,
        note: rec.status === 'stalled'
          ? `${rec.name} was stalled. Your message is queued and Links will wake it for another bounded turn.`
          : rec.loop?.running
            ? `${rec.name} is working. Links coalesced your message for one bounded follow-up turn.`
            : !rec.loop
              ? `${rec.name} has not started yet; your message will be waiting when it does.`
              : `${rec.name} is between Links rounds; your message is queued for its next turn.`,
      };
    }
    if (rec.origin === 'spawned' && rec.operatorAdded && rec.status === 'completed') {
      // Every turn of an operator-added helper shares the Links roster pool,
      // not just its first one. Preserve this message as the scheduled prompt;
      // later messages received while queued go through the queue branch below.
      rec.status = 'queued';
      rec.queuedPrompt = prefixed;
      rec.finishedAt = null;
      if (countAgainstBudget) this._bumpLink();
      this._emitDelivery(sender, rec, from, text, 'pending-start', { fromName: senderName, source });
      try {
        this.onActivity({
          type: 'operator-helper-queued', agentId: rec.id, from,
          fromName: senderName, delivered: 'pending-start',
        });
      } catch { /* scheduler hook is advisory */ }
      return {
        ok: true, delivered: 'pending-start', agentId: rec.id, name: rec.name,
        status: rec.status,
        note: `${rec.name}'s next turn is queued for shared team capacity.`,
      };
    }
    if (rec.origin === 'spawned' && rec.operatorAdded && rec.status === 'queued' && rec.store) {
      const depth = rec.store.enqueue(rec.id, prefixed);
      if (countAgainstBudget) this._bumpLink();
      this._emitDelivery(sender, rec, from, text, 'pending-start', { fromName: senderName, source });
      return {
        ok: true, delivered: 'pending-start', agentId: rec.id, name: rec.name,
        status: rec.status, inbox: depth,
        note: `${rec.name} is waiting for team capacity; your message is queued for its scheduled turn.`,
      };
    }
    if (rec.control?.paused && rec.store) {
      rec.store.enqueue(rec.id, prefixed);
      if (countAgainstBudget) this._bumpLink();
      this._emitDelivery(sender, rec, from, text, 'queued', { fromName: senderName, source });
      return { ok: true, delivered: 'queued', agentId: rec.id, name: rec.name, status: 'paused' };
    }
    if (!rec.loop) {
      // Pending member (chain: hasn't had its turn yet). Buffer the message;
      // it is prepended to the member's prompt when it starts.
      rec.inbox = rec.inbox || [];
      rec.inbox.push(prefixed);
      if (countAgainstBudget) this._bumpLink();
      this._emitDelivery(sender, rec, from, text, 'pending-start', { fromName: senderName, source });
      return { ok: true, delivered: 'pending-start', agentId: rec.id, name: rec.name, status: rec.status, note: `${rec.name} has not started yet; your message will be waiting when it does.` };
    }
    if (rec.loop.running) {
      // Fire-and-forget: AgentLoop enqueues internally while running.
      rec.loop.sendUserMessage(prefixed).catch((e) => this._settle(rec.id, 'failed', e.message));
      if (countAgainstBudget) this._bumpLink();
      this._emitDelivery(sender, rec, from, text, 'queued', { fromName: senderName, source });
      return { ok: true, delivered: 'queued', agentId: rec.id, name: rec.name, status: rec.status, note: 'The agent is working; your message is queued and it will read it when the current turn ends.' };
    }
    this._trackTask(rec.id, this._run(rec.id, prefixed));
    if (countAgainstBudget) this._bumpLink();
    this._emitDelivery(sender, rec, from, text, 'new-turn', { fromName: senderName, source });
    return { ok: true, delivered: 'new-turn', agentId: rec.id, name: rec.name, note: 'The agent was idle and has been woken with your message.' };
  }

  /* User/operator mail is deliberately distinct from peer mail:
   * - it cannot trip the LINKS: COMPLETE sentinel;
   * - it does not spend the agents' bounded peer-exchange budget;
   * - it is labelled as user direction in the receiving prompt and telemetry.
   * Existing pause/finished/inbox rules still apply, so this cannot silently
   * revoke an explicit user pause or resurrect a terminal failed worker. */
  sendFromUser({ to, message }) {
    return this.send({
      from: '__user__', to, message,
      fromName: 'You', source: 'user',
      countAgainstBudget: false,
      allowCompletion: false,
      exact: true,
    });
  }

  /* Links budget accounting: one unit per DELIVERED crew message. */
  _bumpLink() {
    if (this.linkBudget != null) this.linkSends++;
  }

  status(agentId, callerId) {
    const rec = this._resolve(agentId, callerId);
    if (!rec) return this._notFound(agentId);
    if (rec.ambiguous) return { ok: false, error: `"${agentId}" is ambiguous.`, candidates: rec.ambiguous };
    if (!rec.store) {
      return {
        ok: true, agentId: rec.id, name: rec.name, model: rec.model, origin: rec.origin,
        depth: rec.depth, status: rec.status, running: rec.status === 'running',
        note: 'Has not started yet (queued in the crew).', inbox: (rec.inbox || []).length,
        output: '', error: null, todos: [],
      };
    }
    const todos = (rec.store.get(rec.id).todos || []).map(t => ({ text: t.text || t.content || '', status: t.status || '' }));
    return {
      ok: true,
      agentId: rec.id,
      name: rec.name,
      model: rec.model,
      origin: rec.origin,
      depth: rec.depth,
      status: rec.status,
      running: !FINISHED.has(rec.status),
      ms: (rec.finishedAt || Date.now()) - rec.startedAt,
      messagesSent: rec.messagesSent,
      messagesReceived: rec.messagesReceived,
      inbox: (rec.inbox || []).length,
      todos,
      output: rec.output ? rec.output.slice(0, OUTPUT_PREVIEW) : '',
      error: rec.error,
    };
  }

  transcript(agentId, callerId, limit = TRANSCRIPT_MESSAGES) {
    const rec = this._resolve(agentId, callerId);
    if (!rec) return this._notFound(agentId);
    if (rec.ambiguous) return { ok: false, error: `"${agentId}" is ambiguous.`, candidates: rec.ambiguous };
    if (!rec.store) {
      return { ok: true, agentId: rec.id, name: rec.name, status: rec.status, count: 0, messages: [], note: 'Has not started yet.' };
    }
    const n = Math.max(1, Math.min(200, Number(limit) || TRANSCRIPT_MESSAGES));
    const messages = rec.store.get(rec.id).messages
      .filter(m => m && (m.role === 'user' || m.role === 'assistant'))
      .slice(-n)
      .map(m => ({ role: m.role, content: cleanOutput(m.content).slice(0, TRANSCRIPT_CHARS) }));
    return { ok: true, agentId: rec.id, name: rec.name, status: rec.status, count: messages.length, messages };
  }

  /* Block until a peer finishes. Cycle-checked: A awaiting B while B awaits A
   * would hang the crew, so refuse the edge that closes the loop. */
  async awaitAgent(agentId, callerId, { timeoutMs, signal } = {}) {
    const rec = this._resolve(agentId, callerId);
    if (!rec) return this._notFound(agentId);
    if (rec.ambiguous) return { ok: false, error: `"${agentId}" is ambiguous.`, candidates: rec.ambiguous };
    if (rec.id === callerId) return { ok: false, error: 'An agent cannot await itself.' };
    // A queued operator helper is waiting for a slot currently held by one or
    // more roster turns. Letting such a roster member block in agent.await can
    // deadlock a concurrency-1 team, so it must finish/yield its turn first.
    if (rec.operatorAdded && rec.status === 'queued') {
      return {
        ok: false,
        status: 'queued',
        error: `${rec.name} is queued for team capacity. Do not await it while holding a team slot; continue useful work or finish this turn so the scheduler can start it.`,
      };
    }
    const cycle = this._awaitCycle(callerId, rec.id);
    if (cycle) return { ok: false, error: `Circular await refused: ${cycle.join(' → ')}. Await something else or use agent.status to poll.` };

    const limit = Math.max(1000, Number(timeoutMs) || this.awaitTimeoutMs);
    const deadline = Date.now() + limit;
    this.awaiting.set(callerId, rec.id);
    try {
      while (!FINISHED.has(rec.status)) {
        if (this.stopped) return { ok: false, status: rec.status, error: 'The crew run was stopped while awaiting.' };
        if (signal?.aborted) return { ok: false, status: rec.status, error: 'Await interrupted.' };
        if (Date.now() > deadline) {
          return { ok: false, timedOut: true, status: rec.status, name: rec.name, output: rec.output.slice(0, OUTPUT_PREVIEW), error: `Timed out after ${Math.round(limit / 1000)}s; ${rec.name} is still ${rec.status}. Poll agent.status or await again.` };
        }
        await new Promise(r => setTimeout(r, 100));
      }
      return {
        ok: rec.status === 'completed',
        agentId: rec.id, name: rec.name, status: rec.status,
        output: rec.output.slice(0, OUTPUT_PREVIEW), error: rec.error,
        ms: (rec.finishedAt || Date.now()) - rec.startedAt,
      };
    } finally {
      this.awaiting.delete(callerId);
    }
  }

  _awaitCycle(callerId, targetId) {
    // Would caller→target close a loop through the existing await graph?
    const path = [callerId, targetId];
    let cur = targetId;
    for (let i = 0; i < this.agents.size + 2; i++) {
      const next = this.awaiting.get(cur);
      if (!next) return null;
      if (next === callerId) return [...path, next].map(id => this.agents.get(id)?.name || id);
      path.push(next);
      cur = next;
    }
    return null;
  }

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
    for (const id of this.agents.keys()) NET_BY_AGENT.delete(id);
  }

  snapshot() {
    return [...this.agents.values()].map(a => ({
      agentId: a.id, name: a.name, model: a.model, origin: a.origin, depth: a.depth,
      parentId: a.parentId, status: a.status, chars: a.output.length, error: a.error,
      output: a.output.slice(0, OUTPUT_PREVIEW),
    }));
  }
}

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
