/*
 * SignalR.E.A.C.H pages — Logs renderer.
 * Registers window.__reachPageRegistry.logs.
 * Depends on window.__reachCore (reach-core.js) and
 * window.__reachPageWidgets (pages-common.js).
 */
(function initReachPageLogs() {
    'use strict';

    const core = window.__reachCore;
    if (!core) {
        console.error('[signal-reach] reach-core.js missing — re-run install.');
        return;
    }
    const { el, toast } = core;
    const { pageHeader, kv, confirmDialog } =
        window.__reachPageWidgets;

    /* ------------------------------------------------------------------ LOGS */
    function renderLogs(container) {
        container.appendChild(pageHeader('fa-list', 'Logs',
            'Recent requests through the relay (local store). Click any row to inspect full payload.'));
        const body = el('div', 'reach-stack');
        container.appendChild(body);
        let timer = null;
        let limit = 100;
        let statusFilter = '';
        let modelFilter = '';
        let activeModal = null;

        function showLogInspector(entry) {
            if (activeModal) activeModal.remove();

            const overlay = el('div', 'reach-modal-overlay');
            const modal = el('div', 'reach-modal-card reach-modal-drawer');
            modal.setAttribute('role', 'dialog');
            modal.setAttribute('aria-label', 'Request payload inspector');

            // Header
            const head = el('div', 'reach-modal-head');
            const titleWrap = el('h3', null);
            titleWrap.innerHTML = '<i class="fa-solid fa-file-lines" style="color:var(--reach-accent-light, #ffd37a);"></i> Request Inspector'
                + (entry.id != null ? ' <span class="reach-hint">#' + entry.id + '</span>' : '');
            const closeBtn = el('button', 'reach-btn reach-btn-sm', '✕');
            closeBtn.style.padding = '2px 8px';
            head.appendChild(titleWrap);
            head.appendChild(closeBtn);
            modal.appendChild(head);

            // Body
            const modalBody = el('div', 'reach-modal-body');

            const statusClass = entry.status >= 500 ? 'reach-kv-bad' : (entry.status >= 400 ? 'reach-kv-warn' : 'reach-kv-ok');
            const dl = el('dl', 'reach-kv');
            kv(dl, 'Request ID', entry.id == null ? '—' : '#' + entry.id);
            kv(dl, 'Timestamp', core.fmtTime(entry.ts) + ' (' + (entry.ts || '') + ')');
            kv(dl, 'HTTP Status', String(entry.status || '—'), statusClass);
            kv(dl, 'Cache Hit', entry.cached ? 'Yes (served from response cache)' : 'No');
            kv(dl, 'Client IP', entry.ip || 'Unknown');
            kv(dl, 'User Agent', entry.user_agent || 'Unknown');
            kv(dl, 'API Key', entry.key_name || '—');
            kv(dl, 'Model Alias', entry.model || '—');
            kv(dl, 'Upstream Target', entry.upstream_model || '—');
            kv(dl, 'Streaming', entry.stream ? 'Yes (SSE)' : 'No (JSON)');
            kv(dl, 'Latency', core.fmtLatency(entry.latency_ms) + ' (' + (entry.latency_ms || 0) + ' ms)');
            kv(dl, 'Input Tokens', core.fmtNum(entry.tokens_in || 0));
            kv(dl, 'Output Tokens', core.fmtNum(entry.tokens_out || 0));
            kv(dl, 'Total Tokens', core.fmtNum((entry.tokens_in || 0) + (entry.tokens_out || 0)));
            if (entry.error) {
                kv(dl, 'Error Message', entry.error, 'bad');
            }
            modalBody.appendChild(dl);

            // Payload bodies — fetched from the detail endpoint (the list
            // endpoint never carries request/response bodies).
            const reqTitle = el('div', 'reach-hint', 'Request Payload:');
            reqTitle.style.fontWeight = '600';
            modalBody.appendChild(reqTitle);
            const reqPre = el('pre', 'reach-modal-pre', 'loading…');
            modalBody.appendChild(reqPre);
            const resTitle = el('div', 'reach-hint', 'Response Payload:');
            resTitle.style.fontWeight = '600';
            modalBody.appendChild(resTitle);
            const resPre = el('pre', 'reach-modal-pre', 'loading…');
            modalBody.appendChild(resPre);

            const jsonTitle = el('div', 'reach-hint', 'Full JSON Record:');
            jsonTitle.style.fontWeight = '600';
            modalBody.appendChild(jsonTitle);

            let detail = entry;
            const pre = el('pre', 'reach-modal-pre', JSON.stringify(entry, null, 2));
            modalBody.appendChild(pre);

            modal.appendChild(modalBody);

            function renderBodies(rec) {
                detail = rec;
                pre.textContent = JSON.stringify(rec, null, 2);
                const reqBody = rec.request_body;
                const resBody = rec.response_body;
                reqPre.textContent = reqBody ? prettyTry(reqBody) : '(not stored — enable "Store body snippets" in Settings → Observability)';
                resPre.textContent = resBody ? prettyTry(resBody) : '(not stored)';
            }

            function prettyTry(raw) {
                try { return JSON.stringify(JSON.parse(raw), null, 2); }
                catch (_e) { return String(raw); }
            }

            if (entry.id != null) {
                core.relayFetch('/_reach/logs/' + encodeURIComponent(entry.id), undefined, 5000)
                    .then(res => (res.ok ? res.json() : Promise.reject(new Error('HTTP ' + res.status))))
                    .then(renderBodies)
                    .catch(err => {
                        reqPre.textContent = 'Payload unavailable: ' + err.message;
                        resPre.textContent = '';
                    });
            } else {
                reqPre.textContent = '(no request id)';
                resPre.textContent = '';
            }

            // Footer
            const foot = el('div', 'reach-modal-foot');
            const copyBtn = el('button', 'reach-btn reach-btn-sm', 'Copy JSON');
            copyBtn.addEventListener('click', () => {
                core.copyText(JSON.stringify(detail, null, 2))
                    .then(ok => toast(ok ? 'JSON copied ✓' : 'Copy failed', ok ? 'ok' : 'error'));
            });
            const dismissBtn = el('button', 'reach-btn reach-btn-primary reach-btn-sm', 'Close');
            foot.appendChild(copyBtn);
            foot.appendChild(dismissBtn);
            modal.appendChild(foot);

            overlay.appendChild(modal);
            document.body.appendChild(overlay);
            activeModal = overlay;
            // Body-level overlay: inherit the user's chosen accent palette.
            if (window.signalReach && typeof window.signalReach.reapplyAccent === 'function') {
                try { window.signalReach.reapplyAccent(); } catch (_e) { /* cosmetic only */ }
            }

            const close = () => {
                if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
                activeModal = null;
                document.removeEventListener('keydown', onKey);
            };

            const onKey = (e) => {
                if (e.key === 'Escape') close();
            };

            closeBtn.addEventListener('click', close);
            dismissBtn.addEventListener('click', close);
            overlay.addEventListener('click', (e) => {
                if (e.target === overlay) close();
            });
            document.addEventListener('keydown', onKey);
        }

        function draw() {
            const params = new URLSearchParams({ limit: String(limit) });
            if (statusFilter) params.set('status', statusFilter);
            if (modelFilter) params.set('model', modelFilter);
            core.relayFetch('/_reach/logs?' + params.toString(), undefined, 4000)
                .then(res => (res.ok ? res.json() : Promise.reject(new Error('HTTP ' + res.status))))
                .then(data => {
                    const logs = data.logs || [];
                    body.innerHTML = '';

                    const toolbar = el('div', 'reach-toolbar');

                    // Filter chips
                    const filterChips = el('div', 'reach-presence-filters');
                    filterChips.style.marginRight = '8px';

                    const chipDefs = [
                        { label: 'All', val: '' },
                        { label: '2xx OK', val: '2*' },
                        { label: '429 RL', val: '429' },
                        { label: '5xx Err', val: '5*' }
                    ];

                    chipDefs.forEach(c => {
                        const b = el('button', 'reach-presence-filter-btn' + (statusFilter === c.val ? ' active' : ''), c.label);
                        b.addEventListener('click', () => {
                            statusFilter = c.val;
                            draw();
                        });
                        filterChips.appendChild(b);
                    });
                    toolbar.appendChild(filterChips);

                    const modelInput = document.createElement('input');
                    modelInput.className = 'reach-input reach-input-sm';
                    modelInput.placeholder = 'model filter (e.g. gpt-4o*)';
                    modelInput.value = modelFilter;
                    modelInput.addEventListener('change', () => { modelFilter = modelInput.value.trim(); draw(); });
                    toolbar.appendChild(modelInput);

                    const refreshBtn = el('button', 'reach-btn reach-btn-sm', 'Refresh');
                    refreshBtn.addEventListener('click', draw);
                    toolbar.appendChild(refreshBtn);

                    const exportBtn = el('button', 'reach-btn reach-btn-sm');
                    exportBtn.innerHTML = '<i class="fa-solid fa-download"></i> Export JSON';
                    exportBtn.addEventListener('click', () => {
                        if (!logs.length) {
                            toast('No logs to export', 'warn');
                            return;
                        }
                        const blob = new Blob([JSON.stringify(logs, null, 2)], { type: 'application/json' });
                        const url = URL.createObjectURL(blob);
                        const a = document.createElement('a');
                        a.href = url;
                        a.download = 'reach-logs-' + new Date().toISOString().slice(0, 10) + '.json';
                        document.body.appendChild(a);
                        a.click();
                        a.remove();
                        URL.revokeObjectURL(url);
                        toast('Exported ' + logs.length + ' logs ✓', 'ok');
                    });
                    toolbar.appendChild(exportBtn);

                    const flushBtn = el('button', 'reach-btn reach-btn-sm');
                    flushBtn.innerHTML = '<i class="fa-solid fa-broom"></i> Flush Cache';
                    flushBtn.addEventListener('click', () => {
                        confirmDialog({
                            title: 'Flush response cache?',
                            message: 'All cached responses will be discarded. Upstream requests will run fresh until the cache refills. This cannot be undone.',
                            confirmLabel: 'Flush Cache',
                            danger: true
                        }).then(ok => {
                            if (!ok) return;
                            core.relayFetch('/_reach/cache/clear', { method: 'POST' }, 5000)
                                .then(res => res.json())
                                .then(d => toast('Cache flushed ✓ (' + (d.entries || 0) + ' entries)', 'ok'))
                                .catch(err => toast('Flush failed: ' + err.message, 'error'));
                        });
                    });
                    toolbar.appendChild(flushBtn);

                    const clearBtn = el('button', 'reach-btn reach-btn-danger reach-btn-sm', 'Clear Logs');
                    clearBtn.addEventListener('click', () => {
                        confirmDialog({
                            title: 'Clear all request logs?',
                            message: 'This permanently purges every stored request record from the local database and resets log-derived metrics. The purge is recorded in the audit trail. This cannot be undone.',
                            confirmLabel: 'Purge Logs',
                            danger: true
                        }).then(ok => {
                            if (!ok) return;
                            clearBtn.disabled = true;
                            core.relayFetch('/_reach/logs', { method: 'DELETE' }, 5000)
                                .then(res => {
                                    if (!res.ok) throw new Error('HTTP ' + res.status);
                                    toast('Logs purged ✓', 'ok');
                                    draw();
                                })
                                .catch(err => toast('Purge failed: ' + err.message, 'error'))
                                .finally(() => { clearBtn.disabled = false; });
                        });
                    });
                    toolbar.appendChild(clearBtn);

                    const count = el('span', 'reach-hint', logs.length + ' rows (click to inspect)');
                    toolbar.appendChild(count);
                    body.appendChild(toolbar);

                    const table = el('table', 'reach-table reach-table-logs');
                    table.innerHTML = '<thead><tr><th>ID</th><th>Time</th><th>IP</th><th>Model</th><th>Status</th><th>Cache</th><th>Latency</th><th>In</th><th>Out</th><th>Error</th></tr></thead>';
                    const tbody = document.createElement('tbody');
                    logs.forEach(entry => {
                        const tr = document.createElement('tr');
                        tr.className = 'reach-log-row-clickable';
                        tr.title = 'Click to inspect full request payload';
                        tr.appendChild(el('td', 'reach-nowrap reach-hint', entry.id == null ? '—' : '#' + entry.id));
                        tr.appendChild(el('td', 'reach-nowrap', core.fmtTime(entry.ts)));
                        tr.appendChild(el('td', null, entry.ip || '?'));
                        tr.appendChild(el('td', null, entry.model || '—'));
                        const statusTd = el('td', null, String(entry.status || '—'));
                        if (entry.status >= 500) statusTd.className = 'reach-kv-bad';
                        else if (entry.status >= 400) statusTd.className = 'reach-kv-warn';
                        else statusTd.className = 'reach-kv-ok';
                        tr.appendChild(statusTd);
                        const cacheTd = el('td', null, entry.cached ? 'HIT' : '—');
                        if (entry.cached) cacheTd.className = 'reach-kv-ok';
                        tr.appendChild(cacheTd);
                        tr.appendChild(el('td', null, core.fmtLatency(entry.latency_ms)));
                        tr.appendChild(el('td', null, entry.tokens_in == null ? '·' : core.fmtNum(entry.tokens_in)));
                        tr.appendChild(el('td', null, entry.tokens_out == null ? '·' : core.fmtNum(entry.tokens_out)));
                        tr.appendChild(el('td', 'reach-err', entry.error || ''));

                        tr.addEventListener('click', () => showLogInspector(entry));
                        tbody.appendChild(tr);
                    });
                    if (!logs.length) {
                        const tr = document.createElement('tr');
                        const td = el('td', 'reach-copy', 'No matching requests');
                        td.colSpan = 10;
                        tr.appendChild(td);
                        tbody.appendChild(tr);
                    }
                    table.appendChild(tbody);
                    body.appendChild(table);

                    body.appendChild(buildAuditTrail());
                })
                .catch(err => {
                    body.innerHTML = '';
                    body.appendChild(el('div', 'reach-banner reach-banner-off', 'Logs unavailable: ' + err.message));
                });
        }

        // Audit trail for destructive admin actions (log purge, cache flush,
        // key revocation, pointer publish). PRD: purge operations log an audit
        // event recording timestamp and actor.
        function buildAuditTrail() {
            const card = el('section', 'reach-card');
            card.appendChild(el('header', 'reach-card-head', 'Audit Trail'));
            const list = el('div', 'reach-card-body');
            const note = el('p', 'reach-hint', 'Loading…');
            list.appendChild(note);
            card.appendChild(list);
            core.relayFetch('/_reach/audit?limit=25', undefined, 4000)
                .then(res => (res.ok ? res.json() : Promise.reject(new Error('HTTP ' + res.status))))
                .then(data => {
                    const events = data.events || [];
                    list.innerHTML = '';
                    if (!events.length) {
                        list.appendChild(el('p', 'reach-copy', 'No recorded admin actions yet. Purges, cache flushes, key revocations, and pointer publishes appear here.'));
                        return;
                    }
                    const table = el('table', 'reach-table');
                    table.innerHTML = '<thead><tr><th>Time</th><th>Action</th><th>Actor</th><th>Detail</th></tr></thead>';
                    const tbody = document.createElement('tbody');
                    events.forEach(ev => {
                        const tr = document.createElement('tr');
                        tr.appendChild(el('td', 'reach-nowrap', core.fmtTime(ev.ts)));
                        tr.appendChild(el('td', null, ev.action || '—'));
                        tr.appendChild(el('td', null, ev.actor || '—'));
                        tr.appendChild(el('td', 'reach-hint', ev.detail || ''));
                        tbody.appendChild(tr);
                    });
                    table.appendChild(tbody);
                    list.appendChild(table);
                })
                .catch(err => {
                    list.innerHTML = '';
                    list.appendChild(el('p', 'reach-copy', 'Audit trail unavailable: ' + err.message));
                });
            return card;
        }

        draw();
        timer = setInterval(draw, 10000);
        return () => {
            if (timer) clearInterval(timer);
            if (activeModal && activeModal.parentNode) activeModal.parentNode.removeChild(activeModal);
        };
    }

    window.__reachPageRegistry.logs = renderLogs;
})();
