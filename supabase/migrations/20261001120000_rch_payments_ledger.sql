-- Provider-neutral payment ledger. Stripe, PayPal and manual operator entries all
-- land here as one normalized record; this migration decides what each is worth
-- and applies it in a single transaction. It adds a table and a function and
-- changes nothing that already exists: accounts, plan grants, credits,
-- redemptions and request reservations are untouched.
--
-- The rules mirror RCH/service/payments/core.mjs line for line, and one shared
-- test suite runs the same cases against both implementations.
create table reach_accounts.payments (
  id text primary key check (id ~ '^[a-f0-9]{64}$'),
  provider text not null check (provider in ('stripe','paypal','manual')),
  event_id text not null check (event_id ~ '^[A-Za-z0-9_.:-]{3,128}$'),
  object_id text not null check (object_id ~ '^[A-Za-z0-9_.:-]{3,128}$'),
  kind text not null check (kind in ('subscription_period','top_up')),
  -- Deliberately NOT a foreign key. Money that arrives for an account we cannot
  -- find is exactly the case that must still leave a durable record.
  account_id text not null check (account_id ~ '^[A-Za-z0-9_-]{8,128}$'),
  amount_usd_micros bigint not null check (amount_usd_micros > 0 and amount_usd_micros <= 1000000000000),
  currency text not null check (currency = 'usd'),
  period_end bigint,
  status text not null check (status in ('applied','superseded','expired','rejected')),
  reason text check (reason is null or reason ~ '^[a-z_]{1,64}$'),
  grant_id text check (grant_id is null or grant_id ~ '^pay_[a-f0-9]{48}$'),
  fingerprint text not null check (fingerprint ~ '^[a-f0-9]{64}$'),
  created bigint not null check (created >= 0),
  -- The idempotency key is the provider's payment OBJECT, not the event: a
  -- provider routinely sends several events for one invoice.
  unique (provider, object_id, kind),
  check ((kind = 'subscription_period' and period_end is not null) or (kind = 'top_up' and period_end is null)),
  check ((status = 'applied') = (reason is null))
);
create index payment_account on reach_accounts.payments(account_id, created);
create index payment_review on reach_accounts.payments(status) where status in ('rejected','expired');
alter table reach_accounts.payments enable row level security;
revoke all on reach_accounts.payments from public, anon, authenticated;
-- Append-only: the service can record and read payments but cannot edit or
-- delete one. A later refund or dispute is a new entry, never a rewrite.
grant select, insert on reach_accounts.payments to service_role;

create function public.reach_payment_store(p_operation text, p_payload jsonb) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare
  a reach_accounts.accounts%rowtype;
  x reach_accounts.payments%rowtype;
  v_now bigint := (p_payload->>'now')::bigint;
  v_provider text := p_payload->>'provider';
  v_object text := p_payload->>'objectId';
  v_kind text := p_payload->>'kind';
  v_account text := p_payload->>'accountId';
  v_amount bigint := (p_payload->>'amountUsdMicros')::bigint;
  v_period bigint := (p_payload->>'periodEnd')::bigint;
  v_grant text := p_payload->>'grantId';
  v_policy jsonb := p_payload->'subscription';
  v_policy_ok boolean;
  v_found boolean;
  v_status text := 'applied';
  v_reason text;
  v_do_grant boolean := false;
  v_debt_paid bigint;
  v_credit bigint;
  v_limit integer;
  result jsonb := 'null'::jsonb;
begin
  if jsonb_typeof(p_payload) is distinct from 'object' or v_now is null or v_now < 0 then
    perform reach_accounts.fail('invalid_operation');
  end if;

  if p_operation = 'apply_payment' then
    if v_provider is null or v_kind is null or v_object is null or v_account is null or v_amount is null
       or coalesce(p_payload->>'currency', 'usd') <> 'usd'
       or coalesce(p_payload->>'fingerprint', '') !~ '^[a-f0-9]{64}$'
       or coalesce(p_payload->>'paymentId', '') !~ '^[a-f0-9]{64}$' then
      perform reach_accounts.fail('invalid_payment');
    end if;

    -- One payment object is processed by one transaction at a time, whatever
    -- account the event claims. Without this, two events naming different
    -- accounts for the same invoice could both apply their effect.
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('reach-payment:' || v_provider || ':' || v_kind || ':' || v_object, 0));
    select * into x from reach_accounts.payments where provider = v_provider and object_id = v_object and kind = v_kind;
    if found then
      if x.fingerprint is distinct from p_payload->>'fingerprint' then perform reach_accounts.fail('payment_conflict'); end if;
      return jsonb_build_object('result', jsonb_build_object('paymentId', x.id, 'status', x.status, 'reason', x.reason,
        'kind', x.kind, 'grantId', x.grant_id, 'duplicate', true));
    end if;

    if v_kind = 'subscription_period' then
      v_policy_ok := coalesce(v_policy->'basic'->>'id' = 'basic-wallet'
        and v_policy->'basic'->'includedRequests' = '1500'::jsonb
        and v_policy->'basic'->'priceUsdMicros' = '15000000'::jsonb
        and v_policy->'overageUsdMicrosPerRequest' = '10000'::jsonb
        and v_policy->'proEnabled' = 'false'::jsonb, false);
      if not v_policy_ok then perform reach_accounts.fail('subscription_unconfigured'); end if;
      if v_period is null or coalesce(v_grant, '') !~ '^pay_[a-f0-9]{48}$'
         or jsonb_typeof(p_payload->'models') is distinct from 'array' or jsonb_array_length(p_payload->'models') = 0 then
        perform reach_accounts.fail('invalid_payment');
      end if;
      -- Same order as the legacy grant: grant lock first, then the account row.
      perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('reach-grant:' || v_grant, 0));
    end if;

    select * into a from reach_accounts.accounts where id = v_account for update;
    v_found := found;

    if v_kind = 'subscription_period' then
      if not v_found then v_status := 'rejected'; v_reason := 'account_missing';
      elsif v_amount <> 15000000 then v_status := 'rejected'; v_reason := 'amount_mismatch';
      elsif v_period <= v_now then v_status := 'expired'; v_reason := 'period_over';
      elsif v_period > v_now + 34560000000 then v_status := 'rejected'; v_reason := 'period_too_long';
      elsif coalesce(a.plan_id, '') <> '' and a.plan_id not in ('basic','basic-wallet') and a.plan_expires > v_now then
        v_status := 'rejected'; v_reason := 'other_plan_active';
      elsif a.plan_id in ('basic','basic-wallet') and a.plan_expires >= v_period then
        v_status := 'superseded'; v_reason := 'newer_period_active';
      else v_do_grant := true;
      end if;
    else
      if not v_found then v_status := 'rejected'; v_reason := 'account_missing';
      elsif v_amount < 1000000 or v_amount > 500000000 then v_status := 'rejected'; v_reason := 'amount_out_of_range';
      else
        v_debt_paid := least(a.usd_debt, v_amount);
        v_credit := v_amount - v_debt_paid;
        if a.usd_prepaid + v_credit > 1000000000000 then v_status := 'rejected'; v_reason := 'credit_limit';
        else
          update reach_accounts.accounts set usd_prepaid = usd_prepaid + v_credit, usd_debt = usd_debt - v_debt_paid where id = a.id;
        end if;
      end if;
    end if;

    if v_do_grant then
      -- Reuse the existing, tested grant so a payment can never drift from what
      -- a hand-run grant does. Same transaction, so the ledger row and the plan
      -- commit together or not at all.
      perform reach_accounts.legacy_account_store('grant_plan', jsonb_build_object(
        'wallet', a.wallet, 'grantId', v_grant, 'planId', 'basic-wallet', 'name', 'Basic',
        'models', p_payload->'models', 'tokens', 0, 'expiresAt', v_period,
        'payload', jsonb_build_object('wallet', a.wallet, 'planId', 'basic-wallet', 'name', 'Basic',
          'models', p_payload->'models', 'tokens', 0, 'expiresAt', v_period)::text,
        'accountId', a.id, 'now', v_now));
    end if;

    insert into reach_accounts.payments(id, provider, event_id, object_id, kind, account_id, amount_usd_micros, currency,
      period_end, status, reason, grant_id, fingerprint, created)
    values (p_payload->>'paymentId', v_provider, p_payload->>'eventId', v_object, v_kind, v_account, v_amount, 'usd',
      v_period, v_status, v_reason, case when v_do_grant then v_grant end, p_payload->>'fingerprint', v_now)
    returning * into x;
    return jsonb_build_object('result', jsonb_build_object('paymentId', x.id, 'status', x.status, 'reason', x.reason,
      'kind', x.kind, 'grantId', x.grant_id, 'duplicate', false));

  elsif p_operation = 'list_payments' then
    v_limit := coalesce((p_payload->>'limit')::integer, 50);
    if v_limit not between 1 and 200 then v_limit := 50; end if;
    select coalesce(jsonb_agg(to_jsonb(t) - 'fingerprint' order by t.created desc, t.id), '[]'::jsonb) into result
      from (select * from reach_accounts.payments where account_id = v_account order by created desc, id limit v_limit) t;
    return jsonb_build_object('result', result);

  elsif p_operation = 'flagged_payments' then
    select coalesce(jsonb_agg(to_jsonb(t) - 'fingerprint' order by t.created, t.id), '[]'::jsonb) into result
      from reach_accounts.payments t where t.status in ('rejected','expired');
    return jsonb_build_object('result', result);
  end if;

  perform reach_accounts.fail('invalid_operation');
  return jsonb_build_object('result', result);
end;
$$;
revoke execute on function public.reach_payment_store(text, jsonb) from public, anon, authenticated;
grant execute on function public.reach_payment_store(text, jsonb) to service_role;
notify pgrst, 'reload schema';
