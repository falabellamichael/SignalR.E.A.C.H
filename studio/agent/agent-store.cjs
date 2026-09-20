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
 * Message provenance uses the same _reachMeta convention as the VS Code
 * extension (context.js), so compaction metadata survives the round trip.
 */

const fs = require('fs');
const path = require('path');

const { resolveBudgets } = require('./budgets.cjs');

const MAX_AGENTS = 200;
const MAX_STORED_MESSAGES = 400;

class AgentStore {
  constructor(filePath, getSettings = () => ({})) {
    this.getSettings = getSettings;
    this.filePath = filePath;
    this.agents = this._load();
  }

  _load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      if (!raw || !Array.isArray(raw.agents)) return [];
      return raw.agents.filter(a => a && typeof a.id === 'string' && typeof a.name === 'string').map(a => {
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
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tmp = this.filePath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ agents: this.agents }, null, 2));
    fs.renameSync(tmp, this.filePath);
  }

  list() {
    // Return summaries only — full histories can be megabytes.
    return this.agents.map(a => ({
      id: a.id,
      name: a.name,
      dir: a.dir,
      model: a.model || '',
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
    const a = this.agents.find(a => a.id === id) || null;
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

  create({ name, dir, model, parentChatId = null, forkIndex = null }) {
    const maxAgents = resolveBudgets(this.getSettings()).maxConversations;
    if (maxAgents > 0 && this.agents.length >= maxAgents) {
      throw new Error(`Conversation limit reached (${maxAgents}). Change Settings > Budgeting or delete a conversation.`);
    }
    const now = Date.now();
    const agent = {
      id: 'agent-' + now.toString(36) + '-' + Math.random().toString(36).slice(2, 8),
      name: String(name || 'Chat').slice(0, 80),
      dir: String(dir || ''),
      model: String(model || ''),
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
    this.agents.push(agent);
    this._save();
    return agent;
  }

  /* Fork a conversation: new chat under the same project, copying history up
   * to (and including) message index `upToIndex` — -1/undefined = all.
   * The fork inherits parent settings; its runState starts fresh. */
  fork(id, { upToIndex = -1, name = null } = {}) {
    const parent = this.get(id);
    if (!parent) throw new Error('Conversation not found.');
    const messages = Array.isArray(parent.messages) ? parent.messages : [];
    const cut = Number.isInteger(upToIndex) && upToIndex >= 0 ? upToIndex + 1 : messages.length;
    const siblings = this.childrenOf(id).length;
    const child = this.create({
      name: name || `${parent.name} (branch ${siblings + 1})`,
      dir: parent.dir,
      model: parent.model,
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
    const agent = this.get(id);
    if (!agent) return null;
    agent.messages.push(message);
    // Apply only the user-configured history retention cap. Compression keeps
    // a separate context checkpoint and never removes the audit transcript.
    const retained = resolveBudgets(this.getSettings(), agent.settings).storedMessages;
    if (retained > 0 && agent.messages.length > retained) {
      const keepSystem = agent.messages.filter(m => m.role === 'system' || m.role === 'developer').slice(0, 4);
      const rest = agent.messages.filter(m => !(m.role === 'system' || m.role === 'developer'));
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
    const before = this.agents.length;
    this.agents = this.agents.filter(a => a.id !== id);
    if (this.agents.length !== before) this._save();
    return this.agents.length !== before;
  }
}

module.exports = { AgentStore };
