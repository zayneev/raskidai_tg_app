begin;
create extension if not exists pgtap with schema extensions;
select plan(1);
set local role service_role;
do $$
declare
  creator constant uuid := '71000000-0000-4000-8000-000000000001';
  guest constant uuid := '72000000-0000-4000-8000-000000000002';
  outsider constant uuid := '73000000-0000-4000-8000-000000000003';
  removed constant uuid := '74000000-0000-4000-8000-000000000004';
  create_rid constant uuid := '76000000-0000-4000-8000-000000000006';
  rotate_rid constant uuid := '77000000-0000-4000-8000-000000000007';
  expense_rid constant uuid := '78000000-0000-4000-8000-000000000008';
  settle_rid constant uuid := '79000000-0000-4000-8000-000000000009';
  send_rid constant uuid := '7a000000-0000-4000-8000-00000000000a';
  eid uuid;
  sid uuid;
  tid uuid;
  version_after_rotate integer;
  first_page jsonb;
  second_page jsonb;
  cursor_value jsonb;
  result jsonb;
begin
  if has_table_privilege('anon','public.event_requests','SELECT')
    or has_table_privilege('authenticated','public.event_requests','INSERT')
    or has_table_privilege('service_role','public.event_requests','UPDATE')
    or has_function_privilege('anon','public.event_history_action(text,jsonb)','EXECUTE')
    or has_function_privilege('authenticated','public.event_history_action(text,jsonb)','EXECUTE') then
    raise exception 'stage 7 objects exposed or mutable';
  end if;
  if not (select relrowsecurity from pg_class
    where oid='public.event_requests'::regclass) then
    raise exception 'event_requests RLS disabled';
  end if;
  insert into public.users(id,telegram_id,display_name) values
    (creator,8700000000000001,'Создатель'),
    (guest,8700000000000002,'Участник'),
    (outsider,8700000000000003,'Чужой'),
    (removed,8700000000000004,'Исключённый');
  insert into public.app_sessions(token_hash,user_id) values
    (repeat('a',64),creator),(repeat('b',64),guest),
    (repeat('c',64),outsider),(repeat('d',64),removed);
  result:=public.event_action(repeat('a',64),'create',jsonb_build_object(
    'title','Устойчивость','description','','requestId',create_rid));
  eid:=(result->>'eventId')::uuid;
  if eid is null then raise exception 'create failed'; end if;
  if public.event_action(repeat('a',64),'create',jsonb_build_object(
    'title','Другое','description','','requestId',create_rid))->>'error'
      is distinct from 'request_conflict' then
    raise exception 'create body conflict not detected';
  end if;
  insert into public.members(event_id,user_id) values(eid,guest),(eid,removed);
  delete from public.members where event_id=eid and user_id=removed;

  result:=public.event_action(repeat('a',64),'rotate',jsonb_build_object(
    'eventId',eid,'invitationHash',repeat('e',64),'requestId',rotate_rid));
  select version into version_after_rotate from public.events where id=eid;
  if result->>'ok'<>'true' then raise exception 'rotate failed %',result; end if;
  if public.event_action(repeat('a',64),'rotate',jsonb_build_object(
    'eventId',eid,'invitationHash',repeat('e',64),'requestId',rotate_rid))<>result
    or (select version from public.events where id=eid)<>version_after_rotate then
    raise exception 'event retry was not idempotent';
  end if;
  if public.event_action(repeat('a',64),'rotate',jsonb_build_object(
    'eventId',eid,'invitationHash',repeat('f',64),'requestId',rotate_rid))->>'error'
      is distinct from 'request_conflict' then
    raise exception 'event request conflict missing';
  end if;

  perform public.expense_action(repeat('a',64),'create',jsonb_build_object(
    'eventId',eid,'title','Такси','amountKopecks',100,
    'memberIds',jsonb_build_array(guest),'requestId',expense_rid));
  result:=public.settlement_action(repeat('a',64),'settle',jsonb_build_object(
    'eventId',eid,'eventVersion',(select version from public.events where id=eid),
    'requestId',settle_rid));
  sid:=(result->'settlement'->>'id')::uuid;
  select id into tid from public.transfers where settlement_id=sid;
  perform public.transfer_action(repeat('b',64),'send',jsonb_build_object(
    'eventId',eid,'transferId',tid,
    'eventVersion',(select version from public.events where id=eid),
    'requestId',send_rid));

  first_page:=public.event_history_action(repeat('a',64),jsonb_build_object(
    'eventId',eid,'limit',2));
  cursor_value:=first_page->'nextCursor';
  if jsonb_array_length(first_page->'items')<>2 or cursor_value is null
    or not (first_page->'items' @> '[{"action":"transfer.sent"}]')
    or not (first_page->'items' @> '[{"action":"settlement.settle"}]') then
    raise exception 'first history page incorrect %',first_page;
  end if;
  second_page:=public.event_history_action(repeat('b',64),jsonb_build_object(
    'eventId',eid,'limit',2,'cursor',cursor_value));
  if jsonb_array_length(second_page->'items')<>1
    or not (second_page->'items' @> '[{"action":"expense.create"}]')
    or second_page->'nextCursor' <> 'null'::jsonb then
    raise exception 'second history page incorrect %',second_page;
  end if;
  if first_page->'items'->0->>'id'=second_page->'items'->0->>'id'
    or public.event_history_action(repeat('c',64),jsonb_build_object(
      'eventId',eid))->>'error' is distinct from 'not_found'
    or public.event_history_action(repeat('d',64),jsonb_build_object(
      'eventId',eid))->>'error' is distinct from 'not_found' then
    raise exception 'history isolation failed';
  end if;
  update public.app_sessions set expires_at=clock_timestamp()-interval '1 second'
    where token_hash=repeat('a',64);
  if public.event_history_action(repeat('a',64),jsonb_build_object(
    'eventId',eid))->>'error' is distinct from 'unauthorized' then
    raise exception 'expired history session accepted';
  end if;
end $$;
reset role;
select pass('resilience: event idempotency, closed history, membership, sessions and stable cursor pages');
select * from finish();
rollback;
