import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
const renderer = new URL('../renderer/', import.meta.url);
export default async function (page) {
  await page.setContent('<html><head><title>Agent tile activity QA</title></head><body><div id="drawer"><div id="drawer-menu"></div></div></body></html>');
  for (const file of ['styles.css', 'singular-panel.css']) await page.addStyleTag({ content: await fs.readFile(new URL(file, renderer), 'utf8') });
  await page.addStyleTag({ content: '#drawer { position:static; width:100%; height:auto; } #singular-panel { display:flex; }' });
  for (const file of ['member-designs.js', 'activity-state.js']) await page.addScriptTag({ content: await fs.readFile(new URL(file, renderer), 'utf8') });
  await page.addScriptTag({ content: `
    const $ = s => document.querySelector(s), drawer = $('#drawer');
    const drawerOpen = true, drawerPanel = 'singular';
    const member = {personaId:'builder',personaName:'Builder',role:'Developer',personaModel:'Test model',designId:ReachMemberDesigns.encode({...ReachMemberDesigns.config('bot-01'),animation:'orbit'})};
    const team = {id:'team-1',name:'Test crew',members:[member],mode:'links'};
    const currentAgent = {id:'chat-1',name:'Test chat',settings:{teamChat:{teamId:team.id,enabled:true}}};
    const card = {_teamActivity: ReachActivityState.reduce(null,{type:'run-state',status:'running'}),_crewComms:{sent:2,received:3,inbox:1}};
    card._teamActivity = ReachActivityState.reduce(card._teamActivity,{type:'tool-call',tool:'read_file'});
    const teamConversationViews = new Map([['chat-1',{team,task:'Inspect the project files',cards:new Map([[0,card]])}]]);
    window.ReachWorkspace = {node(tag,cls,text){const el=document.createElement(tag);if(cls)el.className=cls;if(text)el.textContent=text;return el;},action(text,fn){const el=document.createElement('button');el.textContent=text;el.onclick=fn;return el;}};
    const reachApi = {teams:{list:async()=>[team]},git:{info:async()=>({})},telemetry:{sample:async()=>({})}};
  ` });
  await page.addScriptTag({ content: await fs.readFile(new URL('singular-panel.js', renderer), 'utf8') });
  const summary = page.locator('.singular-member-activity summary');
  await summary.waitFor();
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  const portrait = page.locator('.singular-member svg.team-bot');
  assert.equal(await portrait.getAttribute('data-animation'), 'orbit');
  await page.waitForFunction(() => document.querySelector('.team-bot')?.dataset.action === 'scan');
  assert.equal(await portrait.locator('.bot-body').evaluate(el => getComputedStyle(el).animationName), 'none');
  assert.equal(await portrait.locator('.bot-scan-beam').evaluate(el => getComputedStyle(el).animationName), 'bot-holo-scan');
  for (const [type, fields, action] of [
    ['tool-call',{tool:'write_file'},'build'],
    ['tool-call',{tool:'shell'},'execute'],
    ['compaction-start',{},'compress'],
    ['request-start',{},'wait'],
    ['reasoning',{chars:20},'think'],
    ['delta',{text:'Answer'},'transmit'],
    ['approval-wait',{},'wait'],
    ['approval-end',{},'transmit'],
    ['tool-call',{tool:'read_file'},'scan'],
  ]) {
    await page.addScriptTag({content:`card._teamActivity = ReachActivityState.reduce(card._teamActivity,${JSON.stringify({type,...fields})});`});
    await page.waitForFunction(expected => document.querySelector('.team-bot')?.dataset.action === expected, action);
  }
  await page.emulateMedia({reducedMotion:'reduce'});
  assert.equal(await portrait.evaluate(svg=>svg.getAnimations({subtree:true}).length),0);
  assert.equal(await portrait.locator('.bot-action-scan').evaluate(el=>getComputedStyle(el).display),'inline');
  await page.emulateMedia({reducedMotion:'no-preference'});
  assert.match(await summary.innerText(), /read_file/);
  await summary.click();
  assert.match(await page.locator('.singular-member-activity').innerText(), /Inspect the project files/);
  assert.equal(await page.locator('.singular-member-facts dt').allTextContents().then(labels => labels.join(',')), 'Model');
  assert.equal(await page.locator('.singular-member-pulse').count(), 0);
  await page.addScriptTag({ content: `card._teamActivity = ReachActivityState.reduce(card._teamActivity,{type:'run-state',status:'completed'});` });
  await page.waitForFunction(() => document.querySelector('.singular-member-activity summary').textContent === 'Completed');
  assert.equal(await page.locator('.singular-member-activity').getAttribute('open'), '');
  await page.waitForFunction(()=>document.querySelector('.team-bot')?.dataset.action==='complete');
  await page.waitForFunction(()=>document.querySelector('.team-bot')?.dataset.action==='idle');
  assert.equal(await portrait.locator('.bot-body').evaluate(el=>getComputedStyle(el).animationName),'bot-orbit');
  assert.equal(await summary.innerText(),'Completed');
  await page.addScriptTag({ content: `currentAgent.settings.teamChat.enabled = false; document.dispatchEvent(new Event('reach-team-settings-changed'));` });
  await page.locator('.singular-team-list').waitFor({ state: 'hidden' });
  await page.addScriptTag({ content: `currentAgent.settings.teamChat.enabled = true; document.dispatchEvent(new Event('reach-team-settings-changed'));` });
  await summary.waitFor({ state: 'visible' });
  assert.equal(await page.locator('.singular-member').count(), 1);
  await page.addScriptTag({ content: `currentAgent.id = 'another-chat';` });
  await page.waitForFunction(() => document.querySelector('.singular-member-activity summary').textContent.startsWith('Idle'));
  assert.doesNotMatch(await page.locator('.singular-member-activity').innerText(), /Inspect the project files/);
  assert.equal(await portrait.getAttribute('data-action'),'idle');
  assert.equal(await portrait.locator('.bot-body').evaluate(el=>getComputedStyle(el).animationName),'bot-orbit');
  return { liveTool: true, completed: true, expansionPreserved: true, conversationIsolation: true, toggleVisibility: true };
}
