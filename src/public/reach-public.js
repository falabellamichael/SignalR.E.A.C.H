/* SignalREACH public edition. Connections are entered by the user; secrets stay
 * in SimpleRAG's existing endpoint storage, never in extension preferences. */
(function registerPublicReach() {
    'use strict';
    const manifest = window.__signalReachPublicManifest;
    const host = window.RAGWorkspaceExtensions;
    if (!manifest || !host || window.signalReachPublic) return;

    const APP_ID = 'signal-reach-public';
    const PREFS_KEY = 'signal-reach-public.preferences.v1';
    const API = '/api/extensions/rag-workspace';
    const SETTINGS_HUB_URL = 'http://127.0.0.1:21309';
    let context = null;
    let root = null;
    const PAGES = [
        ['usage', 'Usage', 'fa-chart-column'],
        ['playground', 'Playground', 'fa-comment-dots'],
        ['settings', 'Settings', 'fa-sliders']
    ];
    const PAGE_ALIASES = { dashboard: 'usage', endpoint: 'settings', models: 'settings', logs: 'playground',
        'shared-settings': 'settings', about: 'settings' };
    let activePage = 'usage';
    let generation = 0;
    let pending = null;
    let active = false;
    let savedConnections = null;
    let connectionStatus = 'Not checked';
    let promptDraft = '';
    let lastResponse = '';
    const activity = [];
    let usageData = null;
    let usageEndpointId = '';
    let usageController = null;
    let usageError = '';
    const safeRate = value => typeof value === 'string' && /^(?:\d{1,8})(?:\.\d{1,8})?$/.test(value) ? value : '';
    function readStatistics(value) {
        const v = value && typeof value === 'object' ? value : {};
        const rates = Object.create(null);
        if (v.rates && typeof v.rates === 'object') Object.keys(v.rates).slice(0,100).forEach(key => {
            const r = v.rates[key];
            if (r && typeof r === 'object' && key.length < 600) rates[key] = {
                input: safeRate(r.input), output: safeRate(r.output), cached: safeRate(r.cached),
                currency: r.currency === 'CAD' ? 'CAD' : 'USD'
            };
        });
        return { endpointId: typeof v.endpointId === 'string' ? v.endpointId : '',
            comparisonId: typeof v.comparisonId === 'string' ? v.comparisonId : '',
            model: typeof v.model === 'string' ? v.model.slice(0,256) : '',
            days: [7,30,90].includes(v.days) ? v.days : 30, cadPerUsd: safeRate(v.cadPerUsd), rates };
    }

    function readPreferences() {
        try {
            const saved = JSON.parse(localStorage.getItem(PREFS_KEY) || '{}');
            if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return {};
            const defaults = Object.create(null);
            if (saved.defaults && typeof saved.defaults === 'object' && !Array.isArray(saved.defaults)) {
                Object.keys(saved.defaults).filter(model => model && model.length <= 256).forEach(model => {
                    const entry = saved.defaults[model];
                    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return;
                    defaults[model] = {
                        temperature: typeof entry.temperature === 'number' && Number.isFinite(entry.temperature)
                            && entry.temperature >= 0 && entry.temperature <= 2 ? entry.temperature : 0.7,
                        maxOutputTokens: Number.isInteger(entry.maxOutputTokens) && entry.maxOutputTokens > 0
                            && entry.maxOutputTokens <= 32768 ? entry.maxOutputTokens : 1024
                    };
                });
            }
            return {
                endpointId: typeof saved.endpointId === 'string' ? saved.endpointId : '',
                name: typeof saved.name === 'string' ? saved.name : '',
                baseUrl: typeof saved.baseUrl === 'string' ? saved.baseUrl : '',
                model: typeof saved.model === 'string' && saved.model.length <= 256 ? saved.model : '',
                defaults, statistics: readStatistics(saved.statistics)
            };
        } catch (_error) { return {}; }
    }
    const preferences = Object.assign({ endpointId: '', name: '', baseUrl: '', model: '', defaults: {} }, readPreferences());
    const statistics = readStatistics(preferences.statistics);
    const models = new Set(preferences.model ? [preferences.model] : []);

    function savePreferences() {
        // Whitelist fields; never serialize endpoint responses or API keys.
        const defaults = Object.create(null);
        Object.keys(preferences.defaults).forEach(model => {
            const entry = preferences.defaults[model] || {};
            defaults[model] = { temperature: entry.temperature, maxOutputTokens: entry.maxOutputTokens };
        });
        localStorage.setItem(PREFS_KEY, JSON.stringify({
            endpointId: preferences.endpointId, name: preferences.name,
            baseUrl: preferences.baseUrl, model: preferences.model, defaults, statistics
        }));
    }

    function element(tag, className, text) {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined) node.textContent = text;
        return node;
    }
    function field(label, input, hint) {
        const wrap = element('label', 'sr-public-field');
        wrap.appendChild(element('span', '', label));
        wrap.appendChild(input);
        if (hint) wrap.appendChild(element('small', '', hint));
        return wrap;
    }
    function input(type, value, placeholder) {
        const node = element('input');
        node.type = type;
        node.value = value || '';
        if (placeholder) node.placeholder = placeholder;
        return node;
    }
    function select(options, value) {
        const node = element('select');
        const choices = options.slice();
        if (value !== undefined && !choices.some(choice => String(choice[0]) === String(value))) {
            choices.push([value, String(value) + ' (saved)']);
        }
        choices.forEach(([key, label]) => {
            const option = element('option', '', label);
            option.value = String(key);
            node.appendChild(option);
        });
        if (value !== undefined) node.value = String(value);
        return node;
    }
    function button(text, handler, className) {
        const node = element('button', className || 'sr-public-button', text);
        node.type = 'button';
        node.addEventListener('click', handler);
        return node;
    }
    function status(message, error) {
        const node = root && root.querySelector('[data-status]');
        if (node) {
            node.textContent = message;
            node.classList.toggle('sr-public-error', !!error);
        }
    }
    function normalizeUrl(raw) {
        const url = new URL(raw.trim());
        const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
        if (url.username || url.password || url.search || url.hash) throw new Error('Enter a base URL without credentials, a query, or a fragment.');
        if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) throw new Error('Use HTTPS for a provider, or HTTP for a local model on this computer.');
        return url.href.replace(/\/+$/, '');
    }
    async function request(path, body, signal) {
        const options = { credentials: 'same-origin', redirect: 'error', signal };
        if (body !== undefined) {
            options.method = 'POST';
            options.headers = { 'Content-Type': 'application/json' };
            options.body = JSON.stringify(body);
        }
        const response = await fetch(API + path, options);
        const data = await response.json();
        if (!response.ok) {
            // Do not echo server errors that might contain a provider credential.
            throw new Error('SimpleRAG could not complete the request (HTTP ' + response.status + '). Check the connection in SimpleRAG settings.');
        }
        return data;
    }
    async function action(control, job) {
        control.disabled = true;
        const currentGeneration = generation;
        try { await job(); }
        catch (error) {
            if (generation === currentGeneration) status(error.name === 'AbortError' ? 'Request stopped.' : error.message, true);
        }
        finally { control.disabled = false; }
    }
    function card(title, description) {
        const node = element('section', 'sr-public-card');
        node.appendChild(element('h2', '', title));
        if (description) node.appendChild(element('p', 'sr-public-hint', description));
        root.appendChild(node);
        return node;
    }
    function modelDefaults(model) {
        if (!Object.prototype.hasOwnProperty.call(preferences.defaults, model)) {
            Object.defineProperty(preferences.defaults, model, { value: { temperature: 0.7, maxOutputTokens: 1024 }, enumerable: true, writable: true, configurable: true });
        }
        return preferences.defaults[model];
    }

    async function loadConnections(signal) {
        const data = await request('/model-endpoints', undefined, signal);
        if (!Array.isArray(data)) throw new Error('SimpleRAG did not return saved connections.');
        return data.filter(item => item && typeof item.id === 'string' && item.is_enabled !== false).flatMap(item => {
            try {
                return [{ id: item.id, name: String(item.name || 'Saved connection'),
                    baseUrl: normalizeUrl(item.base_url), model: typeof item.default_model === 'string' ? item.default_model : '',
                    models: (Array.isArray(item.chat_models) ? item.chat_models : Array.isArray(item.models) ? item.models : [])
                        .filter(model => typeof model === 'string' && model && model.length <= 256) }];
            } catch (_error) { return []; }
        });
    }

    function renderSettings() {
        const existing = card('Use a saved SimpleRAG connection', 'Choose a connection you already use in SimpleRAG. Its key stays in SimpleRAG.');
        const load = button('Load saved connections', () => action(load, async () => {
            savedConnections = await loadConnections();
            render();
            status(savedConnections.length ? 'Choose a connection, then select Use connection.' : 'No compatible saved connections. Add a connection below.');
        }));
        existing.appendChild(load);
        if (savedConnections && savedConnections.length) {
            const choices = select([['', 'Choose a saved connection'], ...savedConnections.map(item => [item.id, item.name])], '');
            existing.appendChild(field('Saved connection', choices));
            existing.appendChild(button('Use connection', () => {
                const chosen = savedConnections.find(item => item.id === choices.value);
                if (!chosen) return status('Choose a saved connection first.', true);
                if (preferences.endpointId !== chosen.id) {
                    preferences.defaults = {};
                    lastResponse = '';
                }
                preferences.endpointId = chosen.id;
                preferences.name = chosen.name;
                preferences.baseUrl = chosen.baseUrl;
                preferences.model = chosen.model;
                models.clear();
                chosen.models.forEach(model => models.add(model));
                if (preferences.model) models.add(preferences.model);
                connectionStatus = 'Not checked';
                savePreferences();
                render();
                status('Connection selected. Refresh models to check availability.');
            }, 'sr-public-button sr-public-primary'));
        }
        const connection = card('Your connection', 'Use your own account or a local model. Saving adds this connection to SimpleRAG; an existing connection at the same URL is updated.');
        const grid = element('div', 'sr-public-grid');
        const name = input('text', preferences.name, 'My provider');
        const url = input('url', preferences.baseUrl, 'Provider base URL, including /v1 if required');
        const key = input('password', '', 'Enter your API key; leave empty for a local model');
        key.autocomplete = 'off';
        grid.appendChild(field('Connection name', name));
        grid.appendChild(field('Base URL', url));
        grid.appendChild(field('Your API key', key, 'Saved by SimpleRAG. The extension does not keep a copy.'));
        connection.appendChild(grid);
        const save = button('Save connection', () => action(save, async () => {
            const baseUrl = normalizeUrl(url.value);
            const data = await request('/model-endpoints', {
                name: name.value.trim() || 'SignalREACH - my provider', base_url: baseUrl,
                api_key: key.value.trim(), default_model: '',
                category: new URL(baseUrl).protocol === 'https:' ? 'api' : 'local',
                endpoint_kind: 'openai-compatible', model_type: 'llm', skip_probe: true
            });
            if (!data || typeof data.id !== 'string' || !data.id) throw new Error('SimpleRAG returned an invalid connection.');
            if (preferences.endpointId !== data.id) {
                preferences.model = '';
                preferences.defaults = {};
                models.clear();
            }
            preferences.endpointId = data.id;
            preferences.name = name.value.trim() || 'SignalREACH - my provider';
            preferences.baseUrl = baseUrl;
            connectionStatus = 'Not checked';
            key.value = '';
            savePreferences();
            render();
            status('Connection saved. Refresh models to choose a default.');
        }), 'sr-public-button sr-public-primary');
        connection.appendChild(save);
        renderModels();
        const shared = element('details', 'sr-public-details');
        shared.appendChild(element('summary', '', 'Shared Studio and VS Code settings'));
        shared.appendChild(sharedSettingsLink());
        const sync = element('iframe', 'sr-public-sync-frame');
        sync.title = 'Sync Studio and VS Code settings';
        sync.src = SETTINGS_HUB_URL + '/sync';
        sync.loading = 'lazy';
        shared.appendChild(sync);
        root.appendChild(shared);
        root.appendChild(element('p', 'sr-public-hint', 'SignalREACH · Public edition · v' + manifest.version));
    }

    async function refreshModels() {
        if (!preferences.endpointId) throw new Error('Choose or save a connection in Settings first.');
        const endpointId = preferences.endpointId;
        try {
            const data = await request('/model-endpoints/' + encodeURIComponent(endpointId) + '/models?refresh=true');
            if (endpointId !== preferences.endpointId) return;
            const list = Array.isArray(data.chat_models) ? data.chat_models : data.models;
            if (!Array.isArray(list)) throw new Error('SimpleRAG did not return a model list. You can enter a model ID manually.');
            models.clear();
            list.filter(model => typeof model === 'string' && model && model.length <= 256).forEach(model => models.add(model));
            const available = models.size;
            if (preferences.model) models.add(preferences.model);
            connectionStatus = data.online === false ? 'Offline' : available ? 'Models available' : 'No models returned';
            render();
            status(available + ' model choices available.');
        } catch (error) {
            if (endpointId === preferences.endpointId) { connectionStatus = 'Check failed'; renderSidebar(); }
            throw error;
        }
    }

    function renderModels() {
        const settings = card('Model defaults', 'Choose a default for this connection. Temperature and output length apply to prompts sent from this playground.');
        const controls = element('div', 'sr-public-grid');
        const defaultModel = select([['', 'Select a model'], ...Array.from(models).sort().map(model => [model, model])], preferences.model);
        controls.appendChild(field('Default model', defaultModel));
        const custom = input('text', '', 'Exact model ID');
        const customGroup = element('details', 'sr-public-details');
        customGroup.appendChild(element('summary', '', 'Enter a model ID manually'));
        customGroup.appendChild(field('Model ID', custom));
        customGroup.appendChild(button('Use model', () => {
            const model = custom.value.trim();
            if (!model || model.length > 256) return status('Enter a model ID of up to 256 characters.', true);
            models.add(model);
            preferences.model = model;
            render();
            status('Model selected. Save model settings to apply it.');
        }));
        settings.appendChild(controls);
        settings.appendChild(customGroup);
        const refresh = button('Refresh models', () => action(refresh, refreshModels));
        refresh.disabled = !preferences.endpointId;
        settings.appendChild(refresh);
        defaultModel.addEventListener('change', () => { preferences.model = defaultModel.value; render(); });

        Array.from(models).sort().forEach(model => {
            const details = element('details', 'sr-public-details');
            details.appendChild(element('summary', '', model + (model === preferences.model ? ' · default' : '')));
            const defaults = modelDefaults(model);
            const fields = element('div', 'sr-public-grid');
            const temperature = select([[0, '0 · precise'], [0.3, '0.3'], [0.7, '0.7 · balanced'], [1, '1'], [1.5, '1.5'], [2, '2 · varied']], defaults.temperature);
            temperature.addEventListener('change', () => { defaults.temperature = Number(temperature.value); });
            const tokens = select([[256, '256 tokens'], [512, '512 tokens'], [1024, '1,024 tokens'], [2048, '2,048 tokens'], [4096, '4,096 tokens'], [8192, '8,192 tokens']], defaults.maxOutputTokens);
            tokens.addEventListener('change', () => { defaults.maxOutputTokens = Number(tokens.value); });
            fields.appendChild(field('Temperature', temperature));
            fields.appendChild(field('Output length', tokens));
            details.appendChild(fields);
            settings.appendChild(details);
        });
        const saveModels = button('Save model settings', () => action(saveModels, async () => {
            if (!preferences.endpointId || !preferences.model) throw new Error('Save your connection and select a default model first.');
            await request('/model-endpoints/' + encodeURIComponent(preferences.endpointId), { default_model: preferences.model });
            savePreferences();
            status('Model defaults saved.');
        }), 'sr-public-button sr-public-primary');
        settings.appendChild(saveModels);
    }

    function navigate(page) {
        page = PAGE_ALIASES[page] || page;
        if (!PAGES.some(item => item[0] === page)) return;
        if (page !== activePage) deactivateRequest();
        activePage = page;
        if (context && context.state) context.state.folder = page;
        render();
    }

    function navigation(className) {
        const nav = element('nav', className);
        nav.setAttribute('aria-label', 'SignalREACH navigation');
        PAGES.forEach(([id, label, icon]) => {
            const item = button('', () => navigate(id), 'sr-public-nav-item');
            const symbol = element('i', 'fa-solid ' + icon);
            symbol.setAttribute('aria-hidden', 'true');
            item.appendChild(symbol);
            item.appendChild(element('span', '', label));
            item.setAttribute('aria-current', activePage === id ? 'page' : 'false');
            nav.appendChild(item);
        });
        return nav;
    }

    function renderNavigation() {
        if (!active) return;
        const elements = context && context.elements || {};
        if (elements.navTitle) elements.navTitle.textContent = 'SignalREACH';
        if (elements.navFolderList) elements.navFolderList.replaceChildren(navigation('sr-public-nav'));
    }

    function summary(parent, label, value) {
        const item = element('div', 'sr-public-summary');
        item.appendChild(element('span', 'sr-public-hint', label));
        item.appendChild(element('strong', '', value));
        parent.appendChild(item);
    }

    function sharedSettingsLink() {
        const link = element('a', 'sr-public-button sr-public-primary', 'Open shared settings hub');
        link.href = SETTINGS_HUB_URL + '/';
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        return link;
    }

    function renderSidebar() {
        if (!active) return;
        const elements = context && context.elements || {};
        if (elements.listTitle) elements.listTitle.textContent = 'At a glance';
        if (!elements.listContent) return;
        const panel = element('div', 'sr-public-sidebar');
        const info = element('section', 'sr-public-card');
        info.appendChild(element('h2', '', preferences.name || 'Your connection'));
        info.appendChild(element('span', 'sr-public-badge', preferences.endpointId ? connectionStatus : 'Setup needed'));
        summary(info, 'Default model', preferences.model || 'Not selected');
        summary(info, 'Model choices', String(models.size));
        panel.appendChild(info);
        panel.appendChild(element('p', 'sr-public-hint', 'Usage shows your REACH account statistics. Settings brings connections and model controls together.'));
        elements.listContent.replaceChildren(panel);
    }

    function renderUsage() {
        const toolbar = card('Your usage, in numbers', 'REACH account totals for the selected period, across apps using this account.');
        const controls = element('div', 'sr-public-grid');
        const endpoints = savedConnections || [];
        const account = select([['', 'Choose your saved REACH connection'], ...endpoints.map(e => [e.id, e.name])], statistics.endpointId);
        account.addEventListener('change', () => {
            deactivateRequest();
            statistics.endpointId = account.value;
            if (statistics.comparisonId === account.value) { statistics.comparisonId = ''; statistics.model = ''; }
            usageData = null; usageError = ''; savePreferences(); render();
        });
        controls.appendChild(field('REACH account connection', account));
        const period = select([[7, 'Last 7 days'], [30, 'Last 30 days'], [90, 'Last 90 days']], statistics.days);
        period.addEventListener('change', () => { deactivateRequest(); statistics.days = Number(period.value); usageData = null; savePreferences(); render(); });
        controls.appendChild(field('Reporting period', period));
        toolbar.appendChild(controls);
        const refresh = button('Refresh statistics', () => action(refresh, async () => {
            const current = ++generation;
            usageController?.abort();
            const controller = new AbortController(); usageController = controller;
            usageError = '';
            try {
                const connections = await loadConnections(controller.signal);
                if (current !== generation) return;
                savedConnections = connections;
                const chosenId = statistics.endpointId || preferences.endpointId;
                if (!connections.some(e => e.id === chosenId)) {
                    usageData = null; render(); status('Choose your REACH connection, then refresh its statistics.'); return;
                }
                statistics.endpointId = chosenId;
                const report = await request('/model-endpoints/' + encodeURIComponent(chosenId)
                    + '/reach-usage?days=' + statistics.days, undefined, controller.signal);
                if (current !== generation || chosenId !== statistics.endpointId) return;
                validateUsage(report);
                usageData = report; usageEndpointId = chosenId; savePreferences(); render();
                status('Statistics updated.');
            } catch (error) {
                if (current !== generation) return;
                usageData = null;
                usageError = error.name === 'AbortError' ? 'Refresh stopped.'
                    : 'Statistics unavailable. Choose a REACH connection with a valid account key. SimpleRAG and the REACH service must support usage summaries.';
                render(); status(usageError, true);
            } finally { if (usageController === controller) usageController = null; }
        }), 'sr-public-button sr-public-primary');
        toolbar.appendChild(refresh);
        if (!savedConnections) toolbar.appendChild(element('p', 'sr-public-hint', 'Refresh loads the connections already saved in SimpleRAG. No keys are copied into this panel.'));
        const report = usageEndpointId === statistics.endpointId ? usageData : null;
        const tiles = element('div', 'sr-public-tiles sr-public-stat-tiles');
        const subscriptions = report?.spending.subscriptions || [];
        summary(tiles, 'Subscription payments · net', report ? subscriptions.map(s => money(s.netMicros / 1e6, s.currency)).join(' + ') || money(0, 'USD') : '—');
        summary(tiles, 'Crypto credit used', report ? money(report.spending.rchUsdMicros / 1e6, 'USD') : '—');
        summary(tiles, 'Other credit used', report ? money((report.spending.creditUsdMicros - report.spending.rchUsdMicros) / 1e6, 'USD') : '—');
        summary(tiles, 'Completed requests', report ? number(report.requests.completed) : '—');
        root.appendChild(tiles);
        if (usageError) root.appendChild(element('p', 'sr-public-error', usageError));
        if (report) {
            const details = element('div', 'sr-public-tiles');
            summary(details, 'Input tokens', number(report.tokens.input));
            summary(details, 'Output tokens', number(report.tokens.output));
            summary(details, 'Cached input', number(report.tokens.cachedInput));
            summary(details, 'Measured requests', number(report.requests.measured) + ' / ' + number(report.requests.completed));
            root.appendChild(details);
        }
        renderComparison(report, endpoints);
        if (!report) {
            root.appendChild(element('p', 'sr-public-hint', 'Refresh your account statistics to see recorded spending and usage. Unavailable figures are not treated as zero.'));
            return;
        }
        const ledger = card('Period breakdown', new Date(report.period.from).toLocaleDateString() + ' – '
            + new Date(report.period.to).toLocaleDateString() + ' · By the date each request or payment was recorded.');
        const funding = element('div', 'sr-public-tiles');
        summary(funding, 'Crypto redeemed · credit value', money(report.redemptions.creditUsdMicros / 1e6, 'USD'));
        summary(funding, 'Subscription refunds', subscriptions.map(s => money(s.refundedMicros / 1e6, s.currency)).join(' + ') || money(0, 'USD'));
        summary(funding, 'Pending or unresolved', number(report.requests.pending));
        summary(funding, 'Released requests', number(report.requests.released));
        ledger.appendChild(funding);
        ledger.appendChild(element('p', 'sr-public-hint', 'Redeemed value is the credit granted at redemption, not your crypto purchase price or gas fees. Only credit used is included in the spending comparison. Subscription payments are net of recorded refunds.'));
        if (report.spending.unpricedCreditTokens) ledger.appendChild(element('p', 'sr-public-hint', number(report.spending.unpricedCreditTokens)
            + ' older token credits were used without a recorded cash value. A complete money comparison is unavailable for this period.'));
        const tableWrap = element('div', 'sr-public-table-wrap');
        const table = element('table', 'sr-public-table');
        const caption = element('caption', '', 'Usage by REACH model'); table.appendChild(caption);
        const head = element('thead'); const headings = element('tr');
        ['Model', 'Requests', 'Input tokens', 'Output tokens', 'Measured'].forEach(label => {
            const th = element('th', '', label); th.scope = 'col'; headings.appendChild(th);
        });
        head.appendChild(headings); table.appendChild(head);
        const body = element('tbody');
        report.models.forEach(model => {
            const row = element('tr');
            [model.model, number(model.requests), number(model.inputTokens), number(model.outputTokens), number(model.measured) + ' / ' + number(model.requests)]
                .forEach(value => row.appendChild(element('td', '', value)));
            body.appendChild(row);
        });
        table.appendChild(body); tableWrap.appendChild(table); ledger.appendChild(tableWrap);
        if (!report.models.length) ledger.appendChild(element('p', 'sr-public-hint', 'No completed model requests in this period.'));
    }

    const number = value => new Intl.NumberFormat('en-CA').format(value);
    const money = (value, currency) => new Intl.NumberFormat('en-CA', { style: 'currency', currency,
        currencyDisplay: 'code', maximumFractionDigits: 4 }).format(value);
    function validateUsage(report) {
        const count = value => Number.isSafeInteger(value) && value >= 0;
        if (!report || !report.period || !Number.isFinite(Date.parse(report.period.from)) || !Number.isFinite(Date.parse(report.period.to))
            || !report.requests || !['completed','pending','released','measured'].every(k => count(report.requests[k]))
            || report.requests.measured > report.requests.completed || !report.tokens || !['input','output','cachedInput'].every(k => count(report.tokens[k]))
            || report.tokens.cachedInput > report.tokens.input || !report.spending
            || !['creditUsdMicros','rchUsdMicros','unpricedCreditTokens'].every(k => count(report.spending[k]))
            || report.spending.rchUsdMicros > report.spending.creditUsdMicros
            || !Array.isArray(report.spending.subscriptions) || !report.spending.subscriptions.every(s => ['USD','CAD'].includes(s.currency)
                && ['paidMicros','refundedMicros','netMicros'].every(k => count(s[k])) && s.netMicros === s.paidMicros - s.refundedMicros)
            || !report.redemptions || !count(report.redemptions.creditUsdMicros) || !Array.isArray(report.models)
            || !report.models.every(m => typeof m.model === 'string' && ['requests','measured','inputTokens','outputTokens','cachedInputTokens'].every(k => count(m[k])))) {
            throw new Error('Invalid usage summary.');
        }
    }
    function renderComparison(report, endpoints) {
        const comparison = card('What would the same usage cost?', 'Choose an API and model already saved in SimpleRAG. This estimates the same token volume; model capabilities may differ.');
        const choices = endpoints.filter(e => e.id !== statistics.endpointId);
        const provider = select([['', 'Choose a comparison API'], ...choices.map(e => [e.id, e.name])], statistics.comparisonId);
        provider.addEventListener('change', () => {
            statistics.comparisonId = provider.value;
            statistics.model = choices.find(e => e.id === provider.value)?.model || '';
            savePreferences(); render();
        });
        const selected = choices.find(e => e.id === statistics.comparisonId);
        const modelNames = [...new Set([...(selected?.models || []), selected?.model].filter(Boolean))];
        const model = select([['', 'Choose a model'], ...modelNames.map(name => [name, name])], statistics.model);
        model.addEventListener('change', () => { statistics.model = model.value; savePreferences(); render(); });
        const grid = element('div', 'sr-public-grid');
        grid.appendChild(field('Compare with API', provider)); grid.appendChild(field('Comparison model', model)); comparison.appendChild(grid);
        if (!selected || !statistics.model) {
            comparison.appendChild(element('p', 'sr-public-hint', 'Select a saved API and model to set its rates and compare costs.'));
            return;
        }
        const rateKey = JSON.stringify([selected.id, statistics.model]);
        const rate = statistics.rates[rateKey] || (statistics.rates[rateKey] = { input: '', output: '', cached: '', currency: 'USD' });
        const pricing = element('details', 'sr-public-details');
        pricing.open = !rate.input || !rate.output;
        pricing.appendChild(element('summary', '', 'Rates for ' + statistics.model));
        pricing.appendChild(element('p', 'sr-public-hint', 'Enter your current price per 1 million tokens, including any negotiated discount. These are your comparison assumptions, not a provider invoice.'));
        const fields = element('div', 'sr-public-grid');
        const currency = select([['USD','USD'],['CAD','CAD']], rate.currency);
        fields.appendChild(field('Rate currency', currency));
        const rateInputs = {};
        [['input','Input / 1M tokens'],['output','Output / 1M tokens'],['cached','Cached input / 1M tokens']].forEach(([key,label]) => {
            const control = input('number', rate[key], key === 'cached' ? 'Uses input price if blank' : 'Your API rate');
            control.min = '0'; control.step = 'any';
            fields.appendChild(field(label, control)); rateInputs[key] = control;
        });
        const fx = input('number', statistics.cadPerUsd, 'Required when CAD is used'); fx.min = '0.00000001'; fx.step = 'any';
        fields.appendChild(field('CAD per USD', fx, 'Your exchange-rate assumption. No automatic currency conversion.'));
        pricing.appendChild(fields); comparison.appendChild(pricing);
        const result = element('div', 'sr-public-tiles sr-public-comparison');
        const values = ['REACH recorded cost', 'Selected API estimate', 'Difference'];
        const outputs = values.map(label => { const tile = element('div', 'sr-public-summary'); tile.appendChild(element('span','sr-public-hint',label));
            const output = element('strong','','—'); tile.appendChild(output); result.appendChild(tile); return output; });
        comparison.appendChild(result);
        const explanation = element('p','sr-public-hint'); explanation.setAttribute('role','status'); comparison.appendChild(explanation);
        function calculate() {
            outputs.forEach(out => { out.textContent = '—'; });
            if (!report) { explanation.textContent = 'Refresh your REACH statistics to compare this period.'; return; }
            if (Object.values(rateInputs).some(control => control.value !== '' && !safeRate(control.value))
                || fx.value !== '' && !safeRate(fx.value)) { explanation.textContent = 'Enter valid, non-negative decimal rates.'; return; }
            const needsFx = rate.currency === 'CAD' || report.spending.subscriptions.some(s => s.currency === 'CAD' && s.netMicros > 0);
            const exchange = Number(statistics.cadPerUsd);
            if (needsFx && (!statistics.cadPerUsd || exchange <= 0)) { explanation.textContent = 'Enter CAD per USD in Rates to compare both costs in USD.'; return; }
            const reach = report.spending.creditUsdMicros / 1e6 + report.spending.subscriptions.reduce((sum,s) => sum + s.netMicros / 1e6 / (s.currency === 'CAD' ? exchange : 1),0);
            outputs[0].textContent = money(reach,'USD');
            if (!rate.input || !rate.output) { explanation.textContent = 'Enter the selected model’s input and output rates.'; return; }
            if (report.requests.measured !== report.requests.completed || report.spending.unpricedCreditTokens) {
                explanation.textContent = 'Some completed requests lack measured tokens or a recorded credit value. A full-period cost difference cannot be calculated.'; return;
            }
            const api = ((report.tokens.input - report.tokens.cachedInput) * Number(rate.input)
                + report.tokens.cachedInput * Number(rate.cached || rate.input) + report.tokens.output * Number(rate.output)) / 1e6 / (rate.currency === 'CAD' ? exchange : 1);
            const difference = api - reach;
            outputs[1].textContent = money(api,'USD'); outputs[2].textContent = money(Math.abs(difference),'USD');
            explanation.textContent = Math.abs(difference) < 0.00005 ? 'The estimated costs are equal.' : difference > 0
                ? 'REACH costs less by this amount for the recorded period.' : 'REACH costs more by this amount for the recorded period.';
            if (needsFx) explanation.textContent += ' Converted using your CAD per USD rate of ' + statistics.cadPerUsd + '.';
        }
        Object.entries(rateInputs).forEach(([key,control]) => control.addEventListener('input', () => {
            rate[key] = safeRate(control.value); savePreferences(); calculate();
        }));
        currency.addEventListener('change', () => { rate.currency = currency.value; savePreferences(); calculate(); });
        fx.addEventListener('input', () => { statistics.cadPerUsd = safeRate(fx.value); savePreferences(); calculate(); });
        calculate();
    }

    function renderLogs() {
        root.querySelector('[data-playground-activity]')?.remove();
        const logs = card('Playground activity', 'Recent requests from this window session. Prompt text, responses and credentials are not stored in this log.');
        logs.setAttribute('data-playground-activity', '');
        if (!activity.length) logs.appendChild(element('p', 'sr-public-hint', 'No Playground requests yet.'));
        activity.slice().reverse().forEach(item => {
            const row = element('div', 'sr-public-log-row');
            row.appendChild(element('span', '', new Date(item.at).toLocaleTimeString()));
            row.appendChild(element('strong', '', item.model));
            row.appendChild(element('span', '', item.outcome));
            row.appendChild(element('span', 'sr-public-hint', (item.durationMs / 1000).toFixed(2) + ' s'));
            logs.appendChild(row);
        });
    }

    function renderPlayground() {
        const playground = card('Try your model', preferences.name && preferences.model
            ? preferences.name + ' · ' + preferences.model
            : 'Save your connection and choose a model in Settings first.');
        playground.appendChild(element('p', 'sr-public-hint', 'Sending a prompt uses your provider account and may use paid credits. Workspace documents are not included.'));
        const prompt = element('textarea');
        prompt.rows = 4;
        prompt.placeholder = 'Write a prompt…';
        prompt.value = promptDraft;
        prompt.addEventListener('input', () => { promptDraft = prompt.value; });
        playground.appendChild(field('Prompt', prompt));
        const output = element('pre', 'sr-public-output');
        output.textContent = lastResponse;
        output.setAttribute('aria-live', 'polite');
        const send = button('Send prompt', () => action(send, async () => {
            if (!preferences.endpointId || !preferences.model) throw new Error('Save your connection and select a model first.');
            if (!prompt.value.trim()) throw new Error('Write a prompt first.');
            promptDraft = prompt.value;
            const currentGeneration = generation;
            const requestController = new AbortController();
            pending = requestController;
            const entry = { at: Date.now(), model: preferences.model, outcome: 'Failed', durationMs: 0 };
            stop.disabled = false;
            status('Waiting for your model…');
            try {
                const defaults = modelDefaults(preferences.model);
                const data = await request('/chat', {
                    message: prompt.value.trim(), endpoint_id: preferences.endpointId,
                    model: preferences.model, temperature: defaults.temperature,
                    max_output_tokens: defaults.maxOutputTokens, context: '',
                    use_workspace_context: false, use_web_search: false,
                    use_web_search_loop: false, embedding_enabled: false
                }, requestController.signal);
                if (generation !== currentGeneration) return;
                entry.outcome = 'Completed';
                lastResponse = typeof data.response === 'string' ? data.response : 'No text response returned.';
                output.textContent = lastResponse;
                status('Response received.');
            } catch (error) {
                if (error.name === 'AbortError') entry.outcome = 'Stopped';
                throw error;
            } finally {
                if (generation !== currentGeneration) entry.outcome = 'Stopped';
                entry.durationMs = Date.now() - entry.at;
                activity.push(entry);
                if (activity.length > 100) activity.shift();
                if (pending === requestController) pending = null;
                stop.disabled = true;
                renderSidebar();
                if (active && activePage === 'playground') renderLogs();
            }
        }), 'sr-public-button sr-public-primary');
        send.disabled = !preferences.endpointId || !preferences.model;
        const stop = button('Stop waiting', () => { if (pending) pending.abort(); });
        stop.disabled = true;
        playground.appendChild(send);
        playground.appendChild(stop);
        playground.appendChild(output);
        renderLogs();
    }

    function target() {
        const elements = context && context.elements || {};
        return elements.settingsContainer || document.getElementById('settings-container') || document.getElementById('settingsContainer');
    }
    function render() {
        if (!active) return;
        const container = target();
        if (!container) return;
        if (root) root.remove();
        root = element('div', 'sr-public-page');
        root.appendChild(element('p', 'sr-public-eyebrow', 'SIGNALREACH'));
        root.appendChild(element('h1', '', PAGES.find(item => item[0] === activePage)[1]));
        if (!(context && context.elements && context.elements.navFolderList)) root.appendChild(navigation('sr-public-tabs'));
        const note = element('p', 'sr-public-status');
        note.setAttribute('data-status', '');
        note.setAttribute('role', 'status');
        root.appendChild(note);
        container.replaceChildren(root);
        ({ playground: renderPlayground, usage: renderUsage, settings: renderSettings })[activePage]();
        renderNavigation();
        renderSidebar();
    }
    function deactivateRequest() {
        generation++;
        if (pending) pending.abort();
        if (usageController) usageController.abort();
    }
    function ensureHostRecord() {
        try {
            const records = JSON.parse(localStorage.getItem('ragworkspace_plugins') || '[]');
            if (!Array.isArray(records)) return;
            const record = records.find(item => item && item.id === manifest.id);
            if (!record) records.push({ id: manifest.id, name: manifest.name, version: manifest.version,
                enabled: true, status: 'running', runtimeBacked: true, runtimePage: APP_ID,
                description: manifest.description, permissions: manifest.permissions,
                publisher: manifest.publisher.name, installMethod: 'Local extension registry' });
            else { record.version = manifest.version; record.runtimeBacked = true; record.runtimePage = APP_ID; }
            localStorage.setItem('ragworkspace_plugins', JSON.stringify(records));
        } catch (_error) { /* Preserve a corrupt host record for recovery. */ }
    }
    const controller = {
        appId: APP_ID,
        mount(next) { context = next; ensureHostRecord(); },
        activate(next) { active = true; context = next || context; if (context && context.state) context.state.folder = activePage; render(); },
        renderPage(next) {
            context = next || context;
            const requested = context && context.state && context.state.folder;
            const page = PAGE_ALIASES[requested] || requested;
            if (PAGES.some(item => item[0] === page) && page !== activePage) { deactivateRequest(); activePage = page; }
            render();
        },
        onFolderChanged(next, page) {
            if (next && typeof next === 'object') context = next;
            navigate(typeof page === 'string' ? page : typeof next === 'string' ? next : context && context.state && context.state.folder);
        },
        renderNav(next) {
            context = next || context;
            renderNavigation();
        },
        renderList(next) {
            context = next || context;
            renderSidebar();
        },
        deactivate() { active = false; deactivateRequest(); },
        unmount() { active = false; deactivateRequest(); if (root) root.remove(); root = null; context = null; }
    };
    host.registerController({ pluginId: manifest.id, capabilities: ['workspace.page-controller.v1'],
        pages: { [manifest.contributes.pages[0].id]: controller }, commands: {
            'signalReachPublic.openPage': () => { if (typeof window.setApp === 'function') window.setApp(APP_ID); }
        } });
    host.registerManifest(manifest);
    ensureHostRecord();
    window.signalReachPublic = Object.freeze({ pluginId: manifest.id, controller });
})();
