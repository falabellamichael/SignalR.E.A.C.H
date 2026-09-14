'use strict';

const os = require('os');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execute = promisify(execFile);
const asArray = value => Array.isArray(value) ? value : [];
const number = value => value !== null && value !== undefined && Number.isFinite(Number(value)) ? Number(value) : null;
const sum = (items, key) => items.reduce((total, item) => total + (number(item[key]) || 0), 0);
const defaults = [
  { type: 'ollama', url: 'http://127.0.0.1:11434', enabled: true },
  { type: 'lmstudio', url: 'http://127.0.0.1:1234', enabled: true },
  { type: 'lemonade', url: 'http://127.0.0.1:8000/api/v1', enabled: true },
];
const providerNames = { ollama: 'Ollama', lmstudio: 'LM Studio', lemonade: 'Lemonade' };
function validateSources(sources) {
  if (!Array.isArray(sources) || sources.length > 8) throw new Error('Use up to eight telemetry sources.');
  return sources.map(source => {
    if (!Object.hasOwn(providerNames, source.type)) throw new Error('Unknown telemetry provider.');
    const url = new URL(source.url);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('Telemetry URLs must be HTTP(S), without credentials or query strings.');
    return { type: source.type, url: url.href.replace(/\/+$/, ''), enabled: source.enabled !== false };
  });
}
function normalizeModels(type, data) {
  if (type === 'ollama') {
    if (!Array.isArray(data.models)) throw new Error('No loaded-model inventory in this response.');
    return data.models.map(m => ({ name: m.name || m.model, bytes: number(m.size), vram: number(m.size_vram),
      ram: number(m.size) !== null && number(m.size_vram) !== null ? Math.max(0, m.size - m.size_vram) : null,
      placement: number(m.size_vram) === null ? 'Not reported' : m.size_vram === 0 ? 'CPU' : m.size_vram >= m.size ? 'GPU' : 'CPU + GPU',
      context: number(m.context_length), kind: m.details?.family || '', pid: null }));
  }
  if (type === 'lmstudio') {
    if (!Array.isArray(data.models) || data.models.some(m => !Array.isArray(m.loaded_instances))) throw new Error('No loaded-instance inventory in this response.');
    // size_bytes is the model file size, NOT resident RAM. Do not display it as memory.
    return data.models.flatMap(m => m.loaded_instances.map(instance => ({ name: instance.id || m.display_name || m.key,
      bytes: null, ram: null, vram: null, placement: m.format === 'mlx' ? 'Unified memory' : 'Not reported',
      context: number(instance.config?.context_length), kind: m.type || '', pid: null })));
  }
  if (!Array.isArray(data.all_models_loaded) && !Object.hasOwn(data, 'model_loaded')) throw new Error('No loaded-model inventory in this response.');
  const models = Array.isArray(data.all_models_loaded) ? data.all_models_loaded : typeof data.model_loaded === 'string' && data.model_loaded ? [{ model_name: data.model_loaded }] : [];
  return models.map(m => ({ name: m.model_name || m.name, bytes: null, ram: null, vram: null,
    placement: m.device || 'Not reported', context: number(m.recipe_options?.ctx_size), kind: m.type || '', pid: number(m.pid) }));
}
function gpuSnapshot(raw) {
  const grouped = new Map();
  for (const engine of asArray(raw.engines)) {
    const key = String(engine.Name).replace(/^pid_\d+_/, '');
    grouped.set(key, (grouped.get(key) || 0) + (number(engine.UtilizationPercentage) || 0));
  }
  const memory = asArray(raw.memory), adapters = asArray(raw.adapters);
  return { name: adapters.map(a => a.name).join(' · ') || 'GPU',
    utilization: grouped.size ? Math.min(100, Math.max(...grouped.values())) : null,
    dedicated: memory.length ? sum(memory, 'DedicatedUsage') : null,
    shared: memory.length ? sum(memory, 'SharedUsage') : null,
    total: adapters.length && adapters.every(a => number(a.total) > 0) ? sum(adapters, 'total') : null,
    adapters, source: 'Windows GPU counters · busiest engine' };
}
function cpuTimes() {
  const cpus = os.cpus();
  return { idle: cpus.reduce((n, c) => n + c.times.idle, 0), total: cpus.reduce((n, c) => n + Object.values(c.times).reduce((a, b) => a + b, 0), 0) };
}
async function platformSample() {
  if (process.platform === 'win32') {
    const script = fs.readFileSync(path.join(__dirname, 'telemetry-windows.ps1'), 'utf8');
    const { stdout } = await execute(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, timeout: 15000, maxBuffer: 2 * 1024 * 1024 });
    return JSON.parse(stdout.replace(/^\uFEFF/, ''));
  }
  const { stdout } = await execute('/bin/ps', ['-axo', 'pid=,rss=,pcpu=,comm='], { timeout: 5000, maxBuffer: 2 * 1024 * 1024 });
  const processes = stdout.split('\n').flatMap(line => {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+([\d.]+)\s+(.+)$/);
    return m ? [{ pid: +m[1], ram: +m[2] * 1024, cpu: +m[3] / Math.max(1, os.cpus().length), name: path.basename(m[4]) }] : [];
  }).sort((a, b) => b.ram - a.ram).slice(0, 30);
  return { processes, notes: ['GPU, disk and network counters are currently available on Windows.'] };
}
class Telemetry {
  constructor({ getSettings = () => ({}), samplePlatform = platformSample, fetcher = fetch, now = Date.now } = {}) {
    this.getSettings = getSettings; this.samplePlatform = samplePlatform; this.fetcher = fetcher; this.now = now;
    this.previousCpu = cpuTimes(); this.previousProcesses = new Map(); this.previousAt = now();
    this.cache = null; this.pending = null; this.providerCache = null; this.providerAt = 0; this.sourceKey = '';
  }
  async providers() {
    const settings = this.getSettings();
    const sources = validateSources(settings.telemetrySources || defaults);
    const key = JSON.stringify(sources);
    if (this.providerCache && this.sourceKey === key && this.now() - this.providerAt < 10000) return this.providerCache;
    const results = await Promise.all(sources.filter(s => s.enabled).map(async source => {
      const base = source.url.replace(/\/+$/, '');
      const url = source.type === 'ollama' ? base.replace(/\/(?:api|v1)$/, '') + '/api/ps'
        : source.type === 'lmstudio' ? base.replace(/\/(?:api\/v1|v1)$/, '') + '/api/v1/models'
        : base + (/\/v1$/.test(base) ? '' : '/api/v1') + '/health';
      const headers = {};
      // Reuse a configured key only within that endpoint's exact origin and base path.
      try { const endpoint = new URL(settings.endpoint); const target = new URL(url);
        const prefix = endpoint.pathname.replace(/\/(?:api\/)?v1\/?$/, '').replace(/\/$/, '');
        if (settings.accessKey && target.origin === endpoint.origin && (!prefix || target.pathname.startsWith(prefix + '/'))) headers.Authorization = 'Bearer ' + settings.accessKey;
      } catch { /* pointer URLs and unconfigured endpoints do not share credentials */ }
      const status = { provider: providerNames[source.type], url: source.url, local: ['localhost', '127.0.0.1', '[::1]'].includes(new URL(url).hostname), models: [] };
      try {
        const response = await this.fetcher(url, { method: 'GET', headers, redirect: 'error', signal: AbortSignal.timeout(2500) });
        if (!response.ok) throw new Error('HTTP ' + response.status);
        if (+response.headers.get('content-length') > 1024 * 1024) throw new Error('Inventory response too large');
        const reader = response.body.getReader(); let size = 0; const chunks = [];
        try { while (true) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > 1024 * 1024) throw new Error('Inventory response too large'); chunks.push(Buffer.from(value)); } }
        finally { await reader.cancel().catch(() => {}); }
        status.models = normalizeModels(source.type, JSON.parse(Buffer.concat(chunks).toString('utf8'))).map(m => ({ ...m, provider: status.provider, local: status.local }));
        status.state = 'connected';
      } catch (error) { status.state = 'unavailable'; status.error = /^HTTP \d+$|No loaded-|Inventory/.test(error.message) ? error.message : 'Not reachable or not supported'; }
      return status;
    }));
    this.sourceKey = key; this.providerAt = this.now();
    return this.providerCache = results;
  }
  async sample() {
    if (this.pending) return this.pending;
    if (this.cache && this.now() - this.cache.at < 2500) return this.cache;
    this.pending = this.collect().finally(() => { this.pending = null; });
    return this.pending;
  }
  async collect() {
    const [platform, providers] = await Promise.allSettled([this.samplePlatform(), this.providers()]);
    const raw = platform.status === 'fulfilled' ? platform.value : { notes: ['System counters unavailable: check OS permissions.'] };
    const now = this.now(), cpu = cpuTimes(), delta = cpu.total - this.previousCpu.total;
    const cpuPercent = delta > 0 ? Math.max(0, Math.min(100, 100 * (1 - (cpu.idle - this.previousCpu.idle) / delta))) : null;
    const elapsed = (now - this.previousAt) / 1000, threads = Math.max(1, os.cpus().length);
    const processes = asArray(raw.processes).map(p => {
      const previous = this.previousProcesses.get(p.pid);
      const percent = previous?.name === p.name && number(p.cpuSeconds) !== null && number(previous.cpuSeconds) !== null && elapsed > 0
        ? Math.max(0, Math.min(100, (p.cpuSeconds - previous.cpuSeconds) / elapsed / threads * 100)) : number(p.cpu);
      return { pid: p.pid, name: String(p.name), ram: number(p.ram), cpu: percent };
    });
    this.previousProcesses = new Map(asArray(raw.processes).map(p => [p.pid, p]));
    this.previousCpu = cpu; this.previousAt = now;
    const total = os.totalmem(), available = os.freemem();
    const sources = providers.status === 'fulfilled' ? providers.value : [];
    return this.cache = { at: now, platform: process.platform, cpu: { percent: cpuPercent, name: os.cpus()[0]?.model || 'CPU', threads },
      ram: { total, available, used: total - available }, gpu: gpuSnapshot(raw), processes,
      network: raw.network || null, disk: raw.disk || null, uptime: os.uptime(),
      sources, models: sources.flatMap(s => s.models), notes: [...(raw.notes || []), ...(providers.status === 'rejected' ? ['Telemetry source settings need attention.'] : [])] };
  }
}
module.exports = { Telemetry, defaults, validateSources, normalizeModels, gpuSnapshot };
