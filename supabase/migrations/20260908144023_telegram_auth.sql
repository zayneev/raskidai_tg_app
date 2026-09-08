-- All application data is server-only; browser Supabase roles have no access.
create table public.users (
  id uuid primary key default gen_random_uuid(),
  telegram_id bigint not null unique check (telegram_id > 0 and telegram_id <= 9007199254740991),
  display_name text not null check (length(btrim(display_name)) between 1 and 256),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table public.app_sessions (
  token_hash text primary key check (token_hash ~ '^[a-f0-9]{64}$'),
  user_id uuid not null references public.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '24 hours')
);
create index app_sessions_user_id_idx on public.app_sessions(user_id);
alter table public.users enable row level security;
alter table public.app_sessions enable row level security;
revoke all on public.users, public.app_sessions from public, anon, authenticated;
grant select, insert, update, delete on public.users, public.app_sessions to service_role;

-- Invoker functions: callable only by the server service_role. One transaction.
create function public.create_telegram_session(p_telegram_id bigint, p_display_name text, p_token_hash text)
returns jsonb language plpgsql set search_path = '' as $$
declare
  app_user public.users;
  expiry timestamptz;
begin
  insert into public.users (telegram_id, display_name) values (p_telegram_id, p_display_name)
  on conflict (telegram_id) do update set display_name = excluded.display_name, updated_at = now()
  returning * into app_user;
  delete from public.app_sessions where user_id = app_user.id and expires_at <= now();
  insert into public.app_sessions(token_hash, user_id) values (p_token_hash, app_user.id)
  returning expires_at into expiry;
  return jsonb_build_object('user', jsonb_build_object('id', app_user.id, 'displayName', app_user.display_name), 'expiresAt', expiry);
end;
$$;
create function public.get_app_session(p_token_hash text)
returns jsonb language sql stable set search_path = '' as $$
  select jsonb_build_object('user', jsonb_build_object('id', u.id, 'displayName', u.display_name), 'expiresAt', s.expires_at)
  from public.app_sessions s join public.users u on u.id = s.user_id
  where s.token_hash = p_token_hash and s.expires_at > now();
$$;
create function public.revoke_app_session(p_token_hash text)
returns void language sql set search_path = '' as $$
  delete from public.app_sessions where token_hash = p_token_hash;
$$;
revoke all on function public.create_telegram_session(bigint, text, text), public.get_app_session(text), public.revoke_app_session(text) from public, anon, authenticated;
grant execute on function public.create_telegram_session(bigint, text, text), public.get_app_session(text), public.revoke_app_session(text) to service_role;
