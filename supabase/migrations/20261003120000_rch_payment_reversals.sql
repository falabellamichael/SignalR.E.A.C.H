-- Refunds and disputes. Each is its own append-only row pointing at the payment
-- it reverses; the payment row itself is never edited. Additive: one table and
-- one function, nothing existing changes.
--
-- The rules mirror decideReversal in RCH/service/payments/core.mjs line for
-- line, and the shared payments suite runs the same cases against both.
create table reach_accounts.payment_reversals (
  id text primary key check (id ~ '^[a-f0-9]{64}$'),
  provider text not null check (provider in ('stripe','paypal','manual')),
  event_id text not null check (event_id ~ '^[A-Za-z0-9_.:-]{3,128}$'),
  object_id text not null check (object_id ~ '^[A-Za-z0-9_.:-]{3,128}$'),
  kind text not null check (kind in ('refund','dispute')),
  payment_id text not null references reach_accounts.payments(id),
  account_id text not null check (account_id ~ '^[A-Za-z0-9_-]{8,128}$'),
  amount_usd_micros bigint not null check (amount_usd_micros > 0 and amount_usd_micros <= 1000000000000),
  applied_usd_micros bigint not null check (applied_usd_micros >= 0 and applied_usd_micros <= amount_usd_micros),
  currency text not null check (currency = 'usd'),
  status text not null check (status in ('applied','superseded','rejected')),
  reason text check (reason is null or reason ~ '^[a-z_]{1,64}$'),
  fingerprint text not null check (fingerprint ~ '^[a-f0-9]{64}$'),
  created bigint not null check (created >= 0),
  unique (provider, object_id, kind),
  check ((status = 'applied') = (reason is null)),
  check (status = 'applied' or applied_usd_micros = 0)
);
create index reversal_payment on reach_accounts.payment_reversals(payment_id);
create index reversal_account on reach_accounts.payment_reversals(account_id, created);
create index reversal_review on reach_accounts.payment_reversals(status) where status = 'rejected';
alter table reach_accounts.payment_reversals enable row level security;
revoke all on reach_accounts.payment_reversals from public, anon, authenticated;
grant select, insert on reach_accounts.payment_reversals to service_role;

create function public.reach_payment_reversal_store(p_operation text, p_payload jsonb) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare
  a reach_accounts.accounts%rowtype;
  o reach_accounts.payments%rowtype;
  x reach_accounts.payment_reversals%rowtype;
  v_now bigint := (p_payload->>'now')::bigint;
  v_provider text := p_payload->>'provider';
  v_object text := p_payload->>'objectId';
  v_kind text := p_payload->>'kind';
  v_original text := p_payload->>'originalObjectId';
  v_original_kind text := p_payload->>'originalKind';
  v_amount bigint := (p_payload->>'amountUsdMicros')::bigint;
  v_found boolean;
  v_requested bigint;
  v_prior_applied bigint;
  v_remaining bigint;
  v_applied bigint := 0;
  v_from_credit bigint;
  v_debt bigint;
  v_status text := 'applied';
  v_reason text;
  v_limit integer;
  result jsonb := 'null'::jsonb;
begin
  if jsonb_typeof(p_payload) is distinct from 'object' or v_now is null or v_now < 0 then
    perform reach_accounts.fail('invalid_operation');
  end if;

  if p_operation = 'apply_reversal' then
    if v_provider is null or v_kind is null or v_object is null or v_original is null or v_original_kind is null
       or v_amount is null or v_amount <= 0
       or coalesce(p_payload->>'currency', 'usd') <> 'usd'
       or coalesce(p_payload->>'fingerprint', '') !~ '^[a-f0-9]{64}$'
       or coalesce(p_payload->>'reversalId', '') !~ '^[a-f0-9]{64}$' then
      perform reach_accounts.fail('invalid_payment');
    end if;

    -- The same lock key as apply_payment for the original, so a reversal and
    -- the payment it reverses never interleave.
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('reach-payment:' || v_provider || ':' || v_original_kind || ':' || v_original, 0));
    select * into x from reach_accounts.payment_reversals where provider = v_provider and object_id = v_object and kind = v_kind;
    if found then
      if x.fingerprint is distinct from p_payload->>'fingerprint' then perform reach_accounts.fail('payment_conflict'); end if;
      return jsonb_build_object('result', jsonb_build_object('reversalId', x.id, 'status', x.status, 'reason', x.reason,
        'kind', x.kind, 'appliedUsdMicros', x.applied_usd_micros, 'duplicate', true));
    end if;

    select * into o from reach_accounts.payments where provider = v_provider and object_id = v_original and kind = v_original_kind;
    -- Not a payment REACH recorded: nothing to reverse and nothing to record.
    if not found then return jsonb_build_object('result', 'null'::jsonb); end if;

    select * into a from reach_accounts.accounts where id = o.account_id for update;
    v_found := found;
    select coalesce(sum(amount_usd_micros), 0), coalesce(sum(applied_usd_micros), 0) into v_requested, v_prior_applied
      from reach_accounts.payment_reversals where payment_id = o.id;
    v_remaining := o.amount_usd_micros - v_prior_applied;

    if o.status <> 'applied' then v_status := 'superseded'; v_reason := 'original_not_applied';
    elsif not v_found then v_status := 'rejected'; v_reason := 'account_missing';
    elsif o.kind = 'top_up' then
      if v_remaining <= 0 then v_status := 'superseded'; v_reason := 'already_reversed';
      else
        v_applied := least(v_amount, v_remaining);
        v_from_credit := least(a.usd_prepaid, v_applied);
        v_debt := v_applied - v_from_credit;
        if a.usd_debt + v_debt > 1000000000000 then v_status := 'rejected'; v_reason := 'credit_limit'; v_applied := 0;
        else
          update reach_accounts.accounts set usd_prepaid = usd_prepaid - v_from_credit, usd_debt = usd_debt + v_debt where id = a.id;
        end if;
      end if;
    elsif v_requested + v_amount < o.amount_usd_micros then v_status := 'rejected'; v_reason := 'partial_reversal';
    elsif a.plan_version is distinct from o.grant_id then v_status := 'rejected'; v_reason := 'period_not_current';
    elsif a.plan_expires <= v_now then v_status := 'superseded'; v_reason := 'plan_already_ended';
    else
      v_applied := greatest(0, least(v_amount, v_remaining));
      update reach_accounts.accounts set plan_expires = v_now where id = a.id;
    end if;

    insert into reach_accounts.payment_reversals(id, provider, event_id, object_id, kind, payment_id, account_id,
      amount_usd_micros, applied_usd_micros, currency, status, reason, fingerprint, created)
    values (p_payload->>'reversalId', v_provider, p_payload->>'eventId', v_object, v_kind, o.id, o.account_id,
      v_amount, v_applied, 'usd', v_status, v_reason, p_payload->>'fingerprint', v_now)
    returning * into x;
    return jsonb_build_object('result', jsonb_build_object('reversalId', x.id, 'status', x.status, 'reason', x.reason,
      'kind', x.kind, 'appliedUsdMicros', x.applied_usd_micros, 'duplicate', false));

  elsif p_operation = 'list_reversals' then
    v_limit := coalesce((p_payload->>'limit')::integer, 50);
    if v_limit not between 1 and 200 then v_limit := 50; end if;
    select coalesce(jsonb_agg(to_jsonb(t) - 'fingerprint' order by t.created desc, t.id), '[]'::jsonb) into result
      from (select * from reach_accounts.payment_reversals where account_id = p_payload->>'accountId' order by created desc, id limit v_limit) t;
    return jsonb_build_object('result', result);

  elsif p_operation = 'flagged_reversals' then
    select coalesce(jsonb_agg(to_jsonb(t) - 'fingerprint' order by t.created, t.id), '[]'::jsonb) into result
      from reach_accounts.payment_reversals t where t.status = 'rejected';
    return jsonb_build_object('result', result);
  end if;

  perform reach_accounts.fail('invalid_operation');
  return jsonb_build_object('result', result);
end;
$$;
revoke execute on function public.reach_payment_reversal_store(text, jsonb) from public, anon, authenticated;
grant execute on function public.reach_payment_reversal_store(text, jsonb) to service_role;
notify pgrst, 'reload schema';
