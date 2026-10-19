import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
const renderer = new URL('../renderer/', import.meta.url);
export default async function(page) {
  await page.setContent('<html><head><title>Shared bot work actions</title></head><body></body></html>');
  await page.addStyleTag({content:await fs.readFile(new URL('styles.css',renderer),'utf8')});
  await page.addStyleTag({content:'body {display:grid;grid-template-columns:repeat(4,1fr);height:auto;overflow:auto;gap:16px;padding:24px;background:#101510;color:#edf1de;font:14px Georgia} section {border:1px solid #3d5036;padding:18px;border-radius:16px} strong {display:block;margin-top:12px}'});
  await page.addScriptTag({content:await fs.readFile(new URL('member-designs.js',renderer),'utf8')});
  await page.addScriptTag({content:`
    for (const [action,label] of Object.entries(ReachMemberDesigns.actions)) {
      const tile=document.createElement('section');
      for (const size of [32,64,96]) {
        tile.insertAdjacentHTML('beforeend',ReachMemberDesigns.svg(ReachMemberDesigns.encode({...ReachMemberDesigns.config('bot-21'),animation:'dance'}),size));
        ReachMemberDesigns.applyAction(tile.lastElementChild,action);
      }
      const title=document.createElement('strong');title.textContent=label;tile.append(title);document.body.append(tile);
    }
  `});
  await page.setViewportSize({width:1300,height:850});
  await page.emulateMedia({reducedMotion:'no-preference'});
  const result=await page.locator('svg').evaluateAll(svgs=>svgs.map(svg=>{
    const visible=[...svg.querySelectorAll('.bot-work-effects > g')].filter(g=>getComputedStyle(g).display!=='none');
    const animations=svg.getAnimations({subtree:true});
    const before=svg.dataset.animation;
    const moving=animations.length;
    animations.forEach(a=>{a.pause();a.currentTime=500;});
    return {action:svg.dataset.action,visible:visible.length,moving,before,label:svg.getAttribute('aria-label')};
  }));
  for (const item of result) {
    assert.equal(item.visible,item.action==='idle'?0:1,item.action);
    assert.equal(item.before,'dance');
    if (!['paused'].includes(item.action)) assert.ok(item.moving>0,item.action);
    if(item.action!=='idle') assert.match(item.label, / - /);
  }
  const activeFrames = await page.locator('svg:not([data-action="idle"]) .bot-motion-frame').evaluateAll(frames=>frames.map(el=>getComputedStyle(el).transform));
  await page.emulateMedia({reducedMotion:'reduce'});
  assert.deepEqual(await page.locator('svg:not([data-action="idle"]) .bot-motion-frame').evaluateAll(frames=>frames.map(el=>getComputedStyle(el).transform)),activeFrames);
  assert.equal(await page.locator('svg[data-action="idle"] .bot-motion-frame').first().evaluate(el=>getComputedStyle(el).transform),'none');
  assert.equal(await page.locator('svg').evaluateAll(svgs=>svgs.reduce((n,s)=>n+s.getAnimations({subtree:true}).length,0)),0);
  await page.emulateMedia({reducedMotion:'no-preference'});
  return {actions:12,portraits:result.length,sizes:[32,64,96],reducedMotion:true,staticStateSymbols:true};
}
