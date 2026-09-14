select 'users' as table_name, count(*)::bigint as row_count from public.users
union all select 'app_sessions', count(*) from public.app_sessions
union all select 'events', count(*) from public.events
union all select 'members', count(*) from public.members
union all select 'invitations', count(*) from public.invitations
union all select 'expenses', count(*) from public.expenses
union all select 'expense_shares', count(*) from public.expense_shares
union all select 'expense_requests', count(*) from public.expense_requests
union all select 'audit_log', count(*) from public.audit_log
union all select 'settlements', count(*) from public.settlements
union all select 'settlement_balances', count(*) from public.settlement_balances
union all select 'settlement_expenses', count(*) from public.settlement_expenses
union all select 'settlement_shares', count(*) from public.settlement_shares
union all select 'transfers', count(*) from public.transfers
union all select 'settlement_requests', count(*) from public.settlement_requests
union all select 'settlement_audit_log', count(*) from public.settlement_audit_log
union all select 'transfer_requests', count(*) from public.transfer_requests
union all select 'transfer_status_history', count(*) from public.transfer_status_history
union all select 'event_requests', count(*) from public.event_requests
order by table_name;
