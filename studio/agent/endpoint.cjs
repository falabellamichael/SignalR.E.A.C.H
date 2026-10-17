'use strict';

/* Shared by every request path. Kept independent of Electron so pointer
 * resolution and rejection paths are executable under the unit-test runner. */
const LOGIN_PROVIDERS_ENDPOINT = 'http://127.0.0.1:20777/_reach/login-providers';

function isLoginProvidersEndpoint(value) {
  return String(value || '').replace(/\/+$/, '') === LOGIN_PROVIDERS_ENDPOINT;
}

// The catalog marker belongs only to this fixed local service. Never forward a
// connection key or follow a redirect from the private login-provider API.
function providerRequestOptions(endpoint, accessKey, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (isLoginProvidersEndpoint(endpoint)) {
    for (const key of Object.keys(headers)) if (key.toLowerCase() === 'authorization') delete headers[key];
    headers['X-Reach-Client'] = 'studio';
    return { ...options, headers, redirect: 'error' };
  }
  if (accessKey) headers.Authorization = 'Bearer ' + accessKey;
  return { ...options, headers };
}

async function resolveEndpoint(raw, depth = 0) {
  if (depth > 3) throw new Error('Endpoint pointer redirects in a loop.');
  const url = new URL(raw);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('Use an HTTP or HTTPS endpoint without embedded credentials.');
  }
  if (isLoginProvidersEndpoint(String(raw).replace(/\/(?:models|chat\/completions)\/?$/, ''))) return LOGIN_PROVIDERS_ENDPOINT;
  if (url.hostname === 'gist.githubusercontent.com' || /\.txt(?:\/v1)?\/?$/.test(url.pathname)) {
    url.pathname = url.pathname.replace(/\/v1\/?$/, '');
    const response = await fetch(url.toString(), { signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error(`Endpoint pointer returned HTTP ${response.status}`);
    const target = (await response.text()).trim();
    return resolveEndpoint(target, depth + 1);
  }
  // A pasted endpoint may already carry a version segment AND a trailing API
  // path (".../v1/models"), which the plain /v1$ strip below cannot see because
  // the path ends in "/models", producing ".../v1/models/v1" and a 404. Reduce a
  // known API path back to its version root first, so both spellings converge.
  url.pathname = url.pathname.replace(/\/(?:models|chat\/completions|completions)\/?$/, '');
  url.pathname = url.pathname.replace(/\/+$/, '').replace(/\/v1$/, '') + '/v1';
  url.search = ''; url.hash = '';
  return url.toString().replace(/\/$/, '');
}

module.exports = { resolveEndpoint, LOGIN_PROVIDERS_ENDPOINT, isLoginProvidersEndpoint, providerRequestOptions };
