create table public.expenses (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id) on delete restrict,
  author_id uuid not null,
  title text not null check (length(btrim(title)) between 1 and 120),
  amount_kopecks bigint not null check (amount_kopecks between 1 and 99999999999),
  version integer not null default 1 check (version > 0),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  unique (event_id, id),
  foreign key (event_id, author_id) references public.members(event_id, user_id) on delete restrict
);
create index expenses_event_author_idx on public.expenses(event_id, author_id);
create table public.expense_shares (
  event_id uuid not null,
  expense_id uuid not null,
  user_id uuid not null,
  amount_kopecks bigint not null check (amount_kopecks >= 0),
  primary key (expense_id, user_id),
  foreign key (event_id, expense_id) references public.expenses(event_id, id) on delete restrict,
  foreign key (event_id, user_id) references public.members(event_id, user_id) on delete restrict
);
create index expense_shares_event_user_idx on public.expense_shares(event_id, user_id);
-- No FK to expenses: deletion must preserve the audit and retry result.
create table public.expense_requests (
  event_id uuid not null references public.events(id) on delete restrict,
  actor_id uuid not null references public.users(id),
  request_id uuid not null,
  payload jsonb not null,
  response jsonb not null,
  primary key (event_id, actor_id, request_id)
);
create index expense_requests_actor_idx on public.expense_requests(actor_id);
create table public.audit_log (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id) on delete restrict,
  expense_id uuid not null,
  actor_id uuid not null references public.users(id),
  actor_name text not null,
  action text not null check (action in ('create','update','delete')),
  before_data jsonb,
  after_data jsonb,
  created_at timestamptz not null default clock_timestamp()
);
create index audit_log_event_time_idx on public.audit_log(event_id, created_at, id);
create index audit_log_actor_idx on public.audit_log(actor_id);
alter table public.expenses enable row level security;
alter table public.expense_shares enable row level security;
alter table public.expense_requests enable row level security;
alter table public.audit_log enable row level security;
revoke all on public.expenses, public.expense_shares, public.expense_requests, public.audit_log from public, anon, authenticated;
grant select, insert, update, delete on public.expenses, public.expense_shares to service_role;
revoke all on public.expense_requests, public.audit_log from service_role;
grant select, insert on public.expense_requests, public.audit_log to service_role;

-- Deferred check permits atomic replacement of shares, but rejects an incomplete expense.
create function public.check_expense_shares() returns trigger
language plpgsql security invoker set search_path = '' as $$
declare xid uuid; total bigint; n integer; actual numeric;
begin
  if TG_TABLE_NAME = 'expenses' then xid := coalesce(new.id, old.id);
  else xid := coalesce(new.expense_id, old.expense_id); end if;
  select amount_kopecks into total from public.expenses where id = xid;
  if found then
    select count(*), coalesce(sum(amount_kopecks),0) into n, actual from public.expense_shares where expense_id = xid;
    if n = 0 or actual <> total then raise exception 'invalid expense shares' using errcode = '23514'; end if;
  end if;
  return null;
end $$;
create constraint trigger expense_total_check after insert or update on public.expenses
  deferrable initially deferred for each row execute function public.check_expense_shares();
create constraint trigger shares_total_check after insert or update or delete on public.expense_shares
  deferrable initially deferred for each row execute function public.check_expense_shares();
revoke all on function public.check_expense_shares() from public, anon, authenticated;
grant execute on function public.check_expense_shares() to service_role;

create function public.expense_snapshot(p_id uuid) returns jsonb
language sql security invoker set search_path = '' as $$
  select to_jsonb(e) || jsonb_build_object('author_name', u.display_name, 'shares',
    (select jsonb_agg(jsonb_build_object('user_id',s.user_id,'display_name',su.display_name,
       'amount_kopecks',s.amount_kopecks) order by s.user_id)
     from public.expense_shares s join public.users su on su.id=s.user_id where s.expense_id=e.id))
  from public.expenses e join public.users u on u.id=e.author_id where e.id=p_id;
$$;
revoke all on function public.expense_snapshot(uuid) from public, anon, authenticated;
grant execute on function public.expense_snapshot(uuid) to service_role;

create function public.expense_action(p_token_hash text, p_action text, p_data jsonb default '{}')
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  uid uuid; eid uuid; xid uuid; rid uuid; ev public.events; ex public.expenses;
  recipients uuid[]; amount bigint; label text; prior public.expense_requests;
  payload jsonb; result jsonb; before_value jsonb; after_value jsonb;
begin
  select user_id into uid from public.app_sessions
    where token_hash=p_token_hash and expires_at>clock_timestamp() for share;
  if uid is null then return jsonb_build_object('error','unauthorized'); end if;
  if p_action is null or p_action not in ('list','history','create','update','delete') then
    return jsonb_build_object('error','invalid_action'); end if;
  eid := (p_data->>'eventId')::uuid;
  -- Same lock/order as event_action: session SHARE, event UPDATE, then expense.
  select * into ev from public.events where id=eid for update;
  if not exists(select 1 from public.app_sessions where token_hash=p_token_hash and expires_at>clock_timestamp()) then
    return jsonb_build_object('error','unauthorized'); end if;
  if ev.id is null or not exists(select 1 from public.members where event_id=eid and user_id=uid) then
    return jsonb_build_object('error','not_found'); end if;
  if p_action='list' then
    select coalesce(jsonb_agg(public.expense_snapshot(id) order by created_at desc,id),'[]') into result
      from public.expenses where event_id=eid;
    return jsonb_build_object('expenses',result);
  elsif p_action='history' then
    select coalesce(jsonb_agg(to_jsonb(a) order by created_at desc,id),'[]') into result from public.audit_log a where event_id=eid;
    return jsonb_build_object('history',result);
  end if;
  rid := (p_data->>'requestId')::uuid;
  if rid is null then return jsonb_build_object('error','invalid_input'); end if;
  payload := jsonb_build_object('action',p_action,'data',p_data - 'requestId');
  select * into prior from public.expense_requests where event_id=eid and actor_id=uid and request_id=rid;
  if found then
    if prior.payload <> payload then return jsonb_build_object('error','request_conflict'); end if;
    return prior.response;
  end if;
  if ev.status <> 'draft' then return jsonb_build_object('error','event_locked'); end if;
  if p_action in ('update','delete') then
    xid := (p_data->>'expenseId')::uuid;
    select * into ex from public.expenses where id=xid and event_id=eid;
    if ex.id is null then return jsonb_build_object('error','not_found'); end if;
    if uid <> ex.author_id and uid <> ev.creator_id then return jsonb_build_object('error','forbidden'); end if;
    if jsonb_typeof(p_data->'version') is distinct from 'number' or (p_data->>'version')::numeric <> ex.version then
      return jsonb_build_object('error','version_conflict'); end if;
    before_value := public.expense_snapshot(xid);
  end if;
  if p_action in ('create','update') then
    if jsonb_typeof(p_data->'title') is distinct from 'string' or length(btrim(p_data->>'title')) not between 1 and 120
      or jsonb_typeof(p_data->'amountKopecks') is distinct from 'number'
      or (p_data->>'amountKopecks')::numeric not between 1 and 99999999999
      or trunc((p_data->>'amountKopecks')::numeric) <> (p_data->>'amountKopecks')::numeric then
      return jsonb_build_object('error','invalid_input'); end if;
    if jsonb_typeof(p_data->'memberIds') is distinct from 'array' then return jsonb_build_object('error','invalid_input'); end if;
    if jsonb_array_length(p_data->'memberIds') not between 1 and 30 then return jsonb_build_object('error','invalid_input'); end if;
    select array_agg(v::uuid order by v::uuid) into recipients from jsonb_array_elements_text(p_data->'memberIds') v;
    if (select count(distinct v) from unnest(recipients) v) <> cardinality(recipients)
      or exists(select 1 from unnest(recipients) v where v is null or not exists(select 1 from public.members where event_id=eid and user_id=v)) then
      return jsonb_build_object('error','invalid_input'); end if;
    amount := (p_data->>'amountKopecks')::bigint; label := btrim(p_data->>'title');
    if p_action='create' then
      insert into public.expenses(event_id,author_id,title,amount_kopecks) values(eid,uid,label,amount) returning id into xid;
    else
      update public.expenses set title=label,amount_kopecks=amount,version=version+1,updated_at=clock_timestamp() where id=xid;
      delete from public.expense_shares where expense_id=xid;
    end if;
    insert into public.expense_shares(event_id,expense_id,user_id,amount_kopecks)
      select eid,xid,v,amount/cardinality(recipients) + case when ord <= amount%cardinality(recipients) then 1 else 0 end
      from unnest(recipients) with ordinality t(v,ord);
    after_value := public.expense_snapshot(xid);
  else
    delete from public.expense_shares where expense_id=xid;
    delete from public.expenses where id=xid;
  end if;
  insert into public.audit_log(event_id,expense_id,actor_id,actor_name,action,before_data,after_data)
    select eid,xid,uid,display_name,p_action,before_value,after_value from public.users where id=uid;
  update public.events set version=version+1 where id=eid;
  result := jsonb_build_object('ok',true,'expenseId',xid);
  insert into public.expense_requests(event_id,actor_id,request_id,payload,response) values(eid,uid,rid,payload,result);
  return result;
exception when invalid_text_representation or numeric_value_out_of_range then
  return jsonb_build_object('error','invalid_input');
end $$;
revoke all on function public.expense_action(text,text,jsonb) from public, anon, authenticated;
grant execute on function public.expense_action(text,text,jsonb) to service_role;
