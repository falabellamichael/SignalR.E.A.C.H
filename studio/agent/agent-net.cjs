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

/* Strip the run-control fence: relay only what a human would read. */
function cleanOutput(text) {
  try {
    const parsed = parseAgentResponse(text);
    return (parsed.display || parsed.confirm?.question || '').trim();
  } catch {
    return String(text || '').trim();
  }
}

/* agentId -> net, so collab tools can find their network from tool context. */
const NET_BY_AGENT = new Map();
function netForAgent(agentId) { return NET_BY_AGENT.get(agentId) || null; }

const FINISHED = new Set(['completed', 'failed', 'stopped', 'abandoned']);

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
    maxAgents = MAX_AGENTS,
    maxDepth = MAX_DEPTH,
    awaitTimeoutMs = DEFAULT_AWAIT_TIMEOUT,
    onSettled = () => {},
  } = {}) {
    this.budgets = budgets;
    this.agentSettings = agentSettings;
    this.onSettled = onSettled;
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
    this.stopped = false;
    this.paused = false;
    this._stopDeferred = null;
    this.seq = 0;
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
    this.sendEvent('team:event', { teamRunId: this.teamRunId, type: 'subagent', netType, ...payload });
  }

  /* Register an agent the net did not create itself (a roster member). The
   * caller owns its loop; the net only tracks and routes messages to it. */
  register({ agentId, name, model = '', prompt = '', depth = 0, parentId = null, loop, store, task = '' }) {
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
  preRegister({ agentId, name, model = '', prompt = '', depth = 0, task = '' }) {
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
  attach(agentId, loop, store) {
    const rec = this.agents.get(agentId);
    if (!rec) return null;
    rec.loop = loop;
    rec.store = store;
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

  depthOf(agentId) {
    return this.agents.get(agentId)?.depth || 0;
  }

  /* Spawn a background worker. Returns immediately with an id — the caller
   * keeps working and can poll (agent.status), await, or message it. */
  spawn({ name, model = '', prompt = '', task, parentId = null, depth = 0, callerName = '' }) {
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
    const useModel = String(model || '').trim() || this.defaultModel || 'gpt-4o-mini';
    const loop = new AgentLoop({
      agentId: id,
      store,
      endpoint: this.endpoint,
      accessKey: this.accessKey,
      model: useModel,
      projectDir: this.projectDir,
      reachExecutor: this.reachExecutor,
      browserExecutor: this.browserExecutor,
      personaPrompt: String(prompt || ''),
      requestTimeoutMs: this.requestTimeoutMs,
      budgets: this.budgets ? { ...this.budgets, maxRounds: this.budgets.subagentMaxRounds } : null,
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

    const rec = {
      id, name: String(name).trim(), model: useModel, prompt: String(prompt || ''),
      depth: childDepth, parentId: parentId || null, origin: 'spawned',
      loop, store, status: 'starting', output: '', error: null, task: cleanTask,
      startedAt: Date.now(), finishedAt: null, messagesSent: 0, messagesReceived: 0,
      spawnedBy: callerName || null,
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
    });
    this.tasks.push(this._run(id, cleanTask));
    return { ok: true, agentId: id, name: rec.name, model: useModel, depth: childDepth, task: cleanTask, async: true };
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
          ? (q) => this.requestMemberAnswer({ ...q, name: rec.name, model: rec.model, subagent: true })
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
  send({ from, to, message }) {
    if (this.stopped) return { ok: false, error: 'The crew run is stopped.' };
    const text = String(message || '').trim();
    if (!text) return { ok: false, error: 'A message is required.' };
    const rec = this._resolve(to, from);
    if (!rec) return this._notFound(to);
    if (rec.ambiguous) return { ok: false, error: `"${to}" matches several agents: ${rec.ambiguous.map(a => a.agentId).join(', ')}. Address one by id.`, candidates: rec.ambiguous };
    if (rec.id === from) return { ok: false, error: 'An agent cannot message itself.' };

    const sender = this.agents.get(from);
    if (sender) sender.messagesSent++;
    rec.messagesReceived++;

    const prefixed = `MESSAGE FROM ${sender ? sender.name : from} (a crew member):\n${text}`;
    if (rec.control?.paused && rec.store) {
      rec.store.enqueue(rec.id, prefixed);
      return { ok: true, delivered: 'queued', agentId: rec.id, name: rec.name, status: 'paused' };
    }
    if (!rec.loop) {
      // Pending member (chain: hasn't had its turn yet). Buffer the message;
      // it is prepended to the member's prompt when it starts.
      rec.inbox = rec.inbox || [];
      rec.inbox.push(prefixed);
      this._emit('agent-message', { from, to: rec.id, toName: rec.name, chars: text.length, delivered: 'pending-start' });
      return { ok: true, delivered: 'pending-start', agentId: rec.id, name: rec.name, status: rec.status, note: `${rec.name} has not started yet; your message will be waiting when it does.` };
    }
    if (rec.loop.running) {
      // Fire-and-forget: AgentLoop enqueues internally while running.
      rec.loop.sendUserMessage(prefixed).catch((e) => this._settle(rec.id, 'failed', e.message));
      this._emit('agent-message', { from, to: rec.id, toName: rec.name, chars: text.length, delivered: 'queued' });
      return { ok: true, delivered: 'queued', agentId: rec.id, name: rec.name, status: rec.status, note: 'The agent is working; your message is queued and it will read it when the current turn ends.' };
    }
    if (rec.origin === 'roster' && FINISHED.has(rec.status)) {
      // Roster members are owned by the TeamRunner; waking one here would run
      // it outside the crew's result accounting. Its answer is already in the
      // handoff relay / parallel results.
      return { ok: false, error: `${rec.name} already finished (${rec.status}) and its answer is part of the crew's results. It cannot be woken.` };
    }
    if (FINISHED.has(rec.status) && rec.status !== 'completed') {
      return { ok: false, error: `${rec.name} already ${rec.status}${rec.error ? ': ' + rec.error : ''}. It cannot be woken.`, status: rec.status };
    }
    this.tasks.push(this._run(rec.id, prefixed));
    this._emit('agent-message', { from, to: rec.id, toName: rec.name, chars: text.length, delivered: 'new-turn' });
    return { ok: true, delivered: 'new-turn', agentId: rec.id, name: rec.name, note: 'The agent was idle and has been woken with your message.' };
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
    }));
    return { ok: true, team: this.teamName, count: agents.length, maxAgents: this.maxAgents, agents };
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
    for (const rec of this.agents.values()) if (rec.origin === 'spawned') rec.control?.pause();
  }

  resume() {
    this.paused = false;
    for (const rec of this.agents.values()) if (rec.origin === 'spawned') rec.control?.resume();
  }

  controlWorker(id, start) {
    const rec = this.agents.get(id);
    if (rec?.origin !== 'spawned' || !rec.control || rec.control.finished) throw new Error('No unfinished worker with this id.');
    if (start) { this.paused = false; rec.control.resume(); }
    else rec.control.pause();
  }

  /* Update a REGISTERED (roster) member's record when its runner finishes it.
   * No subagent event: the renderer tracks roster members by index, and an
   * agent-state emit would spawn a phantom worker card. */
  syncMember(agentId, { status, error = null, output = null }) {
    const rec = this.agents.get(agentId);
    if (!rec || rec.origin !== 'roster') return;
    rec.status = status;
    if (error !== null) rec.error = error;
    if (output) rec.output = output;
    rec.finishedAt = Date.now();
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
  MAX_AGENTS,
  MAX_DEPTH,
  SUBAGENT_MAX_ROUNDS,
};
