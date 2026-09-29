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


    let demoLastIntent = 'overview';
    const demoKnowledge = [
      {id:'overview',keys:['what can reach do','what is reach','signalreach','features','capabilities','overview','help'],quick:"REACH brings project files, AI conversations, model connections, custom personas, and agent teams into one connected workspace.",steps:"Start by opening a project, connecting an OpenAI-compatible endpoint, choosing a model, adding only the context you need, and reviewing the result before applying changes.",example:"Try asking: How do I connect a local model? How do agent teams work? Or why is localhost not connecting?"},
      {id:'install',keys:['install','installation','setup','set up','get started','getting started','start reach','launch reach','prerequisite','node 24','npm ci','instal','instll'],quick:"Start with Git and Node.js 24 LTS, then follow the Studio or VS Code setup guide for the surface you want to use.",steps:"Install Git and Node.js 24 LTS, clone SignalREACH, follow the Studio or extension README, then configure your endpoint and model inside the app.",example:"Example path: clone the repo, open the Studio guide, install dependencies, start Studio, then add your endpoint in Settings."},
      {id:'endpoint',keys:['endpoint','connect','connection','base url','baseurl','server url','host url','api endpoint','openai compatible','end point','conect','connnect','endpont'],quick:"Configure the complete endpoint base URL, the access key required by that host, and a model ID the endpoint actually exposes.",steps:"Start or obtain an OpenAI-compatible endpoint, copy its full base URL into REACH, add the required key, refresh the model list, and test with a small request.",example:"A local REACH relay commonly uses a URL shaped like http://127.0.0.1:20777/v1, but use the exact address your relay reports."},
      {id:'apikey',keys:['api key','apikey','access key','credential','credentials','secret','token','authentication','auth','bearer','api kye'],quick:"Treat API keys as secrets and store them in supported application or credential storage, never in public source files, screenshots, or demo prompts.",steps:"Get the key from the provider, enter it in REACH connection settings, test the connection, and rotate it immediately if it is ever exposed.",example:"Example header shape: Authorization: Bearer YOUR_REACH_KEY. Keep the real value private."},
      {id:'model',keys:['model','models','choose model','select model','model id','available models','which model','modle','moddel'],quick:"REACH uses the models exposed by your configured endpoint. Choose an exact model ID returned by that host rather than guessing a name.",steps:"Connect the endpoint, refresh its model catalog, choose a model that fits the task, then test it with a small prompt.",example:"If your local server exposes a coding model and a general model, use the exact IDs shown by that server."},
      {id:'missingmodel',keys:['model missing','missing model','model not found','404 model','unknown model','no models','empty model list','model unavailable'],quick:"If a model is missing, refresh the catalog from the configured endpoint and use an exact ID it actually exposes.",steps:"Verify the endpoint, inspect its model list, confirm the model is loaded or enabled, then use the exact returned ID.",example:"A local server may expose my-coder-model while a guessed provider-style name returns model-not-found."},
      {id:'localmodel',keys:['local model','ollama','lm studio','localhost model','local ai','offline model','local llm','run locally','local inference'],quick:"You can connect REACH to a local model server when it exposes a compatible API. Keep the server running and use its current local base URL.",steps:"Start the local server, enable its OpenAI-compatible API, copy the base URL into REACH, select a loaded model, and test before adding workspace context.",example:"LM Studio or another local server can work when its compatible API is enabled and reachable from the REACH client."},
      {id:'studio',keys:['studio','reach studio','desktop app','standalone','workspace app','electron','desktop workspace'],quick:"REACH Studio is the standalone workspace for project files, editing, AI conversations, custom personas, agent teams, connection settings, budgets, and activity.",steps:"Open a folder, configure an endpoint and default model, select relevant context, choose an assistant or team, then review the resulting work.",example:"Open a web project, select the component and stylesheet involved in a bug, and ask REACH to explain the issue before editing."},
      {id:'vscode',keys:['vscode','vs code','visual studio code','extension','editor extension','reach extension','code editor'],quick:"The VS Code extension keeps REACH chat beside your code with provider and model selection, file or image context, and workspace-aware controls.",steps:"Load the extension, configure a provider and model, open your project, attach only the files needed, and review edits before applying them.",example:"Attach app.js and styles.css, ask for one focused UI change, then inspect the proposed patch."},
      {id:'project',keys:['project','folder','open folder','workspace','project folder','new project','existing project','workspce'],quick:"Open the actual project folder you want REACH to work with so context and proposed changes stay bounded and relevant.",steps:"Choose the project root, confirm it is correct, select only task-relevant files, and ask for a plan before broad edits.",example:"For a React bug, open the app repository rather than your whole drive, then select the component, hook, and stylesheet involved."},
      {id:'context',keys:['context','workspace context','project context','add context','selected context','context window','file context','relevant files','contex','cntxt'],quick:"Good context is specific context. Give REACH only the files, snippets, errors, and constraints needed for the current task.",steps:"State the task, select the smallest relevant file set, include exact errors or constraints, and refresh context when the task moves elsewhere.",example:"For a failing login form, include the form component, auth client, route handler, and exact error instead of unrelated assets."},
      {id:'agent',keys:['agent','agents','agent mode','coding agent','assistant agent','run agent','agnet','agnt'],quick:"Agents are best for multi-step work. Give them a clear outcome, bounded context, and permissions you are comfortable reviewing.",steps:"Define the outcome, provide focused context, review tool permissions, inspect the plan, then verify the resulting changes.",example:"Try: inspect these files, identify why the test fails, propose a minimal patch, and show me the diff before applying it."},
      {id:'teams',keys:['agent team','agent teams','multi agent','multiple agents','collaborating agents','team agents','agent crew','team'],quick:"REACH Studio can organize collaborating agent roles so planning, implementation, and review can be separated.",steps:"Create focused roles, give them a shared outcome, let planning break down the work, keep implementation scoped, and use a review role before acceptance.",example:"A simple team could be Planner, Frontend implementer, then Test reviewer."},
      {id:'persona',keys:['persona','personas','custom persona','specialist','assistant role','role','roles','pesona'],quick:"Custom personas shape an assistant around a repeatable job such as reviewer, debugger, documentation writer, or frontend specialist.",steps:"Name the role, define its responsibility, add constraints, test it on a small task, then refine the instructions.",example:"Example: Frontend reviewer. Prioritize accessibility and responsive behavior, and explain uncertainty instead of guessing."},
      {id:'coding',keys:['code','coding','programming','build feature','implement','refactor','function','javascript','python','typescript','react','html','css'],quick:"Use REACH for explanation, implementation, refactoring, and review, while keeping the requested change scoped and verifiable.",steps:"Describe the target behavior, provide relevant code and constraints, ask for a minimal plan when risky, review the diff, then run validation.",example:"Try: add keyboard navigation to this tab component without changing its public API, then show the patch and tests."},
      {id:'debug',keys:['debug','error','exception','stack trace','bug','broken','not working','fails','failure','crash','traceback','fix error'],quick:"For debugging, give REACH the exact error, the action that triggers it, and the smallest set of relevant files.",steps:"Copy the exact error, explain how to reproduce it, include the relevant code or config, mention recent changes, then test the smallest likely fix first.",example:"Try: npm start fails with this stack trace after I changed vite.config.js; here are the config and package files."},
      {id:'git',keys:['git','github','commit','push','pull','branch','merge','diff','repo status','repository status'],quick:"For Git work, review the working tree and diff before committing or pushing so unrelated changes do not get bundled together.",steps:"Check status, inspect the diff, run relevant tests, write a focused commit message, push to the intended branch, and verify the remote commit.",example:"Try: show me what changed in these website files and prepare one focused commit."},
      {id:'terminal',keys:['terminal','shell','command','commands','cli','powershell','bash','cmd','run command','console'],quick:"Use terminal actions deliberately: confirm the working directory, understand the command, and inspect output before chaining destructive steps.",steps:"Start with read-only inspection, run the narrowest command that tests your assumption, then review output before modifying or deleting anything.",example:"Check git status and run the project test command before committing a code change."},
      {id:'browser',keys:['browser','web','research','web search','reader','chromium','browse','website research'],quick:"SignalREACH includes browser and research surfaces for public web work alongside your project. Keep source links with evidence you add to context.",steps:"Open the documented Browser or Reader surface, navigate to the source, capture only relevant evidence, and preserve the source link.",example:"Look up current library documentation, save the relevant API section with its source, then compare it with your project code."},
      {id:'theme',keys:['theme','color','colors','design','gold','charcoal','palette','style','appearance','brand','branding','dark mode','light mode','switch theme'],quick:"SignalREACH keeps its charcoal-and-gold identity in dark mode and a warm ivory-and-gold interpretation in light mode.",steps:"Use the theme toggle, check contrast in both themes, keep gold as the accent, and use the separate motion control if you want fewer animations.",example:"Dark mode uses deep charcoal surfaces with gold accents; light mode uses warm ivory surfaces with the same gold identity."},
      {id:'privacy',keys:['privacy','private','data','retention','telemetry','analytics','tracking','store prompts','conversation data'],quick:"This website demo does not send your demo prompt to a model. In the actual app, the configured provider receives the request and context needed to answer.",steps:"Know which provider is selected, send only required context, review its processing and retention policies, and keep secrets out of prompts.",example:"The homepage heuristic stays in the page; a real configured model request follows the policies of the endpoint you choose."},
      {id:'security',keys:['security','secure','safe','credential storage','vault','keychain','security policy','securty'],quick:"Keep credentials in supported secret storage, review agent and tool permissions, and do not make private endpoints public just to bypass a connection problem.",steps:"Read the repository security policy, use supported credential storage, review permissions before runs, and rotate exposed credentials immediately.",example:"If authentication fails, fix the key or host policy rather than removing authentication from a private endpoint."},
      {id:'cors',keys:['cors','cross origin','blocked by cors','origin','preflight','browser blocked','access control allow origin','cors error'],quick:"A browser client can be blocked by CORS even when the endpoint is healthy. Configure CORS on the endpoint or proxy rather than disabling browser security.",steps:"Confirm the endpoint works from a trusted client, inspect the browser error, allow the intended origin and headers on the endpoint, then retest the preflight.",example:"An OPTIONS preflight can fail before the chat request is sent; the browser console usually identifies the missing permission."},
      {id:'localhost',keys:['localhost','127.0.0.1','local host','connection refused','refused','port','cant connect localhost','local server'],quick:"localhost means the machine running the client. If REACH and the model server are on different computers, 127.0.0.1 points to the wrong machine.",steps:"Confirm the server is running, verify its port and base path, test it locally, and use a properly secured reachable address if the client is on another machine.",example:"http://127.0.0.1:20777 works only when the REACH client can reach a relay on its own local machine at that port."},
      {id:'auth',keys:['401','403','unauthorized','forbidden','auth error','authentication error','access denied','invalid key','bad key','key rejected'],quick:"401 or 403 errors usually point to credentials or host access policy. Recheck the selected endpoint and key before changing model settings.",steps:"Verify the URL matches the key, re-enter or rotate the key, check host permissions, then retry a minimal request.",example:"A key for one provider will not authenticate against a different endpoint even if both use OpenAI-compatible request shapes."},
      {id:'performance',keys:['performance','slow','lag','laggy','speed','memory','cpu','high cpu','freeze','frozen','performance issue'],quick:"If REACH feels slow, isolate whether the bottleneck is the model endpoint, context size, browser surface, or the local app itself.",steps:"Try a tiny prompt with minimal context, compare endpoint response time, reduce unnecessary attachments, close unused heavy surfaces, and inspect logs for retries.",example:"If a tiny prompt is fast but a workspace-wide prompt is slow, context size is a stronger suspect than the UI theme."},
      {id:'budget',keys:['budget','budgets','usage','cost','token usage','spend','spending','limit','limits','activity trail'],quick:"REACH Studio includes budgeting and activity surfaces to keep usage visible, while actual billing or limits still come from your configured provider.",steps:"Review Studio budgeting, understand provider and model costs, keep context scoped, and inspect activity for long agent runs.",example:"Use focused context for routine edits and reserve heavier runs for tasks that actually need them."},
      {id:'docs',keys:['docs','documentation','guide','manual','readme','instructions','how to use','help page'],quick:"The Docs page covers quick start, Studio, endpoints, VS Code, security, and troubleshooting.",steps:"Open Docs, choose the surface you are using, use the endpoint guide for connection setup, and switch to Troubleshooting when requests fail.",example:"Endpoint problem? Open Docs, then Connect an endpoint, then Troubleshooting."},
      {id:'integrations',keys:['integration','integrations','provider','providers','connect provider','compatible services','service support'],quick:"The Integrations page lists known compatible surfaces and setup guidance. The static website itself does not connect accounts or store credentials.",steps:"Open Integrations, search for the provider or surface, read its requirements, then configure credentials in the actual application.",example:"Find an OpenAI-compatible provider, then use its documented base URL and key in REACH connection settings."}
    ];
    const normalizeDemo=value=>String(value||'').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9./+# -]+/g,' ').replace(/\s+/g,' ').trim();
    const demoDistance=(a,b)=>{
      if(a===b)return 0;
      if(!a||!b)return Math.max(a.length,b.length);
      const row=Array.from({length:b.length+1},(_,i)=>i);
      for(let i=1;i<=a.length;i++){
        let diag=row[0];row[0]=i;
        for(let j=1;j<=b.length;j++){
          const old=row[j];
          row[j]=Math.min(row[j]+1,row[j-1]+1,diag+(a[i-1]===b[j-1]?0:1));
          diag=old;
        }
      }
      return row[b.length];
    };
    const findDemoIntent=raw=>{
      const q=normalizeDemo(raw),words=q.split(' ').filter(Boolean);
      let best=demoKnowledge[0],bestScore=0;
      for(const item of demoKnowledge){
        let score=0;
        for(const keyRaw of item.keys){
          const key=normalizeDemo(keyRaw);
          if(q===key)score+=18;
          else if(q.includes(key))score+=8+Math.min(4,key.split(' ').length);
          for(const w of words){
            for(const k of key.split(' ')){
              if(w===k&&w.length>2)score+=2;
              else if(w.length>=4&&k.length>=4&&demoDistance(w,k)===1)score+=1;
            }
          }
        }
        if(score>bestScore){bestScore=score;best=item;}
      }
      return bestScore>=4?best:demoKnowledge[0];
    };
    const getDemoIntent=id=>demoKnowledge.find(item=>item.id===id)||demoKnowledge[0];
    const formatDemoAnswer=(item,prompt)=>{
      const q=normalizeDemo(prompt);
      if(/\b(example|show me an example|give me an example)\b/.test(q))return item.example;
      if(/\b(step by step|steps|walk me through|how do i|how can i|what next)\b/.test(q))return item.steps;
      if(/^(more|tell me more|explain more|details|go deeper|continue)\??$/.test(q))return item.steps+' '+item.example;
      return item.quick;
    };
    on($('#demo-form'),'submit',e=>{
      e.preventDefault();
      const input=$('#demo-input'),text=input.value.trim();if(!text)return;
      const log=$('#demo-log'),button=$('#demo-form button');
      const command=normalizeDemo(text);
      if(command==='/clear'){
        $$('[data-demo-dynamic]',log).forEach(node=>node.remove());
        input.value='';input.focus({preventScroll:true});return;
      }
      const user=document.createElement('div');
      user.className='chat-user';user.dataset.demoDynamic='true';user.textContent=text;log.append(user);
      const who=document.createElement('div');
      who.className='chat-who';who.dataset.demoDynamic='true';
      who.innerHTML='<span class="brand-mark">'+icon('mark')+'</span>REACH <span class="muted">· Local heuristic demo</span>';
      log.append(who);
      const response=document.createElement('p');
      response.className='chat-message';response.dataset.demoDynamic='true';log.append(response);
      let answer;
      if(command==='/help'){
        answer='Ask about setup, endpoints, API keys, models, local AI, Studio, VS Code, project context, agents, agent teams, coding, debugging, Git, terminal use, research, themes, privacy, security, CORS, localhost, authentication, performance, budgets, docs, or integrations. Commands: /help, /topics, /clear.';
      }else if(command==='/topics'){
        answer='Try: connect a local model; set up REACH Studio; how do agent teams work; what project context should I use; debug an error; Git commit and push; CORS error; localhost refused; API key rejected; switch theme; or privacy and security.';
      }else{
        const contextual=/^(more|tell me more|explain more|details|go deeper|continue|what next)\??$/.test(command);
        const intent=contextual?getDemoIntent(demoLastIntent):findDemoIntent(text);
        demoLastIntent=intent.id;
        answer=formatDemoAnswer(intent,text);
        if(intent.id==='overview'&&!/what can reach|what is reach|signalreach|features|capabilities|overview/.test(command))answer+=' Try /topics for example questions.';
      }
      answer+=' This is a local website demo, not a live AI response.';
      input.value='';button.disabled=true;log.setAttribute('aria-busy','true');
      const words=answer.split(' ');let index=0;
      const finish=()=>{button.disabled=false;log.setAttribute('aria-busy','false');input.focus({preventScroll:true});log.scrollTop=log.scrollHeight;};
      if(!motionEnabled()){response.textContent=answer;finish();return;}
      const tick=()=>{response.textContent=words.slice(0,++index).join(' ');log.scrollTop=log.scrollHeight;if(index<words.length)later(tick,22);else finish();};
      tick();
    });
  }
  window.SignalREACH = {init, destroy:()=>dispose()};
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init,{once:true});else init();
})();
