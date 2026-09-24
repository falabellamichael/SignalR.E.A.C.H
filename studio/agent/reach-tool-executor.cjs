'use strict';

/* Reach Studio — first-class agent tools for the Reach language.
 *
 * Exposes native Reach compiler and project actions as agent-callable tools:
 *
 *   reach.compile {path?}        → reachc <path||index.rsh>
 *   reach.run     {path?, args?} → Node frontend after native compile
 *   reach.init    {}             → write Reach starter files
 *   reach.clean   {}             → remove compiled backend
 *   reach.version {}             → reachc --version
 *
 * All use the agent's bound project directory via
 * reach-process.cjs. Exec-class tools require approval per the registry.
 */

const fs = require('node:fs');
const path = require('node:path');
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
  const normalized = s.replace(/\\/g, '/');
  if (!projectDir) return normalized;
  try {
    const root = fs.realpathSync(projectDir);
    const target = fs.realpathSync(path.resolve(root, normalized));
    const relative = path.relative(root, target);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return null;
    return normalized;
  } catch { return null; } // a compiler source must exist before execution

}

/* Build the argv for a reach invocation. `toolName` is one of the reach.*
 * keys; `args` is the model-supplied argument object. */
function buildReachArgs(toolName, args = {}) {
  switch (toolName) {
    case 'reach.version':
      return ['version'];
    case 'reach.compile': {
      const p = args.path === undefined ? 'index.rsh' : safeProjectPath(null, args.path);
      return p ? ['compile', p] : null;
    }
    case 'reach.run': {
      const p = args.path === undefined ? 'index.rsh' : safeProjectPath(null, args.path);
      if (!p) return null;
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
    if (!argv) return { ok: false, error: ['reach.compile', 'reach.run'].includes(toolName)
      ? 'Invalid Reach source path.' : `Unknown reach tool: ${toolName}` };

    const cwd = context && context.projectDir;
    if (!cwd) return { ok: false, error: 'This agent is not bound to a project directory.' };
    if (['reach.compile', 'reach.run'].includes(toolName)) {
      const source = safeProjectPath(cwd, argv[1]);
      if (!source) return { ok: false, error: 'Reach source is missing or resolves outside the project.' };
      if (toolName === 'reach.run' && path.basename(source) !== source)
        return { ok: false, error: 'Native Reach run needs a source file at the project root.' };
      argv[1] = source;
    }

    if (context.signal?.aborted) return { ok: false, error: 'reach command cancelled' };
    const runId = reachProcess.runReach({ cwd, args: argv });

    return await new Promise((resolve) => {
      const abort = () => reachProcess.killRun(runId);
      context.signal?.addEventListener('abort', abort, { once: true });
      if (context.signal?.aborted) abort();
      let collected = '';
      let errCollected = '';
      const detach = reachProcess.onRunEvent((ev) => {
        if (!ev || ev.runId !== runId) return;
        if (ev.type === 'output') {
          if (ev.channel === 'err') errCollected += ev.data;
          else collected += ev.data;
        } else if (ev.type === 'exit') {
          context.signal?.removeEventListener('abort', abort);
          detach();
          clearTimeout(timer);
          const out = collected.trim();
          const err = errCollected.trim();
          const summary = (out ? out + '\n' : '') + (err ? '[stderr]\n' + err : '');
          resolve({
            ok: ev.code === 0 && !context.signal?.aborted,
            exitCode: ev.code,
            output: summary || '(no output)',
          });
        }
      });
      // reach compiles can take a while (SMT verification) — 10 minutes max.
      const timer = setTimeout(() => {
        context.signal?.removeEventListener('abort', abort);
        detach();
        reachProcess.killRun(runId);
        resolve({ ok: false, error: 'reach command timed out after 10 minutes', output: collected + errCollected });
      }, 10 * 60 * 1000);
    });
  };
}

module.exports = { createReachToolExecutor, buildReachArgs, safeProjectPath };
