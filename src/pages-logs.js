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
    const { pageHeader, kv } =
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
            const modal = el('div', 'reach-modal-card');

            // Header
            const head = el('div', 'reach-modal-head');
            const titleWrap = el('h3', null);
            titleWrap.innerHTML = '<i class="fa-solid fa-file-lines" style="color:var(--reach-accent-light, #ffd37a);"></i> Request Inspector';
            const closeBtn = el('button', 'reach-btn reach-btn-sm', '✕');
            closeBtn.style.padding = '2px 8px';
            head.appendChild(titleWrap);
            head.appendChild(closeBtn);
            modal.appendChild(head);

            // Body
            const modalBody = el('div', 'reach-modal-body');

            const statusClass = entry.status >= 500 ? 'reach-kv-bad' : (entry.status >= 400 ? 'reach-kv-warn' : 'reach-kv-ok');
            const dl = el('dl', 'reach-kv');
            kv(dl, 'Timestamp', core.fmtTime(entry.ts) + ' (' + (entry.ts || '') + ')');
            kv(dl, 'HTTP Status', String(entry.status || '—'), statusClass);
            kv(dl, 'Client IP', entry.ip || 'Unknown');
            kv(dl, 'User Agent', entry.user_agent || 'Unknown');
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

            const jsonTitle = el('div', 'reach-hint', 'Full JSON Record:');
            jsonTitle.style.fontWeight = '600';
            modalBody.appendChild(jsonTitle);

            const pre = el('pre', 'reach-modal-pre', JSON.stringify(entry, null, 2));
            modalBody.appendChild(pre);

            modal.appendChild(modalBody);

            // Footer
            const foot = el('div', 'reach-modal-foot');
            const copyBtn = el('button', 'reach-btn reach-btn-sm', 'Copy JSON');
            copyBtn.addEventListener('click', () => {
                core.copyText(JSON.stringify(entry, null, 2))
                    .then(ok => toast(ok ? 'JSON copied ✓' : 'Copy failed', ok ? 'ok' : 'error'));
            });
            const dismissBtn = el('button', 'reach-btn reach-btn-primary reach-btn-sm', 'Close');
            foot.appendChild(copyBtn);
            foot.appendChild(dismissBtn);
            modal.appendChild(foot);

            overlay.appendChild(modal);
            document.body.appendChild(overlay);
            activeModal = overlay;

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

                    const clearBtn = el('button', 'reach-btn reach-btn-danger reach-btn-sm', 'Clear');
                    clearBtn.addEventListener('click', () => {
                        core.relayFetch('/_reach/logs', { method: 'DELETE' }, 5000)
                            .then(() => { toast('Log cleared ✓', 'ok'); draw(); });
                    });
                    toolbar.appendChild(clearBtn);

                    const count = el('span', 'reach-hint', logs.length + ' rows (click to inspect)');
                    toolbar.appendChild(count);
                    body.appendChild(toolbar);

                    const table = el('table', 'reach-table reach-table-logs');
                    table.innerHTML = '<thead><tr><th>Time</th><th>IP</th><th>Model</th><th>Status</th><th>Latency</th><th>In</th><th>Out</th><th>Error</th></tr></thead>';
                    const tbody = document.createElement('tbody');
                    logs.forEach(entry => {
                        const tr = document.createElement('tr');
                        tr.className = 'reach-log-row-clickable';
                        tr.title = 'Click to inspect full request payload';
                        tr.appendChild(el('td', 'reach-nowrap', core.fmtTime(entry.ts)));
                        tr.appendChild(el('td', null, entry.ip || '?'));
                        tr.appendChild(el('td', null, entry.model || '—'));
                        const statusTd = el('td', null, String(entry.status || '—'));
                        if (entry.status >= 500) statusTd.className = 'reach-kv-bad';
                        else if (entry.status >= 400) statusTd.className = 'reach-kv-warn';
                        else statusTd.className = 'reach-kv-ok';
                        tr.appendChild(statusTd);
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
                        td.colSpan = 8;
                        tr.appendChild(td);
                        tbody.appendChild(tr);
                    }
                    table.appendChild(tbody);
                    body.appendChild(table);
                })
                .catch(err => {
                    body.innerHTML = '';
                    body.appendChild(el('div', 'reach-banner reach-banner-off', 'Logs unavailable: ' + err.message));
                });
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
