'use strict';

/* Reach Studio — first-class agent tools for the Reach language.
 *
 * Exposes the reach CLI as agent-callable tools with explicit contracts:
 *
 *   reach.compile {path?}        → reach compile <path||index.rsh>
 *   reach.run     {path?, args?} → reach run <path> [args...]
 *   reach.init    {}             → reach init
 *   reach.clean   {}             → reach clean
 *   reach.version {}             → reach version
 *
 * All of them run inside WSL against the agent's bound project directory via
 * reach-process.cjs. Exec-class tools require approval per the registry.
 */

const reachProcess = require('./reach-process.cjs');

/* Sanitize a model-supplied project-relative path. The agent must never
 * escape the bound project directory, even by accident. Returns null when
 * the path is unsafe; the caller turns that into a tool error. */
function safeProjectPath(projectDir, requested) {
  if (!requested) return null;
  const s = String(requested).trim();
  if (!s) return null;
  // Disallow absolute paths, drive letters, WSL mounts, and parent traversal.
  if (/^([a-zA-Z]:[\\/]|\\\\|\/|~)/.test(s)) return null;
  if (/(^|[\\/])\.\.([\\/]|$)/.test(s)) return null;
  return s.replace(/\\/g, '/');
}

/* Build the argv for a reach invocation. `toolName` is one of the reach.*
 * keys; `args` is the model-supplied argument object. */
function buildReachArgs(toolName, args = {}) {
  switch (toolName) {
    case 'reach.version':
      return ['version'];
    case 'reach.compile': {
      const p = safeProjectPath(null, args.path) || 'index.rsh';
      return ['compile', p];
    }
    case 'reach.run': {
      const p = safeProjectPath(null, args.path) || 'index.rsh';
      const extra = Array.isArray(args.args) ? args.args.map(a => String(a)) : [];
      return ['run', p, ...extra];
    }
    case 'reach.init':
      return ['init'];
    case 'reach.clean':
      return ['clean'];
    default:
      return null;
  }
}

/* Execute a reach tool. Spawns through reach-process and subscribes to the
 * main-process run-event bus — this is the fix for the broken renderer-event
 * listener approach (webContents.on never fires for outbound events). */
function createReachToolExecutor() {
  return async function executeReachTool(toolName, args, context) {
    const argv = buildReachArgs(toolName, args);
    if (!argv) return { ok: false, error: `Unknown reach tool: ${toolName}` };

    const cwd = context && context.projectDir;
    if (!cwd) return { ok: false, error: 'This agent is not bound to a project directory.' };

    const runId = reachProcess.runReach({ cwd, args: argv });

    return await new Promise((resolve) => {
      let collected = '';
      let errCollected = '';
      const detach = reachProcess.onRunEvent((ev) => {
        if (!ev || ev.runId !== runId) return;
        if (ev.type === 'output') {
          if (ev.channel === 'err') errCollected += ev.data;
          else collected += ev.data;
        } else if (ev.type === 'exit') {
          detach();
          clearTimeout(timer);
          const out = collected.trim();
          const err = errCollected.trim();
          const summary = (out ? out + '\n' : '') + (err ? '[stderr]\n' + err : '');
          resolve({
            ok: ev.code === 0,
            exitCode: ev.code,
            output: summary || '(no output)',
          });
        }
      });
      // reach compiles can take a while (SMT verification) — 10 minutes max.
      const timer = setTimeout(() => {
        detach();
        reachProcess.killRun(runId);
        resolve({ ok: false, error: 'reach command timed out after 10 minutes', output: collected + errCollected });
      }, 10 * 60 * 1000);
    });
  };
}

module.exports = { createReachToolExecutor, buildReachArgs, safeProjectPath };
