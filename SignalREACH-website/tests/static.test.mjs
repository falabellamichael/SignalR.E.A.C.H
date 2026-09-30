import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile, access} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const pages=['index','platform','integrations','docs','about','download'];
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
 assert.match(css,/#d4af37/i);assert.match(css,/#161618/i);
 assert.match(css,/prefers-reduced-motion/);assert.match(css,/data-theme=light/);
 const scripts=await Promise.all(['theme','data','app','chat-engine','chat-ui'].map(n=>readFile(path.join(root,`assets/${n}.js`),'utf8')));
 for(const script of scripts)assert.doesNotThrow(()=>new Function(script));
 assert.match(scripts[2],/Object\.hasOwn\(productMap, key\)/);
 assert.match(scripts[4],/textContent=text/,'user prompt must be rendered as text');
 assert.match(scripts[3],/local, scripted demo/);
 assert.match(scripts[4],/controller\.abort\(\)/);
 assert.match(scripts[4],/if \(busy \|\| destroyed \|\| composing\) return/);
 assert.ok(!css.includes('@import'),'no remote font or stylesheet import');
});
