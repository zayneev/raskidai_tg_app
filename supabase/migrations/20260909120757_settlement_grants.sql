-- The project grants service_role broad defaults on new tables. Reduce them to
-- the exact privileges required by the SECURITY INVOKER settlement RPC.
revoke all on public.settlements, public.settlement_balances, public.settlement_expenses,
  public.settlement_shares, public.transfers, public.settlement_requests,
  public.settlement_audit_log from service_role;
grant select, insert, update on public.settlements, public.transfers to service_role;
grant select, insert on public.settlement_balances, public.settlement_expenses,
  public.settlement_shares, public.settlement_requests, public.settlement_audit_log to service_role;
