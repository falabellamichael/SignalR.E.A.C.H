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
const engines = require('./engines.cjs');
const { disabledTools } = require('./tool-policy.cjs');
const { evaluateCommand, defaultPolicy } = require('./sandbox.cjs');
// E3: one recursive, total-budget bound for a tool result, replacing a
// top-level-only string truncation that left arrays and nested objects
// unbounded and could cost ~5x the stated budget.
const { boundResult } = require('./bounded-result.cjs');
const { createHash } = require('node:crypto');
const { validateToolArgs, commandsAt } = require('./tool-params.cjs');
const { auditEvent } = require('./audit-event.cjs');

const disabledAudit = new WeakMap();

/**
 * Enforce the command sandbox for exec-class tools.
 *
 * This is the single choke point: every shell command an agent runs passes
 * through runToolCall, so gating here cannot be bypassed by a tool that forgets
 * to check. Approval stays a separate, additional gate — a command can be
 * user-approved and still be refused by policy, which is the whole point: the
 * policy is enforced by code rather than by the user remembering what they
 * clicked.
 *
 * Opt-in through settings.sandbox.enabled so an existing conversation's
 * behaviour is unchanged until the user turns the sandbox on. An invalid policy
 * fails closed (the command is refused) rather than silently running wide open.
 */
function enforceSandbox(name, args, settings, context) {
  const tool = TOOLS[name];
  const sandbox = settings && settings.sandbox;
  if (!sandbox || sandbox.enabled !== true) {
    if ((tool?.class === 'write' || tool?.class === 'exec') && context.auditLog?.write) {
      let agents = disabledAudit.get(context.auditLog);
      if (!agents) { agents = new Set(); disabledAudit.set(context.auditLog, agents); }
      const key = String(context.agentId || 'unknown');
      if (!agents.has(key)) {
        agents.add(key);
        try { context.auditLog.write({ event: 'sandbox.disabled', agent: key,
          allowed: true, detail: { tool: name } }); } catch { /* never fail an action over audit I/O */ }
      }
    }
    return null;
  }
  if (!tool?.commandPaths?.length) return null;
  // `reach.*` tools carry no shell command: they spawn a fixed internal binary
  // with structured argv through spawnCommand(), which uses no shell (verified:
  // platform.cjs passes args as an array with shell unset), so there is no
  // command string for a shell-policy whitelist to judge. Applying the command
  // sandbox to them would refuse every legitimate compile/run — they are instead
  // governed by the `workspace` feature toggle and approval.
  if (tool.tier === 'reach') return null;
  // No configured policy means the built-in default, not an empty object: an
  // empty policy is invalid and would refuse everything with a confusing
  // "policy rejected" message, which reads like a bug rather than a guard.
  const policy = sandbox.policy && typeof sandbox.policy === 'object' && !Array.isArray(sandbox.policy)
    ? sandbox.policy
    : defaultPolicy();

  // An exec-class tool may carry its command in `args.command` (shell) OR in a
  // nested list (tests.run takes gates[].command). Checking only args.command let
  // tests.run slip past: the sandbox saw an empty string, refused it as "empty"
  // for the wrong reason, and never evaluated the real gate commands. Collect
  // every command string the tool could execute and evaluate each, so a nested
  // command cannot bypass the policy.
  const commands = commandsAt(args, tool.commandPaths);
  if (!commands.length) {
    // No command found at all — an exec tool with nothing to run is a no-op, but
    // fail closed rather than assume a shape we do not recognise is safe.
    return 'Sandbox policy: this tool invocation carried no recognisable command.';
  }
  for (const command of commands) {
    const verdict = evaluateCommand(command, policy, { projectDir: context.projectDir });
    if (verdict.allowed) continue;
    // Record every refusal in the audit log when one is wired up. The log is
    // append-only and hash-chained; a denial that is not recorded is a denial
    // nobody can explain later.
    try {
      if (context.auditLog && typeof context.auditLog.write === 'function') {
        context.auditLog.write({
          event: 'sandbox.deny',
          agent: context.agentId || null,
          tool: name,
          command,
          allowed: false,
          code: verdict.code,
          reason: verdict.reason,
          findings: verdict.findings,
          // `tool` is not a field in AuditLog's canonical() record set, and
          // canonical() must not change: its own comment warns that changing the
          // hashed shape invalidates every previously written log. detail IS in
          // the hash, so the tool name rides along there rather than being
          // silently dropped — a denial that cannot name the tool is much
          // harder to explain later.
          detail: { tool: name, projectDir: context.projectDir || null },
        });
      }
    } catch { /* an audit failure must not turn into a command being allowed */ }
    return `Sandbox policy refused this command (${verdict.code}): ${verdict.reason}`;
  }
  return null;
}

/**
 * Command provenance comes from each tool's declarative commandPaths schema.
 */
async function runToolCall(agentId, name, args, context) {
  context.signal?.throwIfAborted();
  const tool = TOOLS[name];
  const record = { tool: name, arguments: args || {}, timestamp: Date.now() };

  if (!tool) {
    const error = `Unknown tool "${name}". The allowed tools are: ${Object.keys(TOOLS).join(', ')}.`;
    record.error = error;
    await persistToolResult(agentId, name, args, { ok: false, error }, context, record);
    return { ok: false, error, record };
  }

  // Approval: exec-class tools prompt unless the agent's settings say auto-all.
  const getSettings = () => typeof context.getSettings === 'function'
    ? context.getSettings() : (context.agentStore && context.agentStore.get(agentId)?.settings) || {};
  const settings = getSettings();
  if (disabledTools(settings, TOOLS).includes(name)) {
    const error = `The ${name} tool is disabled in this conversation's tool controls.`;
    await persistToolResult(agentId, name, args, { ok: false, error }, context, record);
    return { ok: false, error, record };
  }

  const validated = validateToolArgs(tool.params, args || {});
  if (!validated.ok) {
    record.error = validated.error;
    await persistToolResult(agentId, name, args, { ok: false, error: validated.error }, context, record);
    return { ok: false, error: validated.error, record };
  }
  args = validated.args;
  record.arguments = args;

  // Sandbox policy is checked BEFORE the approval prompt. A command the policy
  // forbids must never reach the user as something they can click through:
  // otherwise "Approve" looks like it grants permission the sandbox is meant to
  // withhold, and an approval recorded for a refused command is misleading.
  const sandboxDenial = enforceSandbox(name, args, settings, context);
  if (sandboxDenial) {
    record.error = sandboxDenial;
    await persistToolResult(agentId, name, args, { ok: false, error: sandboxDenial }, context, record);
    return { ok: false, error: sandboxDenial, record };
  }

  const approvalMode = settings.approvals || 'prompt';
  const needsPrompt = needsApproval(name) && approvalMode !== 'auto-all';
  // Read-only tools never prompt. Auto-read mode only auto-approves reads.
  const needsFinalPrompt = needsPrompt && !(approvalMode === 'auto-read' && tool.class === 'read');

  if (needsFinalPrompt && typeof context.requestApproval === 'function') {
    auditEvent(context.auditLog, 'approval.request', { agent: agentId, detail: { tool: name, class: tool.class } });
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
    auditEvent(context.auditLog, 'approval.decision', { agent: agentId, allowed: !!approved,
      reason: approved ? 'approved' : 'declined', detail: { tool: name, class: tool.class } });
    if (!approved) {
      const error = `The user declined the ${name} action.`;
      record.error = error;
      await persistToolResult(agentId, name, args, { ok: false, error }, context, record);
      return { ok: false, error, record };
    }
  }

  let result;
  try {
    // Controls may change while an approval dialog is open.
    if (disabledTools(getSettings(), TOOLS).includes(name)) throw new Error(`The ${name} tool is now disabled.`);
    const cached = context.readMemo?.get(name, args);
    if (cached) {
      result = cached;
      record.cached = true;
      context.onCache?.(name);
    } else if (name.startsWith('reach.')) {
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

  // E3: bound the WHOLE result — arrays and nested objects included — against
  // ONE total budget, and use that same bounded value for both the returned
  // object and the persisted message. The previous code truncated only
  // top-level strings, left collections untouched, and applied the cut to the
  // caller's copy while persisting the full shape.
  const { value: truncated, bytes, truncated: wasTruncated, elided } = boundResult(result, { budget: budgetFor(name) });
  if (!record.cached) context.readMemo?.set(name, args, truncated);

  record.ok = !!result.ok;
  if (result.error) record.error = result.error;
  if (wasTruncated) {
    // Surface the loss so the model and the UI can see it was bounded rather
    // than assuming the result is complete (see bounded-result.cjs).
    record.bounded = { bytes, elidedItems: elided.total };
    context.sendEvent?.('agent:tool-bounded', { agentId, tool: name, bytes, elidedItems: elided.total });
  }
  await persistToolResult(agentId, name, args, truncated, context, record);
  if (tool.class === 'write' && truncated.ok && !truncated.pending && !truncated.unchanged) {
    auditEvent(context.auditLog, 'tool.allow', { agent: agentId, allowed: true,
      detail: { tool: name, path: truncated.path || args.path || null, cached: !!record.cached } });
  }
  return { ...truncated, record };
}

async function persistToolResult(agentId, name, args, result, context, record = null) {
  const observation = engines.getLedger().observe(name, args, result, agentId);
  // The loop appends the complete, fenced tool-summary after a batch. Keep a
  // small provenance record here for interrupted batches and audit history;
  // storing the body twice bloats saved conversations and compaction input.
  const digest = createHash('sha256').update(JSON.stringify(result)).digest('hex');
  const argumentsSha256 = createHash('sha256').update(JSON.stringify(args || {})).digest('hex');
  context.journal?.append('evidence', { agentId, tool: name, argumentsSha256,
    ok: !!result.ok, pending: !!result.pending, editId: result.editId || null,
    path: String(result.path || args?.path || args?.filePath || '').slice(0, 300),
    elapsedMs: Math.max(0, Date.now() - (record?.timestamp || Date.now())), resultSha256: digest });
  if (!context.agentStore || !agentId) return;
  const content = JSON.stringify({ tool: name, ok: !!result.ok, argumentsSha256, resultSha256: digest,
    error: result.error ? String(result.error).slice(0, 500) : undefined });
  context.agentStore.appendMessage(agentId, {
    role: 'tool',
    tool_call_id: `call_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    name,
    content,
    _reachMeta: { source: 'tool', toolId: name, observationId: observation.id },
  });
}

module.exports = { runToolCall, resolveInProject };
