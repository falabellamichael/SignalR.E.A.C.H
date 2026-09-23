'use strict';

// Provider facts are learned from actual responses and stored on the saved
// connection, keyed by the resolved endpoint and model. A pointer URL can move
// to another backend without inheriting the old backend's observations.
const MAX_ENTRIES = 32;

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
    for (const key of ['toolCalling', 'reasoningParam', 'streaming']) {
      if (typeof entry[key] === 'boolean') fact[key] = entry[key];
    }
    if (Number.isSafeInteger(entry.maxTokensCeiling) && entry.maxTokensCeiling > 0) {
      fact.maxTokensCeiling = entry.maxTokensCeiling;
    }
    out.push(fact);
  }
  return out;
}

function createCapabilityStore({ load, save }) {
  const target = (settings, connectionId, endpoint) =>
    settings?.connections?.find(c => c.id === connectionId)
      || settings?.connections?.find(c => c.endpoint === endpoint);
  return {
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
}

module.exports = { normalizeCapabilities, createCapabilityStore, observedMaxTokensCeiling };
