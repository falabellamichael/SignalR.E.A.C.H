/* SignalR.E.A.C.H web search + page fetching (shared by the extension host).
 * Zero-dependency by default: DuckDuckGo HTML scraping + plain HTTP page
 * fetching with tag-stripping. If the optional `playwright` module is
 * installed in the extension folder, page fetching upgrades to a real
 * headless browser (renders JS pages, better extraction).
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

async function pageTextWithPlaywright(url, timeoutMs = 15000) {
  if (!playwright) return null;
  let browser = null;
  try {
    browser = await playwright.chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.goto(url, { timeout: timeoutMs, waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1200);
    const text = await page.evaluate(() => {
      // readability-lite: drop nav/footer/script noise
      const kill = document.querySelectorAll('script,style,nav,footer,header,aside,iframe');
      kill.forEach((n) => n.remove());
      return (document.body && document.body.innerText) || '';
    });
    return text.replace(/\s+/g, ' ').trim();
  } catch (e) {
    return null;
  } finally {
    if (browser) { try { await browser.close(); } catch (e) { /* noop */ } }
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

module.exports = {
  webSearchDdg,
  searchAndFetch,
  pageText,
  stripTags,
  hasPlaywright: !!playwright,
};
