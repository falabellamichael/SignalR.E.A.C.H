-- Only the server service role may manage or resolve hashed user API keys.
create table reach_accounts.api_keys (
  id text primary key check (id ~ '^[a-f0-9]{64}$'),
  account_id text not null references reach_accounts.accounts(id),
  name text not null check (length(btrim(name)) between 1 and 64 and name !~ '[[:cntrl:]]'),
  prefix text not null check (prefix ~ '^rch_key_[a-f0-9]{8}$'),
  hash text not null unique check (hash ~ '^[a-f0-9]{64}$'),
  created bigint not null check (created >= 0),
  expires bigint not null check (expires > created),
  revoked bigint
);
create index api_keys_account on reach_accounts.api_keys(account_id,created);
alter table reach_accounts.api_keys enable row level security;
revoke all on reach_accounts.api_keys from public, anon, authenticated;
grant select,insert,update on reach_accounts.api_keys to service_role;

create function public.reach_api_key_store(p_operation text,p_payload jsonb) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare
  v_now bigint := (p_payload->>'now')::bigint;
  v_account text := p_payload->>'accountId';
  k reach_accounts.api_keys%rowtype;
  result jsonb;
begin
  if v_now is null or v_now < 0 then perform reach_accounts.fail('invalid_operation'); end if;
  if p_operation = 'authenticate' then
    select * into k from reach_accounts.api_keys
      where hash = p_payload->>'hash' and revoked is null and expires > v_now;
    if not found then perform reach_accounts.fail('api_key_invalid'); end if;
    return jsonb_build_object('result',k.account_id);
  end if;
  -- Serialize creation against the same account so concurrent calls cannot exceed ten.
  perform 1 from reach_accounts.accounts where id = v_account for update;
  if not found then perform reach_accounts.fail('account_missing'); end if;
  if p_operation = 'list' then
    select coalesce(jsonb_agg(to_jsonb(t) order by t.created desc,t.id),'[]'::jsonb) into result
      from (select id,name,prefix,created,expires,revoked from reach_accounts.api_keys where account_id = v_account) t;
    return jsonb_build_object('result',result);
  elsif p_operation = 'create' then
    if (select count(*) from reach_accounts.api_keys where account_id = v_account and revoked is null and expires > v_now) >= 10 then
      perform reach_accounts.fail('api_key_limit');
    end if;
    insert into reach_accounts.api_keys(id,account_id,name,prefix,hash,created,expires)
      values(p_payload->>'id',v_account,p_payload->>'name',p_payload->>'prefix',p_payload->>'hash',v_now,v_now+7776000000)
      returning * into k;
  elsif p_operation = 'revoke' then
    update reach_accounts.api_keys set revoked = coalesce(revoked,v_now)
      where id = p_payload->>'id' and account_id = v_account returning * into k;
    if not found then perform reach_accounts.fail('api_key_missing'); end if;
  else
    perform reach_accounts.fail('invalid_operation');
  end if;
  return jsonb_build_object('result',jsonb_build_object('id',k.id,'name',k.name,'prefix',k.prefix,
    'created',k.created,'expires',k.expires,'revoked',k.revoked));
end;
$$;
revoke execute on function public.reach_api_key_store(text,jsonb) from public,anon,authenticated;
grant execute on function public.reach_api_key_store(text,jsonb) to service_role;
notify pgrst, 'reload schema';
