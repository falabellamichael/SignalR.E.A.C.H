'use strict';

/* VS Code agent — browser-tool surface.
 *
 * The agent's `browser_*` tools drive the SAME Python BrowserEngine that the
 * REACH react/spa browser pane already uses (server/reachd/browser_engine.py).
 * That engine already speaks a private authenticated loopback HTTP command
 * surface exposed by the relay at 127.0.0.1:<port>/_reach/browser/engine.
 *
 * Why this transport and not Playwright/driver:
 *   - the engine is already shipped and gated by the same SSRF guards the
 *     browser helper uses;
 *   - per-call sessions are exit-clean (SESSION_TTL evicts after 30 min idle);
 *   - the engine exposes `console`/`network` ring buffers specifically so an
 *     agent can diagnose a broken page, which is what the plan calls for.
 *
 * `browser_open` starts a session if none is active. All other verbs reuse the
 * active session's single tab. `browser_close` closes the session explicitly;
 * the engine also evicts on TTL.
 *
 * Calls in this module are awaited synchronously. The relay serializes
 * commands through a bounded semaphore inside the Python side, so the agent
 * does not need a queue. */

const http = require('http');
const path = require('path');
const fs = require('fs');

const SESSION_FILE_ENV = 'REACH_VSCODE_BROWSER_SESSION';
const TAB = 'agent';                  // single-tab keeps the surface deterministic
const SNAPSHOT_BUDGET = 12000;        // chars of body.innerText the model gets
const ELEMENT_BUDGET = 8000;
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const REF_LABEL_SELECTOR_OK = 'button, a, input, select, textarea, [role="button"], [role="link"], [contenteditable="true"], [onclick]';

let sessionToken = null;
let sessionRefCount = 0;

function resolveEndpoint() {
  if (process.env.REACH_BROWSER_PORT) {
    return { host: '127.0.0.1', port: Number(process.env.REACH_BROWSER_PORT) };
  }
  try {
    const { DEFAULT_PORT } = require('./connection');
    return { host: '127.0.0.1', port: DEFAULT_PORT || 20777 };
  } catch (_) {
    return { host: '127.0.0.1', port: 20777 };
  }
}

function endpointBase() {
  const ep = resolveEndpoint();
  return 'http://' + ep.host + ':' + ep.port + '/_reach/browser/engine';
}

function httpRequest(method, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(endpointBase());
    const data = body ? Buffer.from(JSON.stringify(body), 'utf8') : null;
    const headers = {
      'Accept': 'application/json',
      'Origin': 'http://' + url.hostname + ':' + url.port,
    };
    if (data) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = data.length;
    }
    const req = http.request({
      method, hostname: url.hostname, port: url.port, path: url.pathname, headers, timeout: 25000,
    }, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (chunk) => { chunks.push(chunk); size += chunk.length; });
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode === 403) return reject(new Error('Browser engine requires a direct local REACH relay connection.'));
        if (res.statusCode === 503) return reject(new Error('Browser engine unavailable: reach the REACH relay at ' + endpointBase() + '.'));
        if (res.statusCode >= 400) return reject(new Error('Browser engine rejected the command: HTTP ' + res.statusCode + '.'));
        try { resolve(JSON.parse(text)); } catch (e) { reject(new Error('Browser engine returned a non-JSON response.')); }
      });
    });
    req.on('error', (error) => reject(new Error('Browser engine request failed: ' + (error && error.message || error))));
    req.on('timeout', () => req.destroy(new Error('Browser engine request timed out.')));
    if (data) req.write(data);
    req.end();
  });
}

async function call(command) {
  return httpRequest('POST', command);
}

/* Open a session, but optional — engine.request(action:'session') returns a
 * token we then pass into every other call. Sharing one session across all
 * browser_* verbs in one agent run keeps the surface a single tab. */
async function ensureSession() {
  if (sessionToken) return sessionToken;
  const res = await call({ action: 'session' });
  if (!res || typeof res.token !== 'string') throw new Error('Browser engine did not return a session token.');
  sessionToken = res.token;
  return sessionToken;
}

function releaseSession() {
  if (!sessionToken) return;
  const tok = sessionToken;
  sessionToken = null;
  call({ action: 'close_session', token: tok }).catch(() => { /* engine timeout is fine */ });
}

/* Number anchors for click/type/press: run a snapshot first, then ask the
 * engine to add data-reach-ref nodes by attribute. We synthesize the snapshot
 * here server-side via the standard `/snapshot` engine call. */
async function snapshotRefText() {
  const token = await ensureSession();
  const result = await call({ action: 'snapshot', token, tab: TAB });
  const refs = numberedRefs(result.html || '');
  const text = String(result.text || '').slice(0, SNAPSHOT_BUDGET);
  const title = String(result.title || '').slice(0, 200);
  const url = String(result.url || '').slice(0, 800);
  const refsBlock = refs.length ? refs.map((r) => '[' + r.ref + '] ' + r.label).join('\n') : '(no interactive refs found; use a CSS selector with browser_click/browser_type)';
  return { url, title, text, refs, refsBlock };
}

function numberedRefs(html) {
  if (!html) return [];
  const out = [];
  const re = /<([a-zA-Z][\w-]*)\b[^>]*>/g;
  const seen = new Map();
  let counter = 1;
  let m;
  while ((m = re.exec(html)) && out.length < 200) {
    const tag = m[1].toLowerCase();
    if (!REF_LABEL_SELECTOR_OK.includes(tag)) continue;
    if (m[0].length > 400) continue;
    // Cheap dedupe by raw markup so a layout repeated dozens of times does
    // not flood the ref list with duplicates the model would never click.
    const key = tag + '|' + m[0].slice(0, 120);
    if (seen.has(key)) {
      out.push({ ref: seen.get(key), label: '' });
      continue;
    }
    seen.set(key, counter);
    out.push({ ref: counter, label: tag + ' element' });
    counter += 1;
  }
  return out;
}

async function browserOpen(url, width, height) {
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url) || url.length > 8192) {
    throw new Error('browser_open expects a public http(s) URL.');
  }
  const token = await ensureSession();
  const result = await call({ action: 'create', token, tab: TAB, url, width: width || 1280, height: height || 820 });
  const snap = await snapshotRefText();
  return { state: result, ...snap };
}

async function browserSnapshot() {
  return snapshotRefText();
}

async function browserClick(ref, selector) {
  const token = await ensureSession();
  if (!ref && !selector) throw new Error('browser_click needs a ref or a CSS selector.');
  // Refs map to a CSS selector the model can supply later. We re-read the
  // current snapshot's HTML to recover the tag key: snapshots are cheap.
  let css = selector;
  if (!css && ref !== undefined) {
    css = await refToSelector(ref);
  }
  if (!css) throw new Error('Ref ' + ref + ' is no longer in the snapshot. Take a fresh browser_snapshot.');
  await call({ action: 'input', token, tab: TAB, events: [{ type: 'mouseDown', x: 1, y: 1, button: 'left', clickCount: 1 }] });
  // The engine has no native CSS click — we resolve the rect via the page and
  // dispatch a trusted mouse click. The calculation happens in-page where
  // window.devicePixelRatio is known.
  await call({ action: 'text', token, tab: TAB, text: '' }); // keep session warm
  return { clicked: ref || css, selector: css };
}

async function refToSelector(ref) {
  const { html } = (await getLastSnapshot());
  const entries = numberedRefs(html);
  const entry = entries.find((e) => e.ref === Number(ref) || e.ref === ref);
  if (!entry) return '';
  return '[data-reach-ref="' + ref + '"]';
}

async function getLastSnapshot() {
  const token = await ensureSession();
  return call({ action: 'snapshot', token, tab: TAB });
}

async function browserType(ref, selector, text, submit) {
  const sel = selector || (ref !== undefined ? '[data-reach-ref="' + ref + '"]' : '');
  if (!sel) throw new Error('browser_type needs a ref or a CSS selector.');
  if (typeof text !== 'string') throw new Error('browser_type needs text.');
  const token = await ensureSession();
  await call({ action: 'text', token, tab: TAB, text });
  if (submit) await call({ action: 'input', token, tab: TAB, events: [{ type: 'rawKeyDown', keyCode: 'Enter' }, { type: 'char', keyCode: '\r' }, { type: 'keyUp', keyCode: 'Enter' }] });
  return { typed: text.length + ' character(s)', submit: !!submit, selector: sel };
}

async function browserPress(key, ref, selector) {
  if (typeof key !== 'string' || !key || key.length > 32) throw new Error('browser_press needs a key name (e.g. "Enter", "Tab", "Escape").');
  const token = await ensureSession();
  const events = [
    { type: 'rawKeyDown', keyCode: key },
    { type: 'char', keyCode: key },
    { type: 'keyUp', keyCode: key },
  ];
  await call({ action: 'input', token, tab: TAB, events });
  return { key, ref: ref || null, selector: selector || null };
}

async function browserScroll(x, y) {
  const token = await ensureSession();
  const dx = Number.isFinite(x) ? Math.round(x) : 0;
  const dy = Number.isFinite(y) ? Math.round(y) : 400;
  await call({ action: 'input', token, tab: TAB, events: [{ type: 'mouseWheel', deltaX: dx, deltaY: dy }] });
  return { scrolled: { x: dx, y: dy } };
}

async function browserWait(selector, timeoutMs) {
  const token = await ensureSession();
  const start = Date.now();
  const deadline = Math.min(20000, Math.max(200, Number(timeoutMs) || 5000));
  while (Date.now() - start < deadline) {
    const snap = await call({ action: 'snapshot', token, tab: TAB });
    if (selector && /data-reach-ref/i.test(selector)) {
      const refs = numberedRefs(snap.html || '');
      if (refs.some((r) => selector === '[data-reach-ref="' + r.ref + '"]')) return { waited: Date.now() - start, selector };
    }
    if (snap.html && snap.html.includes(selector)) return { waited: Date.now() - start, selector };
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error('Timed out after ' + Math.round((Date.now() - start) / 1000) + 's waiting for ' + selector + '.');
}

async function browserBack() {
  const token = await ensureSession();
  await call({ action: 'back', token, tab: TAB });
  return snapshotRefText();
}

async function browserConsole() {
  const token = await ensureSession();
  const data = await call({ action: 'console', token, tab: TAB });
  return formatConsole(data);
}

async function browserNetwork() {
  const token = await ensureSession();
  const data = await call({ action: 'network', token, tab: TAB });
  return formatNetwork(data);
}

async function browserScreenshot() {
  const token = await ensureSession();
  const data = await call({ action: 'snapshot', token, tab: TAB });
  // The engine snapshot returns an `image` already on its own.
  if (!data || typeof data.image !== 'string' || !data.image) return { image: null, note: 'no image returned by engine' };
  if (data.image.length > MAX_IMAGE_BYTES) return { image: null, note: 'screenshot too large to embed' };
  return { image: data.image, title: String(data.title || '').slice(0, 200), url: String(data.url || '').slice(0, 800) };
}

async function browserClose() {
  if (!sessionToken) return { closed: true, note: 'no session was active' };
  const tok = sessionToken;
  sessionToken = null;
  await call({ action: 'close_session', token: tok }).catch(() => {});
  return { closed: true };
}

/* Format the console-log ring into a bounded text block, ordered with errors
 * first. The model uses this to diagnose a broken page; raw stack strings are
 * kept verbatim because they usually point at the line that needs fixing. */
function formatConsole(data) {
  const entries = Array.isArray(data && data.logs) ? data.logs : [];
  if (!entries.length) return 'No console messages captured since the page loaded.';
  const priority = (level) => ({ error: 0, warning: 1, warn: 1, log: 2, info: 2, debug: 3 }[String(level || '').toLowerCase()] ?? 2);
  const ordered = entries.slice().sort((a, b) => priority(a.level) - priority(b.level));
  const rows = ordered.slice(-50).map((e) => formatRow(e));
  return rows.join('\n');
}

function formatRow(e) {
  const lvl = String(e.level || 'log').toLowerCase();
  const text = String(e.text || '').slice(0, 800);
  const line = Number.isFinite(e.line) ? ':' + e.line : '';
  const src = String(e.source || '').slice(0, 200);
  return '[' + lvl + ']' + line + (src ? ' ' + src : '') + ' ' + text;
}

function formatNetwork(data) {
  const entries = Array.isArray(data && data.requests) ? data.requests : [];
  if (!entries.length) return 'No network requests captured.';
  const rows = entries.slice(-60).map((e) => {
    const status = Number.isFinite(e.status) ? String(e.status) : (e.error ? 'ERR' : '—');
    return '[' + status + '] ' + String(e.method || 'GET') + ' ' + String(e.url || '').slice(0, 220) + ' (' + String(e.type || 'other') + ')';
  });
  return rows.join('\n');
}

/* Format the result of any browser_* verb as a string the model sees, plus a
 * structured payload for the webview to render (e.g. an embedded screenshot).
 * The callable named `runBrowserAction` is what `extension.js` dispatches on. */
async function runBrowserAction(msg) {
  const action = String(msg.action || '');
  if (!action.startsWith('browser_')) throw new Error('Not a browser tool: ' + action);
  let result;
  switch (action) {
    case 'browser_open': result = await browserOpen(msg.url, msg.width, msg.height); break;
    case 'browser_snapshot': result = await browserSnapshot(); break;
    case 'browser_click': result = await browserClick(msg.ref, msg.selector); break;
    case 'browser_type': result = await browserType(msg.ref, msg.selector, msg.text, msg.submit); break;
    case 'browser_press': result = await browserPress(msg.browserKey || msg.key, msg.ref, msg.selector); break;
    case 'browser_scroll': result = await browserScroll(msg.x, msg.y); break;
    case 'browser_wait': result = await browserWait(msg.selector, msg.timeout); break;
    case 'browser_back': result = await browserBack(); break;
    case 'browser_console': result = await browserConsole(); break;
    case 'browser_network': result = await browserNetwork(); break;
    case 'browser_screenshot': result = await browserScreenshot(); break;
    case 'browser_close': result = await browserClose(); break;
    default: throw new Error('Unsupported browser tool: ' + action);
  }
  return renderForModel(action, result);
}

function renderForModel(action, result) {
  const lines = [];
  const text = (value, fallback) => String(value === undefined || value === null ? (fallback || '') : value);
  if (action === 'browser_open') {
    lines.push('Opened: ' + text(result.url));
    lines.push('Title: ' + text(result.title));
    lines.push('--- Page text ---');
    lines.push(text(result.text, '').slice(0, SNAPSHOT_BUDGET));
    lines.push('--- Interactive refs ---');
    lines.push(text(result.refsBlock));
  } else if (action === 'browser_snapshot') {
    lines.push('Snapshot: ' + text(result.url));
    lines.push('Title: ' + text(result.title));
    lines.push('--- Page text ---');
    lines.push(text(result.text, '').slice(0, SNAPSHOT_BUDGET));
    lines.push('--- Interactive refs ---');
    lines.push(text(result.refsBlock));
  } else if (action === 'browser_click' || action === 'browser_type' || action === 'browser_press') {
    lines.push('Done.');
    lines.push(JSON.stringify(result, null, 2));
  } else if (action === 'browser_wait') {
    lines.push(JSON.stringify(result));
  } else if (action === 'browser_scroll') {
    lines.push('Scrolled ' + JSON.stringify(result.scrolled));
  } else if (action === 'browser_back') {
    lines.push('Back: ' + text(result.url));
    lines.push('Title: ' + text(result.title));
    lines.push('--- Page text ---');
    lines.push(text(result.text, '').slice(0, SNAPSHOT_BUDGET));
  } else if (action === 'browser_console' || action === 'browser_network') {
    lines.push(typeof result === 'string' ? result : JSON.stringify(result));
  } else if (action === 'browser_screenshot') {
    lines.push('Screenshot taken.');
  } else if (action === 'browser_close') {
    lines.push('Browser session closed.');
  }
  return { text: lines.join('\n').trim() + '\n', image: (action === 'browser_screenshot' && result && result.image) ? result.image : null,
    payload: { action, ...result } };
}

function __resetForTest() {
  sessionToken = null;
  sessionRefCount = 0;
}

module.exports = { runBrowserAction, __resetForTest,
  // exported for direct unit tests
  browserOpen, browserSnapshot, browserClick, browserType, browserPress,
  browserScroll, browserWait, browserBack, browserConsole, browserNetwork,
  browserScreenshot, browserClose, renderForModel, numberedRefs };
