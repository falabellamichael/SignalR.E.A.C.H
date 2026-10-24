-- Review signals only: no blocking by IP, VPN classification, plan changes or
-- trial resets. Device IDs are browser-installation hints, not hardware identity.
create table reach_accounts.signup_signal_key (
  singleton boolean primary key default true check(singleton),
  salt text not null default (gen_random_uuid()::text || gen_random_uuid()::text)
);
insert into reach_accounts.signup_signal_key(singleton) values(true);
create table reach_accounts.signup_signals (
  account_id text primary key references reach_accounts.accounts(id) on delete cascade,
  email_hash text not null, ip_hash text, device_hash text,
  recorded_at timestamptz not null default now(),
  flags text[] not null default '{}'
);
create index on reach_accounts.signup_signals(ip_hash);
create index on reach_accounts.signup_signals(device_hash);
alter table reach_accounts.signup_signal_key enable row level security;
alter table reach_accounts.signup_signals enable row level security;
revoke all on reach_accounts.signup_signal_key, reach_accounts.signup_signals from public, anon, authenticated;

create function public.reach_record_signup_signals(p_operation text, p_payload jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare
  a reach_accounts.accounts%rowtype; salt text; e text; i text; d text;
  flags text[] := '{}';
begin
  if p_operation <> 'record' then perform reach_accounts.fail('invalid_operation'); end if;
  -- Serialize matching and insertion so simultaneous signups cannot miss each other.
  perform pg_catalog.pg_advisory_xact_lock(23130000);
  select * into a from reach_accounts.accounts where id=p_payload->>'accountId';
  if not found then perform reach_accounts.fail('account_missing'); end if;
  if a.email is null then return jsonb_build_object('result',jsonb_build_object('recorded',false)); end if;
  if exists(select 1 from reach_accounts.signup_signals where account_id=a.id) then
    return jsonb_build_object('result',jsonb_build_object('recorded',false));
  end if;
  select k.salt into salt from reach_accounts.signup_signal_key k where singleton;
  e:=encode(sha256(convert_to(salt||':email:'||lower(trim(a.email)),'UTF8')),'hex');
  if length(p_payload->>'ip') between 2 and 45 then
    i:=encode(sha256(convert_to(salt||':ip:'||host((p_payload->>'ip')::inet),'UTF8')),'hex');
  end if;
  if coalesce(p_payload->>'deviceId','') ~ '^[a-f0-9]{32,64}$' then
    d:=encode(sha256(convert_to(salt||':device:'||(p_payload->>'deviceId'),'UTF8')),'hex');
  end if;
  -- Same verified email is the primary identity and is not a duplicate trial signal.
  if not exists(select 1 from reach_accounts.signup_signals where email_hash=e) then
    if i is not null and exists(select 1 from reach_accounts.signup_signals where ip_hash=i and email_hash<>e) then
      flags:=array_append(flags,'different_email_same_ip');
    end if;
    if d is not null and exists(select 1 from reach_accounts.signup_signals where device_hash=d and email_hash<>e) then
      flags:=array_append(flags,'different_email_same_device');
    end if;
  end if;
  insert into reach_accounts.signup_signals(account_id,email_hash,ip_hash,device_hash,flags) values(a.id,e,i,d,flags);
  return jsonb_build_object('result',jsonb_build_object('recorded',true));
end;
$$;
revoke execute on function public.reach_record_signup_signals(text,jsonb) from public,anon,authenticated;
grant execute on function public.reach_record_signup_signals(text,jsonb) to service_role;
notify pgrst,'reload schema';
