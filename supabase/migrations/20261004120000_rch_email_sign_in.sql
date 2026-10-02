-- Email sign-in. An account is reached by a wallet, an email address, or both;
-- every other table already refers to the internal account ID.
--
-- Existing rows are untouched: the wallet column only stops being mandatory.
-- New operations live in a wrapper in front of the existing account function,
-- in the same style as earlier migrations, and every other operation is
-- delegated unchanged. Rules mirror RCH/service/store.mjs and the shared
-- email suite runs the same cases against both stores.
alter table reach_accounts.accounts alter column wallet drop not null;
alter table reach_accounts.accounts add column email text unique
  check (email is null or (length(email) <= 254 and email = lower(email) and email ~ '^[^[:space:]@]{1,64}@[a-z0-9.-]+\.[a-z]{2,63}$'));
alter table reach_accounts.accounts add constraint account_identity check (wallet is not null or email is not null);

-- No foreign key to flows: a challenge outlives its ten-minute flow so the
-- hourly per-address limits can count it.
create table reach_accounts.email_challenges (
  id text primary key check (id ~ '^[a-f0-9]{64}$'),
  flow_id text not null check (flow_id ~ '^[a-f0-9]{64}$'),
  email text not null,
  code_hash text not null check (code_hash ~ '^[a-f0-9]{64}$'),
  attempts integer not null default 0 check (attempts between 0 and 5),
  expires bigint not null,
  consumed integer not null default 0 check (consumed in (0, 1)),
  created bigint not null check (created >= 0)
);
create index email_challenge_email on reach_accounts.email_challenges(email, created);
create index email_challenge_created on reach_accounts.email_challenges(created);
create index email_challenge_flow on reach_accounts.email_challenges(flow_id);
alter table reach_accounts.email_challenges enable row level security;
revoke all on reach_accounts.email_challenges from public, anon, authenticated;
grant select, insert, update, delete on reach_accounts.email_challenges to service_role;

-- Both the public dispatcher and the payment ledger call legacy_account_store
-- by name, so the wrapper takes that name and the previous body moves aside.
alter function reach_accounts.legacy_account_store(text, jsonb) rename to wallet_account_store;
create function reach_accounts.legacy_account_store(p_operation text, p_payload jsonb) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare
  a reach_accounts.accounts%rowtype;
  f reach_accounts.flows%rowtype;
  c reach_accounts.email_challenges%rowtype;
  g reach_accounts.grants%rowtype;
  v_now bigint := (p_payload->>'now')::bigint;
  v_email text := p_payload->>'email';
  v_count integer;
  v_last bigint;
  v_expiry bigint;
  v_amount bigint;
  result jsonb := 'null'::jsonb;
begin
  if jsonb_typeof(p_payload) is distinct from 'object' or v_now is null or v_now < 0 then
    perform reach_accounts.fail('invalid_operation');
  end if;

  if p_operation = 'grant_plan' and p_payload->>'wallet' is null and p_payload ? 'accountId' then
    -- A grant for an email-only account names the account. Same rules as the
    -- wallet grant: one grant ID, one payload, locked before the account row.
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('reach-grant:' || (p_payload->>'grantId'), 0));
    select * into g from reach_accounts.grants where id = p_payload->>'grantId';
    if found then
      if g.payload is distinct from p_payload->>'payload' then perform reach_accounts.fail('grant_conflict'); end if;
      return jsonb_build_object('result', reach_accounts.snapshot(g.account_id));
    end if;
    v_amount := (p_payload->>'tokens')::bigint;
    v_expiry := (p_payload->>'expiresAt')::bigint;
    if v_amount is null or v_amount not between 0 and 1000000000000 or v_expiry <= v_now
      or jsonb_typeof(p_payload->'models') is distinct from 'array' or jsonb_array_length(p_payload->'models') = 0
      or coalesce(p_payload->>'grantId', '') !~ '^[a-zA-Z0-9_-]{8,128}$' then
      perform reach_accounts.fail('invalid_grant');
    end if;
    select * into a from reach_accounts.accounts where id = p_payload->>'accountId' for update;
    if not found then perform reach_accounts.fail('account_missing'); end if;
    update reach_accounts.accounts set plan_id = p_payload->>'planId', plan_name = p_payload->>'name',
      plan_expires = v_expiry, plan_version = p_payload->>'grantId', models = (p_payload->'models')::text, included = v_amount where id = a.id;
    insert into reach_accounts.grants(id, account_id, payload) values (p_payload->>'grantId', a.id, p_payload->>'payload');
    return jsonb_build_object('result', reach_accounts.snapshot(a.id));

  elsif p_operation in ('find_email_account', 'ensure_email_account') then
    if p_operation = 'ensure_email_account' then
      insert into reach_accounts.accounts(id, email) values (p_payload->>'accountId', v_email) on conflict (email) do nothing;
    end if;
    select to_jsonb(x) into result from reach_accounts.accounts x where email = v_email;
    return jsonb_build_object('result', result);

  elsif p_operation in ('create_email_challenge', 'verify_email_challenge') then
    if coalesce(p_payload->>'flowId', '') !~ '^[a-f0-9]{64}$' then perform reach_accounts.fail('invalid_flow'); end if;
    if coalesce(p_payload->>'challengeId', '') !~ '^[a-f0-9]{64}$' or coalesce(p_payload->>'codeHash', '') !~ '^[a-f0-9]{64}$' then
      perform reach_accounts.fail('invalid_challenge');
    end if;
    select * into f from reach_accounts.flows where id = p_payload->>'flowId' for update;
    if not found or f.expires <= v_now or f.consumed = 1 then perform reach_accounts.fail('flow_expired'); end if;
    if f.account_id is not null then perform reach_accounts.fail('flow_verified'); end if;

    if p_operation = 'create_email_challenge' then
      -- One lock per address and one for the service-wide count, so concurrent
      -- requests cannot both slip under a limit.
      perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('reach-email:' || v_email, 0));
      perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('reach-email-service', 0));
      select count(*), max(created) into v_count, v_last from reach_accounts.email_challenges
        where email = v_email and created > v_now - 3600000;
      if v_last is not null and v_now - v_last < 60000 then perform reach_accounts.fail('email_cooldown'); end if;
      if v_count >= 5 then perform reach_accounts.fail('email_rate_limit'); end if;
      if (select count(*) from reach_accounts.email_challenges where created > v_now - 3600000) >= 500 then
        perform reach_accounts.fail('email_busy');
      end if;
      v_expiry := least(f.expires, v_now + 600000);
      update reach_accounts.email_challenges set consumed = 1 where flow_id = f.id;
      insert into reach_accounts.email_challenges(id, flow_id, email, code_hash, expires, created)
        values (p_payload->>'challengeId', f.id, v_email, p_payload->>'codeHash', v_expiry, v_now);
      return jsonb_build_object('result', jsonb_build_object('challengeId', p_payload->>'challengeId',
        'expiresAt', reach_accounts.iso_time(v_expiry)));
    end if;

    select * into c from reach_accounts.email_challenges where id = p_payload->>'challengeId' and flow_id = f.id for update;
    if not found or c.consumed = 1 or c.expires <= v_now then
      return jsonb_build_object('result', jsonb_build_object('expired', true));
    end if;
    if c.code_hash is distinct from p_payload->>'codeHash' then
      -- Returned, not raised: raising would roll back the attempt count.
      update reach_accounts.email_challenges set attempts = c.attempts + 1,
        consumed = case when c.attempts + 1 >= 5 then 1 else 0 end where id = c.id;
      return jsonb_build_object('result', jsonb_build_object('remaining', 5 - (c.attempts + 1)));
    end if;
    insert into reach_accounts.accounts(id, email) values (p_payload->>'accountId', c.email) on conflict (email) do nothing;
    select * into a from reach_accounts.accounts where email = c.email;
    update reach_accounts.email_challenges set consumed = 1 where id = c.id;
    update reach_accounts.flows set account_id = a.id where id = f.id;
    return jsonb_build_object('result', jsonb_build_object('accountId', a.id));

  elsif p_operation = 'prune_auth' then
    delete from reach_accounts.email_challenges where created <= v_now - 3600000;
  end if;

  return reach_accounts.wallet_account_store(p_operation, p_payload);
end;
$$;
revoke execute on function reach_accounts.wallet_account_store(text, jsonb) from public, anon, authenticated;
grant execute on function reach_accounts.wallet_account_store(text, jsonb) to service_role;
revoke execute on function reach_accounts.legacy_account_store(text, jsonb) from public, anon, authenticated;
grant execute on function reach_accounts.legacy_account_store(text, jsonb) to service_role;
notify pgrst, 'reload schema';
