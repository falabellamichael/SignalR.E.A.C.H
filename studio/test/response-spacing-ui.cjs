'use strict';
// Compact AI typography in the actual renderer; isolated profile, no provider.
const { app } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const { AgentStore } = require('../agent/agent-store.cjs');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reach-response-spacing-'));
app.setPath('userData', root);
fs.writeFileSync(path.join(root,'settings.json'),JSON.stringify({theme:'light',telemetrySources:[]}));
fs.writeFileSync(path.join(root,'projects.json'),JSON.stringify([{name:'Spacing fixture',dir:root}]));
const store = new AgentStore(path.join(root,'agents.json'));
const fixture = store.create({name:'Compact replies',dir:root});
const code = 'function check() {\n  const value = 42;\n\n  return value;\n}';
const reply = ['First paragraph stays readable.','Second paragraph has a modest gap.','## Results','- First finding\n- Second finding','1. Review the changes\n2. Run the checks','```js\n'+code+'\n```','Everything is ready.'].join('\n\n');
let win;
const errors=[];
app.on('browser-window-created',(_event,window)=>{
  win=window; setImmediate(()=>window.removeAllListeners('ready-to-show'));
  window.webContents.on('console-message',(_event,level,message)=>{if(level>=3)errors.push(message);});
});
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const run=code=>win.webContents.executeJavaScript(code,true);
const timeout=setTimeout(()=>{console.error('Response spacing timed out',root);app.exit(1);},60000);
(async()=>{
  await import(pathToFileURL(path.resolve(__dirname,'../main.mjs')).href);
  await app.whenReady(); while(!win||win.webContents.isLoading())await delay(30);
  for(let i=0;i<100;i++){
    if(await run('typeof ReachTeamDeck!=="undefined" && document.querySelector("#agent-project-select option")'))break;
    await delay(30);
  }
  await run(`(async()=>{
    setDrawer(false); await showTab('agents'); await selectAgent({id:${JSON.stringify(fixture.id)}});
    window.userReply=appendChatMessage('user','Keep my lines.\\n\\n  Indentation too.');
    window.aiReply=appendChatMessage('assistant',${JSON.stringify(reply)});
    startTeamRunView('spacing',{name:'Team1',mode:'parallel'},'Inspect response spacing');
    window.teamReply=teamCard(0,'Seeker','fixture').querySelector('.member-body');
    teamReply.innerHTML=md.render(${JSON.stringify(reply)});
    chatScroll.scrollTop=0;
  })()`);
  for(const [theme,width,zoom] of [['light',1440,1],['dark',1000,1],['light',1420,1.25]]){
    win.setContentSize(width,900); win.webContents.setZoomFactor(zoom);
    await run(`document.documentElement.dataset.theme=${JSON.stringify(theme)}`); await delay(120);
    for(const target of ['aiReply','teamReply']){
      const layout=await run(`(()=>{
        const el=${target}, p=el.querySelectorAll(':scope > p'), pre=el.querySelector('pre'), style=getComputedStyle(el);
        const a=p[0].getBoundingClientRect(),b=p[1].getBoundingClientRect();
        return {whiteSpace:style.whiteSpace,font:parseFloat(style.fontSize),line:parseFloat(style.lineHeight),padding:parseFloat(style.paddingTop),
          paragraphGap:b.top-a.bottom,firstInset:a.top-el.getBoundingClientRect().top,
          code:pre.querySelector('code').textContent,codeSpace:getComputedStyle(pre).whiteSpace,
          copyPosition:getComputedStyle(pre.querySelector('.md-copy')).position,
          items:el.querySelectorAll('li').length,lists:el.querySelectorAll('ul,ol').length,
          lastMargin:getComputedStyle(p[p.length-1]).marginBottom,height:el.getBoundingClientRect().height};
      })()`);
      assert.equal(layout.whiteSpace,'normal','HTML separator newlines must not create blank lines');
      assert.ok(layout.paragraphGap>=5 && layout.paragraphGap<=7,JSON.stringify(layout));
      assert.equal(layout.padding,8);
      assert.ok(layout.firstInset<=10,'No default first-paragraph margin');
      assert.equal(layout.font,target==='aiReply'?13.5:12.5,'Keep the readable font size');
      assert.ok(Math.abs(layout.line/layout.font-1.45)<.02);
      assert.equal(layout.code,code,'Preserve indentation and intentional blank code lines');
      assert.equal(layout.codeSpace,'pre');
      assert.equal(layout.copyPosition,'absolute','Copy controls do not add a line to code');
      assert.equal(layout.items,4); assert.equal(layout.lists,2);
      assert.equal(layout.lastMargin,'0px');
    }
    assert.equal(await run('getComputedStyle(userReply).whiteSpace'),'pre-wrap','User whitespace stays unchanged');
    await run('chatScroll.scrollTop=0'); await delay(50);
    fs.writeFileSync(path.join(root,`team-${theme}-${width}.png`),(await win.capturePage()).toPNG());
    await run('chatScroll.scrollTop+=aiReply.getBoundingClientRect().top-chatScroll.getBoundingClientRect().top'); await delay(50);
    fs.writeFileSync(path.join(root,`reply-${theme}-${width}.png`),(await win.capturePage()).toPNG());
  }
  // Streamed assistant text uses the same block spacing as saved replies.
  await run(`handleAgentEvent({agentId:currentAgent.id,type:'message-start',role:'assistant'});handleAgentEvent({agentId:currentAgent.id,type:'delta',text:'First.\\n\\nSecond.'});`);
  assert.equal(await run('getComputedStyle(streamBubble).whiteSpace'),'normal');
  assert.equal(await run('streamBubble.querySelectorAll("p").length'),2);
  assert.deepEqual(errors,[]);
  console.log('RESPONSE SPACING UI PASS',root);
  clearTimeout(timeout);app.exit(0);
})().catch(error=>{console.error(error.stack,root,errors);clearTimeout(timeout);app.exit(1);});
