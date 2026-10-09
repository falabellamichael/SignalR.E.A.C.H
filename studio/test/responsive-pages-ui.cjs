'use strict';

// Run with: npx electron test/responsive-pages-ui.cjs
// Add --home-only for the wide/compact Home alignment regression check.
// Add --alignment-only to check every page, or --alignment-measure to record
// the same geometry before a repair without treating findings as a test pass.
// Add --page-layout-only to check both saved modes; --page-layout-relaunch=ROOT
// with --expect-layout=MODE checks a fresh process using that isolated profile.
// Add --overlap-transition-only to grow Files/Browser through the docking
// threshold and verify that every page stays at its last pushed-aside position.
// Exercises the actual renderer, pointer input and native Browser view in an
// isolated profile. It never changes the installed app or starts an AI run.
const { app } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { AgentStore } = require('../agent/agent-store.cjs');
const { PersonaStore } = require('../agent/persona-store.cjs');

const relaunchArg = process.argv.find(value => value.startsWith('--page-layout-relaunch='));
const relaunchRoot = relaunchArg ? path.resolve(relaunchArg.slice('--page-layout-relaunch='.length)) : '';
const expectedLayout = process.argv.find(value=>value.startsWith('--expect-layout='))?.slice('--expect-layout='.length) || 'full-width';
if(relaunchRoot) assert.ok(relaunchRoot.startsWith(path.resolve(os.tmpdir())+path.sep)&&/^reach-responsive-ui-/.test(path.basename(relaunchRoot)),'Relaunch must use a temporary test profile');
const root = relaunchRoot || fs.mkdtempSync(path.join(os.tmpdir(), 'reach-responsive-ui-'));
const profile = path.join(root, 'profile');
const project = path.join(root, 'a-project-with-a-readable-long-folder-name');
if(!relaunchRoot) {
fs.mkdirSync(profile);
fs.mkdirSync(project);
fs.writeFileSync(path.join(project, 'example.js'), 'console.log("Responsive layout fixture");\n');
fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({ theme: 'dark', telemetrySources: [], connections: [] }));
fs.writeFileSync(path.join(profile, 'projects.json'), JSON.stringify([{ name: 'A project with a readable long name', dir: project }]));
}
const store = new AgentStore(path.join(profile, 'agents.json'));
const fixture = relaunchRoot ? store.list()[0] : store.create({ name: 'A conversation with a readable long name', dir: project });
assert.ok(fixture?.id,'An isolated conversation fixture must exist');
const personas = new PersonaStore(path.join(profile, 'personas.json'));
if(!relaunchRoot) {
const reviewer = personas.createPersona({ name:'Quality reviewer with a readable long name', model:'local-review-model-with-a-readable-long-name', prompt:'Review usability and correctness.' });
const builder = personas.createPersona({ name:'Project builder', model:'local-project-model', prompt:'Build the requested scoped change.' });
personas.createTeam({ name:'A project review team with a readable long name', mode:'links', members:[
  { personaId:reviewer.id, role:'Quality reviewer and accessibility checks' },
  { personaId:builder.id, role:'Implementation and verification' },
] });
store.setMessages(fixture.id, [
  { role: 'user', content: 'Check the compact page layout and keep the controls usable.' },
  { role: 'assistant', content: 'The page should adapt to the space available.\n\n```js\nconst longLine = "A code block can scroll locally without widening the page.";\n```' },
]);
}
app.setPath('userData', profile);
app.commandLine.appendSwitch('force-device-scale-factor', '1');

let win;
const errors = [];
let rendererErrors = [];
const samples = [];
const browserSamples = [];
const homeBaselineSamples = [];
const alignmentSamples = [];
const pageLayoutSamples = [];
const overlapSamples = [];
const failures = [];
const fixtureLayoutMissing = !Object.hasOwn(JSON.parse(fs.readFileSync(path.join(profile,'settings.json'),'utf8')),'pageLayout');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
app.on('browser-window-created', (_event, window) => {
  win = window;
  // Keep test dimensions stable while its window is visible on the desktop.
  window.setMaximizable(false);
  setImmediate(() => window.removeAllListeners('ready-to-show'));
  window.webContents.on('console-message', event => {
    // Existing index.html supplies this directive through a meta element.
    // Chromium reports it on every boot; unrelated renderer errors stay fatal.
    const knownMetaWarning = "The Content Security Policy directive 'frame-ancestors' is ignored when delivered via a <meta> element.";
    if ((event.level === 'error' || event.level >= 3) && event.message !== knownMetaWarning) errors.push(event.message);
  });
});
const run = code => win.webContents.executeJavaScript(code, true);
async function captureSettled() {
  await run("new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))");
  return (await win.capturePage()).toPNG();
}
async function until(predicate, label) {
  const deadline = Date.now() + 6000;
  while (!await predicate()) {
    if (Date.now() > deadline) throw new Error(label);
    await delay(35);
  }
}
async function click(selector) {
  const point = await run(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)}), r = el.getBoundingClientRect();
    const x = r.left + r.width / 2, y = r.top + r.height / 2;
    return { x, y, hit: !!document.elementFromPoint(x, y)?.closest(${JSON.stringify(selector)}) };
  })()`);
  assert.equal(point.hit, true, 'Pointer target must be visible: ' + selector);
  const zoom = win.webContents.getZoomFactor();
  const position = { x: Math.round(point.x * zoom), y: Math.round(point.y * zoom) };
  win.focus();
  win.webContents.focus();
  win.webContents.sendInputEvent({ type: 'mouseMove', ...position });
  win.webContents.sendInputEvent({ type: 'mouseDown', ...position, button: 'left', clickCount: 1 });
  win.webContents.sendInputEvent({ type: 'mouseUp', ...position, button: 'left', clickCount: 1 });
  await delay(100);
}
async function resizeDrawer(width) {
  const point = await run(`(() => {
    const r = document.querySelector('#drawer-resizer-x').getBoundingClientRect();
    const x = r.left+r.width/2, y = r.top+Math.min(120,r.height/2);
    return {x,y,width:drawer.getBoundingClientRect().width,hit:document.elementFromPoint(x,y)?.id==='drawer-resizer-x'};
  })()`);
  assert.equal(point.hit,true,'Drawer resizer must be reachable');
  const zoom = win.webContents.getZoomFactor();
  const start = {x:Math.round(point.x*zoom),y:Math.round(point.y*zoom)};
  const end = {x:Math.round((point.x-(width-point.width))*zoom),y:start.y};
  win.focus(); win.webContents.focus();
  win.webContents.sendInputEvent({type:'mouseMove',...start});
  win.webContents.sendInputEvent({type:'mouseDown',...start,button:'left',clickCount:1});
  win.webContents.sendInputEvent({type:'mouseMove',...end});
  win.webContents.sendInputEvent({type:'mouseUp',...end,button:'left',clickCount:1});
  await delay(120);
}

async function inspect(page, state, scenario) {
  const geometry = await run(`(() => {
    const page = document.querySelector('#page-' + ${JSON.stringify(page)});
    const main = document.querySelector('main'), drawer = document.querySelector('#file-drawer');
    const header = document.querySelector('header'), footer = document.querySelector('#statusbar-bottom');
    const rect = el => { const r = el.getBoundingClientRect(); return { left:r.left, right:r.right, top:r.top, bottom:r.bottom, width:r.width, height:r.height }; };
    const bounds = rect(page);
    const horizontalScroller = el => {
      for (let parent = el.parentElement; parent && parent !== page; parent = parent.parentElement) {
        if (/auto|scroll/.test(getComputedStyle(parent).overflowX) && parent.scrollWidth > parent.clientWidth + 2) return true;
      }
      return false;
    };
    const offsideControls = [...page.querySelectorAll('button,input,select,textarea')].filter(el => {
      const r = el.getBoundingClientRect(), style = getComputedStyle(el);
      return r.width > 2 && r.height > 2 && style.visibility !== 'hidden' && style.clip === 'auto'
        && r.bottom > bounds.top && r.top < bounds.bottom && !horizontalScroller(el)
        && (r.left < bounds.left - 2 || r.right > bounds.right + 2);
    }).map(el => ({ id:el.id || el.className, ...rect(el) }));
    const headerControls = ['#tab-home','#tab-projects','#tab-agents','#tab-create','#tab-settings','#btn-toggle-files','#account-menu-button'].map(selector => {
      const el = document.querySelector(selector), r = rect(el);
      const route = selector.startsWith('#tab-') ? selector.slice(5) : '';
      const railItem = route ? document.querySelector('#rail-'+route) : null;
      return { selector, ...r, railAlternative:!!railItem && railItem.getBoundingClientRect().width >= 28,
        hit: !!document.elementFromPoint(r.left+r.width/2,r.top+r.height/2)?.closest(selector) };
    });
    const conversation = ${JSON.stringify(page)} === 'agents' && !document.querySelector('#agent-view').classList.contains('hidden') ? Object.fromEntries(
      ['#page-agents > aside','#page-agents > .work','#agent-view','#agent-model-info','#agent-model-info .model-info-content','#chat-scroll','.chat-pane','.composer','#composer-input','#btn-send'].map(selector => [selector,rect(document.querySelector(selector))])
    ) : null;
    if(conversation)conversation.workPaddingBottom=parseFloat(getComputedStyle(document.querySelector('#page-agents > .work')).paddingBottom);
    const home = ${JSON.stringify(page)} === 'home' ? (() => {
      const scroll = page.querySelector('.home-scroll'), content = page.querySelector('.home-content');
      const style = getComputedStyle(content);
      return { scroll:rect(scroll), scrollClientWidth:scroll.clientWidth, content:rect(content),
        hero:rect(page.querySelector('.home-hero')), paddingLeft:parseFloat(style.paddingLeft),
        paddingRight:parseFloat(style.paddingRight), marginLeft:parseFloat(style.marginLeft), marginRight:parseFloat(style.marginRight) };
    })() : null;
    return { innerWidth, innerHeight, pageLayout:document.documentElement.dataset.pageLayout, appBody:rect(document.querySelector('.app-body')), main:rect(main), pageRect:bounds, drawer:rect(drawer),
      overlay:drawer.classList.contains('overlay'), closed:drawer.classList.contains('closed'),
      rail:rect(document.querySelector('#nav-rail')), header:rect(header), footer:rect(footer),
      pageOverflow:page.scrollWidth-page.clientWidth, bodyOverflow:document.body.scrollWidth-innerWidth,
      offsideControls, headerControls, conversation, home };
  })()`);
  const sample = { page, state, scenario, ...geometry };
  samples.push(sample);
  const problem = message => failures.push({ page, state, scenario, message });
  if (geometry.pageOverflow > 2) problem('Page has horizontal overflow: ' + geometry.pageOverflow);
  if (geometry.bodyOverflow > 2) problem('Window has horizontal overflow: ' + geometry.bodyOverflow);
  if (geometry.offsideControls.length) problem('Controls extend outside the page: ' + JSON.stringify(geometry.offsideControls));
  for (const control of geometry.headerControls) {
    if (!control.width && !control.height && control.railAlternative) continue;
    if (control.width < 24 || control.height < 24 || control.left < 0 || control.right > geometry.innerWidth + 2 || !control.hit) {
      problem('Header control is clipped or unreachable: ' + JSON.stringify(control));
    }
  }
  if (page !== 'settings' && geometry.pageRect.width <= 0) problem('Selected page is hidden');
  if (geometry.conversation) {
    const composer = geometry.conversation['.composer'], chat = geometry.conversation['#chat-scroll'];
    const work=geometry.conversation['#page-agents > .work'], view=geometry.conversation['#agent-view'];
    const expectedBottom=work.bottom-geometry.conversation.workPaddingBottom;
    if(Math.abs(composer.bottom-expectedBottom)>2||Math.abs(view.bottom-expectedBottom)>2) problem('Conversation/composer must remain pinned above the work-area bottom padding: '+JSON.stringify({composerBottom:composer.bottom,viewBottom:view.bottom,expectedBottom}));
    if (composer.bottom > geometry.pageRect.bottom + 2 || composer.top < geometry.pageRect.top - 2) problem('Composer extends outside the visible conversation: ' + JSON.stringify(composer));
    if (chat.height < 40) problem('Conversation has no useful reading area: ' + JSON.stringify(chat));
    const send = geometry.conversation['#btn-send'], input = geometry.conversation['#composer-input'];
    if (send.bottom > geometry.pageRect.bottom+2 || input.bottom > geometry.pageRect.bottom+2) problem('Message input or Send button is clipped');
  }
  if (geometry.home) {
    const home = geometry.home;
    if (Math.abs(home.paddingLeft-24)>0.5 || Math.abs(home.paddingRight-24)>0.5) {
      problem('Home side padding must stay at 24px across drawer and window breakpoints: ' + JSON.stringify(home));
    }
    const fullWidth=geometry.pageLayout==='full-width';
    const expectedWidth=fullWidth?home.scrollClientWidth:Math.min(home.scrollClientWidth,1390);
    const expectedLeft=home.scroll.left+(fullWidth?0:(home.scrollClientWidth-expectedWidth)/2);
    if (Math.abs(home.content.left-expectedLeft)>2 || fullWidth&&(Math.abs(home.marginLeft)>2 || Math.abs(home.marginRight)>2)) {
      problem('Home content has an unintended outer gutter: ' + JSON.stringify(home));
    }
    if (Math.abs(home.content.width-expectedWidth)>2) problem('Home content does not match its selected page width: ' + JSON.stringify(home));
    if (Math.abs(home.hero.left-home.content.left-home.paddingLeft)>2
      || Math.abs(home.hero.width-(home.content.width-home.paddingLeft-home.paddingRight))>2) {
      problem('Home hero does not use the available padded area: ' + JSON.stringify(home));
    }
  }
  if (geometry.footer.bottom > geometry.innerHeight + 2) problem('Status bar extends below the window');
  return geometry;
}

async function changePageLayout(mode) {
  assert.ok(['page-sized','full-width'].includes(mode),'Valid page layout mode');
  await run("ReachAccountMenu.close({returnFocus:false}); openSettingsPanel('appearance')");
  await until(()=>run("!!document.querySelector('#set-page-sized')"),'Appearance layout toggle must exist');
  const checked=await run("document.querySelector('#set-page-sized').checked");
  const changed=checked!==(mode==='page-sized');
  if(changed) {
    await run("document.querySelector('#set-page-sized').scrollIntoView({block:'center'})");
    await click('#set-page-sized');
  }
  await until(async()=>await run(`document.documentElement.dataset.pageLayout===${JSON.stringify(mode)} && document.querySelector('#set-page-sized').checked===${mode==='page-sized'} && !document.querySelector('#set-page-sized').disabled`),'Saved layout must apply to the renderer');
  await until(()=>{
    const value=JSON.parse(fs.readFileSync(path.join(profile,'settings.json'),'utf8')).pageLayout;
    return (value==='full-width'?'full-width':'page-sized')===mode;
  },'Page layout selection must persist or use the page-sized default in the isolated settings file');
  pageLayoutSamples.push({event:changed?'saved-through-settings':'settings-already-selected',mode,status:await run("document.querySelector('#page-layout-status').textContent")});
  await run("ReachAccountMenu.close({returnFocus:false})");
}

async function inspectAlignment(page,state,scenario,section='') {
  const geometry = await run(`(() => {
    const pageName=${JSON.stringify(page)}, section=${JSON.stringify(section)};
    const page=document.querySelector('#page-'+pageName);
    const selectors={home:['.home-content','.home-content','.home-hero'],
      projects:[':scope > .work','#project-view','.project-head'],
      agents:[':scope > .work','#agent-view','#agent-model-info'],
      create:['.create-workbench','.create-workbench','.create-heading'],
      workspace:['.ws-wrap','.ws-wrap','.ws-head'], playground:['.pg-wrap','.pg-wrap','.pg-head'],
      about:['.ab-wrap','.ab-wrap','.ab-mark'], refactor:['.rf-wrap','.rf-wrap','.pg-head']};
    const rect=el=>el.getBoundingClientRect().toJSON();
    const describe=el=>{const style=getComputedStyle(el); return {...rect(el),clientWidth:el.clientWidth,
      paddingLeft:parseFloat(style.paddingLeft),paddingRight:parseFloat(style.paddingRight),
      marginLeft:parseFloat(style.marginLeft),marginRight:parseFloat(style.marginRight),maxWidth:style.maxWidth};};
    let shell,content,anchor,parent;
    if(pageName==='settings') {
      const menu=document.querySelector('#account-menu');
      shell=document.querySelector('#account-menu-panel-'+(section==='account'||section==='usage'?section:'settings'));
      content=section==='account'||section==='usage'?shell.firstElementChild:page.querySelector('.settings-panel:not(.hidden)');
      anchor=section==='account'||section==='usage'?content.querySelector('.home-card'):content.querySelector('h2');
      parent=menu;
    } else {
      const names=selectors[pageName]; shell=page.querySelector(names[0]); content=page.querySelector(names[1]); anchor=page.querySelector(names[2]);
      if(section==='empty'&&pageName==='projects'){content=page.querySelector('#no-project');anchor=content.querySelector('.big-mark');}
      if(section==='empty'&&pageName==='agents'){content=page.querySelector('#no-agent');anchor=content.querySelector('.telemetry-dashboard')||content.querySelector('.big-mark');}
      parent=pageName==='home'?page.querySelector('.home-scroll'):page;
    }
    const sidebar=pageName==='projects'||pageName==='agents'?page.querySelector(':scope > aside'):null;
    return {pageLayout:document.documentElement.dataset.pageLayout,overlay:drawer.classList.contains('overlay'),pageRect:rect(page),parent:describe(parent),shell:describe(shell),content:describe(content),anchor:rect(anchor),
      sidebar:sidebar?rect(sidebar):null,flexDirection:getComputedStyle(page).flexDirection};
  })()`);
  const sample={page,state,scenario,section,...geometry};
  alignmentSamples.push(sample);
  const problem=message=>failures.push({page,state,scenario,section,message});
  const fullWidth=geometry.pageLayout==='full-width';
  const intendedPadding=24;
  if (Math.abs(geometry.shell.paddingLeft-intendedPadding)>0.5 || Math.abs(geometry.shell.paddingRight-intendedPadding)>0.5) {
    problem('Page padding changes from its intended fixed '+intendedPadding+'px: '+JSON.stringify({left:geometry.shell.paddingLeft,right:geometry.shell.paddingRight}));
  }
  if (fullWidth&&(Math.abs(geometry.content.marginLeft)>2 || Math.abs(geometry.content.marginRight)>2 || Math.abs(geometry.shell.marginLeft)>2 || Math.abs(geometry.shell.marginRight)>2)) {
    problem('Content has automatic outer margins: '+JSON.stringify({contentLeft:geometry.content.marginLeft,contentRight:geometry.content.marginRight,shellLeft:geometry.shell.marginLeft,shellRight:geometry.shell.marginRight}));
  }
  const inset=geometry.shell.paddingLeft;
  if((fullWidth||page==='settings')&&Math.abs(geometry.anchor.left-geometry.shell.left-inset)>2) problem('Content anchor is offset beyond its shell padding: '+JSON.stringify({anchorLeft:geometry.anchor.left,shellLeft:geometry.shell.left,paddingLeft:inset}));
  if(page!=='settings') {
    const expectedShellLeft=page==='home'?geometry.parent.left:geometry.pageRect.left+(geometry.sidebar&&geometry.flexDirection==='row'?geometry.sidebar.width:0);
    const availableWidth=page==='home'?geometry.parent.clientWidth:geometry.pageRect.width-(geometry.sidebar&&geometry.flexDirection==='row'?geometry.sidebar.width:0);
    if(fullWidth) {
      if(Math.abs(geometry.shell.left-expectedShellLeft)>2) problem('Page shell is displaced from its available left edge: '+JSON.stringify({shellLeft:geometry.shell.left,expectedShellLeft}));
      if(Math.abs(geometry.shell.width-availableWidth)>2) problem('Page shell does not fill its available width: '+JSON.stringify({shellWidth:geometry.shell.width,availableWidth}));
    } else {
      const cap={home:1390,projects:1400,agents:960,create:1400,workspace:1400,playground:1400,about:760,refactor:1400}[page];
      const innerPage=['projects','agents'].includes(page);
      const actual=innerPage?geometry.content:geometry.shell;
      const usable=innerPage?geometry.shell.clientWidth-geometry.shell.paddingLeft-geometry.shell.paddingRight:availableWidth;
      const expectedWidth=section==='empty'&&page==='projects'?actual.width:Math.min(usable,cap);
      const expectedLeft=(innerPage?geometry.shell.left+geometry.shell.paddingLeft:expectedShellLeft)+(usable-expectedWidth)/2;
      if(Math.abs(actual.width-expectedWidth)>2||Math.abs(actual.left-expectedLeft)>2) {
        problem('Page-sized content must center within its local available width: '+JSON.stringify({actualWidth:actual.width,actualLeft:actual.left,expectedWidth,expectedLeft,cap,usable}));
      }
    }
  }
  return geometry;
}

async function finish(label) {
  rendererErrors=await run('window.__errors');
  const reportName=relaunchRoot?'relaunch-'+expectedLayout+'.json':'report.json';
  fs.writeFileSync(path.join(root,reportName),JSON.stringify({samples,browserSamples,homeBaselineSamples,alignmentSamples,pageLayoutSamples,overlapSamples,rendererErrors,consoleErrors:errors,failures},null,2));
  console.log(JSON.stringify({samples:samples.length,alignmentSamples:alignmentSamples.length,overlapSamples:overlapSamples.length,pageLayoutSamples,browserModes:browserSamples.map(sample => sample.mode),homeBaselineSamples,rendererErrors,consoleErrors:errors,failures,artifacts:root},null,2));
  assert.deepEqual(rendererErrors,[],'Renderer must remain error-free');
  assert.deepEqual(errors,[],'Renderer console must remain error-free');
  if(!process.argv.includes('--alignment-measure')) assert.deepEqual(failures,[],'All page controls must remain inside their responsive layout');
  console.log(label);
  clearTimeout(timeout);
  server.close();
  app.exit(0);
}

const server = http.createServer((_request, response) => {
  response.writeHead(200, { 'Content-Type': 'text/html' });
  response.end('<title>Responsive browser fixture</title><h1>Responsive browser fixture</h1><p>A local page for native view alignment.</p>');
});
const timeout = setTimeout(() => { console.error('Responsive pages UI timed out', root); app.exit(1); }, process.argv.includes('--overlap-transition-only') ? 180000 : 120000);

(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/`;
  await import(pathToFileURL(path.resolve(__dirname, '../main.mjs')).href);
  await app.whenReady();
  await until(() => win && !win.webContents.isLoading(), 'Studio did not load');
  win.show();
  await until(() => run('typeof selectAgent === "function" && document.querySelector("#agent-project-select option")'), 'Renderer did not initialize');
  if(process.argv.includes('--page-layout-only')||process.argv.includes('--overlap-transition-only')||relaunchRoot) {
    const expected=relaunchRoot?expectedLayout:'page-sized';
    assert.ok(['page-sized','full-width'].includes(expected),'Expected startup layout must be valid');
    if(!relaunchRoot)assert.equal(fixtureLayoutMissing,true,'Default test must begin without a stored pageLayout key');
    await until(()=>run(`document.documentElement.dataset.pageLayout===${JSON.stringify(expected)}`),'Renderer must load the persisted/default page layout');
    await run("openSettingsPanel('appearance')");
    assert.equal(await run("document.querySelector('#set-page-sized').checked"),expected==='page-sized','Appearance checkbox must reflect the startup preference');
    pageLayoutSamples.push({event:relaunchRoot?'fresh-process-startup':'missing-key-default',mode:expected,fixtureLayoutMissing,checked:expected==='page-sized'});
    await run("ReachAccountMenu.close({returnFocus:false})");
    if(relaunchRoot) {
      if(expected==='full-width')await changePageLayout('page-sized');
      await finish('PAGE LAYOUT RELAUNCH UI PASS');
      return;
    }
  }
  await run(`selectAgent({id:${JSON.stringify(fixture.id)}})`);
  await run(`(async () => { await selectDrawerPanel('browser', {focus:false}); await browserCommand('navigate', {url:${JSON.stringify(url)}}); setDrawer(false); })()`);
  await until(() => win.contentView.children.some(view => view.webContents?.getURL() === url && !view.webContents.isLoading()), 'Local browser fixture did not load');
  const browserView = win.contentView.children.find(view => view.webContents?.getURL() === url);

  const aligned = async () => {
    const pane = await run(`document.querySelector('#browser-viewport').getBoundingClientRect().toJSON()`);
    const zoom = win.webContents.getZoomFactor(), outer = win.getContentBounds();
    const edge = (value, limit) => Math.min(limit, Math.max(0, Math.round(value * zoom)));
    const expected = { x:edge(pane.left,outer.width), y:edge(pane.top,outer.height) };
    expected.width = edge(pane.right,outer.width)-expected.x;
    expected.height = edge(pane.bottom,outer.height)-expected.y;
    const actual = browserView.getBounds();
    aligned.diagnostic = JSON.stringify({pane,expected,actual,visible:browserView.getVisible()});
    return browserView.getVisible() && expected.width > 0 && expected.height > 0
      && Object.keys(expected).every(key => Math.abs(actual[key]-expected[key]) <= 1);
  };
  if(process.argv.includes('--overlap-transition-only')) {
    const pages=['home','projects','agents','create','workspace','playground','about','refactor','settings'];
    const prepare = async (page,section,panel) => {
      await run(`(async()=>{ReachAccountMenu.close({returnFocus:false});closeSettingsMenus();setDrawer(false);
        if(['projects','agents'].includes(${JSON.stringify(page)})){
          await selectAgent({id:${JSON.stringify(fixture.id)}});
          if(${JSON.stringify(section)}==='empty'){
            if(${JSON.stringify(page)}==='projects'){currentProject=null;noProject.classList.remove('hidden');projectView.classList.add('hidden');}
            else{currentAgent=null;agentView.classList.add('hidden');noAgent.classList.remove('hidden');}
          }
        }
        await showTab(${JSON.stringify(page==='settings'?'home':page)});
        drawer.style.width='420px'; await selectDrawerPanel(${JSON.stringify(panel)},{focus:false});
        if(${JSON.stringify(page)}==='settings'){
          if(['account','usage'].includes(${JSON.stringify(section)}))ReachAccountMenu.open(${JSON.stringify(section)});
          else await openSettingsPanel(${JSON.stringify(section)});
        }
      })()`);
      await delay(50);
    };
    const measure = async (page,section,panel,scenario,requestedWidth,previous) => {
      await delay(45);
      const geometry=page==='settings'&&['account','usage'].includes(section)
        ? await run("(() => {const r=el=>el.getBoundingClientRect().toJSON();return {appBody:r(document.querySelector('.app-body')),rail:r(document.querySelector('#nav-rail')),main:r(document.querySelector('main')),overlay:drawer.classList.contains('overlay'),closed:drawer.classList.contains('closed')};})()")
        : await inspect(page,panel,scenario);
      const alignment=await inspectAlignment(page,panel,scenario,section);
      const available=geometry.appBody.width-geometry.rail.width;
      const minimum=Math.min(available,760);
      const shouldOverlay=available-requestedWidth<760;
      const expectedWidth=shouldOverlay?minimum:available-requestedWidth;
      const current={page,section,panel,scenario,requestedWidth,available,minimum,expectedWidth,
        overlay:geometry.overlay,main:geometry.main,anchor:alignment.anchor,flexDirection:alignment.flexDirection,sidebar:alignment.sidebar};
      overlapSamples.push(current);
      const problem=message=>failures.push({page,section,state:panel,scenario,message});
      if(geometry.closed||geometry.overlay!==shouldOverlay)problem('Drawer must stay open and overlap only below the page minimum: '+JSON.stringify(current));
      if(Math.abs(geometry.main.width-expectedWidth)>2||Math.abs(geometry.main.left-geometry.rail.right)>2)problem('Main must keep its pushed-aside width and left edge across overlap: '+JSON.stringify(current));
      if(previous&&previous.scenario===scenario) {
        if(current.anchor.left>previous.anchor.left+2)problem('Growing a drawer must never recenter content to the right: '+JSON.stringify({previous,current}));
        if(previous.overlay&&current.overlay&&Math.abs(current.anchor.left-previous.anchor.left)>2)problem('Further overlap must preserve the page anchor: '+JSON.stringify({previous,current}));
        if(previous.available-previous.requestedWidth===761&&available-requestedWidth===759&&Math.abs(current.anchor.left-previous.anchor.left)>2)problem('Crossing into overlap must not jump the content anchor: '+JSON.stringify({previous,current}));
      }
      if(panel==='browser') {
        if(page==='settings')await until(()=>!browserView.getVisible(),'Settings must remain above native Browser during overlap');
        else await until(aligned,'Native Browser must follow overlap geometry: '+scenario+' / '+page);
      }
      return current;
    };
    for(const mode of ['page-sized','full-width']) {
      await changePageLayout(mode);
      for(const expanded of [false,true]) {
        win.webContents.setZoomFactor(1); win.setSize(3440,1440); await delay(120);
        if(await run("document.documentElement.dataset.rail === 'expanded'")!==expanded)await click('#rail-toggle');
        const scenario=`3440x1440@1-${mode}${expanded?'-expanded-rail':''}`;
        const available=await run("document.querySelector('.app-body').getBoundingClientRect().width-document.querySelector('#nav-rail').getBoundingClientRect().width");
        // Include the reported 2600px drawer plus the exact two sides of the
        // threshold; sort because the expanded rail changes available width.
        const widths=[...new Set([420,2600,available-800,available-761,available-759,available-500])].sort((a,b)=>a-b);
        for(const page of pages) {
          const sections=page==='settings'?['connection','conversation','budgeting','appearance','account','usage']:['projects','agents'].includes(page)?['selected','empty']:[''];
          for(const section of sections)for(const panel of ['files','browser']) {
            await prepare(page,section,panel);
            let previous;
            for(const requestedWidth of widths) {
              await run(`drawer.style.width=${JSON.stringify(requestedWidth+'px')}`);
              previous=await measure(page,section,panel,scenario,requestedWidth,previous);
              if(!expanded&&panel==='files'&&requestedWidth===widths.at(-1))fs.writeFileSync(path.join(root,`overlap-${mode}-${page}${section?'-'+section:''}.png`),await captureSettled());
            }
          }
        }
        console.log('Drawer growth transition checked:',scenario);
      }
      // Keep the drawer open while resizing through the threshold in both
      // directions. Zoom also covers a page narrower than the 760px floor.
      for(const page of pages) {
        win.webContents.setZoomFactor(1); win.setSize(1600,900); await delay(100);
        if(await run("document.documentElement.dataset.rail === 'expanded'"))await click('#rail-toggle');
        const section=page==='settings'?'appearance':['projects','agents'].includes(page)?'selected':'';
        await prepare(page,section,'files');
        for(const [width,height,zoom] of [[1600,900,1],[1260,900,1],[1250,900,1],[1000,740,1],[1000,740,1.5],[1250,900,1],[1260,900,1],[1600,900,1]]) {
          win.webContents.setZoomFactor(zoom); win.setSize(width,height);
          await measure(page,section,'files',`${width}x${height}@${zoom}-${mode}-window-resize`,420);
        }
      }
    }
    await finish('ALL PAGES OVERLAP TRANSITION UI PASS');
    return;
  }
  if(process.argv.includes('--alignment-only')||process.argv.includes('--alignment-measure')||process.argv.includes('--page-layout-only')) {
    const modes=process.argv.includes('--page-layout-only')?['page-sized','full-width']:['full-width'];
    for(const mode of modes) {
    // The missing-key default stays untouched until its layout is measured.
    if(mode==='full-width')await changePageLayout(mode);
    for(const [width,height,zoom] of [[3440,1440,1],[2000,1000,1],[1000,740,1],[1000,740,1.5]]) {
      const scenario=`${width}x${height}@${zoom}-${mode}`;
      win.setSize(width,height); win.webContents.setZoomFactor(zoom); await delay(180);
      if(await run("document.documentElement.dataset.rail === 'expanded'")) await click('#rail-toggle');
      await run("drawer.style.width='420px'");
      for(const page of ['home','projects','agents','create','workspace','playground','about','refactor','settings']) {
        const sections=page==='settings'?['connection','conversation','budgeting','appearance','account','usage']:['projects','agents'].includes(page)?['selected','empty']:[''];
        for(const section of sections) {
          let closed;
          for(const state of ['closed','files','browser']) {
            await run(`(async()=>{ReachAccountMenu.close({returnFocus:false});closeSettingsMenus();setDrawer(false);
              if(['projects','agents'].includes(${JSON.stringify(page)})){
                await selectAgent({id:${JSON.stringify(fixture.id)}});
                if(${JSON.stringify(section)}==='empty'){
                  if(${JSON.stringify(page)}==='projects'){currentProject=null;noProject.classList.remove('hidden');projectView.classList.add('hidden');}
                  else{currentAgent=null;agentView.classList.add('hidden');noAgent.classList.remove('hidden');}
                }
              }
              await showTab(${JSON.stringify(page==='settings'?'home':page)});
              if(${JSON.stringify(state)}!=='closed')await selectDrawerPanel(${JSON.stringify(state)},{focus:false});
              if(${JSON.stringify(page)}==='settings'){
                if(['account','usage'].includes(${JSON.stringify(section)}))ReachAccountMenu.open(${JSON.stringify(section)});
                else await openSettingsPanel(${JSON.stringify(section)});
              }
            })()`);
            await delay(90);
            if(page!=='settings'||!['account','usage'].includes(section)) await inspect(page,state+(section?'-'+section:''),scenario);
            const current=await inspectAlignment(page,state,scenario,section);
            if(state==='closed')closed=current;
            else if(mode==='full-width'&&(!current.sidebar||current.flexDirection===closed.flexDirection&&Math.abs(current.sidebar.width-closed.sidebar.width)<=2)) {
              if(Math.abs(current.anchor.left-closed.anchor.left)>2) failures.push({page,state,scenario,section,message:'Opening a drawer shifts the page anchor: '+JSON.stringify({closedLeft:closed.anchor.left,openLeft:current.anchor.left})});
            }
            if(page==='settings')await until(()=>!browserView.getVisible(),'Account/Settings must cover the native Browser');
            // Native Browser bounds and pointer occlusion are covered by the
            // full matrix; this branch isolates page alignment geometry.
            if(width===3440&&state==='files')fs.writeFileSync(path.join(root,`alignment-${mode}-${page}${section?'-'+section:''}-${state}.png`),await captureSettled());
          }
          if(['projects','agents'].includes(page))await run(`selectAgent({id:${JSON.stringify(fixture.id)}})`);
        }
      }
      console.log('All-page alignment scenario checked:',scenario);
    }
    }
    await finish(process.argv.includes('--alignment-measure')?'ALIGNMENT MEASUREMENTS COMPLETE':process.argv.includes('--page-layout-only')?'BOTH PAGE LAYOUT MODES UI PASS':'ALL PAGES ALIGNMENT UI PASS');
    return;
  }
  if (process.argv.includes('--home-only')) {
    await changePageLayout('full-width');
    for (const [width,height,zoom] of [[3440,1440,1],[2000,1000,1],[1000,740,1],[1000,740,1.5]]) {
      const scenario = `${width}x${height}@${zoom}`;
      win.setSize(width,height);
      win.webContents.setZoomFactor(zoom);
      await delay(180);
      if (await run("document.documentElement.dataset.rail === 'expanded'")) await click('#rail-toggle');
      await run("ReachAccountMenu.close({returnFocus:false}); closeSettingsMenus(); showTab('home'); setDrawer(false); drawer.style.width='420px'; document.querySelector('.home-scroll').scrollTop=0;");
      await delay(100);
      const closed = await inspect('home','closed',scenario);
      if (width === 3440) {
        // Reproduce the former CSS in the isolated renderer to prove that the
        // wide-width assertions cover the reported empty-left-space defect.
        try {
          await run("(() => { const style=document.createElement('style'); style.id='home-alignment-baseline'; style.textContent='.home-content { width:min(100%,1390px); margin:0 auto; }'; document.head.append(style); })()");
          await delay(50);
          const baseline = await run("(() => { const scroll=document.querySelector('.home-scroll'), content=document.querySelector('.home-content'); return {gap:content.getBoundingClientRect().left-scroll.getBoundingClientRect().left,width:content.getBoundingClientRect().width,scrollClientWidth:scroll.clientWidth}; })()");
          homeBaselineSamples.push({scenario,...baseline});
          assert.ok(baseline.gap>500 && baseline.scrollClientWidth-baseline.width>1000,'Former centered Home CSS must reproduce the excessive wide gutter');
          fs.writeFileSync(path.join(root,'home-3440-before.png'),(await win.capturePage()).toPNG());
        } finally {
          await run("document.querySelector('#home-alignment-baseline')?.remove()");
        }
        await inspect('home','closed-restored',scenario);
      }
      if (width>=2000) fs.writeFileSync(path.join(root,`home-${width}-closed.png`),(await win.capturePage()).toPNG());
      for (const panel of ['files','browser']) {
        await run(`selectDrawerPanel(${JSON.stringify(panel)},{focus:false})`);
        await delay(100);
        const open = await inspect('home',panel,scenario);
        const shouldOverlay = open.innerWidth-open.rail.width-open.drawer.width<760;
        if (open.closed || open.overlay!==shouldOverlay) failures.push({page:'home',state:panel,scenario,message:'Drawer mode does not match the available Home width'});
        if (Math.abs(open.main.width-(shouldOverlay?Math.min(closed.main.width,760):closed.main.width-open.drawer.width))>2) {
          failures.push({page:'home',state:panel,scenario,message:'Home width does not match docked/overlay drawer geometry'});
        }
        if (Math.abs(open.home.hero.left-closed.home.hero.left)>2) {
          failures.push({page:'home',state:panel,scenario,message:'Opening the drawer shifts Home content horizontally: '+JSON.stringify({closedLeft:closed.home.hero.left,openLeft:open.home.hero.left})});
        }
        if (panel==='browser') {
          try { await until(aligned,'Native Browser must align during the Home check: '+scenario); }
          catch (error) { throw new Error(error.message+' '+aligned.diagnostic); }
        }
        if (width>=2000) fs.writeFileSync(path.join(root,`home-${width}-${panel}.png`),(await win.capturePage()).toPNG());
      }
      console.log('Home alignment scenario checked:',scenario);
    }
    await finish('HOME ALIGNMENT UI PASS');
    return;
  }
  const pages = ['home','projects','agents','create','workspace','playground','about','refactor','settings'];
  // The outer window has 24px of side borders here. 1250 and 1260 therefore
  // land just below and just above the 1228px content-width docking threshold.
  const scenarios = process.argv.includes('--browser-only') ? [] : [[1440,900,1], [1000,740,1], [1000,740,1.5], [1250,900,1], [1260,900,1], [1360,900,1,true]];
  for (const [width,height,zoom,expanded=false] of scenarios) {
    const scenario = `${width}x${height}@${zoom}${expanded?'-expanded-rail':''}`;
    win.setSize(width,height);
    win.webContents.setZoomFactor(zoom);
    await delay(180);
    const railExpanded = await run("document.documentElement.dataset.rail === 'expanded'");
    if (railExpanded !== expanded) await click('#rail-toggle');
    for (const page of pages) {
      await run(`(async () => { ReachAccountMenu.close({returnFocus:false}); closeSettingsMenus(); setDrawer(false); await showTab(${JSON.stringify(page)}); })()`);
      await delay(100);
      const closed = await inspect(page,'closed',scenario);
      if (zoom === 1.5 || page === 'agents') {
        fs.writeFileSync(path.join(root,`${page}-${width}-${zoom}-closed.png`),(await win.capturePage()).toPNG());
      }
      if (page === 'settings') {
        for (const panel of ['conversation','budgeting']) {
          await run(`openSettingsPanel(${JSON.stringify(panel)})`);
          await delay(50);
          await inspect(page,'closed-'+panel,scenario);
          if (zoom === 1.5) fs.writeFileSync(path.join(root,`settings-${panel}-${width}-${zoom}.png`),(await win.capturePage()).toPNG());
        }
      }
      if (zoom === 1.5 && ['home','create'].includes(page)) {
        await run(`document.querySelector(${JSON.stringify(page === 'home' ? '#home-command-input' : '.create-roster')}).scrollIntoView({block:'center'})`);
        await delay(50);
        await inspect(page,'closed-details',scenario);
        fs.writeFileSync(path.join(root,`${page}-${width}-${zoom}-details.png`),(await win.capturePage()).toPNG());
      }
      for (const panel of ['files','browser']) {
        // Opening the drawer closes the settings menu in real pointer input.
        // Reopen the live Settings surface after selecting each drawer mode.
        await run(`(async () => { await selectDrawerPanel(${JSON.stringify(panel)}, {focus:false}); if (${JSON.stringify(page)} === 'settings') await openSettingsPanel('connection'); })()`);
        await delay(100);
        const open = await inspect(page,panel,scenario);
        const shouldOverlay = open.innerWidth-open.rail.width-420 < 760;
        if (open.closed) failures.push({page,state:panel,scenario,message:'Opening a drawer must preserve its open state'});
        if (open.overlay !== shouldOverlay) failures.push({page,state:panel,scenario,message:'Drawer overlay mode does not match available page width'});
        if (shouldOverlay && Math.abs(open.main.width-Math.min(closed.main.width,760))>2) failures.push({page,state:panel,scenario,message:'Overlay drawer did not retain the page minimum at its pushed-aside position'});
        if (!shouldOverlay && Math.abs(closed.main.width-open.main.width-open.drawer.width)>2) failures.push({page,state:panel,scenario,message:'Wide drawer does not use its own column'});
        if (panel === 'browser' && page !== 'settings') await until(aligned, `Native Browser bounds do not follow ${scenario} / ${page}`);
        if (panel === 'browser' && page === 'settings') await until(() => !browserView.getVisible(), 'Native Browser must yield to Settings');
      }
      if (zoom === 1.5 && page === 'home') {
        fs.writeFileSync(path.join(root,`${page}-${width}-${zoom}-browser.png`),(await win.capturePage()).toPNG());
      }
    }

    // Actual clicks verify that compact geometry leaves the drawer, menu, and
    // account controls reachable above the native browser layer.
    await run("ReachAccountMenu.close({returnFocus:false}); showTab('home'); selectDrawerPanel('browser',{focus:false})");
    await until(aligned,'Native Browser must be visible before pointer checks');
    await click('#btn-close-drawer');
    assert.equal(await run("drawer.classList.contains('closed')"),true,'Drawer Close click must work');
    await click('#btn-toggle-files');
    await click('#btn-show-browser');
    await until(aligned,'Browser menu click must reopen the drawer');
    await click('#account-menu-button');
    await until(() => !browserView.getVisible(),'Account menu must hide the native Browser');
    await click('#account-menu-close');
    await until(aligned,'Closing account menu must restore native Browser');
    await click('#btn-toggle-files');
    await until(() => !browserView.getVisible(),'Files/Browser menu must hide the native Browser');
    await click('#btn-show-files');
    assert.equal(await run('drawer.dataset.panel'), 'files','Files menu item must switch drawer modes');
    console.log('Responsive scenario checked:',scenario);
  }

  // Resize and saved drawer width crossings must adapt without throwing away
  // the user's open drawer or forcing them to reopen it after every resize.
  win.webContents.setZoomFactor(1);
  win.setSize(1440,900);
  if (await run("document.documentElement.dataset.rail === 'expanded'")) await click('#rail-toggle');
  await run("selectDrawerPanel('files',{focus:false}); drawer.style.width='420px';");
  await until(() => run("!drawer.classList.contains('overlay')"),'Wide drawer must dock');
  win.setSize(1000,740);
  await until(() => run("drawer.classList.contains('overlay') && !drawer.classList.contains('closed')"),'Narrow resize must overlap and keep the drawer open');
  win.setSize(1440,900);
  await until(() => run("!drawer.classList.contains('overlay') && !drawer.classList.contains('closed')"),'Widening must dock and keep the drawer open');
  await resizeDrawer(720);
  await until(() => run("drawer.classList.contains('overlay')"),'A wider drawer must trigger overlay before squeezing the page');
  await resizeDrawer(320);
  await until(() => run("!drawer.classList.contains('overlay')"),'A narrower drawer must return to a docked column');
  await run('setDrawer(false)');
  win.setSize(1000,740);
  await delay(120);
  assert.equal(await run("drawer.classList.contains('closed')"),true,'Resizing must preserve a closed drawer');

  // A minimum-width Browser drawer also needs to fit its toolbar, selected
  // element details, viewport and status inside a short zoomed window.
  win.webContents.setZoomFactor(1.5);
  await run("ReachAccountMenu.close({returnFocus:false}); showTab('home'); selectDrawerPanel('browser',{focus:false}); drawer.style.width='260px';");
  await delay(150);
  for (const mode of ['normal','find','selection']) {
    await run(`(() => {
      document.querySelector('#browser-find').classList.toggle('hidden', ${JSON.stringify(mode)} !== 'find');
      document.querySelector('#browser-selection').classList.toggle('hidden', ${JSON.stringify(mode)} !== 'selection');
      document.querySelector('#browser-selection-label').textContent = 'button.example-selected-element';
      document.querySelector('#browser-selection-text').textContent = 'A selected page element with a readable description';
    })()`);
    await delay(100);
    const geometry = await run(`(() => {
      const rect = selector => document.querySelector(selector).getBoundingClientRect().toJSON();
      const welcome = document.querySelector('.browser-welcome');
      return {drawer:rect('#file-drawer'),viewport:rect('#browser-viewport'),status:rect('#browser-status'),panel:rect('#browser-panel'),
        welcome:rect('.browser-welcome'),welcomeOverflow:welcome.scrollHeight-welcome.clientHeight,welcomeScroll:getComputedStyle(welcome).overflowY};
    })()`);
    browserSamples.push({mode,...geometry});
    if (geometry.viewport.height < 40 || geometry.viewport.bottom > geometry.drawer.bottom+2 || geometry.status.bottom > geometry.drawer.bottom+2) {
      failures.push({page:'home',state:'browser-'+mode,scenario:'1000x740@1.5-260px-drawer',message:'Browser viewport/status is clipped: '+JSON.stringify(geometry)});
    }
    if (geometry.welcome.bottom > geometry.viewport.bottom+2 || geometry.welcome.top < geometry.viewport.top-2 || (geometry.welcomeOverflow > 2 && geometry.welcomeScroll !== 'auto')) {
      failures.push({page:'home',state:'browser-'+mode,scenario:'1000x740@1.5-260px-drawer',message:'Browser welcome copy spills outside its viewport'});
    }
    fs.writeFileSync(path.join(root,`browser-260px-${mode}.png`),(await win.capturePage()).toPNG());
    await until(aligned,'Minimum-width Browser native bounds do not match its viewport');
    await run("document.querySelector('#browser-elements').scrollIntoView({block:'nearest'});");
    await delay(50);
    const chrome = await run("(() => { const el=document.querySelector('.browser-chrome'); return el && {top:el.scrollTop,height:el.clientHeight,content:el.scrollHeight}; })()");
    assert.ok(chrome && chrome.content > chrome.height && chrome.top > 0,'Short Browser toolbar must scroll to its lower controls');
    await click('#browser-elements');
    assert.equal(await run("document.querySelector('#browser-elements').getAttribute('aria-pressed')"),'true','Scrolled Browser tool must remain clickable');
    await click('#browser-elements');
    await run("document.querySelector('.browser-chrome').scrollTop=0");
  }

  await finish('RESPONSIVE PAGES UI PASS');
})().catch(error => {
  const reportName=relaunchRoot?'relaunch-'+expectedLayout+'.json':'report.json';
  fs.writeFileSync(path.join(root,reportName),JSON.stringify({samples,browserSamples,homeBaselineSamples,alignmentSamples,pageLayoutSamples,overlapSamples,rendererErrors,consoleErrors:errors,failures,error:error.stack},null,2));
  console.error(error.stack,'\nArtifacts:',root);
  clearTimeout(timeout);
  server.close();
  app.exit(1);
});
