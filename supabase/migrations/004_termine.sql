-- FamOS: Kalender (Familientermine und Verabredungen), zeilenweise wie Aufgaben und Einkaufsliste
-- Einmal im Supabase SQL-Editor ausführen.

create table public.events (
  id           text not null check (id ~ '^[A-Za-z0-9_-]{1,40}$'),
  household_id uuid not null references public.households (id) on delete cascade,
  title        text not null check (char_length(title) between 1 and 120),
  day          date not null,
  end_day      date check (end_day is null or end_day > day),
  t_from       text not null default '' check (t_from ~ '^$|^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  t_to         text not null default '' check (t_to ~ '^$|^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  place        text not null default '' check (char_length(place) <= 80),
  note         text not null default '' check (char_length(note) <= 300),
  who          jsonb not null default '[]' check (jsonb_typeof(who) = 'array' and jsonb_array_length(who) <= 12),
  rep          text not null default '' check (rep in ('', 'w', 'y')),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  primary key (household_id, id)
);

alter table public.events enable row level security;
create policy e_all on public.events for all to authenticated
  using (is_member(household_id)) with check (is_member(household_id));
revoke all on public.events from anon;

create trigger events_touch before update on public.events for each row execute function public.touch_item();

alter publication supabase_realtime add table public.events;
