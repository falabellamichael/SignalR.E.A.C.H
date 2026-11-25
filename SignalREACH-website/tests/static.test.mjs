import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile, access} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const pages=['index','platform','integrations','docs','about','download','subscription','login','profile','privacy'];
for(const page of pages){
 test(`${page}: structure, unique IDs, and local links`,async()=>{
   const html=await readFile(path.join(root,page+'.html'),'utf8');
   assert.match(html,/<!doctype html>/i);
   assert.match(html,/<html[^>]*lang="en"/);
   assert.equal((html.match(/<h1(?:\s|>)/g)||[]).length,1);
   assert.match(html,/<meta name="description" content="[^"]+"/);
   assert.match(html,/<main[^>]+id="main"/);
   assert.match(html,/prefers-reduced-motion|motion-toggle/);
   const ids=[...html.matchAll(/\sid="([^"]+)"/g)].map(x=>x[1]);
   assert.equal(ids.length,new Set(ids).size,'duplicate HTML IDs');
   for(const [,target] of html.matchAll(/(?:href|src)="([^"]*)"/g)){
     assert.ok(target && target!=='#','empty or placeholder link');
     if(/^(https?:|mailto:|data:|#)/.test(target))continue;
     const file=target.split(/[?#]/)[0];
     await access(path.join(root,file));
   }
   for(const [,attrs] of html.matchAll(/<a\s([^>]+)>/g)){
     if(attrs.includes('target="_blank"'))assert.match(attrs,/rel="[^"]*noopener/);
   }
 });
}
test('Brand, motion, and offline assets',async()=>{
 const css=await readFile(path.join(root,'assets/styles.css'),'utf8');
 assert.match(css,/#a6cf45/i);assert.match(css,/#161618/i);
 assert.match(css,/prefers-reduced-motion/);assert.match(css,/data-theme=light/);
 const scripts=await Promise.all(['theme','data','app','chat-engine','chat-ui','automation-demo'].map(n=>readFile(path.join(root,`assets/${n}.js`),'utf8')));
 for(const script of scripts)assert.doesNotThrow(()=>new Function(script));
 assert.match(scripts[2],/Object\.hasOwn\(productMap, key\)/);
 assert.match(scripts[4],/textContent=text/,'user prompt must be rendered as text');
 assert.match(scripts[3],/local, scripted demo/);
 assert.match(scripts[4],/controller\.abort\(\)/);
 assert.match(scripts[4],/if \(busy \|\| destroyed \|\| composing\) return/);
 assert.ok(!css.includes('@import'),'no remote font or stylesheet import');
 const home=await readFile(path.join(root,'index.html'),'utf8');
 const plan=await readFile(path.join(root,'subscription.html'),'utf8');
 assert.match(home,/href="subscription\.html"[^>]*>Subscription</);
 assert.match(home,/href="login\.html"/);
 assert.match(home,/CAD \$25\.00/);
 assert.match(plan,/id="subscription-checkout"/);
 assert.match(plan,/assets\/account\.js/);
 assert.doesNotMatch(plan,/href="https:\/\/checkout\.stripe\.com"/,'checkout must be created for the authenticated account, not a generic Stripe link');
 assert.match(plan,/Subscribe with Stripe/);
 const catalog=plan.match(/<ul class="model-list" id="subscription-model-list">([\s\S]*?)<\/ul>/)[1];
 const modelIds=[...catalog.matchAll(/Model ID: ([a-z0-9.-]+)</g)].map(match=>match[1]);
 assert.deepEqual(modelIds,['qwen3.8-27b','lfm3-omni-2b','bge-m3','bge-reranker-v2-m3','inkling-2-mini','edge0-120b']);
 assert.doesNotMatch(catalog,/token context/);
 assert.match(catalog,/<small>Embeddings<\/small>/);
 assert.match(catalog,/<small>Reranking<\/small>/);
 assert.equal((catalog.match(/<small>Chat<\/small>/g)||[]).length,4);
 assert.match(plan,/id="subscription-model-status"/);
 assert.match(plan,/assets\/subscription-catalog\.js/);
 assert.match(plan,/<details class="model-benchmarks"/);
 assert.match(plan,/Reference benchmarks for LFM3 1\.7B/);
 assert.equal((plan.match(/<th scope="row">/g)||[]).length,16);
 assert.match(plan,/tax included/);
 assert.match(plan,/REACH Subscription Plus/);
});
