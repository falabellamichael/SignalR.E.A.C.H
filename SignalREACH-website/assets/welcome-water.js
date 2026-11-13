/* Play the reversed-droplet water loop only while welcome-page motion is on. */
(() => {
  const video = document.querySelector('.welcome-water');
  if (!video) return;
  // Optional alternate background: ?bg=circuits swaps in the PCB render while
  // keeping the same intro/fade-out plumbing.
  if (new URLSearchParams(location.search).get('bg') === 'circuits') {
    video.poster = 'assets/welcome-circuits.jpg';
    for (const source of video.querySelectorAll('source')) {
      const type = source.type === 'video/mp4' ? 'mp4' : 'webm';
      source.src = `assets/welcome-circuits.${type}`;
    }
    video.classList.add('welcome-circuits');
    video.load();
  }
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const root = document.documentElement;
  let finished = false;
  function sync() {
    if (finished || document.hidden || reduced.matches || root.dataset.motion === 'off') video.pause();
    else video.play().catch(() => { /* Poster and gradient remain if autoplay is refused. */ });
  }
  // The water is an intro; once it has faded out, the page background takes
  // over and the loop has nothing left to show.
  const background = document.querySelector('.welcome-background');
  if (background) background.addEventListener('animationend', event => {
    if (event.animationName !== 'welcome-water-back') return;
    finished = true;
    video.hidden = true;
    video.pause();
  });
  new MutationObserver(sync).observe(root, {attributes: true, attributeFilter: ['data-motion']});
  reduced.addEventListener('change', sync);
  document.addEventListener('visibilitychange', sync);
  // Source errors do not bubble; listen in the capture phase so a bad or
  // unsupported file falls back to the CSS water gradient.
  video.addEventListener('error', () => { video.hidden = true; }, true);
  sync();
})();
