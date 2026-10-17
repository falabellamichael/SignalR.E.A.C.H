// Email sign-in: the code from the email, typed into the same
// browser page that wallet sign-in uses. The code only authorizes the existing
// PKCE sign-in flow, so Studio and VS Code finish exactly as they do for a
// wallet. Nothing here touches balances.
import { createHash, randomInt } from 'node:crypto';
import { fail } from './errors.mjs';

export const EMAIL_CODE_TTL_MS = 10 * 60 * 1000;
export const EMAIL_CODE_ATTEMPTS = 5;
// Per address: one code a minute and five an hour. Per service: 500 an hour,
// which also caps what a flood of sign-ups can cost on the sending account.
export const EMAIL_COOLDOWN_MS = 60 * 1000;
export const EMAIL_PER_ADDRESS_PER_HOUR = 5;
export const EMAIL_PER_SERVICE_PER_HOUR = 500;
export const EMAIL_WINDOW_MS = 60 * 60 * 1000;

const ADDRESS = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

// One canonical form per address, so the same person always reaches the same
// account. Case is folded; nothing else (dots, plus tags) is rewritten.
export function normalizeEmail(value) {
  const email = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (email.length > 254 || !ADDRESS.test(email)) fail(400, 'email_invalid', 'Enter a valid email address.');
  return email;
}

export const emailCode = () => String(randomInt(0, 1_000_000)).padStart(6, '0');
// Salted by the challenge ID so a code is only ever valid for its own challenge.
export const emailCodeHash = (challengeId, code) => createHash('sha256').update(`${challengeId}:${code}`).digest('hex');
// Supabase Auth emails an 8-digit code. The Resend fallback still generates 6.
export const validEmailCode = code => typeof code === 'string' && /^(?:\d{6}|\d{8})$/.test(code);

// Sends the sign-in code through the Supabase project's own email auth and
// checks the code there. The REACH account row is still created in the same
// Supabase project by the account store after the code is accepted.
export function createSupabaseOtpMailer({ url, secretKey, fetchImpl = fetch, timeoutMs = 15000 }) {
  const headers = { 'content-type': 'application/json', apikey: secretKey, authorization: `Bearer ${secretKey}` };
  async function post(pathname, body) {
    let response;
    try {
      response = await fetchImpl(new URL(pathname, url), { method: 'POST', headers, redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs), body: JSON.stringify(body) });
    } catch { fail(502, 'email_unavailable', 'The sign-in email could not be sent. Try again shortly.'); }
    return response;
  }
  return {
    kind: 'supabase',
    async sendSignInCode({ to }) {
      const response = await post('/auth/v1/otp', { email: to, create_user: true });
      if (response.status === 429) fail(429, 'email_rate_limit', 'Supabase is temporarily limiting sign-in emails. Wait about an hour, then request a new code.');
      if (!response.ok) fail(502, 'email_unavailable', 'The sign-in email could not be sent. Try again shortly.');
    },
    async verifyCode({ email, code }) {
      const response = await post('/auth/v1/verify', { type: 'email', email, token: code });
      return response.ok;
    },
  };
}

export function createResendMailer({ apiKey, from, fetchImpl = fetch, timeoutMs = 15000 }) {
  return {
    async sendSignInCode({ to, code, challengeId, host }) {
      const text = `Your REACH sign-in code is ${code}\n\nEnter it on the ${host} sign-in page within 10 minutes.\n`
        + 'If you did not try to sign in, ignore this email. Nobody can sign in without the code.\n';
      let response;
      try {
        response = await fetchImpl('https://api.resend.com/emails', {
          method: 'POST', redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
          // A retried request for the same challenge never sends a second email.
          headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', 'Idempotency-Key': `reach-signin-${challengeId}` },
          // The code stays out of the subject, which lock screens show.
          body: JSON.stringify({ from, to: [to], subject: 'Your REACH sign-in code', text }),
        });
      } catch { fail(502, 'email_unavailable', 'The sign-in email could not be sent. Try again shortly.'); }
      // Provider errors can name the key or domain; they never reach the customer.
      if (!response.ok) fail(502, 'email_unavailable', 'The sign-in email could not be sent. Try again shortly.');
    },
  };
}
