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
-- Incidents, inspections and toolbox talks, with what was done about each one.
-- severity applies to incidents only.
-- -------------------------------------------------------------
create table if not exists public.site_events (
  id             uuid primary key default gen_random_uuid(),
  project_id     uuid not null references public.projects(id) on delete cascade,
  event_date     date not null default current_date,
  kind           text not null default 'incident'
                 check (kind in ('incident', 'inspection', 'toolbox_talk')),
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

-- 'near_miss' was dropped as a kind. A table created before that still allows
-- it, so any row left over is removed before the narrower check goes on.
delete from public.site_events where kind = 'near_miss';
alter table public.site_events drop constraint if exists site_events_kind_check;
alter table public.site_events add constraint site_events_kind_check
  check (kind in ('incident', 'inspection', 'toolbox_talk'));

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

-- -------------------------------------------------------------
-- 19. Crew on site: who brought how many, by trade
-- One row per contractor per trade per day. daily_logs.manpower held the same
-- counts with no contractor against them, which answered how many men were on
-- site but never whose they were - and so never which contractor is short.
-- A null contractor_id is labour the client engaged themselves, through no
-- contractor of ours - so it is counted, but never against anyone's record.
-- Placed here, after contractors: it points at that table and cannot be
-- created before it exists.
-- -------------------------------------------------------------
create table if not exists public.daily_manpower (
  id            uuid primary key default gen_random_uuid(),
  daily_log_id  uuid not null references public.daily_logs(id) on delete cascade,
  contractor_id uuid references public.contractors(id) on delete set null,
  trade         text not null,
  workers       integer not null default 0 check (workers >= 0),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- One entry per contractor and trade. Postgres treats every null as distinct,
-- so directly engaged labour needs a stand-in to be held to the same rule.
create unique index if not exists daily_manpower_unique_idx on public.daily_manpower
  (daily_log_id, coalesce(contractor_id, '00000000-0000-0000-0000-000000000000'::uuid), trade);
create index if not exists daily_manpower_contractor_idx
  on public.daily_manpower (contractor_id);

drop trigger if exists set_updated_at on public.daily_manpower;
create trigger set_updated_at before update on public.daily_manpower
  for each row execute function public.set_updated_at();

alter table public.daily_manpower enable row level security;
drop policy if exists "authenticated_full_access" on public.daily_manpower;
create policy "authenticated_full_access" on public.daily_manpower
  for all to authenticated using (true) with check (true);

-- Carry across whatever the old column holds, once, as unassigned labour.
-- Re-running changes nothing: the unique index above turns the second attempt
-- at the same day and trade into a no-op.
insert into public.daily_manpower (daily_log_id, contractor_id, trade, workers)
select l.id, null, m.key, m.value::int
from public.daily_logs l, jsonb_each_text(l.manpower) as m(key, value)
where m.value ~ '^[0-9]+$' and m.value::int > 0
on conflict do nothing;

notify pgrst, 'reload schema';

-- -------------------------------------------------------------
-- 20. Guards (დარაჯი)
-- A guard is on the client's account in the same way a daily worker is: paid a
-- fixed rate for the day, outside any contractor's price. Counted as its own
-- trade in the crew, and priced from its own rate - a guard's day is not worth
-- a labourer's. projects.guard_rate is the default the log form starts from.
-- -------------------------------------------------------------
alter table public.projects
  add column if not exists guard_rate numeric(10,2) check (guard_rate is null or guard_rate >= 0);
alter table public.daily_logs
  add column if not exists guard_rate numeric(10,2) check (guard_rate is null or guard_rate >= 0);

notify pgrst, 'reload schema';

-- -------------------------------------------------------------
-- 21. Knock-on delays: whose fault, and whose work it cost
-- delays.contractor_id has always meant the contractor at fault, so it is
-- renamed to say so. What it never recorded is who the delay landed on: if the
-- blockwork contractor stops, the plasterer behind him finishes late through no
-- fault of his own, and his record should not carry it.
--
-- One row per timetable item a delay held up. The affected contractor is not
-- stored - it is whoever holds the item, so it can never disagree with the
-- timetable. days_lost is per item because float differs: the same ten-day
-- stoppage may cost the plasterer ten days and the painter three.
--
-- Those days are excused: they come off the item's lateness before a contractor
-- is counted late, and are shown against the delay's cause instead.
-- -------------------------------------------------------------
-- Running the whole file again puts the old column back at section 6, so the
-- two can both be present: rename only when the new one is not there yet, and
-- otherwise drop the empty column section 6 just re-added.
do $$
declare
  has_old boolean := exists (select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'delays' and column_name = 'contractor_id');
  has_new boolean := exists (select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'delays' and column_name = 'cause_contractor_id');
begin
  if has_old and not has_new then
    alter table public.delays rename column contractor_id to cause_contractor_id;
  elsif has_old and has_new then
    -- Anything written to the old column since the rename is still the cause.
    update public.delays set cause_contractor_id = contractor_id
     where cause_contractor_id is null and contractor_id is not null;
    alter table public.delays drop column contractor_id;
  end if;
end;
$$;

alter table public.delays
  add column if not exists cause_contractor_id uuid references public.contractors(id) on delete set null;

drop index if exists delays_contractor_idx;
create index if not exists delays_cause_contractor_idx
  on public.delays (cause_contractor_id);

create table if not exists public.delay_impacts (
  id         uuid primary key default gen_random_uuid(),
  delay_id   uuid not null references public.delays(id) on delete cascade,
  task_id    uuid not null references public.schedule_tasks(id) on delete cascade,
  days_lost  integer not null default 1 check (days_lost >= 1),
  created_at timestamptz not null default now(),
  unique (delay_id, task_id)
);

create index if not exists delay_impacts_delay_idx on public.delay_impacts (delay_id);
create index if not exists delay_impacts_task_idx  on public.delay_impacts (task_id);

alter table public.delay_impacts enable row level security;
drop policy if exists "authenticated_full_access" on public.delay_impacts;
create policy "authenticated_full_access" on public.delay_impacts
  for all to authenticated using (true) with check (true);

notify pgrst, 'reload schema';

-- -------------------------------------------------------------
-- 22. A held-up item loses exactly the days the delay lasted
-- days_lost was asked for per item, on the reasoning that float differs. In
-- practice nobody knows that number, and inventing one is worse than useless:
-- the delay is the reason the work is standing, so for as long as the delay
-- runs the hold-up runs with it. The days now come from the delay itself,
-- which means an ongoing delay keeps excusing days until it is settled,
-- without anyone having to remember to come back and raise the figure.
-- -------------------------------------------------------------
alter table public.delay_impacts drop column if exists days_lost;

notify pgrst, 'reload schema';

-- -------------------------------------------------------------
-- 23. Materials the client buys for a job
-- Some contractors price only their labour, and the client supplies the
-- materials. Each item then has two budgets: budget (the contract, what the
-- contractor is paid) and material_budget (what the client expects to spend on
-- materials for it). Each purchase is dated and names the job it was bought
-- for, so the contractor on that job is who it was supplied to. task_id null =
-- general site stock; deleting a job keeps its purchases as general ones.
-- -------------------------------------------------------------
alter table public.schedule_tasks
  add column if not exists material_budget numeric(14,2) not null default 0
  check (material_budget >= 0);

create table if not exists public.materials (
  id          uuid primary key default gen_random_uuid(),
  project_id  uuid not null references public.projects(id) on delete cascade,
  task_id     uuid references public.schedule_tasks(id) on delete set null,
  bought_on   date not null default current_date,
  item        text not null,
  item_ka     text,
  quantity    numeric(14,3) check (quantity is null or quantity >= 0),
  unit        text,
  unit_price  numeric(14,2) check (unit_price is null or unit_price >= 0),
  amount      numeric(14,2) not null check (amount >= 0),
  supplier    text,
  supplier_ka text,
  note        text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists materials_project_idx on public.materials (project_id, bought_on);
create index if not exists materials_task_idx on public.materials (task_id);

drop trigger if exists set_updated_at on public.materials;
create trigger set_updated_at before update on public.materials
  for each row execute function public.set_updated_at();

alter table public.materials enable row level security;
drop policy if exists "authenticated_full_access" on public.materials;
create policy "authenticated_full_access" on public.materials
  for all to authenticated using (true) with check (true);

notify pgrst, 'reload schema';

-- -------------------------------------------------------------
-- 24. Work done, line by line, on each daily log
-- What was done that day, where and by whom: "Block A, flat 301 - gypsum
-- board, 200 m², Giorgi's company". The room is optional (a facade or the
-- yard is not in one), and so is the quantity (some work is not measured).
-- work is the Georgian, work_en the English. The day and the project come
-- from the log, so deleting the log deletes its lines.
-- -------------------------------------------------------------
create table if not exists public.work_done (
  id             uuid primary key default gen_random_uuid(),
  daily_log_id   uuid not null references public.daily_logs(id) on delete cascade,
  flat_id        uuid references public.flats(id) on delete set null,
  contractor_id  uuid references public.contractors(id) on delete set null,
  work           text not null,
  work_en        text,
  quantity       numeric(14,3) check (quantity is null or quantity >= 0),
  unit           text,
  created_at     timestamptz not null default now()
);

create index if not exists work_done_log_idx on public.work_done (daily_log_id);
create index if not exists work_done_flat_idx on public.work_done (flat_id);
create index if not exists work_done_contractor_idx on public.work_done (contractor_id);

alter table public.work_done enable row level security;
drop policy if exists "authenticated_full_access" on public.work_done;
create policy "authenticated_full_access" on public.work_done
  for all to authenticated using (true) with check (true);

notify pgrst, 'reload schema';

-- -------------------------------------------------------------
-- 25. Work done is entered per room, not through a daily log
-- A line now belongs to the project and a day of its own; the daily log it
-- was first written in, if any, is kept but no longer needed.
-- -------------------------------------------------------------
alter table public.work_done
  add column if not exists project_id uuid references public.projects(id) on delete cascade,
  add column if not exists work_date date;

update public.work_done w
   set project_id = l.project_id, work_date = l.log_date
  from public.daily_logs l
 where l.id = w.daily_log_id and (w.project_id is null or w.work_date is null);

alter table public.work_done
  alter column project_id set not null,
  alter column work_date set not null,
  alter column work_date set default current_date,
  alter column daily_log_id drop not null;

create index if not exists work_done_project_date_idx on public.work_done (project_id, work_date);

notify pgrst, 'reload schema';

-- -------------------------------------------------------------
-- 26. What has actually been paid for the site costs
-- Daily workers and guards are paid by the month, rentals as their supplier
-- asks: each payment is a row here, against a month (labour, guard) or a
-- rental. Materials are paid on purchase or taken on credit (ნისია):
-- paid_on null = still owed, due_on = when the supplier expects it.
-- -------------------------------------------------------------
create table if not exists public.site_payments (
  id          uuid primary key default gen_random_uuid(),
  project_id  uuid not null references public.projects(id) on delete cascade,
  kind        text not null check (kind in ('labour', 'guard', 'rental')),
  month       date,
  rental_id   uuid references public.equipment_rentals(id) on delete cascade,
  amount      numeric(14,2) not null check (amount > 0),
  paid_on     date not null default current_date,
  note        text,
  created_at  timestamptz not null default now(),
  check ((kind = 'rental') = (rental_id is not null)),
  check (kind = 'rental' or month is not null)
);

create index if not exists site_payments_project_idx on public.site_payments (project_id, kind);

alter table public.site_payments enable row level security;
drop policy if exists "authenticated_full_access" on public.site_payments;
create policy "authenticated_full_access" on public.site_payments
  for all to authenticated using (true) with check (true);

-- Materials bought before this were paid for: the column is filled in for them.
alter table public.materials
  add column if not exists due_on date;
do $$
begin
  if not exists (select 1 from information_schema.columns
                 where table_schema = 'public' and table_name = 'materials' and column_name = 'paid_on') then
    alter table public.materials add column paid_on date;
    update public.materials set paid_on = bought_on;
  end if;
end;
$$;

notify pgrst, 'reload schema';

-- -------------------------------------------------------------
-- 27. One administrator; everyone else can only look
-- st@cpmgroup.ge may change anything. Every other signed-in account can read
-- every project but change nothing: the database refuses, whatever the page
-- does. Run last - it turns each table's earlier "authenticated_full_access"
-- policy into read-for-all plus write-for-the-administrator.
-- -------------------------------------------------------------
create or replace function public.is_admin() returns boolean
  language sql stable
as $$
  select coalesce(auth.jwt() ->> 'email', '') = 'st@cpmgroup.ge'
$$;

do $$
declare
  t text;
begin
  for t in
    select distinct tablename from pg_policies
     where schemaname = 'public' and policyname in ('authenticated_full_access', 'read_all', 'admin_write')
  loop
    execute format('drop policy if exists "authenticated_full_access" on public.%I', t);
    execute format('drop policy if exists "read_all" on public.%I', t);
    execute format('drop policy if exists "admin_write" on public.%I', t);
    execute format('create policy "read_all" on public.%I for select to authenticated using (true)', t);
    execute format('create policy "admin_write" on public.%I for all to authenticated
                      using (public.is_admin()) with check (public.is_admin())', t);
  end loop;
end;
$$;

notify pgrst, 'reload schema';

-- -------------------------------------------------------------
-- 28. A room's work entries go with the room
-- Deleting a room deletes what was recorded in it. The same kind of work in
-- other rooms is untouched.
-- -------------------------------------------------------------
alter table public.work_done drop constraint if exists work_done_flat_id_fkey;
alter table public.work_done
  add constraint work_done_flat_id_fkey foreign key (flat_id) references public.flats(id) on delete cascade;

notify pgrst, 'reload schema';
