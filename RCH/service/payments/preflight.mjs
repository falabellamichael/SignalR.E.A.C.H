// Read-only provider configuration checks. Only GET requests and a PayPal
// OAuth token request are made; no charge, customer, order or email is created.
// Permission checks remain unverified and never count as readiness.
import { STRIPE_API, STRIPE_VERSION } from './stripe.mjs';
import { PAYPAL_API } from './paypal.mjs';

export const STRIPE_EVENTS = ['invoice.paid', 'checkout.session.completed', 'checkout.session.async_payment_succeeded',
  'refund.created', 'refund.updated', 'charge.dispute.created'];
export const PAYPAL_EVENTS = ['CHECKOUT.ORDER.APPROVED', 'PAYMENT.CAPTURE.COMPLETED', 'PAYMENT.CAPTURE.REFUNDED', 'PAYMENT.CAPTURE.REVERSED',
  'PAYMENT.SALE.COMPLETED', 'PAYMENT.SALE.REFUNDED', 'PAYMENT.SALE.REVERSED'];

const ok = (check, detail) => ({ check, status: 'ok', detail });
const problem = (check, detail) => ({ check, status: 'problem', detail });
const skipped = (check, detail) => ({ check, status: 'skipped', detail });
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const currency = value => typeof value === 'string' && /^[a-z]{3}$/i.test(value) ? value.toUpperCase() : 'unknown';
const decimal = value => typeof value === 'string' && /^\d{1,12}(?:\.\d{1,6})?$/.test(value) ? value : 'an unknown amount';
const malformed = (check, name) => problem(check, `${name} returned an incomplete or invalid setting. Try again and verify it in the dashboard.`);

async function get(fetchImpl, url, headers, timeoutMs) {
  try {
    const response = await fetchImpl(url, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(timeoutMs), headers });
    let data = null;
    try { data = await response.json(); } catch { /* status alone is enough */ }
    return { status: response.status, data };
  } catch { return { status: 0, data: null }; }
}
// Never print raw provider error text or unchecked response strings: they may
// echo credentials, account details or a URL containing a secret.
const unreachable = (check, name) => problem(check, `${name} could not be reached. Check the network and try again.`);
const refused = (check, name, status) => status === 401
  ? problem(check, `${name} rejected the key. Check that the environment variable holds the current key for this mode.`)
  : status === 403
    ? skipped(check, `This key could not read this setting (HTTP 403). Verify it in the ${name} dashboard, or use authorized read access.`)
    : problem(check, `${name} could not verify this setting (HTTP ${status}). Resolve the request failure or try again after the provider recovers.`);

export async function checkStripe(stripe, { origin, fetchImpl = fetch, timeoutMs = 15000 }) {
  const headers = { Authorization: `Bearer ${stripe.secretKey}`, 'Stripe-Version': STRIPE_VERSION };
  const results = [];
  const price = await get(fetchImpl, `${STRIPE_API}/v1/prices/${encodeURIComponent(stripe.basicPriceId)}`, headers, timeoutMs);
  if (price.status === 0) return [unreachable('Stripe key and Basic price', 'Stripe')];
  if (price.status === 401) return [refused('Stripe key and Basic price', 'Stripe', 401)];
  if (price.status === 404) results.push(problem('Basic price', `Stripe has no price ${stripe.basicPriceId} in ${stripe.mode} mode. Copy the price ID from the REACH Basic product.`));
  else if (price.status !== 200) results.push(refused('Basic price', 'Stripe', price.status));
  else if (!object(price.data)) results.push(malformed('Basic price', 'Stripe'));
  else {
    const p = price.data, issues = [];
    if (p.id !== stripe.basicPriceId) issues.push('its ID does not match the configured price');
    if (p.livemode !== (stripe.mode === 'live')) issues.push(typeof p.livemode === 'boolean' ? `it belongs to ${p.livemode ? 'live' : 'test'} mode` : 'its mode could not be verified');
    if (p.active !== true) issues.push('it is archived or unavailable');
    if (p.currency !== 'usd') issues.push(`its currency is ${currency(p.currency)}, not USD`);
    if (p.unit_amount !== 1500) issues.push(`it charges ${Number.isSafeInteger(p.unit_amount) ? p.unit_amount : 'a variable or unknown amount'} cents, not 1500`);
    if (p.recurring?.interval !== 'month' || p.recurring?.interval_count !== 1) issues.push('it does not renew every month');
    if (p.billing_scheme !== 'per_unit' || p.recurring?.usage_type !== 'licensed' || p.transform_quantity != null) issues.push('it is not a fixed price for one subscription');
    if (p.recurring?.trial_period_days) issues.push('it has a free trial, which REACH does not grant');
    results.push(issues.length ? problem('Basic price', `Price ${stripe.basicPriceId} cannot be used: ${issues.join('; ')}.`)
      : ok('Basic price', 'US$15.00 a month, active.'));
  }
  const url = `${origin}/v1/billing/stripe/webhook`;
  const hooks = await get(fetchImpl, `${STRIPE_API}/v1/webhook_endpoints?limit=100`, headers, timeoutMs);
  if (hooks.status !== 200) results.push(hooks.status === 0 ? unreachable('Webhook', 'Stripe') : refused('Webhook', 'Stripe', hooks.status));
  else if (!Array.isArray(hooks.data?.data)) results.push(malformed('Webhook', 'Stripe'));
  else {
    const endpoint = hooks.data.data.find(entry => entry?.url === url);
    const validEvents = Array.isArray(endpoint?.enabled_events) && endpoint.enabled_events.every(name => typeof name === 'string');
    const events = new Set(validEvents ? endpoint.enabled_events : []);
    const missing = events.has('*') ? [] : STRIPE_EVENTS.filter(name => !events.has(name));
    results.push(!endpoint ? problem('Webhook', `No Stripe webhook sends to ${url}. Add it under Developers > Webhooks.`)
      : endpoint.status !== 'enabled' ? problem('Webhook', `The webhook to ${url} is disabled. Enable it in Stripe.`)
        : !validEvents ? malformed('Webhook', 'Stripe')
          : missing.length ? problem('Webhook', `The webhook to ${url} is missing these events: ${missing.join(', ')}.`)
            : ok('Webhook', `Sends all ${STRIPE_EVENTS.length} events to ${url}.`));
  }
  const portal = await get(fetchImpl, `${STRIPE_API}/v1/billing_portal/configurations?is_default=true&limit=1`, headers, timeoutMs);
  if (portal.status !== 200) results.push(portal.status === 0 ? unreachable('Customer portal', 'Stripe') : refused('Customer portal', 'Stripe', portal.status));
  else {
    const config = Array.isArray(portal.data?.data) ? portal.data.data[0] : null;
    results.push(config?.active === true && config.is_default === true && config.livemode === (stripe.mode === 'live') && config.features?.subscription_cancel?.enabled === true
      ? ok('Customer portal', 'Customers can cancel their subscription in the active default portal.')
      : problem('Customer portal', 'Customers cannot cancel in the portal yet. Turn on cancellation in the active default portal for this mode under Settings > Billing > Customer portal.'));
  }
  return results;
}

export async function checkPayPal(paypal, { origin, fetchImpl = fetch, timeoutMs = 15000 }) {
  const base = PAYPAL_API[paypal.mode];
  let token;
  try {
    const response = await fetchImpl(`${base}/v1/oauth2/token`, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
      headers: { Authorization: `Basic ${Buffer.from(`${paypal.clientId}:${paypal.clientSecret}`).toString('base64')}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=client_credentials' });
    if (response.status === 401) return [problem('PayPal credentials', `PayPal rejected the client ID or secret. Use the ${paypal.mode} app's credentials.`)];
    if (!response.ok) return [refused('PayPal credentials', 'PayPal', response.status)];
    try { token = (await response.json())?.access_token; } catch { /* invalid JSON is an invalid token response */ }
  } catch { return [unreachable('PayPal credentials', 'PayPal')]; }
  if (typeof token !== 'string' || !token.trim() || /[\r\n]/.test(token)) return [problem('PayPal credentials', 'PayPal did not issue an access token.')];
  const headers = { Authorization: `Bearer ${token}` };
  const results = [ok('PayPal credentials', `The ${paypal.mode} REST app credentials work.`)];

  const plan = await get(fetchImpl, `${base}/v1/billing/plans/${encodeURIComponent(paypal.basicPlanId)}`, headers, timeoutMs);
  if (plan.status === 404) results.push(problem('Basic plan', `PayPal has no plan ${paypal.basicPlanId} for this ${paypal.mode} app.`));
  else if (plan.status !== 200) results.push(plan.status === 0 ? unreachable('Basic plan', 'PayPal') : refused('Basic plan', 'PayPal', plan.status));
  else if (!object(plan.data)) results.push(malformed('Basic plan', 'PayPal'));
  else {
    const p = plan.data, cycles = Array.isArray(p.billing_cycles) ? p.billing_cycles : [], issues = [];
    const regular = cycles.filter(cycle => cycle?.tenure_type === 'REGULAR');
    const price = regular[0]?.pricing_scheme?.fixed_price;
    if (p.id !== paypal.basicPlanId) issues.push('its ID does not match the configured plan');
    if (p.status !== 'ACTIVE') issues.push(`its status is ${['CREATED', 'INACTIVE'].includes(p.status) ? p.status : 'unknown'}, not ACTIVE`);
    if (cycles.some(cycle => cycle?.tenure_type === 'TRIAL')) issues.push('it has a trial period, which REACH does not grant');
    if (regular.length !== 1 || regular[0].frequency?.interval_unit !== 'MONTH' || regular[0].frequency?.interval_count !== 1) issues.push('it does not renew every month');
    if (regular[0]?.total_cycles !== 0) issues.push('it does not renew indefinitely');
    if (price?.currency_code !== 'USD' || decimal(price?.value) === 'an unknown amount' || Number(price.value) !== 15) issues.push(`it charges ${decimal(price?.value)} ${currency(price?.currency_code)}, not 15.00 USD`);
    if (Number(p.payment_preferences?.setup_fee?.value ?? 0) !== 0) issues.push('it has a setup fee');
    if (Number(p.taxes?.percentage ?? 0) !== 0) issues.push('it adds tax, which would make the amount differ from US$15.00');
    results.push(issues.length ? problem('Basic plan', `Plan ${paypal.basicPlanId} cannot be used: ${issues.join('; ')}.`)
      : ok('Basic plan', 'US$15.00 a month, active.'));
  }

  const url = `${origin}/v1/billing/paypal/webhook`;
  const hook = await get(fetchImpl, `${base}/v1/notifications/webhooks/${encodeURIComponent(paypal.webhookId)}`, headers, timeoutMs);
  if (hook.status === 404) results.push(problem('Webhook', `PayPal has no webhook ${paypal.webhookId} for this ${paypal.mode} app.`));
  else if (hook.status !== 200) results.push(hook.status === 0 ? unreachable('Webhook', 'PayPal') : refused('Webhook', 'PayPal', hook.status));
  else if (!object(hook.data) || !Array.isArray(hook.data.event_types)) results.push(malformed('Webhook', 'PayPal'));
  else {
    const names = new Set(hook.data.event_types.map(event => event?.name));
    const missing = names.has('*') ? [] : PAYPAL_EVENTS.filter(name => !names.has(name));
    results.push(hook.data.url !== url ? problem('Webhook', `Webhook ${paypal.webhookId} must send to ${url}. Correct its URL in PayPal.`)
      : missing.length ? problem('Webhook', `Webhook ${paypal.webhookId} is missing these events: ${missing.join(', ')}.`)
        : ok('Webhook', `Sends all ${PAYPAL_EVENTS.length} events to ${url}.`));
  }
  return results;
}

export async function checkResend(resend, { fetchImpl = fetch, timeoutMs = 15000 }) {
  const domain = /@([^>\s]+)>?$/.exec(resend.from)?.[1]?.toLowerCase();
  const response = await get(fetchImpl, 'https://api.resend.com/domains', { Authorization: `Bearer ${resend.apiKey}` }, timeoutMs);
  if (response.status === 0) return [unreachable('Sending domain', 'Resend')];
  if (response.status !== 200) {
    // Resend's 401 restricted_api_key means send-only; its 403 with the same
    // name means an inactive key, and must be treated as a problem.
    if (response.status === 401 && response.data?.name === 'restricted_api_key' || response.status === 403 && response.data?.name === 'invalid_permission') {
      return [skipped('Sending domain', `This key cannot read domains, so ${domain} could not be checked. Confirm it shows "Verified" under Domains in Resend.`)];
    }
    return [response.status === 403 ? problem('Sending domain', 'Resend denied domain access. Check that the API key is active and has the required permissions.')
      : refused('Sending domain', 'Resend', response.status)];
  }
  if (!Array.isArray(response.data?.data)) return [malformed('Sending domain', 'Resend')];
  const entry = response.data.data.find(item => typeof item?.name === 'string' && item.name.toLowerCase() === domain);
  const status = ['pending', 'failed', 'temporary_failure', 'not_started'].includes(entry?.status) ? entry.status : 'unverified';
  return [!entry ? problem('Sending domain', `${domain} is not added to Resend. Add it under Domains and create its DNS records.`)
    : entry.status !== 'verified' ? problem('Sending domain', `${domain} is ${status}, not verified. Finish its DNS records in Resend.`)
      : ok('Sending domain', `${domain} is verified.`)];
}

export async function checkBilling(config, options = {}) {
  const sections = [];
  if (config.payments?.stripe) sections.push({ provider: `Stripe (${config.payments.stripe.mode})`, results: await checkStripe(config.payments.stripe, { origin: config.origin, ...options }) });
  if (config.payments?.paypal) sections.push({ provider: `PayPal (${config.payments.paypal.mode})`, results: await checkPayPal(config.payments.paypal, { origin: config.origin, ...options }) });
  if (config.email?.resend) sections.push({ provider: 'Resend (sign-in email)', results: await checkResend(config.email.resend, options) });
  if (!config.subscription) sections.push({ provider: 'Basic plan', results: [problem('Subscription', 'No Basic subscription is configured in accounts.json.')] });
  if (!config.payments?.stripe && !config.payments?.paypal) sections.push({ provider: 'Billing', results: [problem('Providers', 'No payment provider is configured in accounts.json.')] });
  return { ready: sections.every(section => section.results.every(result => result.status === 'ok')), sections };
}

export function formatReport(report) {
  const mark = { ok: 'OK     ', problem: 'PROBLEM', skipped: 'CHECK  ' };
  const lines = [];
  for (const section of report.sections) {
    lines.push(section.provider);
    for (const result of section.results) lines.push(`  ${mark[result.status]} ${result.check}: ${result.detail}`);
  }
  const hasProblem = report.sections.some(section => section.results.some(result => result.status === 'problem'));
  lines.push('', report.ready ? 'Ready: provider configuration verified. Complete the database, delivery and payment tests in go-live.md before going live.'
    : hasProblem ? 'Not ready: fix every PROBLEM and verify every CHECK above, then run this again.'
      : 'Not verified: every CHECK needs verification in the dashboard or with authorized read access. This check cannot certify readiness yet.');
  return lines.join('\n');
}
