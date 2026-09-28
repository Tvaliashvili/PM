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
-- {"masons":6,"carpenters":3,"electricians":2,"day_workers":10}
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
  duration_days   integer not null default 1 check (duration_days >= 1),
  description     text,          -- Georgian
  description_en  text,          -- English
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

-- The client (employer) who hired the company for this project.
alter table public.projects add column if not exists client_name text;
-- Names are spelled by hand in both languages (documents are bilingual).
alter table public.projects add column if not exists client_name_ka text;

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

-- Timetable items double as the project's BOQ: budget (optionally quantity × rate)
-- and dated payments. The older cash_flow table is no longer used by the app.
alter table public.schedule_tasks
  add column if not exists quantity numeric(14,3) check (quantity is null or quantity >= 0),
  add column if not exists unit     text,
  add column if not exists rate     numeric(14,2) check (rate is null or rate >= 0),
  add column if not exists budget   numeric(14,2) not null default 0 check (budget >= 0);

-- % complete per item (100 = finished; done/done_at are kept in step by the app).
alter table public.schedule_tasks
  add column if not exists progress_pct smallint not null default 0
  check (progress_pct between 0 and 100);
update public.schedule_tasks set progress_pct = 100 where done and progress_pct < 100;

create table if not exists public.task_payments (
  id          uuid primary key default gen_random_uuid(),
  project_id  uuid not null references public.projects(id) on delete cascade,
  task_id     uuid not null references public.schedule_tasks(id) on delete cascade,
  paid_on     date not null default current_date,
  amount      numeric(14,2) not null check (amount > 0),
  note        text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists task_payments_project_idx on public.task_payments (project_id, paid_on);
create index if not exists task_payments_task_idx on public.task_payments (task_id);

drop trigger if exists set_updated_at on public.task_payments;
create trigger set_updated_at before update on public.task_payments
  for each row execute function public.set_updated_at();

alter table public.task_payments enable row level security;
drop policy if exists "authenticated_full_access" on public.task_payments;
create policy "authenticated_full_access" on public.task_payments
  for all to authenticated using (true) with check (true);

-- Contractors belong to one project: each project has its own list, and
-- deleting a project deletes its contractors. Timetable items and delays can
-- name one, which drives the per-contractor on-time/late summary.
create table if not exists public.contractors (
  id              uuid primary key default gen_random_uuid(),
  project_id      uuid not null references public.projects(id) on delete cascade,
  name            text not null,
  trade           text,
  contact_person  text,
  phone           text,
  email           text,
  notes           text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

drop trigger if exists set_updated_at on public.contractors;
create trigger set_updated_at before update on public.contractors
  for each row execute function public.set_updated_at();

alter table public.contractors enable row level security;
drop policy if exists "authenticated_full_access" on public.contractors;
create policy "authenticated_full_access" on public.contractors
  for all to authenticated using (true) with check (true);

alter table public.schedule_tasks
  add column if not exists contractor_id uuid references public.contractors(id) on delete set null;
alter table public.delays
  add column if not exists contractor_id uuid references public.contractors(id) on delete set null;

-- Upgrade from the earlier shared-list design (company list + project_contractors roster):
-- move each contractor onto the project that used it, drop unused ones and the roster table.
alter table public.contractors add column if not exists email text;
alter table public.contractors add column if not exists name_ka text; -- Georgian spelling
alter table public.contractors
  add column if not exists project_id uuid references public.projects(id) on delete cascade;
do $$
begin
  if to_regclass('public.project_contractors') is not null then
    update public.contractors c set project_id = pc.project_id
      from public.project_contractors pc
     where pc.contractor_id = c.id and c.project_id is null;
    drop table public.project_contractors;
  end if;
end;
$$;
update public.contractors c set project_id = t.project_id
  from public.schedule_tasks t where t.contractor_id = c.id and c.project_id is null;
delete from public.contractors where project_id is null;
alter table public.contractors alter column project_id set not null;
create index if not exists contractors_project_idx on public.contractors (project_id);

create index if not exists schedule_tasks_contractor_idx on public.schedule_tasks (contractor_id);
create index if not exists delays_contractor_idx on public.delays (contractor_id);

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

-- -------------------------------------------------------------
-- 7. Delays counted in whole days + description in both languages
-- (migration for databases created with duration_hours; 8 h = 1 day)
-- -------------------------------------------------------------
alter table public.delays
  add column if not exists duration_days integer not null default 1 check (duration_days >= 1),
  add column if not exists description_en text;

do $$
begin
  if exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'delays' and column_name = 'duration_hours') then
    update public.delays set duration_days = greatest(1, ceil(duration_hours / 8.0))::int;
    alter table public.delays drop column duration_hours;
  end if;
end;
$$;

notify pgrst, 'reload schema';

-- -------------------------------------------------------------
-- 8. Not every site has rooms (e.g. a stadium). Rooms page, room fields
-- and room figures in reports only show when has_rooms is ticked.
-- Projects that existed before this column keep their rooms.
-- -------------------------------------------------------------
do $$
begin
  if not exists (select 1 from information_schema.columns
                 where table_schema = 'public' and table_name = 'projects' and column_name = 'has_rooms') then
    alter table public.projects add column has_rooms boolean not null default false;
    update public.projects set has_rooms = true;
  end if;
end;
$$;

notify pgrst, 'reload schema';

-- -------------------------------------------------------------
-- 9. Site costs outside the BOQ
-- Daily workers (დღიური მუშა) are counted in daily_logs.manpower.day_workers
-- and paid a fixed rate per day: cost = headcount × day_rate on that log.
-- projects.day_rate is the default rate the log form starts from.
-- Equipment rentals cost daily_rate × days, spread day by day from start_date.
-- -------------------------------------------------------------
alter table public.projects
  add column if not exists day_rate numeric(10,2) check (day_rate is null or day_rate >= 0);
alter table public.daily_logs
  add column if not exists day_rate numeric(10,2) check (day_rate is null or day_rate >= 0);

create table if not exists public.equipment_rentals (
  id          uuid primary key default gen_random_uuid(),
  project_id  uuid not null references public.projects(id) on delete cascade,
  equipment   text not null,
  supplier    text,
  start_date  date not null default current_date,
  days        integer not null default 1 check (days >= 1),
  daily_rate  numeric(12,2) not null default 0 check (daily_rate >= 0),
  note        text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists equipment_rentals_project_idx on public.equipment_rentals (project_id, start_date);

drop trigger if exists set_updated_at on public.equipment_rentals;
create trigger set_updated_at before update on public.equipment_rentals
  for each row execute function public.set_updated_at();

alter table public.equipment_rentals enable row level security;
drop policy if exists "authenticated_full_access" on public.equipment_rentals;
create policy "authenticated_full_access" on public.equipment_rentals
  for all to authenticated using (true) with check (true);

notify pgrst, 'reload schema';

-- -------------------------------------------------------------
-- 10. Project name in Georgian too (documents are bilingual)
-- -------------------------------------------------------------
alter table public.projects add column if not exists name_ka text;

notify pgrst, 'reload schema';

-- -------------------------------------------------------------
-- 11. Location in Georgian too
-- -------------------------------------------------------------
alter table public.projects add column if not exists location_ka text;

notify pgrst, 'reload schema';

-- -------------------------------------------------------------
-- 12. Georgian spelling for timetable items and rentals
-- (the English column keeps the Georgian text when no English is given)
-- -------------------------------------------------------------
alter table public.schedule_tasks add column if not exists name_ka text;
alter table public.equipment_rentals
  add column if not exists equipment_ka text,
  add column if not exists supplier_ka text;

notify pgrst, 'reload schema';

-- -------------------------------------------------------------
-- 13. Ongoing delays: a delay can be logged before anyone knows how long
-- it will last. duration_days null = still running (days lost are counted
-- from created_at up to today); resolved_on = the day it was settled.
-- -------------------------------------------------------------
alter table public.delays add column if not exists resolved_on date;
alter table public.delays alter column duration_days drop not null;

notify pgrst, 'reload schema';

-- -------------------------------------------------------------
-- 14. Site photos
-- A photo belongs to one daily log or one delay, never both. This table holds
-- only what each photo is of: path = the 1280 px copy shown in the report,
-- thumb_path = the 400 px copy shown in lists. Both are written by the browser
-- after it shrinks the original, so a photo costs ~150 KB.
--
-- The files themselves are in Cloudflare R2, not Supabase Storage (see the
-- photo-url function). The bucket and policy below are left in place for
-- anything uploaded before that move; nothing writes to them now.
-- -------------------------------------------------------------
create table if not exists public.photos (
  id            uuid primary key default gen_random_uuid(),
  project_id    uuid not null references public.projects(id) on delete cascade,
  daily_log_id  uuid references public.daily_logs(id) on delete cascade,
  delay_id      uuid references public.delays(id) on delete cascade,
  path          text not null,
  thumb_path    text not null,
  caption       text,
  bytes         integer,
  created_at    timestamptz not null default now(),
  constraint photos_one_owner check (num_nonnulls(daily_log_id, delay_id) = 1)
);

create index if not exists photos_daily_log_idx on public.photos (daily_log_id);
create index if not exists photos_delay_idx     on public.photos (delay_id);
create index if not exists photos_project_idx   on public.photos (project_id);

alter table public.photos enable row level security;
drop policy if exists "authenticated_full_access" on public.photos;
create policy "authenticated_full_access" on public.photos
  for all to authenticated using (true) with check (true);


notify pgrst, 'reload schema';

-- -------------------------------------------------------------
-- 15. Baseline: the programme as it was approved
-- Planned dates get revised when work slips, which is normal - but once they
-- move, the slippage disappears from every report. The baseline is a frozen
-- copy of the planned dates, written once and never edited, so drift since
-- approval stays visible.
-- -------------------------------------------------------------
alter table public.schedule_tasks
  add column if not exists baseline_start  date,
  add column if not exists baseline_finish date;

alter table public.projects
  add column if not exists baseline_set_on date;

notify pgrst, 'reload schema';

-- -------------------------------------------------------------
-- 16. Site events: safety and quality
-- Incidents, near misses, inspections and toolbox talks. A near miss costs
-- nothing and predicts what the next incident will be, which is why it is
-- recorded next to the rest. severity applies to incidents only.
-- -------------------------------------------------------------
create table if not exists public.site_events (
  id             uuid primary key default gen_random_uuid(),
  project_id     uuid not null references public.projects(id) on delete cascade,
  event_date     date not null default current_date,
  kind           text not null default 'incident'
                 check (kind in ('incident', 'near_miss', 'inspection', 'toolbox_talk')),
  severity       text check (severity in ('first_aid', 'lost_time', 'reportable')),
  title          text not null,
  description    text,          -- Georgian
  description_en text,          -- English
  contractor_id  uuid references public.contractors(id) on delete set null,
  action         text,          -- what was done about it
  closed         boolean not null default false,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create index if not exists site_events_project_date_idx
  on public.site_events (project_id, event_date desc);

drop trigger if exists set_updated_at on public.site_events;
create trigger set_updated_at before update on public.site_events
  for each row execute function public.set_updated_at();

alter table public.site_events enable row level security;
drop policy if exists "authenticated_full_access" on public.site_events;
create policy "authenticated_full_access" on public.site_events
  for all to authenticated using (true) with check (true);

notify pgrst, 'reload schema';

-- -------------------------------------------------------------
-- 17. Retention
-- A share of every certified amount is held back until the work is accepted.
-- task_payments.amount stays the net actually paid, so every existing cost
-- figure is unchanged; retention is what was withheld from that certificate,
-- and gross certified = amount + retention.
-- -------------------------------------------------------------
alter table public.task_payments
  add column if not exists retention numeric(14,2) not null default 0 check (retention >= 0);

alter table public.projects
  add column if not exists retention_pct numeric(5,2) not null default 0
    check (retention_pct >= 0 and retention_pct <= 100);

notify pgrst, 'reload schema';

-- -------------------------------------------------------------
-- 18. Variations (change orders)
-- Extra or altered work instructed after the contract was signed. Editing a
-- task's budget would hide that it was ever extra, which is exactly what gets
-- argued about later - so a variation is its own record, from instruction to
-- approval, carrying both the money and any extension of time claimed with it.
-- -------------------------------------------------------------
create table if not exists public.variations (
  id             uuid primary key default gen_random_uuid(),
  project_id     uuid not null references public.projects(id) on delete cascade,
  ref            text,           -- the number it is known by on site, e.g. VO-03
  title          text not null,
  description    text,           -- Georgian
  description_en text,           -- English
  contractor_id  uuid references public.contractors(id) on delete set null,
  instructed_on  date not null default current_date,
  status         text not null default 'instructed'
                 check (status in ('instructed', 'priced', 'approved', 'rejected')),
  amount         numeric(14,2) not null default 0,
  days_claimed   integer not null default 0 check (days_claimed >= 0),
  decided_on     date,           -- approved or rejected on
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create index if not exists variations_project_idx
  on public.variations (project_id, instructed_on desc);

drop trigger if exists set_updated_at on public.variations;
create trigger set_updated_at before update on public.variations
  for each row execute function public.set_updated_at();

alter table public.variations enable row level security;
drop policy if exists "authenticated_full_access" on public.variations;
create policy "authenticated_full_access" on public.variations
  for all to authenticated using (true) with check (true);

notify pgrst, 'reload schema';
