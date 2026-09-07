/*
 * SimpleREACH pages — Models renderer.
 * Registers window.__reachPageRegistry.models.
 * Depends on window.__reachCore (reach-core.js) and
 * window.__reachPageWidgets (pages-common.js).
 */
(function initReachPageModels() {
    'use strict';

    const core = window.__reachCore;
    if (!core) {
        console.error('[simple-reach] reach-core.js missing — re-run install.');
        return;
    }
    const { el, esc, toast } = core;
    const { pageHeader, emptyNote } =
        window.__reachPageWidgets;

    /* ---------------------------------------------------------------- MODELS */
    function renderModels(container) {
        container.appendChild(pageHeader('fa-cubes', 'Models',
            'Public aliases and their upstream codegpt targets. Toggles apply instantly.'));
        const body = el('div', 'reach-stack');
        container.appendChild(body);
        let timer = null;

        function draw() {
            const cfg = core.store.settings;
            body.innerHTML = '';
            const card = el('section', 'reach-card');
            card.appendChild(el('header', 'reach-card-head', 'Served aliases'));
            if (!cfg || !cfg.models) {
                card.appendChild(emptyNote('Relay offline — cannot read the model table.'));
                body.appendChild(card);
                return;
            }
            const table = el('table', 'reach-table');
            table.innerHTML = '<thead><tr><th>Public alias</th><th>Upstream target &amp; specs</th><th>Live Test</th><th>Enabled</th><th></th><th></th></tr></thead>';
            const tbody = document.createElement('tbody');
            const entries = Object.entries(cfg.models).sort((a, b) => a[0].localeCompare(b[0]));
            entries.forEach(([alias, spec]) => {
                const tr = document.createElement('tr');

                // Alias + badges
                const aliasTd = document.createElement('td');
                const aliasStrong = el('strong', null, alias);
                aliasTd.appendChild(aliasStrong);
                if (spec.fallback) {
                    const fbBadge = el('span', 'reach-model-spec-badge', 'fallback: ' + spec.fallback);
                    aliasTd.appendChild(fbBadge);
                }
                tr.appendChild(aliasTd);

                // Upstream & specs
                const upTd = document.createElement('td');
                upTd.appendChild(document.createTextNode(spec.upstream || '—'));
                const ctxBadge = el('span', 'reach-model-spec-badge', (spec.context_window ? Math.round(spec.context_window / 1000) + 'k ctx' : '128k ctx'));
                upTd.appendChild(ctxBadge);
                tr.appendChild(upTd);

                // Ping Test TD
                const pingTd = document.createElement('td');
                const pingBtn = el('button', 'reach-btn reach-btn-sm reach-model-ping-btn');
                pingBtn.innerHTML = '<i class="fa-solid fa-bolt"></i> Ping';
                const pingTag = el('span', 'reach-model-ping-tag', '');
                pingTag.hidden = true;

                pingBtn.addEventListener('click', () => {
                    pingBtn.disabled = true;
                    pingBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';
                    const start = Date.now();
                    fetch(core.RELAY + '/v1/chat/completions', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            model: alias,
                            messages: [{ role: 'user', content: 'Ping' }],
                            max_tokens: 4
                        })
                    })
                        .then(r => r.json())
                        .then(d => {
                            const lat = Date.now() - start;
                            pingTag.hidden = false;
                            if (d.choices && d.choices[0]) {
                                pingTag.className = 'reach-model-ping-tag reach-chip-good';
                                pingTag.textContent = '✓ ' + core.fmtLatency(lat);
                                toast(alias + ' ping: ' + core.fmtLatency(lat), 'ok');
                            } else {
                                pingTag.className = 'reach-model-ping-tag reach-chip-bad';
                                pingTag.textContent = '✗ Error';
                                toast(alias + ': ' + (d.error?.message || 'failed'), 'error');
                            }
                        })
                        .catch(e => {
                            pingTag.hidden = false;
                            pingTag.className = 'reach-model-ping-tag reach-chip-bad';
                            pingTag.textContent = '✗ ' + e.message;
                            toast(alias + ': ' + e.message, 'error');
                        })
                        .finally(() => {
                            pingBtn.disabled = false;
                            pingBtn.innerHTML = '<i class="fa-solid fa-bolt"></i> Ping';
                        });
                });

                pingTd.appendChild(pingBtn);
                pingTd.appendChild(pingTag);
                tr.appendChild(pingTd);

                // Toggle
                const toggleTd = document.createElement('td');
                const toggle = el('label', 'reach-switch');
                const input = document.createElement('input');
                input.type = 'checkbox';
                input.checked = !!spec.enabled;
                input.addEventListener('change', () => {
                    core.saveSettings({ models: { [alias]: { enabled: input.checked } } })
                        .then(({ ok, data }) => {
                            if (ok) { toast('Model toggled ✓', 'ok'); core.loadSettings(); }
                            else toast('Failed: ' + esc((data && data.error && data.error.message) || ''), 'error');
                        });
                });
                const slider = el('span', 'reach-switch-slider');
                toggle.appendChild(input);
                toggle.appendChild(slider);
                toggleTd.appendChild(toggle);
                tr.appendChild(toggleTd);

                // Edit
                const editTd = document.createElement('td');
                const edit = el('button', 'reach-btn reach-btn-sm', 'Edit');
                edit.title = 'Open the full per-model editor in Settings';
                edit.addEventListener('click', () => {
                    core.prefsSet('model-edit', alias);
                    if (window.simpleReach && typeof window.simpleReach.switchPage === 'function') {
                        window.simpleReach.switchPage('settings', true);
                    }
                });
                editTd.appendChild(edit);
                tr.appendChild(editTd);

                // Remove
                const rmTd = document.createElement('td');
                const rm = el('button', 'reach-btn reach-btn-danger reach-btn-sm', 'Remove');
                rm.addEventListener('click', () => {
                    if (Object.keys(cfg.models).length <= 1) { toast('Keep at least one alias', 'error'); return; }
                    core.saveSettings({ models: { [alias]: null } }).then(({ ok, data }) => {
                        if (ok) {
                            toast('Removed ' + alias, 'ok');
                            core.loadSettings().then(draw);
                        } else {
                            toast('Failed: ' + esc((data && data.error && data.error.message) || ''), 'error');
                        }
                    });
                });
                rmTd.appendChild(rm);
                tr.appendChild(rmTd);

                tbody.appendChild(tr);
            });
            table.appendChild(tbody);
            card.appendChild(table);
            body.appendChild(card);

            const addCard = el('section', 'reach-card');
            addCard.appendChild(el('header', 'reach-card-head', 'Add alias'));
            const form = el('form', 'reach-form');
            form.addEventListener('submit', e => {
                e.preventDefault();
                const alias = aliasInput.value.trim();
                const upstream = upstreamInput.value.trim();
                if (!alias || !upstream) { toast('Both fields are required', 'error'); return; }
                core.saveSettings({ models: { [alias]: { upstream: upstream, enabled: true } } })
                    .then(({ ok, data }) => {
                        if (ok) {
                            toast('Alias added ✓', 'ok');
                            core.loadSettings().then(draw);
                        } else {
                            toast('Failed: ' + esc((data && data.error && data.error.message) || ''), 'error');
                        }
                    });
            });
            const row = el('div', 'reach-form-row');
            const aliasInput = document.createElement('input');
            aliasInput.placeholder = 'public alias (e.g. gpt-4o-mini)';
            aliasInput.className = 'reach-input';
            const upstreamInput = document.createElement('input');
            upstreamInput.placeholder = 'upstream (e.g. codegpt/codegpt-gpt-4o-mini)';
            upstreamInput.className = 'reach-input';
            row.appendChild(aliasInput);
            row.appendChild(upstreamInput);
            const submit = el('button', 'reach-btn reach-btn-primary reach-btn-sm', 'Add');
            submit.type = 'submit';
            row.appendChild(submit);
            form.appendChild(row);
            addCard.appendChild(form);
            addCard.appendChild(el('p', 'reach-copy', 'Upstream ids live in OmniRoute\'s /v1/models catalog.'));
            body.appendChild(addCard);
        }

        core.loadSettings().then(draw);
        timer = setInterval(() => core.loadSettings().then(draw), 30000);
        return () => { if (timer) clearInterval(timer); };
    }

    window.__reachPageRegistry.models = renderModels;
})();
