/* Binary preview pane: images render inline, audio/video get a player, PDFs
 * render in an iframe, and anything else binary offers "Open externally".
 * Data URLs are decoded to blob: URLs — CSP allows blob:/data: for img/media
 * but a multi-MB base64 src can still refuse to decode, so blob is safer. */
function dataUrlToBlobUrl(dataUrl) {
  const comma = dataUrl.indexOf(',');
  const head = dataUrl.slice(0, comma);
  const mime = (head.match(/data:([^;]+)/) || [])[1] || 'application/octet-stream';
  const raw = atob(dataUrl.slice(comma + 1));
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return URL.createObjectURL(new Blob([bytes], { type: mime }));
}
function renderPreviewPane(relPath, res, dir) {
  const pane = document.createElement('div');
  pane.className = 'preview-pane';
  const bar = document.createElement('div');
  bar.className = 'preview-bar';
  const meta = document.createElement('span');
  meta.className = 'preview-meta dim';
  const kb = res.size >= 1024 ? (res.size / 1024).toFixed(1) + ' KB' : res.size + ' B';
  meta.textContent = `${res.kind.toUpperCase()} · ${res.mime || ''} · ${kb}`.trim();
  const openBtn = document.createElement('button');
  openBtn.className = 'ghost small';
  openBtn.textContent = 'Open externally';
  openBtn.onclick = async () => {
    const out = await reachApi.files.openExternal(drawerAgentId(), relPath, dir);
    if (!out.ok) { editorStatus.textContent = `Could not open ${relPath}: ${out.err}`; editorStatus.title = editorStatus.textContent; }
  };
  bar.append(meta, openBtn);
  pane.appendChild(bar);
  const body = document.createElement('div');
  body.className = 'preview-body';
  const src = dataUrlToBlobUrl(res.dataUrl);
  // Revoke when the pane is torn down (tab close destroys the host).
  new MutationObserver((mutations, observer) => {
    for (const m of mutations) {
      for (const n of m.removedNodes) {
        if (n === pane || (n.contains && n.contains(pane))) { URL.revokeObjectURL(src); observer.disconnect(); return; }
      }
    }
  }).observe(pane.parentNode || document.body, { childList: true, subtree: true });
  if (res.kind === 'image') {
    const img = document.createElement('img');
    img.className = 'preview-image';
    img.alt = relPath;
    img.src = src;
    img.onerror = () => {
      body.replaceChildren();
      const note = document.createElement('p');
      note.className = 'dim';
      note.textContent = 'Image could not be decoded. Use Open externally.';
      body.appendChild(note);
    };
    body.appendChild(img);
  } else if (res.kind === 'audio' || res.kind === 'video') {
    const media = document.createElement(res.kind === 'audio' ? 'audio' : 'video');
    media.className = 'preview-media';
    media.controls = true;
    media.src = src;
    if (res.kind === 'video') media.style.maxHeight = '100%';
    body.appendChild(media);
  } else if (res.kind === 'pdf') {
    const frame = document.createElement('iframe');
    frame.className = 'preview-pdf';
    frame.title = relPath;
    frame.src = src;
    body.appendChild(frame);
  } else {
    const note = document.createElement('p');
    note.className = 'dim';
    note.textContent = 'Preview is not available for this file type. Use Open externally.';
    body.appendChild(note);
  }
  pane.appendChild(body);
  return pane;
}

function makeEditorTab(relPath) {
  const tab = document.createElement('div');
  tab.className = 'editor-tab';
  tab.innerHTML = `<span class="tab-name">${escapeHtml(relPath.split('/').pop())}</span><button class="tab-close" title="Close">×</button>`;
  tab.onclick = (e) => { if (!e.target.classList.contains('tab-close')) activateFile(relPath); };
  tab.querySelector('.tab-close').onclick = () => closeFile(relPath);
  editorTabsEl.appendChild(tab);
  const host = document.createElement('div');
  host.className = 'editor-instance hidden';
  editorHost.appendChild(host);
  return { tab, host };
}

function openPreviewTab(relPath, res, dir) {
  const { tab, host } = makeEditorTab(relPath);
  const entry = { el: tab, host, dir, savedText: '', dirty: false, preview: true,
    previewRes: { kind: res.kind, mime: res.mime, dataUrl: res.dataUrl, size: res.size },
    editor: { destroy() {}, getText: () => '' } };
  host.appendChild(renderPreviewPane(relPath, res, dir));
  openFiles.set(relPath, entry);
  activateFile(relPath);
}

function openEditorTab(relPath, content, dir, { savedText, text } = {}) {
  const { tab, host } = makeEditorTab(relPath);
  const entry = {
    el: tab,
    host,
    dir,
    savedText: savedText !== undefined ? savedText : content,
    dirty: false,
    editor: null,
  };
  entry.editor = window.ReachEditor.create(host, {
    doc: text !== undefined ? text : content,
    filename: relPath,
    onChange: (changed) => {
      entry.dirty = changed !== entry.savedText;
      tab.classList.toggle('dirty', entry.dirty);
      $('#btn-save-file').classList.toggle('hidden', !entry.dirty);
      editorStatus.textContent = entry.dirty ? 'modified' : relPath;
    },
    onLive: (active) => {
      if (activeFile === relPath) syncLiveTools();
      if (active === false) forgetLiveContext(relPath);
    },
  });
  openFiles.set(relPath, entry);
  activateFile(relPath);
}

async function openFile(relPath) {
  const dir = drawerDir();
  const generation = fileTreeGeneration;
  if (!dir) return;
  if (openFiles.has(relPath)) {
    if (openFiles.get(relPath).dir === dir) { activateFile(relPath); return; }
    await closeFile(relPath);
    if (openFiles.has(relPath)) return; // Unsaved file from another project was kept.
  }
  const res = await reachApi.files.read(drawerAgentId(), relPath, dir);
  if (dir !== drawerDir() || generation !== fileTreeGeneration) return;
  if (openFiles.get(relPath)?.dir === dir) { activateFile(relPath); return; }
  if (!res.ok) {
    editorStatus.textContent = `Could not open ${relPath}: ${res.err}`;
    editorStatus.title = editorStatus.textContent;
    if (/binary|Binary|encoding/i.test(res.err || '')) {
      editorStatus.textContent += ' — use Files ▸ Open externally, or right-click the file.';
    }
    return;
  }
  // Binary previews (images, audio, video, PDF) render instead of editing.
  if (res.preview) { openPreviewTab(relPath, res, dir); return; }
  openEditorTab(relPath, res.content, dir, {});
}

function activateFile(relPath) {
  activeFile = relPath;
  for (const [p, f] of openFiles) {
    f.el.classList.toggle('active', p === relPath);
    f.host.classList.toggle('hidden', p !== relPath);
  }
  editorEmpty.classList.toggle('hidden', openFiles.size > 0);
  const f = openFiles.get(relPath);
  if (f) {
    editorStatus.textContent = f.dirty ? 'modified' : relPath;
    $('#btn-save-file').classList.toggle('hidden', !f.dirty);
  }
  syncLiveTools();
}

async function closeFile(relPath) {
  const f = openFiles.get(relPath);
  if (!f) return;
  if (f.dirty && !await confirmAction(`${relPath} has unsaved changes. Close anyway?`)) return;
  f.editor.destroy();
  f.el.remove();
  f.host.remove();
  openFiles.delete(relPath);
  if (activeFile === relPath) {
    activeFile = null;
    const next = openFiles.keys().next();
    if (!next.done) activateFile(next.value);
    else { editorEmpty.classList.remove('hidden'); editorStatus.textContent = ''; syncLiveTools(); }
  }
}

async function saveActiveFile() {
  if (!activeFile) return;
  const f = openFiles.get(activeFile);
  if (!f) return;
  const text = f.editor.getText();
  const res = await reachApi.files.write(drawerAgentId(), activeFile, text, f.dir);
  if (!res.ok) { editorStatus.textContent = 'save failed: ' + res.err; return; }
  f.savedText = text;
  f.dirty = false;
  f.el.classList.remove('dirty');
  $('#btn-save-file').classList.add('hidden');
  editorStatus.textContent = activeFile + ' — saved';
}

$('#btn-save-file').onclick = saveActiveFile;

/* Quiet icon actions for a live diff. They sit in the footer and only appear
 * while highlights are up. Removed lines themselves are not controls. */
const liveTools = $('#editor-live-tools');
const liveButtons = {};

function liveIcon(paths) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('width', '12');
  svg.setAttribute('height', '12');
  svg.setAttribute('aria-hidden', 'true');
  for (const d of paths) {
    const shape = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    shape.setAttribute('d', d);
    shape.setAttribute('fill', 'none');
    shape.setAttribute('stroke', 'currentColor');
    shape.setAttribute('stroke-width', '1.4');
    shape.setAttribute('stroke-linecap', 'round');
    shape.setAttribute('stroke-linejoin', 'round');
    svg.appendChild(shape);
  }
  return svg;
}

function setLiveIcon(button, paths) {
  button.replaceChildren(liveIcon(paths));
}

function addLiveTool(id, paths, title, onClick) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'editor-live-tool';
  button.title = title;
  button.setAttribute('aria-label', title);
  setLiveIcon(button, paths);
  button.addEventListener('click', onClick);
  liveTools.appendChild(button);
  liveButtons[id] = button;
}

const liveIconPaths = {
  up: ['M4 10 L8 5.5 L12 10'],
  down: ['M4 6 L8 10.5 L12 6'],
  eye: ['M1.5 8 C3.6 4.6 6 3.2 8 3.2 C10 3.2 12.4 4.6 14.5 8 C12.4 11.4 10 12.8 8 12.8 C6 12.8 3.6 11.4 1.5 8 Z', 'M8 10.1 A2.1 2.1 0 1 0 8 5.9 A2.1 2.1 0 1 0 8 10.1 Z'],
  eyeOff: ['M1.5 8 C3.6 4.6 6 3.2 8 3.2 C10 3.2 12.4 4.6 14.5 8 C12.4 11.4 10 12.8 8 12.8 C6 12.8 3.6 11.4 1.5 8 Z', 'M3 13 L13 3'],
  copy: ['M6 2.5 H12.5 V10.5 H6 Z', 'M3.5 5.5 H10 V13.5 H3.5 Z'],
  refresh: ['M13.2 8 A5.2 5.2 0 1 1 11.1 3.7', 'M11.1 1.4 V4.5 H8'],
  clear: ['M4.5 4.5 L11.5 11.5', 'M11.5 4.5 L4.5 11.5'],
};

function activeLiveEditor() {
  const file = activeFile ? openFiles.get(activeFile) : null;
  const editor = file && file.editor;
  if (!editor || typeof editor.liveState !== 'function') return null;
  return editor;
}

function syncLiveTools() {
  const editor = activeLiveEditor();
  const state = editor ? editor.liveState() : null;
  const on = !!(state && state.active);
  liveTools.hidden = !on;
  if (!on) return;
  liveButtons.prev.disabled = state.hunks < 1;
  liveButtons.next.disabled = state.hunks < 1;
  const hasRemoved = state.removed > 0;
  liveButtons.removed.hidden = !hasRemoved;
  liveButtons.copy.hidden = !hasRemoved;
  const removedTitle = state.showDeletions ? 'Hide removed lines' : 'Show removed lines';
  liveButtons.removed.title = removedTitle;
  liveButtons.removed.setAttribute('aria-label', removedTitle);
  liveButtons.removed.setAttribute('aria-pressed', state.showDeletions ? 'true' : 'false');
  setLiveIcon(liveButtons.removed, state.showDeletions ? liveIconPaths.eyeOff : liveIconPaths.eye);
}

addLiveTool('prev', liveIconPaths.up, 'Previous change', () => {
  const editor = activeLiveEditor();
  if (editor) editor.jumpLive(-1);
});
addLiveTool('next', liveIconPaths.down, 'Next change', () => {
  const editor = activeLiveEditor();
  if (editor) editor.jumpLive(1);
});
addLiveTool('removed', liveIconPaths.eyeOff, 'Hide removed lines', () => {
  const editor = activeLiveEditor();
  if (!editor) return;
  editor.setDeletionsVisible(!editor.liveState().showDeletions);
});
addLiveTool('copy', liveIconPaths.copy, 'Copy removed lines', async () => {
  const editor = activeLiveEditor();
  const text = editor ? editor.removedText() : '';
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    editorStatus.textContent = 'Copied removed lines';
    editorStatus.title = editorStatus.textContent;
  } catch {
    editorStatus.textContent = 'Could not copy removed lines';
    editorStatus.title = editorStatus.textContent;
  }
});
addLiveTool('refresh', liveIconPaths.refresh, 'Refresh and clear highlights', () => {
  const rel = activeFile;
  const editor = activeLiveEditor();
  if (editor) editor.clearLive();
  if (rel) dropLiveMark(rel);
});
addLiveTool('clear', liveIconPaths.clear, 'Clear highlights', () => {
  const editor = activeLiveEditor();
  if (editor) editor.clearLive();
});
syncLiveTools();
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 's' && drawerOpen) {
    e.preventDefault();
    saveActiveFile();
  }
});

