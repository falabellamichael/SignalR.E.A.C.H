import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import vm from 'node:vm';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = await readFile(path.join(root,'assets/chat-conversations.js'),'utf8');
const baseSource = await readFile(path.join(root,'assets/chat-engine.js'),'utf8');
const context = vm.createContext({});
vm.runInContext(baseSource,context);
const original = context.SignalREACHChat;
vm.runInContext(source,context);
const E = context.SignalREACHChat;
const talk = (scene,branch) => `talk:${scene.id}${branch ? '/'+branch.id : ''}`;
function validReply(reply) {
  assert.ok(reply && reply.text.length > 25);
  assert.ok(Array.isArray(reply.steps)); assert.ok(Array.isArray(reply.actions));
  assert.ok(reply.suggestions.length >= 2);
  for (const suggestion of reply.suggestions) {
    assert.ok(suggestion.id && suggestion.prompt && suggestion.label);
    assert.equal(E.createSession().reply(suggestion.prompt,{intent:suggestion.id}).intent,suggestion.id);
  }
}
test('exactly 50 authored trees, 200 nodes, and 400 selectable replies',()=>{
  assert.equal(E.conversationCount,50); assert.equal(E.conversationNodeCount,200); assert.equal(E.conversationReplyCount,400);
  assert.equal(E.topics.length,94);
  assert.equal(new Set(E.conversations.map(scene=>scene.id)).size,50);
  assert.equal(new Set(E.topics.map(topic=>topic.id)).size,E.topics.length);
  for(const scene of E.conversations) {
    assert.equal(scene.branches.length,3); assert.equal(new Set(scene.branches.map(branch=>branch.id)).size,3);
    assert.equal(new Set(scene.replies).size,2);
    for (const branch of scene.branches) {
      assert.equal(new Set(branch.replies).size,2);
      assert.ok(branch.next==='@resume' || E.topics.some(topic=>topic.id===branch.next));
    }
  }
});
for (const scene of E.conversations) {
  for (const keyword of scene.keywords) test(`opening ${scene.id}: ${keyword}`,()=>{
    const r=E.createSession().reply(keyword); assert.equal(r.intent,talk(scene)); validReply(r);
  });
  for (const branch of scene.branches) {
    for (const keyword of branch.keywords) test(`branch ${scene.id}/${branch.id}: ${keyword}`,()=>{
      const session=E.createSession(); session.reply(scene.keywords[0],{intent:talk(scene)});
      const r=session.reply(keyword); assert.equal(r.intent,talk(scene,branch)); validReply(r);
    });
    test(`node ${scene.id}/${branch.id}: variation, detail, example and next`,()=>{
      const session=E.createSession();
      const first=session.reply(branch.label,{intent:talk(scene,branch)});
      const second=session.reply(branch.label,{intent:talk(scene,branch)});
      assert.notEqual(first.text,second.text);
      const detail=session.reply('/steps'); assert.equal(detail.intent,talk(scene,branch)); assert.ok(detail.steps.length>=2);
      const example=session.reply('/example'); assert.equal(example.intent,talk(scene,branch)); assert.match(example.example,/Example scripted conversation/);
      const next=session.reply('what next'); assert.ok(next.matched); validReply(next);
    });
  }
  test(`opening ${scene.id}: two variants and style options`,()=>{
    const session=E.createSession();
    const a=session.reply(scene.label,{intent:talk(scene)}),b=session.reply(scene.label,{intent:talk(scene)});
    assert.notEqual(a.text,b.text);
    assert.ok(session.reply(scene.label,{intent:talk(scene),mode:'steps'}).steps.length);
    assert.ok(session.reply(scene.label,{intent:talk(scene),mode:'example'}).example);
  });
}
const paths = [
  [['hey, how are you?','talk:hello'],['im tired','talk:hello/tired'],['tiny task','talk:tired/tiny'],['tell me more','talk:tired/tiny'],['show an example','talk:tired/tiny']],
  [['im bored','talk:bored'],['a riddle','talk:bored/riddle'],['hint','talk:riddle/hint'],['answer','talk:riddle/answer']],
  [['good morning','talk:morning'],['coffee first','talk:morning/coffee'],['tea actually','talk:coffee/tea']],
  [['project idea','talk:project'],['website','talk:project/website'],['portfolio','talk:site/portfolio'],['yes','website']],
  [['hey my endpoint returns 401','authentication'],['thanks','talk:thanks'],['continue','authentication'],['show an example','authentication']],
  [['im confused','talk:confused'],['example','talk:confused/example'],['limits','talk:demo/limits']]
];
for (const [index, turns] of paths.entries()) test(`multi-turn conversation ${index+1}`,()=>{
  const session=E.createSession(); for(const [prompt,intent] of turns) assert.equal(session.reply(prompt).intent,intent,prompt);
});
for (const prompt of ['heyyy','HIIII!','HEY, HOW R U?','hi there','good afternoon']) test(`greeting normalization: ${prompt}`,()=>assert.equal(E.createSession().reply(prompt).intent,'talk:hello'));
for (const topic of original.topics.filter(topic=>!['greeting','thanks','goodbye'].includes(topic.id))) test(`existing topic preserved: ${topic.id}`,()=>{
  const expected=original.createSession().reply(topic.keywords[0]); const actual=E.createSession().reply(topic.keywords[0]);
  assert.equal(actual.intent,expected.intent);
});
for (const [prompt,intent] of [['hello I need help with a 401 error','authentication'],['hey why am I getting 429','rateLimit'],['hi my endpoint is returning 404','notfound'],['hey CORS error on localhost','cors'],['conect a modle','endpoints'],['accesibility','accessibility'],['PLEASE HELP ME BUILD A RESPONSIVE WEBSITE!','website']]) test(`technical routing: ${prompt}`,()=>{
  const session=E.createSession(); session.reply('hey'); assert.equal(session.reply(prompt).intent,intent);
});
test('optional name is session-local, bounded, text-only, and resettable',()=>{
  const a=E.createSession(),b=E.createSession(); a.reply('call me Alex');
  assert.match(a.reply('what is my name').text,/Alex/); assert.doesNotMatch(b.reply('what is my name').text,/call you Alex/);
  assert.match(a.reply('hi').text,/Alex/); a.reply('forget my name'); assert.equal(a.getContext().name,'');
  a.reply('my name is Sam'); a.reply('/clear'); assert.equal(a.getContext().name,''); assert.equal(a.getContext().lastIntent,null);
  a.reply('call me <img src=x onerror=alert(1)>'); assert.equal(a.getContext().name,'');
  a.reply('call me '+ 'A'.repeat(80)); assert.equal(a.getContext().name,'');
});
test('commands and conversation rotation preserve explicit control',()=>{
  const session=E.createSession(); const ids=new Set();
  for(let i=0;i<50;i++) ids.add(session.reply('/conversation').intent);
  assert.equal(ids.size,50); assert.match(session.reply('/help').text,/\/conversation/);
  for(const [command,value] of [['/clear','clear'],['/reset','clear'],['/topics','topics'],['/export','export']]) assert.equal(session.reply(command).command,value);
  session.reply('im bored'); session.reset(); assert.equal(session.getContext().conversationId,null);
  assert.equal(session.reply('tell me more').intent,'overview');
});
test('declining and unknown messages do not invent a completed action',()=>{
  const session=E.createSession();session.reply('im bored');
  assert.match(session.reply('no thanks').text,/another direction/);
  const unknown=session.reply('unmapped cobalt zebras 987654'); assert.equal(unknown.matched,false); assert.match(unknown.text,/not a live AI/);
  assert.equal(session.getContext().conversationId,'bored');
  assert.equal(session.reply('this is unrelated').matched,false);
  assert.equal(E.createSession().reply('what is the weather today').matched,false);
});
test('empty, oversized, malicious and invalid inputs are bounded',()=>{
  const session=E.createSession();
  assert.equal(session.reply(null),null); assert.equal(session.reply('  '),null);
  assert.equal(E.normalize('x'.repeat(6000)).length,600);
  assert.equal(session.reply('x'.repeat(6000)).matched,false);
  assert.equal(session.reply('hi',{intent:'talk:__proto__/constructor',mode:'bad'}).intent,'talk:hello');
  assert.equal(session.reply('hi',{intent:'talk:hello/not-a-node'}).intent,'talk:hello');
  const result=session.reply('<img src=x onerror=alert(1)> hey'); assert.equal(result.intent,'talk:hello'); assert.doesNotMatch(result.text,/<img/);
});
test('catalog is immutable, independent sessions do not share state, and extension is idempotent',()=>{
  assert.ok(Object.isFrozen(E)); assert.ok(Object.isFrozen(E.conversations)); assert.ok(Object.isFrozen(E.conversations[0].branches[0].replies));
  const a=E.createSession(),b=E.createSession(); a.reply('im bored'); b.reply('good morning');
  assert.equal(a.reply('hint').intent,'talk:bored'); // no riddle has been selected yet
  assert.equal(b.reply('plan').intent,'talk:morning/plan');
  vm.runInContext(source,context); assert.equal(context.SignalREACHChat,E);
});
test('extension has no network or persistence APIs',()=>{
  assert.doesNotMatch(source,/\b(?:fetch|XMLHttpRequest|WebSocket|sendBeacon|eval|Function)\s*\(/);
  assert.doesNotMatch(source,/\b(?:localStorage|sessionStorage|indexedDB)\s*\./);
  assert.doesNotMatch(source,/document\s*\.\s*cookie/);
});
test('production bundle includes the extension before the unchanged UI adapter',async()=>{
  execFileSync(process.execPath,['tools/build.mjs'],{cwd:root,stdio:'pipe'});
  const bundled=await readFile(path.join(root,'dist/assets/chat-ui.js'),'utf8');
  const ui=await readFile(path.join(root,'assets/chat-ui.js'),'utf8');
  assert.ok(bundled.startsWith(source)); assert.ok(bundled.endsWith(ui));
  const browser=vm.createContext({}); vm.runInContext(baseSource,browser); vm.runInContext(bundled,browser);
  assert.equal(browser.SignalREACHChat.conversationCount,50);
  assert.equal(typeof browser.SignalREACHChatUI.mount,'function');
  assert.equal(browser.SignalREACHChat.createSession().reply('hey how are you').intent,'talk:hello');
  assert.match(await readFile(path.join(root,'dist/about.html'),'utf8'),/Brought to you by: SimpleRAG Developers/);
});
