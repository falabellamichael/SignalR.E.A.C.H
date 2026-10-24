-- Read-only, paginated metadata for the host operator. Never return key hashes.
create function public.reach_operator_key_store(p_operation text,p_payload jsonb) returns jsonb
language plpgsql stable security invoker set search_path = '' as $$
declare
  v_offset integer := coalesce((p_payload->>'offset')::integer,0);
  v_result jsonb;
begin
  if p_operation <> 'list' or p_operation is null or v_offset < 0 or v_offset > 1000000 then
    raise exception 'invalid_operation';
  end if;
  select coalesce(jsonb_agg(to_jsonb(k) order by k.created desc,k.id),'[]'::jsonb) into v_result
  from (select id,account_id,name,prefix,created,expires,revoked
        from reach_accounts.api_keys order by created desc,id limit 101 offset v_offset) k;
  return jsonb_build_object('result',v_result);
end;
$$;
revoke execute on function public.reach_operator_key_store(text,jsonb) from public,anon,authenticated;
grant execute on function public.reach_operator_key_store(text,jsonb) to service_role;
notify pgrst, 'reload schema';
