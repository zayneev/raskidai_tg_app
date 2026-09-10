begin;
create extension if not exists pgtap with schema extensions;
select plan(1);
set local role service_role;
do $$
declare
  a constant uuid := '11000000-0000-4000-8000-000000000001';
  b constant uuid := '12000000-0000-4000-8000-000000000002';
  c constant uuid := '13000000-0000-4000-8000-000000000003';
  outsider constant uuid := '14000000-0000-4000-8000-000000000004';
  eid constant uuid := '15000000-0000-4000-8000-000000000005';
  cancel_eid constant uuid := '16000000-0000-4000-8000-000000000006';
  zero_eid constant uuid := '17000000-0000-4000-8000-000000000007';
  expense_id constant uuid := '18000000-0000-4000-8000-000000000008';
  cancel_expense_id constant uuid := '19000000-0000-4000-8000-000000000009';
  sid uuid; transfer_one uuid; transfer_two uuid; cancel_sid uuid;
  send_rid uuid := gen_random_uuid(); problem_rid uuid := gen_random_uuid();
  resend_rid uuid := gen_random_uuid(); confirm_one_rid uuid := gen_random_uuid();
  confirm_two_rid uuid := gen_random_uuid(); cancel_rid uuid := gen_random_uuid();
  r jsonb; first_response jsonb; table_name text; role_name text; operation text;
begin
  foreach table_name in array array['transfer_requests','transfer_status_history'] loop
    foreach role_name in array array['anon','authenticated'] loop
      foreach operation in array array['SELECT','INSERT','UPDATE','DELETE'] loop
        if has_table_privilege(role_name,'public.'||table_name,operation) then
          raise exception 'client privilege % % %',role_name,operation,table_name; end if;
      end loop;
    end loop;
    if not (select relrowsecurity from pg_class where oid=('public.'||table_name)::regclass) then
      raise exception 'RLS disabled for %',table_name; end if;
  end loop;
  if has_table_privilege('service_role','public.transfer_status_history','UPDATE')
    or has_table_privilege('service_role','public.transfer_requests','DELETE')
    or has_function_privilege('anon','public.transfer_action(text,text,jsonb)','execute')
    or has_function_privilege('authenticated','public.transfer_action(text,text,jsonb)','execute') then
    raise exception 'transfer history or RPC exposed'; end if;

  insert into public.users(id,telegram_id,display_name) values
    (a,8300000000000001,'Аня'),(b,8300000000000002,'Борис'),
    (c,8300000000000003,'Вера'),(outsider,8300000000000004,'Чужой');
  insert into public.app_sessions(token_hash,user_id) values
    (repeat('1',64),a),(repeat('2',64),b),(repeat('3',64),c),(repeat('4',64),outsider);
  insert into public.events(id,creator_id,title,request_id) values
    (eid,a,'Два перевода',gen_random_uuid()),
    (cancel_eid,a,'Отмена',gen_random_uuid()),
    (zero_eid,a,'Без переводов',gen_random_uuid());
  insert into public.members(event_id,user_id) values
    (eid,a),(eid,b),(eid,c),(cancel_eid,a),(cancel_eid,b),(zero_eid,a);
  insert into public.expenses(id,event_id,author_id,title,amount_kopecks)
    values(expense_id,eid,a,'Только копейки',200),
      (cancel_expense_id,cancel_eid,a,'Можно отменить',100);
  insert into public.expense_shares(event_id,expense_id,user_id,amount_kopecks)
    values(eid,expense_id,b,100),(eid,expense_id,c,100),
      (cancel_eid,cancel_expense_id,b,100);
  set constraints all immediate;

  r := public.settlement_action(repeat('1',64),'settle',jsonb_build_object(
    'eventId',eid,'eventVersion',1,'requestId',gen_random_uuid()));
  sid := (r->'settlement'->>'id')::uuid;
  select id into transfer_one from public.transfers where settlement_id=sid and sequence=1;
  select id into transfer_two from public.transfers where settlement_id=sid and sequence=2;
  if sid is null or transfer_one is null or transfer_two is null
    or (select array_agg(amount_kopecks order by sequence) from public.transfers where settlement_id=sid)
      <> array[100::bigint,100] then raise exception 'stage 5 settlement changed %',r; end if;

  if public.transfer_action(repeat('4',64),'send',jsonb_build_object(
    'eventId',eid,'transferId',transfer_one,'eventVersion',2,'requestId',gen_random_uuid()))->>'error'
      is distinct from 'not_found' then raise exception 'outsider changed transfer'; end if;
  if public.transfer_action(repeat('1',64),'send',jsonb_build_object(
    'eventId',eid,'transferId',transfer_one,'eventVersion',2,'requestId',gen_random_uuid()))->>'error'
      is distinct from 'forbidden' then raise exception 'receiver sent transfer'; end if;
  if public.transfer_action(repeat('2',64),'confirm',jsonb_build_object(
    'eventId',eid,'transferId',transfer_one,'eventVersion',2,'requestId',gen_random_uuid()))->>'error'
      is distinct from 'forbidden' then raise exception 'sender confirmed transfer'; end if;
  if public.transfer_action(repeat('1',64),'confirm',jsonb_build_object(
    'eventId',eid,'transferId',transfer_one,'eventVersion',2,'requestId',gen_random_uuid()))->>'error'
      is distinct from 'invalid_transition' then raise exception 'pending confirmed'; end if;
  if public.transfer_action(repeat('1',64),'not_received',jsonb_build_object(
    'eventId',eid,'transferId',transfer_one,'eventVersion',2,'requestId',gen_random_uuid()))->>'error'
      is distinct from 'invalid_transition' then raise exception 'pending rejected'; end if;

  first_response := public.transfer_action(repeat('2',64),'send',jsonb_build_object(
    'eventId',eid,'transferId',transfer_one,'eventVersion',2,'requestId',send_rid));
  if first_response->>'eventVersion'<>'3'
    or (select status from public.transfers where id=transfer_one)<>'sent'
    or (select sent_at is null from public.transfers where id=transfer_one)
    or (select transfers_started_at is null from public.settlements where id=sid)
    or (select count(*) from public.transfer_status_history where transfer_id=transfer_one)<>1 then
    raise exception 'send failed %',first_response; end if;
  if public.transfer_action(repeat('2',64),'send',jsonb_build_object(
    'eventId',eid,'transferId',transfer_one,'eventVersion',2,'requestId',send_rid))<>first_response
    or (select count(*) from public.transfer_status_history where transfer_id=transfer_one)<>1 then
    raise exception 'send replay duplicated'; end if;
  if public.transfer_action(repeat('2',64),'send',jsonb_build_object(
    'eventId',eid,'transferId',transfer_two,'eventVersion',2,'requestId',send_rid))->>'error'
      is distinct from 'request_conflict' then raise exception 'send request mismatch'; end if;
  if public.transfer_action(repeat('2',64),'send',jsonb_build_object(
    'eventId',eid,'transferId',transfer_one,'eventVersion',2,'requestId',gen_random_uuid()))->>'error'
      is distinct from 'version_conflict' then raise exception 'stale send accepted'; end if;

  r := public.transfer_action(repeat('1',64),'not_received',jsonb_build_object(
    'eventId',eid,'transferId',transfer_one,'eventVersion',3,'requestId',problem_rid));
  if r->>'eventVersion'<>'4' or (select status from public.transfers where id=transfer_one)<>'not_received'
    or (select count(*) from public.transfer_status_history where transfer_id=transfer_one)<>2
    or (select status from public.events where id=eid)<>'settled' then
    raise exception 'not received failed %',r; end if;
  first_response := public.transfer_action(repeat('1',64),'not_received',jsonb_build_object(
    'eventId',eid,'transferId',transfer_one,'eventVersion',4,'requestId',gen_random_uuid()));
  if first_response->>'eventVersion'<>'4'
    or (select count(*) from public.transfer_status_history where transfer_id=transfer_one)<>2 then
    raise exception 'semantic not-received retry changed state'; end if;
  if public.settlement_action(repeat('1',64),'cancel',jsonb_build_object(
    'eventId',eid,'eventVersion',4,'requestId',gen_random_uuid()))->>'error'
      is distinct from 'transfers_started' then raise exception 'cancel after not-received'; end if;

  r := public.transfer_action(repeat('2',64),'send',jsonb_build_object(
    'eventId',eid,'transferId',transfer_one,'eventVersion',4,'requestId',resend_rid));
  if r->>'eventVersion'<>'5' or (select status from public.transfers where id=transfer_one)<>'sent'
    or (select not_received_at is not null from public.transfers where id=transfer_one)
    or (select count(*) from public.transfer_status_history where transfer_id=transfer_one)<>3 then
    raise exception 'resend failed %',r; end if;
  r := public.transfer_action(repeat('1',64),'confirm',jsonb_build_object(
    'eventId',eid,'transferId',transfer_one,'eventVersion',5,'requestId',confirm_one_rid));
  if r->>'eventVersion'<>'6' or (select status from public.events where id=eid)<>'settled'
    or (select status from public.transfers where id=transfer_one)<>'confirmed' then
    raise exception 'first confirmation completed early %',r; end if;
  if public.transfer_action(repeat('2',64),'send',jsonb_build_object(
    'eventId',eid,'transferId',transfer_one,'eventVersion',6,'requestId',gen_random_uuid()))->>'error'
      is distinct from 'invalid_transition' then raise exception 'confirmed transfer changed'; end if;

  r := public.transfer_action(repeat('3',64),'send',jsonb_build_object(
    'eventId',eid,'transferId',transfer_two,'eventVersion',6,'requestId',gen_random_uuid()));
  if r->>'eventVersion'<>'7' then raise exception 'second send failed %',r; end if;
  first_response := public.transfer_action(repeat('1',64),'confirm',jsonb_build_object(
    'eventId',eid,'transferId',transfer_two,'eventVersion',7,'requestId',confirm_two_rid));
  if first_response->>'eventVersion'<>'8' or first_response->>'eventStatus'<>'completed'
    or (select status from public.events where id=eid)<>'completed'
    or (select count(*) from public.settlement_audit_log where settlement_id=sid and action='complete')<>1 then
    raise exception 'last confirmation did not complete %',first_response; end if;
  if public.transfer_action(repeat('1',64),'confirm',jsonb_build_object(
    'eventId',eid,'transferId',transfer_two,'eventVersion',7,'requestId',confirm_two_rid))<>first_response
    or (select count(*) from public.transfer_status_history where settlement_id=sid)<>6
    or (select count(*) from public.settlement_audit_log where settlement_id=sid and action='complete')<>1 then
    raise exception 'last confirmation replay duplicated'; end if;
  if public.settlement_action(repeat('1',64),'cancel',jsonb_build_object(
    'eventId',eid,'eventVersion',8,'requestId',gen_random_uuid()))->>'error'
      is distinct from 'event_locked' then raise exception 'completed event cancelled'; end if;

  -- Cancellation before any send remains atomic and idempotent.
  r := public.settlement_action(repeat('1',64),'settle',jsonb_build_object(
    'eventId',cancel_eid,'eventVersion',1,'requestId',gen_random_uuid()));
  cancel_sid := (r->'settlement'->>'id')::uuid;
  first_response := public.settlement_action(repeat('1',64),'cancel',jsonb_build_object(
    'eventId',cancel_eid,'eventVersion',2,'requestId',cancel_rid));
  if first_response->>'eventVersion'<>'3' or (select status from public.events where id=cancel_eid)<>'draft'
    or (select active from public.settlements where id=cancel_sid) then
    raise exception 'pre-send cancellation failed %',first_response; end if;
  if public.settlement_action(repeat('1',64),'cancel',jsonb_build_object(
    'eventId',cancel_eid,'eventVersion',2,'requestId',cancel_rid))<>first_response
    or (select count(*) from public.settlement_audit_log where settlement_id=cancel_sid and action='cancel')<>1 then
    raise exception 'cancellation replay duplicated'; end if;
  if public.transfer_action(repeat('2',64),'send',jsonb_build_object(
    'eventId',cancel_eid,
    'transferId',(select id from public.transfers where settlement_id=cancel_sid limit 1),
    'eventVersion',3,'requestId',gen_random_uuid()))->>'error'
      is distinct from 'transfer_unavailable' then raise exception 'inactive transfer available'; end if;

  r := public.settlement_action(repeat('1',64),'settle',jsonb_build_object(
    'eventId',zero_eid,'eventVersion',1,'requestId',gen_random_uuid()));
  if r->>'eventStatus'<>'completed' or (select status from public.events where id=zero_eid)<>'completed'
    or jsonb_array_length(r->'settlement'->'transfers')<>0
    or (select count(*) from public.settlement_audit_log
      where settlement_id=(r->'settlement'->>'id')::uuid and action='complete')<>1 then
    raise exception 'zero transfer settlement not completed %',r; end if;

  update public.app_sessions set expires_at=clock_timestamp()-interval '1 second'
    where token_hash=repeat('2',64);
  if public.transfer_action(repeat('2',64),'send',jsonb_build_object(
    'eventId',eid,'transferId',transfer_one,'eventVersion',8,'requestId',gen_random_uuid()))->>'error'
      is distinct from 'unauthorized' then raise exception 'expired session accepted'; end if;
end $$;
reset role;
select pass('transfers: rights, transitions, idempotency, immutable history and completion');
select * from finish();
rollback;
