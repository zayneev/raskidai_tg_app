alter table public.events
  add column category text not null default 'other'
    check (category in ('trip','food','party','home','leisure','other')),
  add column event_date date;

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
  event_category text;
  event_day date;
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
          'createdAt',e.created_at,'category',e.category,'eventDate',e.event_date,
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
    event_category:=coalesce(p_data->>'category','other');
    if jsonb_typeof(p_data->'title') is distinct from 'string'
      or length(btrim(p_data->>'title')) not between 1 and 120
      or jsonb_typeof(p_data->'description') is distinct from 'string'
      or length(p_data->>'description')>300
      or event_category not in ('trip','food','party','home','leisure','other')
      or (p_data->>'eventDate' is not null and
        (p_data->>'eventDate' !~ '^\d{4}-\d{2}-\d{2}$'))
      or (p_data ? 'invitationHash' and
        coalesce(p_data->>'invitationHash','') !~ '^[a-f0-9]{64}$') then
      return jsonb_build_object('error','invalid_input');
    end if;
    event_day:=(p_data->>'eventDate')::date;
    insert into public.events(
      creator_id,title,description,request_id,category,event_date)
      values(
        uid,btrim(p_data->>'title'),p_data->>'description',rid,
        event_category,event_day)
      on conflict(creator_id,request_id) do nothing returning id into eid;
    if eid is null then
      select * into prior from public.event_requests
        where actor_id=uid and request_id=rid;
      if prior.request_id is null or prior.payload<>payload then
        return jsonb_build_object('error','request_conflict');
      end if;
      return prior.response;
    end if;
    insert into public.members(event_id,user_id) values(eid,uid);
    if p_data ? 'invitationHash' then
      insert into public.invitations(event_id,token_hash)
        values(eid,p_data->>'invitationHash');
    end if;
    result:=jsonb_build_object('eventId',eid);
    insert into public.event_requests(actor_id,request_id,event_id,payload,response)
      values(uid,rid,eid,payload,result);
    return result;
  elsif p_action='join' then
    invite_hash:=p_data->>'invitationHash';
    if prior.request_id is not null then eid:=prior.event_id;
    else select event_id into eid from public.invitations where token_hash=invite_hash;
    end if;
  elsif p_action in ('get','rotate','disable','leave') then
    eid:=(p_data->>'eventId')::uuid;
  end if;

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
      'category',ev.category,'eventDate',ev.event_date,
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
  when invalid_text_representation or datetime_field_overflow then
    return jsonb_build_object('error','invalid_input');
  when foreign_key_violation then
    return jsonb_build_object('error','member_has_expenses');
end;
$$;
revoke all on function public.event_action(text,text,jsonb)
  from public, anon, authenticated;
grant execute on function public.event_action(text,text,jsonb) to service_role;

create function public.settlement_preview_action(
  p_token_hash text,
  p_data jsonb default '{}'
) returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  uid uuid;
  eid uuid;
  ev public.events;
  user_ids uuid[];
  display_names text[];
  paid_values bigint[];
  share_values bigint[];
  balance_values bigint[];
  working_values bigint[];
  balances jsonb:='[]'::jsonb;
  transfers jsonb:='[]'::jsonb;
  idx integer;
  debtor_index integer;
  creditor_index integer;
  transfer_number integer:=0;
  payment bigint;
begin
  select user_id into uid from public.app_sessions
    where token_hash=p_token_hash and expires_at>clock_timestamp() for share;
  if uid is null then return jsonb_build_object('error','unauthorized'); end if;
  if coalesce(p_data->>'eventId','') !~
    '^[a-fA-F0-9]{8}(-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12}$' then
    return jsonb_build_object('error','invalid_input');
  end if;
  eid:=(p_data->>'eventId')::uuid;
  select * into ev from public.events where id=eid for share;
  if not exists(select 1 from public.app_sessions
    where token_hash=p_token_hash and expires_at>clock_timestamp()) then
    return jsonb_build_object('error','unauthorized');
  end if;
  if ev.id is null or not exists(select 1 from public.members
    where event_id=eid and user_id=uid) then
    return jsonb_build_object('error','not_found');
  end if;
  if ev.status<>'draft' then return jsonb_build_object('error','event_locked'); end if;

  select
    array_agg(q.user_id order by q.user_id),
    array_agg(q.display_name order by q.user_id),
    array_agg(q.paid order by q.user_id),
    array_agg(q.share order by q.user_id),
    array_agg(q.paid-q.share order by q.user_id)
  into user_ids,display_names,paid_values,share_values,balance_values
  from (
    select m.user_id,u.display_name,coalesce(p.paid,0)::bigint paid,
      coalesce(sh.share,0)::bigint share
    from public.members m
    join public.users u on u.id=m.user_id
    left join (
      select author_id,sum(amount_kopecks)::bigint paid
      from public.expenses where event_id=eid group by author_id
    ) p on p.author_id=m.user_id
    left join (
      select user_id,sum(amount_kopecks)::bigint share
      from public.expense_shares where event_id=eid group by user_id
    ) sh on sh.user_id=m.user_id
    where m.event_id=eid
  ) q;

  working_values:=balance_values;
  if coalesce(array_length(user_ids,1),0)>0 then
    for idx in 1..array_length(user_ids,1) loop
      balances:=balances||jsonb_build_array(jsonb_build_object(
        'userId',user_ids[idx],
        'displayName',display_names[idx],
        'paidKopecks',paid_values[idx],
        'shareKopecks',share_values[idx],
        'balanceKopecks',balance_values[idx]
      ));
    end loop;
  end if;

  loop
    debtor_index:=null;
    creditor_index:=null;
    for idx in 1..array_length(user_ids,1) loop
      if working_values[idx]<0 then
        if debtor_index is null or working_values[idx]<working_values[debtor_index] then
          debtor_index:=idx;
        end if;
      elsif working_values[idx]>0 then
        if creditor_index is null or working_values[idx]>working_values[creditor_index] then
          creditor_index:=idx;
        end if;
      end if;
    end loop;
    exit when debtor_index is null;
    if creditor_index is null then
      raise exception 'unmatched settlement preview credit' using errcode='23514';
    end if;
    payment:=least(-working_values[debtor_index],working_values[creditor_index]);
    transfer_number:=transfer_number+1;
    transfers:=transfers||jsonb_build_array(jsonb_build_object(
      'sequence',transfer_number,
      'senderId',user_ids[debtor_index],
      'senderName',display_names[debtor_index],
      'receiverId',user_ids[creditor_index],
      'receiverName',display_names[creditor_index],
      'amountKopecks',payment
    ));
    working_values[debtor_index]:=working_values[debtor_index]+payment;
    working_values[creditor_index]:=working_values[creditor_index]-payment;
    if transfer_number>29 then
      raise exception 'too many preview transfers' using errcode='23514';
    end if;
  end loop;

  return jsonb_build_object('preview',jsonb_build_object(
    'sourceEventVersion',ev.version,
    'balances',balances,
    'transfers',transfers
  ));
exception when invalid_text_representation then
  return jsonb_build_object('error','invalid_input');
end;
$$;
revoke all on function public.settlement_preview_action(text,jsonb)
  from public, anon, authenticated;
grant execute on function public.settlement_preview_action(text,jsonb) to service_role;
