-- LOCAL TESTING ONLY. Recreates the small slice of Supabase's built-in schemas
-- (auth, storage, API roles, realtime publication) that our migration relies on,
-- so the real migration can be applied to a plain Postgres and tested.
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
end $$;

create schema auth;
create table auth.users (
  id uuid primary key default gen_random_uuid(),
  email text unique,
  phone text,
  is_anonymous boolean not null default false,
  encrypted_password text,
  created_at timestamptz not null default now()
);
create function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claims', true)::json ->> 'sub', '')::uuid $$;
create function auth.role() returns text language sql stable as $$
  select current_setting('request.jwt.claims', true)::json ->> 'role' $$;
create function auth.jwt() returns jsonb language sql stable as $$
  select coalesce(current_setting('request.jwt.claims', true), '{}')::jsonb $$;

create schema storage;
create table storage.buckets (id text primary key, name text, public boolean default false, file_size_limit bigint, allowed_mime_types text[]);
create table storage.objects (
  id uuid primary key default gen_random_uuid(), bucket_id text references storage.buckets(id), name text,
  owner uuid, metadata jsonb, created_at timestamptz default now(), unique (bucket_id, name));
alter table storage.objects enable row level security;
create function storage.foldername(name text) returns text[] language sql immutable as $$
  select (string_to_array(name, '/'))[1:array_length(string_to_array(name, '/'), 1) - 1] $$;

create schema extensions;
create publication supabase_realtime;

grant usage on schema public, auth, storage to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
grant select on storage.buckets to anon, authenticated;
grant all on storage.objects to authenticated, service_role;
grant select on auth.users to service_role;
