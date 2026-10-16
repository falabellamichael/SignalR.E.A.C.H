-- Source-only migration: deploy separately after backup/review. No historical
-- account, Basic payment, RCH credit or existing request row is rewritten.
-- CAD minor units are deliberately separate from the legacy USD credit ledger.
create table reach_accounts.plus_payments (
  id text primary key, object_id text not null unique, event_id text not null,
  account_id text not null, price_id text not null,
  amount_minor bigint not null check(amount_minor>0), currency text not null check(currency in ('cad','usd')),
  period_end bigint not null, status text not null check(status in ('applied','superseded','expired','rejected')),
  reason text, grant_id text, fingerprint text not null, created bigint not null,
  customer_id text not null, subscription_id text not null, checkout_id text not null, session_id text not null
);
create index plus_payment_receipt on reach_accounts.plus_payments(account_id,grant_id,period_end,status);
create index plus_payment_subscription on reach_accounts.plus_payments(subscription_id);
create index plus_payment_checkout on reach_accounts.plus_payments(checkout_id);
create table reach_accounts.plus_reversals (
  id text primary key, object_id text not null, kind text not null check(kind in ('refund','dispute')),
  event_id text not null, payment_id text not null references reach_accounts.plus_payments(id),
  amount_minor bigint not null check(amount_minor>0), currency text not null,
  status text not null check(status in ('applied','rejected')), reason text, fingerprint text not null, created bigint not null,
  unique(object_id,kind)
);
create table reach_accounts.plus_requests (
  id text primary key, account_id text not null references reach_accounts.accounts(id),
  request_id text not null, model text not null, fingerprint text not null, plan_version text not null,
  status text not null check(status in ('reserved','uncertain','released','settled')),
  replay text, reason text, created bigint not null, unique(account_id,request_id)
);
create index plus_request_account on reach_accounts.plus_requests(account_id,plan_version,status);
alter table reach_accounts.plus_payments enable row level security;
alter table reach_accounts.plus_reversals enable row level security;
alter table reach_accounts.plus_requests enable row level security;
revoke all on reach_accounts.plus_payments,reach_accounts.plus_reversals,reach_accounts.plus_requests from public,anon,authenticated;
grant select,insert on reach_accounts.plus_payments,reach_accounts.plus_reversals to service_role;
grant select,insert,update,delete on reach_accounts.plus_requests to service_role;

create function reach_accounts.plus_policy_ok(p jsonb) returns boolean
language sql immutable security invoker set search_path='' as $$
  select coalesce(p->>'id'='plus' and length(p->>'name') between 1 and 80
    and p->>'currency' in ('cad','usd') and (p->>'amountMinor')::bigint between 1 and 1000000
    and p->>'interval'='month' and p->'intervalCount'='1'::jsonb
    and p->>'taxBehavior'='inclusive' and p->'unlimited'='true'::jsonb,false)
$$;
revoke execute on function reach_accounts.plus_policy_ok(jsonb) from public,anon,authenticated;
grant execute on function reach_accounts.plus_policy_ok(jsonb) to service_role;

-- Historical receipts retain the initial Checkout binding across renewals and
-- later checkout-intent rotation. Only server-written intents bootstrap it.
create function reach_accounts.plus_checkout_binding(p jsonb) returns text
language plpgsql security invoker set search_path='' as $$
declare v_session text;
begin
  if exists(select 1 from reach_accounts.plus_payments where subscription_id=p->>'subscriptionId' or checkout_id=p->>'checkoutId') then
    if exists(select 1 from reach_accounts.plus_payments where (subscription_id=p->>'subscriptionId' or checkout_id=p->>'checkoutId') and
      (account_id is distinct from p->>'accountId' or customer_id is distinct from p->>'customerId'
       or subscription_id is distinct from p->>'subscriptionId' or checkout_id is distinct from p->>'checkoutId' or price_id is distinct from p->>'priceId')) then perform reach_accounts.fail('payment_conflict'); end if;
    select session_id into v_session from reach_accounts.plus_payments where subscription_id=p->>'subscriptionId' limit 1;
  else
    select provider_object_id into v_session from reach_accounts.subscription_checkouts where account_id=p->>'accountId' and id=p->>'checkoutId';
    if v_session is null then perform reach_accounts.fail('plus_checkout_pending'); end if;
  end if;
  return v_session;
end;
$$;
revoke execute on function reach_accounts.plus_checkout_binding(jsonb) from public,anon,authenticated;
grant execute on function reach_accounts.plus_checkout_binding(jsonb) to service_role;

create function public.reach_plus_store(p_operation text,p_payload jsonb) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare
  a reach_accounts.accounts%rowtype;
  x reach_accounts.plus_payments%rowtype;
  r reach_accounts.plus_reversals%rowtype;
  v_now bigint := (p_payload->>'now')::bigint;
  v_policy jsonb := p_payload->'subscription'->'plus';
  v_amount bigint := (p_payload->>'amountMinor')::bigint;
  v_period bigint := (p_payload->>'periodEnd')::bigint;
  v_currency text := p_payload->>'currency';
  v_status text := 'applied'; v_reason text; v_grant text;
  v_prior bigint; v_found boolean; v_verified boolean; result jsonb;
begin
  if jsonb_typeof(p_payload) is distinct from 'object' or v_now is null or v_now<0 then perform reach_accounts.fail('invalid_operation'); end if;
  if p_operation='apply_payment' then
    if not reach_accounts.plus_policy_ok(v_policy) then perform reach_accounts.fail('subscription_unconfigured'); end if;
    if p_payload->>'provider' is distinct from 'stripe' or p_payload->>'planId' is distinct from 'plus'
      or coalesce(p_payload->>'objectId','') !~ '^[A-Za-z0-9_.:-]{3,128}$'
      or coalesce(p_payload->>'eventId','') !~ '^[A-Za-z0-9_.:-]{3,128}$'
      or coalesce(p_payload->>'accountId','') !~ '^[A-Za-z0-9_-]{8,128}$'
      or coalesce(p_payload->>'priceId','') !~ '^price_[A-Za-z0-9]{8,64}$'
      or coalesce(p_payload->>'customerId','') !~ '^cus_[A-Za-z0-9]{3,128}$'
      or coalesce(p_payload->>'subscriptionId','') !~ '^sub_[A-Za-z0-9]{3,128}$'
      or coalesce(p_payload->>'checkoutId','') !~ '^[a-f0-9]{64}$'
      or coalesce(p_payload->>'sessionId','') !~ '^cs_[A-Za-z0-9_]{3,128}$'
      or coalesce(p_payload->>'paymentId','') !~ '^[a-f0-9]{64}$'
      or coalesce(p_payload->>'fingerprint','') !~ '^[a-f0-9]{64}$'
      or coalesce(p_payload->>'grantId','') !~ '^plus_[a-f0-9]{48}$'
      or v_amount is null or v_amount not between 1 and 1000000 or v_currency not in ('cad','usd')
      or v_currency is null or v_period is null or v_period<=0
      or jsonb_typeof(p_payload->'models') is distinct from 'array' or jsonb_array_length(p_payload->'models')=0 then perform reach_accounts.fail('invalid_payment'); end if;
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('reach-payment:stripe:subscription_period:'||(p_payload->>'objectId'),0));
    select * into x from reach_accounts.plus_payments where object_id=p_payload->>'objectId';
    if found then
      if x.fingerprint is distinct from p_payload->>'fingerprint' then perform reach_accounts.fail('payment_conflict'); end if;
      return jsonb_build_object('result',jsonb_build_object('paymentId',x.id,'status',x.status,'reason',x.reason,'grantId',x.grant_id,'duplicate',true));
    end if;
    if exists(select 1 from reach_accounts.payments where provider='stripe' and object_id=p_payload->>'objectId') then perform reach_accounts.fail('payment_conflict'); end if;
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('reach-grant:'||(p_payload->>'grantId'),0));
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('reach-plus-checkout:'||(p_payload->>'checkoutId'),0));
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('reach-plus-subscription:'||(p_payload->>'subscriptionId'),0));
    select * into a from reach_accounts.accounts where id=p_payload->>'accountId' for update;
    v_found:=found;
    if reach_accounts.plus_checkout_binding(p_payload) is distinct from p_payload->>'sessionId' then perform reach_accounts.fail('payment_conflict'); end if;
    if a.plan_expires>v_now and exists(select 1 from reach_accounts.plus_payments where account_id=a.id and grant_id=a.plan_version and status='applied' and subscription_id is distinct from p_payload->>'subscriptionId') then perform reach_accounts.fail('payment_conflict'); end if;
    v_verified:=a.plan_id='plus' and exists(select 1 from reach_accounts.plus_payments where account_id=a.id and grant_id=a.plan_version and period_end=a.plan_expires and status='applied');
    if not v_found then v_status:='rejected';v_reason:='account_missing';
    elsif v_amount<>(v_policy->>'amountMinor')::bigint or v_currency<>v_policy->>'currency' then v_status:='rejected';v_reason:='amount_mismatch';
    elsif v_period<=v_now then v_status:='expired';v_reason:='period_over';
    elsif v_period>v_now+2764800000 then v_status:='rejected';v_reason:='period_too_long';
    elsif coalesce(a.plan_id,'')<>'' and not coalesce(v_verified,false) and a.plan_expires>v_now then v_status:='rejected';v_reason:='other_plan_active';
    elsif v_verified and a.plan_expires>=v_period then v_status:='superseded';v_reason:='newer_period_active';
    end if;
    if v_status='applied' then
      v_grant:=p_payload->>'grantId';
      perform reach_accounts.legacy_account_store('grant_plan',jsonb_build_object(
        'accountId',a.id,'grantId',v_grant,'planId','plus','name',v_policy->>'name','models',p_payload->'models','tokens',0,'expiresAt',v_period,'now',v_now,
        'payload',jsonb_build_object('accountId',a.id,'planId','plus','name',v_policy->>'name','models',p_payload->'models','tokens',0,'expiresAt',v_period)::text));
    end if;
    insert into reach_accounts.plus_payments values(p_payload->>'paymentId',p_payload->>'objectId',p_payload->>'eventId',p_payload->>'accountId',p_payload->>'priceId',v_amount,v_currency,v_period,v_status,v_reason,v_grant,p_payload->>'fingerprint',v_now,p_payload->>'customerId',p_payload->>'subscriptionId',p_payload->>'checkoutId',p_payload->>'sessionId') returning * into x;
    return jsonb_build_object('result',jsonb_build_object('paymentId',x.id,'status',x.status,'reason',x.reason,'grantId',x.grant_id,'duplicate',false));
  elsif p_operation='pending_checkout' then
    select jsonb_build_object('id',c.id,'fingerprint',c.fingerprint,'expiresAt',c.expires,'providerObjectId',c.provider_object_id) into result from reach_accounts.subscription_checkouts c where c.account_id=p_payload->>'accountId';
    return jsonb_build_object('result',result);
  elsif p_operation='checkout_binding' then
    return jsonb_build_object('result',jsonb_build_object('sessionId',reach_accounts.plus_checkout_binding(p_payload)));
  elsif p_operation='portal_customer' then
    select p.customer_id into v_currency from reach_accounts.plus_payments p join reach_accounts.accounts acct on acct.id=p.account_id and acct.plan_version=p.grant_id where acct.id=p_payload->>'accountId' and p.status='applied';
    return jsonb_build_object('result',v_currency);
  elsif p_operation='apply_reversal' then
    if coalesce(p_payload->>'objectId','') !~ '^[A-Za-z0-9_.:-]{3,128}$'
      or coalesce(p_payload->>'eventId','') !~ '^[A-Za-z0-9_.:-]{3,128}$'
      or coalesce(p_payload->>'originalObjectId','') !~ '^[A-Za-z0-9_.:-]{3,128}$'
      or coalesce(p_payload->>'fingerprint','') !~ '^[a-f0-9]{64}$'
      or coalesce(p_payload->>'reversalId','') !~ '^[a-f0-9]{64}$'
      or coalesce(p_payload->>'kind','') not in ('refund','dispute') or v_amount is null or v_amount<=0 then perform reach_accounts.fail('invalid_payment'); end if;
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('reach-plus-reversal:'||(p_payload->>'kind')||':'||(p_payload->>'objectId'),0));
    select * into r from reach_accounts.plus_reversals where object_id=p_payload->>'objectId' and kind=p_payload->>'kind';
    if found then
      if r.fingerprint is distinct from p_payload->>'fingerprint' then perform reach_accounts.fail('payment_conflict'); end if;
      return jsonb_build_object('result',jsonb_build_object('status',r.status,'reason',r.reason,'duplicate',true));
    end if;
    select * into x from reach_accounts.plus_payments where object_id=p_payload->>'originalObjectId';
    if not found then return jsonb_build_object('result',null); end if;
    if v_currency is distinct from x.currency then perform reach_accounts.fail('invalid_payment'); end if;
    select * into a from reach_accounts.accounts where id=x.account_id for update;
    v_found:=found;
    select coalesce(sum(amount_minor),0) into v_prior from reach_accounts.plus_reversals where payment_id=x.id;
    if x.status<>'applied' then v_reason:='original_not_applied';
    elsif v_prior+v_amount<x.amount_minor then v_reason:='partial_reversal';
    elsif not v_found then v_reason:='account_missing';
    elsif a.plan_version is distinct from x.grant_id then v_reason:='period_not_current';
    elsif a.plan_expires<=v_now then v_reason:='plan_already_ended'; end if;
    if v_reason is null then update reach_accounts.accounts set plan_expires=v_now where id=a.id;
    else v_status:='rejected'; end if;
    insert into reach_accounts.plus_reversals values(p_payload->>'reversalId',p_payload->>'objectId',p_payload->>'kind',p_payload->>'eventId',x.id,v_amount,v_currency,v_status,v_reason,p_payload->>'fingerprint',v_now);
    return jsonb_build_object('result',jsonb_build_object('status',v_status,'reason',v_reason,'duplicate',false));
  elsif p_operation in ('list_payments','flagged_payments') then
    select coalesce(jsonb_agg(to_jsonb(t)-'fingerprint' order by t.created desc,t.id),'[]'::jsonb) into result from
      (select * from reach_accounts.plus_payments where case when p_operation='flagged_payments' then status in ('rejected','expired') else account_id=p_payload->>'accountId' end order by created desc,id limit 200) t;
    return jsonb_build_object('result',result);
  elsif p_operation in ('list_reversals','flagged_reversals') then
    select coalesce(jsonb_agg(to_jsonb(t)-'fingerprint' order by t.created desc,t.id),'[]'::jsonb) into result from
      (select r.*,p.account_id from reach_accounts.plus_reversals r join reach_accounts.plus_payments p on p.id=r.payment_id where case when p_operation='flagged_reversals' then r.status='rejected' else p.account_id=p_payload->>'accountId' end order by r.created desc,r.id limit 200) t;
    return jsonb_build_object('result',result);
  end if;
  perform reach_accounts.fail('invalid_operation');
end;
$$;
revoke execute on function public.reach_plus_store(text,jsonb) from public,anon,authenticated;
grant execute on function public.reach_plus_store(text,jsonb) to service_role;

-- Wrap the original request ledger, preserving every Basic/PAYG operation.
alter function public.reach_request_store(text,jsonb) set schema reach_accounts;
alter function reach_accounts.reach_request_store(text,jsonb) rename to basic_request_store;
create function public.reach_request_store(p_operation text,p_payload jsonb) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare
  a reach_accounts.accounts%rowtype; r reach_accounts.plus_requests%rowtype;
  v_now bigint := (p_payload->>'now')::bigint;
  v_policy jsonb := p_payload->'subscription'->'plus';
  v_active boolean; v_count bigint; v_reserved bigint; v_id text; v_replay jsonb; result jsonb;
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
    if a.plan_id is distinct from 'plus' and r.id is null then return reach_accounts.basic_request_store(p_operation,p_payload); end if;
    v_active:=reach_accounts.plus_policy_ok(v_policy) and a.plan_id='plus' and a.plan_expires>v_now and coalesce(a.plan_version,'') ~ '^plus_[a-f0-9]{48}$'
      and exists(select 1 from reach_accounts.plus_payments where account_id=a.id and grant_id=a.plan_version and period_end=a.plan_expires and status='applied');
    if p_operation='request_allowance' then
      select count(*) filter(where status='settled'),count(*) filter(where status in ('reserved','uncertain')) into v_count,v_reserved from reach_accounts.plus_requests where account_id=a.id and plan_version=a.plan_version;
      return jsonb_build_object('result',jsonb_build_object('allowance',jsonb_build_object('plusActive',v_active,'unlimited',v_active,'basicActive',false,'includedLimit',null,'remaining',null,'completed',v_count,'reserved',v_reserved,'overageUsdMicrosPerRequest',0,'periodEndsAt',reach_accounts.iso_time(a.plan_expires)),'reservedUsdMicros',0));
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
    insert into reach_accounts.plus_requests(id,account_id,request_id,model,fingerprint,plan_version,status,created) values(v_id,a.id,p_payload->>'requestId',p_payload->>'model',p_payload->>'fingerprint',a.plan_version,'reserved',v_now)
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
revoke execute on function reach_accounts.basic_request_store(text,jsonb) from public,anon,authenticated;
grant execute on function reach_accounts.basic_request_store(text,jsonb) to service_role;
revoke execute on function public.reach_request_store(text,jsonb) from public,anon,authenticated;
grant execute on function public.reach_request_store(text,jsonb) to service_role;

-- Close cross-mode replay holes while delegating the existing auth/RCH/Basic
-- dispatchers unchanged. The shared account lock serializes billing modes.
alter function public.reach_account_store(text,jsonb) set schema reach_accounts;
alter function reach_accounts.reach_account_store(text,jsonb) rename to pre_plus_account_store;
create function public.reach_account_store(p_operation text,p_payload jsonb) returns jsonb
language plpgsql security invoker set search_path='' as $$
begin
  if p_operation in ('reserve','reserve_usd') then
    perform 1 from reach_accounts.accounts where id=p_payload->>'accountId' for update;
    if exists(select 1 from reach_accounts.plus_requests where account_id=p_payload->>'accountId' and request_id=p_payload->>'requestId') then perform reach_accounts.fail('idempotency_conflict'); end if;
  end if;
  return reach_accounts.pre_plus_account_store(p_operation,p_payload);
end;
$$;
alter function public.reach_payment_store(text,jsonb) set schema reach_accounts;
alter function reach_accounts.reach_payment_store(text,jsonb) rename to basic_payment_store;
create function public.reach_payment_store(p_operation text,p_payload jsonb) returns jsonb
language plpgsql security invoker set search_path='' as $$
begin
  if p_operation='apply_payment' and p_payload->>'provider'='stripe' then
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('reach-payment:stripe:subscription_period:'||(p_payload->>'objectId'),0));
    if exists(select 1 from reach_accounts.plus_payments where object_id=p_payload->>'objectId') then perform reach_accounts.fail('payment_conflict'); end if;
  end if;
  return reach_accounts.basic_payment_store(p_operation,p_payload);
end;
$$;
revoke execute on function reach_accounts.pre_plus_account_store(text,jsonb),reach_accounts.basic_payment_store(text,jsonb) from public,anon,authenticated;
grant execute on function reach_accounts.pre_plus_account_store(text,jsonb),reach_accounts.basic_payment_store(text,jsonb) to service_role;
revoke execute on function public.reach_account_store(text,jsonb),public.reach_payment_store(text,jsonb) from public,anon,authenticated;
grant execute on function public.reach_account_store(text,jsonb),public.reach_payment_store(text,jsonb) to service_role;
notify pgrst,'reload schema';
