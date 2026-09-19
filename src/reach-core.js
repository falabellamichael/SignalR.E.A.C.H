/*
 * SignalR.E.A.C.H core — shared helpers for the REACH plugin pages.
 * Exposes window.__reachCore. Loaded before reach-pages.js / reach.js.
 */
(function initReachCore() {
    'use strict';

    const RELAY = 'http://127.0.0.1:20777';
    const POINTER = 'https://gist.githubusercontent.com/falabellamichael/e261e0c31ad08c373bcd667b6982847a/raw/simple-reach-endpoint.txt';
    const REPO_URL = 'https://github.com/falabellamichael/SignalR.E.A.C.H';
    const API_BASE = '/api/extensions/rag-workspace';
    const POINTER_TTL_MS = 60000;
    const PREFS_PREFIX = 'signal-reach.ui.';
    const LEGACY_PREFS_PREFIX = 'simple-reach.ui.';

    const store = {
        local: null,            // relay /status snapshot (or null when offline)
        localAt: 0,
        localChecked: false,
        pointerUrl: null,
        pointerAt: 0,
        settings: null,         // relay /_reach/settings (masked)
        page: 'dashboard',
        dirty: false,
        toastTimer: null,
        version: '26.9.6' // x-release-please-version
    };

    function prefsGet(key, fallback) {
        try {
            const raw = localStorage.getItem(PREFS_PREFIX + key);
            if (raw !== null) return raw;
            const legacy = localStorage.getItem(LEGACY_PREFS_PREFIX + key);
            return legacy === null ? fallback : legacy;
        } catch (_e) {
            return fallback;
        }
    }

    function prefsSet(key, value) {
        try {
            localStorage.setItem(PREFS_PREFIX + key, String(value));
        } catch (_e) { /* storage full or blocked — non-fatal */ }
    }

    function fetchWithTimeout(url, options, timeoutMs) {
        const controller = typeof AbortController === 'function' ? new AbortController() : null;
        const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
        const opts = Object.assign({}, options || {});
        if (controller) opts.signal = controller.signal;
        return fetch(url, opts)
            .catch(err => { throw err; })
            .finally(() => { if (timer) clearTimeout(timer); });
    }

    function relayFetch(path, options, timeoutMs) {
        return fetchWithTimeout(RELAY + path, options, timeoutMs || 4000);
    }

    function refreshLocal() {
        return relayFetch('/status', undefined, 3000)
            .then(res => {
                if (!res.ok) throw new Error('HTTP ' + res.status);
                return res.json();
            })
            .then(snap => {
                store.localChecked = true;
                store.local = snap;
                store.localAt = Date.now();
                return snap;
            })
            .catch(() => {
                store.localChecked = true;
                store.local = null;
                return null;
            });
    }

    function refreshPointer(force) {
        const now = Date.now();
        if (!force && store.pointerUrl && now - store.pointerAt < POINTER_TTL_MS) {
            return Promise.resolve(store.pointerUrl);
        }
        return fetchWithTimeout(POINTER, undefined, 8000)
            .then(res => (res.ok ? res.text() : Promise.reject(new Error('HTTP ' + res.status))))
            .then(text => {
                const url = text.trim();
                if (url && /^https:\/\//.test(url)) {
                    store.pointerUrl = url;
                    store.pointerAt = Date.now();
                    return url;
                }
                return store.pointerUrl;
            })
            .catch(() => store.pointerUrl);
    }

    function loadSettings() {
        return relayFetch('/_reach/settings', undefined, 4000)
            .then(res => (res.ok ? res.json() : Promise.reject(new Error('HTTP ' + res.status))))
            .then(cfg => { store.settings = cfg; return cfg; })
            .catch(() => { store.settings = null; return null; });
    }

    function saveSettings(patch) {
        return relayFetch('/_reach/settings', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(patch || {})
        }, 6000)
            .then(res => res.json().then(data => ({ ok: res.ok, status: res.status, data: data })));
    }

    // ------------------------------------------------------------------ format
    function pad2(n) { return String(n).padStart(2, '0'); }

    function fmtTime(ts) {
        if (!ts) return '—';
        const t = new Date(ts.length === 13 ? ts + ':00' : ts);
        if (isNaN(t)) return ts;
        return t.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
            + ' ' + t.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
    }

    function fmtHour(hour) {
        const t = new Date(hour + (hour.length === 13 ? ':00' : ''));
        if (isNaN(t)) return hour;
        return pad2(t.getHours()) + ':00';
    }

    function fmtNum(n) {
        n = Number(n || 0);
        if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
        if (n >= 1e4) return (n / 1e3).toFixed(1) + 'k';
        return String(n);
    }

    function fmtLatency(ms) {
        if (ms == null || isNaN(ms)) return '—';
        if (ms < 1000) return Math.round(ms) + ' ms';
        return (ms / 1000).toFixed(1) + ' s';
    }

    function fmtUptime(seconds) {
        seconds = Math.max(0, Math.floor(seconds || 0));
        const d = Math.floor(seconds / 86400);
        const h = Math.floor((seconds % 86400) / 3600);
        const m = Math.floor((seconds % 3600) / 60);
        if (d) return d + 'd ' + h + 'h';
        if (h) return h + 'h ' + m + 'm';
        if (m) return m + 'm ' + (seconds % 60) + 's';
        return seconds + 's';
    }

    function fmtAgo(ts) {
        const t = new Date(ts);
        if (isNaN(t)) return '—';
        const s = Math.max(0, (Date.now() - t.getTime()) / 1000);
        if (s < 60) return Math.floor(s) + 's ago';
        if (s < 3600) return Math.floor(s / 60) + 'm ago';
        if (s < 86400) return Math.floor(s / 3600) + 'h ago';
        return Math.floor(s / 86400) + 'd ago';
    }

    function esc(value) {
        const el = document.createElement('span');
        el.textContent = String(value == null ? '' : value);
        return el.innerHTML;
    }

    function el(tag, className, text) {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined) node.textContent = text;
        return node;
    }

    // ------------------------------------------------------------------ toast
    function toast(message, kind) {
        let node = document.querySelector('.reach-toast');
        if (!node) {
            node = document.createElement('div');
            node.className = 'reach-toast';
            document.body.appendChild(node);
        }
        node.textContent = message;
        node.className = 'reach-toast reach-toast-' + (kind || 'info');
        node.hidden = false;
        if (store.toastTimer) clearTimeout(store.toastTimer);
        store.toastTimer = setTimeout(() => { node.hidden = true; }, 3200);
    }

    function copyText(text) {
        if (navigator.clipboard && navigator.clipboard.writeText) {
            return navigator.clipboard.writeText(text).then(() => true).catch(() => false);
        }
        try {
            const ta = document.createElement('textarea');
            ta.value = text;
            ta.style.cssText = 'position:fixed;opacity:0;';
            document.body.appendChild(ta);
            ta.select();
            const ok = document.execCommand('copy');
            ta.remove();
            return Promise.resolve(ok);
        } catch (_e) {
            return Promise.resolve(false);
        }
    }

    window.__reachCore = Object.freeze({
        RELAY: RELAY,
        POINTER: POINTER,
        REPO_URL: REPO_URL,
        API_BASE: API_BASE,
        store: store,
        prefsGet: prefsGet,
        prefsSet: prefsSet,
        relayFetch: relayFetch,
        refreshLocal: refreshLocal,
        refreshPointer: refreshPointer,
        loadSettings: loadSettings,
        saveSettings: saveSettings,
        fmtTime: fmtTime,
        fmtHour: fmtHour,
        fmtNum: fmtNum,
        fmtLatency: fmtLatency,
        fmtUptime: fmtUptime,
        fmtAgo: fmtAgo,
        esc: esc,
        el: el,
        toast: toast,
        copyText: copyText
    });
})();
