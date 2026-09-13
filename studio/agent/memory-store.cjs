'use strict';

/* Reach Studio — in-memory store implementing the slice of AgentStore that
 * AgentLoop depends on. Team members run through the SAME AgentLoop as a
 * normal conversation, but their transcripts are ephemeral: the member only
 * needs get / appendMessage / setMessages / setTodos / setRunState. The team
 * runner harvests the final assistant message from it afterwards.
 */

class MemoryStore {
  constructor() {
    this.records = new Map();
  }

  _rec(id) {
    if (!this.records.has(id)) {
      this.records.set(id, { id, messages: [], todos: [], runState: null, settings: {}, queue: [] });
    }
    const rec = this.records.get(id);
    if (!Array.isArray(rec.queue)) rec.queue = [];
    return rec;
  }

  get(id) { return this._rec(id); }

  appendMessage(id, message) {
    const r = this._rec(id);
    r.messages.push(message);
    return r;
  }

  setMessages(id, messages) {
    const r = this._rec(id);
    r.messages = Array.isArray(messages) ? messages : [];
    return r;
  }

  setTodos(id, todos) {
    const r = this._rec(id);
    r.todos = Array.isArray(todos) ? todos : [];
    return r;
  }

  setRunState(id, runState) {
    const r = this._rec(id);
    r.runState = runState;
    return r;
  }

  // Queue API — AgentLoop drains this at the end of every run. Members run a
  // single prompt so the queue stays empty, but the methods must exist.
  enqueue(id, text) {
    const r = this._rec(id);
    r.queue.push(String(text));
    return r.queue.length;
  }

  dequeue(id) {
    const r = this._rec(id);
    const text = r.queue.shift();
    return text === undefined ? null : text;
  }

  queueLength(id) {
    return this._rec(id).queue.length;
  }

  // The last assistant text the member produced — the team runner relays this
  // to the next member in a chain, and reports it for parallel fan-outs.
  lastAssistantText(id) {
    const r = this._rec(id);
    for (let i = r.messages.length - 1; i >= 0; i--) {
      const m = r.messages[i];
      if (m && m.role === 'assistant' && typeof m.content === 'string' && m.content.trim()) {
        return m.content.trim();
      }
    }
    return '';
  }
}

module.exports = { MemoryStore };
