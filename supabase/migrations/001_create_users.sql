-- SvenTV - Schema de usuarios para Supabase/Postgres
-- Execute este script no SQL Editor do Supabase antes de iniciar a API.

create extension if not exists "pgcrypto";

create table if not exists public.users (
  id uuid primary key default gen_random_uuid(),
  name varchar(80) not null check (char_length(name) >= 2),
  email varchar(255) not null unique,
  password text not null,
  avatar text not null default '',
  api_token text unique,
  plan varchar(20) not null default 'free' check (plan in ('free', 'basic', 'premium')),
  status varchar(20) not null default 'active' check (status in ('active', 'inactive', 'banned', 'pending')),
  role varchar(20) not null default 'user' check (role in ('user', 'admin')),
  login_attempts integer not null default 0,
  lock_until timestamptz,
  last_login timestamptz,
  last_login_ip varchar(64),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists users_status_idx on public.users (status);
create index if not exists users_plan_idx on public.users (plan);
create index if not exists users_role_idx on public.users (role);

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists users_set_updated_at on public.users;
create trigger users_set_updated_at
before update on public.users
for each row
execute function public.set_updated_at();

alter table public.users enable row level security;

-- RLS focada para uso via service role no backend.
drop policy if exists "Service role full access users" on public.users;
create policy "Service role full access users"
on public.users
as permissive
for all
to service_role
using (true)
with check (true);

-- Compatibilidade para projetos usando anon/authenticated no backend.
-- ATENCAO: isso permite acesso amplo via chaves publicas; prefira service_role/sb_secret em producao.
drop policy if exists "Anon full access users" on public.users;
create policy "Anon full access users"
on public.users
as permissive
for all
to anon
using (true)
with check (true);

drop policy if exists "Authenticated full access users" on public.users;
create policy "Authenticated full access users"
on public.users
as permissive
for all
to authenticated
using (true)
with check (true);
