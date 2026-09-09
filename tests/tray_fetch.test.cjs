const {test}=require('node:test');
const assert=require('node:assert/strict');
const http=require('node:http');
const https=require('node:https');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'../copilot/tray/main.js'),'utf8');
const section=source.slice(source.indexOf('function _fetchText('),source.indexOf('function stripTags('));
const context={http,https,URL,AbortController,setTimeout,clearTimeout,_hostIsPublic:async()=>true};
vm.runInNewContext(section,context);
async function server(t, handler){const s=http.createServer(handler);await new Promise(r=>s.listen(0,'127.0.0.1',r));t.after(()=>{s.closeAllConnections();s.close();});return `http://127.0.0.1:${s.address().port}`;}
test('oversized web pages resolve a bounded excerpt rather than leaving chat pending',async t=>{
 const url=await server(t,(_req,res)=>{res.writeHead(200,{'Content-Type':'text/html'});res.end('x'.repeat(600000));});
 assert.equal((await context.fetchPage(url,1000)).length,400000);
});
test('stalled web response has an overall deadline and aborts the request',async t=>{
 const url=await server(t,(_req,res)=>{res.writeHead(200,{'Content-Type':'text/html'});res.write('waiting');});
 await assert.rejects(context.fetchPage(url,100),/timed out/);
});
