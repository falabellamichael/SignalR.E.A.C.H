-- Persist a known provider subscription so expired idempotency keys cannot create another charge.
alter table reach_accounts.subscription_checkouts add column provider_object_id text
  check (provider_object_id is null or provider_object_id ~ '^[A-Za-z0-9_-]{3,128}$');

create or replace function public.reach_checkout_store(p_operation text,p_payload jsonb) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare
  a reach_accounts.accounts%rowtype;
  c reach_accounts.subscription_checkouts%rowtype;
  v_now bigint := (p_payload->>'now')::bigint;
begin
  if p_operation not in ('reserve_checkout','attach_checkout') or v_now is null or v_now < 0
    or p_operation = 'reserve_checkout' and coalesce(p_payload->>'fingerprint','') !~ '^[a-f0-9]{64}$'
    or coalesce(p_payload->>'checkoutId','') !~ '^[a-f0-9]{64}$' then
    perform reach_accounts.fail('invalid_operation');
  end if;
  select * into a from reach_accounts.accounts where id=p_payload->>'accountId' for update;
  if not found then perform reach_accounts.fail('account_missing'); end if;
  if p_operation = 'attach_checkout' then
    if coalesce(p_payload->>'providerObjectId','') !~ '^[A-Za-z0-9_-]{3,128}$' then perform reach_accounts.fail('invalid_operation'); end if;
    select * into c from reach_accounts.subscription_checkouts where account_id=a.id;
    if not found or c.id is distinct from p_payload->>'checkoutId'
      or c.provider_object_id is not null and c.provider_object_id is distinct from p_payload->>'providerObjectId' then
      perform reach_accounts.fail('checkout_pending');
    end if;
    update reach_accounts.subscription_checkouts set provider_object_id=p_payload->>'providerObjectId' where account_id=a.id returning * into c;
    return jsonb_build_object('result',jsonb_build_object('id',c.id,'expiresAt',c.expires,'providerObjectId',c.provider_object_id));
  end if;
  if a.plan_id is not null and a.plan_expires > v_now then perform reach_accounts.fail('plan_active'); end if;
  select * into c from reach_accounts.subscription_checkouts where account_id=a.id;
  if found and (c.expires > v_now or c.id is distinct from p_payload->>'replaceExpiredId') then
    if c.fingerprint <> p_payload->>'fingerprint' then perform reach_accounts.fail('checkout_pending'); end if;
  else
    insert into reach_accounts.subscription_checkouts(account_id,id,fingerprint,expires)
      values(a.id,p_payload->>'checkoutId',p_payload->>'fingerprint',(v_now / 1000 + 3600)*1000)
      on conflict(account_id) do update set id=excluded.id,fingerprint=excluded.fingerprint,expires=excluded.expires,provider_object_id=null
      returning * into c;
  end if;
  return jsonb_build_object('result',jsonb_build_object('id',c.id,'expiresAt',c.expires) || case when c.provider_object_id is null then '{}'::jsonb else jsonb_build_object('providerObjectId',c.provider_object_id) end);
end;
$$;
revoke execute on function public.reach_checkout_store(text,jsonb) from public, anon, authenticated;
grant execute on function public.reach_checkout_store(text,jsonb) to service_role;
notify pgrst, 'reload schema';

-- Read only the immutable paid period for a replayed provider sale.
create function public.reach_payment_period(p_operation text,p_payload jsonb) returns jsonb
language sql security invoker set search_path = '' as $$
  select jsonb_build_object('result',(
    select jsonb_build_object('periodEnd',period_end) from reach_accounts.payments
    where p_operation='payment_period' and provider=p_payload->>'provider'
      and object_id=p_payload->>'objectId' and kind='subscription_period'
  ));
$$;
revoke execute on function public.reach_payment_period(text,jsonb) from public,anon,authenticated;
grant execute on function public.reach_payment_period(text,jsonb) to service_role;
notify pgrst,'reload schema';
