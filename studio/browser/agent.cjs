'use strict';
const { pageAction } = require('./page.cjs');

function cancellable(promise, signal, stop = () => {}) {
  return new Promise((resolve, reject) => {
    const abort = () => { try { stop(); } catch {} reject(signal.reason); };
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
    if (signal.aborted) abort();
  });
}
async function pageCall(tab, op, args = {}) {
  const result = await tab.view.webContents.executeJavaScriptInIsolatedWorld(999, [{ code: `(() => { try { return { ok: true, value: (${pageAction.toString()})(${JSON.stringify(op)}, ${JSON.stringify(args)}) }; } catch (error) { return { ok: false, error: String(error.message || error) }; } })()` }]);
  if (!result.ok) throw new Error(result.error);
  return result.value;
}
async function settled(tab, signal) {
  const wc = tab.view.webContents;
  // A click may schedule navigation on the next event-loop turn.
  await cancellable(new Promise(resolve => setTimeout(resolve, 80)), signal);
  while (wc.isLoadingMainFrame()) await cancellable(new Promise(resolve => setTimeout(resolve, 40)), signal, () => wc.stop());
  if (tab.error) throw new Error(tab.error);
}
async function agentCommand(host, action, args, ctx) {
  const op = action === 'browser' ? String(args.op || 'read') : action;
  const supported = ['tabs', 'open', 'read', 'back', 'forward', 'reload', 'scroll', 'close', 'click', 'type'];
  if (!supported.includes(op) || (action === 'browser' && ['click', 'type'].includes(op))) throw new Error('Use browser with a navigation/read operation, or browser.click / browser.type for interactions.');
  const timeout = ctx.browserTimeoutMs ?? 30000;
  const signals = [ctx.signal, timeout > 0 ? AbortSignal.timeout(timeout) : null].filter(Boolean);
  const signal = signals.length ? AbortSignal.any(signals) : new AbortController().signal;
  signal.throwIfAborted();
  if (op === 'tabs') return { ok: true, ...host.state() };
  let tab = args.tabId ? host.tabs.get(args.tabId) : [...host.tabs.values()].find(t => t.owner === ctx.owner);
  if (args.tabId && !tab) throw new Error('Browser tab no longer exists. List tabs again.');
  if (!tab && op !== 'open') throw new Error('Open a URL first or provide tabId from browser tabs.');
  if (!tab) {
    tab = host.newTab(); tab.owner = ctx.owner;
    host.win.webContents.send('browser:reveal');
  }
  // Keep operations on a shared explicit tab ordered, while independent team tabs run concurrently.
  const previous = tab.agentQueue || Promise.resolve();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  tab.agentQueue = previous.catch(() => {}).then(() => gate);
  try {
    await cancellable(previous.catch(() => {}), signal);
    signal.throwIfAborted();
    const wc = tab.view.webContents;
    if (wc.isDestroyed()) throw new Error('Browser tab was closed.');
    if (op === 'close') { await host.command('close', { id: tab.id }); return { ok: true, closed: tab.id }; }
    if (op === 'open') {
      if (!String(args.url || '').trim()) throw new Error('A URL or search query is required.');
      host.navigate(tab, args.url);
    } else if (['back', 'forward', 'reload'].includes(op)) await host.command(op, { id: tab.id });
    else if (op !== 'read') await cancellable(pageCall(tab, op, { ref: args.ref, text: args.text, direction: args.direction }), signal, () => wc.stop());
    await settled(tab, signal);
    const result = await cancellable(pageCall(tab, 'read'), signal, () => wc.stop());
    signal.throwIfAborted();
    host.emit();
    return { ok: true, tabId: tab.id, url: wc.getURL(), title: wc.getTitle(), ...result };
  } finally { release(); }
}
module.exports = { agentCommand, pageCall };
