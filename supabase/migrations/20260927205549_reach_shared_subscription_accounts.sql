-- Shared REACH subscription state. Only the trusted account service uses this
-- schema. Wallet verification, chain-event verification, model configuration,
-- and conversion policy remain in that service, never in a browser client.
create schema if not exists reach_accounts;
revoke all on schema reach_accounts from public, anon, authenticated;
grant usage on schema reach_accounts to service_role;

create table reach_accounts.accounts (
  id text primary key check (id ~ '^[a-f0-9]{64}$'),
  wallet text unique not null check (wallet ~ '^0x[a-fA-F0-9]{40}$'),
  plan_id text, plan_name text, plan_expires bigint not null default 0,
  plan_version text, models text not null default '[]' check (jsonb_typeof(models::jsonb) = 'array'),
  included bigint not null default 0 check (included between 0 and 9007199254740991),
  -- Returning existing reserved funds may exceed the new-redemption credit cap.
  -- Keep that policy in credit_redemption; stored balances allow safe refunds.
  prepaid bigint not null default 0 check (prepaid between 0 and 9007199254740991),
  debt bigint not null default 0 check (debt between 0 and 9007199254740991)
);
create table reach_accounts.flows (
  id text primary key, state_hash text not null, challenge text not null,
  expires bigint not null, account_id text references reach_accounts.accounts(id),
  consumed integer not null default 0 check (consumed in (0, 1))
);
create table reach_accounts.challenges (
  id text primary key, flow_id text not null references reach_accounts.flows(id) on delete cascade,
  wallet text not null, message text not null, expires bigint not null,
  consumed integer not null default 0 check (consumed in (0, 1))
);
create table reach_accounts.sessions (
  hash text primary key, account_id text not null references reach_accounts.accounts(id), expires bigint not null
);
create table reach_accounts.grants (
  id text primary key, account_id text not null references reach_accounts.accounts(id), payload text not null
);
create table reach_accounts.reservations (
  id text primary key, account_id text not null references reach_accounts.accounts(id), request_id text not null,
  model text not null, fingerprint text not null, amount bigint not null check (amount between 1 and 1000000000000),
  held_included bigint not null check (held_included >= 0), held_prepaid bigint not null check (held_prepaid >= 0),
  plan_version text, status text not null check (status in ('reserved', 'uncertain', 'released', 'settled')),
  created bigint not null, usage text, replay text, reason text,
  unique (account_id, request_id), check (held_included + held_prepaid = amount)
);
create table reach_accounts.redemptions (
  id text primary key check (id ~ '^0x[a-f0-9]{64}$'), account_id text not null references reach_accounts.accounts(id),
  wallet text not null, amount text not null check (amount ~ '^[0-9]+$'),
  usage_tokens bigint not null check (usage_tokens between 1 and 1000000000000),
  ticket_hash text not null, expires bigint not null,
  status text not null default 'created' check (status in ('created', 'pending', 'credited')),
  tx_hash text, event_key text unique, created bigint not null
);
create index reservation_account_status on reach_accounts.reservations(account_id, status);
create index redemption_account_status on reach_accounts.redemptions(account_id, status);
create index redemption_status on reach_accounts.redemptions(status);
create index challenge_expiry on reach_accounts.challenges(expires);
create index challenge_flow on reach_accounts.challenges(flow_id);
create index flow_expiry on reach_accounts.flows(expires);
create index flow_account on reach_accounts.flows(account_id);
create index session_expiry on reach_accounts.sessions(expires);
create index session_account on reach_accounts.sessions(account_id);
create index grant_account on reach_accounts.grants(account_id);

alter table reach_accounts.accounts enable row level security;
alter table reach_accounts.flows enable row level security;
alter table reach_accounts.challenges enable row level security;
alter table reach_accounts.sessions enable row level security;
alter table reach_accounts.grants enable row level security;
alter table reach_accounts.reservations enable row level security;
alter table reach_accounts.redemptions enable row level security;
-- No anon/authenticated policies: shared balances can only be changed by the
-- service_role backend after it verifies the account session or chain event.
revoke all on all tables in schema reach_accounts from public, anon, authenticated;
grant select, insert, update, delete on all tables in schema reach_accounts to service_role;
alter default privileges in schema reach_accounts revoke all on tables from public, anon, authenticated;
alter default privileges in schema reach_accounts revoke execute on functions from public, anon, authenticated;

create function reach_accounts.fail(p_code text) returns void
language plpgsql security invoker set search_path = '' as $$
begin
  -- The adapter maps these bounded codes to static public messages. Neither SQL
  -- diagnostics nor submitted values are returned to an account-service client.
  raise exception using errcode = 'P0001', message = p_code;
end;
$$;

create function reach_accounts.iso_time(p_milliseconds bigint) returns text
language sql security invoker set search_path = '' as $$
  select pg_catalog.to_char(pg_catalog.to_timestamp(p_milliseconds / 1000.0) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
$$;

create function reach_accounts.snapshot(p_account_id text) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare result jsonb;
begin
  select jsonb_build_object('account', to_jsonb(a), 'reserved',
    (select coalesce(sum(r.amount), 0) from reach_accounts.reservations r
      where r.account_id = a.id and r.status in ('reserved', 'uncertain')))
  into result from reach_accounts.accounts a where a.id = p_account_id;
  if result is null then perform reach_accounts.fail('account_missing'); end if;
  return result;
end;
$$;

-- This is an explicit operation dispatcher, not an arbitrary SQL interface.
-- Each PostgREST RPC executes in one transaction. Balance changes serialize on
-- their account row; reservations always acquire that row before their own.
create function public.reach_account_store(p_operation text, p_payload jsonb) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare
  a reach_accounts.accounts%rowtype;
  f reach_accounts.flows%rowtype;
  c reach_accounts.challenges%rowtype;
  r reach_accounts.reservations%rowtype;
  d reach_accounts.redemptions%rowtype;
  g reach_accounts.grants%rowtype;
  result jsonb := 'null'::jsonb;
  v_now bigint := (p_payload->>'now')::bigint;
  v_account text := p_payload->>'accountId';
  v_expiry bigint;
  v_amount bigint;
  v_included bigint;
  v_prepaid bigint;
  v_actual bigint;
  v_over bigint;
  v_debt_paid bigint;
  v_id text;
  v_snapshot jsonb;
  v_table text;
begin
  if jsonb_typeof(p_payload) is distinct from 'object' or v_now is null or v_now < 0 then
    perform reach_accounts.fail('invalid_operation');
  end if;

  if p_operation = 'import_snapshot' then
    v_snapshot := p_payload->'snapshot';
    if jsonb_typeof(v_snapshot) is distinct from 'object' then perform reach_accounts.fail('invalid_import'); end if;
    if (select count(*) from jsonb_object_keys(v_snapshot)) <> 7
      or not (v_snapshot ?& array['accounts', 'flows', 'challenges', 'sessions', 'grants', 'reservations', 'redemptions']) then
      perform reach_accounts.fail('invalid_import');
    end if;
    foreach v_table in array array['accounts', 'flows', 'challenges', 'sessions', 'grants', 'reservations', 'redemptions'] loop
      if jsonb_typeof(v_snapshot->v_table) is distinct from 'array' then perform reach_accounts.fail('invalid_import'); end if;
      if exists (select 1 from jsonb_array_elements(v_snapshot->v_table) entry where jsonb_typeof(entry) <> 'object') then
        perform reach_accounts.fail('invalid_import');
      end if;
    end loop;
    -- Explicit operator action only. Exclusive locks prevent a simultaneous
    -- sign-in or grant from racing the empty-target check. No rows are replaced.
    lock table reach_accounts.accounts, reach_accounts.flows, reach_accounts.challenges,
      reach_accounts.sessions, reach_accounts.grants, reach_accounts.reservations,
      reach_accounts.redemptions in access exclusive mode;
    if exists (select 1 from reach_accounts.accounts) or exists (select 1 from reach_accounts.flows)
      or exists (select 1 from reach_accounts.challenges) or exists (select 1 from reach_accounts.sessions)
      or exists (select 1 from reach_accounts.grants) or exists (select 1 from reach_accounts.reservations)
      or exists (select 1 from reach_accounts.redemptions) then perform reach_accounts.fail('import_target_not_empty'); end if;
    begin
      insert into reach_accounts.accounts select * from jsonb_populate_recordset(null::reach_accounts.accounts, v_snapshot->'accounts');
      insert into reach_accounts.flows select * from jsonb_populate_recordset(null::reach_accounts.flows, v_snapshot->'flows');
      insert into reach_accounts.challenges select * from jsonb_populate_recordset(null::reach_accounts.challenges, v_snapshot->'challenges');
      insert into reach_accounts.sessions select * from jsonb_populate_recordset(null::reach_accounts.sessions, v_snapshot->'sessions');
      insert into reach_accounts.grants select * from jsonb_populate_recordset(null::reach_accounts.grants, v_snapshot->'grants');
      insert into reach_accounts.reservations select * from jsonb_populate_recordset(null::reach_accounts.reservations, v_snapshot->'reservations');
      insert into reach_accounts.redemptions select * from jsonb_populate_recordset(null::reach_accounts.redemptions, v_snapshot->'redemptions');
    exception when integrity_constraint_violation or data_exception then
      perform reach_accounts.fail('invalid_import');
    end;
    select jsonb_object_agg(key, jsonb_array_length(value)) into result from jsonb_each(v_snapshot);

  elsif p_operation = 'prune_auth' then
    delete from reach_accounts.challenges where expires <= v_now;
    delete from reach_accounts.flows where expires <= v_now;
    delete from reach_accounts.sessions where expires <= v_now;

  elsif p_operation in ('find_account', 'ensure_account') then
    if p_operation = 'ensure_account' then
      insert into reach_accounts.accounts(id, wallet) values (v_account, p_payload->>'wallet')
        on conflict (wallet) do nothing;
    end if;
    select to_jsonb(x) into result from reach_accounts.accounts x where wallet = p_payload->>'wallet';

  elsif p_operation = 'account_by_id' then
    select to_jsonb(x) into result from reach_accounts.accounts x where id = v_account;
    if result is null then perform reach_accounts.fail('account_missing'); end if;

  elsif p_operation = 'account' then
    result := reach_accounts.snapshot(v_account);

  elsif p_operation = 'grant_plan' then
    -- A grant ID is globally unique, including competing grants for different
    -- wallets. Lock it before any account row so replay cannot reset allowance.
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('reach-grant:' || (p_payload->>'grantId'), 0));
    select * into g from reach_accounts.grants where id = p_payload->>'grantId';
    if found then
      if g.payload is distinct from p_payload->>'payload' then perform reach_accounts.fail('grant_conflict'); end if;
      result := reach_accounts.snapshot(g.account_id);
    else
      v_amount := (p_payload->>'tokens')::bigint;
      v_expiry := (p_payload->>'expiresAt')::bigint;
      if v_amount is null or v_amount not between 0 and 1000000000000 or v_expiry <= v_now
        or jsonb_typeof(p_payload->'models') is distinct from 'array' or jsonb_array_length(p_payload->'models') = 0
        or coalesce(p_payload->>'grantId', '') !~ '^[a-zA-Z0-9_-]{8,128}$' then
        perform reach_accounts.fail('invalid_grant');
      end if;
      insert into reach_accounts.accounts(id, wallet) values (v_account, p_payload->>'wallet') on conflict (wallet) do nothing;
      select * into a from reach_accounts.accounts where wallet = p_payload->>'wallet' for update;
      update reach_accounts.accounts set plan_id = p_payload->>'planId', plan_name = p_payload->>'name',
        plan_expires = v_expiry, plan_version = p_payload->>'grantId', models = (p_payload->'models')::text, included = v_amount where id = a.id;
      insert into reach_accounts.grants(id, account_id, payload) values (p_payload->>'grantId', a.id, p_payload->>'payload');
      result := reach_accounts.snapshot(a.id);
    end if;

  elsif p_operation = 'start_flow' then
    v_expiry := v_now + 600000;
    insert into reach_accounts.flows(id, state_hash, challenge, expires)
      values (p_payload->>'flowId', p_payload->>'stateHash', p_payload->>'challenge', v_expiry);
    result := jsonb_build_object('flowId', p_payload->>'flowId', 'expiresAt', reach_accounts.iso_time(v_expiry));

  elsif p_operation in ('get_flow', 'create_challenge', 'get_challenge', 'authorize', 'exchange') then
    if coalesce(p_payload->>'flowId', '') !~ '^[a-f0-9]{64}$' then perform reach_accounts.fail('invalid_flow'); end if;
    -- Challenges and session exchange share this lock. Only one challenge can
    -- authorize the flow and only one exchange can consume its PKCE proof.
    select * into f from reach_accounts.flows where id = p_payload->>'flowId' for update;
    if not found or f.expires <= v_now or f.consumed = 1 then perform reach_accounts.fail('flow_expired'); end if;
    if p_operation = 'get_flow' then
      result := to_jsonb(f);
    elsif p_operation = 'create_challenge' then
      if f.account_id is not null then perform reach_accounts.fail('flow_verified'); end if;
      v_expiry := (p_payload->>'expires')::bigint;
      if v_expiry <= v_now or v_expiry > f.expires or v_expiry > v_now + 300000 then perform reach_accounts.fail('challenge_expired'); end if;
      update reach_accounts.challenges set consumed = 1 where flow_id = f.id;
      insert into reach_accounts.challenges(id, flow_id, wallet, message, expires)
        values (p_payload->>'challengeId', f.id, p_payload->>'wallet', p_payload->>'message', v_expiry);
      result := jsonb_build_object('challengeId', p_payload->>'challengeId', 'message', p_payload->>'message',
        'address', p_payload->>'wallet', 'expiresAt', reach_accounts.iso_time(v_expiry));
    elsif p_operation in ('get_challenge', 'authorize') then
      if coalesce(p_payload->>'challengeId', '') !~ '^[a-f0-9]{64}$' then perform reach_accounts.fail('invalid_challenge'); end if;
      select * into c from reach_accounts.challenges where id = p_payload->>'challengeId' and flow_id = f.id for update;
      if not found or c.consumed = 1 or c.expires <= v_now then perform reach_accounts.fail('challenge_expired'); end if;
      if p_operation = 'get_challenge' then result := to_jsonb(c);
      else
        if f.account_id is not null then perform reach_accounts.fail('flow_verified'); end if;
        insert into reach_accounts.accounts(id, wallet) values (v_account, c.wallet) on conflict (wallet) do nothing;
        select * into a from reach_accounts.accounts where wallet = c.wallet;
        update reach_accounts.challenges set consumed = 1 where id = c.id;
        update reach_accounts.flows set account_id = a.id where id = f.id;
        result := to_jsonb(a.id);
      end if;
    else
      if f.state_hash is distinct from p_payload->>'stateHash' or f.challenge is distinct from p_payload->>'challenge' then
        perform reach_accounts.fail('invalid_proof');
      end if;
      if f.account_id is not null then
        v_expiry := v_now + 3600000;
        update reach_accounts.flows set consumed = 1 where id = f.id;
        insert into reach_accounts.sessions(hash, account_id, expires) values (p_payload->>'sessionHash', f.account_id, v_expiry);
        result := jsonb_build_object('expiresAt', reach_accounts.iso_time(v_expiry), 'snapshot', reach_accounts.snapshot(f.account_id));
      end if;
    end if;

  elsif p_operation = 'authenticate' then
    select account_id into v_account from reach_accounts.sessions where hash = p_payload->>'sessionHash' and expires > v_now;
    if not found then perform reach_accounts.fail('session_expired'); end if;
    result := reach_accounts.snapshot(v_account);
  elsif p_operation = 'logout' then
    delete from reach_accounts.sessions where hash = p_payload->>'sessionHash';

  elsif p_operation = 'reserve' then
    v_amount := (p_payload->>'amount')::bigint;
    if v_amount is null or v_amount not between 1 and 1000000000000
      or p_payload->>'requestId' is null or length(p_payload->>'requestId') > 128 then perform reach_accounts.fail('invalid_reservation'); end if;
    -- Lock before reading the request ID: concurrent identical calls reserve
    -- once, and competing different requests cannot overspend the balance.
    select * into a from reach_accounts.accounts where id = v_account for update;
    if not found then perform reach_accounts.fail('account_missing'); end if;
    select * into r from reach_accounts.reservations where account_id = a.id and request_id = p_payload->>'requestId' for update;
    if found then
      if r.fingerprint is distinct from p_payload->>'fingerprint' or r.model is distinct from p_payload->>'model' then perform reach_accounts.fail('idempotency_conflict'); end if;
      if r.status <> 'released' then
        return jsonb_build_object('result', jsonb_build_object('id', r.id, 'status', r.status, 'replay', r.replay::jsonb, 'fresh', false));
      end if;
    end if;
    if a.plan_expires <= v_now or not (a.models::jsonb ? (p_payload->>'model'))
      or (p_payload->>'modelQualified')::boolean is distinct from true then perform reach_accounts.fail('model_not_entitled'); end if;
    if a.debt > 0 then perform reach_accounts.fail('usage_debt'); end if;
    if a.included + a.prepaid < v_amount then perform reach_accounts.fail('allowance_exhausted'); end if;
    v_id := coalesce(r.id, p_payload->>'reservationId');
    v_included := least(a.included, v_amount); v_prepaid := v_amount - v_included;
    update reach_accounts.accounts set included = included - v_included, prepaid = prepaid - v_prepaid where id = a.id;
    insert into reach_accounts.reservations(id, account_id, request_id, model, fingerprint, amount, held_included, held_prepaid, plan_version, status, created)
      values (v_id, a.id, p_payload->>'requestId', p_payload->>'model', p_payload->>'fingerprint', v_amount, v_included, v_prepaid, a.plan_version, 'reserved', v_now)
      on conflict (id) do update set amount = excluded.amount, held_included = excluded.held_included, held_prepaid = excluded.held_prepaid,
        plan_version = excluded.plan_version, status = 'reserved', created = excluded.created, reason = null, usage = null, replay = null;
    result := jsonb_build_object('id', v_id, 'status', 'reserved', 'replay', null, 'fresh', true);

  elsif p_operation in ('settle', 'release', 'mark_uncertain') then
    select * into r from reach_accounts.reservations where id = p_payload->>'reservationId';
    if not found then
      if p_operation = 'settle' then perform reach_accounts.fail('reservation_missing'); end if;
      return jsonb_build_object('result', null);
    end if;
    select * into a from reach_accounts.accounts where id = r.account_id for update;
    -- Re-read under the account lock; another process may have settled/released
    -- this reservation since the lookup that found its immutable account ID.
    select * into r from reach_accounts.reservations where id = r.id for update;
    if p_operation = 'mark_uncertain' then
      update reach_accounts.reservations set status = 'uncertain', reason = left(p_payload->>'reason', 200) where id = r.id and status = 'reserved';
    elsif p_operation = 'release' then
      if r.status = 'released' then return jsonb_build_object('result', null); end if;
      if r.status <> 'reserved' then perform reach_accounts.fail('reservation_closed'); end if;
      update reach_accounts.accounts set included = included + case when a.plan_version is not distinct from r.plan_version and a.plan_expires > v_now then r.held_included else 0 end,
        prepaid = prepaid + r.held_prepaid where id = a.id;
      update reach_accounts.reservations set status = 'released', reason = p_payload->>'reason' where id = r.id;
    else
      v_actual := (p_payload->'usage'->>'totalTokens')::bigint;
      if v_actual is null or v_actual not between 0 and 1000000000000
        or p_payload->'usage'->>'promptTokens' is null
        or p_payload->'usage'->>'completionTokens' is null
        or (p_payload->'usage'->>'promptTokens')::bigint not between 0 and 1000000000000
        or (p_payload->'usage'->>'completionTokens')::bigint not between 0 and 1000000000000
        or v_actual <> (p_payload->'usage'->>'promptTokens')::bigint + (p_payload->'usage'->>'completionTokens')::bigint then perform reach_accounts.fail('invalid_usage'); end if;
      if r.status = 'settled' then return jsonb_build_object('result', null); end if;
      if r.status not in ('reserved', 'uncertain') then perform reach_accounts.fail('reservation_closed'); end if;
      v_included := a.included; v_prepaid := a.prepaid; v_over := 0;
      if v_actual <= r.amount then
        if a.plan_version is not distinct from r.plan_version and a.plan_expires > v_now then v_included := v_included + r.held_included - least(v_actual, r.held_included); end if;
        v_prepaid := v_prepaid + r.held_prepaid - greatest(0, v_actual - r.held_included);
      else
        v_over := v_actual - r.amount;
        v_amount := case when a.plan_expires > v_now then least(v_over, v_included) else 0 end;
        v_included := v_included - v_amount; v_over := v_over - v_amount;
        v_amount := least(v_over, v_prepaid); v_prepaid := v_prepaid - v_amount; v_over := v_over - v_amount;
      end if;
      update reach_accounts.accounts set included = v_included, prepaid = v_prepaid, debt = debt + v_over where id = a.id;
      update reach_accounts.reservations set status = 'settled', usage = (p_payload->'usage')::text,
        replay = case when octet_length(p_payload->>'replay') <= 1048576 then p_payload->>'replay' else null end, reason = null where id = r.id;
    end if;

  elsif p_operation = 'unsettled_reservations' then
    select coalesce(jsonb_agg(jsonb_build_object('id', x.id, 'account_id', x.account_id,
      'request_id', x.request_id, 'model', x.model, 'amount', x.amount, 'status', x.status,
      'created', x.created, 'reason', x.reason) order by x.created, x.id), '[]'::jsonb) into result
      from reach_accounts.reservations x where status in ('reserved', 'uncertain') and (v_account is null or account_id = v_account);

  elsif p_operation = 'create_redemption' then
    v_amount := (p_payload->>'usageTokens')::bigint;
    if v_amount is null or v_amount not between 1 and 1000000000000 then perform reach_accounts.fail('invalid_redemption'); end if;
    select * into a from reach_accounts.accounts where id = v_account for update;
    if not found then perform reach_accounts.fail('account_missing'); end if;
    if a.plan_expires <= v_now then perform reach_accounts.fail('plan_required'); end if;
    v_expiry := v_now + 900000;
    insert into reach_accounts.redemptions(id, account_id, wallet, amount, usage_tokens, ticket_hash, expires, created)
      values (p_payload->>'redemptionId', a.id, a.wallet, p_payload->>'amount', v_amount, p_payload->>'ticketHash', v_expiry, v_now);
    result := jsonb_build_object('redemptionId', p_payload->>'redemptionId', 'expiresAt', reach_accounts.iso_time(v_expiry));

  elsif p_operation in ('get_redemption', 'submit_redemption', 'replace_redemption') then
    select * into d from reach_accounts.redemptions where id = p_payload->>'redemptionId' for update;
    if not found or d.ticket_hash is distinct from p_payload->>'ticketHash' then perform reach_accounts.fail('redemption_missing'); end if;
    if p_operation = 'submit_redemption' then
      if coalesce(p_payload->>'txHash', '') !~ '^0x[a-f0-9]{64}$' then perform reach_accounts.fail('invalid_transaction'); end if;
      if d.tx_hash is not null and d.tx_hash <> p_payload->>'txHash' then perform reach_accounts.fail('transaction_conflict'); end if;
      update reach_accounts.redemptions set tx_hash = p_payload->>'txHash', status = case when status = 'credited' then status else 'pending' end where id = d.id returning * into d;
    elsif p_operation = 'replace_redemption' then
      if coalesce(p_payload->>'nextTxHash', '') !~ '^0x[a-f0-9]{64}$' then perform reach_accounts.fail('invalid_transaction'); end if;
      if d.status <> 'pending' or d.tx_hash is distinct from p_payload->>'previousTxHash' then perform reach_accounts.fail('transaction_conflict'); end if;
      update reach_accounts.redemptions set tx_hash = p_payload->>'nextTxHash' where id = d.id returning * into d;
    end if;
    result := to_jsonb(d);

  elsif p_operation = 'pending_redemptions' then
    select coalesce(jsonb_agg(to_jsonb(x) order by x.created, x.id), '[]'::jsonb) into result
      from reach_accounts.redemptions x where status = 'pending' and tx_hash is not null and (v_account is null or account_id = v_account);

  elsif p_operation = 'credit_redemption' then
    if coalesce(p_payload->>'eventKey', '') = '' then perform reach_accounts.fail('redemption_not_pending'); end if;
    -- Serialize the chain event globally before acquiring the account row. A
    -- unique constraint is a second barrier against cross-account double credit.
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('reach-event:' || (p_payload->>'eventKey'), 0));
    select * into d from reach_accounts.redemptions where id = p_payload->>'redemptionId';
    if not found then perform reach_accounts.fail('redemption_missing'); end if;
    select * into a from reach_accounts.accounts where id = d.account_id for update;
    select * into d from reach_accounts.redemptions where id = d.id for update;
    if d.status = 'credited' then
      if d.event_key is distinct from p_payload->>'eventKey' then perform reach_accounts.fail('event_conflict'); end if;
      return jsonb_build_object('result', null);
    end if;
    if d.status <> 'pending' or d.tx_hash is null then perform reach_accounts.fail('redemption_not_pending'); end if;
    if exists (select 1 from reach_accounts.redemptions where event_key = p_payload->>'eventKey') then perform reach_accounts.fail('event_conflict'); end if;
    v_debt_paid := least(a.debt, d.usage_tokens);
    v_amount := d.usage_tokens - v_debt_paid;
    if a.prepaid + v_amount > 1000000000000 then perform reach_accounts.fail('credit_limit'); end if;
    update reach_accounts.accounts set prepaid = prepaid + v_amount, debt = debt - v_debt_paid where id = a.id;
    update reach_accounts.redemptions set status = 'credited', event_key = p_payload->>'eventKey' where id = d.id;
  else
    perform reach_accounts.fail('invalid_operation');
  end if;
  return jsonb_build_object('result', result);
end;
$$;

revoke execute on all functions in schema reach_accounts from public, anon, authenticated;
grant execute on all functions in schema reach_accounts to service_role;
revoke execute on function public.reach_account_store(text, jsonb) from public, anon, authenticated;
grant execute on function public.reach_account_store(text, jsonb) to service_role;
comment on function public.reach_account_store(text, jsonb) is 'Server-only REACH account operations. Requires service_role; never expose its credential to clients.';
notify pgrst, 'reload schema';
