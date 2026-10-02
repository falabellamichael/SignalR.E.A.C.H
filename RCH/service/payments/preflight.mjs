// Go-live checks for the billing providers. READ-ONLY: every call is a GET or
// an OAuth token request, so running it never creates a charge, customer,
// order or email. Each check reports ok, problem, or skipped (when the key is
// not allowed to read that setting) with a plain-language fix.
import { STRIPE_API, STRIPE_VERSION } from './stripe.mjs';
import { PAYPAL_API } from './paypal.mjs';

export const STRIPE_EVENTS = ['invoice.paid', 'checkout.session.completed', 'checkout.session.async_payment_succeeded',
  'refund.created', 'refund.updated', 'charge.dispute.created'];
export const PAYPAL_EVENTS = ['CHECKOUT.ORDER.APPROVED', 'PAYMENT.CAPTURE.COMPLETED', 'PAYMENT.CAPTURE.REFUNDED', 'PAYMENT.CAPTURE.REVERSED',
  'PAYMENT.SALE.COMPLETED', 'PAYMENT.SALE.REFUNDED', 'PAYMENT.SALE.REVERSED'];

const ok = (check, detail) => ({ check, status: 'ok', detail });
const problem = (check, detail) => ({ check, status: 'problem', detail });
const skipped = (check, detail) => ({ check, status: 'skipped', detail });

async function get(fetchImpl, url, headers, timeoutMs) {
  try {
    const response = await fetchImpl(url, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(timeoutMs), headers });
    let data = null;
    try { data = await response.json(); } catch { /* status alone is enough */ }
    return { status: response.status, data };
  } catch { return { status: 0, data: null }; }
}
// Provider error text is never printed: it can echo keys or account details.
const unreachable = (check, name) => problem(check, `${name} could not be reached. Check the network and try again.`);
const refused = (check, name, status) => status === 401
  ? problem(check, `${name} rejected the key. Check that the environment variable holds the current key for this mode.`)
  : skipped(check, `This key is not allowed to read this setting (HTTP ${status}). Check it in the ${name} dashboard instead, or grant read access.`);

export async function checkStripe(stripe, { origin, fetchImpl = fetch, timeoutMs = 15000 }) {
  const headers = { Authorization: `Bearer ${stripe.secretKey}`, 'Stripe-Version': STRIPE_VERSION };
  const results = [];
  const price = await get(fetchImpl, `${STRIPE_API}/v1/prices/${encodeURIComponent(stripe.basicPriceId)}`, headers, timeoutMs);
  if (price.status === 0) return [unreachable('Stripe key and Basic price', 'Stripe')];
  if (price.status === 401) return [refused('Stripe key and Basic price', 'Stripe', 401)];
  if (price.status === 404) results.push(problem('Basic price', `Stripe has no price ${stripe.basicPriceId} in ${stripe.mode} mode. Copy the price ID from the REACH Basic product.`));
  else if (price.status !== 200) results.push(refused('Basic price', 'Stripe', price.status));
  else {
    const p = price.data, issues = [];
    if (p.livemode !== (stripe.mode === 'live')) issues.push(`it belongs to ${p.livemode ? 'live' : 'test'} mode`);
    if (p.active !== true) issues.push('it is archived');
    if (p.currency !== 'usd') issues.push(`its currency is ${String(p.currency).toUpperCase()}, not USD`);
    if (p.unit_amount !== 1500) issues.push(`it charges ${p.unit_amount ?? 'a variable amount'} cents, not 1500`);
    if (p.recurring?.interval !== 'month' || p.recurring?.interval_count !== 1) issues.push('it does not renew every month');
    if (p.recurring?.trial_period_days) issues.push('it has a free trial, which REACH does not grant');
    results.push(issues.length ? problem('Basic price', `Price ${stripe.basicPriceId} cannot be used: ${issues.join('; ')}.`)
      : ok('Basic price', 'US$15.00 a month, active.'));
  }
  const url = `${origin}/v1/billing/stripe/webhook`;
  const hooks = await get(fetchImpl, `${STRIPE_API}/v1/webhook_endpoints?limit=100`, headers, timeoutMs);
  if (hooks.status !== 200) results.push(hooks.status === 0 ? unreachable('Webhook', 'Stripe') : refused('Webhook', 'Stripe', hooks.status));
  else {
    const endpoint = (Array.isArray(hooks.data?.data) ? hooks.data.data : []).find(entry => entry?.url === url);
    const events = new Set(endpoint?.enabled_events ?? []);
    const missing = events.has('*') ? [] : STRIPE_EVENTS.filter(name => !events.has(name));
    results.push(!endpoint ? problem('Webhook', `No Stripe webhook sends to ${url}. Add it under Developers → Webhooks.`)
      : endpoint.status !== 'enabled' ? problem('Webhook', `The webhook to ${url} is disabled. Enable it in Stripe.`)
        : missing.length ? problem('Webhook', `The webhook to ${url} is missing these events: ${missing.join(', ')}.`)
          : ok('Webhook', `Sends all ${STRIPE_EVENTS.length} events to ${url}.`));
  }
  const portal = await get(fetchImpl, `${STRIPE_API}/v1/billing_portal/configurations?is_default=true&limit=1`, headers, timeoutMs);
  if (portal.status !== 200) results.push(portal.status === 0 ? unreachable('Customer portal', 'Stripe') : refused('Customer portal', 'Stripe', portal.status));
  else {
    const config = portal.data?.data?.[0];
    results.push(config?.features?.subscription_cancel?.enabled === true ? ok('Customer portal', 'Customers can cancel their subscription.')
      : problem('Customer portal', 'Customers cannot cancel in the portal yet. Turn on cancellation under Settings → Billing → Customer portal.'));
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
    token = (await response.json())?.access_token;
  } catch { return [unreachable('PayPal credentials', 'PayPal')]; }
  if (typeof token !== 'string') return [problem('PayPal credentials', 'PayPal did not issue an access token.')];
  const headers = { Authorization: `Bearer ${token}` };
  const results = [ok('PayPal credentials', `The ${paypal.mode} REST app credentials work.`)];

  const plan = await get(fetchImpl, `${base}/v1/billing/plans/${encodeURIComponent(paypal.basicPlanId)}`, headers, timeoutMs);
  if (plan.status === 404) results.push(problem('Basic plan', `PayPal has no plan ${paypal.basicPlanId} for this ${paypal.mode} app.`));
  else if (plan.status !== 200) results.push(plan.status === 0 ? unreachable('Basic plan', 'PayPal') : refused('Basic plan', 'PayPal', plan.status));
  else {
    const p = plan.data, cycles = Array.isArray(p.billing_cycles) ? p.billing_cycles : [], issues = [];
    const regular = cycles.filter(cycle => cycle?.tenure_type === 'REGULAR');
    const price = regular[0]?.pricing_scheme?.fixed_price;
    if (p.status !== 'ACTIVE') issues.push(`its status is ${p.status}, not ACTIVE`);
    if (cycles.some(cycle => cycle?.tenure_type === 'TRIAL')) issues.push('it has a trial period, which REACH does not grant');
    if (regular.length !== 1 || regular[0].frequency?.interval_unit !== 'MONTH' || regular[0].frequency?.interval_count !== 1) issues.push('it does not renew every month');
    if (price?.currency_code !== 'USD' || Number(price?.value) !== 15) issues.push(`it charges ${[price?.value, price?.currency_code].filter(Boolean).join(' ') || 'an unknown amount'}, not 15.00 USD`);
    if (Number(p.payment_preferences?.setup_fee?.value ?? 0) !== 0) issues.push('it has a setup fee');
    if (Number(p.taxes?.percentage ?? 0) !== 0) issues.push('it adds tax, which would make the amount differ from US$15.00');
    results.push(issues.length ? problem('Basic plan', `Plan ${paypal.basicPlanId} cannot be used: ${issues.join('; ')}.`)
      : ok('Basic plan', 'US$15.00 a month, active.'));
  }

  const url = `${origin}/v1/billing/paypal/webhook`;
  const hook = await get(fetchImpl, `${base}/v1/notifications/webhooks/${encodeURIComponent(paypal.webhookId)}`, headers, timeoutMs);
  if (hook.status === 404) results.push(problem('Webhook', `PayPal has no webhook ${paypal.webhookId} for this ${paypal.mode} app.`));
  else if (hook.status !== 200) results.push(hook.status === 0 ? unreachable('Webhook', 'PayPal') : refused('Webhook', 'PayPal', hook.status));
  else {
    const names = new Set((Array.isArray(hook.data?.event_types) ? hook.data.event_types : []).map(event => event?.name));
    const missing = names.has('*') ? [] : PAYPAL_EVENTS.filter(name => !names.has(name));
    results.push(hook.data?.url !== url ? problem('Webhook', `Webhook ${paypal.webhookId} sends to ${hook.data?.url}, not ${url}.`)
      : missing.length ? problem('Webhook', `Webhook ${paypal.webhookId} is missing these events: ${missing.join(', ')}.`)
        : ok('Webhook', `Sends all ${PAYPAL_EVENTS.length} events to ${url}.`));
  }
  return results;
}

export async function checkResend(resend, { fetchImpl = fetch, timeoutMs = 15000 }) {
  const domain = /@([^>\s]+)>?$/.exec(resend.from)?.[1]?.toLowerCase();
  const response = await get(fetchImpl, 'https://api.resend.com/domains', { Authorization: `Bearer ${resend.apiKey}` }, timeoutMs);
  if (response.status === 0) return [unreachable('Sending domain', 'Resend')];
  if (response.status !== 200) return [response.status === 401 && response.data?.name !== 'restricted_api_key'
    ? problem('Sending domain', 'Resend rejected the API key. Check the environment variable.')
    : skipped('Sending domain', `This key can only send email, so ${domain} could not be checked. Confirm it shows "Verified" under Domains in Resend.`)];
  const entry = (Array.isArray(response.data?.data) ? response.data.data : []).find(item => item?.name?.toLowerCase() === domain);
  return [!entry ? problem('Sending domain', `${domain} is not added to Resend. Add it under Domains and create its DNS records.`)
    : entry.status !== 'verified' ? problem('Sending domain', `${domain} is ${entry.status}, not verified. Finish its DNS records in Resend.`)
      : ok('Sending domain', `${domain} is verified.`)];
}

// Runs every configured provider's checks. Nothing configured is itself reported.
export async function checkBilling(config, options = {}) {
  const sections = [];
  if (config.payments?.stripe) sections.push({ provider: `Stripe (${config.payments.stripe.mode})`, results: await checkStripe(config.payments.stripe, { origin: config.origin, ...options }) });
  if (config.payments?.paypal) sections.push({ provider: `PayPal (${config.payments.paypal.mode})`, results: await checkPayPal(config.payments.paypal, { origin: config.origin, ...options }) });
  if (config.email?.resend) sections.push({ provider: 'Resend (sign-in email)', results: await checkResend(config.email.resend, options) });
  if (!config.subscription) sections.push({ provider: 'Basic plan', results: [problem('Subscription', 'No Basic subscription is configured in accounts.json.')] });
  if (!sections.length) sections.push({ provider: 'Billing', results: [problem('Providers', 'No payment provider or email sender is configured in accounts.json.')] });
  return { ready: sections.every(section => section.results.every(result => result.status !== 'problem')), sections };
}

export function formatReport(report) {
  const mark = { ok: 'OK     ', problem: 'PROBLEM', skipped: 'CHECK  ' };
  const lines = [];
  for (const section of report.sections) {
    lines.push(section.provider);
    for (const result of section.results) lines.push(`  ${mark[result.status]} ${result.check}: ${result.detail}`);
  }
  lines.push('', report.ready ? 'Ready: no problems found. Items marked CHECK need a look in the dashboard.' : 'Not ready: fix every PROBLEM above, then run this again.');
  return lines.join('\n');
}
