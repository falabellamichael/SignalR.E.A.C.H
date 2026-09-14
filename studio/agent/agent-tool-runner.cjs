'use strict';

/* Reach Studio — agent tool dispatch + approval + persistence.
 *
 * One entry point: runToolCall(agentId, name, args, context). It validates
 * the tool against the registry, asks the user when the registry demands
 * approval, executes, truncates to the tool's budget, records the call in
 * the agent's message history as a tool message, and returns the result.
 *
 * The context object carries everything a tool might need:
 *   { projectDir, agentId, agentStore, reachExecutor, sendEvent }
 * sendEvent(channel, payload) pushes renderer events (approval prompts,
 * streaming status) without this module knowing Electron exists.
 */

const { TOOLS, needsApproval, budgetFor, resolveInProject } = require('./tool-registry.cjs');
const { disabledTools } = require('./tool-policy.cjs');

function truncate(text, budget) {
  const s = String(text === undefined ? '' : text);
  if (s.length <= budget) return s;
  return s.slice(0, budget) + '\n… [truncated at ' + budget + ' characters]';
}

async function runToolCall(agentId, name, args, context) {
  context.signal?.throwIfAborted();
  const tool = TOOLS[name];
  const record = { tool: name, arguments: args || {}, timestamp: Date.now() };

  if (!tool) {
    const error = `Unknown tool "${name}". The allowed tools are: ${Object.keys(TOOLS).join(', ')}.`;
    record.error = error;
    await persistToolResult(agentId, name, args, { ok: false, error }, context);
    return { ok: false, error, record };
  }

  // Approval: exec-class tools prompt unless the agent's settings say auto-all.
  const settings = (context.agentStore && context.agentStore.get(agentId)?.settings) || {};
  if (disabledTools(settings, TOOLS).includes(name)) {
    const error = `The ${name} tool is disabled in this conversation's tool controls.`;
    await persistToolResult(agentId, name, args, { ok: false, error }, context);
    return { ok: false, error, record };
  }
  const approvalMode = settings.approvals || 'prompt';
  const needsPrompt = needsApproval(name) && approvalMode !== 'auto-all';
  // Read-only tools never prompt. Auto-read mode only auto-approves reads.
  const needsFinalPrompt = needsPrompt && !(approvalMode === 'auto-read' && tool.class === 'read');

  if (needsFinalPrompt && typeof context.requestApproval === 'function') {
    const approval = context.requestApproval({
      agentId,
      tool: name,
      arguments: args,
      class: tool.class,
      help: tool.help,
    });
    const approved = await new Promise((resolve, reject) => {
      const abort = () => reject(context.signal.reason);
      context.signal?.addEventListener('abort', abort, { once: true });
      Promise.resolve(approval).then(resolve, reject).finally(() => context.signal?.removeEventListener('abort', abort));
      if (context.signal?.aborted) abort();
    });
    context.signal?.throwIfAborted();
    if (!approved) {
      const error = `The user declined the ${name} action.`;
      record.error = error;
      await persistToolResult(agentId, name, args, { ok: false, error }, context);
      return { ok: false, error, record };
    }
  }

  let result;
  try {
    // Controls may change while an approval dialog is open.
    if (disabledTools(context.agentStore?.get(agentId)?.settings || {}, TOOLS).includes(name)) throw new Error(`The ${name} tool is now disabled.`);
    if (name.startsWith('reach.')) {
      if (typeof context.reachExecutor !== 'function') throw new Error('Reach tools are not available.');
      result = await context.reachExecutor(name, args || {}, context);
    } else if (typeof tool.execute === 'function') {
      result = await tool.execute(args || {}, context);
    } else {
      result = { ok: false, error: `Tool ${name} has no executor wired.` };
    }
  } catch (e) {
    result = { ok: false, error: String(e && e.message || e) };
  }

  const budget = budgetFor(name);
  const serialized = JSON.stringify(result, null, 2);
  const truncated = serialized.length > budget ? JSON.parse(JSON.stringify(result)) : result;
  if (serialized.length > budget) {
    // Truncate the largest string fields first.
    for (const key of Object.keys(truncated)) {
      if (typeof truncated[key] === 'string') truncated[key] = truncate(truncated[key], Math.floor(budget / 2));
    }
  }

  record.ok = !!result.ok;
  if (result.error) record.error = result.error;
  await persistToolResult(agentId, name, args, truncated, context);
  return { ...truncated, record };
}

async function persistToolResult(agentId, name, args, result, context) {
  if (!context.agentStore || !agentId) return;
  const content = `Tool ${name}(${JSON.stringify(args)}) → ${result.ok ? 'ok' : 'error'}\n${JSON.stringify(result, null, 2)}`;
  context.agentStore.appendMessage(agentId, {
    role: 'tool',
    tool_call_id: `call_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    name,
    content,
    _reachMeta: { source: 'tool', toolId: name },
  });
}

module.exports = { runToolCall, resolveInProject };
