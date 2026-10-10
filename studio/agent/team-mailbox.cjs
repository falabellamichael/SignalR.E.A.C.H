'use strict';

/* Unified crew mailbox + shared Notes.
 *
 * Per-agent inboxes are routing state: a message lands in ONE peer's box and
 * is consumed by that peer's next turn. That is fine for delivery but bad for
 * awareness — a coordinator that needs "what has the crew been saying" had no
 * place to look, and a finding meant for everyone had to be sent N times.
 *
 * The mailbox is the additive fix: _emitDelivery records every accepted
 * message (peer, user, nurse) into one bounded crew-wide log, and broadcasts
 * (agent.mail op send to 'all') live ONLY here — no inbox, no wake, peers pick
 * them up on their next read. Notes is the companion bulletin board: longer-
 * lived findings a member pins for the whole crew to cite.
 *
 * Bounded like every other shared structure in this file: an unbounded mail
 * log is a prompt-injection amplifier on the next read.
 */

const MAILBOX_MAX_ENTRIES = 300;
const MAIL_ENTRY_CHARS = 20000;   // stored text per entry
const MAIL_READ_CHARS = 2000;     // text shown per entry on read
const NOTES_MAX = 100;
const NOTE_CHARS = 8000;

module.exports = () => ({
  /* Single funnel: called by _emitDelivery for every ACCEPTED delivery, so the
   * mailbox sees exactly the mail peers see — no separate write path to drift. */
  _recordMail({ from, fromName, to, toName, text, source, delivered }) {
    this.mail ||= [];
    this.mail.push({
      at: Date.now(), from, fromName: String(fromName || from),
      to, toName: String(toName || to), source, delivered,
      text: String(text || '').slice(0, MAIL_ENTRY_CHARS),
    });
    while (this.mail.length > MAILBOX_MAX_ENTRIES) this.mail.shift();
  },

  /* Crew-wide mail: addressed to everyone, delivered only through the mailbox.
   * No inbox copy and no wake — an idle peer is not charged a turn for a note
   * it may not need. It reads the board when its own work calls for context. */
  broadcast({ from, message, fromName = '', source = 'agent' }) {
    if (this.stopped) return { ok: false, error: 'The crew run is stopped.' };
    const text = String(message || '').trim();
    if (!text) return { ok: false, error: 'A message is required.' };
    const sender = this.agents.get(from);
    const senderName = sender ? sender.name : (fromName || String(from));
    this._recordMail({ from, fromName: senderName, to: '*', toName: 'crew', text, source, delivered: 'mailbox' });
    if (sender) sender.messagesSent++;
    this.journal?.append('crew-message', { from, to: '*', source, message: text, delivered: 'mailbox' });
    this._emit('agent-message', {
      from, fromName: senderName, source, to: '*', toName: 'crew',
      chars: text.length, delivered: 'mailbox',
      messagesSent: sender ? sender.messagesSent : 0,
    });
    return { ok: true, delivered: 'mailbox', note: 'Posted to the crew mailbox. Every agent sees it on its next agent.mail read; nobody was woken for it.' };
  },

  /* Read the unified mailbox. Default: the whole crew's recent mail, newest
   * last. `agent` narrows to mail that agent sent or received — the caller may
   * pass a peer's name/id or omit it for "me". */
  mailbox(callerId, { agent = '', limit = 20 } = {}) {
    const all = this.mail || [];
    let wanted = '';
    const filter = String(agent || '').trim();
    if (filter) {
      const rec = filter === callerId ? this.agents.get(callerId) : this._resolve(filter, callerId);
      if (!rec) return this._notFound(filter);
      if (rec.ambiguous) return { ok: false, error: `"${filter}" matches several agents: ${rec.ambiguous.map(a => a.agentId).join(', ')}.`, candidates: rec.ambiguous };
      wanted = rec.id;
    }
    const entries = (wanted ? all.filter(e => e.from === wanted || e.to === wanted) : all)
      .slice(-Math.max(1, Math.min(Number(limit) || 20, 100)));
    return {
      ok: true,
      team: this.teamName,
      total: all.length,
      shown: entries.length,
      entries: entries.map(e => ({
        at: new Date(e.at).toISOString(), from: e.fromName, to: e.toName,
        source: e.source, delivered: e.delivered, text: e.text.slice(0, MAIL_READ_CHARS),
      })),
      notes: (this.notes || []).length,
      guidance: 'Broadcast to the whole crew with agent.mail { op: "send", to: "all", message: "..." }. Pin a finding for everyone with op "note".',
    };
  },

  /* The shared Notes board: findings, decisions and references the whole crew
   * can cite. Append-only — a peer rewriting another peer's note is how a
   * mailbox becomes an argument. */
  postNote(callerId, entry) {
    if (this.stopped) return { ok: false, error: 'The crew run is stopped.' };
    const text = String(entry || '').trim();
    if (!text) return { ok: false, error: 'A note is required.' };
    const rec = this.agents.get(callerId);
    this.notes ||= [];
    if (this.notes.length >= NOTES_MAX) return { ok: false, error: `The Notes board is full (${NOTES_MAX} entries). Ask the user to restart or work without it.` };
    const note = { at: Date.now(), by: callerId, byName: rec ? rec.name : String(callerId), text: text.slice(0, NOTE_CHARS) };
    this.notes.push(note);
    this.journal?.append('crew-note', { from: callerId, chars: note.text.length });
    this._emit('crew-note', { agentId: callerId, name: note.byName, chars: note.text.length });
    return { ok: true, notes: this.notes.length, appended: note.text.slice(0, 200) };
  },

  crewNotes() {
    const notes = this.notes || [];
    return {
      ok: true,
      count: notes.length,
      notes: notes.map(n => ({ at: new Date(n.at).toISOString(), by: n.byName, text: n.text })),
    };
  },
});
