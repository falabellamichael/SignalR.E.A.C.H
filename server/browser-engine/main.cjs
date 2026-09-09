/* SignalREACH's isolated, offscreen Chromium engine.
 * The relay owns this process and speaks a private authenticated loopback
 * command API. There is no debugger endpoint,
 * and remote pages never enter SimpleRAG's DOM.
 */
'use strict';

const net = require('node:net');
const path = require('node:path');

const MAX_TABS = 8;
const MAX_LINE_BYTES = 256 * 1024;
const MODIFIERS = new Set(['shift', 'control', 'ctrl', 'alt', 'meta', 'command',
  'cmd', 'isKeypad', 'isAutoRepeat', 'leftButtonDown', 'middleButtonDown',
  'rightButtonDown', 'capsLock', 'numLock', 'left', 'right']);
const KEY_TYPES = new Set(['rawKeyDown', 'keyDown', 'keyUp', 'char']);
const MOUSE_TYPES = new Set(['mouseDown', 'mouseUp', 'mouseMove', 'mouseEnter',
  'mouseLeave', 'mouseWheel']);

function publicIp(address) {
  if (net.isIP(address) === 4) {
    const [a, b, c] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)) ||
        (b === 88 && c === 99))) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113));
  }
  if (net.isIP(address) !== 6 || address.includes('%') || address.includes('.')) return false;
  const parts = address.toLowerCase().split('::');
  const left = parts[0] ? parts[0].split(':') : [];
  const right = parts.length > 1 && parts[1] ? parts[1].split(':') : [];
  const words = [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill('0'), ...right]
    .map(value => parseInt(value, 16));
  // Only global unicast. Exclude protocol/transition and documentation ranges.
  return words[0] >= 0x2000 && words[0] <= 0x3fff &&
    !(words[0] === 0x2001 && words[1] < 0x200) &&
    !(words[0] === 0x2001 && words[1] === 0xdb8) &&
    words[0] !== 0x2002 && !(words[0] === 0x3fff && words[1] < 0x1000);
}

function isLoopbackHost(host) {
  if (host === 'localhost') return true;
  if (!net.isIP(host)) return false;
  if (net.isIP(host) === 4) return host.startsWith('127.');
  return host === '::1' || host === '0:0:0:0:0:0:0:1';
}

function parseUrl(value, sockets = false) {
  if (typeof value !== 'string' || !value || value.length > 8192 ||
      /[\x00-\x20\x7f\\]/.test(value)) throw new Error('Enter a valid HTTP or HTTPS URL.');
  let url;
  try { url = new URL(value); } catch (_) { throw new Error('Enter a valid HTTP or HTTPS URL.'); }
  if (!['http:', 'https:', ...(sockets ? ['ws:', 'wss:'] : [])].includes(url.protocol) ||
      !url.hostname || url.username || url.password) throw new Error('Only HTTP and HTTPS websites are supported.');
  const host = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!host || host.length > 253 || host.includes('%') ||
      (!isLoopbackHost(host) &&
        (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') ||
          (net.isIP(host) && !publicIp(host))))) throw new Error('Local and private addresses are blocked.');
  return { url: url.href, host };
}

function dimension(value, fallback, maximum) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 100 || value > maximum) throw new Error('Invalid browser viewport size.');
  return value;
}

function inputEvent(raw, width, height) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid input event.');
  const event = { type: raw.type };
  if (raw.modifiers !== undefined) {
    if (!Array.isArray(raw.modifiers) || raw.modifiers.length > 12 ||
        raw.modifiers.some(item => !MODIFIERS.has(item))) throw new Error('Invalid input modifiers.');
    event.modifiers = [...raw.modifiers];
  }
  if (KEY_TYPES.has(raw.type)) {
    if (typeof raw.keyCode !== 'string' || !raw.keyCode || raw.keyCode.length > 32 ||
        /[\x00]/.test(raw.keyCode)) throw new Error('Invalid keyboard key.');
    event.keyCode = raw.keyCode;
    return event;
  }
  if (!MOUSE_TYPES.has(raw.type)) throw new Error('Unsupported input event.');
  if (![raw.x, raw.y].every(Number.isFinite)) throw new Error('Invalid pointer coordinates.');
  event.x = Math.max(0, Math.min(width - 1, Math.round(raw.x)));
  event.y = Math.max(0, Math.min(height - 1, Math.round(raw.y)));
  if (raw.button !== undefined) {
    if (!['left', 'middle', 'right'].includes(raw.button)) throw new Error('Invalid pointer button.');
    event.button = raw.button;
  }
  if (raw.clickCount !== undefined) {
    if (!Number.isInteger(raw.clickCount) || raw.clickCount < 0 || raw.clickCount > 3) throw new Error('Invalid click count.');
    event.clickCount = raw.clickCount;
  }
  if (raw.type === 'mouseWheel') {
    for (const key of ['deltaX', 'deltaY']) {
      const value = raw[key] ?? 0;
      if (!Number.isFinite(value) || Math.abs(value) > 10000) throw new Error('Invalid scroll delta.');
      event[key] = value;
    }
    event.canScroll = true;
    event.hasPreciseScrollingDeltas = raw.hasPreciseScrollingDeltas !== false;
  }
  return event;
}

async function startEngine() {
  const { app, BrowserWindow, session } = require('electron');
  const bridgePort = Number(process.env.REACH_BROWSER_PORT || 0);
  const bridgeSecret = process.env.REACH_BROWSER_SECRET || '';
  const parentPid = Number(process.env.REACH_BROWSER_PARENT_PID || process.ppid);
  if (!Number.isInteger(bridgePort) || bridgePort < 1 || bridgePort > 65535 || bridgeSecret.length < 32) {
    throw new Error('Invalid private browser bridge configuration.');
  }
  const profileArg = process.argv.find(arg => arg.startsWith('--profile='));
  if (!profileArg || !path.isAbsolute(profileArg.slice(10))) throw new Error('An absolute --profile path is required.');
  app.setPath('userData', path.resolve(profileArg.slice(10)));
  app.setName('SignalREACH Browser');
  // Software offscreen rendering avoids GPU copies; Chromium's sandbox and all
  // web security features remain enabled.
  app.disableHardwareAcceleration();
  const tabs = new Map();
  let lastActivity = Date.now();
  let quitting = false;
  let pendingCommands = 0;
  function quit() {
    if (quitting) return;
    quitting = true;
    for (const tab of tabs.values()) if (!tab.win.isDestroyed()) tab.win.destroy();
    tabs.clear();
    app.quit();
  }
  app.on('window-all-closed', () => { /* tabs can all be closed while the relay stays connected */ });
  app.on('before-quit', () => { quitting = true; });
  app.on('web-contents-created', (_event, contents) => {
    contents.on('will-attach-webview', event => event.preventDefault());
    contents.on('select-bluetooth-device', (event, _devices, callback) => { event.preventDefault(); callback(''); });
  });
  app.on('certificate-error', (event, _contents, _url, _error, _certificate, callback) => {
    event.preventDefault(); callback(false);
  });
  app.on('login', (event, _contents, _details, _info, callback) => { event.preventDefault(); callback(); });
  await app.whenReady();
  if (quitting) return;
  const browserSession = session.fromPartition('signalreach-browser-' + process.pid, { cache: false });
  await browserSession.setProxy({ mode: 'direct' });
  browserSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  browserSession.setPermissionCheckHandler(() => false);
  browserSession.setDevicePermissionHandler(() => false);
  browserSession.on('will-download', (event, _item, contents) => {
    event.preventDefault();
    const tab = [...tabs.values()].find(item => item.win.webContents === contents);
    if (tab) tab.error = 'Downloads are not available in this browser pane.';
  });
  // Drop the Electron product token, keeping the actual Chromium version.
  browserSession.setUserAgent(browserSession.getUserAgent().replace(/\s(?:Electron|SignalREACH Browser|signalreach-browser)\/[^\s]+/g, ''));
  const resolving = new Map();
  async function publicUrl(value, sockets = false) {
    const parsed = parseUrl(value, sockets);
    if (net.isIP(parsed.host) || parsed.host === 'localhost') return parsed.url;
    let promise = resolving.get(parsed.host);
    if (!promise) {
      if (resolving.size >= 32) throw new Error('Too many website address lookups.');
      // Use Chromium's own resolver/cache, the same resolution path as the
      // subsequent request; do not trust an OS lookup made by another process.
      promise = browserSession.resolveHost(parsed.host, { cacheUsage: 'allowed' });
      resolving.set(parsed.host, promise);
      promise.finally(() => resolving.delete(parsed.host)).catch(() => {});
    }
    const result = await timeout(promise, 8000, 'Website address lookup timed out.');
    if (!result.endpoints.length || result.endpoints.some(item => !publicIp(item.address))) {
      throw new Error('Local and private addresses are blocked.');
    }
    return parsed.url;
  }
  browserSession.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, callback) => {
    // Non-network subresources such as data images and blob workers remain
    // local to the isolated Chromium renderer. They cannot navigate the tab.
    if (/^(data:|blob:|about:)/.test(details.url) && details.resourceType !== 'mainFrame') {
      callback({ cancel: false }); return;
    }
    if (details.url === 'about:blank') { callback({ cancel: false }); return; }
    publicUrl(details.url, true).then(() => callback({ cancel: false }), error => {
      if (details.resourceType === 'mainFrame') {
        const tab = [...tabs.values()].find(item => item.win.webContents.id === details.webContentsId);
        if (tab) tab.error = error.message;
      }
      callback({ cancel: true });
    });
  });

  function state(tab, since) {
    const contents = tab.win.webContents;
    const value = {
      tab: tab.id, url: contents.getURL() === 'about:blank' ? '' : contents.getURL(),
      title: contents.getTitle().slice(0, 200), loading: contents.isLoading(),
      canBack: contents.canGoBack(), canForward: contents.canGoForward(),
      sequence: tab.sequence, width: tab.width, height: tab.height,
      cursor: tab.cursor, error: tab.error, find: tab.find,
    };
    if (since !== undefined && tab.image && tab.sequence !== since) {
      if (tab.encodedSequence !== tab.sequence) {
        let frame = tab.image;
        const size = frame.getSize();
        if (size.width !== tab.width || size.height !== tab.height) {
          frame = frame.resize({ width: tab.width, height: tab.height, quality: 'good' });
        }
        tab.encodedImage = frame.toJPEG(78).toString('base64');
        tab.encodedSequence = tab.sequence;
      }
      value.image = tab.encodedImage;
    }
    return value;
  }
  function viewport(tab, message) {
    const width = dimension(message.width, tab.width, 2400);
    const height = dimension(message.height, tab.height, 1800);
    if (width !== tab.width || height !== tab.height) {
      tab.width = width; tab.height = height;
      tab.win.setContentSize(width, height);
      tab.image = null;
      tab.win.webContents.invalidate();
    }
  }
  function create(message) {
    if (typeof message.tab !== 'string' || !/^[A-Za-z0-9_-]{1,160}$/.test(message.tab)) throw new Error('Invalid browser tab.');
    if (tabs.has(message.tab)) return tabs.get(message.tab);
    if (tabs.size >= MAX_TABS) throw new Error('Close a browser tab before opening another.');
    const width = dimension(message.width, 1024, 2400);
    const height = dimension(message.height, 700, 1800);
    const win = new BrowserWindow({
      width, height, useContentSize: true, show: false, frame: false,
      autoHideMenuBar: true, title: 'SignalREACH Browser',
      webPreferences: {
        session: browserSession, offscreen: true, contextIsolation: true,
        nodeIntegration: false, sandbox: true, webSecurity: true,
        allowRunningInsecureContent: false, webviewTag: false,
        backgroundThrottling: false, spellcheck: false, disableDialogs: true,
      },
    });
    win.setMenu(null);
    const tab = { id: message.tab, win, width, height, sequence: 0, image: null,
      encodedSequence: -1, encodedImage: '', cursor: 'default', error: '',
      find: null, paused: false, contextText: '', pointer: { x: 0, y: 0 }, navigation: 0,
      mutationQueue: Promise.resolve() };
    tabs.set(tab.id, tab);
    const contents = win.webContents;
    contents.setFrameRate(15);
    contents.setWebRTCIPHandlingPolicy('disable_non_proxied_udp');
    contents.on('paint', (_event, _dirty, image) => {
      if (!tab.paused && !image.isEmpty()) { tab.image = image; tab.sequence += 1; }
    });
    contents.on('cursor-changed', (_event, cursor) => { tab.cursor = cursor; });
    contents.on('context-menu', (_event, params) => {
      tab.contextText = String(params.selectionText || params.linkText || params.titleText || '').slice(0, 16000);
    });
    contents.on('found-in-page', (_event, result) => {
      tab.find = { matches: result.matches, activeMatchOrdinal: result.activeMatchOrdinal,
        finalUpdate: result.finalUpdate };
    });
    contents.on('did-start-navigation', (_event, _url, _inPlace, isMainFrame) => {
      if (isMainFrame) { tab.error = ''; tab.find = null; tab.contextText = ''; }
    });
    contents.on('did-fail-load', (_event, code, description, _url, isMainFrame) => {
      if (isMainFrame && code !== -3) tab.error = tab.error || description;
    });
    contents.on('render-process-gone', (_event, detail) => {
      tab.error = 'The page stopped responding (' + detail.reason + '). Reload to try again.';
    });
    contents.on('will-navigate', (event, url) => {
      try { parseUrl(url); } catch (error) { event.preventDefault(); tab.error = error.message; }
    });
    contents.on('will-redirect', (event, url) => {
      try { parseUrl(url); } catch (error) { event.preventDefault(); tab.error = error.message; }
    });
    contents.setWindowOpenHandler(({ url, postBody }) => {
      // New-window links remain in the current browser tab. Never create a
      // visible native window or allow a page to choose Electron preferences.
      if (postBody) tab.error = 'This pop-up form requires a separate browser window.';
      else void publicUrl(url).then(validated => {
        if (!win.isDestroyed()) void contents.loadURL(validated).catch(() => {});
      }, error => { tab.error = error.message; });
      return { action: 'deny' };
    });
    contents.on('will-prevent-unload', event => event.preventDefault());
    contents.on('content-bounds-updated', event => event.preventDefault());
    win.on('closed', () => { if (tabs.get(tab.id) === tab) tabs.delete(tab.id); });
    contents.focus();
    void contents.loadURL('about:blank').catch(() => {});
    return tab;
  }
  async function command(message) {
    if (!message || typeof message !== 'object' || Array.isArray(message)) throw new Error('Invalid browser command.');
    lastActivity = Date.now();
    if (message.action === 'ping') return { ready: true, engine: 'Chromium', version: process.versions.chrome };
    if (message.action === 'pause' && !message.tab) {
      for (const tab of tabs.values()) { tab.paused = true; tab.win.webContents.stopPainting(); }
      return { ok: true };
    }
    if (message.action === 'close' && !tabs.has(message.tab)) return { ok: true };
    const tab = message.action === 'create' ? create(message) : tabs.get(message.tab);
    if (!tab || tab.win.isDestroyed()) throw new Error('Browser tab is closed.');
    const contents = tab.win.webContents;
    switch (message.action) {
      case 'create':
        if (!message.url) return state(tab);
        // A supplied initial URL follows exactly the navigation checks below.
      case 'navigate': {
        const url = await publicUrl(message.url);
        const navigation = ++tab.navigation;
        tab.error = '';
        void contents.loadURL(url).catch(error => {
          if (tab.navigation === navigation && error.errno !== -3 &&
              !/ERR_ABORTED/.test(error.message) && !tab.error && !contents.isDestroyed()) tab.error = error.message;
        });
        return state(tab);
      }
      case 'frame':
        viewport(tab, message);
        return state(tab, Number.isInteger(message.since) ? message.since : -1);
      case 'back': if (contents.canGoBack()) contents.goBack(); return state(tab);
      case 'forward': if (contents.canGoForward()) contents.goForward(); return state(tab);
      case 'reload': tab.error = ''; contents.reload(); return state(tab);
      case 'stop': contents.stop(); return state(tab);
      case 'input': {
        const events = message.events || (message.event ? [message.event] : null);
        if (!Array.isArray(events) || events.length < 1 || events.length > 64) throw new Error('Invalid input event batch.');
        const validated = events.map(event => inputEvent(event, tab.width, tab.height));
        contents.focus();
        for (const event of validated) {
          if (MOUSE_TYPES.has(event.type)) tab.pointer = { x: event.x, y: event.y };
          contents.sendInputEvent(event);
        }
        return state(tab);
      }
      case 'text':
        if (typeof message.text !== 'string' || message.text.length > 32768 || message.text.includes('\0')) throw new Error('Invalid text input.');
        contents.focus();
        await timeout(contents.insertText(message.text), 3000, 'Text input timed out.');
        return state(tab);
      case 'snapshot': {
        const result = await timeout(contents.executeJavaScript(`(() => {
          let selection = window.getSelection ? String(window.getSelection()) : '';
          const active = document.activeElement;
          if (active && /^(INPUT|TEXTAREA)$/.test(active.tagName) &&
              !/^(password|hidden|file)$/i.test(active.type || '') &&
              typeof active.selectionStart === 'number' && typeof active.selectionEnd === 'number') {
            selection = active.value.slice(active.selectionStart, active.selectionEnd);
          }
          const pointed = document.elementFromPoint(${tab.pointer.x}, ${tab.pointer.y});
          const paragraph = pointed && (pointed.closest('p,li,blockquote,pre,h1,h2,h3,h4,h5,h6,a') || pointed);
          return { url: location.href, title: document.title.slice(0, 200),
            text: (document.body ? document.body.innerText : '').slice(0, 160000),
            html: (document.documentElement ? document.documentElement.outerHTML : '').slice(0, 2000000),
            selection: selection.slice(0, 16000),
            contextText: (paragraph && paragraph.innerText || '').trim().slice(0, 16000) };
        })()`, false), 5000, 'The page did not respond.');
        result.contextText = tab.contextText || result.contextText;
        return result;
      }
      case 'find':
        if (typeof message.text !== 'string' || message.text.length > 500) throw new Error('Invalid find text.');
        tab.find = null;
        if (message.text) contents.findInPage(message.text, { forward: message.forward !== false, findNext: message.findNext === true });
        else contents.stopFindInPage('clearSelection');
        return state(tab);
      case 'pause': tab.paused = true; contents.stopPainting(); return state(tab);
      case 'resume': tab.paused = false; contents.startPainting(); contents.invalidate(); return state(tab);
      case 'close': tabs.delete(tab.id); tab.win.destroy(); return { ok: true };
      default: throw new Error('Unsupported browser command.');
    }
  }
  {
    const http = require('node:http');
    const crypto = require('node:crypto');
    const expectedAuthorization = Buffer.from('Bearer ' + bridgeSecret);
    const server = http.createServer((request, response) => {
      const reply = (status, body) => {
        if (response.destroyed || response.writableEnded) return;
        const encoded = JSON.stringify(body);
        response.writeHead(status, { 'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(encoded), 'Cache-Control': 'no-store',
          Connection: 'close' });
        response.end(encoded);
      };
      const authorization = Buffer.from(request.headers.authorization || '');
      if (request.headers.origin || request.headers.host !== '127.0.0.1:' + bridgePort ||
          authorization.length !== expectedAuthorization.length ||
          !crypto.timingSafeEqual(authorization, expectedAuthorization)) {
        reply(403, { error: 'Private browser connection required.' }); request.resume(); return;
      }
      if (request.method === 'GET' && request.url === '/status') {
        reply(200, { ready: true, engine: 'Chromium', version: process.versions.chrome }); return;
      }
      if (request.method !== 'POST' || request.url !== '/command') {
        reply(404, { error: 'Unknown browser route.' }); request.resume(); return;
      }
      if (pendingCommands >= 64) { reply(429, { error: 'Browser command queue is full.' }); request.resume(); return; }
      let size = 0;
      const chunks = [];
      request.on('data', chunk => {
        size += chunk.length;
        if (size <= MAX_LINE_BYTES) chunks.push(chunk);
      });
      request.on('end', () => {
        let message;
        try {
          if (size > MAX_LINE_BYTES) throw new Error('Browser command too large.');
          message = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (!message || (!Number.isSafeInteger(message.id) && !(typeof message.id === 'string' && message.id.length < 100))) {
            throw new Error('Invalid request ID.');
          }
        } catch (error) { reply(400, { error: error.message }); return; }
        pendingCommands += 1;
        const tab = tabs.get(message.tab);
        const ordered = !['frame', 'snapshot', 'ping', 'stop', 'close'].includes(message.action);
        const operation = tab && ordered ? tab.mutationQueue.then(() => command(message)) : command(message);
        if (tab && ordered) tab.mutationQueue = operation.catch(() => {});
        void operation.then(result => reply(200, { id: message.id, result }),
          error => reply(200, { id: message.id, error: error.message || 'Browser command failed.' }))
          .finally(() => { pendingCommands -= 1; });
      });
      request.on('error', () => {});
    });
    server.requestTimeout = 15000;
    server.headersTimeout = 10000;
    server.maxConnections = 32;
    server.on('error', error => { process.stderr.write('SignalREACH browser bridge: ' + error.code + '\n'); quit(); });
    server.listen(bridgePort, '127.0.0.1');
    app.on('before-quit', () => server.close());
  }
  setInterval(() => {
    if (Date.now() - lastActivity > 10 * 60 * 1000) return quit();
    if (Number.isSafeInteger(parentPid) && parentPid > 0) {
      try { process.kill(parentPid, 0); } catch (error) { if (error.code === 'ESRCH') quit(); }
    }
  }, 5000).unref();
}

function timeout(promise, milliseconds, message) {
  let timer;
  return Promise.race([promise, new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), milliseconds);
  })]).finally(() => clearTimeout(timer));
}

module.exports = { publicIp, parseUrl, dimension, inputEvent, startEngine };
// Electron's default app loader does not consistently assign require.main to
// a directly launched .cjs entry, so also recognize its browser process.
if (require.main === module || (process.versions.electron && process.type === 'browser')) {
  startEngine().catch(error => {
    process.stderr.write('SignalREACH browser: ' + error.message + '\n');
    process.exit(1);
  });
}
