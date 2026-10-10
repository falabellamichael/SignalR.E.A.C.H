let fileTreeGeneration = 0;
let fileTreeRoot = null;
const expandedFolders = new Set();
const liveMarks = new Map();
const liveFadeTimers = new Map();
const liveRefreshTries = new Map();
const liveEditorTokens = new Map();
const LIVE_FADE_MS = 10000;

async function refreshFileTree() {
  const dir = drawerDir();
  const agentId = drawerAgentId();
  const generation = ++fileTreeGeneration;
  if (fileTreeRoot !== dir) {
    resetEditors();
    expandedFolders.clear();
    clearLiveMarks();
    fileTreeRoot = dir;
  }
  fileTreeEl.innerHTML = '';
  if (!dir) {
    drawerContext.textContent = 'no project bound';
    return;
  }
  drawerContext.textContent = dir;
  async function loadFolder(host, directory = '', offset = 0) {
    if (generation !== fileTreeGeneration) return false;
    host.dataset.loading = '1';
    delete host.dataset.loaded;
    const status = document.createElement('div');
    status.className = 'tree-empty dim';
    status.textContent = 'Loading…';
    host.appendChild(status);
    let res;
    try { res = await reachApi.files.tree(agentId, dir, directory, offset); }
    catch (error) { res = { ok: false, err: error.message }; }
    if (generation !== fileTreeGeneration) return false;
    status.remove();
    if (!res.ok) {
      delete host.dataset.loading;
      const retry = document.createElement('button');
      retry.className = 'tree-entry file';
      retry.textContent = 'Could not list folder: ' + (res.err || 'unreadable') + ' — retry';
      retry.onclick = () => { retry.remove(); loadFolder(host, directory, offset); };
      host.appendChild(retry);
      return false;
    }
    for (const entry of res.tree) {
      const row = document.createElement('button');
      row.className = 'tree-entry ' + entry.type;
      row.style.paddingLeft = (8 + entry.depth * 14) + 'px';
      row.dataset.path = entry.path;
      row.title = entry.path;
      const name = entry.path.split('/').pop();
      if (entry.type === 'file') {
        row.textContent = name;
        row.onclick = () => openFile(entry.path);
        host.appendChild(row);
        continue;
      }
      const children = document.createElement('div');
      children.setAttribute('role', 'group');
      let open = expandedFolders.has(entry.path), loaded = false, loading = false;
      const update = () => {
        row.textContent = (open ? '▾ ' : '▸ ') + name;
        row.setAttribute('aria-expanded', String(open));
        children.hidden = !open;
      };
      const expand = async () => {
        if (loaded || loading) return;
        loading = true;
        loaded = await loadFolder(children, entry.path);
        loading = false;
      };
      row.onclick = () => {
        open = !open;
        if (open) expandedFolders.add(entry.path); else expandedFolders.delete(entry.path);
        update();
        if (open) expand();
      };
      update();
      host.append(row, children);
      if (open) expand();
    }
    if (!res.tree.length && !offset) {
      const empty = document.createElement('div');
      empty.className = 'tree-empty dim'; empty.textContent = 'Folder is empty'; host.appendChild(empty);
    }
    if (res.nextOffset !== null && res.nextOffset !== undefined) {
      const more = document.createElement('button');
      more.className = 'tree-entry file tree-more';
      more.textContent = `Show more (${res.total - res.nextOffset} remaining)`;
      more.onclick = () => { more.remove(); loadFolder(host, directory, res.nextOffset); };
      host.appendChild(more);
    }
    if (generation !== fileTreeGeneration) return false;
    delete host.dataset.loading;
    host.dataset.loaded = '1';
    insertMissingLiveRows(host, directory);
    return true;
  }
  await loadFolder(fileTreeEl);
}

$('#btn-refresh-tree').onclick = refreshFileTree;

/* Live file updates. A write from Studio itself (agent save, accepted review,
 * refactor apply) arrives as files:live. The tree keeps a short-lived +n/-n
 * mark. An open clean editor reloads and shows the deleted lines in red and
 * the added lines in green until the user types. A dirty buffer is left alone. */
function rootsMatch(a, b) {
  if (!a || !b) return false;
  const norm = (value) => String(value).replace(/\\/g, '/').replace(/\/+$/g, '').toLowerCase();
  return norm(a) === norm(b);
}

function parentPath(rel) {
  const slash = String(rel || '').lastIndexOf('/');
  return slash < 0 ? '' : rel.slice(0, slash);
}

function findFileRow(rel) {
  if (!fileTreeEl || !rel) return null;
  for (const row of fileTreeEl.querySelectorAll('button.tree-entry.file')) {
    if (row.dataset.path === rel) return row;
  }
  return null;
}

function findDirRow(rel) {
  if (!fileTreeEl || !rel) return null;
  for (const row of fileTreeEl.querySelectorAll('button.tree-entry.dir')) {
    if (row.dataset.path === rel) return row;
  }
  return null;
}

function clearLiveMarks() {
  for (const timer of liveFadeTimers.values()) clearTimeout(timer);
  liveFadeTimers.clear();
  liveMarks.clear();
  liveRefreshTries.clear();
  liveEditorTokens.clear();
}

function ensureFileName(row) {
  const name = row.querySelector(':scope > .tree-file-name');
  if (name) return name;
  const span = document.createElement('span');
  span.className = 'tree-file-name';
  span.textContent = row.textContent;
  row.replaceChildren(span);
  return span;
}

function paintLiveMark(row, mark) {
  if (!row || !mark) return;
  ensureFileName(row);
  row.querySelector(':scope > .tree-live-stat')?.remove();
  row.classList.toggle('live-add', mark.created === true);
  const stat = document.createElement('span');
  stat.className = 'tree-live-stat';
  stat.setAttribute('aria-hidden', 'true');
  if (mark.added == null && mark.removed == null) {
    const updated = document.createElement('span');
    updated.className = 'chg';
    updated.textContent = 'updated';
    stat.appendChild(updated);
  } else {
    if (mark.added) {
      const added = document.createElement('span');
      added.className = 'add';
      added.textContent = `+${mark.added}`;
      stat.appendChild(added);
    }
    if (mark.removed) {
      const removed = document.createElement('span');
      removed.className = 'del';
      removed.textContent = `-${mark.removed}`;
      stat.appendChild(removed);
    }
  }
  if (stat.childNodes.length) row.appendChild(stat);
}

function insertFileRow(host, rel) {
  const depth = rel.split('/').length - 1;
  const row = document.createElement('button');
  row.className = 'tree-entry file';
  row.style.paddingLeft = (8 + depth * 14) + 'px';
  row.dataset.path = rel;
  row.title = rel;
  const name = rel.split('/').pop();
  row.textContent = name;
  row.onclick = () => openFile(rel);
  let before = null;
  for (const child of host.children) {
    if (!child.classList || !child.classList.contains('tree-entry') || child.classList.contains('dir')) continue;
    if (!child.dataset.path || child.classList.contains('tree-more')) { before = child; break; }
    if (name.localeCompare(child.dataset.path.split('/').pop()) < 0) { before = child; break; }
  }
  host.querySelector(':scope > .tree-empty')?.remove();
  if (before) host.insertBefore(row, before);
  else host.appendChild(row);
  return row;
}

function placeLiveRow(rel) {
  const existing = findFileRow(rel);
  if (existing) return existing;
  const parent = parentPath(rel);
  let host = fileTreeEl;
  if (parent) {
    const folder = findDirRow(parent);
    const children = folder && folder.nextElementSibling;
    if (!children || children.getAttribute('role') !== 'group' || children.dataset.loaded !== '1' || children.dataset.loading === '1') return null;
    host = children;
  } else if (fileTreeEl.dataset.loading === '1') {
    return null;
  }
  return insertFileRow(host, rel);
}

function parentFolderMissing(rel) {
  const parent = parentPath(rel);
  return parent ? !findDirRow(parent) : false;
}

function insertMissingLiveRows(host, directory) {
  const dir = directory || '';
  for (const [rel, mark] of liveMarks) {
    if (parentPath(rel) !== dir) continue;
    const existing = findFileRow(rel);
    if (existing) { paintLiveMark(existing, mark); continue; }
    paintLiveMark(insertFileRow(host, rel), mark);
  }
}

function dropLiveMark(rel) {
  const pending = liveFadeTimers.get(rel);
  if (pending) clearTimeout(pending);
  liveFadeTimers.delete(rel);
  liveMarks.delete(rel);
  liveRefreshTries.delete(rel);
  const row = findFileRow(rel);
  if (!row) return;
  row.classList.remove('live-add');
  row.querySelector(':scope > .tree-live-stat')?.remove();
}

function armLiveFade(rel) {
  const pending = liveFadeTimers.get(rel);
  if (pending) clearTimeout(pending);
  liveFadeTimers.set(rel, setTimeout(() => dropLiveMark(rel), LIVE_FADE_MS));
}

function forgetLiveContext(rel) {
  const entry = openFiles.get(rel);
  const dir = (entry && entry.dir) || drawerDir();
  if (!dir || !rel || typeof reachApi.files?.clearLive !== 'function') return;
  void reachApi.files.clearLive(dir, rel).catch(() => {});
}

function noteLiveTree(rel, mark) {
  liveMarks.set(rel, mark);
  const row = placeLiveRow(rel);
  if (row) paintLiveMark(row, mark);
  else if (parentFolderMissing(rel)) {
    const tries = liveRefreshTries.get(rel) || 0;
    if (tries < 1 && fileTreeEl.dataset.loading !== '1') {
      liveRefreshTries.set(rel, tries + 1);
      void refreshFileTree();
    }
  }
  armLiveFade(rel);
}

function liveChangeList(ev) {
  const changes = Array.isArray(ev.changes) ? ev.changes : [];
  return ev.truncated && !changes.length ? [] : changes;
}

function liveStatusText(rel, ev) {
  if (ev.truncated && !(ev.changes || []).length) return `${rel} updated — too large to highlight each line`;
  const bits = [];
  if (Number.isInteger(ev.added) && ev.added) bits.push(`+${ev.added}`);
  if (Number.isInteger(ev.removed) && ev.removed) bits.push(`-${ev.removed}`);
  const summary = bits.join(' ');
  return summary ? `${rel} updated ${summary}${ev.truncated ? ' (highlights capped)' : ''}` : `${rel} updated`;
}

function nextLiveToken(rel) {
  const token = (liveEditorTokens.get(rel) || 0) + 1;
  liveEditorTokens.set(rel, token);
  return token;
}

async function showLiveEditor(rel, ev) {
  const dir = drawerDir();
  if (!dir) return;
  const anyDirty = [...openFiles.values()].some(file => file.dirty);
  const entry = openFiles.get(rel);
  const changes = liveChangeList(ev);
  if (entry && rootsMatch(entry.dir, dir)) {
    if (entry.preview || !entry.editor || typeof entry.editor.showChange !== 'function') return;
    if (entry.dirty) {
      if (activeFile === rel) {
        editorStatus.textContent = `${rel} changed on disk — unsaved edits kept`;
        editorStatus.title = editorStatus.textContent;
      }
      return;
    }
    const token = nextLiveToken(rel);
    const res = await reachApi.files.read(drawerAgentId(), rel, dir);
    if (liveEditorTokens.get(rel) !== token || !rootsMatch(drawerDir(), dir)) return;
    const current = openFiles.get(rel);
    if (!current || current.dirty || current.preview || !rootsMatch(current.dir, dir)) {
      if (current && current.dirty && activeFile === rel) {
        editorStatus.textContent = `${rel} changed on disk — unsaved edits kept`;
        editorStatus.title = editorStatus.textContent;
      }
      return;
    }
    if (!res.ok || res.preview) return;
    current.savedText = res.content;
    current.dirty = false;
    current.el.classList.remove('dirty');
    current.editor.showChange(res.content, changes);
    if (!anyDirty) activateFile(rel);
    if (activeFile === rel) {
      const status = liveStatusText(rel, ev);
      editorStatus.textContent = status;
      editorStatus.title = status;
      $('#btn-save-file').classList.add('hidden');
    }
    return;
  }
  if (entry || anyDirty) return;
  const token = nextLiveToken(rel);
  await openFile(rel);
  if (liveEditorTokens.get(rel) !== token || !rootsMatch(drawerDir(), dir)) return;
  const opened = openFiles.get(rel);
  if (!opened || opened.dirty || opened.preview || !rootsMatch(opened.dir, dir) || typeof opened.editor.showChange !== 'function') return;
  opened.editor.showChange(opened.editor.getText(), changes);
  const status = liveStatusText(rel, ev);
  editorStatus.textContent = status;
  editorStatus.title = status;
}

function onLiveFile(ev) {
  if (!ev || typeof ev.path !== 'string' || !rootsMatch(ev.root, drawerDir())) return;
  const rel = ev.path.split('\\').join('/').replace(/^\/+/, '');
  if (!rel || rel.split('/').includes('..')) return;
  noteLiveTree(rel, {
    created: ev.created === true,
    added: Number.isInteger(ev.added) ? ev.added : null,
    removed: Number.isInteger(ev.removed) ? ev.removed : null,
  });
  void showLiveEditor(rel, ev);
}

if (typeof reachApi.files.onLive === 'function') reachApi.files.onLive(onLiveFile);

