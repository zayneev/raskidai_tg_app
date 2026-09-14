create table public.event_requests (
  actor_id uuid not null references public.users(id),
  request_id uuid not null,
  event_id uuid not null references public.events(id) on delete restrict,
  payload jsonb not null,
  response jsonb not null,
  primary key (actor_id, request_id)
);
create index event_requests_event_idx on public.event_requests(event_id);
alter table public.event_requests enable row level security;
revoke all on public.event_requests from public, anon, authenticated, service_role;
grant select, insert on public.event_requests to service_role;

-- Preserve idempotency for events created before stage 7 and make a changed body
-- with an old requestId a request_conflict instead of silently returning success.
insert into public.event_requests(actor_id,request_id,event_id,payload,response)
select creator_id,request_id,id,
  jsonb_build_object('legacy',true),
  jsonb_build_object('eventId',id)
from public.events
on conflict do nothing;

create or replace function public.event_action(
  p_token_hash text,
  p_action text,
  p_data jsonb default '{}'
) returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  uid uuid;
  eid uuid;
  rid uuid;
  ev public.events;
  result jsonb;
  invite_hash text;
  payload jsonb;
  prior public.event_requests;
begin
  select user_id into uid from public.app_sessions
    where token_hash=p_token_hash and expires_at>clock_timestamp() for share;
  if uid is null then return jsonb_build_object('error','unauthorized'); end if;
  if p_action is null or p_action not in
    ('list','create','get','join','rotate','disable','leave') then
    return jsonb_build_object('error','invalid_action');
  end if;

  if p_action='list' then
    select coalesce(jsonb_agg(item order by item->>'createdAt' desc,item->>'id'),'[]')
      into result from (
        select jsonb_build_object(
          'id',e.id,'title',e.title,'description',e.description,
          'creatorId',e.creator_id,'status',e.status,'version',e.version,
          'createdAt',e.created_at,
          'memberCount',(select count(*) from public.members where event_id=e.id)
        ) item
        from public.events e
        join public.members m on m.event_id=e.id
        where m.user_id=uid
      ) q;
    return jsonb_build_object('events',result);
  end if;

  if p_action='get' then
    eid := (p_data->>'eventId')::uuid;
  else
    -- Legacy stage 3-6 callers did not send requestId for membership and
    -- invitation actions. Keep them working during rollout; the stage 7 HTTP
    -- handler always requires requestId for every new mutation.
    if p_action<>'create' and not (p_data ? 'requestId') then
      rid:=null;
    elsif coalesce(p_data->>'requestId','') !~
      '^[a-fA-F0-9]{8}(-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12}$' then
      return jsonb_build_object('error','invalid_input');
    else
      rid := (p_data->>'requestId')::uuid;
      payload := jsonb_build_object('action',p_action,'data',p_data-'requestId');
      select * into prior from public.event_requests
        where actor_id=uid and request_id=rid;
      if found and prior.payload<>payload
        and coalesce((prior.payload->>'legacy')::boolean,false)=false then
        return jsonb_build_object('error','request_conflict');
      end if;
    end if;
  end if;

  if p_action='create' then
    if prior.request_id is not null then return prior.response; end if;
    if jsonb_typeof(p_data->'title') is distinct from 'string'
      or length(btrim(p_data->>'title')) not between 1 and 120
      or jsonb_typeof(p_data->'description') is distinct from 'string'
      or length(p_data->>'description')>2000 then
      return jsonb_build_object('error','invalid_input');
    end if;
    insert into public.events(creator_id,title,description,request_id)
      values(uid,btrim(p_data->>'title'),p_data->>'description',rid)
      on conflict(creator_id,request_id) do nothing returning id into eid;
    if eid is null then
      select * into prior from public.event_requests
        where actor_id=uid and request_id=rid;
      if prior.request_id is null then
        return jsonb_build_object('error','request_conflict');
      end if;
      if prior.payload<>payload then
        return jsonb_build_object('error','request_conflict');
      end if;
      return prior.response;
    end if;
    insert into public.members(event_id,user_id) values(eid,uid);
    result:=jsonb_build_object('eventId',eid);
    if rid is not null then
      insert into public.event_requests(actor_id,request_id,event_id,payload,response)
        values(uid,rid,eid,payload,result);
    end if;
    return result;
  elsif p_action='join' then
    invite_hash:=p_data->>'invitationHash';
    if prior.request_id is not null then eid:=prior.event_id;
    else select event_id into eid from public.invitations where token_hash=invite_hash;
    end if;
  elsif p_action in ('get','rotate','disable','leave') then
    eid:=(p_data->>'eventId')::uuid;
  end if;

  -- Global order remains session SHARE -> event UPDATE. Recheck the session
  -- after waiting for the application lock, including idempotent retries.
  select * into ev from public.events where id=eid for update;
  if not exists(select 1 from public.app_sessions
    where token_hash=p_token_hash and expires_at>clock_timestamp()) then
    return jsonb_build_object('error','unauthorized');
  end if;
  if ev.id is null then return jsonb_build_object('error','not_found'); end if;
  if prior.request_id is null and rid is not null then
    select * into prior from public.event_requests
      where actor_id=uid and request_id=rid;
    if prior.request_id is not null and prior.payload<>payload then
      return jsonb_build_object('error','request_conflict');
    end if;
  end if;
  if prior.request_id is not null then return prior.response; end if;

  if p_action='join' then
    if not exists(select 1 from public.invitations
      where event_id=eid and token_hash=invite_hash and active) then
      return jsonb_build_object('error','invitation_invalid');
    end if;
    if exists(select 1 from public.members where event_id=eid and user_id=uid) then
      result:=jsonb_build_object('eventId',eid);
    else
      if ev.status<>'draft' then return jsonb_build_object('error','event_locked'); end if;
      if (select count(*) from public.members where event_id=eid)>=30 then
        return jsonb_build_object('error','event_full');
      end if;
      insert into public.members(event_id,user_id) values(eid,uid);
      update public.events set version=version+1 where id=eid;
      result:=jsonb_build_object('eventId',eid);
    end if;
    if rid is not null then
      insert into public.event_requests(actor_id,request_id,event_id,payload,response)
        values(uid,rid,eid,payload,result);
    end if;
    return result;
  end if;

  if not exists(select 1 from public.members where event_id=eid and user_id=uid) then
    return jsonb_build_object('error','not_found');
  end if;
  if p_action='get' then
    select jsonb_agg(jsonb_build_object(
      'id',u.id,'displayName',u.display_name,'joinedAt',m.joined_at)
      order by m.joined_at,u.id) into result
    from public.members m join public.users u on u.id=m.user_id
    where m.event_id=eid;
    return jsonb_build_object('event',jsonb_build_object(
      'id',ev.id,'title',ev.title,'description',ev.description,
      'creatorId',ev.creator_id,'status',ev.status,'version',ev.version,
      'members',result,
      'invitationActive',exists(select 1 from public.invitations
        where event_id=eid and active)));
  end if;

  if p_action in ('rotate','disable') then
    if ev.creator_id<>uid then return jsonb_build_object('error','forbidden'); end if;
    if ev.status<>'draft' then return jsonb_build_object('error','event_locked'); end if;
    if p_action='rotate' then
      if coalesce(p_data->>'invitationHash','') !~ '^[a-f0-9]{64}$' then
        return jsonb_build_object('error','invalid_input');
      end if;
      insert into public.invitations(event_id,token_hash)
        values(eid,p_data->>'invitationHash')
        on conflict(event_id) do update
          set token_hash=excluded.token_hash,active=true;
    else
      update public.invitations set active=false where event_id=eid;
    end if;
  elsif p_action='leave' then
    if ev.creator_id=uid then
      return jsonb_build_object('error','creator_cannot_leave');
    end if;
    if ev.status<>'draft' then return jsonb_build_object('error','event_locked'); end if;
    delete from public.members where event_id=eid and user_id=uid;
  end if;
  update public.events set version=version+1 where id=eid;
  result:=jsonb_build_object('ok',true);
  if rid is not null then
    insert into public.event_requests(actor_id,request_id,event_id,payload,response)
      values(uid,rid,eid,payload,result);
  end if;
  return result;
exception
  when invalid_text_representation then
    return jsonb_build_object('error','invalid_input');
  when foreign_key_violation then
    return jsonb_build_object('error','member_has_expenses');
end;
$$;
revoke all on function public.event_action(text,text,jsonb)
  from public, anon, authenticated;
grant execute on function public.event_action(text,text,jsonb) to service_role;

create function public.event_history_action(
  p_token_hash text,
  p_data jsonb default '{}'
) returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  uid uuid;
  eid uuid;
  ev public.events;
  page_limit integer := 20;
  cursor_at timestamptz;
  cursor_id uuid;
  cursor_source text;
  items jsonb;
  next_cursor jsonb;
begin
  select user_id into uid from public.app_sessions
    where token_hash=p_token_hash and expires_at>clock_timestamp() for share;
  if uid is null then return jsonb_build_object('error','unauthorized'); end if;
  if coalesce(p_data->>'eventId','') !~
    '^[a-fA-F0-9]{8}(-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12}$' then
    return jsonb_build_object('error','invalid_input');
  end if;
  eid:=(p_data->>'eventId')::uuid;
  if p_data ? 'limit' then
    if jsonb_typeof(p_data->'limit') is distinct from 'number'
      or trunc((p_data->>'limit')::numeric)<>(p_data->>'limit')::numeric
      or (p_data->>'limit')::numeric not between 1 and 50 then
      return jsonb_build_object('error','invalid_input');
    end if;
    page_limit:=(p_data->>'limit')::integer;
  end if;
  if p_data ? 'cursor' then
    if jsonb_typeof(p_data->'cursor') is distinct from 'object'
      or coalesce(p_data#>>'{cursor,occurredAt}','')=''
      or coalesce(p_data#>>'{cursor,id}','') !~
        '^[a-fA-F0-9]{8}(-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12}$'
      or coalesce(p_data#>>'{cursor,source}','') not in
        ('expense','settlement','transfer') then
      return jsonb_build_object('error','invalid_input');
    end if;
    cursor_at:=(p_data#>>'{cursor,occurredAt}')::timestamptz;
    cursor_id:=(p_data#>>'{cursor,id}')::uuid;
    cursor_source:=p_data#>>'{cursor,source}';
  end if;

  -- A shared event lock gives the same session -> event order as mutations and
  -- a consistent page. Session expiry/revocation is checked after the wait.
  select * into ev from public.events where id=eid for share;
  if not exists(select 1 from public.app_sessions
    where token_hash=p_token_hash and expires_at>clock_timestamp()) then
    return jsonb_build_object('error','unauthorized');
  end if;
  if ev.id is null or not exists(select 1 from public.members
    where event_id=eid and user_id=uid) then
    return jsonb_build_object('error','not_found');
  end if;

  with history_items as (
    select a.id,'expense'::text source,('expense.'||a.action) action,
      a.actor_name,a.created_at occurred_at,a.before_data before_value,
      a.after_data after_value,
      jsonb_build_object('expenseId',a.expense_id) details
    from public.audit_log a where a.event_id=eid
    union all
    select a.id,'settlement',('settlement.'||a.action),a.actor_name,a.created_at,
      case when a.action='cancel' then a.data else null end,
      case when a.action='cancel' then null else a.data end,
      jsonb_build_object('settlementId',a.settlement_id)
    from public.settlement_audit_log a where a.event_id=eid
    union all
    select h.id,'transfer',('transfer.'||h.action),u.display_name,h.occurred_at,
      to_jsonb(h.status_before),to_jsonb(h.status_after),
      jsonb_build_object(
        'settlementId',h.settlement_id,'transferId',h.transfer_id,
        'senderId',t.sender_id,'senderName',sb.display_name,
        'receiverId',t.receiver_id,'receiverName',rb.display_name,
        'amountKopecks',t.amount_kopecks)
    from public.transfer_status_history h
    join public.users u on u.id=h.actor_id
    join public.transfers t on t.id=h.transfer_id and t.settlement_id=h.settlement_id
    join public.settlement_balances sb
      on sb.settlement_id=t.settlement_id and sb.user_id=t.sender_id
    join public.settlement_balances rb
      on rb.settlement_id=t.settlement_id and rb.user_id=t.receiver_id
    where h.event_id=eid
  ), eligible as (
    select *,row_number() over(
      order by occurred_at desc,id desc,source desc) row_number,
      count(*) over() total_count
    from history_items
    where cursor_at is null
      or (occurred_at,id,source)<(cursor_at,cursor_id,cursor_source)
  )
  select
    coalesce(jsonb_agg(jsonb_build_object(
      'id',id,'source',source,'action',action,'actorName',actor_name,
      'occurredAt',occurred_at,'before',before_value,'after',after_value,
      'details',details) order by row_number)
      filter(where row_number<=page_limit),'[]'::jsonb),
    (jsonb_agg(jsonb_build_object(
      'occurredAt',occurred_at,'id',id,'source',source))
      filter(where row_number=page_limit and total_count>page_limit))->0
  into items,next_cursor
  from eligible;
  return jsonb_build_object('items',items,'nextCursor',next_cursor);
exception
  when invalid_text_representation or datetime_field_overflow then
    return jsonb_build_object('error','invalid_input');
end;
$$;
revoke all on function public.event_history_action(text,jsonb)
  from public, anon, authenticated;
grant execute on function public.event_history_action(text,jsonb) to service_role;
