-- FamOS: Fotos zu Gerichten. Je Gericht eine kleine Vorschau und ein verkleinertes Bild,
-- beide als JPEG-Data-URL (die App verkleinert vor dem Hochladen). Zeilenweise wie Aufgaben und Termine.
-- Einmal im Supabase SQL-Editor ausführen.

create table public.dish_images (
  household_id uuid not null references public.households (id) on delete cascade,
  dish_id      text not null check (dish_id ~ '^[A-Za-z0-9_-]{1,40}$'),
  thumb        text not null check (char_length(thumb) <= 40000 and thumb ~ '^data:image/jpeg;base64,[A-Za-z0-9+/]+={0,2}$'),
  photo        text not null check (char_length(photo) <= 400000 and photo ~ '^data:image/jpeg;base64,[A-Za-z0-9+/]+={0,2}$'),
  rev          text not null default '' check (rev ~ '^[A-Za-z0-9]{0,20}$'),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  primary key (household_id, dish_id)
);

alter table public.dish_images enable row level security;
create policy di_all on public.dish_images for all to authenticated
  using (is_member(household_id)) with check (is_member(household_id));
revoke all on public.dish_images from anon;

create trigger dish_images_touch before update on public.dish_images for each row execute function public.touch_item();

-- Höchstens 300 Fotos je Haushalt (so viele Gerichte erlaubt die App); Ersetzen eines vorhandenen Fotos bleibt möglich
create function public.dish_images_cap() returns trigger language plpgsql as $$
begin
  if (select count(*) from public.dish_images where household_id = new.household_id and dish_id <> new.dish_id) >= 300 then
    raise exception 'zu viele Fotos in diesem Haushalt';
  end if;
  return new;
end $$;
create trigger dish_images_cap before insert on public.dish_images for each row execute function public.dish_images_cap();

alter publication supabase_realtime add table public.dish_images;
