-- Application administrators receive complimentary subscription-model access.
-- Roles stay in the existing private, RLS-protected account table. No browser
-- metadata, JWT role claim, payment receipt or wallet balance grants this role.
alter table reach_accounts.accounts
  add column role text not null default 'user' check (role in ('user','admin'));
comment on column reach_accounts.accounts.role is
  'Operator-managed application role. Admin grants complimentary subscription access; never set from client metadata.';

-- Reuse the unlimited request ledger, including its replay and recovery rules.
-- Stored paid plans, credits and payment history remain unchanged on promotion
-- and demotion. Every reservation checks the current database role.
create or replace function reach_accounts.request_store_before_sources(p_operation text,p_payload jsonb) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare
  a reach_accounts.accounts%rowtype; r reach_accounts.plus_requests%rowtype;
  v_now bigint := (p_payload->>'now')::bigint;
  v_policy jsonb := p_payload->'subscription'->'plus';
  v_active boolean; v_admin boolean; v_version text; v_count bigint; v_reserved bigint; v_id text; v_replay jsonb; result jsonb;
begin
  if jsonb_typeof(p_payload) is distinct from 'object' or v_now is null or v_now<0 then perform reach_accounts.fail('invalid_operation'); end if;
  if p_operation='unsettled_requests' then
    result:=reach_accounts.basic_request_store(p_operation,p_payload)->'result';
    select coalesce(jsonb_agg(jsonb_build_object('id',x.id,'account_id',x.account_id,'request_id',x.request_id,'model',x.model,'amount',0,'status',x.status,'created',x.created,'reason',x.reason,'currency','requests','unlimited',true) order by x.created,x.id),'[]'::jsonb) into v_replay from reach_accounts.plus_requests x where status in ('reserved','uncertain') and (p_payload->>'accountId' is null or account_id=p_payload->>'accountId');
    return jsonb_build_object('result',result||v_replay);
  elsif p_operation in ('request_allowance','reserve_request') then
    select * into a from reach_accounts.accounts where id=p_payload->>'accountId' for update;
    if not found then perform reach_accounts.fail('account_missing'); end if;
    select * into r from reach_accounts.plus_requests where account_id=a.id and request_id=p_payload->>'requestId' for update;
    v_admin:=a.role='admin';
    v_version:=case when v_admin then 'admin_'||a.id else a.plan_version end;
    if not v_admin and a.plan_id is distinct from 'plus' and r.id is null then
      return reach_accounts.basic_request_store(p_operation,p_payload);
    end if;
    -- Complimentary administrator access is a private database role. Paid Plus
    -- still requires its original verified receipt; no payment is fabricated.
    v_active:=v_admin or (reach_accounts.plus_policy_ok(v_policy) and a.plan_id='plus'
      and a.plan_expires>v_now and coalesce(a.plan_version,'') ~ '^plus_[a-f0-9]{48}$'
      and exists(select 1 from reach_accounts.plus_payments where account_id=a.id
        and grant_id=a.plan_version and period_end=a.plan_expires and status='applied'));
    if p_operation='request_allowance' then
      select count(*) filter(where status='settled'),count(*) filter(where status in ('reserved','uncertain')) into v_count,v_reserved from reach_accounts.plus_requests where account_id=a.id and plan_version=v_version;
      return jsonb_build_object('result',jsonb_build_object('allowance',jsonb_build_object('adminActive',v_admin,'plusActive',v_active,'unlimited',v_active,'basicActive',false,'includedLimit',null,'remaining',null,'completed',v_count,'reserved',v_reserved,'overageUsdMicrosPerRequest',0,'periodEndsAt',case when v_admin then null else reach_accounts.iso_time(a.plan_expires) end),'reservedUsdMicros',0));
    end if;
    if (p_payload->>'modelQualified')::boolean is distinct from true then perform reach_accounts.fail('model_not_entitled'); end if;
    if coalesce(p_payload->>'requestId','') !~ '^[a-zA-Z0-9._:-]{1,128}$' or coalesce(length(p_payload->>'fingerprint'),0) not between 1 and 128 or coalesce(length(p_payload->>'model'),0) not between 1 and 128 then perform reach_accounts.fail('invalid_reservation'); end if;
    if r.id is not null then
      if r.model is distinct from p_payload->>'model' or r.fingerprint is distinct from p_payload->>'fingerprint' then perform reach_accounts.fail('idempotency_conflict'); end if;
      if r.status<>'released' then return jsonb_build_object('result',jsonb_build_object('id',r.id,'status',r.status,'fresh',false,'replay',r.replay::jsonb)); end if;
    end if;
    if not v_active then perform reach_accounts.fail('subscription_expired'); end if;
    if a.usd_debt>0 then perform reach_accounts.fail('usage_debt'); end if;
    if exists(select 1 from reach_accounts.request_reservations where account_id=a.id and request_id=p_payload->>'requestId') or exists(select 1 from reach_accounts.reservations where account_id=a.id and request_id=p_payload->>'requestId') then perform reach_accounts.fail('idempotency_conflict'); end if;
    v_id:=coalesce(r.id,p_payload->>'reservationId');
    insert into reach_accounts.plus_requests(id,account_id,request_id,model,fingerprint,plan_version,status,created) values(v_id,a.id,p_payload->>'requestId',p_payload->>'model',p_payload->>'fingerprint',v_version,'reserved',v_now)
      on conflict(id) do update set plan_version=excluded.plan_version,status='reserved',replay=null,reason=null,created=excluded.created;
    return jsonb_build_object('result',jsonb_build_object('id',v_id,'status','reserved','fresh',true,'replay',null));
  elsif p_operation in ('settle_request','release_request','mark_request_uncertain') then
    select * into r from reach_accounts.plus_requests where id=p_payload->>'reservationId';
    if r.id is null then return reach_accounts.basic_request_store(p_operation,p_payload); end if;
    perform 1 from reach_accounts.accounts where id=r.account_id for update;
    select * into r from reach_accounts.plus_requests where id=r.id for update;
    if p_operation='mark_request_uncertain' then
      update reach_accounts.plus_requests set status='uncertain',reason=left(p_payload->>'reason',200) where id=r.id and status='reserved';
    elsif p_operation='release_request' then
      if r.status='released' then return jsonb_build_object('result',null); end if;
      if r.status<>'reserved' then perform reach_accounts.fail('reservation_closed'); end if;
      update reach_accounts.plus_requests set status='released',replay=null,reason='not_completed' where id=r.id;
    else
      begin v_replay:=(p_payload->>'replay')::jsonb; exception when data_exception then perform reach_accounts.fail('invalid_replay'); end;
      if jsonb_typeof(v_replay) is distinct from 'object' or coalesce(v_replay->>'contentType','') not in ('application/json; charset=utf-8','text/event-stream') or jsonb_typeof(v_replay->'body') is distinct from 'string' or octet_length(p_payload->>'replay')>1048576 then perform reach_accounts.fail('invalid_replay'); end if;
      if r.status='settled' then return jsonb_build_object('result',null); end if;
      if r.status not in ('reserved','uncertain') then perform reach_accounts.fail('reservation_closed'); end if;
      update reach_accounts.plus_requests set status='settled',replay=p_payload->>'replay',reason=null where id=r.id;
    end if;
    return jsonb_build_object('result',null);
  end if;
  return reach_accounts.basic_request_store(p_operation,p_payload);
end;
$$;

create or replace function public.reach_api_key_store(p_operation text,p_payload jsonb) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare a reach_accounts.accounts%rowtype;
begin
  if p_operation = 'create' then
    select * into a from reach_accounts.accounts where id=p_payload->>'accountId' for update;
    if not found then perform reach_accounts.fail('account_missing'); end if;
    if a.role<>'admin' and not (a.plan_id is not null and a.plan_expires>(p_payload->>'now')::bigint)
      and not (a.debt=0 and least(a.prepaid,a.rch_tokens)>0)
      and not (a.usd_debt=0 and least(a.usd_prepaid,a.rch_usd)>0) then
      perform reach_accounts.fail('api_key_ineligible');
    end if;
  end if;
  return reach_accounts.reach_api_key_store_before_eligibility(p_operation,p_payload);
end;
$$;

revoke execute on function reach_accounts.request_store_before_sources(text,jsonb)
  from public,anon,authenticated;
grant execute on function reach_accounts.request_store_before_sources(text,jsonb) to service_role;
revoke execute on function public.reach_api_key_store(text,jsonb) from public,anon,authenticated;
grant execute on function public.reach_api_key_store(text,jsonb) to service_role;
notify pgrst,'reload schema';
