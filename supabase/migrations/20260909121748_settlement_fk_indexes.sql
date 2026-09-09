create index settlement_balances_user_idx on public.settlement_balances(user_id);
create index settlement_expenses_author_idx on public.settlement_expenses(settlement_id, author_id);
create index settlement_shares_user_idx on public.settlement_shares(settlement_id, user_id);
create index transfers_settlement_sender_idx on public.transfers(settlement_id, sender_id);
create index transfers_settlement_receiver_idx on public.transfers(settlement_id, receiver_id);
