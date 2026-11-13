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
  // Only introduce visitors arriving at the homepage. Shared links and account
  // flows keep their destination, and blocked storage never causes a loop.
  try {
    const seenKey = 'signalreach.welcome-seen.v1';
    const page = location.pathname.split('/').pop();
    if (page === 'welcome.html') localStorage.setItem(seenKey, '1');
    if (/^https?:$/.test(location.protocol) && (page === '' || page === 'index.html') &&
        !location.search && !location.hash && !localStorage.getItem(seenKey)) {
      localStorage.setItem(seenKey, '1');
      location.replace(new URL('welcome.html', location.href).href);
    }
  } catch (_) { /* The homepage remains available without browser storage. */ }
})();
