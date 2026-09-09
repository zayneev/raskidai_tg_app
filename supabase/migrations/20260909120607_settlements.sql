create table public.settlements (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id) on delete restrict,
  source_event_version integer not null check (source_event_version > 0),
  created_by uuid not null references public.users(id),
  active boolean not null default true,
  created_at timestamptz not null default clock_timestamp(),
  cancelled_at timestamptz,
  cancelled_by uuid references public.users(id),
  unique (event_id, id),
  check ((active and cancelled_at is null and cancelled_by is null)
    or (not active and cancelled_at is not null and cancelled_by is not null))
);
create unique index settlements_one_active_idx on public.settlements(event_id) where active;
create index settlements_creator_idx on public.settlements(created_by);
create index settlements_cancelled_by_idx on public.settlements(cancelled_by) where cancelled_by is not null;

create table public.settlement_balances (
  settlement_id uuid not null,
  event_id uuid not null,
  user_id uuid not null references public.users(id),
  display_name text not null,
  paid_kopecks bigint not null check (paid_kopecks >= 0),
  share_kopecks bigint not null check (share_kopecks >= 0),
  balance_kopecks bigint not null,
  primary key (settlement_id, user_id),
  foreign key (event_id, settlement_id) references public.settlements(event_id, id) on delete restrict,
  check (balance_kopecks = paid_kopecks - share_kopecks)
);
create index settlement_balances_event_idx on public.settlement_balances(event_id, settlement_id);

create table public.settlement_expenses (
  settlement_id uuid not null,
  event_id uuid not null,
  expense_id uuid not null,
  author_id uuid not null,
  author_name text not null,
  title text not null,
  amount_kopecks bigint not null check (amount_kopecks > 0),
  expense_version integer not null check (expense_version > 0),
  created_at timestamptz not null,
  updated_at timestamptz not null,
  primary key (settlement_id, expense_id),
  foreign key (event_id, settlement_id) references public.settlements(event_id, id) on delete restrict,
  foreign key (settlement_id, author_id) references public.settlement_balances(settlement_id, user_id) on delete restrict
);
create index settlement_expenses_event_idx on public.settlement_expenses(event_id, settlement_id);

create table public.settlement_shares (
  settlement_id uuid not null,
  expense_id uuid not null,
  user_id uuid not null,
  display_name text not null,
  amount_kopecks bigint not null check (amount_kopecks >= 0),
  primary key (settlement_id, expense_id, user_id),
  foreign key (settlement_id, expense_id) references public.settlement_expenses(settlement_id, expense_id) on delete restrict,
  foreign key (settlement_id, user_id) references public.settlement_balances(settlement_id, user_id) on delete restrict
);

create table public.transfers (
  id uuid primary key default gen_random_uuid(),
  settlement_id uuid not null,
  sequence integer not null check (sequence > 0),
  sender_id uuid not null,
  receiver_id uuid not null,
  amount_kopecks bigint not null check (amount_kopecks > 0),
  status text not null default 'pending' check (status in ('pending','sent','confirmed','not_received')),
  active boolean not null default true,
  sent_at timestamptz,
  confirmed_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  unique (settlement_id, sequence),
  foreign key (settlement_id, sender_id) references public.settlement_balances(settlement_id, user_id) on delete restrict,
  foreign key (settlement_id, receiver_id) references public.settlement_balances(settlement_id, user_id) on delete restrict,
  check (sender_id <> receiver_id)
);
create index transfers_sender_idx on public.transfers(sender_id, settlement_id);
create index transfers_receiver_idx on public.transfers(receiver_id, settlement_id);

create table public.settlement_requests (
  event_id uuid not null references public.events(id) on delete restrict,
  actor_id uuid not null references public.users(id),
  request_id uuid not null,
  payload jsonb not null,
  response jsonb not null,
  created_at timestamptz not null default clock_timestamp(),
  primary key (event_id, actor_id, request_id)
);
create index settlement_requests_actor_idx on public.settlement_requests(actor_id);

create table public.settlement_audit_log (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id) on delete restrict,
  settlement_id uuid not null references public.settlements(id) on delete restrict,
  actor_id uuid not null references public.users(id),
  actor_name text not null,
  action text not null check (action in ('settle','cancel')),
  data jsonb not null,
  created_at timestamptz not null default clock_timestamp()
);
create index settlement_audit_event_time_idx on public.settlement_audit_log(event_id, created_at, id);
create index settlement_audit_actor_idx on public.settlement_audit_log(actor_id);
create index settlement_audit_settlement_idx on public.settlement_audit_log(settlement_id);

alter table public.settlements enable row level security;
alter table public.settlement_balances enable row level security;
alter table public.settlement_expenses enable row level security;
alter table public.settlement_shares enable row level security;
alter table public.transfers enable row level security;
alter table public.settlement_requests enable row level security;
alter table public.settlement_audit_log enable row level security;
revoke all on public.settlements, public.settlement_balances, public.settlement_expenses,
  public.settlement_shares, public.transfers, public.settlement_requests,
  public.settlement_audit_log from public, anon, authenticated;
grant select, insert, update on public.settlements, public.transfers to service_role;
grant select, insert on public.settlement_balances, public.settlement_expenses,
  public.settlement_shares, public.settlement_requests, public.settlement_audit_log to service_role;

-- Snapshot identity and money are immutable. Stage 6 may only change transfer state/timestamps.
create function public.protect_settlement_immutable() returns trigger
language plpgsql security invoker set search_path = '' as $$
begin
  if old.id <> new.id or old.event_id <> new.event_id
    or old.source_event_version <> new.source_event_version
    or old.created_by <> new.created_by or old.created_at <> new.created_at then
    raise exception 'immutable settlement snapshot' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger settlements_immutable before update on public.settlements
  for each row execute function public.protect_settlement_immutable();

create function public.protect_transfer_immutable() returns trigger
language plpgsql security invoker set search_path = '' as $$
begin
  if old.id <> new.id or old.settlement_id <> new.settlement_id
    or old.sequence <> new.sequence or old.sender_id <> new.sender_id
    or old.receiver_id <> new.receiver_id or old.amount_kopecks <> new.amount_kopecks
    or old.created_at <> new.created_at then
    raise exception 'immutable transfer calculation' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger transfers_immutable before update on public.transfers
  for each row execute function public.protect_transfer_immutable();
revoke all on function public.protect_settlement_immutable() from public, anon, authenticated;
revoke all on function public.protect_transfer_immutable() from public, anon, authenticated;
grant execute on function public.protect_settlement_immutable() to service_role;
grant execute on function public.protect_transfer_immutable() to service_role;

create function public.settlement_result(p_id uuid) returns jsonb
language sql security invoker set search_path = '' as $$
  select jsonb_build_object(
    'id', s.id,
    'eventId', s.event_id,
    'sourceEventVersion', s.source_event_version,
    'active', s.active,
    'createdAt', s.created_at,
    'cancelledAt', s.cancelled_at,
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
        'status', t.status, 'active', t.active) order by t.sequence)
      from public.transfers t
      join public.settlement_balances sb on sb.settlement_id=t.settlement_id and sb.user_id=t.sender_id
      join public.settlement_balances rb on rb.settlement_id=t.settlement_id and rb.user_id=t.receiver_id
      where t.settlement_id=s.id
    ), '[]'::jsonb)
  ) from public.settlements s where s.id=p_id;
$$;
revoke all on function public.settlement_result(uuid) from public, anon, authenticated;
grant execute on function public.settlement_result(uuid) to service_role;

create function public.settlement_action(p_token_hash text, p_action text, p_data jsonb default '{}')
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
  -- Same lock and order as participant and expense writes.
  select * into ev from public.events where id=eid for update;
  -- A session can expire or be revoked while this call waits for the event lock.
  if not exists(select 1 from public.app_sessions
    where token_hash=p_token_hash and expires_at>clock_timestamp()) then
    return jsonb_build_object('error','unauthorized'); end if;
  if ev.id is null or not exists(select 1 from public.members where event_id=eid and user_id=uid) then
    return jsonb_build_object('error','not_found'); end if;

  if p_action='get' then
    select id into sid from public.settlements where event_id=eid and active;
    return jsonb_build_object('settlement', case when sid is null then null else public.settlement_result(sid) end);
  end if;
  if uid <> ev.creator_id then return jsonb_build_object('error','forbidden'); end if;
  if coalesce(p_data->>'requestId','') !~ '^[a-fA-F0-9-]{36}$'
    or jsonb_typeof(p_data->'eventVersion') is distinct from 'number'
    or trunc((p_data->>'eventVersion')::numeric) <> (p_data->>'eventVersion')::numeric
    or (p_data->>'eventVersion')::numeric not between 1 and 2147483647 then
    return jsonb_build_object('error','invalid_input'); end if;
  rid := (p_data->>'requestId')::uuid;
  expected_version := (p_data->>'eventVersion')::integer;
  payload := jsonb_build_object('action',p_action,'data',p_data - 'requestId');
  select * into prior from public.settlement_requests
    where event_id=eid and actor_id=uid and request_id=rid;
  if found then
    if prior.payload <> payload then return jsonb_build_object('error','request_conflict'); end if;
    return prior.response;
  end if;
  if ev.version <> expected_version then return jsonb_build_object('error','version_conflict'); end if;
  select display_name into actor_name from public.users where id=uid;

  if p_action='settle' then
    if ev.status <> 'draft' then return jsonb_build_object('error','event_locked'); end if;
    insert into public.settlements(event_id,source_event_version,created_by)
      values(eid,ev.version,uid) returning id into sid;

    insert into public.settlement_balances(
      settlement_id,event_id,user_id,display_name,paid_kopecks,share_kopecks,balance_kopecks)
    select sid,eid,m.user_id,u.display_name,
      coalesce(p.paid,0),coalesce(sh.share,0),coalesce(p.paid,0)-coalesce(sh.share,0)
    from public.members m join public.users u on u.id=m.user_id
    left join (select author_id,sum(amount_kopecks)::bigint paid from public.expenses
      where event_id=eid group by author_id) p on p.author_id=m.user_id
    left join (select user_id,sum(amount_kopecks)::bigint share from public.expense_shares
      where event_id=eid group by user_id) sh on sh.user_id=m.user_id
    where m.event_id=eid;
    if (select coalesce(sum(balance_kopecks),0) from public.settlement_balances where settlement_id=sid) <> 0 then
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
      select b.user_id,
        b.balance_kopecks + coalesce(sum(t.amount_kopecks) filter (where t.sender_id=b.user_id),0)::bigint
      into debtor,debt
      from public.settlement_balances b
      left join public.transfers t on t.settlement_id=b.settlement_id and t.sender_id=b.user_id
      where b.settlement_id=sid
      group by b.user_id,b.balance_kopecks
      having b.balance_kopecks + coalesce(sum(t.amount_kopecks) filter (where t.sender_id=b.user_id),0) < 0
      order by 2 asc,b.user_id asc limit 1;
      exit when debtor is null;
      select b.user_id,
        b.balance_kopecks - coalesce(sum(t.amount_kopecks) filter (where t.receiver_id=b.user_id),0)::bigint
      into creditor,credit
      from public.settlement_balances b
      left join public.transfers t on t.settlement_id=b.settlement_id and t.receiver_id=b.user_id
      where b.settlement_id=sid
      group by b.user_id,b.balance_kopecks
      having b.balance_kopecks - coalesce(sum(t.amount_kopecks) filter (where t.receiver_id=b.user_id),0) > 0
      order by 2 desc,b.user_id asc limit 1;
      if creditor is null then raise exception 'unmatched settlement credit' using errcode='23514'; end if;
      payment := least(-debt,credit);
      transfer_number := transfer_number + 1;
      insert into public.transfers(settlement_id,sequence,sender_id,receiver_id,amount_kopecks)
        values(sid,transfer_number,debtor,creditor,payment);
      if transfer_number > 29 then raise exception 'too many transfers' using errcode='23514'; end if;
    end loop;
    if exists(
      select 1 from public.settlement_balances b where b.settlement_id=sid and
        b.balance_kopecks
          + coalesce((select sum(t.amount_kopecks) from public.transfers t where t.settlement_id=sid and t.sender_id=b.user_id),0)
          - coalesce((select sum(t.amount_kopecks) from public.transfers t where t.settlement_id=sid and t.receiver_id=b.user_id),0) <> 0
    ) then raise exception 'settlement did not close balances' using errcode='23514'; end if;
    select count(*) into nonzero_count from public.settlement_balances
      where settlement_id=sid and balance_kopecks<>0;
    if transfer_number > greatest(nonzero_count-1,0) then
      raise exception 'too many settlement transfers' using errcode='23514'; end if;

    update public.events set status='settled',version=version+1 where id=eid;
    result := jsonb_build_object('ok',true,'eventVersion',ev.version+1,
      'settlement',public.settlement_result(sid));
    insert into public.settlement_audit_log(event_id,settlement_id,actor_id,actor_name,action,data)
      values(eid,sid,uid,actor_name,'settle',result->'settlement');
  else
    if ev.status <> 'settled' then return jsonb_build_object('error','event_locked'); end if;
    select id into sid from public.settlements where event_id=eid and active for update;
    if sid is null then return jsonb_build_object('error','not_found'); end if;
    if exists(select 1 from public.transfers where settlement_id=sid and active
      and (status<>'pending' or sent_at is not null)) then
      return jsonb_build_object('error','transfers_started'); end if;
    update public.transfers set active=false where settlement_id=sid and active;
    update public.settlements set active=false,cancelled_at=clock_timestamp(),cancelled_by=uid where id=sid;
    update public.events set status='draft',version=version+1 where id=eid;
    result := jsonb_build_object('ok',true,'eventVersion',ev.version+1,'settlementId',sid);
    insert into public.settlement_audit_log(event_id,settlement_id,actor_id,actor_name,action,data)
      values(eid,sid,uid,actor_name,'cancel',jsonb_build_object('eventVersion',ev.version+1));
  end if;
  insert into public.settlement_requests(event_id,actor_id,request_id,payload,response)
    values(eid,uid,rid,payload,result);
  return result;
exception when invalid_text_representation or numeric_value_out_of_range then
  return jsonb_build_object('error','invalid_input');
end $$;
revoke all on function public.settlement_action(text,text,jsonb) from public, anon, authenticated;
grant execute on function public.settlement_action(text,text,jsonb) to service_role;
