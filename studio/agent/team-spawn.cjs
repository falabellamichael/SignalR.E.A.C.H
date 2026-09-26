'use strict';

const { AgentLoop } = require('./agent-loop.cjs');
const { MemoryStore } = require('./memory-store.cjs');
const { RunControl } = require('./run-control.cjs');
const { registerNet } = require('./net-registry.cjs');
const { PROMPT: LINKS_CODE_PROMPT } = require('./links-code.cjs');

module.exports = ({ workerSoulKey, SUBAGENT_MAX_ROUNDS }) => ({
  spawn({ name, model = '', prompt = '', task, parentId = null, depth = 0, callerName = '', endpoint = '', accessKey = '', connectionId = '', deferStart = false, operatorAdded = false, soulKey: explicitSoulKey = '' }) {
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
    const useConnectionId = String(connectionId || '') || (parentRec && parentRec.connectionId) || '';
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
    const soulKey = requestedOk ? requestedKey : workerSoulKey(parentRec && parentRec.soulKey, workerName, this.limits.workerKeyChars);
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
      connectionId: useConnectionId,
      capabilityStore: this.capabilityStore,
      journal: this.journal,
      model: useModel,
      projectDir: this.projectDir,
      reachExecutor: this.reachExecutor,
      browserExecutor: this.browserExecutor,
      personaPrompt: this.rosterMailbox
        ? [String(prompt || ''), LINKS_CODE_PROMPT].filter(Boolean).join('\n\n')
        : String(prompt || ''),
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
      logger: this.logger,
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
      endpoint: useEndpoint || '', accessKey: useAccessKey || '', connectionId: useConnectionId,
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
    registerNet(id, this);
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
  },

  /* Start a worker that was deliberately admitted without running. This is
   * used only by the Links scheduler for operator-added helpers, keeping that
   * work inside the configured roster concurrency cap. */
});
