'use strict';

const DEFAULT_WEATHER_URL = 'https://www.theweathernetwork.com/en/city/ca/ontario/toronto/current';
function weatherUrl(value = DEFAULT_WEATHER_URL) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.hostname !== 'www.theweathernetwork.com' || url.port || url.username || url.password
      || !/^\/en\/city\/[a-z0-9-]+\/[a-z0-9-]+\/[a-z0-9-]+\/current\/?$/.test(url.pathname)) {
    throw new Error('Paste a current-weather city link from The Weather Network.');
  }
  url.search = ''; url.hash = '';
  return url.href;
}
function weatherText(html) {
  const text = html.replace(/^[\s\S]*?<body\b[^>]*>/i, '').replace(/<(script|style|svg|noscript)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ').replace(/&nbsp;|&#160;/g, ' ').replace(/&deg;|&#176;/g, '°').replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/\s+/g, ' ').trim();
  const start = text.indexOf('Current Weather');
  const faq = text.indexOf('Weather FAQ');
  if (start < 0) throw new Error('The Weather Network page did not include readable conditions. Open the source page to check it.');
  const current = text.slice(Math.max(0, start - 70), text.indexOf('Today’s Conditions', start) > start ? text.indexOf('Today’s Conditions', start) : start + 1500);
  const answers = faq >= 0 ? text.slice(faq, text.indexOf('News', faq) > faq ? text.indexOf('News', faq) : faq + 1800) : '';
  return (current.slice(0, 2400) + '\n' + answers.slice(0, 2400)).trim();
}
async function readWeather(config = {}, args = {}, signal) {
  if (config.enabled === false) throw new Error('The Weather Network connection is disabled.');
  const url = weatherUrl(args.url || config.url || DEFAULT_WEATHER_URL);
  const requestSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(20000)]) : AbortSignal.timeout(20000);
  let target = url, response;
  for (let redirects = 0; redirects < 4; redirects++) {
    response = await fetch(target, { redirect: 'manual', signal: requestSignal, headers: { 'User-Agent': 'SignalREACH-Studio/26.10 (weather reader)' } });
    if (![301, 302, 303, 307, 308].includes(response.status)) break;
    const next = new URL(response.headers.get('location') || '', target);
    if (weatherUrl(next.href) !== url) throw new Error('Weather page redirected to another location. Open the source page to check it.');
    await response.body?.cancel(); target = next.href;
  }
  if (!response.ok) throw new Error(`The Weather Network returned HTTP ${response.status}. Open the source page or try again.`);
  // Limit the public page size before parsing. No private or arbitrary URLs.
  const reader = response.body.getReader(); let size = 0; const parts = [];
  try { while (true) { const part = await reader.read(); if (part.done) break; size += part.value.byteLength; if (size > 8 * 1024 * 1024) throw new Error('Weather page is too large.'); parts.push(Buffer.from(part.value)); } }
  finally { await reader.cancel().catch(() => {}); }
  return { ok: true, source: 'The Weather Network', url, retrievedAt: new Date().toISOString(), text: weatherText(Buffer.concat(parts).toString('utf8')),
    note: 'Public website reading. Quote observation times from the page; retrieval time is not the observation time.' };
}
module.exports = { DEFAULT_WEATHER_URL, weatherUrl, readWeather };
