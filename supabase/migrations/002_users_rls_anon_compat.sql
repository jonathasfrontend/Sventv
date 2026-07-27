-- Ajuste de RLS para compatibilidade com chave anon/authenticated.
-- Execute no SQL Editor do Supabase para corrigir erro:
-- "new row violates row-level security policy for table users"

alter table public.users enable row level security;

drop policy if exists "Service role full access users" on public.users;
create policy "Service role full access users"
on public.users
as permissive
for all
to service_role
using (true)
with check (true);

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
