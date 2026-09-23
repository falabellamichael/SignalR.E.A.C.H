'use strict';

module.exports = {
  _takeLinkInbox(index) {
    if (!this.net) return [];
    const rec = this.net.agents.get(`m${index}-${this.personas[index].id}`);
    if (!rec || !Array.isArray(rec.inbox) || !rec.inbox.length) return [];
    const box = rec.inbox.slice();
    rec.inbox = [];
    return box;
  },

  _restoreLinkInbox(index, messages) {
    if (!this.net || !messages?.length) return;
    const rec = this.net.agents.get(`m${index}-${this.personas[index].id}`);
    if (!rec) return;
    rec.inbox = [...messages, ...(rec.inbox || [])];
  },

  /* Wake a member for one more Links turn, re-using the SAME loop + store so
   * the member keeps its full conversation and everything it learned. */
  async _wakeMember(index, inbox, { synthesize = false, note = '', handoff = '' } = {}) {
    const persona = this.personas[index];
    const key = `m${index}-${persona.id}`;
    const store = this.memberStores.get(key);
    const conn = this._memberConn(index);
    if (!store || !this.loops.has(key)) {
      return { index, name: persona.name, model: conn.model, ok: false, output: '', status: 'error', error: 'Member loop was not kept alive for the Links round.' };
    }
    const control = this.controls[index];
    control.finished = false;
    // A queued Links batch may outlive the first active wake. If the user
    // pauses while another slot is still pending, do not let that later item
    // begin a provider request just because its previous turn was marked
    // finished (RunControl.pause intentionally ignores finished controls).
    if (this.userPaused) control.pause();
    await control.wait(() => this._stopSignal());
    if (this.stopped) {
      control.finished = true;
      return { index, name: persona.name, model: conn.model, ok: false, output: '', status: 'stopped', error: 'Stopped by you.', completedAt: Date.now(), wakeDeferred: true };
    }
    const parts = [`Original task:\n${this.task}`, this._crewContext(index, 'links')];
    const role = this._roleBlock(index);
    if (role) parts.push(role);
    parts.push(this._linksBlock());
    if (synthesize) {
      if (handoff) {
        parts.push(handoff);
        parts.push(`${note} You are asked for the FINAL SYNTHESIS: use the Team Nurse handoff above as the current crew state. Call agent.list / agent.status only if something is genuinely missing, then write the definitive answer to the original task now. State clearly what is DONE (with evidence), what is NOT, and what each unfinished piece still needs.`);
      } else {
        parts.push(`${note} You are asked for the FINAL SYNTHESIS: use the real crew state and agent.list / agent.status to collect any missing peer results, then write the definitive answer to the original task now. State clearly what is DONE (with evidence), what is NOT, and what each unfinished piece still needs.`);
      }
    } else {
      parts.push(`LINK MESSAGES from the crew (deliver on them, then continue your role's work):\n${inbox.join('\n\n')}`);
    }
    const prompt = parts.filter(Boolean).join('\n\n');
    this._emit('member-start', { index, name: persona.name, model: conn.model, role: this.roleOf(index), promptChars: prompt.length, retake: true });
    if (this.net) {
      const rec = this.net.agents.get(key);
      if (rec) rec.status = control.paused ? 'paused' : 'running';
    }
    let last;
    try {
      const end = await this._drive(key, index, persona, conn.model, prompt, control);
      last = this._asLinksResult(this._harvest(key, store, persona, index, conn.model, end.error, end.messageBoundary));
    } catch (e) {
      last = this._asLinksResult({ index, name: persona.name, model: conn.model, ok: false, output: '', status: 'error', error: e.message });
    }
    last.completedAt = Date.now();
    this.journal?.append('member-turn', { agentId: key, index, name: persona.name, model: conn.model,
      ok: last.ok, status: last.status, output: last.output, error: last.error, completedAt: last.completedAt });
    this._emit('member-done', { index, name: persona.name, ok: last.ok, chars: last.output.length, status: last.status, error: last.error, completionReason: last.completionReason, retake: true });
    if (this.net) this.net.syncMember(key, { status: last.status, error: last.error, output: last.output });
    control.finished = true;
    this.updatePausedState();
    return last;
  },
};
