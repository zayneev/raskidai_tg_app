\set ON_ERROR_STOP on

do $$
declare
  expected_tables constant text[] := array[
    'users','app_sessions','events','members','invitations','expenses',
    'expense_shares','expense_requests','audit_log','settlements',
    'settlement_balances','settlement_expenses','settlement_shares','transfers',
    'settlement_requests','settlement_audit_log','transfer_requests',
    'transfer_status_history','event_requests'
  ];
  table_name text;
begin
  foreach table_name in array expected_tables loop
    if to_regclass('public.' || table_name) is null then
      raise exception 'missing application table: %', table_name;
    end if;
    if not (select relrowsecurity from pg_class where oid = ('public.' || table_name)::regclass) then
      raise exception 'RLS disabled: %', table_name;
    end if;
    if has_table_privilege('anon', 'public.' || table_name, 'SELECT,INSERT,UPDATE,DELETE')
      or has_table_privilege('authenticated', 'public.' || table_name, 'SELECT,INSERT,UPDATE,DELETE') then
      raise exception 'client table privilege: %', table_name;
    end if;
  end loop;
  if exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname in (
      'create_telegram_session','get_app_session','revoke_app_session',
      'event_action','expense_action','settlement_action','transfer_action',
      'event_history_action','expense_snapshot','settlement_result'
    ) and p.prosecdef
  ) then raise exception 'SECURITY DEFINER application function found'; end if;
  if exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname in (
      'create_telegram_session','get_app_session','revoke_app_session',
      'event_action','expense_action','settlement_action','transfer_action',
      'event_history_action','expense_snapshot','settlement_result'
    ) and has_function_privilege('public', p.oid, 'EXECUTE')
  ) then raise exception 'PUBLIC can execute application RPC'; end if;
end $$;

do $$
begin
  if exists (
    select 1 from public.expenses e
    left join public.events v on v.id=e.event_id where v.id is null
  ) or exists (
    select 1 from public.expense_shares s
    left join public.expenses e on e.id=s.expense_id and e.event_id=s.event_id
    where e.id is null
  ) or exists (
    select 1 from public.transfers t
    left join public.settlements s on s.id=t.settlement_id where s.id is null
  ) then raise exception 'referential integrity violation'; end if;
  if exists (
    select 1 from public.expenses e
    left join lateral (
      select count(*) n, coalesce(sum(amount_kopecks),0)::bigint total
      from public.expense_shares where expense_id=e.id
    ) s on true where s.n=0 or s.total<>e.amount_kopecks
  ) then raise exception 'expense share invariant violation'; end if;
  if exists (
    select 1 from public.settlements s
    join lateral (
      select coalesce(sum(balance_kopecks),0)::bigint total
      from public.settlement_balances where settlement_id=s.id
    ) b on true where b.total<>0
  ) then raise exception 'settlement balance sum violation'; end if;
  if exists (
    select 1 from public.transfers t
    join public.settlement_balances sender
      on sender.settlement_id=t.settlement_id and sender.user_id=t.sender_id
    join public.settlement_balances receiver
      on receiver.settlement_id=t.settlement_id and receiver.user_id=t.receiver_id
    where t.amount_kopecks<=0 or t.sender_id=t.receiver_id
      or sender.balance_kopecks>=0 or receiver.balance_kopecks<=0
  ) then raise exception 'transfer direction or amount violation'; end if;
  if exists (
    select 1 from public.settlement_balances b
    where b.balance_kopecks
      + coalesce((select sum(t.amount_kopecks) from public.transfers t
        where t.settlement_id=b.settlement_id and t.sender_id=b.user_id),0)
      - coalesce((select sum(t.amount_kopecks) from public.transfers t
        where t.settlement_id=b.settlement_id and t.receiver_id=b.user_id),0) <> 0
  ) then raise exception 'settlement does not close after transfers'; end if;
end $$;

select extname, extversion from pg_extension order by extname;
select * from public.get_app_session(repeat('0',64));
\i scripts/backup-counts.sql
