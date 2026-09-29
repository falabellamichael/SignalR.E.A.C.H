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

    on($('#demo-form'),'submit',e=>{
      e.preventDefault();const input=$('#demo-input');const text=input.value.trim();if(!text)return;
      const log=$('#demo-log');const button=$('#demo-form button');const user=document.createElement('div');user.className='chat-user';user.textContent=text;log.append(user);
      const who=document.createElement('div');who.className='chat-who';who.innerHTML=`<span class="brand-mark">${icon('mark')}</span>REACH <span class="muted">· Demo response</span>`;log.append(who);
      const response=document.createElement('p');response.className='chat-message';log.append(response);
      const prompt=text.toLowerCase();let answer;
      if(/theme|color|design/.test(prompt))answer='The signature charcoal and gold stay at the center of this design. Use the theme switch above to explore the lighter side. This is a scripted website demo, not a live AI response.';
      else if(/model|endpoint|connect/.test(prompt))answer='In the real app, configure your endpoint, access key, and default model in Settings. Your host determines the models you can use. Open the connection guide for setup; this demo is not connected to an AI endpoint.';
      else if(/agent|team/.test(prompt))answer='REACH Studio supports custom personas and collaborating agent teams. Explore the Agent teams tab for a sample role map, then use the Studio guide to configure the actual workspace.';
      else answer='REACH brings project files, AI conversations, personas, and agent teams into a connected workspace. Choose the Platform page to explore each surface, or Get started for setup. This response is a local, scripted demo.';
      input.value='';button.disabled=true;log.setAttribute('aria-busy','true');
      const words=answer.split(' ');let index=0;
      const finish=()=>{button.disabled=false;log.setAttribute('aria-busy','false');input.focus({preventScroll:true});log.scrollTop=log.scrollHeight;};
      if(!motionEnabled()){response.textContent=answer;finish();return;}
      const tick=()=>{response.textContent=words.slice(0,++index).join(' ');log.scrollTop=log.scrollHeight;if(index<words.length)later(tick,26);else finish();};tick();
    });
  }
  window.SignalREACH = {init, destroy:()=>dispose()};
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init,{once:true});else init();
})();
