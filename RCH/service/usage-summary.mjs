// Account-owned aggregate analytics. Never return prompts, responses, payment
// references, wallet addresses or credentials to the control panel.
import { fail } from './errors.mjs';

export function usagePeriod(from, to, now = Date.now()) {
  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 0 || to <= from
    || to > now + 60000 || to - from > 366 * 86400000) {
    fail(400, 'invalid_usage_period', 'Choose a reporting period of up to 366 days.');
  }
  return { from, to };
}
const count = n => Number.isSafeInteger(n) && n >= 0;
const parse = text => { try { return typeof text === 'string' ? JSON.parse(text) : text; } catch { return null; } };
function counters(value, trusted = false) {
  if (!value || (!trusted && value.usage_source !== 'provider')) return null;
  const u = trusted ? value : value.usage;
  const input = trusted ? u?.promptTokens : u?.prompt_tokens;
  const output = trusted ? u?.completionTokens : u?.completion_tokens;
  const total = trusted ? u?.totalTokens : u?.total_tokens;
  const cached = (trusted ? u?.details?.prompt?.cached_tokens : u?.prompt_tokens_details?.cached_tokens) ?? 0;
  return [input, output, total, cached].every(count) && input + output === total && cached <= input
    ? { input, output, cached } : null;
}
export function recordedTokens(usage, replay) {
  const settled = counters(parse(usage), true);
  if (settled) return settled;
  const record = parse(replay);
  if (!record || typeof record.body !== 'string') return null;
  if (record.contentType !== 'text/event-stream') return counters(parse(record.body));
  let latest = null;
  for (const line of record.body.split('\n')) {
    if (line.startsWith('data:')) latest = counters(parse(line.slice(5).trim())) || latest;
  }
  return latest;
}
export function emptyRequestGroup(model, status) {
  return { model, status, count: 0, input_tokens: 0, output_tokens: 0, cached_tokens: 0,
    measured_count: 0, credit_usd_micros: 0, rch_usd_micros: 0, legacy_credit_tokens: 0 };
}
export function addRequest(group, row) {
  group.count++;
  if (row.status !== 'settled') return;
  const usage = parse(row.usage);
  const tokens = recordedTokens(row.usage, row.replay);
  if (tokens) {
    group.measured_count++;
    group.input_tokens += tokens.input;
    group.output_tokens += tokens.output;
    group.cached_tokens += tokens.cached;
  }
  const charge = row.currency === 'USD' ? usage?.chargedUsdMicros : row.charge_usd_micros ?? 0;
  if (count(charge)) {
    group.credit_usd_micros += charge;
    group.rch_usd_micros += Math.min(row.held_rch || 0, charge);
  }
  if (row.currency === 'tokens' && tokens) group.legacy_credit_tokens += Math.max(0, tokens.input + tokens.output - row.held_included);
}
export function usageSummary(snapshot, period) {
  const result = { period: { from: new Date(period.from).toISOString(), to: new Date(period.to).toISOString(), basis: 'recorded_at' },
    requests: { completed: 0, pending: 0, released: 0, measured: 0 },
    tokens: { input: 0, output: 0, cachedInput: 0 },
    spending: { subscriptions: [], creditUsdMicros: 0, rchUsdMicros: 0, unpricedCreditTokens: 0 },
    redemptions: { creditUsdMicros: 0, tokenCredits: 0, rchWei: '0' }, models: [] };
  for (const row of snapshot.requests) {
    if (row.status === 'settled') {
      result.requests.completed += row.count;
      result.requests.measured += row.measured_count;
      result.tokens.input += row.input_tokens;
      result.tokens.output += row.output_tokens;
      result.tokens.cachedInput += row.cached_tokens;
      result.spending.creditUsdMicros += row.credit_usd_micros;
      result.spending.rchUsdMicros += row.rch_usd_micros;
      result.spending.unpricedCreditTokens += row.legacy_credit_tokens;
      result.models.push({ model: row.model, requests: row.count, measured: row.measured_count,
        inputTokens: row.input_tokens, outputTokens: row.output_tokens, cachedInputTokens: row.cached_tokens });
    } else if (row.status === 'released') result.requests.released += row.count;
    else result.requests.pending += row.count;
  }
  result.models.sort((a, b) => b.requests - a.requests || a.model.localeCompare(b.model));
  result.spending.subscriptions = snapshot.subscriptions.map(row => ({ currency: row.currency.toUpperCase(),
    paidMicros: row.paid_micros, refundedMicros: row.refunded_micros, netMicros: row.paid_micros - row.refunded_micros }));
  for (const row of snapshot.redemptions) {
    result.redemptions.creditUsdMicros += row.usd_micros;
    result.redemptions.tokenCredits += row.token_credits;
    result.redemptions.rchWei = String(BigInt(result.redemptions.rchWei) + BigInt(row.amount_rch));
  }
  return result;
}

export function sqliteUsageSummary(db, accountId, period) {
  const groups = new Map();
  for (const table of ['reservations', 'request_reservations', 'plus_requests']) {
    const rows = db.prepare(`SELECT * FROM ${table} WHERE account_id=? AND created>=? AND created<?`).iterate(accountId, period.from, period.to);
    for (const row of rows) {
      const key = JSON.stringify([row.model, row.status]);
      if (!groups.has(key)) groups.set(key, emptyRequestGroup(row.model, row.status));
      addRequest(groups.get(key), row);
    }
  }
  const subscriptions = db.prepare(`SELECT currency, SUM(paid_micros) AS paid_micros, SUM(refunded_micros) AS refunded_micros FROM (
    SELECT p.currency,p.amount_usd_micros AS paid_micros,MIN(p.amount_usd_micros,COALESCE((SELECT SUM(r.amount_usd_micros) FROM payment_reversals r WHERE r.payment_id=p.id AND r.created<?),0)) AS refunded_micros
    FROM payments p WHERE p.account_id=? AND p.kind='subscription_period' AND p.status<>'rejected' AND p.created>=? AND p.created<?
    UNION ALL
    SELECT p.currency,p.amount_minor*10000,MIN(p.amount_minor,COALESCE((SELECT SUM(r.amount_minor) FROM plus_reversals r WHERE r.payment_id=p.id AND r.created<?),0))*10000
    FROM plus_payments p WHERE p.account_id=? AND p.status<>'rejected' AND p.created>=? AND p.created<?
  ) GROUP BY currency ORDER BY currency`).all(period.to,accountId,period.from,period.to,period.to,accountId,period.from,period.to);
  const redemptions = db.prepare("SELECT usd_micros,usage_tokens AS token_credits,amount AS amount_rch FROM redemptions WHERE account_id=? AND status='credited' AND created>=? AND created<?").all(accountId,period.from,period.to);
  return usageSummary({ requests: [...groups.values()], subscriptions, redemptions }, period);
}
