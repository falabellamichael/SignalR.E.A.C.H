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
    let context = null;
    let root = null;
    let activePage = 'settings';
    let generation = 0;
    let pending = null;

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
        try { await job(); }
        catch (error) { status(error.name === 'AbortError' ? 'Request stopped.' : error.message, true); }
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
            key.value = '';
            savePreferences();
            render();
            status('Connection saved. Refresh models to choose a default.');
        }), 'sr-public-button sr-public-primary');
        connection.appendChild(save);

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
        const refresh = button('Refresh models', () => action(refresh, async () => {
            if (!preferences.endpointId) throw new Error('Save your connection first.');
            const data = await request('/model-endpoints/' + encodeURIComponent(preferences.endpointId) + '/models?refresh=true');
            const list = Array.isArray(data.chat_models) ? data.chat_models : data.models;
            if (!Array.isArray(list)) throw new Error('SimpleRAG did not return a model list. You can enter a model ID manually.');
            models.clear();
            list.filter(model => typeof model === 'string' && model && model.length <= 256).forEach(model => models.add(model));
            if (preferences.model) models.add(preferences.model);
            render();
            status(models.size + ' model choices available.');
        }));
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

    function renderPlayground() {
        const playground = card('Try your model', preferences.name && preferences.model
            ? preferences.name + ' · ' + preferences.model
            : 'Save your connection and choose a model in Settings first.');
        playground.appendChild(element('p', 'sr-public-hint', 'Sending a prompt uses your provider account and may use paid credits. Workspace documents are not included.'));
        const prompt = element('textarea');
        prompt.rows = 4;
        prompt.placeholder = 'Write a prompt…';
        playground.appendChild(field('Prompt', prompt));
        const output = element('pre', 'sr-public-output');
        output.setAttribute('aria-live', 'polite');
        const send = button('Send prompt', () => action(send, async () => {
            if (!preferences.endpointId || !preferences.model) throw new Error('Save your connection and select a model first.');
            if (!prompt.value.trim()) throw new Error('Write a prompt first.');
            const currentGeneration = generation;
            pending = new AbortController();
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
                }, pending.signal);
                if (generation !== currentGeneration) return;
                output.textContent = typeof data.response === 'string' ? data.response : 'No text response returned.';
                status('Response received.');
            } finally { pending = null; stop.disabled = true; }
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
        const container = target();
        if (!container) return;
        if (root) root.remove();
        root = element('div', 'sr-public-page');
        root.appendChild(element('h1', '', 'SignalREACH'));
        root.appendChild(element('p', 'sr-public-intro', 'Your providers. Your models. Your settings.'));
        const nav = element('nav', 'sr-public-tabs');
        ['settings', 'playground'].forEach(page => {
            const tab = button(page === 'settings' ? 'Settings' : 'Playground', () => {
                deactivateRequest();
                activePage = page;
                render();
            });
            tab.setAttribute('aria-current', activePage === page ? 'page' : 'false');
            nav.appendChild(tab);
        });
        root.appendChild(nav);
        const note = element('p', 'sr-public-status');
        note.setAttribute('data-status', '');
        note.setAttribute('role', 'status');
        root.appendChild(note);
        container.appendChild(root);
        if (activePage === 'playground') renderPlayground();
        else renderSettings();
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
        activate(next) { context = next || context; render(); },
        renderPage(next) { context = next || context; render(); },
        renderNav(next) {
            context = next || context;
            const elements = context && context.elements || {};
            if (elements.navTitle) elements.navTitle.textContent = 'SignalREACH';
            if (elements.navFolderList) elements.navFolderList.replaceChildren();
        },
        renderList(next) {
            context = next || context;
            const elements = context && context.elements || {};
            if (elements.listTitle) elements.listTitle.textContent = 'Your provider';
            if (elements.listContent) elements.listContent.replaceChildren(element('p', 'sr-public-hint', preferences.name || 'Add your own connection in Settings.'));
        },
        deactivate() { deactivateRequest(); },
        unmount() { deactivateRequest(); if (root) root.remove(); root = null; }
    };
    host.registerController({ pluginId: manifest.id, capabilities: ['workspace.page-controller.v1'],
        pages: { [manifest.contributes.pages[0].id]: controller }, commands: {
            'signalReachPublic.openPage': () => { if (typeof window.setApp === 'function') window.setApp(APP_ID); }
        } });
    host.registerManifest(manifest);
    ensureHostRecord();
    window.signalReachPublic = Object.freeze({ pluginId: manifest.id, controller });
})();
