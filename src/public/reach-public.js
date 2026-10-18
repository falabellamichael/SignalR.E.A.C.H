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
        ['dashboard', 'Dashboard', 'fa-gauge-high'],
        ['endpoint', 'Endpoint', 'fa-link'],
        ['models', 'Models', 'fa-cubes'],
        ['playground', 'Playground', 'fa-comment-dots'],
        ['usage', 'Usage', 'fa-chart-column'],
        ['logs', 'Logs', 'fa-list'],
        ['settings', 'Settings', 'fa-sliders'],
        ['shared-settings', 'Shared settings', 'fa-arrows-rotate'],
        ['about', 'About', 'fa-circle-info']
    ];
    let activePage = 'dashboard';
    let generation = 0;
    let pending = null;
    let active = false;
    let savedConnections = null;
    let connectionStatus = 'Not checked';
    let promptDraft = '';
    let lastResponse = '';
    const activity = [];

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
                defaults
            };
        } catch (_error) { return {}; }
    }
    const preferences = Object.assign({ endpointId: '', name: '', baseUrl: '', model: '', defaults: {} }, readPreferences());
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
            baseUrl: preferences.baseUrl, model: preferences.model, defaults
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

    function renderSettings() {
        const existing = card('Use a saved SimpleRAG connection', 'Choose a connection you already use in SimpleRAG. Its key stays in SimpleRAG.');
        const load = button('Load saved connections', () => action(load, async () => {
            const data = await request('/model-endpoints');
            if (!Array.isArray(data)) throw new Error('SimpleRAG did not return saved connections.');
            savedConnections = data.filter(item => item && typeof item.id === 'string' && item.is_enabled !== false)
                .flatMap(item => {
                    try {
                        return [{ id: item.id, name: String(item.name || 'Saved connection'),
                            baseUrl: normalizeUrl(item.base_url), model: typeof item.default_model === 'string' ? item.default_model : '',
                            models: (Array.isArray(item.chat_models) ? item.chat_models : Array.isArray(item.models) ? item.models : [])
                                .filter(model => typeof model === 'string' && model && model.length <= 256) }];
                    } catch (_error) { return []; }
                });
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
                navigate('dashboard');
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
        if (elements.listTitle) elements.listTitle.textContent = 'Connection & Models';
        if (!elements.listContent) return;
        const panel = element('div', 'sr-public-sidebar');
        const connection = element('section', 'sr-public-card');
        connection.appendChild(element('h2', '', preferences.name || 'Your REACH connection'));
        connection.appendChild(element('span', 'sr-public-badge', preferences.endpointId ? connectionStatus : 'Setup needed'));
        connection.appendChild(element('p', 'sr-public-hint sr-public-url', preferences.baseUrl || 'Choose a saved connection or add your provider.'));
        connection.appendChild(button('Connection settings', () => navigate('settings')));
        panel.appendChild(connection);
        const selection = element('section', 'sr-public-card');
        selection.appendChild(element('h2', '', 'Model'));
        selection.appendChild(element('p', 'sr-public-model-name', preferences.model || 'Choose a default model'));
        const refresh = button('Refresh models', () => action(refresh, refreshModels));
        refresh.disabled = !preferences.endpointId;
        selection.appendChild(refresh);
        selection.appendChild(button('Model settings', () => navigate('models')));
        panel.appendChild(selection);
        const shared = element('section', 'sr-public-card');
        shared.appendChild(element('h2', '', 'Studio + VS Code sync'));
        const sync = element('iframe', 'sr-public-sync-frame');
        sync.title = 'Sync Studio and VS Code settings';
        sync.src = SETTINGS_HUB_URL + '/sync';
        shared.appendChild(sync);
        shared.appendChild(button('Shared settings', () => navigate('shared-settings')));
        panel.appendChild(shared);
        const session = element('section', 'sr-public-card');
        session.appendChild(element('h2', '', 'This session'));
        summary(session, 'Completed prompts', String(activity.filter(item => item.outcome === 'Completed').length));
        session.appendChild(button('View activity', () => navigate('logs')));
        panel.appendChild(session);
        panel.appendChild(element('p', 'sr-public-hint', 'SignalREACH · v' + manifest.version));
        elements.listContent.replaceChildren(panel);
    }

    function renderDashboard() {
        const welcome = card('Welcome to SignalREACH', 'Your models, connections and prompt activity in SimpleRAG.');
        welcome.appendChild(element('span', 'sr-public-badge', preferences.endpointId ? connectionStatus : 'Set up your connection'));
        welcome.appendChild(element('p', 'sr-public-hint', preferences.endpointId
            ? 'Open Models to refresh your catalog and choose a default, or try a prompt in Playground.'
            : 'Start with a connection already saved in SimpleRAG, or enter your own REACH / OpenAI-compatible endpoint.'));
        welcome.appendChild(button(preferences.endpointId ? 'Open Playground' : 'Choose a connection',
            () => navigate(preferences.endpointId ? 'playground' : 'settings'), 'sr-public-button sr-public-primary'));
        welcome.appendChild(button('Browse models', () => navigate('models')));
        const tiles = element('div', 'sr-public-tiles');
        summary(tiles, 'Connection', preferences.name || 'Not selected');
        summary(tiles, 'Default model', preferences.model || 'Not selected');
        summary(tiles, 'Model choices', models.size ? String(models.size) : 'Refresh to load');
        summary(tiles, 'Completed prompts', String(activity.filter(item => item.outcome === 'Completed').length));
        root.appendChild(tiles);
        const shortcuts = card('Your workspace', 'Open a page to manage your connection or try your models.');
        const grid = element('div', 'sr-public-shortcuts');
        [['models', 'Models', 'Choose a model and tune prompt defaults.'],
            ['endpoint', 'Endpoint', 'Review the connection used by this extension.'],
            ['playground', 'Playground', 'Send a prompt through your selected connection.'],
            ['usage', 'Usage', 'Review activity from this Playground session.'],
            ['shared-settings', 'Shared settings', 'Manage shared Studio and VS Code settings and sync.']].forEach(([id, label, detail]) => {
            const item = button('', () => navigate(id), 'sr-public-shortcut');
            item.appendChild(element('strong', '', label));
            item.appendChild(element('span', 'sr-public-hint', detail));
            grid.appendChild(item);
        });
        shortcuts.appendChild(grid);
    }

    function renderSharedSettings() {
        const shared = card('REACH settings hub', 'Manage shared connection, model and generation settings for installed REACH Studio and the SimpleREACH VS Code extension.');
        shared.appendChild(sharedSettingsLink());
        shared.appendChild(element('p', 'sr-public-hint', 'Keep an updated Studio or VS Code extension running to host the local hub. If it is unavailable, start one of those clients and open the hub again.'));
        const sync = card('Sync Studio + VS Code', 'Use the switch in the second panel to automatically apply saved hub settings in both running clients. Sync defaults to off.');
        sync.appendChild(element('p', 'sr-public-hint', 'The hub shares the connection name, endpoint, model, temperature and output-token limit. Configure API keys in each client.'));
        card('SimpleRAG connection settings', 'The Settings page here manages the connection used by this SimpleRAG extension. Studio and VS Code share their settings through the hub independently.');
    }

    function renderEndpoint() {
        const info = card('Your endpoint', 'The connection selected for SignalREACH. Credentials are managed by SimpleRAG.');
        summary(info, 'Connection', preferences.name || 'Not selected');
        summary(info, 'Base URL', preferences.baseUrl || 'Not configured');
        summary(info, 'Default model', preferences.model || 'Not selected');
        summary(info, 'Last model check', connectionStatus);
        info.appendChild(button('Choose or edit connection', () => navigate('settings'), 'sr-public-button sr-public-primary'));
        const check = button('Check models', () => action(check, refreshModels));
        check.disabled = !preferences.endpointId;
        info.appendChild(check);
        card('Use in SimpleRAG', 'Connections saved here are also available in SimpleRAG model settings. Choose the same connection and model in the Copilot model picker to use them in your chats.');
    }

    function renderUsage() {
        const usage = card('Playground usage', 'This window session only. Your provider or REACH account remains the source for billing and account-wide usage.');
        const completed = activity.filter(item => item.outcome === 'Completed');
        summary(usage, 'Completed prompts', String(completed.length));
        summary(usage, 'Failed or stopped prompts', String(activity.length - completed.length));
        summary(usage, 'Average response time', completed.length
            ? (completed.reduce((sum, item) => sum + item.durationMs, 0) / completed.length / 1000).toFixed(2) + ' s' : 'No completed prompts');
        usage.appendChild(button('Open activity log', () => navigate('logs')));
    }

    function renderLogs() {
        const logs = card('Playground activity', 'Recent requests from this window session. Prompt text, responses and credentials are not stored in this log.');
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

    function renderAbout() {
        const about = card('SignalREACH', 'RAG Endpoint & AI Chat Host · SimpleRAG extension');
        summary(about, 'Version', manifest.version);
        summary(about, 'Edition', 'Public');
        summary(about, 'Publisher', manifest.publisher.name);
        about.appendChild(element('p', 'sr-public-hint', 'Manage your connection, choose models and try prompts. Your provider credentials stay in SimpleRAG.'));
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
            }
        }), 'sr-public-button sr-public-primary');
        send.disabled = !preferences.endpointId || !preferences.model;
        const stop = button('Stop waiting', () => { if (pending) pending.abort(); });
        stop.disabled = true;
        playground.appendChild(send);
        playground.appendChild(stop);
        playground.appendChild(output);
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
        ({ dashboard: renderDashboard, endpoint: renderEndpoint, models: renderModels,
            playground: renderPlayground, usage: renderUsage, logs: renderLogs,
            settings: renderSettings, 'shared-settings': renderSharedSettings, about: renderAbout })[activePage]();
        renderNavigation();
        renderSidebar();
    }
    function deactivateRequest() {
        generation++;
        if (pending) pending.abort();
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
            const page = context && context.state && context.state.folder;
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
