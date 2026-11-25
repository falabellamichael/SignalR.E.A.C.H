/* Refresh the dated subscription catalog without an account session. */
(async () => {
  'use strict';
  const list = document.getElementById('subscription-model-list');
  const status = document.getElementById('subscription-model-status');
  if (!list || !status) return;

  function modelRole(capabilities = {}) {
    switch (capabilities.endpoint) {
      case '/v1/embeddings': return 'Embeddings';
      case '/v1/rerank': return 'Reranking';
      case '/v1/decisions': return 'Decision scoring';
      case '/v1/chat/completions': return capabilities.chat === false ? 'Subscription model' : 'Chat';
      case undefined: break;
      default: return 'Subscription model';
    }
    if (capabilities.embedding === true) return 'Embeddings';
    if (capabilities.rerank === true) return 'Reranking';
    if (capabilities.decisions === true) return 'Decision scoring';
    if (capabilities.chat === true) return 'Chat';
    // The service's chat routes currently publish output controls without a chat flag or endpoint.
    const chatFields = ['outputTokenLimit', 'automaticOutput', 'jsonSchema', 'context_window', 'context_compression'];
    const chat = capabilities.outputTokenLimit === true && typeof capabilities.automaticOutput === 'boolean'
      && typeof capabilities.jsonSchema === 'boolean' && Object.keys(capabilities).every(key => chatFields.includes(key));
    return chat ? 'Chat' : 'Subscription model';
  }

  function modelRow(model) {
    const row = document.createElement('li');
    row.className = 'model-row';
    const info = document.createElement('span');
    info.className = 'model-name';
    const name = document.createElement('b');
    name.textContent = model.name;
    const role = document.createElement('small');
    role.textContent = modelRole(model.capabilities);
    const description = document.createElement('span');
    description.className = 'model-description';
    const context = model.capabilities?.context_window;
    description.textContent = 'Model ID: ' + model.id
      + (Number.isSafeInteger(context) && context > 0 ? ' · ' + context.toLocaleString() + ' token context' : '');
    info.append(name, role, description);
    row.append(info);
    return row;
  }

  try {
    const response = await fetch('https://unbent-semicolon-hermit.ngrok-free.dev/v1/account/config', {
      method: 'GET',
      headers: {Accept: 'application/json', 'ngrok-skip-browser-warning': '1'},
      credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store', redirect: 'error',
      signal: AbortSignal.timeout(6000)
    });
    if (!response.ok) return;
    const config = await response.json();
    if (!Array.isArray(config?.redemptionModels)) return;
    const rows = [];
    for (const model of config.redemptionModels) {
      if (!model || typeof model.id !== 'string' || !model.id.trim()
        || (model.access !== undefined && typeof model.access !== 'string')) return;
      if (model.access !== 'requests') continue;
      if (typeof model.name !== 'string' || !model.name.trim()
        || (model.capabilities !== undefined && (!model.capabilities || typeof model.capabilities !== 'object' || Array.isArray(model.capabilities)))) return;
      rows.push(modelRow(model));
    }
    list.replaceChildren(...rows);
    status.textContent = 'From the REACH subscription service. Your account determines which models you can use.'
      + (rows.length ? '' : ' No subscription models are listed.');
  } catch {
    // The static page already identifies the date of its catalog.
  }
})();
