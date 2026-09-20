/* Deployed teams: a persistent tab per worker, one full-width detail surface.
 * The deck consumes the existing activity model, never invents progress, and
 * leaves each member DOM intact so transcripts, reviews and inputs survive. */
(() => {
  let serial = 0;
  const icons = { queued: 'clock', working: 'circle-notch', waiting: 'pause-circle',
    silent: 'clock', paused: 'pause-circle', stalled: 'warning-circle', completed: 'check-circle', error: 'warning-circle' };
  const setText = (node, value) => { if (node.textContent !== value) node.textContent = value; };
  function icon(name, className = '') {
    const el = document.createElement('span');
    el.className = 'team-icon ' + className;
    el.dataset.icon = name;
    el.setAttribute('aria-hidden', 'true');
    return el;
  }
  function create({ team, task }) {
    const id = 'team-deck-' + ++serial;
    const entries = new Map();
    const nurseStats = { handoffs: 0, wakes: 0, wakeStarted: 0, wakeSucceeded: 0, wakeFailed: 0, skips: 0, quiet: 0 };
    let selected = null, ended = false;
    const element = document.createElement('section');
    element.className = 'team-run team-deck';
    element.setAttribute('aria-label', `${team.name} deployed team`);
    element.innerHTML = '<div class="team-deck-nav"><div class="team-deck-heading"><strong></strong><span class="team-deck-mode"></span><span class="team-deck-nurse" aria-live="off" hidden></span><span class="team-deck-count"></span></div><div class="team-tab-strip"><button class="team-tab-scroll" type="button" aria-label="Scroll team tabs left"></button><div class="team-tabs" role="tablist" aria-label="Deployed team members" aria-orientation="horizontal"></div><button class="team-tab-scroll" type="button" aria-label="Scroll team tabs right"></button></div><details class="team-model-info" open><summary aria-label="Toggle selected team member information"><span class="team-model-summary-copy"><strong></strong><span class="team-model-summary-model"></span></span><span class="team-model-summary-state"></span><span class="team-icon team-model-caret" data-icon="caret-right" aria-hidden="true"></span></summary><div class="team-model-info-expanded"><div class="team-model-expanded-identity"><strong></strong><span class="team-model-expanded-model"></span></div><span class="team-model-expanded-state"></span><span class="team-model-expanded-meta"></span><button class="ghost small team-model-control" type="button"></button></div></details></div><div class="team-panels"></div><div class="team-reviews"></div>';
    const banner = element.querySelector('.team-deck-heading');
    setText(banner.querySelector('strong'), team.name || 'Team');
    setText(banner.querySelector('.team-deck-mode'), team.mode || 'parallel');
    banner.title = task;
    const nurseBadge = banner.querySelector('.team-deck-nurse');
    const count = element.querySelector('.team-deck-count');
    const tabs = element.querySelector('.team-tabs');
    const panels = element.querySelector('.team-panels');
    const reviews = element.querySelector('.team-reviews');
    const modelInfo = element.querySelector('.team-model-info');
    // Pin the live tab rail, not the expanded metadata. At small window sizes
    // keeping both pinned can cover the entire conversation viewport.
    element.querySelector('.team-deck-nav').after(modelInfo);
    const modelControl = modelInfo.querySelector('.team-model-control');
    modelInfo.hidden = true;
    const [left, right] = element.querySelectorAll('.team-tab-scroll');
    left.append(icon('caret-left')); right.append(icon('caret-right'));
    function overflow() {
      const extra = tabs.scrollWidth - tabs.clientWidth;
      const scrolling = extra > 2;
      left.hidden = right.hidden = !scrolling;
      left.disabled = tabs.scrollLeft <= 1;
      right.disabled = tabs.scrollLeft >= extra - 1;
    }
    const scroll = amount => tabs.scrollBy({ left: amount, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
    left.onclick = () => scroll(-Math.max(240, tabs.clientWidth * .75));
    right.onclick = () => scroll(Math.max(240, tabs.clientWidth * .75));
    tabs.addEventListener('scroll', overflow, { passive: true });
    tabs.addEventListener('wheel', event => {
      if (event.ctrlKey || Math.abs(event.deltaX) >= Math.abs(event.deltaY) || tabs.scrollWidth <= tabs.clientWidth) return;
      const before = tabs.scrollLeft;
      tabs.scrollLeft += event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? tabs.clientWidth : 1);
      if (before !== tabs.scrollLeft) event.preventDefault();
    }, { passive: false });
    const resize = new ResizeObserver(overflow);
    resize.observe(tabs);
    // No global listeners or timers: the owning run disposes this observer
    // when its archived DOM is discarded by a history refresh.
    function select(card, focus = false) {
      if (!entries.has(card)) return;
      selected = card;
      for (const [panel, item] of entries) {
        const active = panel === card;
        panel.hidden = !active;
        item.tab.setAttribute('aria-selected', String(active));
        item.tab.tabIndex = active ? 0 : -1;
      }
      const tab = entries.get(card).tab;
      const box = tab.getBoundingClientRect(), rail = tabs.getBoundingClientRect();
      // Scroll only the rail, never the surrounding conversation.
      if (box.left < rail.left) tabs.scrollLeft -= rail.left - box.left;
      else if (box.right > rail.right) tabs.scrollLeft += box.right - rail.right;
      if (focus) tab.focus({ preventScroll: true });
      modelInfo.hidden = false;
      syncModelInfo();
      overflow();
    }
    function syncModelInfo() {
      const entry = selected && entries.get(selected);
      if (!entry) return;
      const state = entry.head.querySelector('.member-state')?.textContent || entry.action || 'Queued';
      const meta = entry.head.querySelector('.member-meta')?.textContent || '';
      const control = entry.head.querySelector('.member-control');
      setText(modelInfo.querySelector('.team-model-summary-copy strong'), entry.name);
      setText(modelInfo.querySelector('.team-model-summary-model'), entry.model || (entry.worker ? 'Spawned worker' : 'Team member'));
      setText(modelInfo.querySelector('.team-model-summary-state'), state);
      setText(modelInfo.querySelector('.team-model-expanded-identity strong'), entry.name);
      setText(modelInfo.querySelector('.team-model-expanded-model'), entry.model || (entry.worker ? 'Spawned worker' : 'Team member'));
      setText(modelInfo.querySelector('.team-model-expanded-state'), state);
      setText(modelInfo.querySelector('.team-model-expanded-meta'), meta);
      modelControl.hidden = !control;
      if (control) {
        modelControl.textContent = control.textContent;
        modelControl.title = control.title;
        modelControl.disabled = control.disabled;
      }
      modelInfo.dataset.status = entry.status;
    }
    modelControl.onclick = () => entries.get(selected)?.head.querySelector('.member-control')?.click();
    tabs.addEventListener('keydown', event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      const cards = [...entries.keys()];
      const current = cards.indexOf(selected);
      const index = event.key === 'Home' ? 0 : event.key === 'End' ? cards.length - 1
        : (current + (event.key === 'ArrowRight' ? 1 : -1) + cards.length) % cards.length;
      if (cards[index]) { event.preventDefault(); select(cards[index], true); }
    });
    function tally() {
      const counts = {};
      for (const entry of entries.values()) counts[entry.status] = (counts[entry.status] || 0) + 1;
      const bits = [`${entries.size} agent${entries.size === 1 ? '' : 's'}`];
      if (counts.working) bits.push(`${counts.working} working`);
      if (counts.silent) bits.push(`${counts.silent} awaiting update`);
      if (counts.waiting) bits.push(`${counts.waiting} ${counts.waiting === 1 ? 'needs' : 'need'} attention`);
      if (counts.error) bits.push(`${counts.error} failed`);
      if (counts.stalled) bits.push(`${counts.stalled} stalled`);
      if (counts.paused) bits.push(`${counts.paused} paused`);
      if (counts.completed) bits.push(`${counts.completed} complete`);
      setText(count, bits.join(' · '));
    }
    function noteNurse(event = {}) {
      const action = String(event.nurseType || event.action || 'monitoring');
      const name = String(event.name || '').trim();
      let last = 'Nurse · monitoring';
      if (action === 'handoff') {
        nurseStats.handoffs += Math.max(1, Number(event.count) || 1);
        last = 'Nurse · context handed off';
      } else if (action === 'wake-staged' || action === 'wake') {
        nurseStats.wakes++;
        last = `Nurse · wake queued${name ? ` for ${name}` : ''}`;
      } else if (action === 'wake-started') {
        nurseStats.wakeStarted++;
        last = `Nurse · waking${name ? ` ${name}` : ' member'}`;
      } else if (action === 'wake-succeeded') {
        nurseStats.wakeSucceeded++;
        last = `Nurse · recovery succeeded${name ? ` for ${name}` : ''}`;
      } else if (action === 'wake-failed') {
        nurseStats.wakeFailed++;
        last = `Nurse · recovery ended${name ? ` for ${name}` : ''}`;
      } else if (action === 'skip' || action === 'retry-suppressed' || action === 'quarantine') {
        nurseStats.skips++;
        last = action === 'quarantine'
          ? `Nurse · unsafe retry avoided${name ? ` for ${name}` : ''}`
          : 'Nurse · retry avoided';
      } else if (action === 'quiet' || action === 'no-useful-work') {
        nurseStats.quiet++;
        last = event.reason === 'complete' ? 'Nurse · team complete'
          : event.reason === 'budget' ? 'Nurse · budget protected'
          : 'Nurse · no useful work';
      }
      const bits = [];
      if (nurseStats.handoffs) bits.push(`${nurseStats.handoffs} handoff${nurseStats.handoffs === 1 ? '' : 's'}`);
      if (nurseStats.wakes) bits.push(`${nurseStats.wakes} wake${nurseStats.wakes === 1 ? '' : 's'} queued`);
      if (nurseStats.wakeStarted) bits.push(`${nurseStats.wakeStarted} started`);
      if (nurseStats.wakeSucceeded) bits.push(`${nurseStats.wakeSucceeded} succeeded`);
      if (nurseStats.wakeFailed) bits.push(`${nurseStats.wakeFailed} ended without completion`);
      if (nurseStats.skips) bits.push(`${nurseStats.skips} ${nurseStats.skips === 1 ? 'retry' : 'retries'} avoided`);
      if (nurseStats.quiet) bits.push(`${nurseStats.quiet} quiet decision${nurseStats.quiet === 1 ? '' : 's'}`);
      const description = `Team Nurse: ${bits.length ? bits.join(', ') : 'monitoring'}. Last: ${last.replace(/^Nurse · /, '')}.`;
      setText(nurseBadge, last);
      nurseBadge.hidden = false;
      nurseBadge.title = description;
      nurseBadge.setAttribute('aria-label', description);
      nurseBadge.dataset.action = action;
      for (const [key, value] of Object.entries(nurseStats)) nurseBadge.dataset[key] = String(value);
    }
    function identify(card, name, model) {
      const entry = entries.get(card);
      if (!entry) return;
      if (name) entry.name = name;
      if (model) entry.model = model;
      setText(entry.nameNode, entry.name);
      setText(entry.modelNode, entry.model || (entry.worker ? 'Spawned worker' : 'Team member'));
      setText(entry.initial, entry.name.slice(0, 1).toUpperCase());
      setText(entry.head.querySelector('.member-name'), entry.name);
      setText(entry.head.querySelector('.member-model'), entry.model);
      entry.modelNode.title = entry.model;
      if (selected === card) syncModelInfo();
      label(entry);
    }
    function label(entry) {
      const description = [entry.name, entry.worker ? 'spawned worker' : '', entry.model, entry.action, entry.stepNode.textContent].filter(Boolean).join(' · ');
      entry.tab.setAttribute('aria-label', description);
      entry.tab.title = description;
    }
    function add(card, { name, model, worker = false }) {
      const n = entries.size;
      const tab = document.createElement('button');
      tab.type = 'button'; tab.className = 'team-tab'; tab.id = `${id}-tab-${n}`;
      tab.setAttribute('role', 'tab'); tab.setAttribute('aria-controls', `${id}-panel-${n}`);
      tab.innerHTML = '<span class="team-orbit"><span class="team-initial"></span></span><span class="team-tab-copy"><span class="team-tab-name"></span><span class="team-tab-model"></span><span class="team-tab-detail"><span class="team-tab-action"></span><span class="team-tab-step"></span></span></span>';
      const orbit = tab.querySelector('.team-orbit');
      orbit.prepend(icon('clock', 'team-orbit-icon'));
      card.id = `${id}-panel-${n}`;
      card.setAttribute('role', 'tabpanel'); card.setAttribute('aria-labelledby', tab.id); card.tabIndex = 0;
      const entry = { tab, name: name || 'Agent', model: model || '', worker, status: 'queued', action: 'Queued', head: card.querySelector('.member-head'),
        nameNode: tab.querySelector('.team-tab-name'), modelNode: tab.querySelector('.team-tab-model'),
        actionNode: tab.querySelector('.team-tab-action'), stepNode: tab.querySelector('.team-tab-step'),
        initial: tab.querySelector('.team-initial'), ring: orbit.querySelector('.team-icon') };
      entries.set(card, entry);
      entry.observer = new MutationObserver(() => { if (selected === card) syncModelInfo(); });
      entry.observer.observe(entry.head, { subtree: true, childList: true, characterData: true, attributes: true });
      tab.dataset.worker = String(worker);
      tabs.appendChild(tab); panels.appendChild(card);
      card._teamDeck = api;
      tab.onclick = () => select(card);
      identify(card, name, model);
      update(card);
      if (!selected) select(card); else card.hidden = true;
      tab.setAttribute('aria-selected', String(selected === card)); tab.tabIndex = selected === card ? 0 : -1;
      overflow();
    }
    function update(card, state, now = Date.now()) {
      const entry = entries.get(card);
      if (!entry) return;
      card._teamActivity = state;
      entry.state = state;
      const summary = window.ReachActivityState.summary(state, now);
      const status = !state ? 'queued' : state.status === 'completed' ? 'completed'
        : state.status === 'error' ? 'error' : state.status === 'stalled' ? 'stalled' : ['paused', 'stopped'].includes(state.status) ? 'paused'
        : ['waiting_edits', 'waiting_input'].includes(state.status) || summary.waiting ? 'waiting'
        : summary.silent ? 'silent' : summary.active ? 'working' : 'queued';
      entry.status = status;
      entry.action = state?.status === 'waiting_edits' ? 'Review needed' : state?.status === 'waiting_input' ? 'Answer needed'
        : status === 'completed' ? 'Complete' : summary.title || 'Queued';
      setText(entry.actionNode, entry.action);
      setText(entry.stepNode, state?.count ? `Step ${state.count}` : '');
      entry.tab.dataset.status = card.dataset.teamStatus = status;
      entry.ring.dataset.icon = icons[status];
      entry.initial.hidden = status !== 'working';
      const metadata = entry.head.querySelector('.member-meta');
      if (metadata) setText(metadata, [state?.round ? `Round ${state.round}` : '', summary.elapsed || '', card.dataset.crewMeta || ''].filter(Boolean).join(' · '));
      // A small, event-driven signal, not a fabricated continuous waveform.
      if (entry.updatedAt !== state?.updatedAt) {
        entry.updatedAt = state?.updatedAt;
        entry.actionNode.getAnimations().forEach(animation => animation.cancel());
        if (status === 'working' && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
          entry.actionNode.animate([{ opacity: .55 }, { opacity: 1 }], { duration: 320 });
        }
      }
      label(entry); tally();
      if (selected === card) syncModelInfo();
    }
    function finish(status) {
      ended = true;
      element.dataset.finished = status;
      for (const [card, entry] of entries) {
        const button = entry.head.querySelector('.member-control');
        if (button) button.disabled = true;
        card.dataset.finished = 'true';
        // Do not imply skipped/pending members completed on a failed run.
        if (!['completed', 'error', 'stalled'].includes(entry.status)) update(card, { startedAt: Date.now(), steps: [], count: 0, ...entry.state,
          status: status === 'error' ? 'error' : 'stopped', endedAt: Date.now() });
      }
    }
    const api = { element, banner, reviews, add, identify, update, select, finish, noteNurse,
      dispose: () => { resize.disconnect(); for (const entry of entries.values()) entry.observer?.disconnect(); }, get ended() { return ended; } };
    return api;
  }
  window.ReachTeamDeck = { create };
})();
