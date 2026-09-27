// =============================================================
// CPMG PM — main app logic
// =============================================================
import {
  SUPABASE_URL, SUPABASE_KEY, CURRENCIES, DEFAULT_CURRENCY,
  UNIT_TYPES, UNIT_STATUSES,
  MANPOWER_TRADES, WEATHER_OPTIONS, DELAY_CAUSES,
  BOQ_UNITS, CONTRACTOR_TRADES,
} from './config.js';
import { generateDailyReport } from './pdfReport.js';
import { buildProjectReport, downloadProjectReport } from './projectReport.js';
import {
  scheduleProgress, taskState, durationDays, completionOf,
  plannedSpendByMonth, actualSpendByMonth, costPosition, contractorPerformance,
} from './schedule.js';
import { ka } from './bilingual.js';

// ---------- Supabase ----------
const isConfigured = !SUPABASE_URL.includes('YOUR-') && !SUPABASE_KEY.includes('YOUR-');
const db = isConfigured ? window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY) : null;

const state = {
  user: null,
  projects: [],
  projectsLoaded: false,
  projectId: null,
  // Open project:
  flats: [],            // units
  tasks: [],            // timetable items (also the BOQ)
  payments: [],         // task_payments
  contractorDelays: [], // delays with contractor_id + hours
  contractors: [],      // this project's contractors
  progress: null,       // scheduleProgress() result
};

// ---------- Helpers ----------
const $  = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

// Money is shown in the open project's currency ($ or ₾).
const moneyFormats = new Map();
function moneyFormat(decimals) {
  const currency = state.projects.find((p) => p.id === state.projectId)?.currency ?? DEFAULT_CURRENCY;
  const key = `${currency}:${decimals}`;
  if (!moneyFormats.has(key)) {
    moneyFormats.set(key, new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency,
      currencyDisplay: 'narrowSymbol',
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    }));
  }
  return moneyFormats.get(key);
}
const money  = { format: (n) => moneyFormat(0).format(n) };
const money2 = { format: (n) => moneyFormat(2).format(n) };

const todayISO = () => new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD, local time

const formatDate = (iso) => new Date(`${iso}T00:00`).toLocaleDateString(undefined, {
  day: 'numeric', month: 'short', year: 'numeric',
});

const floorLabel = (floor) => {
  if (floor === 0) return 'Ground';
  if (floor < 0) return `Basement ${-floor}`;
  return `Floor ${floor}`;
};

const storage = {
  get(key) { try { return localStorage.getItem(key); } catch { return null; } },
  set(key, val) { try { localStorage.setItem(key, val); } catch { /* storage unavailable */ } },
};

function toast(message, type = 'info') {
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.setAttribute('role', type === 'error' ? 'alert' : 'status');
  el.textContent = message;
  $('#toast-root').appendChild(el);
  setTimeout(() => el.remove(), 4000);
}

function setBusy(btn, busy, busyLabel = 'Saving…') {
  btn.disabled = busy;
  if (busy) {
    btn.dataset.label = btn.textContent;
    btn.textContent = busyLabel;
  } else if (btn.dataset.label) {
    btn.textContent = btn.dataset.label;
  }
}

function showFormError(form, message) {
  const el = $('[data-error]', form);
  el.textContent = message || '';
  el.classList.toggle('hidden', !message);
}

function setProjectActionsEnabled(enabled) {
  ['#btn-new-log', '#btn-new-log-page', '#btn-new-delay', '#btn-export-pdf', '#btn-report-daily', '#btn-view-report', '#btn-add-unit', '#btn-add-task', '#btn-add-contractor',
    '#btn-edit-project'].forEach((sel) => { $(sel).disabled = !enabled; });
}

// =============================================================
// Navigation + mobile sidebar
// =============================================================
function setSidebar(open) {
  $('#sidebar').classList.toggle('-translate-x-full', !open);
  $('#sidebar-overlay').classList.toggle('hidden', !open);
}

// Two views: the full-page project list (#projects, default) and the project workspace,
// whose sections (#dashboard, #timetable, #units, …) all need a selected project.
function route() {
  const sections = $$('[data-section]');
  const requested = location.hash.slice(1);
  let target = sections.some((s) => s.dataset.section === requested) ? requested : 'projects';

  // Before projects load, keep the requested page so a refresh on #dashboard lands back there.
  if (target !== 'projects' && state.projectsLoaded && !state.projectId) {
    target = 'projects';
    history.replaceState(null, '', '#projects');
  }

  const onList = target === 'projects';
  $('#view-projects').classList.toggle('hidden', !onList);
  $('#view-workspace').classList.toggle('hidden', onList);

  sections.forEach((s) => s.classList.toggle('hidden', s.dataset.section !== target));
  $$('[data-nav]').forEach((l) => l.classList.toggle('active', l.dataset.nav === target));
  window.scrollTo(0, 0);
  $('#main-content').scrollTop = 0;
  setSidebar(false);

  if (onList && state.projectsLoaded) renderProjectList();
}

function goTo(name) {
  if (location.hash === `#${name}`) route();
  else location.hash = name;
}

function initNavigation() {
  window.addEventListener('hashchange', route);
  $('#sidebar-toggle').addEventListener('click', () => setSidebar(true));
  $('#sidebar-overlay').addEventListener('click', () => setSidebar(false));
  route();
}

// =============================================================
// Auth
// =============================================================
function initAuth() {
  db.auth.onAuthStateChange((_event, session) => {
    // Deferred: Supabase advises against awaiting client calls inside this callback.
    setTimeout(() => handleSession(session), 0);
  });
}

function handleSession(session) {
  const user = session?.user ?? null;
  if (user && user.id === state.user?.id) return; // token refresh, same user

  state.user = user;
  $$('[data-user-email]').forEach((el) => { el.textContent = user?.email ?? 'Not signed in'; });
  $$('[data-sign-out]').forEach((el) => el.classList.toggle('hidden', !user));

  if (user) {
    closeModal('modal-login');
    loadProjects();
  } else {
    openModal('modal-login');
  }
}

async function signIn(e) {
  e.preventDefault();
  const form = e.currentTarget;
  const btn  = $('[type=submit]', form);
  const fd   = new FormData(form);

  showFormError(form, '');
  setBusy(btn, true, 'Signing in…');
  const { error } = await db.auth.signInWithPassword({
    email: fd.get('email').trim(),
    password: fd.get('password'),
  });
  setBusy(btn, false);

  if (error) showFormError(form, error.message);
  // On success, onAuthStateChange takes over.
}

async function signOut() {
  await db.auth.signOut();
  location.reload();
}

function showSetupNotice() {
  $('#btn-new-project').disabled = true;
  $('#projects-container').textContent = 'Add your Supabase URL and anon key in js/config.js to get started.';
}

// =============================================================
// Projects
// =============================================================
async function loadProjects() {
  const { data, error } = await db
    .from('projects')
    .select('id, name, location, client_name, client_name_ka, total_flats, created_at, start_date, end_date, currency')
    .order('created_at', { ascending: false });

  if (error) {
    $('#projects-container').textContent = `Could not load projects: ${error.message}`;
    toast(`Could not load projects: ${error.message}`, 'error');
    return;
  }

  state.projects = data;

  // Reopen the last project after a refresh; otherwise start on the list.
  const saved = storage.get('cpm.projectId');
  state.projectsLoaded = true;
  selectProject(data.some((p) => p.id === saved) ? saved : null);
  route();
}

async function selectProject(projectId) {
  state.projectId = projectId || null;
  state.flats = [];
  state.tasks = [];
  state.payments = [];
  state.contractorDelays = [];
  state.contractors = [];
  setProjectActionsEnabled(Boolean(state.projectId));

  const project = currentProject();
  applyProjectHeader(project);

  if (!project) {
    storage.set('cpm.projectId', '');
    return;
  }

  storage.set('cpm.projectId', project.id);
  await Promise.all([
    loadUnits(project.id), loadSchedule(project.id), refreshDashboard(project.id), loadLogs(project.id),
  ]);
}

// The UI is English: show the English client name, else the Georgian one.
const clientOf = (p) => p?.client_name || p?.client_name_ka || '';

const currentProject = () => state.projects.find((p) => p.id === state.projectId);

// Project name/location wherever it's shown in the workspace.
function applyProjectHeader(project) {
  const navLabel = $('#nav-project-name');
  navLabel.textContent = project?.name ?? '';
  navLabel.classList.toggle('hidden', !project);
  $('#topbar-project-name').textContent = project?.name ?? '';
  $('#topbar-project-location').textContent = [project?.location, clientOf(project) && `Client: ${clientOf(project)}`]
    .filter(Boolean).join(' · ');
  $('#dashboard-subtitle').textContent = project
    ? [project.name, project.location, clientOf(project) && `Client: ${clientOf(project)}`].filter(Boolean).join(' · ')
    : 'Select a project to view its status.';
}

function openProject(projectId) {
  if (projectId !== state.projectId) selectProject(projectId);
  goTo('dashboard');
}

// ---------- Projects list ----------
let projectListRequest = 0;

async function renderProjectList() {
  const el = $('#projects-container');

  if (!state.projects.length) {
    el.className = 'panel empty-state';
    el.innerHTML = `
      <div class="space-y-2 py-6">
        <p class="text-base font-medium text-white">No projects yet</p>
        <p>Click <span class="text-brand-400">New Project</span> above to create your first one.</p>
      </div>`;
    return;
  }

  const request = ++projectListRequest;
  const [tasks, delays] = await Promise.all([
    db.from('schedule_tasks').select('project_id, planned_start, planned_finish, done'),
    db.from('delays').select('project_id'),
  ]);
  if (request !== projectListRequest) return; // a newer render started
  if (tasks.error || delays.error) toast('Could not load project stats.', 'error');

  const tasksByProject = new Map(state.projects.map((p) => [p.id, []]));
  for (const t of tasks.data ?? []) tasksByProject.get(t.project_id)?.push(t);
  const delayCount = new Map();
  for (const d of delays.data ?? []) delayCount.set(d.project_id, (delayCount.get(d.project_id) ?? 0) + 1);

  const today = todayISO();
  el.className = 'projects-grid';
  el.innerHTML = state.projects.map((p) => {
    const prog = scheduleProgress(tasksByProject.get(p.id) ?? [], today);
    const s = { units: p.total_flats ?? 0, overdue: prog.overdue.length, delays: delayCount.get(p.id) ?? 0 };
    const pct = prog.actualPct;
    return `
      <article class="project-card${p.id === state.projectId ? ' is-active' : ''}">
        <button type="button" class="project-card-open" data-open-project="${esc(p.id)}">
          <p class="pr-8 font-semibold text-white truncate">${esc(p.name)}</p>
          <p class="text-sm text-slate-500 truncate">${esc(p.location || 'No location set')} · ${esc(p.currency ?? DEFAULT_CURRENCY)}</p>
          ${clientOf(p) ? `<p class="text-xs text-slate-400 truncate">Client: ${esc(clientOf(p))}</p>` : ''}
          <p class="text-xs text-slate-500 mt-1">${p.start_date && p.end_date
            ? `${esc(formatDate(p.start_date))} → ${esc(formatDate(p.end_date))}`
            : 'Dates not set'}</p>
          <div class="mt-4 flex items-center gap-3">
            <div class="flex-1 h-1.5 rounded-full bg-ink-700 overflow-hidden">
              <div class="h-full bg-emerald-500" style="width:${pct}%"></div>
            </div>
            <span class="text-xs text-slate-400 tabular-nums">${pct}%</span>
          </div>
          <dl class="project-stats">
            <div><dt>Rooms</dt><dd>${s.units}</dd></div>
            <div><dt>Overdue</dt><dd class="${s.overdue ? 'is-alert' : ''}">${s.overdue}</dd></div>
            <div><dt>Delays</dt><dd class="${s.delays ? 'is-alert' : ''}">${s.delays}</dd></div>
          </dl>
        </button>
        <button type="button" class="project-card-delete" data-delete-project="${esc(p.id)}"
                title="Delete project" aria-label="Delete ${esc(p.name)}">
          <svg viewBox="0 0 24 24" class="w-4 h-4 fill-current"><path d="M6 19a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>
        </button>
      </article>`;
  }).join('');
}

function onProjectsClick(e) {
  const open = e.target.closest('[data-open-project]');
  if (open) return openProject(open.dataset.openProject);

  const del = e.target.closest('[data-delete-project]');
  if (del) deleteProject(del.dataset.deleteProject);
}

async function deleteProject(projectId) {
  const project = state.projects.find((p) => p.id === projectId);
  if (!project) return;
  if (!confirm(`Delete "${project.name}" and everything in it?\n\n`
    + 'This permanently removes its timetable, budgets and payments, contractors, units, '
    + 'daily logs and delays. This cannot be undone.')) return;

  const { error } = await db.from('projects').delete().eq('id', projectId);
  if (error) {
    toast(`Could not delete project: ${error.message}`, 'error');
    return;
  }

  toast(`Deleted ${project.name}.`, 'success');
  if (state.projectId === projectId) selectProject(null);
  await loadProjects();
}

// ---------- New project ----------
function openProjectModal() {
  const form = $('#form-project');
  form.reset();
  showFormError(form, '');
  openModal('modal-project');
}

async function saveProject(e) {
  e.preventDefault();
  const form = e.currentTarget;
  const btn  = $('[type=submit]', form);
  const fd   = new FormData(form);

  showFormError(form, '');
  setBusy(btn, true, 'Creating…');
  const { data: project, error } = await db
    .from('projects')
    .insert({
      name: fd.get('name').trim(),
      location: fd.get('location').trim() || null,
      client_name: fd.get('client_name').trim() || null,
      client_name_ka: fd.get('client_name_ka').trim() || null,
      currency: fd.get('currency') || DEFAULT_CURRENCY,
    })
    .select('id')
    .single();
  setBusy(btn, false);

  if (error) {
    showFormError(form, error.message);
    return;
  }

  closeModal('modal-project');
  toast('Project created. Add its timetable, rooms and dates next.', 'success');

  // Open the new project on its Timetable, which drives progress.
  storage.set('cpm.projectId', project.id);
  await loadProjects();
  goTo('timetable');
}

// =============================================================
// Units register (stored in the flats table)
// =============================================================
const UNIT_STATUS_CHIP = {
  not_started: 'status-pending',
  in_progress: 'status-in_progress',
  finished:    'status-done',
  handed_over: 'status-handed',
};
const areaFormat = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });
const numOrNull = (v) => (v === '' || v == null ? null : Number(v));

async function loadUnits(projectId) {
  const { data, error } = await db
    .from('flats')
    .select('id, block, floor, flat_number, unit_type, area_m2, rooms, status, notes')
    .eq('project_id', projectId)
    .order('block')
    .order('floor')
    .order('flat_number');

  if (projectId !== state.projectId) return; // project switched mid-request
  if (error) {
    $('#units-table').innerHTML = `<div class="empty-state">Could not load units: ${esc(error.message)}</div>`;
    return;
  }
  state.flats = data;
  renderUnits();
}

function renderUnits() {
  const units = state.flats;
  const count = (status) => units.filter((u) => (u.status ?? 'not_started') === status).length;
  const withArea = units.filter((u) => u.area_m2 != null);
  const area = sumOf(withArea, 'area_m2');

  const types = new Map();
  for (const u of units) if (u.unit_type) types.set(u.unit_type, (types.get(u.unit_type) ?? 0) + 1);
  const typeSummary = [...types].sort((a, b) => b[1] - a[1]).slice(0, 3)
    .map(([type, n]) => `${n} × ${type}`).join(' · ') || 'No types set';

  $('#units-summary').innerHTML = [
    statTile('Rooms', String(units.length), typeSummary),
    statTile('Total area', `${areaFormat.format(area)} m²`,
      withArea.length ? `Average ${areaFormat.format(area / withArea.length)} m²` : 'No areas entered'),
    statTile('Finished', String(count('finished') + count('handed_over')), `${count('in_progress')} in progress`),
    statTile('Handed over', String(count('handed_over')), `${count('not_started')} not started`),
  ].join('');

  if (!units.length) {
    $('#units-table').innerHTML = '<div class="empty-state">No rooms yet — click Add Room.</div>';
    return;
  }

  const rows = units.map((u) => `
    <tr>
      <td class="font-medium text-white whitespace-nowrap">${esc(u.flat_number)}</td>
      <td>${esc(u.block)}</td>
      <td class="whitespace-nowrap">${esc(floorLabel(u.floor))}</td>
      <td>${u.unit_type ? esc(u.unit_type) : '<span class="text-slate-500">—</span>'}</td>
      <td class="num">${u.area_m2 != null ? areaFormat.format(u.area_m2) : '—'}</td>
      <td><span class="status-chip ${UNIT_STATUS_CHIP[u.status] ?? 'status-pending'}">${esc(UNIT_STATUSES[u.status] ?? u.status)}</span></td>
      <td class="max-w-[16rem] truncate text-slate-400" title="${esc(u.notes ?? '')}">${esc(u.notes ?? '')}</td>
      <td class="text-right whitespace-nowrap">
        <button type="button" class="table-action" data-unit-edit="${esc(u.id)}">Edit</button>
        <button type="button" class="table-action is-danger" data-unit-delete="${esc(u.id)}">Delete</button>
      </td>
    </tr>`).join('');

  $('#units-table').innerHTML = `
    <table class="data-table">
      <thead>
        <tr>
          <th>Room</th><th>Block</th><th>Floor</th><th>Type</th><th class="num">Area m²</th>
          <th>Status</th><th>Notes</th><th></th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
      <tfoot>
        <tr>
          <td colspan="4">${units.length} rooms</td>
          <td class="num">${areaFormat.format(area)}</td>
          <td colspan="3"></td>
        </tr>
      </tfoot>
    </table>`;
}

function openUnitModal(unit) {
  if (!requireProject()) return;
  const form = $('#form-unit');
  const f = form.elements;
  form.reset();
  showFormError(form, '');
  $('#unit-title').textContent = unit ? `Edit Room ${unit.flat_number}` : 'Add Room';

  f.id.value = unit?.id ?? '';
  if (unit) {
    f.block.value = unit.block;
    f.floor.value = unit.floor;
    f.flat_number.value = unit.flat_number;
    f.unit_type.value = unit.unit_type ?? '';
    f.area_m2.value = unit.area_m2 ?? '';
    f.status.value = unit.status ?? 'not_started';
    f.notes.value = unit.notes ?? '';
  } else {
    const last = state.flats.at(-1); // continue where the list ends
    f.block.value = last?.block ?? 'A';
    f.floor.value = last?.floor ?? 1;
    f.status.value = 'not_started';
  }
  openModal('modal-unit');
}

async function saveUnit(e) {
  e.preventDefault();
  const form = e.currentTarget;
  const btn  = $('[type=submit]', form);
  const fd   = new FormData(form);
  const projectId = state.projectId;

  const id = fd.get('id');
  const row = {
    block:       fd.get('block').trim(),
    floor:       parseInt(fd.get('floor'), 10),
    flat_number: fd.get('flat_number').trim(),
    unit_type:   fd.get('unit_type') || null,
    area_m2:     numOrNull(fd.get('area_m2')),
    status:      fd.get('status'),
    notes:       fd.get('notes').trim() || null,
  };

  showFormError(form, '');
  setBusy(btn, true);
  const { error } = id
    ? await db.from('flats').update(row).eq('id', id)
    : await db.from('flats').insert({ ...row, project_id: projectId, stage_status: {} });
  setBusy(btn, false);

  if (error) {
    showFormError(form, error.code === '23505'
      ? `Room ${row.flat_number} already exists in block ${row.block}.`
      : error.message);
    return;
  }

  closeModal('modal-unit');
  toast(id ? 'Room updated.' : 'Room added.', 'success');
  await syncFlatCount(projectId);
  if (projectId === state.projectId) loadUnits(projectId);
}

async function onUnitsTableClick(e) {
  const edit = e.target.closest('[data-unit-edit]');
  if (edit) {
    openUnitModal(state.flats.find((u) => u.id === edit.dataset.unitEdit));
    return;
  }

  const del = e.target.closest('[data-unit-delete]');
  if (!del) return;
  const unit = state.flats.find((u) => u.id === del.dataset.unitDelete);
  if (!unit || !confirm(`Delete room ${unit.flat_number} (block ${unit.block})?\n\nDelays linked to it are kept as site-wide.`)) return;

  const projectId = state.projectId;
  const { error } = await db.from('flats').delete().eq('id', unit.id);
  if (error) {
    toast(`Could not delete unit: ${error.message}`, 'error');
    return;
  }
  toast(`Deleted room ${unit.flat_number}.`, 'success');
  await syncFlatCount(projectId);
  if (projectId === state.projectId) loadUnits(projectId);
}

// Keeps projects.total_flats in step with the flats table (used by reports).
async function syncFlatCount(projectId) {
  const { count, error } = await db
    .from('flats')
    .select('id', { count: 'exact', head: true })
    .eq('project_id', projectId);
  if (error) return;
  await db.from('projects').update({ total_flats: count }).eq('id', projectId);
  const project = state.projects.find((p) => p.id === projectId);
  if (project) project.total_flats = count;
}

// =============================================================
// Timetable (schedule_tasks) — drives progress, and doubles as the BOQ:
// each item has dates, a contractor, a budget and dated payments.
// =============================================================
const addDays = (iso, n) => {
  const d = new Date(`${iso}T00:00`);
  d.setDate(d.getDate() + n);
  return d.toLocaleDateString('en-CA');
};

const contractorName = (id) => state.contractors.find((c) => c.id === id)?.name ?? '';
const paidOn = (taskId) => sumOf(state.payments.filter((p) => p.task_id === taskId), 'amount');

// Items, payments and contractor-linked delays for one project, then every view built on them.
async function loadSchedule(projectId) {
  const [tasks, payments, delays, contractors] = await Promise.all([
    db.from('schedule_tasks')
      .select('id, name, planned_start, planned_finish, done, done_at, progress_pct, contractor_id, quantity, unit, rate, budget')
      .eq('project_id', projectId)
      .order('planned_start')
      .order('planned_finish'),
    db.from('task_payments')
      .select('id, task_id, paid_on, amount, note')
      .eq('project_id', projectId)
      .order('paid_on'),
    db.from('delays')
      .select('contractor_id, duration_hours')
      .eq('project_id', projectId),
    db.from('contractors')
      .select('id, name, name_ka, trade, contact_person, phone, email, notes')
      .eq('project_id', projectId)
      .order('name'),
  ]);

  if (projectId !== state.projectId) return;
  const failed = [tasks, payments, delays, contractors].find((r) => r.error);
  if (failed) {
    $('#schedule-table').innerHTML = `<div class="empty-state">Could not load timetable: ${esc(failed.error.message)}</div>`;
    return;
  }
  state.tasks = tasks.data;
  state.payments = payments.data;
  state.contractorDelays = delays.data;
  state.contractors = contractors.data;
  renderScheduleViews();
}

function renderScheduleViews() {
  renderSchedule();
  renderCosts();
  renderContractors();
  if (!$('#modal-payments').open) return;
  renderPaymentsList();
}

function taskStateChip(task, s) {
  if (s.key === 'done') {
    const when = task.done_at ? ` ${formatDate(task.done_at)}` : '';
    const late = s.daysLate ? ` · ${s.daysLate} d late` : '';
    return `<span class="status-chip status-done">✓ Done${esc(when)}${late}</span>`;
  }
  if (s.key === 'overdue') {
    return `<span class="status-chip status-blocked">! Overdue · ${s.daysLate} d · ${Math.round(completionOf(task) * 100)}%</span>`;
  }
  if (s.key === 'active') return '<span class="status-chip status-in_progress">In progress</span>';
  return '<span class="status-chip status-pending">Upcoming</span>';
}

// Work done vs planned by today, in words (within 5% counts as on track).
function planStatus(gap) {
  if (gap < -5) return 'Behind plan';
  if (gap > 5) return 'Ahead of plan';
  return 'On track';
}

function renderSchedule() {
  const today = todayISO();
  const p = scheduleProgress(state.tasks, today);
  state.progress = p;
  updateProgressKpi();

  const gap = p.actualPct - p.plannedPct;
  $('#schedule-summary').innerHTML = [
    statTile('Progress', `${p.actualPct}%`, `${p.doneCount} of ${p.count} items done`),
    statTile('Planned by today', `${p.plannedPct}%`,
      !p.count ? '—' : planStatus(gap), gap < -5 ? 'negative' : ''),
    statTile('Overdue', String(p.overdue.length),
      p.overdue.length ? `Longest: ${p.overdue[0].daysLate} days late` : 'Nothing overdue', p.overdue.length ? 'negative' : ''),
    statTile('Remaining', `${100 - p.actualPct}%`, `${p.count - p.doneCount} items left`),
  ].join('');

  if (!state.tasks.length) {
    $('#schedule-table').innerHTML = '<div class="empty-state">No items yet — click Add Item to build the timetable. Progress, the BOQ and cash flow are all calculated from it.</div>';
    return;
  }

  const rows = state.tasks.map((t) => {
    const s = taskState(t, today);
    return `
      <tr class="${s.key === 'overdue' ? 'is-overdue' : ''}${t.done ? ' is-done' : ''}">
        <td class="task-pct-cell">
          <div class="task-pct">
            <input type="number" min="0" max="100" step="5" inputmode="numeric" class="task-pct-input"
                   value="${Math.round(completionOf(t) * 100)}" data-task-pct="${esc(t.id)}"
                   aria-label="Percent complete for ${esc(t.name)}"><span>%</span>
          </div>
          <div class="task-pct-bar"><div style="width:${Math.round(completionOf(t) * 100)}%"></div></div>
        </td>
        <td class="task-name">${esc(t.name)}</td>
        <td>
          <select class="select-dark select-inline" data-task-contractor="${esc(t.id)}"
                  aria-label="Contractor for ${esc(t.name)}">${contractorOptions(t.contractor_id ?? '')}</select>
        </td>
        <td class="whitespace-nowrap">${esc(formatDate(t.planned_start))}</td>
        <td class="whitespace-nowrap">${esc(formatDate(t.planned_finish))}</td>
        <td class="num">${durationDays(t)} d</td>
        <td class="num">${Number(t.budget) ? money.format(t.budget) : '—'}</td>
        <td class="whitespace-nowrap">${taskStateChip(t, s)}</td>
        <td class="text-right whitespace-nowrap">
          <button type="button" class="table-action" data-task-edit="${esc(t.id)}">Edit</button>
          <button type="button" class="table-action is-danger" data-task-delete="${esc(t.id)}">Delete</button>
        </td>
      </tr>`;
  }).join('');

  $('#schedule-table').innerHTML = `
    <table class="data-table">
      <thead>
        <tr>
          <th>% done</th><th>Work item</th><th>Contractor</th><th>Start</th><th>Finish</th>
          <th class="num">Days</th><th class="num">Budget</th><th>Status</th><th></th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>`;
}

// Saves an item's % complete. 100% = finished: done is set and the finish
// date recorded (kept if it was already finished), which drives on-time/late.
async function setTaskPercent(taskId, rawValue) {
  const task = state.tasks.find((t) => t.id === taskId);
  if (!task) return;
  const pct = Math.min(100, Math.max(0, Math.round(Number(rawValue) || 0)));
  const prev = { progress_pct: task.progress_pct, done: task.done, done_at: task.done_at };
  if (pct === Math.round(completionOf(task) * 100)) return renderSchedule(); // unchanged (re-clamp display)

  // Optimistic update, rolled back on failure.
  task.progress_pct = pct;
  task.done = pct === 100;
  task.done_at = task.done ? (prev.done ? prev.done_at : todayISO()) : null;
  renderScheduleViews();

  const { error } = await db
    .from('schedule_tasks')
    .update({ progress_pct: task.progress_pct, done: task.done, done_at: task.done_at })
    .eq('id', task.id);
  if (error) {
    Object.assign(task, prev);
    renderScheduleViews();
    toast(`Could not update "${task.name}": ${error.message}`, 'error');
  }
}

// Dropdown options: this project's contractors.
function contractorOptions(selectedId) {
  return '<option value="">— None —</option>'
    + state.contractors.map((c) => `
      <option value="${esc(c.id)}"${c.id === selectedId ? ' selected' : ''}>
        ${esc(c.name)}${c.trade ? ` · ${esc(c.trade)}` : ''}
      </option>`).join('');
}

function updateTaskDuration() {
  const f = $('#form-task').elements;
  const start = f.planned_start.value;
  const finish = f.planned_finish.value;
  $('#task-duration').textContent = start && finish
    ? (finish < start ? 'Finish is before start.' : `${durationDays({ planned_start: start, planned_finish: finish })} days`)
    : '';
}

function openTaskModal(task) {
  if (!requireProject()) return;
  const form = $('#form-task');
  const f = form.elements;
  form.reset();
  showFormError(form, '');
  $('#task-title').textContent = task ? 'Edit Item' : 'Add Item';
  $('#task-contractor').innerHTML = contractorOptions(task?.contractor_id ?? '');

  f.id.value = task?.id ?? '';
  if (task) {
    f.name.value = task.name;
    f.planned_start.value = task.planned_start;
    f.planned_finish.value = task.planned_finish;
    f.quantity.value = task.quantity ?? '';
    f.unit.value = task.unit ?? '';
    f.rate.value = task.rate ?? '';
    f.budget.value = Number(task.budget) ? task.budget : '';
  } else {
    // Start the day after the last item, else at the project start, else today.
    const last = state.tasks.reduce((max, t) => (t.planned_finish > max ? t.planned_finish : max), '');
    const start = last ? addDays(last, 1) : (currentProject()?.start_date ?? todayISO());
    f.planned_start.value = start;
    f.planned_finish.value = addDays(start, 6);
  }
  updateTaskDuration();
  openModal('modal-task');
}

// Dates → duration hint; quantity × rate → budget.
function onTaskInput(e) {
  updateTaskDuration();
  if (!['quantity', 'rate'].includes(e.target.name)) return;
  const f = e.currentTarget.elements;
  const qty = parseFloat(f.quantity.value);
  const rate = parseFloat(f.rate.value);
  if (qty >= 0 && rate >= 0) f.budget.value = (Math.round(qty * rate * 100) / 100).toFixed(2);
}

async function saveTask(e) {
  e.preventDefault();
  const form = e.currentTarget;
  const btn  = $('[type=submit]', form);
  const fd   = new FormData(form);

  const id = fd.get('id');
  const row = {
    name:           fd.get('name').trim(),
    contractor_id:  fd.get('contractor_id') || null,
    planned_start:  fd.get('planned_start'),
    planned_finish: fd.get('planned_finish'),
    quantity:       numOrNull(fd.get('quantity')),
    unit:           fd.get('unit') || null,
    rate:           numOrNull(fd.get('rate')),
    budget:         Number(fd.get('budget') || 0),
  };
  if (row.planned_finish < row.planned_start) {
    showFormError(form, 'Planned finish must be on or after the planned start.');
    return;
  }

  showFormError(form, '');
  setBusy(btn, true);
  const { error } = id
    ? await db.from('schedule_tasks').update(row).eq('id', id)
    : await db.from('schedule_tasks').insert({ ...row, project_id: state.projectId });
  setBusy(btn, false);

  if (error) {
    showFormError(form, error.message);
    return;
  }

  closeModal('modal-task');
  toast(id ? 'Item updated.' : 'Item added.', 'success');
  loadSchedule(state.projectId);
}

async function deleteTask(taskId) {
  const task = state.tasks.find((t) => t.id === taskId);
  const payments = state.payments.filter((p) => p.task_id === taskId).length;
  const extra = payments ? `\n\nIts ${payments} payment(s) will be deleted too.` : '';
  if (!task || !confirm(`Delete "${task.name}"?${extra}`)) return;

  const { error } = await db.from('schedule_tasks').delete().eq('id', task.id);
  if (error) {
    toast(`Could not delete item: ${error.message}`, 'error');
    return;
  }
  toast('Item deleted.', 'success');
  loadSchedule(state.projectId);
}

function onScheduleChange(e) {
  const pct = e.target.closest('[data-task-pct]');
  if (pct) return setTaskPercent(pct.dataset.taskPct, pct.value);

  const contractor = e.target.closest('[data-task-contractor]');
  if (contractor) assignContractor(contractor.dataset.taskContractor, contractor.value || null);
}

// Contractor dropdown on a timetable row.
async function assignContractor(taskId, contractorId) {
  const task = state.tasks.find((t) => t.id === taskId);
  if (!task) return;
  const prev = task.contractor_id;

  task.contractor_id = contractorId;
  renderScheduleViews();

  const { error } = await db.from('schedule_tasks').update({ contractor_id: contractorId }).eq('id', task.id);
  if (error) {
    task.contractor_id = prev;
    renderScheduleViews();
    toast(`Could not assign contractor: ${error.message}`, 'error');
  }
}

// Edit / delete / payments buttons, shared by the Timetable and BOQ tables.
function onTaskTableClick(e) {
  const edit = e.target.closest('[data-task-edit]');
  if (edit) return openTaskModal(state.tasks.find((t) => t.id === edit.dataset.taskEdit));

  const del = e.target.closest('[data-task-delete]');
  if (del) return deleteTask(del.dataset.taskDelete);

  const pay = e.target.closest('[data-task-payments]');
  if (pay) openPaymentsModal(pay.dataset.taskPayments);
}

// =============================================================
// Dashboard KPIs + recent activity
// =============================================================
function updateProgressKpi() {
  const p = state.progress;
  if (!p) return;
  $('#kpi-progress').textContent = `${p.actualPct}%`;
  $('#kpi-progress-bar').style.width = `${p.actualPct}%`;
  $('#kpi-progress-meta').textContent = p.count
    ? `Planned ${p.plannedPct}% by today · ${p.overdue.length} overdue`
    : 'Add timetable items to track progress';
  renderTimeline();
}

async function refreshDashboard(projectId) {
  // The Spent vs Budget card is updated by renderCosts() from the timetable.
  const [delays, logs] = await Promise.all([
    db.from('delays')
      .select('id, delay_cause, duration_hours, description, created_at, flats(block, flat_number)')
      .eq('project_id', projectId)
      .order('created_at', { ascending: false }),
    db.from('daily_logs')
      .select('log_date, weather, manpower, notes')
      .eq('project_id', projectId)
      .order('log_date', { ascending: false })
      .limit(5),
  ]);

  if (projectId !== state.projectId) return;
  const failed = [delays, logs].find((r) => r.error);
  if (failed) {
    toast(`Could not load dashboard: ${failed.error.message}`, 'error');
    return;
  }

  // Delays
  const hours = delays.data.reduce((sum, d) => sum + Number(d.duration_hours || 0), 0);
  $('#kpi-delays').textContent = delays.data.length;
  $('#kpi-delays-meta').textContent = `${hours.toLocaleString()} hours lost`;

  renderRecentLogs(logs.data);
  renderRecentDelays(delays.data.slice(0, 5));
}

function renderRecentLogs(logs) {
  const el = $('#dashboard-recent-logs');
  if (!logs.length) {
    el.className = 'empty-state';
    el.textContent = 'No logs yet.';
    return;
  }
  el.className = 'divide-y divide-ink-700';
  el.innerHTML = logs.map((l) => {
    const workers = Object.values(l.manpower || {}).reduce((sum, n) => sum + Number(n || 0), 0);
    return `
      <div class="py-2.5 flex items-start justify-between gap-3 text-sm">
        <div class="min-w-0">
          <p class="text-white font-medium">${esc(formatDate(l.log_date))}</p>
          <p class="text-slate-500 truncate">${esc(l.notes || 'No notes')}</p>
        </div>
        <div class="shrink-0 text-right text-xs text-slate-400">
          <p>${esc(l.weather || '—')}</p>
          <p>${workers} on site</p>
        </div>
      </div>`;
  }).join('');
}

function renderRecentDelays(delays) {
  const el = $('#dashboard-recent-delays');
  if (!delays.length) {
    el.className = 'empty-state';
    el.textContent = 'No delays recorded.';
    return;
  }
  el.className = 'divide-y divide-ink-700';
  el.innerHTML = delays.map((d) => {
    const where = d.flats ? `Block ${d.flats.block} · Room ${d.flats.flat_number}` : 'Site-wide';
    return `
      <div class="py-2.5 flex items-start justify-between gap-3 text-sm">
        <div class="min-w-0">
          <p class="text-white font-medium">${esc(d.delay_cause)}</p>
          <p class="text-slate-500 truncate">${esc(where)}${d.description ? ` — ${esc(d.description)}` : ''}</p>
        </div>
        <span class="shrink-0 text-xs font-semibold text-rose-400 tabular-nums">${Number(d.duration_hours)} h</span>
      </div>`;
  }).join('');
}

// =============================================================
// Project timeline + edit project
// =============================================================
const DAY_MS = 86_400_000;
const parseDate = (iso) => (iso ? new Date(`${iso}T00:00`) : null);
const daysBetween = (a, b) => Math.round((b - a) / DAY_MS);

function timelineBar(label, pct, colorClass) {
  return `
    <div>
      <div class="flex justify-between text-xs mb-1">
        <span class="text-slate-400">${label}</span>
        <span class="text-slate-300 tabular-nums">${pct}%</span>
      </div>
      <div class="h-2 rounded-full bg-ink-700 overflow-hidden">
        <div class="h-full rounded-full ${colorClass}" style="width:${pct}%"></div>
      </div>
    </div>`;
}

// Project dates plus the timetable: planned-by-today vs actually done, and what's overdue.
function renderTimeline() {
  const el = $('#timeline-body');
  const project = currentProject();
  if (!project) return;

  const p = state.progress ?? scheduleProgress([], todayISO());
  const start = parseDate(project.start_date);
  const end = parseDate(project.end_date);
  const today = parseDate(todayISO());
  const bars = [];
  let dates = '<p class="text-slate-500">No start or completion date — add them with Edit project.</p>';
  let when = '';

  if (start && end) {
    const total = Math.max(1, daysBetween(start, end));
    const elapsed = Math.min(total, Math.max(0, daysBetween(start, today)));
    dates = `
      <p class="text-slate-300">
        ${esc(formatDate(project.start_date))} → ${esc(formatDate(project.end_date))}
        <span class="text-slate-500">· ${total} days</span>
      </p>`;
    if (today < start) when = `Starts in ${daysBetween(today, start)} days`;
    else if (today > end) when = `${daysBetween(end, today)} days past planned completion`;
    else when = `Day ${elapsed} of ${total} · ${daysBetween(today, end)} days remaining`;
    bars.push(timelineBar('Time elapsed', Math.round((elapsed / total) * 100), 'bg-slate-500'));
  }

  const chips = [];
  if (p.count) {
    bars.push(timelineBar('Planned by today', p.plannedPct, 'bg-sky-500'));
    bars.push(timelineBar('Work complete', p.actualPct, 'bg-emerald-500'));
    const gap = p.actualPct - p.plannedPct;
    chips.push(gap >= -5
      ? { cls: 'status-done', text: `✓ ${planStatus(gap)}` }
      : { cls: gap >= -15 ? 'status-in_progress' : 'status-blocked', text: `! ${planStatus(gap)}` });
    if (p.overdue.length) chips.push({ cls: 'status-blocked', text: `! ${p.overdue.length} overdue` });
  }

  const overdueList = p.overdue.length ? `
    <ul class="mt-3 space-y-1 text-xs">
      ${p.overdue.slice(0, 3).map((t) => `
        <li class="text-rose-300">! ${esc(t.name)} — ${t.daysLate} days past planned finish</li>`).join('')}
      ${p.overdue.length > 3 ? `<li class="text-slate-500">and ${p.overdue.length - 3} more on the Timetable page</li>` : ''}
    </ul>` : '';

  el.innerHTML = `
    <div class="flex flex-wrap items-center justify-between gap-2 mb-4">
      ${dates}
      <div class="flex flex-wrap gap-1">
        ${chips.map((c) => `<span class="status-chip ${c.cls}">${esc(c.text)}</span>`).join('')}
      </div>
    </div>
    ${bars.length ? `<div class="space-y-3">${bars.join('')}</div>` : ''}
    ${p.count ? '' : '<p class="mt-3 text-slate-500">No timetable yet — add activities on the Timetable page to track progress.</p>'}
    ${overdueList}
    ${when ? `<p class="mt-3 text-xs text-slate-500">${esc(when)}</p>` : ''}`;
}

function openEditProjectModal() {
  const project = currentProject();
  if (!project) return;
  const form = $('#form-edit-project');
  const f = form.elements;
  f.name.value = project.name;
  f.location.value = project.location ?? '';
  f.client_name.value = project.client_name ?? '';
  f.client_name_ka.value = project.client_name_ka ?? '';
  f.start_date.value = project.start_date ?? '';
  f.end_date.value = project.end_date ?? '';
  f.currency.value = project.currency ?? DEFAULT_CURRENCY;
  showFormError(form, '');
  openModal('modal-edit-project');
}

async function saveEditProject(e) {
  e.preventDefault();
  const form = e.currentTarget;
  const btn  = $('[type=submit]', form);
  const fd   = new FormData(form);
  const project = currentProject();

  const row = {
    name: fd.get('name').trim(),
    location: fd.get('location').trim() || null,
    client_name: fd.get('client_name').trim() || null,
    client_name_ka: fd.get('client_name_ka').trim() || null,
    start_date: fd.get('start_date') || null,
    end_date: fd.get('end_date') || null,
    currency: fd.get('currency') || DEFAULT_CURRENCY,
  };
  if (row.start_date && row.end_date && row.end_date < row.start_date) {
    showFormError(form, 'Planned completion must be on or after the start date.');
    return;
  }

  showFormError(form, '');
  setBusy(btn, true);
  const { error } = await db.from('projects').update(row).eq('id', project.id);
  setBusy(btn, false);

  if (error) {
    showFormError(form, error.message);
    return;
  }

  Object.assign(project, row);
  closeModal('modal-edit-project');
  toast('Project updated.', 'success');
  applyProjectHeader(project);
  renderTimeline();
  renderScheduleViews();           // amounts in the (possibly new) currency
}

// =============================================================
// BOQ & cash flow — built from timetable items and their payments
// =============================================================
const qtyFormat = new Intl.NumberFormat(undefined, { maximumFractionDigits: 3 });
const sumOf = (items, key) => items.reduce((sum, i) => sum + Number(i[key] || 0), 0);
const monthLabel = (ym) => new Date(`${ym}-01T00:00`).toLocaleDateString(undefined, { month: 'short', year: 'numeric' });

function statTile(label, value, meta, tone = '') {
  return `
    <article class="kpi-card">
      <p class="kpi-label">${esc(label)}</p>
      <p class="kpi-value kpi-value-sm ${tone}">${esc(value)}</p>
      <p class="kpi-meta">${esc(meta)}</p>
    </article>`;
}

// Dashboard "Spent vs Budget" card.
function updateCostKpi(c) {
  const el = $('#kpi-cashflow');
  el.textContent = money.format(c.spent);
  el.classList.toggle('negative', c.spent > c.budget && c.budget > 0);
  $('#kpi-cashflow-meta').textContent = c.budget
    ? `of ${money.format(c.budget)} budget · work done worth ${money.format(c.earned)}`
    : 'Add budgets to timetable items';
}

function renderCosts() {
  const today = todayISO();
  const c = costPosition(state.tasks, state.payments, today);
  updateCostKpi(c);

  $('#cash-summary').innerHTML = [
    statTile('Budget', money.format(c.budget), `${state.tasks.filter((t) => Number(t.budget)).length} priced items`),
    statTile('Planned by today', money.format(c.planned), 'Value of work due by now'),
    statTile('Work done', money.format(c.earned), 'Budget × % complete',
      c.earned < c.planned - 0.5 ? 'negative' : ''),
    statTile('Spent', money.format(c.spent), c.budget ? `${Math.round((c.spent / c.budget) * 100)}% of budget` : '—',
      c.spent > c.budget && c.budget > 0 ? 'negative' : ''),
  ].join('');

  // Plain-language position: schedule (done vs planned) and cost (spent vs done).
  const lines = [];
  if (c.budget) {
    const behind = c.planned - c.earned;
    lines.push(behind > 0.5
      ? `Schedule: work worth ${money.format(behind)} is behind plan.`
      : 'Schedule: work done is on or ahead of plan.');
    const over = c.spent - c.earned;
    lines.push(over > 0.5
      ? `Cost: ${money.format(over)} more has been paid than the value of work done (advances or overspend).`
      : `Cost: payments are ${money.format(-over)} below the value of work done.`);
  }
  $('#cash-position').textContent = lines.join(' ');

  if (!state.tasks.length) {
    $('#boq-table').innerHTML = '<div class="empty-state">No items yet — click Add Item. Each timetable item can carry a budget and payments.</div>';
    $('#cashflow-months').innerHTML = '<div class="empty-state">The monthly cash flow appears once items have budgets or payments.</div>';
    return;
  }

  // ---- BOQ table ----
  const rows = state.tasks.map((t) => {
    const budget = Number(t.budget || 0);
    const paid = paidOn(t.id);
    const left = budget - paid;
    const qty = t.quantity != null
      ? `${qtyFormat.format(t.quantity)} ${esc(t.unit || '')}${t.rate != null ? ` × ${money2.format(t.rate)}` : ''}`
      : '<span class="text-slate-500">—</span>';
    return `
      <tr>
        <td class="task-name">${esc(t.name)}</td>
        <td>${t.contractor_id ? esc(contractorName(t.contractor_id)) : '<span class="text-slate-500">—</span>'}</td>
        <td class="num">${qty}</td>
        <td class="num">${budget ? money.format(budget) : '—'}</td>
        <td class="num">${paid ? money.format(paid) : '—'}</td>
        <td class="num">${!budget ? '—' : left < 0
          ? `<span class="variance-over">${money.format(-left)} over</span>`
          : money.format(left)}</td>
        <td class="whitespace-nowrap">${taskStateChip(t, taskState(t, today))}</td>
        <td class="text-right whitespace-nowrap">
          <button type="button" class="table-action" data-task-payments="${esc(t.id)}">Payments</button>
          <button type="button" class="table-action" data-task-edit="${esc(t.id)}">Edit</button>
        </td>
      </tr>`;
  }).join('');

  $('#boq-table').innerHTML = `
    <table class="data-table">
      <thead>
        <tr>
          <th>Work item</th><th>Contractor</th><th class="num">Qty × rate</th><th class="num">Budget</th>
          <th class="num">Paid</th><th class="num">Left to pay</th><th>Status</th><th></th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
      <tfoot>
        <tr>
          <td colspan="3">Total</td>
          <td class="num">${money.format(c.budget)}</td>
          <td class="num">${money.format(sumOf(state.payments, 'amount'))}</td>
          <td class="num">${money.format(c.budget - sumOf(state.payments, 'amount'))}</td>
          <td colspan="2"></td>
        </tr>
      </tfoot>
    </table>`;

  // ---- Monthly cash flow ----
  const planned = plannedSpendByMonth(state.tasks);
  const actual = actualSpendByMonth(state.payments);
  const months = [...new Set([...planned.keys(), ...actual.keys()])].sort();
  if (!months.length) {
    $('#cashflow-months').innerHTML = '<div class="empty-state">Add budgets or payments to items to see the monthly cash flow.</div>';
    return;
  }

  const thisMonth = today.slice(0, 7);
  let cumPlanned = 0;
  let cumActual = 0;
  const monthRows = months.map((ym) => {
    const p = planned.get(ym) ?? 0;
    const a = actual.get(ym) ?? 0;
    cumPlanned += p;
    cumActual += a;
    return `
      <tr class="${ym === thisMonth ? 'is-current' : ''}">
        <td>${esc(monthLabel(ym))}${ym === thisMonth ? ' <span class="text-xs text-brand-400">· this month</span>' : ''}</td>
        <td class="num">${money.format(p)}</td>
        <td class="num">${a ? money.format(a) : '—'}</td>
        <td class="num">${money.format(cumPlanned)}</td>
        <td class="num">${ym <= thisMonth ? money.format(cumActual) : '—'}</td>
      </tr>`;
  }).join('');

  $('#cashflow-months').innerHTML = `
    <table class="data-table">
      <thead>
        <tr>
          <th>Month</th><th class="num">Planned</th><th class="num">Paid</th>
          <th class="num">Cumulative planned</th><th class="num">Cumulative paid</th>
        </tr>
      </thead>
      <tbody>${monthRows}</tbody>
    </table>`;
}

// ---------- Payments ----------
let paymentTaskId = null;

function renderPaymentsList() {
  const task = state.tasks.find((t) => t.id === paymentTaskId);
  if (!task) {
    closeModal('modal-payments');
    return;
  }
  const payments = state.payments.filter((p) => p.task_id === task.id);
  const paid = sumOf(payments, 'amount');
  const budget = Number(task.budget || 0);

  $('#payments-title').textContent = `Payments — ${task.name}`;
  $('#payments-summary').textContent = budget
    ? `Budget ${money.format(budget)} · paid ${money.format(paid)} · ${paid > budget ? `${money.format(paid - budget)} over budget` : `${money.format(budget - paid)} left`}`
    : `Paid ${money.format(paid)} · no budget set for this item`;

  $('#payments-list').innerHTML = payments.length ? `
    <table class="data-table">
      <thead><tr><th>Date</th><th class="num">Amount</th><th>Note</th><th></th></tr></thead>
      <tbody>
        ${payments.map((p) => `
          <tr>
            <td class="whitespace-nowrap">${esc(formatDate(p.paid_on))}</td>
            <td class="num">${money2.format(p.amount)}</td>
            <td>${esc(p.note ?? '')}</td>
            <td class="text-right">
              <button type="button" class="table-action is-danger" data-payment-delete="${esc(p.id)}">Delete</button>
            </td>
          </tr>`).join('')}
      </tbody>
    </table>` : '<p class="text-sm text-slate-500">No payments yet.</p>';
}

function openPaymentsModal(taskId) {
  paymentTaskId = taskId;
  const form = $('#form-payment');
  form.reset();
  form.elements.paid_on.value = todayISO();
  showFormError(form, '');
  renderPaymentsList();
  openModal('modal-payments');
  form.elements.amount.focus();
}

async function reloadPayments() {
  const projectId = state.projectId;
  const { data, error } = await db
    .from('task_payments')
    .select('id, task_id, paid_on, amount, note')
    .eq('project_id', projectId)
    .order('paid_on');
  if (projectId !== state.projectId) return;
  if (error) {
    toast(`Could not reload payments: ${error.message}`, 'error');
    return;
  }
  state.payments = data;
  renderScheduleViews();
}

async function savePayment(e) {
  e.preventDefault();
  const form = e.currentTarget;
  const btn  = $('[type=submit]', form);
  const fd   = new FormData(form);

  const row = {
    project_id: state.projectId,
    task_id:    paymentTaskId,
    paid_on:    fd.get('paid_on'),
    amount:     Number(fd.get('amount')),
    note:       fd.get('note').trim() || null,
  };
  if (!(row.amount > 0)) {
    showFormError(form, 'Enter an amount above zero.');
    return;
  }

  showFormError(form, '');
  setBusy(btn, true);
  const { error } = await db.from('task_payments').insert(row);
  setBusy(btn, false);
  if (error) {
    showFormError(form, error.message);
    return;
  }

  form.reset();
  form.elements.paid_on.value = row.paid_on; // keep the date for the next entry
  toast('Payment added.', 'success');
  reloadPayments();
}

async function onPaymentsClick(e) {
  const del = e.target.closest('[data-payment-delete]');
  if (!del) return;
  const payment = state.payments.find((p) => p.id === del.dataset.paymentDelete);
  if (!payment || !confirm(`Delete the payment of ${money2.format(payment.amount)} on ${formatDate(payment.paid_on)}?`)) return;

  const { error } = await db.from('task_payments').delete().eq('id', payment.id);
  if (error) {
    toast(`Could not delete payment: ${error.message}`, 'error');
    return;
  }
  toast('Payment deleted.', 'success');
  reloadPayments();
}

// =============================================================
// Contractors — each project has its own (contractors.project_id).
// Loaded with the project in loadSchedule(); performance is per project.
// =============================================================
const CONTRACTOR_FIELDS = ['name', 'name_ka', 'trade', 'contact_person', 'phone', 'email', 'notes'];

function contractorRating(s) {
  if (!s || !s.items) return '<span class="text-slate-500">No jobs yet</span>';
  if (s.overdue) return `<span class="status-chip status-blocked">! ${s.overdue} overdue</span>`;
  if (s.late) return `<span class="status-chip status-in_progress">Late on ${s.late} · avg ${s.avgDaysLate} d</span>`;
  if (s.onTime) return '<span class="status-chip status-done">✓ On time</span>';
  return '<span class="status-chip status-pending">Not finished yet</span>';
}

function renderContractors() {
  const perf = contractorPerformance(state.tasks, state.contractorDelays, state.payments, todayISO());
  const el = $('#contractors-table');
  const list = [...state.contractors].sort((a, b) =>
    (perf.get(b.id)?.items ?? 0) - (perf.get(a.id)?.items ?? 0) || a.name.localeCompare(b.name));

  if (!list.length) {
    el.innerHTML = '<div class="empty-state">No contractors on this project yet — click Add Contractor.</div>';
    return;
  }

  const contact = (c) => [c.trade, c.contact_person, c.phone, c.email].filter(Boolean).map(esc).join(' · ');
  const rows = list.map((c) => {
    const s = perf.get(c.id);
    return `
      <tr>
        <td>
          <p class="text-white font-medium">${esc(c.name)}${c.name_ka ? ` <span class="text-slate-400 font-normal">· ${esc(c.name_ka)}</span>` : ''}</p>
          <p class="text-xs text-slate-500">${contact(c)}</p>
        </td>
        <td class="num">${s?.items ?? 0}</td>
        <td class="num">${s?.onTime ?? 0}</td>
        <td class="num">${s?.late ? `${s.late} <span class="text-slate-500">(avg ${s.avgDaysLate} d)</span>` : 0}</td>
        <td class="num">${s?.overdue ? `<span class="variance-over">${s.overdue}</span>` : 0}</td>
        <td class="num">${s?.open ?? 0}</td>
        <td class="num">${s?.delayHours ? `${s.delayHours} h` : '—'}</td>
        <td class="num">${s?.budget ? money.format(s.budget) : '—'}</td>
        <td class="num">${s?.paid ? money.format(s.paid) : '—'}</td>
        <td class="whitespace-nowrap">${contractorRating(s)}</td>
        <td class="text-right whitespace-nowrap">
          <button type="button" class="table-action" data-contractor-edit="${esc(c.id)}">Edit</button>
          <button type="button" class="table-action is-danger" data-contractor-delete="${esc(c.id)}">Delete</button>
        </td>
      </tr>`;
  }).join('');

  const unassigned = perf.get('')?.items ?? 0;
  el.innerHTML = `
    <table class="data-table">
      <thead>
        <tr>
          <th>Contractor</th><th class="num">Jobs</th><th class="num">On time</th><th class="num">Late</th>
          <th class="num">Overdue now</th><th class="num">Open</th><th class="num">Delays</th>
          <th class="num">Budget</th><th class="num">Paid</th><th>Performance</th><th></th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
    ${unassigned ? `<p class="mt-3 text-xs text-slate-500">${unassigned} timetable item(s) have no contractor yet — pick one in the Contractor column on the Timetable.</p>` : ''}`;
}

function openContractorModal(contractor) {
  if (!requireProject()) return;
  const form = $('#form-contractor');
  const f = form.elements;
  form.reset();
  showFormError(form, '');
  $('#contractor-title').textContent = contractor ? 'Edit Contractor' : 'Add Contractor';
  f.id.value = contractor?.id ?? '';
  for (const key of CONTRACTOR_FIELDS) f[key].value = contractor?.[key] ?? '';
  openModal('modal-contractor');
  f.name.focus();
}

async function saveContractor(e) {
  e.preventDefault();
  const form = e.currentTarget;
  const btn  = $('[type=submit]', form);
  const fd   = new FormData(form);
  const id = fd.get('id');
  const row = Object.fromEntries(CONTRACTOR_FIELDS.map((k) => [k, fd.get(k).trim() || null]));

  showFormError(form, '');
  setBusy(btn, true);
  const { error } = id
    ? await db.from('contractors').update(row).eq('id', id)
    : await db.from('contractors').insert({ ...row, project_id: state.projectId });
  setBusy(btn, false);

  if (error) {
    showFormError(form, error.message);
    return;
  }
  closeModal('modal-contractor');
  toast(id ? 'Contractor updated.' : `${row.name} added.`, 'success');
  loadSchedule(state.projectId);
}

async function deleteContractor(contractorId) {
  const contractor = state.contractors.find((c) => c.id === contractorId);
  if (!contractor) return;
  const jobs = state.tasks.filter((t) => t.contractor_id === contractorId).length;
  const extra = jobs ? `\n\nTheir ${jobs} timetable item(s) will be left without a contractor.` : '';
  if (!confirm(`Delete contractor "${contractor.name}"?${extra}`)) return;

  const { error } = await db.from('contractors').delete().eq('id', contractorId);
  if (error) {
    toast(`Could not delete contractor: ${error.message}`, 'error');
    return;
  }
  toast(`Deleted ${contractor.name}.`, 'success');
  loadSchedule(state.projectId);
}

function onContractorsClick(e) {
  const edit = e.target.closest('[data-contractor-edit]');
  if (edit) return openContractorModal(state.contractors.find((c) => c.id === edit.dataset.contractorEdit));

  const del = e.target.closest('[data-contractor-delete]');
  if (del) deleteContractor(del.dataset.contractorDelete);
}

// =============================================================
// Daily logs list + Ask Gemini (whole-project Q&A)
// =============================================================
async function loadLogs(projectId) {
  const el = $('#daily-logs-container');
  const { data, error } = await db
    .from('daily_logs')
    .select('log_date, weather, manpower, notes, notes_en')
    .eq('project_id', projectId)
    .order('log_date', { ascending: false })
    .limit(60);

  if (projectId !== state.projectId) return;
  if (error) {
    el.innerHTML = `<div class="panel empty-state">Could not load logs: ${esc(error.message)}</div>`;
    return;
  }
  if (!data.length) {
    el.innerHTML = "<div class=\"panel empty-state\">No daily logs yet — click New Daily Log and paste today's WhatsApp log.</div>";
    return;
  }

  const tradeLabel = (key) => MANPOWER_TRADES.find((t) => t.key === key)?.label ?? key;
  el.innerHTML = data.map((l) => {
    const crew = Object.entries(l.manpower || {}).filter(([, n]) => n > 0);
    const total = crew.reduce((sum, [, n]) => sum + Number(n), 0);
    return `
      <article class="log-card">
        <div class="log-card-head">
          <span class="log-card-date">${esc(formatDate(l.log_date))}</span>
          <span class="log-card-meta">${esc([l.weather, total ? `${total} on site` : ''].filter(Boolean).join(' · '))}</span>
        </div>
        ${crew.length ? `<p class="log-card-crew">${crew.map(([k, n]) => `${esc(tradeLabel(k))} ${n}`).join(' · ')}</p>` : ''}
        <div class="log-notes">
          <p><span class="log-lang">ქართული</span>${esc(l.notes || '—')}</p>
          <p><span class="log-lang">English</span>${esc(l.notes_en || '—')}</p>
        </div>
      </article>`;
  }).join('') + (data.length === 60 ? '<p class="text-xs text-slate-500">Showing the latest 60 logs. Ask Gemini to search older ones.</p>' : '');
}

async function askGemini(e) {
  e.preventDefault();
  if (!requireProject()) return;
  const form = e.currentTarget;
  const btn = $('[type=submit]', form);
  const out = $('#ask-answer');
  const question = form.elements.question.value.trim();
  if (!question) return;

  out.classList.remove('hidden');
  out.innerHTML = `<p class="ask-q">${esc(question)}</p>Reading the project's logs…`;
  setBusy(btn, true, 'Asking…');
  const { data, error } = await db.functions.invoke('ask-project', {
    body: { project_id: state.projectId, question, today: todayISO() },
  });
  setBusy(btn, false);

  out.innerHTML = `<p class="ask-q">${esc(question)}</p>${esc(error
    ? `Gemini couldn't answer: ${await functionErrorMessage(error)}`
    : data.answer)}`;
}

function onAskSuggestion(e) {
  const chip = e.target.closest('[data-ask]');
  if (!chip) return;
  const form = $('#form-ask');
  form.elements.question.value = chip.dataset.ask;
  form.requestSubmit();
}

// =============================================================
// Modals
// =============================================================
function openModal(id) {
  const dlg = document.getElementById(id);
  if (!dlg.open) dlg.showModal();
}

function closeModal(id) {
  const dlg = document.getElementById(id);
  if (dlg.open) dlg.close();
}

function initModals() {
  $$('dialog.modal').forEach((dlg) => {
    const locked = dlg.hasAttribute('data-locked');
    dlg.addEventListener('cancel', (e) => { if (locked) e.preventDefault(); }); // Esc key
    dlg.addEventListener('click', (e) => {
      if (e.target.closest('[data-close]')) dlg.close();
      else if (e.target === dlg && !locked) dlg.close(); // backdrop click
    });
  });

  // Static option lists
  $('#log-weather').innerHTML = '<option value="">— Select —</option>'
    + WEATHER_OPTIONS.map((w) => `<option value="${esc(w)}">${esc(w)}</option>`).join('');

  $('#manpower-fields').innerHTML = MANPOWER_TRADES.map((t) => `
    <label class="block">
      <span class="form-label">${esc(t.label)}</span>
      <input type="number" name="mp_${t.key}" min="0" step="1" inputmode="numeric" placeholder="0"
             class="input-dark w-full">
    </label>
  `).join('');

  $('#delay-cause').innerHTML = DELAY_CAUSES.map((c) => `<option value="${esc(c)}">${esc(c)}</option>`).join('');

  $('#form-daily-log').addEventListener('input', updateManpowerTotal);

  $('#task-unit').innerHTML = '<option value="">—</option>'
    + BOQ_UNITS.map((u) => `<option value="${esc(u)}">${esc(u)}</option>`).join('');
  $('#contractor-trades').innerHTML = CONTRACTOR_TRADES.map((t) => `<option value="${esc(t)}"></option>`).join('');

  const currencyOptions = Object.entries(CURRENCIES)
    .map(([code, label]) => `<option value="${code}">${esc(label)}</option>`).join('');
  $$('[data-currency-options]').forEach((sel) => { sel.innerHTML = currencyOptions; });

  const typeOptions = '<option value="">—</option>'
    + UNIT_TYPES.map((u) => `<option value="${esc(u)}">${esc(u)}</option>`).join('');
  $('#unit-type').innerHTML = typeOptions;
  $('#unit-status').innerHTML = Object.entries(UNIT_STATUSES)
    .map(([value, label]) => `<option value="${value}">${esc(label)}</option>`).join('');
}

function requireProject() {
  if (state.projectId) return true;
  toast('Select a project first.', 'error');
  return false;
}

// ---------- Daily log ----------
function updateManpowerTotal() {
  const total = $$('#manpower-fields input').reduce((sum, i) => sum + (parseInt(i.value, 10) || 0), 0);
  $('#manpower-total').textContent = total;
}

function openDailyLogModal() {
  if (!requireProject()) return;
  const form = $('#form-daily-log');
  form.reset();
  form.elements.log_date.value = todayISO();
  form.elements.log_date.max = todayISO();
  updateManpowerTotal();
  showFormError(form, '');
  openModal('modal-daily-log');
  form.elements.raw_text.focus();
}

// Readable message from a failed supabase.functions.invoke().
async function functionErrorMessage(error) {
  try {
    const body = await error.context?.json();
    if (body?.error) return body.error;
  } catch { /* non-JSON error body */ }
  return error.message;
}

// Sends the pasted Georgian log to Gemini and fills the form with the result.
async function processLogText() {
  const form = $('#form-daily-log');
  const f = form.elements;
  const raw = f.raw_text.value.trim();
  if (!raw) {
    showFormError(form, 'Paste the log text first.');
    f.raw_text.focus();
    return;
  }

  const btn = $('#btn-parse-log');
  showFormError(form, '');
  setBusy(btn, true, 'Processing…');
  const { data, error } = await db.functions.invoke('parse-log', {
    body: {
      text: raw,
      today: todayISO(),
      trades: MANPOWER_TRADES.map((t) => ({ key: t.key, label: t.label, ka: ka(t.label) })),
      weather: WEATHER_OPTIONS.map((w) => ({ key: w, label: w, ka: ka(w) })),
    },
  });
  setBusy(btn, false);

  if (error) {
    showFormError(form, `Gemini couldn't process the log: ${await functionErrorMessage(error)}`);
    return;
  }

  if (data.date && data.date <= todayISO()) f.log_date.value = data.date;
  f.weather.value = data.weather || '';
  for (const t of MANPOWER_TRADES) f[`mp_${t.key}`].value = data.manpower?.[t.key] || '';
  f.notes.value = data.notes_ka || '';
  f.notes_en.value = data.notes_en || '';
  updateManpowerTotal();
  toast('Log processed — check the details, then save.', 'success');
}

async function saveDailyLog(e) {
  e.preventDefault();
  const form = e.currentTarget;
  const btn  = $('[type=submit]', form);
  const fd   = new FormData(form);

  const manpower = {};
  for (const t of MANPOWER_TRADES) {
    const n = parseInt(fd.get(`mp_${t.key}`), 10);
    if (n > 0) manpower[t.key] = n;
  }

  const row = {
    project_id: state.projectId,
    log_date:   fd.get('log_date'),
    weather:    fd.get('weather') || null,
    manpower,
    // Georgian notes fall back to the raw paste if it wasn't processed.
    notes:      fd.get('notes').trim() || fd.get('raw_text').trim() || null,
    notes_en:   fd.get('notes_en').trim() || null,
    raw_text:   fd.get('raw_text').trim() || null,
  };

  showFormError(form, '');
  setBusy(btn, true);
  const { error } = await db.from('daily_logs').insert(row);
  setBusy(btn, false);

  if (error) {
    showFormError(form, error.code === '23505'
      ? `A log for ${formatDate(row.log_date)} already exists for this project.`
      : error.message);
    return;
  }

  closeModal('modal-daily-log');
  toast('Daily log saved.', 'success');
  refreshDashboard(state.projectId);
  loadLogs(state.projectId);
}

// ---------- Delay ----------
function openDelayModal() {
  if (!requireProject()) return;
  const form = $('#form-delay');
  form.reset();
  $('#delay-flat').innerHTML = '<option value="">Site-wide (no specific room)</option>'
    + state.flats.map((f) => `
      <option value="${esc(f.id)}">Block ${esc(f.block)} · Room ${esc(f.flat_number)} (${esc(floorLabel(f.floor))})</option>
    `).join('');
  $('#delay-contractor').innerHTML = contractorOptions('');
  showFormError(form, '');
  openModal('modal-delay');
}

async function saveDelay(e) {
  e.preventDefault();
  const form = e.currentTarget;
  const btn  = $('[type=submit]', form);
  const fd   = new FormData(form);

  const duration = parseFloat(fd.get('duration_hours'));
  if (!Number.isFinite(duration) || duration < 0) {
    showFormError(form, 'Enter a duration of 0 hours or more.');
    return;
  }

  const row = {
    project_id:     state.projectId,
    flat_id:        fd.get('flat_id') || null,
    contractor_id:  fd.get('contractor_id') || null,
    delay_cause:    fd.get('delay_cause'),
    duration_hours: duration,
    description:    fd.get('description').trim() || null,
  };

  showFormError(form, '');
  setBusy(btn, true);
  const { error } = await db.from('delays').insert(row);
  setBusy(btn, false);

  if (error) {
    showFormError(form, error.message);
    return;
  }

  closeModal('modal-delay');
  toast('Delay recorded.', 'success');
  refreshDashboard(state.projectId);
  if (row.contractor_id) loadSchedule(state.projectId); // contractor delay hours
}

// =============================================================
// PDF export
// =============================================================
// ---------- Full project report (viewer + PDF) ----------
let reportPage = null;

async function openProjectReport() {
  if (!requireProject()) return;
  const project = currentProject();
  const root = $('#report-root');
  const pdfBtn = $('#btn-report-pdf');
  reportPage = null;
  pdfBtn.disabled = true;
  root.innerHTML = '<p class="rpt-loading">Building report…</p>';
  $('#report-title').textContent = `Project Report — ${project.name}`;
  openModal('modal-report');

  try {
    const page = await buildProjectReport({
      db,
      project,
      tasks: state.tasks,
      payments: state.payments,
      contractors: state.contractors,
      contractorDelays: state.contractorDelays,
      units: state.flats,
      progress: state.progress ?? scheduleProgress([], todayISO()),
      money,
      userEmail: state.user?.email,
    });
    if (project.id !== state.projectId) return;
    root.replaceChildren(page);
    reportPage = page;
    pdfBtn.disabled = false;
  } catch (err) {
    root.innerHTML = `<p class="rpt-loading">${esc(err.message || 'Could not build the report.')}</p>`;
  }
}

async function downloadReport() {
  if (!reportPage) return;
  const btn = $('#btn-report-pdf');
  setBusy(btn, true, 'Saving…');
  try {
    await downloadProjectReport(reportPage, currentProject());
    toast('Project report downloaded.', 'success');
  } catch (err) {
    toast(err.message || 'Could not save the PDF.', 'error');
  } finally {
    setBusy(btn, false);
  }
}

let exporting = false;

async function exportDailyReport(e) {
  if (exporting || !requireProject()) return;
  const btn = e.currentTarget;
  const label = btn.querySelector('span') ?? btn;
  const original = label.textContent;
  const project = state.projects.find((p) => p.id === state.projectId);

  exporting = true;
  btn.disabled = true;
  label.textContent = 'Generating…';
  toast('Building today\'s report — the AI summary can take a few seconds.');

  try {
    const { aiNote } = await generateDailyReport({
      db, project, progress: state.progress, userEmail: state.user?.email,
    });
    if (aiNote) toast(`PDF saved. ${aiNote}`, 'error');
    else toast('Daily report downloaded.', 'success');
  } catch (err) {
    toast(err.message || 'Could not generate the report.', 'error');
  } finally {
    exporting = false;
    btn.disabled = !state.projectId;
    label.textContent = original;
  }
}

// =============================================================
// Boot
// =============================================================
initNavigation();
initModals();
setProjectActionsEnabled(false);

$('#btn-new-log').addEventListener('click', openDailyLogModal);
$('#btn-new-delay').addEventListener('click', openDelayModal);
$('#form-daily-log').addEventListener('submit', saveDailyLog);
$('#form-delay').addEventListener('submit', saveDelay);
$('#units-table').addEventListener('click', onUnitsTableClick);
$('#btn-add-unit').addEventListener('click', () => openUnitModal(null));
$('#form-unit').addEventListener('submit', saveUnit);
$('#btn-add-task').addEventListener('click', () => openTaskModal(null));
$('#form-task').addEventListener('submit', saveTask);
$('#form-task').addEventListener('input', onTaskInput);
$('#schedule-table').addEventListener('change', onScheduleChange);
$('#schedule-table').addEventListener('click', onTaskTableClick);
$('#boq-table').addEventListener('click', onTaskTableClick);
$('#form-payment').addEventListener('submit', savePayment);
$('#payments-list').addEventListener('click', onPaymentsClick);
$('#btn-add-contractor').addEventListener('click', () => openContractorModal(null));
$('#form-contractor').addEventListener('submit', saveContractor);
$('#contractors-table').addEventListener('click', onContractorsClick);
$('#projects-container').addEventListener('click', onProjectsClick);
$('#btn-new-project').addEventListener('click', openProjectModal);
$('#form-project').addEventListener('submit', saveProject);
$('#btn-parse-log').addEventListener('click', processLogText);
$('#btn-new-log-page').addEventListener('click', openDailyLogModal);
$('#form-ask').addEventListener('submit', askGemini);
$('#form-ask').addEventListener('click', onAskSuggestion);
$('#btn-edit-project').addEventListener('click', openEditProjectModal);
$('#form-edit-project').addEventListener('submit', saveEditProject);
$('#btn-export-pdf').addEventListener('click', exportDailyReport);
$('#btn-report-daily').addEventListener('click', exportDailyReport);
$('#btn-view-report').addEventListener('click', openProjectReport);
$('#btn-report-pdf').addEventListener('click', downloadReport);

if (db) {
  $('#form-login').addEventListener('submit', signIn);
  $$('[data-sign-out]').forEach((el) => el.addEventListener('click', signOut));
  initAuth();
} else {
  showSetupNotice();
}
