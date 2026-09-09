const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname,'../vscode/media/chat.js'),'utf8');

function toolParser() {
 const ctx = {};
 vm.runInNewContext(source.slice(source.indexOf('  function repairJson('), source.indexOf('  function diffLines('))
   + source.slice(source.indexOf('  function maskFenced('), source.indexOf('  /* ---------- Cursor-style step tracker')), ctx);
 return ctx;
}

test('XML tool requests from the reported reply execute a read with the requested range', () => {
 const ctx = toolParser();
 ctx.pendingText = '<tool>\n{"action": "read", "path": "README.md", "start_line": 1, "end_line": 260}\n</tool>';
 const calls = [];
 Object.assign(ctx, { busy: true, rafPending: false, stopRequested: false, agenticEnabled: true, pendingEdits: [], agentRounds: 0, MAX_AGENT_ROUNDS: 40,
   pendingBubble: {}, activeResponseStep: null, setRich() {}, startSteps() {}, showThinking() {},
   addStepRow() {}, post: (type, payload) => calls.push({type, ...payload}) });
 vm.runInNewContext(source.slice(source.indexOf('  function beginToolRound('), source.indexOf('  function continueAgent(')), ctx);
 const done = source.slice(source.indexOf("      case 'done': {"), source.indexOf("      case 'toolResult': {"));
 vm.runInNewContext('const msg = {}; switch("done") {\n' + done + '\n}', ctx);
 assert.equal(calls.length, 1);
 assert.equal(calls[0].type, 'toolReq');
 assert.equal(calls[0].path, 'README.md');
 assert.equal(calls[0].startLine, 1);
 assert.equal(calls[0].endLine, 260);
 assert.equal(ctx.pendingText, '', 'tool markup is removed from the visible response');
});

test('mixed tool wrappers retain order, normalize range aliases, and preserve surrounding prose', () => {
 const ctx = toolParser();
 const parsed = ctx.extractTools('Reading first.\n<tool>{"action":"read","path":"a.js","start_line":2,"end_line":8}</tool>\n'
   + 'Then searching.\n```tool\n{"action":"search","pattern":"TODO"}\n```\n'
   + '<tool>{"action":"read","path":"b.js","startLine":11,"endLine":20}</tool>');
 assert.deepEqual(Array.from(parsed.tools, t => t.action), ['read','search','read']);
 assert.equal(parsed.tools[0].startLine, 2); assert.equal(parsed.tools[2].endLine, 20);
 assert.equal(parsed.text, 'Reading first.\n\nThen searching.');
});

test('incomplete, unsupported, malformed, and unwrapped tool requests do not execute', () => {
 const ctx = toolParser();
 for (const text of ['<tool>{"action":"read","path":"a.js"}',
   '<tool>{"action":"delete","path":"a.js"}</tool>', '<tool>bad JSON</tool>',
   '{"action":"read","path":"a.js"}', '```json\n{"action":"read","path":"a.js"}\n```']) {
   const parsed = ctx.extractTools(text);
   assert.equal(parsed.tools.length, 0); assert.equal(parsed.text, text);
 }
 assert.equal(ctx.maskFenced('Reading.\n<tool>{"action":"read"'), 'Reading.\n…');
 assert.equal(ctx.maskFenced('<tool>{"action":"read"}</tool>\n```tool\n{}\n```'), '…');
});

test('later tool rounds retain earlier file contents and line ranges reach the host',()=>{
 const parser=source.slice(source.indexOf('  function extractTools('),source.indexOf('  function diffLines('));
 const continuation=source.slice(source.indexOf('  function continueAgent('),source.indexOf('  /* ---------- per-message actions'));
 const calls=[];
 const workspaceCase=source.slice(source.indexOf("      case 'contextInfo': {"),source.indexOf("        showStep('Workspace context ready'",source.indexOf("      case 'contextInfo': {")));
 const ctx={conv:{model:'copilot-chat'},agentMessages:[{role:'user',content:'Read both complete files.'}],
  contTools:[{action:'read',path:'one.js',result:'FIRST_FILE_END'}],pendingText:'Reading one.js',agentRounds:0,pendingBubble:null,
  repairJson:x=>x,post:(type,payload)=>calls.push(payload),pickVoice:()=>({text:''}),showStep:()=>{}};
 vm.runInNewContext(workspaceCase.replace("      case 'contextInfo': {",'')+'\n', {...ctx,msg:{context:'AUTO_READ_FILE_END'}});
 vm.runInNewContext(parser+continuation+'\ncontinueAgent();',ctx);
 assert.equal(ctx.pendingText,'','the next stream starts without repeating the previous update');
 ctx.contTools=[{action:'read',path:'two.js',result:'SECOND_FILE_END'}];
 ctx.pendingText='Reading two.js';
 vm.runInNewContext('continueAgent();',ctx);
 const sent=calls[1].body.messages.map(m=>m.content).join('\n');
 assert.match(sent,/AUTO_READ_FILE_END/);assert.match(sent,/FIRST_FILE_END/);assert.match(sent,/SECOND_FILE_END/);
 const tools=vm.runInNewContext('extractTools(\'```tool\\n{"action":"read","path":"file.js","startLine":201,"endLine":400}\\n```\').tools',ctx);
 assert.equal(tools[0].startLine,201);assert.equal(tools[0].endLine,400);
});
