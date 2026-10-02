-- Durable Stripe subscription checkout intent. No existing records change.
create table reach_accounts.subscription_checkouts (
  account_id text primary key references reach_accounts.accounts(id),
  id text not null unique check (id ~ '^[a-f0-9]{64}$'),
  fingerprint text not null check (fingerprint ~ '^[a-f0-9]{64}$'),
  expires bigint not null check (expires > 0)
);
alter table reach_accounts.subscription_checkouts enable row level security;
revoke all on reach_accounts.subscription_checkouts from public, anon, authenticated;
grant select, insert, update on reach_accounts.subscription_checkouts to service_role;
create function public.reach_checkout_store(p_operation text,p_payload jsonb) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare
  a reach_accounts.accounts%rowtype;
  c reach_accounts.subscription_checkouts%rowtype;
  v_now bigint := (p_payload->>'now')::bigint;
begin
  if p_operation is distinct from 'reserve_checkout' or v_now is null or v_now < 0
    or coalesce(p_payload->>'fingerprint','') !~ '^[a-f0-9]{64}$'
    or coalesce(p_payload->>'checkoutId','') !~ '^[a-f0-9]{64}$' then
    perform reach_accounts.fail('invalid_operation');
  end if;
  select * into a from reach_accounts.accounts where id=p_payload->>'accountId' for update;
  if not found then perform reach_accounts.fail('account_missing'); end if;
  if a.plan_id is not null and a.plan_expires > v_now then perform reach_accounts.fail('plan_active'); end if;
  select * into c from reach_accounts.subscription_checkouts where account_id=a.id;
  if found and (c.expires > v_now or c.id is distinct from p_payload->>'replaceExpiredId') then
    if c.fingerprint <> p_payload->>'fingerprint' then perform reach_accounts.fail('checkout_pending'); end if;
  else
    insert into reach_accounts.subscription_checkouts(account_id,id,fingerprint,expires)
      values(a.id,p_payload->>'checkoutId',p_payload->>'fingerprint',(v_now / 1000 + 3600)*1000)
      on conflict(account_id) do update set id=excluded.id,fingerprint=excluded.fingerprint,expires=excluded.expires
      returning * into c;
  end if;
  return jsonb_build_object('result',jsonb_build_object('id',c.id,'expiresAt',c.expires));
end;
$$;
revoke execute on function public.reach_checkout_store(text,jsonb) from public, anon, authenticated;
grant execute on function public.reach_checkout_store(text,jsonb) to service_role;
notify pgrst, 'reload schema';
