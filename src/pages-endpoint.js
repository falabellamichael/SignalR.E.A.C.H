/*
 * SignalR.E.A.C.H pages — Endpoint renderer.
 * Registers window.__reachPageRegistry.endpoint.
 * Depends on window.__reachCore (reach-core.js) and
 * window.__reachPageWidgets (pages-common.js).
 */
(function initReachPageEndpoint() {
    'use strict';

    const core = window.__reachCore;
    if (!core) {
        console.error('[signal-reach] reach-core.js missing — re-run install.');
        return;
    }
    const { el, esc, toast } = core;
    const { pageHeader, chip } =
        window.__reachPageWidgets;

    /* -------------------------------------------------------------- ENDPOINT */
    function renderEndpoint(container) {
        container.appendChild(pageHeader('fa-link', 'Endpoint',
            'The OpenAI-compatible surface. Use it from anything that speaks OpenAI.'));
        const body = el('div', 'reach-stack');
        container.appendChild(body);

        const urlCard = el('section', 'reach-card');
        urlCard.appendChild(el('header', 'reach-card-head', 'Base URL'));
        const urlRow = el('div', 'reach-url-row');
        const urlCode = el('code', 'reach-url', core.store.pointerUrl ? core.store.pointerUrl + '/v1' : 'resolving…');
        urlRow.appendChild(urlCode);
        const copyBtn = el('button', 'reach-btn reach-btn-sm', 'Copy');
        copyBtn.addEventListener('click', () => {
            if (core.store.pointerUrl) {
                core.copyText(core.store.pointerUrl + '/v1').then(ok => toast(ok ? 'Copied ✓' : 'Copy failed', ok ? 'ok' : 'error'));
            }
        });
        urlRow.appendChild(copyBtn);
        urlCard.appendChild(urlRow);
        const meta = el('div', 'reach-meta-row');
        meta.appendChild(chip('model: gpt-4o'));
        meta.appendChild(chip('tokens/s telemetry'));
        meta.appendChild(chip('unlimited · free'));
        meta.appendChild(chip('no API key'));
        urlCard.appendChild(meta);
        body.appendChild(urlCard);

        // --- Endpoint Diagnostics Card (PRD: Test Public Endpoint Reachability) ---
        const diagCard = el('section', 'reach-card');
        const diagHead = el('header', 'reach-card-head');
        diagHead.innerHTML = '<div style="display:flex;align-items:center;gap:8px;">'
            + '<i class="fa-solid fa-stethoscope" style="color:var(--reach-accent-light, #ffd37a);"></i>'
            + '<span>Endpoint Diagnostics</span></div>'
            + '<span class="reach-chip" id="diag-badge">idle</span>';
        diagCard.appendChild(diagHead);
        const diagBody = el('div', 'reach-card-body');
        diagBody.appendChild(el('p', 'reach-copy',
            'Probe the public pointer URL from the relay itself: TLS certificate validity, response headers, and a sample chat payload with round-trip timing. Verifies external clients can actually connect.'));
        const diagUrl = el('div', 'reach-url-row');
        const diagUrlCode = el('code', 'reach-url', core.store.pointerUrl || (core.store.local && core.store.local.public_url) || 'no public URL yet');
        diagUrl.appendChild(diagUrlCode);
        diagBody.appendChild(diagUrl);
        const diagResults = el('div', 'reach-diag-results');
        diagResults.hidden = true;
        diagBody.appendChild(diagResults);
        const diagFoot = el('div', 'reach-card-foot');
        const diagBtn = el('button', 'reach-btn reach-btn-primary reach-btn-sm');
        diagBtn.innerHTML = '<i class="fa-solid fa-satellite-dish"></i> Run Diagnostics';
        const diagBadge = diagHead.querySelector('#diag-badge');
        diagBtn.addEventListener('click', () => {
            diagBtn.disabled = true;
            diagBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Probing…';
            diagBadge.className = 'reach-chip';
            diagBadge.textContent = 'running…';
            diagResults.hidden = false;
            diagResults.innerHTML = '<p class="reach-hint">Contacting public endpoint…</p>';
            core.relayFetch('/_reach/diagnose', { method: 'POST' }, 90000)
                .then(res => res.json().then(data => ({ ok: res.ok, status: res.status, data })))
                .then(({ ok, status, data }) => {
                    diagResults.innerHTML = '';
                    if (data.url) {
                        const u = el('div', 'reach-hint', 'Target: ' + data.url + (data.total_ms != null ? ' — ' + data.total_ms + ' ms total' : ''));
                        diagResults.appendChild(u);
                    }
                    const checks = data.checks || [];
                    if (checks.length) {
                        const tbl = el('table', 'reach-table');
                        tbl.innerHTML = '<thead><tr><th>Check</th><th>Result</th><th>Detail</th></tr></thead>';
                        const tb = document.createElement('tbody');
                        checks.forEach(c => {
                            const tr = document.createElement('tr');
                            tr.appendChild(el('td', null, c.name || '—'));
                            const resTd = el('td', null, c.ok ? 'PASS' : 'FAIL');
                            resTd.className = c.ok ? 'reach-kv-ok' : 'reach-kv-bad';
                            tr.appendChild(resTd);
                            tr.appendChild(el('td', 'reach-hint', c.detail || ''));
                            tb.appendChild(tr);
                        });
                        tbl.appendChild(tb);
                        diagResults.appendChild(tbl);
                    }
                    if (data.error) {
                        const e = el('div', 'reach-banner reach-banner-off', 'Diagnostic error: ' + data.error);
                        diagResults.appendChild(e);
                    }
                    const passed = ok && data.ok;
                    diagBadge.className = 'reach-chip ' + (passed ? 'reach-chip-live' : 'reach-chip-warn');
                    diagBadge.textContent = passed ? 'reachable ✓' : 'failed ✗';
                    toast(passed ? 'Endpoint reachable ✓' : 'Diagnostics reported failures', passed ? 'ok' : 'error');
                })
                .catch(err => {
                    diagResults.innerHTML = '';
                    diagResults.appendChild(el('div', 'reach-banner reach-banner-off', 'Diagnostics unavailable: ' + err.message));
                    diagBadge.className = 'reach-chip reach-chip-warn';
                    diagBadge.textContent = 'error';
                    toast('Diagnostics failed: ' + err.message, 'error');
                })
                .finally(() => {
                    diagBtn.disabled = false;
                    diagBtn.innerHTML = '<i class="fa-solid fa-satellite-dish"></i> Run Diagnostics';
                });
        });
        diagFoot.appendChild(diagBtn);
        diagBody.appendChild(diagFoot);
        diagCard.appendChild(diagBody);
        body.appendChild(diagCard);

        // --- Interactive API Playground Card ---
        const playCard = el('section', 'reach-card');
        const playHead = el('header', 'reach-card-head');
        playHead.innerHTML = '<div style="display:flex;align-items:center;gap:8px;">'
            + '<i class="fa-solid fa-terminal" style="color:var(--reach-accent-light, #ffd37a);"></i>'
            + '<span>Interactive API Playground</span>'
            + '</div>'
            + '<span class="reach-chip reach-chip-live">Live</span>';
        playCard.appendChild(playHead);

        const playBody = el('div', 'reach-card-body reach-playground');

        // Sample Prompt Pills
        const pillsWrap = el('div', 'reach-playground-pills');
        const samplePrompts = [
            'Explain quantum computing in 1 sentence',
            'Write a haiku about local LLMs',
            'Generate a TypeScript interface for a User',
            'Reply with: REACH RELAY OK'
        ];
        samplePrompts.forEach(sp => {
            const p = el('button', 'reach-pill', sp);
            p.type = 'button';
            p.addEventListener('click', () => {
                promptInput.value = sp;
                promptInput.focus();
            });
            pillsWrap.appendChild(p);
        });
        playBody.appendChild(pillsWrap);

        // Prompt Input
        const promptInput = el('textarea', 'reach-playground-textarea');
        promptInput.placeholder = 'Type a message to test this endpoint…';
        promptInput.value = 'Explain how SignalR.E.A.C.H relays to OmniRoute in 2 brief bullets.';
        playBody.appendChild(promptInput);

        // Controls bar
        const ctrlBar = el('div', 'reach-playground-controls');

        // Model select
        const modelLabel = el('span', 'reach-hint', 'Model:');
        ctrlBar.appendChild(modelLabel);
        const modelSelect = el('select', 'reach-input reach-input-sm');
        const availModels = (core.store.local && core.store.local.models) || ['gpt-4o', 'gpt-4o-mini'];
        availModels.forEach(m => {
            const opt = document.createElement('option');
            opt.value = m;
            opt.textContent = m;
            modelSelect.appendChild(opt);
        });
        ctrlBar.appendChild(modelSelect);

        // Stream switch
        const streamLabel = el('label', 'reach-check');
        const streamCheck = document.createElement('input');
        streamCheck.type = 'checkbox';
        streamCheck.checked = true;
        streamLabel.appendChild(streamCheck);
        streamLabel.appendChild(document.createTextNode('Stream'));
        ctrlBar.appendChild(streamLabel);

        // Temperature
        const tempLabel = el('span', 'reach-hint', 'Temp:');
        ctrlBar.appendChild(tempLabel);
        const tempInput = el('input', 'reach-input reach-input-sm');
        tempInput.type = 'number';
        tempInput.min = '0';
        tempInput.max = '2';
        tempInput.step = '0.1';
        tempInput.value = '0.7';
        tempInput.style.width = '54px';
        ctrlBar.appendChild(tempInput);

        // Max tokens
        const maxLabel = el('span', 'reach-hint', 'Max tok:');
        ctrlBar.appendChild(maxLabel);
        const maxInput = el('input', 'reach-input reach-input-sm');
        maxInput.type = 'number';
        maxInput.min = '1';
        maxInput.max = '8192';
        maxInput.step = '64';
        maxInput.value = '512';
        maxInput.style.width = '64px';
        ctrlBar.appendChild(maxInput);

        // Send Button
        const sendBtn = el('button', 'reach-btn reach-btn-primary reach-btn-sm');
        sendBtn.innerHTML = '<i class="fa-solid fa-paper-plane"></i> Send';
        ctrlBar.appendChild(sendBtn);

        // Clear Button
        const clearBtn = el('button', 'reach-btn reach-btn-sm', 'Clear Console');
        ctrlBar.appendChild(clearBtn);

        playBody.appendChild(ctrlBar);

        // Console Output
        const consoleBox = el('div', 'reach-playground-console', '// Response stream will appear here…');
        playBody.appendChild(consoleBox);

        // Stats Bar
        const statsBar = el('div', 'reach-playground-stats');
        statsBar.innerHTML = '<span>Status: <strong class="reach-playground-stat-val" id="play-stat-status">Idle</strong></span>'
            + '<span>Latency: <strong class="reach-playground-stat-val" id="play-stat-lat">—</strong></span>'
            + '<span>Tokens: <strong class="reach-playground-stat-val" id="play-stat-tok">0</strong></span>'
            + '<span>Speed: <strong class="reach-playground-stat-val" id="play-stat-spd">—</strong></span>';
        playBody.appendChild(statsBar);

        clearBtn.addEventListener('click', () => {
            consoleBox.textContent = '// Console cleared';
            statsBar.querySelector('#play-stat-status').textContent = 'Idle';
            statsBar.querySelector('#play-stat-lat').textContent = '—';
            statsBar.querySelector('#play-stat-tok').textContent = '0';
            statsBar.querySelector('#play-stat-spd').textContent = '—';
        });

        sendBtn.addEventListener('click', () => {
            const prompt = promptInput.value.trim();
            if (!prompt) {
                toast('Please enter a prompt', 'warn');
                return;
            }
            const model = modelSelect.value || 'gpt-4o';
            const isStream = streamCheck.checked;
            const temp = parseFloat(tempInput.value) || 0.7;
            let maxTok = parseInt(maxInput.value, 10);
            if (isNaN(maxTok) || maxTok < 1) maxTok = 512;
            if (maxTok > 8192) maxTok = 8192;

            sendBtn.disabled = true;
            sendBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Sending…';
            consoleBox.textContent = '';
            statsBar.querySelector('#play-stat-status').textContent = isStream ? 'Streaming…' : 'Waiting…';

            const startTime = Date.now();
            let tokenCount = 0;

            const payload = {
                model: model,
                messages: [{ role: 'user', content: prompt }],
                stream: isStream,
                temperature: temp,
                max_tokens: maxTok
            };

            const targetUrl = core.RELAY + '/v1/chat/completions';

            if (!isStream) {
                fetch(targetUrl, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                })
                    .then(res => res.json().then(data => ({ ok: res.ok, status: res.status, data })))
                    .then(({ ok, status, data }) => {
                        const elapsed = Date.now() - startTime;
                        statsBar.querySelector('#play-stat-lat').textContent = core.fmtLatency(elapsed);
                        if (ok) {
                            const reply = data?.choices?.[0]?.message?.content || '';
                            consoleBox.textContent = reply;
                            const totalTok = data?.usage?.total_tokens || Math.ceil(reply.length / 4);
                            statsBar.querySelector('#play-stat-status').textContent = '200 OK';
                            statsBar.querySelector('#play-stat-tok').textContent = totalTok;
                            const spd = (totalTok / (elapsed / 1000)).toFixed(1);
                            statsBar.querySelector('#play-stat-spd').textContent = spd + ' tok/s';
                        } else {
                            consoleBox.textContent = 'Error ' + status + ':\n' + JSON.stringify(data, null, 2);
                            statsBar.querySelector('#play-stat-status').textContent = 'Error ' + status;
                        }
                    })
                    .catch(err => {
                        consoleBox.textContent = 'Network error: ' + err.message;
                        statsBar.querySelector('#play-stat-status').textContent = 'Net Error';
                    })
                    .finally(() => {
                        sendBtn.disabled = false;
                        sendBtn.innerHTML = '<i class="fa-solid fa-paper-plane"></i> Send';
                    });
            } else {
                fetch(targetUrl, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                })
                    .then(res => {
                        if (!res.ok) {
                            return res.text().then(t => {
                                throw new Error('HTTP ' + res.status + ': ' + t);
                            });
                        }
                        const reader = res.body ? res.body.getReader() : null;
                        if (!reader) throw new Error('ReadableStream unsupported in browser');

                        const decoder = new TextDecoder('utf-8');
                        let buffer = '';

                        function readChunk() {
                            return reader.read().then(({ done, value }) => {
                                if (done) {
                                    const elapsed = Date.now() - startTime;
                                    statsBar.querySelector('#play-stat-status').textContent = '200 OK';
                                    statsBar.querySelector('#play-stat-lat').textContent = core.fmtLatency(elapsed);
                                    const spd = elapsed > 0 ? (tokenCount / (elapsed / 1000)).toFixed(1) : '—';
                                    statsBar.querySelector('#play-stat-spd').textContent = spd + ' tok/s';
                                    return;
                                }
                                buffer += decoder.decode(value, { stream: true });
                                const lines = buffer.split('\n');
                                buffer = lines.pop();

                                for (const line of lines) {
                                    const trimmed = line.trim();
                                    if (!trimmed || trimmed.startsWith(':')) continue;
                                    if (trimmed === 'data: [DONE]') continue;
                                    if (trimmed.startsWith('data: ')) {
                                        try {
                                            const json = JSON.parse(trimmed.slice(6));
                                            const delta = json.choices?.[0]?.delta?.content;
                                            if (delta) {
                                                consoleBox.textContent += delta;
                                                consoleBox.scrollTop = consoleBox.scrollHeight;
                                                tokenCount += 1;
                                                statsBar.querySelector('#play-stat-tok').textContent = tokenCount;
                                                const elapsed = Date.now() - startTime;
                                                statsBar.querySelector('#play-stat-lat').textContent = core.fmtLatency(elapsed);
                                            }
                                        } catch (_e) {}
                                    }
                                }
                                return readChunk();
                            });
                        }

                        return readChunk();
                    })
                    .catch(err => {
                        consoleBox.textContent = 'Stream error:\n' + err.message;
                        statsBar.querySelector('#play-stat-status').textContent = 'Error';
                    })
                    .finally(() => {
                        sendBtn.disabled = false;
                        sendBtn.innerHTML = '<i class="fa-solid fa-paper-plane"></i> Send';
                    });
            }
        });

        playCard.appendChild(playBody);
        body.appendChild(playCard);

        const addCard = el('section', 'reach-card');
        addCard.appendChild(el('header', 'reach-card-head', 'One-click SimpleRAG hookup'));
        const addBody = el('div', 'reach-card-body');
        addBody.appendChild(el('p', 'reach-copy', 'Register this endpoint in SimpleRAG\'s endpoint list (idempotent — re-running just refreshes it).'));
        const addFoot = el('div', 'reach-card-foot');
        const addBtn = el('button', 'reach-btn reach-btn-primary reach-btn-sm', 'Add to SimpleRAG');
        addBtn.addEventListener('click', () => {
            const url = core.store.pointerUrl;
            if (!url) { toast('No public URL yet', 'error'); return; }
            addBtn.disabled = true;
            addBtn.textContent = 'Adding…';
            fetch(core.API_BASE + '/model-endpoints', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    name: 'SignalR.E.A.C.H (REACH)',
                    base_url: url + '/v1',
                    api_key: '',
                    default_model: 'gpt-4o'
                })
            })
                .then(res => res.json().then(data => ({ ok: res.ok, data: data })))
                .then(({ ok, data }) => {
                    if (ok) {
                        toast('Added ✓ — pick "SignalR.E.A.C.H (REACH)" as your active model', 'ok');
                    } else {
                        toast('Add failed: ' + esc((data && data.detail) || 'unknown error'), 'error');
                    }
                })
                .catch(err => toast('Add failed: ' + err.message, 'error'))
                .finally(() => { addBtn.disabled = false; addBtn.textContent = 'Add to SimpleRAG'; });
        });
        addFoot.appendChild(addBtn);
        addBody.appendChild(addFoot);
        addCard.appendChild(addBody);
        body.appendChild(addCard);

        const docsCard = el('section', 'reach-card');
        docsCard.appendChild(el('header', 'reach-card-head', 'Routes'));
        const table = el('table', 'reach-table');
        table.innerHTML = '<thead><tr><th>Method</th><th>Path</th><th>Description</th></tr></thead><tbody>' +
            '<tr><td>GET</td><td><code>/health</code></td><td>liveness + status (never gated)</td></tr>' +
            '<tr><td>GET</td><td><code>/v1/models</code></td><td>enabled model aliases</td></tr>' +
            '<tr><td>POST</td><td><code>/v1/chat/completions</code></td><td>chat — stream &amp; non-stream, rate-limited</td></tr>' +
            '<tr><td>GET</td><td><code>/status</code></td><td>rich status snapshot</td></tr>' +
            '</tbody>';
        docsCard.appendChild(table);
        body.appendChild(docsCard);

        const usageCard = el('section', 'reach-card');
        usageCard.appendChild(el('header', 'reach-card-head', 'Code snippets'));
        const tabs = el('div', 'reach-usage-tabs');
        ['curl', 'python', 'javascript', 'simplerag'].forEach((tab, idx) => {
            const b = el('button', 'reach-tab' + (idx === 0 ? ' reach-tab-active' : ''), tab === 'simplerag' ? 'SimpleRAG' : tab);
            b.dataset.tab = tab;
            b.addEventListener('click', () => {
                tabs.querySelectorAll('.reach-tab').forEach(t => t.classList.remove('reach-tab-active'));
                b.classList.add('reach-tab-active');
                usageCard.querySelectorAll('.reach-snippet').forEach(s => { s.hidden = s.dataset.snip !== tab; });
            });
            tabs.appendChild(b);
        });
        usageCard.appendChild(tabs);
        const U = () => (core.store.pointerUrl || 'https://YOUR-PUBLIC-URL');
        const renderedUrl = U();
        const snips = [
            { id: 'curl', text: 'curl ' + renderedUrl + '/v1/chat/completions \\\n  -H "Content-Type: application/json" \\\n  -d \'{"model":"gpt-4o","messages":[{"role":"user","content":"Hello!"}]}\'' },
            { id: 'python', text: 'from openai import OpenAI\n\nclient = OpenAI(base_url="' + renderedUrl + '/v1", api_key="not-needed")\nreply = client.chat.completions.create(\n    model="gpt-4o",\n    messages=[{"role": "user", "content": "Hello!"}],\n)\nprint(reply.choices[0].message.content)' },
            { id: 'javascript', text: 'const res = await fetch("' + renderedUrl + '/v1/chat/completions", {\n  method: "POST",\n  headers: { "Content-Type": "application/json" },\n  body: JSON.stringify({ model: "gpt-4o",\n    messages: [{ role: "user", content: "Hello!" }] }),\n});\nconst data = await res.json();\nconsole.log(data.choices[0].message.content);' },
            { id: 'simplerag', text: '1. Endpoint settings → add OpenAI-compatible\n2. Base URL: ' + renderedUrl + '/v1\n3. Model: gpt-4o\n4. API key: leave blank\n5. Save + select as active model\n(or just hit "Add to SimpleRAG" above)' }
        ];
        snips.forEach(s => {
            const pre = el('pre', 'reach-snippet');
            pre.dataset.snip = s.id;
            pre.hidden = s.id !== 'curl';
            pre.appendChild(el('code', null, s.text));
            usageCard.appendChild(pre);
        });
        body.appendChild(usageCard);

        core.refreshPointer().then(() => {
            const fresh = core.store.pointerUrl;
            if (!fresh || fresh === renderedUrl) {
                urlCode.textContent = fresh ? fresh + '/v1' : urlCode.textContent;
                return;
            }
            urlCode.textContent = fresh + '/v1';
            usageCard.querySelectorAll('.reach-snippet code').forEach(code => {
                code.textContent = code.textContent.split(renderedUrl).join(fresh);
            });
        });
        return () => {};
    }

    window.__reachPageRegistry.endpoint = renderEndpoint;
})();
