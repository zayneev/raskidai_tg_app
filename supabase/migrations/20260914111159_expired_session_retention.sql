create extension if not exists pg_cron;

create function public.cleanup_expired_app_sessions(p_batch_size integer default 500)
returns bigint language plpgsql security invoker set search_path = '' as $$
declare
  deleted_count bigint;
begin
  if p_batch_size not between 1 and 1000 then
    raise exception 'batch size must be between 1 and 1000' using errcode='22023';
  end if;
  with doomed as (
    select token_hash from public.app_sessions
    where expires_at < clock_timestamp() - interval '7 days'
    order by expires_at, token_hash
    limit p_batch_size
    for update skip locked
  )
  delete from public.app_sessions s using doomed d
  where s.token_hash=d.token_hash;
  get diagnostics deleted_count = row_count;
  return deleted_count;
end;
$$;

revoke all on function public.cleanup_expired_app_sessions(integer)
  from public, anon, authenticated, service_role;
grant execute on function public.cleanup_expired_app_sessions(integer) to postgres;

select cron.schedule(
  'raskidai-expired-sessions-daily',
  '17 3 * * *',
  $$select public.cleanup_expired_app_sessions(500);$$
);
