/* SignalR.E.A.C.H web search + page fetching (shared by the extension host).
 * Zero-dependency by default: DuckDuckGo HTML scraping + plain HTTP page
 * fetching with tag-stripping. If the optional `playwright` module is
 * installed in the extension folder, page fetching upgrades to a real
 * headless browser (renders JS pages, better extraction, page snapshots).
 *
 * Browser lifecycle: ONE shared Chromium for the whole extension session,
 * launched lazily on first use and closed when idle for a while or on
 * extension deactivate (call disposeBrowser()). Every page gets its own
 * incognito-style context, so cookies never leak between browses. Browsing
 * is serialized through a small queue so parallel tool calls can't race the
 * same browser.
 */

let playwright = null;
try {
  // eslint-disable-next-line global-require, import/no-unresolved
  playwright = require('playwright');
} catch (e) {
  playwright = null;
}

const DDG_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0';

/* Plain Chrome UA (no HeadlessChrome token) — some sites serve bot walls to
 * the default headless user agent. */
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const VIEWPORT = { width: 1280, height: 900 };
const SNAPSHOT_MAX_HEIGHT = 3600;   // cap full-page screenshots at ~2.8 viewports
const IDLE_CLOSE_MS = 5 * 60 * 1000; // shared browser closes after 5 min idle

/* ---- shared browser lifecycle ----------------------------------------- */

let browserPromise = null;
let idleTimer = null;
let browseQueue = Promise.resolve();

function launchBrowser() {
  if (!playwright) return Promise.reject(new Error('playwright not installed'));
  if (browserPromise) return browserPromise;
  browserPromise = playwright.chromium.launch({ headless: true })
    .catch((e) => {
      browserPromise = null; // failed launch is not cached — next call retries
      throw e;
    });
  return browserPromise;
}

async function disposeBrowser() {
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
  const p = browserPromise;
  browserPromise = null;
  if (p) {
    try { (await p).close(); } catch (e) { /* already gone */ }
  }
}

function touchIdleTimer() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => { disposeBrowser(); }, IDLE_CLOSE_MS);
  if (idleTimer.unref) idleTimer.unref();
}

/* Serialize browser work: returns a promise for fn()'s result. */
function withBrowseLock(fn) {
  const run = browseQueue.then(fn, fn);
  browseQueue = run.then(() => undefined, () => undefined);
  return run;
}

function isStaleBrowserError(e) {
  const m = String((e && e.message) || e);
  return /browser has been closed|target closed|websocket.*closed|connection closed|crash/i.test(m);
}

function isMissingBinaryError(e) {
  const m = String((e && e.message) || e);
  return /executable doesn't exist|playwright install|browserType.launch: executable/i.test(m);
}

/* ---- shared page helpers ---------------------------------------------- */

async function newIsolatedPage() {
  const browser = await launchBrowser();
  const context = await browser.newContext({ userAgent: BROWSER_UA, viewport: VIEWPORT });
  const page = await context.newPage();
  return { context, page };
}

/* Bounded settle: networkidle for up to ~3s, then a scroll pass that
 * triggers lazy-loaded content, then back to the top. */
async function settleAndScroll(page) {
  await page.waitForLoadState('networkidle', { timeout: 3000 }).catch(() => {});
  try {
    for (let i = 0; i < 3; i += 1) {
      await page.evaluate(() => {
        const h = Math.max(document.body ? document.body.scrollHeight : 0,
          document.documentElement ? document.documentElement.scrollHeight : 0);
        window.scrollTo(0, h);
      });
      await page.waitForTimeout(350);
    }
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(150);
  } catch (e) { /* page may have closed mid-scroll — extraction handles it */ }
}

/* readability-lite: drop nav/footer/script noise; prefer <main>/<article>
 * when present, else the whole body. */
async function extractMainText(page) {
  return page.evaluate(() => {
    const kill = document.querySelectorAll('script,style,noscript,svg,iframe,nav,footer,header,aside');
    kill.forEach((n) => n.remove());
    const roots = [];
    const main = document.querySelector('main')
      || document.querySelector('article')
      || document.querySelector('[role="main"]');
    if (main) roots.push(main);
    if (!roots.length) roots.push(document.body || document.documentElement);
    return roots.map((r) => (r.innerText || '').replace(/\u00a0/g, ' '))
      .join('\n')
      .replace(/[ \t]+/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  });
}

async function captureSnapshot(page) {
  try {
    const size = page.viewportSize() || VIEWPORT;
    const fullHeight = await page.evaluate(() => Math.max(
      document.body ? document.body.scrollHeight : 0,
      document.documentElement ? document.documentElement.scrollHeight : 0));
    let shot;
    if (fullHeight > SNAPSHOT_MAX_HEIGHT + 200) {
      shot = await page.screenshot({
        type: 'jpeg', quality: 70,
        clip: { x: 0, y: 0, width: size.width, height: SNAPSHOT_MAX_HEIGHT },
      });
    } else {
      shot = await page.screenshot({ type: 'jpeg', quality: 70, fullPage: true });
    }
    return shot.toString('base64');
  } catch (e) {
    return null;
  }
}

/* ---- HTTP fallback (no playwright) ------------------------------------ */

function stripTags(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#x27;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractLinks(html, baseUrl) {
  const links = [];
  const re = /<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    let href = m[1].trim();
    let text = stripTags(m[2]).slice(0, 120);
    if (!href || href.startsWith('#') || href.startsWith('javascript:')) continue;
    if (href.startsWith('/')) href = new URL(href, baseUrl).toString();
    if (!/^https?:\/\//i.test(href)) continue;
    links.push({ href, text });
  }
  return links;
}

async function httpGet(url, timeoutMs = 10000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': DDG_UA, 'Accept-Language': 'en-US,en;q=0.9' },
    });
    if (!resp.ok) return null;
    return await resp.text();
  } catch (e) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function webSearchDdg(query, maxResults = 5) {
  const url = 'https://html.duckduckgo.com/html/?q='
    + encodeURIComponent(query.slice(0, 200));
  const html = await httpGet(url);
  if (!html) return [];
  // DDG HTML results: <a class="result__a" href="...">title</a>
  // + <a class="result__snippet" ...>snippet</a>
  const results = [];
  const blockRe = /<div class="result[^"]*"[^>]*>[\s\S]*?<\/div>\s*<\/div>/gi;
  const blocks = html.match(blockRe) || [];
  for (const block of blocks) {
    const titleMatch = block.match(/<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i)
      || block.match(/<a[^>]*href="([^"]+)"[^>]*class="result__a"[^>]*>([\s\S]*?)<\/a>/i);
    if (!titleMatch) continue;
    const snippetMatch = block.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/i)
      || block.match(/<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/i);
    let href = titleMatch[1];
    if (href.startsWith('//')) href = 'https:' + href;
    const ddgRedirect = /uddg=([^&]+)/.exec(href);
    if (ddgRedirect) href = decodeURIComponent(ddgRedirect[1]);
    if (!/^https?:\/\//i.test(href)) continue;
    results.push({
      title: stripTags(titleMatch[2]).slice(0, 140),
      url: href,
      snippet: stripTags(snippetMatch ? snippetMatch[1] : '').slice(0, 300),
    });
    if (results.length >= maxResults) break;
  }
  return results;
}

/* ---- page text (searchAndFetch uses this) ----------------------------- */

async function pageTextWithPlaywright(url, timeoutMs = 15000) {
  if (!playwright) return null;
  try {
    return await withBrowseLock(async () => {
      const { context, page } = await newIsolatedPage();
      try {
        const response = await page.goto(url, { timeout: timeoutMs, waitUntil: 'domcontentloaded' });
        if (response && response.status() >= 400) return 'HTTP ' + response.status();
        await settleAndScroll(page);
        return await extractMainText(page);
      } finally {
        await context.close().catch(() => {});
        touchIdleTimer();
      }
    });
  } catch (e) {
    if (isMissingBinaryError(e)) return null; // fall through to HTTP path
    if (isStaleBrowserError(e)) { await disposeBrowser(); return null; }
    return null;
  }
}

async function pageText(url, maxChars = 8000, timeoutMs = 15000) {
  const viaBrowser = await pageTextWithPlaywright(url, timeoutMs);
  if (viaBrowser) return viaBrowser.slice(0, maxChars);
  const html = await httpGet(url, timeoutMs);
  if (!html) return null;
  return stripTags(html).slice(0, maxChars);
}

async function searchAndFetch(query, maxResults = 5, pagesToRead = 2) {
  const results = await webSearchDdg(query, maxResults);
  const pages = [];
  for (let i = 0; i < results.length && i < pagesToRead; i += 1) {
    const text = await pageText(results[i].url);
    if (text) {
      pages.push({ title: results[i].title, url: results[i].url, text });
    }
  }
  return { results, pages };
}

/* ---- the REACH browser (browse tool) ---------------------------------- */

/* Render + screenshot one page with the shared browser. Returns
 * { ok, title, url, status, text, image, partial? } or { ok: false, error }. */
async function browseOnce(url, timeoutMs) {
  const { context, page } = await newIsolatedPage();
  try {
    let response = null;
    let navError = null;
    try {
      response = await page.goto(url, { timeout: timeoutMs, waitUntil: 'domcontentloaded' });
    } catch (e) {
      navError = e;
    }
    const status = response ? response.status() : 0;
    if (status >= 400) {
      return { ok: false, error: 'HTTP ' + status + ' for ' + url };
    }
    await settleAndScroll(page);
    const title = (await page.title().catch(() => '')).slice(0, 200) || url;
    const text = (await extractMainText(page)).slice(0, 12000);
    // A timed-out navigation can still leave readable partial content behind.
    if (navError && status === 0 && text.length < 80) throw navError;
    const image = await captureSnapshot(page);
    const finalUrl = page.url();
    const result = { ok: true, title, url: finalUrl, status, text, image };
    if (navError && status === 0) {
      result.partial = true;
      result.text = text + '\n\n(partial — the page did not finish loading)';
    }
    return result;
  } finally {
    await context.close().catch(() => {});
    touchIdleTimer();
  }
}

async function browsePage(url, timeoutMs = 15000) {
  // Render with Playwright; fall back to plain HTTP text extraction when
  // Playwright or its Chromium binary isn't available.
  if (!playwright) return httpBrowse(url, timeoutMs);
  let lastErr = null;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      return await withBrowseLock(() => browseOnce(url, timeoutMs));
    } catch (e) {
      lastErr = e;
      if (isMissingBinaryError(e)) return httpBrowse(url, timeoutMs);
      if (isStaleBrowserError(e)) {
        await disposeBrowser(); // launch fresh Chromium next attempt
        continue;
      }
      return { ok: false, error: String((e && e.message) || e) };
    }
  }
  return { ok: false, error: String((lastErr && lastErr.message) || lastErr) };
}

async function httpBrowse(url, timeoutMs) {
  const text = await pageText(url, 12000, timeoutMs);
  return text
    ? { ok: true, title: url, url, status: 0, text, image: null }
    : { ok: false, error: 'no readable content' };
}

/* Re-check after an on-demand install (one-click from the REACH Browser):
 * re-resolve the module and update this file's binding. Existing callers
 * keep working because browsePage et al. read the module-level variable. */
function refreshPlaywright() {
  try {
    // eslint-disable-next-line global-require
    delete require.cache[require.resolve('playwright')];
    // eslint-disable-next-line global-require
    playwright = require('playwright');
  } catch (e) {
    playwright = null;
  }
  return !!playwright;
}

function hasPlaywright() {
  return !!playwright;
}

module.exports = {
  webSearchDdg,
  searchAndFetch,
  pageText,
  browsePage,
  stripTags,
  disposeBrowser,
  refreshPlaywright,
  hasPlaywright,
};
