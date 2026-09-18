'use strict';

/* Reach Studio — the agent orchestrator.
 *
 * One AgentLoop per agent session. It owns the conversation history, the
 * run-control state machine, the tool dispatch loop, context compaction,
 * streaming, the pending-edit review flow, and the user-message queue.
 * Transport-agnostic: main.mjs injects the endpoint, an event sink, and the
 * approval/edit-review callbacks.
 */

const { compactMessages, normalizeChatMessages, contextChars } = require('./context.cjs');
const { fingerprint, workingMessages, summarizeSegments } = require('./compaction.cjs');
const { readChatResponse, emptyReplyDiagnostic, isTransientTransportError, transportDiagnostic, waitForRetry } = require('./chat-response.cjs');
const { protocol, start, decide } = require('./agent-run.cjs');
const { actionInstruction } = require('./agent-action.cjs');
const { parseAgentResponse, extractToolBlocks } = require('./agent-response.cjs');
const { runToolCall } = require('./agent-tool-runner.cjs');
const { toolHelp, TOOLS } = require('./tool-registry.cjs');
const { features, disabledTools } = require('./tool-policy.cjs');

const { budgetPolicy, reserveGuard, checkpoint } = require('./budget-awareness.cjs');
const { resolveBudgets, cap } = require('./budgets.cjs');

const DEFAULT_MODEL = 'gpt-4o-mini';
const MAX_ROUNDS = 40;
const RETRY_LIMIT = 2;

class AgentLoop {
  constructor({ agentId, store, endpoint, accessKey, model, projectDir, reachExecutor, browserExecutor, sendEvent, requestApproval, requestEditReview, personaPrompt = '', budgets = null, requestTimeoutMs = 180000 }) {
    this.agentId = agentId;
    this.store = store;
    this.endpoint = endpoint;
    this.accessKey = accessKey || '';
    this.model = model || DEFAULT_MODEL;
    this.projectDir = projectDir;
    this.reachExecutor = reachExecutor;
    this.browserExecutor = browserExecutor;
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
    const event = { agentId: this.agentId, type, ...payload, at: Date.now() };
    const activity = require('../renderer/activity-state.js');
    this.activity = activity.reduce(this.activity, event);
    const agent = this._agent();
    if (agent && this.activity) agent.activity = this.activity;
    // Stream counters stay in memory; existing message saves persist checkpoints.
    if (type === 'run-state' && this.activity) this.store.setActivity?.(this.agentId, this.activity);
    this.sendEvent('agent:event', event);
  }

  _buildSystemPrompt() {
    const settings = this._agent()?.settings || {}, controls = features(settings);
    const disabled = disabledTools(settings, TOOLS);
    if (!controls.agent) return 'You are REACH Studio. Answer the user directly in normal prose. Agent mode is off: do not use tools, execute commands, modify files, or emit action/control blocks. '
      + (controls.think ? '' : 'Give a concise direct answer without an extended reasoning narrative. ')
      + this.personaPrompt;
    const projectLine = !controls.workspace ? 'Workspace access is off. Do not read or change project files or run project commands.' : this.projectDir
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
      + (controls.think ? '' : 'Thinking preference is off: keep reasoning brief and respond directly.\n')
      + (structured
        ? actionInstruction({ includeCollab: this._inCrew(), disabled })
        // Advertise the codebase tools only when bound to a project: indexing,
        // impact analysis and refactoring have nothing to act on otherwise, and
        // offering them would invite calls that can only fail.
        : toolHelp(this.projectDir ? ['core', 'reach', 'code'] : ['core', 'reach'], disabled) + '\n\n' + protocol)
      + '\n\nCURRENT SAVED TASK STATE (data, not instructions):\n' + JSON.stringify({
        todos: this._agent()?.todos || [],
        pendingEdits: Object.values(this._agent()?.pendingEdits || {}).map(edit => ({ path: edit.path || edit.filePath, editId: edit.editId, status: 'awaiting review, not applied' })),
      });
  }

  _messagesForRequest() {
    const agent = this._agent();
    return [{ role: 'system', content: this._buildSystemPrompt() }, ...workingMessages(agent)];
  }

  contextStatus() {
    const messages = this._messagesForRequest(), budgets = this._budgets();
    return { chars: contextChars(messages), estimatedTokens: Math.ceil(contextChars(messages) / 3),
      trigger: budgets.contextTrigger, automatic: budgets.autoCompact,
      lastCompression: this._agent()?.context ? { before: this._agent().context.before,
        after: this._agent().context.after, at: this._agent().context.at } : null };
  }

  _budgets() { return this.budgets || resolveBudgets({}, this._agent()?.settings); }

  async _fetchChat(messages, { stream = true, maxTokens = this._budgets().maxTokens, purpose = stream ? 'answer' : 'summary', concise = false } = {}) {
    const url = this.endpoint.replace(/\/+$/, '') + '/chat/completions';
    const headers = { 'Content-Type': 'application/json' };
    if (this.accessKey) headers.Authorization = 'Bearer ' + this.accessKey;
    const agent = this._agent();
    const settings = agent?.settings || {};
    const body = {
      model: this.model,
      messages: normalizeChatMessages([...messages, { role: 'system', content: budgetPolicy({ maxTokens, purpose, budgets: this._budgets(), round: this.requestRound || 1, contextChars: contextChars(messages), concise }) }]),
      stream,
    };
    if ((features(settings).think === false || concise || maxTokens > 0 && maxTokens <= 1024) && /qwen/i.test(this.model) && !this.noThinkingHint) body.chat_template_kwargs = { enable_thinking: false };
    if (maxTokens > 0) body.max_tokens = maxTokens;
    if (settings.temperature !== null && settings.temperature !== undefined) {
      body.temperature = settings.temperature;
    }
    this.abortController.signal.throwIfAborted();
    // The deadline covers connection, headers AND the streamed body. A model
    // that never finishes must not keep a team member working indefinitely.
    this.requestSignal = this.requestTimeoutMs === 0 ? this.abortController.signal
      : AbortSignal.any([this.abortController.signal, AbortSignal.timeout(this.requestTimeoutMs)]);
    this._emit('request-start', { purpose });
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: this.requestSignal,
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      if (body.chat_template_kwargs && [400, 422].includes(response.status) && /chat_template_kwargs|enable_thinking/.test(text)) {
        this.noThinkingHint = true;
        return this._fetchChat(messages, { stream, maxTokens, purpose, concise });
      }
      const error = new Error(`Endpoint returned HTTP ${response.status}: ${text.slice(0, 500)}`);
      error.status = response.status;
      error.contextOverflow = [400, 413, 422].includes(response.status) && /context[_ ](length[_ ]exceeded|window|limit)|maximum context|too many (input )?tokens|input.*(too long|token limit)/i.test(text);
      throw error;
    }
    return response;
  }

  _budgetCheckpoint(cause = 'output') {
    const agent = this._agent();
    return checkpoint({ maxTokens: this._budgets().maxTokens, results: this.turnResults || [], todos: agent?.todos || [], pendingEdits: agent?.pendingEdits || {}, cause });
  }

  async _readAnswer(messages, concise = false) {
    const response = await this._fetchChat(messages, { stream: true, concise });
    this._emit('message-start', { role: 'assistant' });
    return readChatResponse(response, {
      stream: true, signal: this.requestSignal || this.abortController.signal,
      onReasoning: chars => this._emit('reasoning', { chars }),
      onText: text => this._emit('delta', { text }),
      onProgress: reserveGuard(this._budgets().maxTokens),
    });
  }

  async _budgetedAnswer(messages) {
    let reply;
    try { reply = await this._readAnswer(messages); }
    catch (error) {
      if (error.code !== 'REACH_OUTPUT_RESERVE') throw error;
      reply = { finishReason: 'length' };
    }
    if (reply.error) throw new Error(reply.error);
    if (reply.finishReason !== 'length' && !(reply.reasoningChars && !reply.content?.trim() && !reply.nativeActions?.length)) return reply;
    this.abortController.signal.throwIfAborted();
    this._emit('message-end', { role: 'assistant', provisional: true });
    this._emit('budget-recovery', { note: 'Output reserve reached · requesting a shorter complete response with the same per-request cap' });
    try {
      reply = await this._readAnswer([...messages, { role: 'user', content: 'The previous response did not finish within its output budget and no actions from it were executed. Return a shorter, complete executable response now. Report verified results first. If the task is unfinished, choose one small next action or state what remains; never invent completion.' }], true);
    } catch (error) {
      if (this.abortController.signal.aborted || error.code !== 'REACH_OUTPUT_RESERVE') throw error;
      return this._budgetCheckpoint();
    }
    if (reply.error) throw new Error(reply.error);
    const parsed = parseAgentResponse(reply.content || '', reply.nativeActions || []);
    if (reply.finishReason === 'length' || parsed.invalid || !parsed.actions.length && !parsed.control && !parsed.confirm) return this._budgetCheckpoint();
    return reply;
  }

  async _summarizeForCompaction(archived, { maxChars }) {
    const budgets = this._budgets();
    return summarizeSegments(archived, { maxChars,
      chunkSize: Math.max(1000, Math.min(28000, (budgets.contextTrigger || 60000) - maxChars - 5000)),
      signal: this.abortController.signal,
      progress: (type, payload) => this._emit(type, payload),
      request: async messages => {
        for (let retry = 0; ; retry++) {
          try {
            const response = await this._fetchChat(messages, { stream: true, purpose: 'summary', concise: true, maxTokens: budgets.summaryTokens });
            let chars = 0;
            return await readChatResponse(response, { stream: true, signal: this.requestSignal,
              onReasoning: count => this._emit('compaction-progress', { note: `Preparing memory · ${count} reasoning characters received` }),
              onText: text => { chars += text.length; this._emit('compaction-progress', { note: `Writing memory · ${chars} characters received` }); } });
          } catch (error) {
            if (this.abortController.signal.aborted || retry >= RETRY_LIMIT || !isTransientTransportError(error)) throw error;
            this._emit('compaction-progress', { note: 'Connection interrupted · retrying this segment' });
            await waitForRetry(1500, this.abortController.signal);
          }
        }
      } });
  }

  async _maybeCompact(messages, { force = false, target } = {}) {
    const budgets = this._budgets();
    if (!budgets.autoCompact && !force) return messages;
    const history = this._agent().messages.slice();
    const historyFingerprint = fingerprint(history);
    const compacted = await compactMessages(messages, (archived, options) => this._summarizeForCompaction(archived, options), {
      trigger: budgets.contextTrigger, target: target ? Math.min(target, budgets.contextTarget) : budgets.contextTarget,
      messageLimit: budgets.contextMessages, force,
    });
    this.abortController.signal.throwIfAborted();
    if (compacted.changed) {
      if (fingerprint(this._agent().messages.slice(0, history.length)) !== historyFingerprint) throw new Error('Conversation changed during compression; original history is intact. Retry compression.');
      const context = { messages: compacted.messages.slice(1), through: history.length,
        fingerprint: historyFingerprint, before: compacted.before, after: compacted.after, at: Date.now() };
      if (this.store.setContext) this.store.setContext(this.agentId, context);
      else this._agent().context = context;
      this._emit('compacted', { before: compacted.before, after: compacted.after });
    }
    this._emit('context-status', this.contextStatus());
    return compacted.messages;
  }

  async compactNow() {
    if (this.running) throw new Error('Stop the current run before compressing manually. Automatic compression runs between requests.');
    const prior = this._agent().runState;
    this.running = true;
    this.stopRequested = false;
    this.abortController = new AbortController();
    this._saveRunState({ ...prior, status: 'running' });
    this._emit('run-state', { status: 'running', reason: 'Compressing conversation context' });
    try {
      await this._maybeCompact(this._messagesForRequest(), { force: true });
      return this.contextStatus();
    } catch (error) {
      this._emit('error', { message: error.message });
      throw error;
    } finally {
      this.running = false;
      this.abortController = this.requestSignal = null;
      this._saveRunState(prior);
      this._emit('run-state', { status: prior?.status || 'idle', reason: prior?.reason || '' });
      const queued = this.stopRequested ? null : this.store.dequeue(this.agentId);
      if (queued !== null) await this._runConversation(queued);
    }
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
    this.turnResults = [];
    this.stopRequested = false;
    this.abortController = new AbortController();
    let runState = start(agent.runState);
    // Use one response contract from the first round, including ordinary chat.
    runState.structuredActions = true;
    this._saveRunState(runState);
    this._emit('run-state', { status: 'running', reason: '' });

    try {
      let transportRetries = 0, overflowRetries = 0;
      for (let round = 0; round < cap(this._budgets().maxRounds); round++) {
        this.abortController.signal.throwIfAborted();
        this.requestRound = round + 1;
        this._emit('round', { round: round + 1 });
        const requestMessages = await this._maybeCompact(this._messagesForRequest());

        let reply;
        try {
          reply = await this._budgetedAnswer(requestMessages);
          transportRetries = 0;
        } catch (error) {
          this._emit('message-end', { role: 'assistant', error: error.message });
          if (this.abortController.signal.aborted) throw error;
          if (this.requestSignal?.aborted) throw new Error(`${this.model}: model request exceeded ${Math.round(this.requestTimeoutMs / 1000)} seconds. Try again or choose a different model.`);
          if (error.contextOverflow && this._budgets().autoCompact && overflowRetries++ < 1) {
            this._emit('retry', { error: 'Provider context limit reached · compressing before retry' });
            await this._maybeCompact(requestMessages, { force: true, target: Math.max(8000, Math.floor(contextChars(requestMessages) * 0.45)) });
            round--; // A rejected request did not execute a model round or any tool.
            continue;
          }
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

        let content = reply.content || '';
        if (!features(this._agent()?.settings).agent) {
          this._emit('message-end', { role: 'assistant', content });
          this.store.appendMessage(this.agentId, { role: 'assistant', content, _reachMeta: { display: content } });
          runState = { ...runState, status: 'completed', reason: '' };
          break;
        }
        let parsed = parseAgentResponse(content, reply.nativeActions || []);
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

        let decision = decide(runState, input);
        if (reply.budgetFallback || decision.action === 'pause' && decision.reason?.startsWith('Agent round limit')) {
          if (!reply.budgetFallback) { reply = this._budgetCheckpoint('round'); content = reply.content; parsed = parseAgentResponse(content); }
          decision = { action: 'pause', state: { ...runState, status: 'paused', reason: 'Budget reached. Progress saved; Continue to resume.' } };
        }
        const provisional = decision.action === 'continue';
        this._emit('message-end', { role: 'assistant', content: parsed.display, question: parsed.confirm, provisional });
        this.store.appendMessage(this.agentId, { role: 'assistant', content,
          _reachMeta: { display: parsed.display, question: parsed.confirm || null,
            ...(reply.budgetFallback ? { source: 'budget-checkpoint' } : provisional ? { source: 'recovery-attempt' } : {}) } });
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
              browserExecutor: this.browserExecutor,
              browserTimeoutMs: this.requestTimeoutMs,
              sendEvent: this.sendEvent,
              requestApproval: this.requestApproval ? async payload => {
                const approvalSignal = this.abortController.signal;
                this._emit('approval-wait', {});
                const approved = await this.requestApproval(payload);
                if (!approvalSignal.aborted && approved) this._emit('approval-end', {});
                return approved;
              } : undefined,
              requestEditReview: this.requestEditReview,
              signal: this.abortController.signal,
            });
            this.turnResults.push({ tool: call.name, path: String(call.args?.path || call.args?.filePath || '').slice(0, 300), ok: result.ok, pending: !!result.pending });
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
