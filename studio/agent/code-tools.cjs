'use strict';

/* Reach Studio — agent tools for the codebase engines.
 *
 * The engines in code-index.cjs, refactor.cjs, patch-manager.cjs and
 * test-loop.cjs were built as pure modules; without tools here the agent could
 * not reach them at all, and the PRD's stories are written from the agent's
 * point of view ("I want the agent to search and index codebase ASTs", "I want
 * the coding agent to analyze dependencies and refactor code across multiple
 * files").
 *
 * Safety rules this file follows, matching the existing registry:
 *   - every path goes through resolveInProject (no absolute paths, no `..`)
 *   - nothing writes to disk without going through the refactor engine's
 *     atomic apply, and write-class tools honour the edit-review flow
 *   - output is bounded; a large repository must not blow the tool budget
 *   - failures return {ok:false, error} rather than throwing
 *
 * One deliberate omission: there is no tool that runs the *autonomous*
 * self-correction loop. That loop needs to call the model to propose fixes, and
 * a tool has no model access — it is invoked BY the model. tests.run therefore
 * executes the gates and returns structured parsed diagnostics for the agent to
 * act on, and tests.quickfix applies deterministic fixes. The full loop
 * (runSelfCorrectionLoop) is driven from the orchestrator/UI instead.
 */

const fs = require('node:fs');
const path = require('node:path');
const codeIndex = require('./code-index.cjs');
const refactor = require('./refactor.cjs');
const patchManager = require('./patch-manager.cjs');
const testLoop = require('./test-loop.cjs');
const { runCommand } = require('./platform.cjs');

/* ------------------------------------------------------------------- caching */

/* The index cache lives in code-index.cjs, which is the single owner.
 *
 * An earlier revision of this file kept its own cache. Two caches for the same
 * project disagree the moment anything writes to the tree: prompt injection
 * could serve definitions that the tools had already invalidated, or vice versa,
 * and the agent would be reasoning about source that no longer exists. Both call
 * sites now share one Map and one TTL.
 */
const { getIndex, invalidateIndex } = codeIndex;

/* ------------------------------------------------------------ bounded output */

/** Trim a symbol list to a size that cannot blow the tool budget. */
function capSymbols(symbols, limit) {
  const n = Number.isSafeInteger(limit) ? Math.max(1, Math.min(200, limit)) : 25;
  return symbols.slice(0, n).map(s => ({
    name: s.name,
    qualified: s.qualified,
    kind: s.kind,
    scope: s.scope || null,
    path: s.path,
    line: s.line,
    endLine: s.endLine,
    exported: !!s.exported,
    signature: String(s.signature || '').slice(0, 200),
  }));
}

function summarizeWarnings(warnings, limit = 12) {
  const list = Array.isArray(warnings) ? warnings : [];
  return {
    count: list.length,
    shown: list.slice(0, limit).map(w => ({ path: w.path, level: w.level, message: w.message })),
    truncated: list.length > limit,
  };
}

/* ------------------------------------------------------------- plan sessions */

/**
 * Refactor plans are stored here between the plan and apply calls, keyed by an
 * opaque id. Passing the full plan back through the model would cost thousands
 * of tokens and risk transcription errors in file contents; the agent only has
 * to remember a short id plus which chunks it wants.
 *
 * Bounded and time-expired: a plan holds full file contents, so an abandoned one
 * must not linger.
 */
const planSessions = new Map();
const MAX_PLAN_SESSIONS = 12;
const PLAN_TTL_MS = 30 * 60 * 1000;

function storePlan(projectDir, plan, reviews, context) {
  for (const [id, entry] of planSessions) {
    if (Date.now() - entry.at > PLAN_TTL_MS) planSessions.delete(id);
  }
  while (planSessions.size >= MAX_PLAN_SESSIONS) {
    const oldest = planSessions.keys().next().value;
    if (oldest === undefined) break;
    planSessions.delete(oldest);
  }
  const planId = 'plan-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  // `context` is stored because chunk ids are positional in the chunking: they
  // only mean the same thing at the width the previews were built with. See the
  // note on refactor.apply below.
  planSessions.set(planId, {
    at: Date.now(),
    projectDir: path.resolve(String(projectDir)),
    plan,
    reviews,
    context,
  });
  return planId;
}

function getPlan(planId) {
  const entry = planSessions.get(String(planId || ''));
  if (!entry) return null;
  if (Date.now() - entry.at > PLAN_TTL_MS) { planSessions.delete(String(planId)); return null; }
  return entry;
}

/* ------------------------------------------------------------------- the tools */

const CODE_TOOLS = {
  'code.index': {
    class: 'read', tier: 'code', approval: false, budget: 20000,
    help: 'indexes the bound project: builds the symbol table, import graph, call graph and detects dependency cycles. Returns counts plus any files skipped and why. Pass refresh:true to re-read from disk after edits.',
    example: { action: 'code.index', refresh: true },
    async execute(args, ctx) {
      if (!ctx.projectDir) return { ok: false, error: 'This agent is not bound to a project directory.' };
      try {
        const index = getIndex(ctx.projectDir, { force: args.refresh === true });
        const summary = codeIndex.summarize(index);
        return {
          ok: true,
          summary,
          warnings: summarizeWarnings(index.warnings),
          truncated: !!index.truncated,
          fileCycles: (index.fileCycles || []).slice(0, 10),
          symbolCycles: (index.symbolCycles || []).slice(0, 10),
        };
      } catch (error) { return { ok: false, error: String(error && error.message || error) }; }
    },
  },

  'code.search': {
    class: 'read', tier: 'code', approval: false, budget: 30000,
    help: 'searches the codebase symbol index by name (function, class, interface, type, enum, method, constant). Returns ranked matches with file, line and signature. Use this instead of grepping when you want declarations rather than every textual mention.',
    example: { action: 'code.search', query: 'runCommand', limit: 15 },
    async execute(args, ctx) {
      if (!ctx.projectDir) return { ok: false, error: 'This agent is not bound to a project directory.' };
      const query = String(args.query || '').trim();
      if (!query) return { ok: false, error: 'A query is required.' };
      try {
        const index = getIndex(ctx.projectDir);
        const limit = Number.isSafeInteger(args.limit) ? Math.max(1, Math.min(200, args.limit)) : 25;
        const found = codeIndex.contextForQuery(index, query, { maxSymbols: limit, maxChars: 100000, includeSnippets: false });
        return { ok: true, query, total: found.total, symbols: capSymbols(found.symbols, limit) };
      } catch (error) { return { ok: false, error: String(error && error.message || error) }; }
    },
  },

  'code.context': {
    class: 'read', tier: 'code', approval: false, budget: 30000,
    help: 'returns a ready-to-paste context block: the most relevant symbol definitions (with source snippets) plus their dependency edges for a query. Use it to ground yourself in real code before editing, instead of guessing at APIs.',
    example: { action: 'code.context', query: 'apply the patch atomically', maxSymbols: 8 },
    async execute(args, ctx) {
      if (!ctx.projectDir) return { ok: false, error: 'This agent is not bound to a project directory.' };
      const query = String(args.query || '').trim();
      if (!query) return { ok: false, error: 'A query is required.' };
      try {
        const index = getIndex(ctx.projectDir);
        const maxSymbols = Number.isSafeInteger(args.maxSymbols) ? Math.max(1, Math.min(40, args.maxSymbols)) : 10;
        const maxChars = Number.isSafeInteger(args.maxChars) ? Math.max(500, Math.min(24000, args.maxChars)) : 8000;
        const found = codeIndex.contextForQuery(index, query, { maxSymbols, maxChars, includeSnippets: true });
        return {
          ok: true,
          query,
          total: found.total,
          chars: found.chars,
          context: codeIndex.formatContext(found),
          symbols: capSymbols(found.symbols, maxSymbols),
          dependencies: found.dependencies,
        };
      } catch (error) { return { ok: false, error: String(error && error.message || error) }; }
    },
  },

  'code.impact': {
    class: 'read', tier: 'code', approval: false, budget: 20000,
    help: 'reports what a change to a symbol or file would touch: which symbols reference it (call graph) and which files import it (import graph). Check this BEFORE a rename or signature change so you plan every affected file at once.',
    example: { action: 'code.impact', symbol: 'applyPlan' },
    async execute(args, ctx) {
      if (!ctx.projectDir) return { ok: false, error: 'This agent is not bound to a project directory.' };
      const symbol = String(args.symbol || '').trim();
      const file = String(args.file || '').trim();
      if (!symbol && !file) return { ok: false, error: 'Pass a symbol name or a file path.' };
      try {
        const index = getIndex(ctx.projectDir);
        const out = { ok: true };
        if (symbol) {
          const matches = index.symbols.filter(s => s.name === symbol || s.qualified === symbol);
          if (!matches.length) return { ok: false, error: `No symbol named "${symbol}" is indexed. Run code.index first, or check the spelling.` };
          // Who references it? The call graph maps a symbol -> names it mentions,
          // so reverse it to find the referrers.
          const referrers = [];
          for (const [qualified, refs] of index.callGraph) {
            if (refs.has(matches[0].qualified)) referrers.push(qualified);
          }
          out.symbol = {
            name: symbol,
            definitions: matches.map(m => ({ qualified: m.qualified, path: m.path, line: m.line, kind: m.kind })),
            referencedBy: referrers.slice(0, 60),
            referenceCount: referrers.length,
          };
        }
        if (file) {
          const rel = file.split(path.sep).join('/').replace(/^\.\//, '');
          const importsOf = index.fileGraph.get(rel) || [];
          const importedBy = [];
          for (const [from, targets] of index.fileGraph) if (targets.includes(rel)) importedBy.push(from);
          out.file = {
            path: rel,
            exists: index.symbolsByFile.has(rel) || importsOf.length > 0,
            imports: importsOf.slice(0, 60),
            importedBy: importedBy.slice(0, 60),
            importedByCount: importedBy.length,
          };
        }
        return out;
      } catch (error) { return { ok: false, error: String(error && error.message || error) }; }
    },
  },

  'refactor.plan': {
    class: 'read', tier: 'code', approval: false, budget: 40000,
    help: 'plans a coordinated multi-file change and returns a reviewable diff WITHOUT touching disk. '
      + 'edits is an array; one entry per file. Each entry is {path, hunks:[{search, replace}, ...]} for targeted changes, '
      + '{path, content} to replace a whole file, or {path, create:true, content} for a new file. '
      + 'IMPORTANT: a file may appear in only ONE entry — put every change to that file in its hunks array, not in separate entries. '
      + 'Detects dependency cycles, ambiguous or stale searches, and concurrent on-disk edits. Returns a planId; pass it to refactor.apply.',
    example: { action: 'refactor.plan', edits: [
      { path: 'src/a.ts', hunks: [{ search: 'oldName(', replace: 'newName(' }, { search: "from './b'", replace: "from './c'" }] },
      { path: 'src/b.ts', search: 'export const oldName', replace: 'export const newName' },
    ] },
    async execute(args, ctx) {
      if (!ctx.projectDir) return { ok: false, error: 'This agent is not bound to a project directory.' };
      const edits = Array.isArray(args.edits) ? args.edits : null;
      if (!edits || !edits.length) return { ok: false, error: 'edits must be a non-empty array.' };
      if (edits.length > 60) return { ok: false, error: `Too many edits at once (${edits.length}); split the refactor into batches of 60 or fewer files.` };
      try {
        const plan = refactor.planFromEdits(edits, { projectDir: ctx.projectDir, ...(args.dependencyIndex === true ? { dependencyIndex: getIndex(ctx.projectDir) } : {}) });
        if (plan.errors.length) {
          // A plan with errors cannot be applied; report precisely why rather
          // than returning an id that would fail later.
          return { ok: false, error: plan.errors[0], errors: plan.errors.slice(0, 12), warnings: plan.warnings.slice(0, 12) };
        }
        // Per-file chunked previews so the caller (or the UI) can accept or
        // reject individual hunks instead of all-or-nothing.
        const reviews = plan.files.map(f => patchManager.buildReview(f.before, f.after, { path: f.path, context: args.context }));

        // Halt on unparseable output here too, matching the UI path: the PRD's
        // contract is that the agent "halts refactoring and displays an error
        // trace highlighting affected modules". Reporting it at plan time means
        // the caller can fix its edits immediately instead of storing a planId
        // whose apply is guaranteed to be refused. refactor.apply re-validates
        // regardless, because chunk selection can recombine edits.
        const syntax = await refactor.validateSyntax(plan);
        if (!syntax.ok) {
          return { ok: false, error: syntax.errors[0], errors: syntax.errors.slice(0, 12), warnings: syntax.warnings.slice(0, 12), halted: 'syntax' };
        }
        for (const w of syntax.warnings) plan.warnings.push({ path: null, message: w });

        const planId = storePlan(ctx.projectDir, plan, reviews, args.context);
        return {
          ok: true,
          planId,
          summary: refactor.summarizePlan(plan),
          order: plan.order,
          cycles: plan.cycles,
          warnings: plan.warnings.slice(0, 12),
          files: plan.files.map((f, i) => ({
            path: f.path,
            creating: !!f.creating,
            stats: reviews[i].stats,
            chunks: reviews[i].chunks.map(c => ({ id: c.id, added: c.added, removed: c.removed })),
          })),
          message: 'Nothing was written. Review the diff, then call refactor.apply with this planId (and optionally the chunk ids to accept).',
        };
      } catch (error) { return { ok: false, error: String(error && error.message || error) }; }
    },
  },

  'refactor.apply': {
    class: 'write', tier: 'code', approval: true, budget: 40000,
    help: 'applies a plan from refactor.plan atomically: every file changes or the whole change is rolled back. Optionally accept only some chunks per file (accepted: {path: [chunkId,...]}). Set commit:true to record a git checkpoint after a successful apply.',
    example: { action: 'refactor.apply', planId: 'plan-abc123', commit: true },
    async execute(args, ctx) {
      if (!ctx.projectDir) return { ok: false, error: 'This agent is not bound to a project directory.' };
      const entry = getPlan(args.planId);
      if (!entry) return { ok: false, error: 'Unknown or expired planId. Run refactor.plan again.' };
      // The plan was built against a specific project root; refuse to apply it
      // somewhere else (an agent can be rebound between calls).
      if (path.resolve(String(ctx.projectDir)) !== entry.projectDir) {
        return { ok: false, error: 'This plan belongs to a different project directory. Run refactor.plan again.' };
      }
      try {
        let plan = entry.plan;
        const accepted = args.accepted && typeof args.accepted === 'object' ? args.accepted : null;
        if (accepted) {
          const selections = entry.reviews.map((review, i) => ({
            path: plan.files[i].path,
            before: plan.files[i].before,
            after: plan.files[i].after,
            selected: Array.isArray(accepted[plan.files[i].path]) ? accepted[plan.files[i].path] : null,
          }));
          // The stored context MUST match what the previews were built with:
          // chunk ids are positional, so re-deriving chunks at the default width
          // would map an accepted id onto a different (or larger) chunk and write
          // text the caller never selected. See patch-manager.applySelection.
          const selected = patchManager.applySelections(selections, accepted, { context: entry.context });
          if (!selected.edits.length) {
            return { ok: false, error: 'No chunks were selected, so nothing would change.', warnings: selected.warnings, skipped: selected.skipped };
          }
          plan = refactor.planFromEdits(selected.edits, { projectDir: entry.projectDir });
          if (plan.errors.length) return { ok: false, error: plan.errors[0], errors: plan.errors.slice(0, 12) };
        }

        // Syntax guard before ANY write. This is the agent-facing path, so a model
        // proposes the edits and there is no human reviewing a diff — a rejected
        // selection can also combine chunks into code that never existed in the
        // plan. Nothing is written if it does not parse; the planId is kept so the
        // caller can re-select rather than re-plan.
        const syntax = await refactor.validateSyntax(plan);
        if (!syntax.ok) {
          return { ok: false, error: syntax.errors[0], errors: syntax.errors.slice(0, 12), halted: 'syntax', wrote: false };
        }

        const applied = refactor.applyPlan(plan, { projectDir: entry.projectDir });
        if (!applied.ok) {
          invalidateIndex(ctx.projectDir);
          return {
            ok: false,
            error: applied.error,
            rolledBack: !!applied.rolledBack,
            rollbackFailed: !!applied.rollbackFailed,
            restoreErrors: applied.restoreErrors || [],
            applied: applied.applied || [],
          };
        }
        // The tree changed, so any cached index is now stale.
        invalidateIndex(ctx.projectDir);
        planSessions.delete(String(args.planId));

        const result = { ok: true, applied: applied.applied, summary: refactor.summarizePlan(plan) };
        if (args.commit === true) {
          // Best-effort: a project that is not a git repository is not an error.
          result.checkpoint = await refactor.commitCheckpoint(entry.projectDir, args.commitMessage);
        }
        return result;
      } catch (error) { return { ok: false, error: String(error && error.message || error) }; }
    },
  },

  'patch.review': {
    class: 'read', tier: 'code', approval: false, budget: 60000,
    help: 'builds a side-by-side, chunk-by-chunk diff between a file on disk and proposed content, so individual hunks can be accepted or rejected. Args: path, content (the full proposed text). Returns chunk ids, line numbers and a rendered side-by-side view.',
    example: { action: 'patch.review', path: 'src/a.ts', content: 'new file text\n' },
    async execute(args, ctx) {
      if (!ctx.projectDir) return { ok: false, error: 'This agent is not bound to a project directory.' };
      const rel = String(args.path || '').trim();
      if (!rel) return { ok: false, error: 'A project-relative path is required.' };
      if (typeof args.content !== 'string') return { ok: false, error: 'content must be the full proposed file text.' };
      let abs;
      try { abs = require('./paths.cjs').resolveInProject(ctx.projectDir, rel); }
      catch (error) { return { ok: false, error: String(error && error.message || error) }; }
      let before = null;
      try { if (fs.existsSync(abs)) before = fs.readFileSync(abs, 'utf8'); }
      catch (error) { return { ok: false, error: 'Could not read the current file: ' + error.message }; }
      const review = patchManager.buildReview(before, args.content, { path: rel, context: args.context });
      if (!review.ok) return { ok: false, error: review.error };
      return {
        ok: true,
        path: rel,
        creating: before === null,
        identical: review.identical,
        stats: review.stats,
        chunks: review.chunks.map(c => ({
          id: c.id, added: c.added, removed: c.removed,
          sideBySide: c.sideBySide.map(r => ({ kind: r.kind, left: r.left, right: r.right })),
        })),
      };
    },
  },

  'tests.run': {
    class: 'exec', tier: 'code', approval: true, budget: 60000,
    help: 'runs the project\'s quality gates and returns STRUCTURED failures (file, line, rule/code, message) rather than raw output. gates is an array of {id, command, runner} where runner is one of node, pytest, jest, vitest, tsc, eslint, generic. Defaults to `npm test` with the node runner.',
    example: { action: 'tests.run', gates: [{ id: 'test', command: 'npm test', runner: 'node' }, { id: 'lint', command: 'npx eslint src', runner: 'eslint' }] },
    async execute(args, ctx) {
      if (!ctx.projectDir) return { ok: false, error: 'This agent is not bound to a project directory.' };
      const gates = Array.isArray(args.gates) && args.gates.length
        ? args.gates
        : [{ id: 'test', command: 'npm test', runner: 'node' }];
      if (gates.length > 8) return { ok: false, error: 'At most 8 gates per run.' };
      const results = [];
      let firstFailure = null;
      for (const gate of gates) {
        if (ctx.signal?.aborted) return { ok: false, cancelled: true, error: 'Cancelled.', results };
        const command = String(gate.command || '').trim();
        if (!command) { results.push({ gate: gate.id || '?', ok: false, error: 'A gate needs a command.' }); continue; }
        const started = Date.now();
        // runCommand goes through the same platform layer as the shell tool, so
        // the sandbox policy and approval gating that apply there apply here.
        const raw = await runCommand(command, [], { cwd: ctx.projectDir, shell: true, signal: ctx.signal });
        const interpreted = testLoop.interpret({ ...raw, durationMs: Date.now() - started }, gate.runner);
        const entry = {
          gate: gate.id || command,
          runner: interpreted.runner,
          ok: interpreted.ok,
          exitCode: interpreted.exitCode,
          durationMs: interpreted.durationMs,
          counts: interpreted.counts,
          failures: interpreted.failures.slice(0, 40).map(f => ({
            name: String(f.name || '').slice(0, 200),
            file: f.file || null,
            message: String(f.message || '').slice(0, 400),
            code: f.code || null,
            severity: f.severity || null,
          })),
          failureCount: interpreted.failures.length,
        };
        if (interpreted.failures.length > 40) entry.failuresTruncated = interpreted.failures.length - 40;
        results.push(entry);
        if (!interpreted.ok && !firstFailure) { firstFailure = entry; break; }
      }
      return { ok: !firstFailure, passed: !firstFailure, results, failingGate: firstFailure ? firstFailure.gate : null };
    },
  },

  'tests.quickfix': {
    class: 'write', tier: 'code', approval: true, budget: 40000,
    help: 'applies deterministic auto-fixes (e.g. `eslint --fix`) to the files with fixable diagnostics, then returns the resulting changes for review. This is the mechanical half of self-correction: formatting, semicolons and import order, which should not cost a model attempt. Args: command (the fixer), paths (optional array).',
    example: { action: 'tests.quickfix', command: 'npx eslint --fix src', paths: ['src/a.ts'] },
    async execute(args, ctx) {
      if (!ctx.projectDir) return { ok: false, error: 'This agent is not bound to a project directory.' };
      const command = String(args.command || '').trim();
      if (!command) return { ok: false, error: 'A fixer command is required, e.g. "npx eslint --fix src".' };
      if (!/--fix\b|--write\b|-w\b/.test(command)) {
        // Refuse a command that claims to be a fixer but has no fix flag: running
        // it would either do nothing or make unintended changes.
        return { ok: false, error: 'That command has no --fix/--write flag, so it would not fix anything. Pass the fixer command explicitly.' };
      }
      // Snapshot the files we are about to let a third-party tool rewrite, so the
      // change is reviewable and revertible. A fixer that writes in place with no
      // snapshot would leave edits nobody can undo from here.
      const wanted = Array.isArray(args.paths) && args.paths.length ? args.paths : null;
      const before = new Map();
      try {
        if (wanted) {
          for (const rel of wanted) {
            const abs = require('./paths.cjs').resolveInProject(ctx.projectDir, rel);
            if (fs.existsSync(abs)) before.set(rel, fs.readFileSync(abs, 'utf8'));
          }
        } else {
          const index = getIndex(ctx.projectDir);
          for (const s of index.symbols) {
            if (before.size >= 400) break;
            if (!before.has(s.path)) {
              const abs = path.resolve(ctx.projectDir, s.path);
              try { if (fs.existsSync(abs)) before.set(s.path, fs.readFileSync(abs, 'utf8')); } catch { /* unreadable: skip */ }
            }
          }
        }
      } catch (error) { return { ok: false, error: String(error && error.message || error) }; }

      const res = await runCommand(command, [], { cwd: ctx.projectDir, shell: true, signal: ctx.signal });
      invalidateIndex(ctx.projectDir);

      const changes = [];
      for (const [rel, oldText] of before) {
        let abs;
        try { abs = require('./paths.cjs').resolveInProject(ctx.projectDir, rel); } catch { continue; }
        let now = null;
        try { if (fs.existsSync(abs)) now = fs.readFileSync(abs, 'utf8'); } catch { continue; }
        if (now !== null && now !== oldText) {
          const review = patchManager.buildReview(oldText, now, { path: rel, context: 2 });
          changes.push({ path: rel, stats: review.stats, chunks: review.chunks.map(c => ({ id: c.id, added: c.added, removed: c.removed })) });
        }
      }
      return {
        ok: true,
        exitCode: res.exitCode,
        changedFiles: changes.length,
        changes: changes.slice(0, 60),
        stdout: String(res.stdout || '').slice(-2000),
        stderr: String(res.stderr || '').slice(-1000),
        message: changes.length
          ? `${changes.length} file(s) were auto-fixed. Review the changes before continuing.`
          : 'The fixer changed nothing.',
      };
    },
  },
};

/* Exports.
 *
 * The default export is the tool map itself, because tool-registry.cjs spreads
 * it into TOOLS (`{ ...CORE_TOOLS, ...require('./code-tools.cjs') }`). Any extra
 * property added to that object would therefore become a phantom "tool", so
 * internals are exposed via a non-enumerable property that object spread skips.
 */
module.exports = CODE_TOOLS;
Object.defineProperty(module.exports, 'internals', {
  value: { getIndex, invalidateIndex, storePlan, getPlan, capSymbols, planSessions },
  enumerable: false,
});
