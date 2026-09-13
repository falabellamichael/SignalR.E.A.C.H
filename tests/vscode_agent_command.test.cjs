'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), vm = require('node:vm');
const {EventEmitter} = require('node:events');
const {runAgentCommand} = require('../vscode/agent-command');

test('an approved command executes once and returns the same output shown to the user', async t => {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'reach-command-'));
 const script=path.join(dir,'fixture.js'), count=path.join(dir,'count.txt');
 fs.writeFileSync(script,'require("fs").appendFileSync("count.txt","1"); console.log("SINGLE_RUN"); console.error("STDERR");');
 t.after(()=>{for(const file of [script,count])if(fs.existsSync(file))fs.unlinkSync(file);fs.rmdirSync(dir);});
 let displayed='';
 const result=await runAgentCommand('node fixture.js',{cwd:dir,onOutput:text=>{displayed+=text;}});
 assert.equal(result.ok,true);assert.equal(result.code,0);assert.equal(fs.readFileSync(count,'utf8'),'1');
 assert.match(result.output,/SINGLE_RUN/);assert.match(result.output,/STDERR/);
 assert.match(displayed,/SINGLE_RUN/);assert.match(displayed,/exit code 0/);
});

function mockedRunner() {
 const calls=[],timers=new Set();
 const child=new EventEmitter();child.stdout=new EventEmitter();child.stderr=new EventEmitter();child.pid=12345;
 child.kill=()=>calls.push({kill:true});
 const spawn=(command,args,options)=>{
  calls.push({command,args,options});
  if(command==='taskkill') {const killer=new EventEmitter();queueMicrotask(()=>child.emit('close',1));return killer;}
  return child;
 };
 const ctx={module:{exports:{}},require:name=>({spawn}),process:{platform:'win32',env:{}},
  setTimeout:fn=>{timers.add(fn);return fn;},clearTimeout:fn=>timers.delete(fn)};
 vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../vscode/agent-command.js'),'utf8'),ctx);
 return {run:ctx.module.exports.runAgentCommand,calls,child,timers};
}

test('Stop and timeout terminate only the spawned process tree and report failure',async()=>{
 for(const timeout of [false,true]){
  const f=mockedRunner(),controller=new AbortController();
  const pending=f.run('approved-command',{signal:controller.signal});
  f.child.stdout.emit('data','partial output');
  if(timeout) [...f.timers][0](); else controller.abort();
  const result=await pending;
  assert.equal(f.calls.length,2);assert.equal(f.calls[1].command,'taskkill');
  assert.deepEqual(Array.from(f.calls[1].args),['/PID','12345','/T','/F']);
  assert.equal(result.ok,false);assert.match(result.output,/partial output/);
  assert.match(result.output,timeout?/Timed out/:/Stopped by you/);assert.equal(f.timers.size,0);
 }
});

test('completed commands clear timers and abort listeners, and nonzero exit stays a failure',async()=>{
 const f=mockedRunner(),controller=new AbortController();
 const pending=f.run('approved-command',{signal:controller.signal});
 f.child.emit('close',7);const result=await pending;
 assert.equal(result.ok,false);assert.equal(result.code,7);assert.equal(f.timers.size,0);
 controller.abort();assert.equal(f.calls.length,1);
});

test('an already stopped request never spawns a command',()=>{
 const f=mockedRunner(),controller=new AbortController();controller.abort();
 assert.throws(()=>f.run('never-run',{signal:controller.signal}),{name:'AbortError'});
 assert.equal(f.calls.length,0);
});
