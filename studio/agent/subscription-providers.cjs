'use strict';

// Native subscription clients own OAuth, credential storage and renewal.
// Studio never reads their credential files or automates provider webpages.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const ROOT = 'http://127.0.0.1:20777/_reach/login-providers/';
const PROVIDERS = ['devin', 'codex'];
const label = provider => provider === 'codex' ? 'Codex' : 'Devin';

function subscriptionRoute(value) {
  const match = /^(devin|codex)\/(models|chat\/completions)$/.exec(String(value).startsWith(ROOT) ? String(value).slice(ROOT.length) : '');
  return match ? { provider: match[1], action: match[2] } : null;
}

function executable(provider, env = process.env, platform = process.platform, home = os.homedir()) {
  if (!PROVIDERS.includes(provider)) throw new Error('Unknown subscription provider.');
  const candidates = [];
  if (platform === 'win32') {
    if (provider === 'devin' && env.LOCALAPPDATA) candidates.push(path.join(env.LOCALAPPDATA, 'devin/cli/bin/devin.exe'));
    if (provider === 'codex' && env.APPDATA) {
      const npm = path.join(env.APPDATA, 'npm/node_modules/@openai/codex/node_modules/@openai');
      for (const [pkg, triple] of [['codex-win32-x64', 'x86_64-pc-windows-msvc'], ['codex-win32-arm64', 'aarch64-pc-windows-msvc']]) {
        candidates.push(path.join(npm, pkg, 'vendor', triple, 'bin/codex.exe'));
      }
    }
  } else {
    candidates.push(path.join(home, '.local/bin', provider), path.join('/opt/homebrew/bin', provider), path.join('/usr/local/bin', provider));
  }
  for (const dir of String(env.PATH || env.Path || '').split(path.delimiter).filter(Boolean)) {
    candidates.push(path.join(dir, provider + (platform === 'win32' ? '.exe' : '')));
  }
  for (const file of candidates) { try { if (fs.statSync(file).isFile()) return file; } catch {} }
  throw new Error(`Install ${label(provider)} CLI to connect this subscription, then restart Studio.`);
}

function createSubscriptionProviders({ spawnImpl = spawn, resolveExecutable = executable } = {}) {
  const flows = new Map(), cache = new Map(), children = new Set();
  function launch(provider, args, options = {}) {
    const env = { ...process.env };
    // These connections must use the signed-in subscription, never an API key
    // inherited from the desktop's environment.
    for (const key of ['OPENAI_API_KEY', 'CODEX_API_KEY', 'CODEX_ACCESS_TOKEN', 'WINDSURF_API_KEY', 'DEVIN_API_KEY', 'ELECTRON_RUN_AS_NODE']) delete env[key];
    const child = spawnImpl(resolveExecutable(provider), args, {
      cwd: os.tmpdir(), windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'], env, ...options,
    });
    children.add(child);
    child.once('close', () => children.delete(child));
    return child;
  }
  function run(provider, args, { signal, timeout = 30000, input = '', cwd = os.tmpdir() } = {}) {
    signal?.throwIfAborted();
    return new Promise((resolve, reject) => {
      let child, output = '', diagnostic = '', settled = false;
      const finish = (error, result) => {
        if (settled) return;
        settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
        if (error) { child?.kill(); reject(error); } else resolve(result);
      };
      const abort = () => finish(signal.reason || new Error('Subscription request cancelled.'));
      const timer = setTimeout(() => finish(new Error(`${label(provider)} request timed out.`)), timeout);
      try { child = launch(provider, args, { cwd }); } catch (error) { finish(error); return; }
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) { abort(); return; }
      child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
      child.stdout.on('data', value => { output += value; if (output.length > 16 * 1024 * 1024) finish(new Error('Subscription output exceeded its limit.')); });
      child.stderr.on('data', value => { diagnostic = (diagnostic + value).slice(-8192); });
      child.once('error', () => finish(new Error(`${label(provider)} CLI could not start.`)));
      child.once('close', code => finish(null, { code, output, diagnostic }));
      child.stdin.on('error', () => {}); child.stdin.end(input);
    });
  }
  async function status(provider, signal) {
    if (!PROVIDERS.includes(provider)) throw new Error('Unknown subscription provider.');
    const flow = flows.get(provider);
    if (flow?.status === 'pending' || flow?.status === 'error') return { ...flow };
    const result = await run(provider, provider === 'codex' ? ['login', 'status'] : ['auth', 'status'], { signal });
    const text = result.output + '\n' + result.diagnostic;
    const connected = result.code === 0 && (provider === 'codex' ? /Logged in using ChatGPT/i : /Logged in \(via Devin\)/i).test(text);
    return { status: connected ? 'connected' : 'signed-out', provider };
  }
  function signIn(provider) {
    if (!PROVIDERS.includes(provider)) throw new Error('Unknown subscription provider.');
    if (flows.get(provider)?.status === 'pending') return { ok: true, status: 'pending' };
    // The official login commands open the system browser and complete their
    // own localhost OAuth callback. No URL, auth code or token reaches the UI.
    resolveExecutable(provider);
    flows.set(provider, { provider, status: 'pending' }); cache.delete(provider);
    void run(provider, provider === 'codex' ? ['login'] : ['auth', 'login'], { timeout: 10 * 60 * 1000 })
      .then(result => {
        if (result.code !== 0) throw new Error('Sign-in did not complete. Try again.');
        flows.delete(provider);
      }).catch(() => flows.set(provider, { provider, status: 'error', err: 'Sign-in did not complete. Try again.' }));
    return { ok: true, status: 'pending' };
  }
  async function models(provider, signal) {
    const auth = await status(provider, signal);
    if (auth.status !== 'connected') throw new Error(`Sign in to ${label(provider)} in Settings → Connections first.`);
    const old = cache.get(provider);
    if (old && old.until > Date.now()) return old.models;
    const result = await run(provider, provider === 'codex' ? ['debug', 'models'] : ['models'], { signal });
    if (result.code !== 0) throw new Error(`${label(provider)} could not list subscription models. Check your sign-in.`);
    let ids;
    if (provider === 'codex') {
      let data;
      try { data = JSON.parse(result.output); } catch { throw new Error('Codex returned an invalid model catalog.'); }
      ids = (Array.isArray(data) ? data : data.models || []).filter(m => m.visibility !== 'hide').map(m => m.slug);
    } else {
      ids = result.output.split(/\r?\n/).filter(line => /^\s{2,}\S/.test(line) && !/^\s*aliases:/.test(line))
        .map(line => line.trim().split(/\s+/)[0]).filter(id => /^[\w.-]+$/.test(id));
    }
    ids = [...new Set(ids.filter(id => typeof id === 'string' && /^[\w.-]+$/.test(id)))];
    if (!ids.length) throw new Error(`${label(provider)} returned no subscription models.`);
    const rows = [{ id: `${provider}-chat`, name: `${label(provider)} · default model` }, ...ids.map(id => ({ id, name: id }))]
      .map(row => ({ ...row, capabilities: { outputTokenLimit: false, automaticOutput: true, jsonSchema: false } }));
    cache.set(provider, { until: Date.now() + 60000, models: rows });
    return rows;
  }
  async function devinChat(prompt, model, signal, onText, cwd) {
    // Studio owns all file/tool execution. The native client is a model
    // transport here; disable its local tools and reject ACP permissions.
    const config = path.join(cwd, 'client.json');
    fs.writeFileSync(config, JSON.stringify({ subagents_enabled: false,
      permissions: { deny: ['read', 'edit', 'grep', 'glob', 'exec', 'mcp__*', 'Fetch(*)'] },
      read_config_from: Object.fromEntries(['agents_standard', 'cursor', 'windsurf', 'claude', 'copilot', 'codex', 'kiro', 'opencode', 'zed', 'cloud'].map(k => [k, false])),
    }));
    const args = ['--config', config, 'acp'];
    if (model !== 'devin-chat') args.push('--model', model);
    const child = launch('devin', args, { cwd });
    return new Promise((resolve, reject) => {
      let buffer = '', phase = 0, settled = false, size = 0, answerLength = 0;
      const send = msg => { if (!child.stdin.destroyed) child.stdin.write(JSON.stringify(msg) + '\n'); };
      const done = error => {
        if (settled) return; settled = true;
        clearTimeout(timer); signal?.removeEventListener('abort', abort);
        const finish = () => { if (error) reject(error); else resolve(); };
        if (child.exitCode !== null || child.signalCode) finish();
        else { child.once('close', finish); child.kill(); }
      };
      const abort = () => done(signal.reason || new Error('Subscription request cancelled.'));
      const timer = setTimeout(() => done(new Error('Devin request timed out.')), 600000);
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) { abort(); return; }
      child.stdin.on('error', () => {}); child.stderr.resume(); child.stdout.setEncoding('utf8');
      child.once('error', () => done(new Error('Devin CLI could not start.')));
      child.once('close', () => done(new Error('Devin ended before completing its response.')));
      child.stdout.on('data', chunk => {
        buffer += chunk; size += chunk.length;
        if (buffer.length > 4 * 1024 * 1024 || size > 32 * 1024 * 1024) return done(new Error('Devin output exceeded its limit.'));
        let end;
        while (!settled && (end = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
          let msg; try { msg = JSON.parse(line); } catch { continue; }
          if (msg.method && msg.id !== undefined) {
            send(msg.method === 'session/request_permission'
              ? { jsonrpc: '2.0', id: msg.id, result: { outcome: { outcome: 'cancelled' } } }
              : { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Studio handles tools separately.' } });
          } else if (msg.id === phase) {
            if (msg.error) return done(new Error('Devin rejected the subscription request. Check sign-in and model access.'));
            if (phase === 0) { phase = 1; send({ jsonrpc: '2.0', id: 1, method: 'session/new', params: { cwd, mcpServers: [] } }); }
            else if (phase === 1) {
              if (!msg.result?.sessionId) return done(new Error('Devin did not create a session.'));
              phase = 2; send({ jsonrpc: '2.0', id: 2, method: 'session/prompt', params: { sessionId: msg.result.sessionId, prompt: [{ type: 'text', text: prompt }] } });
            } else if (phase === 2) {
              return done(msg.result?.stopReason === 'end_turn' && answerLength ? null : new Error('Devin stopped before finishing its answer.'));
            }
          } else if (msg.method === 'session/update') {
            const update = msg.params?.update;
            if (update?.sessionUpdate === 'agent_message_chunk' && update.content?.type === 'text') {
              answerLength += update.content.text.length; onText(update.content.text);
            }
          }
        }
      });
      send({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } } });
    });
  }
  async function chat(provider, body, signal, onText) {
    signal?.throwIfAborted();
    if (!Array.isArray(body.messages) || body.messages.some(m => typeof m.content !== 'string')) throw new Error('Subscription connections currently accept text messages only.');
    const available = await models(provider, signal);
    const model = body.model || `${provider}-chat`;
    if (!available.some(row => row.id === model)) throw new Error(`Choose an available ${label(provider)} subscription model.`);
    const prompt = body.messages.map(m => `${m.role}:\n${m.content}`).join('\n\n');
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'reach-subscription-'));
    try {
      if (provider === 'devin') return await devinChat(prompt, model, signal, onText, cwd);
      const out = path.join(cwd, 'answer.txt');
      const args = ['exec', '--ignore-user-config', '--ignore-rules', '--ephemeral', '--skip-git-repo-check',
        '-s', 'read-only', '--disable', 'shell_tool', '--disable', 'unified_exec', '--disable', 'multi_agent', '--disable', 'plugins',
        '-C', cwd, '-o', out];
      if (model !== 'codex-chat') args.push('-m', model);
      args.push('-');
      const result = await run(provider, args, { signal, cwd, input: prompt, timeout: 600000 });
      if (result.code !== 0) throw new Error('Codex could not complete the subscription request. Check sign-in, model access and usage limits.');
      const answer = fs.readFileSync(out, 'utf8').trim();
      if (!answer) throw new Error('Codex returned no answer.');
      onText(answer);
    } finally {
      // This directory was created above, never supplied by a caller.
      await fs.promises.rm(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  }
  async function request(url, options = {}) {
    options.signal?.throwIfAborted();
    const route = subscriptionRoute(url);
    if (!route) throw new Error('Unknown subscription route.');
    const { provider, action } = route;
    const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
    if (action === 'models') {
      try { return json({ object: 'list', catalog: 'login-providers', data: await models(provider, options.signal) }); }
      catch (error) { if (options.signal?.aborted) throw error; return json({ error: { message: error.message } }, 503); }
    }
    if (options.method !== 'POST') return json({ error: { message: 'POST required.' } }, 405);
    let body; try { body = JSON.parse(options.body); } catch { return json({ error: { message: 'Invalid subscription request.' } }, 400); }
    if (body.tools?.length) return json({ error: { message: 'Native function calling tools are not supported by this subscription transport. Use Studio actions.' } }, 400);
    if (body.response_format) return json({ error: { message: 'response_format is not supported by this subscription transport.' } }, 400);
    if (!body.stream) {
      try { let text = ''; await chat(provider, body, options.signal, delta => { text += delta; });
        return json({ choices: [{ message: { role: 'assistant', content: text }, finish_reason: 'stop' }] });
      } catch (error) { if (options.signal?.aborted) throw error; return json({ error: { message: error.message } }, 503); }
    }
    const controller = new AbortController();
    const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(sink) {
        const event = value => { if (!signal.aborted) sink.enqueue(encoder.encode('data: ' + JSON.stringify(value) + '\n\n')); };
        void chat(provider, body, signal, delta => event({ choices: [{ delta: { content: delta }, finish_reason: null }] }))
          .then(() => event({ choices: [{ delta: {}, finish_reason: 'stop' }] }))
          .catch(error => { if (!signal.aborted) event({ error: { message: error.message } }); })
          .finally(() => { if (!signal.aborted) { sink.enqueue(encoder.encode('data: [DONE]\n\n')); sink.close(); } });
        signal.addEventListener('abort', () => { try { sink.error(signal.reason); } catch {} }, { once: true });
      },
      cancel() { controller.abort(); },
    });
    return new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } });
  }
  function close() { for (const child of children) child.kill(); children.clear(); }
  return { status, signIn, models, request, close };
}

module.exports = { subscriptionRoute, executable, createSubscriptionProviders };
