/*
 * SimpleREACH pages — shared page widgets + per-page registry.
 * Loaded after reach-core.js and before the pages-*.js files.
 * Defines window.__reachPageRegistry (populated by pages-*.js) and
 * window.__reachPageWidgets (shared widgets used by the page renderers).
 * Depends on window.__reachCore (reach-core.js).
 */
(function initReachPageCommon() {
    'use strict';

    const core = window.__reachCore;
    if (!core) {
        console.error('[simple-reach] reach-core.js missing — re-run install.');
        return;
    }
    const { el } = core;

    window.__reachPageRegistry = {};

    function pageHeader(icon, title, subtitle) {
        const head = el('div', 'reach-page-head');
        const iconEl = el('div', 'reach-page-head-icon');
        const i = el('i', 'fa-solid ' + icon);
        iconEl.appendChild(i);
        const copy = el('div', 'reach-page-head-copy');
        copy.appendChild(el('h1', 'reach-page-title', title));
        if (subtitle) copy.appendChild(el('p', 'reach-page-sub', subtitle));
        head.appendChild(iconEl);
        head.appendChild(copy);
        return head;
    }

    function statTile(label, value, sub, tone) {
        const tile = el('div', 'reach-tile' + (tone ? ' reach-tile-' + tone : ''));
        tile.appendChild(el('div', 'reach-tile-label', label));
        tile.appendChild(el('div', 'reach-tile-value', value));
        if (sub) tile.appendChild(el('div', 'reach-tile-sub', sub));
        return tile;
    }

    function emptyNote(text) {
        const note = el('div', 'reach-empty');
        note.appendChild(el('i', 'fa-regular fa-circle-question'));
        note.appendChild(el('span', null, text));
        return note;
    }

    function chip(label, tone) {
        const c = el('span', 'reach-chip' + (tone ? ' reach-chip-' + tone : ''));
        c.textContent = label;
        return c;
    }

    function kv(dl, key, value, tone) {
        dl.appendChild(el('dt', null, key));
        const dd = el('dd', tone ? 'reach-kv-' + tone : null, value);
        dl.appendChild(dd);
    }

    function publishNow() {
        return core.relayFetch('/_reach/publish', { method: 'POST' }, 30000)
            .then(res => res.json().then(data => ({ ok: res.ok, data: data })))
            .then(({ ok, data }) => {
                if (!ok) throw new Error((data && data.error) || 'publish failed');
                return data.public_url;
            });
    }

    window.__reachPageWidgets = Object.freeze({
        pageHeader,
        statTile,
        emptyNote,
        chip,
        kv,
        publishNow
    });
})();
