'use strict';

const { decode: decodeLinksCode } = require('./links-code.cjs');

module.exports = ({ FINISHED }) => ({
  _emitDelivery(sender, rec, from, text, delivered, { fromName = '', source = 'agent' } = {}) {
    this.journal?.append('crew-message', { from, to: rec.id, source, message: text, delivered });
    require('./audit-event.cjs').auditEvent(this.auditLog, 'crew.handoff', { agent: from,
      allowed: true, detail: { to: rec.id, source, chars: text.length, delivered } });
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
  },

  send({ from, to, message, fromName = '', source = 'agent', countAgainstBudget = true, exact = false }) {
    if (this.stopped) return { ok: false, error: 'The crew run is stopped.' };
    const text = String(message || '').trim();
    if (!text) return { ok: false, error: 'A message is required.' };
    if (source === 'agent') {
      try { decodeLinksCode(text); }
      catch (error) { return { ok: false, code: 'invalid-links-code', error: error.message }; }
    }
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

    /* Bound accepted agent-to-agent messages across the crew. */
    if (countAgainstBudget && this.linkBudget != null && this.linkSends >= this.linkBudget) {
      return { ok: false, error: `Message handoff budget reached (${this.linkBudget} configured agent messages). Finish with what the crew has; ask the Coordinator to declare completion.` };
    }

    if (source === 'user') {
      const messages = Number(rec.operatorMessages || 0);
      const chars = Number(rec.operatorChars || 0);
      if (messages >= this.limits.operatorMessages || chars + text.length > this.limits.operatorChars) {
        return {
          ok: false,
          error: `Operator mailbox limit reached for ${rec.name} (${this.limits.operatorMessages} messages or ${this.limits.operatorChars.toLocaleString()} characters). Wait for it to process the current guidance.`,
          code: 'operator-queue-full',
        };
      }
      rec.operatorMessages = messages + 1;
      rec.operatorChars = chars + text.length;
    }

    const sender = this.agents.get(from);
    if (sender) sender.messagesSent++;
    rec.messagesReceived++;

    // Peer messages are data, including any completion claims they contain.
    // Only TeamRunner's validated terminal result can conclude the crew.
    const senderName = sender ? sender.name : (fromName || String(from));

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
  },

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
      exact: true,
    });
  },

  /* Links budget accounting: one unit per DELIVERED crew message. */
  _bumpLink() {
    if (this.linkBudget != null) this.linkSends++;
  },
});
