'use strict';

// Provider facts are learned from actual responses and stored on the saved
// connection, keyed by the resolved endpoint and model. A pointer URL can move
// to another backend without inheriting the old backend's observations.
const MAX_ENTRIES = 32;
const { createHash } = require('node:crypto');

// Gateway byte limits and provider token windows are separate facts. Never
// infer one from the other or guess an input scope absent from the catalog.
function modelInputLimits(model) {
  if (!model || typeof model !== 'object') return {};
  const facts = {};
  for (const [wire, local] of [['max_input_bytes', 'maxInputBytes'], ['max_input_tokens', 'maxInputTokens'], ['context_window', 'contextTokens']]) {
    if (Number.isSafeInteger(model[wire]) && model[wire] > 0) facts[local] = model[wire];
  }
  if (['messages', 'request_fields', 'request'].includes(model.input_limit_scope)) facts.inputLimitScope = model.input_limit_scope;
  if (!facts.inputLimitScope) delete facts.maxInputBytes;
  return facts;
}

function observedMaxTokensCeiling(message) {
  const text = String(message || '');
  const match = /(?:max[_ ](?:completion[_ ]|output[_ ])?tokens?|output tokens?)\s*(?:must be|is|:)?\s*(?:at most|less than or equal to|<=|maximum of)\s*(\d{1,7})/i.exec(text)
    || /(?:maximum|limit)\s*(?:for\s+)?(?:max[_ ](?:completion[_ ]|output[_ ])?tokens?|output tokens?)\s*(?:is|:|of)\s*(\d{1,7})/i.exec(text);
  const value = match ? Number(match[1]) : 0;
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function normalizeCapabilities(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const entry of value.slice(-MAX_ENTRIES)) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const endpoint = String(entry.endpoint || '').slice(0, 2048);
    const model = String(entry.model || '').slice(0, 240);
    if (!endpoint || !model) continue;
    const fact = { endpoint, model };
    for (const key of ['toolCalling', 'reasoningParam', 'streaming', 'outputTokenLimit']) {
      if (typeof entry[key] === 'boolean') fact[key] = entry[key];
    }
    if (Number.isSafeInteger(entry.maxTokensCeiling) && entry.maxTokensCeiling > 0) {
      fact.maxTokensCeiling = entry.maxTokensCeiling;
    }
    for (const key of ['maxInputBytes', 'maxInputTokens', 'contextTokens']) {
      if (Number.isSafeInteger(entry[key]) && entry[key] > 0) fact[key] = entry[key];
    }
    if (['messages', 'request_fields', 'request'].includes(entry.inputLimitScope)) fact.inputLimitScope = entry.inputLimitScope;
    if (!fact.inputLimitScope) delete fact.maxInputBytes;
    out.push(fact);
  }
  return out;
}

function createCapabilityStore({ load, save }) {
  const discoveries = new Map();
  const target = (settings, connectionId, endpoint) =>
    settings?.connections?.find(c => c.id === connectionId)
      || settings?.connections?.find(c => c.endpoint === endpoint);
  const store = {
    recordCatalog(connectionId, endpoint, data) {
      for (const model of Array.isArray(data?.data) ? data.data : []) {
        if (typeof model?.id !== 'string' || !model.id) continue;
        const facts = modelInputLimits(model);
        if (typeof model.capabilities?.outputTokenLimit === 'boolean') facts.outputTokenLimit = model.capabilities.outputTokenLimit;
        const old = store.get(connectionId, endpoint, model.id);
        if (Object.keys(facts).length || old && ['maxInputBytes', 'inputLimitScope', 'maxInputTokens', 'contextTokens', 'outputTokenLimit'].some(key => old[key] !== undefined)) {
          store.record(connectionId, endpoint, model.id, {
            maxInputBytes: undefined, inputLimitScope: undefined, maxInputTokens: undefined, contextTokens: undefined, outputTokenLimit: undefined, ...facts,
          });
        }
      }
    },
    async discover(connectionId, endpoint, accessKey, fetchImpl = global.fetch) {
      const credential = createHash('sha256').update(accessKey || '').digest('hex');
      const key = JSON.stringify([connectionId, endpoint, credential]);
      const previous = discoveries.get(key);
      if (previous && Date.now() - previous.at < 60000) return previous.promise;
      const promise = (async () => {
        try {
          const headers = accessKey ? { Authorization: 'Bearer ' + accessKey } : {};
          const response = await fetchImpl(endpoint.replace(/\/+$/, '') + '/models', { headers, signal: AbortSignal.timeout(3000) });
          if (response.ok) store.recordCatalog(connectionId, endpoint, await response.json());
        } catch { /* Optional discovery: unsupported catalogs keep response learning. */ }
      })();
      discoveries.set(key, { at: Date.now(), promise });
      if (discoveries.size > MAX_ENTRIES) discoveries.delete(discoveries.keys().next().value);
      return promise;
    },
    get(connectionId, endpoint, model) {
      try {
        const connection = target(load(), connectionId, endpoint);
        return normalizeCapabilities(connection?.capabilities)
          .find(c => c.endpoint === endpoint && c.model === model) || null;
      } catch { return null; }
    },
    record(connectionId, endpoint, model, facts) {
      try {
        const settings = load();
        const connection = target(settings, connectionId, endpoint);
        if (!connection) return false;
        const entries = normalizeCapabilities(connection.capabilities);
        const old = entries.find(c => c.endpoint === endpoint && c.model === model);
        const next = normalizeCapabilities([{ endpoint, model, ...old, ...facts }])[0];
        if (!next || JSON.stringify(old) === JSON.stringify(next)) return false;
        const retained = entries.filter(c => c.endpoint !== endpoint || c.model !== model);
        retained.push(next);
        const updated = { ...settings, connections: settings.connections.map(c => c.id === connection.id
          ? { ...c, capabilities: retained.slice(-MAX_ENTRIES) } : c) };
        save(updated);
        return true;
      } catch { return false; } // capability learning must never fail a request
    },
  };
  return store;
}

module.exports = { normalizeCapabilities, createCapabilityStore, observedMaxTokensCeiling, modelInputLimits };
