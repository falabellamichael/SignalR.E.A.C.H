/* Local connection to the published SignalREACH service. No hosting credentials. */
const http = require('node:http');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const POINTER = 'https://gist.githubusercontent.com/falabellamichael/e261e0c31ad08c373bcd667b6982847a/raw/simple-reach-endpoint.txt';

// A page in the user's browser also reaches this bridge from 127.0.0.1, and CORS
// is open, so a configured key must only ever be used for a genuine local
// program: no Origin (browsers always send one on POST) and a loopback Host
// (a DNS-rebinding page carries its own domain there).
const LOOPBACK_HOST = /^(localhost|127(?:\.\d{1,3}){3}|\[::1\])(:\d+)?$/i;
const isLocalCaller = req => !req.headers.origin && LOOPBACK_HOST.test(req.headers.host || '');

function createClient({ fetchImpl = fetch, pointer = POINTER, now = Date.now, key = process.env.REACH_KEY || '' } = {}) {
  const accessKey = String(key).trim();
  let endpoint, expires = 0, resolving;
  async function resolveEndpoint() {
    if (endpoint && now() < expires) return endpoint;
    if (!resolving) resolving = (async () => {
      const response = await fetchImpl(pointer, { signal: AbortSignal.timeout(15000) });
      if (!response.ok) throw new Error('Endpoint pointer HTTP ' + response.status);
      const url = new URL((await response.text()).trim());
      if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash)
        throw new Error('The published endpoint must be an HTTPS URL without credentials.');
      endpoint = url.href.replace(/\/$/, '').replace(/\/v1$/, '');
      expires = now() + 60000;
      return endpoint;
    })().finally(() => { resolving = null; });
    return resolving;
  }
  function json(res, status, body) {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  }
  return http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Reach-Key');
    res.setHeader('Access-Control-Expose-Headers', 'Retry-After');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
    const route = new URL(req.url, 'http://localhost').pathname.replace(/\/$/, '');
    const isTest = route === '/_reach/test' && ['GET', 'POST'].includes(req.method);
    const isStatus = ['/health', '/status'].includes(route) && req.method === 'GET';
    const isModels = ['/v1/models', '/models'].includes(route) && req.method === 'GET';
    const isChat = route === '/v1/chat/completions' && req.method === 'POST';
    const isPointer = route === '/public-url' && req.method === 'GET';
    if (!(isTest || isStatus || isModels || isChat || isPointer)) {
      json(res, route.startsWith('/_reach/') ? 403 : 404, {
        error: route.startsWith('/_reach/')
          ? 'Hosting controls and detailed logs are available on the SignalREACH host.' : 'Not found',
      });
      return;
    }
    const abort = new AbortController();
    // No timeout on chat: a real agent turn can run far longer than any fixed
    // budget, and killing it mid-generation loses the whole response. The
    // request is aborted only when the client goes away.
    res.on('close', () => { if (!res.writableEnded) abort.abort(); });
    try {
      const base = await resolveEndpoint();
      if (isPointer) { json(res, 200, { public_url: base, source: 'published endpoint' }); return; }
      let body;
      if (isChat) {
        const parts = []; let size = 0;
        for await (const chunk of req) {
          size += chunk.length;
          if (size > 8 * 1024 * 1024) { json(res, 413, { error: 'Request exceeds 8 MB' }); return; }
          parts.push(chunk);
        }
        body = Buffer.concat(parts);
        try { JSON.parse(body.toString()); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
      } else if (isTest) {
        body = JSON.stringify({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'Reply with REACH_OK only.' }], max_tokens: 16, stream: false });
      }
      const headers = { 'ngrok-skip-browser-warning': '1' };
      if (body) headers['Content-Type'] = 'application/json';
      // Only the caller's endpoint credentials are forwarded; never local host secrets.
      if (req.headers.authorization) headers.Authorization = req.headers.authorization;
      if (req.headers['x-reach-key']) headers['X-Reach-Key'] = req.headers['x-reach-key'];
      // The hosted relay wants an sk-reach key. Supply the configured one for local
      // programs that did not bring their own.
      if (accessKey && !headers.Authorization && !headers['X-Reach-Key'] && isLocalCaller(req)) {
        headers.Authorization = 'Bearer ' + accessKey;
      }
      const started = now();
      const upstream = await fetchImpl(base + (isStatus ? '/health' : isModels ? '/v1/models' : '/v1/chat/completions'), {
        method: body ? 'POST' : 'GET', headers, body, signal: abort.signal,
      });
      if (isStatus || isTest) {
        const data = await upstream.json();
        if (isStatus) {
          if (!upstream.ok || data.service !== 'signalreach') throw new Error('SignalREACH health check failed (HTTP ' + upstream.status + ')');
          json(res, 200, { ...data, connection_mode: 'hosted', public_url: base, public_url_source: 'published endpoint' });
        } else {
          json(res, upstream.status, { ok: upstream.ok, latency_ms: now() - started, model: data.model,
            reply: data.choices?.[0]?.message?.content || '', error: data.error?.message || data.error });
        }
        return;
      }
      res.statusCode = upstream.status;
      res.setHeader('Content-Type', upstream.headers.get('content-type') || 'application/json');
      if (upstream.headers.has('retry-after')) res.setHeader('Retry-After', upstream.headers.get('retry-after'));
      if (upstream.body) await pipeline(Readable.fromWeb(upstream.body), res);
      else res.end();
    } catch (error) {
      if (!res.headersSent && !res.destroyed) json(res, 502, { error: { message: String(error.message || error) } });
      else res.destroy();
    } finally { /* nothing to clear: the request owns the abort signal */ }
  });
}

if (require.main === module) {
  const server = createClient();
  server.listen(20777, '127.0.0.1', () => console.log('SignalREACH endpoint connection listening on 127.0.0.1:20777'));
  server.on('error', error => { console.error(error.message); process.exit(1); });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => process.exit(0)));
}
module.exports = { createClient };
