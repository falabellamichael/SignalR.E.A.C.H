import fs from 'node:fs/promises';import assert from 'node:assert/strict';
const root=new URL('../renderer/',import.meta.url);
export default async function(page){
 await page.setContent('<html><head><title>Compact connections QA</title></head><body><div id="connections"></div></body></html>');
 await page.addStyleTag({content:await fs.readFile(new URL('app-connections.css',root),'utf8')});
 await page.addStyleTag({content:'body{background:#171c16;color:#e5ecd7;margin:12px}'});
 await page.addScriptTag({content:await fs.readFile(new URL('app-connections.js',root),'utf8')});
 await page.addScriptTag({content:`window.calls=[];let items=['weather','gmail','github','outlook','calendar','drive','slack','notion','discord','todo'].map(id=>({id,name:id==='gmail'?'Gmail':id==='calendar'?'Google Calendar':id,enabled:true,status:{state:'ready'},description:'Read connected app data.',fields:[{key:'token',label:'Access token',secret:true}],actions:[]}));const mounted=ReachAppConnections.mount(document.querySelector('#connections'),async(action,value)=>{calls.push({action,value});return {ok:true,items};});mounted.refresh();`});
 await page.waitForFunction(()=>document.querySelectorAll('.app-connection-card').length===10);
 for(const width of [360,600]){
  await page.setViewportSize({width,height:800});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  assert.ok(await page.locator('.app-connection-card').evaluateAll(rows=>rows.every(row=>row.getBoundingClientRect().height<=44)));
 }
 const card=page.locator('[data-connection=slack]');await card.locator('summary').click();
 await card.getByLabel('Access token').fill('test-token');await card.getByRole('button',{name:'Save',exact:true}).click();
 await page.waitForFunction(()=>calls.some(c=>c.action==='save'));
 assert.equal(await card.getAttribute('open'),'');
 await page.addScriptTag({content:"document.body.dataset.savedToken=calls.find(c=>c.action==='save').value.patch.token;"});
 assert.equal(await page.locator('body').getAttribute('data-saved-token'),'test-token');
 await card.getByRole('button',{name:'Check',exact:true}).click();await page.waitForFunction(()=>calls.some(c=>c.action==='check'));
 assert.equal(await card.getAttribute('open'),'');
 await card.locator('summary').focus();await page.keyboard.press('Enter');assert.equal(await card.getAttribute('open'),null);
 return {rows:10,compactHeight:true,widths:[360,600],save:true,check:true,openStatePreserved:true,keyboardToggle:true};
}
