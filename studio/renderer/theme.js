/* Paint the saved theme before the first layout, then bind the status-bar controls. */
(() => {
  const catalog = window.ReachThemes;
  const root = document.documentElement;
  let state = catalog.normalize(window.reach && window.reach.initialTheme);
  let painting = false;

  function hsvToHex(h, s, v) {
    const c = v * s;
    const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
    const m = v - c;
    let r = 0, g = 0, b = 0;
    if (h < 60) { r = c; g = x; }
    else if (h < 120) { r = x; g = c; }
    else if (h < 180) { g = c; b = x; }
    else if (h < 240) { g = x; b = c; }
    else if (h < 300) { r = x; b = c; }
    else { r = c; b = x; }
    return catalog.rgbToHex((r + m) * 255, (g + m) * 255, (b + m) * 255);
  }

  function hexToHsv(hex) {
    const rgb = catalog.hexToRgb(hex) || [182, 240, 74];
    let [r, g, b] = rgb.map(v => v / 255);
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const d = max - min;
    let h = 0;
    if (d) {
      if (max === r) h = ((g - b) / d) % 6;
      else if (max === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h *= 60;
      if (h < 0) h += 360;
    }
    return { h, s: max === 0 ? 0 : d / max, v: max };
  }

  function paintNow(next) {
    const painted = catalog.paint(next);
    painting = true;
    state = { theme: painted.theme, accent: painted.accent, tint: painted.tint };
    root.dataset.theme = painted.theme;
    root.dataset.scheme = painted.scheme;
    root.style.colorScheme = painted.scheme;
    for (const [key, value] of Object.entries(painted.vars)) root.style.setProperty('--' + key, value);
    painting = false;
    document.dispatchEvent(new Event('reach-theme-change'));
    return painted;
  }

  paintNow(state);

  document.addEventListener('DOMContentLoaded', () => {
    const select = document.querySelector('#theme-select');
    const button = document.querySelector('#theme-accent');
    const pop = document.querySelector('#theme-accent-pop');
    const square = document.querySelector('#theme-sv');
    const marker = square && square.querySelector('i');
    const hue = document.querySelector('#theme-hue');
    const tint = document.querySelector('#theme-tint');
    const tintValue = document.querySelector('#theme-tint-value');
    if (!select || !button || !pop || !square || !hue || !tint) return;

    for (const item of catalog.themes) {
      const option = document.createElement('option');
      option.value = item.id;
      option.textContent = item.name;
      select.appendChild(option);
    }

    let hsv = hexToHsv(catalog.paint(state).vars.gold);
    let saveTimer = 0;

    function currentAccent() {
      return state.accent || catalog.findTheme(state.theme).vars.gold;
    }

    function syncControls() {
      select.value = state.theme;
      tint.value = String(state.tint);
      if (tintValue) tintValue.textContent = String(state.tint);
      hue.value = String(Math.round(hsv.h));
      square.style.backgroundColor = `hsl(${hsv.h} 100% 50%)`;
      if (marker) {
        marker.style.left = (hsv.s * 100) + '%';
        marker.style.top = ((1 - hsv.v) * 100) + '%';
      }
    }

    function persist(immediate) {
      clearTimeout(saveTimer);
      const send = () => window.reach.setTheme({ theme: state.theme, accent: state.accent, tint: state.tint }).catch(error => {
        window.ReachDialogs?.notice('Could not save theme: ' + error.message);
      });
      if (immediate) return send();
      saveTimer = setTimeout(send, 80);
      return Promise.resolve();
    }

    function applyChoice(next, { save = true, immediate = false } = {}) {
      const painted = paintNow(next);
      hsv = hexToHsv(painted.vars.gold);
      syncControls();
      return save ? persist(immediate) : painted;
    }

    select.onchange = () => applyChoice({ theme: select.value, accent: '', tint: state.tint }, { immediate: true });

    function setOpen(open) {
      pop.hidden = !open;
      button.setAttribute('aria-expanded', String(open));
      if (open) hsv = hexToHsv(currentAccent());
      syncControls();
    }

    button.onclick = () => setOpen(pop.hidden);

    function pickSquare(event) {
      const rect = square.getBoundingClientRect();
      hsv.s = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
      hsv.v = Math.min(1, Math.max(0, 1 - (event.clientY - rect.top) / rect.height));
      applyChoice({ theme: state.theme, accent: hsvToHex(hsv.h, hsv.s, hsv.v), tint: state.tint });
    }

    square.addEventListener('pointerdown', event => {
      square.setPointerCapture(event.pointerId);
      pickSquare(event);
    });
    square.addEventListener('pointermove', event => {
      if (square.hasPointerCapture(event.pointerId)) pickSquare(event);
    });

    hue.addEventListener('input', () => {
      hsv.h = Number(hue.value);
      applyChoice({ theme: state.theme, accent: hsvToHex(hsv.h, hsv.s, hsv.v), tint: state.tint });
    });
    tint.addEventListener('input', () => {
      applyChoice({ theme: state.theme, accent: state.accent || currentAccent(), tint: Number(tint.value) });
    });

    document.addEventListener('pointerdown', event => {
      if (pop.hidden) return;
      if (event.target === button || button.contains(event.target) || pop.contains(event.target)) return;
      setOpen(false);
    });
    document.addEventListener('keydown', event => {
      if (event.key === 'Escape' && !pop.hidden) { setOpen(false); button.focus(); }
    });

    new MutationObserver(() => {
      if (painting) return;
      const id = root.dataset.theme;
      if (!id || id === state.theme) return;
      applyChoice({ theme: id, accent: '', tint: state.tint }, { save: false });
    }).observe(root, { attributes: true, attributeFilter: ['data-theme'] });

    syncControls();
  });
})();
