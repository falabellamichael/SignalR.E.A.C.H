/* SignalREACH website. Dependency-free, no analytics, no remote AI calls.
   Demo content is intentionally distinct from live product functionality. */
(() => {
  'use strict';
  const DATA = window.REACH_DATA;
  if (!DATA) return;
  const REPO = 'https://github.com/falabellamichael/SignalR.E.A.C.H';
  const $ = (q, root = document) => root.querySelector(q);
  const $$ = (q, root = document) => Array.from(root.querySelectorAll(q));
  const escapeHTML = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const icon = key => `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${DATA.icons[key] || DATA.icons.info}</svg>`;
  const list = items => `<ul class="check-list">${items.map(s=>`<li>${icon('check')}<span>${s}</span></li>`).join('')}</ul>`;
  const external = (href, text) => `<a class="text-link" href="${href}" target="_blank" rel="noopener noreferrer">${text}${icon('external')}<span class="sr-only"> (opens in a new tab)</span></a>`;
  const notice = text => `<div class="notice">${icon('info')}<p>${text}</p></div>`;
  const codebox = (code, label, id) => `<div class="code-box"><div class="code-toolbar"><span class="mono">${label}</span><button type="button" class="copy-btn" data-copy="${id}">${icon('copy')}<span>Copy</span></button></div><pre><code id="${id}">${escapeHTML(code)}</code></pre></div>`;
  let dispose = () => {};

  function init() {
    dispose();
    const controller = new AbortController();
    const signal = controller.signal;
    const timers = new Set();
    let observer, frame = 0;
    const later = (fn, ms) => { const id = setTimeout(() => { timers.delete(id); if (!signal.aborted) fn(); }, ms); timers.add(id); return id; };
    const on = (element, event, fn, opts = {}) => element?.addEventListener(event, fn, {...opts, signal});
    dispose = () => { controller.abort(); observer?.disconnect(); timers.forEach(clearTimeout); cancelAnimationFrame(frame); };
    const root = document.documentElement;
    const page = document.body.dataset.page;
    const reduced = matchMedia('(prefers-reduced-motion: reduce)');
    let toastTimer = null;
    const readSection = () => {
      const raw = window.SignalREACHPreview?.route?.section ?? location.hash.slice(1);
      try { return decodeURIComponent(raw); } catch (_) { return ''; }
    };
    const readQuery = () => new URLSearchParams(window.SignalREACHPreview?.route?.search ?? location.search);
    const setSection = section => {
      if (window.SignalREACHPreview) { window.SignalREACHPreview.setSection(section); return; }
      try { history.pushState(null, '', `#${section}`); } catch (_) { location.hash = section; }
    };
    const motionEnabled = () => root.dataset.motion !== 'off' && !reduced.matches;
    const toast = text => {
      const node = $('.toast');
      if (!node) return;
      clearTimeout(toastTimer);
      node.textContent = text;
      node.classList.add('visible');
      toastTimer = later(() => node.classList.remove('visible'), 2600);
    };
    const save = (key, val) => { try { localStorage.setItem(key, val); } catch (_) {} };
    const updatePreferences = () => {
      const light = root.dataset.theme === 'light';
      $$('.theme-toggle').forEach(button => {
        button.setAttribute('aria-label', `Switch to ${light ? 'dark' : 'light'} theme`);
        button.title = `Switch to ${light ? 'dark' : 'light'} theme`;
      });
      $('meta[name="theme-color"]')?.setAttribute('content', light ? '#f7f5ee' : '#161618');
      $$('.motion-toggle').forEach(button => {
        button.setAttribute('aria-pressed', String(motionEnabled()));
        button.innerHTML = icon(motionEnabled() ? 'pause' : 'play') + `<span>Motion ${motionEnabled() ? 'on' : 'off'}</span>`;
      });
    };
    updatePreferences();
    const observeReveals = () => {
      if (!('IntersectionObserver' in window) || !motionEnabled()) return;
      observer = new IntersectionObserver(entries => entries.forEach(entry => {
        if (entry.isIntersecting) {
          entry.target.classList.remove('pending');
          entry.target.classList.add('visible');
          observer.unobserve(entry.target);
        }
      }), {threshold: 0.06, rootMargin: '0px 0px -25px 0px'});
      $$('.reveal').forEach((node, i) => {
        if (node.getBoundingClientRect().top < innerHeight - 30) { node.classList.add('visible'); return; }
        node.style.setProperty('--stagger', `${(i % 3) * 55}ms`);
        node.classList.add('pending');
        observer.observe(node);
      });
    };
    observeReveals();
    const updateProgress = () => {
      frame = 0;
      const progress = $('.scroll-progress');
      const available = document.documentElement.scrollHeight - innerHeight;
      if (progress) progress.style.transform = `scaleX(${available > 0 ? Math.min(1, Math.max(0, scrollY / available)) : 0})`;
    };
    on(window, 'scroll', () => { if (!frame) frame = requestAnimationFrame(updateProgress); }, {passive:true});
    updateProgress();
    on(document, 'visibilitychange', () => { root.dataset.pageHidden = String(document.hidden); });
    on(reduced, 'change', () => {
      if (reduced.matches) { root.dataset.motion = 'off'; $$('.reveal.pending').forEach(n=>n.classList.remove('pending')); }
      updatePreferences();
    });

    const closeMenu = (focus = false) => {
      const toggle = $('.menu-toggle');
      $('#primary-nav')?.classList.remove('open');
      toggle?.setAttribute('aria-expanded', 'false');
      toggle?.setAttribute('aria-label', 'Open navigation');
      if (focus) toggle?.focus();
    };
    on(window, 'resize', () => { if (innerWidth > 760) closeMenu(); updateProgress(); }, {passive:true});
    on(document, 'keydown', e => {
      if (e.key === 'Escape' && $('.nav-links.open')) closeMenu(true);
      const tab = e.target.closest('[role="tab"]');
      if (!tab) return;
      const group = tab.closest('[role="tablist"]');
      const vertical = group?.getAttribute('aria-orientation') === 'vertical';
      const keys = vertical ? ['ArrowUp','ArrowDown','Home','End'] : ['ArrowLeft','ArrowRight','Home','End'];
      if (!keys.includes(e.key)) return;
      e.preventDefault();
      const tabs = $$('[role="tab"]', group);
      let idx = tabs.indexOf(tab);
      if (e.key === 'Home') idx = 0;
      else if (e.key === 'End') idx = tabs.length - 1;
      else idx = (idx + (['ArrowRight','ArrowDown'].includes(e.key) ? 1 : -1) + tabs.length) % tabs.length;
      tabs[idx].focus(); tabs[idx].click();
    });
    const selectTab = button => {
      const group = button.closest('[role="tablist"]');
      if (!group) return;
      $$('[role="tab"]', group).forEach(tab => {
        const selected = tab === button;
        tab.setAttribute('aria-selected', String(selected));
        tab.tabIndex = selected ? 0 : -1;
      });
      const panel = document.getElementById(button.getAttribute('aria-controls'));
      panel?.setAttribute('aria-labelledby', button.id);
    };
    const animateContent = node => {
      if (!node || !motionEnabled()) return;
      node.classList.remove('content-enter');
      void node.offsetWidth;
      node.classList.add('content-enter');
    };
    const copyText = async button => {
      const source = document.getElementById(button.dataset.copy);
      if (!source) return;
      const text = source.textContent;
      let success = false;
      try {
        if (navigator.clipboard && isSecureContext) { await navigator.clipboard.writeText(text); success = true; }
      } catch (_) {}
      if (!success) {
        const active = document.activeElement;
        const fallback = document.createElement('textarea');
        fallback.value = text; fallback.readOnly = true;
        fallback.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0';
        document.body.append(fallback); fallback.select();
        try { success = document.execCommand('copy'); } catch (_) {}
        fallback.remove(); active?.focus({preventScroll:true});
      }
      if (signal.aborted) return;
      if (success) {
        const original = button.innerHTML;
        button.innerHTML = `${icon('check')}<span>Copied</span>`;
        toast('Code copied to clipboard.');
        later(() => { if (button.isConnected) button.innerHTML = original; }, 1800);
      } else {
        const selection = getSelection(); const range = document.createRange(); range.selectNodeContents(source);
        selection?.removeAllRanges(); selection?.addRange(range);
        toast('Select Copy in your browser to copy the highlighted code.');
      }
    };
    const openDialog = dialog => {
      if (!dialog || dialog.open) return;
      dialog.showModal();
      document.body.style.overflow = 'hidden';
    };
    $$('dialog').forEach(dialog => {
      on(dialog, 'close', () => { document.body.style.overflow = ''; });
      on(dialog, 'click', e => {
        if (e.target === dialog) {
          const rect = dialog.getBoundingClientRect();
          if (e.clientX < rect.left || e.clientX > rect.right || e.clientY < rect.top || e.clientY > rect.bottom) dialog.close();
        }
      });
    });

    /* Product tour: real interactive slides, not a video placeholder. */
    const TOUR = [
      {tag:'01 · BRING YOUR WORK',title:'Start with your project.',text:'Open an existing folder in REACH Studio or create a general project. Keep the files and the conversation in one place.',rows:[['Project files','Your own workspace'],['Conversation','Your next question'],['Editor','Context within reach']]},
      {tag:'02 · CHOOSE YOUR INTELLIGENCE',title:'Connect on your terms.',text:'Configure an OpenAI-compatible endpoint, supply the access required by its host, and choose one of its available models.',rows:[['Endpoint','Your configured base URL'],['Access','Host-managed credentials'],['Model','Your preferred model']]},
      {tag:'03 · KEEP MOVING',title:'Give the idea a direction.',text:'Work with an assistant, create custom personas, or collaborate with agent teams in Studio. Review the work and keep usage visible.',rows:[['Plan','Break down the work'],['Build','Keep context connected'],['Review','Choose your next step']]}
    ];
    let tourStep = 0;
    const renderTour = () => {
      const step = TOUR[tourStep];
      $('#tour-body').innerHTML = `<span class="pill gold">${step.tag}</span><h2 id="tour-title">${step.title}</h2><p>${step.text}</p><div class="tour-visual">${step.rows.map(([a,b],i)=>`<div class="graphic-row ${i===0?'highlight':''}">${a}<span>${b}</span></div>`).join('')}</div><p class="preview-caption">Guided product overview · No live application or AI connection</p><div class="tour-navigation"><button type="button" class="btn btn-secondary btn-sm" data-tour-prev ${tourStep===0?'disabled':''}>Back</button><span class="tour-progress" aria-label="Step ${tourStep+1} of 3">${TOUR.map((_,i)=>`<span class="${i===tourStep?'active':''}" aria-hidden="true"></span>`).join('')}</span>${tourStep<2?`<button type="button" class="btn btn-primary btn-sm" data-tour-next>Next ${icon('arrow')}</button>`:`<a class="btn btn-primary btn-sm" href="download.html">Get started ${icon('arrow')}</a>`}</div>`;
      animateContent($('#tour-body'));
    };

    /* Static examples: placeholders are intentional; no credentials are collected. */
    const examples = {
      curl: DATA.curl,
      python: `import json\nimport urllib.request\n\nrequest = urllib.request.Request(\n    "http://127.0.0.1:20777/v1/chat/completions",\n    headers={\n        "Authorization": "Bearer YOUR_REACH_KEY",\n        "Content-Type": "application/json",\n    },\n    data=json.dumps({\n        "model": "YOUR_MODEL_ID",\n        "messages": [{"role": "user",\n                      "content": "Let’s build something."}]\n    }).encode(),\n)\nwith urllib.request.urlopen(request, timeout=60) as response:\n    print(json.load(response))`,
      javascript: `async function askREACH() {\n  const response = await fetch(\n    "http://127.0.0.1:20777/v1/chat/completions", {\n      method: "POST",\n      headers: {\n        "Authorization": "Bearer YOUR_REACH_KEY",\n        "Content-Type": "application/json"\n      },\n      body: JSON.stringify({\n        model: "YOUR_MODEL_ID",\n        messages: [{ role: "user",\n          content: "Let’s build something." }]\n      })\n    });\n  if (!response.ok) throw new Error(\n    "REACH request failed: " + response.status);\n  console.log(await response.json());\n}\naskREACH().catch(console.error);`
    };
    const originalEditor = $('#editor-code')?.innerHTML;
    const fileContents = {
      'theme.css': `/* Signature SignalREACH palette */\n:root {\n  --background: #161618;\n  --surface: #232329;\n  --text: #eceade;\n  --gold: #d4af37;\n}\n\n[data-theme="light"] {\n  --background: #f7f5ee;\n  --surface: #fffef9;\n  --text: #24231e;\n}\n\n/* Example file, not your workspace. */`,
      'README.md': `# Your next idea\n\nA little context goes a long way.\n\n1. Connect a compatible endpoint.\n2. Open your project folder.\n3. Choose the relevant context.\n4. Build, review, and iterate.\n\nREACH Studio brings the conversation\nand the work into one workspace.\n\nThis is an illustrative preview.\nNo actual files are read or changed.`
    };
    const workflowContent = {
      connect: $('#workflow-panel')?.innerHTML,
      context: `<div class="panel-label">YOUR PROJECT <span class="mono">02 / 03</span></div><h3>The right files. In reach.</h3><p>Keep the relevant context close to the conversation.</p><div class="context-list"><div class="context-item"><span>${icon('file')}app.tsx</span><span class="accent">Selected</span></div><div class="context-item"><span>${icon('file')}theme.css</span><span class="accent">Selected</span></div><div class="context-item"><span>${icon('file')}README.md</span><span class="accent">Selected</span></div></div><a class="btn btn-primary" href="docs.html#studio">Explore project setup ${icon('arrow')}</a><div class="visual-bottom">${icon('info')}Example selection. No files are accessed.</div>`,
      build: `<div class="panel-label">YOUR NEXT STEP <span class="mono">03 / 03</span></div><h3>Keep the work moving.</h3><p>Collaborate with your assistant or configure an agent team in Studio.</p><div class="context-list"><div class="context-item"><span>${icon('layers')}Plan a clear approach</span>${icon('check')}</div><div class="context-item"><span>${icon('code')}Work through the changes</span>${icon('check')}</div><div class="context-item"><span>${icon('shield')}Review before the next step</span>${icon('check')}</div></div><a class="btn btn-primary" href="platform.html">Meet your workspace ${icon('arrow')}</a><div class="visual-bottom">${icon('info')}Illustrative workflow, not a running task.</div>`
    };
    const productMap = {
      studio: {tag:'STANDALONE WORKSPACE', title:'REACH Studio', text:'Your project, AI conversations, custom personas, and collaborating agent teams in a standalone desktop app.', checks:['Project files and editing','Custom personas and agent teams','Connection and budget controls'], href:'docs.html#studio', cta:'Open the Studio guide', graphic:'YOUR WORKSPACE, CONNECTED', rows:[['Project workspace','Files + editor'],['Conversation','Your selected model'],['Agent teams','Custom personas'],['Activity & budgets','Keep work in view']]},
      relay: {tag:'HOST & MANAGE',title:'Relay & control panel',text:'Add a hosted OpenAI-compatible endpoint to SimpleRAG and manage the connection through the integrated REACH panel.',checks:['Dashboard, Endpoint, Models, and Usage','Browser, Logs, Settings, and About','Host-managed access keys and SSE streaming'],href:'docs.html#endpoint',cta:'Open the endpoint guide',graphic:'FROM CLIENT TO MODEL',rows:[['Compatible client','Chat completion request'],['REACH relay','Host-managed access'],['Configured upstream','Model routing'],['Control panel','Usage, logs, settings']]},
      editor: {tag:'INSIDE YOUR EDITOR',title:'REACH for VS Code',text:'Keep AI conversations and coding alongside the project you already have open. Use the extension’s provider, model, and context controls.',checks:['Provider and model selection','Files and images as context','Agent, Workspace, Think, and Web controls'],href:'docs.html#editor',cta:'Open the extension guide',graphic:'THE EDITOR EXPERIENCE',rows:[['Your project','Workspace context'],['REACH Chat','Provider + model'],['Composer','Files and images'],['Controls','Choose the tools you need']]},
      tray: {tag:'DESKTOP COMPANION',title:'A bridge within reach.',text:'Use the local desktop tray for endpoint access, MiniChat, and configured provider routes without opening the full workspace.',checks:['Home, MiniChat, and Controls','Endpoint and provider selectors','Local bridge status and connection controls'],href:REPO+'#desktop-tray-macos-windows-and-linux',cta:'Read the tray guide',graphic:'A SMALLER SURFACE',rows:[['Provider','Configured endpoint or bridge'],['Home','Connection status'],['MiniChat','A compact conversation'],['Controls','Local bridge settings']]}
    };
    const selectProduct = (key, updateURL = false) => {
      if (!Object.hasOwn(productMap, key)) key = 'studio';
      const product = productMap[key]; const stage = $('#platform-stage');
      if (!stage) return;
      const button = $(`[data-platform="${key}"]`); selectTab(button);
      stage.innerHTML = `<div><span class="pill gold">${product.tag}</span><h2>${product.title}</h2><p>${product.text}</p>${list(product.checks)}${product.href.startsWith('http')?external(product.href,product.cta):`<a class="text-link" href="${product.href}">${product.cta}${icon('arrow')}</a>`}</div><div class="platform-graphic"><div class="graphic-title">${icon('mark')}${product.graphic}</div>${product.rows.map(([a,b],i)=>`<div class="graphic-row ${i===0?'highlight':''}">${a}<span>${b}</span></div>`).join('')}<div class="visual-bottom">${icon('info')}Feature map · not a live application</div></div>`;
      animateContent(stage);
      if (updateURL && !window.SignalREACHPreview) {
        const url = new URL(location.href); url.searchParams.set('view',key);
        try { history.replaceState(null,'',url); } catch (_) {}
      }
    };
    if (page==='platform') selectProduct(readQuery().get('view') || 'studio');

    /* Integrations: only filter known data. No backend call. */
    let activeFilter = 'all';
    const filterIntegrations = () => {
      const query = ($('#integration-search')?.value || '').toLowerCase().trim(); let count = 0;
      $$('.integration-card').forEach(card => {
        const match = (activeFilter==='all' || card.dataset.category===activeFilter) && card.dataset.search.includes(query);
        card.hidden = !match;
        if (match) { count++; card.classList.remove('pending'); card.classList.add('visible'); }
      });
      if ($('#integration-count')) $('#integration-count').textContent = `Showing ${count} integration${count===1?'':'s'}`;
      if ($('#integration-empty')) $('#integration-empty').hidden = count !== 0;
      $$('[data-filter]').forEach(b=>{const selected=b.dataset.filter===activeFilter;b.classList.toggle('active',selected);b.setAttribute('aria-pressed',String(selected));});
    };
    on($('#integration-search'),'input',filterIntegrations);

    /* Docs: the initial article is server-rendered; the other compact guides are local. */
    const quickstart = $('#docs-article')?.innerHTML || '';
    const docArticles = {
      quickstart:{title:'Quick start',description:'Run REACH Studio from source. Install Git and Node.js 24 LTS, configure an endpoint, and open a project.',html:quickstart},
      studio:{title:'REACH Studio',description:'Project folders, settings, personas, agent teams, commands, and budgets in the standalone workspace.',html:`<div class="doc-meta"><span class="pill gold">WORKSPACE</span><span>REACH Studio</span></div><h2>Make room for your project.</h2><p>Studio is the standalone macOS, Windows, and Linux app. It combines project files and editing, AI conversations, custom personas, and collaborating agent teams.</p><h3>Choose a starting point.</h3>${list(['<strong>Open Folder</strong> loads an existing project.','<strong>New Project → General project</strong> creates an empty folder.','<strong>Settings → Connection &amp; default model</strong> configures your endpoint.'])}<h3>Keep the work connected.</h3><p>Use the Files panel to explore your project. Work through conversations with relevant context, configure custom personas, and use agent teams when more than one role is useful.</p><h3>Keep usage and actions visible.</h3><p>Studio includes a Budgeting settings page and an Activity trail. Review the applicable tool permissions and edit-review controls before running a task.</p>${notice('Optional TypeSafe Jev context selection and Auto mode require separate configuration and a TypeSafe API key. They are not enabled by this website.')}<div class="docs-pager">${external(REPO+'/blob/main/studio/README.md','Full Studio documentation')}<a class="text-link" href="#endpoint" data-doc="endpoint">Connect an endpoint ${icon('arrow')}</a></div>`},
      endpoint:{title:'Connect an endpoint',description:'Configure base URL, access key, model ID, chat completions, and streaming for the relay.',html:`<div class="doc-meta"><span class="pill gold">CONNECTIONS</span><span>OpenAI-compatible endpoints</span></div><h2>Your endpoint. Your model.</h2><p>Use the base URL and access key provided by your endpoint host. A local REACH relay commonly uses <code>http://127.0.0.1:20777/v1</code>; a hosted relay can use a different address.</p><h3>Configure the connection.</h3>${list(['Enter the complete base URL in your client or Studio connection settings.','Add the API key required by the host. Do not put real keys into public source files.','Choose a model ID actually exposed by that endpoint.'])}<h3>A streaming request.</h3><p>This is an illustrative cURL request. Replace every placeholder and use the URL supplied by your host.</p>${codebox(examples.curl,'cURL · streaming chat','endpoint-example')}${notice('This guide does not run requests. Your provider controls model availability, access, and usage limits. A browser client may also need appropriate CORS configuration.')}<div class="docs-pager">${external(REPO+'#readme','Relay source guide')}<a class="text-link" href="#troubleshooting" data-doc="troubleshooting">Troubleshooting ${icon('arrow')}</a></div>`},
      editor:{title:'VS Code extension',description:'Use chat, model selection, file attachments, workspace context, and agent controls inside VS Code.',html:`<div class="doc-meta"><span class="pill gold">EDITOR</span><span>VS Code extension</span></div><h2>Keep the conversation in your editor.</h2><p>The repository includes a VS Code extension for REACH chat and coding. Follow the extension guide for installation and connection setup.</p><h3>Bring in the context you need.</h3>${list(['Select a provider and an available model.','Use file or image attachments where supported.','Use Workspace context for the open project.','Review the Agent, Think, and Web controls for the current task.'])}<h3>Find the implementation.</h3>${codebox('vscode/\n  media/\n    chat.html\n    browser.html','Repository paths','editor-paths')}<p>The redesigned website preview follows the existing chat layout and provider/context controls, but is not the installed extension itself.</p>${notice('Provider routes may require a local bridge or signed-in account. Configure them according to the extension and tray documentation.')}<div class="docs-pager">${external(REPO+'#vs-code','Extension setup guide')}${external(REPO+'/tree/main/vscode','Extension source')}</div>`},
      security:{title:'Privacy & security',description:'Website demo privacy, local preferences, credentials, storage, and repository security policy.',html:`<div class="doc-meta"><span class="pill gold">BEFORE YOU CONNECT</span><span>Privacy &amp; security</span></div><h2>Know what is connected.</h2><p>This website is a static presentation layer. Its demos do not call a model endpoint, read project files, or collect API keys.</p><h3>What this website stores.</h3><p>Only your light/dark theme and motion preferences are saved in browser local storage, when available. Demo prompts stay in the current page memory and are not transmitted or saved by the website. There are no analytics, remote fonts, or third-party scripts in the site package.</p><h3>What the actual application sends.</h3><p>The selected model provider receives the request and context needed to answer. Provider routes and optional services can have different access, processing, and retention rules. Review the product’s documentation and your provider’s policies.</p><h3>Keep credentials in the application.</h3><p>Studio uses the OS credential vault when available and displays a warning if encryption is unavailable. Not all application data is necessarily encrypted. Review the repository security policy for the precise storage behavior and migration caveats.</p>${notice('Never paste an actual access key into this website’s demo, a public repository, or a shared screenshot. The sample code contains placeholders on purpose.')}<div class="docs-pager">${external(REPO+'/blob/main/SECURITY.md','Read the security policy')}<a class="text-link" href="#quickstart" data-doc="quickstart">Back to setup ${icon('arrow')}</a></div>`},
      troubleshooting:{title:'Troubleshooting',description:'Resolve setup issues, unavailable endpoints, access keys, missing models, and blocked connections.',html:`<div class="doc-meta"><span class="pill gold">FIND A WAY FORWARD</span><span>Troubleshooting</span></div><h2>Check the connection, then the context.</h2><h3>Studio will not start.</h3><p>Confirm the prerequisites from the Studio guide, run <code>npm ci</code> from the <code>studio</code> directory, and read the terminal error. The documented <code>npm start</code> command builds the editor bundle before launching Electron.</p><h3>The endpoint is unavailable.</h3><p>Confirm that the relay or host is running, and use its current base URL. A localhost address points to the machine running the client, not another computer.</p><h3>Access is rejected.</h3><p>Check the API key and the host’s access policy. Do not bypass authentication or make a private endpoint public to work around an access error.</p><h3>A model is missing.</h3><p>Use the model catalog from the configured endpoint. Example model IDs are placeholders, not a guarantee that a provider serves that model.</p><h3>The website demo feels different.</h3><p>The website uses sample files, guided slides, and scripted responses. Install the actual product and configure a connection for live AI functionality.</p><div class="docs-pager">${external(REPO+'/issues','Browse project issues')}<a class="text-link" href="#endpoint" data-doc="endpoint">Connection guide ${icon('arrow')}</a></div>`}
    };
    let currentDoc = 'quickstart';
    const showDoc = (key, focus = false) => {
      const article = $('#docs-article'); if (!article) return;
      if (!Object.hasOwn(docArticles,key)) key='quickstart';
      currentDoc=key;
      article.innerHTML = docArticles[key].html;
      $$('.docs-nav [data-doc]').forEach(a=>{const selected=a.dataset.doc===key;a.classList.toggle('active',selected);if(selected)a.setAttribute('aria-current','page');else a.removeAttribute('aria-current');});
      document.title = `${docArticles[key].title} | SignalREACH Docs`;
      animateContent(article);
      if (focus) { article.focus({preventScroll:true}); if (innerWidth<760) article.scrollIntoView({behavior:motionEnabled()?'smooth':'instant',block:'start'}); }
    };
    if (page==='docs') {
      const section=readSection(); showDoc(Object.hasOwn(docArticles,section)?section:'quickstart');
      on(window,'hashchange',()=>{if(!window.SignalREACHPreview)showDoc(readSection());});
      on(window,'popstate',()=>{if(!window.SignalREACHPreview)showDoc(readSection());});
      on($('#docs-search'),'input', e=>{
        const query=e.target.value.trim().toLowerCase();
        if(!query){showDoc(currentDoc);return;}
        const matches=Object.entries(docArticles).filter(([,doc])=>(doc.title+' '+doc.description).toLowerCase().includes(query));
        const article=$('#docs-article');
        article.innerHTML=`<div class="doc-meta"><span class="pill gold">GUIDE SEARCH</span><span role="status">${matches.length} result${matches.length===1?'':'s'}</span></div><h2>Find your next step.</h2><p id="doc-search-query"></p><div class="doc-search-results">${matches.map(([key,doc])=>`<a class="doc-result" href="#${key}" data-doc="${key}"><h3>${doc.title} ${icon('arrow')}</h3><p>${doc.description}</p></a>`).join('') || '<div class="empty-state"><h3>No matching guides.</h3><p>Try “endpoint”, “project”, or “security”.</p></div>'}</div>`;
        $('#doc-search-query').textContent=`Results for “${e.target.value.trim()}”`;
      });
    }
    const osCopy = {
      windows:['Use the documented Windows source workflow.','Install Git and Node.js 24 LTS.','Configure a compatible endpoint inside Studio.'],
      macos:['Use the documented macOS source workflow.','Install Git and Node.js 24 LTS.','Review OS credential-vault status in Settings.'],
      linux:['Use the documented Linux source workflow.','Install Git and Node.js 24 LTS.','Review credential-storage warnings on your system.']
    };
    const chooseOS = key => {
      if (!osCopy[key]) return;
      const button=$(`[data-os="${key}"]`); if(!button)return;
      selectTab(button); $('#os-panel').innerHTML=list(osCopy[key]); animateContent($('#os-panel'));
    };
    if(page==='download') {
      const platform=navigator.userAgentData?.platform || navigator.platform || '';
      chooseOS(/Mac/i.test(platform)?'macos':/Linux/i.test(platform) && !/Android/i.test(navigator.userAgent)?'linux':'windows');
    }

    on(document, 'click', e => {
      const target = e.target instanceof Element ? e.target : null; if(!target)return;
      const theme=target.closest('.theme-toggle');
      if(theme){root.dataset.theme=root.dataset.theme==='light'?'dark':'light';save('signalreach-theme',root.dataset.theme);updatePreferences();return;}
      if(target.closest('.motion-toggle')){
        if(reduced.matches){root.dataset.motion='off';toast('Your system preference keeps motion reduced.');}
        else root.dataset.motion=motionEnabled()?'off':'on';
        save('signalreach-motion',root.dataset.motion);updatePreferences();
        if(!motionEnabled()) $$('.reveal.pending').forEach(node=>node.classList.remove('pending'));
        return;
      }
      if(target.closest('.menu-toggle')){
        const nav=$('#primary-nav'), button=$('.menu-toggle'); const open=!nav.classList.contains('open');
        nav.classList.toggle('open',open);button.setAttribute('aria-expanded',String(open));button.setAttribute('aria-label',open?'Close navigation':'Open navigation');
        if(open)$('a',nav)?.focus();return;
      }
      if($('.nav-links.open') && (!target.closest('.site-header') || target.closest('.nav-links a')))closeMenu();
      const copy=target.closest('[data-copy]');if(copy){copyText(copy);return;}
      if(target.closest('[data-close-dialog]')){target.closest('dialog')?.close();return;}
      if(target.closest('[data-open-tour]')){tourStep=0;renderTour();openDialog($('#tour-dialog'));return;}
      if(target.closest('[data-tour-next]')){tourStep=Math.min(2,tourStep+1);renderTour();$('#tour-body h2')?.setAttribute('tabindex','-1');$('#tour-body h2')?.focus();return;}
      if(target.closest('[data-tour-prev]')){tourStep=Math.max(0,tourStep-1);renderTour();return;}
      const preview=target.closest('[data-preview]');
      if(preview){selectTab(preview);$$('.studio-window [role="tabpanel"]').forEach(panel=>{panel.hidden=panel.id!==`preview-${preview.dataset.preview}`;});animateContent($(`#preview-${preview.dataset.preview}`));return;}
      const file=target.closest('[data-file]');
      if(file){$$('[data-file]').forEach(b=>{const active=b===file;b.classList.toggle('active',active);b.setAttribute('aria-pressed',String(active));});$('#editor-file-name').textContent=file.dataset.file;$('.editor-bar .accent').textContent=file.dataset.file==='app.tsx'?'TSX':file.dataset.file==='theme.css'?'CSS':'MD';$('#editor-code').innerHTML=file.dataset.file==='app.tsx'?originalEditor:fileContents[file.dataset.file].split('\n').map((line,i)=>`<span class="ln">${i+1}</span>${escapeHTML(line)}`).join('\n');return;}
      const step=target.closest('[data-step]');
      if(step){selectTab(step);$('#workflow-panel').innerHTML=workflowContent[step.dataset.step];animateContent($('#workflow-panel'));return;}
      const lang=target.closest('[data-language]');
      if(lang){selectTab(lang);$('#api-example').textContent=examples[lang.dataset.language];animateContent($('#api-example-panel'));return;}
      const product=target.closest('[data-platform]');if(product){selectProduct(product.dataset.platform,true);return;}
      const filter=target.closest('[data-filter]');if(filter){activeFilter=filter.dataset.filter;filterIntegrations();return;}
      if(target.closest('#clear-integrations')){activeFilter='all';$('#integration-search').value='';filterIntegrations();$('#integration-search').focus();return;}
      const integration=target.closest('[data-integration]');
      if(integration){const item=DATA.integrations.find(x=>x.id===integration.dataset.integration);if(!item)return;$('#integration-dialog-body').innerHTML=`<span class="pill gold">${item.category}</span><h2 id="integration-title">${item.name}</h2><p>${item.description}</p><h3 style="font-size:18px;margin-bottom:14px">Before you connect</h3><p>${item.detail}</p>${item.href.startsWith('http')?external(item.href,'Open the project guide'):`<a class="btn btn-primary" href="${item.href}">Read the setup guide ${icon('arrow')}</a>`}${notice('Compatibility information only. This website does not connect accounts, collect credentials, or activate a provider.')}`;openDialog($('#integration-dialog'));return;}
      const doc=target.closest('[data-doc]');if(doc && page==='docs'){e.preventDefault();const key=doc.dataset.doc;if($('#docs-search'))$('#docs-search').value='';setSection(key);showDoc(key,true);return;}
      const os=target.closest('[data-os]');if(os){chooseOS(os.dataset.os);return;}
    });

    /* Rich local heuristic demo: no network/model calls. */
    const demoForm = $('#demo-form');
    const demoInput = $('#demo-input');
    const demoLog = $('#demo-log');
    if (demoForm && demoInput && demoLog) {
      const DEMO_TOPICS = [
        {id:'overview',title:'What REACH can do',category:'Start',keywords:['what can reach do','what is reach','signalreach','features','capabilities','overview','help me understand','what does this do','reach app'],quick:'SignalREACH brings project files, AI conversations, model connections, custom personas, and agent teams into one connected workspace. Use this demo to explore a feature, then open Platform or Docs for the real setup path.',steps:['Open a project in REACH Studio or use the VS Code extension.','Connect an OpenAI-compatible endpoint and select an available model.','Bring only the files and context you need into the conversation.','Review the assistant or agent-team output before applying changes.'],example:'Example: ask “How do I connect a local model?” or “How do agent teams work?” and this demo will route you to a focused answer.'},
        {id:'install',title:'Install / get started',category:'Start',keywords:['install','installation','setup','set up','get started','getting started','start reach','run reach','launch reach','prerequisite','node 24','npm ci','instal','instll'],quick:'Start with Git and Node.js 24 LTS, then follow the Studio or VS Code setup guide for the surface you want to use. The website itself is only a static demo.',steps:['Install Git and Node.js 24 LTS.','Clone or download the SignalREACH repository.','For Studio, open the studio directory and follow its documented npm workflow.','Configure your endpoint and model inside the app instead of placing secrets in source files.'],example:'Example path: clone the repository → open the Studio guide → install dependencies → start Studio → add your endpoint in Settings.'},
        {id:'windows',title:'Windows setup',category:'Start',keywords:['windows','win11','win 11','win10','win 10','powershell','windows install','windows setup','pc setup'],quick:'On Windows, use the documented source workflow with Git and Node.js 24 LTS, then configure your endpoint from inside REACH Studio. Keep API keys out of public files and screenshots.',steps:['Install Git for Windows and Node.js 24 LTS.','Clone SignalREACH and open the Studio folder.','Install the documented dependencies and start the app.','Open Settings → Connection & default model and add your endpoint.'],example:'Example: after Studio opens, connect a local relay at the base URL your relay displays, then choose one of the model IDs it actually exposes.'},
        {id:'mac',title:'macOS setup',category:'Start',keywords:['mac','macos','mac os','apple silicon','m1','m2','m3','m4','mac install','mac setup'],quick:'On macOS, use Git and Node.js 24 LTS, follow the Studio source workflow, and review credential-vault status in Settings after you connect a provider.',steps:['Install Git and Node.js 24 LTS.','Clone the repository and enter the Studio directory.','Run the documented install/start commands.','Configure your endpoint and confirm credential storage status in Settings.'],example:'Example: use a local or hosted OpenAI-compatible endpoint, select a model exposed by that host, then open a project folder.'},
        {id:'linux',title:'Linux setup',category:'Start',keywords:['linux','ubuntu','debian','fedora','arch','linux install','linux setup','wayland','x11'],quick:'On Linux, install Git and Node.js 24 LTS, follow the Studio source workflow, and pay attention to any credential-storage warning shown for your environment.',steps:['Install Git and Node.js 24 LTS using your distribution’s supported method.','Clone the repo and follow the Studio README.','Start Studio and configure a compatible endpoint.','Review credential-storage warnings before saving access keys.'],example:'Example: a local relay can stay on localhost while Studio connects to it using the relay’s documented base URL.'},
        {id:'endpoint',title:'Connect an endpoint',category:'Models',keywords:['endpoint','connect','connection','base url','baseurl','server url','host url','api endpoint','openai compatible','compatible endpoint','conect','connnect','endpont','end point'],quick:'In the real app, enter the complete base URL, the access key required by that host, and a model ID that endpoint actually serves. A localhost URL points to the machine running the client.',steps:['Start or obtain access to an OpenAI-compatible endpoint.','Copy its complete base URL into REACH connection settings.','Add the host-required access key without committing it to source.','Refresh or select a model ID exposed by that endpoint.','Send a small test request before attaching large project context.'],example:'Example: a local REACH relay commonly uses a URL shaped like http://127.0.0.1:20777/v1, but use the exact address your relay reports.'},
        {id:'apikey',title:'API keys',category:'Models',keywords:['api key','apikey','key','token','access key','credential','credentials','secret','auth','authentication','bearer','api kye'],quick:'Treat API keys as secrets. Store them in the application or your provider’s supported credential mechanism—never in public source, demo prompts, screenshots, or commits.',steps:['Create or obtain the key from the endpoint/provider you are using.','Enter it only in the app’s connection settings or supported secret store.','Test the connection.','Rotate the key if it is ever exposed publicly.'],example:'Example header: Authorization: Bearer YOUR_REACH_KEY. The placeholder belongs in documentation; your real key does not.'},
        {id:'model',title:'Choose a model',category:'Models',keywords:['model','models','choose model','select model','model id','model name','available models','missing model','which model','modle','moddel'],quick:'REACH does not invent the model catalog. It uses the models exposed by your configured endpoint, so select a model ID that the host actually returns.',steps:['Connect the endpoint first.','Refresh or inspect its available model catalog.','Choose the model that fits your task and provider limits.','Run a small test prompt before using larger context.'],example:'Example: if your local server exposes a coding model and a general model, use the exact IDs shown by that server rather than a guessed name.'},
        {id:'localmodel',title:'Local models',category:'Models',keywords:['local model','ollama','lm studio','localhost model','offline model','local ai','run locally','local llm','local inference'],quick:'You can point REACH at a local OpenAI-compatible server when that server exposes the endpoints REACH expects. Keep the server running and use its current local base URL.',steps:['Start your local model server.','Enable or locate its OpenAI-compatible API.','Copy its base URL into REACH.','Select a model currently loaded or exposed by the server.','Test before adding workspace context.'],example:'Example: LM Studio or another local server can work when its OpenAI-compatible API is enabled and reachable from the REACH client.'},
        {id:'streaming',title:'Streaming responses',category:'Models',keywords:['stream','streaming','sse','server sent events','tokens','token stream','stream response','slow stream'],quick:'REACH can work with streaming chat-completion responses when the configured endpoint supports the expected OpenAI-compatible streaming format.',steps:['Confirm the endpoint supports streaming chat completions.','Enable streaming in the client/request path where documented.','Check proxy or CORS settings if a browser-based client stalls.','Inspect logs if the connection opens but no chunks arrive.'],example:'Example: a compatible endpoint usually returns incremental SSE chunks until the completion ends.'},
        {id:'studio',title:'REACH Studio',category:'Workspace',keywords:['studio','reach studio','desktop app','standalone','workspace app','electron','desktop workspace'],quick:'REACH Studio is the standalone workspace: project files, editing, AI conversations, custom personas, agent teams, connection settings, budgets, and an activity trail in one app.',steps:['Open an existing folder or create a general project.','Configure your endpoint and default model.','Select the files/context relevant to the task.','Use a normal assistant, persona, or agent team.','Review activity and proposed changes.'],example:'Example: open a web project, select its component and stylesheet, then ask a coding persona to explain a UI bug before editing.'},
        {id:'vscode',title:'VS Code extension',category:'Workspace',keywords:['vscode','vs code','visual studio code','extension','editor extension','reach extension','code editor'],quick:'The VS Code extension keeps REACH chat beside your code with provider/model selection, file and image attachments, workspace context, and Agent / Think / Web controls where available.',steps:['Install or load the REACH extension using the repository guide.','Configure a provider and model.','Open the project you want to work on.','Attach files or enable workspace context deliberately.','Review edits before applying them.'],example:'Example: attach app.js and styles.css, ask for a focused change, then inspect the proposed edit before saving.'},
        {id:'project',title:'Projects & folders',category:'Workspace',keywords:['project','folder','open folder','workspace','repo','repository','project folder','new project','existing project','workspce'],quick:'Projects give REACH a bounded workspace. Open the folder you actually want to work on so file context and proposed changes stay relevant.',steps:['Open an existing project folder or create a general project.','Confirm the project root is correct.','Select only the files relevant to the current task.','Ask the assistant to inspect or explain before making broad edits.'],example:'Example: for a React bug, open the app repository—not your entire drive—then select the component, related hook, and stylesheet.'},
        {id:'context',title:'Project context',category:'Workspace',keywords:['context','workspace context','project context','add context','selected context','context window','file context','relevant files','contex','cntxt'],quick:'Good context is specific context. Give REACH the files, snippets, and project information needed for the current task instead of attaching everything by default.',steps:['State the concrete task.','Select the smallest set of relevant files.','Add error output or constraints when useful.','Ask for an explanation or plan before large changes.','Refresh context when the task moves to another part of the project.'],example:'Example: for a failing login form, include the form component, auth client, route handler, and exact error—not unrelated assets.'},
        {id:'files',title:'Files & attachments',category:'Workspace',keywords:['file','files','attachment','attachments','image attachment','attach file','select file','read file','edit file'],quick:'Use file and image attachments where the selected REACH surface supports them. Keep attachments task-specific and verify any generated edits before applying them.',steps:['Choose the file or image that contains the needed evidence.','Add it to the current conversation/context.','Describe exactly what you want checked or changed.','Review the answer against the source file.'],example:'Example: attach a screenshot plus the matching CSS file when diagnosing a responsive-layout issue.'},
        {id:'agent',title:'Agents',category:'Agents',keywords:['agent','agents','agent mode','coding agent','assistant agent','run agent','agnet','agnt'],quick:'Agents are useful when the task has multiple steps or tools. Give an agent a clear goal, bounded context, and permissions you are comfortable reviewing.',steps:['Define the outcome rather than a vague role.','Provide only the context needed for that outcome.','Review available tools/permissions before the run.','Inspect the plan and resulting changes.','Keep sensitive or destructive actions under explicit review.'],example:'Example: “Inspect these three files, identify why the test fails, propose a minimal patch, and show me the diff before applying it.”'},
        {id:'personas',title:'Custom personas',category:'Agents',keywords:['persona','personas','custom persona','role','roles','specialist','assistant role','pesona','persona setup'],quick:'Custom personas let you shape an assistant around a repeatable role, such as reviewer, debugger, documentation writer, or frontend specialist.',steps:['Name the role and its responsibility.','Define what context it should prioritize.','Add constraints such as “explain before editing”.','Test it on a small task and refine the instructions.'],example:'Example persona: “Frontend reviewer — prioritize accessibility, responsive behavior, and minimal changes; flag uncertainty instead of guessing.”'},
        {id:'teams',title:'Agent teams',category:'Agents',keywords:['agent team','agent teams','team','multi agent','multiple agents','collaboration','collaborating agents','team agents','agent crew'],quick:'REACH Studio can organize collaborating agent roles so planning, implementation, and review can be separated instead of asking one role to do everything.',steps:['Create focused roles with non-overlapping responsibilities.','Give the team a shared outcome and project context.','Let a planning role break down the work.','Have implementation roles make scoped changes.','Use a review role to check the result before acceptance.'],example:'Example team: Planner → Frontend implementer → Test reviewer, all working against the same bounded project goal.'},
        {id:'coding',title:'Coding help',category:'Build',keywords:['code','coding','program','programming','build feature','implement','refactor','function','javascript','python','typescript','react','html','css'],quick:'Use REACH for explanation, implementation, refactoring, and review—but keep the task scoped and verify code against your project’s tests and conventions.',steps:['Describe the behavior you want, not only the file you want changed.','Provide the relevant code and constraints.','Ask for a minimal plan or diagnosis first when the change is risky.','Review the diff.','Run the project’s tests or validation commands.'],example:'Example: “Add keyboard navigation to this tab component without changing its public API; show the patch and tests.”'},
        {id:'debug',title:'Debug an error',category:'Build',keywords:['debug','error','exception','stack trace','bug','broken','not working','fails','failure','crash','traceback','fix error','troubleshoot code'],quick:'For debugging, give REACH the exact error, the smallest reproducible path, and the relevant files. Specific evidence produces better diagnoses than “it doesn’t work.”',steps:['Copy the exact error or stack trace.','Say what action triggers it.','Add the relevant code/config files.','Mention what recently changed.','Ask for likely causes ranked by evidence, then test the smallest fix first.'],example:'Example: “npm start fails with this stack trace after I changed vite.config.js; here are the config and package.json files.”'},
        {id:'git',title:'Git & GitHub',category:'Build',keywords:['git','github','commit','push','pull','branch','merge','diff','repository','repo status'],quick:'REACH can help reason about Git changes and prepare repository work. Review the diff and branch target before committing or pushing.',steps:['Check the working tree and current branch.','Review the diff for unrelated changes.','Run relevant tests.','Write a focused commit message.','Push to the intended branch and verify the remote commit.'],example:'Example: “Show me what changed in these website files, exclude generated logs, and prepare one focused commit.”'},
        {id:'terminal',title:'Terminal & commands',category:'Build',keywords:['terminal','shell','command','commands','cli','powershell','bash','cmd','run command','console'],quick:'Use terminal actions deliberately: know the working directory, understand the command, and inspect output before chaining destructive steps.',steps:['Confirm the project directory.','Use read-only inspection commands first.','Run the narrowest command that tests your assumption.','Review output before changing or deleting files.'],example:'Example: check git status and run the project test command before committing a code change.'},
        {id:'browser',title:'Research browser',category:'Build',keywords:['browser','web','research','web search','site','website','reader','chromium','browse'],quick:'SignalREACH includes browser/research surfaces for public web work alongside your project. Keep web evidence separate from project files and verify sources before acting on them.',steps:['Open the Browser or Reader surface documented for your REACH client.','Search or navigate to the relevant public source.','Capture only the evidence needed for the task.','Keep source links with excerpts you add to context.'],example:'Example: look up current library documentation, save the relevant API section with its source link, then compare it with your project code.'},
        {id:'theme',title:'Theme & design',category:'Appearance',keywords:['theme','color','colors','design','gold','charcoal','palette','style','appearance','brand','branding','ui design'],quick:'SignalREACH keeps its signature charcoal-and-gold identity in dark mode and a warm ivory-and-gold interpretation in light mode. The theme switch changes presentation, not your project files.',steps:['Use the theme toggle in the site header.','Keep gold as the accent instead of using it as large body-text color.','Preserve readable contrast in both themes.','Respect reduced-motion preferences for animated elements.'],example:'Example: dark uses deep charcoal surfaces with gold accents; light uses warm ivory surfaces with the same gold identity.'},
        {id:'lightdark',title:'Light / dark mode',category:'Appearance',keywords:['dark mode','light mode','switch theme','toggle theme','dark theme','light theme','night mode','day mode'],quick:'Use the header theme control to switch between SignalREACH dark and light themes. The site saves that preference locally when browser storage is available.',steps:['Activate the theme toggle in the header.','Check text, controls, code blocks, and focus states after switching.','Use the motion control separately if you want fewer animations.'],example:'Example: switching to light mode keeps the gold accent while changing the background and surfaces to warm ivory tones.'},
        {id:'performance',title:'Performance',category:'Troubleshoot',keywords:['performance','slow','lag','laggy','speed','memory','cpu','high cpu','freeze','frozen','responsive','performance issue'],quick:'When REACH feels slow, isolate whether the bottleneck is the model endpoint, project context size, browser surface, or the local app itself before changing settings.',steps:['Try a small prompt with minimal context.','Check whether the endpoint itself responds slowly.','Reduce unnecessary file/context attachments.','Close unused heavy browser tabs or agent runs.','Review logs for repeated retries or connection errors.'],example:'Example: if a tiny prompt is fast but a workspace-wide prompt is slow, context size is a stronger suspect than the UI theme.'},
        {id:'privacy',title:'Privacy',category:'Security',keywords:['privacy','private','data','retention','telemetry','analytics','tracking','conversation data','store prompts'],quick:'This website demo makes no model request and does not transmit demo prompts. In the actual app, the configured provider receives the request and context needed to answer, so review that provider’s policies.',steps:['Know which endpoint/provider is selected.','Send only the context required for the task.','Review provider retention and processing rules.','Keep secrets out of prompts and public artifacts.'],example:'Example: the homepage heuristic demo stays in the page; a real configured model request follows the policies of the endpoint you chose.'},
        {id:'security',title:'Security',category:'Security',keywords:['security','secure','safe','secret','credential storage','vault','keychain','threat','security policy','securty'],quick:'Keep credentials in supported secret storage, review tool permissions, and avoid making private endpoints public just to bypass a connection problem.',steps:['Read the repository security policy.','Store keys in the application or OS-backed credential mechanism where available.','Review agent/tool permissions before runs.','Rotate exposed credentials immediately.','Keep private services bound and authenticated appropriately.'],example:'Example: if authentication fails, fix the key or host policy—do not remove authentication from a private endpoint as a shortcut.'},
        {id:'cors',title:'CORS / browser connection',category:'Troubleshoot',keywords:['cors','cross origin','blocked by cors','origin','preflight','browser blocked','access control allow origin','cors error'],quick:'A browser-based client can be blocked by CORS even when the endpoint itself is healthy. Configure CORS on the endpoint/proxy rather than disabling browser security.',steps:['Confirm the endpoint works from a trusted non-browser client.','Inspect the browser console/network error.','Configure the endpoint or reverse proxy to allow the intended origin and headers.','Retest the preflight and request.'],example:'Example: an OPTIONS preflight can fail before your chat request is ever sent; the browser console usually names the missing CORS permission.'},
        {id:'localhost',title:'Localhost connection',category:'Troubleshoot',keywords:['localhost','127.0.0.1','local host','cant connect localhost','connection refused','refused','port','local server'],quick:'localhost always means the machine running the client. If REACH and the model server are on different computers, use an appropriate reachable address instead of 127.0.0.1.',steps:['Confirm the server process is running.','Confirm the port and base path are correct.','Test the endpoint locally on the server machine.','If the client is on another machine, use a properly secured reachable address.'],example:'Example: http://127.0.0.1:20777 works only when the REACH client can reach a relay on its own local machine at that port.'},
        {id:'missingmodel',title:'Model missing',category:'Troubleshoot',keywords:['model missing','missing model','model not found','404 model','unknown model','no models','empty model list','model unavailable'],quick:'If a model is missing, refresh the model catalog from the configured endpoint and use an ID it actually exposes. Documentation examples are not guarantees of provider availability.',steps:['Verify you are connected to the intended endpoint.','Inspect or refresh its model list.','Check that the model is loaded/enabled on that host.','Use the exact returned model ID.'],example:'Example: a local server may expose “my-coder-model” while a guessed provider-style name returns model-not-found.'},
        {id:'autherror',title:'Authentication error',category:'Troubleshoot',keywords:['401','403','unauthorized','forbidden','auth error','authentication error','access denied','invalid key','bad key','key rejected'],quick:'401/403 errors usually point to credentials or host access policy. Recheck the selected endpoint and key before changing network or model settings.',steps:['Verify the endpoint URL is the one the key belongs to.','Re-enter or rotate the access key.','Check the host’s permissions or account status.','Retry a minimal request.'],example:'Example: a valid key for one provider will not authenticate against a different endpoint, even if both use OpenAI-compatible request shapes.'},
        {id:'budget',title:'Budgets & usage',category:'Workspace',keywords:['budget','budgets','usage','cost','token usage','spend','spending','limit','limits','activity trail'],quick:'REACH Studio includes budgeting and activity surfaces to help keep usage visible. Provider billing and limits still come from the provider you configured.',steps:['Review the Studio Budgeting settings.','Know the provider/model pricing or local-resource cost.','Keep context scoped to reduce unnecessary usage.','Review activity when an agent or long task runs.'],example:'Example: use a smaller context and a focused model for routine edits, then reserve heavier runs for tasks that need them.'},
        {id:'docs',title:'Documentation',category:'Start',keywords:['docs','documentation','guide','manual','readme','instructions','how to use','help page'],quick:'Use the Docs page for quick start, Studio, endpoints, VS Code, security, and troubleshooting. The repository README and component guides contain the implementation details.',steps:['Open Docs from the top navigation.','Choose the guide matching your current surface.','Use the endpoint guide for connection issues.','Use Troubleshooting when setup works but requests fail.'],example:'Example: endpoint problems → Docs → Connect an endpoint → Troubleshooting.'},
        {id:'integrations',title:'Integrations',category:'Workspace',keywords:['integration','integrations','provider','providers','connect provider','compatible services','service support'],quick:'The Integrations page lists known compatible surfaces and setup guidance. Compatibility does not mean the static website connects accounts or stores credentials.',steps:['Open Integrations.','Filter or search for the provider/surface you need.','Read its setup requirements.','Configure credentials in the actual application, not the website demo.'],example:'Example: find an OpenAI-compatible provider, then use its documented base URL and key in REACH connection settings.'},
        {id:'commands',title:'Demo commands',category:'Demo',keywords:['slash command','commands','demo commands','help command','topic list','clear chat'],quick:'This homepage demo understands /help, /topics, /quick, /steps, /example, and /clear. These commands only control the local heuristic demo.',steps:['Type /topics to see the available demo areas.','Use /steps or /example to change response style.','Ask a feature question.','Use /clear to remove demo messages added during this visit.'],example:'Example: /steps, then “connect a local model”.'},
        {id:'updates',title:'Updates & versions',category:'Start',keywords:['update','upgrade','version','new version','latest version','release','changelog'],quick:'Use the repository releases/changelog and component documentation to understand version changes. Re-run the documented build/install workflow when updating source-based installs.',steps:['Review the changelog or release notes.','Pull or download the intended version.','Reinstall dependencies only as documented.','Run tests or launch checks before replacing a working setup.'],example:'Example: review the changelog first so you know whether an update changes configuration, dependencies, or migration steps.'}
      ];

      let demoMode = 'quick';
      let demoLastTopic = 'overview';
      let demoRun = 0;
      const normalizeDemo = value => String(value || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9./+# -]+/g,' ').replace(/\s+/g,' ').trim();
      const demoDistance = (a,b) => {
        if (a === b) return 0;
        if (!a || !b) return Math.max(a.length,b.length);
        const prev = Array.from({length:b.length+1},(_,i)=>i);
        for (let i=1;i<=a.length;i++) {
          let diag=prev[0]; prev[0]=i;
          for (let j=1;j<=b.length;j++) {
            const old=prev[j];
            prev[j]=Math.min(prev[j]+1,prev[j-1]+1,diag+(a[i-1]===b[j-1]?0:1));
            diag=old;
          }
        }
        return prev[b.length];
      };
      const demoMatch = raw => {
        const q = normalizeDemo(raw);
        const words = q.split(' ').filter(Boolean);
        const errorish = /\b(error|fail|failed|broken|not working|401|403|404|refused|cors|missing|unavailable)\b/.test(q);
        let best = DEMO_TOPICS[0], bestScore = -1, secondScore = -1;
        for (const topic of DEMO_TOPICS) {
          let score = 0;
          for (const kwRaw of topic.keywords) {
            const kw = normalizeDemo(kwRaw);
            if (!kw) continue;
            if (q === kw) score += 18;
            else if (q.includes(kw)) score += 9 + Math.min(4,kw.split(' ').length);
            const kwWords = kw.split(' ');
            for (const w of words) {
              for (const k of kwWords) {
                if (w === k && w.length > 2) score += 2.1;
                else if (w.length >= 4 && k.length >= 4) {
                  const d = demoDistance(w,k);
                  if (d === 1) score += 1.25;
                  else if (d === 2 && Math.max(w.length,k.length) >= 7) score += .45;
                }
              }
            }
          }
          if (errorish && topic.category === 'Troubleshoot') score += 2.5;
          if (score > bestScore) { secondScore=bestScore; bestScore=score; best=topic; }
          else if (score > secondScore) secondScore=score;
        }
        return {topic:best,score:bestScore,confidence:bestScore>=14?'high':bestScore>=7?'medium':'low',ambiguous:bestScore>0 && bestScore-secondScore<1.4};
      };
      const demoTopic = id => DEMO_TOPICS.find(t=>t.id===id) || DEMO_TOPICS[0];
      const demoAnswer = (topic,mode) => {
        if (mode === 'steps') return topic.title + '\n\n' + topic.steps.map((s,i)=>(i+1)+'. '+s).join('\n');
        if (mode === 'example') return topic.title + '\n\n' + topic.example;
        return topic.quick;
      };
      const demoSetMode = mode => {
        if (!['quick','steps','example'].includes(mode)) return;
        demoMode=mode;
        $$('#demo-tools [data-demo-mode]').forEach(btn=>{
          const active=btn.dataset.demoMode===mode;
          btn.classList.toggle('active',active);
          btn.setAttribute('aria-pressed',String(active));
        });
      };
      const demoAppendUser = text => {
        const node=document.createElement('div');
        node.className='chat-user'; node.dataset.demoDynamic='true'; node.textContent=text; demoLog.append(node);
      };
      const demoAppendWho = (label='Heuristic demo') => {
        const who=document.createElement('div');
        who.className='chat-who'; who.dataset.demoDynamic='true';
        who.innerHTML='<span class="brand-mark">'+icon('mark')+'</span>REACH <span class="muted">· '+label+'</span>';
        demoLog.append(who);
      };
      const demoAppendMessage = () => {
        const p=document.createElement('p');
        p.className='chat-message demo-rich'; p.dataset.demoDynamic='true'; demoLog.append(p); return p;
      };
      const demoFinish = (run,response,topic,confidence) => {
        if (run!==demoRun) return;
        const meta=document.createElement('div');
        meta.className='demo-response-meta'; meta.dataset.demoDynamic='true';
        meta.textContent='Matched: '+topic.title+' · '+demoMode+' · '+confidence+' confidence';
        demoLog.append(meta);
        const follow=document.createElement('div');
        follow.className='demo-followups'; follow.dataset.demoDynamic='true';
        follow.innerHTML='<button type="button" data-demo-follow="steps">Step by step</button><button type="button" data-demo-follow="example">Show example</button><button type="button" data-demo-related="'+topic.category+'">Related topics</button>';
        demoLog.append(follow);
        $('#demo-form button[type="submit"]')?.removeAttribute('disabled');
        demoLog.setAttribute('aria-busy','false');
        demoInput.focus({preventScroll:true});
        demoLog.scrollTop=demoLog.scrollHeight;
      };
      const demoRenderTopics = (category='',query='') => {
        const grid=$('#demo-topic-grid'); if(!grid)return;
        const q=normalizeDemo(query);
        const topics=DEMO_TOPICS.filter(t=>(!category||t.category===category)&&(!q||normalizeDemo(t.title+' '+t.keywords.join(' ')).includes(q)));
        grid.innerHTML=topics.map(t=>'<button type="button" class="demo-topic-button" data-demo-topic="'+t.id+'"><strong>'+t.title+'</strong><span>'+t.category+'</span></button>').join('') || '<p class="muted">No demo topics match that search.</p>';
        const count=$('#demo-topic-count'); if(count)count.textContent=topics.length+' topic'+(topics.length===1?'':'s');
      };
      const demoShowRelated = category => {
        const matches=DEMO_TOPICS.filter(t=>t.category===category).slice(0,8);
        demoAppendWho('Related topics');
        const response=demoAppendMessage();
        response.textContent=matches.map(t=>'• '+t.title).join('\n');
        demoLog.scrollTop=demoLog.scrollHeight;
      };
      const demoClear = () => {
        demoRun++;
        $$('[data-demo-dynamic]',demoLog).forEach(n=>n.remove());
        demoLastTopic='overview';
        demoSetMode('quick');
        demoLog.removeAttribute('aria-busy');
        $('#demo-form button[type="submit"]')?.removeAttribute('disabled');
        demoInput.value='';
        demoInput.focus({preventScroll:true});
      };
      const demoRespond = raw => {
        const text=String(raw||'').trim(); if(!text)return;
        const cmd=normalizeDemo(text);
        if (cmd==='/clear') { demoClear(); return; }
        if (cmd==='/quick') { demoSetMode('quick'); demoAppendWho('Demo command'); const r=demoAppendMessage(); r.textContent='Response style set to Quick answer.'; return; }
        if (cmd==='/steps') { demoSetMode('steps'); demoAppendWho('Demo command'); const r=demoAppendMessage(); r.textContent='Response style set to Step by step.'; return; }
        if (cmd==='/example') {
          demoSetMode('example');
          const topic=demoTopic(demoLastTopic); demoAppendUser(text); demoAppendWho();
          const r=demoAppendMessage(); r.textContent=demoAnswer(topic,'example');
          const meta=document.createElement('div'); meta.className='demo-response-meta'; meta.dataset.demoDynamic='true'; meta.textContent='Matched: '+topic.title+' · example'; demoLog.append(meta); return;
        }
        if (cmd==='/help') {
          demoAppendUser(text); demoAppendWho('Demo commands'); const r=demoAppendMessage();
          r.textContent='Try /topics, /quick, /steps, /example, or /clear. You can also ask about setup, models, endpoints, local AI, Studio, VS Code, agents, project context, coding, Git, themes, privacy, security, CORS, localhost, authentication, performance, budgets, docs, or integrations.';
          return;
        }
        if (cmd==='/topics') {
          demoAppendUser(text); demoAppendWho('Topic index'); const r=demoAppendMessage();
          const cats=[...new Set(DEMO_TOPICS.map(t=>t.category))];
          r.textContent=cats.map(c=>c+': '+DEMO_TOPICS.filter(t=>t.category===c).map(t=>t.title).join(', ')).join('\n\n');
          return;
        }

        let mode=demoMode;
        const followMore=/^(more|tell me more|explain more|details|why|go deeper|continue)\??$/.test(cmd);
        const wantsExample=/\b(example|show me an example|give me an example)\b/.test(cmd);
        const wantsSteps=/\b(step by step|steps|walk me through|how do i|how can i)\b/.test(cmd);
        let match=followMore ? {topic:demoTopic(demoLastTopic),confidence:'context',ambiguous:false} : demoMatch(text);
        if (wantsExample) mode='example'; else if (wantsSteps) mode='steps';
        if (match.confidence==='low' && !followMore) match.topic=demoTopic('overview');
        demoLastTopic=match.topic.id;

        demoAppendUser(text);
        demoAppendWho(match.confidence==='low'?'Heuristic fallback':'Heuristic demo');
        const response=demoAppendMessage();
        let answer=demoAnswer(match.topic,mode);
        if (match.confidence==='low') answer='I could not match that strongly to one demo topic. '+answer+'\n\nTry /topics or browse the topic list below for a more specific answer.';
        else if (match.ambiguous) answer+=' \n\nThat prompt could fit more than one area; add a detail like “endpoint”, “Studio”, “VS Code”, “agent team”, or the exact error for a tighter match.';
        demoInput.value='';
        const send=$('#demo-form button[type="submit"]'); if(send)send.disabled=true;
        demoLog.setAttribute('aria-busy','true');
        const run=++demoRun;
        const words=answer.split(' '); let index=0;
        const finish=()=>demoFinish(run,response,match.topic,match.confidence);
        if(!motionEnabled()){response.textContent=answer;finish();return;}
        const tick=()=>{
          if(run!==demoRun)return;
          response.textContent=words.slice(0,++index).join(' ');
          demoLog.scrollTop=demoLog.scrollHeight;
          if(index<words.length)later(tick,18); else finish();
        };
        tick();
      };

      if (!$('#demo-tools')) {
        const style=document.createElement('style');
        style.id='demo-tools-style';
        style.textContent='.demo-tools{border-top:1px solid var(--border);padding:12px 14px;display:grid;gap:10px;background:color-mix(in srgb,var(--surface) 92%,transparent)}.demo-toolbar,.demo-suggestions,.demo-followups{display:flex;flex-wrap:wrap;gap:7px;align-items:center}.demo-toolbar button,.demo-suggestions button,.demo-followups button,.demo-topic-button{font:inherit;color:var(--text);background:var(--surface-2,var(--surface));border:1px solid var(--border);border-radius:999px;padding:7px 10px;cursor:pointer}.demo-toolbar button:hover,.demo-suggestions button:hover,.demo-followups button:hover,.demo-topic-button:hover,.demo-toolbar button.active{border-color:var(--gold);color:var(--gold)}.demo-toolbar .demo-stop{margin-left:auto}.demo-topic-browser{border:1px solid var(--border);border-radius:12px;padding:9px 10px}.demo-topic-browser summary{cursor:pointer;color:var(--muted);font-size:13px}.demo-topic-controls{display:grid;grid-template-columns:1fr auto;gap:8px;margin:10px 0}.demo-topic-controls input,.demo-topic-controls select{min-width:0;background:var(--surface);color:var(--text);border:1px solid var(--border);border-radius:8px;padding:8px}.demo-topic-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:7px;max-height:210px;overflow:auto}.demo-topic-button{text-align:left;border-radius:10px;display:grid;gap:2px}.demo-topic-button span,.demo-response-meta{font-size:11px;color:var(--muted)}.demo-rich{white-space:pre-line}.demo-response-meta{margin:-4px 0 8px}.demo-followups{margin:0 0 12px}.demo-followups button{font-size:12px;padding:5px 8px}@media(max-width:620px){.demo-topic-grid{grid-template-columns:1fr}.demo-toolbar .demo-stop{margin-left:0}}';
        document.head.append(style);
        const tools=document.createElement('div');
        tools.className='demo-tools'; tools.id='demo-tools';
        tools.innerHTML='<div class="demo-toolbar" role="group" aria-label="Demo response style"><span class="muted">Answer:</span><button type="button" class="active" data-demo-mode="quick" aria-pressed="true">Quick</button><button type="button" data-demo-mode="steps" aria-pressed="false">Step by step</button><button type="button" data-demo-mode="example" aria-pressed="false">Example</button><button type="button" class="demo-stop" data-demo-stop>Stop</button></div><div class="demo-suggestions" aria-label="Suggested demo questions"><button type="button" data-demo-ask="How do I connect a local model?">Connect a model</button><button type="button" data-demo-ask="How do agent teams work?">Agent teams</button><button type="button" data-demo-ask="What project context should I use?">Project context</button><button type="button" data-demo-ask="Why is my localhost endpoint not working?">Fix connection</button><button type="button" data-demo-ask="How does the theme work?">Theme</button></div><details class="demo-topic-browser"><summary>Browse <span id="demo-topic-count">'+DEMO_TOPICS.length+' topics</span> · local heuristic demo</summary><div class="demo-topic-controls"><input id="demo-topic-search" type="search" placeholder="Search demo topics" aria-label="Search demo topics"><select id="demo-topic-category" aria-label="Filter demo topics"><option value="">All categories</option>'+[...new Set(DEMO_TOPICS.map(t=>t.category))].map(c=>'<option>'+c+'</option>').join('')+'</select></div><div class="demo-topic-grid" id="demo-topic-grid"></div></details>';
        demoForm.before(tools);
        demoRenderTopics();
        on(tools,'click',e=>{
          const target=e.target instanceof Element?e.target.closest('button'):null; if(!target)return;
          if(target.dataset.demoMode){demoSetMode(target.dataset.demoMode);return;}
          if(target.hasAttribute('data-demo-stop')){demoRun++;demoLog.removeAttribute('aria-busy');$('#demo-form button[type="submit"]')?.removeAttribute('disabled');return;}
          if(target.dataset.demoAsk){demoInput.value=target.dataset.demoAsk;demoRespond(target.dataset.demoAsk);return;}
          if(target.dataset.demoTopic){const topic=demoTopic(target.dataset.demoTopic);demoInput.value=topic.title;demoRespond(topic.title);return;}
        });
        on($('#demo-topic-search'),'input',e=>demoRenderTopics($('#demo-topic-category')?.value||'',e.target.value));
        on($('#demo-topic-category'),'change',e=>demoRenderTopics(e.target.value,$('#demo-topic-search')?.value||''));
      }

      on(demoLog,'click',e=>{
        const target=e.target instanceof Element?e.target.closest('button'):null; if(!target)return;
        if(target.dataset.demoFollow){
          demoSetMode(target.dataset.demoFollow);
          const topic=demoTopic(demoLastTopic);
          demoRespond(topic.title);
          return;
        }
        if(target.dataset.demoRelated){demoShowRelated(target.dataset.demoRelated);}
      });
      on(demoForm,'submit',e=>{e.preventDefault();demoRespond(demoInput.value);});
    }
  }
  window.SignalREACH = {init, destroy:()=>dispose()};
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init,{once:true});else init();
})();
