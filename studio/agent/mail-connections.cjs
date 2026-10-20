'use strict';

// Mail credentials stay in the settings vault. They are never included in a
// model prompt or a connection-status response.
const refreshes = new Map();
async function jsonRequest(url, options = {}) {
  const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(20000)]) : AbortSignal.timeout(20000);
  const response = await fetch(url, { ...options, redirect: 'error', signal });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Mail service returned HTTP ${response.status}. ${response.status === 401 ? 'Reconnect this account.' : response.status === 403 ? 'Check the granted permissions and enable the Gmail API in your Google Cloud project.' : 'Try again or check your connection.'}`);
  return data;
}
async function gmailToken(config = {}) {
  if (config.enabled === false) throw new Error('Gmail connection is disabled.');
  if (config.accessToken && Number(config.expiresAt) > Date.now() + 60000) return config.accessToken;
  if (config.refreshToken && config.clientId) {
    const key = config.refreshToken;
    const previous = refreshes.get(key);
    if (previous && previous.expiresAt > Date.now() + 60000) return previous.token;
    if (previous?.pending) return previous.pending;
    const pending = (async () => {
      const body = new URLSearchParams({ client_id: config.clientId, refresh_token: key, grant_type: 'refresh_token' });
      if (config.clientSecret) body.set('client_secret', config.clientSecret);
      const data = await jsonRequest('https://oauth2.googleapis.com/token', { method: 'POST', body });
      if (!data.access_token) throw new Error('Google did not return an access token. Reconnect Gmail.');
      if (refreshes.size > 20) refreshes.clear();
      refreshes.set(key, { token: data.access_token, expiresAt: Date.now() + (Number(data.expires_in) || 3600) * 1000 });
      return data.access_token;
    })();
    refreshes.set(key, { pending });
    try { return await pending; } catch (error) { refreshes.delete(key); throw error; }
  }
  // The old password field can hold a short-lived OAuth access token. Google
  // app passwords are not Gmail REST API credentials and must fail honestly.
  const token = config.accessToken || config.password;
  if (!token) throw new Error('Connect Gmail in Connections first.');
  return token;
}
async function gmailFetch(config, route, { signal, ...options } = {}) {
  const token = await gmailToken(config);
  return jsonRequest('https://gmail.googleapis.com/gmail/v1/users/me/' + route, {
    ...options, signal, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
  });
}
async function gmailRead(config, args = {}, signal) {
  const query = String(args.query || '').slice(0, 400), limit = Math.min(20, Math.max(1, Number(args.limit) || 5));
  const list = await gmailFetch(config, 'messages?' + new URLSearchParams({ q: query, maxResults: String(limit) }), { signal });
  const messages = [];
  for (const item of list.messages || []) {
    signal?.throwIfAborted();
    const message = await gmailFetch(config, 'messages/' + encodeURIComponent(item.id) + '?format=full', { signal });
    const header = name => message.payload?.headers?.find(h => h.name.toLowerCase() === name)?.value || '';
    const parts = [];
    function collect(part) {
      if (part?.mimeType === 'text/plain' && part.body?.data) parts.push(Buffer.from(part.body.data, 'base64url').toString('utf8'));
      for (const child of part?.parts || []) collect(child);
    }
    collect(message.payload);
    messages.push({ id: item.id, from: header('from'), to: header('to'), subject: header('subject'), date: header('date'),
      snippet: message.snippet || '', body: parts.join('\n').slice(0, 12000), url: 'https://mail.google.com/mail/u/0/#all/' + encodeURIComponent(item.id) });
  }
  return { ok: true, account: config.email || '', query, messages };
}
function rawMessage(config, args) {
  for (const value of [config.email, args.to, args.subject]) if (typeof value !== 'string' || /[\r\n]/.test(value)) throw new Error('Invalid email header.');
  if (!args.to || !args.subject || !args.body) throw new Error('Recipient, subject and body are required.');
  const subject = '=?UTF-8?B?' + Buffer.from(args.subject).toString('base64') + '?=';
  return Buffer.from(`From: ${config.email}\r\nTo: ${args.to}\r\nSubject: ${subject}\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${Buffer.from(String(args.body)).toString('base64')}`).toString('base64url');
}
async function gmailSend(config, args, signal) {
  const result = await gmailFetch(config, 'messages/send', { method: 'POST', signal, body: JSON.stringify({ raw: rawMessage(config, args) }) });
  if (!result.id) throw new Error('Gmail did not confirm the send. Check Sent Mail before retrying.');
  return { ok: true, sent: true, id: result.id, to: args.to, subject: args.subject };
}
async function outlookFetch(config, route, options = {}) {
  if (config?.enabled === false || !config?.password) throw new Error('Add a Microsoft Graph OAuth access token in Connections.');
  return jsonRequest('https://graph.microsoft.com/v1.0/me' + route, { ...options, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + config.password } });
}
module.exports = { gmailFetch, gmailRead, gmailSend, outlookFetch };
