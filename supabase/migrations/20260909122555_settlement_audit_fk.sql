alter table public.settlement_audit_log
  add constraint settlement_audit_event_settlement_fkey
  foreign key (event_id, settlement_id)
  references public.settlements(event_id, id) on delete restrict;
