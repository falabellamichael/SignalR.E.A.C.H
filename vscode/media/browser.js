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
  const openExtBtn = $('#open-ext-btn');
  const statusEl = $('#status');
  const welcome = $('#welcome');
  const errorBox = $('#error-box');
  const ctxMenu = $('#ctx-menu');
  const engineBanner = $('#engine-banner');
  const engineInstallBtn = $('#engine-install-btn');
  const engineProgress = $('#engine-progress');
  const engineReady = $('#engine-ready');

  let currentUrl = '';
  let currentTitle = '';
  let hasPage = false;
  let frame = null;
  let installing = false;

  // Remember the last URL/view across reloads (VS Code webview state).
  const saved = vscode.getState ? vscode.getState() : null;
  let lastUrl = (saved && saved.url) || '';

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

  /* ----------------------------- page frame ------------------------------- */

  function ensureFrame() {
    if (frame && frame.isConnected) return frame;
    frame = document.createElement('iframe');
    frame.className = 'browser-frame';
    frame.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads');
    frame.setAttribute('title', 'page');
    page.appendChild(frame);
    return frame;
  }

  function renderPage(data) {
    currentUrl = data.url || '';
    currentTitle = data.title || currentUrl;
    address.value = currentUrl;
    hasPage = true;
    errorBox.hidden = true;
    welcome.hidden = true;
    hideMenu();
    statusEl.textContent = (currentTitle || currentUrl).slice(0, 60);
    const fr = ensureFrame();
    // The proxy serves the page from the same origin as this iframe, so
    // module scripts + API calls work; the injected capture script reports
    // the real page title/URL back to us.
    fr.src = String(data.proxyUrl || '');
    if (vscode.setState) vscode.setState({ url: currentUrl });
    applyState(data);
  }

  function renderError(data) {
    if (frame) { frame.remove(); frame = null; }
    hasPage = false;
    hideMenu();
    errorBox.hidden = false;
    errorBox.textContent = 'Could not load ' + (data.url || 'page') + ' — ' + (data.error || 'unknown error');
    statusEl.textContent = 'error';
  }

  function applyState(data) {
    if (typeof data.canBack === 'boolean') backBtn.disabled = !data.canBack;
    if (typeof data.canForward === 'boolean') fwdBtn.disabled = !data.canForward;
    if (data.title) statusEl.textContent = String(data.title).slice(0, 60);
    if (typeof data.engine === 'boolean') setEngine(data.engine);
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
    if (!hasPage) return;
    const items = [];
    const text = String(info.text || '').trim();
    const sel = String(info.sel || '').replace(/\s+/g, ' ').trim();
    const href = String(info.href || '').trim();

    if (text) {
      items.push({
        label: 'Add element to chat', sub: 'REACH',
        fn: () => { post('addElement', { url: currentUrl, title: currentTitle, text }); hideMenu(); },
      });
    }
    if (sel) {
      items.push({
        label: 'Add selected text to chat', sub: 'REACH',
        fn: () => { post('addElement', { url: currentUrl, title: currentTitle, text: sel.slice(0, 8000) }); hideMenu(); },
      });
    }
    if (href && /^https?:\/\//i.test(href)) {
      items.push({ sep: true });
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
  window.addEventListener('message', (e) => {
    if (!frame || e.source !== frame.contentWindow) return;
    const d = e.data || {};
    if (!d.__reach) return;
    if (d.type === 'ctx') {
      const r = frame.getBoundingClientRect();
      showMenu(r.left + Math.max(0, Number(d.x) || 0), r.top + Math.max(0, Number(d.y) || 0), d);
    } else if (d.type === 'nav') {
      const url = normalizeUrl(d.url);
      if (url) { statusEl.textContent = 'Loading…'; post('navigate', { url, push: true }); }
    } else if (d.type === 'title') {
      if (String(d.title || '').trim()) {
        currentTitle = String(d.title).slice(0, 120);
        statusEl.textContent = currentTitle.slice(0, 60);
        post('pageTitle', { title: currentTitle });
      }
    } else if (d.type === 'click' || d.type === 'scroll' || d.type === 'esc') {
      hideMenu();
    }
  });

  document.addEventListener('click', (e) => {
    if (!ctxMenu.hidden && !ctxMenu.contains(e.target)) hideMenu();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') hideMenu();
  });

  /* ------------------------------- controls ------------------------------- */

  address.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    const url = normalizeUrl(address.value);
    if (url) {
      address.value = url;
      statusEl.textContent = 'Loading…';
      post('navigate', { url, push: true });
    } else {
      statusEl.textContent = 'Enter an http(s) or localhost URL';
    }
  });

  backBtn.addEventListener('click', () => post('back', {}));
  fwdBtn.addEventListener('click', () => post('forward', {}));
  reloadBtn.addEventListener('click', () => { if (hasPage) { statusEl.textContent = 'Loading…'; post('reload', {}); } });
  openExtBtn.addEventListener('click', () => {
    if (currentUrl) post('openExternal', { url: currentUrl });
  });

  /* ------------------------------- messages ------------------------------- */

  window.addEventListener('message', (e) => {
    // Host messages only — ignore anything posted by the page iframe.
    if (frame && e.source === frame.contentWindow) return;
    const msg = e.data || {};
    switch (msg.type) {
      case 'page':
        renderPage(msg);
        break;
      case 'pageError':
        renderError(msg);
        break;
      case 'state':
        applyState(msg);
        break;
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

  // Prefill the last page (if any) and put the cursor in the address bar.
  if (lastUrl) address.value = lastUrl;
  address.focus();
  address.select();

  post('ready', {});
})();
