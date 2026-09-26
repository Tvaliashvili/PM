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
