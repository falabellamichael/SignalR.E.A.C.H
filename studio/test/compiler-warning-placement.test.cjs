'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');const vm=require('node:vm');
const renderer=path.join(__dirname,'../renderer');
test('no persistent compiler status elements or refresh-time warnings',async()=>{
 const html=fs.readFileSync(path.join(renderer,'index.html'),'utf8');assert.doesNotMatch(html,/id="(?:wsl-status|reach-version)"|compiler-notice/);
 const source=fs.readFileSync(path.join(renderer,'app-projects.js'),'utf8');const refresh=source.slice(source.indexOf('async function refreshStatus()'),source.indexOf('// ---------- projects ----------'));
 const context={reachApi:{getVersion:async()=> 'Native Reach compiler unavailable. Configure Settings.'},reachCliAvailable:true};vm.createContext(context);vm.runInContext(refresh,context);await context.refreshStatus();assert.equal(context.reachCliAvailable,false);
 context.reachApi.getVersion=async()=> 'reachc 0.1.13';await context.refreshStatus();assert.equal(context.reachCliAvailable,true);
});
test('attempting native Reach without compiler produces command-output error only',async()=>{
 const source=fs.readFileSync(path.join(renderer,'app-projects.js'),'utf8');const start=source.indexOf('async function execCommand('),end=source.indexOf('\n}',start)+2;
 const logged=[];const context={currentProject:{dir:'project'},reachCliAvailable:false,logLine:(kind,text)=>logged.push({kind,text})};vm.createContext(context);vm.runInContext(source.slice(start,end),context);
 assert.equal(await context.execCommand(['compile','index.rsh'],'reach'),false);assert.equal(logged.length,1);assert.equal(logged[0].kind,'err');assert.match(logged[0].text,/compiler is unavailable/);
});
