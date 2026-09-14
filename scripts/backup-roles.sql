\set ON_ERROR_STOP on
\pset tuples_only on
\pset format unaligned
\pset footer off

do $$
begin
  if (select count(*) from pg_roles where rolname in ('anon', 'authenticated', 'service_role')) <> 3 then
    raise exception 'expected Supabase application roles are missing';
  end if;
end $$;

select format(
  'do $role$ begin if not exists (select 1 from pg_roles where rolname = %L) then create role %I; end if; end $role$;%s'
  || 'alter role %I with %s %s %s %s %s %s %s;',
  rolname,
  rolname,
  chr(10),
  rolname,
  case when rolsuper then 'superuser' else 'nosuperuser' end,
  case when rolinherit then 'inherit' else 'noinherit' end,
  case when rolcreaterole then 'createrole' else 'nocreaterole' end,
  case when rolcreatedb then 'createdb' else 'nocreatedb' end,
  case when rolcanlogin then 'login' else 'nologin' end,
  case when rolreplication then 'replication' else 'noreplication' end,
  case when rolbypassrls then 'bypassrls' else 'nobypassrls' end
)
from pg_roles
where rolname in ('anon', 'authenticated', 'service_role')
order by rolname;
