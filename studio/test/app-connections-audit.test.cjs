'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');
const apps=require('../agent/extra-apps.cjs');
function reply(data,status=200){return {ok:status<400,status,json:async()=>data,text:async()=>JSON.stringify(data)};}
test('all extra apps return real response data, auth and permission failures surface',async()=>{
 const payloads={calendar:{items:[{summary:'Meeting'}]},drive:{files:[{name:'Doc'}]},slack:{ok:true,messages:{matches:[{text:'Hello'}]}},notion:{results:[{id:'page'}]},discord:[{content:'Hello'}],todo:{value:[{title:'Task'}]}};
 for(const id of apps.ids){const calls=[];const result=await apps.execute(id,{query:'test',channel:'123'},{token:'test',enabled:true},{fetchImpl:async(url,options)=>{calls.push({url:String(url),options});return reply(payloads[id]);}});assert.ok(JSON.stringify(result).includes(id==='calendar'?'Meeting':id==='drive'?'Doc':id==='notion'?'page':id==='todo'?'Task':'Hello'));assert.equal(calls.length,1);
 for(const status of [401,403,429])await assert.rejects(apps.execute(id,{channel:'123'},{token:'test'},{fetchImpl:async()=>reply({},status)}),new RegExp('HTTP '+status));}
});
test('Drive exports Google Docs, Notion reads blocks and To Do creation is separate',async()=>{
 const calls=[];const result=await apps.execute('drive',{id:'doc'},{token:'test'},{fetchImpl:async(url,options)=>{calls.push(String(url));return calls.length===1?reply({mimeType:'application/vnd.google-apps.document'}):{ok:true,text:async()=>'Document content'};}});assert.equal(result.text,'Document content');assert.match(calls[1],/export\?mimeType=text%2Fplain/);
 const notion=await apps.execute('notion',{id:'page'},{token:'test'},{fetchImpl:async url=>{assert.match(String(url),/blocks\/page\/children/);return reply({results:[{type:'paragraph'}]});}});assert.equal(notion.blocks[0].type,'paragraph');
 const original=global.fetch;try{global.fetch=async(url,options)=>{assert.equal(options.method,'GET');assert.match(String(url),/\/tasks/);return reply({value:[]});};await apps.TOOLS['todo.read'].execute({list:'a',operation:'create',title:'must not create'},{getPlugins:()=>({todo:{token:'test'}})});}finally{global.fetch=original;}
 assert.equal(apps.TOOLS['todo.create'].approval,true);
});
test('checks verify identity without inventing a Slack channel, and validate Discord channel access',async()=>{
 const seen=[];await apps.checkConnection('slack',{token:'test'},{fetchImpl:async url=>{seen.push(String(url));return reply({ok:true});}});assert.equal(seen[0],'https://slack.com/api/auth.test');
 await apps.checkConnection('discord',{token:'test',channel:'123'},{fetchImpl:async url=>{seen.push(String(url));return reply([]);}});assert.ok(seen.some(url=>url.endsWith('/users/@me')));assert.ok(seen.some(url=>url.includes('/channels/123/messages')));
});
test('GitHub repository issue and PR tools preserve API auth and reject disabled connections',async()=>{
 const original=global.fetch;const seen=[];global.fetch=async(url,options)=>{seen.push({url:String(url),options});return reply(new URL(url).pathname.endsWith('/issues')||new URL(url).pathname.endsWith('/pulls')?[]:{name:'repo',full_name:'owner/repo'});};
 try{const {PLUGIN_TOOLS,testPlugin}=require('../agent/plugins.cjs');const ctx={getPlugins:()=>({github:{enabled:true,token:'test'}})};
 for(const tool of ['github.repo','github.issues','github.prs']){const result=await PLUGIN_TOOLS[tool].execute({owner:'owner',repo:'repo'},ctx);assert.notEqual(result.ok,false);}
 assert.ok(seen.every(c=>c.options.redirect==='error'&&c.options.headers.Authorization==='Bearer test'));
 const denied=await PLUGIN_TOOLS['github.repo'].execute({owner:'owner',repo:'repo'},{getPlugins:()=>({github:{enabled:false,token:'test'}})});assert.equal(denied.ok,false);
 }finally{global.fetch=original;}
});
test('Gmail refresh/list/read/send and Outlook read use authenticated API routes',async()=>{
 const original=global.fetch;const calls=[];global.fetch=async(url,options)=>{calls.push({url:String(url),options});if(String(url).includes('oauth2'))return reply({access_token:'refreshed',expires_in:3600});if(String(url).includes('messages/send'))return reply({id:'sent'});if(String(url).includes('messages/m1'))return reply({payload:{mimeType:'text/plain',body:{data:Buffer.from('Mail body').toString('base64url')},headers:[{name:'Subject',value:'Subject'}]}});if(String(url).includes('gmail'))return reply({messages:[{id:'m1'}]});return reply({value:[{subject:'Outlook mail'}]});};
 try{const mail=require('../agent/mail-connections.cjs');const config={refreshToken:'audit-refresh',clientId:'client',email:'me@example.com'};const result=await mail.gmailRead(config,{query:'unread',limit:1});assert.equal(result.messages[0].body,'Mail body');assert.ok(calls.some(c=>c.options.headers?.Authorization==='Bearer refreshed'));
 const sent=await mail.gmailSend(config,{to:'you@example.com',subject:'Test',body:'Body'});assert.equal(sent.sent,true);
 const outlook=await mail.outlookFetch({password:'graph'},'/messages');assert.equal(outlook.value[0].subject,'Outlook mail');
 await assert.rejects(mail.gmailSend(config,{to:'you@example.com\r\nBcc:bad',subject:'x',body:'x'}),/header/);
 }finally{global.fetch=original;}
});
