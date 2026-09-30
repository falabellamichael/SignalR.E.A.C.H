-- Add request accounting without converting legacy tokens, USD balances,
-- subscriptions, redemption records, or their existing reservations.
create table reach_accounts.request_periods (
  account_id text not null references reach_accounts.accounts(id),
  period_key text not null, plan_version text not null, period_ends bigint not null,
  included_limit integer not null check (included_limit = 1500),
  completed integer not null default 0 check (completed between 0 and included_limit),
  primary key (account_id, period_key)
);
create table reach_accounts.request_reservations (
  id text primary key check (id ~ '^[a-f0-9]{64}$'),
  account_id text not null references reach_accounts.accounts(id),
  request_id text not null check (request_id ~ '^[a-zA-Z0-9._:-]{1,128}$'),
  model text not null, fingerprint text not null check (length(fingerprint) between 1 and 128),
  period_key text, included boolean not null,
  charge_usd_micros bigint not null check (charge_usd_micros in (0,10000)),
  status text not null check (status in ('reserved','uncertain','released','settled')),
  created bigint not null, replay text, reason text,
  unique (account_id, request_id),
  foreign key (account_id,period_key) references reach_accounts.request_periods(account_id,period_key),
  check (included and charge_usd_micros=0 and period_key is not null
    or not included and charge_usd_micros=10000 and period_key is null)
);
create index request_reservation_account_period on reach_accounts.request_reservations(account_id,period_key,status);
alter table reach_accounts.request_periods enable row level security;
alter table reach_accounts.request_reservations enable row level security;
revoke all on reach_accounts.request_periods,reach_accounts.request_reservations from public,anon,authenticated;
grant select,insert,update,delete on reach_accounts.request_periods,reach_accounts.request_reservations to service_role;

create function public.reach_request_store(p_operation text,p_payload jsonb) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare
  a reach_accounts.accounts%rowtype;
  r reach_accounts.request_reservations%rowtype;
  v_now bigint := (p_payload->>'now')::bigint;
  v_account text := p_payload->>'accountId';
  v_policy jsonb := p_payload->'subscription';
  v_policy_ok boolean;
  v_period text;
  v_completed integer := 0;
  v_reserved integer := 0;
  v_held_usd bigint := 0;
  v_included boolean := false;
  v_charge bigint := 10000;
  v_id text;
  v_replay jsonb;
  result jsonb := 'null'::jsonb;
begin
  if jsonb_typeof(p_payload) is distinct from 'object' or v_now is null or v_now<0 then perform reach_accounts.fail('invalid_operation'); end if;
  v_policy_ok := coalesce(v_policy->'basic'->>'id'='basic-wallet'
    and v_policy->'basic'->'includedRequests'='1500'::jsonb
    and v_policy->'basic'->'priceUsdMicros'='15000000'::jsonb
    and v_policy->'overageUsdMicrosPerRequest'='10000'::jsonb
    and v_policy->'proEnabled'='false'::jsonb,false);

  if p_operation in ('request_allowance','reserve_request','unsettled_requests') then
    if p_operation='unsettled_requests' then
      select coalesce(jsonb_agg(jsonb_build_object('id',x.id,'account_id',x.account_id,'request_id',x.request_id,
        'model',x.model,'amount',x.charge_usd_micros,'status',x.status,'created',x.created,'reason',x.reason,
        'currency','requests','included',x.included) order by x.created,x.id),'[]'::jsonb) into result
        from reach_accounts.request_reservations x where status in ('reserved','uncertain') and (v_account is null or account_id=v_account);
      return jsonb_build_object('result',result);
    end if;
    -- All mutations use the same account-first lock order as the legacy ledger.
    select * into a from reach_accounts.accounts where id=v_account for update;
    if not found then perform reach_accounts.fail('account_missing'); end if;
    if v_policy_ok and a.plan_id in ('basic','basic-wallet') and a.plan_expires>v_now and coalesce(length(a.plan_version),0)>0 then
      v_period:=a.plan_version||':'||a.plan_expires::text;
      select coalesce(max(completed),0) into v_completed from reach_accounts.request_periods where account_id=a.id and period_key=v_period;
      select count(*) into v_reserved from reach_accounts.request_reservations where account_id=a.id and period_key=v_period and included and status in ('reserved','uncertain');
    end if;
    if p_operation='request_allowance' then
      select coalesce(sum(charge_usd_micros),0) into v_held_usd from reach_accounts.request_reservations where account_id=a.id and status in ('reserved','uncertain');
      result:=jsonb_build_object('allowance',jsonb_build_object('includedLimit',case when v_period is null then 0 else 1500 end,
        'completed',v_completed,'reserved',v_reserved,'remaining',case when v_period is null then 0 else greatest(0,1500-v_completed-v_reserved) end,
        'periodEndsAt',case when v_period is null then null else reach_accounts.iso_time(a.plan_expires) end,
        'overageUsdMicrosPerRequest',case when v_policy_ok then 10000 else 0 end,'basicActive',v_period is not null),
        'reservedUsdMicros',v_held_usd);
      return jsonb_build_object('result',result);
    end if;
    if not v_policy_ok or (p_payload->>'modelQualified')::boolean is distinct from true then perform reach_accounts.fail('model_not_entitled'); end if;
    if coalesce(p_payload->>'requestId','') !~ '^[a-zA-Z0-9._:-]{1,128}$'
      or coalesce(length(p_payload->>'fingerprint'),0) not between 1 and 128
      or coalesce(length(p_payload->>'model'),0) not between 1 and 128 then perform reach_accounts.fail('invalid_reservation'); end if;
    if exists(select 1 from reach_accounts.reservations where account_id=a.id and request_id=p_payload->>'requestId') then perform reach_accounts.fail('idempotency_conflict'); end if;
    select * into r from reach_accounts.request_reservations where account_id=a.id and request_id=p_payload->>'requestId' for update;
    if found then
      if r.model is distinct from p_payload->>'model' or r.fingerprint is distinct from p_payload->>'fingerprint' then perform reach_accounts.fail('idempotency_conflict'); end if;
      if r.status<>'released' then return jsonb_build_object('result',jsonb_build_object('id',r.id,'status',r.status,'replay',r.replay::jsonb,'fresh',false)); end if;
    end if;
    v_included:=v_period is not null and v_completed+v_reserved<1500;
    v_charge:=case when v_included then 0 else 10000 end;
    if a.usd_debt>0 then perform reach_accounts.fail('usage_debt'); end if;
    if a.usd_prepaid<v_charge then perform reach_accounts.fail('allowance_exhausted'); end if;
    if v_included then
      insert into reach_accounts.request_periods(account_id,period_key,plan_version,period_ends,included_limit)
        values(a.id,v_period,a.plan_version,a.plan_expires,1500) on conflict(account_id,period_key) do nothing;
    else
      update reach_accounts.accounts set usd_prepaid=usd_prepaid-v_charge where id=a.id;
    end if;
    v_id:=coalesce(r.id,p_payload->>'reservationId');
    insert into reach_accounts.request_reservations(id,account_id,request_id,model,fingerprint,period_key,included,charge_usd_micros,status,created)
      values(v_id,a.id,p_payload->>'requestId',p_payload->>'model',p_payload->>'fingerprint',case when v_included then v_period else null end,v_included,v_charge,'reserved',v_now)
      on conflict(id) do update set period_key=excluded.period_key,included=excluded.included,charge_usd_micros=excluded.charge_usd_micros,status='reserved',created=excluded.created,replay=null,reason=null;
    result:=jsonb_build_object('id',v_id,'status','reserved','replay',null,'fresh',true);
  elsif p_operation in ('settle_request','release_request','mark_request_uncertain') then
    select * into r from reach_accounts.request_reservations where id=p_payload->>'reservationId';
    if not found then perform reach_accounts.fail('reservation_missing'); end if;
    select * into a from reach_accounts.accounts where id=r.account_id for update;
    select * into r from reach_accounts.request_reservations where id=r.id for update;
    if p_operation='mark_request_uncertain' then
      update reach_accounts.request_reservations set status='uncertain',reason=left(p_payload->>'reason',200) where id=r.id and status='reserved';
    elsif p_operation='release_request' then
      if r.status='released' then return jsonb_build_object('result',null); end if;
      if r.status<>'reserved' then perform reach_accounts.fail('reservation_closed'); end if;
      if a.usd_prepaid+r.charge_usd_micros>1000000000000 then perform reach_accounts.fail('credit_limit'); end if;
      update reach_accounts.accounts set usd_prepaid=usd_prepaid+r.charge_usd_micros where id=a.id;
      update reach_accounts.request_reservations set status='released',reason='not_completed' where id=r.id;
    else
      begin v_replay:=(p_payload->>'replay')::jsonb; exception when data_exception then perform reach_accounts.fail('invalid_replay'); end;
      if jsonb_typeof(v_replay) is distinct from 'object' or coalesce(v_replay->>'contentType','') not in ('application/json; charset=utf-8','text/event-stream')
        or jsonb_typeof(v_replay->'body') is distinct from 'string' or octet_length(p_payload->>'replay')>1048576 then perform reach_accounts.fail('invalid_replay'); end if;
      if r.status='settled' then return jsonb_build_object('result',null); end if;
      if r.status not in ('reserved','uncertain') then perform reach_accounts.fail('reservation_closed'); end if;
      if r.included then
        update reach_accounts.request_periods set completed=completed+1 where account_id=a.id and period_key=r.period_key and completed<included_limit;
        if not found then perform reach_accounts.fail('credit_limit'); end if;
      end if;
      update reach_accounts.request_reservations set status='settled',replay=p_payload->>'replay',reason=null where id=r.id;
    end if;
  else perform reach_accounts.fail('invalid_operation');
  end if;
  return jsonb_build_object('result',result);
end;
$$;
revoke execute on function public.reach_request_store(text,jsonb) from public,anon,authenticated;
grant execute on function public.reach_request_store(text,jsonb) to service_role;

-- Prevent an idempotency key from crossing either direction between billing
-- modes. Delegate every other legacy operation and its existing math unchanged.
alter function public.reach_account_store(text,jsonb) set schema reach_accounts;
alter function reach_accounts.reach_account_store(text,jsonb) rename to legacy_account_store;
create function public.reach_account_store(p_operation text,p_payload jsonb) returns jsonb
language plpgsql security invoker set search_path = '' as $$
begin
  if p_operation in ('reserve','reserve_usd') then
    perform 1 from reach_accounts.accounts where id=p_payload->>'accountId' for update;
    if exists(select 1 from reach_accounts.request_reservations where account_id=p_payload->>'accountId' and request_id=p_payload->>'requestId') then perform reach_accounts.fail('idempotency_conflict'); end if;
  end if;
  return reach_accounts.legacy_account_store(p_operation,p_payload);
end;
$$;
revoke execute on function reach_accounts.legacy_account_store(text,jsonb) from public,anon,authenticated;
grant execute on function reach_accounts.legacy_account_store(text,jsonb) to service_role;
revoke execute on function public.reach_account_store(text,jsonb) from public,anon,authenticated;
grant execute on function public.reach_account_store(text,jsonb) to service_role;
notify pgrst,'reload schema';
