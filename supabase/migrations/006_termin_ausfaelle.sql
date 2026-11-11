-- FamOS: einzelne Termine einer Serie ausfallen lassen. skip = Liste der ausgefallenen Tage (JSON-Array mit Datumstexten).
-- Einmal im Supabase SQL-Editor ausführen.

alter table public.events
  add column skip jsonb not null default '[]'
  check (jsonb_typeof(skip) = 'array' and jsonb_array_length(skip) <= 100);
