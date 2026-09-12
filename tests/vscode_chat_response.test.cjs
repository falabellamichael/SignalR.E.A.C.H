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
