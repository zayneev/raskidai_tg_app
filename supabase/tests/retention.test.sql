begin;
create extension if not exists pgtap with schema extensions;
select plan(1);

do $$
declare
  uid uuid := gen_random_uuid();
  old_hash text := repeat('7',64);
  recent_hash text := repeat('8',64);
  active_hash text := repeat('9',64);
  deleted_count bigint;
begin
  if has_function_privilege('public','public.cleanup_expired_app_sessions(integer)','EXECUTE')
    or has_function_privilege('anon','public.cleanup_expired_app_sessions(integer)','EXECUTE')
    or has_function_privilege('authenticated','public.cleanup_expired_app_sessions(integer)','EXECUTE')
    or has_function_privilege('service_role','public.cleanup_expired_app_sessions(integer)','EXECUTE') then
    raise exception 'cleanup function exposed';
  end if;
  if (select p.prosecdef from pg_proc p
    where p.oid='public.cleanup_expired_app_sessions(integer)'::regprocedure) then
    raise exception 'cleanup must remain SECURITY INVOKER';
  end if;
  insert into public.users(id,telegram_id,display_name)
    values(uid,8999999999999999,'Retention fixture');
  insert into public.app_sessions(token_hash,user_id,expires_at) values
    (old_hash,uid,clock_timestamp()-interval '8 days'),
    (recent_hash,uid,clock_timestamp()-interval '6 days'),
    (active_hash,uid,clock_timestamp()+interval '1 day');
  deleted_count:=public.cleanup_expired_app_sessions(1);
  if deleted_count<>1 or exists(select 1 from public.app_sessions where token_hash=old_hash)
    or not exists(select 1 from public.app_sessions where token_hash=recent_hash)
    or not exists(select 1 from public.app_sessions where token_hash=active_hash) then
    raise exception 'cleanup retention or batch invariant failed';
  end if;
  begin
    perform public.cleanup_expired_app_sessions(0);
    raise exception 'invalid batch accepted';
  exception when invalid_parameter_value then null;
  end;
  if not exists(select 1 from cron.job where jobname='raskidai-expired-sessions-daily'
    and active and command='select public.cleanup_expired_app_sessions(500);') then
    raise exception 'daily cleanup schedule missing';
  end if;
end $$;

select pass('retention: bounded cleanup keeps active/recent sessions and is not client-callable');
select * from finish();
rollback;
