'use strict';
// Native Chromium verification of the real Admin renderer, real country API,
// and actual flag image. Telemetry is a labeled fixture in an isolated profile.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const installed = process.argv.includes('--installed');
const outArg = process.argv.indexOf('--out');
const out = path.resolve(outArg >= 0 ? process.argv[outArg + 1] : 'build/usage-country-flags', installed ? 'qa-installed' : 'qa-source');
fs.mkdirSync(out, { recursive: true });
app.setPath('userData', path.join(out, 'profile'));
const generated = installed ? null : JSON.parse(execFileSync('python', ['-c',
  'import json,pathlib,sys;sys.path.insert(0,"tools");import extension_editions as e;a=e.edition_assets(pathlib.Path.cwd(),"admin")[2];print(json.dumps({k:a[k].decode("utf-8") for k in ("pages-usage.js","reach-telemetry.css")}))'
], { encoding: 'utf8' }));
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1220, height: 950,
    webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  const errors = [], lookups = [];
  win.webContents.on('console-message', (_event, level, message) => {
    if (level >= 3 && !message.includes("directive 'frame-ancestors' is ignored")) errors.push(message);
  });
  win.webContents.session.webRequest.onBeforeRequest({ urls: ['https://api.country.is/*'] }, (details, callback) => {
    lookups.push(details.url); callback({});
  });
  const run = code => win.webContents.executeJavaScript(code, true);
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  const timeout = setTimeout(() => { console.error('Usage flags UI timed out'); app.exit(1); }, 45000);
  try {
    await win.loadURL('http://127.0.0.1:18111/gui/');
    for (let i = 0; i < 100; i++) {
      if (await run('!!window.__reachAdminPageRegistry?.usage && !!window.__reachAdminCore')) break;
      await delay(100);
    }
    assert.equal(await run('!!window.__reachAdminPageRegistry?.usage'), true);
    if (generated) {
      await run(generated['pages-usage.js']);
      await run(`(() => {const style=document.createElement('style');style.textContent=${JSON.stringify(generated['reach-telemetry.css'])};document.head.appendChild(style);})()`);
    }
    // The registered renderer captured its core already. Keep actual helpers,
    // but replace only fixture telemetry and clipboard before reinitializing it.
    const usageSource = generated?.['pages-usage.js'] || await run(`(async () => {
      const script=[...document.scripts].find(s=>s.src.includes('/signal-reach-admin/pages-usage.js'));
      if(!script)throw new Error('Installed Usage asset is missing');
      return (await fetch(script.src,{cache:'no-store'})).text();
    })()`);
    await run(`(() => {
      window.__flagCopies=[];
      const client={ip:'195.231.96.123',requests:6,tokens_out:21200,last_model:'minicpm5-2b',last_seen:new Date().toISOString(),user_agent:'Country flag verification fixture'};
      const stats={today:{requests:6,tokens_out:21200},top_clients:[client,{...client,ip:'127.0.0.1',requests:1}],hourly:[],by_model:[]};
      window.__reachAdminCore=Object.freeze({...window.__reachAdminCore,
        prefsGet:(key,fallback)=>key==='show_client_presence'?'1':fallback,prefsSet:()=>{},
        copyText:async ip=>{window.__flagCopies.push(ip);return true;},
        relayFetch:async route=>({ok:true,json:async()=>route.startsWith('/_reach/stats')?{stats}: {logs:[]}})
      });
      const host=document.createElement('main');host.className='reach-root';host.style.cssText='position:fixed;inset:0;overflow:auto;padding:20px;background:#171717;color:#ddd;z-index:2147483000;';
      document.body.appendChild(host);
      window.__flagHost=host;
    })()`);
    await run(usageSource);
    await run(`window.__flagCleanup=window.__reachAdminPageRegistry.usage(window.__flagHost); true`);
    let loaded = false;
    for (let i = 0; i < 100; i++) {
      loaded = await run(`!!document.querySelector('.reach-presence-country img')?.naturalWidth`);
      if (loaded) break;
      await delay(100);
    }
    assert.equal(loaded, true, 'A real country flag must load successfully under the host origin');
    const report = await run(`(() => {
      const card=[...document.querySelectorAll('.reach-presence-card')].find(c=>c.querySelector('.reach-presence-ip-identity')?.textContent.includes('195.231.96.123'));
      const flag=card.querySelector('.reach-presence-country img');
      const local=[...document.querySelectorAll('.reach-presence-card')].find(c=>c.querySelector('.reach-presence-ip-identity')?.textContent.includes('127.0.0.1'));
      card.querySelector('.reach-presence-ip-row button').click();
      card.querySelector('.reach-presence-footer button').click();
      return {alt:flag.alt,title:flag.parentElement.title,url:flag.src,width:flag.naturalWidth,
        privateAddressHasFlag:!!local.querySelector('.reach-presence-country'),copies:window.__flagCopies,
        filterWorks:document.querySelector('.reach-presence-card.selected')?.textContent.includes('195.231.96.123')};
    })()`);
    assert.equal(report.alt, 'Italy flag'); assert.equal(report.privateAddressHasFlag, false);
    assert.deepEqual(report.copies, ['195.231.96.123']); assert.equal(report.filterWorks, true);
    await delay(2800); // Exercise a telemetry poll and presence-clock redraw.
    assert.equal(lookups.length, 1, 'Polling must reuse the same lookup');
    assert.equal(await run(`!!document.querySelector('.reach-presence-country img')?.naturalWidth`), true);
    const rect = await run(`document.querySelector('.reach-presence-card').getBoundingClientRect().toJSON()`);
    fs.writeFileSync(path.join(out, 'client-tile.png'), (await win.capturePage({x:Math.floor(rect.x),y:Math.floor(rect.y),width:Math.ceil(rect.width),height:Math.ceil(rect.height)})).toPNG());
    fs.writeFileSync(path.join(out, 'usage.png'), (await win.capturePage()).toPNG());
    await run('window.__flagCleanup()');
    assert.deepEqual(errors, []);
    Object.assign(report, { installed, countryLookups: lookups.length, errors });
    fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
    console.log('USAGE COUNTRY FLAGS UI PASS', JSON.stringify(report));
    clearTimeout(timeout); win.destroy(); app.exit(0);
  } catch (error) {
    fs.writeFileSync(path.join(out, 'error.txt'), String(error.stack || error));
    console.error(error, errors, lookups); clearTimeout(timeout); win.destroy(); app.exit(1);
  }
});
