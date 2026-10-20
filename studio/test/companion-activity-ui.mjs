import fs from 'node:fs/promises';import assert from 'node:assert/strict';
const root=new URL('../renderer/',import.meta.url);
export default async function(page){
 await page.setContent('<html><head><title>Companion activity QA</title></head><body><div id="companion-panel"><div id="host"></div></div></body></html>');
 await page.addStyleTag({content:await fs.readFile(new URL('companion-activity.css',root),'utf8')});
 await page.addStyleTag({content:'body{background:#171c16;color:#e5ecd7;padding:18px;font:13px system-ui}'});
 for(const file of ['activity-state.js','companion-activity.js'])await page.addScriptTag({content:await fs.readFile(new URL(file,root),'utf8')});
 await page.addScriptTag({content:`const view=ReachCompanionActivity.mount(document.querySelector('#host'));view.event({type:'run-state',status:'running'});view.event({type:'tool-call',tool:'weather.current'});view.event({type:'tool-result',ok:true,result:{temperature:'12 C',untrusted:'<img src=x onerror=alert(1)>'}});view.event({type:'request-start'});view.event({type:'reasoning',chars:42});`});
 assert.equal(await page.locator('.steps-chip').innerText(),'Thinking');assert.equal(await page.locator('img').count(),0);
 await page.locator('.step-details').nth(1).locator('summary').click();
 await page.addScriptTag({content:"view.event({type:'approval-wait'});"});assert.match(await page.locator('.steps-chip').innerText(),/approval/);assert.equal(await page.locator('.step-details').nth(1).getAttribute('open'),'');
 await page.addScriptTag({content:"view.event({type:'approval-end'});view.event({type:'delta',text:'Answer'});view.event({type:'run-state',status:'completed'});"});
 assert.equal(await page.locator('.steps-chip').innerText(),'Completed');
 for(const width of [420,600]){await page.setViewportSize({width,height:650});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);}
 await page.emulateMedia({reducedMotion:'reduce'});assert.equal(await page.locator('.mini-spin').first().evaluate(el=>getComputedStyle(el).animationName),'none');
 return {toolResultSafe:true,thinking:true,approvalWait:true,detailsPreserved:true,completed:true,widths:[420,600],reducedMotion:true};
}
