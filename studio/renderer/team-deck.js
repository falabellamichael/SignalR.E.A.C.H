/* Deployed teams: a persistent tab per worker, one full-width detail surface.
 * The deck consumes the existing activity model, never invents progress, and
 * leaves each member DOM intact so transcripts, reviews and inputs survive. */
(() => {
  let serial = 0;
  const icons = { queued: 'clock', working: 'circle-notch', waiting: 'pause-circle',
    silent: 'clock', paused: 'pause-circle', completed: 'check-circle', error: 'warning-circle' };
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
    let selected = null, ended = false;
    const element = document.createElement('section');
    element.className = 'team-run team-deck';
    element.setAttribute('aria-label', `${team.name} deployed team`);
    element.innerHTML = '<div class="team-deck-nav"><div class="team-deck-heading"><strong></strong><span class="team-deck-mode"></span><span class="team-deck-count"></span></div><div class="team-tab-strip"><button class="team-tab-scroll" type="button" aria-label="Scroll team tabs left"></button><div class="team-tabs" role="tablist" aria-label="Deployed team members" aria-orientation="horizontal"></div><button class="team-tab-scroll" type="button" aria-label="Scroll team tabs right"></button></div></div><div class="team-panels"></div><div class="team-reviews"></div>';
    const banner = element.querySelector('.team-deck-heading');
    setText(banner.querySelector('strong'), team.name || 'Team');
    setText(banner.querySelector('.team-deck-mode'), team.mode || 'parallel');
    banner.title = task;
    const count = element.querySelector('.team-deck-count');
    const tabs = element.querySelector('.team-tabs');
    const panels = element.querySelector('.team-panels');
    const reviews = element.querySelector('.team-reviews');
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
      overflow();
    }
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
      if (counts.paused) bits.push(`${counts.paused} paused`);
      if (counts.completed) bits.push(`${counts.completed} complete`);
      setText(count, bits.join(' · '));
    }
    function identify(card, name, model) {
      const entry = entries.get(card);
      if (!entry) return;
      if (name) entry.name = name;
      if (model) entry.model = model;
      setText(entry.nameNode, entry.name);
      setText(entry.modelNode, entry.model || (entry.worker ? 'Spawned worker' : 'Team member'));
      setText(entry.initial, entry.name.slice(0, 1).toUpperCase());
      setText(card.querySelector('.member-name'), entry.name);
      setText(card.querySelector('.member-model'), entry.model);
      entry.modelNode.title = entry.model;
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
      const entry = { tab, name: name || 'Agent', model: model || '', worker, status: 'queued', action: 'Queued',
        nameNode: tab.querySelector('.team-tab-name'), modelNode: tab.querySelector('.team-tab-model'),
        actionNode: tab.querySelector('.team-tab-action'), stepNode: tab.querySelector('.team-tab-step'),
        initial: tab.querySelector('.team-initial'), ring: orbit.querySelector('.team-icon') };
      entries.set(card, entry);
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
      entry.state = state;
      const summary = window.ReachActivityState.summary(state, now);
      const status = !state ? 'queued' : state.status === 'completed' ? 'completed'
        : state.status === 'error' ? 'error' : ['paused', 'stopped'].includes(state.status) ? 'paused'
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
      const metadata = card.querySelector('.member-meta');
      if (metadata) setText(metadata, [state?.round ? `Round ${state.round}` : '', summary.elapsed || ''].filter(Boolean).join(' · '));
      // A small, event-driven signal, not a fabricated continuous waveform.
      if (entry.updatedAt !== state?.updatedAt) {
        entry.updatedAt = state?.updatedAt;
        entry.actionNode.getAnimations().forEach(animation => animation.cancel());
        if (status === 'working' && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
          entry.actionNode.animate([{ opacity: .55 }, { opacity: 1 }], { duration: 320 });
        }
      }
      label(entry); tally();
    }
    function finish(status) {
      ended = true;
      element.dataset.finished = status;
      for (const [card, entry] of entries) {
        const button = card.querySelector('.member-control');
        if (button) button.disabled = true;
        card.dataset.finished = 'true';
        // Do not imply skipped/pending members completed on a failed run.
        if (!['completed', 'error'].includes(entry.status)) update(card, { startedAt: Date.now(), steps: [], count: 0, ...entry.state,
          status: status === 'error' ? 'error' : 'stopped', endedAt: Date.now() });
      }
    }
    const api = { element, banner, reviews, add, identify, update, select, finish,
      dispose: () => resize.disconnect(), get ended() { return ended; } };
    return api;
  }
  window.ReachTeamDeck = { create };
})();
