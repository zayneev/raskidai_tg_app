begin;
create extension if not exists pgtap with schema extensions;
select plan(1);
set local role service_role;
do $$
declare
 a uuid; b uuid; c uuid; outsider uuid; eid uuid; eid2 uuid; xid uuid; req uuid := gen_random_uuid();
 d jsonb; r jsonb; original jsonb; table_name text; role_name text; operation text;
begin
 foreach table_name in array array['expenses','expense_shares','expense_requests','audit_log'] loop
   foreach role_name in array array['anon','authenticated'] loop
     foreach operation in array array['SELECT','INSERT','UPDATE','DELETE'] loop
       if has_table_privilege(role_name,'public.'||table_name,operation) then raise exception 'client privilege % %',role_name,table_name; end if;
     end loop;
   end loop;
   if not (select relrowsecurity from pg_class where oid=('public.'||table_name)::regclass) then raise exception 'RLS %',table_name; end if;
 end loop;
 if has_function_privilege('anon','public.expense_action(text,text,jsonb)','execute') or has_function_privilege('authenticated','public.expense_snapshot(uuid)','execute') then raise exception 'RPC public'; end if;
 if has_table_privilege('service_role','public.audit_log','UPDATE') or has_table_privilege('service_role','public.audit_log','DELETE') then raise exception 'mutable audit'; end if;
 a := (public.create_telegram_session(8100000000000001,'Expense creator',repeat('d',64))->'user'->>'id')::uuid;
 b := (public.create_telegram_session(8100000000000002,'Expense author',repeat('e',64))->'user'->>'id')::uuid;
 c := (public.create_telegram_session(8100000000000003,'Expense recipient',repeat('f',64))->'user'->>'id')::uuid;
 outsider := (public.create_telegram_session(8100000000000004,'Outsider',repeat('9',64))->'user'->>'id')::uuid;
 eid := (public.event_action(repeat('d',64),'create',jsonb_build_object('title','Expense test','description','','requestId',gen_random_uuid()))->>'eventId')::uuid;
 eid2 := (public.event_action(repeat('9',64),'create',jsonb_build_object('title','Other event','description','','requestId',gen_random_uuid()))->>'eventId')::uuid;
 insert into public.members(event_id,user_id) values(eid,b),(eid,c);
 if public.expense_action(repeat('0',64),'list',jsonb_build_object('eventId',eid))->>'error' is distinct from 'unauthorized' then raise exception 'unknown session'; end if;
 foreach operation in array array['list','history','create','update','delete'] loop
   if public.expense_action(repeat('9',64),operation,jsonb_build_object('eventId',eid))->>'error' is distinct from 'not_found' then raise exception 'outsider %',operation; end if;
 end loop;
 d := jsonb_build_object('eventId',eid,'title','Dinner','amountKopecks',101,'memberIds',jsonb_build_array(c,a,b),'requestId',req,'authorId',a);
 r := public.expense_action(repeat('e',64),'create',d); original:=r; xid:=(r->>'expenseId')::uuid;
 if xid is null then raise exception 'create %',r; end if;
 if (select author_id from public.expenses where id=xid) <> b then raise exception 'payer forged'; end if;
 if public.expense_action(repeat('e',64),'create',d) <> original or (select count(*) from public.audit_log where event_id=eid) <> 1 then raise exception 'retry duplicate'; end if;
 if public.expense_action(repeat('e',64),'create',d||'{"amountKopecks":102}')->>'error' is distinct from 'request_conflict' then raise exception 'request mismatch'; end if;
 if exists(select 1 from (select amount_kopecks,row_number() over(order by user_id) rn from public.expense_shares where expense_id=xid) q where amount_kopecks <> case when rn<=2 then 34 else 33 end) then raise exception 'stable rounding'; end if;
 -- Deferred constraints reject mismatched totals and empty share sets.
 begin
   update public.expense_shares set amount_kopecks=amount_kopecks+1 where expense_id=xid;
   set constraints all immediate;
   raise exception 'sum constraint missing';
 exception when check_violation then null; end;
 begin
   delete from public.expense_shares where expense_id=xid;
   set constraints all immediate;
   raise exception 'empty shares constraint missing';
 exception when check_violation then null; end;
 if public.event_action(repeat('e',64),'leave',jsonb_build_object('eventId',eid))->>'error' is distinct from 'member_has_expenses' then raise exception 'author leave'; end if;
 if public.event_action(repeat('f',64),'leave',jsonb_build_object('eventId',eid))->>'error' is distinct from 'member_has_expenses' then raise exception 'recipient leave'; end if;
 begin
   delete from public.members where event_id=eid and user_id=c;
   raise exception 'recipient FK absent';
 exception when foreign_key_violation then null; end;
 begin
   insert into public.expense_shares values(eid,xid,outsider,0);
   raise exception 'cross event member FK absent';
 exception when foreign_key_violation then null; end;
 begin
   insert into public.expense_shares values(eid2,xid,outsider,0);
   raise exception 'cross event expense FK absent';
 exception when foreign_key_violation then null; end;
 d := d||jsonb_build_object('expenseId',xid,'version',1,'requestId',gen_random_uuid());
 foreach operation in array array['update','delete'] loop
   if public.expense_action(repeat('f',64),operation,d)->>'error' is distinct from 'forbidden' then raise exception 'foreign expense %',operation; end if;
 end loop;
 -- Invalid inputs must not write anything.
 foreach r in array array['{"amountKopecks":0}'::jsonb,'{"amountKopecks":-1}','{"amountKopecks":1.01}','{"amountKopecks":100000000000}','{"amountKopecks":"100"}','{"memberIds":[]}','{"title":" "}','{"memberIds":null}',jsonb_build_object('memberIds',jsonb_build_array(a,a)),jsonb_build_object('memberIds',jsonb_build_array(outsider))] loop
   if public.expense_action(repeat('e',64),'update',d||r)->>'error' is distinct from 'invalid_input' then raise exception 'invalid accepted %',r; end if;
 end loop;
 if (select count(*) from public.audit_log where event_id=eid) <> 1 then raise exception 'failed update audit'; end if;
 -- Creator edits another member's expense; payer stays author and may be excluded.
 d:=d||jsonb_build_object('title','Changed','amountKopecks',1,'memberIds',jsonb_build_array(c,a));
 r:=public.expense_action(repeat('d',64),'update',d);
 if r ? 'error' then raise exception 'creator edit %',r; end if;
 if public.expense_action(repeat('d',64),'update',d) <> r then raise exception 'update retry'; end if;
 if (select version from public.expenses where id=xid)<>2 or (select author_id from public.expenses where id=xid)<>b or exists(select 1 from public.expense_shares where expense_id=xid and user_id=b) then raise exception 'update snapshot'; end if;
 if (select sum(amount_kopecks) from public.expense_shares where expense_id=xid)<>1 or (select count(*) from public.expense_shares where expense_id=xid and amount_kopecks=0)<>1 then raise exception 'small amount'; end if;
 if public.event_action(repeat('e',64),'leave',jsonb_build_object('eventId',eid))->>'error' is distinct from 'member_has_expenses' then raise exception 'excluded author leave'; end if;
 if public.expense_action(repeat('e',64),'update',d||jsonb_build_object('requestId',gen_random_uuid()))->>'error' is distinct from 'version_conflict' then raise exception 'stale update'; end if;
 d:=d||jsonb_build_object('version',2,'memberIds',jsonb_build_array(c),'requestId',gen_random_uuid());
 r:=public.expense_action(repeat('e',64),'update',d);
 if r ? 'error' or (select amount_kopecks from public.expense_shares where expense_id=xid)<>1 then raise exception 'own edit single recipient %',r; end if;
 update public.events set status='settled' where id=eid;
 foreach operation in array array['create','update','delete'] loop
   if public.expense_action(repeat('e',64),operation,d||jsonb_build_object('requestId',gen_random_uuid()))->>'error' is distinct from 'event_locked' then raise exception 'locked %',operation; end if;
 end loop;
 if jsonb_array_length(public.expense_action(repeat('f',64),'list',jsonb_build_object('eventId',eid))->'expenses')<>1 then raise exception 'read locked'; end if;
 update public.events set status='draft' where id=eid;
 d:=jsonb_build_object('eventId',eid,'expenseId',xid,'version',3,'requestId',gen_random_uuid());
 r:=public.expense_action(repeat('d',64),'delete',d);
 if r ? 'error' or exists(select 1 from public.expenses where id=xid) then raise exception 'delete %',r; end if;
 if public.expense_action(repeat('d',64),'delete',d)<>r then raise exception 'delete retry'; end if;
 if public.expense_action(repeat('e',64),'create',jsonb_build_object('eventId',eid,'title','Dinner','amountKopecks',101,'memberIds',jsonb_build_array(c,a,b),'requestId',req,'authorId',a))<>original or exists(select 1 from public.expenses where id=xid) then raise exception 'create retry resurrected'; end if;
 if (select count(*) from public.audit_log where event_id=eid)<>4 then raise exception 'audit count'; end if;
 if not exists(select 1 from public.audit_log where expense_id=xid and action='delete' and before_data->>'title'='Changed' and after_data is null) then raise exception 'delete history'; end if;
 if jsonb_array_length(public.expense_action(repeat('f',64),'history',jsonb_build_object('eventId',eid))->'history')<>4 then raise exception 'history read'; end if;
 if public.event_action(repeat('f',64),'leave',jsonb_build_object('eventId',eid))->>'ok' is distinct from 'true' then raise exception 'leave after deletion'; end if;
 if public.expense_action(repeat('f',64),'history',jsonb_build_object('eventId',eid))->>'error' is distinct from 'not_found' then raise exception 'history after leave'; end if;
 update public.app_sessions set expires_at=clock_timestamp()-interval '1 second' where token_hash=repeat('e',64);
 if public.expense_action(repeat('e',64),'list',jsonb_build_object('eventId',eid))->>'error' is distinct from 'unauthorized' then raise exception 'expired'; end if;
 perform public.revoke_app_session(repeat('d',64));
 if public.expense_action(repeat('d',64),'list',jsonb_build_object('eventId',eid))->>'error' is distinct from 'unauthorized' then raise exception 'revoked'; end if;
end $$;
set constraints all immediate;
reset role;
select pass('expenses: CRUD, exact shares, rights, FKs, history, retries, versions, locked state and sessions');
select * from finish();
rollback;
