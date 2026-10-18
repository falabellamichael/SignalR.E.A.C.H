'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const crypto = require('node:crypto');
const PORT = 21309;
function location() {
  const base = process.platform === 'win32' ? process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')
    : process.platform === 'darwin' ? path.join(os.homedir(), 'Library', 'Application Support') : process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(base, 'SignalREACH', 'user-settings.json');
}
function validate(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid settings.');
  const allowed = ['name', 'endpoint', 'model', 'temperature', 'maxTokens'];
  if (Object.keys(input).some(key => !allowed.includes(key))) throw new Error('Unsupported setting.');
  const url = new URL(input.endpoint);
  if (url.username || url.password || url.search || url.hash || !(url.protocol === 'https:' || url.protocol === 'http:' && ['localhost','127.0.0.1','[::1]'].includes(url.hostname))) throw new Error('Use HTTPS or a local HTTP endpoint without credentials.');
  if (typeof input.model !== 'string' || !input.model.trim() || input.model.length > 200) throw new Error('Enter a model ID (up to 200 characters).');
  if (!Number.isFinite(input.temperature) || input.temperature < 0 || input.temperature > 2) throw new Error('Temperature must be between 0 and 2.');
  if (!Number.isInteger(input.maxTokens) || input.maxTokens < 0 || input.maxTokens > 131072) throw new Error('Output tokens must be between 0 and 131072.');
  return { name: String(input.name || 'Shared connection').slice(0,60), endpoint: url.href.replace(/\/+$/, ''), model: input.model.trim(), temperature: input.temperature, maxTokens: input.maxTokens };
}
function read(file = location()) {
  try { const data = JSON.parse(fs.readFileSync(file, 'utf8')); return { revision: data.revision, syncEnabled: data.syncEnabled === true, settings: data.settings ? validate(data.settings) : null }; }
  catch { return null; }
}
function save(settings, file = location()) {
  const data = { revision: crypto.randomUUID(), syncEnabled: read(file)?.syncEnabled === true, settings: validate(settings) };
  return write(data, file);
}
function write(data, file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = file + '.' + crypto.randomUUID() + '.tmp';
  try { fs.writeFileSync(temp, JSON.stringify(data, null, 2), { mode: 0o600 }); fs.renameSync(temp, file); }
  finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
  return data;
}
function setSync(enabled, file = location()) {
  if (typeof enabled !== 'boolean') throw new Error('Sync must be on or off.');
  return write({ ...(read(file) || { settings: null }), revision: crypto.randomUUID(), syncEnabled: enabled }, file);
}
function watch(callback, file = location()) {
  let revision, busy = false;
  const poll = async () => {
    if (busy) return;
    const shared = read(file);
    if (!shared?.settings || !shared.syncEnabled || revision === shared.revision) return;
    busy = true;
    try { await callback(shared); revision = shared.revision; }
    catch (error) { console.warn('Settings sync failed:', error.message); }
    finally { busy = false; }
  };
  const timer = setInterval(poll, 1000);
  timer.unref();
  return { dispose: () => clearInterval(timer), poll };
}
function applyStudio(settings, shared) {
  if (!shared?.settings || !shared.syncEnabled || settings.hubRevision === shared.revision) return settings;
  const value = shared.settings;
  const list = [...(settings.connections || [])];
  // Preserve credentials only for the exact same endpoint, never across providers.
  const match = list.find(item => item.id !== 'reach-hosted' && item.endpoint?.replace(/\/+$/, '') === value.endpoint);
  const connection = { ...(match || {}), id: match?.id || 'reach-user-hub', name: value.name, endpoint: value.endpoint, model: value.model, accessKey: match?.accessKey || '' };
  const next = list.filter(item => item.id !== connection.id);
  next.push(connection);
  return { ...settings, connections: next, activeConnection: connection.id, endpoint: connection.endpoint, model: connection.model, accessKey: connection.accessKey,
    temperature: value.temperature, budgets: { ...settings.budgets, maxTokens: value.maxTokens }, hubRevision: shared.revision };
}
async function applyCode(vscode, context, shared = read()) {
  if (!shared?.settings || !shared.syncEnabled || context.globalState.get('reachHubRevision') === shared.revision) return;
  const cfg = vscode.workspace.getConfiguration('simplereach');
  const value = shared.settings;
  const endpoints = cfg.get('additionalEndpoints') || [];
  const changes = { additionalEndpoints: [...new Set([...endpoints, value.endpoint])], selectedEndpoint: value.endpoint,
    provider: 'endpoint', model: value.model, temperature: value.temperature, maxTokens: value.maxTokens };
  for (const [key, val] of Object.entries(changes)) await cfg.update(key, val, vscode.ConfigurationTarget.Global);
  await context.globalState.update('reachHubRevision', shared.revision);
}
function start({ file = location(), page = path.join(__dirname, 'settings-hub.html') } = {}) {
  const token = crypto.randomBytes(32).toString('hex');
  const origin = `http://127.0.0.1:${PORT}`;
  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
    const syncFrame = req.method === 'GET' && req.url === '/sync' && !req.headers['x-reach-hub'] && req.headers['sec-fetch-dest'] === 'iframe';
    if (req.headers.host !== `127.0.0.1:${PORT}` || req.headers.origin && req.headers.origin !== origin || req.headers['sec-fetch-site'] === 'cross-site' && !syncFrame) { res.writeHead(403).end(); return; }
    try {
      if (req.method === 'GET' && (req.url === '/' || req.url === '/sync' && !req.headers['x-reach-hub'])) {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        const html = req.url === '/sync' ? `<!doctype html><html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><style>body{font:14px sans-serif;padding:12px;color:#25382b;background:#f4f4ec}label{display:flex;gap:8px;align-items:center}p{line-height:1.5}input{width:18px;height:18px}</style><label><input type="checkbox" role="switch" id="sync">Sync Studio + VS Code</label><p id="status" role="status">Loading...</p><script>const token='${token}',toggle=document.querySelector('input'),status=document.querySelector('p');async function call(method,body){const r=await fetch('/sync',{method,headers:{'X-Reach-Hub':token,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});if(!r.ok)throw Error('Sync unavailable');return r.json()}function show(d){toggle.checked=d.syncEnabled;status.textContent=d.syncEnabled?'Saved settings automatically refresh both running clients.':'Sync is off. Client settings stay unchanged.'}call('GET').then(show).catch(e=>{toggle.disabled=true;status.textContent=e.message});toggle.onchange=async()=>{toggle.disabled=true;try{show(await call('POST',{enabled:toggle.checked}))}catch(e){toggle.checked=!toggle.checked;status.textContent=e.message}finally{toggle.disabled=false}};</script></html>` : fs.readFileSync(page, 'utf8').replace('__HUB_TOKEN__', token);
        if (req.url === '/sync') res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'self' http://localhost:* http://127.0.0.1:*; base-uri 'none'; form-action 'none'");
        res.end(html); return;
      }
      if (req.headers['x-reach-hub'] !== token) { res.writeHead(403).end(); return; }
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/sync' && req.method === 'GET') { res.end(JSON.stringify({ syncEnabled: read(file)?.syncEnabled === true })); return; }
      if (req.url === '/sync' && req.method === 'POST') {
        let body = ''; for await (const chunk of req) { body += chunk; if (body.length > 256) throw new Error('Invalid sync request.'); }
        res.end(JSON.stringify(setSync(JSON.parse(body).enabled, file))); return;
      }
      if (req.url === '/settings' && req.method === 'GET') { res.end(JSON.stringify(read(file))); return; }
      if (req.url === '/settings' && req.method === 'POST') {
        let body = '';
        for await (const chunk of req) { body += chunk; if (Buffer.byteLength(body) > 16384) throw new Error('Settings too large.'); }
        res.end(JSON.stringify(save(JSON.parse(body), file))); return;
      }
      res.writeHead(404).end('{}');
    } catch (error) { res.writeHead(400).end(JSON.stringify({ error: error.message })); }
  });
  // Studio and VS Code share the same service; whichever starts first hosts it.
  server.on('error', error => { if (error.code !== 'EADDRINUSE') console.warn('Settings hub unavailable:', error.message); });
  server.listen(PORT, '127.0.0.1');
  server.unref();
  return { dispose: () => server.close(), url: origin };
}
module.exports = { location, validate, read, save, setSync, watch, applyStudio, applyCode, start };
