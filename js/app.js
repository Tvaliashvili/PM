// =============================================================
// CPMG PM - main app logic
// =============================================================
import {
  SUPABASE_URL, SUPABASE_KEY, CURRENCIES, DEFAULT_CURRENCY,
  UNIT_TYPES, UNIT_STATUSES,
  MANPOWER_TRADES, WEATHER_OPTIONS, DELAY_CAUSES, DAY_WORKER_KEY, GUARD_KEY, EQUIPMENT_SUGGESTIONS,
  SITE_EVENT_KINDS, INCIDENT_SEVERITIES, VARIATION_STATUSES,
  BOQ_UNITS, CONTRACTOR_TRADES,
} from './config.js';
import { generateDailyReport } from './pdfReport.js';
import { buildProjectReport, downloadProjectReport } from './projectReport.js';
import {
  scheduleProgress, taskState, durationDays, completionOf, expectedPct,
  plannedSpendByMonth, actualSpendByMonth, costPosition, contractorPerformance,
  labourCosts, guardCosts, rentalCosts, rentalTotal, rentalEnd, siteCostsByMonth,
  delayIsOngoing, delayDaysLost, delayStart, delayEnd, delayCovers, causeOf, excusedDaysByTask,
} from './schedule.js';
import { ka, roomLabel } from './bilingual.js';
import {
  MAX_PHOTOS, uploadPhotos, fetchPhotos, signPhotos, photosBy, deletePhoto, deletePhotosFor,
} from './photos.js';

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
  contractorDelays: [], // delays with cause_contractor_id + days
  delayImpacts: [],     // { delay_id, task_id, days_lost } - work a delay held up
  contractors: [],      // this project's contractors
  siteLogs: [],         // every daily log's date, manpower and day rate (daily-worker pay)
  events: [],           // safety and quality events, newest first
  variations: [],       // change orders, newest first
  rentals: [],          // equipment_rentals
  delays: [],           // every delay on the project, newest first
  siteCosts: [],        // labourCosts() + rentalCosts() entries
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
// Whole amounts read better without the trailing zeros, but a rate of 65.50 is
// not 66 and a day's pay of 196.50 is not 197 - so the pence show when there
// are any. Anything within half a penny of round is treated as round, since
// that is a floating-point artefact rather than money.
const isRound = (n) => Math.abs(Number(n) - Math.round(Number(n))) < 0.005;
const money  = { format: (n) => moneyFormat(isRound(n) ? 0 : 2).format(n) };
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
  ['#btn-new-log-page', '#btn-new-delay', '#btn-report-daily', '#btn-report-daily-print', '#btn-report-project', '#btn-report-project-print', '#btn-add-unit', '#btn-add-task', '#btn-baseline', '#btn-new-event', '#btn-new-variation', '#btn-add-contractor', '#btn-add-rental',
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
  if (target === 'units' && state.projectId && !hasRooms(currentProject())) {
    target = 'dashboard';
    history.replaceState(null, '', '#dashboard');
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
    .select('id, name, name_ka, location, location_ka, client_name, client_name_ka, total_flats, has_rooms, day_rate, guard_rate, created_at, start_date, end_date, currency, baseline_set_on, retention_pct')
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
  state.siteLogs = [];
  state.rentals = [];
  state.siteCosts = [];
  state.delays = [];
  state.events = [];
  state.variations = [];
  setProjectActionsEnabled(Boolean(state.projectId));

  const project = currentProject();
  applyProjectHeader(project);

  if (!project) {
    storage.set('cpm.projectId', '');
    return;
  }

  storage.set('cpm.projectId', project.id);
  resetLogFilter(); // a new project starts with a clean, unfiltered log list
  await Promise.all([
    loadUnits(project.id), loadSchedule(project.id), refreshDashboard(project.id), loadLogs(project.id),
    loadEvents(project.id), loadVariations(project.id),
  ]);
}

// The UI is English: show the English client name, else the Georgian one.
const clientOf = (p) => p?.client_name || p?.client_name_ka || '';
const locationOf = (p) => p?.location || p?.location_ka || '';
// Sites without rooms (e.g. a stadium) hide the Rooms page and every room field.
const hasRooms = (p) => Boolean(p?.has_rooms);

const currentProject = () => state.projects.find((p) => p.id === state.projectId);

// Project name/location wherever it's shown in the workspace.
function applyProjectHeader(project) {
  $('#topbar-project-name').textContent = project?.name ?? '';
  $('#topbar-project-location').textContent = [locationOf(project), clientOf(project) && `Client: ${clientOf(project)}`]
    .filter(Boolean).join(' · ');
  $('#dashboard-subtitle').textContent = project
    ? [project.name, locationOf(project), clientOf(project) && `Client: ${clientOf(project)}`].filter(Boolean).join(' · ')
    : 'Select a project to view its status.';

  $('[data-nav="units"]').classList.toggle('hidden', !hasRooms(project));
  if (project && !hasRooms(project) && location.hash === '#units') goTo('dashboard');
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
          ${p.name_ka ? `<p class="pr-8 text-sm text-slate-400 truncate">${esc(p.name_ka)}</p>` : ''}
          <p class="text-sm text-slate-500 truncate">${esc(locationOf(p) || 'No location set')} · ${esc(p.currency ?? DEFAULT_CURRENCY)}</p>
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
            ${hasRooms(p) ? `<div><dt>Rooms</dt><dd>${s.units}</dd></div>` : `<div><dt>Items</dt><dd>${prog.count}</dd></div>`}
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
  if (del) openDeleteProjectModal(del.dataset.deleteProject);
}

function openDeleteProjectModal(projectId) {
  const project = state.projects.find((p) => p.id === projectId);
  if (!project) return;
  const form = $('#form-delete-project');
  form.reset();
  form.elements.id.value = project.id;
  $('#delete-project-name').textContent = project.name;
  showFormError(form, '');
  openModal('modal-delete-project');
}

/**
 * Deleting a project wipes years of site history and nothing restores it, so
 * the account's own password has to be typed first - a reflex click is not enough.
 */
async function confirmDeleteProject(e) {
  e.preventDefault();
  const form = e.currentTarget;
  const btn = $('[type=submit]', form);
  const projectId = form.elements.id.value;
  const email = state.user?.email;
  if (!email) {
    showFormError(form, 'You are not signed in.');
    return;
  }

  showFormError(form, '');
  setBusy(btn, true, 'Checking…');
  // The only way to check a password is to sign in with it again: same user,
  // same session, so nothing else about the app changes.
  const { error: authError } = await db.auth.signInWithPassword({
    email,
    password: form.elements.password.value,
  });
  if (authError) {
    setBusy(btn, false);
    showFormError(form, 'That password is not right - nothing has been deleted.');
    form.elements.password.select();
    return;
  }

  setBusy(btn, true, 'Deleting…');
  const deleted = await deleteProject(projectId);
  setBusy(btn, false);
  if (deleted) closeModal('modal-delete-project');
}

/** Removes the project and everything that cascades from it. True when it went. */
async function deleteProject(projectId) {
  const project = state.projects.find((p) => p.id === projectId);
  if (!project) return false;

  const { error } = await db.from('projects').delete().eq('id', projectId);
  if (error) {
    toast(`Could not delete project: ${error.message}`, 'error');
    return false;
  }

  toast(`Deleted ${project.name}.`, 'success');
  if (state.projectId === projectId) selectProject(null);
  await loadProjects();
  return true;
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
      name_ka: fd.get('name_ka').trim() || null,
      location: fd.get('location').trim() || null,
      location_ka: fd.get('location_ka').trim() || null,
      client_name: fd.get('client_name').trim() || null,
      client_name_ka: fd.get('client_name_ka').trim() || null,
      currency: fd.get('currency') || DEFAULT_CURRENCY,
      has_rooms: fd.has('has_rooms'),
    })
    .select('id')
    .single();
  setBusy(btn, false);

  if (error) {
    showFormError(form, error.message);
    return;
  }

  closeModal('modal-project');
  toast(`Project created. Add its timetable${fd.has('has_rooms') ? ', rooms' : ''} and dates next.`, 'success');

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
    $('#units-table').innerHTML = '<div class="empty-state">No rooms yet - click Add Room.</div>';
    return;
  }

  const anyBlock = units.some((u) => u.block);
  const rows = units.map((u) => `
    <tr>
      <td class="font-medium text-white whitespace-nowrap">${esc(u.flat_number)}</td>
      ${anyBlock ? `<td>${esc(u.block || '-')}</td>` : ''}
      <td class="whitespace-nowrap">${esc(floorLabel(u.floor))}</td>
      <td>${u.unit_type ? esc(u.unit_type) : '<span class="text-slate-500">-</span>'}</td>
      <td class="num">${u.area_m2 != null ? areaFormat.format(u.area_m2) : '-'}</td>
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
          <th>Room</th>${anyBlock ? '<th>Block</th>' : ''}<th>Floor</th><th>Type</th><th class="num">Area m²</th>
          <th>Status</th><th>Notes</th><th></th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
      <tfoot>
        <tr>
          <td colspan="${anyBlock ? 4 : 3}">${units.length} rooms</td>
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
    f.block.value = last?.block ?? '';
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
      ? `${roomLabel(row)} already exists.`
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
  if (!unit || !confirm(`Delete ${roomLabel(unit)}?\n\nDelays linked to it are kept as site-wide.`)) return;

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
// Timetable (schedule_tasks) - drives progress, and doubles as the BOQ:
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
  const [tasks, payments, delays, impacts, contractors, siteLogs, rentals] = await Promise.all([
    db.from('schedule_tasks')
      .select('id, name, name_ka, planned_start, planned_finish, baseline_start, baseline_finish, done, done_at, progress_pct, contractor_id, quantity, unit, rate, budget')
      .eq('project_id', projectId)
      .order('planned_start')
      .order('planned_finish'),
    db.from('task_payments')
      .select('id, task_id, paid_on, amount, retention, note')
      .eq('project_id', projectId)
      .order('paid_on'),
    db.from('delays')
      .select('cause_contractor_id, duration_days, created_at, delay_cause, resolved_on')
      .eq('project_id', projectId),
    // Days each item lost to a delay, so excused lateness is off the contractor's record.
    db.from('delay_impacts')
      .select('delay_id, task_id, days_lost, delays!inner(project_id)')
      .eq('delays.project_id', projectId),
    db.from('contractors')
      .select('id, name, name_ka, trade, contact_person, phone, email, notes')
      .eq('project_id', projectId)
      .order('name'),
    db.from('daily_logs')
      .select('log_date, manpower, day_rate, guard_rate, crew:daily_manpower(contractor_id, trade, workers)')
      .eq('project_id', projectId)
      .order('log_date'),
    db.from('equipment_rentals')
      .select('id, equipment, equipment_ka, supplier, supplier_ka, start_date, days, daily_rate, note')
      .eq('project_id', projectId)
      .order('start_date', { ascending: false }),
  ]);

  if (projectId !== state.projectId) return;
  const failed = [tasks, payments, delays, impacts, contractors, siteLogs, rentals].find((r) => r.error);
  if (failed) {
    $('#schedule-table').innerHTML = `<div class="empty-state">Could not load timetable: ${esc(failed.error.message)}</div>`;
    return;
  }
  state.tasks = tasks.data;
  state.payments = payments.data;
  state.contractorDelays = delays.data;
  state.delayImpacts = impacts.data;
  state.contractors = contractors.data;
  state.siteLogs = siteLogs.data;
  state.rentals = rentals.data;
  state.siteCosts = [
    ...labourCosts(state.siteLogs, DAY_WORKER_KEY),
    ...guardCosts(state.siteLogs, GUARD_KEY),
    ...rentalCosts(state.rentals),
  ];
  renderScheduleViews();
}

function renderScheduleViews() {
  renderSchedule();
  renderCosts();
  renderContractors();
  renderDelays(); // contractor names are known now
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
      !p.count ? '-' : planStatus(gap), gap < -5 ? 'negative' : ''),
    statTile('Overdue', String(p.overdue.length),
      p.overdue.length ? `Longest: ${p.overdue[0].daysLate} days late` : 'Nothing overdue', p.overdue.length ? 'negative' : ''),
    statTile('Remaining', `${100 - p.actualPct}%`, `${p.count - p.doneCount} items left`),
  ].join('');

  if (!state.tasks.length) {
    $('#schedule-table').innerHTML = '<div class="empty-state">No items yet - click Add Item to build the timetable. Progress, the BOQ and cash flow are all calculated from it.</div>';
    return;
  }

  const rows = state.tasks.map((t) => {
    const s = taskState(t, today);
    // What the dates say should be done by today - a guide when the real figure
    // is hard to measure, and a nudge when nobody has updated it.
    const donePct = Math.round(completionOf(t) * 100);
    const plan = expectedPct(t, today);
    const showPlan = !t.done && donePct < 100 && today >= t.planned_start;
    return `
      <tr class="${s.key === 'overdue' ? 'is-overdue' : ''}${t.done ? ' is-done' : ''}">
        <td class="task-pct-cell">
          <div class="task-pct">
            <input type="number" min="0" max="100" step="5" inputmode="numeric" class="task-pct-input"
                   value="${Math.round(completionOf(t) * 100)}" data-task-pct="${esc(t.id)}"
                   aria-label="Percent complete for ${esc(t.name)}"><span>%</span>
          </div>
          <div class="task-pct-bar">
            <div style="width:${donePct}%"></div>
            ${showPlan ? `<i class="task-pct-plan" style="left:${plan}%" aria-hidden="true"></i>` : ''}
          </div>
          ${showPlan
    ? `<span class="task-pct-hint${plan - donePct > 10 ? ' is-behind' : ''}" title="From this item's start and finish dates">plan ${plan}%</span>`
    : ''}
        </td>
        <td class="task-name">${esc(t.name)}${t.name_ka && t.name_ka !== t.name ? `<span class="block text-xs text-slate-500">${esc(t.name_ka)}</span>` : ''}</td>
        <td>
          <select class="select-dark select-inline" data-task-contractor="${esc(t.id)}"
                  aria-label="Contractor for ${esc(t.name)}">${contractorOptions(t.contractor_id ?? '')}</select>
        </td>
        <td class="whitespace-nowrap">${esc(formatDate(t.planned_start))}</td>
        <td class="whitespace-nowrap">${esc(formatDate(t.planned_finish))}</td>
        <td class="num">${durationDays(t)} d</td>
        <td class="num">${Number(t.budget) ? money.format(t.budget) : '-'}</td>
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
  return '<option value="">- None -</option>'
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
    f.name_ka.value = task.name_ka ?? '';
    f.name.value = task.name_ka && task.name === task.name_ka ? '' : task.name;
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
  f.name_ka.focus();
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
  // Either language will do; the English column falls back to the Georgian text.
  const nameKa = fd.get('name_ka').trim();
  const nameEn = fd.get('name').trim();
  if (!nameKa && !nameEn) {
    showFormError(form, 'Enter the work item in Georgian or English.');
    return;
  }
  const row = {
    name:           nameEn || nameKa,
    name_ka:        nameKa || null,
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
      .select('id, delay_cause, duration_days, resolved_on, description, description_en, created_at, flat_id, cause_contractor_id, flats(block, flat_number), impacts:delay_impacts(task_id, days_lost)')
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
  const days = delays.data.reduce((sum, d) => sum + delayDaysLost(d), 0);
  const stillOpen = delays.data.filter(delayIsOngoing).length;
  $('#kpi-delays').textContent = delays.data.length;
  $('#kpi-delays-meta').textContent = `${days.toLocaleString()} ${days === 1 ? 'day' : 'days'} lost`
    + (stillOpen ? ` · ${stillOpen} ongoing` : '');

  state.delays = delays.data;
  renderRecentLogs(logs.data);
  renderRecentDelays(delays.data.slice(0, 5));
  await loadDelayPhotos();
  renderDelays();
}

// ---------- Delays page ----------
// Local calendar date a delay started (stored as a timestamp).
const delayDate = delayStart;

// Horizontal bars with the figure written beside each one.
function barList(entries, unit) {
  if (!entries.length) return '<div class="empty-state">Nothing recorded.</div>';
  const max = Math.max(...entries.map(([, v]) => v));
  return `<div class="bar-list">${entries.map(([label, v, sub]) => `
    <div class="bar-list-row">
      <span class="bar-list-label">${esc(label)}${sub ? ` <span class="text-slate-500">${esc(sub)}</span>` : ''}</span>
      <span class="bar-list-track"><span class="bar-list-fill" style="width:${(v / max) * 100}%"></span></span>
      <span class="bar-list-value">${v} ${unit}</span>
    </div>`).join('')}</div>`;
}

// Photos filed against a delay: delay id → [{ id, url }] (url = signed thumbnail).
let delayPhotos = new Map();

async function loadDelayPhotos() {
  const photos = await fetchPhotos(db, { delayIds: state.delays.map((d) => d.id) });
  const urls = await signPhotos(db, photos);
  delayPhotos = new Map();
  for (const [delayId, rows] of photosBy(photos, 'delay_id')) {
    delayPhotos.set(delayId, rows.map((p) => ({ ...p, url: urls.get(p.id) || '' })));
  }
}

/**
 * The work a delay held up: each item with the days it lost, under whoever
 * holds it. Those days are excused on his record and carried by the cause.
 */
/**
 * What the contractor at fault had on site the day the delay started, read off
 * that day's crew sheet - the record that backs the claim up. "No crew sheet"
 * means nobody filled the log in, which is not the same as nobody turning up.
 */
function crewNote(delay) {
  const who = causeOf(delay);
  if (!who) return '';
  const day = delayDate(delay);
  const log = state.siteLogs.find((l) => l.log_date === day);
  if (!log) return '<span class="impact-row-who">No crew sheet that day</span>';
  const men = (log.crew ?? []).filter((c) => c.contractor_id === who)
    .reduce((sum, c) => sum + (Number(c.workers) || 0), 0);
  return `<span class="impact-row-who">${men} on site that day</span>`;
}

function knockOnCell(delay) {
  const impacts = delay.impacts ?? [];
  if (!impacts.length) return '<span class="text-slate-500">-</span>';
  const byContractor = new Map();
  for (const i of impacts) {
    const task = state.tasks.find((t) => t.id === i.task_id);
    const who = task?.contractor_id ? contractorName(task.contractor_id) : 'No contractor';
    if (!byContractor.has(who)) byContractor.set(who, []);
    byContractor.get(who).push(`${task ? task.name : 'Item removed'} (${i.days_lost} d)`);
  }
  return [...byContractor].map(([who, items]) => `
    <p class="text-xs"><span class="text-white">${esc(who)}</span>
      <span class="text-slate-500">${esc(items.join(', '))}</span></p>`).join('');
}

function renderDelays() {
  const delays = state.delays;
  const rooms = hasRooms(currentProject());
  const days = delays.reduce((sum, d) => sum + delayDaysLost(d), 0);
  const thisMonth = todayISO().slice(0, 7);
  const monthDays = delays.filter((d) => delayDate(d).startsWith(thisMonth))
    .reduce((sum, d) => sum + delayDaysLost(d), 0);
  const ongoing = delays.filter(delayIsOngoing);
  const ongoingDays = ongoing.reduce((sum, d) => sum + delayDaysLost(d), 0);

  const byCause = new Map();
  const byContractor = new Map();
  let noContractorDays = 0;
  let noContractorCount = 0;
  for (const d of delays) {
    const n = delayDaysLost(d);
    const c = byCause.get(d.delay_cause) ?? [0, 0];
    byCause.set(d.delay_cause, [c[0] + n, c[1] + 1]);
    // Leaving the contractor blank means nobody was held responsible - that is
    // not a contractor to rank, so it stays out of the chart.
    if (causeOf(d)) {
      const key = contractorName(causeOf(d));
      const k = byContractor.get(key) ?? [0, 0];
      byContractor.set(key, [k[0] + n, k[1] + 1]);
    } else {
      noContractorDays += n;
      noContractorCount += 1;
    }
  }
  const sorted = (m) => [...m].sort((a, b) => b[1][0] - a[1][0])
    .map(([label, [v, count]]) => [label, v, `· ${count}×`]);
  const top = sorted(byCause)[0];

  $('#delays-summary').innerHTML = [
    statTile('Delays', String(delays.length),
      delays.length ? `${monthDays} ${monthDays === 1 ? 'day' : 'days'} lost this month` : 'None recorded'),
    statTile('Days lost', String(days), ongoingDays ? `incl. ${ongoingDays} still counting` : 'All time', days ? 'negative' : ''),
    statTile('Ongoing', String(ongoing.length),
      ongoing.length ? `${ongoingDays} ${ongoingDays === 1 ? 'day' : 'days'} so far` : 'All settled',
      ongoing.length ? 'negative' : ''),
    statTile('Main cause', top ? top[0] : '-', top ? `${top[1]} days` : ''),
  ].join('');

  $('#delays-by-cause').innerHTML = barList(sorted(byCause), 'd');
  // Delays nobody was blamed for are counted under the chart, not inside it.
  const unattributed = noContractorDays
    ? `<p class="mt-3 text-xs text-slate-500">${noContractorCount} delay${noContractorCount === 1 ? '' : 's'}`
      + ` (${noContractorDays} day${noContractorDays === 1 ? '' : 's'}) with no contractor at fault.</p>`
    : '';
  $('#delays-by-contractor').innerHTML = (byContractor.size
    ? barList(sorted(byContractor), 'd')
    : '<div class="empty-state">No delay has been blamed on a contractor.</div>') + unattributed;

  if (!delays.length) {
    $('#delays-table').innerHTML = '<div class="empty-state">No delays yet - click Log Delay.</div>';
    return;
  }
  // Delays still running come first - they are the ones that need a decision.
  const ordered = [...delays].sort((a, b) => (delayIsOngoing(b) ? 1 : 0) - (delayIsOngoing(a) ? 1 : 0));
  const rows = ordered.map((d) => {
    const where = roomLabel(d.flats);
    return `
      <tr>
        <td class="whitespace-nowrap">${esc(formatDate(delayDate(d)))}</td>
        <td>${esc(d.delay_cause)}</td>
        ${rooms ? `<td>${esc(where)}</td>` : ''}
        <td>${causeOf(d) ? `${esc(contractorName(causeOf(d)))}${crewNote(d)}` : '<span class="text-slate-500">-</span>'}</td>
        <td>${knockOnCell(d)}</td>
        <td class="num font-semibold text-rose-400">
          ${delayIsOngoing(d)
            ? `${delayDaysLost(d)}<span class="ml-1 rounded-full bg-rose-500/20 px-1.5 py-0.5 text-[10px] font-semibold text-rose-300">ongoing</span>`
            : delayDaysLost(d)}
        </td>
        <td class="max-w-md">
          ${d.description_en ? `<p>${esc(d.description_en)}</p>` : ''}
          ${d.description ? `<p class="text-slate-500">${esc(d.description)}</p>` : ''}
          ${!d.description && !d.description_en ? '<span class="text-slate-500">-</span>' : ''}
          ${photoStrip(delayPhotos.get(d.id), d.id)}
        </td>
        <td class="text-right whitespace-nowrap">
          <button type="button" class="table-action" data-delay-edit="${esc(d.id)}">Edit</button>
          <button type="button" class="table-action is-danger" data-delay-delete="${esc(d.id)}">Delete</button>
        </td>
      </tr>`;
  }).join('');
  $('#delays-table').innerHTML = `
    <table class="data-table">
      <thead>
        <tr>
          <th>Date</th><th>Cause</th>${rooms ? '<th>Room</th>' : ''}<th>At fault</th><th>Work held up</th>
          <th class="num">Days</th><th>Description</th><th></th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
      <tfoot>
        <tr><td colspan="${rooms ? 4 : 3}">Total</td><td class="num">${days}</td><td colspan="2"></td></tr>
      </tfoot>
    </table>`;
}

async function onDelaysTableClick(e) {
  const open = e.target.closest('[data-photo-open]');
  if (open) {
    const [delayId, index] = open.dataset.photoOpen.split(':');
    return openPhotoFrom(delayPhotos.get(delayId) || [], Number(index));
  }

  const edit = e.target.closest('[data-delay-edit]');
  if (edit) {
    openDelayModal(state.delays.find((d) => d.id === edit.dataset.delayEdit));
    return;
  }
  const del = e.target.closest('[data-delay-delete]');
  if (!del) return;
  const delay = state.delays.find((d) => d.id === del.dataset.delayDelete);
  if (!delay || !confirm(`Delete the ${delay.delay_cause} delay of ${formatDate(delayDate(delay))} `
    + `(${delayDaysLost(delay)} days${delayIsOngoing(delay) ? ', still ongoing' : ''})?`)) return;
  await deletePhotosFor(db, { delayId: delay.id });
  const { error } = await db.from('delays').delete().eq('id', delay.id);
  if (error) {
    toast(`Could not delete: ${error.message}`, 'error');
    return;
  }
  toast('Delay deleted.', 'success');
  refreshDashboard(state.projectId);
  loadSchedule(state.projectId); // delay days and excused days both move
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
          <p>${esc(l.weather || '-')}</p>
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
  const rooms = hasRooms(currentProject());
  el.innerHTML = delays.map((d) => {
    const where = rooms ? roomLabel(d.flats) : '';
    const text = [where, d.description_en || d.description].filter(Boolean).join(' - ');
    return `
      <div class="py-2.5 flex items-start justify-between gap-3 text-sm">
        <div class="min-w-0">
          <p class="text-white font-medium">${esc(d.delay_cause)}</p>
          <p class="text-slate-500 truncate">${esc(text)}</p>
        </div>
        <span class="shrink-0 text-xs font-semibold text-rose-400 tabular-nums">
          ${delayDaysLost(d)} d${delayIsOngoing(d) ? '+' : ''}
        </span>
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
  let dates = '<p class="text-slate-500">No start or completion date - add them with Edit project.</p>';
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
        <li class="text-rose-300">! ${esc(t.name)} - ${t.daysLate} days past planned finish</li>`).join('')}
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
    ${p.count ? '' : '<p class="mt-3 text-slate-500">No timetable yet - add activities on the Timetable page to track progress.</p>'}
    ${overdueList}
    ${when ? `<p class="mt-3 text-xs text-slate-500">${esc(when)}</p>` : ''}`;
}

function openEditProjectModal() {
  const project = currentProject();
  if (!project) return;
  const form = $('#form-edit-project');
  const f = form.elements;
  f.name.value = project.name;
  f.name_ka.value = project.name_ka ?? '';
  f.location.value = project.location ?? '';
  f.location_ka.value = project.location_ka ?? '';
  f.client_name.value = project.client_name ?? '';
  f.client_name_ka.value = project.client_name_ka ?? '';
  f.start_date.value = project.start_date ?? '';
  f.end_date.value = project.end_date ?? '';
  f.currency.value = project.currency ?? DEFAULT_CURRENCY;
  f.has_rooms.checked = hasRooms(project);
  f.day_rate.value = project.day_rate ?? '';
  f.guard_rate.value = project.guard_rate ?? '';
  f.retention_pct.value = Number(project.retention_pct) || '';
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
    name_ka: fd.get('name_ka').trim() || null,
    location: fd.get('location').trim() || null,
    location_ka: fd.get('location_ka').trim() || null,
    client_name: fd.get('client_name').trim() || null,
    client_name_ka: fd.get('client_name_ka').trim() || null,
    start_date: fd.get('start_date') || null,
    end_date: fd.get('end_date') || null,
    currency: fd.get('currency') || DEFAULT_CURRENCY,
    has_rooms: fd.has('has_rooms'),
    day_rate: fd.get('day_rate') === '' ? null : Number(fd.get('day_rate')),
    guard_rate: fd.get('guard_rate') === '' ? null : Number(fd.get('guard_rate')),
    retention_pct: Number(fd.get('retention_pct') || 0),
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
// BOQ & cash flow - built from timetable items and their payments
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
  const c = costPosition(state.tasks, state.payments, today, state.siteCosts);
  updateCostKpi(c);

  const breakdown = [
    `Contracts ${money.format(c.contracts)}`,
    c.labour ? `daily workers ${money.format(c.labour)}` : '',
    c.guard ? `guards ${money.format(c.guard)}` : '',
    c.rental ? `rentals ${money.format(c.rental)}` : '',
  ].filter(Boolean).join(' · ');
  $('#cash-summary').innerHTML = [
    statTile('Budget', money.format(c.budget), `${state.tasks.filter((t) => Number(t.budget)).length} priced items`),
    statTile('Planned by today', money.format(c.planned), 'Value of work due by now'),
    statTile('Work done', money.format(c.earned), 'Budget × % complete',
      c.earned < c.planned - 0.5 ? 'negative' : ''),
    statTile('Spent', money.format(c.spent), breakdown,
      c.spent > c.budget && c.budget > 0 ? 'negative' : ''),
  ].join('');

  // Plain-language position: schedule (done vs planned) and cost (contract payments vs done).
  const lines = [];
  if (c.budget) {
    const behind = c.planned - c.earned;
    lines.push(behind > 0.5
      ? `Schedule: work worth ${money.format(behind)} is behind plan.`
      : 'Schedule: work done is on or ahead of plan.');
    const over = c.contracts - c.earned;
    lines.push(over > 0.5
      ? `Cost: ${money.format(over)} more has been paid to contractors than the value of work done (advances or overspend).`
      : `Cost: contract payments are ${money.format(-over)} below the value of work done.`);
  }
  if (c.labour || c.guard || c.rental) {
    const extra = [
      c.labour ? `${money.format(c.labour)} on daily workers` : '',
      c.guard ? `${money.format(c.guard)} on guards` : '',
      c.rental ? `${money.format(c.rental)} on equipment rentals` : '',
    ].filter(Boolean).join(', ');
    lines.push(`On top of contracts: ${extra} so far.`);
  }
  $('#cash-position').textContent = lines.join(' ');

  renderLabour();
  renderRentals();

  // ---- BOQ table ----
  if (!state.tasks.length) {
    $('#boq-table').innerHTML = '<div class="empty-state">No items yet - add them on the Timetable. Each timetable item can carry a budget and payments.</div>';
  } else {
    const rows = state.tasks.map((t) => {
      const budget = Number(t.budget || 0);
      const paid = paidOn(t.id);
      const left = budget - paid;
      const qty = t.quantity != null
        ? `${qtyFormat.format(t.quantity)} ${esc(t.unit || '')}${t.rate != null ? ` × ${money2.format(t.rate)}` : ''}`
        : '<span class="text-slate-500">-</span>';
      return `
        <tr>
          <td class="task-name">${esc(t.name)}${t.name_ka && t.name_ka !== t.name ? `<span class="block text-xs text-slate-500">${esc(t.name_ka)}</span>` : ''}</td>
          <td>${t.contractor_id ? esc(contractorName(t.contractor_id)) : '<span class="text-slate-500">-</span>'}</td>
          <td class="num">${qty}</td>
          <td class="num">${budget ? money.format(budget) : '-'}</td>
          <td class="num">${paid ? money.format(paid) : '-'}</td>
          <td class="num">${!budget ? '-' : left < 0
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
  }

  // ---- Monthly cash flow: planned budget vs everything actually spent ----
  const planned = plannedSpendByMonth(state.tasks);
  const actual = actualSpendByMonth(state.payments);
  const site = siteCostsByMonth(state.siteCosts, today);
  const months = [...new Set([...planned.keys(), ...actual.keys(), ...site.keys()])].sort();
  if (!months.length) {
    $('#cashflow-months').innerHTML = '<div class="empty-state">Add budgets, payments, daily workers or rentals to see the monthly cash flow.</div>';
    return;
  }

  const thisMonth = today.slice(0, 7);
  const cell = (v) => (v ? money.format(v) : '<span class="text-slate-500">-</span>');
  let cumPlanned = 0;
  let cumSpent = 0;
  const totals = { p: 0, a: 0, labour: 0, guard: 0, rental: 0 };
  const monthRows = months.map((ym) => {
    const p = planned.get(ym) ?? 0;
    const a = actual.get(ym) ?? 0;
    const { labour = 0, guard = 0, rental = 0 } = site.get(ym) ?? {};
    const spent = a + labour + guard + rental;
    cumPlanned += p;
    cumSpent += spent;
    totals.p += p;
    totals.a += a;
    totals.labour += labour;
    totals.guard += guard;
    totals.rental += rental;
    return `
      <tr class="${ym === thisMonth ? 'is-current' : ''}">
        <td>${esc(monthLabel(ym))}${ym === thisMonth ? ' <span class="text-xs text-brand-400">· this month</span>' : ''}</td>
        <td class="num">${money.format(p)}</td>
        <td class="num">${cell(a)}</td>
        <td class="num">${cell(labour)}</td>
        <td class="num">${cell(guard)}</td>
        <td class="num">${cell(rental)}</td>
        <td class="num font-semibold text-white">${cell(spent)}</td>
        <td class="num">${money.format(cumPlanned)}</td>
        <td class="num">${ym <= thisMonth ? money.format(cumSpent) : '-'}</td>
      </tr>`;
  }).join('');

  $('#cashflow-months').innerHTML = `
    <table class="data-table">
      <thead>
        <tr>
          <th>Month</th><th class="num">Planned</th><th class="num">Contracts paid</th><th class="num">Daily workers</th>
          <th class="num">Guards</th><th class="num">Rentals</th><th class="num">Total spent</th>
          <th class="num">Cumulative planned</th><th class="num">Cumulative spent</th>
        </tr>
      </thead>
      <tbody>${monthRows}</tbody>
      <tfoot>
        <tr>
          <td>Total</td>
          <td class="num">${money.format(totals.p)}</td>
          <td class="num">${money.format(totals.a)}</td>
          <td class="num">${money.format(totals.labour)}</td>
          <td class="num">${money.format(totals.guard)}</td>
          <td class="num">${money.format(totals.rental)}</td>
          <td class="num">${money.format(totals.a + totals.labour + totals.guard + totals.rental)}</td>
          <td colspan="2"></td>
        </tr>
      </tfoot>
    </table>`;
}

// ---------- Daily workers (from daily logs) ----------
function renderLabour() {
  const entries = state.siteCosts.filter((e) => e.kind === 'labour');
  const el = $('#labour-table');
  if (!entries.length) {
    el.innerHTML = '<div class="empty-state">No daily workers logged yet - add them in a daily log’s Manpower section.</div>';
    return;
  }
  const byMonth = new Map();
  for (const e of entries) {
    const key = e.date.slice(0, 7);
    const m = byMonth.get(key) ?? { days: 0, workerDays: 0, cost: 0 };
    m.days += 1;
    m.workerDays += e.workers;
    m.cost += e.amount;
    byMonth.set(key, m);
  }
  const missingRate = entries.filter((e) => !e.amount).length;
  const rows = [...byMonth].sort((a, b) => b[0].localeCompare(a[0])).map(([ym, m]) => `
    <tr>
      <td>${esc(monthLabel(ym))}</td>
      <td class="num">${m.days}</td>
      <td class="num">${m.workerDays}</td>
      <td class="num">${m.workerDays ? money2.format(m.cost / m.workerDays) : '-'}</td>
      <td class="num">${money.format(m.cost)}</td>
    </tr>`).join('');
  const total = entries.reduce((s, e) => s + e.amount, 0);
  const workerDays = entries.reduce((s, e) => s + e.workers, 0);
  const warning = missingRate === 1
    ? '1 log has daily workers but no rate, so it isn’t counted.'
    : `${missingRate} logs have daily workers but no rate, so they aren’t counted.`;
  el.innerHTML = `
    <table class="data-table">
      <thead>
        <tr><th>Month</th><th class="num">Days</th><th class="num">Worker-days</th><th class="num">Avg rate</th><th class="num">Cost</th></tr>
      </thead>
      <tbody>${rows}</tbody>
      <tfoot>
        <tr><td>Total</td><td class="num">${entries.length}</td><td class="num">${workerDays}</td><td></td>
          <td class="num">${money.format(total)}</td></tr>
      </tfoot>
    </table>
    ${missingRate ? `<p class="text-xs text-amber-400 mt-2">${warning}</p>` : ''}`;
}

// ---------- Equipment rentals ----------
function renderRentals() {
  const el = $('#rentals-table');
  if (!state.rentals.length) {
    el.innerHTML = '<div class="empty-state">No rentals yet - click Add Rental.</div>';
    return;
  }
  const today = todayISO();
  const accrued = new Map();
  for (const e of state.siteCosts) {
    if (e.kind === 'rental' && e.date <= today) accrued.set(e.rentalId, (accrued.get(e.rentalId) ?? 0) + e.amount);
  }
  const rows = state.rentals.map((r) => {
    const end = rentalEnd(r);
    const status = today < r.start_date ? 'Booked' : today > end ? 'Returned' : 'On site';
    return `
      <tr>
        <td>
          <p class="text-white font-medium">${esc(r.equipment)}${r.equipment_ka && r.equipment_ka !== r.equipment ? ` <span class="text-slate-400 font-normal">· ${esc(r.equipment_ka)}</span>` : ''}</p>
          <p class="text-xs text-slate-500">${esc([r.supplier, r.note].filter(Boolean).join(' · ') || '-')}</p>
        </td>
        <td class="whitespace-nowrap">${esc(formatDate(r.start_date))} → ${esc(formatDate(end))}
          <span class="block text-xs text-slate-500">${status}</span></td>
        <td class="num">${r.days} × ${money2.format(r.daily_rate)}</td>
        <td class="num">${money.format(rentalTotal(r))}
          <span class="block text-xs text-slate-500">${money.format(accrued.get(r.id) ?? 0)} so far</span></td>
        <td class="text-right whitespace-nowrap">
          <button type="button" class="table-action" data-rental-edit="${esc(r.id)}">Edit</button>
          <button type="button" class="table-action is-danger" data-rental-delete="${esc(r.id)}">Delete</button>
        </td>
      </tr>`;
  }).join('');
  el.innerHTML = `
    <table class="data-table">
      <thead><tr><th>Equipment</th><th>Dates</th><th class="num">Days × price</th><th class="num">Cost</th><th></th></tr></thead>
      <tbody>${rows}</tbody>
      <tfoot>
        <tr><td colspan="3">Total</td><td class="num">${money.format(state.rentals.reduce((s, r) => s + rentalTotal(r), 0))}</td><td></td></tr>
      </tfoot>
    </table>`;
}

function openRentalModal(rental = null) {
  if (!requireProject()) return;
  const form = $('#form-rental');
  const f = form.elements;
  form.reset();
  $('#rental-title').textContent = rental ? `Edit Rental - ${rental.equipment}` : 'Add Rental';
  f.id.value = rental?.id ?? '';
  f.equipment_ka.value = rental?.equipment_ka ?? '';
  f.equipment.value = rental?.equipment_ka && rental.equipment === rental.equipment_ka ? '' : (rental?.equipment ?? '');
  f.supplier_ka.value = rental?.supplier_ka ?? '';
  f.supplier.value = rental?.supplier ?? '';
  f.start_date.value = rental?.start_date ?? todayISO();
  f.days.value = rental?.days ?? 1;
  f.daily_rate.value = rental?.daily_rate ?? '';
  f.note.value = rental?.note ?? '';
  updateRentalTotal();
  showFormError(form, '');
  openModal('modal-rental');
  f.equipment_ka.focus();
}

// Picking a suggested item in one language fills the other one in.
function onRentalInput(e) {
  const f = e.currentTarget.elements;
  if (e.target === f.equipment && !f.equipment_ka.value && EQUIPMENT_SUGGESTIONS.includes(f.equipment.value)) {
    f.equipment_ka.value = ka(f.equipment.value);
  }
  if (e.target === f.equipment_ka && !f.equipment.value) {
    const en = EQUIPMENT_SUGGESTIONS.find((x) => ka(x) === f.equipment_ka.value);
    if (en) f.equipment.value = en;
  }
  updateRentalTotal();
}

function updateRentalTotal() {
  const f = $('#form-rental').elements;
  const days = Number(f.days.value);
  const rate = Number(f.daily_rate.value);
  $('#rental-total').textContent = days > 0 && f.daily_rate.value !== ''
    ? `Total: ${days} day${days === 1 ? '' : 's'} × ${money2.format(rate)} = ${money.format(days * rate)}`
    : '';
}

async function saveRental(e) {
  e.preventDefault();
  const form = e.currentTarget;
  const btn = $('[type=submit]', form);
  const fd = new FormData(form);
  const days = Number(fd.get('days'));
  const rate = Number(fd.get('daily_rate'));
  if (!Number.isInteger(days) || days < 1) {
    showFormError(form, 'Days must be a whole number - 1 or more.');
    return;
  }
  if (fd.get('daily_rate') === '' || !Number.isFinite(rate) || rate < 0) {
    showFormError(form, 'Enter the daily price.');
    return;
  }
  const equipmentKa = fd.get('equipment_ka').trim();
  const equipmentEn = fd.get('equipment').trim();
  if (!equipmentKa && !equipmentEn) {
    showFormError(form, 'Enter the equipment in Georgian or English.');
    return;
  }
  const id = fd.get('id');
  const row = {
    equipment: equipmentEn || equipmentKa,
    equipment_ka: equipmentKa || null,
    supplier: fd.get('supplier').trim() || fd.get('supplier_ka').trim() || null,
    supplier_ka: fd.get('supplier_ka').trim() || null,
    start_date: fd.get('start_date'),
    days,
    daily_rate: rate,
    note: fd.get('note').trim() || null,
  };

  showFormError(form, '');
  setBusy(btn, true);
  const { error } = id
    ? await db.from('equipment_rentals').update(row).eq('id', id)
    : await db.from('equipment_rentals').insert({ ...row, project_id: state.projectId });
  setBusy(btn, false);
  if (error) {
    showFormError(form, error.message);
    return;
  }
  closeModal('modal-rental');
  toast(id ? 'Rental updated.' : 'Rental added.', 'success');
  loadSchedule(state.projectId);
}

async function onRentalsTableClick(e) {
  const edit = e.target.closest('[data-rental-edit]');
  if (edit) {
    openRentalModal(state.rentals.find((r) => r.id === edit.dataset.rentalEdit));
    return;
  }
  const del = e.target.closest('[data-rental-delete]');
  if (!del) return;
  const rental = state.rentals.find((r) => r.id === del.dataset.rentalDelete);
  if (!rental || !confirm(`Delete the ${rental.equipment} rental (${money.format(rentalTotal(rental))})?`)) return;
  const { error } = await db.from('equipment_rentals').delete().eq('id', rental.id);
  if (error) {
    toast(`Could not delete: ${error.message}`, 'error');
    return;
  }
  toast('Rental deleted.', 'success');
  loadSchedule(state.projectId);
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

  $('#payments-title').textContent = `Payments - ${task.name}`;
  const held = sumOf(payments, 'retention');
  $('#payments-summary').textContent = (budget
    ? `Budget ${money.format(budget)} · paid ${money.format(paid)} · ${paid > budget ? `${money.format(paid - budget)} over budget` : `${money.format(budget - paid)} left`}`
    : `Paid ${money.format(paid)} · no budget set for this item`)
    + (held ? ` · ${money.format(held)} retention held` : '');

  $('#payments-list').innerHTML = payments.length ? `
    <table class="data-table">
      <thead><tr><th>Date</th><th class="num">Paid</th><th class="num">Retention</th><th>Note</th><th></th></tr></thead>
      <tbody>
        ${payments.map((p) => `
          <tr>
            <td class="whitespace-nowrap">${esc(formatDate(p.paid_on))}</td>
            <td class="num">${money2.format(p.amount)}</td>
            <td class="num">${Number(p.retention) ? money2.format(p.retention) : '<span class="text-slate-500">-</span>'}</td>
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
  updatePaymentNet();
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

// "10,000 certified - 500 retention = 9,500 paid", under the payment form.
function updatePaymentNet() {
  const f = $('#form-payment').elements;
  const gross = Number(f.gross.value || 0);
  const pct = Number(currentProject()?.retention_pct || 0);
  // Retention follows the project percentage until someone types over it.
  if (document.activeElement === f.gross && pct > 0) {
    f.retention.value = gross > 0 ? (gross * pct / 100).toFixed(2) : '';
  }
  const retention = Number(f.retention.value || 0);
  const el = $('#payment-net');
  if (!(gross > 0)) {
    el.textContent = pct > 0
      ? `${pct}% retention is filled in for you; change it if this certificate differs.`
      : '';
    return;
  }
  el.textContent = retention > 0
    ? `${money2.format(gross)} certified - ${money2.format(retention)} retention = ${money2.format(gross - retention)} paid`
    : `${money2.format(gross)} paid, nothing held`;
}

async function savePayment(e) {
  e.preventDefault();
  const form = e.currentTarget;
  const btn  = $('[type=submit]', form);
  const fd   = new FormData(form);

  // The certificate is the gross; what leaves the bank is the gross less the
  // retention held, and that stays the payment's amount.
  const gross = Number(fd.get('gross'));
  const retention = Number(fd.get('retention') || 0);
  const row = {
    project_id: state.projectId,
    task_id:    paymentTaskId,
    paid_on:    fd.get('paid_on'),
    amount:     Number((gross - retention).toFixed(2)),
    retention,
    note:       fd.get('note').trim() || null,
  };
  if (!(gross > 0)) {
    showFormError(form, 'Enter a certified amount above zero.');
    return;
  }
  if (retention < 0 || retention >= gross) {
    showFormError(form, 'Retention has to be less than the certified amount.');
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
  updatePaymentNet();
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
// Contractors - each project has its own (contractors.project_id).
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
  const perf = contractorPerformance(state.tasks, state.contractorDelays, state.payments, todayISO(), state.delayImpacts);
  const el = $('#contractors-table');
  const list = [...state.contractors].sort((a, b) =>
    (perf.get(b.id)?.items ?? 0) - (perf.get(a.id)?.items ?? 0) || a.name.localeCompare(b.name));

  if (!list.length) {
    el.innerHTML = '<div class="empty-state">No contractors on this project yet - click Add Contractor.</div>';
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
        <td class="num">${s?.delayDays ? `${s.delayDays} d` : '-'}</td>
        <td class="num">${s?.excusedDays
          ? `<span class="text-sky-300">${s.excusedDays} d</span> <span class="text-slate-500">(${s.excusedItems})</span>`
          : '-'}</td>
        <td class="num">${s?.budget ? money.format(s.budget) : '-'}</td>
        <td class="num">${s?.paid ? money.format(s.paid) : '-'}</td>
        <td class="whitespace-nowrap">${contractorRating(s)}</td>
        <td class="text-right whitespace-nowrap">
          <button type="button" class="table-action" data-contractor-jobs="${esc(c.id)}">Jobs</button>
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
          <th class="num">Overdue now</th><th class="num">Open</th><th class="num">Delay days</th>
          <th class="num">Excused</th><th class="num">Budget</th><th class="num">Paid</th><th>Performance</th><th></th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
    ${unassigned ? `<p class="mt-3 text-xs text-slate-500">${unassigned} timetable item(s) have no contractor yet - pick one in the Contractor column on the Timetable.</p>` : ''}`;
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
  f.name_ka.focus();
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

// Pop-up with every timetable item assigned to one contractor.
function openContractorJobs(contractorId) {
  const c = state.contractors.find((x) => x.id === contractorId);
  if (!c) return;
  const today = todayISO();
  const jobs = state.tasks
    .filter((t) => t.contractor_id === c.id)
    .sort((a, b) => a.planned_start.localeCompare(b.planned_start));
  const s = contractorPerformance(state.tasks, state.contractorDelays, state.payments, today, state.delayImpacts).get(c.id);

  $('#contractor-jobs-title').textContent = `Jobs - ${c.name}`;
  $('#contractor-jobs-sub').textContent = [c.name_ka, c.trade].filter(Boolean).join(' · ');
  $('#contractor-jobs-summary').innerHTML = [
    statTile('Jobs', String(jobs.length), s ? `${s.onTime} on time · ${s.late} late` : ''),
    statTile('Overdue', String(s?.overdue ?? 0), 'Past planned finish', s?.overdue ? 'negative' : ''),
    statTile('Excused', s?.excusedDays ? `${s.excusedDays} d` : '-',
      s?.excusedItems ? `on ${s.excusedItems} item${s.excusedItems === 1 ? '' : 's'} - another's delay` : 'Nothing held them up'),
    statTile('Budget', money.format(s?.budget ?? 0), 'Their items'),
    statTile('Paid', money.format(s?.paid ?? 0),
      s?.budget ? `${Math.round(((s.paid ?? 0) / s.budget) * 100)}% of budget` : ''),
  ].join('');

  $('#contractor-jobs-list').innerHTML = jobs.length ? `
    <table class="data-table">
      <thead>
        <tr><th>Work item</th><th>Dates</th><th class="num">Done</th><th class="num">Budget</th><th class="num">Paid</th><th>Status</th></tr>
      </thead>
      <tbody>
        ${jobs.map((t) => {
          const pct = Math.round(completionOf(t) * 100);
          return `
            <tr>
              <td class="task-name">${esc(t.name)}${t.name_ka && t.name_ka !== t.name ? `<span class="block text-xs text-slate-500">${esc(t.name_ka)}</span>` : ''}</td>
              <td class="whitespace-nowrap">${esc(formatDate(t.planned_start))} → ${esc(formatDate(t.planned_finish))}</td>
              <td class="num">
                ${pct}%
                <div class="task-pct-bar"><div style="width:${pct}%"></div></div>
              </td>
              <td class="num">${Number(t.budget) ? money.format(t.budget) : '-'}</td>
              <td class="num">${paidOn(t.id) ? money.format(paidOn(t.id)) : '-'}</td>
              <td class="whitespace-nowrap">${taskStateChip(t, taskState(t, today))}</td>
            </tr>`;
        }).join('')}
      </tbody>
    </table>`
    : '<div class="empty-state">No jobs assigned yet - pick this contractor in the Contractor column on the Timetable.</div>';
  openModal('modal-contractor-jobs');
}

function onContractorsClick(e) {
  const jobs = e.target.closest('[data-contractor-jobs]');
  if (jobs) return openContractorJobs(jobs.dataset.contractorJobs);

  const edit = e.target.closest('[data-contractor-edit]');
  if (edit) return openContractorModal(state.contractors.find((c) => c.id === edit.dataset.contractorEdit));

  const del = e.target.closest('[data-contractor-delete]');
  if (del) deleteContractor(del.dataset.contractorDelete);
}

// =============================================================
// Daily logs list + Ask Gemini (whole-project Q&A)
// =============================================================
const LOG_PAGE = 60;                                  // logs fetched at a time
const logFilter = { from: '', to: '', text: '' };     // what the toolbar asks for
let shownLogs = [];                                   // logs on screen, newest first

// PostgREST reads commas and brackets as syntax inside .or() - keep them out.
const searchTerm = (v) => v.replace(/[(),*%\\]/g, ' ').trim();

// Photos of the logs on screen: log id → [{ id, url }] (url = signed thumbnail).
let logPhotos = new Map();

const photoStrip = (photos, owner) => (photos?.length ? `
  <div class="photo-strip">
    ${photos.map((p, i) => `
      <button type="button" class="photo-thumb" data-photo-open="${esc(owner)}:${i}">
        <img src="${esc(p.url)}" alt="" loading="lazy">
      </button>`).join('')}
  </div>` : '');

/**
 * The delays that were running on a day, shown on its log. The crew above is
 * the evidence for them: it is this sheet that shows whose men were missing.
 */
function delayLineFor(logDate) {
  const running = state.delays.filter((d) => delayCovers(d, logDate));
  if (!running.length) return '';
  const parts = running.map((d) => {
    const who = causeOf(d) ? contractorName(causeOf(d)) : 'nobody at fault';
    return `${d.delay_cause} (${who})`;
  });
  return `<p class="log-card-delays">Delay running: ${parts.map((t) => esc(t)).join(' &middot; ')}</p>`;
}

const logCard = (l) => {
  const tradeLabel = (key) => MANPOWER_TRADES.find((t) => t.key === key)?.label ?? key;
  const nameOf = (id) => state.contractors.find((c) => c.id === id)?.name ?? 'Hired by the client';
  // Grouped by whoever brought them, which is the question the day answers now.
  const byContractor = new Map();
  for (const c of l.crew ?? []) {
    if (!(Number(c.workers) > 0)) continue;
    const name = nameOf(c.contractor_id);
    if (!byContractor.has(name)) byContractor.set(name, []);
    byContractor.get(name).push(`${tradeLabel(c.trade)} ${c.workers}`);
  }
  const crew = [...byContractor].map(([name, parts]) => `${name}: ${parts.join(', ')}`);
  const total = (l.crew ?? []).reduce((sum, c) => sum + (Number(c.workers) || 0), 0);
  return `
    <article class="log-card">
      <div class="log-card-head">
        <span class="log-card-date">${esc(formatDate(l.log_date))}</span>
        <span class="log-card-meta">${esc([l.weather, total ? `${total} on site` : ''].filter(Boolean).join(' · '))}</span>
        <span class="log-card-actions">
          <button type="button" class="table-action" data-log-edit="${esc(l.id)}">Edit</button>
          <button type="button" class="table-action is-danger" data-log-delete="${esc(l.id)}">Delete</button>
        </span>
      </div>
      ${crew.length ? `<p class="log-card-crew">${crew.map((line) => esc(line)).join(' &middot; ')}</p>` : ''}
      ${delayLineFor(l.log_date)}
      <div class="log-notes">
        <p><span class="log-lang">ქართული</span>${esc(l.notes || '-')}</p>
        <p><span class="log-lang">English</span>${esc(l.notes_en || '-')}</p>
      </div>
      ${photoStrip(logPhotos.get(l.id), l.id)}
    </article>`;
};

/**
 * Newest first, a page at a time. `more` keeps what is on screen and adds the
 * next page; anything else starts again from the newest log that matches.
 */
async function loadLogs(projectId, { more = false } = {}) {
  const el = $('#daily-logs-container');
  const from = more ? shownLogs.length : 0;

  let q = db
    .from('daily_logs')
    .select('id, log_date, weather, manpower, notes, notes_en, raw_text, day_rate, guard_rate, '
      + 'crew:daily_manpower(contractor_id, trade, workers)', { count: 'exact' })
    .eq('project_id', projectId);
  if (logFilter.from) q = q.gte('log_date', logFilter.from);
  if (logFilter.to) q = q.lte('log_date', logFilter.to);
  const term = searchTerm(logFilter.text);
  if (term) q = q.or(`notes.ilike.%${term}%,notes_en.ilike.%${term}%,weather.ilike.%${term}%`);

  const { data, error, count } = await q
    .order('log_date', { ascending: false })
    .range(from, from + LOG_PAGE - 1);

  if (projectId !== state.projectId) return;
  if (error) {
    el.innerHTML = `<div class="panel empty-state">Could not load logs: ${esc(error.message)}</div>`;
    return;
  }

  shownLogs = more ? [...shownLogs, ...data] : data;
  const filtered = Boolean(logFilter.from || logFilter.to || term);
  const total = Number(count ?? shownLogs.length);

  $('#log-count').textContent = total
    ? `${filtered ? `${total} log${total === 1 ? '' : 's'} found` : `${total} log${total === 1 ? '' : 's'}`}`
      + (shownLogs.length < total ? ` · showing the newest ${shownLogs.length}` : '')
    : '';

  if (!shownLogs.length) {
    el.innerHTML = filtered
      ? '<div class="panel empty-state">No logs match - widen the dates or clear the search.</div>'
      : "<div class=\"panel empty-state\">No daily logs yet - click New Daily Log and paste today's WhatsApp log.</div>";
    return;
  }

  await loadLogPhotos();
  el.innerHTML = shownLogs.map(logCard).join('')
    + (shownLogs.length < total
      ? `<button type="button" id="btn-log-more" class="btn btn-secondary w-full">
           Show older logs (${total - shownLogs.length} more)
         </button>`
      : '');
}

async function onLogsClick(e) {
  if (e.target.closest('#btn-log-more')) return loadLogs(state.projectId, { more: true });

  const edit = e.target.closest('[data-log-edit]');
  if (edit) return openDailyLogModal(shownLogs.find((l) => l.id === edit.dataset.logEdit));

  const open = e.target.closest('[data-photo-open]');
  if (open) {
    const [logId, index] = open.dataset.photoOpen.split(':');
    return openPhotoFrom(logPhotos.get(logId) || [], Number(index));
  }

  const del = e.target.closest('[data-log-delete]');
  if (!del) return;
  const log = shownLogs.find((l) => l.id === del.dataset.logDelete);
  if (!log || !confirm(`Delete the daily log of ${formatDate(log.log_date)}?`)) return;

  await deletePhotosFor(db, { dailyLogId: log.id }); // the rows cascade, the files do not
  const { error } = await db.from('daily_logs').delete().eq('id', log.id);
  if (error) {
    toast(`Could not delete the log: ${error.message}`, 'error');
    return;
  }
  toast('Daily log deleted.', 'success');
  shownLogs = shownLogs.filter((l) => l.id !== log.id);
  refreshDashboard(state.projectId);
  loadLogs(state.projectId);
  loadSchedule(state.projectId); // daily-worker pay feeds the cash flow
}

// Signed thumbnails for the logs on screen, in one round trip.
async function loadLogPhotos() {
  const ids = shownLogs.map((l) => l.id);
  const photos = await fetchPhotos(db, { dailyLogIds: ids });
  const urls = await signPhotos(db, photos);
  logPhotos = new Map();
  for (const [logId, rows] of photosBy(photos, 'daily_log_id')) {
    logPhotos.set(logId, rows.map((p) => ({ ...p, url: urls.get(p.id) || '' })));
  }
}

// A thumbnail opens the full-size photo, signed on the way.
async function openPhotoFrom(photos, index) {
  const urls = await signPhotos(db, photos, { full: true });
  openPhotoViewer(photos.map((p) => urls.get(p.id)).filter(Boolean), index);
}

// Typing in the search box shouldn't hit the database on every keystroke.
let logSearchTimer;
function onLogFilterChange() {
  logFilter.from = $('#log-from').value;
  logFilter.to = $('#log-to').value;
  logFilter.text = $('#log-search').value.trim();
  clearTimeout(logSearchTimer);
  logSearchTimer = setTimeout(() => loadLogs(state.projectId), 250);
}

// Switching project starts the list again, unfiltered.
function resetLogFilter() {
  logFilter.from = '';
  logFilter.to = '';
  logFilter.text = '';
  shownLogs = [];
  $('#log-from').value = '';
  $('#log-to').value = '';
  $('#log-search').value = '';
}

function clearLogFilter() {
  $('#log-from').value = '';
  $('#log-to').value = '';
  $('#log-search').value = '';
  onLogFilterChange();
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

  if (error) {
    out.innerHTML = `<p class="ask-q">${esc(question)}</p>${esc(`Gemini couldn't answer: ${await functionErrorMessage(error)}`)}`;
    return;
  }
  // How much of the project the answer is based on - and what it could not read.
  const read = Number(data.logs_used || 0);
  const found = Number(data.logs_found || read);
  const coverage = read
    ? `Read ${read} daily log${read === 1 ? '' : 's'}${read < found ? ` of ${found} - the ${found - read} oldest did not fit` : ''}.`
    : '';
  // Gemini answers in both languages; the question's own is shown and the
  // toggle switches to the other, so either can be copied into a message.
  const shown = data.asked === 'ka' ? 'ka' : 'en';
  const both = data.ka && data.en;
  // The box keeps the answer's own line breaks (pre-wrap), so the markup
  // around it carries no newlines of its own.
  const langBtn = (lang) =>
    `<button type="button" class="ask-lang${lang === shown ? ' is-active' : ''}" `
    + `data-ask-lang="${lang}">${lang === 'ka' ? 'ქართული' : 'English'}</button>`;
  const answerText = (lang) =>
    `<div class="ask-text${lang === shown ? '' : ' hidden'}" data-ask-text="${lang}">${esc(data[lang])}</div>`;

  out.innerHTML = `<div class="ask-head"><p class="ask-q">${esc(question)}</p>`
    + (both ? `<div class="ask-langs">${langBtn('ka')}${langBtn('en')}</div>` : '')
    + '</div>'
    + (both ? answerText('ka') + answerText('en') : esc(data.answer ?? ''))
    + (coverage ? `<p class="mt-2 text-xs text-slate-500">${esc(coverage)}</p>` : '');
}

// The answer is already on the page in both languages: only which one is
// visible changes, so switching never asks Gemini again.
function onAskLangToggle(e) {
  const btn = e.target.closest('[data-ask-lang]');
  if (!btn) return;
  const out = $('#ask-answer');
  $$('[data-ask-lang]', out).forEach((b) => b.classList.toggle('is-active', b === btn));
  $$('[data-ask-text]', out).forEach((t) => t.classList.toggle('hidden', t.dataset.askText !== btn.dataset.askLang));
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
  $('#log-weather').innerHTML = '<option value="">- Select -</option>'
    + WEATHER_OPTIONS.map((w) => `<option value="${esc(w)}">${esc(w)}</option>`).join('');

  $('#btn-add-crew').addEventListener('click', () => addCrewRow());
  $('#crew-rows').addEventListener('click', (e) => {
    if (!e.target.closest('[data-crew-remove]')) return;
    e.target.closest('.crew-row').remove();
    if (!$$('#crew-rows .crew-row').length) addCrewRow();
    updateManpowerTotal();
  });
  $('#crew-rows').addEventListener('change', updateManpowerTotal);

  $('#delay-cause').innerHTML = DELAY_CAUSES.map((c) => `<option value="${esc(c)}">${esc(c)}</option>`).join('');

  $('#form-daily-log').addEventListener('input', updateManpowerTotal);

  $('#task-unit').innerHTML = '<option value="">-</option>'
    + BOQ_UNITS.map((u) => `<option value="${esc(u)}">${esc(u)}</option>`).join('');
  $('#contractor-trades').innerHTML = CONTRACTOR_TRADES.map((t) => `<option value="${esc(t)}"></option>`).join('');

  const currencyOptions = Object.entries(CURRENCIES)
    .map(([code, label]) => `<option value="${code}">${esc(label)}</option>`).join('');
  $$('[data-currency-options]').forEach((sel) => { sel.innerHTML = currencyOptions; });

  const typeOptions = '<option value="">-</option>'
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
// ---------- Crew on site: one line per contractor and trade ----------
/** The contractors to choose from, plus men the client engaged themselves. */
function crewContractorOptions(selected) {
  const chosen = selected ?? '';
  const direct = `<option value=""${chosen === '' ? ' selected' : ''}>Hired by the client</option>`;
  return direct + state.contractors.map((c) => (
    `<option value="${esc(c.id)}"${c.id === chosen ? ' selected' : ''}>${esc(c.name)}</option>`
  )).join('');
}

function addCrewRow(entry = {}) {
  const row = document.createElement('div');
  row.className = 'crew-row';
  row.innerHTML = `
    <select class="select-dark" data-crew="contractor">${crewContractorOptions(entry.contractor_id)}</select>
    <select class="select-dark" data-crew="trade">
      ${MANPOWER_TRADES.map((t) => (
    `<option value="${esc(t.key)}"${t.key === entry.trade ? ' selected' : ''}>${esc(t.label)}</option>`
  )).join('')}
    </select>
    <input type="number" min="0" step="1" inputmode="numeric" placeholder="0" class="input-dark"
           data-crew="workers" value="${entry.workers ? esc(String(entry.workers)) : ''}">
    <button type="button" class="table-action" data-crew-remove aria-label="Remove this line">&times;</button>`;
  $('#crew-rows').appendChild(row);
  updateManpowerTotal();
}

/** Fills the form from saved rows; an empty log starts with one blank line. */
function renderCrewRows(entries) {
  $('#crew-rows').replaceChildren();
  if (entries?.length) entries.forEach(addCrewRow);
  else addCrewRow();
}

/** What the form holds now, with the blank and zeroed lines dropped. */
function readCrewRows() {
  return $$('#crew-rows .crew-row').map((row) => ({
    contractor_id: $('[data-crew="contractor"]', row).value || null,
    trade: $('[data-crew="trade"]', row).value,
    workers: parseInt($('[data-crew="workers"]', row).value, 10) || 0,
  })).filter((e) => e.workers > 0);
}

/** The day's headcount by trade, whoever brought them. */
function crewByTrade(entries) {
  const totals = {};
  for (const e of entries) totals[e.trade] = (totals[e.trade] || 0) + e.workers;
  return totals;
}

/** Replaces a log's crew lines with what the form holds. */
async function saveCrew(logId, crew) {
  const { error } = await db.from('daily_manpower').delete().eq('daily_log_id', logId);
  if (error) return error;
  if (!crew.length) return null;
  const rows = crew.map((e) => ({ daily_log_id: logId, ...e }));
  return (await db.from('daily_manpower').insert(rows)).error;
}

function updateManpowerTotal() {
  const total = $$('#crew-rows [data-crew="workers"]')
    .reduce((sum, i) => sum + (parseInt(i.value, 10) || 0), 0);
  $('#manpower-total').textContent = total;
  updateDayCost();
}

// "5 daily workers × ₾80 = ₾400" under each rate field.
function updateDayCost() {
  // Only the client's own: a contractor's men are paid by that contractor, out
  // of the price of their work, and are not a cost here.
  const own = (trade) => readCrewRows()
    .filter((e) => !e.contractor_id && e.trade === trade)
    .reduce((sum, e) => sum + e.workers, 0);
  rateLine('#day-cost', 'day_rate', own(DAY_WORKER_KEY), 'daily worker');
  rateLine('#guard-cost', 'guard_rate', own(GUARD_KEY), 'guard');
}

function rateLine(selector, rateField, workers, noun) {
  const f = $('#form-daily-log').elements;
  const rate = f[rateField].value === '' ? null : Number(f[rateField].value);
  const el = $(selector);
  if (!workers) {
    el.textContent = `No ${noun}s of the client’s own entered.`;
    el.className = 'text-sm text-slate-500 pb-2';
  } else if (rate == null) {
    el.textContent = `${workers} ${noun}${workers === 1 ? '' : 's'} on the client's account - enter the rate to count their pay.`;
    el.className = 'text-sm text-amber-400 pb-2';
  } else {
    el.textContent = `${workers} × ${money2.format(rate)} = ${money.format(workers * rate)} today`;
    el.className = 'text-sm text-slate-300 pb-2';
  }
}

// =============================================================
// Photos on a daily log or a delay
// =============================================================
// One picker per modal. `existing` are photos already stored (with a signed
// thumbnail), `pending` are files chosen but not yet uploaded, `removed` are
// stored photos the user struck out - all three are settled on save.
const pickers = new Map();

function picker(name) {
  if (!pickers.has(name)) {
    const root = $(`[data-picker="${name}"]`);
    pickers.set(name, { root, list: $('[data-photo-list]', root), existing: [], pending: [], removed: [] });
  }
  return pickers.get(name);
}

async function resetPicker(name, owner = null) {
  const p = picker(name);
  p.pending.forEach((f) => URL.revokeObjectURL(f.url));
  p.existing = [];
  p.pending = [];
  p.removed = [];
  renderPicker(name);
  if (!owner) return;
  // fetchPhotos takes lists, not one id - passing the owner straight through
  // matched nothing, so an edited entry opened with no photos to remove.
  const photos = await fetchPhotos(db, owner.dailyLogId
    ? { dailyLogIds: [owner.dailyLogId] }
    : { delayIds: [owner.delayId] });
  const urls = await signPhotos(db, photos);
  p.existing = photos.map((photo) => ({ photo, url: urls.get(photo.id) || '' }));
  renderPicker(name);
}

function renderPicker(name) {
  const p = picker(name);
  const tile = (src, key, index) => `
    <div class="photo-tile">
      <img src="${esc(src)}" alt="">
      <button type="button" class="photo-drop" data-photo-drop="${key}:${index}" aria-label="Remove photo">&times;</button>
    </div>`;
  p.list.innerHTML = p.existing.map((e, i) => tile(e.url, 'kept', i)).join('')
    + p.pending.map((f, i) => tile(f.url, 'new', i)).join('');
  const count = p.existing.length + p.pending.length;
  $('.photo-add', p.root).classList.toggle('hidden', count >= MAX_PHOTOS);
}

function addPhotoFiles(name, files) {
  const p = picker(name);
  const room = MAX_PHOTOS - (p.existing.length + p.pending.length);
  const picked = [...files].filter((f) => f.type.startsWith('image/')).slice(0, Math.max(0, room));
  if (files.length > picked.length) toast(`Only ${MAX_PHOTOS} photos fit on one entry.`, 'error');
  for (const file of picked) p.pending.push({ file, url: URL.createObjectURL(file) });
  renderPicker(name);
}

function onPickerClick(e) {
  const drop = e.target.closest('[data-photo-drop]');
  if (!drop) return;
  const name = drop.closest('[data-picker]').dataset.picker;
  const p = picker(name);
  const [kind, index] = drop.dataset.photoDrop.split(':');
  if (kind === 'kept') {
    p.removed.push(p.existing.splice(Number(index), 1)[0].photo);
  } else {
    URL.revokeObjectURL(p.pending[Number(index)].url);
    p.pending.splice(Number(index), 1);
  }
  renderPicker(name);
}

/** Uploads what was added and deletes what was struck out. Returns an error message, or ''. */
async function commitPhotos(name, owner) {
  const p = picker(name);
  try {
    for (const photo of p.removed) await deletePhoto(db, photo);
    await uploadPhotos(db, { projectId: state.projectId, files: p.pending.map((f) => f.file), ...owner });
    p.pending.forEach((f) => URL.revokeObjectURL(f.url));
    p.pending = [];
    p.removed = [];
    return '';
  } catch (err) {
    return err.message;
  }
}

// ---------- Photo viewer ----------
let viewer = { urls: [], index: 0 };

function openPhotoViewer(urls, index = 0) {
  viewer = { urls, index };
  showPhoto(0);
  openModal('modal-photo');
}

function showPhoto(step) {
  const { urls } = viewer;
  if (!urls.length) return;
  viewer.index = (viewer.index + step + urls.length) % urls.length;
  $('#photo-view-img').src = urls[viewer.index];
  $('#photo-view-note').textContent = urls.length > 1 ? `${viewer.index + 1} / ${urls.length}` : '';
  $$('#modal-photo .photo-nav').forEach((b) => b.classList.toggle('hidden', urls.length < 2));
}

function openDailyLogModal(log = null) {
  if (!requireProject()) return;
  const form = $('#form-daily-log');
  const f = form.elements;
  form.reset();
  form.dataset.logId = log?.id ?? '';
  $('#daily-log-title').textContent = log ? 'Edit Daily Log' : 'New Daily Log';
  f.log_date.max = todayISO();
  if (log) {
    f.log_date.value = log.log_date;
    f.weather.value = log.weather || '';
    renderCrewRows(log.crew);
    f.notes.value = log.notes || '';
    f.notes_en.value = log.notes_en || '';
    f.raw_text.value = log.raw_text || '';
    f.day_rate.value = log.day_rate ?? '';
    f.guard_rate.value = log.guard_rate ?? '';
  } else {
    f.log_date.value = todayISO();
    f.day_rate.value = currentProject()?.day_rate ?? '';
    f.guard_rate.value = currentProject()?.guard_rate ?? '';
    renderCrewRows([]);
  }
  updateManpowerTotal();
  resetPicker('log', log ? { dailyLogId: log.id } : null);
  showFormError(form, '');
  openModal('modal-daily-log');
  (log ? f.notes : f.raw_text).focus();
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
  // Gemini reads a headcount by trade; it has no way of knowing whose men they
  // were, so they come in as the client's own and the contractor is set by hand.
  renderCrewRows(MANPOWER_TRADES
    .map((t) => ({ contractor_id: null, trade: t.key, workers: Number(data.manpower?.[t.key]) || 0 }))
    .filter((e) => e.workers > 0));
  f.notes.value = data.notes_ka || '';
  f.notes_en.value = data.notes_en || '';
  updateManpowerTotal();
  toast('Log processed - check the details, then save.', 'success');
}

async function saveDailyLog(e) {
  e.preventDefault();
  const form = e.currentTarget;
  const btn  = $('[type=submit]', form);
  const fd   = new FormData(form);

  const crew = readCrewRows();
  // daily_logs.manpower is kept as the day's total by trade. It is derived from
  // the crew lines, never typed: the edge functions and the older figures still
  // read it, and two places to enter the same count would soon disagree.
  const manpower = crewByTrade(crew);

  const row = {
    project_id: state.projectId,
    log_date:   fd.get('log_date'),
    weather:    fd.get('weather') || null,
    manpower,
    // Georgian notes fall back to the raw paste if it wasn't processed.
    notes:      fd.get('notes').trim() || fd.get('raw_text').trim() || null,
    notes_en:   fd.get('notes_en').trim() || null,
    raw_text:   fd.get('raw_text').trim() || null,
    day_rate:   fd.get('day_rate') === '' ? null : Number(fd.get('day_rate')),
    guard_rate: fd.get('guard_rate') === '' ? null : Number(fd.get('guard_rate')),
  };

  const logId = form.dataset.logId;

  showFormError(form, '');
  setBusy(btn, true);
  const { data: saved, error } = logId
    ? await db.from('daily_logs').update(row).eq('id', logId).select('id').single()
    : await db.from('daily_logs').insert(row).select('id').single();

  if (error) {
    setBusy(btn, false);
    showFormError(form, error.code === '23505'
      ? `A log for ${formatDate(row.log_date)} already exists for this project.`
      : error.message);
    return;
  }

  // The crew lines are replaced wholesale: simpler than working out which of
  // them changed, and the day is only ever a handful of rows.
  const crewError = await saveCrew(saved.id, crew);
  if (crewError) {
    setBusy(btn, false);
    showFormError(form, `The log was saved, but the crew lines were not: ${crewError.message}`);
    return;
  }

  const photoError = await commitPhotos('log', { dailyLogId: saved.id });
  setBusy(btn, false);
  if (photoError) toast(`The log was saved, but the photos were not: ${photoError}`, 'error');

  closeModal('modal-daily-log');
  toast(logId ? 'Daily log updated.' : 'Daily log saved.', 'success');

  // The first rate of each kind becomes the project's default for later logs.
  const project = currentProject();
  const defaults = {};
  if (project?.day_rate == null && row.day_rate != null) defaults.day_rate = row.day_rate;
  if (project?.guard_rate == null && row.guard_rate != null) defaults.guard_rate = row.guard_rate;
  if (project && Object.keys(defaults).length) {
    const { error: rateError } = await db.from('projects').update(defaults).eq('id', project.id);
    if (!rateError) Object.assign(project, defaults);
  }
  refreshDashboard(state.projectId);
  loadLogs(state.projectId);
  loadSchedule(state.projectId); // daily-worker pay feeds the cash flow
}

// =============================================================
// Variations (change orders)
// =============================================================
const variationStatus = (key) => VARIATION_STATUSES[key] ?? key;

async function loadVariations(projectId) {
  const { data, error } = await db
    .from('variations')
    .select('id, ref, title, description, description_en, contractor_id, instructed_on, status, amount, days_claimed, decided_on')
    .eq('project_id', projectId)
    .order('instructed_on', { ascending: false });
  if (projectId !== state.projectId) return;
  if (error) {
    $('#variations-table').innerHTML = `<div class="empty-state">Could not load variations: ${esc(error.message)}</div>`;
    return;
  }
  state.variations = data;
  renderVariations();
}

function renderVariations() {
  const variations = state.variations;
  const approved = variations.filter((v) => v.status === 'approved');
  const open = variations.filter((v) => v.status === 'instructed' || v.status === 'priced');
  const approvedValue = sumOf(approved, 'amount');
  const openValue = sumOf(open, 'amount');
  const approvedDays = approved.reduce((sum, v) => sum + Number(v.days_claimed || 0), 0);
  // The contract sum as it stands: the priced work plus what has been approved
  // on top of it. Anything unapproved is money still being argued about.
  const contract = state.tasks.reduce((sum, t) => sum + Number(t.budget || 0), 0);

  $('#variations-summary').innerHTML = [
    statTile('Approved', money.format(approvedValue),
      `${approved.length} variation${approved.length === 1 ? '' : 's'}`),
    statTile('Awaiting a decision', money.format(openValue),
      open.length ? `${open.length} not yet settled` : 'none outstanding', open.length ? 'negative' : ''),
    statTile('Revised contract sum', money.format(contract + approvedValue),
      contract ? `${money.format(contract)} + variations` : 'no budgets set'),
    statTile('Extra days approved', String(approvedDays),
      approvedDays ? 'added to the programme' : 'none granted'),
  ].join('');

  if (!variations.length) {
    $('#variations-table').innerHTML = '<div class="empty-state">No variations yet - record work instructed after the contract was signed.</div>';
    return;
  }

  const statusChip = (v) => {
    const tone = { approved: 'bg-emerald-500/20 text-emerald-300', rejected: 'bg-slate-500/20 text-slate-300' }[v.status]
      ?? 'bg-amber-500/20 text-amber-300';
    return `<span class="rounded-full ${tone} px-2 py-0.5 text-[11px] font-semibold">${esc(variationStatus(v.status))}</span>`;
  };

  $('#variations-table').innerHTML = `
    <table class="data-table">
      <thead>
        <tr>
          <th>Ref</th><th>Instructed</th><th>What was instructed</th><th>Contractor</th>
          <th class="num">Value</th><th class="num">Days</th><th>Status</th><th></th>
        </tr>
      </thead>
      <tbody>
        ${variations.map((v) => `
          <tr>
            <td class="whitespace-nowrap">${v.ref ? esc(v.ref) : '<span class="text-slate-500">-</span>'}</td>
            <td class="whitespace-nowrap">${esc(formatDate(v.instructed_on))}</td>
            <td class="max-w-md">
              <p>${esc(v.title)}</p>
              ${v.description_en || v.description
    ? `<p class="text-slate-500">${esc(v.description_en || v.description)}</p>` : ''}
            </td>
            <td>${v.contractor_id ? esc(contractorName(v.contractor_id)) : '<span class="text-slate-500">-</span>'}</td>
            <td class="num">${Number(v.amount) ? money2.format(v.amount) : '<span class="text-slate-500">-</span>'}</td>
            <td class="num">${Number(v.days_claimed) || '<span class="text-slate-500">-</span>'}</td>
            <td class="whitespace-nowrap">${statusChip(v)}</td>
            <td class="text-right whitespace-nowrap">
              <button type="button" class="table-action" data-variation-edit="${esc(v.id)}">Edit</button>
              <button type="button" class="table-action is-danger" data-variation-delete="${esc(v.id)}">Delete</button>
            </td>
          </tr>`).join('')}
      </tbody>
    </table>`;
}

function openVariationModal(variation = null) {
  if (!requireProject()) return;
  const form = $('#form-variation');
  const f = form.elements;
  form.reset();
  $('#variation-title').textContent = variation ? 'Edit Variation' : 'Add Variation';
  $('#variation-status').innerHTML = Object.entries(VARIATION_STATUSES)
    .map(([key, label]) => `<option value="${key}">${esc(label)}</option>`).join('');
  $('#variation-contractor').innerHTML = contractorOptions(variation?.contractor_id ?? '');
  f.id.value = variation?.id ?? '';
  f.ref.value = variation?.ref ?? '';
  f.instructed_on.value = variation?.instructed_on ?? todayISO();
  f.status.value = variation?.status ?? 'instructed';
  f.title.value = variation?.title ?? '';
  f.amount.value = Number(variation?.amount) || '';
  f.days_claimed.value = Number(variation?.days_claimed) || '';
  f.decided_on.value = variation?.decided_on ?? '';
  f.description.value = variation?.description ?? '';
  f.description_en.value = variation?.description_en ?? '';
  syncVariationStatus();
  showFormError(form, '');
  openModal('modal-variation');
}

// A decision date only means something once there has been a decision.
function syncVariationStatus() {
  const status = $('#variation-status').value;
  const decided = status === 'approved' || status === 'rejected';
  $('#variation-decided-field').classList.toggle('hidden', !decided);
  if (decided && !$('#form-variation').elements.decided_on.value) {
    $('#form-variation').elements.decided_on.value = todayISO();
  }
}

async function saveVariation(e) {
  e.preventDefault();
  const form = e.currentTarget;
  const btn = $('[type=submit]', form);
  const fd = new FormData(form);
  const id = fd.get('id');
  const status = fd.get('status');
  const decided = status === 'approved' || status === 'rejected';

  const row = {
    ref:            fd.get('ref').trim() || null,
    title:          fd.get('title').trim(),
    description:    fd.get('description').trim() || null,
    description_en: fd.get('description_en').trim() || null,
    contractor_id:  fd.get('contractor_id') || null,
    instructed_on:  fd.get('instructed_on'),
    status,
    amount:         Number(fd.get('amount') || 0),
    days_claimed:   parseInt(fd.get('days_claimed'), 10) || 0,
    decided_on:     decided ? (fd.get('decided_on') || todayISO()) : null,
  };
  if (row.decided_on && row.decided_on < row.instructed_on) {
    showFormError(form, 'A variation cannot be decided before it was instructed.');
    return;
  }

  showFormError(form, '');
  setBusy(btn, true);

  // One language filled in: let Gemini write the other before saving.
  if (needsTranslation(form)) {
    const err = await translateBilingual(form, [row.ref, row.title].filter(Boolean).join(' - '));
    if (err) toast(`Saved without translation - ${err}`, 'error');
    row.description = form.elements.description.value.trim() || null;
    row.description_en = form.elements.description_en.value.trim() || null;
  }

  const { error } = id
    ? await db.from('variations').update(row).eq('id', id)
    : await db.from('variations').insert({ ...row, project_id: state.projectId });
  setBusy(btn, false);

  if (error) {
    showFormError(form, error.message);
    return;
  }
  closeModal('modal-variation');
  toast(id ? 'Variation updated.' : 'Variation recorded.', 'success');
  loadVariations(state.projectId);
}

async function onVariationsClick(e) {
  const edit = e.target.closest('[data-variation-edit]');
  if (edit) return openVariationModal(state.variations.find((v) => v.id === edit.dataset.variationEdit));

  const del = e.target.closest('[data-variation-delete]');
  if (!del) return;
  const variation = state.variations.find((v) => v.id === del.dataset.variationDelete);
  if (!variation || !confirm(`Delete ${variation.ref ? `${variation.ref} - ` : ''}"${variation.title}"?`)) return;
  const { error } = await db.from('variations').delete().eq('id', variation.id);
  if (error) {
    toast(`Could not delete: ${error.message}`, 'error');
    return;
  }
  toast('Variation deleted.', 'success');
  loadVariations(state.projectId);
}

// =============================================================
// Safety and quality events
// =============================================================
const eventKind = (key) => SITE_EVENT_KINDS[key] ?? key;
const severityLabel = (key) => INCIDENT_SEVERITIES[key] ?? key;
const seriousEvent = (e) => e.severity === 'lost_time' || e.severity === 'reportable';

async function loadEvents(projectId) {
  const { data, error } = await db
    .from('site_events')
    .select('id, event_date, kind, severity, title, description, description_en, contractor_id, action, closed')
    .eq('project_id', projectId)
    .order('event_date', { ascending: false });
  if (projectId !== state.projectId) return;
  if (error) {
    $('#events-table').innerHTML = `<div class="empty-state">Could not load events: ${esc(error.message)}</div>`;
    return;
  }
  state.events = data;
  renderEvents();
}

function renderEvents() {
  const events = state.events;
  const incidents = events.filter((e) => e.kind === 'incident');
  const open = events.filter((e) => !e.closed);
  const serious = incidents.filter(seriousEvent).length;
  // The figure everyone on a site knows: counted from the last incident, or
  // from the first thing recorded if there has never been one.
  const lastIncident = incidents[0]?.event_date;
  const since = lastIncident ?? events.at(-1)?.event_date;
  const daysSince = since ? Math.round((new Date(`${todayISO()}T00:00`) - new Date(`${since}T00:00`)) / 86_400_000) : null;

  $('#events-summary').innerHTML = [
    statTile('Days without an incident', daysSince == null ? '-' : String(daysSince),
      lastIncident ? `last one ${formatDate(lastIncident)}` : 'no incident recorded'),
    statTile('Incidents', String(incidents.length),
      serious ? `${serious} serious` : 'none serious', incidents.length ? 'negative' : ''),
    statTile('Open actions', String(open.length),
      open.length ? 'not closed out' : 'all closed', open.length ? 'negative' : ''),
  ].join('');

  if (!events.length) {
    $('#events-table').innerHTML = '<div class="empty-state">Nothing recorded yet - log incidents, inspections and toolbox talks here.</div>';
    return;
  }

  $('#events-table').innerHTML = `
    <table class="data-table">
      <thead>
        <tr>
          <th>Date</th><th>Type</th><th>What happened</th><th>Contractor</th>
          <th>Action taken</th><th>Status</th><th></th>
        </tr>
      </thead>
      <tbody>
        ${events.map((e) => `
          <tr>
            <td class="whitespace-nowrap">${esc(formatDate(e.event_date))}</td>
            <td class="whitespace-nowrap">${esc(eventKind(e.kind))}${e.severity
              ? `<span class="ml-1 rounded-full bg-rose-500/20 px-1.5 py-0.5 text-[10px] font-semibold text-rose-300">${esc(severityLabel(e.severity))}</span>`
              : ''}</td>
            <td class="max-w-md">
              <p>${esc(e.title)}</p>
              ${e.description_en || e.description
                ? `<p class="text-slate-500">${esc(e.description_en || e.description)}</p>` : ''}
            </td>
            <td>${e.contractor_id ? esc(contractorName(e.contractor_id)) : '<span class="text-slate-500">-</span>'}</td>
            <td class="max-w-xs">${e.action ? esc(e.action) : '<span class="text-slate-500">-</span>'}</td>
            <td>${e.closed
              ? '<span class="chip-ok">Closed</span>'
              : '<span class="chip-open">Open</span>'}</td>
            <td class="text-right whitespace-nowrap">
              <button type="button" class="table-action" data-event-edit="${esc(e.id)}">Edit</button>
              <button type="button" class="table-action is-danger" data-event-delete="${esc(e.id)}">Delete</button>
            </td>
          </tr>`).join('')}
      </tbody>
    </table>`;
}

function openEventModal(event = null) {
  if (!requireProject()) return;
  const form = $('#form-event');
  const f = form.elements;
  form.reset();
  $('#event-title').textContent = event ? 'Edit Event' : 'Record Event';
  $('#event-kind').innerHTML = Object.entries(SITE_EVENT_KINDS)
    .map(([key, label]) => `<option value="${key}">${esc(label)}</option>`).join('');
  $('#event-severity').innerHTML = '<option value="">- Not stated -</option>'
    + Object.entries(INCIDENT_SEVERITIES).map(([key, label]) => `<option value="${key}">${esc(label)}</option>`).join('');
  $('#event-contractor').innerHTML = contractorOptions(event?.contractor_id ?? '');
  f.id.value = event?.id ?? '';
  f.event_date.value = event?.event_date ?? todayISO();
  f.event_date.max = todayISO();
  f.kind.value = event?.kind ?? 'incident';
  f.severity.value = event?.severity ?? '';
  f.title.value = event?.title ?? '';
  f.description.value = event?.description ?? '';
  f.description_en.value = event?.description_en ?? '';
  f.action.value = event?.action ?? '';
  f.closed.checked = Boolean(event?.closed);
  syncEventKind();
  showFormError(form, '');
  openModal('modal-event');
}

// Severity is an incident's word; a toolbox talk has none.
function syncEventKind() {
  const isIncident = $('#event-kind').value === 'incident';
  $('#event-severity-field').classList.toggle('hidden', !isIncident);
  if (!isIncident) $('#event-severity').value = '';
}

async function saveEvent(e) {
  e.preventDefault();
  const form = e.currentTarget;
  const btn = $('[type=submit]', form);
  const fd = new FormData(form);
  const id = fd.get('id');

  const row = {
    event_date:     fd.get('event_date'),
    kind:           fd.get('kind'),
    severity:       fd.get('kind') === 'incident' ? (fd.get('severity') || null) : null,
    title:          fd.get('title').trim(),
    description:    fd.get('description').trim() || null,
    description_en: fd.get('description_en').trim() || null,
    contractor_id:  fd.get('contractor_id') || null,
    action:         fd.get('action').trim() || null,
    closed:         fd.get('closed') === 'on',
  };

  showFormError(form, '');
  setBusy(btn, true);

  // One language filled in: let Gemini write the other before saving.
  if (needsTranslation(form)) {
    const err = await translateBilingual(form, [eventKind(row.kind), row.title].filter(Boolean).join(': '));
    if (err) toast(`Saved without translation - ${err}`, 'error');
    row.description = form.elements.description.value.trim() || null;
    row.description_en = form.elements.description_en.value.trim() || null;
  }

  const { error } = id
    ? await db.from('site_events').update(row).eq('id', id)
    : await db.from('site_events').insert({ ...row, project_id: state.projectId });
  setBusy(btn, false);

  if (error) {
    showFormError(form, error.message);
    return;
  }
  closeModal('modal-event');
  toast(id ? 'Event updated.' : 'Event recorded.', 'success');
  loadEvents(state.projectId);
}

async function onEventsClick(e) {
  const edit = e.target.closest('[data-event-edit]');
  if (edit) return openEventModal(state.events.find((x) => x.id === edit.dataset.eventEdit));

  const del = e.target.closest('[data-event-delete]');
  if (!del) return;
  const event = state.events.find((x) => x.id === del.dataset.eventDelete);
  if (!event || !confirm(`Delete the ${eventKind(event.kind).toLowerCase()} of ${formatDate(event.event_date)}?`)) return;
  const { error } = await db.from('site_events').delete().eq('id', event.id);
  if (error) {
    toast(`Could not delete: ${error.message}`, 'error');
    return;
  }
  toast('Event deleted.', 'success');
  loadEvents(state.projectId);
}

// ---------- Baseline ----------
/**
 * Freezes today's planned dates as the approved programme. Everything after
 * this is measured against it, so re-setting it throws away the drift recorded
 * so far - which is why it asks twice the second time.
 */
async function setBaseline() {
  if (!requireProject()) return;
  const project = currentProject();
  const dated = state.tasks.filter((t) => t.planned_start && t.planned_finish);
  if (!dated.length) {
    toast('Add activities with dates first - a baseline is a copy of the planned dates.', 'error');
    return;
  }
  const already = project.baseline_set_on;
  const question = already
    ? `This project was baselined on ${formatDate(already)}.

`
      + `Setting it again replaces the approved programme with today's dates, and the drift recorded since then is lost. Continue?`
    : `Freeze today's planned dates for ${dated.length} activities as the approved programme?

`
      + 'From now on the report shows how far the dates have moved since this point.';
  if (!confirm(question)) return;

  const btn = $('#btn-baseline');
  setBusy(btn, true, 'Saving…');
  // An upsert is an insert that falls back to an update, and Postgres checks
  // the not-null columns before it finds the conflict - so every one of them
  // has to travel with the row, unchanged, even though the row already exists.
  const rows = dated.map((t) => ({
    id: t.id,
    project_id: project.id,
    name: t.name,
    planned_start: t.planned_start,
    planned_finish: t.planned_finish,
    baseline_start: t.planned_start,
    baseline_finish: t.planned_finish,
  }));
  const { error } = await db.from('schedule_tasks').upsert(rows, { onConflict: 'id' });
  const { error: projectError } = error
    ? {}
    : await db.from('projects').update({ baseline_set_on: todayISO() }).eq('id', project.id);
  setBusy(btn, false);

  if (error || projectError) {
    toast(`Could not set the baseline: ${(error ?? projectError).message}`, 'error');
    return;
  }
  project.baseline_set_on = todayISO();
  toast(`Baseline set for ${dated.length} activities.`, 'success');
  loadSchedule(state.projectId);
}

// ---------- Delay ----------
function openDelayModal(delay = null) {
  if (!requireProject()) return;
  const form = $('#form-delay');
  const f = form.elements;
  form.reset();
  $('#delay-title').textContent = delay ? 'Edit Delay' : 'Log Delay';
  f.id.value = delay?.id ?? '';
  f.delay_date.value = delay ? delayDate(delay) : todayISO();
  f.delay_date.max = todayISO();
  $('#delay-flat').innerHTML = '<option value="">Site-wide (no specific room)</option>'
    + state.flats.map((f) => `
      <option value="${esc(f.id)}">${esc(roomLabel(f))} (${esc(floorLabel(f.floor))})</option>
    `).join('');
  $('#delay-flat-field').classList.toggle('hidden', !hasRooms(currentProject()));
  $('#delay-contractor').innerHTML = contractorOptions(causeOf(delay ?? {}) ?? '');
  renderImpactPicker(delay);
  if (delay) {
    f.flat_id.value = delay.flat_id ?? '';
    f.delay_cause.value = delay.delay_cause;
    f.resolved_on.value = delay.resolved_on ?? '';
    // An ongoing delay opens with the days it has run so far, ready to be corrected
    // and saved as finished.
    f.duration_days.value = delayDaysLost(delay);
    f.description.value = delay.description ?? '';
    f.description_en.value = delay.description_en ?? '';
  }
  f.delay_status.value = delay && delayIsOngoing(delay) ? 'ongoing' : 'finished';
  syncDelayStatus();
  resetPicker('delay', delay ? { delayId: delay.id } : null);
  showFormError(form, '');
  openModal('modal-delay');
}

/**
 * One row per timetable item, ticked for the ones this delay held up. Items
 * already recorded open ticked, with the days they were given.
 */
function renderImpactPicker(delay) {
  const el = $('#delay-impacts');
  const already = new Map((delay?.impacts ?? []).map((i) => [i.task_id, i.days_lost]));
  if (!state.tasks.length) {
    el.innerHTML = '<div class="empty-state">No timetable items yet - add them on the Timetable first.</div>';
    return;
  }
  el.innerHTML = state.tasks.map((t) => {
    const hit  = already.has(t.id);
    const who  = t.contractor_id ? contractorName(t.contractor_id) : 'No contractor';
    const days = already.get(t.id) ?? '';
    return `
      <label class="impact-row">
        <input type="checkbox" data-impact-task="${esc(t.id)}"${hit ? ' checked' : ''}>
        <span class="impact-row-name">${esc(t.name)}
          <span class="impact-row-who">${esc(who)} · ${esc(formatDate(t.planned_start))} → ${esc(formatDate(t.planned_finish))}</span>
        </span>
        <input type="number" min="1" step="1" class="input-dark impact-row-days" aria-label="Days lost"
               value="${esc(String(days))}"${hit ? '' : ' disabled'}>
      </label>`;
  }).join('');
}

/**
 * Ticking an item asks for its days, and starts from the delay's own duration -
 * usually the same number, and one click when it is.
 */
function onImpactToggle(e) {
  const box = e.target.closest('[data-impact-task]');
  if (!box) return;
  const days = $('.impact-row-days', box.closest('.impact-row'));
  days.disabled = !box.checked;
  if (!box.checked) return;
  if (!days.value) days.value = $('#delay-status').value === 'ongoing' ? 1 : ($('#form-delay').elements.duration_days.value || 1);
  days.focus();
}

/** What the picker has: one entry per ticked item. */
const impactsFromPicker = () =>
  $$('#delay-impacts [data-impact-task]').filter((b) => b.checked).map((b) => ({
    task_id: b.dataset.impactTask,
    days_lost: Math.max(1, Number($('.impact-row-days', b.closest('.impact-row')).value) || 1),
  }));

// Ongoing delays have no end date and no days lost yet - those fields only
// make sense once the delay is settled.
function syncDelayStatus() {
  const ongoing = $('#delay-status').value === 'ongoing';
  $('#delay-finished-fields').classList.toggle('hidden', ongoing);
  $('#delay-ongoing-note').classList.toggle('hidden', !ongoing);
}

// Fills the delay description in both languages via Gemini. Returns an error message, or '' on success.
/**
 * Fills a form's Georgian and English description from whichever one is
 * written: Gemini corrects the Georgian and writes the other. `context` is a
 * line of background (the cause, the incident, what was instructed) so the
 * wording suits the record. Returns an error message, or '' on success.
 */
async function translateBilingual(form, context = '') {
  const f = form.elements;
  const { data, error } = await db.functions.invoke('translate-delay', {
    body: { ka: f.description.value, en: f.description_en.value, cause: context || null },
  });
  if (error) return functionErrorMessage(error);
  f.description.value = data.ka;
  f.description_en.value = data.en;
  return '';
}

/** One language written and not the other: let Gemini fill the gap on save. */
const needsTranslation = (form) => {
  const f = form.elements;
  return !f.description.value.trim() !== !f.description_en.value.trim();
};

/** The Translate button on the delay, event and variation forms. */
async function onTranslate(formId, buttonId, context) {
  const form = $(formId);
  const f = form.elements;
  if (!f.description.value.trim() && !f.description_en.value.trim()) {
    showFormError(form, 'Write the description in Georgian or English first.');
    f.description.focus();
    return;
  }
  const btn = $(buttonId);
  showFormError(form, '');
  setBusy(btn, true, 'Translating…');
  const err = await translateBilingual(form, context(form.elements));
  setBusy(btn, false);
  if (err) showFormError(form, `Gemini couldn't translate: ${err}`);
}

/**
 * Replaces the delay's list of held-up items with what the form has. Unticking
 * an item has to remove its row, so the whole list is rewritten rather than
 * added to. Returns an error message, or '' if it went through.
 */
async function saveDelayImpacts(delayId, impacts) {
  const { error: wiped } = await db.from('delay_impacts').delete().eq('delay_id', delayId);
  if (wiped) return wiped.message;
  if (!impacts.length) return '';
  const { error } = await db.from('delay_impacts')
    .insert(impacts.map((i) => ({ ...i, delay_id: delayId })));
  return error ? error.message : '';
}

async function saveDelay(e) {
  e.preventDefault();
  const form = e.currentTarget;
  const btn  = $('[type=submit]', form);
  const fd   = new FormData(form);

  const ongoing = fd.get('delay_status') === 'ongoing';
  const days = Number(fd.get('duration_days'));
  if (!ongoing && (!Number.isInteger(days) || days < 1)) {
    showFormError(form, 'Enter the days lost as a whole number - 1 or more, or mark the delay ongoing.');
    return;
  }
  const endedOn = ongoing ? null : (fd.get('resolved_on') || null);
  if (endedOn && endedOn < fd.get('delay_date')) {
    showFormError(form, 'The delay cannot end before it started.');
    return;
  }

  showFormError(form, '');
  setBusy(btn, true);

  // One language filled in: let Gemini write the other before saving.
  const f = form.elements;
  if (needsTranslation(form)) {
    const err = await translateBilingual(form, f.delay_cause.value);
    if (err) toast(`Saved without translation - ${err}`, 'error');
  }

  const id = fd.get('id');
  const row = {
    flat_id:             fd.get('flat_id') || null,
    cause_contractor_id: fd.get('cause_contractor_id') || null,
    delay_cause:    fd.get('delay_cause'),
    // null days = still running; the days lost are counted up to today instead.
    duration_days:  ongoing ? null : days,
    resolved_on:    endedOn,
    description:    f.description.value.trim() || null,
    description_en: f.description_en.value.trim() || null,
    // Stored as a timestamp; midday keeps the chosen calendar day in any time zone offset.
    created_at:     new Date(`${fd.get('delay_date')}T12:00`).toISOString(),
  };

  const { data: saved, error } = id
    ? await db.from('delays').update(row).eq('id', id).select('id').single()
    : await db.from('delays').insert({ ...row, project_id: state.projectId }).select('id').single();

  if (error) {
    setBusy(btn, false);
    showFormError(form, error.message);
    return;
  }

  const impactError = await saveDelayImpacts(saved.id, impactsFromPicker());
  const photoError = await commitPhotos('delay', { delayId: saved.id });
  setBusy(btn, false);
  if (impactError) toast(`The delay was saved, but the work it held up was not: ${impactError}`, 'error');
  if (photoError) toast(`The delay was saved, but the photos were not: ${photoError}`, 'error');

  closeModal('modal-delay');
  toast(id ? 'Delay updated.' : 'Delay recorded.', 'success');
  refreshDashboard(state.projectId);
  loadSchedule(state.projectId); // contractor delay days
}

// =============================================================
// PDF export
// =============================================================
// ---------- Full project report (viewer + PDF) ----------

/** The report page for the open project, built from what is already loaded. */
function projectReportArgs(project) {
  return {
    db,
    project,
    tasks: state.tasks,
    payments: state.payments,
    contractors: state.contractors,
    contractorDelays: state.contractorDelays,
    delayImpacts: state.delayImpacts,
    units: state.flats,
    siteLogs: state.siteLogs,
    siteCosts: state.siteCosts,
    rentals: state.rentals,
    progress: state.progress ?? scheduleProgress([], todayISO()),
    money,
  };
}

/**
 * Builds the project report and saves it, without opening the preview - the
 * same one-click path the daily report has.
 */
async function exportProjectReport(e) {
  if (exporting || !requireProject()) return;
  const btn = e.currentTarget;
  const printable = btn.id === 'btn-report-project-print';
  const label = btn.querySelector('span') ?? btn;
  const original = label.textContent;

  exporting = true;
  btn.disabled = true;
  label.textContent = 'Building…';
  toast('Building the project report…');

  try {
    const project = currentProject();
    const page = await buildProjectReport(projectReportArgs(project));
    await downloadProjectReport(page, project, { printable });
  } catch (err) {
    toast(err.message || 'Could not build the report.', 'error');
  } finally {
    exporting = false;
    btn.disabled = !state.projectId;
    label.textContent = original;
  }
}

let exporting = false;

async function exportDailyReport(e) {
  if (exporting || !requireProject()) return;
  const btn = e.currentTarget;
  const printable = btn.id === 'btn-report-daily-print';
  const label = btn.querySelector('span') ?? btn;
  const original = label.textContent;
  const project = state.projects.find((p) => p.id === state.projectId);

  exporting = true;
  btn.disabled = true;
  label.textContent = 'Generating…';
  toast('Building today\'s report…');

  try {
    await generateDailyReport({ db, project, progress: state.progress, printable });
    toast('Daily report downloaded.', 'success');
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

$('#btn-new-delay').addEventListener('click', () => openDelayModal());
$('#form-daily-log').addEventListener('submit', saveDailyLog);
$('#form-delay').addEventListener('submit', saveDelay);
$('#btn-translate-delay').addEventListener('click', () => onTranslate('#form-delay', '#btn-translate-delay',
  (f) => f.delay_cause.value));
$('#btn-translate-event').addEventListener('click', () => onTranslate('#form-event', '#btn-translate-event',
  (f) => [eventKind(f.kind.value), f.title.value].filter(Boolean).join(': ')));
$('#btn-translate-variation').addEventListener('click', () => onTranslate('#form-variation', '#btn-translate-variation',
  (f) => [f.ref.value, f.title.value].filter(Boolean).join(' - ')));
$('#delay-status').addEventListener('change', syncDelayStatus);
$('#delay-impacts').addEventListener('change', onImpactToggle);
$('#delays-table').addEventListener('click', onDelaysTableClick);
$('#btn-add-rental').addEventListener('click', () => openRentalModal());
$('#form-rental').addEventListener('submit', saveRental);
$('#form-rental').addEventListener('input', onRentalInput);
$('#rentals-table').addEventListener('click', onRentalsTableClick);
$('#equipment-options').innerHTML = EQUIPMENT_SUGGESTIONS.map((x) => `<option value="${esc(x)}"></option>`).join('');
$('#equipment-options-ka').innerHTML = EQUIPMENT_SUGGESTIONS.map((x) => `<option value="${esc(ka(x))}"></option>`).join('');
$('#units-table').addEventListener('click', onUnitsTableClick);
$('#btn-add-unit').addEventListener('click', () => openUnitModal(null));
$('#form-unit').addEventListener('submit', saveUnit);
$('#btn-add-task').addEventListener('click', () => openTaskModal(null));
$('#btn-baseline').addEventListener('click', setBaseline);
$('#btn-new-variation').addEventListener('click', () => openVariationModal(null));
$('#form-variation').addEventListener('submit', saveVariation);
$('#variation-status').addEventListener('change', syncVariationStatus);
$('#variations-table').addEventListener('click', onVariationsClick);
$('#btn-new-event').addEventListener('click', () => openEventModal(null));
$('#form-event').addEventListener('submit', saveEvent);
$('#event-kind').addEventListener('change', syncEventKind);
$('#events-table').addEventListener('click', onEventsClick);
$('#form-task').addEventListener('submit', saveTask);
$('#form-task').addEventListener('input', onTaskInput);
$('#schedule-table').addEventListener('change', onScheduleChange);
$('#schedule-table').addEventListener('click', onTaskTableClick);
$('#boq-table').addEventListener('click', onTaskTableClick);
$('#form-payment').addEventListener('submit', savePayment);
$('#form-payment').addEventListener('input', updatePaymentNet);
$('#payments-list').addEventListener('click', onPaymentsClick);
$('#btn-add-contractor').addEventListener('click', () => openContractorModal(null));
$('#form-contractor').addEventListener('submit', saveContractor);
$('#contractors-table').addEventListener('click', onContractorsClick);
$('#projects-container').addEventListener('click', onProjectsClick);
$('#btn-new-project').addEventListener('click', openProjectModal);
$('#form-project').addEventListener('submit', saveProject);
$('#btn-parse-log').addEventListener('click', processLogText);
$('#btn-new-log-page').addEventListener('click', () => openDailyLogModal());
$('#log-from').addEventListener('change', onLogFilterChange);
$('#log-to').addEventListener('change', onLogFilterChange);
$('#log-search').addEventListener('input', onLogFilterChange);
$('#btn-log-clear').addEventListener('click', clearLogFilter);
$('#daily-logs-container').addEventListener('click', onLogsClick);
$$('[data-picker]').forEach((root) => {
  root.addEventListener('click', onPickerClick);
  $('[data-photo-input]', root).addEventListener('change', (e) => {
    addPhotoFiles(root.dataset.picker, e.target.files);
    e.target.value = ''; // picking the same file twice should still add it
  });
});
$('#modal-photo').addEventListener('click', (e) => {
  const step = e.target.closest('[data-photo-step]');
  if (step) showPhoto(Number(step.dataset.photoStep));
});
$('#form-ask').addEventListener('submit', askGemini);
$('#form-ask').addEventListener('click', onAskSuggestion);
$('#ask-answer').addEventListener('click', onAskLangToggle);
$('#btn-edit-project').addEventListener('click', openEditProjectModal);
$('#form-edit-project').addEventListener('submit', saveEditProject);
$('#form-delete-project').addEventListener('submit', confirmDeleteProject);
$('#btn-report-daily').addEventListener('click', exportDailyReport);
$('#btn-report-daily-print').addEventListener('click', exportDailyReport);
$('#btn-report-project').addEventListener('click', exportProjectReport);
$('#btn-report-project-print').addEventListener('click', exportProjectReport);

if (db) {
  $('#form-login').addEventListener('submit', signIn);
  $$('[data-sign-out]').forEach((el) => el.addEventListener('click', signOut));
  initAuth();
} else {
  showSetupNotice();
}
