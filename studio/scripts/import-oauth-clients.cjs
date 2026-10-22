'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { validateClients } = require('../agent/oauth-clients.cjs');
const destination = path.join(__dirname, '..', 'oauth-clients.json');
const [provider, source, brokerOrigin] = process.argv.slice(2);
if (!['google', 'github', 'microsoft', 'slack', 'notion', 'discord'].includes(provider) || !source) throw new Error('Import a Google Desktop JSON or a public provider client ID. Hosted providers also require the HTTPS callback service origin.');
const current = fs.existsSync(destination) ? JSON.parse(fs.readFileSync(destination, 'utf8')) : {};
if (provider === 'google') {
  const downloaded = JSON.parse(fs.readFileSync(path.resolve(source), 'utf8'));
  if (!downloaded.installed || downloaded.web) throw new Error('Import a Google Desktop client, not a web application client.');
  current.google = { clientId: downloaded.installed.client_id, clientSecret: downloaded.installed.client_secret };
} else current[provider] = { clientId: source, ...(brokerOrigin ? { brokerOrigin } : {}) };
const value = validateClients(current);
fs.writeFileSync(destination, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
console.log('Publisher configuration saved for: ' + Object.keys(value).join(', ') + '. No customer credentials were imported.');
