/* Transcript controls: thought previews, message actions, pins, speech, and adaptive trays.
 * Factories defer DOM work until app.js reaches the transcript initialization.
 * Dependencies are supplied by the renderer; this module does not read app state.
 */
(function expose(factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.ReachMessageActions = api;
})(function buildReachMessageActions() {
  function create({
    window, document, localStorage, chatLog, chatScroll, composerInput, reachApi,
    showNotice, confirmAction, escapeHtml, openTranslatePopover, messageResendBusy,
    getCurrentAgent, setComposerIntentPending, setAgentRunning, updateSendControl,
    appendChatMessage, updateStatusPill, loadAgentTree, renderTodos,
  }) {
    const { navigator, ResizeObserver, SpeechSynthesisUtterance, Event, Blob, URL } = window;
    const requestAnimationFrame = callback => window.requestAnimationFrame(callback);
    const getComputedStyle = element => window.getComputedStyle(element);

    let dismissThoughtPreview = null;
    function attachThoughtPreview(button, text) {
      let preview = null;
      let hideTimer = null;
      let overButton = false;
      let overPreview = false;
      let resizeObserver = null;

      const place = () => {
        if (!preview?.isConnected) return;
        const anchor = button.getBoundingClientRect();
        const scroll = chatScroll.getBoundingClientRect();
        if (anchor.bottom < scroll.top || anchor.top > scroll.bottom) { hide(); return; }

        const leftEdge = Math.max(12, scroll.left + 8);
        const rightEdge = Math.min(window.innerWidth - 12, scroll.right - 8);
        const width = Math.min(420, rightEdge - leftEdge);
        if (width < 80) { hide(); return; }
        preview.style.width = `${width}px`;
        preview.style.maxHeight = '480px';
        const desiredHeight = preview.getBoundingClientRect().height;
        const gap = 6;
        const above = Math.max(0, anchor.top - 12 - gap);
        const below = Math.max(0, window.innerHeight - 12 - anchor.bottom - gap);
        const showAbove = above >= desiredHeight || (below < desiredHeight && above >= below);
        preview.style.maxHeight = `${Math.min(480, showAbove ? above : below)}px`;
        const height = preview.getBoundingClientRect().height;
        const left = Math.max(leftEdge, Math.min(anchor.left, rightEdge - width));
        const top = showAbove ? anchor.top - gap - height : anchor.bottom + gap;
        preview.style.left = `${left}px`;
        preview.style.top = `${Math.max(12, Math.min(top, window.innerHeight - 12 - height))}px`;
        preview.style.visibility = 'visible';
      };
      const hide = () => {
        clearTimeout(hideTimer);
        preview?.remove();
        preview = null;
        resizeObserver?.disconnect();
        resizeObserver = null;
        chatScroll.removeEventListener('scroll', place);
        window.removeEventListener('scroll', place);
        window.removeEventListener('resize', place);
        if (dismissThoughtPreview === hide) dismissThoughtPreview = null;
      };
      const scheduleHide = () => {
        clearTimeout(hideTimer);
        hideTimer = setTimeout(() => {
          if (!overButton && !overPreview && document.activeElement !== button) hide();
        }, 120);
      };
      const show = () => {
        clearTimeout(hideTimer);
        if (preview) return place();
        dismissThoughtPreview?.();
        preview = document.createElement('div');
        preview.className = 'thought-hover-box';
        preview.setAttribute('role', 'tooltip');
        preview.textContent = text;
        preview.style.visibility = 'hidden';
        preview.addEventListener('mouseenter', () => { overPreview = true; clearTimeout(hideTimer); });
        preview.addEventListener('mouseleave', () => { overPreview = false; scheduleHide(); });
        document.body.appendChild(preview);
        dismissThoughtPreview = hide;
        chatScroll.addEventListener('scroll', place);
        window.addEventListener('scroll', place);
        window.addEventListener('resize', place);
        resizeObserver = new ResizeObserver(place);
        resizeObserver.observe(chatScroll);
        place();
      };
      button.addEventListener('mouseenter', () => { overButton = true; show(); });
      button.addEventListener('mouseleave', () => { overButton = false; scheduleHide(); });
      button.addEventListener('focus', show);
      button.addEventListener('blur', scheduleHide);
    }

    function appendThoughtIndicator(bubble, thought) {
      const text = String(thought || '').trim();
      if (!text || bubble.dataset.hasThought === 'true') return;
      bubble.dataset.hasThought = 'true';

      const detail = document.createElement('div');
      detail.className = 'thought-detail';
      detail.textContent = text;
      detail.hidden = true;

      const toggles = [];
      const makeToggle = () => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'thought-icon';
        button.textContent = '💭';
        button.setAttribute('aria-label', 'Show model reasoning');
        button.setAttribute('aria-expanded', 'false');
        attachThoughtPreview(button, text);
        toggles.push(button);
        return button;
      };
      const lead = document.createElement('span');
      lead.className = 'thought-lead';
      lead.append(makeToggle(), document.createTextNode('... '));
      const firstBlock = [...bubble.children].find(child => !child.classList.contains('msg-ts'));
      if (firstBlock?.tagName === 'P') firstBlock.prepend(lead);
      else bubble.insertBefore(lead, firstBlock || bubble.firstChild);

      const trail = document.createElement('span');
      trail.className = 'thought-trail';
      trail.append(document.createTextNode(' ...'), makeToggle());
      const timestamp = bubble.querySelector(':scope > .msg-ts');
      bubble.insertBefore(trail, timestamp);
      bubble.insertAdjacentElement('afterend', detail);

      const toggle = () => {
        detail.hidden = !detail.hidden;
        for (const button of toggles) button.setAttribute('aria-expanded', String(!detail.hidden));
      };
      for (const button of toggles) button.addEventListener('click', toggle);
    }

    function updateMessageActions() {
      const busy = messageResendBusy();
      for (const button of chatLog.querySelectorAll('.msg-resend')) {
        button.disabled = busy || !button.dataset.messageIndex || !button.dataset.messageKey;
      }
    }

    function messageActionIcon(action) {
      const shapes = {
        copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"/>',
        copied: '<path d="m5 12 4 4L19 6"/>',
        resend: '<path d="M3 10a9 9 0 1 1 2.6 8.4M3 4v6h6"/>',
        edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
        pin: '<path d="M9 4h6l1 7 3 3v2H5v-2l3-3Z"/><path d="M12 16v5"/>',
        pinned: '<path d="M9 4h6l1 7 3 3v2H5v-2l3-3Z"/><path d="M12 16v5"/><path d="m5 12 4 4L19 6"/>',
        save: '<path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2Z"/><path d="M17 21v-8H7v8M7 3v5h8"/>',
        export: '<path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M4 21h16"/>',
        speak: '<path d="M11 5 6 9H3v6h3l5 4Z"/><path d="M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13"/>',
        stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
        translate: '<path d="M4 5h9M8.5 3v2c0 4-2.5 7-5.5 8.5M5 9c1.5 2.5 4 4.5 7 5.5"/><path d="m12.5 21 4.5-10 4.5 10M14 17.5h6"/>',
        memory: '<path d="M12 3a7 7 0 0 1 7 7c0 2.5-1.5 4.5-3 6-.5 2-1.5 5-4 5-2.5 0-3.5-3-4-5-1.5-1.5-3-3.5-3-6a7 7 0 0 1 7-7Z"/><circle cx="12" cy="10" r="2.5"/>',
        task: '<path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>',
        more: '<circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/>',
      };
      return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${shapes[action] || shapes.more}</svg>`;
    }

    /* Pinned messages survive reloads (localStorage, per conversation). */
    function pinnedMessagesKey(agentId) { return 'reach:pinned:' + agentId; }
    function getPinnedMessages(agentId) {
      try { const raw = JSON.parse(localStorage.getItem(pinnedMessagesKey(agentId)) || '[]'); return Array.isArray(raw) ? raw : []; }
      catch { return []; }
    }
    function isMessagePinned(agentId, messageKey) {
      return !!messageKey && getPinnedMessages(agentId).some(p => p.key === messageKey);
    }
    function togglePinnedMessage(agentId, messageKey, text, role) {
      if (!messageKey) { showNotice('Message identity is unavailable. Refresh the conversation.'); return false; }
      let pinned = getPinnedMessages(agentId);
      if (pinned.some(p => p.key === messageKey)) pinned = pinned.filter(p => p.key !== messageKey);
      else pinned.push({ key: messageKey, text: String(text).slice(0, 4000), role, at: Date.now() });
      try { localStorage.setItem(pinnedMessagesKey(agentId), JSON.stringify(pinned.slice(-50))); } catch {}
      return pinned.some(p => p.key === messageKey);
    }

    function speakMessage(text, button) {
      try {
        const synth = window.speechSynthesis;
        if (!synth) { showNotice('Speech synthesis is not available in this build.'); return; }
        if (synth.speaking) { synth.cancel(); if (button) { button.innerHTML = messageActionIcon('speak'); button.title = 'Read aloud'; } return; }
        const utterance = new SpeechSynthesisUtterance(String(text).slice(0, 2000));
        utterance.onend = () => { if (button?.isConnected) { button.innerHTML = messageActionIcon('speak'); button.title = 'Read aloud'; } };
        if (button) { button.innerHTML = messageActionIcon('stop'); button.title = 'Stop reading'; }
        synth.speak(utterance);
      } catch (error) { showNotice(`Could not read message: ${error.message}`); }
    }

    /* Adaptive tray layout — dynamic and structured:
     * The tile keeps its natural message-determined size; the row NEVER grows it.
     * Icons fill the natural row (copy, resend, tray icons in order, dots last).
     * When an icon no longer fits, it moves to a wing outside the tile's edge —
     * right side for your messages, left for AI responses — and the whole tile
     * slides toward the centre so the wing shows in the space it vacates.
     * A second wing (other side) is used only if the first is full.
     * Re-runs on expand and on resize so every tile size adapts. */
    function collapseMessageTray(actions) {
      if (!actions.classList.contains('expanded')) return;
      actions.classList.remove('expanded');
      actions.querySelector('.msg-more')?.setAttribute('aria-expanded', 'false');
      const bubble = actions.closest('.chat-msg');
      if (bubble) layoutMessageTray(actions, bubble, bubble.classList.contains('user') ? 'user' : 'assistant');
    }

    /* A wing taller than the tile scrolls; the clipped end fades to hint there is
     * more. The fade shows WHILE icons are still hidden beyond the current scroll
     * end and clears once fully scrolled out (column-reverse: the far end is the
     * top, and Chromium reports that as negative scrollTop). */
    function updateWingFade(wing) {
      const overflowing = wing.scrollHeight - wing.clientHeight > 2;
      // Distance still available to scroll toward the clipped (top) end.
      const remaining = wing.scrollTop + (wing.scrollHeight - wing.clientHeight);
      wing.classList.toggle('fading', overflowing && remaining > 2);
    }

    function layoutMessageTray(actions, bubble, role) {
      const tray = actions.querySelector(':scope > .msg-tray');
      const wingLeft = bubble.querySelector(':scope > .msg-wing-left');
      const wingRight = bubble.querySelector(':scope > .msg-wing-right');
      const more = actions.querySelector(':scope > .msg-more');
      if (!tray || !wingLeft || !wingRight || !more) return;
      const open = actions.classList.contains('expanded');
      bubble.classList.toggle('tray-open', open);
      // A left-offset (not transform): a transform would make the bubble the
      // containing block for the fixed-position translate popover inside it.
      bubble.style.left = '';
      // Reset: every overflow button back into the tray, both wings emptied.
      const buttons = [...tray.querySelectorAll(':scope > .msg-action'),
        ...wingLeft.querySelectorAll('.msg-action'), ...wingRight.querySelectorAll('.msg-action')];
      wingLeft.replaceChildren();
      wingRight.replaceChildren();
      wingLeft.scrollTop = 0;
      wingRight.scrollTop = 0;
      tray.replaceChildren(...buttons);
      wingLeft.setAttribute('aria-hidden', 'true');
      wingRight.setAttribute('aria-hidden', 'true');
      if (!open) return;
      // Natural tile width: the bubble's content box with the actions row hidden.
      // The row is capped to this so it can never grow the tile.
      actions.style.display = 'none';
      const bubbleStyle = getComputedStyle(bubble);
      const textWidth = bubble.getBoundingClientRect().width
        - parseFloat(bubbleStyle.paddingLeft) - parseFloat(bubbleStyle.paddingRight);
      actions.style.display = '';
      // Show the full row, then pull icons out (from the end, dots stay last)
      // until the row fits the natural width again. This fills every pixel the
      // tile already has before anything goes to the wings.
      const firstWing = role === 'user' ? wingRight : wingLeft;
      const secondWing = role === 'user' ? wingLeft : wingRight;
      let guard = 0;
      while (guard++ < 12 && tray.querySelectorAll(':scope > .msg-action').length
          && actions.scrollWidth > textWidth + 1) {
        const last = [...tray.querySelectorAll(':scope > .msg-action')].pop();
        (firstWing.children.length < 6 ? firstWing : secondWing).appendChild(last);
      }
      wingLeft.setAttribute('aria-hidden', String(!wingLeft.children.length));
      wingRight.setAttribute('aria-hidden', String(!wingRight.children.length));
      updateWingFade(wingLeft);
      updateWingFade(wingRight);
      // Slide the tile toward the centre just enough to reveal the wing on its
      // outer side (user bubbles: right edge; AI: left edge). The inner-side
      // wing sits in the chat gutter and needs no slide.
      const outerWing = role === 'user' ? wingRight : wingLeft;
      const slide = outerWing.children.length ? outerWing.getBoundingClientRect().width + 6 : 0;
      if (slide) bubble.style.left = `${role === 'user' ? -slide : slide}px`;
    }
    window.addEventListener('resize', () => {
      for (const actions of document.querySelectorAll('.msg-actions.expanded')) {
        const bubble = actions.closest('.chat-msg');
        if (bubble) layoutMessageTray(actions, bubble, bubble.classList.contains('user') ? 'user' : 'assistant');
      }
    });

    function makeMessageActionButton({ cls, title, icon, onClick, dataset }) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'msg-action ' + cls;
      button.title = title;
      button.setAttribute('aria-label', title);
      button.innerHTML = messageActionIcon(icon);
      if (dataset) for (const [key, value] of Object.entries(dataset)) if (value !== undefined) button.dataset[key] = value;
      button.onclick = onClick;
      return button;
    }

    function appendMessageActions(bubble, role, text, msgIndex = null, provisional = false, messageKey = '') {
      if (!['user', 'assistant'].includes(role) || !text || bubble.querySelector('.msg-actions')) return;
      const agentId = getCurrentAgent()?.id;
      const actions = document.createElement('span');
      actions.className = 'msg-actions';
      // Core: copy + resend stay inline; the rest live in the slide-out tray.
      const copy = makeMessageActionButton({ cls: 'msg-copy', title: 'Copy message', icon: 'copy',
        onClick: async () => {
          try {
            await navigator.clipboard.writeText(String(text));
            copy.innerHTML = messageActionIcon('copied');
            copy.title = 'Copied';
            copy.setAttribute('aria-label', copy.title);
            setTimeout(() => {
              copy.innerHTML = messageActionIcon('copy');
              copy.title = 'Copy message';
              copy.setAttribute('aria-label', copy.title);
            }, 1200);
          } catch (error) { showNotice(`Could not copy message: ${error.message}`); }
        } });
      const resendDataset = {};
      if (Number.isInteger(msgIndex) && !provisional) resendDataset.messageIndex = String(msgIndex);
      if (messageKey && !provisional) resendDataset.messageKey = messageKey;
      const resend = makeMessageActionButton({ cls: 'msg-resend', title: role === 'user' ? 'Resend prompt' : 'Resend preceding prompt',
        icon: 'resend', dataset: resendDataset,
        onClick: async () => {
          if (getCurrentAgent()?.id !== agentId || resend.disabled || messageResendBusy()) return;
          const index = Number(resend.dataset.messageIndex);
          setComposerIntentPending(true);
          updateSendControl();
          try {
            const result = await reachApi.agents.resend(agentId, index, resend.dataset.messageKey);
            if (!result.ok) throw new Error(result.err || 'The prompt could not be resent.');
            if (getCurrentAgent()?.id === agentId) {
              appendChatMessage('user', result.display, result.messageIndex, '', result.messageKey);
              setAgentRunning(true);
              updateStatusPill('running');
            }
            await loadAgentTree();
          } catch (error) { showNotice(`Could not resend prompt: ${error.message}`); }
          finally { setComposerIntentPending(false); updateSendControl(); }
        } });
      // 1 — Inline edit: load the message text back into the composer.
      const edit = makeMessageActionButton({ cls: 'msg-edit-btn', title: 'Edit in composer', icon: 'edit',
        onClick: () => {
          composerInput.value = String(text);
          composerInput.dispatchEvent(new Event('input'));
          composerInput.focus();
        } });
      // 4 — Pin: bookmark the message per conversation (survives reloads).
      const pinnedNow = isMessagePinned(agentId, messageKey);
      const pin = makeMessageActionButton({ cls: 'msg-pin', title: pinnedNow ? 'Unpin message' : 'Pin message', icon: pinnedNow ? 'pinned' : 'pin',
        onClick: () => {
          const pinned = togglePinnedMessage(agentId, messageKey || resend.dataset.messageKey, text, role);
          pin.innerHTML = messageActionIcon(pinned ? 'pinned' : 'pin');
          pin.title = pinned ? 'Unpin message' : 'Pin message';
          pin.setAttribute('aria-label', pin.title);
        } });
      // 5 — Save to file: download the message as markdown.
      const save = makeMessageActionButton({ cls: 'msg-save', title: 'Save message to file', icon: 'save',
        onClick: () => {
          const blob = new Blob([String(text)], { type: 'text/markdown' });
          const url = URL.createObjectURL(blob);
          const link = document.createElement('a');
          link.href = url;
          link.download = `message-${new Date().toISOString().replace(/[:.]/g, '-')}.md`;
          document.body.appendChild(link);
          link.click();
          link.remove();
          setTimeout(() => URL.revokeObjectURL(url), 5000);
        } });
      // 6 — Export: copy as markdown quote / HTML snippet.
      const exportBtn = makeMessageActionButton({ cls: 'msg-export', title: 'Export message (markdown / HTML)', icon: 'export',
        onClick: async () => {
          const choice = await confirmAction('Export as HTML? Cancel keeps Markdown.');
          const out = choice
            ? `<blockquote><p>${escapeHtml(String(text)).replace(/\n/g, '<br>')}</p></blockquote>`
            : `> ${String(text).split('\n').join('\n> ')}`;
          try { await navigator.clipboard.writeText(out); showNotice(choice ? 'Copied as HTML.' : 'Copied as Markdown.'); }
          catch (error) { showNotice(`Could not export message: ${error.message}`); }
        } });
      // 7 — Read aloud via speech synthesis (toggles to stop).
      const speak = makeMessageActionButton({ cls: 'msg-speak', title: 'Read aloud', icon: 'speak',
        onClick: () => speakMessage(text, speak) });
      // 9 — Translate: drop-up popover to pick the target language, then the
      // result replaces the tile's own text (original kept one click away).
      const translate = makeMessageActionButton({ cls: 'msg-translate', title: 'Translate message', icon: 'translate',
        onClick: (event) => {
          event?.stopPropagation?.();
          openTranslatePopover(bubble, translate, String(text), role);
        } });
      // 10 — Remember: append to the agent's MEMORY.md via note.
      const remember = makeMessageActionButton({ cls: 'msg-remember', title: 'Save to memory', icon: 'memory',
        onClick: async () => {
          if (!agentId) return;
          try {
            const result = await reachApi.agents.appendNote(agentId, `Saved from chat:\n${String(text).slice(0, 2000)}`);
            if (!result.ok) throw new Error(result.err || 'Could not save.');
            showNotice('Saved to memory.');
          } catch (error) { showNotice(`Could not save to memory: ${error.message}`); }
        } });
      // 11 — Task: create a todo from this message.
      const task = makeMessageActionButton({ cls: 'msg-task', title: 'Create task from message', icon: 'task',
        onClick: async () => {
          if (!agentId) return;
          try {
            const agent = await reachApi.agents.get(agentId);
            const todos = [...(agent?.todos || []), { text: String(text), status: 'pending' }];
            const result = await reachApi.agents.setTodos(agentId, todos);
            if (!result.ok) throw new Error(result.err || 'Could not create task.');
            if (getCurrentAgent()?.id === agentId) { getCurrentAgent().todos = todos; renderTodos(); }
            showNotice('Task created.');
          } catch (error) { showNotice(`Could not create task: ${error.message}`); }
        } });
      // Overflow: tray fills the tile row first, then wraps into side wings.
      // Measures the row on expand and moves overflowing icons into floating
      // vertical wings beside the bubble (user: left, assistant: right).
      const more = makeMessageActionButton({ cls: 'msg-more', title: 'More message actions', icon: 'more',
        onClick: (e) => {
          e.stopPropagation();
          // Only one tray open at a time.
          for (const other of chatLog.querySelectorAll('.msg-actions.expanded')) {
            if (other !== actions) collapseMessageTray(other);
          }
          if (actions.classList.contains('expanded')) { collapseMessageTray(actions); return; }
          actions.classList.add('expanded');
          more.setAttribute('aria-expanded', 'true');
          requestAnimationFrame(() => layoutMessageTray(actions, bubble, role));
        } });
      more.setAttribute('aria-expanded', 'false');
      const tray = document.createElement('span');
      tray.className = 'msg-tray';
      tray.append(edit, pin, save, exportBtn, speak, translate, remember, task);
      const wingLeft = document.createElement('span');
      wingLeft.className = 'msg-wing msg-wing-left';
      wingLeft.setAttribute('aria-hidden', 'true');
      wingLeft.addEventListener('scroll', () => updateWingFade(wingLeft));
      const wingRight = document.createElement('span');
      wingRight.className = 'msg-wing msg-wing-right';
      wingRight.setAttribute('aria-hidden', 'true');
      wingRight.addEventListener('scroll', () => updateWingFade(wingRight));
      actions.append(copy, resend, tray, more);
      bubble.append(wingLeft, wingRight);
      bubble.appendChild(actions);
      updateMessageActions();
      // Live bubbles are rendered before the renderer receives a refreshed history.
      // Resolve once now, then retain that saved index even for repeated text.
      if (!messageKey && agentId && !provisional) {
        reachApi.agents.get(agentId).then(agent => {
          if (!resend.isConnected || getCurrentAgent()?.id !== agentId) return;
          const messages = agent?.messages || [];
          const matches = message => message?.role === role && (message._reachMeta?.display ?? message.content) === text;
          const index = Number.isInteger(msgIndex) && matches(messages[msgIndex]) ? msgIndex : messages.findLastIndex(matches);
          if (index >= 0 && messages[index]._reachMessageKey) {
            resend.dataset.messageIndex = String(index);
            resend.dataset.messageKey = messages[index]._reachMessageKey;
          }
          updateMessageActions();
        }).catch(() => { /* Copy stays available if the saved message is unavailable. */ });
      }
    }

    return Object.freeze({
      attachThoughtPreview,
      appendThoughtIndicator,
      updateMessageActions,
      messageActionIcon,
      pinnedMessagesKey,
      getPinnedMessages,
      isMessagePinned,
      togglePinnedMessage,
      speakMessage,
      collapseMessageTray,
      updateWingFade,
      layoutMessageTray,
      makeMessageActionButton,
      appendMessageActions,
      dismissThoughtPreview: () => dismissThoughtPreview?.(),
    });
  }

  return Object.freeze({ create });
});
