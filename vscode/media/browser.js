/* REACH Browser — webview script.
 * Pages load through the local page proxy (same origin as the iframe) so
 * module scripts and API calls work — but the proxy injects a capture script
 * into the page, so right-clicking any element still gives
 * "Add element to chat (REACH)". Talks to the extension host via postMessage. */
(function () {
  const vscode = window.acquireVsCodeApi ? window.acquireVsCodeApi() : null;
  if (!vscode) return;
  // Page scripts run in the iframe; remove the API surface so they can never
  // reach the extension host.
  try { window.acquireVsCodeApi = undefined; } catch (e) { /* ignore */ }

  const $ = (s) => document.querySelector(s);
  const page = $('#page');
  const address = $('#address');
  const backBtn = $('#back-btn');
  const fwdBtn = $('#fwd-btn');
  const reloadBtn = $('#reload-btn');
  const homeBtn = $('#home-btn');
  const openExtBtn = $('#open-ext-btn');
  const bookmarkBtn = $('#bookmark-btn');
  const pageToChatBtn = $('#page-to-chat-btn');
  const newTabBtn = $('#newtab-btn');
  const tabsEl = $('#tabs');
  const bookmarksEl = $('#bookmarks');
  const spinner = $('#spinner');
  const statusEl = $('#status');
  const welcome = $('#welcome');
  const errorBox = $('#error-box');
  const ctxMenu = $('#ctx-menu');
  const engineBanner = $('#engine-banner');
  const engineInstallBtn = $('#engine-install-btn');
  const engineProgress = $('#engine-progress');
  const engineReady = $('#engine-ready');

  const HOME_URL = 'https://docs.reach.sh/';

  // Remember the tabs/bookmarks across reloads (VS Code webview state).
  const saved = vscode.getState ? vscode.getState() : null;
  let bookmarks = Array.isArray(saved && saved.bookmarks) ? saved.bookmarks.slice(0, 40) : [];

  let installing = false;

  /* Each tab owns its own history stack and iframe element. A single iframe
   * is reused by swapping `src`, which would lose per-tab history — so we
   * keep one iframe per tab and show only the active one. */
  let seq = 0;
  let tabs = [];
  let activeId = null;
  const frames = new Map();

  function makeTab(url) {
    return { id: 'tab-' + (++seq), url: url || '', title: url || 'New tab', history: [], index: -1 };
  }

  function activeTab() {
    return tabs.find((t) => t.id === activeId) || null;
  }

  const getFrame = (id) => frames.get(id) || null;

  function ensureFrame(id) {
    let fr = frames.get(id);
    if (fr && fr.isConnected) return fr;
    fr = document.createElement('iframe');
    fr.className = 'browser-frame';
    fr.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads');
    fr.setAttribute('title', 'page');
    fr.hidden = true;
    fr.dataset.tab = id;
    page.appendChild(fr);
    frames.set(id, fr);
    return fr;
  }

  const post = (type, data) => vscode.postMessage(Object.assign({ type }, data || {}));

  /* ---------------------------- URL handling ------------------------------ */

  function normalizeUrl(raw) {
    let u = String(raw || '').trim();
    if (!u) return '';
    if (/^https?:\/\//i.test(u)) return u;
    if (/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/i.test(u)) return 'http://' + u;
    if (/^[\w.-]+\.[a-z]{2,}(\/|$)/i.test(u)) return 'https://' + u;
    // Bare words: search (DuckDuckGo HTML — Google answers embedded/localhost
    // clients with a reCAPTCHA wall: "Localhost is not in the list of
    // supported domains for this site key", and "unusual traffic" checks).
    return 'https://duckduckgo.com/html/?q=' + encodeURIComponent(u);
  }

  /* ----------------------------- tab bar UI ------------------------------- */

  function persist() {
    if (vscode.setState) vscode.setState({ bookmarks, tabs: tabs.map((t) => ({ id: t.id, url: t.url, title: t.title })), activeId });
  }

  function renderTabs() {
    tabsEl.innerHTML = '';
    tabs.forEach((t) => {
      const el = document.createElement('div');
      el.className = 'tab' + (t.id === activeId ? ' active' : '');
      el.title = t.title || t.url || 'New tab';
      const label = document.createElement('span');
      label.className = 'tab-label';
      label.textContent = (t.title || t.url || 'New tab').slice(0, 40);
      el.appendChild(label);
      const close = document.createElement('button');
      close.className = 'tab-close';
      close.title = 'Close tab (Ctrl+W)';
      close.setAttribute('aria-label', 'Close tab');
      close.textContent = '\u00d7';
      close.addEventListener('click', (e) => { e.stopPropagation(); closeTab(t.id); });
      el.appendChild(close);
      el.addEventListener('click', () => activateTab(t.id));
      tabsEl.appendChild(el);
    });
  }

  function setTabFrameVisibility() {
    frames.forEach((fr, id) => { fr.hidden = id !== activeId; });
  }

  function activateTab(id) {
    if (!tabs.some((t) => t.id === id)) return;
    activeId = id;
    const t = activeTab();
    renderTabs();
    setTabFrameVisibility();
    hideMenu();
    syncChrome();
    if (t && t.url) { welcome.hidden = true; } else { welcome.hidden = false; }
    persist();
    if (t && !t.url) address.focus();
  }

  function newTab(url) {
    const t = makeTab(url || '');
    tabs.push(t);
    if (url) {
      // Defer the load until the host has created the proxy for this URL.
      pendingNav.set(t.id, url);
    }
    activateTab(t.id);
    if (url) navigateInTab(t.id, url, true);
    return t;
  }

  function closeTab(id) {
    const idx = tabs.findIndex((t) => t.id === id);
    if (idx === -1) return;
    const fr = frames.get(id);
    if (fr) { fr.remove(); frames.delete(id); }
    pendingNav.delete(id);
    tabs.splice(idx, 1);
    if (!tabs.length) {
      newTab('');
      return;
    }
    if (activeId === id) {
      const next = tabs[Math.min(idx, tabs.length - 1)];
      activateTab(next.id);
    } else {
      renderTabs();
      persist();
    }
  }

  function syncChrome() {
    const t = activeTab();
    if (!t) return;
    const hist = t.history;
    address.value = t.url || '';
    backBtn.disabled = t.index <= 0;
    fwdBtn.disabled = t.index >= hist.length - 1;
    statusEl.textContent = (t.title || t.url || '').slice(0, 60);
    bookmarkBtn.classList.toggle('active', bookmarks.some((b) => b.url === t.url));
  }

  /* ----------------------------- navigation ------------------------------- */

  const pendingNav = new Map(); // tabId -> url awaiting the proxy URL
  function navigateInTab(id, url, push) {
    if (!/^https?:\/\//i.test(url)) return;
    statusEl.textContent = 'Loading…';
    setSpinner(true);
    pendingNav.set(id, url);
    post('navigate', { url, push: push !== false, tab: id });
  }

  function applyPage(id, data) {
    const t = tabs.find((x) => x.id === id);
    if (!t) return;
    t.url = data.url || t.url;
    t.title = data.title || t.url || t.title;
    t.history = Array.isArray(data.history) ? data.history : t.history;
    t.index = typeof data.index === 'number' ? data.index : t.index;
    errorBox.hidden = true;
    if (id === activeId) welcome.hidden = true;
    const fr = ensureFrame(id);
    if (data.proxyUrl) fr.src = String(data.proxyUrl);
    if (id === activeId) { renderTabs(); setTabFrameVisibility(); syncChrome(); }
    setSpinner(false);
    persist();
  }

  function applyError(id, data) {
    setSpinner(false);
    if (id === activeId) {
      errorBox.hidden = false;
      errorBox.textContent = 'Could not load ' + (data.url || 'page') + ' — ' + (data.error || 'unknown error');
      statusEl.textContent = 'error';
    }
  }

  function applyState(data) {
    if (typeof data.engine === 'boolean') setEngine(data.engine);
    if (data.canBack === undefined && data.canForward === undefined) return;
    const t = activeTab();
    if (t) {
      if (typeof data.canBack === 'boolean') backBtn.disabled = !data.canBack;
      if (typeof data.canForward === 'boolean') fwdBtn.disabled = !data.canForward;
    }
  }

  function setSpinner(on) { spinner.hidden = !on; }

  /* ----------------------------- bookmarks -------------------------------- */

  function renderBookmarks() {
    bookmarksEl.innerHTML = '';
    bookmarksEl.hidden = !bookmarks.length;
    bookmarks.forEach((b) => {
      const el = document.createElement('button');
      el.className = 'bookmark';
      el.title = b.url;
      const label = document.createElement('span');
      label.className = 'bookmark-label';
      label.textContent = b.title || b.url;
      el.appendChild(label);
      const rm = document.createElement('span');
      rm.className = 'bookmark-remove';
      rm.textContent = '\u00d7';
      rm.addEventListener('click', (e) => { e.stopPropagation(); removeBookmark(b.url); });
      el.appendChild(rm);
      el.addEventListener('click', () => {
        const t = activeTab();
        if (t) navigateInTab(t.id, b.url, true);
      });
      bookmarksEl.appendChild(el);
    });
  }

  function toggleBookmark() {
    const t = activeTab();
    if (!t || !t.url) return;
    const existing = bookmarks.findIndex((b) => b.url === t.url);
    if (existing >= 0) bookmarks.splice(existing, 1);
    else bookmarks.unshift({ url: t.url, title: t.title || t.url });
    bookmarks = bookmarks.slice(0, 40);
    renderBookmarks();
    syncChrome();
    persist();
  }

  function removeBookmark(url) {
    bookmarks = bookmarks.filter((b) => b.url !== url);
    renderBookmarks();
    syncChrome();
    persist();
  }

  /* ------------------------- engine one-click install -------------------- */

  function setEngine(ok) {
    if (ok) {
      engineBanner.hidden = true;
      engineReady.hidden = false;
      engineProgress.hidden = true;
      engineInstallBtn.disabled = false;
      engineInstallBtn.textContent = 'Install browser engine';
      return;
    }
    engineBanner.hidden = false;
    engineReady.hidden = true;
  }

  function setInstalling(active, line) {
    installing = active;
    engineInstallBtn.disabled = active;
    engineProgress.hidden = !active;
    if (active && line) engineProgress.textContent = line;
    if (!active) {
      engineProgress.textContent = '';
      engineInstallBtn.textContent = 'Install browser engine';
    }
  }

  engineInstallBtn.addEventListener('click', () => {
    if (installing) return;
    setInstalling(true, 'Starting…');
    post('installBrowser', {});
  });

  /* ----------------------------- context menu ----------------------------- */

  function hideMenu() {
    ctxMenu.hidden = true;
    ctxMenu.innerHTML = '';
  }

  function showMenu(px, py, info) {
    const t = activeTab();
    if (!t || !t.url) return;
    const items = [];
    const text = String(info.text || '').trim();
    const sel = String(info.sel || '').replace(/\s+/g, ' ').trim();
    const href = String(info.href || '').trim();

    if (text) {
      items.push({
        label: 'Add element to chat', sub: 'REACH',
        fn: () => { post('addElement', { url: t.url, title: t.title, text }); hideMenu(); },
      });
    }
    if (sel) {
      items.push({
        label: 'Add selected text to chat', sub: 'REACH',
        fn: () => { post('addElement', { url: t.url, title: t.title, text: sel.slice(0, 8000) }); hideMenu(); },
      });
    }
    if (href && /^https?:\/\//i.test(href)) {
      items.push({ sep: true });
      items.push({
        label: 'Open link in new tab',
        fn: () => { newTab(normalizeUrl(href)); hideMenu(); },
      });
      items.push({
        label: 'Open link in external browser',
        fn: () => { post('openExternal', { url: href }); hideMenu(); },
      });
    }
    if (!items.length) return;

    ctxMenu.innerHTML = '';
    items.forEach((it) => {
      if (it.sep) {
        const s = document.createElement('div');
        s.className = 'ctx-sep';
        ctxMenu.appendChild(s);
        return;
      }
      const b = document.createElement('button');
      b.className = 'ctx-item';
      b.appendChild(document.createTextNode(it.label));
      if (it.sub) {
        const s = document.createElement('span');
        s.className = 'ctx-sub';
        s.textContent = '(' + it.sub + ')';
        b.appendChild(s);
      }
      b.addEventListener('click', it.fn);
      ctxMenu.appendChild(b);
    });

    ctxMenu.hidden = false;
    const rect = ctxMenu.getBoundingClientRect();
    const x = Math.min(px, window.innerWidth - rect.width - 8);
    const y = Math.min(py, window.innerHeight - rect.height - 8);
    ctxMenu.style.left = Math.max(4, x) + 'px';
    ctxMenu.style.top = Math.max(4, y) + 'px';
  }

  // Capture messages sent by the proxy-injected page script.
  function frameTabId(source) {
    const hit = [...frames.entries()].find(([, f]) => f.contentWindow === source);
    return hit ? hit[0] : null;
  }

  window.addEventListener('message', (e) => {
    const tabId = frameTabId(e.source);
    if (!tabId) return;
    const d = e.data || {};
    if (!d.__reach) return;
    const t = tabs.find((x) => x.id === tabId);
    if (!t) return;
    if (d.type === 'ctx') {
      if (tabId !== activeId) return;
      const r = getFrame(tabId).getBoundingClientRect();
      showMenu(r.left + Math.max(0, Number(d.x) || 0), r.top + Math.max(0, Number(d.y) || 0), d);
    } else if (d.type === 'nav') {
      const url = normalizeUrl(d.url);
      if (url) navigateInTab(tabId, url, true);
    } else if (d.type === 'title') {
      const title = String(d.title || '').trim();
      if (title) {
        t.title = title.slice(0, 120);
        if (t.index >= 0) t.history[t.index] = Object.assign({}, t.history[t.index], { title: t.title });
        if (tabId === activeId) { renderTabs(); statusEl.textContent = t.title.slice(0, 60); }
        post('pageTitle', { title: t.title });
        persist();
      }
    } else if (d.type === 'click' || d.type === 'scroll' || d.type === 'esc') {
      hideMenu();
    }
  });

  document.addEventListener('click', (e) => {
    if (!ctxMenu.hidden && !ctxMenu.contains(e.target)) hideMenu();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { hideMenu(); return; }
    const mod = e.ctrlKey || e.metaKey;
    if (e.altKey && e.key === 'ArrowLeft') { e.preventDefault(); post('back', {}); return; }
    if (e.altKey && e.key === 'ArrowRight') { e.preventDefault(); post('forward', {}); return; }
    if (!mod) return;
    const k = e.key.toLowerCase();
    if (k === 'r') { e.preventDefault(); const t = activeTab(); if (t && t.url) { statusEl.textContent = 'Loading…'; setSpinner(true); post('reload', {}); } }
    else if (k === 'l') { e.preventDefault(); address.focus(); address.select(); }
    else if (k === 't') { e.preventDefault(); newTab(''); }
    else if (k === 'w') { e.preventDefault(); if (activeId) closeTab(activeId); }
  });

  /* ------------------------------- controls ------------------------------- */

  address.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    const t = activeTab();
    const url = normalizeUrl(address.value);
    if (url && t) {
      address.value = url;
      navigateInTab(t.id, url, true);
    } else {
      statusEl.textContent = 'Enter an http(s) or localhost URL';
    }
  });

  backBtn.addEventListener('click', () => post('back', {}));
  fwdBtn.addEventListener('click', () => post('forward', {}));
  reloadBtn.addEventListener('click', () => { const t = activeTab(); if (t && t.url) { statusEl.textContent = 'Loading…'; post('reload', {}); } });
  homeBtn.addEventListener('click', () => { const h = activeTab(); if (h) navigateInTab(h.id, HOME_URL, true); else newTab(HOME_URL); });
  newTabBtn.addEventListener('click', () => newTab(''));
  bookmarkBtn.addEventListener('click', toggleBookmark);
  pageToChatBtn.addEventListener('click', () => { const p = activeTab(); if (p && p.url) post('addPageToChat', { url: p.url, title: p.title }); });
  openExtBtn.addEventListener('click', () => {
    const t = activeTab();
    if (t && t.url) post('openExternal', { url: t.url });
  });

  /* ------------------------------- messages ------------------------------- */

  window.addEventListener('message', (e) => {
    // Host messages only — ignore anything posted by a page iframe.
    if (frameTabId(e.source)) return;
    const msg = e.data || {};
    switch (msg.type) {
      case 'page':
        applyPage(msg.tab || activeId, msg);
        break;
      case 'pageError':
        applyError(msg.tab || activeId, msg);
        break;
      case 'state':
        applyState(msg);
        break;
      case 'hostNewTab':
        newTab('');
        break;
      case 'hostNavigate': {
        const url = normalizeUrl(msg.url);
        if (!url) break;
        if (msg.newTab) {
          newTab(url);
        } else {
          const cur = activeTab();
          if (cur) navigateInTab(cur.id, url, true); else newTab(url);
        }
        break;
      }
      case 'hostSendPageToChat': {
        const p = activeTab();
        if (p && p.url) post('addPageToChat', { url: p.url, title: p.title });
        break;
      }
      case 'installProgress':
        if (!msg || !msg.line) break;
        engineProgress.textContent = (msg.stage === 'chromium' ? '⬇ ' : '') + msg.line;
        break;
      case 'installDone': {
        setInstalling(false, '');
        if (msg && msg.ok) {
          setEngine(true);
          engineProgress.hidden = true;
          statusEl.textContent = 'Browser engine installed ✓';
        } else {
          setEngine(false);
          engineProgress.hidden = false;
          engineProgress.textContent = '✗ ' + ((msg && msg.error) || 'install failed — try again');
        }
        break;
      }
      default:
        break;
    }
  });

  /* ------------------------------- startup -------------------------------- */

  // Restore previous tabs if the webview state carried them; otherwise open a
  // single blank tab.
  renderBookmarks();
  const restored = Array.isArray(saved && saved.tabs) ? saved.tabs : [];
  if (restored.length) {
    restored.forEach((r) => {
      const t = makeTab('');
      if (r && r.id) t.id = String(r.id);
      t.title = (r && r.title) || 'New tab';
      t.url = (r && r.url) || '';
      tabs.push(t);
    });
    const wantActive = (saved && saved.activeId) || tabs[0].id;
    activeId = tabs.some((t) => t.id === wantActive) ? wantActive : tabs[0].id;
    renderTabs();
    setTabFrameVisibility();
    syncChrome();
    const rt = tabs.find((t) => t.id === activeId);
    if (rt && rt.url) navigateInTab(activeId, rt.url, true);
  } else {
    newTab('');
  }

  address.focus();
  address.select();

  post('ready', {});
})();
