import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../assets/chat-engine.js';
const E = globalThis.SignalREACHChat;
const reply = (text, settings) => E.createSession().reply(text, settings);
for (const topic of E.topics) {
  test(`catalog: ${topic.label} routes and has valid links/follow-ups`, () => {
    const exact = reply(topic.keywords[0]);
    assert.equal(exact.intent,topic.id);
    const r = reply(topic.label,{intent:topic.id,mode:'steps'});
    assert.equal(r.intent,topic.id); assert.ok(r.text.length > 30); assert.ok(r.steps.length >= 2);
    assert.ok(reply(topic.label,{intent:topic.id,mode:'example'}).example.length > 20);
    assert.ok(r.suggestions.length >= 2);
    for(const item of r.suggestions) assert.ok(E.topics.some(t => t.id === item.id));
    for(const action of r.actions) assert.ok(E.actions[action],`unknown action ${action}`);
  });
}
const cases = [
  ['What can REACH do?','overview'],
  ['PLEASE HELP ME BUILD A RESPONSIVE WEBSITE!','website'],
  ['I want to debug my React component','debugging'],
  ['conect a modle','endpoints'],
  ['accesibility','accessibility'],
  ['instalation','install'],
  ['streamng','streaming'],
  ['set up Ollama','local'],
  ['can I use LM Studio?','local'],
  ['My API returns 401','authentication'],
  ['My endpoint won’t connect','network'],
  ['unknown model ID returns 404','notfound'],
  ['What does a 429 error mean?','rateLimit'],
  ['CORS error on localhost','cors'],
  ['fix the 401 error','authentication'],
  ['offline model','local'],
  ['offline demo','limits'],
  ['How do I run tests?','tests'],
  ['Change the colour palette','themes'],
  ['thèmes','themes'],
  ['hello there','greeting'],
  ['<img src=x onerror=alert(1)> Tell me about themes','themes'],
  ['this is unrelated','fallback'],
  ['What is the capital of France?','fallback'],
  ['tell me a joke','fallback'],
  ['what is the weather today','fallback'],
  ['a'.repeat(4000),'fallback'],
];
for (const [text,id] of cases) test(`intent: ${text.slice(0,65)}`,()=>assert.equal(reply(text).intent,id));
test('examples and detailed phrasing select response style',()=>{
  assert.ok(reply('show a website example').example);
  assert.ok(reply('explain endpoints step by step').steps.length);
});
test('context follows the selected topic without changing it accidentally',()=>{
  const s = E.createSession();
  assert.equal(s.reply('agent teams').intent,'agents');
  assert.equal(s.reply('tell me more').intent,'agents');
  const example=s.reply('show an example');assert.equal(example.intent,'agents');assert.ok(example.example);
  assert.equal(s.reply('shorter').mode,'quick');
  assert.equal(s.reply('yes please').intent,'personas');
  assert.equal(s.reply('what next').intent,'agents');
});
test('unmatched questions are honest and do not overwrite the previous topic',()=>{
  const s=E.createSession();s.reply('themes');
  const unknown=s.reply('elephants on mars');assert.equal(unknown.intent,'fallback');assert.equal(unknown.matched,false);
  assert.match(unknown.text,/not a live AI/);
  assert.equal(s.reply('more').intent,'themes');
});
test('repeat answers add detail rather than giving only the same summary',()=>{
 const s=E.createSession();assert.equal(s.reply('themes').steps.length,0);assert.ok(s.reply('themes').steps.length);
});
test('each session is isolated and reset clears follow-up state',()=>{
 const a=E.createSession(),b=E.createSession();a.reply('models');b.reply('agents');
 assert.equal(a.reply('/example').intent,'models');assert.equal(b.reply('/example').intent,'agents');
 a.reply('/clear');assert.equal(a.getContext().lastIntent,null);assert.equal(a.reply('more').intent,'overview');
});
test('commands have explicit behavior',()=>{
 const s=E.createSession();
 for(const [command,result] of [['/clear','clear'],['/reset','clear'],['/export','export'],['/topics','topics']]) assert.equal(s.reply(command).command,result);
 assert.equal(s.reply('/help').intent,'shortcuts');
 const first=s.reply('/random').intent;assert.notEqual(s.reply('/random').intent,first);
 assert.ok(s.reply('/steps').steps.length);assert.ok(s.reply('/example').example);
});
test('empty, invalid settings, and oversized input remain safe',()=>{
 assert.equal(reply('   '),null);assert.equal(reply(null),null);
 assert.equal(reply('themes',{mode:'invalid',intent:'constructor'}).intent,'themes');
 assert.equal(E.normalize('x'.repeat(2000)).length,600);
 assert.equal(reply('topics with data',{intent:'__proto__'}).matched,false);
});
test('catalog identifiers are unique and the keyword count is accurate',()=>{
 assert.equal(new Set(E.topics.map(t=>t.id)).size,E.topics.length);
 assert.equal(E.topics.length,47);assert.equal(E.keywordCount,E.topics.reduce((n,t)=>n+t.keywords.length,0));
});
