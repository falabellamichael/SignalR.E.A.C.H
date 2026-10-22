'use strict';

const fs = require('node:fs');
const path = require('node:path');

// Publisher registration metadata is separate from the customer's settings vault.
// Only Google Desktop clients have a public-client secret; never put a web app
// secret, bot token, or a customer's grant in this file.
function validateClients(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid OAuth application configuration.');
  const out = {};
  for (const [provider, value] of Object.entries(input)) {
    const hosted = ['slack', 'notion', 'discord'].includes(provider);
    const fields = provider === 'google' ? ['clientId', 'clientSecret'] : hosted ? ['clientId', 'brokerOrigin'] : ['clientId'];
    if (!['google', 'github', 'microsoft', 'slack', 'notion', 'discord'].includes(provider) || !value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Unsupported OAuth application configuration.');
    if (Object.keys(value).some(key => !fields.includes(key))) throw new Error('OAuth application configuration contains unsupported credential fields.');
    if (typeof value.clientId !== 'string' || !/^[A-Za-z0-9._-]{3,256}$/.test(value.clientId)) throw new Error('Invalid OAuth application client ID.');
    if (provider === 'google' && !value.clientId.endsWith('.apps.googleusercontent.com')) throw new Error('A Google Desktop OAuth client is required.');
    if (value.clientSecret !== undefined && (typeof value.clientSecret !== 'string' || !/^[A-Za-z0-9._-]{1,256}$/.test(value.clientSecret))) throw new Error('Invalid Google Desktop client configuration.');
    if (value.brokerOrigin !== undefined) {
      const url = new URL(value.brokerOrigin);
      if (!hosted || url.protocol !== 'https:' || url.origin !== value.brokerOrigin || url.username || url.password) throw new Error('Invalid OAuth callback service configuration.');
    }
    if (['notion', 'discord'].includes(provider) && !value.brokerOrigin) throw new Error('A hosted OAuth callback service is required.');
    out[provider] = Object.freeze({ ...value });
  }
  return Object.freeze(out);
}

function loadClients(file = path.join(__dirname, '..', 'oauth-clients.json')) {
  if (!fs.existsSync(file)) return Object.freeze({});
  try { return validateClients(JSON.parse(fs.readFileSync(file, 'utf8'))); }
  catch { throw new Error('REACH OAuth application configuration is invalid. Reinstall a correctly configured build.'); }
}

module.exports = { loadClients, validateClients };
