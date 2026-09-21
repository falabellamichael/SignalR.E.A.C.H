'use strict';

const { jevRequestIsSelfContained } = require('./typesafe-jev');
const ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
const PROFILES = {
  current: 'Keep the currently allowed tool set when the task scope is uncertain.',
  inspect: 'Inspect or explain workspace code, files, Git, or editor state without changing files or running commands.',
  build: 'Implement, fix, refactor, or test workspace code using file tools and approved commands; no web browsing is needed.',
  web: 'Research or interact with web pages without inspecting or changing local workspace files.',
  combined: 'The request needs both workspace implementation or inspection and web research or browser verification.',
};

function toolsForProfile(names, profile) {
  if (profile === 'current' || profile === 'combined') return names.slice();
  return names.filter(name => {
    if (['todo_read', 'todo_write', 'tool_help'].includes(name)) return true;
    const browser = name === 'browse' || name === 'websearch' || name.startsWith('browser_');
    if (profile === 'web') return browser;
    if (browser) return false;
    return profile === 'build' || !['shell', 'runTask', 'vscodeCommand', 'edit_patch', 'open'].includes(name);
  });
}

function choice(answer, options) {
  if (answer?.type !== 'choice' || !options.includes(answer.choice)
      || typeof answer.confidence !== 'number' || !Number.isFinite(answer.confidence)
      || answer.confidence < 0 || answer.confidence > 1 || !answer.probabilities
      || Object.keys(answer.probabilities).length !== options.length) throw new Error('Invalid Jev Auto choice');
  const values = options.map(option => answer.probabilities[option]);
  if (values.some(value => typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1)
      || Math.abs(values.reduce((sum, value) => sum + value, 0) - 1) > 0.02
      || values.some(value => value > answer.probabilities[answer.choice] + 0.001)) throw new Error('Invalid Jev Auto distribution');
  return answer.confidence >= 0.75 && answer.probabilities[answer.choice] >= 0.75 ? answer.choice : null;
}

async function routeWithJev({ key, request, models, currentModel, manualModel, permissions, tools,
  signal, fetchImpl = fetch }) {
  signal?.throwIfAborted();
  if (!jevRequestIsSelfContained(request)) return { abstained: true, usage: null };
  const candidates = [...new Set([currentModel, ...(models || [])].filter(value => typeof value === 'string' && value.length && value.length <= 160))].slice(0, 24);
  const alternatives = candidates.filter(model => model !== currentModel);
  const state = { user_request: request, current_model: String(currentModel || '').slice(0, 160),
    available_models: candidates, permissions, available_tools: tools.slice(0, 64) };
  const modes = permissions.agent ? { current: 'Keep the user-selected Agent mode if intent is uncertain.',
    direct: 'A direct conversational answer is sufficient. No tool execution or iterative agent work is needed.',
    agent: 'The user needs source inspection, changes, commands, research, or a task that needs tools and continued work.' }
    : { direct: 'The user disabled Agent mode. Answer directly.' };
  const questions = permissions.agent ? {
    mode: { type: 'choice', instructions: 'Choose how to handle `user_request` within the supplied permissions.', criteria: modes },
    tools: { type: 'choice', instructions: 'If Agent mode is used, which available tool subset is sufficient for the complete request? Preserve broader tools when uncertain.', criteria: PROFILES },
  } : {};
  if (!manualModel && alternatives.length) questions.model = {
    type: 'choice', instructions: 'Choose a suitable available model for the complete request, preferring a smaller or faster model for simple requests and a capable coding/reasoning model for demanding work. Model names are the only capability evidence. Do not assume prices. Choose current when the names do not establish a better fit.',
    criteria: { current: 'Keep the currently selected model.', ...Object.fromEntries(alternatives.map((model, index) => ['model_' + index, { model }])) },
  };
  for (const [name, description] of Object.entries({ workspace: 'Reading local workspace or editor context is needed to answer the request.',
    web: 'Fresh web research is needed before answering the request.', think: 'An additional private planning pass before answering is useful for this request.' })) {
    if (permissions[name]) questions[name] = { type: 'noul', instructions: description,
      criteria: { true: 'Needed for this user request.', false: 'Can be omitted for this user request.' } };
  }
  if (!Object.keys(questions).length) return { model: currentModel, agentic: false,
    permissions: { ...permissions }, tools: [], profile: 'none', usage: null, skipped: true };
  const controller = new AbortController();
  const onAbort = () => controller.abort(signal.reason);
  signal?.addEventListener('abort', onAbort, { once: true });
  const timeout = setTimeout(() => controller.abort(new Error('Jev Auto timed out')), 8000);
  try {
    const response = await fetchImpl(ENDPOINT, { method: 'POST', redirect: 'error', signal: controller.signal,
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'jev-latest', state, questions }) });
    signal?.throwIfAborted();
    if (!response.ok) throw new Error('Jev Auto HTTP ' + response.status);
    const data = await response.json();
    signal?.throwIfAborted();
    const validCount = value => Number.isSafeInteger(value) && value >= 0;
    const usage = data.usage && validCount(data.usage.input_tokens) && validCount(data.usage.output_tokens)
      ? { input_tokens: data.usage.input_tokens, output_tokens: data.usage.output_tokens } : null;
    const mode = questions.mode ? choice(data.answers?.mode, Object.keys(modes)) : 'direct';
    const profile = mode === 'direct' ? 'current' : choice(data.answers?.tools, Object.keys(PROFILES));
    const selected = questions.model ? choice(data.answers?.model, Object.keys(questions.model.criteria)) : 'current';
    if (!mode || (mode !== 'direct' && !profile) || !selected) return { abstained: true, usage };
    const enabled = { ...permissions };
    for (const name of ['workspace', 'web', 'think']) {
      if (!questions[name]) continue;
      const value = data.answers?.[name];
      if (value?.type !== 'noul' || typeof value.noul !== 'number' || !Number.isFinite(value.noul)
          || value.noul < 0 || value.noul > 1) throw new Error('Invalid Jev Auto judgment');
      // Uncertain judgments retain the user's enabled capability.
      enabled[name] = value.noul > 0.15;
    }
    const agentic = permissions.agent && mode !== 'direct';
    return { model: selected === 'current' ? currentModel : alternatives[Number(selected.slice(6))],
      agentic, permissions: enabled, tools: agentic ? toolsForProfile(tools, profile) : [],
      profile: agentic ? profile : 'none', usage };
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', onAbort);
  }
}

module.exports = { routeWithJev, toolsForProfile };
