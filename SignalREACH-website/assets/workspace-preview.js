/* This page runs only in an opaque sandbox. It never receives account data. */
(() => {
  'use strict';
  const parentOrigin = new URL(location.href).origin;
  function projectPath(value, entry) {
    if (typeof value !== 'string' || /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(value)) return null;
    let path; try { path = decodeURIComponent(value.split(/[?#]/)[0]); } catch (_) { return null; }
    const parts = path.startsWith('/') ? [] : entry.split('/').slice(0,-1);
    for (const part of path.split('/')) {
      if (!part || part === '.') continue;
      if (part === '..') { if (!parts.length) return null; parts.pop(); } else parts.push(part);
    }
    return parts.join('/');
  }
  // Runs before generated scripts, entirely inside the opaque preview frame.
  function runtime({channel, parentOrigin, entry, paths, urls, storage}, resolve) {
    const post = (type, fields) => parent.postMessage({type, channel, ...fields}, parentOrigin);
    const report = text => post('reach-preview-status', {text:String(text).slice(0,300)});
    const persistent = new Map(Object.entries(storage || {}));
    function isolatedStorage(map, persist) {
      const api = {getItem:key => map.get(String(key)) ?? null, setItem(key, value) { map.set(String(key),String(value)); if (persist) post('reach-preview-storage',{storage:Object.fromEntries(map)}); },
        removeItem(key) { map.delete(String(key)); if (persist) post('reach-preview-storage',{storage:Object.fromEntries(map)}); },
        clear() { map.clear(); if (persist) post('reach-preview-storage',{storage:{}}); }, key:index => [...map.keys()][index] ?? null, get length() { return map.size; }};
      return new Proxy(api, {get:(target,key) => key in target ? target[key] : typeof key === 'string' ? target.getItem(key) : undefined,
        set(target,key,value) { target.setItem(key,value); return true; }});
    }
    Object.defineProperty(window,'localStorage',{value:isolatedStorage(persistent,true)});
    Object.defineProperty(window,'sessionStorage',{value:isolatedStorage(new Map(),false)});
    const originalFetch = window.fetch.bind(window);
    window.fetch = (input, options) => {
      const path = typeof input === 'string' ? resolve(input,entry) : null;
      return originalFetch(path && Object.hasOwn(urls,path) ? urls[path] : input, options);
    };
    addEventListener('click', event => {
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest('input[type=file]')) { event.preventDefault(); event.stopImmediatePropagation(); return; }
      const href = target?.closest('a')?.getAttribute('href'), path = href ? resolve(href,entry) : null;
      if (path && paths.includes(path) && /\.html?$/i.test(path)) { event.preventDefault(); post('reach-preview-navigate',{path}); }
    }, true);
    addEventListener('drop', event => { if (event.dataTransfer?.files?.length) { event.preventDefault(); event.stopImmediatePropagation(); } }, true);
    addEventListener('paste', event => { if (event.clipboardData?.files?.length) { event.preventDefault(); event.stopImmediatePropagation(); } }, true);
    const showPicker = HTMLInputElement.prototype.showPicker;
    if (showPicker) HTMLInputElement.prototype.showPicker = function() { if (this.type !== 'file') return showPicker.call(this); };
    addEventListener('error', event => { if (!event.filename?.startsWith('chrome-extension:')) report(`JavaScript: ${event.message || 'A script could not load.'}`); });
    addEventListener('unhandledrejection', event => { if (!String(event.reason?.stack || '').includes('chrome-extension:')) report('JavaScript: ' + (event.reason?.message || 'Unhandled promise rejection.')); });
    addEventListener('DOMContentLoaded', () => report('Preview ready · Your project runs in its own sandbox'), {once:true});
  }
  let rendered = false;
  addEventListener('message', event => {
    if (rendered || event.source !== parent || event.origin !== parentOrigin || event.data?.type !== 'reach-preview-render') return;
    const {channel, entry = 'index.html', storage = {}} = event.data;
    let files;
    try { files = globalThis.SignalREACHWorkspaceCore.validate(event.data.files); } catch (_) { return; }
    if (typeof channel !== 'string' || !Object.hasOwn(files,entry)) return;
    rendered = true;
    const report = text => parent.postMessage({type:'reach-preview-status', channel, text:String(text).slice(0,300)}, parentOrigin);
    try {
      const urls = {}, imports = {}, cssPending = new Set();
      const mime = path => /\.m?js$/i.test(path) ? 'text/javascript' : /\.css$/i.test(path) ? 'text/css' : /\.svg$/i.test(path) ? 'image/svg+xml' : /\.json$/i.test(path) ? 'application/json' : 'text/plain';
      const blob = (content,type) => URL.createObjectURL(new Blob([content],{type}));
      const moduleName = (value,path) => { const resolved = projectPath(value,path); return resolved && Object.hasOwn(files,resolved) ? 'reach-project/'+resolved : value; };
      const js = (content,path) => content
        .replace(/(\b(?:import|export)\s+(?:[^'";]*?\s+from\s*)?)(['"])([^'"]+)\2/g, (_,prefix,quote,value) => prefix+quote+moduleName(value,path)+quote)
        .replace(/(\bimport\s*\(\s*)(['"])([^'"]+)\2/g, (_,prefix,quote,value) => prefix+quote+moduleName(value,path)+quote);
      for (const [path,content] of Object.entries(files)) if (!/\.html?$|\.css$/i.test(path)) urls[path] = blob(/\.m?js$/i.test(path) ? js(content,path) : content,mime(path));
      const resource = (value,path) => {
        const resolved = projectPath(value,path);
        if (!resolved || !Object.hasOwn(files,resolved)) return value;
        if (/\.css$/i.test(resolved)) return cssUrl(resolved);
        return urls[resolved] || value;
      };
      const css = (content,path) => content.replace(/url\(\s*(['"]?)([^)'"\s]+)\1\s*\)/gi, (_,quote,value) => 'url("'+resource(value,path)+'")')
        .replace(/(@import\s+)(['"])([^'"]+)\2/gi, (_,prefix,quote,value) => prefix+quote+resource(value,path)+quote);
      function cssUrl(path) {
        if (urls[path]) return urls[path];
        if (cssPending.has(path)) return blob('', 'text/css');
        cssPending.add(path); urls[path] = blob(css(files[path],path),'text/css'); cssPending.delete(path); return urls[path];
      }
      for (const path of Object.keys(files)) if (/\.css$/i.test(path)) cssUrl(path);
      for (const [path,url] of Object.entries(urls)) imports['reach-project/'+path] = url;
      const parsed = new DOMParser().parseFromString(files[entry], 'text/html');
      parsed.querySelectorAll('base,meta[http-equiv],input[type=file]').forEach(node => node.remove());
      for (const node of parsed.querySelectorAll('[src],link[href]')) {
        const attr = node.hasAttribute('src') ? 'src' : 'href'; node.setAttribute(attr,resource(node.getAttribute(attr),entry));
      }
      parsed.querySelectorAll('[style]').forEach(node => node.setAttribute('style',css(node.getAttribute('style'),entry)));
      parsed.querySelectorAll('style').forEach(node => { node.textContent = css(node.textContent,entry); });
      parsed.querySelectorAll('script[type=module]:not([src])').forEach(node => { node.textContent = js(node.textContent,entry); });
      const map = {imports:{}};
      parsed.querySelectorAll('script[type=importmap]').forEach(node => { try { Object.assign(map.imports,JSON.parse(node.textContent).imports); } catch (_) {} node.remove(); });
      Object.assign(map.imports,imports);
      const importMap = parsed.createElement('script'); importMap.type = 'importmap'; importMap.textContent = JSON.stringify(map).replace(/</g,'\\u003c'); parsed.head.prepend(importMap);
      const boot = parsed.createElement('script');
      const config = JSON.stringify({channel,parentOrigin,entry,paths:Object.keys(files),urls,storage}).replace(/</g,'\\u003c');
      boot.textContent = '('+runtime.toString()+')('+config+','+projectPath.toString()+');'; parsed.head.prepend(boot);
      const html = '<!doctype html>\n'+parsed.documentElement.outerHTML;
      document.open(); document.write(html); document.close();
    } catch (error) { report('Preview: '+error.message); }
  });
  parent.postMessage({type:'reach-preview-ready'}, parentOrigin);
})();
