-- Wallet and email sign-in can fill the two identity columns of one account.
-- A second proof attaches only when that column is empty. Two existing
-- accounts are never merged.
create or replace function reach_accounts.legacy_account_store(p_operation text, p_payload jsonb) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare
  a reach_accounts.accounts%rowtype;
  f reach_accounts.flows%rowtype;
  c reach_accounts.email_challenges%rowtype;
  wc reach_accounts.challenges%rowtype;
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

  elsif p_operation = 'bind_flow_account' then
    if coalesce(p_payload->>'flowId', '') !~ '^[a-f0-9]{64}$' or coalesce(p_payload->>'accountId', '') !~ '^[A-Za-z0-9_-]{8,128}$' then
      perform reach_accounts.fail('invalid_flow');
    end if;
    select * into f from reach_accounts.flows where id = p_payload->>'flowId' for update;
    if not found or f.expires <= v_now or f.consumed = 1 then perform reach_accounts.fail('flow_expired'); end if;
    if f.account_id is not null then perform reach_accounts.fail('flow_verified'); end if;
    select * into a from reach_accounts.accounts where id = p_payload->>'accountId';
    if not found then perform reach_accounts.fail('account_missing'); end if;
    update reach_accounts.flows set account_id = a.id where id = f.id;
    return jsonb_build_object('result', true);

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
    if f.account_id is not null then
      select * into a from reach_accounts.accounts where id = f.account_id for update;
      if a.email is not null then perform reach_accounts.fail('flow_verified'); end if;
    end if;

    if p_operation = 'create_email_challenge' then
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
      update reach_accounts.email_challenges set attempts = c.attempts + 1,
        consumed = case when c.attempts + 1 >= 5 then 1 else 0 end where id = c.id;
      return jsonb_build_object('result', jsonb_build_object('remaining', 5 - (c.attempts + 1)));
    end if;
    if f.account_id is not null then
      if exists (select 1 from reach_accounts.accounts where email = c.email and id <> f.account_id) then
        perform reach_accounts.fail('identity_taken');
      end if;
      update reach_accounts.accounts set email = c.email where id = f.account_id and (email is null or email = c.email);
      if not found then perform reach_accounts.fail('identity_taken'); end if;
      a.id := f.account_id;
    else
      insert into reach_accounts.accounts(id, email) values (p_payload->>'accountId', c.email) on conflict (email) do nothing;
      select * into a from reach_accounts.accounts where email = c.email;
    end if;
    update reach_accounts.email_challenges set consumed = 1 where id = c.id;
    update reach_accounts.flows set account_id = a.id where id = f.id;
    return jsonb_build_object('result', jsonb_build_object('accountId', a.id));

  elsif p_operation = 'prune_auth' then
    delete from reach_accounts.email_challenges where created <= v_now - 3600000;

  elsif p_operation in ('create_challenge', 'authorize')
    and coalesce(p_payload->>'flowId', '') ~ '^[a-f0-9]{64}$' then
    select * into f from reach_accounts.flows where id = p_payload->>'flowId' for update;
    if found and f.account_id is not null and f.consumed = 0 and f.expires > v_now then
      select * into a from reach_accounts.accounts where id = f.account_id for update;
      if a.wallet is null then
        if p_operation = 'create_challenge' then
          v_expiry := (p_payload->>'expires')::bigint;
          if v_expiry <= v_now or v_expiry > f.expires or v_expiry > v_now + 300000 then perform reach_accounts.fail('challenge_expired'); end if;
          update reach_accounts.challenges set consumed = 1 where flow_id = f.id;
          insert into reach_accounts.challenges(id, flow_id, wallet, message, expires)
            values (p_payload->>'challengeId', f.id, p_payload->>'wallet', p_payload->>'message', v_expiry);
          return jsonb_build_object('result', jsonb_build_object('challengeId', p_payload->>'challengeId', 'message', p_payload->>'message',
            'address', p_payload->>'wallet', 'expiresAt', reach_accounts.iso_time(v_expiry)));
        end if;
        if coalesce(p_payload->>'challengeId', '') !~ '^[a-f0-9]{64}$' then perform reach_accounts.fail('invalid_challenge'); end if;
        select * into wc from reach_accounts.challenges where id = p_payload->>'challengeId' and flow_id = f.id for update;
        if not found or wc.consumed = 1 or wc.expires <= v_now then perform reach_accounts.fail('challenge_expired'); end if;
        if exists (select 1 from reach_accounts.accounts where wallet = wc.wallet and id <> a.id) then
          perform reach_accounts.fail('identity_taken');
        end if;
        update reach_accounts.accounts set wallet = wc.wallet where id = a.id;
        update reach_accounts.challenges set consumed = 1 where id = wc.id;
        return jsonb_build_object('result', to_jsonb(a.id));
      end if;
    end if;
  end if;

  return reach_accounts.wallet_account_store(p_operation, p_payload);
end;
$$;
