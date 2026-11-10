-- FamOS: Korrektur zu 001 – Einladungscode ohne pgcrypto
-- Bei Supabase liegt pgcrypto im Schema "extensions"; new_invite_code() fand gen_random_bytes() nicht.
-- gen_random_uuid() ist seit Postgres 13 eingebaut (kryptografisch zufällig) und überall erreichbar.
-- Einmal im Supabase SQL-Editor ausführen.

create or replace function public.new_invite_code() returns text
language sql volatile set search_path = pg_catalog, public as $$
  select string_agg(substr('ABCDEFGHJKMNPQRSTUVWXYZ23456789', 1 + (get_byte(b, i) % 31), 1), '' order by i)
  from (select uuid_send(gen_random_uuid()) as b) x, generate_series(0, 7) as i;
$$;

revoke all on function public.new_invite_code() from public, anon;
