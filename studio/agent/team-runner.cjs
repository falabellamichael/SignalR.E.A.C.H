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
const { runToTerminal, MAX_RESUME_CYCLES: DRIVER_MAX_CYCLES } = require('./pause-resume.cjs');

const { resolveBudgets, cap } = require('./budgets.cjs');

const PARALLEL_CONCURRENCY = 3;
const MAX_RESUME_CYCLES = 6;
const RELAY_CHAR_BUDGET = 24000;

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
  constructor({ team, personas, roles = [], task, projectDir, endpoint, accessKey, defaultModel, reachExecutor, browserExecutor, sendEvent, requestApproval, requestEditReview, requestTimeoutMs, awaitEditResolution, requestMemberAnswer, concurrency = PARALLEL_CONCURRENCY, budgets = null, agentSettings = {}, auditLog = null }) {
    this.agentSettings = agentSettings;
    this.budgets = budgets;
    // Shared security audit log: every member runs tools, so every member's
    // sandbox denials must be recorded, not just the orchestrator's.
    this.auditLog = auditLog;
    this.team = team;
    this.personas = personas;            // resolved persona objects in roster order
    this.roles = Array.isArray(roles) ? roles : [];
    this.task = String(task || '');
    this.projectDir = projectDir || '';
    this.endpoint = endpoint;
    this.accessKey = accessKey;
    this.defaultModel = defaultModel;
    this.reachExecutor = reachExecutor;
    this.browserExecutor = browserExecutor;
    this.sendEvent = sendEvent;
    this.requestApproval = requestApproval;
    this.requestEditReview = requestEditReview;
    this.requestTimeoutMs = budgets?.requestTimeoutMs ?? requestTimeoutMs;
    this.awaitEditResolution = awaitEditResolution;
    this.requestMemberAnswer = requestMemberAnswer;
    this.concurrency = budgets ? cap(budgets.teamConcurrency) : Math.max(1, Number(concurrency) || PARALLEL_CONCURRENCY);
    this.loops = new Map();              // memberKey -> AgentLoop
    this.memberStores = new Map();       // memberKey -> MemoryStore (for resume)
    this.memberEdits = new Map();        // memberKey -> [edit] proposed this pause cycle
    this.stopped = false;
    this.paused = false;
    this.controls = this.personas.map((persona, index) => new RunControl(null, paused => {
      this.net?.syncMember(`m${index}-${persona.id}`, { status: paused ? 'paused' : 'running' });
      this._emit('member-control', { index, name: persona.name, paused });
    }));
    this.running = true;
    // Resolves when stop() is called so pause waits can race it and unwind.
    this._stopDeferred = null;
  }

  _stopSignal() {
    if (!this._stopDeferred) {
      let resolve;
      const p = new Promise(r => { resolve = r; });
      this._stopDeferred = { promise: p, resolve };
    }
    return this._stopDeferred.promise;
  }

  _emit(type, payload = {}) {
    this.sendEvent('team:event', { teamRunId: this.teamRunId, type, ...payload });
  }

  roleOf(index) {
    const fromRoster = (this.team.members[index] || {}).role;
    return String(fromRoster || this.roles[index] || '').trim();
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
      : 'You are one member of a crew working the SAME task simultaneously. Produce your own complete, self-contained answer from your own perspective and role. Do not assume another member covers a part of it, and do not reference work you cannot see.';
    return `CREW CONTEXT (this run has ${this.personas.length} members, mode: ${mode}):\n${roster}\n\n${you}\n${shape}`;
  }

  async run(teamRunId) {
    this.teamRunId = teamRunId;
    const mode = this.team.mode === 'chain' ? 'chain' : 'parallel';
    // One network per crew run: roster members register into it, and any of
    // them may spawn/message/await peers through the agent.* collab tools.
    this.net = new AgentNet({
      agentSettings: this.agentSettings,
      teamRunId,
      teamName: this.team.name,
      onSettled: () => this.updatePausedState(),
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
    });
    this._emit('start', {
      teamName: this.team.name,
      mode,
      members: this.personas.map((p, i) => ({ index: i, name: p.name, model: p.model || this.defaultModel, role: this.roleOf(i) })),
      task: this.task,
    });
    // Pre-register the whole roster so every member can see and address its
    // peers from its FIRST turn (agent.list / agent.send / agent.status),
    // even chain members that have not started yet.
    this.personas.forEach((p, i) => {
      this.net.preRegister({
        agentId: `m${i}-${p.id}`,
        name: p.name,
        model: p.model || this.defaultModel,
        prompt: p.prompt || '',
        depth: 0,
        task: this.task,
      });
    });

    const results = [];
    try {
      if (mode === 'parallel') {
        const settled = await mapWithConcurrency(this.personas, this.concurrency, (p, i) =>
          this._runMember(p, i, this._memberPrompt(i, mode, [])));
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
    } catch (e) {
      this._emit('error', { message: e.message });
    } finally {
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
      results: results.map(r => ({ index: r.index, name: r.name, ok: r.ok, status: r.status || null, error: r.error || null, chars: (r.output || '').length })),
      // The crew answer: chain → last successful output; parallel → all outputs.
      answer: mode === 'chain'
        ? (results.length && results[results.length - 1].ok ? results[results.length - 1].output : '')
        : results.map(r => `【${r.name}】\n${r.ok ? r.output : '(failed: ' + (r.error || 'unknown') + ')'}`).join('\n\n'),
    });
    return results;
  }

  _handoffEntry(index, output) {
    const p = this.personas[index];
    const role = this.roleOf(index);
    return `HANDOFF FROM ${p.name}${role ? ` (${role})` : ''} — crew member ${index + 1}/${this.personas.length}:\n${output}`;
  }

  _memberPrompt(index, mode, handoffs) {
    const crew = this._crewContext(index, mode);
    if (mode === 'chain' && handoffs.length) {
      return `${this.task}\n\n${crew}\n\n${boundedRelay(handoffs, this.budgets?.relayChars ?? RELAY_CHAR_BUDGET)}`;
    }
    return `${this.task}\n\n${crew}`;
  }

  async _runMember(persona, index, prompt) {
    const key = `m${index}-${persona.id}`;
    const store = new MemoryStore();
    Object.assign(store.get(key).settings, structuredClone(this.agentSettings));
    const model = persona.model || this.defaultModel || 'gpt-4o-mini';
    const loop = new AgentLoop({
      agentId: key,
      store,
      endpoint: this.endpoint,
      accessKey: this.accessKey,
      model,
      projectDir: this.projectDir,
      reachExecutor: this.reachExecutor,
      browserExecutor: this.browserExecutor,
      personaPrompt: persona.prompt || '',
      requestTimeoutMs: this.requestTimeoutMs,
      budgets: this.budgets,
      auditLog: this.auditLog,
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
      // Shared pause/resume driver (same one AgentNet workers use): drives the
      // loop to a terminal state, surfacing edit-review and question pauses.
      const end = await runToTerminal({
        loop,
        store,
        agentId: key,
        firstPrompt: fullPrompt,
        control,
        maxCycles: cap(this.budgets?.resumeCycles ?? MAX_RESUME_CYCLES),
        isStopped: () => this.stopped,
        stopSignal: () => this._stopSignal(),
        getPendingEdits: () => this.memberEdits.get(key) || [],
        clearPendingEdits: () => this.memberEdits.set(key, []),
        awaitEditResolution: this.awaitEditResolution,
        requestMemberAnswer: this.requestMemberAnswer
          ? (q) => this.requestMemberAnswer({ ...q, index, name: persona.name, model })
          : null,
        onWaiting: (edits) => this._emit('member-waiting', {
          index, name: persona.name, status: 'waiting_edits',
          edits: edits.map(e => ({ editId: e.editId, path: e.path, stats: e.stats })),
        }),
        onQuestion: (questionId, question) => this._emit('member-question', { index, name: persona.name, questionId, question }),
        onResumed: (cycle, status) => this._emit('member-resumed', { index, name: persona.name, cycle, status }),
      });
      last = this._harvest(key, store, persona, index, model, end.error);
      this._emit('member-done', { index, name: persona.name, ok: last.ok, chars: last.output.length, status: last.status, error: last.error });
      return last;
    } catch (e) {
      last = { index, name: persona.name, model, ok: false, output: '', status: 'error', error: e.message };
      this._emit('member-done', { index, name: persona.name, ok: false, error: e.message });
      return last;
    } finally {
      control.finished = true;
      this.loops.delete(key);
      this.memberStores.delete(key);
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
  _harvest(key, store, persona, index, model, driverError = null) {
    const output = cleanOutput(store.lastAssistantText(key));
    const runState = store.get(key).runState;
    const status = runState?.status || 'unknown';
    const ok = !this.stopped && !!output && status === 'completed' && !driverError;
    const error = ok
      ? null
      : (this.stopped ? 'Stopped by you.' : driverError || runState?.reason || `Member ${status}; no completed answer.`);
    return { index, name: persona.name, model, ok, output, status, error, question: runState?.reason || null };
  }

  stop() {
    this.stopped = true;
    for (const loop of this.loops.values()) loop.stop();
    if (this.net) this.net.stop();
    if (this._stopDeferred) this._stopDeferred.resolve();
  }

  pause() {
    this.paused = true;
    for (const control of this.controls) control.pause();
    this.net?.pause();
    this._emit('control', { paused: true });
  }

  resume() {
    this.paused = false;
    for (const control of this.controls) control.resume();
    this.net?.resume();
    this._emit('control', { paused: false });
  }

  controlMember(index, start) {
    if (!Number.isInteger(index) || !this.controls[index]) throw new Error('Team member not found.');
    const control = this.controls[index];
    if (control.finished) throw new Error('This member has already finished.');
    if (start) { if (this.net) this.net.paused = false; control.resume(); }
    else control.pause();
    this.updatePausedState();
  }

  updatePausedState() {
    this.paused = this.controls.every(c => c.finished || c.paused) && (!this.net || this.net.workersPaused());
    this._emit('control', { paused: this.paused });
  }
}

module.exports = { TeamRunner, cleanOutput, boundedRelay, mapWithConcurrency, PARALLEL_CONCURRENCY, MAX_RESUME_CYCLES };
