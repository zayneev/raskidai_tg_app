create index settlement_audit_event_settlement_idx
  on public.settlement_audit_log(event_id, settlement_id);
