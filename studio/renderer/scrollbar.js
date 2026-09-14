// Keep native wheel, arrow and thumb-drag behavior; reveal only its painted parts.
(() => {
  const scroll = document.querySelector('#chat-scroll');
  if (!scroll) return;
  const revealDistance = 40;
  let pointer = null;
  let holding = false;
  const update = () => {
    if (holding && scroll.classList.contains('scrollbar-near')) return;
    const rect = scroll.getBoundingClientRect();
    const dx = pointer ? Math.max(rect.right - 12 - pointer.x, pointer.x - rect.right, 0) : Infinity;
    const dy = pointer ? Math.max(rect.top - pointer.y, pointer.y - rect.bottom, 0) : Infinity;
    scroll.classList.toggle('scrollbar-near', rect.height > 0 && scroll.scrollHeight > scroll.clientHeight && Math.hypot(dx, dy) <= revealDistance);
  };
  const track = event => {
    pointer = { x: event.clientX, y: event.clientY };
    holding = (event.buttons & 1) !== 0;
    update();
  };
  document.addEventListener('pointermove', track, { passive: true });
  document.addEventListener('pointerdown', track, { passive: true });
  document.addEventListener('pointerup', track, { passive: true });
  document.documentElement.addEventListener('pointerleave', event => {
    holding = (event.buttons & 1) !== 0;
    pointer = null;
    update();
  });
  window.addEventListener('blur', () => { holding = false; pointer = null; update(); });
  window.addEventListener('resize', update);
  const resize = new ResizeObserver(update);
  resize.observe(scroll);
  const log = document.querySelector('#chat-log');
  if (log) resize.observe(log);
})();
