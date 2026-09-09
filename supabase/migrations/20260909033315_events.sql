create table public.events (
  id uuid primary key default gen_random_uuid(),
  creator_id uuid not null references public.users(id),
  title text not null check (length(btrim(title)) between 1 and 120),
  description text not null default '' check (length(description) <= 2000),
  status text not null default 'draft' check (status in ('draft', 'settled', 'completed')),
  version integer not null default 1 check (version > 0),
  created_at timestamptz not null default now(),
  request_id uuid not null,
  unique (creator_id, request_id)
);
create table public.members (
  event_id uuid not null references public.events(id) on delete cascade,
  user_id uuid not null references public.users(id),
  joined_at timestamptz not null default now(),
  primary key (event_id, user_id)
);
create index members_user_event_idx on public.members(user_id, event_id);
create table public.invitations (
  event_id uuid primary key references public.events(id) on delete cascade,
  token_hash text not null unique check (token_hash ~ '^[a-f0-9]{64}$'),
  active boolean not null default true
);
alter table public.events enable row level security;
alter table public.members enable row level security;
alter table public.invitations enable row level security;
revoke all on public.events, public.members, public.invitations from public, anon, authenticated;
grant select, insert, update, delete on public.events, public.members, public.invitations to service_role;

-- All operations authenticate again inside the transaction. Never accept a user ID.
-- Every membership/invitation mutation locks the event first. Future expense and
-- settlement RPCs must use the same lock, and expense FKs must RESTRICT member deletion.
create function public.event_action(p_token_hash text, p_action text, p_data jsonb default '{}')
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  uid uuid;
  eid uuid;
  ev public.events;
  result jsonb;
  invite_hash text;
begin
  select user_id into uid from public.app_sessions
    where token_hash = p_token_hash and expires_at > clock_timestamp() for share;
  if uid is null then return jsonb_build_object('error', 'unauthorized'); end if;
  if p_action = 'list' then
    select coalesce(jsonb_agg(item order by item->>'createdAt' desc, item->>'id'), '[]') into result from (
      select jsonb_build_object('id', e.id, 'title', e.title, 'description', e.description,
        'creatorId', e.creator_id, 'status', e.status, 'version', e.version,
        'createdAt', e.created_at, 'memberCount', (select count(*) from public.members where event_id = e.id)) item
      from public.events e join public.members m on m.event_id = e.id where m.user_id = uid
    ) q;
    return jsonb_build_object('events', result);
  elsif p_action = 'create' then
    if jsonb_typeof(p_data->'title') is distinct from 'string' or length(btrim(p_data->>'title')) not between 1 and 120
      or jsonb_typeof(p_data->'description') is distinct from 'string' or length(p_data->>'description') > 2000
      or coalesce(p_data->>'requestId', '') !~ '^[a-fA-F0-9-]{36}$' then
      return jsonb_build_object('error', 'invalid_input');
    end if;
    insert into public.events(creator_id, title, description, request_id)
      values(uid, btrim(p_data->>'title'), p_data->>'description', (p_data->>'requestId')::uuid)
      on conflict (creator_id, request_id) do nothing returning id into eid;
    if eid is null then
      select id into eid from public.events where creator_id = uid and request_id = (p_data->>'requestId')::uuid;
    else
      insert into public.members(event_id, user_id) values(eid, uid);
    end if;
    return jsonb_build_object('eventId', eid);
  elsif p_action = 'join' then
    invite_hash := p_data->>'invitationHash';
    select event_id into eid from public.invitations where token_hash = invite_hash;
  elsif p_action in ('get', 'rotate', 'disable', 'leave') then
    eid := (p_data->>'eventId')::uuid;
  else
    return jsonb_build_object('error', 'invalid_action');
  end if;
  select * into ev from public.events where id = eid for update;
  if not exists(select 1 from public.app_sessions where token_hash = p_token_hash and expires_at > clock_timestamp()) then
    return jsonb_build_object('error', 'unauthorized');
  end if;
  if ev.id is null then return jsonb_build_object('error', 'not_found'); end if;
  if p_action = 'join' then
    -- Re-read after acquiring lock: rotation/disable may have won the race.
    if not exists(select 1 from public.invitations where event_id = eid and token_hash = invite_hash and active) then
      return jsonb_build_object('error', 'invitation_invalid');
    end if;
    if exists(select 1 from public.members where event_id = eid and user_id = uid) then
      return jsonb_build_object('eventId', eid);
    end if;
    if ev.status <> 'draft' then return jsonb_build_object('error', 'event_locked'); end if;
    if (select count(*) from public.members where event_id = eid) >= 30 then
      return jsonb_build_object('error', 'event_full');
    end if;
    insert into public.members(event_id, user_id) values(eid, uid);
    update public.events set version = version + 1 where id = eid;
    return jsonb_build_object('eventId', eid);
  end if;
  if not exists(select 1 from public.members where event_id = eid and user_id = uid) then
    return jsonb_build_object('error', 'not_found');
  end if;
  if p_action = 'get' then
    select jsonb_agg(jsonb_build_object('id', u.id, 'displayName', u.display_name, 'joinedAt', m.joined_at)
      order by m.joined_at, u.id) into result
      from public.members m join public.users u on u.id = m.user_id where m.event_id = eid;
    return jsonb_build_object('event', jsonb_build_object('id', ev.id, 'title', ev.title,
      'description', ev.description, 'creatorId', ev.creator_id, 'status', ev.status, 'version', ev.version,
      'members', result, 'invitationActive', exists(select 1 from public.invitations where event_id = eid and active)));
  end if;
  if p_action in ('rotate', 'disable') then
    if ev.creator_id <> uid then return jsonb_build_object('error', 'forbidden'); end if;
    if ev.status <> 'draft' then return jsonb_build_object('error', 'event_locked'); end if;
    if p_action = 'rotate' then
      if coalesce(p_data->>'invitationHash', '') !~ '^[a-f0-9]{64}$' then return jsonb_build_object('error', 'invalid_input'); end if;
      insert into public.invitations(event_id, token_hash) values(eid, p_data->>'invitationHash')
        on conflict (event_id) do update set token_hash = excluded.token_hash, active = true;
    else
      update public.invitations set active = false where event_id = eid;
    end if;
  elsif p_action = 'leave' then
    if ev.creator_id = uid then return jsonb_build_object('error', 'creator_cannot_leave'); end if;
    if ev.status <> 'draft' then return jsonb_build_object('error', 'event_locked'); end if;
    -- Stage 4 must add expense/share references to this composite member key.
    -- ON DELETE RESTRICT then fails closed even if this handler is unchanged.
    delete from public.members where event_id = eid and user_id = uid;
  end if;
  update public.events set version = version + 1 where id = eid;
  return jsonb_build_object('ok', true);
exception
  when invalid_text_representation then return jsonb_build_object('error', 'invalid_input');
  when foreign_key_violation then return jsonb_build_object('error', 'member_has_expenses');
end;
$$;
revoke all on function public.event_action(text, text, jsonb) from public, anon, authenticated;
grant execute on function public.event_action(text, text, jsonb) to service_role;
