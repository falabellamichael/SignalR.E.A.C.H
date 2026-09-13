'use strict';
const { WebContentsView, Menu, shell, ipcMain, session } = require('electron');
const { agentCommand, pageCall } = require('./agent.cjs');

function normalizeUrl(raw) {
  const text = String(raw || '').trim();
  if (!text) return '';
  let value = text;
  if (/^(localhost|(?:\d{1,3}\.){3}\d{1,3}|\[::1\])(:\d+)?([/?#]|$)/i.test(text)) value = 'http://' + text;
  else if (/^[\w.-]+\.[a-z]{2,}(:\d+)?([/?#]|$)/i.test(text)) value = 'https://' + text;
  else if (!/^[a-z][a-z0-9+.-]*:/i.test(text)) {
    value = /^[\w.-]+\.[a-z]{2,}(:\d+)?(\/|$)/i.test(text) ? 'https://' + text
      : 'https://duckduckgo.com/?q=' + encodeURIComponent(text);
  }
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Use an http or https address.');
  if (url.username || url.password) throw new Error('Use the website login form instead of credentials in the address.');
  return url.href;
}

class StudioBrowser {
  constructor(win) {
    this.win = win;
    this.tabs = new Map();
    this.active = null;
    this.seq = 0;
    this.bounds = { x: 0, y: 0, width: 0, height: 0 };
    this.visible = false;
    this.session = session.fromPartition('persist:reach-browser');
    this.session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    this.session.setPermissionCheckHandler(() => false);
    ipcMain.handle('browser:command', async (event, action, args = {}) => {
      if (win.isDestroyed() || win.webContents.isDestroyed()) return { ok: false, err: 'Browser is closing.' };
      if (event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame) throw new Error('Untrusted browser command.');
      try { return { ok: true, ...await this.command(action, args) }; }
      catch (error) { return { ok: false, err: error.message }; }
    });
    win.webContents.once('destroyed', () => { ipcMain.removeHandler('browser:command'); this.dispose(); });
  }
  state() {
    return { active: this.active, tabs: [...this.tabs.values()].map(tab => {
      const wc = tab.view.webContents;
      return { id: tab.id, owner: tab.owner || '', title: wc.getTitle() || 'New tab', url: wc.getURL(), loading: wc.isLoading(),
        canBack: wc.navigationHistory.canGoBack(), canForward: wc.navigationHistory.canGoForward(), error: tab.error || '' };
    }) };
  }
  emit() {
    this.layout();
    if (!this.win.isDestroyed()) this.win.webContents.send('browser:state', this.state());
  }
  layout() {
    if (this.win.isDestroyed()) return;
    const outer = this.win.getContentBounds();
    const b = this.bounds;
    const x = Math.min(outer.width, Math.max(0, Math.round(b.x)));
    const y = Math.min(outer.height, Math.max(0, Math.round(b.y)));
    const width = Math.max(0, Math.min(Math.round(b.width), outer.width - x));
    const height = Math.max(0, Math.min(Math.round(b.height), outer.height - y));
    for (const tab of this.tabs.values()) {
      tab.view.setBounds({ x, y, width, height });
      tab.view.setVisible(this.visible && tab.id === this.active && !!tab.view.webContents.getURL() && !tab.error && width > 0 && height > 0);
    }
  }
  newTab(url = '') {
    const view = new WebContentsView({ webPreferences: {
      session: this.session, sandbox: true, contextIsolation: true, nodeIntegration: false,
      webSecurity: true, navigateOnDragDrop: false,
    } });
    const tab = { id: 'browser-' + ++this.seq, view };
    this.tabs.set(tab.id, tab);
    this.active = tab.id;
    this.win.contentView.addChildView(view);
    const wc = view.webContents;
    const allowed = value => { try { return normalizeUrl(value) === value; } catch { return false; } };
    wc.on('will-navigate', (event, value) => { if (!allowed(value)) event.preventDefault(); });
    wc.on('will-redirect', (event, value) => { if (!allowed(value)) event.preventDefault(); });
    wc.on('will-attach-webview', event => event.preventDefault());
    wc.setWindowOpenHandler(({ url: value }) => {
      if (allowed(value)) this.newTab(value);
      return { action: 'deny' };
    });
    for (const event of ['did-start-loading', 'did-stop-loading', 'did-navigate', 'did-navigate-in-page', 'page-title-updated']) wc.on(event, () => this.emit());
    wc.on('did-fail-load', (_event, code, description, _url, mainFrame) => {
      if (mainFrame && code !== -3) { tab.error = description; this.emit(); }
    });
    wc.on('render-process-gone', () => { tab.error = 'Page stopped responding. Reload to try again.'; this.emit(); });
    wc.on('context-menu', async (_event, params) => {
      let selected;
      try {
        selected = await this.selectElement(tab, params);
      } catch (error) { if (!this.win.isDestroyed()) this.win.webContents.send('browser:error', error.message); return; }
      Menu.buildFromTemplate([
        { label: (params.selectionText ? 'Add selection to chat: ' : 'Add element to chat: ') + selected.selector.slice(0, 60), click: () => this.addContext(tab, params, selected).catch(error => this.win.webContents.send('browser:error', error.message)) },
        { label: 'Add page to chat', click: () => this.addContext(tab).catch(() => {}) },
        { type: 'separator' },
        { role: 'copy', enabled: !!params.selectionText },
        ...(params.isEditable ? [{ role: 'paste' }] : []),
        ...(params.linkURL && allowed(params.linkURL) ? [{ label: 'Open link in new tab', click: () => this.newTab(params.linkURL) }] : []),
      ]).popup({ window: this.win });
    });
    wc.on('before-input-event', (event, input) => {
      if (input.type === 'keyDown' && (input.control || input.meta) && ['l', 'f', 't', 'w'].includes(input.key.toLowerCase())) {
        event.preventDefault();
        this.win.webContents.focus();
        this.win.webContents.send('browser:shortcut', input.key.toLowerCase());
      }
    });
    this.layout();
    this.emit();
    if (url) this.navigate(tab, url);
    return tab;
  }
  navigate(tab, url) {
    const address = normalizeUrl(url);
    if (!address) return;
    tab.error = '';
    tab.view.webContents.loadURL(address).catch(error => {
      if (!tab.view.webContents.isDestroyed() && error.code !== 'ERR_ABORTED') { tab.error = error.message; this.emit(); }
    });
  }
  agentCommand(op, args, ctx) { return agentCommand(this, op, args, ctx); }
  async selectElement(tab, params) {
    const url = tab.view.webContents.getURL();
    const result = await pageCall(tab, 'select', { x: params.x, y: params.y, selectionText: params.selectionText });
    if (tab.view.webContents.getURL() !== url) throw new Error('The page changed; select the element again.');
    const selected = { ...result, tabId: tab.id, url, title: tab.view.webContents.getTitle() };
    this.win.webContents.send('browser:selection', selected);
    return selected;
  }
  async addContext(tab, params = null, selected = null) {
    const wc = tab.view.webContents;
    const url = wc.getURL(), title = wc.getTitle();
    const content = selected || (params ? await this.selectElement(tab, params) : await pageCall(tab, 'page'));
    if (selected && (selected.url !== url || selected.documentId !== (await pageCall(tab, 'page')).documentId)) throw new Error('The page changed; select the element again.');
    const result = { ...content, tabId: tab.id, url, title, text: String(content.text || '').trim().slice(0, 8000) };
    if (wc.getURL() !== url) throw new Error('The page changed; select the content again.');
    if (!result.text) throw new Error('There is no readable text to add.');
    this.win.webContents.focus();
    this.win.webContents.send('browser:context', result);
    return result;
  }
  async command(action, args = {}) {
    if (action === 'layout') {
      const b = args.bounds;
      if (!b || !['x', 'y', 'width', 'height'].every(k => Number.isFinite(b[k]))) throw new Error('Invalid browser bounds.');
      this.bounds = b; this.visible = args.visible === true; this.layout(); return {};
    }
    if (action === 'new') this.newTab(args.url ? normalizeUrl(args.url) : '');
    else if (action !== 'state') {
      const tab = this.tabs.get(args.id || this.active);
      if (!tab) throw new Error('Select a browser tab.');
      const wc = tab.view.webContents;
      if (action === 'select') { this.active = tab.id; this.layout(); }
      else if (action === 'close') {
        this.win.contentView.removeChildView(tab.view); this.tabs.delete(tab.id); wc.close();
        if (this.active === tab.id) this.active = [...this.tabs.keys()].at(-1) || null;
        if (!this.tabs.size) this.newTab(); else this.layout();
      }
      else if (action === 'navigate') this.navigate(tab, args.url);
      else if (action === 'back' && wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack();
      else if (action === 'forward' && wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward();
      else if (action === 'reload') { tab.error = ''; wc.reload(); }
      else if (action === 'stop') wc.stop();
      else if (action === 'external') await shell.openExternal(normalizeUrl(wc.getURL()));
      else if (action === 'context') await this.addContext(tab);
      else if (action === 'clear-selection') { await pageCall(tab, 'clear'); this.win.webContents.send('browser:selection', null); }
      else if (action === 'find') {
        if (args.text) wc.findInPage(String(args.text), { forward: args.forward !== false, findNext: args.next !== true });
        else wc.stopFindInPage('clearSelection');
      }
    }
    this.emit();
    return this.state();
  }
  dispose() {
    for (const tab of this.tabs.values()) if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close();
    this.tabs.clear();
  }
}
module.exports = { StudioBrowser, normalizeUrl };
