'use strict';

module.exports = ({ FINISHED, cleanOutput }) => ({
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
      output: rec.output ? rec.output.slice(0, this.limits.outputPreview) : '',
      error: rec.error,
    };
  },

  transcript(agentId, callerId, limit = null) {
    const rec = this._resolve(agentId, callerId);
    if (!rec) return this._notFound(agentId);
    if (rec.ambiguous) return { ok: false, error: `"${agentId}" is ambiguous.`, candidates: rec.ambiguous };
    if (!rec.store) {
      return { ok: true, agentId: rec.id, name: rec.name, status: rec.status, count: 0, messages: [], note: 'Has not started yet.' };
    }
    // E14: transcriptMessages / transcriptChars are budgets fields. An explicit
    // caller limit still wins; otherwise the configured cap applies.
    const fallback = this.limits.transcriptMessages;
    const requested = Number(limit);
    const n = Math.max(1, Math.min(200, Number.isFinite(requested) && requested > 0 ? requested : fallback));
    const charCap = this.limits.transcriptChars;
    const messages = rec.store.get(rec.id).messages
      .filter(m => m && (m.role === 'user' || m.role === 'assistant'))
      .slice(-n)
      .map(m => ({ role: m.role, content: cleanOutput(m.content).slice(0, charCap) }));
    return { ok: true, agentId: rec.id, name: rec.name, status: rec.status, count: messages.length, messages };
  },

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
          return { ok: false, timedOut: true, status: rec.status, name: rec.name, output: rec.output.slice(0, this.limits.outputPreview), error: `Timed out after ${Math.round(limit / 1000)}s; ${rec.name} is still ${rec.status}. Poll agent.status or await again.` };
        }
        await new Promise(r => setTimeout(r, 100));
      }
      return {
        ok: rec.status === 'completed',
        agentId: rec.id, name: rec.name, status: rec.status,
        output: rec.output.slice(0, this.limits.outputPreview), error: rec.error,
        ms: (rec.finishedAt || Date.now()) - rec.startedAt,
      };
    } finally {
      this.awaiting.delete(callerId);
    }
  },

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
  },
});
