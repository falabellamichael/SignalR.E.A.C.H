-- Historical pooled balances/holds have no durable source attribution. Do not
-- infer it from gross redemptions: debt, imports and intervening spending make
-- that ambiguous. Existing verified available source is retained; old holds
-- default to unknown source and require ledger reconciliation before recovery.
alter table reach_accounts.reservations add column held_rch bigint not null default 0 check(held_rch>=0);
alter table reach_accounts.request_reservations add column held_rch bigint not null default 0 check(held_rch>=0);

alter function public.reach_account_store(text,jsonb) rename to account_store_before_sources;
alter function public.account_store_before_sources(text,jsonb) set schema reach_accounts;
create function public.reach_account_store(p_operation text,p_payload jsonb) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare a reach_accounts.accounts%rowtype; r reach_accounts.reservations%rowtype;
  result jsonb; v_id text; refund bigint:=0; actual bigint;
begin
  if p_operation in ('reserve','reserve_usd') then
    select * into a from reach_accounts.accounts where id=p_payload->>'accountId' for update;
    result:=reach_accounts.account_store_before_sources(p_operation,p_payload);
    if (result->'result'->>'fresh')::boolean then
      v_id:=result->'result'->>'id';
      select * into r from reach_accounts.reservations where id=v_id;
      update reach_accounts.reservations set held_rch=case when r.currency='USD'
        then least(r.amount,a.rch_usd) else least(r.held_prepaid,a.rch_tokens) end where id=v_id;
    end if;
    return result;
  elsif p_operation in ('release','settle') then
    select * into r from reach_accounts.reservations where id=p_payload->>'reservationId';
    select * into a from reach_accounts.accounts where id=r.account_id for update;
    select * into r from reach_accounts.reservations where id=p_payload->>'reservationId' for update;
    result:=reach_accounts.account_store_before_sources(p_operation,p_payload);
    if p_operation='release' and r.status='reserved' then refund:=r.held_rch;
    elsif p_operation='settle' and r.status in ('reserved','uncertain') then
      if r.currency='USD' then
        select (usage::jsonb->>'chargedUsdMicros')::bigint into actual from reach_accounts.reservations where id=r.id;
      else actual:=greatest(0,(p_payload->'usage'->>'totalTokens')::bigint-r.held_included);
      end if;
      refund:=greatest(0,r.held_rch-actual);
    end if;
    if refund>0 then update reach_accounts.accounts set
      rch_usd=rch_usd+case when r.currency='USD' then refund else 0 end,
      rch_tokens=rch_tokens+case when r.currency='tokens' then refund else 0 end where id=a.id;
    end if;
    return result;
  end if;
  return reach_accounts.account_store_before_sources(p_operation,p_payload);
end;
$$;

alter function public.reach_request_store(text,jsonb) rename to request_store_before_sources;
alter function public.request_store_before_sources(text,jsonb) set schema reach_accounts;
create function public.reach_request_store(p_operation text,p_payload jsonb) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare a reach_accounts.accounts%rowtype; r reach_accounts.request_reservations%rowtype; result jsonb; v_id text;
begin
  if p_operation='reserve_request' then
    select * into a from reach_accounts.accounts where id=p_payload->>'accountId' for update;
    result:=reach_accounts.request_store_before_sources(p_operation,p_payload);
    if (result->'result'->>'fresh')::boolean then
      v_id:=result->'result'->>'id';
      update reach_accounts.request_reservations set held_rch=least(charge_usd_micros,a.rch_usd) where id=v_id;
    end if;
    return result;
  elsif p_operation='release_request' then
    select * into r from reach_accounts.request_reservations where id=p_payload->>'reservationId';
    select * into a from reach_accounts.accounts where id=r.account_id for update;
    select * into r from reach_accounts.request_reservations where id=p_payload->>'reservationId' for update;
    result:=reach_accounts.request_store_before_sources(p_operation,p_payload);
    if r.status='reserved' then update reach_accounts.accounts set rch_usd=rch_usd+r.held_rch where id=a.id; end if;
    return result;
  end if;
  return reach_accounts.request_store_before_sources(p_operation,p_payload);
end;
$$;
revoke execute on all functions in schema reach_accounts from public,anon,authenticated;
grant execute on all functions in schema reach_accounts to service_role;
revoke execute on function public.reach_account_store(text,jsonb),public.reach_request_store(text,jsonb) from public,anon,authenticated;
grant execute on function public.reach_account_store(text,jsonb),public.reach_request_store(text,jsonb) to service_role;
notify pgrst,'reload schema';
