/* DOM adapter for the local homepage guide. Curated strings and user input are
 * rendered with textContent. All listeners, timers and blob URLs have cleanup. */
(() => {
  'use strict';
  function mount({panel, icon, motionEnabled, toast, onTheme, onFile, onPreview, onTour}) {
    const engine = globalThis.SignalREACHChat;
    if (!panel || !engine) return () => {};
    const $ = selector => panel.querySelector(selector);
    const $$ = selector => [...panel.querySelectorAll(selector)];
    const log = $('#demo-log'), input = $('#demo-input'), form = $('#demo-form');
    if (!log || !input || !form) return () => {};
    const controller = new AbortController(), signal = controller.signal;
    const session = engine.createSession(), history = [], urls = new Set(), urlTimers = new Set();
    const suggestions = $('#demo-suggestions'), browser = $('#demo-topic-browser');
    const toggle = $('[data-chat-topics-toggle]'), mode = $('#demo-mode');
    const submit = $('[data-chat-send]'), stopButton = $('[data-chat-stop]'), status = $('#demo-status');
    let typingTimer = 0, generation = 0, busy = false, destroyed = false, composing = false;
    let activeFinish = null, turn = 0, selectedGroup = 'All', topicOpen = false;
    const on = (node, event, handler) => node?.addEventListener(event, handler, {signal});
    const horizontalWheel = event => {
      if (event.ctrlKey || event.metaKey) return;
      const target = event.target instanceof Element ? event.target : null;
      const rail = target?.closest('.chat-suggestions, .chat-reply-actions, .chat-topic-groups');
      if (!rail || rail.scrollWidth <= rail.clientWidth + 1) return;
      const delta = Math.abs(event.deltaY) >= Math.abs(event.deltaX) ? event.deltaY : event.deltaX;
      if (!delta) return;
      const max = rail.scrollWidth - rail.clientWidth;
      const atStart = rail.scrollLeft <= 0;
      const atEnd = rail.scrollLeft >= max - 1;
      event.preventDefault();
      if ((delta < 0 && atStart) || (delta > 0 && atEnd)) return;
      rail.scrollLeft = Math.max(0, Math.min(max, rail.scrollLeft + delta));
    };
    panel.addEventListener('wheel', horizontalWheel, {signal, passive:false});
    const element = (tag, className, text) => {
      const node = document.createElement(tag);
      if (className) node.className = className;
      if (text !== undefined) node.textContent = text;
      return node;
    };
    const button = (label, className = 'chat-chip') => {
      const node = element('button', className, label); node.type = 'button'; return node;
    };
    const resizeCounter = () => { $('#demo-length').textContent = `${input.value.length} / ${engine.maxInput}`; };
    const stickToBottom = () => { log.scrollTop = log.scrollHeight; };
    const nearBottom = () => log.scrollHeight - log.scrollTop - log.clientHeight < 70;
    function setBusy(value) {
      busy = value; submit.disabled = value; stopButton.hidden = !value;
      log.setAttribute('aria-busy', String(value));
      panel.classList.toggle('chat-is-busy', value);
      $$('[data-chat-topic], [data-chat-prompt]').forEach(node => { node.disabled = value; });
      status.textContent = value ? 'Preparing local reply…' : 'Local demo · No AI requests';
    }
    function closeTopics(focus = false) {
      topicOpen = false; browser.hidden = true; log.hidden = false; suggestions.hidden = false;
      toggle.setAttribute('aria-expanded','false');
      if (focus) toggle.focus();
    }
    function openTopics() {
      topicOpen = true; browser.hidden = false; log.hidden = true; suggestions.hidden = true;
      toggle.setAttribute('aria-expanded','true');
      renderTopics(); $('#demo-topic-search').focus();
    }
    function renderTopics() {
      const search = engine.normalize($('#demo-topic-search').value);
      const words = search.split(' ').filter(Boolean);
      const matches = engine.topics.filter(topic => (selectedGroup === 'All' || topic.group === selectedGroup)
        && words.every(word => engine.normalize(`${topic.label} ${topic.keywords.join(' ')}`).includes(word)));
      const list = $('#demo-topic-list'); list.replaceChildren();
      for (const topic of matches) {
        const choice = button(topic.label, 'chat-topic');
        choice.dataset.chatTopic = topic.id; choice.disabled = busy;
        const group = element('span', 'chat-topic-group', topic.group); choice.append(group);
        list.append(choice);
      }
      if (!matches.length) list.append(element('p','chat-topic-empty','No matching topics. Try another keyword or choose All.'));
      $('#demo-topic-count').textContent = `${matches.length} of ${engine.topics.length} topics`;
      $$('[data-chat-group]').forEach(node => node.setAttribute('aria-pressed',String(node.dataset.chatGroup === selectedGroup)));
    }
    function renderSuggestions(reply) {
      suggestions.replaceChildren();
      const choices = reply?.suggestions || ['install','website','endpoints','agents'].map(id => {
        const topic = engine.topics.find(item => item.id === id);
        return {id:topic.id, label:topic.label, prompt:topic.keywords[0]};
      });
      for (const choice of choices) {
        const chip = button(choice.label); chip.dataset.chatPrompt = choice.prompt;
        chip.dataset.chatIntent = choice.id; chip.disabled = busy; suggestions.append(chip);
      }
      if (reply?.matched) {
        for (const [label, prompt] of [['More detail','tell me more'],['Show example','show an example']]) {
          const chip = button(label, 'chat-chip chat-followup'); chip.dataset.chatPrompt = prompt;
          chip.disabled = busy; suggestions.append(chip);
        }
      }
    }
    function welcome() {
      log.replaceChildren();
      const card = element('div','chat-welcome');
      const who = element('div','chat-who');
      who.innerHTML = `<span class="brand-mark">${icon('mark')}</span> REACH <span class="muted">· Local guide</span>`;
      card.append(who, element('p','chat-message','What would you like to explore? Ask about the platform, build an idea, or work through a setup issue.'));
      card.append(element('div','chat-welcome-stat',`${engine.topics.length} topics · ${engine.keywordCount} keywords & phrases`));
      card.append(element('p','chat-welcome-tip','Try a topic below, then ask “tell me more” or “show an example”.'));
      log.append(card);
    }
    function reset() {
      generation++; clearTimeout(typingTimer); activeFinish = null;
      session.reset(); history.length = 0; turn = 0;
      input.value = ''; mode.value = 'quick'; selectedGroup = 'All'; $('#demo-topic-search').value = '';
      closeTopics(); setBusy(false); welcome(); renderSuggestions(); resizeCounter();
    }
    function addActions(container, reply, sourceId) {
      const actions = element('div','chat-reply-actions');
      const copy = button('Copy', 'chat-action'); copy.dataset.copy = sourceId;
      copy.setAttribute('aria-label','Copy this reply'); actions.append(copy);
      for (const key of reply.actions) {
        const action = engine.actions[key]; if (!action) continue;
        let node;
        if (action.href) {
          node = element('a','chat-action',action.label); node.href = action.href;
          if (action.href.startsWith('https://')) {
            node.target = '_blank'; node.rel = 'noopener noreferrer';
            node.setAttribute('aria-label',`${action.label} (opens in a new tab)`);
          }
        } else { node = button(action.label, 'chat-action'); node.dataset.chatAction = key; }
        actions.append(node);
      }
      container.append(actions);
    }
    function send(raw, intent = null) {
      if (busy || destroyed || composing) return;
      const text = String(raw ?? '').trim().slice(0,engine.maxInput);
      if (!text) return;
      const reply = session.reply(text, {intent, mode:mode.value}); if (!reply) return;
      input.value = ''; resizeCounter();
      if (reply.command) {
        if (reply.command === 'clear') { reset(); input.focus({preventScroll:true}); toast('Demo conversation cleared.'); }
        else if (reply.command === 'topics') openTopics();
        else if (reply.command === 'export') exportChat();
        return;
      }
      closeTopics(); log.querySelector('.chat-welcome')?.remove();
      const exchange = element('div','chat-turn');
      const user = element('div','chat-user'); user.textContent=text;
      const who = element('div','chat-who');
      who.innerHTML = `<span class="brand-mark">${icon('mark')}</span> REACH <span class="muted">· ${reply.contextual ? 'Follow-up' : 'Demo response'}</span>`;
      const body = element('div','chat-reply'); body.id = `demo-reply-${++turn}`;
      const title = element('p','chat-reply-title',reply.title), paragraph = element('p','chat-message');
      body.append(title,paragraph); exchange.append(user,who,body); log.append(exchange);
      while (log.querySelectorAll('.chat-turn').length > 24) log.querySelector('.chat-turn').remove();
      const mine = ++generation; setBusy(true); stickToBottom();
      const words = reply.text.split(' '); let shown = 0, finished = false;
      function finish(stopped = false) {
        if (finished || destroyed || mine !== generation) return;
        finished = true; clearTimeout(typingTimer); activeFinish = null;
        const pinned = nearBottom();
        if (stopped) paragraph.textContent = `${paragraph.textContent || 'Reply'} … [stopped]`;
        else {
          paragraph.textContent = reply.text;
          if (reply.steps.length) {
            const steps = element('ol','chat-steps');
            reply.steps.forEach(step => steps.append(element('li','',step))); body.append(steps);
          }
          if (reply.example) {
            const example = element('pre','chat-example'); example.append(element('code','',reply.example)); body.append(example);
          }
        }
        const transcript = stopped ? paragraph.textContent : [reply.title, reply.text,
          ...reply.steps.map((step,i) => `${i+1}. ${step}`), reply.example].filter(Boolean).join('\n\n');
        history.push({user:text, assistant:transcript}); if (history.length > 24) history.shift();
        addActions(exchange,reply,body.id);
        setBusy(false); renderSuggestions(reply);
        if (pinned) stickToBottom();
        if (document.activeElement === document.body && panel.isConnected && !topicOpen) input.focus({preventScroll:true});
        if (stopped) status.textContent = 'Stopped · No AI request was sent';
      }
      activeFinish = finish;
      if (!motionEnabled()) { finish(); return; }
      function tick() {
        if (destroyed || mine !== generation || finished) return;
        if (!motionEnabled()) { finish(); return; }
        const pinned = nearBottom();
        shown = Math.min(words.length, shown + 2); paragraph.textContent = words.slice(0,shown).join(' ');
        if (pinned) stickToBottom();
        if (shown >= words.length) finish(); else typingTimer = setTimeout(tick,32);
      }
      tick();
    }
    function exportChat() {
      if (busy) activeFinish?.(true);
      if (!history.length) { toast('Ask a question before exporting a conversation.'); return; }
      const text = ['SignalREACH — local website demo', 'Prepared heuristic replies; no live AI connection.', '',
        ...history.flatMap(item => [`YOU\n${item.user}`, `REACH\n${item.assistant}`, ''])].join('\n\n');
      const url = URL.createObjectURL(new Blob([text],{type:'text/plain;charset=utf-8'})); urls.add(url);
      const link = element('a'); link.href = url; link.download = 'SignalREACH-demo-chat.txt';
      document.body.append(link); link.click(); link.remove();
      const timer = setTimeout(() => { URL.revokeObjectURL(url); urls.delete(url); urlTimers.delete(timer); },1500);
      urlTimers.add(timer); toast('Conversation exported as a local text file.');
    }
    on(form,'submit',event => { event.preventDefault(); send(input.value); });
    on(input,'input',resizeCounter);
    on(input,'compositionstart',() => { composing = true; });
    on(input,'compositionend',() => { composing = false; });
    on(panel,'keydown',event => {
      if (event.key !== 'Escape') return;
      if (topicOpen) { event.preventDefault(); closeTopics(true); }
      else if (busy) { event.preventDefault(); activeFinish?.(true); }
    });
    on($('#demo-topic-search'),'input',renderTopics);
    on(panel,'click',event => {
      const target = event.target instanceof Element ? event.target : null; if (!target) return;
      if (target.closest('[data-chat-topics-toggle]')) { topicOpen ? closeTopics(true) : openTopics(); return; }
      if (target.closest('[data-chat-reset]')) { reset(); input.focus({preventScroll:true}); toast('Demo conversation cleared.'); return; }
      if (target.closest('[data-chat-export]')) { exportChat(); return; }
      if (target.closest('[data-chat-stop]')) { activeFinish?.(true); return; }
      const group = target.closest('[data-chat-group]');
      if (group) { selectedGroup = group.dataset.chatGroup; renderTopics(); return; }
      const topic = target.closest('[data-chat-topic]');
      if (topic) { const item = engine.topics.find(entry => entry.id === topic.dataset.chatTopic); if (item) send(item.label,item.id); return; }
      const prompt = target.closest('[data-chat-prompt]');
      if (prompt) { send(prompt.dataset.chatPrompt,prompt.dataset.chatIntent); return; }
      const actionButton = target.closest('[data-chat-action]');
      if (!actionButton) return;
      const action = engine.actions[actionButton.dataset.chatAction]; if (!action) return;
      if (action.kind === 'theme') onTheme(action.value);
      else if (action.kind === 'file') { onFile(action.value); toast(`Showing the sample ${action.value} file. No computer files were accessed.`); }
      else if (action.kind === 'preview') onPreview(action.value);
      else if (action.kind === 'tour') onTour();
      else if (action.kind === 'topics') openTopics();
    });
    const groups = ['All',...new Set(engine.topics.map(topic => topic.group))];
    for (const name of groups) { const choice = button(name,'chat-group'); choice.dataset.chatGroup = name; choice.setAttribute('aria-pressed',String(name === 'All')); $('#demo-topic-groups').append(choice); }
    reset(); renderTopics(); panel.dataset.chatReady = 'true';
    return () => {
      destroyed = true; generation++; controller.abort(); clearTimeout(typingTimer); activeFinish = null;
      urlTimers.forEach(clearTimeout); urls.forEach(url => URL.revokeObjectURL(url));
      history.length = 0; session.reset(); delete panel.dataset.chatReady;
    };
  }
  globalThis.SignalREACHChatUI = Object.freeze({mount});
})();
