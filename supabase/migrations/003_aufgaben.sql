-- FamOS: Aufgaben (To-dos für alle im Haushalt), zeilenweise wie die Einkaufsliste
-- Einmal im Supabase SQL-Editor ausführen.

create table public.tasks (
  id           text not null check (id ~ '^[A-Za-z0-9_-]{1,40}$'),
  household_id uuid not null references public.households (id) on delete cascade,
  title        text not null check (char_length(title) between 1 and 120),
  note         text not null default '' check (char_length(note) <= 300),
  who          jsonb not null default '[]' check (jsonb_typeof(who) = 'array' and jsonb_array_length(who) <= 12),
  due          date,
  rep          text not null default '' check (rep in ('', 'd', 'w', 'm')),
  done         boolean not null default false,
  done_by      text not null default '' check (char_length(done_by) <= 40),
  done_at      bigint,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  primary key (household_id, id)
);

alter table public.tasks enable row level security;
create policy t_all on public.tasks for all to authenticated
  using (is_member(household_id)) with check (is_member(household_id));
revoke all on public.tasks from anon;

create trigger tasks_touch before update on public.tasks for each row execute function public.touch_item();

alter publication supabase_realtime add table public.tasks;
