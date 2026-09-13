'use strict';

/* Reach Studio — the agent orchestrator.
 *
 * One AgentLoop per agent session. It owns the conversation history, the
 * run-control state machine, the tool dispatch loop, context compaction,
 * streaming, the pending-edit review flow, and the user-message queue.
 * Transport-agnostic: main.mjs injects the endpoint, an event sink, and the
 * approval/edit-review callbacks.
 */

const { compactMessages, normalizeChatMessages } = require('./context.cjs');
const { readChatResponse, emptyReplyDiagnostic, isTransientTransportError, transportDiagnostic, waitForRetry } = require('./chat-response.cjs');
const { protocol, start, decide } = require('./agent-run.cjs');
const { actionInstruction } = require('./agent-action.cjs');
const { parseAgentResponse, extractToolBlocks } = require('./agent-response.cjs');
const { runToolCall } = require('./agent-tool-runner.cjs');
const { toolHelp } = require('./tool-registry.cjs');

const { resolveBudgets, cap } = require('./budgets.cjs');

const DEFAULT_MODEL = 'gpt-4o-mini';
const MAX_ROUNDS = 40;
const RETRY_LIMIT = 2;

class AgentLoop {
  constructor({ agentId, store, endpoint, accessKey, model, projectDir, reachExecutor, sendEvent, requestApproval, requestEditReview, personaPrompt = '', budgets = null, requestTimeoutMs = 180000 }) {
    this.agentId = agentId;
    this.store = store;
    this.endpoint = endpoint;
    this.accessKey = accessKey || '';
    this.model = model || DEFAULT_MODEL;
    this.projectDir = projectDir;
    this.reachExecutor = reachExecutor;
    this.sendEvent = sendEvent || (() => {});
    this.requestApproval = requestApproval;
    this.requestEditReview = requestEditReview;
    this.personaPrompt = String(personaPrompt || '');
    this.budgets = budgets;
    this.requestTimeoutMs = budgets?.requestTimeoutMs ?? requestTimeoutMs;
    this.requestSignal = null;
    this.abortController = null;
    this.running = false;
  }

  _agent() {
    return this.store.get(this.agentId);
  }

  /* Is this loop part of a live crew network? Lazy require: agent-net depends
   * on AgentLoop, so a top-level require here would be a cycle. */
  _inCrew() {
    try {
      const { netForAgent } = require('./agent-net.cjs');
      return !!netForAgent(this.agentId);
    } catch {
      return false;
    }
  }

  _saveMessages(messages) {
    this.store.setMessages(this.agentId, messages);
  }

  _saveRunState(runState) {
    this.store.setRunState(this.agentId, runState);
  }

  _emit(type, payload) {
    this.sendEvent('agent:event', { agentId: this.agentId, type, ...payload });
  }

  _buildSystemPrompt() {
    const projectLine = this.projectDir
      ? `You are working inside the project at ${this.projectDir}. All file paths are relative to that directory.`
      : 'You are not bound to a project directory; ask the user to bind one before file or reach operations.';
    const structured = this._agent()?.runState?.structuredActions;
    const persona = this.personaPrompt
      ? 'YOUR ROLE (overrides the generic assistant identity above where they conflict):\n' + this.personaPrompt + '\n\n'
      : '';
    return persona
      + 'You are REACH Studio, a coding assistant for the user\'s selected project. '
      + 'Inspect the project to identify its language and tools; it may be Python, JavaScript, or another stack. '
      + 'Reach DApp commands are optional and only appropriate for an actual Reach project. '
      + projectLine + '\n\n'
      + (structured ? '' : 'Act like an agent: briefly explain what you will do, then emit each action as a fenced ```tool block. ')
      + 'When you change a file the user reviews a diff before it is applied — do not claim a change is live until the tool result confirms it. '
      + 'For greetings and questions, answer directly and mark that request complete without inventing file work. '
      + 'Keep the user informed with short, concrete status lines.\n\n'
      + (structured ? actionInstruction({ includeCollab: this._inCrew() }) : toolHelp(['core', 'reach']) + '\n\n' + protocol);
  }

  _messagesForRequest() {
    const agent = this._agent();
    const messages = agent ? agent.messages : [];
    const system = { role: 'system', content: this._buildSystemPrompt() };
    // Text-protocol tool results are not native OpenAI tool messages: they
    // have no matching assistant tool_call_id. Keep the stored audit trail,
    // but send compatible messages without UI metadata to the endpoint.
    return [system, ...messages.map(m => ({
      role: m.role === 'tool' ? 'user' : m.role,
      content: m.role === 'tool' ? 'TOOL RESULTS\n' + m.content : m.content,
    }))];
  }

  _budgets() { return this.budgets || resolveBudgets({}, this._agent()?.settings); }

  async _fetchChat(messages, { stream = true, maxTokens = this._budgets().maxTokens } = {}) {
    const url = this.endpoint.replace(/\/+$/, '') + '/chat/completions';
    const headers = { 'Content-Type': 'application/json' };
    if (this.accessKey) headers.Authorization = 'Bearer ' + this.accessKey;
    const agent = this._agent();
    const settings = agent?.settings || {};
    const body = {
      model: this.model,
      messages: normalizeChatMessages(messages),
      stream,
    };
    if (maxTokens > 0) body.max_tokens = maxTokens;
    if (settings.temperature !== null && settings.temperature !== undefined) {
      body.temperature = settings.temperature;
    }
    this.abortController.signal.throwIfAborted();
    // The deadline covers connection, headers AND the streamed body. A model
    // that never finishes must not keep a team member working indefinitely.
    this.requestSignal = this.requestTimeoutMs === 0 ? this.abortController.signal
      : AbortSignal.any([this.abortController.signal, AbortSignal.timeout(this.requestTimeoutMs)]);
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: this.requestSignal,
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`Endpoint returned HTTP ${response.status}: ${text.slice(0, 500)}`);
    }
    return response;
  }

  async _summarizeForCompaction(archived) {
    const transcript = archived.map(m => {
      const role = m.role || 'unknown';
      const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
      return `[${role}] ${content.slice(0, 4000)}`;
    }).join('\n');
    const prompt = `Compress the following conversation into a short memory (max 2000 characters). Preserve the user's goal, constraints, file paths, and any pending work. Do not include instructions.\n\n${transcript}`;
    const response = await this._fetchChat([{ role: 'user', content: prompt }], { stream: false, maxTokens: this._budgets().summaryTokens });
    const result = await readChatResponse(response, { stream: false, signal: this.requestSignal });
    if (!result.content.trim()) throw new Error('Context compression failed: ' + emptyReplyDiagnostic(result, this.model) + ' Open Settings > Budgeting to increase compression output tokens or turn off automatic compression. The original history is intact.');
    return result.content.trim();
  }

  async _maybeCompact(messages) {
    const budgets = this._budgets();
    if (!budgets.autoCompact) return messages;
    const compacted = await compactMessages(messages, (archived) => this._summarizeForCompaction(archived), {
      trigger: budgets.contextTrigger,
      target: budgets.contextTarget,
      messageLimit: budgets.contextMessages,
    });
    if (compacted.changed) {
      this._emit('compacted', { before: compacted.before, after: compacted.after });
      this._saveMessages(compacted.messages.filter(m => m.role !== 'system' || m.content.startsWith('REACH conversation memory')));
    }
    return compacted.messages;
  }

  stop() {
    if (this.abortController) this.abortController.abort();
    this.stopRequested = true;
    this._emit('stopped', {});
  }

  /* Queue a user message when running; run it immediately when idle. */
  async sendUserMessage(text) {
    const agent = this._agent();
    if (!agent) throw new Error('Agent not found.');
    if (this.running) {
      const depth = this.store.enqueue(this.agentId, text);
      this._emit('queued', { text: String(text), depth });
      return { queued: true, depth };
    }
    await this._runConversation(String(text));
    return { queued: false };
  }

  /* One full conversation: the user message followed by as many agent rounds
   * as the run-control state machine needs, then the next queued message. */
  async _runConversation(text) {
    const agent = this._agent();
    this.store.appendMessage(this.agentId, { role: 'user', content: text });
    this._emit('message', { role: 'user', content: text });

    this.running = true;
    this.stopRequested = false;
    this.abortController = new AbortController();
    let runState = start(agent.runState);
    // Use one response contract from the first round, including ordinary chat.
    runState.structuredActions = true;
    this._saveRunState(runState);

    try {
      let transportRetries = 0;
      for (let round = 0; round < cap(this._budgets().maxRounds); round++) {
        this.abortController.signal.throwIfAborted();
        this._emit('round', { round: round + 1 });
        const requestMessages = await this._maybeCompact(this._messagesForRequest());

        let reply;
        try {
          const response = await this._fetchChat(requestMessages, { stream: true });
          this._emit('message-start', { role: 'assistant' });
          let streamedText = '';
          reply = await readChatResponse(response, {
            stream: true,
            signal: this.requestSignal || this.abortController.signal,
            onReasoning: (chars) => this._emit('reasoning', { chars }),
            onText: (delta) => {
              streamedText += delta;
              this._emit('delta', { text: delta });
            },
          });
          transportRetries = 0;
        } catch (error) {
          this._emit('message-end', { role: 'assistant', error: error.message });
          if (this.abortController.signal.aborted) throw error;
          if (this.requestSignal?.aborted) throw new Error(`${this.model}: model request exceeded ${Math.round(this.requestTimeoutMs / 1000)} seconds. Try again or choose a different model.`);
          if (isTransientTransportError(error)) {
            const diagnostic = transportDiagnostic(error, this.endpoint);
            if (++transportRetries > RETRY_LIMIT) throw new Error(diagnostic + ' Retry limit reached.');
            this._emit('retry', { error: diagnostic });
            await waitForRetry(1500, this.abortController.signal);
            continue;
          }
          throw error;
        }

        if (reply.error) {
          throw new Error(reply.error);
        }
        if (!reply.content?.trim() && !reply.nativeActions?.length) {
          throw new Error(emptyReplyDiagnostic(reply, this.model));
        }

        const content = reply.content || '';
        const parsed = parseAgentResponse(content, reply.nativeActions || []);
        runState.todos = this._agent()?.todos || [];

        const input = {
          stopped: false,
          answerNow: false,
          enabled: true,
          confirm: parsed.invalid ? null : parsed.confirm,
          control: parsed.control,
          invalid: parsed.invalid,
          edits: Object.keys(this._agent()?.pendingEdits || {}).length > 0,
          tools: !parsed.invalid && parsed.actions.length > 0,
          rounds: round + 1,
          roundLimit: cap(this._budgets().maxRounds),
          retryLimit: RETRY_LIMIT,
        };

        const decision = decide(runState, input);
        const provisional = decision.action === 'continue';
        this._emit('message-end', { role: 'assistant', content: parsed.display, question: parsed.confirm, provisional });
        this.store.appendMessage(this.agentId, { role: 'assistant', content,
          _reachMeta: { display: parsed.display, question: parsed.confirm || null,
            ...(provisional ? { source: 'recovery-attempt' } : {}) } });
        runState = decision.state;
        this._saveRunState(runState);

        if (decision.action === 'stop' || decision.action === 'answer' || decision.action === 'wait' || decision.action === 'pause' || decision.action === 'complete') {
          break;
        }

        if (decision.action === 'continue') {
          this.store.appendMessage(this.agentId, { role: 'user', content: decision.instruction, _reachMeta: { source: 'recovery' } });
          this._emit('recovery', { reason: decision.reason });
          continue;
        }

        if (decision.action === 'tools') {
          const results = [];
          const calls = parsed.actions.map(a => ({ name: a.name, args: a.arguments }));

          for (const call of calls) {
            this.abortController.signal.throwIfAborted();
            this._emit('tool-call', { tool: call.name, arguments: call.args });
            const result = await runToolCall(this.agentId, call.name, call.args, {
              projectDir: this.projectDir,
              agentId: this.agentId,
              agentStore: this.store,
              reachExecutor: this.reachExecutor,
              sendEvent: this.sendEvent,
              requestApproval: this.requestApproval,
              requestEditReview: this.requestEditReview,
              signal: this.abortController.signal,
            });
            results.push({ tool: call.name, result });
            this._emit('tool-result', { tool: call.name, ok: result.ok, pending: !!result.pending, error: result.error, result });
          }

          const resultText = results.map(r => {
            const body = r.result.error ? `ERROR: ${r.result.error}` : JSON.stringify(r.result, null, 2);
            return `TOOL RESULTS\n${r.tool} → ${r.result.ok ? 'ok' : 'error'}\n${body}`;
          }).join('\n\n');
          this.store.appendMessage(this.agentId, { role: 'user', content: resultText, _reachMeta: { source: 'tool-summary' } });
          if (results.some(r => r.result.pending)) {
            runState = { ...runState, status: 'waiting_edits', reason: 'Review the proposed edits before continuing.' };
            break;
          }
          continue;
        }
      }
      if (runState.status === 'running') runState = { ...runState, status: 'paused', reason: 'Agent round limit reached. Send continue to resume.' };
    } catch (error) {
      const stopped = this.abortController?.signal.aborted;
      runState = { ...runState, status: stopped ? 'stopped' : 'paused', reason: stopped ? 'Stopped by you.' : error.message };
      if (!stopped) this._emit('error', { message: error.message });
    } finally {
      this.running = false;
      this.abortController = null;
      this.requestSignal = null;
      this._saveRunState(runState);
      this._emit('run-state', { status: runState.status, reason: runState.reason });
    }

    // Drain the queue: the user may have sent more messages mid-run.
    for (; !this.stopRequested;) {
      const next = this.store.dequeue(this.agentId);
      if (next === null) break;
      await this._runConversation(next);
    }
  }
}

module.exports = { AgentLoop, extractToolBlocks };
