begin;
create extension if not exists pgtap with schema extensions;
select plan(1);
-- A single assertion wraps a scenario: any incorrect result raises with context.
set local role service_role;
do $$
declare
  creator uuid;
  eid uuid;
  r jsonb;
  i integer;
  h text;
begin
  if has_table_privilege('anon', 'public.events', 'select') or has_table_privilege('authenticated', 'public.members', 'insert')
    or has_table_privilege('anon', 'public.invitations', 'select') or has_function_privilege('anon', 'public.event_action(text,text,jsonb)', 'execute')
    or has_function_privilege('authenticated', 'public.event_action(text,text,jsonb)', 'execute') then raise exception 'client privileges'; end if;
  if exists(select 1 from pg_class where oid in ('public.events'::regclass, 'public.members'::regclass, 'public.invitations'::regclass) and not relrowsecurity) then raise exception 'RLS missing'; end if;
  r := public.create_telegram_session(8000000000000001, 'Stage 3 creator', repeat('1',64)); creator := (r->'user'->>'id')::uuid;
  r := public.create_telegram_session(8000000000000002, 'Stage 3 guest', repeat('2',64));
  if public.event_action(repeat('0',64), 'list')->>'error' is distinct from 'unauthorized' then raise exception 'unknown session'; end if;
  if public.event_action(repeat('1',64), 'create', '{"title":" ","description":"","requestId":"00000000-0000-4000-8000-000000000001"}')->>'error' is distinct from 'invalid_input' then raise exception 'empty title'; end if;
  r := public.event_action(repeat('1',64), 'create', '{"title":"Trip","description":"Lake","requestId":"00000000-0000-4000-8000-000000000001"}'); eid := (r->>'eventId')::uuid;
  if eid is null then raise exception 'create failed: %', r; end if;
  r := public.event_action(repeat('1',64), 'create', '{"title":"Trip","description":"Lake","requestId":"00000000-0000-4000-8000-000000000001"}');
  if (r->>'eventId')::uuid <> eid then raise exception 'duplicate creation'; end if;
  if (select count(*) from public.members where event_id=eid) <> 1 then raise exception 'creator membership'; end if;
  if jsonb_array_length(public.event_action(repeat('2',64),'list')->'events') <> 0 then raise exception 'list leak'; end if;
  if public.event_action(repeat('2',64),'get',jsonb_build_object('eventId',eid))->>'error' is distinct from 'not_found' then raise exception 'detail leak'; end if;
  perform public.event_action(repeat('1',64),'rotate',jsonb_build_object('eventId',eid,'invitationHash',repeat('a',64)));
  r := public.event_action(repeat('2',64),'join',jsonb_build_object('invitationHash',repeat('a',64)));
  if (r->>'eventId')::uuid is distinct from eid then raise exception 'join failed'; end if;
  perform public.event_action(repeat('2',64),'join',jsonb_build_object('invitationHash',repeat('a',64)));
  if (select count(*) from public.members where event_id=eid) <> 2 then raise exception 'duplicate join'; end if;
  if jsonb_array_length(public.event_action(repeat('2',64),'get',jsonb_build_object('eventId',eid))->'event'->'members') <> 2 then raise exception 'member list'; end if;
  if public.event_action(repeat('2',64),'rotate',jsonb_build_object('eventId',eid,'invitationHash',repeat('b',64)))->>'error' is distinct from 'forbidden' then raise exception 'rotation rights'; end if;
  if public.event_action(repeat('2',64),'disable',jsonb_build_object('eventId',eid))->>'error' is distinct from 'forbidden' then raise exception 'disable rights'; end if;
  if public.event_action(repeat('1',64),'leave',jsonb_build_object('eventId',eid))->>'error' is distinct from 'creator_cannot_leave' then raise exception 'creator leave'; end if;
  perform public.event_action(repeat('2',64),'leave',jsonb_build_object('eventId',eid));
  if public.event_action(repeat('2',64),'get',jsonb_build_object('eventId',eid))->>'error' is distinct from 'not_found' then raise exception 'left member access'; end if;
  perform public.event_action(repeat('1',64),'disable',jsonb_build_object('eventId',eid));
  if public.event_action(repeat('2',64),'join',jsonb_build_object('invitationHash',repeat('a',64)))->>'error' is distinct from 'invitation_invalid' then raise exception 'disabled invitation'; end if;
  perform public.event_action(repeat('1',64),'rotate',jsonb_build_object('eventId',eid,'invitationHash',repeat('b',64)));
  if public.event_action(repeat('2',64),'join',jsonb_build_object('invitationHash',repeat('a',64)))->>'error' is distinct from 'not_found' then raise exception 'old invitation'; end if;
  update public.events set status='settled' where id=eid;
  if public.event_action(repeat('2',64),'join',jsonb_build_object('invitationHash',repeat('b',64)))->>'error' is distinct from 'event_locked' then raise exception 'locked join'; end if;
  if public.event_action(repeat('1',64),'rotate',jsonb_build_object('eventId',eid,'invitationHash',repeat('c',64)))->>'error' is distinct from 'event_locked' then raise exception 'locked rotation'; end if;
  update public.events set status='draft' where id=eid;
  for i in 3..31 loop
    h := lpad(i::text,64,'0');
    perform public.create_telegram_session(8000000000000000+i,'Capacity test',h);
    r := public.event_action(h,'join',jsonb_build_object('invitationHash',repeat('b',64)));
    if r ? 'error' then raise exception 'capacity join %: %',i,r; end if;
  end loop;
  if (select count(*) from public.members where event_id=eid) <> 30 then raise exception 'capacity count'; end if;
  if public.event_action(repeat('2',64),'join',jsonb_build_object('invitationHash',repeat('b',64)))->>'error' is distinct from 'event_full' then raise exception '31st accepted'; end if;
  -- Existing members can open an active invitation at capacity.
  if (public.event_action(lpad('3',64,'0'),'join',jsonb_build_object('invitationHash',repeat('b',64)))->>'eventId')::uuid is distinct from eid then raise exception 'existing at capacity'; end if;
  update public.app_sessions set expires_at=now()-interval '1 second' where token_hash=repeat('2',64);
  if public.event_action(repeat('2',64),'join',jsonb_build_object('invitationHash',repeat('b',64)))->>'error' is distinct from 'unauthorized' then raise exception 'expired session'; end if;
  perform public.revoke_app_session(repeat('1',64));
  if public.event_action(repeat('1',64),'get',jsonb_build_object('eventId',eid))->>'error' is distinct from 'unauthorized' then raise exception 'revoked session'; end if;
end $$;
reset role;
select pass('events: access, creation retry, join retry, members, leave, invitations, locked state, 30 member limit, session lifecycle');
select * from finish();
rollback;
