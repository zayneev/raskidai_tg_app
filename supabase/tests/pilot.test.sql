begin;
create extension if not exists pgtap with schema extensions;
select plan(2);
set local role service_role;

do $$
declare
  a constant uuid := '91000000-0000-4000-8000-000000000001';
  b constant uuid := '92000000-0000-4000-8000-000000000002';
  removed constant uuid := '93000000-0000-4000-8000-000000000003';
  outsider constant uuid := '94000000-0000-4000-8000-000000000004';
  eid constant uuid := '95000000-0000-4000-8000-000000000005';
  other_eid constant uuid := '96000000-0000-4000-8000-000000000006';
  v_expense_id uuid;
  v_settlement_id uuid;
  v_transfer_id uuid;
  request_id uuid;
  result jsonb;
  first_result jsonb;
  version_now integer;
  table_name text;
  role_name text;
  operation text;
begin
  foreach table_name in array array[
    'users','app_sessions','events','members','invitations','expenses',
    'expense_shares','expense_requests','audit_log','settlements',
    'settlement_balances','settlement_expenses','settlement_shares','transfers',
    'settlement_requests','settlement_audit_log','transfer_requests',
    'transfer_status_history','event_requests'
  ] loop
    if not (select relrowsecurity from pg_class where oid=('public.'||table_name)::regclass) then
      raise exception 'RLS disabled: %',table_name;
    end if;
    foreach role_name in array array['anon','authenticated'] loop
      foreach operation in array array['SELECT','INSERT','UPDATE','DELETE'] loop
        if has_table_privilege(role_name,'public.'||table_name,operation) then
          raise exception 'unexpected table privilege: % % %',role_name,operation,table_name;
        end if;
      end loop;
    end loop;
  end loop;
  if exists(
    select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname in (
      'create_telegram_session','get_app_session','revoke_app_session',
      'event_action','expense_action','settlement_action','transfer_action',
      'event_history_action','expense_snapshot','settlement_result'
    ) and (p.prosecdef or has_function_privilege('public',p.oid,'EXECUTE'))
  ) then raise exception 'application RPC is definer or executable by PUBLIC'; end if;

  insert into public.users(id,telegram_id,display_name) values
    (a,8800000000000001,'Pilot creator'),(b,8800000000000002,'Pilot member'),
    (removed,8800000000000003,'Pilot removed'),(outsider,8800000000000004,'Pilot outsider');
  insert into public.app_sessions(token_hash,user_id) values
    (repeat('1',64),a),(repeat('2',64),b),(repeat('3',64),removed),(repeat('4',64),outsider),
    (repeat('5',64),removed);
  update public.app_sessions set expires_at=clock_timestamp()-interval '1 second'
    where token_hash=repeat('5',64);
  insert into public.events(id,creator_id,title,request_id) values
    (eid,a,'Pilot access',gen_random_uuid()),(other_eid,outsider,'Other event',gen_random_uuid());
  insert into public.members(event_id,user_id) values
    (eid,a),(eid,b),(eid,removed),(other_eid,outsider);
  delete from public.members where event_id=eid and user_id=removed;

  if jsonb_array_length(public.event_action(repeat('1',64),'list')->'events')<>1
    or jsonb_array_length(public.event_action(repeat('4',64),'list')->'events')<>1
    or public.event_action(repeat('2',64),'get',jsonb_build_object('eventId',eid))->'event'->>'id'<>eid::text
    or public.event_action(repeat('3',64),'get',jsonb_build_object('eventId',eid))->>'error'<>'not_found'
    or public.event_action(repeat('4',64),'get',jsonb_build_object('eventId',eid))->>'error'<>'not_found'
    or public.event_action(repeat('0',64),'list')->>'error'<>'unauthorized'
    or public.event_action(repeat('5',64),'list')->>'error'<>'unauthorized'
    or public.event_action('damaged','list')->>'error'<>'unauthorized' then
    raise exception 'event/session access matrix failed';
  end if;
  perform public.revoke_app_session(repeat('3',64));
  if public.event_action(repeat('3',64),'list')->>'error'<>'unauthorized'
    or public.event_action(repeat('2',64),'rotate',jsonb_build_object(
      'eventId',eid,'invitationHash',repeat('a',64),'requestId',gen_random_uuid()))->>'error'<>'forbidden'
    or public.event_action(repeat('1',64),'leave',jsonb_build_object(
      'eventId',eid,'requestId',gen_random_uuid()))->>'error'<>'creator_cannot_leave' then
    raise exception 'revocation or event rights failed';
  end if;

  request_id:=gen_random_uuid();
  result:=public.expense_action(repeat('2',64),'create',jsonb_build_object(
    'eventId',eid,'title','Member pays','amountKopecks',101,
    'memberIds',jsonb_build_array(a,b),'requestId',request_id,
    'userId',outsider,'actorId',outsider,'serverTime','forged','status','completed'));
  v_expense_id:=(result->>'expenseId')::uuid;
  if v_expense_id is null or (select author_id from public.expenses where id=v_expense_id)<>b
    or (select sum(amount_kopecks) from public.expense_shares where expense_id=v_expense_id)<>101
    or public.expense_action(repeat('4',64),'list',jsonb_build_object('eventId',eid))->>'error'<>'not_found'
    or public.expense_action(repeat('3',64),'history',jsonb_build_object('eventId',eid))->>'error'<>'unauthorized' then
    raise exception 'expense access or forged identity failed';
  end if;
  first_result:=public.expense_action(repeat('1',64),'update',jsonb_build_object(
    'eventId',eid,'expenseId',v_expense_id,'version',1,'title','Creator edit',
    'amountKopecks',100,'memberIds',jsonb_build_array(a),'requestId',gen_random_uuid()));
  if first_result ? 'error' or public.expense_action(repeat('2',64),'update',jsonb_build_object(
    'eventId',eid,'expenseId',v_expense_id,'version',1,'title','Stale',
    'amountKopecks',1,'memberIds',jsonb_build_array(b),'requestId',gen_random_uuid()))->>'error'<>'version_conflict' then
    raise exception 'expense creator/version matrix failed';
  end if;
  perform public.expense_action(repeat('1',64),'delete',jsonb_build_object(
    'eventId',eid,'expenseId',v_expense_id,'version',2,'requestId',gen_random_uuid()));
  result:=public.expense_action(repeat('1',64),'create',jsonb_build_object(
    'eventId',eid,'title','Creator pays member','amountKopecks',100,
    'memberIds',jsonb_build_array(b),'requestId',gen_random_uuid()));

  select version into version_now from public.events where id=eid;
  if public.settlement_action(repeat('2',64),'settle',jsonb_build_object(
    'eventId',eid,'eventVersion',version_now,'requestId',gen_random_uuid()))->>'error'<>'forbidden' then
    raise exception 'member settled event';
  end if;
  request_id:=gen_random_uuid();
  first_result:=public.settlement_action(repeat('1',64),'settle',jsonb_build_object(
    'eventId',eid,'eventVersion',version_now,'requestId',request_id,
    'balances','forged','transfers','forged','actorId',outsider));
  v_settlement_id:=(first_result->'settlement'->>'id')::uuid;
  select id into v_transfer_id from public.transfers where settlement_id=v_settlement_id;
  if v_settlement_id is null or v_transfer_id is null
    or public.settlement_action(repeat('1',64),'settle',jsonb_build_object(
      'eventId',eid,'eventVersion',version_now,'requestId',request_id,
      'balances','forged','transfers','forged','actorId',outsider))<>first_result
    or public.settlement_action(repeat('1',64),'settle',jsonb_build_object(
      'eventId',eid,'eventVersion',version_now,'requestId',request_id))->>'error'<>'request_conflict'
    or public.expense_action(repeat('1',64),'create',jsonb_build_object(
      'eventId',eid,'title','Locked','amountKopecks',1,'memberIds',jsonb_build_array(a),
      'requestId',gen_random_uuid()))->>'error'<>'event_locked' then
    raise exception 'settlement replay/conflict/lock failed';
  end if;

  if public.transfer_action(repeat('1',64),'send',jsonb_build_object(
    'eventId',eid,'transferId',v_transfer_id,'eventVersion',version_now+1,
    'requestId',gen_random_uuid()))->>'error'<>'forbidden'
    or public.transfer_action(repeat('4',64),'send',jsonb_build_object(
    'eventId',eid,'transferId',v_transfer_id,'eventVersion',version_now+1,
    'requestId',gen_random_uuid()))->>'error'<>'not_found' then
    raise exception 'transfer access matrix failed';
  end if;
  result:=public.transfer_action(repeat('2',64),'send',jsonb_build_object(
    'eventId',eid,'transferId',v_transfer_id,'eventVersion',version_now+1,
    'requestId',gen_random_uuid(),'status','confirmed','amountKopecks',1,
    'senderId',a,'receiverId',b,'serverTime','forged'));
  if result->>'eventVersion'<>(version_now+2)::text then raise exception 'send failed %',result; end if;
  result:=public.transfer_action(repeat('1',64),'not_received',jsonb_build_object(
    'eventId',eid,'transferId',v_transfer_id,'eventVersion',version_now+2,
    'requestId',gen_random_uuid()));
  result:=public.transfer_action(repeat('2',64),'send',jsonb_build_object(
    'eventId',eid,'transferId',v_transfer_id,'eventVersion',version_now+3,
    'requestId',gen_random_uuid()));
  result:=public.transfer_action(repeat('1',64),'confirm',jsonb_build_object(
    'eventId',eid,'transferId',v_transfer_id,'eventVersion',version_now+4,
    'requestId',gen_random_uuid()));
  if result->>'eventStatus'<>'completed'
    or public.settlement_action(repeat('1',64),'cancel',jsonb_build_object(
      'eventId',eid,'eventVersion',version_now+5,'requestId',gen_random_uuid()))->>'error'<>'event_locked'
    or public.event_history_action(repeat('4',64),jsonb_build_object('eventId',eid))->>'error'<>'not_found'
    or public.event_history_action(repeat('1',64),jsonb_build_object(
      'eventId',eid,'limit',0))->>'error'<>'invalid_input' then
    raise exception 'completion/history access matrix failed';
  end if;
  result:=public.event_history_action(repeat('1',64),jsonb_build_object(
    'eventId',eid,'limit',2,'actorId',outsider,'before','forged','status','forged'));
  if jsonb_array_length(result->'items')<>2 or result->'nextCursor' is null then
    raise exception 'history pagination failed %',result;
  end if;
end $$;
select pass('pilot access: roles, sessions, membership, IDs, mutations, replay, history and completed state');

do $$
declare
  users constant uuid[] := array[
    'a1000000-0000-4000-8000-000000000001'::uuid,
    'a2000000-0000-4000-8000-000000000002'::uuid,
    'a3000000-0000-4000-8000-000000000003'::uuid,
    'a4000000-0000-4000-8000-000000000004'::uuid,
    'a5000000-0000-4000-8000-000000000005'::uuid,
    'a6000000-0000-4000-8000-000000000006'::uuid,
    'a7000000-0000-4000-8000-000000000007'::uuid,
    'a8000000-0000-4000-8000-000000000008'::uuid
  ];
  first_event constant uuid := 'b1000000-0000-4000-8000-000000000001';
  second_event constant uuid := 'b2000000-0000-4000-8000-000000000002';
  single_event constant uuid := 'b3000000-0000-4000-8000-000000000003';
  sid1 uuid; sid2 uuid; single_sid uuid; xid uuid; uid uuid;
  seed bigint := 20260914;
  amount bigint; participant_count integer; author_index integer; i integer; ord integer;
  r jsonb;
begin
  if exists(
    select 1 from information_schema.columns
    where table_schema='public' and column_name like '%kopecks'
      and data_type<>'bigint'
  ) then raise exception 'non-bigint money column found'; end if;
  for i in 1..8 loop
    insert into public.users(id,telegram_id,display_name)
      values(users[i],8900000000000000+i,'Arithmetic '||i);
  end loop;
  insert into public.app_sessions(token_hash,user_id) values(repeat('6',64),users[1]);
  insert into public.events(id,creator_id,title,request_id) values
    (first_event,users[1],'Seed 20260914 forward',gen_random_uuid()),
    (second_event,users[1],'Seed 20260914 reverse',gen_random_uuid()),
    (single_event,users[1],'Single participant',gen_random_uuid());
  foreach uid in array users loop
    insert into public.members(event_id,user_id) values(first_event,uid),(second_event,uid);
  end loop;
  insert into public.members(event_id,user_id) values(single_event,users[1]);
  xid:=md5('single expense')::uuid;
  insert into public.expenses(id,event_id,author_id,title,amount_kopecks)
    values(xid,single_event,users[1],'Maximum',99999999999);
  insert into public.expense_shares(event_id,expense_id,user_id,amount_kopecks)
    values(single_event,xid,users[1],99999999999);

  for i in 1..48 loop
    seed:=mod(seed*1103515245+12345,2147483648);
    amount:=case when i=1 then 99999999999 when i=2 then 1 else mod(seed,1000000)+1 end;
    participant_count:=mod(seed,8)+1;
    author_index:=mod(seed/8,8)+1;
    xid:=md5('forward expense '||i)::uuid;
    insert into public.expenses(id,event_id,author_id,title,amount_kopecks)
      values(xid,first_event,users[author_index],'Generated '||i,amount);
    for ord in 1..participant_count loop
      insert into public.expense_shares(event_id,expense_id,user_id,amount_kopecks)
        values(first_event,xid,users[ord],amount/participant_count
          + case when ord<=mod(amount,participant_count) then 1 else 0 end);
    end loop;
  end loop;
  seed:=20260914;
  for i in 1..48 loop
    seed:=mod(seed*1103515245+12345,2147483648);
    amount:=case when i=1 then 99999999999 when i=2 then 1 else mod(seed,1000000)+1 end;
    participant_count:=mod(seed,8)+1;
    author_index:=mod(seed/8,8)+1;
    xid:=md5('reverse expense '||(49-i))::uuid;
    insert into public.expenses(id,event_id,author_id,title,amount_kopecks)
      values(xid,second_event,users[author_index],'Generated '||i,amount);
    for ord in reverse participant_count..1 loop
      insert into public.expense_shares(event_id,expense_id,user_id,amount_kopecks)
        values(second_event,xid,users[ord],amount/participant_count
          + case when ord<=mod(amount,participant_count) then 1 else 0 end);
    end loop;
  end loop;
  set constraints all immediate;

  r:=public.settlement_action(repeat('6',64),'settle',jsonb_build_object(
    'eventId',single_event,'eventVersion',1,'requestId',gen_random_uuid()));
  single_sid:=(r->'settlement'->>'id')::uuid;
  if r->>'eventStatus'<>'completed'
    or exists(select 1 from public.settlement_balances where settlement_id=single_sid and balance_kopecks<>0)
    or exists(select 1 from public.transfers where settlement_id=single_sid) then
    raise exception 'single participant / zero result failed, seed=20260914';
  end if;
  r:=public.settlement_action(repeat('6',64),'settle',jsonb_build_object(
    'eventId',first_event,'eventVersion',1,'requestId',gen_random_uuid()));
  sid1:=(r->'settlement'->>'id')::uuid;
  r:=public.settlement_action(repeat('6',64),'settle',jsonb_build_object(
    'eventId',second_event,'eventVersion',1,'requestId',gen_random_uuid()));
  sid2:=(r->'settlement'->>'id')::uuid;
  if sid1 is null or sid2 is null then raise exception 'generated settle failed, seed=20260914'; end if;
  if (select sum(balance_kopecks) from public.settlement_balances where settlement_id=sid1)<>0
    or (select sum(amount_kopecks) from public.transfers where settlement_id=sid1)
      is distinct from (select sum(balance_kopecks) from public.settlement_balances
        where settlement_id=sid1 and balance_kopecks>0)
    or (select sum(amount_kopecks) from public.transfers where settlement_id=sid1)
      is distinct from -(select sum(balance_kopecks) from public.settlement_balances
        where settlement_id=sid1 and balance_kopecks<0)
    or exists(select 1 from public.transfers where settlement_id=sid1
      and (amount_kopecks<=0 or sender_id=receiver_id))
    or exists(select 1 from public.transfers t
      join public.settlement_balances d on d.settlement_id=t.settlement_id and d.user_id=t.sender_id
      join public.settlement_balances c on c.settlement_id=t.settlement_id and c.user_id=t.receiver_id
      where t.settlement_id=sid1 and (d.balance_kopecks>=0 or c.balance_kopecks<=0))
    or exists(select 1 from public.settlement_balances b where b.settlement_id=sid1
      and b.balance_kopecks
        +coalesce((select sum(amount_kopecks) from public.transfers where settlement_id=sid1 and sender_id=b.user_id),0)
        -coalesce((select sum(amount_kopecks) from public.transfers where settlement_id=sid1 and receiver_id=b.user_id),0)<>0) then
    raise exception 'generated arithmetic invariant failed, seed=20260914';
  end if;
  if (select jsonb_agg(jsonb_build_array(user_id,paid_kopecks,share_kopecks,balance_kopecks) order by user_id)
      from public.settlement_balances where settlement_id=sid1)
    <> (select jsonb_agg(jsonb_build_array(user_id,paid_kopecks,share_kopecks,balance_kopecks) order by user_id)
      from public.settlement_balances where settlement_id=sid2)
    or (select jsonb_agg(jsonb_build_array(sequence,sender_id,receiver_id,amount_kopecks) order by sequence)
      from public.transfers where settlement_id=sid1)
    <> (select jsonb_agg(jsonb_build_array(sequence,sender_id,receiver_id,amount_kopecks) order by sequence)
      from public.transfers where settlement_id=sid2) then
    raise exception 'non-deterministic result or row-order dependency, seed=20260914';
  end if;
end $$;
select pass('pilot arithmetic: seed 20260914, 1/8 participants, 1/48 expenses, pennies, max, rounding and determinism');

reset role;
select * from finish();
rollback;
