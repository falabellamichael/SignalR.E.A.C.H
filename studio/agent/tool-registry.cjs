'use strict';

/* Reach Studio — the agent tool registry.
 *
 * Trimmed from the VS Code extension's tools.js. One source of truth for
 * every tool the Reach Studio agent can call: name, class (read/write/exec/
 * browse), whether approval is required, result budget, and the help line
 * the model sees. The system prompt, the client-side allow-list, and the
 * executor all read from here so the three can never drift apart.
 *
 * Tools are grouped by `tier`:
 *   'core'    — described on every agentic turn
 *   'reach'   — described on every agentic turn (this is Reach Studio)
 */

const fs = require('fs');
const path = require('path');
const { reviewDiff, stats } = require('./diff.cjs');
const { readTextFile, writeTextFile, assertTextPath } = require('./text-files.cjs');
const { runFileScan } = require('./file-scan.cjs');

function scanBudget(limit) {
  const deadline = Date.now() + 10000;
  let visited = 0, chars = 0, truncated = false;
  return {
    visit(count) {
      if (count >= limit || ++visited > 20000 || chars >= 30000 || Date.now() >= deadline) {
        truncated = true;
        return false;
      }
      return true;
    },
    add(text) { chars += text.length; },
    get truncated() { return truncated; },
  };
}

/* Whether this call should return a reviewable proposal instead of writing
 * to disk. Review is on by default; the agent's settings can turn it off
 * (settings.reviewEdits === false → write directly). */
function shouldReview(ctx) {
  const settings = (ctx.agentStore && ctx.agentId && ctx.agentStore.get(ctx.agentId)?.settings) || {};
  if (settings.reviewEdits === false) return false;
  return typeof ctx.requestEditReview === 'function';
}

function proposeEdit(ctx, filePath, absPath, proposed, existed) {
  let current = '';
  assertTextPath(absPath);
  if (existed) current = readTextFile(absPath).content;
  if (current === proposed) {
    return { ok: true, path: filePath, unchanged: true, message: 'The file already contains exactly this content. No change was needed.' };
  }
  const hunks = reviewDiff(current, proposed, 3);
  const s = stats(hunks);
  const editId = 'edit-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  ctx.requestEditReview({
    editId,
    path: filePath,
    absPath,
    proposed,
    hunks,
    stats: s,
    isNew: !existed,
  });
  return {
    ok: true,
    pending: true,
    editId,
    path: filePath,
    isNew: !existed,
    stats: s,
    message: 'This edit is waiting for the user to accept or reject it in the review card. '
      + 'Do not claim the change is applied until the result confirms acceptance.',
  };
}

/* Path safety: every tool that touches the filesystem resolves against the
 * agent's bound project directory. No absolute paths, no parent traversal,
 * no drive letters. Returns the resolved absolute path or throws. */
function resolveInProject(projectDir, requested) {
  if (!projectDir) throw new Error('This agent is not bound to a project directory.');
  const raw = String(requested || '').trim();
  if (!raw) throw new Error('A path is required.');
  if (/^([a-zA-Z]:[\\/]|\\\\|\/|~)/.test(raw)) throw new Error('Absolute paths are not allowed. Use a project-relative path.');
  if (/(^|[\\/])\.\.([\\/]|$)/.test(raw)) throw new Error('Parent-directory traversal (..) is not allowed.');
  const resolved = path.resolve(projectDir, raw);
  const rootResolved = path.resolve(projectDir);
  const rootWithSep = rootResolved.endsWith(path.sep) ? rootResolved : rootResolved + path.sep;
  if (!resolved.startsWith(rootWithSep) && resolved !== rootResolved) {
    throw new Error('Path escapes the project directory.');
  }
  return resolved;
}

const CORE_TOOLS = {
  read: {
    class: 'read', tier: 'core', approval: false, budget: Infinity,
    help: 'reads one file completely (including unsaved editor changes). Optional inclusive 1-based startLine / endLine for a range.',
    example: { action: 'read', path: 'index.rsh' },
    async execute(args, ctx) {
      const abs = resolveInProject(ctx.projectDir, args.path);
      const text = readTextFile(abs).content;
      const lines = text.split(/\r?\n/);
      const start = Math.max(1, Number.isInteger(args.startLine) ? args.startLine : 1);
      const end = Math.min(lines.length, Number.isInteger(args.endLine) ? args.endLine : lines.length);
      if (start > end) return { ok: false, error: `Invalid range ${start}-${end}; file has ${lines.length} lines.` };
      const slice = lines.slice(start - 1, end).join('\n');
      return { ok: true, path: args.path, startLine: start, endLine: end, content: slice, totalLines: lines.length };
    },
  },
  write: {
    class: 'write', tier: 'core', approval: false, budget: 40000,
    help: 'creates or overwrites a file with the supplied content. Use edit_patch for targeted changes to existing files.',
    example: { action: 'write', path: 'index.rsh', content: "'reach 0.1'; ..." },
    async execute(args, ctx) {
      const abs = resolveInProject(ctx.projectDir, args.path);
      const content = String(args.content === undefined ? '' : args.content);
      const existed = fs.existsSync(abs);
      if (shouldReview(ctx)) {
        return proposeEdit(ctx, args.path, abs, content, existed);
      }
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      writeTextFile(abs, content);
      return { ok: true, path: args.path, bytes: Buffer.byteLength(content, 'utf8') };
    },
  },
  edit_patch: {
    class: 'write', tier: 'core', approval: false, budget: 40000,
    help: 'applies a multi-hunk patch to an existing file. Each hunk is {search, replace} or {startLine, endLine, replace}.',
    example: { action: 'edit_patch', path: 'index.rsh', hunks: [{ search: 'old text', replace: 'new text' }] },
    async execute(args, ctx) {
      const abs = resolveInProject(ctx.projectDir, args.path);
      const current = readTextFile(abs).content;
      const { applyPatch } = require('./edits.cjs');
      const next = applyPatch(current, args.hunks);
      if (shouldReview(ctx)) {
        return proposeEdit(ctx, args.path, abs, next, true);
      }
      writeTextFile(abs, next);
      return { ok: true, path: args.path, hunks: args.hunks.length };
    },
  },
  glob: {
    class: 'read', tier: 'core', approval: false, budget: 40000,
    help: 'finds files by path/name pattern, e.g. "*.rsh", "build/**". Optional path scopes the search to a subdirectory.',
    example: { action: 'glob', pattern: '**/*.rsh' },
    async execute(args, ctx) {
      if (!ctx.inScanWorker) return runFileScan('glob', args, ctx);
      const pattern = String(args.pattern || '*');
      const base = resolveInProject(ctx.projectDir, args.path || '.');
      const matches = [];
      const budget = scanBudget(200);
      const walk = (dir, rel) => {
        let entries;
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
          if (!budget.visit(matches.length)) return;
          if (e.isSymbolicLink()) continue;
          const childRel = rel ? rel + '/' + e.name : e.name;
          if (e.isDirectory()) {
            if (e.name === 'node_modules' || e.name === '__pycache__' || e.name === '.git' || e.name.startsWith('.')) continue;
            walk(path.join(dir, e.name), childRel);
          } else if (globMatch(pattern, childRel)) {
            matches.push(childRel);
            budget.add(childRel);
          }
        }
      };
      walk(base, '');
      return { ok: true, pattern, matches, truncated: budget.truncated };
    },
  },
  search: {
    class: 'read', tier: 'core', approval: false, budget: 40000,
    help: 'greps file contents and returns "path:line: text" matches. Options: regex:true, include:"*.rsh", caseSensitive:true.',
    example: { action: 'search', pattern: 'reach 0.1', regex: false },
    async execute(args, ctx) {
      if (!ctx.inScanWorker) return runFileScan('search', args, ctx);
      const base = resolveInProject(ctx.projectDir, args.path || '.');
      const pattern = String(args.pattern || '');
      const isRegex = !!args.regex;
      const caseSensitive = !!args.caseSensitive;
      const include = args.include ? String(args.include) : null;
      const results = [];
      const budget = scanBudget(200);
      const regex = isRegex ? new RegExp(pattern, caseSensitive ? 'g' : 'gi') : null;
      const walk = (dir, rel) => {
        let entries;
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
          if (!budget.visit(results.length)) return;
          if (e.isSymbolicLink()) continue;
          const childRel = rel ? rel + '/' + e.name : e.name;
          if (e.isDirectory()) {
            if (e.name === 'node_modules' || e.name === '__pycache__' || e.name === '.git' || e.name.startsWith('.')) continue;
            walk(path.join(dir, e.name), childRel);
          } else {
            if (include && !globMatch(include, childRel)) continue;
            let text;
            try { text = readTextFile(path.join(dir, e.name)).content; } catch { continue; }
            const lines = text.split(/\r?\n/);
            for (let i = 0; i < lines.length; i++) {
              let match = false;
              if (regex) { regex.lastIndex = 0; match = regex.test(lines[i]); }
              else { match = caseSensitive ? lines[i].includes(pattern) : lines[i].toLowerCase().includes(pattern.toLowerCase()); }
              if (match) {
                if (!budget.visit(results.length)) return;
                const hit = `${childRel}:${i + 1}: ${lines[i].slice(0, 500)}`;
                results.push(hit);
                budget.add(hit);
              }
            }
          }
        }
      };
      walk(base, '');
      return { ok: true, pattern, matches: results, truncated: budget.truncated };
    },
  },
  list: {
    class: 'read', tier: 'core', approval: false, budget: 40000,
    help: 'prints a directory tree (empty path = project root).',
    example: { action: 'list', path: '' },
    async execute(args, ctx) {
      if (!ctx.inScanWorker) return runFileScan('list', args, ctx);
      const base = resolveInProject(ctx.projectDir, args.path || '.');
      const lines = [];
      const budget = scanBudget(300);
      const walk = (dir, prefix) => {
        let entries;
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
          if (!budget.visit(lines.length)) return;
          if (e.isSymbolicLink()) continue;
          if (e.name === 'node_modules' || e.name === '__pycache__' || e.name === '.git' || e.name.startsWith('.')) continue;
          lines.push(prefix + (e.isDirectory() ? '📁 ' : '📄 ') + e.name);
          budget.add(lines[lines.length - 1]);
          if (e.isDirectory()) walk(path.join(dir, e.name), prefix + '  ');
        }
      };
      walk(base, '');
      return { ok: true, tree: lines.join('\n'), truncated: budget.truncated };
    },
  },
  shell: {
    class: 'exec', tier: 'core', approval: true, budget: 40000,
    help: 'runs a shell command in the project directory and returns stdout/stderr/exit code. The user must approve it first.',
    example: { action: 'shell', command: 'ls -la' },
    async execute(args, ctx) {
      const { spawn } = require('child_process');
      const cmd = String(args.command || '');
      if (!cmd) return { ok: false, error: 'A command is required.' };
      return await new Promise((resolve) => {
        const proc = spawn(cmd, { cwd: ctx.projectDir, shell: true, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
        let out = '', err = '';
        proc.stdout.on('data', d => { out += d; if (out.length > 60000) proc.kill(); });
        proc.stderr.on('data', d => { err += d; });
        proc.on('close', code => resolve({ ok: code === 0, exitCode: code, stdout: out, stderr: err }));
        proc.on('error', e => resolve({ ok: false, error: e.message }));
      });
    },
  },
  websearch: {
    class: 'browse', tier: 'core', approval: false, budget: 40000,
    help: 'searches the web and reads the top pages.',
    example: { action: 'websearch', query: 'Reach language parallel reduce' },
    async execute(args, ctx) {
      return { ok: false, error: 'websearch is not yet wired in Reach Studio. Use browse with a search engine URL instead.' };
    },
  },
  browse: {
    class: 'browse', tier: 'core', approval: false, budget: 40000,
    help: 'opens a web page and reads its text. One-shot.',
    example: { action: 'browse', url: 'https://docs.reach.sh' },
    async execute(args, ctx) {
      return { ok: false, error: 'browse is not yet wired in Reach Studio.' };
    },
  },
  todo_write: {
    class: 'write', tier: 'core', approval: false, budget: 40000,
    help: 'creates or updates the structured plan / checklist for multi-step tasks.',
    example: { action: 'todo_write', todos: [{ text: 'Compile the contract', status: 'in_progress' }] },
    async execute(args, ctx) {
      if (!ctx.agentStore || !ctx.agentId) return { ok: false, error: 'No agent context.' };
      ctx.agentStore.setTodos(ctx.agentId, args.todos);
      return { ok: true, todos: args.todos };
    },
  },
  todo_read: {
    class: 'read', tier: 'core', approval: false, budget: 40000,
    help: 'reads the current structured plan / checklist.',
    example: { action: 'todo_read' },
    async execute(args, ctx) {
      if (!ctx.agentStore || !ctx.agentId) return { ok: false, error: 'No agent context.' };
      const agent = ctx.agentStore.get(ctx.agentId);
      return { ok: true, todos: agent ? agent.todos : [] };
    },
  },
  tool_help: {
    class: 'read', tier: 'core', approval: false, budget: 40000,
    help: 'shows extended documentation for specific tool suites.',
    example: { action: 'tool_help', topic: 'reach' },
    async execute(args, ctx) {
      return { ok: true, help: toolHelp(args.topic || 'core') };
    },
  },
};

const REACH_TOOLS = {
  'reach.compile': {
    class: 'exec', tier: 'reach', approval: true, budget: 40000,
    help: 'compiles a Reach source file. Optional path (default index.rsh). Runs in WSL against the project directory.',
    example: { action: 'reach.compile', path: 'index.rsh' },
    execute: null, // wired in agent-tool-runner.cjs via createReachToolExecutor
  },
  'reach.run': {
    class: 'exec', tier: 'reach', approval: true, budget: 40000,
    help: 'runs a Reach program. Optional path (default index.rsh) and args array. Runs in WSL.',
    example: { action: 'reach.run', path: 'index.rsh', args: [] },
    execute: null,
  },
  'reach.init': {
    class: 'exec', tier: 'reach', approval: true, budget: 40000,
    help: 'initializes a Reach project in the bound directory (reach init).',
    example: { action: 'reach.init' },
    execute: null,
  },
  'reach.clean': {
    class: 'exec', tier: 'reach', approval: true, budget: 40000,
    help: 'cleans Reach build artifacts (reach clean).',
    example: { action: 'reach.clean' },
    execute: null,
  },
  'reach.version': {
    class: 'read', tier: 'reach', approval: false, budget: 40000,
    help: 'returns the installed reach version.',
    example: { action: 'reach.version' },
    execute: null,
  },
};

/* ---------- agent collaboration tools (Grok-Bot-style crew net) ----------
 * These let an agent drive collaboration ITSELF: spawn workers, message
 * peers, poll status, read a peer's transcript, and block on a peer. They
 * resolve the network by the CALLING agent's id (netForAgent), so the tool
 * context needs no changes and an agent outside a crew gets a clear error
 * instead of a crash. Mirrors Grok Bot's create_agent / send_message /
 * get_agent_status / read_agent_transcript / await tool set. */
function netFromCtx(ctx) {
  // Lazy require: tool-registry is required BY agent-net's AgentLoop chain.
  const { netForAgent } = require('./agent-net.cjs');
  return netForAgent(ctx.agentId);
}
function noNet() {
  return { ok: false, error: 'You are not part of a crew run, so collaboration tools are unavailable. Work directly, or ask the user to dispatch a team.' };
}

const COLLAB_TOOLS = {
  'agent.spawn': {
    class: 'read', tier: 'collab', approval: false, budget: 40000,
    help: 'spawns a background crew agent to do a task in parallel while you keep working. Args: name (required), task (required), optional model and prompt (its role/instructions). Returns an agentId immediately; the worker runs async. Poll with agent.status, block with agent.await, or message it with agent.send.',
    example: { action: 'agent.spawn', name: 'Contract Auditor', task: 'Audit index.rsh for reentrancy and unchecked returns.', prompt: 'You are a meticulous smart-contract auditor.' },
    async execute(args, ctx) {
      const net = netFromCtx(ctx);
      if (!net) return noNet();
      const me = net.agents.get(ctx.agentId);
      return net.spawn({
        name: args.name, model: args.model, prompt: args.prompt, task: args.task,
        parentId: ctx.agentId, depth: (me ? me.depth + 1 : 1), callerName: me ? me.name : '',
      });
    },
  },
  'agent.send': {
    class: 'write', tier: 'collab', approval: false, budget: 40000,
    help: 'sends a message to another crew agent (by agentId or exact name). A working agent gets it queued; an idle one is woken with it. Args: to, message.',
    example: { action: 'agent.send', to: 'Contract Auditor', message: 'Focus on the withdraw path first.' },
    async execute(args, ctx) {
      const net = netFromCtx(ctx);
      if (!net) return noNet();
      return net.send({ from: ctx.agentId, to: args.to, message: args.message });
    },
  },
  'agent.status': {
    class: 'read', tier: 'collab', approval: false, budget: 40000,
    help: 'returns one crew agent\'s status: running/completed/failed, its open todos, how long it has run, and a preview of its output. Args: agent (id or name). Use agent.list for the whole crew.',
    example: { action: 'agent.status', agent: 'Contract Auditor' },
    async execute(args, ctx) {
      const net = netFromCtx(ctx);
      if (!net) return noNet();
      return net.status(args.agent, ctx.agentId);
    },
  },
  'agent.list': {
    class: 'read', tier: 'collab', approval: false, budget: 40000,
    help: 'lists every agent in this crew run (roster members + spawned workers) with their status and task. Args: none.',
    example: { action: 'agent.list' },
    async execute(args, ctx) {
      const net = netFromCtx(ctx);
      if (!net) return noNet();
      return net.list(ctx.agentId);
    },
  },
  'agent.transcript': {
    class: 'read', tier: 'collab', approval: false, budget: 40000,
    help: 'reads another crew agent\'s recent conversation (its reasoning and answers). Args: agent (id or name), optional limit. Use to see WHAT a peer did, not just whether it finished.',
    example: { action: 'agent.transcript', agent: 'Contract Auditor', limit: 20 },
    async execute(args, ctx) {
      const net = netFromCtx(ctx);
      if (!net) return noNet();
      return net.transcript(args.agent, ctx.agentId, args.limit);
    },
  },
  'agent.await': {
    class: 'read', tier: 'collab', approval: false, budget: 40000,
    help: 'blocks until another crew agent finishes, then returns its output. Args: agent (id or name), optional timeoutMs. Circular awaits are refused. Prefer this over repeated agent.status polling when you need a peer\'s result to continue.',
    example: { action: 'agent.await', agent: 'Contract Auditor', timeoutMs: 60000 },
    async execute(args, ctx) {
      const net = netFromCtx(ctx);
      if (!net) return noNet();
      return net.awaitAgent(args.agent, ctx.agentId, { timeoutMs: args.timeoutMs, signal: ctx.signal });
    },
  },
  'agent.reflect': {
    class: 'read', tier: 'collab', approval: false, budget: 40000,
    help: 'self-check before you report done: your open todos, a recap of your recent work, and the crew\'s status. Use it to catch unfinished checklist items. Args: none.',
    example: { action: 'agent.reflect' },
    async execute(args, ctx) {
      const net = netFromCtx(ctx);
      if (!net) return noNet();
      return net.reflect(ctx.agentId);
    },
  },
};

const TOOLS = { ...CORE_TOOLS, ...REACH_TOOLS, ...COLLAB_TOOLS };

function allowedNames() {
  return Object.keys(TOOLS);
}

function namesByTier(tier) {
  return Object.keys(TOOLS).filter((name) => TOOLS[name].tier === tier);
}

const CORE_PROMPT_TOOLS = ['read', 'write', 'edit_patch', 'glob', 'search', 'list', 'shell', 'browse', 'websearch'];

function toolHelp(tier = 'core', disabled = []) {
  const tiers = Array.isArray(tier) ? tier : [tier];
  const off = new Set(disabled);
  const lines = [];
  for (const name of CORE_PROMPT_TOOLS) {
    if (!TOOLS[name] || off.has(name)) continue;
    lines.push('- ' + name + ': ' + TOOLS[name].help);
    lines.push('  ' + JSON.stringify(TOOLS[name].example));
  }
  if (tiers.includes('reach')) {
    const reachAvail = namesByTier('reach').filter(n => !off.has(n));
    if (reachAvail.length) {
      lines.push('Reach tools (compile, run, and manage this project):');
      for (const name of reachAvail) {
        lines.push('- ' + name + ': ' + TOOLS[name].help);
        lines.push('  ' + JSON.stringify(TOOLS[name].example));
      }
    }
  } else {
    const reachAvail = namesByTier('reach').filter(n => !off.has(n));
    if (reachAvail.length) {
      lines.push('More tools are available on request: emit '
        + JSON.stringify({ action: 'tool_help', topic: 'reach' })
        + ' to receive the Reach tool set (' + reachAvail.join(', ') + ').');
    }
  }
  return lines.join('\n');
}

function needsApproval(name) {
  const tool = TOOLS[name];
  return !!(tool && tool.approval);
}

function budgetFor(name, fallback = 40000) {
  const tool = TOOLS[name];
  if (!tool || tool.budget === Infinity) return fallback;
  return tool.budget || fallback;
}

/* Tiny glob matcher: supports **, *, ?. No character classes.
 * Implemented by hand to avoid the escape-class hazard of encoding
 * placeholders as regex metacharacters. */
function globMatch(pattern, str) {
  const p = String(pattern);
  const s = String(str);
  let pi = 0, si = 0;
  let starPi = -1, starSi = -1;
  while (si < s.length) {
    if (pi < p.length && (p[pi] === '?' || p[pi] === s[si])) {
      pi++; si++;
    } else if (pi < p.length && p[pi] === '*') {
      // Collapse consecutive stars; a double-star crosses /, single doesn't.
      let doubleStar = false;
      while (pi < p.length && p[pi] === '*') { pi++; if (pi < p.length && p[pi] === '*') { doubleStar = true; pi++; } }
      starPi = pi; starSi = si;
      if (doubleStar) {
        // Try to match the rest at every position, including across slashes.
        while (starSi <= s.length) {
          if (globMatch(p.slice(starPi), s.slice(starSi))) return true;
          starSi++;
        }
        return false;
      }
    } else if (starPi !== -1 && s[starSi] !== '/') {
      si = ++starSi;
      pi = starPi;
    } else {
      return false;
    }
  }
  while (pi < p.length && p[pi] === '*') pi++;
  return pi === p.length;
}

module.exports = {
  TOOLS,
  CORE_TOOLS,
  REACH_TOOLS,
  allowedNames,
  namesByTier,
  toolHelp,
  needsApproval,
  budgetFor,
  resolveInProject,
  globMatch,
};
