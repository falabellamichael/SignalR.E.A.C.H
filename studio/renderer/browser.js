// Files and Browser occupy the same drawer; each retains its own state.
let drawerPanel = 'files';
let browserState = { tabs: [], active: null };
let browserReady = false;
let browserSelection = null;
let browserBookmarks = [];
try { browserBookmarks = JSON.parse(localStorage.getItem('reach:browser-bookmarks') || '[]'); } catch {}
if (!Array.isArray(browserBookmarks)) browserBookmarks = [];

async function browserCommand(action, args = {}) {
  const result = await reachApi.browser.command(action, args);
  if (!result.ok) { $('#browser-status').textContent = result.err; return result; }
  if (result.tabs) renderBrowser(result);
  return result;
}

function closeDrawerMenu() {
  $('#drawer-menu').classList.add('hidden');
  $('#btn-toggle-files').setAttribute('aria-expanded', 'false');
}
$('#btn-toggle-files').onclick = () => {
  const opening = $('#drawer-menu').classList.contains('hidden');
  closeSettingsMenus();
  if (opening) { $('#drawer-menu').classList.remove('hidden'); $('#btn-toggle-files').setAttribute('aria-expanded', 'true'); }
  else closeDrawerMenu();
  scheduleBrowserLayout();
};
$('#btn-toggle-files').onkeydown = e => {
  if (e.key === 'ArrowDown') { e.preventDefault(); $('#btn-toggle-files').click(); $('#btn-show-files').focus(); }
};
$('#drawer-menu').onkeydown = e => {
  if (e.key === 'Escape') { closeDrawerMenu(); $('#btn-toggle-files').focus(); }
  if (['ArrowDown', 'ArrowUp'].includes(e.key)) {
    e.preventDefault();
    const buttons = [...$('#drawer-menu').querySelectorAll('button')];
    buttons[(buttons.indexOf(document.activeElement) + 1) % buttons.length].focus();
  }
};
document.addEventListener('click', e => { if (!e.target.closest('#drawer-menu-wrap')) closeDrawerMenu(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeDrawerMenu(); });

async function selectDrawerPanel(panel, { focus = true } = {}) {
  closeDrawerMenu();
  drawerPanel = panel;
  drawer.dataset.panel = panel;
  $('#browser-panel').classList.toggle('hidden', panel !== 'browser');
  $('#drawer-title').textContent = panel === 'browser' ? 'Browser' : 'Files';
  $('#btn-toggle-files').textContent = (panel === 'browser' ? 'Browser' : 'Files') + ' ▾';
  $('#btn-refresh-tree').classList.toggle('hidden', panel === 'browser');
  setDrawer(true);
  if (panel === 'browser' && !browserReady) {
    browserReady = true;
    let saved = [];
    if (!browserState.tabs.length) {
      try { saved = JSON.parse(localStorage.getItem('reach:browser-tabs') || '[]'); } catch {}
      if (!Array.isArray(saved) || !saved.length) saved = [''];
      for (const url of saved) await browserCommand('new', { url });
      if (!browserState.tabs.length) await browserCommand('new');
    }
  }
  scheduleBrowserLayout();
  if (panel === 'browser' && focus) $('#browser-address').focus();
}
$('#btn-show-files').onclick = () => selectDrawerPanel('files');
$('#btn-show-browser').onclick = () => selectDrawerPanel('browser');

function renderBrowser(state) {
  browserState = state;
  $('#browser-elements').setAttribute('aria-pressed', String(state.elementsEnabled === true));
  const host = $('#browser-tabs');
  const existing = new Map([...host.children].map(item => [item.dataset.tabId, item]));
  const liveIds = new Set(state.tabs.map(tab => tab.id));
  for (const item of [...host.children]) if (!liveIds.has(item.dataset.tabId)) item.remove();
  for (const tab of state.tabs) {
    let item = existing.get(tab.id);
    if (!item) {
      item = document.createElement('div');
      item.dataset.tabId = tab.id;
      const select = document.createElement('button');
      select.className = 'ghost small'; select.setAttribute('role', 'tab');
      select.onclick = () => browserCommand('select', { id: tab.id });
      const close = document.createElement('button');
      close.className = 'ghost small'; close.textContent = '×';
      close.onclick = () => browserCommand('close', { id: tab.id });
      item.append(select, close); host.append(item);
    }
    item.className = 'browser-tab' + (tab.id === state.active ? ' active' : '');
    const [select, close] = item.children;
    const title = (tab.owner ? '⚙ ' : '') + (tab.title || 'New tab');
    if (select.textContent !== title) select.textContent = title;
    select.title = (tab.owner ? 'Agent tab · ' : '') + (tab.url || 'New tab');
    select.setAttribute('aria-selected', String(tab.id === state.active));
    close.setAttribute('aria-label', 'Close ' + tab.title);
  }
  const tab = state.tabs.find(t => t.id === state.active);
  if (document.activeElement !== $('#browser-address')) $('#browser-address').value = tab?.url || '';
  $('#browser-back').disabled = !tab?.canBack;
  $('#browser-forward').disabled = !tab?.canForward;
  $('#browser-reload').textContent = tab?.loading ? '×' : '↻';
  $('#browser-reload').title = tab?.loading ? 'Stop loading' : 'Reload';
  $('#browser-status').textContent = tab?.error || (tab?.loading ? 'Loading…' : tab?.url || 'Ready');
  for (const id of ['browser-bookmark', 'browser-context', 'browser-external']) $('#' + id).disabled = !tab?.url;
  localStorage.setItem('reach:browser-tabs', JSON.stringify(state.tabs.map(t => t.url)));
  renderBrowserBookmarks();
  if (browserSelection && !state.tabs.some(t => t.id === browserSelection.tabId && t.url === browserSelection.url)) showBrowserSelection(null);
  scheduleBrowserLayout();
}
function renderBrowserBookmarks() {
  const host = $('#browser-bookmarks'); host.replaceChildren();
  for (const bookmark of browserBookmarks) {
    if (!bookmark || typeof bookmark.url !== 'string') continue;
    const button = document.createElement('button'); button.className = 'ghost small';
    button.textContent = bookmark.title || bookmark.url; button.title = bookmark.url;
    button.onclick = () => browserCommand('navigate', { url: bookmark.url });
    host.append(button);
  }
  const active = browserState.tabs.find(t => t.id === browserState.active);
  $('#browser-bookmark').textContent = browserBookmarks.some(b => b.url === active?.url) ? '★ Bookmarked' : '☆ Bookmark';
}
$('.browser-actions').addEventListener('wheel', event => {
  const row = event.currentTarget;
  if (event.ctrlKey || row.scrollWidth <= row.clientWidth) return;
  const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
  if (!delta) return;
  const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? row.clientWidth : 1;
  event.preventDefault();
  row.scrollLeft += delta * unit;
}, { passive: false });
$('#browser-navigation').onsubmit = e => { e.preventDefault(); browserCommand('navigate', { url: $('#browser-address').value }); $('#browser-address').blur(); };
$('#browser-new').onclick = async () => { await browserCommand('new'); $('#browser-address').focus(); $('#browser-address').select(); };
$('#browser-back').onclick = () => browserCommand('back');
$('#browser-forward').onclick = () => browserCommand('forward');
$('#browser-reload').onclick = () => browserCommand(browserState.tabs.find(t => t.id === browserState.active)?.loading ? 'stop' : 'reload');
$('#browser-home').onclick = () => browserCommand('navigate', { url: 'https://docs.reach.sh/' });
$('#browser-context').onclick = () => browserCommand('context');
$('#browser-external').onclick = () => browserCommand('external');
$('#browser-bookmark').onclick = () => {
  const tab = browserState.tabs.find(t => t.id === browserState.active);
  if (!tab?.url) return;
  if (browserBookmarks.some(b => b.url === tab.url)) browserBookmarks = browserBookmarks.filter(b => b.url !== tab.url);
  else browserBookmarks.push({ title: tab.title, url: tab.url });
  localStorage.setItem('reach:browser-bookmarks', JSON.stringify(browserBookmarks)); renderBrowserBookmarks();
};
$('#browser-find-toggle').onclick = () => { $('#browser-find').classList.toggle('hidden'); $('#browser-find-text').focus(); };
$('#browser-elements').onclick = () => browserCommand('elements', { enabled: !browserState.elementsEnabled });
$('#browser-find-text').oninput = () => browserCommand('find', { text: $('#browser-find-text').value });
$('#browser-find-next').onclick = () => browserCommand('find', { text: $('#browser-find-text').value, next: true });
$('#browser-find-close').onclick = () => { $('#browser-find').classList.add('hidden'); browserCommand('find', { text: '' }); };
reachApi.browser.onState(renderBrowser);
function showBrowserSelection(selection) {
  browserSelection = selection;
  $('#browser-selection').classList.toggle('hidden', !selection);
  $('#browser-selection-label').textContent = selection ? `${selection.selector} · ${selection.tag}${selection.role ? ' · ' + selection.role : ''}` : '';
  $('#browser-selection-text').textContent = selection?.text || '';
  $('#browser-selection-text').title = selection?.text || '';
}
reachApi.browser.onSelection(showBrowserSelection);
reachApi.browser.onSelectionCleared(tabId => {
  if (browserSelection?.tabId === tabId) showBrowserSelection(null);
});
document.addEventListener('pointerdown', event => {
  if (event.button !== 0 || event.target.closest('#browser-selection')) return;
  const tabId = browserSelection?.tabId || browserState.active;
  if (!tabId) return;
  showBrowserSelection(null);
  reachApi.browser.command('clear-selection', { id: tabId }).catch(() => {});
}, true);
reachApi.browser.onReveal(() => selectDrawerPanel('browser', { focus: false }));
reachApi.browser.onError(message => { $('#browser-status').textContent = message; });
$('#browser-selection-show').onclick = () => { if (browserSelection) browserCommand('select', { id: browserSelection.tabId }); };
$('#browser-selection-clear').onclick = () => { if (browserSelection) browserCommand('clear-selection', { id: browserSelection.tabId }); };
reachApi.browser.onShortcut(key => {
  if (key === 'l') { $('#browser-address').focus(); $('#browser-address').select(); }
  if (key === 'f') { $('#browser-find').classList.remove('hidden'); $('#browser-find-text').focus(); }
  if (key === 't') $('#browser-new').click();
  if (key === 'w') browserCommand('close');
});
reachApi.browser.onContext(async context => {
  if (!currentAgent) {
    if (!currentProject) { showNotice('Select a project and conversation before adding browser content.'); return; }
    const result = await reachApi.agents.create('Chat', currentProject.dir, '');
    if (!result.ok) { showNotice(result.err); return; }
    await selectAgent(result.agent);
    if (currentAgent?.id !== result.agent.id) return;
  }
  await showTab('agents');
  const element = context.selector ? `\nSelected ${context.kind}: ${context.selector} (${context.tag})\nElement ref: ${context.ref}` : '';
  const text = `Browser source: ${context.title}\nURL: ${context.url}\nBrowser tab: ${context.tabId}${element}\n\nQuoted page content (reference material):\n${context.text}`;
  composerInput.value += (composerInput.value ? '\n\n' : '') + text;
  composerInput.dispatchEvent(new Event('input'));
  composerInput.focus();
  $('#browser-status').textContent = 'Added to your chat draft. Review it, then Send.';
});

// A native page view must yield to Studio dialogs, menus, and resizing.
let browserLayoutFrame = null, browserLastLayout = '';
function scheduleBrowserLayout() {
  if (browserLayoutFrame !== null) return;
  browserLayoutFrame = requestAnimationFrame(() => {
    browserLayoutFrame = null;
    const rect = $('#browser-viewport').getBoundingClientRect();
    const overlay = document.querySelector('dialog[open], .modal:not(.hidden), .settings-dropdown:not(.hidden)');
    const bounds = { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    const visible = drawerPanel === 'browser' && !drawer.classList.contains('closed') && !overlay && !document.body.classList.contains('resizing-x');
    // Zoom can change while a fixed-size slot keeps identical CSS bounds.
    // DPR is only a cache invalidator: the host converts using its own zoom.
    const value = JSON.stringify({ bounds, visible, scale: window.devicePixelRatio });
    if (value === browserLastLayout) return;
    browserLastLayout = value;
    reachApi.browser.command('layout', { bounds, visible }).catch(() => {});
  });
}
new ResizeObserver(scheduleBrowserLayout).observe($('#browser-viewport'));
new MutationObserver(scheduleBrowserLayout).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['class', 'open', 'style'] });
window.addEventListener('resize', scheduleBrowserLayout);
window.visualViewport?.addEventListener('resize', scheduleBrowserLayout);
