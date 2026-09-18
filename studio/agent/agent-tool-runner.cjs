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
const { evaluateCommand, defaultPolicy } = require('./sandbox.cjs');

function truncate(text, budget) {
  const s = String(text === undefined ? '' : text);
  if (s.length <= budget) return s;
  return s.slice(0, budget) + '\n… [truncated at ' + budget + ' characters]';
}

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
  const sandbox = settings && settings.sandbox;
  if (!sandbox || sandbox.enabled !== true) return null;
  const tool = TOOLS[name];
  if (!tool || tool.class !== 'exec') return null;
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
  const commands = collectCommands(args);
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
 * Every command string an exec-class tool invocation would run.
 *
 * Covers `args.command` (shell, reach.run) and one level of nesting in
 * `args.gates[].command` (tests.run) and `args[].command` (batch forms). Depth is
 * bounded deliberately: a tool could in principle hide a command deeper, but the
 * registered exec tools only nest this far, and walking arbitrary structures
 * would be both slow and a false sense of completeness. A tool that adds a new
 * command shape must extend this function — the sandbox tests cover it.
 */
function collectCommands(args) {
  const out = [];
  if (!args || typeof args !== 'object') return out;
  if (typeof args.command === 'string' && args.command.trim()) out.push(args.command);
  const scanList = (list) => {
    if (!Array.isArray(list)) return;
    for (const item of list) {
      if (item && typeof item === 'object' && typeof item.command === 'string' && item.command.trim()) {
        out.push(item.command);
      }
    }
  };
  scanList(args.gates);
  scanList(args.commands);
  return out;
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

  // Sandbox policy is checked BEFORE the approval prompt. A command the policy
  // forbids must never reach the user as something they can click through:
  // otherwise "Approve" looks like it grants permission the sandbox is meant to
  // withhold, and an approval recorded for a refused command is misleading.
  const sandboxDenial = enforceSandbox(name, args, settings, context);
  if (sandboxDenial) {
    record.error = sandboxDenial;
    await persistToolResult(agentId, name, args, { ok: false, error: sandboxDenial }, context);
    return { ok: false, error: sandboxDenial, record };
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
