/* Tray popover panel logic — status polling + test send + controls. */
'use strict';

const $ = (s) => document.querySelector(s);

function ago(ts) {
    if (!ts) return 'never';
    const s = Math.round((Date.now() - ts) / 1000);
    if (s < 60) return s + 's ago';
    if (s < 3600) return Math.round(s / 60) + 'm ago';
    return Math.round(s / 3600) + 'h ago';
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
        $('#st-error').textContent = st.lastError || '—';
    } catch (e) {
        $('#pill-text').textContent = 'panel error';
        $('#st-error').textContent = String(e.message || e).slice(0, 80);
    }
}

async function runTest() {
    const btn = $('#btn-test');
    const out = $('#test-out');
    const text = $('#test-input').value.trim();
    if (!text) return;
    btn.disabled = true;
    btn.textContent = 'Thinking…';
    out.className = '';
    out.style.display = 'block';
    out.textContent = 'sending to Copilot (can take ~10s)…';
    try {
        const r = await window.copilotTray.test(text);
        out.className = r.ok ? 'ok' : 'err';
        out.textContent = r.ok
            ? r.content.slice(0, 1200) + '\n(' + r.ms + 'ms)'
            : 'ERROR: ' + r.error + ' (' + r.ms + 'ms)';
    } catch (e) {
        out.className = 'err';
        out.textContent = 'ERROR: ' + (e.message || e);
    } finally {
        btn.disabled = false;
        btn.textContent = 'Send test';
        refresh();
    }
}

$('#btn-refresh').addEventListener('click', refresh);
$('#btn-show').addEventListener('click', () => window.copilotTray.showBrowser());
$('#btn-hide').addEventListener('click', () => window.copilotTray.hideBrowser());
$('#btn-refresh-page').addEventListener('click', () => window.copilotTray.refreshPage());
$('#btn-home').addEventListener('click', () => window.copilotTray.reloadBrowser());
$('#btn-signout').addEventListener('click', () => {
    if (confirm('Clear the Microsoft 365 session? You will need to sign in again.')) {
        window.copilotTray.signOut();
        setTimeout(refresh, 3000);
    }
});
$('#btn-test').addEventListener('click', runTest);
$('#test-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') runTest();
});
$('#btn-quit').addEventListener('click', () => window.copilotTray.quit());

refresh();
setInterval(refresh, 15000);
