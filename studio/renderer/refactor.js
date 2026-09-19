'use strict';

/* Reach Studio — Refactor Workbench (PRD: "Multi-File Refactoring Workbench
 * (/refactor)" and "Interactive Diff & Patch Manager").
 *
 * Flow: describe a task -> main grounds it in the symbol index and asks the model
 * for search/replace hunks -> a plan is built server-side (planId) -> the review
 * UI renders a syntax-highlighted side-by-side diff with per-file and per-chunk
 * accept/reject -> apply is atomic with an optional git checkpoint -> quality
 * gates can then be run, and the self-correction loop can fix failures up to the
 * PRD's 10 attempts, pausing into the Review Modal when it gives up.
 *
 * Safety properties this file is responsible for:
 *   - Nothing is written until the user presses Apply. The plan lives in main.
 *   - Diff cells are rendered with textContent first, so source containing HTML
 *     can never execute even before highlighting runs. Highlighting replaces the
 *     content with markup produced by ReachEditor.highlight(), which escapes
 *     internally; this file never interpolates source into innerHTML itself.
 *   - A planId is single-use and expires; a stale one is reported, not silently
 *     re-applied.
 *   - Chunk selection defaults to ALL accepted, so a plan can never be applied
 *     with silently-unselected changes, and "Apply selected" states the count.
 */
(() => {
  const $ = sel => document.querySelector(sel);
  const $$ = sel => [...document.querySelectorAll(sel)];

  const els = {
    noProject: $('#rf-noproject'),
    goProjects: $('#rf-go-projects'),
    body: $('#rf-body'),
    task: $('#rf-task'),
    conn: $('#rf-conn'),
    model: $('#rf-model'),
    modelSrc: $('#rf-model-src'),
    modelList: $('#rf-model-list'),
    browse: $('#rf-browse'),
    scope: $('#rf-scope'),
    generate: $('#rf-generate'),
    stop: $('#rf-stop'),
    commit: $('#rf-commit'),
    status: $('#rf-status'),
    review: $('#rf-review'),
    summary: $('#rf-summary'),
    summaryDetail: $('#rf-summary-detail'),
    selectAll: $('#rf-select-all'),
    selectNone: $('#rf-select-none'),
    warnings: $('#rf-warnings'),
    files: $('#rf-files'),
    apply: $('#rf-apply'),
    discard: $('#rf-discard'),
    applyStatus: $('#rf-apply-status'),
    verify: $('#rf-verify'),
    runGates: $('#rf-run-gates'),
    fixLoop: $('#rf-fix-loop'),
    gates: $('#rf-gates'),
    modal: $('#rf-modal'),
    modalSub: $('#rf-modal-sub'),
    modalTraces: $('#rf-modal-traces'),
    modalRevert: $('#rf-modal-revert'),
    modalScope: $('#rf-modal-scope'),
    modalEdit: $('#rf-modal-edit'),
  };

  const state = {
    planId: null,
    plan: null,
    // path -> Set(chunkId) of accepted chunks. Absent entry means "all accepted".
    selected: new Map(),
    collapsed: new Set(),
    running: false,
    runId: null,
    gates: [],
    lastSelfCorrect: null,
    // Guards against a highlight pass overwriting a newer render.
    renderToken: 0,
  };

  function setStatus(text, kind) {
    if (!els.status) return;
    els.status.textContent = text || '';
    els.status.className = 'dim' + (kind ? ' rf-' + kind : '');
  }
  function setApplyStatus(text, kind) {
    if (!els.applyStatus) return;
    els.applyStatus.textContent = text || '';
    els.applyStatus.className = 'dim' + (kind ? ' rf-' + kind : '');
  }
  function setBusy(on, label) {
    state.running = on;
    if (els.generate) els.generate.disabled = on;
    if (els.stop) els.stop.disabled = !on;
    if (els.apply) els.apply.disabled = on;
    if (els.runGates) els.runGates.disabled = on;
    if (els.fixLoop) els.fixLoop.disabled = on;
    if (on && label) setStatus(label);
  }

  /* Project directory resolution mirrors workspace-shell's precedence: the open
   * conversation's project, then the drawer's, then the selected project. All are
   * lexical globals from app.js (NOT window properties), so they must be read as
   * bare identifiers inside try/catch — a binding that is not yet initialized
   * would otherwise throw. */
  function projectDir() {
    try {
      if (typeof currentAgent !== 'undefined' && currentAgent?.dir) return currentAgent.dir;
      if (typeof drawerDir === 'function') { const d = drawerDir(); if (d) return d; }
      if (typeof currentProject !== 'undefined' && currentProject?.dir) return currentProject.dir;
    } catch { /* not initialized yet */ }
    return null;
  }

  /* ------------------------------------------------------------- selection */

  function chunkIdsFor(file) { return (file.chunks || []).map(c => c.id); }

  function isFileFullySelected(file) {
    const sel = state.selected.get(file.path);
    if (!sel) return true;                       // no entry = all accepted
    const all = chunkIdsFor(file);
    return all.every(id => sel.has(id));
  }
  function selectedIdsFor(file) {
    const sel = state.selected.get(file.path);
    if (!sel) return chunkIdsFor(file);
    return chunkIdsFor(file).filter(id => sel.has(id));
  }
  function setFileSelection(file, ids) {
    if (ids === null) state.selected.delete(file.path);
    else state.selected.set(file.path, new Set(ids));
  }
  function totalSelected() {
    if (!state.plan) return 0;
    return state.plan.files.reduce((n, f) => n + selectedIdsFor(f).length, 0);
  }
  function totalChunks() {
    if (!state.plan) return 0;
    return state.plan.files.reduce((n, f) => n + chunkIdsFor(f).length, 0);
  }

  /* -------------------------------------------------------------- rendering */

  function clearReview() {
    state.planId = null;
    state.plan = null;
    state.selected.clear();
    state.collapsed.clear();
    state.renderToken++;
    if (els.files) els.files.textContent = '';
    if (els.review) els.review.hidden = true;
    if (els.warnings) { els.warnings.hidden = true; els.warnings.textContent = ''; }
    setApplyStatus('');
  }

  function renderWarnings(plan) {
    if (!els.warnings) return;
    const items = [];
    if (Array.isArray(plan.warnings)) items.push(...plan.warnings);
    if (Array.isArray(plan.cycles) && plan.cycles.length) {
      items.push(`Dependency cycle detected: ${plan.cycles.length} cycle(s).`);
    }
    if (!items.length) { els.warnings.hidden = true; els.warnings.textContent = ''; return; }
    els.warnings.textContent = '';
    const list = document.createElement('ul');
    for (const w of items.slice(0, 20)) {
      const li = document.createElement('li');
      li.textContent = typeof w === 'string' ? w : JSON.stringify(w);
      list.appendChild(li);
    }
    els.warnings.appendChild(list);
    els.warnings.hidden = false;
  }

  function renderSummary() {
    if (!state.plan) return;
    const s = state.plan.summary || {};
    const sel = totalSelected(), all = totalChunks();
    if (els.summary) {
      els.summary.textContent = `${s.files ?? state.plan.files.length} file(s) · +${s.added ?? 0} −${s.removed ?? 0}`;
    }
    if (els.summaryDetail) {
      els.summaryDetail.textContent = `${sel} of ${all} chunk(s) staged for apply`
        + (state.plan.order && state.plan.order.length ? ` · apply order: ${state.plan.order.slice(0, 6).join(' → ')}${state.plan.order.length > 6 ? ' …' : ''}` : '');
    }
    if (els.apply) els.apply.disabled = state.running || sel === 0;
  }

  /** Build one diff row. Cells start as textContent (always safe) and are
   *  upgraded to highlighted markup by highlightChunk() afterwards. */
  function buildRow(row, path) {
    const tr = document.createElement('tr');
    tr.className = 'rf-row rf-' + row.kind;
    tr.dataset.path = path;

    const mkCell = (side, cls) => {
      const td = document.createElement('td');
      td.className = 'rf-cell ' + cls;
      const num = document.createElement('span');
      num.className = 'rf-ln';
      num.textContent = side && side.line != null ? String(side.line) : '';
      const code = document.createElement('span');
      code.className = 'rf-code';
      // textContent, never innerHTML: source may contain markup.
      code.textContent = side ? side.text : '';
      td.append(num, code);
      return td;
    };
    tr.append(mkCell(row.left, 'rf-left'), mkCell(row.right, 'rf-right'));
    return tr;
  }

  function renderFiles() {
    if (!els.files || !state.plan) return;
    const token = ++state.renderToken;
    els.files.textContent = '';

    for (const file of state.plan.files) {
      const card = document.createElement('section');
      card.className = 'rf-file';
      card.dataset.path = file.path;

      const head = document.createElement('header');
      head.className = 'rf-file-head';

      const toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = 'ghost tiny rf-collapse';
      toggle.setAttribute('aria-expanded', String(!state.collapsed.has(file.path)));
      toggle.textContent = state.collapsed.has(file.path) ? '▸' : '▾';

      const name = document.createElement('span');
      name.className = 'rf-file-path';
      name.textContent = file.path + (file.creating ? ' (new file)' : file.identical ? ' (unchanged)' : '');

      const st = file.stats || {};
      const stats = document.createElement('span');
      stats.className = 'rf-file-stats';
      stats.textContent = `+${st.added ?? 0} −${st.removed ?? 0}`;

      // File-level accept/reject: the PRD asks for selective approval of
      // "individual file diffs or line chunks".
      const fileCheck = document.createElement('label');
      fileCheck.className = 'check rf-file-check';
      const fileBox = document.createElement('input');
      fileBox.type = 'checkbox';
      fileBox.checked = isFileFullySelected(file);
      fileBox.addEventListener('change', () => {
        setFileSelection(file, fileBox.checked ? null : []);
        syncChunkBoxes(card, file);
        renderSummary();
      });
      fileCheck.append(fileBox, document.createTextNode(' whole file'));

      head.append(toggle, name, stats, fileCheck);

      const chunksWrap = document.createElement('div');
      chunksWrap.className = 'rf-chunks';
      chunksWrap.hidden = state.collapsed.has(file.path);

      for (const chunk of (file.chunks || [])) {
        chunksWrap.appendChild(buildChunk(file, chunk));
      }
      if (!(file.chunks || []).length) {
        const empty = document.createElement('p');
        empty.className = 'dim rf-no-chunks';
        empty.textContent = file.identical ? 'No differences.' : 'No reviewable chunks.';
        chunksWrap.appendChild(empty);
      }

      toggle.addEventListener('click', () => {
        const id = file.path;
        if (state.collapsed.has(id)) state.collapsed.delete(id); else state.collapsed.add(id);
        chunksWrap.hidden = state.collapsed.has(id);
        toggle.textContent = state.collapsed.has(id) ? '▸' : '▾';
        toggle.setAttribute('aria-expanded', String(!state.collapsed.has(id)));
      });

      card.append(head, chunksWrap);
      els.files.appendChild(card);

      // Highlight after the text is on screen, so a slow grammar load never
      // delays the diff appearing.
      for (const chunk of (file.chunks || [])) highlightChunk(card, file, chunk, token);
    }
    renderSummary();
  }

  function buildChunk(file, chunk) {
    const box = document.createElement('div');
    box.className = 'rf-chunk';
    box.dataset.chunk = chunk.id;

    const bar = document.createElement('div');
    bar.className = 'rf-chunk-bar';

    const check = document.createElement('label');
    check.className = 'check';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.dataset.chunkBox = chunk.id;
    cb.checked = selectedIdsFor(file).includes(chunk.id);
    cb.addEventListener('change', () => {
      const sel = new Set(selectedIdsFor(file));
      if (cb.checked) sel.add(chunk.id); else sel.delete(chunk.id);
      setFileSelection(file, [...sel]);
      // Keep the file-level box truthful without recursing into a full re-render.
      const fileCard = box.closest('.rf-file');
      if (fileCard) {
        const fbox = fileCard.querySelector('.rf-file-check input');
        if (fbox) fbox.checked = isFileFullySelected(file);
      }
      renderSummary();
    });
    check.append(cb, document.createTextNode(` accept chunk ${chunk.id}`));

    const meta = document.createElement('span');
    meta.className = 'dim rf-chunk-meta';
    const where = chunk.origStart != null ? `@ ${chunk.origStart}` : '';
    meta.textContent = `+${chunk.added ?? 0} −${chunk.removed ?? 0}${where ? ' ' + where : ''}`
      + (chunk.truncated ? ' · truncated for display' : '');

    bar.append(check, meta);

    const table = document.createElement('table');
    table.className = 'rf-diff';
    const tbody = document.createElement('tbody');
    for (const row of (chunk.rows || [])) tbody.appendChild(buildRow(row, file.path));
    table.appendChild(tbody);

    box.append(bar, table);
    return box;
  }

  function syncChunkBoxes(card, file) {
    const ids = new Set(selectedIdsFor(file));
    for (const cb of card.querySelectorAll('[data-chunk-box]')) {
      cb.checked = ids.has(cb.dataset.chunkBox);
    }
    const fbox = card.querySelector('.rf-file-check input');
    if (fbox) fbox.checked = isFileFullySelected(file);
  }

  /**
   * Upgrade a chunk's cells from escaped text to syntax-highlighted markup.
   *
   * Uses ReachEditor.highlight(), which reuses the editor's grammars and escapes
   * internally. Purely cosmetic: if highlighting is unavailable, slow, or throws,
   * the diff stays readable as plain text. A render token prevents a late-
   * resolving highlight from writing into a chunk that has since been replaced.
   */
  async function highlightChunk(card, file, chunk, token) {
    const editor = window.ReachEditor;
    if (!editor || typeof editor.highlight !== 'function') return;
    const box = card.querySelector(`.rf-chunk[data-chunk="${chunk.id}"]`);
    if (!box) return;
    try {
      const rows = [...box.querySelectorAll('.rf-row')];
      for (let i = 0; i < rows.length; i++) {
        const row = chunk.rows[i];
        if (!row) continue;
        for (const side of ['left', 'right']) {
          const cell = rows[i].querySelector('.rf-' + side + ' .rf-code');
          if (!cell || !row[side]) continue;
          const html = await editor.highlight(row[side].text, file.path);
          // A newer render (or a cleared review) means this chunk is gone.
          if (token !== state.renderToken) return;
          if (typeof html === 'string' && html) cell.innerHTML = html;
        }
      }
    } catch { /* plain text is an acceptable final state */ }
  }

  /* -------------------------------------------------------------- generate */

  async function browseModels() {
    if (!els.browse) return;
    els.browse.disabled = true;
    try {
      // List from the connection THIS workbench is pointed at, not the globally
      // active one: browsing the wrong endpoint yields model ids that then fail
      // when the plan is generated.
      const target = window.ReachConnections?.connectionId('refactor') || undefined;
      const res = await window.reach.listModels(target);
      if (!res.ok) { setStatus(res.err || 'Could not list models.', 'bad'); return; }
      const models = res.models || [];
      if (els.modelList) {
        els.modelList.textContent = '';
        for (const m of models) els.modelList.appendChild(new Option(m, m));
      }
      if (els.model) {
        els.model.readOnly = false;
        els.model.setAttribute('list', 'rf-model-list');
        if (!els.model.value && models.length) els.model.value = models[0];
      }
      const from = res.connectionName || window.ReachConnections?.currentLabel('refactor') || '';
      if (els.modelSrc) els.modelSrc.textContent = from ? `from ${from}` : '';
      setStatus(models.length ? `${models.length} model(s) from ${from || 'the endpoint'}.` : 'Endpoint returned no models.', models.length ? 'ok' : 'bad');
    } catch (e) {
      setStatus('Could not list models: ' + e.message, 'bad');
    } finally { els.browse.disabled = false; }
  }

  async function loadDefaultModel() {
    try {
      const conn = window.ReachConnections?.current('refactor');
      if (els.model && conn && conn.model && !els.model.value) els.model.value = conn.model;
      if (!els.model || els.model.value) return;
      const s = await window.reach.getSettings();
      if (els.model && s.model && !els.model.value) els.model.value = s.model;
    } catch { /* settings unavailable is not fatal */ }
  }

  function scopeList() {
    return (els.scope?.value || '')
      .split('\n').map(l => l.trim()).filter(Boolean).slice(0, 12);
  }

  async function generate() {
    const dir = projectDir();
    if (!dir) { setStatus('Select a project first.', 'bad'); return; }
    const task = (els.task?.value || '').trim();
    if (!task) { setStatus('Describe the refactor task first.', 'bad'); return; }
    const model = (els.model?.value || '').trim();
    if (!model) {
      setStatus('Choose a model first.', 'bad');
      window.ReachDialogs?.notice('Pick a model with Browse before proposing changes.');
      return;
    }

    // A new task invalidates any pending plan: its `before` snapshots were read
    // before the last apply, so applying it now could clobber newer content.
    clearReview();
    if (els.verify) els.verify.hidden = true;

    state.runId = 'rf_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
    setBusy(true, 'Proposing changes…');
    try {
      const res = await window.reach.refactor.generate({
        runId: state.runId, projectDir: dir, task, model, files: scopeList(),
        // Route at the connection the workbench is pointed at, not the globally
        // active one — otherwise the model shown may not be the one used.
        connectionId: window.ReachConnections?.connectionId('refactor') || undefined,
      });
      if (!res.ok) { setStatus(res.err || 'Could not propose changes.', 'bad'); return; }
      if (!res.edits || !res.edits.length) {
        setStatus(res.notes || 'The model proposed no changes.', 'warn');
        return;
      }
      setStatus(res.notes ? `Proposed: ${res.notes}` : 'Proposed changes — building the diff…', 'ok');
      await planFromEdits(dir, res.edits);
    } catch (e) {
      setStatus('Could not propose changes: ' + e.message, 'bad');
    } finally {
      setBusy(false);
    }
  }

  async function planFromEdits(dir, edits) {
    const res = await window.reach.refactor.plan({ projectDir: dir, edits, context: 3 });
    if (!res.ok) {
      setStatus(res.err || 'Could not build a diff.', 'bad');
      if (res.errors && res.errors.length > 1) {
        window.ReachDialogs?.notice(res.errors.slice(0, 6).join('\n'));
      }
      return false;
    }
    state.planId = res.planId;
    state.plan = res.plan;
    state.selected.clear();          // default: everything accepted
    if (els.review) els.review.hidden = false;
    renderWarnings(res.plan);
    renderFiles();
    setStatus('Review the diff, then apply the chunks you want.', 'ok');
    return true;
  }

  async function stopGenerate() {
    if (!state.runId) return;
    try { await window.reach.refactor.stop(state.runId); } catch { /* already done */ }
    setStatus('Stopped.', 'warn');
  }

  /* ----------------------------------------------------------------- apply */

  function acceptedMap() {
    const out = {};
    for (const file of (state.plan?.files || [])) out[file.path] = selectedIdsFor(file);
    return out;
  }

  async function applyPlan() {
    const dir = projectDir();
    if (!dir || !state.planId) { setApplyStatus('Nothing to apply.', 'bad'); return; }
    const sel = totalSelected();
    if (!sel) { setApplyStatus('No chunks are accepted.', 'bad'); return; }

    const commit = !!(els.commit && els.commit.checked);
    const ok = await window.ReachDialogs?.confirm(
      `Apply ${sel} of ${totalChunks()} chunk(s) to ${state.plan.files.length} file(s)?`
      + (commit ? '\n\nA git checkpoint will be committed afterwards.' : '')
    );
    // ReachDialogs.confirm resolves true/false; if dialogs are unavailable, do
    // NOT default to applying — that would write files without consent.
    if (ok === false) { setApplyStatus('Cancelled.'); return; }

    setBusy(true, 'Applying…');
    setApplyStatus('');
    try {
      const res = await window.reach.refactor.apply({
        planId: state.planId, projectDir: dir, accepted: acceptedMap(),
        commit, commitMessage: 'Reach Studio refactor',
      });
      if (!res.ok) {
        setApplyStatus(res.err || 'Apply failed.', 'bad');
        if (res.rollbackFailed) {
          window.ReachDialogs?.notice('The apply failed AND rollback did not fully restore the files:\n'
            + (res.restoreErrors || []).slice(0, 6).join('\n')
            + '\n\nCheck the project state before continuing.');
        } else if (res.rolledBack) {
          setApplyStatus((res.err || 'Apply failed.') + ' All changes were rolled back.', 'bad');
        }
        return;
      }
      let msg = `Applied ${(res.applied || []).length} file(s).`;
      if (res.checkpoint) {
        msg += res.checkpoint.skipped
          ? ` Checkpoint skipped (${res.checkpoint.reason || 'not a git repository'}).`
          : res.checkpoint.ok ? ' Git checkpoint committed.' : ` Checkpoint failed: ${res.checkpoint.error || 'unknown'}.`;
      }
      if (res.selection && res.selection.skipped && res.selection.skipped.length) {
        msg += ` ${res.selection.skipped.length} file(s) unchanged by your selection.`;
      }
      setApplyStatus(msg, 'ok');
      // The plan is single-use and the tree changed; clear the review and offer
      // verification.
      clearReview();
      if (els.verify) {
        els.verify.hidden = false;
        await loadGates(dir);
        renderGates([]);
      }
      setStatus('Applied. Run the quality gates to verify.', 'ok');
    } catch (e) {
      setApplyStatus('Apply failed: ' + e.message, 'bad');
    } finally {
      setBusy(false);
    }
  }

  /* ---------------------------------------------------------------- gates */

  async function loadGates(dir) {
    try {
      const res = await window.reach.refactor.defaultGates(dir || projectDir());
      state.gates = res.ok ? (res.gates || []) : [];
      if (!res.ok && els.gates) {
        els.gates.textContent = '';
        const p = document.createElement('p');
        p.className = 'dim';
        p.textContent = res.err || 'Could not detect quality gates.';
        els.gates.appendChild(p);
      }
    } catch { state.gates = []; }
  }

  function renderGates(results, note) {
    if (!els.gates) return;
    els.gates.textContent = '';
    if (note) {
      const p = document.createElement('p');
      p.className = 'dim';
      p.textContent = note;
      els.gates.appendChild(p);
    }
    if (!results.length && !note) {
      const p = document.createElement('p');
      p.className = 'dim';
      p.textContent = state.gates.length
        ? `Detected gates: ${state.gates.map(g => g.id).join(', ')}. Run them to verify the change.`
        : 'No quality gates detected for this project.';
      els.gates.appendChild(p);
      return;
    }
    for (const r of results) {
      const row = document.createElement('div');
      row.className = 'rf-gate ' + (r.ok ? 'rf-ok' : 'rf-bad');
      const head = document.createElement('div');
      head.className = 'rf-gate-head';
      const badge = document.createElement('span');
      badge.className = 'rf-badge';
      badge.textContent = r.ok ? 'pass' : 'fail';
      const title = document.createElement('strong');
      title.textContent = r.gate || r.command || 'gate';
      const meta = document.createElement('span');
      meta.className = 'dim';
      const counts = r.counts || {};
      const bits = [];
      if (counts.fail !== undefined) bits.push(`${counts.fail} failing`);
      if (counts.pass !== undefined) bits.push(`${counts.pass} passing`);
      if (counts.warnings) bits.push(`${counts.warnings} warnings`);
      if (counts.fixable) bits.push(`${counts.fixable} auto-fixable`);
      meta.textContent = `exit ${r.exitCode ?? '?'}${bits.length ? ' · ' + bits.join(' · ') : ''}${r.durationMs != null ? ` · ${(r.durationMs / 1000).toFixed(1)}s` : ''}`;
      head.append(badge, title, meta);
      row.appendChild(head);

      if (!r.ok) {
        const list = document.createElement('ul');
        list.className = 'rf-failures';
        for (const f of (r.failures || []).slice(0, 15)) {
          const li = document.createElement('li');
          const where = f.file ? `${f.file.path}${f.file.line ? ':' + f.file.line : ''}${f.file.column ? ':' + f.file.column : ''}` : '';
          li.textContent = `${f.name || 'failure'}${where ? ' @ ' + where : ''}${f.code ? ' [' + f.code + ']' : ''}${f.message ? ': ' + f.message : ''}`;
          list.appendChild(li);
        }
        if (!(r.failures || []).length && r.tail) {
          const li = document.createElement('li');
          const pre = document.createElement('pre');
          pre.textContent = String(r.tail).slice(-800);
          li.appendChild(pre);
          list.appendChild(li);
        }
        if (list.childNodes.length) row.appendChild(list);
      }
      els.gates.appendChild(row);
    }
  }

  async function runGates() {
    const dir = projectDir();
    if (!dir) { setStatus('Select a project first.', 'bad'); return; }
    if (els.verify) els.verify.hidden = false;
    setBusy(true, 'Running quality gates…');
    try {
      const res = await window.reach.refactor.gates({ projectDir: dir, gates: state.gates.length ? state.gates : undefined });
      if (!res.ok && !res.results) { renderGates([], res.err || 'Could not run the gates.'); return; }
      renderGates(res.results || []);
      setStatus(res.passed ? 'All quality gates pass.' : `Gate "${res.failingGate}" failed.`, res.passed ? 'ok' : 'bad');
    } catch (e) {
      renderGates([], 'Could not run the gates: ' + e.message);
    } finally {
      setBusy(false);
    }
  }

  async function selfCorrect() {
    const dir = projectDir();
    if (!dir) { setStatus('Select a project first.', 'bad'); return; }
    const model = (els.model?.value || '').trim();
    if (!model) { setStatus('Choose a model first.', 'bad'); return; }
    if (!state.gates.length) await loadGates(dir);
    if (!state.gates.length) { renderGates([], 'No quality gates detected, so there is nothing to self-correct against.'); return; }

    const ok = await window.ReachDialogs?.confirm(
      'Run the self-correction loop?\n\nIt will run the quality gates, ask the model to fix failures, and retry — up to 10 attempts. Files may be modified. A git checkpoint is recommended first.'
    );
    if (ok === false) return;

    state.runId = 'sc_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
    if (els.verify) els.verify.hidden = false;
    setBusy(true, 'Self-correcting…');
    renderGates([], 'Running gates and applying fixes…');
    try {
      const res = await window.reach.refactor.selfCorrect({
        runId: state.runId, projectDir: dir, model, gates: state.gates, files: scopeList(),
        connectionId: window.ReachConnections?.connectionId('refactor') || undefined,
      });
      if (!res.ok) { renderGates([], res.err || 'Self-correction failed.'); setStatus(res.err || 'Self-correction failed.', 'bad'); return; }
      state.lastSelfCorrect = res;
      if (res.passed) {
        renderGates([], `All gates pass after ${res.attempts} attempt(s).`);
        setStatus(`Self-correction succeeded in ${res.attempts} attempt(s).`, 'ok');
      } else {
        renderGates([], `Stopped after ${res.attempts} attempt(s) without passing.`);
        setStatus('Self-correction stopped; review the failures.', 'bad');
        showReviewModal(res);
      }
    } catch (e) {
      renderGates([], 'Self-correction failed: ' + e.message);
    } finally {
      setBusy(false);
    }
  }

  /* --------------------------------------------------------- Review Modal */

  /* PRD: "Upon reaching 10 failing attempts, reachd pauses execution and sends
   * status notification to REACH Studio" and "REACH Studio displays interactive
   * Review Modal Prompt displaying failing test traces and 3 action options:
   * Revert Changes, Adjust Scope, and Manually Edit". */
  function showReviewModal(result) {
    if (!els.modal) return;
    const iters = (result.iterations || []);
    // The most recent iteration that carries real failures is the one to show.
    const withFailures = [...iters].reverse().find(i => i.failures && i.failures.length);
    const last = iters[iters.length - 1];

    if (els.modalSub) {
      els.modalSub.textContent = `${result.attempts} attempt(s) did not reach a passing state.`
        + (result.report ? ' ' + String(result.report).split('\n')[0] : '')
        + ' Your working tree still holds the last attempted fix.';
    }
    if (els.modalTraces) {
      els.modalTraces.textContent = '';
      const shown = withFailures || last;
      if (shown) {
        const head = document.createElement('p');
        head.className = 'rf-modal-head';
        head.textContent = shown.gate
          ? `Last failing gate: ${shown.gate} (attempt ${shown.attempt})`
          : `Last attempt: ${shown.phase || 'unknown'} (attempt ${shown.attempt})`;
        els.modalTraces.appendChild(head);

        const list = document.createElement('ul');
        for (const f of (shown.failures || []).slice(0, 20)) {
          const li = document.createElement('li');
          const where = f.file ? `${f.file.path}${f.file.line ? ':' + f.file.line : ''}` : '';
          li.textContent = `${f.name || 'failure'}${where ? ' @ ' + where : ''}${f.code ? ' [' + f.code + ']' : ''}${f.message ? ': ' + f.message : ''}`;
          list.appendChild(li);
        }
        if (list.childNodes.length) els.modalTraces.appendChild(list);
        if (shown.tail) {
          const pre = document.createElement('pre');
          pre.className = 'rf-modal-tail';
          pre.textContent = String(shown.tail).slice(-900);
          els.modalTraces.appendChild(pre);
        }
        if (!list.childNodes.length && !shown.tail) {
          const p = document.createElement('p');
          p.className = 'dim';
          p.textContent = shown.error || 'No structured traces were captured for this attempt.';
          els.modalTraces.appendChild(p);
        }
      }
      // Every attempt, so the user can see whether it was stalling.
      const phases = document.createElement('p');
      phases.className = 'dim rf-modal-phases';
      phases.textContent = 'Attempts: ' + iters.map(i => `${i.attempt}:${i.phase}`).join(', ');
      els.modalTraces.appendChild(phases);
    }
    els.modal.hidden = false;
    els.modal.setAttribute('aria-hidden', 'false');
    els.modalEdit?.focus();
  }

  function hideReviewModal() {
    if (!els.modal) return;
    els.modal.hidden = true;
    els.modal.setAttribute('aria-hidden', 'true');
  }

  async function modalRevert() {
    const dir = projectDir();
    hideReviewModal();
    if (!dir) { setStatus('Select a project first.', 'bad'); return; }
    const ok = await window.ReachDialogs?.confirm(
      'Revert tracked files to their last committed state?\n\nUncommitted work in this project will be lost. Untracked new files are left alone.'
    );
    if (ok === false) return;
    setBusy(true, 'Reverting…');
    try {
      const res = await window.reach.refactor.revert({ projectDir: dir });
      if (!res.ok) { setStatus(res.err || 'Could not revert.', 'bad'); window.ReachDialogs?.notice(res.err || 'Could not revert.'); return; }
      setStatus(res.note || 'Reverted to the last committed state.', 'ok');
      renderGates([], 'Reverted. Run the gates again to confirm the baseline.');
    } catch (e) {
      setStatus('Could not revert: ' + e.message, 'bad');
    } finally { setBusy(false); }
  }

  function modalAdjustScope() {
    hideReviewModal();
    // Bring the failing files into scope and refocus the task, rather than
    // silently restarting: the user decides what to narrow to.
    const res = state.lastSelfCorrect;
    const failing = new Set();
    for (const it of (res?.iterations || [])) {
      for (const f of (it.failures || [])) if (f.file && f.file.path) failing.add(f.file.path);
    }
    if (failing.size && els.scope) {
      const existing = scopeList();
      const merged = [...new Set([...existing, ...failing])].slice(0, 12);
      els.scope.value = merged.join('\n');
    }
    els.task?.focus();
    setStatus('Narrow the task or scope, then propose changes again.', 'warn');
  }

  async function modalManualEdit() {
    hideReviewModal();
    // Open the first failing file in the editor drawer. setDrawer()/openFile() are
    // lexical globals from app.js (not window properties), so they are called as
    // bare identifiers and guarded — the drawer is best-effort, the point is to
    // get the file open.
    const res = state.lastSelfCorrect;
    let target = null;
    for (const it of [...(res?.iterations || [])].reverse()) {
      for (const f of (it.failures || [])) {
        if (f.file && f.file.path) { target = f.file.path; break; }
      }
      if (target) break;
    }
    try {
      if (typeof setDrawer === 'function') setDrawer(true);
    } catch { /* opening the drawer is best-effort */ }
    if (target && typeof openFile === 'function') {
      try { await openFile(target); setStatus(`Opened ${target} for manual editing.`, 'ok'); return; }
      catch (e) { setStatus('Could not open ' + target + ': ' + e.message, 'bad'); }
    }
    setStatus(target ? 'Open ' + target + ' from the file drawer.' : 'Open the failing file manually from the file drawer.', 'warn');
  }

  /* ------------------------------------------------------------- progress */

  function onProgress(evt) {
    if (!evt || (state.runId && evt.runId && evt.runId !== state.runId)) return;
    const label = evt.note || evt.stage || '';
    if (evt.stage === 'loop') {
      const phase = evt.type ? `attempt ${evt.attempt ?? '?'}: ${evt.type}` : '';
      setStatus([label, phase].filter(Boolean).join(' · '), evt.type === 'passed' ? 'ok' : undefined);
      return;
    }
    if (label) setStatus(label, evt.stage === 'done' ? 'ok' : undefined);
  }

  /* ----------------------------------------------------------------- sync */

  function sync() {
    const dir = projectDir();
    const has = !!dir;
    if (els.noProject) els.noProject.hidden = has;
    if (els.body) els.body.hidden = !has;
    if (!has) { clearReview(); if (els.verify) els.verify.hidden = true; }
    // A plan is bound to one project directory; switching projects invalidates it.
    if (has && state.planId && state.planDir && state.planDir !== dir) clearReview();
    if (has) state.planDir = dir;
    // Settings may have changed since this page was built (a connection added,
    // renamed or removed), so re-populate the picker every time the view shows.
    window.ReachConnections?.refresh('refactor').then(() => loadDefaultModel()).catch(() => {});
  }

  function init() {
    if (!els.body) return;   // page not present (older shell): stay inert
    // Bind the connection picker BEFORE reading the default model: the model
    // comes from whichever connection is selected, so the order matters.
    window.ReachConnections?.bind('refactor', els.conn, {
      onChange: () => {
        // Models are per-endpoint: the previously fetched ids may not exist on
        // the new one, so clear rather than leave a stale id that would fail.
        if (els.modelList) els.modelList.textContent = '';
        if (els.model) { els.model.value = ''; els.model.readOnly = true; els.model.removeAttribute('list'); }
        if (els.modelSrc) els.modelSrc.textContent = '';
        loadDefaultModel();
      },
    });
    loadDefaultModel();
    els.browse?.addEventListener('click', browseModels);
    els.generate?.addEventListener('click', generate);
    els.stop?.addEventListener('click', stopGenerate);
    els.apply?.addEventListener('click', applyPlan);
    els.discard?.addEventListener('click', () => { clearReview(); setStatus('Plan discarded.', 'warn'); });
    els.selectAll?.addEventListener('click', () => { state.selected.clear(); renderFiles(); });
    els.selectNone?.addEventListener('click', () => {
      for (const f of (state.plan?.files || [])) setFileSelection(f, []);
      renderFiles();
    });
    els.runGates?.addEventListener('click', runGates);
    els.fixLoop?.addEventListener('click', selfCorrect);
    els.goProjects?.addEventListener('click', () => {
      if (typeof showTab === 'function') showTab('projects');
    });
    els.modalRevert?.addEventListener('click', modalRevert);
    els.modalScope?.addEventListener('click', modalAdjustScope);
    els.modalEdit?.addEventListener('click', modalManualEdit);
    // Escape closes the modal; it must not also trigger a destructive default.
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && els.modal && !els.modal.hidden) { e.stopPropagation(); hideReviewModal(); }
    });
    // Ctrl/Cmd+Enter proposes changes while the task box has focus, matching the
    // playground's shortcut. The shell's hotkey handler ignores keystrokes whose
    // target is an editable field, so this cannot collide with Ctrl+1..6.
    els.task?.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); generate(); }
    });
    try { window.reach.refactor.onProgress(onProgress); } catch { /* preload without refactor bridge */ }
    sync();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  window.ReachRefactor = { sync, generate, applyPlan, runGates, selfCorrect, clearReview, showReviewModal, hideReviewModal };
})();
