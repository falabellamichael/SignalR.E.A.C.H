'use strict';

/* Reach Studio — conversation (chat/agent) persistence.
 *
 * Conversations are project-scoped: every chat binds to a project directory,
 * and chats can BRANCH — a fork copies the parent's history up to a message
 * index and continues independently (parentChatId + forkIndex record the
 * lineage, so the sidebar can render the conversation tree per project).
 * The whole thing lives in one JSON document under userData/agents.json.
 * Writes are atomic (write tmp + rename) so a crash mid-turn can never
 * truncate the store.
 *
 * Item 1.5 bounds that document: a conversation that grows past
 * MAX_CONVERSATION_BYTES has its oldest messages moved to the append-only
 * userData/agents/<id>.history.jsonl (readArchive). Trimming archives, it never
 * deletes — the operator's instructions and the newest message always stay live.
 *
 * Message provenance uses the same _reachMeta convention as the VS Code
 * extension (context.js), so compaction metadata survives the round trip.
 */

const fs = require('fs');
const path = require('path');

const { resolveBudgets } = require('./budgets.cjs');
const { atomicWriteJson } = require('./atomic-write.cjs');

const MAX_AGENTS = 200;
const MAX_STORED_MESSAGES = 400;
// Item 1.5: every conversation is serialized into agents.json on every save, so
// one unbounded chat inflates every write and risks the whole store. Messages
// above this ceiling move to the append-only archive below — never deleted (A4).
const MAX_CONVERSATION_BYTES = 8 * 1024 * 1024;
const ARCHIVE_PINNED = 4;  // leading system/developer instructions are never archived
const ARCHIVE_FLOOR = 1;   // the newest message is never archived

class AgentStore {
  constructor(filePath, getSettings = () => ({}), options = {}) {
    this.getSettings = getSettings;
    this.filePath = filePath;
    // Test seam for the byte cap; production uses MAX_CONVERSATION_BYTES.
    this.maxConversationBytes = Number.isSafeInteger(options.maxConversationBytes) && options.maxConversationBytes > 0
      ? options.maxConversationBytes
      : MAX_CONVERSATION_BYTES;
    this.agents = this._load();
    this.drafts = new Map();
  }

  _load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      if (!raw || !Array.isArray(raw.agents)) return [];
      return raw.agents.filter(a => a && !a.draft && typeof a.id === 'string' && typeof a.name === 'string').map(a => {
        if (a.runState?.status === 'running') {
          if (a.activity) a.activity = require('../renderer/activity-state.js').reduce(a.activity, { type: 'run-state', status: 'paused', reason: 'Previous app session ended.' });
          a.runState = { ...a.runState, status: 'paused', reason: 'The previous app session ended. Continue to resume this conversation.' };
        }
        return a;
      });
    } catch {
      return [];
    }
  }

  _save() {
    // Item 1.5: enforce the per-conversation byte cap before serializing, so a
    // single runaway chat can never inflate every write or the whole document.
    for (const agent of this.agents) this._enforceByteCap(agent);
    atomicWriteJson(this.filePath, { agents: this.agents });
  }

  /* ---- item 1.5: per-conversation byte cap + append-only archive ---- */

  _archivePath(id) {
    // agents.json lives in userData; archives sit beside it in userData/agents/.
    return path.join(path.dirname(this.filePath), 'agents', `${id}.history.jsonl`);
  }

  /* Leading system/developer messages carry the operator's rules, so a trim must
   * never silently drop them. */
  _pinnedCount(agent) {
    let pinned = 0;
    while (pinned < agent.messages.length && pinned < ARCHIVE_PINNED
      && (agent.messages[pinned].role === 'system' || agent.messages[pinned].role === 'developer')) pinned++;
    return pinned;
  }

  /* Append messages to a conversation's history archive. Append-only: no line is
   * rewritten or removed here (invariant A4), so trimmed history always replays
   * through readArchive(). */
  _appendArchive(id, messages) {
    if (!Array.isArray(messages) || !messages.length) return 0;
    const file = this._archivePath(id);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const archivedAt = Date.now();
    const text = messages
      .map(message => JSON.stringify({ conversationId: String(id), archivedAt, message }))
      .join('\n') + '\n';
    fs.appendFileSync(file, text, { mode: 0o600 });
    return messages.length;
  }

  /* Move the oldest non-pinned messages into the archive. */
  _archiveMessages(agent, count) {
    const moved = agent.messages.splice(this._pinnedCount(agent), Math.max(0, count));
    this._appendArchive(agent.id, moved);
    return moved.length;
  }

  /* Keep one conversation within the byte cap by archiving its oldest messages.
   * Returns the number of messages archived (0 when it already fits). */
  _enforceByteCap(agent) {
    const cap = this.maxConversationBytes > 0 ? this.maxConversationBytes : MAX_CONVERSATION_BYTES;
    const size = () => Buffer.byteLength(JSON.stringify(agent));
    if (size() <= cap) return 0;
    let archived = 0;
    for (;;) {
      const removable = agent.messages.length - this._pinnedCount(agent) - ARCHIVE_FLOOR;
      if (removable <= 0) break;   // instructions + newest message always stay
      // Archive roughly the measured overflow per pass, then re-measure: dumping
      // the whole history for a small overflow would be needless loss.
      const perMessage = Math.max(1, Math.ceil(size() / agent.messages.length));
      const batch = Math.max(1, Math.min(removable, Math.ceil((size() - cap) / perMessage)));
      archived += this._archiveMessages(agent, batch);
      if (size() <= cap) break;
    }
    // The compressed-memory checkpoint covers an exact message prefix, so any
    // archive makes it stale (see compaction.workingMessages). It is also the one
    // derived field, so drop it when messages alone cannot reach the cap.
    if (agent.context !== undefined) delete agent.context;
    return archived;
  }

  /* Replay the archived tail of a conversation, oldest first. */
  readArchive(id) {
    const file = this._archivePath(String(id));
    if (!fs.existsSync(file)) return [];
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)
      .map(line => { try { return JSON.parse(line).message; } catch { return null; } })
      .filter(message => message && typeof message === 'object');
  }

  list() {
    // Return summaries only — full histories can be megabytes.
    return this.agents.map(a => ({
      id: a.id,
      name: a.name,
      dir: a.dir,
      model: a.model || '',
      personaId: a.personaId || '',
      connectionId: a.connectionId || '',
      createdAt: a.createdAt,
      updatedAt: a.updatedAt,
      messageCount: Array.isArray(a.messages) ? a.messages.length : 0,
      status: a.runState && a.runState.status ? a.runState.status : 'idle',
      parentChatId: a.parentChatId || null,
      forkIndex: Number.isInteger(a.forkIndex) ? a.forkIndex : null,
    }));
  }

  /* Conversations bound to one project directory, newest first. */
  listForProject(dir) {
    return this.list()
      .filter(a => a.dir === String(dir || ''))
      .sort((x, y) => (y.updatedAt || 0) - (x.updatedAt || 0));
  }

  /* Direct children (branches) of a conversation. */
  childrenOf(id) {
    return this.agents
      .filter(a => a.parentChatId === id)
      .sort((x, y) => (x.createdAt || 0) - (y.createdAt || 0));
  }

  /* Build the branch tree rooted at the conversations of one project.
   * Roots are chats with no parent (or whose parent is missing/other-project);
   * each node carries children + depth so the sidebar can render the branches
   * without recomputing. */
  tree(dir) {
    const inProject = new Set(this.listForProject(dir).map(a => a.id));
    const byId = new Map(this.agents.map(a => [a.id, a]));
    const summary = (a, depth) => ({
      id: a.id,
      name: a.name,
      dir: a.dir,
      createdAt: a.createdAt,
      updatedAt: a.updatedAt,
      messageCount: Array.isArray(a.messages) ? a.messages.length : 0,
      status: a.runState && a.runState.status ? a.runState.status : 'idle',
      parentChatId: a.parentChatId || null,
      forkIndex: Number.isInteger(a.forkIndex) ? a.forkIndex : null,
      depth,
      children: [],
    });
    const roots = this.agents
      .filter(a => a.dir === String(dir || '') && (!a.parentChatId || !inProject.has(a.parentChatId)))
      .sort((x, y) => (x.createdAt || 0) - (y.createdAt || 0));
    const seen = new Set();
    const build = (node) => {
      if (seen.has(node.id)) return node; // cycle guard (corrupted store)
      seen.add(node.id);
      for (const child of this.childrenOf(node.id).filter(c => inProject.has(c.id))) {
        node.children.push(build(summary(child, node.depth + 1)));
      }
      return node;
    };
    return roots.map(r => build(summary(r, 0)));
  }

  get(id) {
    const a = this.agents.find(a => a.id === id) || this.drafts?.get(id) || null;
    if (a) {
      // Fields added after the first release may be missing on disk.
      if (!a.pendingEdits || typeof a.pendingEdits !== 'object') a.pendingEdits = {};
      if (!Array.isArray(a.queue)) a.queue = [];
      if (!a.settings || typeof a.settings !== 'object') a.settings = {};
      if (a.settings.reviewEdits === undefined) a.settings.reviewEdits = true;
      if (a.settings.approvals === undefined) a.settings.approvals = 'prompt';
      if (a.settings.maxRounds === undefined) a.settings.maxRounds = 40;
    }
    return a;
  }

  _checkConversationLimit() {
    const maxAgents = resolveBudgets(this.getSettings()).maxConversations;
    if (maxAgents > 0 && this.agents.length >= maxAgents) {
      throw new Error(`Conversation limit reached (${maxAgents}). Change Settings > Budgeting or delete a conversation.`);
    }
  }

  create({ name, dir, model, personaId = '', personaPrompt = '', connectionId = '', parentChatId = null, forkIndex = null, draft = false }) {
    if (draft) {
      if (!this.drafts) this.drafts = new Map();
      const existing = [...this.drafts.values()].find(a => a.dir === String(dir || ''));
      if (existing) return existing;
    } else this._checkConversationLimit();
    const now = Date.now();
    const agent = {
      id: 'agent-' + now.toString(36) + '-' + Math.random().toString(36).slice(2, 8),
      ...(draft ? { draft: true } : {}),
      name: String(name || 'Chat').slice(0, 80),
      dir: String(dir || ''),
      model: String(model || ''),
      // A reusable custom agent can be materialized as a normal independent
      // conversation. Keep the template provenance and instructions with the
      // chat so later messages use the same identity without depending on the
      // persona still existing.
      personaId: String(personaId || '').slice(0, 96),
      personaPrompt: String(personaPrompt || '').slice(0, 8000),
      connectionId: String(connectionId || '').slice(0, 64),
      createdAt: now,
      updatedAt: now,
      // Branch lineage: a forked chat copies history up to forkIndex.
      parentChatId: parentChatId || null,
      forkIndex: Number.isInteger(forkIndex) ? forkIndex : null,
      messages: [],
      todos: [],
      runState: null,
      pendingEdits: {},
      queue: [],
      // Persistent per-agent settings the user can change from the UI.
      settings: {
        approvals: 'prompt',   // 'prompt' | 'auto-read' | 'auto-all'  (exec always prompts unless auto-all)
        reviewEdits: true,     // show accept/reject diff cards for write/edit_patch
        maxRounds: 40,
        maxTokens: resolveBudgets(this.getSettings()).maxTokens,
        temperature: null,     // null = let the endpoint decide
      },
    };
    if (draft) this.drafts.set(agent.id, agent);
    else { this.agents.push(agent); this._save(); }
    return agent;
  }

  /* New Chat uses a normal agent identity for model preferences and selected
   * attachments, but does not enter saved history until its first submission. */
  validateMaterialization(id) {
    const agent = this.get(id);
    if (!agent) throw new Error('Conversation not found.');
    if (agent.draft) {
      if (!agent.dir.trim()) throw new Error('Choose a project before sending a message.');
      this._checkConversationLimit();
    }
    return agent;
  }

  materialize(id) {
    const agent = this.validateMaterialization(id);
    if (!agent.draft) return agent;
    const previous = { createdAt: agent.createdAt, updatedAt: agent.updatedAt };
    delete agent.draft;
    agent.createdAt = agent.updatedAt = Date.now();
    this.agents.push(agent);
    try { this._save(); }
    catch (error) {
      this.agents = this.agents.filter(a => a.id !== id);
      Object.assign(agent, previous, { draft: true });
      throw error;
    }
    this.drafts.delete(id);
    return agent;
  }

  /* Fork a conversation: new chat under the same project, copying history up
   * to (and including) message index `upToIndex` — -1/undefined = all.
   * The fork inherits parent settings; its runState starts fresh. */
  fork(id, { upToIndex = -1, name = null } = {}) {
    const parent = this.get(id);
    if (!parent) throw new Error('Conversation not found.');
    if (parent.draft) throw new Error('Send a message before branching this conversation.');
    const messages = Array.isArray(parent.messages) ? parent.messages : [];
    const cut = Number.isInteger(upToIndex) && upToIndex >= 0 ? upToIndex + 1 : messages.length;
    const siblings = this.childrenOf(id).length;
    const child = this.create({
      name: name || `${parent.name} (branch ${siblings + 1})`,
      dir: parent.dir,
      model: parent.model,
      personaId: parent.personaId || '',
      personaPrompt: parent.personaPrompt || '',
      connectionId: parent.connectionId || '',
      parentChatId: id,
      forkIndex: cut,
    });
    child.messages = messages.slice(0, cut).map(m => ({ ...m }));
    child.settings = { ...parent.settings };
    child.todos = (parent.todos || []).map(t => ({ ...t }));
    this._save();
    return child;
  }

  /* Import a previously exported conversation snapshot (item 4.4).
   *
   * Never trusts an incoming id — a fresh one is minted so a malicious or
   * duplicated export cannot overwrite an existing conversation. Every field is
   * whitelisted/sanitized, so a malformed file rejects with a clear error
   * instead of injecting arbitrary keys into the store. */
  importConversation(data) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw new Error('Not a conversation export (expected an object).');
    }
    if (typeof data.dir !== 'string' || !data.dir) {
      throw new Error('Conversation export is missing its project directory (dir).');
    }
    const maxAgents = resolveBudgets(this.getSettings()).maxConversations;
    if (maxAgents > 0 && this.agents.length >= maxAgents) {
      throw new Error(`Conversation limit reached (${maxAgents}). Change Settings > Budgeting or delete a conversation.`);
    }
    const now = Date.now();
    const messages = Array.isArray(data.messages)
      ? data.messages.filter(m => m && typeof m === 'object' && !Array.isArray(m)).map(m => ({ ...m }))
      : [];
    const todos = Array.isArray(data.todos)
      ? data.todos.map(t => ({
        text: String(t && t.text || '').slice(0, 500),
        status: ['pending', 'in_progress', 'completed', 'cancelled'].includes(t && t.status) ? t.status : 'pending',
      }))
      : [];
    const agent = {
      id: 'agent-' + now.toString(36) + '-' + Math.random().toString(36).slice(2, 8),
      name: String(data.name || 'Imported chat').slice(0, 80),
      dir: data.dir,
      model: String(data.model || ''),
      personaId: String(data.personaId || '').slice(0, 96),
      personaPrompt: String(data.personaPrompt || '').slice(0, 8000),
      connectionId: String(data.connectionId || '').slice(0, 64),
      createdAt: now,
      updatedAt: now,
      parentChatId: null,
      forkIndex: null,
      messages,
      todos,
      runState: null,
      pendingEdits: data.pendingEdits && typeof data.pendingEdits === 'object' && !Array.isArray(data.pendingEdits) ? { ...data.pendingEdits } : {},
      queue: Array.isArray(data.queue) ? data.queue.map(String) : [],
      settings: data.settings && typeof data.settings === 'object' && !Array.isArray(data.settings) ? { ...data.settings } : {},
    };
    if (data.context !== undefined) agent.context = data.context;
    if (data.activity !== undefined) agent.activity = data.activity;
    this.agents.push(agent);
    this._save();
    return agent;
  }

  update(id, patch) {
    const agent = this.get(id);
    if (!agent) return null;
    if (patch.name !== undefined) agent.name = String(patch.name).slice(0, 80);
    if (patch.dir !== undefined) agent.dir = String(patch.dir);
    if (patch.model !== undefined) agent.model = String(patch.model);
    if (patch.personaId !== undefined) agent.personaId = String(patch.personaId || '').slice(0, 96);
    if (patch.personaPrompt !== undefined) agent.personaPrompt = String(patch.personaPrompt || '').slice(0, 8000);
    if (patch.connectionId !== undefined) agent.connectionId = String(patch.connectionId || '').slice(0, 64);
    if (patch.settings && typeof patch.settings === 'object') {
      agent.settings = { ...agent.settings, ...patch.settings };
    }
    agent.updatedAt = Date.now();
    this._save();
    return agent;
  }

  clear(id) {
    const agent = this.get(id);
    if (!agent) return null;
    if (agent.runState?.status === 'running') throw new Error('Stop the conversation before clearing it.');
    // Keep the project, model, controls and independent branches. Clear every
    // source of conversational memory so a fresh prompt cannot recover it.
    Object.assign(agent, { name: 'Chat', messages: [], todos: [], runState: null, pendingEdits: {}, queue: [] });
    delete agent.context;
    delete agent.activity;
    agent.updatedAt = Date.now();
    this._save();
    return agent;
  }

  appendMessage(id, message) {
    let agent = this.get(id);
    if (!agent) return null;
    if (agent.draft && message?.role === 'user') {
      const hasContent = Array.isArray(message.content) ? message.content.length > 0 : String(message.content || '').trim().length > 0;
      if (!hasContent) throw new Error('A message is required.');
      agent = this.materialize(id);
    }
    agent.messages.push(message);
    // Apply only the user-configured history retention cap. Compression keeps
    // a separate context checkpoint and never removes the audit transcript.
    const retained = resolveBudgets(this.getSettings(), agent.settings).storedMessages;
    if (retained > 0 && agent.messages.length > retained) {
      const keepSystem = agent.messages.filter(m => m.role === 'system' || m.role === 'developer').slice(0, 4);
      const rest = agent.messages.filter(m => !(m.role === 'system' || m.role === 'developer'));
      // Retention trimming archives what it drops instead of deleting it, so even
      // an explicit storedMessages cap stays replayable (invariant A4).
      this._appendArchive(agent.id, rest.slice(0, Math.max(0, rest.length - retained)));
      agent.messages = [...keepSystem, ...rest.slice(-retained)];
    }
    agent.updatedAt = Date.now();
    this._save();
    return agent;
  }

  setTodos(id, todos) {
    const agent = this.get(id);
    if (!agent) return null;
    agent.todos = Array.isArray(todos) ? todos.map(t => ({
      text: String(t.text || '').slice(0, 500),
      status: ['pending', 'in_progress', 'completed', 'cancelled'].includes(t.status) ? t.status : 'pending',
    })) : [];
    agent.updatedAt = Date.now();
    this._save();
    return agent;
  }

  setActivity(id, activity) {
    const agent = this.get(id);
    if (agent) { agent.activity = activity; this._save(); }
  }

  setRunState(id, runState) {
    const agent = this.get(id);
    if (!agent) return null;
    agent.runState = runState;
    agent.updatedAt = Date.now();
    this._save();
    return agent;
  }

  // ---- pending edits (diff review cards) ----
  addPendingEdit(id, edit) {
    const agent = this.get(id);
    if (!agent) return null;
    agent.pendingEdits[edit.editId] = edit;
    agent.updatedAt = Date.now();
    this._save();
    return edit;
  }

  getPendingEdit(id, editId) {
    const agent = this.get(id);
    if (!agent) return null;
    return agent.pendingEdits[editId] || null;
  }

  resolvePendingEdit(id, editId, accepted) {
    const agent = this.get(id);
    if (!agent) return null;
    const edit = agent.pendingEdits[editId];
    if (!edit) return null;
    delete agent.pendingEdits[editId];
    agent.updatedAt = Date.now();
    this._save();
    return { edit, accepted: !!accepted };
  }

  // ---- queued user messages (sent while the agent is running) ----
  enqueue(id, text) {
    const agent = this.get(id);
    if (!agent) return null;
    agent.queue.push(String(text));
    agent.updatedAt = Date.now();
    this._save();
    return agent.queue.length;
  }

  dequeue(id) {
    const agent = this.get(id);
    if (!agent) return null;
    const text = agent.queue.shift();
    agent.updatedAt = Date.now();
    this._save();
    return text === undefined ? null : text;
  }

  queueLength(id) {
    const agent = this.get(id);
    return agent ? agent.queue.length : 0;
  }

  // Replacing history invalidates the compressed working context.
  setContext(id, context) {
    const agent = this.get(id);
    if (!agent) return null;
    const previous = agent.context;
    agent.context = context;
    try { this._save(); }
    catch (error) {
      if (previous === undefined) delete agent.context;
      else agent.context = previous;
      throw error;
    }
    return agent;
  }

  setMessages(id, messages) {
    const agent = this.get(id);
    if (!agent) return null;
    agent.messages = Array.isArray(messages) ? messages : [];
    delete agent.context;
    agent.updatedAt = Date.now();
    this._save();
    return agent;
  }

  remove(id) {
    if (this.drafts?.delete(id)) return true;
    const before = this.agents.length;
    this.agents = this.agents.filter(a => a.id !== id);
    if (this.agents.length !== before) {
      // Explicitly deleting a conversation also drops its history archive: A4
      // governs *trimming*, and keeping a hidden copy after the user deleted the
      // chat would be a privacy leak rather than a safety net.
      try { fs.rmSync(this._archivePath(String(id)), { force: true }); } catch { /* best effort */ }
      this._save();
    }
    return this.agents.length !== before;
  }
}

module.exports = { AgentStore, MAX_CONVERSATION_BYTES };
