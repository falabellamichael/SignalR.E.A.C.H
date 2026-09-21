'use strict';

const ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
const MAX_CANDIDATES = 32;

function jevRequestIsSelfContained(request) {
  const text = String(request || '').trim();
  if (!text || text.length > 1500) return false;
  if (/^TOOL RESULTS\b/i.test(text) || /(?:^|\n)Attached context:/i.test(text)) return false;
  const words = text.split(/\s+/);
  return !(words.length < 8 && /\b(?:it|that|those|this|same|again|continue|previous|above)\b/i.test(text));
}

function jevShortlistCoversRequest(catalog, request, totalCount) {
  if (totalCount <= MAX_CANDIDATES) return true;
  const terms = (String(request || '').toLowerCase().match(/[a-z0-9]{3,}/g) || [])
    .filter(word => !/^(?:the|and|for|with|from|review|repo|repository|project|source|files|file|code|codebase|implementation)$/.test(word));
  return catalog.some(value => {
    const pathParts = value.toLowerCase().match(/[a-z0-9]{3,}/g) || [];
    return pathParts.some(part => terms.includes(part));
  });
}

// This is a path-only shortlist. File contents and the full conversation are
// never sent to TypeSafe for workspace selection.
function shortlistPaths(paths, request) {
  const words = new Set(String(request || '').toLowerCase().match(/[a-z0-9]{3,}/g) || []);
  const score = value => {
    const path = value.toLowerCase().replace(/\\/g, '/');
    const parts = path.match(/[a-z0-9]{3,}/g) || [];
    const matches = parts.filter(part => words.has(part)).length;
    const manifest = /(?:^|\/)(?:package\.json|pyproject\.toml|cargo\.toml|go\.mod)$/.test(path) ? 1 : 0;
    return matches * 10 + manifest;
  };
  return [...paths].sort((a, b) => score(b) - score(a) || a.localeCompare(b)).slice(0, MAX_CANDIDATES);
}

async function selectWorkspaceFilesWithJev({ key, request, paths, signal, fetchImpl = fetch }) {
  signal?.throwIfAborted();
  const candidates = shortlistPaths(paths, request);
  if (!candidates.length) return { paths: [], usage: null };
  const controller = new AbortController();
  const onAbort = () => controller.abort(signal.reason);
  signal?.addEventListener('abort', onAbort, { once: true });
  const timeout = setTimeout(() => controller.abort(new Error('Jev selection timed out')), 8000);
  const questions = Object.fromEntries(candidates.map((path, index) => ['file_' + index, {
    type: 'noul',
    instructions: `Is the workspace file at path ${JSON.stringify(path)} useful to read before answering the user's request? Judge from the path and request only.`,
    criteria: {
      true: 'Reading this file is likely to provide relevant implementation, configuration, or project context.',
      false: 'The file is unrelated or the request needs no source inspection.',
    },
  }]));
  try {
    const response = await fetchImpl(ENDPOINT, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'jev-latest', state: { user_request: String(request || '').slice(0, 1500) }, questions }),
      signal: controller.signal,
      redirect: 'error',
    });
    signal?.throwIfAborted();
    if (!response.ok) throw new Error(`Jev HTTP ${response.status}`);
    const data = await response.json();
    signal?.throwIfAborted();
    if (!data || typeof data.answers !== 'object') throw new Error('Invalid Jev response');
    const scored = candidates.map((path, index) => {
      const answer = data.answers['file_' + index];
      return { path, probability: answer?.type === 'noul' ? answer.noul : undefined };
    });
    if (scored.some(item => typeof item.probability !== 'number' || !Number.isFinite(item.probability)
        || item.probability < 0 || item.probability > 1)) throw new Error('Invalid Jev relevance answer');
    const validCount = value => Number.isSafeInteger(value) && value >= 0;
    const usage = data.usage && validCount(data.usage.input_tokens) && validCount(data.usage.output_tokens)
      ? { input_tokens: data.usage.input_tokens, output_tokens: data.usage.output_tokens } : null;
    // An uncertain all-negative result must not suppress context. Return its
    // usage even when the caller must use the original provider as a fallback.
    if (!scored.some(item => item.probability >= 0.6)
        && scored.some(item => item.probability > 0.2)) return { paths: [], usage, abstained: true };
    return {
      paths: scored.filter(item => item.probability >= 0.6)
        .sort((a, b) => b.probability - a.probability).slice(0, 8).map(item => item.path),
      usage,
    };
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', onAbort);
  }
}

module.exports = { jevRequestIsSelfContained, jevShortlistCoversRequest, shortlistPaths, selectWorkspaceFilesWithJev };
