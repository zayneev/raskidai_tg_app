alter table public.settlements add column transfers_started_at timestamptz;
alter table public.transfers add column not_received_at timestamptz;
alter table public.transfers add constraint transfers_settlement_id_id_key unique (settlement_id, id);

-- Preserve an irreversible marker if stage 5 data was ever advanced manually.
update public.settlements s set transfers_started_at = q.started_at
from (
  select settlement_id, min(coalesce(sent_at, created_at)) started_at
  from public.transfers
  where status <> 'pending' or sent_at is not null
  group by settlement_id
) q where q.settlement_id = s.id;

create table public.transfer_requests (
  event_id uuid not null references public.events(id) on delete restrict,
  actor_id uuid not null references public.users(id),
  request_id uuid not null,
  payload jsonb not null,
  response jsonb not null,
  created_at timestamptz not null default clock_timestamp(),
  primary key (event_id, actor_id, request_id)
);
create index transfer_requests_actor_idx on public.transfer_requests(actor_id);

create table public.transfer_status_history (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null,
  settlement_id uuid not null,
  transfer_id uuid not null,
  actor_id uuid not null references public.users(id),
  action text not null check (action in ('sent', 'confirmed', 'not_received')),
  status_before text not null check (status_before in ('pending','sent','confirmed','not_received')),
  status_after text not null check (status_after in ('pending','sent','confirmed','not_received')),
  occurred_at timestamptz not null default clock_timestamp(),
  foreign key (event_id, settlement_id) references public.settlements(event_id, id) on delete restrict,
  foreign key (settlement_id, transfer_id) references public.transfers(settlement_id, id) on delete restrict,
  check (
    (action = 'sent' and status_before in ('pending','not_received') and status_after = 'sent')
    or (action = 'confirmed' and status_before = 'sent' and status_after = 'confirmed')
    or (action = 'not_received' and status_before = 'sent' and status_after = 'not_received')
  )
);
create index transfer_status_history_event_time_idx
  on public.transfer_status_history(event_id, occurred_at, id);
create index transfer_status_history_transfer_time_idx
  on public.transfer_status_history(settlement_id, transfer_id, occurred_at, id);
create index transfer_status_history_actor_idx on public.transfer_status_history(actor_id);

alter table public.transfer_requests enable row level security;
alter table public.transfer_status_history enable row level security;
revoke all on public.transfer_requests, public.transfer_status_history from public, anon, authenticated, service_role;
grant select, insert on public.transfer_requests, public.transfer_status_history to service_role;

alter table public.settlement_audit_log drop constraint settlement_audit_log_action_check;
alter table public.settlement_audit_log add constraint settlement_audit_log_action_check
  check (action in ('settle','cancel','complete'));

create or replace function public.protect_settlement_immutable() returns trigger
language plpgsql security invoker set search_path = '' as $$
begin
  if old.id <> new.id or old.event_id <> new.event_id
    or old.source_event_version <> new.source_event_version
    or old.created_by <> new.created_by or old.created_at <> new.created_at
    or (old.transfers_started_at is not null
      and new.transfers_started_at is distinct from old.transfers_started_at) then
    raise exception 'immutable settlement snapshot' using errcode = '23514';
  end if;
  return new;
end $$;

create or replace function public.settlement_result(p_id uuid) returns jsonb
language sql security invoker set search_path = '' as $$
  select jsonb_build_object(
    'id', s.id,
    'eventId', s.event_id,
    'sourceEventVersion', s.source_event_version,
    'active', s.active,
    'createdAt', s.created_at,
    'cancelledAt', s.cancelled_at,
    'transfersStartedAt', s.transfers_started_at,
    'balances', coalesce((
      select jsonb_agg(jsonb_build_object(
        'userId', b.user_id, 'displayName', b.display_name,
        'paidKopecks', b.paid_kopecks, 'shareKopecks', b.share_kopecks,
        'balanceKopecks', b.balance_kopecks) order by b.user_id)
      from public.settlement_balances b where b.settlement_id=s.id
    ), '[]'::jsonb),
    'transfers', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', t.id, 'sequence', t.sequence, 'senderId', t.sender_id,
        'senderName', sb.display_name, 'receiverId', t.receiver_id,
        'receiverName', rb.display_name, 'amountKopecks', t.amount_kopecks,
        'status', t.status, 'active', t.active, 'sentAt', t.sent_at,
        'confirmedAt', t.confirmed_at, 'notReceivedAt', t.not_received_at)
        order by t.sequence)
      from public.transfers t
      join public.settlement_balances sb on sb.settlement_id=t.settlement_id and sb.user_id=t.sender_id
      join public.settlement_balances rb on rb.settlement_id=t.settlement_id and rb.user_id=t.receiver_id
      where t.settlement_id=s.id
    ), '[]'::jsonb)
  ) from public.settlements s where s.id=p_id;
$$;

create function public.transfer_action(p_token_hash text, p_action text, p_data jsonb default '{}')
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  uid uuid; eid uuid; tid uuid; rid uuid; sid uuid; expected_version integer;
  ev public.events; st public.settlements; tr public.transfers;
  prior public.transfer_requests; payload jsonb; result jsonb;
  before_status text; transition_at timestamptz; actor_name text; changed boolean := false;
begin
  select user_id into uid from public.app_sessions
    where token_hash=p_token_hash and expires_at>clock_timestamp() for share;
  if uid is null then return jsonb_build_object('error','unauthorized'); end if;
  if p_action is null or p_action not in ('send','confirm','not_received') then
    return jsonb_build_object('error','invalid_action'); end if;
  if coalesce(p_data->>'eventId','') !~ '^[a-fA-F0-9-]{36}$'
    or coalesce(p_data->>'transferId','') !~ '^[a-fA-F0-9-]{36}$'
    or coalesce(p_data->>'requestId','') !~ '^[a-fA-F0-9-]{36}$'
    or jsonb_typeof(p_data->'eventVersion') is distinct from 'number'
    or trunc((p_data->>'eventVersion')::numeric) <> (p_data->>'eventVersion')::numeric
    or (p_data->>'eventVersion')::numeric not between 1 and 2147483647 then
    return jsonb_build_object('error','invalid_input'); end if;
  eid := (p_data->>'eventId')::uuid;
  tid := (p_data->>'transferId')::uuid;
  rid := (p_data->>'requestId')::uuid;
  expected_version := (p_data->>'eventVersion')::integer;

  -- Shared global order: session -> event -> active settlement -> transfer.
  select * into ev from public.events where id=eid for update;
  if not exists(select 1 from public.app_sessions
    where token_hash=p_token_hash and expires_at>clock_timestamp()) then
    return jsonb_build_object('error','unauthorized'); end if;
  if ev.id is null or not exists(select 1 from public.members where event_id=eid and user_id=uid) then
    return jsonb_build_object('error','not_found'); end if;

  payload := jsonb_build_object('action',p_action,'data',p_data - 'requestId');
  select * into prior from public.transfer_requests
    where event_id=eid and actor_id=uid and request_id=rid;
  if found then
    if prior.payload <> payload then return jsonb_build_object('error','request_conflict'); end if;
    return prior.response;
  end if;
  if ev.version <> expected_version then return jsonb_build_object('error','version_conflict'); end if;

  select * into st from public.settlements where event_id=eid and active for update;
  if not exists(select 1 from public.app_sessions
    where token_hash=p_token_hash and expires_at>clock_timestamp()) then
    return jsonb_build_object('error','unauthorized'); end if;
  if st.id is null then return jsonb_build_object('error','transfer_unavailable'); end if;
  sid := st.id;
  select * into tr from public.transfers
    where settlement_id=sid and id=tid and active for update;
  if not exists(select 1 from public.app_sessions
    where token_hash=p_token_hash and expires_at>clock_timestamp()) then
    return jsonb_build_object('error','unauthorized'); end if;
  if tr.id is null then return jsonb_build_object('error','transfer_unavailable'); end if;
  if ev.status <> 'settled' then return jsonb_build_object('error','event_locked'); end if;

  if p_action='send' then
    if uid <> tr.sender_id then return jsonb_build_object('error','forbidden'); end if;
    if tr.status='confirmed' then return jsonb_build_object('error','invalid_transition'); end if;
    if tr.status not in ('pending','not_received','sent') then
      return jsonb_build_object('error','invalid_transition'); end if;
    changed := tr.status <> 'sent';
  else
    if uid <> tr.receiver_id then return jsonb_build_object('error','forbidden'); end if;
    if p_action='confirm' then
      if tr.status not in ('sent','confirmed') then
        return jsonb_build_object('error','invalid_transition'); end if;
      changed := tr.status <> 'confirmed';
    else
      if tr.status not in ('sent','not_received') then
        return jsonb_build_object('error','invalid_transition'); end if;
      changed := tr.status <> 'not_received';
    end if;
  end if;

  if changed then
    before_status := tr.status;
    transition_at := clock_timestamp();
    if p_action='send' then
      update public.transfers set status='sent',sent_at=transition_at,
        confirmed_at=null,not_received_at=null where id=tid;
      update public.settlements set transfers_started_at=coalesce(transfers_started_at,transition_at)
        where id=sid;
    elsif p_action='confirm' then
      update public.transfers set status='confirmed',confirmed_at=transition_at where id=tid;
    else
      update public.transfers set status='not_received',not_received_at=transition_at where id=tid;
    end if;
    select display_name into actor_name from public.users where id=uid;
    insert into public.transfer_status_history(
      event_id,settlement_id,transfer_id,actor_id,action,status_before,status_after,occurred_at)
    values(eid,sid,tid,uid,
      case p_action when 'send' then 'sent' when 'confirm' then 'confirmed' else p_action end,
      before_status,
      case p_action when 'send' then 'sent' when 'confirm' then 'confirmed' else 'not_received' end,
      transition_at);
    update public.events set version=version+1 where id=eid;
    ev.version := ev.version + 1;
    if p_action='confirm' and not exists(
      select 1 from public.transfers where settlement_id=sid and active and status<>'confirmed'
    ) then
      update public.events set status='completed' where id=eid;
      ev.status := 'completed';
      insert into public.settlement_audit_log(event_id,settlement_id,actor_id,actor_name,action,data)
        values(eid,sid,uid,actor_name,'complete',jsonb_build_object(
          'eventVersion',ev.version,'reason','all_transfers_confirmed'));
    end if;
  end if;

  select * into tr from public.transfers where id=tid;
  result := jsonb_build_object(
    'ok',true,'eventVersion',ev.version,'eventStatus',ev.status,
    'transfer',jsonb_build_object(
      'id',tr.id,'status',tr.status,'sentAt',tr.sent_at,
      'confirmedAt',tr.confirmed_at,'notReceivedAt',tr.not_received_at));
  insert into public.transfer_requests(event_id,actor_id,request_id,payload,response)
    values(eid,uid,rid,payload,result);
  return result;
exception when invalid_text_representation or numeric_value_out_of_range then
  return jsonb_build_object('error','invalid_input');
end $$;
revoke all on function public.transfer_action(text,text,jsonb) from public, anon, authenticated;
grant execute on function public.transfer_action(text,text,jsonb) to service_role;

-- Stage 5 cancellation now checks an irreversible marker (and history as defense
-- in depth), never only the current transfer status.
create or replace function public.settlement_action(p_token_hash text, p_action text, p_data jsonb default '{}')
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  uid uuid; eid uuid; rid uuid; sid uuid; expected_version integer;
  ev public.events; prior public.settlement_requests; payload jsonb; result jsonb;
  debtor uuid; creditor uuid; debt bigint; credit bigint; payment bigint;
  transfer_number integer := 0; nonzero_count integer; actor_name text;
begin
  select user_id into uid from public.app_sessions
    where token_hash=p_token_hash and expires_at>clock_timestamp() for share;
  if uid is null then return jsonb_build_object('error','unauthorized'); end if;
  if p_action is null or p_action not in ('get','settle','cancel') then
    return jsonb_build_object('error','invalid_action'); end if;
  eid := (p_data->>'eventId')::uuid;
  select * into ev from public.events where id=eid for update;
  if not exists(select 1 from public.app_sessions
    where token_hash=p_token_hash and expires_at>clock_timestamp()) then
    return jsonb_build_object('error','unauthorized'); end if;
  if ev.id is null or not exists(select 1 from public.members where event_id=eid and user_id=uid) then
    return jsonb_build_object('error','not_found'); end if;
  if p_action='get' then
    select id into sid from public.settlements where event_id=eid and active;
    return jsonb_build_object('settlement',case when sid is null then null else public.settlement_result(sid) end);
  end if;
  if uid<>ev.creator_id then return jsonb_build_object('error','forbidden'); end if;
  if coalesce(p_data->>'requestId','') !~ '^[a-fA-F0-9-]{36}$'
    or jsonb_typeof(p_data->'eventVersion') is distinct from 'number'
    or trunc((p_data->>'eventVersion')::numeric)<>(p_data->>'eventVersion')::numeric
    or (p_data->>'eventVersion')::numeric not between 1 and 2147483647 then
    return jsonb_build_object('error','invalid_input'); end if;
  rid := (p_data->>'requestId')::uuid;
  expected_version := (p_data->>'eventVersion')::integer;
  payload := jsonb_build_object('action',p_action,'data',p_data-'requestId');
  select * into prior from public.settlement_requests
    where event_id=eid and actor_id=uid and request_id=rid;
  if found then
    if prior.payload<>payload then return jsonb_build_object('error','request_conflict'); end if;
    return prior.response;
  end if;
  if ev.version<>expected_version then return jsonb_build_object('error','version_conflict'); end if;
  select display_name into actor_name from public.users where id=uid;

  if p_action='settle' then
    if ev.status<>'draft' then return jsonb_build_object('error','event_locked'); end if;
    insert into public.settlements(event_id,source_event_version,created_by)
      values(eid,ev.version,uid) returning id into sid;
    insert into public.settlement_balances(
      settlement_id,event_id,user_id,display_name,paid_kopecks,share_kopecks,balance_kopecks)
    select sid,eid,m.user_id,u.display_name,coalesce(p.paid,0),coalesce(sh.share,0),
      coalesce(p.paid,0)-coalesce(sh.share,0)
    from public.members m join public.users u on u.id=m.user_id
    left join (select author_id,sum(amount_kopecks)::bigint paid from public.expenses
      where event_id=eid group by author_id) p on p.author_id=m.user_id
    left join (select user_id,sum(amount_kopecks)::bigint share from public.expense_shares
      where event_id=eid group by user_id) sh on sh.user_id=m.user_id
    where m.event_id=eid;
    if (select coalesce(sum(balance_kopecks),0) from public.settlement_balances where settlement_id=sid)<>0 then
      raise exception 'settlement balances do not sum to zero' using errcode='23514'; end if;
    insert into public.settlement_expenses(
      settlement_id,event_id,expense_id,author_id,author_name,title,amount_kopecks,
      expense_version,created_at,updated_at)
    select sid,eid,e.id,e.author_id,u.display_name,e.title,e.amount_kopecks,
      e.version,e.created_at,e.updated_at
    from public.expenses e join public.users u on u.id=e.author_id where e.event_id=eid;
    insert into public.settlement_shares(settlement_id,expense_id,user_id,display_name,amount_kopecks)
    select sid,sh.expense_id,sh.user_id,u.display_name,sh.amount_kopecks
    from public.expense_shares sh join public.users u on u.id=sh.user_id where sh.event_id=eid;
    loop
      select b.user_id,b.balance_kopecks+coalesce(sum(t.amount_kopecks)
        filter(where t.sender_id=b.user_id),0)::bigint into debtor,debt
      from public.settlement_balances b left join public.transfers t
        on t.settlement_id=b.settlement_id and t.sender_id=b.user_id
      where b.settlement_id=sid group by b.user_id,b.balance_kopecks
      having b.balance_kopecks+coalesce(sum(t.amount_kopecks)
        filter(where t.sender_id=b.user_id),0)<0 order by 2 asc,b.user_id asc limit 1;
      exit when debtor is null;
      select b.user_id,b.balance_kopecks-coalesce(sum(t.amount_kopecks)
        filter(where t.receiver_id=b.user_id),0)::bigint into creditor,credit
      from public.settlement_balances b left join public.transfers t
        on t.settlement_id=b.settlement_id and t.receiver_id=b.user_id
      where b.settlement_id=sid group by b.user_id,b.balance_kopecks
      having b.balance_kopecks-coalesce(sum(t.amount_kopecks)
        filter(where t.receiver_id=b.user_id),0)>0 order by 2 desc,b.user_id asc limit 1;
      if creditor is null then raise exception 'unmatched settlement credit' using errcode='23514'; end if;
      payment:=least(-debt,credit); transfer_number:=transfer_number+1;
      insert into public.transfers(settlement_id,sequence,sender_id,receiver_id,amount_kopecks)
        values(sid,transfer_number,debtor,creditor,payment);
      if transfer_number>29 then raise exception 'too many transfers' using errcode='23514'; end if;
    end loop;
    if exists(select 1 from public.settlement_balances b where b.settlement_id=sid and
      b.balance_kopecks
        +coalesce((select sum(t.amount_kopecks) from public.transfers t where t.settlement_id=sid and t.sender_id=b.user_id),0)
        -coalesce((select sum(t.amount_kopecks) from public.transfers t where t.settlement_id=sid and t.receiver_id=b.user_id),0)<>0)
      then raise exception 'settlement did not close balances' using errcode='23514'; end if;
    select count(*) into nonzero_count from public.settlement_balances where settlement_id=sid and balance_kopecks<>0;
    if transfer_number>greatest(nonzero_count-1,0) then
      raise exception 'too many settlement transfers' using errcode='23514'; end if;
    update public.events set status=case when transfer_number=0 then 'completed' else 'settled' end,
      version=version+1 where id=eid;
    result:=jsonb_build_object('ok',true,'eventVersion',ev.version+1,
      'eventStatus',case when transfer_number=0 then 'completed' else 'settled' end,
      'settlement',public.settlement_result(sid));
    insert into public.settlement_audit_log(event_id,settlement_id,actor_id,actor_name,action,data)
      values(eid,sid,uid,actor_name,'settle',result->'settlement');
    if transfer_number=0 then
      insert into public.settlement_audit_log(event_id,settlement_id,actor_id,actor_name,action,data)
        values(eid,sid,uid,actor_name,'complete',jsonb_build_object(
          'eventVersion',ev.version+1,'reason','no_transfers'));
    end if;
  else
    if ev.status='completed' then return jsonb_build_object('error','event_locked'); end if;
    if ev.status<>'settled' then return jsonb_build_object('error','event_locked'); end if;
    select id into sid from public.settlements where event_id=eid and active for update;
    if sid is null then return jsonb_build_object('error','not_found'); end if;
    if not exists(select 1 from public.app_sessions
      where token_hash=p_token_hash and expires_at>clock_timestamp()) then
      return jsonb_build_object('error','unauthorized'); end if;
    if exists(select 1 from public.settlements where id=sid and transfers_started_at is not null)
      or exists(select 1 from public.transfer_status_history where settlement_id=sid and action='sent')
      or exists(select 1 from public.transfers where settlement_id=sid
        and (status<>'pending' or sent_at is not null)) then
      return jsonb_build_object('error','transfers_started'); end if;
    update public.transfers set active=false where settlement_id=sid and active;
    update public.settlements set active=false,cancelled_at=clock_timestamp(),cancelled_by=uid where id=sid;
    update public.events set status='draft',version=version+1 where id=eid;
    result:=jsonb_build_object('ok',true,'eventVersion',ev.version+1,'settlementId',sid);
    insert into public.settlement_audit_log(event_id,settlement_id,actor_id,actor_name,action,data)
      values(eid,sid,uid,actor_name,'cancel',jsonb_build_object('eventVersion',ev.version+1));
  end if;
  insert into public.settlement_requests(event_id,actor_id,request_id,payload,response)
    values(eid,uid,rid,payload,result);
  return result;
exception when invalid_text_representation or numeric_value_out_of_range then
  return jsonb_build_object('error','invalid_input');
end $$;

-- Bring previously active zero-transfer settlements to the stage 6 terminal state.
with completed as (
  update public.events e set status='completed',version=version+1
  from public.settlements s
  where s.event_id=e.id and s.active and e.status='settled'
    and not exists(select 1 from public.transfers t where t.settlement_id=s.id and t.active)
  returning e.id event_id,e.version,s.id settlement_id,s.created_by actor_id
)
insert into public.settlement_audit_log(event_id,settlement_id,actor_id,actor_name,action,data)
select c.event_id,c.settlement_id,c.actor_id,u.display_name,'complete',
  jsonb_build_object('eventVersion',c.version,'reason','stage6_zero_transfer_migration')
from completed c join public.users u on u.id=c.actor_id;
