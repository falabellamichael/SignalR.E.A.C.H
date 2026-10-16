// ---------- file drawer (right side, toggleable, follows context) ----------
const drawer = $('#file-drawer');
const drawerContext = $('#drawer-context');
let drawerOpen = true;

// Files, Projects, and the conversation sidebar share one selected project.
function drawerDir() {
  return currentProject?.dir || null;
}
function drawerAgentId() {
  return ($('#page-agents').classList.contains('active') && currentAgent) ? currentAgent.id : null;
}

function setDrawer(open) {
  drawerOpen = !!open;
  drawer.classList.toggle('closed', !drawerOpen);
  $('#btn-toggle-files').classList.toggle('active', drawerOpen);
  applyWidthGuard();
  if (drawerOpen) refreshFileTree();
}
// The Files/Browser dropdown is wired by browser.js; Close still hides the drawer.
$('#btn-close-drawer').onclick = () => setDrawer(false);

// Keep the page usable even with a wide saved drawer or an expanded rail.
// Use the requested width (not the overlay's clamped box) so the two modes
// cannot oscillate. Resizing never changes the user's open/closed choice.
function applyWidthGuard() {
  const body = drawer.parentElement;
  const railWidth = $('#nav-rail')?.getBoundingClientRect().width || 0;
  body.style.setProperty('--rail-width', railWidth + 'px');
  const available = body.getBoundingClientRect().width - railWidth;
  const requested = parseFloat(drawer.style.width) || 420;
  const panelWidth = Math.min(requested, Math.max(260, available - 24));
  const pageMinimum = parseFloat(getComputedStyle(drawer).getPropertyValue('--drawer-page-min')) || 760;
  // Once the drawer overlaps, keep the page at the width it reached while
  // docking. Releasing the entire row would recenter it beneath the drawer.
  body.style.setProperty('--drawer-page-width', Math.max(0, Math.min(available, pageMinimum)) + 'px');
  drawer.classList.toggle('overlay', available - panelWidth < pageMinimum);
}
window.addEventListener('resize', applyWidthGuard);
const drawerLayoutObserver = new ResizeObserver(() => requestAnimationFrame(applyWidthGuard));
drawerLayoutObserver.observe(drawer.parentElement);
drawerLayoutObserver.observe($('#nav-rail'));
drawerLayoutObserver.observe(drawer);
applyWidthGuard();

// ---------- Drawer size adjustment (horizontal + vertical split) ----------
function initDrawerResizers() {
  const resizerX = $('#drawer-resizer-x');
  const resizerY = $('#drawer-resizer-y');
  const fileTree = $('#file-tree');
  if (!resizerX || !resizerY || !drawer) return;

  const savedWidth = localStorage.getItem('reach:drawer-width');
  if (savedWidth) {
    const w = parseInt(savedWidth, 10);
    if (Number.isFinite(w) && w >= 260) {
      drawer.style.width = w + 'px';
    }
  }
  applyWidthGuard();

  const savedTreeHeight = localStorage.getItem('reach:drawer-tree-height');
  if (savedTreeHeight && fileTree) {
    const h = parseInt(savedTreeHeight, 10);
    if (!isNaN(h) && h >= 50 && h <= 800) {
      fileTree.style.height = h + 'px';
    }
  }
  applyDrawerLayout(localStorage.getItem('reach:drawer-layout') === 'side' ? 'side' : 'top', false);

  // --- Horizontal Resize (drawer width) ---
  let isDraggingX = false;
  let startX = 0;
  let startWidth = 0;

  const onPointerMoveX = (e) => {
    if (!isDraggingX) return;
    const delta = startX - e.clientX;
    const minW = 260;
    const railWidth = $('#nav-rail').getBoundingClientRect().width;
    const maxW = Math.max(minW, drawer.parentElement.clientWidth - railWidth - 24);
    const newW = Math.min(maxW, Math.max(minW, Math.round(startWidth + delta)));
    drawer.style.width = newW + 'px';
    applyWidthGuard();
  };

  const onPointerUpX = (e) => {
    if (!isDraggingX) return;
    isDraggingX = false;
    document.body.classList.remove('resizing-x');
    resizerX.classList.remove('active');
    window.removeEventListener('pointermove', onPointerMoveX);
    window.removeEventListener('pointerup', onPointerUpX);
    window.removeEventListener('pointercancel', onPointerUpX);
    try { resizerX.releasePointerCapture(e.pointerId); } catch (_) {}
    const finalWidth = Math.round(drawer.getBoundingClientRect().width);
    localStorage.setItem('reach:drawer-width', finalWidth);
  };

  resizerX.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    isDraggingX = true;
    startX = e.clientX;
    startWidth = drawer.getBoundingClientRect().width;
    document.body.classList.add('resizing-x');
    resizerX.classList.add('active');
    try { resizerX.setPointerCapture(e.pointerId); } catch (_) {}
    window.addEventListener('pointermove', onPointerMoveX);
    window.addEventListener('pointerup', onPointerUpX);
    window.addEventListener('pointercancel', onPointerUpX);
  });

  resizerX.addEventListener('dblclick', () => {
    drawer.style.width = '420px';
    localStorage.removeItem('reach:drawer-width');
    applyWidthGuard();
  });

  // --- Vertical Resize (split between file tree and editor) ---
  let isDraggingY = false;
  let startY = 0;
  let startTreeH = 0;

  let dragAxis = 'y';

  const onPointerMoveY = (e) => {
    if (!isDraggingY) return;
    if (dragAxis === 'x') {
      const delta = e.clientX - startY;
      const drawerW = drawer.getBoundingClientRect().width;
      const minW = 120;
      const maxW = Math.max(minW, drawerW - 180);
      const newW = Math.min(maxW, Math.max(minW, Math.round(startTreeH + delta)));
      drawer.style.setProperty('--drawer-tree-width', newW + 'px');
      return;
    }
    const delta = e.clientY - startY;
    const drawerH = drawer.getBoundingClientRect().height;
    const minH = 50;
    const maxH = Math.max(minH, drawerH - 220);
    const newH = Math.min(maxH, Math.max(minH, Math.round(startTreeH + delta)));
    fileTree.style.height = newH + 'px';
  };

  const onPointerUpY = (e) => {
    if (!isDraggingY) return;
    isDraggingY = false;
    document.body.classList.remove('resizing-y', 'resizing-split');
    resizerY.classList.remove('active');
    window.removeEventListener('pointermove', onPointerMoveY);
    window.removeEventListener('pointerup', onPointerUpY);
    window.removeEventListener('pointercancel', onPointerUpY);
    try { resizerY.releasePointerCapture(e.pointerId); } catch (_) {}
    if (dragAxis === 'x') {
      localStorage.setItem('reach:drawer-tree-width', Math.round(fileTree.getBoundingClientRect().width));
    } else {
      localStorage.setItem('reach:drawer-tree-height', Math.round(fileTree.getBoundingClientRect().height));
    }
  };

  resizerY.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    isDraggingY = true;
    dragAxis = drawer.dataset.layout === 'side' ? 'x' : 'y';
    startY = dragAxis === 'x' ? e.clientX : e.clientY;
    startTreeH = dragAxis === 'x' ? fileTree.getBoundingClientRect().width : fileTree.getBoundingClientRect().height;
    document.body.classList.add(dragAxis === 'x' ? 'resizing-split' : 'resizing-y');
    resizerY.classList.add('active');
    try { resizerY.setPointerCapture(e.pointerId); } catch (_) {}
    window.addEventListener('pointermove', onPointerMoveY);
    window.addEventListener('pointerup', onPointerUpY);
    window.addEventListener('pointercancel', onPointerUpY);
  });

  resizerY.addEventListener('dblclick', () => {
    if (drawer.dataset.layout === 'side') {
      drawer.style.removeProperty('--drawer-tree-width');
      localStorage.removeItem('reach:drawer-tree-width');
      return;
    }
    fileTree.style.height = '180px';
    localStorage.removeItem('reach:drawer-tree-height');
  });
}

function applyDrawerLayout(layout, persist = true) {
  const side = layout === 'side';
  const fileTree = $('#file-tree');
  const button = $('#btn-drawer-layout');
  drawer.dataset.layout = side ? 'side' : 'top';
  if (button) {
    button.setAttribute('aria-pressed', String(side));
    button.textContent = side ? 'Top' : 'Side';
    button.title = side ? 'Put the file tree above the editor' : 'Put the file tree beside the editor';
  }
  if (fileTree) {
    if (side) {
      fileTree.style.height = '';
      const savedW = parseInt(localStorage.getItem('reach:drawer-tree-width'), 10);
      if (Number.isFinite(savedW) && savedW >= 120) drawer.style.setProperty('--drawer-tree-width', savedW + 'px');
    } else {
      const savedH = parseInt(localStorage.getItem('reach:drawer-tree-height'), 10);
      fileTree.style.height = Number.isFinite(savedH) && savedH >= 50 && savedH <= 800 ? savedH + 'px' : '';
    }
  }
  if (persist) localStorage.setItem('reach:drawer-layout', side ? 'side' : 'top');
}
$('#btn-drawer-layout').onclick = () => applyDrawerLayout(drawer.dataset.layout === 'side' ? 'top' : 'side');
initDrawerResizers();

