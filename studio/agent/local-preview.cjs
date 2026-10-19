'use strict';

// Static previews live with Studio, independently of an agent's current turn.
// A shell command cannot do this: it waits for the server to exit before the
// agent can open the browser, and Stop kills the server along with the command.
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { fileURLToPath } = require('node:url');
const { resolveInProject } = require('./paths.cjs');

const servers = new Map();
const types = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2',
  '.ttf': 'font/ttf', '.wasm': 'application/wasm', '.mp4': 'video/mp4',
  '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.wav': 'audio/wav',
};

// Resolve symlinks (macOS /var -> /private/var) so a file URL compares against
// the real project root. Use the same resolver as the root (the native one
// expands Windows 8.3 names). A missing tail keeps its name under the real parent.
function realPath(candidate) {
  const resolved = path.resolve(candidate);
  try { return fs.realpathSync(resolved); } catch {
    const parent = path.dirname(resolved);
    return parent === resolved ? resolved : path.join(realPath(parent), path.basename(resolved));
  }
}

function previewPath(root, requested) {
  // No hidden files, Windows alternate data streams, or ambiguous separators.
  if (String(requested).split(/[\\/]/).some(part => part.startsWith('.') && part !== '.')
    || /[:\0]/.test(requested)) throw new Error('This path is not available to the static preview.');
  const resolved = resolveInProject(root, requested);
  if (path.relative(root, fs.realpathSync(resolved)).split(path.sep).some(part => part.startsWith('.'))) {
    throw new Error('Hidden files are not available to the static preview.');
  }
  return resolved;
}

function startServer(root) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const origin = `http://127.0.0.1:${server.address().port}`;
      const fail = code => { res.writeHead(code); res.end(http.STATUS_CODES[code]); };
      // Bind only to loopback; reject rebinding hosts and cross-site requests.
      if (req.headers.host !== new URL(origin).host
        || req.headers.origin && req.headers.origin !== origin
        || req.headers['sec-fetch-site'] === 'cross-site') return fail(403);
      if (!['GET', 'HEAD'].includes(req.method)) return fail(405);
      let target;
      try {
        const relative = decodeURIComponent(req.url.split(/[?#]/)[0].slice(1));
        if (relative.includes('\\') || relative.startsWith('/')) return fail(403);
        target = previewPath(root, relative || '.');
        if (fs.statSync(target).isDirectory()) {
          target = previewPath(root, path.join(relative, 'index.html'));
          if (relative && !relative.endsWith('/')) {
            res.writeHead(302, { Location: '/' + relative.split('/').map(encodeURIComponent).join('/') + '/' });
            return res.end();
          }
        }
        if (!fs.statSync(target).isFile()) return fail(404);
      } catch (error) { return fail(error.code === 'ENOENT' || error.code === 'ENOTDIR' ? 404 : 403); }
      res.writeHead(200, { 'Content-Type': types[path.extname(target).toLowerCase()] || 'application/octet-stream',
        'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      if (req.method === 'HEAD') return res.end();
      fs.createReadStream(target).on('error', () => res.destroy()).pipe(res);
    });
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.unref();
      resolve(server);
    });
  });
}

async function openPreview(args, ctx) {
  const settings = typeof ctx.getSettings === 'function' ? ctx.getSettings()
    : ctx.agentStore?.get(ctx.agentId)?.settings;
  if (settings?.features?.workspace === false) throw new Error('Workspace access is off. Enable it to preview project files.');
  ctx.signal?.throwIfAborted();
  if (!ctx.projectDir) throw new Error('Select a project directory before opening a local preview.');
  const root = fs.realpathSync(ctx.projectDir);
  let requested = args.path;
  if (/^file:/i.test(args.url || '')) requested = path.relative(root, realPath(fileURLToPath(args.url))) || '.';
  if (!requested) throw new Error('Use browser with op "preview" and a project-relative path, such as "coffee.html".');
  let target = previewPath(root, requested);
  if (fs.statSync(target).isDirectory()) target = previewPath(root, path.join(requested, 'index.html'));
  if (!fs.statSync(target).isFile()) throw new Error('The preview path must name a static file or a directory containing index.html.');
  let pending = servers.get(root);
  if (!pending) {
    pending = startServer(root);
    servers.set(root, pending);
    pending.catch(() => { if (servers.get(root) === pending) servers.delete(root); });
  }
  const server = await pending;
  ctx.signal?.throwIfAborted();
  const relative = path.relative(root, target).split(path.sep).map(encodeURIComponent).join('/');
  const url = `http://127.0.0.1:${server.address().port}/${relative}`;
  const result = await ctx.browserExecutor('open', { url, ...(args.tabId ? { tabId: args.tabId } : {}) }, ctx);
  return { ...result, previewUrl: url, previewPath: path.relative(root, target),
    preview: 'static', message: 'Static preview stays available until Studio closes. Source changes appear on reload; no shell server is needed.' };
}

async function closePreviews() {
  const pending = [...servers.values()];
  servers.clear();
  for (const result of await Promise.allSettled(pending)) {
    if (result.status !== 'fulfilled') continue;
    result.value.closeAllConnections();
    await new Promise(resolve => result.value.close(resolve));
  }
}

module.exports = { openPreview, closePreviews };
