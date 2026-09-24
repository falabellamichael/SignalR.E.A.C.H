'use strict';

const { AgentLoop } = require('./agent-loop.cjs');
const { MemoryStore } = require('./memory-store.cjs');
const { runToTerminal } = require('./pause-resume.cjs');
const { cap } = require('./budgets.cjs');

module.exports = ({ cleanOutput, assistantTextSince, linksCompleteIn, MAX_RESUME_CYCLES }) => ({
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
  },

  async _runMember(persona, index, prompt, { keep = false } = {}) {
    const key = `m${index}-${persona.id}`;
    /* Give this member its OWN SOUL.md + MEMORY.md if it does not have them
     * yet. A persona created before the soul feature existed, or whose files
     * were removed by hand, would otherwise run through a crew with no persona
     * or memory at all while a fresh one had both — the difference would be
     * invisible until an agent behaved differently than its card suggested.
     * scaffold() only ever creates MISSING files, so this can never overwrite
     * an agent's own writing, and a failure here must not stop the run: the
     * member simply runs without a soul block, exactly as before the feature. */
    try { this.soulStore?.scaffold?.(persona.id, { name: persona.name, role: this.roleOf(index) }); }
    catch { /* soul files are best-effort; never break the run over them */ }
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
      ...(conn.connectionId ? { connectionId: conn.connectionId } : {}),
      capabilityStore: this.capabilityStore,
      journal: this.journal,
      model,
      projectDir: this.projectDir,
      reachExecutor: this.reachExecutor,
      browserExecutor: this.browserExecutor,
      personaPrompt: persona.prompt || '',
      soulStore: this.soulStore,
      // The KEY is the persona id, NOT the run-scoped member key (`m0-<id>`):
      // the roster position must not change which files an agent owns, or a
      // persona would lose its memory every time the roster was reordered.
      soulKey: persona.id,
      requestTimeoutMs: this.requestTimeoutMs,
      budgets: this.budgets,
      jev: this.jev,
      featureMask: this.featureMask,
      auditLog: this.auditLog,
      logger: this.logger,
      nativeTools: this.nativeTools,
      sendEvent: (_channel, payload) => {
        // Tag every loop event with member identity and forward it.
        // Field order matters: spread the inner event FIRST, then override
        // type/index/name — otherwise the inner type clobbers 'member'.
        if (!payload || payload.agentId !== key) return;
        if (payload.type === 'message' && payload.role === 'user') this.nurse?.acknowledgeUserPackets(key, payload.content);
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
      const rec = this.net.attach(key, loop, store, persona.id);
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
      this.journal?.append('member-turn', { agentId: key, index, name: persona.name, model,
        ok: last.ok, status: last.status, output: last.output, error: last.error, completedAt: last.completedAt });
      this._emit('member-done', { index, name: persona.name, ok: last.ok, chars: last.output.length, status: last.status, error: last.error, completionReason: last.completionReason });
      return last;
    } catch (e) {
      last = this._asLinksResult({ index, name: persona.name, model, ok: false, output: '', status: 'error', error: e.message });
      last.completedAt = Date.now();
      this.journal?.append('member-turn', { agentId: key, index, name: persona.name, model,
        ok: false, status: last.status, output: '', error: last.error, completedAt: last.completedAt });
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
  },

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
  },
});
