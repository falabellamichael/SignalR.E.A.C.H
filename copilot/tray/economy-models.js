'use strict';

/*
 * CodeGPT economy models — the unlimited tier of a paid CodeGPT plan.
 *
 * Source of truth: CodeGPT's own published catalog, shipped in the CodeGPT
 * VS Code extension at
 *   danielsanmedium.dscodegpt/standalone/config/remote-data/model-catalog.json
 * where every entry that is free on a paid plan carries `"economy": true`.
 * (The extension's tui/bridge-model-select.mjs draws the same line for its own
 * model menu: `pro ? 'premium' : 'economy'`.)
 *
 * `wire`  — the upstream route id CodeGPT uses for that model internally.
 * `label` — what the CodeGPT UI calls it.
 *
 * Everything else in the catalog is premium and bills credits, which is why
 * these are the models worth exposing.
 */
const ECONOMY_MODELS = [
    {
        id: 'deepseek-v4-flash',
        label: 'DeepSeek V4 Flash',
        provider: 'openrouter',
        wire: '~deepseek/deepseek-v4-flash-latest',
    },
    {
        id: 'deepseek-v4.1-flash',
        label: 'DeepSeek V4.1 Flash',
        provider: 'openrouter',
        wire: 'deepseek/deepseek-v4.1-flash',
    },
    {
        id: 'gemini-3.6-flash',
        label: 'Gemini 3.6 Flash',
        provider: 'vertex',
        wire: 'gemini-3.6-flash',
    },
    {
        id: 'gemini-3.7-flash',
        label: 'Gemini 3.7 Flash',
        provider: 'vertex',
        wire: 'gemini-3.7-flash',
    },
    {
        id: 'gemini-3.8-flash',
        label: 'Gemini 3.8 Flash',
        provider: 'vertex',
        wire: 'gemini-3.8-flash',
    },
    {
        id: 'ox-alpha',
        label: 'Ox Alpha',
        provider: 'openrouter',
        wire: 'z-ai/glm-5.3-flash',
    },
];

/*
 * Bridge model ids name both the provider and the model, so a client can ask
 * for one economy model without a second setting: `codegpt-eco-<id>`. The bare
 * `codegpt-eco` id stays valid and means "whatever the open agent page serves"
 * — that is the id existing clients already send.
 */
const ECONOMY_PREFIX = 'codegpt-eco';

function economyBridgeId(id) {
    return ECONOMY_PREFIX + '-' + id;
}

function economyBridgeIds() {
    return [ECONOMY_PREFIX].concat(ECONOMY_MODELS.map((model) => economyBridgeId(model.id)));
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
    return ECONOMY_MODELS.find((entry) => value === economyBridgeId(entry.id)) || null;
}

module.exports = {
    ECONOMY_MODELS,
    ECONOMY_PREFIX,
    economyBridgeId,
    economyBridgeIds,
    economyModelFor,
    isEconomyModel,
};
