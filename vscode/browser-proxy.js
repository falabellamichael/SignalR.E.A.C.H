/* REACH Browser page proxy.
 *
 * Webview iframes run pages at the webview's own origin, so module scripts
 * (`<script type="module">` — every Vite/Next/React app) and fetch/XHR are
 * CORS-gated and fail against servers that don't send CORS headers
 * (Python SimpleHTTP, many local dev servers) -> blank pages.
 *
 * This tiny reverse proxy serves the page from http://127.0.0.1:<port> — the
 * SAME origin as the iframe — so modules/API calls work. It injects the
 * REACH capture script into HTML responses so right-click
 * "Add element to chat (REACH)" still works.
 *
 * Routing:
 *   /r/<token>/<path>  -> the page directory (relative assets)
 *   /<absolute-path>   -> the page's origin root (/api/..., /extensions/...)
 *
 * Local-only, unguessable per-session token, http(s) targets only.
 */
'use strict';

const http = require('http');
const crypto = require('crypto');

const FETCH_TIMEOUT_MS = 20000;
const MAX_BODY_BYTES = 16 * 1024 * 1024;
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

/* Capture script injected into HTML responses. Runs inside the page
 * (same origin as the proxy) and reports right-clicks/links/title to the
 * parent webview via postMessage. */
function captureScript(port, tok, origRoot) {
  return '<script>/* reach capture */\n(function () {\n'
    + 'if (window.__reachCapture) return; window.__reachCapture = true;\n'
    + 'var PROXY = ' + JSON.stringify('http://127.0.0.1:' + port + '/r/' + tok + '/') + ';\n'
    + 'var ORIG = ' + JSON.stringify(origRoot) + ';\n'
    + 'function post(type, data) {\n'
    + '  try { window.parent.postMessage(Object.assign({ __reach: true, type: type }, data || {}), "*"); } catch (e) {}\n'
    + '}\n'
    + 'function toOrig(href) { return href && href.indexOf(PROXY) === 0 ? ORIG + href.slice(PROXY.length) : href; }\n'
    + 'function describe(el) {\n'
    + '  if (!el || el.nodeType !== 1) return "";\n'
    + '  var tag = el.tagName ? el.tagName.toLowerCase() : "";\n'
    + '  var text = (el.innerText || el.textContent || "").replace(/\\s+/g, " ").trim();\n'
    + '  if (!text) text = (el.getAttribute("alt") || el.getAttribute("aria-label") || el.getAttribute("title") || "").replace(/\\s+/g, " ").trim();\n'
    + '  if (!text && tag === "img") text = "image: " + (el.getAttribute("src") || "");\n'
    + '  if (!text && tag === "a") text = "link: " + (el.getAttribute("href") || "");\n'
    + '  text = String(text || "").slice(0, 4000);\n'
    + '  var parts = [];\n'
    + '  if (tag) parts.push("<" + tag + ">");\n'
    + '  if (text) parts.push(text);\n'
    + '  var href = el.getAttribute ? (el.getAttribute("href") || "") : "";\n'
    + '  if (tag === "a" && href) parts.push("(href: " + String(href).slice(0, 300) + ")");\n'
    + '  return parts.join(" \\u2014 ").slice(0, 4500);\n'
    + '}\n'
    + 'function flash(el) {\n'
    + '  if (!el || !el.style) return;\n'
    + '  try { el.style.outline = "2px solid #d4af37"; setTimeout(function () { el.style.outline = ""; }, 900); } catch (e) {}\n'
    + '}\n'
    + 'function sendTitle() { try { post("title", { title: document.title || "" }); } catch (e) {} }\n'
    + 'document.addEventListener("DOMContentLoaded", sendTitle);\n'
    + 'window.addEventListener("load", sendTitle);\n'
    + 'document.addEventListener("contextmenu", function (e) {\n'
    + '  var el = e.target && e.target.nodeType === 1 ? e.target : null;\n'
    + '  flash(el);\n'
    + '  var href = "";\n'
    + '  try { var a = el && el.closest ? el.closest("a[href]") : null; if (a) href = a.href || a.getAttribute("href") || ""; } catch (err) {}\n'
    + '  var sel = "";\n'
    + '  try { sel = (window.getSelection() || "").toString ? String(window.getSelection()) : ""; } catch (err) {}\n'
    + '  post("ctx", { x: e.clientX, y: e.clientY, text: describe(el), sel: sel, href: href, tag: el ? el.tagName.toLowerCase() : "" });\n'
    + '}, true);\n'
    + 'document.addEventListener("click", function (e) {\n'
    + '  post("click", {});\n'
    + '  var a = e.target && e.target.closest ? e.target.closest("a[href]") : null;\n'
    + '  if (!a) return;\n'
    + '  var href = "";\n'
    + '  try { href = a.href || a.getAttribute("href") || ""; } catch (err) {}\n'
    + '  href = toOrig(href);\n'
    + '  if (/^https?:\\/\\//i.test(href)) { e.preventDefault(); post("nav", { url: href }); }\n'
    + '}, true);\n'
    + 'document.addEventListener("scroll", function () { post("scroll", {}); }, true);\n'
    + 'document.addEventListener("keydown", function (e) { if (e.key === "Escape") post("esc", {}); }, true);\n'
    + '})();</scr' + 'ipt>';
}

let server = null;
let token = null;
const targets = new Map(); // token -> { root, origin }

function makeRoot(pageUrl) {
  const u = new URL(pageUrl);
  // Treat the page URL as a directory so relative assets resolve under it.
  if (!u.pathname.endsWith('/')) u.pathname += '/';
  return u.toString();
}

function makeOrigin(pageUrl) {
  const u = new URL(pageUrl);
  return u.protocol + '//' + u.host + '/';
}

async function fetchUpstream(target) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const resp = await fetch(target, {
      redirect: 'follow',
      signal: controller.signal,
      headers: { 'User-Agent': BROWSER_UA, 'Accept': '*/*', 'Accept-Language': 'en-US,en;q=0.9' },
    });
    const buf = Buffer.from(await resp.arrayBuffer());
    return { status: resp.status, headers: resp.headers, body: buf };
  } finally {
    clearTimeout(timer);
  }
}

function upgradeHtml(body, targetRoot) {
  let html = body.toString('utf8');
  const proxyRoot = 'http://127.0.0.1:' + server.address().port + '/r/' + token + '/';
  // Strip the page CSP (would block our injected capture script).
  html = html.replace(
    /<meta[^>]+http-equiv\s*=\s*["']?content-security-policy["']?[^>]*>/gi, '');
  // First <base> wins: ours resolves relative assets against the proxy root.
  const base = '<base href="' + proxyRoot + '">';
  if (/<head[^>]*>/i.test(html)) {
    html = html.replace(/<head[^>]*>/i, (m) => m + base);
  } else {
    html = '<head>' + base + '</head>' + html;
  }
  const capture = captureScript(server.address().port, token, targetRoot);
  if (/<\/body>/i.test(html)) html = html.replace(/<\/body>/i, capture + '</body>');
  else html += capture;
  return Buffer.from(html, 'utf8');
}

function respond(res, status, headers, body) {
  res.writeHead(status, Object.assign({
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-store',
    'X-Reach-Proxy': '1',
  }, headers || {}));
  res.end(body);
}

function handle(req, res) {
  const raw = req.url || '/';
  const m = /^\/r\/([A-Za-z0-9_-]+)\/(.*)$/.exec(raw);
  let target = '';
  if (m && targets.has(m[1])) {
    // Relative assets under the page directory.
    try { target = new URL(decodeURIComponent(m[2]), targets.get(m[1]).root).toString(); } catch (e) { /* invalid */ }
  } else if (raw.startsWith('/') && !raw.startsWith('/r/') && targets.has(token)) {
    // Absolute-path requests (/api/..., /extensions/...) -> the page's origin
    // root, exactly like a real browser on the target host.
    try { target = new URL(raw, targets.get(token).origin).toString(); } catch (e) { /* invalid */ }
  }
  if (!target || !/^https?:\/\//i.test(target)) {
    respond(res, 404, { 'Content-Type': 'text/plain' }, 'not found');
    return;
  }
  fetchUpstream(target).then((up) => {
    const ct = String(up.headers.get('content-type') || '');
    let body = up.body;
    let targetForBase = target;
    if (up.status === 200 && ct.includes('text/html')) {
      body = upgradeHtml(up.body, targetForBase);
    }
    const ext = (target.split('?')[0].match(/\.([a-z0-9]+)$/i) || [])[0] || '';
    const type = ct || MIME['.' + ext.toLowerCase()] || 'application/octet-stream';
    respond(res, up.status, { 'Content-Type': type }, body);
  }).catch((e) => {
    respond(res, 502, { 'Content-Type': 'text/plain' },
      'proxy fetch failed: ' + String((e && e.message) || e));
  });
}

function startPageProxy() {
  if (server && server.listening) return Promise.resolve(currentProxyInfo());
  token = crypto.randomBytes(18).toString('base64url');
  return new Promise((resolve, reject) => {
    server = http.createServer(handle);
    server.on('error', (e) => { server = null; reject(e); });
    server.listen(0, '127.0.0.1', () => {
      resolve(currentProxyInfo());
    });
  });
}

function currentProxyInfo() {
  return { port: server ? server.address().port : 0, token };
}

/* Register a page and return its proxy URL. */
function pageProxyUrl(pageUrl) {
  if (!server || !server.listening) throw new Error('proxy not started');
  targets.set(token, { root: makeRoot(pageUrl), origin: makeOrigin(pageUrl) });
  return 'http://127.0.0.1:' + server.address().port + '/r/' + token + '/';
}

function stopPageProxy() {
  if (server) {
    try { server.close(); } catch (e) { /* ignore */ }
    server = null;
  }
  targets.clear();
}

module.exports = { startPageProxy, pageProxyUrl, stopPageProxy, currentProxyInfo };
