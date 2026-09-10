'use strict';

const http = require('node:http');

/*
 * CodeGPT economy models — the unlimited tier of a paid CodeGPT plan.
 *
 * The authoritative list is LIVE, not baked in: the CodeGPT extension keeps a
 * local sidecar (Next 54112/54113) that serves the same credits menu its own
 * model picker renders, and every entry carries a `pro` flag. That flag is the
 * whole economy/premium split (the extension's own launcher draws the same
 * line: `pro ? 'premium' : 'economy'`).
 *
 * A bundled catalog also ships inside the extension, but it drifts — it still
 * flags `deepseek-v4-flash` and `gemini-3.6/3.7-flash` as economy while the
 * live menu offers `gpt-5.6-luna`, `glm-5.2` and `MiniMax-M3` instead. So the
 * sidecar wins whenever it answers, and FALLBACK below is only what to serve
 * when the sidecar is not running (it is the last known good list).
 */
const CATALOG_URLS = [
    'http://127.0.0.1:54112/api/fetch-data/catalog',
    'http://127.0.0.1:54113/api/fetch-data/catalog',
];

// Bridge model ids name both the provider and the model, so a client can ask
// for one economy model without a second setting: `codegpt-eco-<id>`. The bare
// `codegpt-eco` id stays valid and means "whatever the open agent page serves".
const ECONOMY_PREFIX = 'codegpt-eco';

// Last known good economy menu (CodeGPT catalog, 2026-09-10).
const FALLBACK = [
    { id: 'deepseek-v4.1-flash', label: 'DeepSeek V4.1 Flash', badge: 'New!', provider: 'openrouter', wire: 'deepseek/deepseek-v4.1-flash' },
    { id: 'ox-alpha', label: 'GLM 5.3 Flash', badge: 'Economy', provider: 'openrouter', wire: 'z-ai/glm-5.3-flash' },
    { id: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash', badge: 'Economy', provider: 'vertex', wire: 'gemini-3.8-flash' },
    { id: 'gpt-5.6-luna', label: 'GPT 5.6 Luna', badge: 'Economy', provider: 'openrouter', wire: 'gpt-5.6-luna' },
    { id: 'glm-5.2', label: 'GLM 5.2', badge: 'Economy', provider: 'fireworksai', wire: 'accounts/fireworks/models/glm-5p2' },
    { id: 'MiniMax-M3', label: 'MiniMax M3', badge: 'Economy', provider: 'fireworksai', wire: 'accounts/fireworks/models/minimax-m3' },
];

const CACHE_MS = 5 * 60 * 1000;
let cache = { at: 0, models: [], source: 'unloaded' };
let inFlight = null;

function economyBridgeId(id) {
    return ECONOMY_PREFIX + '-' + id;
}

/** The current economy list (cached; FALLBACK until the first fetch lands). */
function economyModels() {
    return cache.models.length ? cache.models : FALLBACK;
}

function economyIds() {
    return economyModels().map((model) => model.id);
}

function economyBridgeIds() {
    return [ECONOMY_PREFIX].concat(economyIds().map(economyBridgeId));
}

function economyCatalogInfo() {
    return { count: economyModels().length, source: cache.source, at: cache.at };
}

// Node's own HTTP, not fetch: inside Electron's main process `fetch` goes
// through Chromium's networking (and any configured proxy), which does not
// reach a loopback sidecar reliably. Everything else in the tray talks to
// localhost this way for the same reason.
function fetchJson(url) {
    return new Promise((resolve, reject) => {
        const request = http.get(url, (response) => {
            if (response.statusCode < 200 || response.statusCode >= 300) {
                response.resume();
                reject(new Error('HTTP ' + response.statusCode));
                return;
            }
            const chunks = [];
            let size = 0;
            response.on('data', (chunk) => {
                size += chunk.length;
                if (size > 2 * 1024 * 1024) { request.destroy(); reject(new Error('catalog too large')); return; }
                chunks.push(chunk);
            });
            response.on('error', reject);
            response.on('end', () => {
                try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
                catch (error) { reject(error); }
            });
        });
        request.on('error', reject);
    });
}

/**
 * Refresh the economy list from the CodeGPT sidecar. Never throws: a sidecar
 * that is not running leaves the previous (or fallback) list in place. There is
 * no timeout — a sidecar that hangs simply means this attempt never lands, so a
 * fresh attempt is allowed if the previous one has been pending a while, and
 * the tray keeps serving the last known good list meanwhile.
 */
async function refreshEconomyModels({ force = false } = {}) {
    if (!force && cache.at && Date.now() - cache.at < CACHE_MS) return economyCatalogInfo();
    if (inFlight && Date.now() - inFlight.startedAt < 60000) return economyCatalogInfo();
    const attempt = { startedAt: Date.now() };
    inFlight = attempt;
    const failures = [];
    try {
        for (const url of CATALOG_URLS) {
            try {
                const feed = await fetchJson(url);
                const menu = Array.isArray(feed && feed.creditsMenu) ? feed.creditsMenu : [];
                const economy = menu
                    // CodeGPT omits `pro` on economy entries rather than
                    // setting it false, so the test is "not pro" — the same
                    // rule the extension's own launcher applies
                    // (`pro ? 'premium' : 'economy'`).
                    .filter((entry) => entry && entry.id && !entry.pro)
                    .map((entry) => ({
                        id: String(entry.id),
                        label: String(entry.name || entry.id),
                        badge: String(entry.badge || ''),
                        provider: entry.provider ? String(entry.provider) : '',
                        wire: entry.wireId ? String(entry.wireId) : '',
                    }));
                if (!economy.length) { failures.push(url.replace(/^http:\/\//, '') + ' empty menu'); continue; }
                cache = { at: Date.now(), models: economy, source: url.replace(/^http:\/\//, '') };
                return economyCatalogInfo();
            } catch (error) {
                failures.push(url.replace(/^http:\/\//, '') + ' ' + error.message);
            }
        }
        // Nothing answered: keep the last good list, but say exactly which
        // sidecar failed and how, so discovery problems are diagnosable.
        cache = { at: cache.at, models: cache.models,
                  source: 'fallback (' + (failures.join('; ') || 'sidecar unreachable') + ')' };
        return economyCatalogInfo();
    } finally {
        if (inFlight === attempt) inFlight = null;
    }
}

/** True for any bridge model id served through the CodeGPT session. */
function isEconomyModel(model) {
    return String(model || '').startsWith(ECONOMY_PREFIX);
}

/**
 * The economy catalog entry a bridge model id selects, or null when the id
 * means "default agent" (bare prefix) or is not an economy id at all.
 */
function economyModelFor(model) {
    const value = String(model || '');
    if (!isEconomyModel(value) || value === ECONOMY_PREFIX) return null;
    return economyModels().find((entry) => value === economyBridgeId(entry.id)) || null;
}

module.exports = {
    ECONOMY_PREFIX,
    economyBridgeId,
    economyBridgeIds,
    economyCatalogInfo,
    economyIds,
    economyModelFor,
    economyModels,
    isEconomyModel,
    refreshEconomyModels,
};
