-- EUR → INR tracker: per-user settings sync.
-- Run once in Supabase → SQL Editor. Safe to re-run.

create table if not exists public.fx_tracker_settings (
  user_id uuid primary key default auth.uid() references auth.users (id) on delete cascade,
  value jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.fx_tracker_settings enable row level security;

drop policy if exists "own settings" on public.fx_tracker_settings;
create policy "own settings" on public.fx_tracker_settings
  for all to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

-- If you ran the earlier version of this app's SQL, that table was readable and
-- writable by anyone with the anon key. Remove it:
-- drop table if exists public.fx_tracker_kv;
