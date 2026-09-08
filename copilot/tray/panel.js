/* Tray panel logic — multi-view (Home / MiniChat / Controls). */
'use strict';

const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));

/* ------------------------------- view routing ------------------------------ */
function show(name) {
    $$('.view').forEach((v) => v.classList.toggle('active', v.id === 'view-' + name));
    if (name === 'home') refresh();
}
$$('[data-goto]').forEach((b) => b.addEventListener('click', () => show(b.dataset.goto)));

/* --------------------------------- status ---------------------------------- */
function ago(ts) {
    if (!ts) return 'never';
    const s = Math.round((Date.now() - ts) / 1000);
    if (s < 60) return s + 's ago';
    if (s < 3600) return Math.round(s / 60) + 'm ago';
    return Math.round(s / 3600) + 'h ago';
}

// Set a button's visible label without destroying its <svg> icon.
function setLabel(btn, text) {
    if (!btn) return;
    let span = btn.querySelector('span.btn-label');
    if (!span) {
        span = document.createElement('span');
        span.className = 'btn-label';
        btn.appendChild(span);
    }
    span.textContent = text;
}

async function refresh() {
    try {
        const st = await window.copilotTray.status();
        const pill = $('#pill');
        pill.classList.toggle('ok', !!st.signedIn);
        pill.classList.toggle('bad', !st.signedIn);
        $('#pill-text').textContent = st.signedIn ? 'signed in' : (st.why || 'not ready');
        $('#st-session').textContent = st.signedIn ? 'Microsoft 365 ✓' : (st.why || '—');
        $('#st-port').textContent = st.bridgeUp ? (st.bridgePort + ' listening') : 'DOWN';
        $('#st-visible').textContent = st.browserVisible ? 'visible' : 'invisible';
        $('#st-last').textContent = ago(st.lastReplyAt);
        const err = $('#st-error'); if (err) err.textContent = st.lastError || '—';
        const url = $('#st-url'); if (url) url.textContent = (st.url || '—').replace(/^https?:\/\//, '').slice(0, 40);
        // window-state labels: show/hide flips with visibility
        setLabel($('#btn-toggle-window'), st.browserVisible ? 'Hide window' : 'Show window');
        const tileLabel = $('#tile-window-label');
        const tileSub = $('#tile-window-sub');
        if (tileLabel && tileSub) {
            tileLabel.textContent = st.browserVisible ? 'Hide window' : 'Copilot window';
            tileSub.textContent = st.browserVisible ? 'running — click to hide' : 'sign in / verify';
        }
    } catch (e) {
        $('#pill-text').textContent = 'panel error';
    }
}

/* --------------------------------- minichat -------------------------------- */
const MAX_HISTORY = 12;
let messages = [];        // {role, content, sources?, note?, error?}
let pending = false;
let reqSeq = 0;

const listEl = $('#chat-messages');
const inputEl = $('#chat-input');
const webEl = $('#chat-web');
const sendEl = $('#chat-send');

function esc(v) {
    return String(v == null ? '' : v)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function renderChat() {
    if (!messages.length) {
        listEl.innerHTML = '<div class="chat-empty">A tiny grounded chat. Keep <b>Web</b> on for current info — answers cite their sources. Turn it off for a direct model reply.</div>';
    } else {
        listEl.innerHTML = messages.map((m) => {
            if (m.thinking) {
                return '<div class="msg assistant thinking" role="status">' +
                    '<span class="think-orbit"><span class="think-brain">🧠</span></span>' +
                    '<span>' + esc(m.hint || 'Thinking…') + '</span></div>';
            }
            const srcs = (m.sources || []).map((s, i) =>
                '<button class="src" data-url="' + esc(s.url) + '" title="' + esc(s.url) + '">' +
                '<span class="src-n">' + (i + 1) + '</span>' +
                '<span class="src-t">' + esc(s.title || s.url) + '</span></button>'
            ).join('');
            const srcHtml = srcs ? '<div class="sources">' + srcs + '</div>' : '';
            const note = m.note ? '<div class="note">' + esc(m.note) + '</div>' : '';
            return '<div class="msg ' + (m.role === 'user' ? 'user' : 'assistant') + (m.error ? ' error' : '') + '">' +
                esc(m.content || '') + srcHtml + note + '</div>';
        }).join('');
    }
    listEl.scrollTop = listEl.scrollHeight;
    inputEl.disabled = pending;
    webEl.disabled = pending;
    sendEl.disabled = pending;
    setLabel(sendEl, pending ? 'Working…' : 'Send');
    $('#chat-clear').disabled = pending;
    autoresize();
}

function autoresize() {
    inputEl.style.height = 'auto';
    const lh = parseFloat(getComputedStyle(inputEl).lineHeight) || 16;
    inputEl.style.height = Math.min(Math.max(inputEl.scrollHeight, 38), lh * 4 + 2) + 'px';
}

// open a source link in the user's real browser (panel denies navigation)
listEl.addEventListener('click', (e) => {
    const b = e.target.closest('.src');
    if (b && b.dataset.url) {
        window.copilotTray.openExternal ? window.copilotTray.openExternal(b.dataset.url)
            : window.open(b.dataset.url, '_blank');
    }
});

async function sendChat() {
    const text = inputEl.value.trim();
    if (!text || pending) return;
    const webSearch = webEl.checked;
    const history = messages
        .filter((m) => !m.error && (m.role === 'user' || m.role === 'assistant'))
        .slice(-MAX_HISTORY)
        .map((m) => ({ role: m.role, content: m.content }));
    reqSeq += 1;
    const rid = 'c' + Date.now() + '-' + reqSeq;
    messages.push({ role: 'user', content: text });
    messages.push({ role: 'assistant', thinking: true, rid, hint: webSearch ? 'Searching the web…' : 'Thinking…' });
    inputEl.value = '';
    pending = true;
    renderChat();
    const reply = messages.find((m) => m.rid === rid);
    try {
        const r = await window.copilotTray.chat({ message: text, history, webSearch });
        if (reply !== messages.find((m) => m.rid === rid)) return; // cleared meanwhile
        if (!r || r.ok === false) {
            Object.assign(reply, { thinking: false, content: (r && r.error) || 'Could not complete that reply.', error: true });
        } else {
            Object.assign(reply, {
                thinking: false,
                content: r.content || '(empty reply)',
                sources: r.sources || [],
                note: r.searchNote || (r.ms ? r.ms + 'ms' : '')
            });
        }
    } catch (e) {
        Object.assign(reply, { thinking: false, content: (e && e.message) || 'Request failed.', error: true });
    } finally {
        pending = false;
        renderChat();
        inputEl.focus({ preventScroll: true });
        refresh();
    }
}

sendEl.addEventListener('click', sendChat);
inputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat(); }
});
inputEl.addEventListener('input', autoresize);
$('#chat-clear').addEventListener('click', () => { if (!pending) { messages = []; renderChat(); } });

/* --------------------------------- controls -------------------------------- */
async function runTest() {
    const btn = $('#btn-test');
    const out = $('#test-out');
    const text = $('#test-input').value.trim();
    if (!text) return;
    btn.disabled = true;
    setLabel(btn, 'Thinking…');
    out.className = '';
    out.style.display = 'block';
    out.textContent = 'sending (can take ~10s)…';
    try {
        const r = await window.copilotTray.test(text);
        out.className = r.ok ? 'ok' : 'err';
        out.textContent = r.ok ? (r.content.slice(0, 1200) + '\n(' + r.ms + 'ms)') : ('ERROR: ' + r.error + ' (' + r.ms + 'ms)');
    } catch (e) {
        out.className = 'err';
        out.textContent = 'ERROR: ' + (e.message || e);
    } finally {
        btn.disabled = false;
        setLabel(btn, 'Send test');
        refresh();
    }
}

$('#btn-test').addEventListener('click', runTest);
$('#test-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') runTest(); });
$('#btn-refresh').addEventListener('click', refresh);
// one-button show/hide toggle: press again while the window is open -> hides it
$('#btn-toggle-window').addEventListener('click', () => {
    window.copilotTray.toggleBrowser();
    setTimeout(refresh, 600);
});
$('#btn-refresh-page').addEventListener('click', () => window.copilotTray.refreshPage());
$('#btn-home').addEventListener('click', () => window.copilotTray.reloadBrowser());
$('#btn-signout').addEventListener('click', () => {
    if (confirm('Clear the Microsoft 365 session? You will need to sign in again.')) {
        window.copilotTray.signOut();
        setTimeout(refresh, 3000);
    }
});

// home tiles — window tile is also a toggle now
$('#tile-show-window').addEventListener('click', () => {
    window.copilotTray.toggleBrowser();
    setTimeout(refresh, 600);
});
$('#tile-refresh').addEventListener('click', () => { refresh(); window.copilotTray.refreshPage(); });

// quit (both footers)
const quit = () => window.copilotTray.quit();
$('#btn-quit').addEventListener('click', quit);
$('#btn-quit-home').addEventListener('click', quit);

/* ---------------------------------- boot ----------------------------------- */
renderChat();
refresh();
setInterval(refresh, 15000);
