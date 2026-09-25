'use strict';
const { randomUUID } = require('node:crypto');

// Main-process ownership keeps delivery alive when the renderer changes chats.
// The store persists pending text; recovery never automatically starts paid work.
class TeamMessageQueue {
  constructor({ read, write, notify, findRun, judge, steer, dispatch, applied }) {
    Object.assign(this, { read, write, notify, findRun, judge, steer, dispatch, applied });
    this.loaded = new Set();
    this.launching = new Set();
    this.checks = new Map();
  }
  list(agentId) {
    let items = this.read(agentId) || [];
    if (!this.loaded.has(agentId)) {
      this.loaded.add(agentId);
      items = items.map(item => ({ ...item, state: 'queued', hold: true, note: 'Restored after restart. Send when ready.' }));
      if (items.length) this.write(agentId, items);
    }
    return items.map(item => ({ ...item }));
  }
  save(agentId, items, delivery) {
    this.write(agentId, items);
    this.notify(agentId, items, delivery);
  }
  patch(agentId, id, patch) {
    const items = this.list(agentId);
    const item = items.find(item => item.id === id);
    if (!item) return null;
    Object.assign(item, patch);
    this.save(agentId, items);
    return item;
  }
  enqueue(agentId, { teamId, teamRunId, message, target = '', mode = 'auto', useHistory = true }) {
    const items = this.list(agentId);
    const text = String(message || '').trim();
    if (!text || text.length > 20000) throw new Error('Team messages must contain 1–20,000 characters.');
    if (items.length >= 20 || items.reduce((n, item) => n + item.message.length, 0) + text.length > 80000) throw new Error('The team message queue is full. Remove or deliver a queued message first.');
    if (!['auto', 'queue', 'steer'].includes(mode)) throw new Error('Unknown team delivery mode.');
    const item = { id: randomUUID(), teamId, teamRunId, message: text, target, mode, useHistory, createdAt: Date.now(), state: mode === 'auto' ? 'checking' : 'queued', note: mode === 'auto' ? 'Jev is checking priority…' : 'Next team turn' };
    this.save(agentId, [...items, item]);
    // Run after the caller receives its acknowledgement; each message is judged once.
    queueMicrotask(() => this.route(agentId, item).catch(error => this.patch(agentId, item.id, { state: 'queued', note: error.message })));
    return item;
  }
  async route(agentId, item) {
    let decision = { steer: item.mode === 'steer', reason: 'manual' };
    if (item.mode === 'auto') {
      const controller = new AbortController();
      this.checks.set(item.id, controller);
      try { decision = await this.judge(agentId, item, controller.signal); }
      finally { this.checks.delete(item.id); }
    }
    const current = this.list(agentId).find(entry => entry.id === item.id);
    if (!current || current.state !== (item.mode === 'auto' ? 'checking' : 'queued')) return;
    if (!this.patch(agentId, item.id, { state: 'queued', priority: decision, note: decision.steer ? 'Important · ready to steer' : decision.reason === 'can-wait' ? 'Jev: can wait · next team turn' : item.mode === 'queue' ? 'Next team turn' : 'Priority unavailable · next team turn' })) return;
    const run = this.findRun(agentId);
    // A late classification can never steer a replacement run.
    if (decision.steer && run?.teamRunId === item.teamRunId) this.promote(agentId, item.id);
    if (!run) await this.drain(agentId);
  }
  promote(agentId, id) {
    const item = this.list(agentId).find(item => item.id === id);
    if (!item || ['steering', 'starting'].includes(item.state)) return { ok: false, err: 'This message has already started delivery.' };
    const run = this.findRun(agentId);
    if (!run) return { ok: false, err: 'There is no active team. Use Send now for a new team turn.' };
    if (run.team.id !== item.teamId || run.teamRunId !== item.teamRunId) return { ok: false, err: 'The original team run has ended. This message remains queued for its next turn.' };
    this.checks.get(id)?.abort();
    this.patch(agentId, id, { state: 'steering', note: 'Nurse carrying guidance · waiting for a safe boundary' });
    let result;
    try { result = this.steer(run, item, () => {
      const current = this.list(agentId).find(entry => entry.id === id);
      if (!current) return;
      this.applied(agentId, current);
      this.save(agentId, this.list(agentId).filter(entry => entry.id !== id), { ...current, state: 'delivered', note: 'Team Nurse handed your guidance to the member' });
    }); } catch (error) { result = { ok: false, error: error.message }; }
    if (!result.ok) this.patch(agentId, id, { state: 'queued', note: result.error || result.err });
    return { ...result, err: result.error || result.err };
  }
  cancel(agentId, id) {
    const items = this.list(agentId), item = items.find(item => item.id === id);
    if (!item) return { ok: false, err: 'Message is no longer queued.' };
    if (['steering', 'starting'].includes(item.state)) return { ok: false, err: 'This message is already being delivered.' };
    this.checks.get(id)?.abort();
    this.save(agentId, items.filter(item => item.id !== id));
    return { ok: true };
  }
  retrySteering(agentId, teamRunId) {
    for (const item of this.list(agentId)) {
      if (item.teamRunId === teamRunId && item.state === 'queued' && !item.hold && (item.priority?.steer || item.mode === 'steer')) this.promote(agentId, item.id);
    }
  }
  async drain(agentId, force = false) {
    if (this.launching.has(agentId) || this.findRun(agentId)) return;
    const item = this.list(agentId)[0];
    if (!item || item.state !== 'queued' || item.hold && !force) return;
    this.launching.add(agentId);
    this.patch(agentId, item.id, { state: 'starting', note: 'Starting next team turn…' });
    let result;
    try {
      result = await this.dispatch(agentId, item);
      if (result.ok) this.save(agentId, this.list(agentId).filter(entry => entry.id !== item.id));
      else this.patch(agentId, item.id, { state: 'queued', note: result.err || 'Could not start this team. Try Send now.' });
    } catch (error) { this.patch(agentId, item.id, { state: 'queued', note: error.message }); }
    finally { this.launching.delete(agentId); }
    if (result?.ok && !this.findRun(agentId)) await this.drain(agentId);
  }
  finished(agentId, teamRunId, continueQueue) {
    const items = this.list(agentId).map(item => item.teamRunId !== teamRunId ? item
      : !continueQueue ? { ...item, state: 'queued', hold: true, note: 'Run stopped · send this queued message when ready' }
        : item.state === 'steering' ? { ...item, state: 'queued', note: 'Run ended before guidance was delivered · next team turn' } : item);
    this.save(agentId, items);
    if (continueQueue) void this.drain(agentId);
  }
}
module.exports = { TeamMessageQueue };
