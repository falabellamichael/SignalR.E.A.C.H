/* Transcript translation: language popover, saved placement, and reversible body swaps.
 * Factories defer DOM work until app.js reaches the transcript initialization.
 * Dependencies are supplied by the renderer; this module does not read app state.
 */
(function expose(factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.ReachMessageTranslation = api;
})(function buildReachMessageTranslation() {
  function create({
    window, document, localStorage, chatLog, md, reachApi, showNotice,
    getCurrentAgent, scheduleBrowserLayout,
  }) {
    const requestAnimationFrame = callback => window.requestAnimationFrame(callback);

    /* The Translate popover. Deliberately quiet: no scrim and no modal, because
     * picking a target language is a two-second decision and the message being
     * translated should stay readable behind it. Never more than one is open. The
     * result does NOT live here — it replaces the message tile's own body, with a
     * tag row to flip back to the original. */
    const TRANSLATE_TARGET_KEY = 'reach:translate-target';
    /* Once the user drags the popover it keeps the chosen offset from the action
     * row: {dx, dy} survives restarts and wins over automatic drop-up placement.
     * An offset (not absolute screen coords) so the parked spot follows whatever
     * message it is opened on — a short prompt and a tall answer anchor alike. */
    const TRANSLATE_POS_KEY = 'reach:translate-pos';

    function savedTranslatePos() {
      try {
        const pos = JSON.parse(localStorage.getItem(TRANSLATE_POS_KEY));
        if (pos && Number.isFinite(pos.dx) && Number.isFinite(pos.dy)) return pos;
        if (pos) localStorage.removeItem(TRANSLATE_POS_KEY); // legacy absolute spot — drop it
      } catch { /* storage blocked or corrupt — fall back to auto placement */ }
      return null;
    }

    function closeTranslatePopovers(except = null) {
      for (const pop of chatLog.querySelectorAll('.msg-translate-pop')) {
        if (pop !== except) pop.remove();
      }
    }

    /* The two modules load from sibling scripts; guard so a stripped build degrades
     * to a notice instead of breaking every message action. */
    function translateModules() {
      const languages = window.ReachLanguages;
      const translate = window.ReachTranslate;
      if (!languages?.get || !translate?.detect) return null;
      return { languages, translate };
    }

    /* Place the popover, clamped to the viewport.
     *
     * It is fixed-positioned because the transcript is a scrolling box: an absolute
     * popover is clipped by that scroller's edge regardless of which side it opens
     * on. Two placement modes:
     *   pos.dx/dy — a spot the user dragged it to, kept as an offset from the
     *     action row so it tracks each message instead of a stale screen point.
     *   pos.left/top — an absolute spot (used by the resize keep-in-view clamp).
     *   pos == null — drop-up from the action ROW the click came from (not the
     *   whole message, which for a tall message can be taller than the screen and
     *   would pin the popover to a window edge). Below the row when there is no
     *   room above, clamped to the window last. */
    function placeTranslatePopover(pop, bubble, anchor, pos) {
      if (!pop.isConnected) return;
      const gap = 6;
      const margin = 8;
      const box = pop.getBoundingClientRect();
      const viewportW = window.innerWidth;
      const viewportH = window.innerHeight;
      const clampX = (v) => Math.min(Math.max(v, margin), Math.max(margin, viewportW - box.width - margin));
      const clampY = (v) => Math.min(Math.max(v, margin), Math.max(margin, viewportH - box.height - margin));

      let left, top;
      const row = (anchor || pop).getBoundingClientRect();
      if (pos && Number.isFinite(pos.dx) && Number.isFinite(pos.dy)) {
        left = clampX(row.left + pos.dx);
        top = clampY(row.top + pos.dy);
      } else if (pos && Number.isFinite(pos.left) && Number.isFinite(pos.top)) {
        left = clampX(pos.left);
        top = clampY(pos.top);
      } else {
        left = clampX(row.left);
        const roomAbove = row.top - gap - margin;
        if (box.height <= roomAbove) top = row.top - gap - box.height;
        else if (box.height <= viewportH - row.bottom - gap - margin) top = row.bottom + gap;
        else top = Math.max(margin, Math.min(row.top - gap - box.height, viewportH - box.height - margin));
      }

      pop.style.left = Math.round(left) + 'px';
      pop.style.top = Math.round(top) + 'px';
      // A short transcript cannot scroll out from under a very tall popover, so cap
      // the list instead of letting it hang off the window.
      const list = pop.querySelector('.msg-translate-list');
      if (list && !list.hidden) {
        list.style.maxHeight = Math.max(96, Math.min(216, viewportH - Math.max(0, top) - 140)) + 'px';
      }
    }

    /* ---- On-tile translation --------------------------------------------------
     * A translation replaces the bubble's body text and leaves a slim tag row
     * naming the pair ("French → English · show original"). Both versions are kept
     * as DocumentFragments, so flipping is instant, keeps code-copy buttons and
     * thought markers alive, and never makes a second model call. */

    // Direct children that are furniture, not message text. Everything else —
    // text nodes and markdown blocks alike — moves as the body. Thought markers
    // count as body: they annotate the original text, so they travel with it.
    const MSG_FURNITURE = ['msg-ts', 'msg-actions', 'msg-wing', 'msg-fork', 'msg-translation-tag', 'msg-translate-pop'];

    function bubbleBodyNodes(bubble) {
      return [...bubble.childNodes].filter(n => n.nodeType !== 1 || !MSG_FURNITURE.some(c => n.classList.contains(c)));
    }

    function detachBubbleBody(bubble) {
      const frag = document.createDocumentFragment();
      for (const node of bubbleBodyNodes(bubble)) frag.appendChild(node);
      return frag;
    }

    function insertBubbleBody(bubble, frag) {
      bubble.insertBefore(frag, bubble.querySelector(':scope > .msg-ts') || null);
    }

    function renderTranslatedBody(out, role) {
      const frag = document.createDocumentFragment();
      if (role === 'assistant') {
        const tmp = document.createElement('div');
        tmp.innerHTML = md.render(out);
        while (tmp.firstChild) frag.appendChild(tmp.firstChild);
      } else {
        frag.appendChild(document.createTextNode(out));
      }
      return frag;
    }

    function updateTranslationTag(bubble) {
      const st = bubble._translate;
      if (!st?.tag) return;
      st.tagLabel.textContent = `${st.fromName || 'Detected'} → ${st.toName}`;
      st.tagToggle.textContent = st.showing === 'translated' ? 'Show original' : 'Show translation';
    }

    function showBubbleTranslation(bubble, variant) {
      const st = bubble._translate;
      if (!st?.origFrag || st.showing === variant) return;
      // Stash whatever is on the tile now, then drop in the other copy.
      const current = detachBubbleBody(bubble);
      if (st.showing === 'translated') st.transFrag = current; else st.origFrag = current;
      insertBubbleBody(bubble, variant === 'translated' ? st.transFrag : st.origFrag);
      st.showing = variant;
      bubble.classList.toggle('is-translated', variant === 'translated');
      updateTranslationTag(bubble);
    }

    function clearBubbleTranslation(bubble) {
      const st = bubble._translate;
      if (!st) return;
      const current = detachBubbleBody(bubble);
      if (st.showing !== 'translated') st.origFrag = current;
      if (st.origFrag) insertBubbleBody(bubble, st.origFrag);
      st.showing = 'original';
      bubble.classList.remove('is-translated');
      st.tag?.remove();
      st.tag = null;
    }

    /* The result lands on the tile itself: body swaps to the translation and the
     * tag row appears above it. Re-translating replaces the translated copy; the
     * original fragment survives untouched. */
    function applyBubbleTranslation(bubble, out, fromName, toName, role) {
      const st = bubble._translate || (bubble._translate = {});
      const current = detachBubbleBody(bubble);
      if (st.showing === 'translated') { /* the previous translation is replaced */ }
      else st.origFrag = current;
      st.transFrag = renderTranslatedBody(out, role);
      st.fromName = fromName;
      st.toName = toName;
      if (!st.tag) {
        st.tag = document.createElement('div');
        st.tag.className = 'msg-translation-tag';
        st.tagLabel = document.createElement('span');
        st.tagLabel.className = 'msg-translation-tag-lang';
        st.tagToggle = document.createElement('button');
        st.tagToggle.type = 'button';
        st.tagToggle.className = 'msg-translation-tag-toggle';
        st.tagToggle.onclick = (e) => {
          e.stopPropagation();
          showBubbleTranslation(bubble, st.showing === 'translated' ? 'original' : 'translated');
        };
        const close = document.createElement('button');
        close.type = 'button';
        close.className = 'msg-translation-tag-close';
        close.textContent = '×';
        close.title = 'Back to the original and forget this translation';
        close.onclick = (e) => { e.stopPropagation(); clearBubbleTranslation(bubble); };
        st.tag.append(st.tagLabel, st.tagToggle, close);
      }
      if (!st.tag.isConnected) bubble.insertBefore(st.tag, bubble.firstChild);
      insertBubbleBody(bubble, st.transFrag);
      st.showing = 'translated';
      bubble.classList.add('is-translated');
      updateTranslationTag(bubble);
    }

    function openTranslatePopover(bubble, anchor, text, role) {
      const modules = translateModules();
      if (!modules) { showNotice('The language catalog is unavailable in this build.'); return; }
      if (bubble.querySelector('.msg-translate-pop')) { closeTranslatePopovers(); return; }
      closeTranslatePopovers();

      const { languages, translate } = modules;
      const pop = document.createElement('div');
      pop.className = 'msg-translate-pop';
      pop.setAttribute('role', 'dialog');
      pop.setAttribute('aria-label', 'Translate message');

      // The head doubles as the drag grip: grab it to park the popover anywhere,
      // and the spot is remembered for next time (auto placement only runs while
      // no saved position exists).
      let userPos = savedTranslatePos();
      const head = document.createElement('div');
      head.className = 'msg-translate-head';
      head.title = 'Drag to move — the popover keeps that spot relative to the message';
      const headTitle = document.createElement('span');
      headTitle.className = 'msg-translate-title';
      headTitle.textContent = 'Translate';
      const headHome = document.createElement('button');
      headHome.type = 'button';
      headHome.className = 'msg-translate-close msg-translate-home';
      headHome.textContent = '⌖';
      headHome.title = 'Snap back to the message';
      headHome.setAttribute('aria-label', 'Snap the popover back to the message');
      headHome.onclick = (e) => {
        e.stopPropagation();
        userPos = null;
        try { localStorage.removeItem(TRANSLATE_POS_KEY); } catch { /* storage blocked */ }
        place();
      };
      const headClose = document.createElement('button');
      headClose.type = 'button';
      headClose.className = 'msg-translate-close';
      headClose.textContent = '×';
      headClose.title = 'Close';
      headClose.setAttribute('aria-label', 'Close translate popover');
      headClose.onclick = (e) => { e.stopPropagation(); closeTranslatePopovers(); };
      head.append(headTitle, headHome, headClose);

      // --- source: what the detector believes, stated as an observation ---
      const detected = translate.detect(text, languages.LANGUAGES);
      const known = detected?.code ? languages.get(detected.code) : null;
      const sourceName = known ? known.name : '';

      const sourceRow = document.createElement('div');
      sourceRow.className = 'msg-translate-row';
      const sourceLabel = document.createElement('label');
      sourceLabel.textContent = 'Detected';
      const sourceValue = document.createElement('span');
      sourceValue.className = 'msg-translate-value' + (known ? '' : ' is-unknown');
      sourceValue.textContent = known ? known.name : 'unknown';
      if (known && known.native && known.native !== known.name) {
        const native = document.createElement('span');
        native.className = 'msg-translate-native';
        native.textContent = known.native;
        sourceValue.appendChild(native);
      }
      sourceValue.title = known
        ? `${known.name} (${detected.source === 'script' ? 'writing system' : 'word evidence'}, ${Math.round(detected.confidence * 100)}% confident)`
        : 'Not enough text to tell — the model will work it out.';
      const swap = document.createElement('button');
      swap.type = 'button';
      swap.className = 'msg-translate-swap';
      swap.textContent = '⇅';
      swap.title = 'Treat the message as the chosen language and translate it back';
      swap.disabled = !known;
      sourceRow.append(sourceLabel, sourceValue, swap);

      // --- target: a searchable picker over the whole catalog ---
      const targetRow = document.createElement('div');
      targetRow.className = 'msg-translate-row';
      const targetLabel = document.createElement('label');
      targetLabel.textContent = 'Into';
      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'msg-translate-target';
      input.setAttribute('list', 'reach-language-options');
      input.setAttribute('autocomplete', 'off');
      input.spellcheck = false;
      input.setAttribute('aria-label', 'Language to translate into');
      const savedTarget = (() => { try { return localStorage.getItem(TRANSLATE_TARGET_KEY) || ''; } catch { return ''; } })();
      const initial = languages.get(savedTarget) || languages.get('en');
      let target = initial || languages.get('en');
      input.value = target ? target.name : 'English';
      const pick = document.createElement('button');
      pick.type = 'button';
      pick.className = 'msg-translate-pick';
      pick.textContent = 'Browse';
      pick.title = 'Browse every language by region';
      targetRow.append(targetLabel, input, pick);

      /* One big list, grouped by where the language is spoken. No filter: the rows
       * are short enough to scan, and a search box here would fight the popover for
       * keystrokes. `languages.grouped` decides the groups, so the UI never invents
       * a category the catalog does not have. */
      const groups = languages.grouped(languages.LANGUAGES);
      const list = document.createElement('div');
      list.className = 'msg-translate-list';
      list.setAttribute('role', 'listbox');
      list.setAttribute('aria-label', 'All languages');
      list.hidden = true;
      const buttons = [];
      for (const group of groups) {
        const heading = document.createElement('div');
        heading.className = 'msg-translate-group';
        const label = document.createElement('span');
        label.textContent = group.name;
        const count = document.createElement('span');
        count.className = 'msg-translate-group-count';
        count.textContent = String(group.items.length);
        heading.append(label, count);
        list.appendChild(heading);
        for (const language of group.items) {
          const option = document.createElement('button');
          option.type = 'button';
          option.className = 'msg-translate-option';
          option.setAttribute('role', 'option');
          option.dataset.code = language.code;
          option.append(document.createTextNode(language.name));
          if (language.native && language.native !== language.name) {
            const native = document.createElement('span');
            native.className = 'msg-translate-native';
            native.textContent = language.native;
            option.appendChild(native);
          }
          option.onclick = (e) => { e.stopPropagation(); choose(language); };
          buttons.push(option);
          list.appendChild(option);
        }
      }
      function choose(language) {
        target = language;
        input.value = language.name;
        markSelected();
        list.hidden = true;
        pick.setAttribute('aria-expanded', 'false');
        input.focus();
      }
      function markSelected() {
        for (const option of buttons) {
          const on = target && option.dataset.code === target.code;
          option.classList.toggle('is-selected', on);
          option.setAttribute('aria-selected', String(on));
        }
      }
      markSelected();
      pick.setAttribute('aria-expanded', 'false');
      pick.onclick = (e) => {
        e.stopPropagation();
        list.hidden = !list.hidden;
        pick.setAttribute('aria-expanded', String(!list.hidden));
        place();
        if (list.hidden) return;
        // Open on whatever is already chosen, and highlight it by typing ahead.
        for (const [index, option] of buttons.entries()) {
          if (!option.classList.contains('is-selected')) continue;
          option.scrollIntoView({ block: 'center' });
          selectedIndex = index;
          break;
        }
      };
      // Keyboard: typing jumps to the next language starting with those letters.
      let typed = '';
      let typedAt = 0;
      let selectedIndex = buttons.findIndex(o => o.classList.contains('is-selected'));
      input.onkeydown = (e) => {
        e.stopPropagation();
        if (e.key === 'Escape') { e.preventDefault(); if (!list.hidden) { list.hidden = true; pick.setAttribute('aria-expanded', 'false'); } else { closeTranslatePopovers(); anchor.focus(); } return; }
        if (!list.hidden && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
          e.preventDefault();
          selectedIndex = Math.max(0, Math.min(buttons.length - 1, selectedIndex + (e.key === 'ArrowDown' ? 1 : -1)));
          buttons[selectedIndex]?.scrollIntoView({ block: 'nearest' });
          buttons[selectedIndex]?.classList.add('is-cursor');
          for (const [i, o] of buttons.entries()) if (i !== selectedIndex) o.classList.remove('is-cursor');
          return;
        }
        if (e.key === 'Enter') {
          e.preventDefault();
          if (!list.hidden && buttons[selectedIndex]) { choose(languages.get(buttons[selectedIndex].dataset.code)); return; }
          run();
        }
      };
      input.oninput = () => {
        const needle = input.value.trim().toLowerCase();
        const now = Date.now();
        typed = now - typedAt > 900 ? needle.slice(-1) : typed + needle.slice(-1);
        typedAt = now;
        const hit = buttons.findIndex(o => (languages.get(o.dataset.code)?.name || '').toLowerCase().startsWith(typed));
        if (hit >= 0) {
          selectedIndex = hit;
          buttons[hit].scrollIntoView({ block: 'nearest' });
          buttons[hit].classList.add('is-cursor');
          for (const [i, o] of buttons.entries()) if (i !== hit) o.classList.remove('is-cursor');
        }
        // Typing a full name selects it outright.
        const exact = languages.LANGUAGES.find(l => l.name.toLowerCase() === needle);
        if (exact) { target = exact; markSelected(); }
      };

      function place() {
        placeTranslatePopover(pop, bubble, anchor, userPos);
      }

      /* Dragging anywhere on the head moves the popover; releasing saves the
       * offset from the action row. A 4px dead zone keeps jittery clicks from
       * silently pinning a spot, and buttons inside the head (the ×) keep their
       * click, so the grip ignores presses that land on a control. */
      head.addEventListener('pointerdown', (e) => {
        if (e.button !== 0 || e.target.closest('button')) return;
        e.preventDefault();
        const start = pop.getBoundingClientRect();
        const rowRect = anchor.getBoundingClientRect();
        const grabX = e.clientX - start.left;
        const grabY = e.clientY - start.top;
        const originX = e.clientX;
        const originY = e.clientY;
        let dragged = false;
        const move = (ev) => {
          if (!dragged && Math.hypot(ev.clientX - originX, ev.clientY - originY) < 4) return;
          dragged = true;
          head.classList.add('dragging');
          const box = pop.getBoundingClientRect();
          const margin = 8;
          const left = Math.min(Math.max(ev.clientX - grabX, margin), Math.max(margin, window.innerWidth - box.width - margin));
          const top = Math.min(Math.max(ev.clientY - grabY, margin), Math.max(margin, window.innerHeight - box.height - margin));
          pop.style.left = Math.round(left) + 'px';
          pop.style.top = Math.round(top) + 'px';
          // Track the spot live as a row offset: a scroll-following place() call
          // mid-drag re-asserts it instead of snapping back to the drag start.
          userPos = { dx: left - rowRect.left, dy: top - rowRect.top };
        };
        const up = () => {
          window.removeEventListener('pointermove', move, true);
          window.removeEventListener('pointerup', up, true);
          head.classList.remove('dragging');
          if (dragged) try { localStorage.setItem(TRANSLATE_POS_KEY, JSON.stringify(userPos)); } catch { /* storage blocked */ }
        };
        window.addEventListener('pointermove', move, true);
        window.addEventListener('pointerup', up, true);
      });

      const meta = document.createElement('div');
      meta.className = 'msg-translate-meta';
      const go = document.createElement('button');
      go.type = 'button';
      go.className = 'gold small msg-translate-go';
      go.textContent = 'Translate';
      pop.append(head, sourceRow, targetRow, list, meta, go);

      /* Translation runs through the prompt-console channel: one non-streaming
       * completion on the active connection. The result replaces the tile body —
       * the popover closes the moment there is something on the message to read. */
      let runId = 0;

      async function run() {
        // The input can hold a typed name the list never confirmed, so resolve it
        // once more here rather than trusting `target` alone.
        const typedName = input.value.trim().toLowerCase();
        const picked = target && (target.name.toLowerCase() === typedName || target.code === typedName)
          ? target
          : languages.get(input.value.trim()) || languages.LANGUAGES.find(l => l.name.toLowerCase() === typedName);
        if (!picked) {
          meta.textContent = 'Pick a language from the list.';
          pick.focus();
          return;
        }
        target = picked;
        if (!getCurrentAgent()) { meta.textContent = 'Open a conversation first.'; return; }
        runId += 1;
        const mine = `tr_${Date.now().toString(36)}_${runId}`;
        go.disabled = true;
        swap.disabled = true;
        go.textContent = 'Translating…';
        meta.textContent = `${sourceName || 'Auto-detect'} → ${target.name}`;
        try { localStorage.setItem(TRANSLATE_TARGET_KEY, target.code); } catch { /* storage blocked */ }
        let result;
        try {
          result = await reachApi.playground.run({
            runId: mine,
            prompt: translate.prompt({ text, targetName: picked.name, sourceName: sourceName || 'Auto-detect' }),
            stream: false,
            // Translation is a deterministic rewrite, so sampling controls add nothing
            // — and a text-only subscription bridge rejects them outright.
            controls: false,
          });
        } catch (error) {
          if (pop.isConnected) meta.textContent = error?.message || 'Translation failed.';
          return;
        } finally {
          if (pop.isConnected) {
            go.disabled = false;
            swap.disabled = !known;
            go.textContent = 'Translate';
          }
        }
        if (!result?.ok) {
          if (pop.isConnected) meta.textContent = result?.err || 'Translation failed.';
          return;
        }
        const out = translate.clean(result.text);
        if (!out) {
          if (pop.isConnected) meta.textContent = 'The model returned nothing to show.';
          return;
        }
        // The translation belongs on the message, not in the popover: hand it to
        // the tile (which keeps the original one click away) and close.
        if (bubble.isConnected) applyBubbleTranslation(bubble, out, sourceName || 'Detected', picked.name, role);
        closeTranslatePopovers();
      }

      swap.onclick = (e) => {
        e.stopPropagation();
        if (!known) return;
        // Swap the direction: what was the source becomes the target.
        choose(known);
        meta.textContent = `Translating back into ${known.name}.`;
      };
      go.onclick = (e) => { e.stopPropagation(); run(); };
      pop.onclick = (e) => e.stopPropagation();

      bubble.appendChild(pop);
      // The fixed popover must be placed from the message's real box. Two frames:
      // the first lets the popover lay out, the second measures that laid-out box.
      place();
      requestAnimationFrame(place);
      // Detached once placed: scrolling the transcript never moves it. The only
      // follow-up is a window resize, which re-clamps the spot it already has so a
      // shrinking window cannot strand it off-screen.
      const keepInView = () => {
        if (!pop.isConnected) { window.removeEventListener('resize', keepInView); return; }
        const box = pop.getBoundingClientRect();
        placeTranslatePopover(pop, bubble, anchor, { left: box.left, top: box.top });
      };
      window.addEventListener('resize', keepInView);
      pop.addEventListener('DOMNodeRemoved', () => window.removeEventListener('resize', keepInView));
      input.focus();
      input.select();
      scheduleBrowserLayout?.();
    }

    return Object.freeze({
      TRANSLATE_TARGET_KEY,
      TRANSLATE_POS_KEY,
      MSG_FURNITURE,
      savedTranslatePos,
      closeTranslatePopovers,
      translateModules,
      placeTranslatePopover,
      bubbleBodyNodes,
      detachBubbleBody,
      insertBubbleBody,
      renderTranslatedBody,
      updateTranslationTag,
      showBubbleTranslation,
      clearBubbleTranslation,
      applyBubbleTranslation,
      openTranslatePopover,
    });
  }

  return Object.freeze({ create });
});
