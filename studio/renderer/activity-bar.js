'use strict';

/* Reach Studio — activity bar: rail collapse, rail notification badges, and the
 * Explorer-style grouping of the Agents sidebar.
 *
 * WHAT THIS FILE IS NOT ALLOWED TO TOUCH
 * --------------------------------------
 * The conversation header spot (#agent-model-info — the "Conversation" summary
 * that also carries the Team button) and the TEAMS deck (#team-deck-slot,
 * .team-deck*, .team-tabs, .member-card) are frozen. Nothing here queries,
 * styles or re-parents them, and activity-bar.css is scoped to
 * `#page-agents aside` and `#page-projects aside` so it cannot leak into them either.
 *
 * WHY THE TREE IS RE-PARENTED RATHER THAN RE-RENDERED
 * --------------------------------------------------
 * app.js owns render order: loadAgentTree() rebuilds the CONTENTS of #agent-tree
 * on roughly twenty call sites, always appending the pinned `#tree-new-chat` row
 * first and then one `.tree-node` per conversation (depth-first, in order).
 * new-chat-ui.cjs asserts:
 *   - the saved rows come AFTER #tree-new-chat in document order
 *     (compareDocumentPosition must report DOCUMENT_POSITION_FOLLOWING), and
 *   - the row classes are `.tree-node` / `.tree-label` / `.tree-delete`.
 * So we do not generate rows and we do not reorder them. We split the SAME row
 * elements into two fixed section bodies, preserving both order and identity.
 * A MutationObserver re-applies the split after every rebuild, which makes the
 * change independent of the ~20 call sites that would each otherwise need an edit.
 */

(() => {
  const $ = sel => document.querySelector(sel);

  /* ------------------------------------------------------------- rail collapse */

  const RAIL_KEY = 'reach.railExpanded';

  function applyRail(expanded) {
    const toggle = $('#rail-toggle');
    document.documentElement.dataset.rail = expanded ? 'expanded' : 'collapsed';
    if (!toggle) return;
    toggle.setAttribute('aria-expanded', String(expanded));
    toggle.textContent = expanded ? '\u2039' : '\u203a';
    const label = expanded ? 'Collapse the navigation rail' : 'Expand the navigation rail';
    toggle.setAttribute('aria-label', label);
    toggle.title = label;
    try { localStorage.setItem(RAIL_KEY, expanded ? '1' : '0'); } catch { /* private mode */ }
  }

  let railExpanded = false;
  try { railExpanded = localStorage.getItem(RAIL_KEY) === '1'; } catch { /* ignore */ }
  applyRail(railExpanded);

  $('#rail-toggle')?.addEventListener('click', () => {
    railExpanded = !railExpanded;
    applyRail(railExpanded);
  });

  /* --------------------------------------------------------- panel width */

  /* Full width is 268px. The slider floor is exactly half of that. Releasing
     the thumb in the last few steps snaps to that floor and locks the thin
     presentation. Agents keep a status mark, the first word, and the time.
     Projects keep the first word. A first word that does not fit becomes its
     first two letters plus "...". Sliding or stepping back up unlocks the
     full names. Keyboard steps do not snap, so one arrow press can leave
     the lock. Each menu remembers its own width. */
  const PANEL_SNAP = 4;

  /* The brief is the first word. It only has a bounded slot in the thin lock,
     so the fit check has to run after layout, and again when the width
     transition finishes. A word that still overflows becomes two letters. */
  let fitFrame = 0;
  function fitBriefs() {
    document.querySelectorAll('#page-agents aside, #page-projects aside').forEach(aside => {
      const thin = aside.dataset.panel === 'thin';
      aside.querySelectorAll('.tree-brief, .project-brief').forEach(el => {
        const word = el.dataset.word || '';
        el.textContent = word;
        if (!thin || el.clientWidth <= 0 || word.length <= 2) return;
        if (el.scrollWidth > el.clientWidth + 1) {
          el.textContent = `${Array.from(word).slice(0, 2).join('')}...`;
        }
      });
    });
  }
  function scheduleFit() {
    if (fitFrame) return;
    fitFrame = requestAnimationFrame(() => {
      fitFrame = 0;
      fitBriefs();
    });
  }

  function bindPanel(aside, input, storageKey, noun) {
    if (!aside || !input) return;
    let fromPointer = false;
    function apply(value, { snap = false, dragging = false } = {}) {
      let next = Math.min(100, Math.max(0, Math.round(Number(value) || 0)));
      if (snap && next <= PANEL_SNAP) next = 0;
      const thin = next <= PANEL_SNAP;
      input.value = String(next);
      if (dragging) aside.dataset.sizing = '1';
      else aside.removeAttribute('data-sizing');
      aside.style.setProperty('--panel-width', String(next));
      aside.dataset.panel = thin ? 'thin' : 'wide';
      const text = thin
        ? 'Thin panel, locked at half width'
        : next >= 100 ? 'Full width' : `Width ${next}%`;
      input.setAttribute('aria-valuetext', text);
      input.title = thin
        ? `Thin panel locked at half width. Slide right to show ${noun}.`
        : 'Slide left to half width to lock the thin panel.';
      try { localStorage.setItem(storageKey, String(next)); } catch { /* private mode */ }
      scheduleFit();
    }
    aside.addEventListener('transitionend', event => {
      if (event.target === aside && event.propertyName === 'width') scheduleFit();
    });
    let stored = 100;
    try {
      const raw = localStorage.getItem(storageKey);
      if (raw !== null && raw !== '') stored = Number(raw);
    } catch { /* ignore */ }
    apply(Number.isFinite(stored) ? stored : 100);
    input.addEventListener('pointerdown', () => { fromPointer = true; });
    input.addEventListener('input', () => apply(input.value, { dragging: true }));
    input.addEventListener('change', () => {
      apply(input.value, { snap: fromPointer });
      fromPointer = false;
    });
  }

  bindPanel(document.querySelector('#page-agents aside'), $('#agent-panel-width'), 'reach.agentsPanelWidth', 'conversation names');
  bindPanel(document.querySelector('#page-projects aside'), $('#project-panel-width'), 'reach.projectsPanelWidth', 'project names');

  /* ------------------------------------------------------------ rail badges */

  /* Statuses that mean "this conversation wants your attention", mirroring the
     tree dot logic in app.js (running pulses, waiting/failed turn red). */
  const BUSY = new Set(['running', 'waiting_input', 'waiting_edits', 'waiting_approval', 'paused', 'stalled']);

  function statusOf(agent) {
    return agent?.runState?.status || agent?.status || '';
  }

  /* live() is exposed by app.js; fall back to the IPC list when the page has not
     been rendered yet. Both resolve to the same store records. */
  async function fetchAgents() {
    try {
      if (Array.isArray(window.live)) return window.live;
      if (typeof reachApi !== 'undefined' && reachApi?.agents?.list) return await reachApi.agents.list();
    } catch { /* fall through to no badge */ }
    return [];
  }

  async function refreshBadges() {
    const agents = await fetchAgents();
    if (!Array.isArray(agents)) return;
    const busy = agents.filter(a => BUSY.has(statusOf(a))).length;
    const badge = $('#rail-agents-badge');
    if (!badge) return;
    badge.hidden = busy === 0;
    badge.textContent = busy > 9 ? '9+' : String(busy);
    const button = $('#rail-agents');
    if (button) {
      button.title = busy
        ? `Agents (Ctrl+4) · ${busy} ${busy === 1 ? 'conversation needs' : 'conversations need'} attention`
        : 'Agents (Ctrl+4)';
    }
  }

  refreshBadges();

  /* ----------------------------------------------------------------- sections */

  const treeEl = $('#agent-tree');
  const startBody = $('#agent-body-new');

  /* A section head is `[aria-expanded]` on BOTH the section and the button; the
     button is what the user clicks, the section is what CSS keys off. */
  function bindSectionHead(head) {
    const section = head.closest('.sidebar-section');
    if (!section || head.dataset.bound === '1') return;
    head.dataset.bound = '1';
    head.addEventListener('click', () => {
      const open = section.getAttribute('aria-expanded') !== 'false';
      section.setAttribute('aria-expanded', String(!open));
      head.setAttribute('aria-expanded', String(!open));
    });
  }

  document.querySelectorAll('#page-agents aside .sidebar-section-head').forEach(bindSectionHead);

  /* The pinned "New Chat" row belongs to app.js; we only decide where it lives. */
  function isNewChatRow(node) {
    return node.nodeType === 1 && !!node.querySelector('#tree-new-chat');
  }

  /* Split root-level rows into the two section bodies without altering them.
     Rows are appended in their existing order, so document order for the
     conversation rows is exactly what app.js produced.

     The dedupe below is load-bearing. app.js rebuilds by clearing the tree with
     `treeEl.innerHTML = ''` and appending a fresh pinned row. Once we move that
     row OUT of #agent-tree it stops being reachable by that clear, so every
     rebuild would leave another copy behind (three rebuilds => three
     #tree-new-chat nodes, which new-chat-ui.cjs catches). Keeping the last
     occurrence and discarding the rest mirrors the owner's intent. */
  function distribute() {
    if (!treeEl || !startBody) return;
    const candidates = [...treeEl.children, ...startBody.children].filter(child =>
      child.classList?.contains('tree-node'));

    const pinned = candidates.filter(isNewChatRow);
    const keep = pinned[pinned.length - 1];
    for (const row of pinned) if (row !== keep) row.remove();

    for (const row of candidates) {
      if (row !== keep && isNewChatRow(row)) continue;
      const target = row === keep ? startBody : treeEl;
      if (row.parentElement !== target) target.appendChild(row);
    }

    /* Hide the list box only when app.js left it truly empty. It is NOT empty
       when the project has no conversations yet — app.js appends a
       `.tree-empty` hint in that case, and hiding the container would drop the
       "choose a project" guidance along with it. */
    treeEl.hidden = treeEl.children.length === 0;
  }

  if (treeEl && startBody) {
    distribute();
    /* childList only, not subtree: app.js replaces rows wholesale, and watching
       the subtree would fire on every text/class update inside a row. */
    new MutationObserver(() => {
      distribute();
      refreshBadges();
      scheduleFit();
    }).observe(treeEl, { childList: true });
  }

  const projectListEl = document.querySelector('#project-list');
  if (projectListEl) {
    new MutationObserver(() => scheduleFit()).observe(projectListEl, { childList: true });
  }

  /* Live status changes (a run starting or finishing) arrive as agent events
     well before the next tree rebuild, so badges refresh on a short debounce
     rather than on a timer. */
  let badgeTimer = null;
  function scheduleBadges() {
    if (badgeTimer) return;
    badgeTimer = setTimeout(() => {
      badgeTimer = null;
      if (!document.hidden) refreshBadges();
    }, 1000);
  }

  try {
    if (typeof reachApi !== 'undefined' && reachApi?.agents?.onEvent) {
      reachApi.agents.onEvent(scheduleBadges);
    }
    document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshBadges(); });
  } catch { /* events are optional; the tree observer still keeps badges fresh */ }

  refreshBadges();
})();