begin;
create extension if not exists pgtap with schema extensions;
select plan(1);
set local role service_role;
do $$
declare
  a constant uuid := '10000000-0000-4000-8000-000000000001';
  b constant uuid := '20000000-0000-4000-8000-000000000002';
  v constant uuid := '30000000-0000-4000-8000-000000000003';
  g constant uuid := '40000000-0000-4000-8000-000000000004';
  outsider constant uuid := '50000000-0000-4000-8000-000000000005';
  eid constant uuid := '60000000-0000-4000-8000-000000000006';
  empty_eid constant uuid := '70000000-0000-4000-8000-000000000007';
  penny_eid constant uuid := '71000000-0000-4000-8000-000000000007';
  zero_eid constant uuid := '72000000-0000-4000-8000-000000000007';
  tie_eid constant uuid := '80000000-0000-4000-8000-000000000008';
  rid uuid := gen_random_uuid(); cancel_rid uuid := gen_random_uuid(); sid uuid;
  x1 uuid := gen_random_uuid(); x2 uuid := gen_random_uuid(); x3 uuid := gen_random_uuid();
  tx1 uuid := gen_random_uuid(); tx2 uuid := gen_random_uuid();
  penny_x uuid := gen_random_uuid(); zero_x uuid := gen_random_uuid();
  r jsonb; table_name text; role_name text; operation text;
begin
  foreach table_name in array array['settlements','settlement_balances','settlement_expenses',
    'settlement_shares','transfers','settlement_requests','settlement_audit_log'] loop
    foreach role_name in array array['anon','authenticated'] loop
      foreach operation in array array['SELECT','INSERT','UPDATE','DELETE'] loop
        if has_table_privilege(role_name,'public.'||table_name,operation) then
          raise exception 'client privilege % % %',role_name,operation,table_name; end if;
      end loop;
    end loop;
    if not (select relrowsecurity from pg_class where oid=('public.'||table_name)::regclass) then
      raise exception 'RLS disabled for %',table_name; end if;
  end loop;
  if has_function_privilege('anon','public.settlement_action(text,text,jsonb)','execute')
    or has_function_privilege('authenticated','public.settlement_result(uuid)','execute') then
    raise exception 'settlement RPC public'; end if;
  if has_table_privilege('service_role','public.settlement_balances','UPDATE')
    or has_table_privilege('service_role','public.settlement_audit_log','DELETE') then
    raise exception 'snapshot or history mutable'; end if;

  insert into public.users(id,telegram_id,display_name) values
    (a,8200000000000001,'Аня'),(b,8200000000000002,'Борис'),
    (v,8200000000000003,'Вера'),(g,8200000000000004,'Глеб'),
    (outsider,8200000000000005,'Чужой');
  insert into public.app_sessions(token_hash,user_id) values
    (repeat('a',64),a),(repeat('b',64),b),(repeat('c',64),v),
    (repeat('d',64),g),(repeat('e',64),outsider);
  insert into public.events(id,creator_id,title,request_id) values
    (eid,a,'Эталон',gen_random_uuid()),
    (empty_eid,a,'Без расходов',gen_random_uuid()),
    (penny_eid,a,'Копейки',gen_random_uuid()),
    (zero_eid,a,'Нулевые балансы',gen_random_uuid()),
    (tie_eid,a,'Равные балансы',gen_random_uuid());
  insert into public.members(event_id,user_id) values
    (eid,a),(eid,b),(eid,v),(eid,g),(empty_eid,a),
    (penny_eid,a),(penny_eid,b),(penny_eid,v),(zero_eid,a),(zero_eid,b),
    (tie_eid,a),(tie_eid,b),(tie_eid,v),(tie_eid,g);
  insert into public.invitations(event_id,token_hash) values(eid,repeat('2',64));

  insert into public.expenses(id,event_id,author_id,title,amount_kopecks) values
    (x1,eid,a,'Аня платит',600000),(x2,eid,b,'Борис платит',300000),
    (x3,eid,v,'Вера платит',80000);
  insert into public.expense_shares(event_id,expense_id,user_id,amount_kopecks) values
    (eid,x1,a,150000),(eid,x1,b,150000),(eid,x1,v,150000),(eid,x1,g,150000),
    (eid,x2,a,100000),(eid,x2,b,100000),(eid,x2,v,100000),
    (eid,x3,v,40000),(eid,x3,g,40000);
  set constraints all immediate;
  set constraints all deferred;

  if public.settlement_action(repeat('e',64),'get',jsonb_build_object('eventId',eid))->>'error'
    is distinct from 'not_found' then raise exception 'outsider read'; end if;
  if public.settlement_action(repeat('b',64),'settle',jsonb_build_object(
    'eventId',eid,'eventVersion',1,'requestId',gen_random_uuid()))->>'error'
    is distinct from 'forbidden' then raise exception 'member settled'; end if;
  if public.settlement_action(repeat('a',64),'settle',jsonb_build_object(
    'eventId',eid,'eventVersion',2,'requestId',gen_random_uuid()))->>'error'
    is distinct from 'version_conflict' then raise exception 'stale settle'; end if;

  r := public.settlement_action(repeat('a',64),'settle',jsonb_build_object(
    'eventId',eid,'eventVersion',1,'requestId',rid,
    'balances',jsonb_build_array(jsonb_build_object('userId',outsider,'balanceKopecks',1)),
    'transfers',jsonb_build_array(jsonb_build_object('senderId',outsider,'amountKopecks',1))));
  sid := (r->'settlement'->>'id')::uuid;
  if sid is null or r ? 'error' then raise exception 'settle failed %',r; end if;
  if (select status from public.events where id=eid)<>'settled'
    or (select version from public.events where id=eid)<>2 then
    raise exception 'event not settled'; end if;
  if (select sum(balance_kopecks) from public.settlement_balances where settlement_id=sid) <> 0 then
    raise exception 'balances do not sum zero'; end if;
  if (select array_agg(balance_kopecks order by user_id) from public.settlement_balances where settlement_id=sid)
    <> array[350000::bigint,50000,-210000,-190000] then raise exception 'reference balances'; end if;
  if (select array_agg(sender_id::text||'>'||receiver_id::text||':'||amount_kopecks order by sequence)
      from public.transfers where settlement_id=sid)
    <> array[v::text||'>'||a::text||':210000',g::text||'>'||a::text||':140000',g::text||'>'||b::text||':50000'] then
    raise exception 'reference transfers'; end if;
  if exists(select 1 from public.transfers where settlement_id=sid and amount_kopecks<=0) then
    raise exception 'nonpositive transfer'; end if;
  if (select count(*) from public.transfers where settlement_id=sid) >
     (select count(*)-1 from public.settlement_balances where settlement_id=sid and balance_kopecks<>0) then
    raise exception 'more than k-1 transfers'; end if;
  if exists(select 1 from public.transfers t join public.settlement_balances s
    on s.settlement_id=t.settlement_id and s.user_id=t.sender_id
    join public.settlement_balances q on q.settlement_id=t.settlement_id and q.user_id=t.receiver_id
    where t.settlement_id=sid and s.event_id<>q.event_id) then raise exception 'cross-event transfer'; end if;
  if (select count(*) from public.settlement_expenses where settlement_id=sid)<>3
    or (select count(*) from public.settlement_shares where settlement_id=sid)<>9 then
    raise exception 'snapshot incomplete'; end if;
  if public.settlement_action(repeat('a',64),'settle',jsonb_build_object(
    'eventId',eid,'eventVersion',1,'requestId',rid,
    'balances',jsonb_build_array(jsonb_build_object('userId',outsider,'balanceKopecks',1)),
    'transfers',jsonb_build_array(jsonb_build_object('senderId',outsider,'amountKopecks',1)))) <> r
    or (select count(*) from public.settlements where event_id=eid)<>1
    or (select count(*) from public.transfers where settlement_id=sid)<>3 then
    raise exception 'settle retry duplicated'; end if;
  if public.settlement_action(repeat('a',64),'settle',jsonb_build_object(
    'eventId',eid,'eventVersion',1,'requestId',rid))->>'error' is distinct from 'request_conflict' then
    raise exception 'settle request mismatch'; end if;
  if public.expense_action(repeat('a',64),'create',jsonb_build_object('eventId',eid,
    'requestId',gen_random_uuid(),'title','Поздний','amountKopecks',1,'memberIds',jsonb_build_array(a)))->>'error'
    is distinct from 'event_locked' then raise exception 'expense not locked'; end if;
  if public.event_action(repeat('a',64),'rotate',jsonb_build_object('eventId',eid,
    'invitationHash',repeat('1',64)))->>'error' is distinct from 'event_locked' then raise exception 'invite not locked'; end if;
  if public.event_action(repeat('e',64),'join',jsonb_build_object('invitationHash',repeat('2',64)))->>'error'
    is distinct from 'event_locked' then raise exception 'join not locked'; end if;
  if public.event_action(repeat('g',64),'leave',jsonb_build_object('eventId',eid))->>'error'
    is distinct from 'unauthorized' then raise exception 'unknown session semantics'; end if;
  if public.event_action(repeat('d',64),'leave',jsonb_build_object('eventId',eid))->>'error'
    is distinct from 'event_locked' then raise exception 'leave not locked'; end if;
  if public.settlement_action(repeat('b',64),'cancel',jsonb_build_object(
    'eventId',eid,'eventVersion',2,'requestId',gen_random_uuid()))->>'error'
    is distinct from 'forbidden' then raise exception 'member cancelled'; end if;
  if public.settlement_action(repeat('a',64),'cancel',jsonb_build_object(
    'eventId',eid,'eventVersion',1,'requestId',gen_random_uuid()))->>'error'
    is distinct from 'version_conflict' then raise exception 'stale cancel'; end if;
  r := public.settlement_action(repeat('a',64),'cancel',jsonb_build_object(
    'eventId',eid,'eventVersion',2,'requestId',cancel_rid));
  if r ? 'error' or (select status from public.events where id=eid)<>'draft'
    or (select active from public.settlements where id=sid)
    or exists(select 1 from public.transfers where settlement_id=sid and active) then
    raise exception 'cancel failed %',r; end if;
  if public.settlement_action(repeat('a',64),'cancel',jsonb_build_object(
    'eventId',eid,'eventVersion',2,'requestId',cancel_rid))<>r
    or (select count(*) from public.settlement_audit_log where settlement_id=sid)<>2 then
    raise exception 'cancel retry duplicated'; end if;
  update public.expenses set title='Изменено после отмены' where id=x1;
  if (select title from public.settlement_expenses where settlement_id=sid and expense_id=x1)<>'Аня платит' then
    raise exception 'snapshot mutated with expense'; end if;
  if public.event_action(repeat('a',64),'rotate',jsonb_build_object('eventId',eid,
    'invitationHash',repeat('1',64)))->>'ok' is distinct from 'true' then raise exception 'invite not restored'; end if;

  -- No expenses: every participant is present with zero balance and no transfers.
  r := public.settlement_action(repeat('a',64),'settle',jsonb_build_object(
    'eventId',empty_eid,'eventVersion',1,'requestId',gen_random_uuid()));
  sid := (r->'settlement'->>'id')::uuid;
  if sid is null or (select count(*) from public.settlement_balances where settlement_id=sid and balance_kopecks=0)<>1
    or exists(select 1 from public.transfers where settlement_id=sid) then raise exception 'empty event'; end if;

  -- Kopeck remainders remain exact through balances and transfers.
  insert into public.expenses(id,event_id,author_id,title,amount_kopecks)
    values(penny_x,penny_eid,a,'101 копейка',101);
  insert into public.expense_shares(event_id,expense_id,user_id,amount_kopecks) values
    (penny_eid,penny_x,a,34),(penny_eid,penny_x,b,34),(penny_eid,penny_x,v,33);
  set constraints all immediate;
  r := public.settlement_action(repeat('a',64),'settle',jsonb_build_object(
    'eventId',penny_eid,'eventVersion',1,'requestId',gen_random_uuid()));
  sid := (r->'settlement'->>'id')::uuid;
  if (select array_agg(balance_kopecks order by user_id) from public.settlement_balances where settlement_id=sid)
      <> array[67::bigint,-34,-33]
    or (select array_agg(amount_kopecks order by sequence) from public.transfers where settlement_id=sid)
      <> array[34::bigint,33] then raise exception 'kopeck settlement'; end if;

  -- Expenses may exist while every member still has a zero balance.
  set constraints all deferred;
  insert into public.expenses(id,event_id,author_id,title,amount_kopecks)
    values(zero_x,zero_eid,a,'Своя доля',12345);
  insert into public.expense_shares(event_id,expense_id,user_id,amount_kopecks)
    values(zero_eid,zero_x,a,12345);
  set constraints all immediate;
  r := public.settlement_action(repeat('a',64),'settle',jsonb_build_object(
    'eventId',zero_eid,'eventVersion',1,'requestId',gen_random_uuid()));
  sid := (r->'settlement'->>'id')::uuid;
  if exists(select 1 from public.settlement_balances where settlement_id=sid and balance_kopecks<>0)
    or exists(select 1 from public.transfers where settlement_id=sid) then raise exception 'all-zero event'; end if;

  -- Equal debts and credits use ascending stable UUID order.
  set constraints all deferred;
  insert into public.expenses(id,event_id,author_id,title,amount_kopecks) values
    (tx1,tie_eid,a,'A за Веру',10000),(tx2,tie_eid,b,'Б за Глеба',10000);
  insert into public.expense_shares(event_id,expense_id,user_id,amount_kopecks) values
    (tie_eid,tx1,v,10000),(tie_eid,tx2,g,10000);
  set constraints all immediate;
  r := public.settlement_action(repeat('a',64),'settle',jsonb_build_object(
    'eventId',tie_eid,'eventVersion',1,'requestId',gen_random_uuid()));
  sid := (r->'settlement'->>'id')::uuid;
  if (select array_agg(sender_id::text||'>'||receiver_id::text order by sequence)
      from public.transfers where settlement_id=sid)
    <> array[v::text||'>'||a::text,g::text||'>'||b::text] then raise exception 'unstable ties'; end if;

  -- Stage 6 foundation: once a transfer is marked sent, cancellation is denied.
  update public.transfers set status='sent',sent_at=clock_timestamp() where settlement_id=sid and sequence=1;
  if public.settlement_action(repeat('a',64),'cancel',jsonb_build_object(
    'eventId',tie_eid,'eventVersion',2,'requestId',gen_random_uuid()))->>'error'
    is distinct from 'transfers_started' then raise exception 'cancel after send'; end if;

  update public.app_sessions set expires_at=clock_timestamp()-interval '1 second' where token_hash=repeat('a',64);
  if public.settlement_action(repeat('a',64),'get',jsonb_build_object('eventId',eid))->>'error'
    is distinct from 'unauthorized' then raise exception 'expired session'; end if;
end $$;
reset role;
select pass('settlements: snapshots, balances, deterministic transfers, rights, versions, retries, locks and cancellation');
select * from finish();
rollback;
