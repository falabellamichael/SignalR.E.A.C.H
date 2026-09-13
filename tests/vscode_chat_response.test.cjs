const {test}=require('node:test');
const assert=require('node:assert/strict');
const {readChatResponse}=require('../vscode/chat-response');

test('SSE across byte boundaries preserves Unicode, trailing data and metadata while hiding both reasoning formats',async()=>{
 const wire='data: '+JSON.stringify({choices:[{delta:{reasoning:'private'}}]})+'\r\n\r\n'
  +'data: '+JSON.stringify({choices:[{delta:{reasoning_content:'also private',content:'Hello 🌱'}}]})+'\n\n'
  +'data: '+JSON.stringify({choices:[{delta:{content:' world'},finish_reason:'stop'}],usage:{completion_tokens:10}});
 const bytes=new TextEncoder().encode(wire),texts=[];
 const response=new Response(new ReadableStream({start(c){for(const byte of bytes)c.enqueue(Uint8Array.of(byte));c.close();}}));
 const result=await readChatResponse(response,{stream:true,onText:t=>texts.push(t)});
 assert.equal(result.content,'Hello 🌱 world');assert.equal(texts.join(''),result.content);
 assert.equal(result.reasoningChars,19);assert.equal(result.finishReason,'stop');
 assert.equal(result.usage.completion_tokens,10);
});

test('JSON fallback preserves errors and distinguishes reasoning from content',async()=>{
 const result=await readChatResponse(new Response(JSON.stringify({choices:[{message:{content:null,reasoning:'trace'},finish_reason:'length'}]})),{stream:true});
 assert.equal(result.content,'');assert.equal(result.reasoningChars,5);assert.equal(result.finishReason,'length');
 const failure=await readChatResponse(new Response('{"error":{"message":"quota exceeded"}}'),{stream:true});
 assert.equal(failure.error,'quota exceeded');
});

test('an answer carried in text blocks is rendered but native tools are recorded separately',async()=>{
 const result=await readChatResponse(new Response(JSON.stringify({choices:[{message:{content:[{type:'text',text:'Answer'}],tool_calls:[{}]}}]})));
 assert.equal(result.content,'Answer');assert.equal(result.toolCalls,true);
});

test('DONE terminates a stream even when the endpoint leaves the connection open', {timeout:1000}, async()=>{
 let cancelled=false;
 const wire='data: '+JSON.stringify({choices:[{delta:{content:'Ready'}}]})+'\n\ndata: [DONE]\n\ndata: {"error":"must be ignored"}\n\n';
 const response=new Response(new ReadableStream({start(c){c.enqueue(new TextEncoder().encode(wire));},cancel(){cancelled=true;}}));
 const result=await readChatResponse(response,{stream:true});
 assert.equal(result.content,'Ready');assert.equal(result.error,null);assert.equal(cancelled,true);
});

test('Stop interrupts an idle stream read', {timeout:1000}, async()=>{
 const controller=new AbortController();let cancelled=false;
 const response=new Response(new ReadableStream({cancel(){cancelled=true;}}));
 const pending=readChatResponse(response,{stream:true,signal:controller.signal});
 controller.abort();
 await assert.rejects(pending,{name:'AbortError'});assert.equal(cancelled,true);
});

test('native function calls assemble across SSE chunks without consuming reasoning as actions',async()=>{
 const chunks=[{reasoning_content:'private',tool_calls:[{index:0,type:'function',function:{name:'re',arguments:'{"path":'}}]},
  {tool_calls:[{index:0,function:{name:'ad',arguments:'"README.md"}'}}]}];
 const wire=chunks.map(delta=>'data: '+JSON.stringify({choices:[{delta}]})+'\n\n').join('')+'data: [DONE]\n\n';
 const result=await readChatResponse(new Response(wire,{headers:{'content-type':'text/event-stream'}}),{stream:false});
 assert.equal(result.content,'');assert.equal(result.reasoningChars,7);
 assert.deepEqual(result.nativeActions,[{type:'function',function:{name:'read',arguments:'{"path":"README.md"}'}}]);
 const decoded=require('../vscode/agent-action').decodeReply(result);
 assert.deepEqual(decoded.tools,[{path:'README.md',action:'read'}]);
});

test('refusals and invalid native call indexes are explicit errors',async()=>{
 for(const message of [{refusal:'Cannot comply',content:'{}'},
  {tool_calls:[{index:99,type:'function',function:{name:'read',arguments:'{}'}}]}]){
  const result=await readChatResponse(new Response(JSON.stringify({choices:[{message}]})));
  assert.match(result.error,/No action was executed/);
 }
});
