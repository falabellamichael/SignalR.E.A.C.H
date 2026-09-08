/* REACH Browser — webview script.
 * Renders fetched pages inside a sandboxed, same-origin iframe so the page runs
 * fully (scripts, styles, navigation). A capture script is injected into the
 * page so right-clicking any element still gives "Add element to chat (REACH)".
 * Talks to the extension host exclusively via postMessage. */
(function () {
  const vscode = window.acquireVsCodeApi ? window.acquireVsCodeApi() : null;
  if (!vscode) return;
  // Page scripts run in a same-origin iframe; remove the API surface so page
  // scripts can never reach the extension host.
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

  /* ---------------------------- URL normalization -------------------------- */

  function normalizeUrl(raw) {
    let u = String(raw || '').trim();
    if (!u) return '';
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(u)) {
      if (/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/i.test(u)) u = 'http://' + u;
      else if (/^[\w.-]+\.[a-z]{2,}(\/|$)/i.test(u)) u = 'https://' + u;
      else return '';
    }
    return /^https?:\/\//i.test(u) ? u : '';
  }

  /* ------------------------- page frame (sandboxed) ------------------------ */

  const CAPTURE_JS = `(function () {
    if (window.__reachCapture) return; window.__reachCapture = true;
    function post(type, data) {
      try { window.parent.postMessage(Object.assign({ __reach: true, type: type }, data || {}), '*'); } catch (e) {}
    }
    function describe(el) {
      if (!el || el.nodeType !== 1) return '';
      var tag = el.tagName ? el.tagName.toLowerCase() : '';
      var text = (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim();
      if (!text) text = (el.getAttribute('alt') || el.getAttribute('aria-label') || el.getAttribute('title') || '').replace(/\\s+/g, ' ').trim();
      if (!text && tag === 'img') text = 'image: ' + (el.getAttribute('src') || '');
      if (!text && tag === 'a') text = 'link: ' + (el.getAttribute('href') || '');
      text = String(text || '').slice(0, 4000);
      var parts = [];
      if (tag) parts.push('<' + tag + '>');
      if (text) parts.push(text);
      var href = el.getAttribute ? (el.getAttribute('href') || '') : '';
      if (tag === 'a' && href) parts.push('(href: ' + String(href).slice(0, 300) + ')');
      return parts.join(' — ').slice(0, 4500);
    }
    function flash(el) {
      if (!el || !el.style) return;
      try {
        el.style.outline = '2px solid #d4af37';
        setTimeout(function () { el.style.outline = ''; }, 900);
      } catch (e) {}
    }
    document.addEventListener('contextmenu', function (e) {
      var el = e.target && e.target.nodeType === 1 ? e.target : null;
      flash(el);
      var href = '';
      try {
        var a = el && el.closest ? el.closest('a[href]') : null;
        if (a) href = a.href || a.getAttribute('href') || '';
      } catch (err) {}
      var sel = '';
      try { sel = (window.getSelection() || '').toString ? String(window.getSelection()) : ''; } catch (err) {}
      post('ctx', { x: e.clientX, y: e.clientY, text: describe(el), sel: sel, href: href, tag: el ? el.tagName.toLowerCase() : '' });
    }, true);
    document.addEventListener('click', function (e) {
      post('click', {});
      var a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
      if (!a) return;
      var href = '';
      try { href = a.href || a.getAttribute('href') || ''; } catch (err) {}
      if (/^https?:\\/\\//i.test(href)) { e.preventDefault(); post('nav', { url: href }); }
    }, true);
    document.addEventListener('scroll', function () { post('scroll', {}); }, true);
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') post('esc', {});
    }, true);
  })();`;

  function stripPageCsp(html) {
    // The page's own CSP would block our injected capture script.
    return String(html || '').replace(
      /<meta[^>]+http-equiv\s*=\s*["']?content-security-policy["']?[^>]*>/gi, '');
  }

  function buildDoc(html, url) {
    let out = stripPageCsp(html);
    // First <base> wins — prepend ours so relative URLs resolve against the page URL.
    const base = '<base href="' + String(url).replace(/"/g, '&quot;') + '">';
    if (/<head[^>]*>/i.test(out)) {
      out = out.replace(/<head[^>]*>/i, (m) => m + base);
    } else {
      out = '<head>' + base + '</head>' + out;
    }
    const captureTag = '<script>' + CAPTURE_JS + '</scr' + 'ipt>';
    if (/<\/body>/i.test(out)) out = out.replace(/<\/body>/i, captureTag + '</body>');
    else out += captureTag;
    return out;
  }

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
    currentTitle = data.title || '';
    address.value = currentUrl;
    hasPage = true;
    errorBox.hidden = true;
    welcome.hidden = true;
    hideMenu();
    statusEl.textContent = currentTitle ? currentTitle.slice(0, 60) : currentUrl.slice(0, 60);
    const fr = ensureFrame();
    fr.srcdoc = buildDoc(data.html || '', currentUrl);
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
    if (data.title) statusEl.textContent = data.title.slice(0, 60);
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

  // Capture messages sent by the injected page script.
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
    } else if (d.type === 'click' || d.type === 'scroll' || d.type === 'esc') {
      // Interactions inside the iframe don't reach the parent document's
      // listeners — the capture script forwards them so the menu closes.
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
