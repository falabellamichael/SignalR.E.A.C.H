'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');const {execute,TOOLS,ids,publicPlugins}=require('../agent/extra-apps.cjs');
test('all six app adapters use fixed origins and token auth with bounded reads',async()=>{
 const seen=[];const fetchImpl=async(url,options)=>{seen.push({url:new URL(url),options});return {ok:true,text:async()=>JSON.stringify({items:[],files:[],messages:{matches:[]},results:[],value:[]})};};
 for(const id of ids)await execute(id,{query:'hello',channel:'123',limit:999},{enabled:true,token:'secret'},{fetchImpl});
 assert.equal(seen.length,6);assert.ok(seen.every(x=>x.options.redirect==='error'));assert.ok(seen.every(x=>x.options.headers.Authorization.endsWith('secret')));
 assert.equal(seen[0].url.searchParams.get('maxResults'),'20');assert.equal(seen[4].url.pathname,'/api/v10/channels/123/messages');
 await assert.rejects(execute('discord',{},{}),/valid resource ID/);await assert.rejects(execute('calendar',{},{}),/Connect/);
 assert.equal(TOOLS['todo.create'].approval,true);assert.equal(TOOLS['todo.read'].approval,false);
 assert.equal(publicPlugins({slack:{token:'secret',enabled:true}}).slack.token,undefined);
});
test('connection catalog exposes all six apps without secret values and preserves blank tokens',()=>{
 const {createAppConnections}=require('../agent/app-connections.cjs');let settings={plugins:{slack:{enabled:true,token:'secret'}}};
 const apps=createAppConnections({getSettings:()=>settings,saveSettings:value=>{settings=value;},openExternal:()=>{}});
 const catalog=apps.catalog();for(const id of ids)assert.ok(catalog.some(item=>item.id===id));assert.equal(catalog.some(item=>item.token==='secret'||item.fields.some(field=>field.value==='secret')),false);
 apps.save('slack',{token:'',enabled:true});assert.equal(settings.plugins.slack.token,'secret');apps.disconnect('slack');assert.equal(settings.plugins.slack.token,undefined);
});
test('external failures never expose response bodies or tokens',async()=>{
 await assert.rejects(execute('slack',{query:'x'},{token:'secret'},{fetchImpl:async()=>({ok:false,status:403,text:async()=>'secret'})}),/HTTP 403/);
 const {companionSettings}=require('../agent/companion-chat.cjs');const off=companionSettings({},{});assert.ok(off.disabledTools.includes('slack.read'));const on=companionSettings({},{slack:{enabled:true}});assert.equal(on.disabledTools.includes('slack.read'),false);
});
