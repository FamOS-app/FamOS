-- FamOS: Grundschema mit Row Level Security
-- Einmal im Supabase SQL-Editor ausführen. Idempotent nicht nötig: nur auf leerem Projekt.
-- Prinzip: Jede Zeile gehört zu genau einem Haushalt. Lesen und Schreiben nur für Mitglieder.

create extension if not exists pgcrypto;

-- ─── Tabellen ────────────────────────────────────────────────
create table public.households (
  id           uuid primary key default gen_random_uuid(),
  name         text not null check (char_length(name) between 1 and 40),
  invite_code  text not null unique,
  created_by   uuid not null default auth.uid() references auth.users (id) on delete cascade,
  created_at   timestamptz not null default now()
);

create table public.members (
  household_id uuid not null references public.households (id) on delete cascade,
  user_id      uuid not null references auth.users (id) on delete cascade,
  role         text not null default 'adult' check (role in ('owner', 'adult')),
  joined_at    timestamptz not null default now(),
  primary key (household_id, user_id)
);
create index members_user_idx on public.members (user_id);

-- Ein Dokument pro Bereich und Haushalt; version für Konflikterkennung (optimistisches Sperren)
create table public.docs (
  household_id uuid not null references public.households (id) on delete cascade,
  key          text not null check (key in ('cfg', 'day', 'tgd', 'savings', 'tx')),
  data         jsonb not null,
  version      integer not null default 1,
  updated_at   timestamptz not null default now(),
  updated_by   uuid default auth.uid(),
  primary key (household_id, key),
  constraint docs_size check (pg_column_size(data) <= 512000)
);

-- Einkaufsliste zeilenweise: gleichzeitiges Eintragen auf mehreren Handys ohne Verlust
create table public.shopping_items (
  id           text not null check (id ~ '^[A-Za-z0-9_-]{1,40}$'),
  household_id uuid not null references public.households (id) on delete cascade,
  name         text not null check (char_length(name) between 1 and 80),
  n            smallint not null default 1 check (n between 1 and 99),
  done         boolean not null default false,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  primary key (household_id, id)
);

-- ─── Hilfsfunktion: bin ich Mitglied? ───────────────────────
-- security definer, damit die Prüfung nicht selbst an den RLS-Regeln von members hängt
create function public.is_member(hid uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from members where household_id = hid and user_id = auth.uid());
$$;

create function public.is_owner(hid uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from members where household_id = hid and user_id = auth.uid() and role = 'owner');
$$;

-- ─── Row Level Security ─────────────────────────────────────
alter table public.households     enable row level security;
alter table public.members        enable row level security;
alter table public.docs           enable row level security;
alter table public.shopping_items enable row level security;

create policy hh_select on public.households for select to authenticated using (is_member(id));
create policy hh_update on public.households for update to authenticated using (is_member(id)) with check (is_member(id));
create policy hh_delete on public.households for delete to authenticated using (is_owner(id));
-- Anlegen nur über create_household(), Beitreten nur über join_household()

create policy m_select on public.members for select to authenticated using (is_member(household_id));
-- Austreten: sich selbst entfernen; Besitzer kann andere entfernen
create policy m_delete on public.members for delete to authenticated
  using (user_id = auth.uid() or is_owner(household_id));

create policy d_all on public.docs for all to authenticated
  using (is_member(household_id)) with check (is_member(household_id));

create policy s_all on public.shopping_items for all to authenticated
  using (is_member(household_id)) with check (is_member(household_id));

-- Spaltenrechte: am Haushalt darf nur der Name geändert werden (Code nur über rotate_invite)
revoke update on public.households from authenticated;
grant update (name) on public.households to authenticated;
-- Mitglieder nur über Funktionen anlegen; Versionsfelder pflegt der Trigger
revoke insert, update on public.members from authenticated;

-- Rollen außerhalb von "authenticated" (anon) bekommen gar nichts
revoke all on public.households, public.members, public.docs, public.shopping_items from anon;

-- ─── Funktionen für Anlegen, Beitreten, Code erneuern ───────
-- Einladungscode: 8 Zeichen ohne verwechselbare Zeichen (kein 0/O, 1/I/L)
create function public.new_invite_code() returns text
language sql volatile as $$
  select string_agg(substr('ABCDEFGHJKMNPQRSTUVWXYZ23456789', 1 + (get_byte(b, i) % 31), 1), '')
  from gen_random_bytes(8) b, generate_series(0, 7) i;
$$;

create function public.create_household(p_name text) returns public.households
language plpgsql volatile security definer set search_path = public as $$
declare h households;
begin
  if auth.uid() is null then raise exception 'nicht angemeldet'; end if;
  if (select count(*) from members where user_id = auth.uid()) >= 3 then
    raise exception 'zu viele Haushalte';
  end if;
  insert into households (name, invite_code, created_by)
    values (left(trim(p_name), 40), new_invite_code(), auth.uid()) returning * into h;
  insert into members (household_id, user_id, role) values (h.id, auth.uid(), 'owner');
  return h;
end $$;

create function public.join_household(p_code text) returns public.households
language plpgsql volatile security definer set search_path = public as $$
declare h households;
begin
  if auth.uid() is null then raise exception 'nicht angemeldet'; end if;
  select * into h from households where invite_code = upper(regexp_replace(p_code, '[^A-Za-z0-9]', '', 'g'));
  if h.id is null then raise exception 'Code ungültig'; end if;
  if (select count(*) from members where household_id = h.id) >= 8 then raise exception 'Haushalt ist voll'; end if;
  insert into members (household_id, user_id, role) values (h.id, auth.uid(), 'adult')
    on conflict do nothing;
  return h;
end $$;

create function public.rotate_invite(p_household uuid) returns text
language plpgsql volatile security definer set search_path = public as $$
declare c text := new_invite_code();
begin
  if not is_owner(p_household) then raise exception 'nur für den Besitzer'; end if;
  update households set invite_code = c where id = p_household;
  return c;
end $$;

revoke all on function public.create_household(text), public.join_household(text),
  public.rotate_invite(uuid), public.new_invite_code(), public.is_member(uuid), public.is_owner(uuid) from public, anon;
grant execute on function public.create_household(text), public.join_household(text),
  public.rotate_invite(uuid), public.is_member(uuid), public.is_owner(uuid) to authenticated;

-- ─── Versionen und Zeitstempel automatisch pflegen ─────────
create function public.touch_doc() returns trigger language plpgsql as $$
begin
  new.version := old.version + 1;
  new.updated_at := now();
  new.updated_by := auth.uid();
  return new;
end $$;
create trigger docs_touch before update on public.docs for each row execute function public.touch_doc();

create function public.touch_item() returns trigger language plpgsql as $$
begin new.updated_at := now(); return new; end $$;
create trigger items_touch before update on public.shopping_items for each row execute function public.touch_item();

-- ─── Live-Abgleich ──────────────────────────────────────────
-- Realtime respektiert RLS: Abonnenten sehen nur Änderungen ihres Haushalts
alter publication supabase_realtime add table public.docs, public.shopping_items;
