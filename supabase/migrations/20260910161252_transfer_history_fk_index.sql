create index transfer_status_history_event_settlement_idx
  on public.transfer_status_history(event_id, settlement_id);
