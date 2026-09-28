-- Monetary credit is separate from legacy plan-token allowance. No conversion
-- of existing balances is performed. Only the trusted service_role can call
-- this invoker RPC or access the private, RLS-protected tables.
alter table reach_accounts.accounts
  add column usd_prepaid bigint not null default 0 check (usd_prepaid between 0 and 1000000000000),
  add column usd_debt bigint not null default 0 check (usd_debt between 0 and 1000000000000);
alter table reach_accounts.reservations
  add column currency text not null default 'tokens' check (currency in ('tokens','USD')),
  add column pricing_json text;
alter table reach_accounts.reservations drop constraint reservations_check;
alter table reach_accounts.reservations add constraint reservation_currency_holds check (
  currency = 'tokens' and held_included + held_prepaid = amount and pricing_json is null
  or currency = 'USD' and held_included = 0 and held_prepaid = 0 and pricing_json is not null
    and jsonb_typeof(pricing_json::jsonb) = 'object');
alter table reach_accounts.redemptions
  add column usd_micros bigint not null default 0 check (usd_micros between 0 and 1000000000000),
  add column quote_json text;
alter table reach_accounts.redemptions drop constraint redemptions_usage_tokens_check;
alter table reach_accounts.redemptions add constraint redemption_currency check (
  usd_micros = 0 and usage_tokens between 1 and 1000000000000 and quote_json is null
  or usd_micros > 0 and usage_tokens = 0 and quote_json is not null and jsonb_typeof(quote_json::jsonb) = 'object');

create or replace function reach_accounts.snapshot(p_account_id text) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare result jsonb;
begin
  select jsonb_build_object('account', to_jsonb(a), 'reserved',
    (select coalesce(sum(r.amount),0) from reach_accounts.reservations r where r.account_id=a.id and r.currency='tokens' and r.status in ('reserved','uncertain')),
    'reservedUsdMicros',
    (select coalesce(sum(r.amount),0) from reach_accounts.reservations r where r.account_id=a.id and r.currency='USD' and r.status in ('reserved','uncertain')))
  into result from reach_accounts.accounts a where a.id=p_account_id;
  if result is null then perform reach_accounts.fail('account_missing'); end if;
  return result;
end;
$$;

-- Preserve the qualified token ledger as a private implementation. The public
-- dispatcher below owns every USD mutation and delegates unchanged token flows.
alter function public.reach_account_store(text,jsonb) set schema reach_accounts;
alter function reach_accounts.reach_account_store(text,jsonb) rename to token_account_store;

create function reach_accounts.usd_usage_cost(p_pricing jsonb,p_usage jsonb) returns bigint
language plpgsql security invoker set search_path = '' as $$
declare i numeric; o numeric; p numeric; c numeric; cached numeric; cached_rate numeric; result numeric;
begin
  begin
    i:=(p_pricing->>'inputUsdMicrosPerMillion')::numeric;
    o:=(p_pricing->>'outputUsdMicrosPerMillion')::numeric;
    p:=(p_usage->>'promptTokens')::numeric;
    c:=(p_usage->>'completionTokens')::numeric;
    cached:=coalesce((p_usage->'details'->'prompt'->>'cached_tokens')::numeric,0);
    cached_rate:=coalesce((p_pricing->>'cachedInputUsdMicrosPerMillion')::numeric,i);
  exception when data_exception then perform reach_accounts.fail('invalid_usage'); end;
  if i is null or o is null or p is null or c is null
    or i not between 0 and 1000000000000 or o not between 0 and 1000000000000
    or p not between 0 and 1000000000000 or c not between 0 and 1000000000000
    or cached not between 0 and p or cached_rate not between 0 and i
    or trunc(cached)<>cached or trunc(cached_rate)<>cached_rate
    or trunc(i)<>i or trunc(o)<>o or trunc(p)<>p or trunc(c)<>c or i+o=0 then perform reach_accounts.fail('invalid_usage'); end if;
  result:=ceil(((p-cached)*i+cached*cached_rate+c*o)/1000000);
  if result>1000000000000 then perform reach_accounts.fail('invalid_usage'); end if;
  return result::bigint;
end;
$$;

create function public.reach_account_store(p_operation text,p_payload jsonb) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare
  a reach_accounts.accounts%rowtype;
  r reach_accounts.reservations%rowtype;
  d reach_accounts.redemptions%rowtype;
  v_now bigint:=(p_payload->>'now')::bigint;
  v_account text:=p_payload->>'accountId';
  v_quote jsonb:=p_payload->'quote';
  v_amount bigint;
  v_expiry bigint;
  v_actual bigint;
  v_available bigint;
  v_debt bigint;
  v_paid bigint;
  v_promised numeric;
  v_budget bigint;
  v_id text;
  result jsonb:='null'::jsonb;
begin
  if jsonb_typeof(p_payload) is distinct from 'object' or v_now is null or v_now<0 then perform reach_accounts.fail('invalid_operation'); end if;

  if p_operation='create_market_redemption' then
    -- The account lock also serializes the entire issued-quote budget. Count
    -- expired quotes too: a signed promise may have an unobserved chain event.
    select * into a from reach_accounts.accounts where id=v_account for update;
    if not found then perform reach_accounts.fail('account_missing'); end if;
    begin
      v_amount:=(v_quote->>'creditUsdMicros')::bigint;
      v_expiry:=(v_quote->>'expiresAtMs')::bigint;
      v_budget:=(v_quote->>'creditBudgetUsdMicros')::bigint;
      if jsonb_typeof(v_quote) is distinct from 'object'
        or v_amount is null or v_amount not between 1 and 1000000000000
        or v_budget is null or v_budget not between 1 and 1000000000000
        or v_expiry is null or v_expiry<=v_now or v_expiry>v_now+900000
        or coalesce(p_payload->>'amount','') !~ '^[1-9][0-9]{0,77}$'
        or v_quote->>'amount' is distinct from p_payload->>'amount'
        or lower(v_quote->>'wallet') is distinct from lower(a.wallet)
        or (v_quote->>'deadline')::bigint*1000 is distinct from v_expiry
        or (v_quote->>'issuedAt')::bigint is null
        or (v_quote->>'issuedAt')::bigint not between v_now/1000-300 and v_now/1000+5
        or (v_quote->>'deadline')::bigint <= (v_quote->>'issuedAt')::bigint
        or (v_quote->>'chainId')::bigint is null or (v_quote->>'chainId')::bigint<1
        or coalesce(v_quote->>'source','')='' or length(v_quote->>'source')>200
        or coalesce(v_quote->>'tokenAddress','') !~ '^0x[a-fA-F0-9]{40}$'
        or coalesce(v_quote->>'treasuryAddress','') !~ '^0x[a-fA-F0-9]{40}$'
        or coalesce(v_quote->>'redemptionContract','') !~ '^0x[a-fA-F0-9]{40}$'
        or octet_length(v_quote::text)>32768 then perform reach_accounts.fail('invalid_redemption'); end if;
    exception when data_exception then perform reach_accounts.fail('invalid_redemption'); end;
    select coalesce(sum(usd_micros),0) into v_promised from reach_accounts.redemptions where account_id=a.id;
    if v_promised+v_amount>v_budget then perform reach_accounts.fail('redemption_budget_exhausted'); end if;
    insert into reach_accounts.redemptions(id,account_id,wallet,amount,usage_tokens,ticket_hash,expires,created,usd_micros,quote_json)
      values(p_payload->>'redemptionId',a.id,a.wallet,p_payload->>'amount',0,p_payload->>'ticketHash',v_expiry,v_now,v_amount,v_quote::text);
    result:=jsonb_build_object('redemptionId',p_payload->>'redemptionId','expiresAt',reach_accounts.iso_time(v_expiry));

  elsif p_operation='reserve_usd' then
    v_amount:=reach_accounts.usd_usage_cost(p_payload->'pricing',p_payload->'limits');
    if v_amount<1 or v_amount is distinct from (p_payload->>'amount')::bigint
      or coalesce(length(p_payload->>'requestId'),0) not between 1 and 128 then perform reach_accounts.fail('invalid_reservation'); end if;
    if (p_payload->>'modelQualified')::boolean is distinct from true then perform reach_accounts.fail('model_not_entitled'); end if;
    select * into a from reach_accounts.accounts where id=v_account for update;
    if not found then perform reach_accounts.fail('account_missing'); end if;
    select * into r from reach_accounts.reservations where account_id=a.id and request_id=p_payload->>'requestId' for update;
    if found then
      if r.fingerprint is distinct from p_payload->>'fingerprint' or r.model is distinct from p_payload->>'model' or r.currency<>'USD' then perform reach_accounts.fail('idempotency_conflict'); end if;
      if r.status<>'released' then return jsonb_build_object('result',jsonb_build_object('id',r.id,'status',r.status,'replay',r.replay::jsonb,'fresh',false)); end if;
    end if;
    if a.usd_debt>0 then perform reach_accounts.fail('usage_debt'); end if;
    if a.usd_prepaid<v_amount then perform reach_accounts.fail('allowance_exhausted'); end if;
    v_id:=coalesce(r.id,p_payload->>'reservationId');
    update reach_accounts.accounts set usd_prepaid=usd_prepaid-v_amount where id=a.id;
    insert into reach_accounts.reservations(id,account_id,request_id,model,fingerprint,amount,held_included,held_prepaid,plan_version,status,created,currency,pricing_json)
      values(v_id,a.id,p_payload->>'requestId',p_payload->>'model',p_payload->>'fingerprint',v_amount,0,0,null,'reserved',v_now,'USD',(p_payload->'pricing')::text)
      on conflict(id) do update set amount=excluded.amount,status='reserved',created=excluded.created,pricing_json=excluded.pricing_json,reason=null,usage=null,replay=null;
    result:=jsonb_build_object('id',v_id,'status','reserved','replay',null,'fresh',true);

  elsif p_operation in ('settle','release') then
    select * into r from reach_accounts.reservations where id=p_payload->>'reservationId';
    if not found or r.currency<>'USD' then return reach_accounts.token_account_store(p_operation,p_payload); end if;
    select * into a from reach_accounts.accounts where id=r.account_id for update;
    select * into r from reach_accounts.reservations where id=r.id for update;
    if p_operation='release' then
      if r.status='released' then return jsonb_build_object('result',null); end if;
      if r.status<>'reserved' then perform reach_accounts.fail('reservation_closed'); end if;
      if a.usd_prepaid+r.amount>1000000000000 then perform reach_accounts.fail('credit_limit'); end if;
      update reach_accounts.accounts set usd_prepaid=usd_prepaid+r.amount where id=a.id;
      update reach_accounts.reservations set status='released',reason=p_payload->>'reason' where id=r.id;
    else
      if (p_payload->'usage'->>'totalTokens')::numeric is null
        or (p_payload->'usage'->>'totalTokens')::numeric is distinct from (p_payload->'usage'->>'promptTokens')::numeric+(p_payload->'usage'->>'completionTokens')::numeric
        or (p_payload->'usage'->>'totalTokens')::numeric not between 0 and 1000000000000 then perform reach_accounts.fail('invalid_usage'); end if;
      v_actual:=reach_accounts.usd_usage_cost(r.pricing_json::jsonb,p_payload->'usage');
      if r.status='settled' then return jsonb_build_object('result',null); end if;
      if r.status not in ('reserved','uncertain') then perform reach_accounts.fail('reservation_closed'); end if;
      v_available:=a.usd_prepaid+r.amount-v_actual;
      v_debt:=a.usd_debt+greatest(0,-v_available);
      if greatest(0,v_available)>1000000000000 or v_debt>1000000000000 then perform reach_accounts.fail('credit_limit'); end if;
      update reach_accounts.accounts set usd_prepaid=greatest(0,v_available),usd_debt=v_debt where id=a.id;
      update reach_accounts.reservations set status='settled',usage=((p_payload->'usage')||jsonb_build_object('chargedUsdMicros',v_actual))::text,
        replay=case when octet_length(p_payload->>'replay')<=1048576 then p_payload->>'replay' else null end,reason=null where id=r.id;
    end if;

  elsif p_operation='credit_redemption' then
    select * into d from reach_accounts.redemptions where id=p_payload->>'redemptionId';
    if not found or d.usd_micros=0 then return reach_accounts.token_account_store(p_operation,p_payload); end if;
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('reach-credit:'||coalesce(p_payload->>'eventKey',''),0));
    select * into a from reach_accounts.accounts where id=d.account_id for update;
    select * into d from reach_accounts.redemptions where id=d.id for update;
    if d.status='credited' then
      if d.event_key is distinct from p_payload->>'eventKey' then perform reach_accounts.fail('event_conflict'); end if;
      return jsonb_build_object('result',null);
    end if;
    if d.status<>'pending' or d.tx_hash is null or coalesce(p_payload->>'eventKey','')='' then perform reach_accounts.fail('redemption_not_pending'); end if;
    if exists(select 1 from reach_accounts.redemptions where event_key=p_payload->>'eventKey') then perform reach_accounts.fail('event_conflict'); end if;
    v_paid:=least(a.usd_debt,d.usd_micros);
    if a.usd_prepaid+d.usd_micros-v_paid>1000000000000 then perform reach_accounts.fail('credit_limit'); end if;
    update reach_accounts.accounts set usd_prepaid=usd_prepaid+d.usd_micros-v_paid,usd_debt=usd_debt-v_paid where id=a.id;
    update reach_accounts.redemptions set status='credited',event_key=p_payload->>'eventKey' where id=d.id;

  elsif p_operation='unsettled_reservations' then
    select coalesce(jsonb_agg(jsonb_build_object('id',x.id,'account_id',x.account_id,'request_id',x.request_id,'model',x.model,
      'amount',x.amount,'status',x.status,'created',x.created,'reason',x.reason,'currency',x.currency) order by x.created,x.id),'[]'::jsonb) into result
      from reach_accounts.reservations x where status in ('reserved','uncertain') and (v_account is null or account_id=v_account);
  else
    if p_operation='reserve' then
      -- A request ID must never cross from monetary billing to token billing.
      select * into a from reach_accounts.accounts where id=v_account for update;
      if exists(select 1 from reach_accounts.reservations where account_id=v_account and request_id=p_payload->>'requestId' and currency<>'tokens') then perform reach_accounts.fail('idempotency_conflict'); end if;
    elsif p_operation='import_snapshot' and jsonb_typeof(p_payload->'snapshot')='object' then
      -- Old seven-table exports omit additive currency columns. Preserve that
      -- supported import path by supplying defaults without overriding values.
      p_payload:=jsonb_set(p_payload,'{snapshot,accounts}',coalesce((select jsonb_agg('{"usd_prepaid":0,"usd_debt":0}'::jsonb||x) from jsonb_array_elements(p_payload->'snapshot'->'accounts') x),'[]'::jsonb));
      p_payload:=jsonb_set(p_payload,'{snapshot,reservations}',coalesce((select jsonb_agg('{"currency":"tokens","pricing_json":null}'::jsonb||x) from jsonb_array_elements(p_payload->'snapshot'->'reservations') x),'[]'::jsonb));
      p_payload:=jsonb_set(p_payload,'{snapshot,redemptions}',coalesce((select jsonb_agg('{"usd_micros":0,"quote_json":null}'::jsonb||x) from jsonb_array_elements(p_payload->'snapshot'->'redemptions') x),'[]'::jsonb));
    end if;
    return reach_accounts.token_account_store(p_operation,p_payload);
  end if;
  return jsonb_build_object('result',result);
end;
$$;
revoke execute on all functions in schema reach_accounts from public,anon,authenticated;
grant execute on all functions in schema reach_accounts to service_role;
revoke execute on function public.reach_account_store(text,jsonb) from public,anon,authenticated;
grant execute on function public.reach_account_store(text,jsonb) to service_role;
notify pgrst,'reload schema';
