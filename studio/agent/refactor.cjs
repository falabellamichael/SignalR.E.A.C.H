'use strict';

/* Reach Studio — multi-file refactoring engine.
 *
 * Plans and executes coordinated changes across several files with all-or-
 * nothing safety. The PRD's refactoring story requires that a dependency
 * change touching N files either fully applies or fully rolls back, and that
 * a dependency cycle or syntax error halts the run with a trace of the
 * affected modules rather than leaving the project half-rewritten.
 *
 * Layering, matching the rest of agent/:
 *   - This module builds and applies PLANS. It never calls a model; the agent
 *     loop supplies the edits (planFromEdits) and this module owns validation,
 *     dependency analysis, ordering, staging, atomic apply, and rollback.
 *   - applyPlan() writes to disk. Everything else is pure and unit-testable.
 *   - Rollback is snapshot-based (original bytes held in memory for the
 *     duration of the apply), not git-based, so it works in a project that is
 *     not a repository. commitCheckpoint() optionally records a git commit
 *     after a successful apply, per the patch-manager story.
 *
 * Zero dependencies: node:fs, node:path, node:crypto only.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const MAX_PLAN_FILES = 200;
const MAX_FILE_BYTES = 4 * 1024 * 1024;

/* ------------------------------------------------------------------- planning */

/**
 * A plan is { id, files: [{path, before, after, ops}], order, cycles, warnings }
 * `before`/`after` are full file contents so staging and rollback need no
 * further disk reads.
 */
function newPlan(meta = {}) {
  return {
    id: crypto.randomUUID(),
    createdAt: Date.now(),
    files: [],
    order: [],
    cycles: [],
    warnings: [],
    errors: [],
    meta,
  };
}

function normalizeRel(p, projectDir) {
  const raw = String(p == null ? '' : p).trim();
  if (!raw) throw new Error('A file path is required.');
  if (/^([A-Za-z]:[\\/]|\\\\|~)/.test(raw)) throw new Error(`"${raw}" must be a project-relative path.`);
  if (/(^|[\\/])\.\.([\\/]|$)/.test(raw)) throw new Error(`"${raw}" must not traverse above the project (..).`);
  const root = projectDir ? path.resolve(String(projectDir)) : null;
  const rel = raw.split(path.sep).join('/').replace(/^\.\//, '');
  if (root) {
    const resolved = path.resolve(root, rel);
    const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep;
    if (resolved !== root && !resolved.startsWith(rootWithSep)) {
      throw new Error(`"${raw}" escapes the project directory.`);
    }
    return path.relative(root, resolved).split(path.sep).join('/');
  }
  return rel;
}

function sha(text) {
  return crypto.createHash('sha256').update(String(text == null ? '' : text), 'utf8').digest('hex');
}

/**
 * Build a plan from a list of proposed edits. Each edit is
 *   { path, content }                       — replace the whole file, or
 *   { path, search, replace, replaceAll }   — a located patch (uses edits.cjs
 *                                             semantics via the caller), or
 *   { path, create: true, content }         — a new file.
 *
 * Reads current contents from disk (through readImpl for tests), validates
 * that every path is inside the project, rejects duplicate targets, and
 * computes the dependency order plus any cycles among the touched files.
 */
function planFromEdits(edits, options = {}) {
  const {
    projectDir = null,
    readImpl = (p) => fs.readFileSync(p, 'utf8'),
    existsImpl = (p) => fs.existsSync(p),
    dependencyIndex = null,   // optional code-index result for ordering
  } = options;
  const plan = newPlan({ projectDir, count: Array.isArray(edits) ? edits.length : 0 });

  if (!Array.isArray(edits) || !edits.length) {
    plan.errors.push('A plan needs at least one file edit.');
    return plan;
  }
  if (edits.length > MAX_PLAN_FILES) {
    plan.errors.push(`Refusing to plan ${edits.length} files at once (limit ${MAX_PLAN_FILES}).`);
    return plan;
  }

  const byPath = new Map();
  for (const [i, edit] of edits.entries()) {
    if (!edit || typeof edit !== 'object') { plan.errors.push(`Edit ${i + 1} is not an object.`); continue; }
    let rel;
    try { rel = normalizeRel(edit.path, projectDir); }
    catch (error) { plan.errors.push(`Edit ${i + 1}: ${error.message}`); continue; }

    if (byPath.has(rel)) {
      // Two edits for one file would be applied in sequence with the second
      // blind to the first; require the caller to merge them instead. Say HOW,
      // because "merge them" alone sends the model back to guess at a format
      // and it will most likely just re-send the same two entries.
      plan.errors.push(`"${rel}" appears in more than one edit. Put every change to that file in ONE edit using hunks: [{search, replace}, ...].`);
      continue;
    }

    const abs = projectDir ? path.resolve(String(projectDir), rel) : rel;
    const creating = edit.create === true;
    let before = null;
    if (!creating) {
      if (!existsImpl(abs)) {
        plan.errors.push(`"${rel}" does not exist. Use create:true for a new file.`);
        continue;
      }
      try {
        const stat = statImpl(options.statImpl, abs);
        if (stat && stat.size > MAX_FILE_BYTES) {
          plan.errors.push(`"${rel}" is ${(stat.size / 1024 / 1024).toFixed(1)} MB, above the ${MAX_FILE_BYTES / 1024 / 1024} MB refactor limit.`);
          continue;
        }
        before = readImpl(abs);
      } catch (error) {
        plan.errors.push(`Cannot read "${rel}": ${error.message}`);
        continue;
      }
      if (typeof before !== 'string') {
        plan.errors.push(`"${rel}" is not a text file.`);
        continue;
      }
    } else if (existsImpl(abs)) {
      plan.errors.push(`"${rel}" already exists; create:true would overwrite it.`);
      continue;
    }

    let after;
    if (typeof edit.content === 'string') {
      after = edit.content;
    } else if (Array.isArray(edit.hunks) && edit.hunks.length) {
      // Located patch. applyPatch() owns the locate semantics (and rejects an
      // ambiguous or non-matching search), so the agent's edit_patch tool and
      // this engine cannot disagree about where a replacement lands or return
      // different text. It also supports several hunks in one file, which
      // locateEdit alone does not.
      try {
        const { applyPatch } = require('./edits.cjs');
        after = applyPatch(before == null ? '' : before, edit.hunks);
      } catch (error) {
        plan.errors.push(`"${rel}": ${error.message}`);
        continue;
      }
    } else if (typeof edit.search === 'string' && typeof edit.replace === 'string') {
      try {
        const { applyPatch } = require('./edits.cjs');
        after = applyPatch(before == null ? '' : before, [{ search: edit.search, replace: edit.replace }]);
      } catch (error) {
        plan.errors.push(`"${rel}": ${error.message}`);
        continue;
      }
    } else {
      plan.errors.push(`"${rel}" needs content, a hunks array, or a search/replace pair.`);
      continue;
    }
    if (typeof after !== 'string') {
      // Guard against a future edits.cjs change returning a descriptor instead
      // of text — writing that to disk would corrupt the file.
      plan.errors.push(`"${rel}" produced a non-text result; refusing to write it.`);
      continue;
    }

    if (after === before) {
      plan.warnings.push({ path: rel, message: 'No change; the proposed content is identical to the current file.' });
      continue;   // a no-op is not an error but should not be staged
    }

    byPath.set(rel, {
      path: rel,
      abs,
      before,
      after,
      creating,
      beforeHash: before === null ? null : sha(before),
      afterHash: sha(after),
      ops: describeOps(before, after),
    });
  }

  plan.files = [...byPath.values()];
  if (plan.errors.length) return plan;

  // Order the writes and surface dependency cycles among the touched files.
  const orderResult = orderFiles(plan.files, dependencyIndex);
  plan.order = orderResult.order;
  plan.cycles = orderResult.cycles;
  if (orderResult.cycles.length) {
    plan.errors.push('Dependency cycle detected among the files being refactored: '
      + orderResult.cycles.map(c => c.join(' → ')).join('; ')
      + '. Refactoring halted; no files were modified.');
  }
  return plan;
}

function statImpl(impl, abs) {
  if (impl) return impl(abs);
  try { return fs.statSync(abs); } catch { return null; }
}

/** Cheap structural summary of what changed, for the diff UI. */
function describeOps(before, after) {
  const ops = { added: 0, removed: 0, lines: 0 };
  if (before === null) { ops.added = String(after).split('\n').length; return ops; }
  ops.lines = Math.max(String(before).split('\n').length, String(after).split('\n').length);
  // A diff already exists in diff.cjs; reuse it so the numbers cannot diverge
  // from what the patch preview shows the user. diffLines takes two STRINGS
  // (it splits internally) — passing pre-split arrays would diff one line
  // against one line and report no change.
  try {
    const { diffLines, stats } = require('./diff.cjs');
    const s = stats(diffLines(before, after));
    ops.added = s.added; ops.removed = s.removed;
  } catch {
    const a = String(before).split('\n').length, b = String(after).split('\n').length;
    ops.added = Math.max(0, b - a);
    ops.removed = Math.max(0, a - b);
  }
  return ops;
}

/* ------------------------------------------------------------------ ordering */

/**
 * Topologically order the touched files using the code index's dependency
 * graph, so a module is written before the modules that import it (keeping
 * intermediate states as coherent as possible). Falls back to path order when
 * no index is supplied. Cycles among the touched files are reported — the
 * PRD requires halting with a trace rather than silently picking an order.
 */
function orderFiles(files, dependencyIndex) {
  const paths = new Set(files.map(f => f.path));
  const order = [];
  if (!dependencyIndex || !dependencyIndex.fileGraph) {
    return { order: files.map(f => f.path).sort(), cycles: [] };
  }
  // Restrict the graph to the files in this plan.
  const graph = new Map();
  for (const p of paths) {
    const targets = dependencyIndex.fileGraph.get(p) || dependencyIndex.fileGraph.get(String(p).split(path.sep).join('/'));
    graph.set(p, (targets ? [...targets] : []).filter(t => paths.has(t)));
  }
  const { findCycles } = require('./code-index.cjs');
  const cycles = findCycles(paths, graph);

  // Kahn's algorithm; a deterministic tie-break keeps plans reproducible.
  const indegree = new Map([...paths].map(p => [p, 0]));
  for (const [, targets] of graph) for (const t of targets) indegree.set(t, (indegree.get(t) || 0) + 1);
  const ready = [...paths].filter(p => !indegree.get(p)).sort();
  while (ready.length) {
    const node = ready.shift();
    order.push(node);
    for (const t of (graph.get(node) || []).slice().sort()) {
      indegree.set(t, indegree.get(t) - 1);
      if (indegree.get(t) === 0) ready.push(t);
    }
    ready.sort();
  }
  // Anything left is part of a cycle: append in path order so the caller still
  // sees every file, but cycles above force the plan to fail.
  for (const p of [...paths].sort()) if (!order.includes(p)) order.push(p);
  return { order, cycles };
}

/* -------------------------------------------------------------------- apply */

/**
 * Apply a plan atomically. Strategy:
 *   1. Re-read every target and verify its hash still matches the plan's
 *      `before` — if the user edited a file since planning, refuse rather than
 *      clobber their work.
 *   2. Snapshot originals, write each new file to a sibling temp, then rename
 *      into place. Rename is atomic within a directory, so a crash cannot
 *      leave a half-written source file.
 *   3. If any step fails, restore every snapshot and delete every temp, so a
 *      failed plan leaves the project exactly as it was.
 *
 * Returns {ok, applied[], rolledBack, error}.
 */
function applyPlan(plan, options = {}) {
  const {
    readImpl = (p) => fs.readFileSync(p, 'utf8'),
    writeImpl = (p, data) => fs.writeFileSync(p, data, 'utf8'),
    renameImpl = (a, b) => fs.renameSync(a, b),
    unlinkImpl = (p) => fs.unlinkSync(p),
    mkdirImpl = (p) => fs.mkdirSync(p, { recursive: true }),
    existsImpl = (p) => fs.existsSync(p),
    hashImpl = sha,
    onProgress = () => {},
    signal = null,
  } = options;

  if (!plan || !Array.isArray(plan.files) || !plan.files.length) {
    return { ok: false, applied: [], rolledBack: false, error: 'Nothing to apply.' };
  }
  if (plan.errors && plan.errors.length) {
    return { ok: false, applied: [], rolledBack: false, error: 'The plan has unresolved errors: ' + plan.errors[0] };
  }

  const ordered = (plan.order && plan.order.length ? plan.order : plan.files.map(f => f.path))
    .map(p => plan.files.find(f => f.path === p))
    .filter(Boolean);

  // 1. Staleness check — nothing is written until every target still matches.
  for (const file of ordered) {
    if (signal?.aborted) return { ok: false, applied: [], rolledBack: false, error: 'Cancelled.', cancelled: true };
    if (file.creating) {
      if (existsImpl(file.abs)) {
        return { ok: false, applied: [], rolledBack: false, error: `"${file.path}" was created since planning; re-plan to include it.` };
      }
      continue;
    }
    let current;
    try { current = readImpl(file.abs); }
    catch (error) { return { ok: false, applied: [], rolledBack: false, error: `"${file.path}" is no longer readable: ${error.message}` }; }
    if (hashImpl(current) !== file.beforeHash) {
      return {
        ok: false, applied: [], rolledBack: false, stale: file.path,
        error: `"${file.path}" changed on disk since the plan was built. Re-plan before applying.`,
      };
    }
  }

  // 2. Snapshot + staged writes.
  //    `applied` is the authoritative rollback list: only files that were
  //    actually renamed into place need undoing. An earlier version snapshotted
  //    every target up front and restored all of them, which "rolled back"
  //    files that had never been touched — and if such a restore failed (the
  //    usual reason being the same fault that broke the apply), it reported
  //    rollbackFailed and stopped, leaving the files that HAD been applied
  //    dirty. That is worse than no rollback at all.
  const snapshots = new Map();   // path -> {abs, before, creating}
  const temps = [];
  const applied = [];            // paths that are live on disk right now
  const cleanupTemps = () => { for (const t of temps) { try { if (existsImpl(t)) unlinkImpl(t); } catch { /* best effort */ } } };

  try {
    for (const file of ordered) {
      if (signal?.aborted) throw Object.assign(new Error('Cancelled.'), { cancelled: true });
      const dir = path.dirname(file.abs);
      if (dir && !existsImpl(dir)) mkdirImpl(dir);
      const temp = file.abs + '.reach-tmp-' + crypto.randomBytes(4).toString('hex');
      writeImpl(temp, file.after);
      temps.push(temp);
      onProgress({ phase: 'staged', path: file.path, count: applied.length, total: ordered.length });
      // Snapshot immediately before the rename: from here on the original is
      // only recoverable from memory.
      snapshots.set(file.path, { abs: file.abs, before: file.before, creating: !!file.creating });
      renameImpl(temp, file.abs);
      temps.pop();
      applied.push(file.path);
      onProgress({ phase: 'applied', path: file.path, count: applied.length, total: ordered.length });
    }
    return { ok: true, applied, rolledBack: false, files: ordered.length };
  } catch (error) {
    cleanupTemps();
    // Undo newest-first so a chain of dependent writes unwinds in reverse.
    // Every restore is attempted even if an earlier one fails, and all failures
    // are collected, so one bad file cannot strand the others on disk.
    const restoreErrors = [];
    for (const p of applied.slice().reverse()) {
      const snap = snapshots.get(p);
      if (!snap) continue;
      try {
        if (snap.creating) { if (existsImpl(snap.abs)) unlinkImpl(snap.abs); }
        else writeImpl(snap.abs, snap.before);
      } catch (restoreError) {
        restoreErrors.push(`${p}: ${restoreError.message}`);
      }
    }
    if (restoreErrors.length) {
      return {
        ok: false, applied, rolledBack: false, rollbackFailed: true,
        restoreErrors,
        error: `Apply failed (${error.message}) and rollback could not restore `
          + `${restoreErrors.length} file(s): ${restoreErrors.join('; ')}`,
      };
    }
    return {
      ok: false, applied: [], rolledBack: true, restored: applied.length,
      error: `Rolled back ${applied.length} file(s) after a failure: ${error.message}`,
      cancelled: !!error.cancelled,
    };
  }
}

/**
 * Record a git commit checkpoint after a successful apply. Best-effort: a
 * project that is not a git repository is not an error, it just yields
 * {skipped: true} so the caller can continue.
 */
function commitCheckpoint(projectDir, message, options = {}) {
  const { runCommand } = require('./platform.cjs');
  const cwd = String(projectDir || '');
  if (!cwd || !fs.existsSync(path.join(cwd, '.git'))) {
    return Promise.resolve({ ok: false, skipped: true, reason: 'Not a git repository.' });
  }
  const text = String(message || 'Reach Studio refactor checkpoint').slice(0, 500);
  return runCommand('git', ['add', '-A'], { cwd })
    .then(add => {
      if (!add.ok) return { ok: false, skipped: false, error: add.error || add.stderr || 'git add failed' };
      return runCommand('git', ['commit', '-m', text, '--no-verify'], { cwd });
    })
    .then(res => res.skipped ? res
      : res.ok ? { ok: true, skipped: false, stdout: res.stdout }
      : { ok: false, skipped: false, error: res.error || res.stderr || 'git commit failed' });
}

/** Compact, JSON-safe view of a plan for the UI and for tool results. */
function summarizePlan(plan) {
  if (!plan) return null;
  return {
    id: plan.id,
    files: plan.files.length,
    added: plan.files.reduce((n, f) => n + (f.ops?.added || 0), 0),
    removed: plan.files.reduce((n, f) => n + (f.ops?.removed || 0), 0),
    creating: plan.files.filter(f => f.creating).map(f => f.path),
    order: plan.order,
    cycles: plan.cycles,
    warnings: plan.warnings,
    errors: plan.errors,
    ok: !plan.errors.length,
    paths: plan.files.map(f => f.path),
  };
}

/* ------------------------------------------------------------ syntax guard */

/* Extensions node itself cannot parse. JSX/TS need a compiler that Studio does
 * not bundle, so these are SKIPPED rather than blocked — refusing to refactor a
 * TypeScript project would be worse than not checking it, and a false rejection
 * on valid code is the one failure mode that makes a guard actively harmful. */
const UNPARSEABLE_EXT = new Set(['.ts', '.tsx', '.jsx', '.mts', '.cts', '.vue', '.svelte']);
/* Validated with BOTH module and script semantics, because `node --check` is
 * extension- and package.json-sensitive: ESM written into a `.cjs` temp file is
 * rejected as "Cannot use import statement outside a module", and vice versa.
 * Accepting a file that parses under either semantics is what keeps this free of
 * false positives. */
const VALIDATED_EXT = new Set(['.js', '.mjs', '.cjs']);

const SYNTAX_CHECK_CONCURRENCY = 8;
const SYNTAX_CHECK_TIMEOUT_MS = 10000;
const SYNTAX_MAX_FILES = 120;

/**
 * Default syntax checker: `node --check` against a temp file.
 *
 * Proven parse-only — it does NOT execute the code being validated. That matters
 * here: the content comes from a model, so running it to check it would be
 * arbitrary code execution inside the app's own process. A probe writing a
 * hostile file (fs.writeFileSync marker + process.exit) showed exit 0, no marker
 * file, no stdout.
 *
 * @param content proposed file text
 * @param dir     where to write the temp candidate (defaults to os.tmpdir())
 * @param ext     the source file's extension. DELIBERATELY UNUSED here: this
 *   implementation forces BOTH `.mjs` and `.cjs` semantics rather than trusting
 *   the caller's extension, because `node --check` is extension- and
 *   package.json-sensitive — ESM checked as `.cjs` is rejected with "Cannot use
 *   import statement outside a module", and CJS as `.mjs` likewise. Accepting a
 *   file that parses under either semantics is what keeps this free of false
 *   positives. The parameter stays in the signature because it is part of the
 *   injectable checker contract (validateSyntax passes it, and a caller
 *   supplying its own TypeScript-aware checker needs it).
 * @returns {{ok:boolean, error?:string, skipped?:string}} — never throws for
 *   invalid syntax. `ok:true` + `skipped` means "could not check", which is
 *   never reported as an error in the user's code.
 */
function defaultCheckSyntax(content, dir, ext) {
  const os = require('node:os');
  const { execFileSync } = require('node:child_process');
  const tmp = fs.mkdtempSync(path.join(dir || os.tmpdir(), 'synchk-'));
  const results = [];
  // process.execPath is the NODE binary under `node --test`, but the ELECTRON
  // binary inside the packaged app (and under `electron . --smoke`). Running
  // `electron --check file` does NOT parse the file: Electron ignores --check and
  // tries to boot a GUI, hanging until the timeout. ELECTRON_RUN_AS_NODE makes
  // that same binary behave as plain node. Verified 2026-09-18: without it,
  // ETIMEDOUT after 8s; with it, exit 0 in ~47ms. Harmless under real node, so
  // set it unconditionally rather than sniffing the runtime.
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' };
  try {
    // Force module vs script semantics with the temp extension so the outcome
    // cannot depend on a package.json "type" field we did not write.
    for (const forced of ['.mjs', '.cjs']) {
      const f = path.join(tmp, 'candidate' + forced);
      fs.writeFileSync(f, content, 'utf8');
      try {
        execFileSync(process.execPath, ['--check', f], {
          encoding: 'utf8',
          timeout: SYNTAX_CHECK_TIMEOUT_MS,
          stdio: ['ignore', 'ignore', 'pipe'],
          env,
          windowsHide: true,   // never let the check pop a console/GUI window
        });
        return { ok: true };   // parses under at least one semantics
      } catch (e) {
        const msg = String(e.stderr || e.message || '').split('\n')
          .find(l => /SyntaxError|Error:/.test(l));
        results.push((msg || 'check failed').trim());
      }
    }
    return { ok: false, error: results[results.length - 1] || 'Syntax check failed.' };
  } catch (e) {
    // A checker that cannot run (no tmp space, killed node) must not be reported
    // as a syntax error in the user's code.
    return { ok: true, skipped: 'checker-unavailable: ' + e.message };
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

/**
 * Validate the PROPOSED content of a plan before anything is written to disk.
 *
 * This is the second half of the halt condition the module header promises ("a
 * dependency cycle or syntax error halts the run"). Cycles were already enforced
 * in planFromEdits; syntax was not checked anywhere, so model-proposed content
 * with an unbalanced brace would have been written straight over the user's file
 * and left the project unbuildable until reverted.
 *
 * Bounded and best-effort: a file we cannot check yields a warning, never an
 * error, so a malformed validator cannot deadlock the feature.
 *
 * @param plan from planFromEdits
 * @param options.checkSyntax (content, tmpDir, ext) => {ok, error} — injectable
 * @param options.tmpDir      where candidate files are written
 * @returns {Promise<{ok:boolean, errors:string[], warnings:string[], checked:number, skipped:number}>}
 */
async function validateSyntax(plan, options = {}) {
  const check = typeof options.checkSyntax === 'function' ? options.checkSyntax : defaultCheckSyntax;
  const errors = [];
  const warnings = [];
  const files = (plan && Array.isArray(plan.files)) ? plan.files : [];
  let checked = 0, skipped = 0;

  const targets = [];
  for (const f of files) {
    if (!f || typeof f.after !== 'string') continue;
    const ext = path.extname(String(f.path || '')).toLowerCase();
    if (UNPARSEABLE_EXT.has(ext) || !VALIDATED_EXT.has(ext)) {
      skipped++;
      continue;
    }
    targets.push(f);
  }

  if (targets.length > SYNTAX_MAX_FILES) {
    warnings.push(`Syntax-checked the first ${SYNTAX_MAX_FILES} of ${targets.length} changed files; the rest were not verified.`);
  }
  const bounded = targets.slice(0, SYNTAX_MAX_FILES);

  // Bounded concurrency: one `node --check` is ~45ms, so a 60-file plan would
  // take ~5s serially. Parallel with a cap keeps review responsive without
  // spawning hundreds of processes.
  let next = 0;
  const worker = async () => {
    while (next < bounded.length) {
      const f = bounded[next++];
      let res;
      try { res = await check(f.after, options.tmpDir, path.extname(String(f.path)).toLowerCase()); }
      catch (e) { res = { ok: true, skipped: 'checker-threw: ' + e.message }; }
      // A skip is checked FIRST: the default checker returns `{ ok: true, skipped }`
      // when it cannot run at all (no tmp space, killed node), and testing `ok`
      // before `skipped` would count that file as verified and silently drop the
      // warning. Counting an unchecked file as checked is the dangerous direction.
      if (res && res.skipped) { skipped++; warnings.push(`"${f.path}" was not syntax-checked (${res.skipped}).`); continue; }
      if (res && res.ok) { checked++; continue; }
      // An error message from node includes the temp path; strip it so the trace
      // names the user's file instead.
      const detail = String(res && res.error ? res.error : 'syntax error')
        .replace(/^[^\n]*candidate\.m?c?js[^\n]*\n?/gm, '')
        .split('\n').filter(Boolean).slice(0, 3).join(' | ')
        .trim();
      errors.push(`Syntax error in "${f.path}": ${detail}`);
    }
  };
  await Promise.all(Array.from({ length: Math.min(SYNTAX_CHECK_CONCURRENCY, Math.max(1, bounded.length)) }, worker));

  return { ok: errors.length === 0, errors, warnings, checked, skipped };
}

module.exports = {
  MAX_PLAN_FILES,
  MAX_FILE_BYTES,
  SYNTAX_CHECK_CONCURRENCY,
  SYNTAX_MAX_FILES,
  UNPARSEABLE_EXT,
  VALIDATED_EXT,
  defaultCheckSyntax,
  validateSyntax,
  newPlan,
  normalizeRel,
  sha,
  planFromEdits,
  orderFiles,
  describeOps,
  applyPlan,
  commitCheckpoint,
  summarizePlan,
};
