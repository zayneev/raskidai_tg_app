begin;
create extension if not exists pgtap with schema extensions;
select plan(1);
set local role service_role;

do $$
declare
  creator uuid;
  guest uuid;
  eid uuid;
  result jsonb;
  preview jsonb;
begin
  result:=public.create_telegram_session(8000000000000701,'V3 creator',repeat('7',64));
  creator:=(result->'user'->>'id')::uuid;
  result:=public.create_telegram_session(8000000000000702,'V3 guest',repeat('8',64));
  guest:=(result->'user'->>'id')::uuid;

  result:=public.event_action(repeat('7',64),'create',jsonb_build_object(
    'title','Ужин с друзьями',
    'description','В центре',
    'category','food',
    'eventDate','2026-09-26',
    'invitationHash',repeat('c',64),
    'requestId','00000000-0000-4000-8000-000000000071'
  ));
  eid:=(result->>'eventId')::uuid;
  if eid is null then raise exception 'v3 create failed: %',result; end if;
  if (select category from public.events where id=eid)<>'food'
    or (select event_date from public.events where id=eid)<>date '2026-09-26'
    or not exists(select 1 from public.invitations where event_id=eid and active) then
    raise exception 'event metadata or invitation missing';
  end if;

  result:=public.event_action(repeat('8',64),'join',jsonb_build_object(
    'invitationHash',repeat('c',64),
    'requestId','00000000-0000-4000-8000-000000000072'
  ));
  if (result->>'eventId')::uuid is distinct from eid then
    raise exception 'guest join failed: %',result;
  end if;

  result:=public.expense_action(repeat('7',64),'create',jsonb_build_object(
    'eventId',eid,
    'requestId','00000000-0000-4000-8000-000000000073',
    'title','Ужин',
    'amountKopecks',10000,
    'memberIds',jsonb_build_array(creator,guest)
  ));
  if result->>'ok' is distinct from 'true' then
    raise exception 'expense create failed: %',result;
  end if;

  preview:=public.settlement_preview_action(
    repeat('8',64),jsonb_build_object('eventId',eid)
  )->'preview';
  if preview is null
    or (preview->>'sourceEventVersion')::integer<>(select version from public.events where id=eid)
    or jsonb_array_length(preview->'balances')<>2
    or jsonb_array_length(preview->'transfers')<>1
    or (preview#>>'{transfers,0,amountKopecks}')::bigint<>5000 then
    raise exception 'unexpected preview: %',preview;
  end if;
end $$;

select pass('v3 event metadata, invitation and settlement preview');
rollback;
