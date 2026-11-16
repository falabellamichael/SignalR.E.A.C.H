-- Read-only, account-scoped aggregates. Only the trusted account service calls
-- this RPC; API keys receive its sanitized HTTP result, never database access.
create function reach_accounts.usage_counters(p_usage text,p_replay text) returns jsonb
language plpgsql immutable security invoker set search_path='' as $$
declare u jsonb; r jsonb; event jsonb; line text; latest jsonb; candidate jsonb; i numeric; o numeric; t numeric; c numeric;
begin
  if p_usage is not null then
    begin
      u:=p_usage::jsonb;
      candidate:=reach_accounts.usage_counters(null,jsonb_build_object('body',jsonb_build_object(
        'usage_source','provider','usage',jsonb_build_object('prompt_tokens',u->'promptTokens',
        'completion_tokens',u->'completionTokens','total_tokens',u->'totalTokens',
        'prompt_tokens_details',jsonb_build_object('cached_tokens',u#>'{details,prompt,cached_tokens}')))::text)::text);
      if candidate is not null then return candidate; end if;
    exception when others then null;
    end;
  end if;
    r:=p_replay::jsonb;
    if r->>'contentType'='text/event-stream' then
      foreach line in array string_to_array(r->>'body',E'\n') loop
        if left(line,5)='data:' and btrim(substr(line,6))<>'[DONE]' then
          begin
            event:=substr(line,6)::jsonb;
            candidate:=reach_accounts.usage_counters(null,jsonb_build_object('body',event::text)::text);
            if candidate is not null then latest:=candidate; end if;
          exception when others then null;
          end;
        end if;
      end loop;
      return latest;
    else u:=(r->>'body')::jsonb;
    end if;
    if u->>'usage_source' is distinct from 'provider' then return null; end if;
    u:=u->'usage';
    if jsonb_typeof(u->'prompt_tokens') is distinct from 'number'
      or jsonb_typeof(u->'completion_tokens') is distinct from 'number'
      or jsonb_typeof(u->'total_tokens') is distinct from 'number'
      or (u#>'{prompt_tokens_details,cached_tokens}' is not null
        and u#>'{prompt_tokens_details,cached_tokens}'<>'null'::jsonb
        and jsonb_typeof(u#>'{prompt_tokens_details,cached_tokens}')<>'number') then return null; end if;
    i:=(u->>'prompt_tokens')::numeric; o:=(u->>'completion_tokens')::numeric;
    t:=(u->>'total_tokens')::numeric; c:=coalesce((u#>>'{prompt_tokens_details,cached_tokens}')::numeric,0);
  if i is null or o is null or t is null or i<0 or o<0 or c<0 or c>i or i+o<>t
    or i<>trunc(i) or o<>trunc(o) or c<>trunc(c) or t>9007199254740991 then return null; end if;
  return jsonb_build_object('input',i,'output',o,'cached',c);
exception when others then return null;
end;
$$;

create function public.reach_usage_summary(p_operation text,p_payload jsonb) returns jsonb
language plpgsql stable security invoker set search_path='' as $$
declare aid text:=p_payload->>'accountId'; since bigint:=(p_payload->>'from')::bigint;
  until_ms bigint:=(p_payload->>'to')::bigint; result jsonb;
begin
  if p_operation<>'summary' or since<0 or until_ms<=since or until_ms-since>31622400000
    or until_ms>(p_payload->>'now')::bigint+60000 or since is null or until_ms is null then
    raise exception 'invalid_usage_period';
  end if;
  if not exists(select 1 from reach_accounts.accounts where id=aid) then raise exception 'account_missing'; end if;
  with requests as (
    select model,status,usage,replay,currency,held_included,held_rch,0::bigint as charge_usd_micros
    from reach_accounts.reservations where account_id=aid and created>=since and created<until_ms
    union all
    select model,status,null,replay,'requests',0,held_rch,charge_usd_micros
    from reach_accounts.request_reservations where account_id=aid and created>=since and created<until_ms
    union all
    select model,status,null,replay,'requests',0,0,0
    from reach_accounts.plus_requests where account_id=aid and created>=since and created<until_ms
  ), measured as (
    select *,case when status='settled' then reach_accounts.usage_counters(usage,replay) end as tokens,
      case when status<>'settled' then 0 when currency='USD' then coalesce((usage::jsonb->>'chargedUsdMicros')::bigint,0)
        else charge_usd_micros end as charged
    from requests
  ), grouped as (
    select model,status,count(*) as count,count(tokens) as measured_count,
      coalesce(sum((tokens->>'input')::bigint),0) as input_tokens,
      coalesce(sum((tokens->>'output')::bigint),0) as output_tokens,
      coalesce(sum((tokens->>'cached')::bigint),0) as cached_tokens,
      coalesce(sum(charged),0) as credit_usd_micros,coalesce(sum(least(held_rch,charged)),0) as rch_usd_micros,
      coalesce(sum(case when currency='tokens' and tokens is not null then greatest(0,(tokens->>'input')::bigint+(tokens->>'output')::bigint-held_included) else 0 end),0) as legacy_credit_tokens
    from measured group by model,status
  ), paid as (
    select p.currency,p.amount_usd_micros as paid_micros,
      least(p.amount_usd_micros,coalesce((select sum(r.amount_usd_micros) from reach_accounts.payment_reversals r where r.payment_id=p.id and r.created<until_ms),0)) as refunded_micros
    from reach_accounts.payments p where p.account_id=aid and p.kind='subscription_period' and p.status<>'rejected' and p.created>=since and p.created<until_ms
    union all
    select p.currency,p.amount_minor*10000,
      least(p.amount_minor,coalesce((select sum(r.amount_minor) from reach_accounts.plus_reversals r where r.payment_id=p.id and r.created<until_ms),0))*10000
    from reach_accounts.plus_payments p where p.account_id=aid and p.status<>'rejected' and p.created>=since and p.created<until_ms
  ), subscriptions as (
    select currency,sum(paid_micros) as paid_micros,sum(refunded_micros) as refunded_micros from paid group by currency order by currency
  ), redeemed as (
    select coalesce(sum(usd_micros),0) as usd_micros,coalesce(sum(usage_tokens),0) as token_credits,coalesce(sum(amount::numeric),0)::text as amount_rch
    from reach_accounts.redemptions where account_id=aid and status='credited' and created>=since and created<until_ms
  ) select jsonb_build_object('requests',coalesce((select jsonb_agg(grouped) from grouped),'[]'::jsonb),
    'subscriptions',coalesce((select jsonb_agg(subscriptions) from subscriptions),'[]'::jsonb),
    'redemptions',(select jsonb_agg(redeemed) from redeemed)) into result;
  return jsonb_build_object('result',result);
end;
$$;
create index if not exists usage_reservation_period on reach_accounts.reservations(account_id,created);
create index if not exists usage_request_period on reach_accounts.request_reservations(account_id,created);
create index if not exists usage_plus_period on reach_accounts.plus_requests(account_id,created);
revoke all on function reach_accounts.usage_counters(text,text),public.reach_usage_summary(text,jsonb) from public,anon,authenticated;
grant execute on function reach_accounts.usage_counters(text,text),public.reach_usage_summary(text,jsonb) to service_role;
notify pgrst,'reload schema';
