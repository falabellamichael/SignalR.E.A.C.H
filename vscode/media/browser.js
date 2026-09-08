/* REACH Browser — webview script.
 * Shows fetched pages (scripts disabled), with a custom right-click menu:
 * "Add element to chat (REACH)" captures the element under the cursor and
 * sends it to the REACH chat panel. Talks to the extension host via postMessage. */
(function () {
  const vscode = window.acquireVsCodeApi ? window.acquireVsCodeApi() : null;
  if (!vscode) return;

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
  let engineOk = true;   // confirmed by the host's 'state' message
  let installing = false;

  // Remember the last URL/view across reloads (VS Code webview state).
  const saved = vscode.getState ? vscode.getState() : null;
  let lastUrl = (saved && saved.url) || '';

  const post = (type, data) => vscode.postMessage(Object.assign({ type }, data || {}));

  /* ------------------------- sanitize fetched HTML ------------------------ */

  function sanitize(html) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    doc.querySelectorAll('script,iframe,object,embed,noscript,base,meta,link,style[type="text/x-template"]').forEach((n) => n.remove());
    // Page <style> is fine (CSP allows inline styles); remove only the
    // elements that could run code or escape our sandbox.
    doc.querySelectorAll('*').forEach((el) => {
      for (const attr of Array.from(el.attributes || [])) {
        const name = attr.name.toLowerCase();
        if (name.startsWith('on')) el.removeAttribute(attr.name);
        if ((name === 'href' || name === 'src' || name === 'action')
          && /^javascript:/i.test(attr.value)) el.setAttribute(attr.name, '');
        if (name === 'srcdoc') el.removeAttribute(attr.name);
      }
    });
    return doc.body ? doc.body.innerHTML : '';
  }

  /* ---------------------------- element capture --------------------------- */

  function describeElement(el) {
    if (!el || el.nodeType !== 1) return '';
    const tag = el.tagName ? el.tagName.toLowerCase() : '';
    let text = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
    if (!text) {
      text = (el.getAttribute('alt') || el.getAttribute('aria-label')
        || el.getAttribute('title') || '').replace(/\s+/g, ' ').trim();
    }
    if (!text && tag === 'img') text = 'image: ' + (el.getAttribute('src') || '');
    if (!text && tag === 'a') text = 'link: ' + (el.getAttribute('href') || '');
    text = text.slice(0, 4000);
    const parts = [];
    if (tag) parts.push('<' + tag + '>');
    if (text) parts.push(text);
    const href = (el.getAttribute && el.getAttribute('href')) || '';
    if (tag === 'a' && href) parts.push('(href: ' + href.slice(0, 300) + ')');
    return parts.join(' — ').slice(0, 4500);
  }

  function flash(el) {
    if (!el) return;
    el.classList.add('reach-flash');
    setTimeout(() => el.classList.remove('reach-flash'), 900);
  }

  function pickElement(x, y) {
    // elementFromPoint is viewport-based; the page container fills the viewport.
    const el = document.elementFromPoint(x, y);
    if (!el || !page.contains(el) || el === page || el === welcome || el === ctxMenu) return null;
    return el;
  }

  /* ----------------------------- context menu ----------------------------- */

  function hideMenu() {
    ctxMenu.hidden = true;
    ctxMenu.innerHTML = '';
  }

  function showMenu(x, y, el, selText) {
    if (!hasPage) return;
    const items = [];

    const addEl = () => {
      const text = describeElement(el);
      if (!text) return;
      flash(el);
      post('addElement', { url: currentUrl, title: currentTitle, text });
      hideMenu();
    };
    items.push({ label: 'Add element to chat', sub: 'REACH', fn: addEl });

    const sel = (selText || '').replace(/\s+/g, ' ').trim();
    if (sel) {
      items.push({
        label: 'Add selected text to chat', sub: 'REACH',
        fn: () => { post('addElement', { url: currentUrl, title: currentTitle, text: sel.slice(0, 8000) }); hideMenu(); },
      });
    }
    const link = el && el.closest ? el.closest('a[href]') : null;
    if (link) {
      items.push({ sep: true });
      items.push({
        label: 'Open link in external browser',
        fn: () => { post('openExternal', { url: resolveUrl(link.getAttribute('href')) }); hideMenu(); },
      });
    }

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
      b.innerHTML = '';
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
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const px = Math.min(x, vw - rect.width - 8);
    const py = Math.min(y, vh - rect.height - 8);
    ctxMenu.style.left = Math.max(4, px) + 'px';
    ctxMenu.style.top = Math.max(4, py) + 'px';
  }

  page.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const el = pickElement(e.clientX, e.clientY);
    const sel = window.getSelection() ? window.getSelection().toString() : '';
    showMenu(e.clientX, e.clientY, el, sel);
  });

  document.addEventListener('click', (e) => {
    if (!ctxMenu.hidden && !ctxMenu.contains(e.target)) hideMenu();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') hideMenu();
  });
  page.addEventListener('scroll', hideMenu, { passive: true });

  /* ----------------------------- rendering -------------------------------- */

  function resolveUrl(href) {
    if (!href) return '';
    try { return new URL(href, currentUrl || address.value || 'https://example.com').toString(); }
    catch (e) { return ''; }
  }

  function renderPage(data) {
    currentUrl = data.url || '';
    currentTitle = data.title || '';
    address.value = currentUrl;
    hasPage = true;
    errorBox.hidden = true;
    welcome.hidden = true;
    statusEl.textContent = currentTitle ? currentTitle.slice(0, 60) : currentUrl.slice(0, 60);
    page.innerHTML = sanitize(data.html || '');
    page.scrollTop = 0;
    if (vscode.setState) vscode.setState({ url: currentUrl });
    applyState(data);
  }

  function renderError(data) {
    errorBox.hidden = false;
    errorBox.textContent = 'Could not load ' + (data.url || 'page') + ' — ' + (data.error || 'unknown error');
    statusEl.textContent = 'error';
  }

  function applyState(data) {
    if (typeof data.canBack === 'boolean') backBtn.disabled = !data.canBack;
    if (typeof data.canForward === 'boolean') fwdBtn.disabled = !data.canForward;
    if (data.url && !hasPage) { address.value = data.url; }
    if (data.title) statusEl.textContent = data.title.slice(0, 60);
    if (typeof data.engine === 'boolean') setEngine(data.engine);
  }

  /* ------------------------- engine one-click install -------------------- */

  function setEngine(ok) {
    engineOk = !!ok;
    if (engineOk) {
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

  // Follow in-panel links (they are plain anchors; page JS is disabled).
  page.addEventListener('click', (e) => {
    const a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
    if (!a) return;
    e.preventDefault();
    const url = resolveUrl(a.getAttribute('href'));
    if (/^https?:\/\//i.test(url)) {
      post('navigate', { url, push: true });
      statusEl.textContent = 'Loading…';
    }
  });

  /* ------------------------------- controls ------------------------------- */

  address.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    const url = address.value.trim();
    if (!/^https?:\/\//i.test(url) && /^[\w.-]+\.[a-z]{2,}/i.test(url)) {
      address.value = 'https://' + url;
    }
    if (/^https?:\/\//i.test(address.value.trim())) {
      post('navigate', { url: address.value.trim(), push: true });
      statusEl.textContent = 'Loading…';
    } else {
      statusEl.textContent = 'Enter an http(s) URL';
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
