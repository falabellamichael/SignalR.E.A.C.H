/* Local Chromium surface. Website code runs in the separate engine process;
 * only rendered pixels, input events and explicit research snapshots cross here. */
(function () {
    'use strict';
    let tokenPromise = null;
    const created = new Map();
    window.addEventListener('pagehide', () => {
        if (tokenPromise) void tokenPromise.then(token => navigator.sendBeacon(
            window.__reachCore.RELAY + '/_reach/browser/engine',
            new Blob([JSON.stringify({ action: 'close_session', token })], { type: 'application/json' })
        )).catch(() => {});
    });
    async function request(body) {
        const response = await fetch(window.__reachCore.RELAY + '/_reach/browser/engine', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            credentials: 'omit', body: JSON.stringify(body), signal: AbortSignal.timeout(20000)
        });
        const data = await response.json();
        if (!response.ok) {
            const error = new Error(data.error?.message || 'The browser engine is unavailable.');
            error.status = response.status; throw error;
        }
        return data;
    }
    async function command(action, tab, data = {}) {
        if (!tokenPromise) tokenPromise = request({ action: 'session' }).then(data => data.token);
        try { return await request({ ...data, action, tab, token: await tokenPromise }); }
        catch (error) { if ([401, 403, 410, 503, 504].includes(error.status)) { tokenPromise = null; created.clear(); } throw error; }
    }
    window.__reachInteractiveBrowser = function (host, callbacks) {
        const surface = document.createElement('canvas');
        surface.className = 'reach-browser-live'; surface.hidden = true;
        surface.tabIndex = 0; surface.setAttribute('role', 'application');
        surface.setAttribute('aria-label', 'Interactive webpage');
        surface.setAttribute('aria-description', 'Click to browse. Escape returns to the address bar. Reader mode provides selectable page text.');
        host.appendChild(surface);
        const context = surface.getContext('2d', { alpha: false });
        let active = null, generation = 0, sequence = 0, stopped = false, timer = null;
        let inputTimer = null, events = [], chain = Promise.resolve(), composing = false;
        function dimensions() {
            const rect = host.getBoundingClientRect();
            return { width: Math.max(160, Math.min(2400, Math.round(rect.width))), height: Math.max(120, Math.min(1800, Math.round(rect.height))) };
        }
        function ensure(tab) {
            if (!created.has(tab)) created.set(tab, command('create', tab, dimensions()).catch(error => { created.delete(tab); tokenPromise = null; throw error; }));
            return created.get(tab);
        }
        function fail(error, tab) { if (!stopped && tab === active) callbacks.error(error.message); }
        function enqueue(action, data = {}, tab = active) {
            if (!tab) return Promise.resolve(null);
            const result = chain.then(() => command(action, tab, data));
            chain = result.catch(error => fail(error, tab));
            return result;
        }
        function flush() {
            clearTimeout(inputTimer); inputTimer = null;
            if (!events.length || !active) return;
            const batch = events; events = [];
            void enqueue('input', { events: batch }).catch(() => {});
        }
        function input(event) {
            if (!active) return;
            if (event.type === 'mouseMove' && events.at(-1)?.type === 'mouseMove') events[events.length - 1] = event;
            else events.push(event);
            if (events.length >= 64) flush();
            else if (!inputTimer) inputTimer = setTimeout(flush, 16);
        }
        function point(event) {
            const rect = surface.getBoundingClientRect();
            const size = dimensions();
            return { x: Math.max(0, Math.min(size.width - 1, Math.round((event.clientX - rect.left) * size.width / rect.width))),
                y: Math.max(0, Math.min(size.height - 1, Math.round((event.clientY - rect.top) * size.height / rect.height))) };
        }
        const modifiers = e => ['shift', 'control', 'alt', 'meta'].filter((m, i) => [e.shiftKey, e.ctrlKey, e.altKey, e.metaKey][i]);
        const mouseButton = e => ['left', 'middle', 'right'][e.button] || 'left';
        let lastClick = 0, clickCount = 1;
        surface.addEventListener('pointerdown', event => {
            if (!active) return;
            surface.focus({ preventScroll: true }); surface.setPointerCapture(event.pointerId);
            clickCount = event.timeStamp - lastClick < 400 ? Math.min(3, clickCount + 1) : 1;
            lastClick = event.timeStamp;
            input({ type: 'mouseDown', ...point(event), button: mouseButton(event), clickCount, modifiers: modifiers(event) });
            event.preventDefault();
        });
        surface.addEventListener('pointermove', event => input({ type: 'mouseMove', ...point(event), button: event.buttons ? mouseButton(event) : 'left', modifiers: modifiers(event).concat(event.buttons & 1 ? ['leftButtonDown'] : []) }));
        const release = event => {
            input({ type: 'mouseUp', ...point(event), button: mouseButton(event), clickCount, modifiers: modifiers(event) });
            if (surface.hasPointerCapture(event.pointerId)) surface.releasePointerCapture(event.pointerId);
            flush();
        };
        surface.addEventListener('pointerup', release);
        surface.addEventListener('pointercancel', release);
        surface.addEventListener('wheel', event => {
            event.preventDefault();
            const scale = event.deltaMode === 1 ? 18 : event.deltaMode === 2 ? dimensions().height : 1;
            const delta = value => Math.max(-10000, Math.min(10000, Math.round(-value * scale)));
            input({ type: 'mouseWheel', ...point(event), deltaX: delta(event.deltaX),
                deltaY: delta(event.deltaY), canScroll: true, modifiers: modifiers(event) });
        }, { passive: false });
        surface.addEventListener('contextmenu', async event => {
            event.preventDefault(); flush();
            try { const data = await enqueue('snapshot'); if (data) callbacks.clip(data.selection || data.contextText || '', data); } catch (_) { /* reported by queue */ }
        });
        surface.addEventListener('compositionstart', () => { composing = true; });
        surface.addEventListener('compositionend', event => { composing = false; if (event.data) void enqueue('text', { text: event.data }).catch(() => {}); });
        surface.addEventListener('paste', event => {
            event.preventDefault(); flush();
            void enqueue('text', { text: event.clipboardData.getData('text/plain').slice(0, 16384) }).catch(() => {});
        });
        const keyNames = { ArrowLeft: 'Left', ArrowRight: 'Right', ArrowUp: 'Up', ArrowDown: 'Down', ' ': 'Space', Control: 'Control', Escape: 'Escape' };
        surface.addEventListener('keydown', async event => {
            if (composing || event.isComposing || event.keyCode === 229) return;
            if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'v') return; // native paste event
            event.preventDefault(); flush();
            if (event.key === 'Escape') { callbacks.address(); return; }
            if ((event.ctrlKey || event.metaKey) && ['l', 'f'].includes(event.key.toLowerCase())) {
                callbacks[event.key.toLowerCase() === 'l' ? 'address' : 'find'](); return;
            }
            if ((event.ctrlKey || event.metaKey) && ['c', 'x'].includes(event.key.toLowerCase())) {
                try {
                    const data = await enqueue('snapshot');
                    if (data?.selection) {
                        await window.__reachCore.copyText(data.selection);
                        if (event.key.toLowerCase() === 'x') await enqueue('input', { events: [{ type: 'keyDown', keyCode: 'Delete' }, { type: 'keyUp', keyCode: 'Delete' }] });
                    }
                } catch (_) { /* reported by queue */ }
                return;
            }
            const keyCode = keyNames[event.key] || event.key;
            input({ type: 'keyDown', keyCode, modifiers: modifiers(event) });
            if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
                input({ type: 'char', keyCode: event.key, modifiers: modifiers(event) });
            }
        });
        surface.addEventListener('keyup', event => {
            if (!composing && event.key !== 'Escape') input({ type: 'keyUp', keyCode: keyNames[event.key] || event.key, modifiers: modifiers(event) });
        });
        async function poll(tab, epoch) {
            if (stopped || epoch !== generation || tab !== active) return;
            try {
                const data = await command('frame', tab, { since: sequence, ...dimensions() });
                if (stopped || epoch !== generation || tab !== active) return;
                callbacks.state(data);
                if (data.image) {
                    const img = new Image();
                    img.src = 'data:image/jpeg;base64,' + data.image;
                    await img.decode();
                    if (stopped || epoch !== generation || tab !== active) return;
                    surface.width = img.naturalWidth; surface.height = img.naturalHeight;
                    context.drawImage(img, 0, 0); sequence = data.sequence;
                }
                surface.style.cursor = data.cursor || 'default';
            } catch (error) { fail(error, tab); return; }
            timer = setTimeout(() => poll(tab, epoch), document.hidden ? 500 : 80);
        }
        return {
            async select(tab) {
                if (active === tab) return;
                flush(); const previous = active; active = tab; generation++; clearTimeout(timer); sequence = 0;
                surface.hidden = !tab;
                if (previous) void command('pause', previous).catch(() => {});
                if (!tab) return;
                context.fillStyle = '#fff'; context.fillRect(0, 0, surface.width, surface.height);
                const epoch = generation;
                try {
                    await ensure(tab);
                    if (stopped || epoch !== generation || tab !== active) { await command('pause', tab); return; }
                    await command('resume', tab);
                    if (stopped || epoch !== generation || tab !== active) { await command('pause', tab); return; }
                    void poll(tab, epoch);
                }
                catch (error) { fail(error, tab); }
            },
            async navigate(tab, url) { await ensure(tab); return enqueue('navigate', { url }, tab); },
            async action(action, data = {}) { flush(); if (action === 'find') data.text = data.text.slice(0, 500); return enqueue(action, data); },
            async snapshot(tab) { flush(); return enqueue('snapshot', {}, tab); },
            close(tab) { if (created.has(tab)) { created.delete(tab); void command('close', tab).catch(() => {}); } },
            dispose() { flush(); stopped = true; generation++; clearTimeout(timer); clearTimeout(inputTimer); if (active) void command('pause', active).catch(() => {}); surface.remove(); }
        };
    };
})();
