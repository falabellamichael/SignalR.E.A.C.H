/* Apply saved preferences before paint. No network requests or analytics. */
(() => {
  const root = document.documentElement;
  try {
    const saved = localStorage.getItem('signalreach-theme');
    root.dataset.theme = saved === 'light' || saved === 'dark' ? saved : (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
    const motion = localStorage.getItem('signalreach-motion');
    root.dataset.motion = motion === 'off' || matchMedia('(prefers-reduced-motion: reduce)').matches ? 'off' : 'on';
  } catch (_) {
    root.dataset.theme = matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
    root.dataset.motion = matchMedia('(prefers-reduced-motion: reduce)').matches ? 'off' : 'on';
  }
})();
