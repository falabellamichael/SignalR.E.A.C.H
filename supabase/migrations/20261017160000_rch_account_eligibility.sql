-- Fail closed for historical pooled balances: their remaining source cannot be
-- proved. New confirmed redemptions record only the net credit after debt.
alter table reach_accounts.accounts
  add column rch_tokens bigint not null default 0 check (rch_tokens >= 0),
  add column rch_usd bigint not null default 0 check (rch_usd >= 0);

create function reach_accounts.consume_rch_credit() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.rch_tokens := greatest(0,new.rch_tokens-greatest(0,old.prepaid-new.prepaid));
  new.rch_usd := greatest(0,new.rch_usd-greatest(0,old.usd_prepaid-new.usd_prepaid));
  return new;
end;
$$;
create trigger consume_rch_credit before update of prepaid,usd_prepaid on reach_accounts.accounts
  for each row execute function reach_accounts.consume_rch_credit();

-- Keep the existing charging dispatcher intact. Serialize the source credit
-- with the same account lock used by reservations and key creation.
alter function public.reach_account_store(text,jsonb) rename to reach_account_store_before_eligibility;
alter function public.reach_account_store_before_eligibility(text,jsonb) set schema reach_accounts;
create function public.reach_account_store(p_operation text,p_payload jsonb) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare a reach_accounts.accounts%rowtype; r reach_accounts.redemptions%rowtype; result jsonb;
begin
  if p_operation = 'credit_redemption' then
    select * into r from reach_accounts.redemptions where id=p_payload->>'redemptionId';
    select * into a from reach_accounts.accounts where id=r.account_id for update;
    -- Re-read after waiting on the account lock: a competing reconciler may
    -- already have credited this redemption while we waited.
    select * into r from reach_accounts.redemptions where id=p_payload->>'redemptionId';
    result := reach_accounts.reach_account_store_before_eligibility(p_operation,p_payload);
    if r.status <> 'credited' then
      update reach_accounts.accounts set
        rch_tokens=rch_tokens+greatest(0,prepaid-a.prepaid),
        rch_usd=rch_usd+greatest(0,usd_prepaid-a.usd_prepaid) where id=a.id;
    end if;
    return result;
  end if;
  return reach_accounts.reach_account_store_before_eligibility(p_operation,p_payload);
end;
$$;
revoke execute on function public.reach_account_store(text,jsonb) from public,anon,authenticated;
grant execute on function public.reach_account_store(text,jsonb) to service_role;

alter function public.reach_api_key_store(text,jsonb) rename to reach_api_key_store_before_eligibility;
alter function public.reach_api_key_store_before_eligibility(text,jsonb) set schema reach_accounts;
create function public.reach_api_key_store(p_operation text,p_payload jsonb) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare a reach_accounts.accounts%rowtype;
begin
  if p_operation = 'create' then
    select * into a from reach_accounts.accounts where id=p_payload->>'accountId' for update;
    if not found then perform reach_accounts.fail('account_missing'); end if;
    if not (a.plan_id is not null and a.plan_expires>(p_payload->>'now')::bigint)
      and not (a.debt=0 and least(a.prepaid,a.rch_tokens)>0)
      and not (a.usd_debt=0 and least(a.usd_prepaid,a.rch_usd)>0) then
      perform reach_accounts.fail('api_key_ineligible');
    end if;
  end if;
  return reach_accounts.reach_api_key_store_before_eligibility(p_operation,p_payload);
end;
$$;
-- Private implementation functions must never become a callable bypass.
revoke execute on all functions in schema reach_accounts from public,anon,authenticated;
grant execute on all functions in schema reach_accounts to service_role;
revoke execute on function public.reach_api_key_store(text,jsonb) from public,anon,authenticated;
grant execute on function public.reach_api_key_store(text,jsonb) to service_role;
notify pgrst, 'reload schema';
