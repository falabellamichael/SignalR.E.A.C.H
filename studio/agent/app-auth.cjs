'use strict';

// Access tokens can be opaque (including personal Microsoft accounts). Do not
// decode them or require JWT syntax. Only remove pasted header/wrapping text.
function normalizeToken(value) {
  const token = String(value || '').trim().replace(/^Authorization:\s*/i, '').replace(/^(Bearer|Bot)\s+/i, '').replace(/[\r\n\t]/g, '').trim();
  if (!token) throw new Error('Paste the complete access token before saving.');
  if (token.length > 16384) throw new Error('The access token is too long. Copy only the access token, not the entire response.');
  if (/\s/.test(token)) throw new Error('The access token contains spaces. Use the token copy button and paste the complete token.');
  return token;
}

const names = { todo: 'Microsoft To Do', outlook: 'Outlook', gmail: 'Gmail', drive: 'Google Drive', calendar: 'Google Calendar', slack: 'Slack', notion: 'Notion', discord: 'Discord' };
const permissions = { todo: 'Tasks.Read or Tasks.ReadWrite', outlook: 'Mail.Read', gmail: 'gmail.readonly', drive: 'drive.readonly', calendar: 'calendar.readonly', slack: 'search:read' };

function connectionError(id, status, data = {}) {
  const name = names[id] || 'App';
  // Provider messages are used only to select static guidance. Never return a
  // raw response, which may echo credentials, account details or other content.
  const error = data?.error;
  const code = typeof error === 'string' ? error : error?.code || data?.code;
  const message = typeof error?.message === 'string' ? error.message.toLowerCase() : '';
  const googleReason = error?.errors?.[0]?.reason;
  const google = ['gmail', 'drive', 'calendar'].includes(id);
  const microsoft = ['todo', 'outlook'].includes(id);
  let advice;
  if (status === 429 || code === 'ratelimited') advice = 'The service is rate limiting requests. Wait a moment before checking again.';
  else if (google && (googleReason === 'accessNotConfigured' || Array.isArray(error?.details) && error.details.some(item => item?.reason === 'SERVICE_DISABLED'))) advice = `Enable the ${name} API in the Google Cloud project that issued this token, then check again.`;
  else if (google && code === 'invalid_client') advice = 'Check the Google Desktop OAuth client ID and client secret, then connect again.';
  else if (google && code === 'invalid_grant') advice = 'Google sign-in has expired or was revoked. Connect Google again.';
  else if (microsoft && message.includes('audience')) advice = 'This token was issued for a different service. Obtain a Microsoft Graph access token.';
  else if (microsoft && /expired|lifetime validation/.test(message)) advice = 'The Microsoft access token has expired. Copy a fresh token from Graph Explorer, Save, then Check.';
  else if (microsoft && (status === 401 || status === 403)) advice = `In Graph Explorer, sign in to the same account, grant ${permissions[id]}, and run ${id === 'todo' ? 'GET /me/todo/lists' : 'GET /me/messages'}. Once it succeeds, copy the new access token here, Save, then Check. Pasted tokens expire and must be replaced.`;
  else if (id === 'slack' && code === 'missing_scope') advice = 'Use a Slack user OAuth token with search:read; a bot token cannot search messages.';
  else if (id === 'slack' && ['invalid_auth', 'token_revoked', 'token_expired', 'not_authed'].includes(code)) advice = 'Reconnect Slack with a current user OAuth token that includes search:read.';
  else if (status === 401) advice = google ? 'The Google access token is invalid or expired. Use a fresh OAuth access token; an API key or app password will not work.' : 'The access token is invalid or expired. Reconnect this app.';
  else if (status === 403 || googleReason === 'insufficientPermissions') advice = permissions[id] ? `Grant ${permissions[id]} and reconnect with a new access token.` : id === 'discord' ? 'Give the bot access to the channel and Read Message History. Enable Message Content intent for message text.' : 'Grant the integration access to the requested resource.';
  else if (status === 404) advice = 'Check the resource ID and share the resource with this connection.';
  else advice = 'Check this app’s setup and try again.';
  return new Error(`${name} ${status >= 400 ? `returned HTTP ${status}` : 'request was refused'}. ${advice}`);
}

module.exports = { normalizeToken, connectionError };
