'use strict';
const { normalizeToken, connectionError } = require('./app-auth.cjs');
const { googleToken } = require('./mail-connections.cjs');
const DEFINITIONS=[
 ['calendar','Google Calendar','Read upcoming events and search your primary calendar.','Google OAuth access token (calendar.readonly)','https://developers.google.com/calendar/api/auth'],
 ['drive','Google Drive','Search files and read Google Docs text.','Google OAuth access token (drive.readonly)','https://developers.google.com/drive/api/guides/api-specific-auth'],
 ['slack','Slack','Search messages accessible to your token.','Slack user OAuth token (search:read)','https://api.slack.com/scopes/search:read'],
 ['notion','Notion','Search shared pages and read their blocks.','Notion integration token (share pages with this integration)','https://developers.notion.com/docs/create-a-notion-integration'],
 ['discord','Discord','Talk to REACH in Discord and read messages from a selected channel.','Discord bot token (optional alternative for reading channels)','https://discord.com/developers/docs/intro'],
 ['todo','Microsoft To Do','List task lists and tasks; create tasks with approval.','Microsoft Graph OAuth token (Tasks.Read or Tasks.ReadWrite)','https://learn.microsoft.com/en-us/graph/api/resources/todo-overview'],
];
const ids=DEFINITIONS.map(d=>d[0]);
async function request(id,config,route,{query,method='GET',body,signal,text:plain=false,fetchImpl=fetch,clients,renewed=false}={}){
 const google=id==='drive'||id==='calendar';
 if(config?.enabled===false||!(config?.token||(google||['slack','todo','notion','discord'].includes(id))&&(config?.accessToken||config?.refreshToken)))throw new Error('Connect '+id+' in Connections first.');
 if(id==='discord'&&!config.token){
  const registration=(clients||require('./oauth-clients.cjs').loadClients()).discord;
  if(!registration?.brokerOrigin||registration.clientId!==config.clientId)throw new Error('Reconnect Discord using the registered REACH application.');
  const auth=require('./oauth-grants.cjs'),accessToken=await auth.oauthToken(id,config,{signal,fetchImpl,clients});
  const channel=/^channels\/([0-9]{10,22})\/messages$/.exec(route)?.[1];
  if(route!=='users/@me'&&!channel)throw new Error('Unsupported Discord connection request.');
  const result=await auth.brokerRequest(id,registration,'read',{accessToken,...(channel?{channel,limit:query?.limit}:{operation:'check'})},{signal,fetchImpl});
  return channel?result.messages:result;
 }
 const origins={calendar:'https://www.googleapis.com/calendar/v3/',drive:'https://www.googleapis.com/drive/v3/',slack:'https://slack.com/api/',notion:'https://api.notion.com/v1/',discord:'https://discord.com/api/v10/',todo:'https://graph.microsoft.com/v1.0/'};
 const url=new URL(route,origins[id]);if(url.origin!==new URL(origins[id]).origin)throw new Error('Invalid app endpoint');
 if(query)url.search=new URLSearchParams(query).toString();
 const token=google?await googleToken(config,id,{signal,fetchImpl}):id==='slack'||id==='todo'||id==='notion'&&!config.token?await require('./oauth-grants.cjs').oauthToken(id,config,{signal,fetchImpl,clients}):config.token;
 const response=await fetchImpl(url,{method,redirect:'error',signal:signal?AbortSignal.any([signal,AbortSignal.timeout(20000)]):AbortSignal.timeout(20000),headers:{Authorization:(id==='discord'?'Bot ':'Bearer ')+normalizeToken(token),'Content-Type':'application/json',...(id==='notion'?{'Notion-Version':'2022-06-28'}:{})},...(body?{body:JSON.stringify(body)}:{})});
 const text=await response.text();if(text.length>2000000)throw new Error('App response exceeds the size limit.');
 if(response.status===401&&id==='notion'&&!config.token&&config.refreshToken&&!renewed){
  const accessToken=await require('./oauth-grants.cjs').oauthToken(id,config,{signal,fetchImpl,clients,forceRefresh:true});
  return request(id,{...config,accessToken,expiresAt:Date.now()+600000},route,{query,method,body,signal,text:plain,fetchImpl,clients,renewed:true});
 }
 if(!response.ok){let data;try{data=JSON.parse(text);}catch{}throw connectionError(id,response.status,data);}
 if(plain)return text.slice(0,60000);
 let data;try{data=JSON.parse(text);}catch{throw new Error(id+' returned an invalid response. Try again or reconnect.');}
 if(!data||typeof data!=='object')throw new Error(id+' returned an invalid response.');
 if(data.ok===false)throw connectionError(id,response.status||200,data);return data;
}
const limit=args=>Math.min(20,Math.max(1,Math.trunc(Number(args.limit)||5)));
const segment=value=>{if(typeof value!=='string'||!value.trim()||value.length>256)throw new Error('A valid resource ID is required.');return encodeURIComponent(value);};
async function execute(id,args,config,options={}){
 const n=limit(args);const call=(route,extra={})=>request(id,config,route,{...options,...extra});
 if(id==='calendar')return {events:(await call('calendars/primary/events',{query:{maxResults:n,singleEvents:'true',orderBy:'startTime',timeMin:new Date().toISOString(),...(args.query?{q:args.query}:{})}})).items||[]};
 if(id==='drive'){
  if(args.id){const file=await call('files/'+segment(args.id),{query:{fields:'id,name,mimeType,webViewLink,description'}});if(file.mimeType==='application/vnd.google-apps.document'){const result=await call('files/'+segment(args.id)+'/export',{query:{mimeType:'text/plain'},text:true});return {file,text:result};}return {file};}
  const q=String(args.query||'').replace(/\\/g,'\\\\').replace(/'/g,"\\'");return {files:(await call('files',{query:{pageSize:n,fields:'files(id,name,mimeType,webViewLink,description)',q:"trashed = false"+(q?" and fullText contains '"+q+"'":'')}})).files||[]};
 }
 if(id==='slack')return {messages:(await call('search.messages',{query:{query:args.query||'',count:n,highlight:'false'}})).messages?.matches||[]};
 if(id==='notion')return args.id?{blocks:(await call('blocks/'+segment(args.id)+'/children',{query:{page_size:n}})).results||[]}:{pages:(await call('search',{method:'POST',body:{query:args.query||'',page_size:n}})).results||[]};
 if(id==='discord')return {messages:await call('channels/'+segment(args.channel||config.channel)+'/messages',{query:{limit:n}})};
 if(id==='todo'){
  if(args.operation==='create'){if(!args.title?.trim())throw new Error('Task title is required');return {task:await call('me/todo/lists/'+segment(args.list)+'/tasks',{method:'POST',body:{title:args.title.slice(0,255)}})};}
  return args.list?{tasks:(await call('me/todo/lists/'+segment(args.list)+'/tasks',{query:{'$top':n}})).value||[]}:{lists:(await call('me/todo/lists',{query:{'$top':n}})).value||[]};
 }
 throw new Error('Unknown app');
}
const TOOLS={};for(const id of ids){const name=id+'.read';TOOLS[name]={class:'browse',tier:'reach',approval:false,budget:30000,help:DEFINITIONS.find(d=>d[0]===id)[2],example:{action:name,limit:5},async execute(args,ctx){const config=(ctx.getPlugins?.()||ctx.getSettings?.().plugins||{})[id];return {ok:true,...await execute(id,{...args,operation:'read'},config,{signal:ctx.signal})};}};}
TOOLS['todo.create']={class:'write',tier:'reach',approval:true,budget:30000,help:'Create a Microsoft To Do task after confirming the list and title with the user. Requires Tasks.ReadWrite.',example:{action:'todo.create',list:'list-id',title:'Task title'},async execute(args,ctx){return {ok:true,...await execute('todo',{...args,operation:'create'},(ctx.getPlugins?.()||ctx.getSettings?.().plugins||{}).todo,{signal:ctx.signal})};}};
async function checkConnection(id,config,options={}){
 if(id==='slack'){await request(id,config,'auth.test',options);return;}
 if(id==='discord'){await request(id,config,'users/@me',options);if(config.channel||config.token)await execute(id,{limit:1},config,options);return;}
 if(id==='notion'){await execute(id,{limit:1},config,options);return;}
 await execute(id,{limit:1},config,options);
}
function publicPlugins(plugins={}){
 const out={...plugins};
 for(const id of ['github','gmail','outlook',...ids])if(out[id]){
  const config=out[id];out[id]={...config,credentialConfigured:!!(config.token||config.password||config.accessToken||config.refreshToken||config.encryptedToken||config.encryptedPassword||config.encryptedAccessToken||config.encryptedRefreshToken)};
  for(const field of ['token','password','clientSecret','accessToken','refreshToken']){delete out[id][field];delete out[id]['encrypted'+field[0].toUpperCase()+field.slice(1)];}
  // Older versions let an app password be entered in this public field.
  if(['gmail','drive','calendar'].includes(id)&&out[id].clientId&&!/^[a-zA-Z0-9._-]+\.apps\.googleusercontent\.com$/.test(out[id].clientId))delete out[id].clientId;
 }
 return out;
}
module.exports={DEFINITIONS,ids,TOOLS,request,execute,checkConnection,publicPlugins};
