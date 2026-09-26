-- =============================================================
-- Construction PM Command Center — Supabase schema
-- Run in: Supabase Dashboard > SQL Editor
-- Safe to re-run: uses IF NOT EXISTS / DROP POLICY IF EXISTS
-- =============================================================

create extension if not exists "pgcrypto";

-- -------------------------------------------------------------
-- Shared trigger: keep updated_at current
-- -------------------------------------------------------------
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- -------------------------------------------------------------
-- 1. projects
-- -------------------------------------------------------------
create table if not exists public.projects (
  id           uuid primary key default gen_random_uuid(),
  name         text not null,
  location     text,
  total_flats  integer not null default 0 check (total_flats >= 0),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- -------------------------------------------------------------
-- 2. flats
-- stage_status example:
-- {"foundation":"done","frame":"in_progress","mep":"pending","finishing":"pending"}
-- -------------------------------------------------------------
create table if not exists public.flats (
  id            uuid primary key default gen_random_uuid(),
  project_id    uuid not null references public.projects(id) on delete cascade,
  block         text not null,
  floor         integer not null,
  flat_number   text not null,
  stage_status  jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (project_id, block, flat_number)
);

create index if not exists flats_project_id_idx on public.flats (project_id);

-- -------------------------------------------------------------
-- 3. daily_logs
-- manpower example:
-- {"masons":6,"carpenters":3,"electricians":2,"labourers":10}
-- -------------------------------------------------------------
create table if not exists public.daily_logs (
  id          uuid primary key default gen_random_uuid(),
  project_id  uuid not null references public.projects(id) on delete cascade,
  log_date    date not null default current_date,
  weather     text,
  manpower    jsonb not null default '{}'::jsonb,
  notes       text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (project_id, log_date)
);

create index if not exists daily_logs_project_date_idx
  on public.daily_logs (project_id, log_date desc);

-- -------------------------------------------------------------
-- 4. delays
-- flat_id is optional: null = site-wide delay
-- -------------------------------------------------------------
create table if not exists public.delays (
  id              uuid primary key default gen_random_uuid(),
  project_id      uuid not null references public.projects(id) on delete cascade,
  flat_id         uuid references public.flats(id) on delete set null,
  delay_cause     text not null,
  duration_hours  numeric(8,2) not null default 0 check (duration_hours >= 0),
  description     text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index if not exists delays_project_id_idx on public.delays (project_id);
create index if not exists delays_flat_id_idx    on public.delays (flat_id);

-- -------------------------------------------------------------
-- 5. cash_flow
-- -------------------------------------------------------------
create table if not exists public.cash_flow (
  id            uuid primary key default gen_random_uuid(),
  project_id    uuid not null references public.projects(id) on delete cascade,
  boq_item      text not null,
  planned_cost  numeric(14,2) not null default 0 check (planned_cost >= 0),
  actual_cost   numeric(14,2) not null default 0 check (actual_cost >= 0),
  status        text not null default 'planned'
                check (status in ('planned', 'committed', 'paid', 'cancelled')),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists cash_flow_project_id_idx on public.cash_flow (project_id);

-- -------------------------------------------------------------
-- updated_at triggers
-- -------------------------------------------------------------
do $$
declare
  t text;
begin
  foreach t in array array['projects','flats','daily_logs','delays','cash_flow']
  loop
    execute format('drop trigger if exists set_updated_at on public.%I', t);
    execute format(
      'create trigger set_updated_at before update on public.%I
         for each row execute function public.set_updated_at()', t);
  end loop;
end;
$$;

-- -------------------------------------------------------------
-- Migration 2026-09-26: project timeline + BOQ detail
-- (additive; safe to re-run on an existing database)
-- -------------------------------------------------------------
alter table public.projects
  add column if not exists start_date date,
  add column if not exists end_date   date;

alter table public.projects drop constraint if exists projects_dates_check;
alter table public.projects add constraint projects_dates_check
  check (start_date is null or end_date is null or end_date >= start_date);

-- cash_flow rows are the project's BOQ: planned_cost = quantity × rate
-- (or a lump sum), actual_cost = spent so far, due_date = when the
-- payment falls due / was paid (drives the monthly cash-flow table).
alter table public.cash_flow
  add column if not exists category text,
  add column if not exists unit     text,
  add column if not exists quantity numeric(14,3) check (quantity is null or quantity >= 0),
  add column if not exists rate     numeric(14,2) check (rate is null or rate >= 0),
  add column if not exists due_date date;

create index if not exists cash_flow_project_due_idx on public.cash_flow (project_id, due_date);

-- -------------------------------------------------------------
-- Migration 2026-09-26 (2): units register + project timetable
-- -------------------------------------------------------------
-- flats rows are the project's units (apartments, commercial, parking…).
-- stage_status is kept for old data but no longer used by the app.
alter table public.flats
  add column if not exists unit_type text,
  add column if not exists area_m2   numeric(10,2) check (area_m2 is null or area_m2 >= 0),
  add column if not exists rooms     smallint check (rooms is null or rooms >= 0),
  add column if not exists status    text not null default 'not_started',
  add column if not exists notes     text;

alter table public.flats drop constraint if exists flats_status_check;
alter table public.flats add constraint flats_status_check
  check (status in ('not_started', 'in_progress', 'finished', 'handed_over'));

-- Daily logs are pasted in Georgian (usually from WhatsApp): raw_text keeps the
-- paste as-is, notes holds Gemini's corrected Georgian and notes_en its English.
alter table public.daily_logs
  add column if not exists notes_en text,
  add column if not exists raw_text text;

-- Per-project currency (amounts are stored as plain numbers in that currency).
alter table public.projects
  add column if not exists currency text not null default 'USD';
alter table public.projects drop constraint if exists projects_currency_check;
alter table public.projects add constraint projects_currency_check
  check (currency in ('USD', 'GEL'));

-- Timetable: overall progress = done activities weighted by planned duration.
create table if not exists public.schedule_tasks (
  id              uuid primary key default gen_random_uuid(),
  project_id      uuid not null references public.projects(id) on delete cascade,
  name            text not null,
  planned_start   date not null,
  planned_finish  date not null,
  done            boolean not null default false,
  done_at         date,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  check (planned_finish >= planned_start)
);

create index if not exists schedule_tasks_project_idx on public.schedule_tasks (project_id, planned_start);

drop trigger if exists set_updated_at on public.schedule_tasks;
create trigger set_updated_at before update on public.schedule_tasks
  for each row execute function public.set_updated_at();

alter table public.schedule_tasks enable row level security;
drop policy if exists "authenticated_full_access" on public.schedule_tasks;
create policy "authenticated_full_access" on public.schedule_tasks
  for all to authenticated using (true) with check (true);

-- -------------------------------------------------------------
-- 6. Row Level Security
-- Full access for any authenticated user; anon gets nothing.
-- -------------------------------------------------------------
do $$
declare
  t text;
begin
  foreach t in array array['projects','flats','daily_logs','delays','cash_flow']
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists "authenticated_full_access" on public.%I', t);
    execute format(
      'create policy "authenticated_full_access" on public.%I
         for all to authenticated
         using (true)
         with check (true)', t);
  end loop;
end;
$$;
