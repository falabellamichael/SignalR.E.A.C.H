/* Keep every spider leg attached to its tile, including while it moves. */
(() => {
  const board = document.querySelector('.welcome-content');
  if (!board) return;
  const themeButton = document.querySelector('.welcome-theme');
  function updateThemeButton() {
    const label = document.documentElement.dataset.theme === 'light' ? 'Switch to dark theme' : 'Switch to light theme';
    themeButton.setAttribute('aria-label', label);
    themeButton.title = label;
    themeButton.hidden = false;
  }
  themeButton.addEventListener('click', () => {
    const root = document.documentElement;
    root.dataset.theme = root.dataset.theme === 'light' ? 'dark' : 'light';
    try { localStorage.setItem('signalreach-theme', root.dataset.theme); } catch (_) { /* Session-only preference. */ }
    updateThemeButton();
  });
  updateThemeButton();
  const svg = board.querySelector('.welcome-connections');
  const center = board.querySelector('.orbit-center');
  const tiles = [...board.querySelectorAll('.welcome-actions a')];
  const toggle = document.querySelector('.welcome-motion');
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  let frame = 0, last = 0;
  const legs = tiles.map((tile, index) => {
    const paths = ['welcome-leg', 'welcome-leg-pulse'].map(className => {
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('class', className);
      svg.append(path);
      return path;
    });
    const leg = {tile, paths, index, hovered: false, focused: false};
    function highlight() {
      paths.forEach(path => path.classList.toggle('is-active', leg.hovered || leg.focused));
    }
    tile.addEventListener('pointerenter', () => { leg.hovered = true; highlight(); });
    tile.addEventListener('pointerleave', () => { leg.hovered = false; highlight(); });
    tile.addEventListener('focus', () => { leg.focused = true; highlight(); });
    tile.addEventListener('blur', () => { leg.focused = false; highlight(); });
    return leg;
  });
  function moving() { return !reduced.matches && document.documentElement.dataset.motion !== 'off'; }
  function draw(time = 0) {
    frame = 0;
    if (document.hidden) return;
    const animate = moving();
    if (!animate || time - last >= 32) {
      last = time;
      for (const leg of legs) {
        // Hold a targeted tile still so it is easy to click or keyboard-focus.
        if (!animate) leg.tile.style.transform = '';
        else if (!leg.hovered && !leg.focused) {
          const phase = time / 1900 + leg.index * .83;
          leg.tile.style.transform = `translate(${Math.sin(phase) * 3}px, ${Math.cos(phase * .8) * 4}px)`;
        }
      }
      const bounds = board.getBoundingClientRect();
      const hub = center.getBoundingClientRect();
      const cx = hub.left + hub.width / 2 - bounds.left;
      const cy = hub.top + hub.height / 2 - bounds.top;
      svg.setAttribute('viewBox', `0 0 ${bounds.width} ${bounds.height}`);
      for (const {tile, paths, index} of legs) {
        const rect = tile.getBoundingClientRect();
        const left = index % 2 === 0;
        const x = (left ? rect.right : rect.left) - bounds.left;
        const y = rect.top + rect.height / 2 - bounds.top;
        const bend = cx + (left ? -1 : 1) * Math.max(28, Math.abs(x - cx) * .52);
        const path = `M ${cx} ${cy} C ${bend} ${cy}, ${bend} ${y}, ${x} ${y}`;
        paths.forEach(node => node.setAttribute('d', path));
      }
    }
    if (animate) frame = requestAnimationFrame(draw);
  }
  function refresh() {
    cancelAnimationFrame(frame);
    last = -Infinity;
    toggle.hidden = false;
    toggle.textContent = moving() ? 'Pause motion' : reduced.matches ? 'Reduced motion' : 'Resume motion';
    toggle.disabled = reduced.matches;
    toggle.setAttribute('aria-pressed', String(!moving()));
    frame = requestAnimationFrame(draw);
  }
  toggle.addEventListener('click', () => {
    const value = moving() ? 'off' : 'on';
    document.documentElement.dataset.motion = value;
    try { localStorage.setItem('signalreach-motion', value); } catch (_) { /* Session-only preference. */ }
    refresh();
  });
  new ResizeObserver(refresh).observe(board);
  reduced.addEventListener('change', refresh);
  document.addEventListener('visibilitychange', refresh);
  refresh();
})();
