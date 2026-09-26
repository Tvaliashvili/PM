// =============================================================
// CPMG PM — main app logic
// =============================================================
import {
  SUPABASE_URL, SUPABASE_KEY, CURRENCY_CODE,
  STAGES, STATUSES, STATUS_LABELS,
  MANPOWER_TRADES, WEATHER_OPTIONS, DELAY_CAUSES,
  BOQ_UNITS, BOQ_CATEGORIES, BOQ_STATUSES,
} from './config.js';
import { generateDailyReport } from './pdfReport.js';

// ---------- Supabase ----------
const isConfigured = !SUPABASE_URL.includes('YOUR-') && !SUPABASE_KEY.includes('YOUR-');
const db = isConfigured ? window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY) : null;

const state = {
  user: null,
  projects: [],
  projectsLoaded: false,
  projectId: null,
  flats: [],
  boq: [],
  workPct: 0,
};

// ---------- Helpers ----------
const $  = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

const money = new Intl.NumberFormat(undefined, {
  style: 'currency', currency: CURRENCY_CODE, maximumFractionDigits: 0,
});

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
  ['#btn-new-log', '#btn-new-delay', '#btn-export-pdf', '#btn-report-daily', '#btn-add-flats', '#btn-add-boq', '#btn-edit-project'].forEach((sel) => { $(sel).disabled = !enabled; });
}

// =============================================================
// Navigation + mobile sidebar
// =============================================================
function setSidebar(open) {
  $('#sidebar').classList.toggle('-translate-x-full', !open);
  $('#sidebar-overlay').classList.toggle('hidden', !open);
}

// Two views: the full-page project list (#projects, default) and the project workspace,
// whose sections (#dashboard, #flat-matrix, …) all need a selected project.
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
    .select('id, name, location, total_flats, created_at, start_date, end_date')
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
  state.boq = [];
  setProjectActionsEnabled(Boolean(state.projectId));

  const project = currentProject();
  applyProjectHeader(project);

  if (!project) {
    storage.set('cpm.projectId', '');
    return;
  }

  storage.set('cpm.projectId', project.id);
  await Promise.all([renderFlatMatrix(project.id), refreshDashboard(project.id), loadBoq(project.id)]);
}

const currentProject = () => state.projects.find((p) => p.id === state.projectId);

// Project name/location wherever it's shown in the workspace.
function applyProjectHeader(project) {
  const navLabel = $('#nav-project-name');
  navLabel.textContent = project?.name ?? '';
  navLabel.classList.toggle('hidden', !project);
  $('#topbar-project-name').textContent = project?.name ?? '';
  $('#topbar-project-location').textContent = project?.location ?? '';
  $('#dashboard-subtitle').textContent = project
    ? [project.name, project.location].filter(Boolean).join(' · ')
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
        <p>Click <span class="text-brand-400">New Project</span> above to create your first one — its flats are generated for you.</p>
      </div>`;
    return;
  }

  const request = ++projectListRequest;
  const [flats, delays] = await Promise.all([
    db.from('flats').select('project_id, stage_status'),
    db.from('delays').select('project_id'),
  ]);
  if (request !== projectListRequest) return; // a newer render started
  if (flats.error || delays.error) toast('Could not load project stats.', 'error');

  const stats = new Map(state.projects.map((p) => [p.id, { flats: 0, done: 0, complete: 0, delays: 0 }]));
  for (const flat of flats.data ?? []) {
    const s = stats.get(flat.project_id);
    if (!s) continue;
    const done = STAGES.filter((st) => statusOf(flat, st.key) === 'done').length;
    s.flats += 1;
    s.done += done;
    if (done === STAGES.length) s.complete += 1;
  }
  for (const delay of delays.data ?? []) {
    const s = stats.get(delay.project_id);
    if (s) s.delays += 1;
  }

  el.className = 'projects-grid';
  el.innerHTML = state.projects.map((p) => {
    const s = stats.get(p.id);
    const pct = s.flats ? Math.round((s.done / (s.flats * STAGES.length)) * 100) : 0;
    return `
      <article class="project-card${p.id === state.projectId ? ' is-active' : ''}">
        <button type="button" class="project-card-open" data-open-project="${esc(p.id)}">
          <p class="pr-8 font-semibold text-white truncate">${esc(p.name)}</p>
          <p class="text-sm text-slate-500 truncate">${esc(p.location || 'No location set')}</p>
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
            <div><dt>Flats</dt><dd>${s.flats}</dd></div>
            <div><dt>Complete</dt><dd>${s.complete}</dd></div>
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
  if (!confirm(`Delete "${project.name}"?\n\nThis permanently removes its flats, daily logs, delays and cash-flow items.`)) return;

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
    .insert({ name: fd.get('name').trim(), location: fd.get('location').trim() || null })
    .select('id')
    .single();
  setBusy(btn, false);

  if (error) {
    showFormError(form, error.message);
    return;
  }

  closeModal('modal-project');
  toast('Project created. Add its flats from the Flat Matrix.', 'success');

  // Open the new project straight on the Flat Matrix so flats can be added.
  storage.set('cpm.projectId', project.id);
  await loadProjects();
  goTo('flat-matrix');
}

// =============================================================
// Flat Matrix
// =============================================================
const statusOf = (flat, stageKey) => {
  const value = flat.stage_status?.[stageKey];
  return STATUSES.includes(value) ? value : 'pending';
};

async function renderFlatMatrix(projectId) {
  const container = $('#flat-matrix-container');
  container.className = 'panel empty-state';
  container.textContent = 'Loading flats…';

  const { data, error } = await db
    .from('flats')
    .select('id, block, floor, flat_number, stage_status')
    .eq('project_id', projectId)
    .order('block')
    .order('floor', { ascending: false })
    .order('flat_number');

  if (projectId !== state.projectId) return; // project switched mid-request
  if (error) {
    container.textContent = `Could not load flats: ${error.message}`;
    return;
  }

  state.flats = data;
  updateProgressKpi();

  if (!data.length) {
    container.textContent = 'No flats yet — click Add Flats to create your first block.';
    return;
  }

  // block -> floor -> flats (Map keeps the query's sort order)
  const blocks = new Map();
  for (const flat of data) {
    if (!blocks.has(flat.block)) blocks.set(flat.block, new Map());
    const floors = blocks.get(flat.block);
    if (!floors.has(flat.floor)) floors.set(flat.floor, []);
    floors.get(flat.floor).push(flat);
  }

  container.className = 'panel space-y-6';
  container.innerHTML = matrixLegend() + [...blocks].map(([block, floors]) => `
    <div class="matrix-block">
      <div class="matrix-block-header">
        <h3 class="matrix-block-title">Block ${esc(block)}</h3>
        <button type="button" class="matrix-block-delete" data-delete-block="${esc(block)}"
                title="Delete block ${esc(block)}">Delete block</button>
      </div>
      ${[...floors].map(([floor, flats]) => `
        <div class="matrix-floor">
          <div class="matrix-floor-label">${esc(floorLabel(floor))}</div>
          <div class="matrix-floor-flats">${flats.map(flatCard).join('')}</div>
        </div>
      `).join('')}
    </div>
  `).join('');
}

function matrixLegend() {
  const statuses = STATUSES.map((s) => `<span class="status-chip status-${s}">${STATUS_LABELS[s]}</span>`).join('');
  const stages = STAGES.map((s) => `<span><b class="text-slate-300">${s.short}</b> ${esc(s.label)}</span>`).join('');
  return `
    <div class="matrix-legend">
      <div class="flex flex-wrap items-center gap-2">
        ${statuses}
        <span class="text-xs text-slate-500 ml-1">Click a badge to advance its status.</span>
      </div>
      <div class="flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-500">${stages}</div>
    </div>`;
}

function flatCard(flat) {
  const done = STAGES.filter((st) => statusOf(flat, st.key) === 'done').length;
  const pct = Math.round((done / STAGES.length) * 100);
  const blocked = STAGES.some((st) => statusOf(flat, st.key) === 'blocked');

  const badges = STAGES.map((st) => {
    const status = statusOf(flat, st.key);
    return `
      <button type="button" class="status-chip status-${status}" data-stage="${st.key}"
              title="${esc(st.label)}: ${STATUS_LABELS[status]} — click to change"
              aria-label="${esc(st.label)}: ${STATUS_LABELS[status]}">${st.short}</button>`;
  }).join('');

  return `
    <div class="flat-card${blocked ? ' is-blocked' : ''}" data-flat-id="${esc(flat.id)}">
      <div class="flex items-center justify-between mb-2">
        <span class="font-semibold text-white text-sm">${esc(flat.flat_number)}</span>
        <span class="text-xs text-slate-400 tabular-nums">${pct}%</span>
      </div>
      <div class="h-1 rounded-full bg-ink-700 overflow-hidden mb-3">
        <div class="h-full bg-emerald-500" style="width:${pct}%"></div>
      </div>
      <div class="flex flex-wrap gap-1">${badges}</div>
    </div>`;
}

function redrawFlat(flat, focusStage) {
  const card = $(`[data-flat-id="${flat.id}"]`);
  if (!card) return;
  card.outerHTML = flatCard(flat);
  if (focusStage) $(`[data-flat-id="${flat.id}"] [data-stage="${focusStage}"]`)?.focus();
}

// ---------- Add / delete flats ----------
const clampInt = (value, min, max) => Math.min(max, Math.max(min, parseInt(value, 10) || 0));

// Flat numbers: floor + 2-digit position, e.g. 101, 102 … ground floor G01, G02.
function planFlats(form) {
  const block = form.elements.block.value.trim();
  const a = clampInt(form.elements.floor_from.value, 0, 80);
  const b = clampInt(form.elements.floor_to.value, 0, 80);
  const perFloor = clampInt(form.elements.flats_per_floor.value, 1, 30);
  const [from, to] = a <= b ? [a, b] : [b, a];

  const flats = [];
  if (!block) return { block, flats };
  for (let floor = from; floor <= to; floor++) {
    for (let i = 1; i <= perFloor; i++) {
      flats.push({
        block,
        floor,
        flat_number: `${floor === 0 ? 'G' : floor}${String(i).padStart(2, '0')}`,
        stage_status: {},
      });
    }
  }
  return { block, flats };
}

function updateFlatsPreview() {
  const { block, flats } = planFlats($('#form-flats'));
  $('#flats-preview').textContent = flats.length
    ? `Adds up to ${flats.length} flats to block ${block}: ${flats[0].flat_number} to ${flats[flats.length - 1].flat_number}.`
    : 'Enter a block name.';
}

function openFlatsModal() {
  if (!requireProject()) return;
  const form = $('#form-flats');
  form.reset();
  // Suggest the next block letter after the existing ones (A → B → C …).
  const blocks = new Set(state.flats.map((f) => f.block));
  const next = [...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'].find((l) => !blocks.has(l));
  if (next) form.elements.block.value = next;
  updateFlatsPreview();
  showFormError(form, '');
  openModal('modal-flats');
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

async function saveFlats(e) {
  e.preventDefault();
  const form = e.currentTarget;
  const btn  = $('[type=submit]', form);
  const projectId = state.projectId;
  const { block, flats } = planFlats(form);

  if (!flats.length) {
    showFormError(form, 'Enter a block name.');
    return;
  }

  showFormError(form, '');
  setBusy(btn, true, 'Adding…');
  // Existing flats (same block + number) are skipped, so a block can be extended.
  const { data, error } = await db
    .from('flats')
    .upsert(flats.map((f) => ({ ...f, project_id: projectId })), {
      onConflict: 'project_id,block,flat_number',
      ignoreDuplicates: true,
    })
    .select('id');
  setBusy(btn, false);

  if (error) {
    showFormError(form, error.message);
    return;
  }

  const added = data.length;
  const skipped = flats.length - added;
  closeModal('modal-flats');
  toast(`Added ${added} flats to block ${block}${skipped ? ` (${skipped} already existed)` : ''}.`, 'success');

  await syncFlatCount(projectId);
  if (projectId === state.projectId) renderFlatMatrix(projectId);
}

async function deleteBlock(block) {
  const projectId = state.projectId;
  const count = state.flats.filter((f) => f.block === block).length;
  if (!confirm(`Delete block ${block} and its ${count} flats?\n\nTheir stage progress is lost. Delays linked to these flats are kept as site-wide.`)) return;

  const { error } = await db.from('flats').delete().eq('project_id', projectId).eq('block', block);
  if (error) {
    toast(`Could not delete block: ${error.message}`, 'error');
    return;
  }

  toast(`Deleted block ${block}.`, 'success');
  await syncFlatCount(projectId);
  if (projectId === state.projectId) renderFlatMatrix(projectId);
}

async function onMatrixClick(e) {
  const blockBtn = e.target.closest('[data-delete-block]');
  if (blockBtn) {
    deleteBlock(blockBtn.dataset.deleteBlock);
    return;
  }

  const chip = e.target.closest('[data-stage]');
  if (!chip) return;

  const flat = state.flats.find((f) => f.id === chip.closest('[data-flat-id]').dataset.flatId);
  if (!flat) return;

  const key = chip.dataset.stage;
  const prev = flat.stage_status;
  const next = STATUSES[(STATUSES.indexOf(statusOf(flat, key)) + 1) % STATUSES.length];

  // Optimistic update, rolled back on failure.
  flat.stage_status = { ...prev, [key]: next };
  redrawFlat(flat, key);
  updateProgressKpi();

  const { error } = await db.from('flats').update({ stage_status: flat.stage_status }).eq('id', flat.id);
  if (error) {
    flat.stage_status = prev;
    redrawFlat(flat, key);
    updateProgressKpi();
    toast(`Could not update flat ${flat.flat_number}: ${error.message}`, 'error');
  }
}

// =============================================================
// Dashboard KPIs + recent activity
// =============================================================
function updateProgressKpi() {
  const flats = state.flats;
  const totalStages = flats.length * STAGES.length;
  const doneStages = flats.reduce(
    (sum, f) => sum + STAGES.filter((st) => statusOf(f, st.key) === 'done').length, 0,
  );
  const complete = flats.filter((f) => STAGES.every((st) => statusOf(f, st.key) === 'done')).length;
  const pct = totalStages ? Math.round((doneStages / totalStages) * 100) : 0;

  $('#kpi-progress').textContent = `${pct}%`;
  $('#kpi-progress-bar').style.width = `${pct}%`;
  $('#kpi-progress-meta').textContent = `${complete} of ${flats.length} flats complete`;

  state.workPct = pct;
  renderTimeline();
}

async function refreshDashboard(projectId) {
  const [delays, cash, logs] = await Promise.all([
    db.from('delays')
      .select('id, delay_cause, duration_hours, description, created_at, flats(block, flat_number)')
      .eq('project_id', projectId)
      .order('created_at', { ascending: false }),
    db.from('cash_flow')
      .select('planned_cost, actual_cost, status')
      .eq('project_id', projectId),
    db.from('daily_logs')
      .select('log_date, weather, manpower, notes')
      .eq('project_id', projectId)
      .order('log_date', { ascending: false })
      .limit(5),
  ]);

  if (projectId !== state.projectId) return;
  const failed = [delays, cash, logs].find((r) => r.error);
  if (failed) {
    toast(`Could not load dashboard: ${failed.error.message}`, 'error');
    return;
  }

  // Delays
  const hours = delays.data.reduce((sum, d) => sum + Number(d.duration_hours || 0), 0);
  $('#kpi-delays').textContent = delays.data.length;
  $('#kpi-delays-meta').textContent = `${hours.toLocaleString()} hours lost`;

  // Cash flow: net = planned − actual (positive = under budget), cancelled items excluded
  const live = cash.data.filter((c) => c.status !== 'cancelled');
  const planned = live.reduce((sum, c) => sum + Number(c.planned_cost || 0), 0);
  const actual  = live.reduce((sum, c) => sum + Number(c.actual_cost || 0), 0);
  const net = planned - actual;
  const netEl = $('#kpi-cashflow');
  netEl.textContent = money.format(net);
  netEl.classList.toggle('positive', net > 0);
  netEl.classList.toggle('negative', net < 0);
  $('#kpi-cashflow-meta').textContent = `Planned ${money.format(planned)} · Actual ${money.format(actual)}`;

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
    const where = d.flats ? `Block ${d.flats.block} · Flat ${d.flats.flat_number}` : 'Site-wide';
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

// Compares time elapsed against work complete (from the flat matrix).
function renderTimeline() {
  const el = $('#timeline-body');
  const project = currentProject();
  if (!project) return;

  const start = parseDate(project.start_date);
  const end = parseDate(project.end_date);
  if (!start || !end) {
    el.innerHTML = 'No start or completion date yet. Click <span class="text-slate-300">Edit project</span> '
      + 'to add them and track time against progress.';
    return;
  }

  const today = parseDate(todayISO());
  const total = Math.max(1, daysBetween(start, end));
  const elapsed = Math.min(total, Math.max(0, daysBetween(start, today)));
  const timePct = Math.round((elapsed / total) * 100);
  const workPct = state.workPct;
  const gap = workPct - timePct;

  let when;
  if (today < start) when = `Starts in ${daysBetween(today, start)} days`;
  else if (today > end) when = `${daysBetween(end, today)} days past planned completion`;
  else when = `Day ${elapsed} of ${total} · ${daysBetween(today, end)} days remaining`;

  let status;
  if (today < start) status = { cls: 'status-pending', text: '○ Not started' };
  else if (gap >= -5) status = { cls: 'status-done', text: '✓ On track' };
  else if (gap >= -15) status = { cls: 'status-in_progress', text: `! Behind by ${-gap} pts` };
  else status = { cls: 'status-blocked', text: `! Behind by ${-gap} pts` };

  el.innerHTML = `
    <div class="flex flex-wrap items-center justify-between gap-2 mb-4">
      <p class="text-slate-300">
        ${esc(formatDate(project.start_date))} → ${esc(formatDate(project.end_date))}
        <span class="text-slate-500">· ${total} days</span>
      </p>
      <span class="status-chip ${status.cls}">${esc(status.text)}</span>
    </div>
    <div class="space-y-3">
      ${timelineBar('Time elapsed', timePct, 'bg-slate-400')}
      ${timelineBar('Work complete', workPct, 'bg-emerald-500')}
    </div>
    <p class="mt-3 text-xs text-slate-500">${esc(when)}</p>`;
}

function openEditProjectModal() {
  const project = currentProject();
  if (!project) return;
  const form = $('#form-edit-project');
  const f = form.elements;
  f.name.value = project.name;
  f.location.value = project.location ?? '';
  f.start_date.value = project.start_date ?? '';
  f.end_date.value = project.end_date ?? '';
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
    start_date: fd.get('start_date') || null,
    end_date: fd.get('end_date') || null,
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
}

// =============================================================
// BOQ & cash flow
// cash_flow rows are BOQ items: planned = budget, actual = spent,
// due_date places the payment in the monthly cash-flow table.
// =============================================================
const money2 = new Intl.NumberFormat(undefined, {
  style: 'currency', currency: CURRENCY_CODE, minimumFractionDigits: 2, maximumFractionDigits: 2,
});
const qtyFormat = new Intl.NumberFormat(undefined, { maximumFractionDigits: 3 });
const BOQ_STATUS_CHIP = {
  planned: 'status-pending', committed: 'status-in_progress', paid: 'status-done', cancelled: 'status-pending',
};

const sumOf = (items, key) => items.reduce((sum, i) => sum + Number(i[key] || 0), 0);
const monthLabel = (ym) => new Date(`${ym}-01T00:00`).toLocaleDateString(undefined, { month: 'short', year: 'numeric' });

async function loadBoq(projectId) {
  const { data, error } = await db
    .from('cash_flow')
    .select('id, boq_item, category, unit, quantity, rate, planned_cost, actual_cost, status, due_date')
    .eq('project_id', projectId)
    .order('category', { nullsFirst: false })
    .order('boq_item');

  if (projectId !== state.projectId) return;
  if (error) {
    $('#boq-table').innerHTML = `<div class="empty-state">Could not load BOQ: ${esc(error.message)}</div>`;
    return;
  }
  state.boq = data;
  renderBoq();
}

function statTile(label, value, meta, tone = '') {
  return `
    <article class="kpi-card">
      <p class="kpi-label">${esc(label)}</p>
      <p class="kpi-value kpi-value-sm ${tone}">${esc(value)}</p>
      <p class="kpi-meta">${esc(meta)}</p>
    </article>`;
}

function varianceCell(item) {
  const planned = Number(item.planned_cost);
  const actual = Number(item.actual_cost);
  if (!actual) return '<span class="text-slate-500">—</span>';
  const diff = actual - planned;
  if (diff > 0) return `<span class="variance-over">+${money.format(diff)} over</span>`;
  if (diff < 0) return `<span class="variance-under">${money.format(-diff)} under</span>`;
  return '<span class="text-slate-400">On budget</span>';
}

function renderBoq() {
  const items = state.boq;
  const live = items.filter((i) => i.status !== 'cancelled');
  const planned = sumOf(live, 'planned_cost');
  const actual = sumOf(live, 'actual_cost');
  const remaining = planned - actual;
  const over = live.filter((i) => Number(i.actual_cost) > Number(i.planned_cost)).length;

  $('#cash-summary').innerHTML = [
    statTile('BOQ budget', money.format(planned), `${live.length} active items`),
    statTile('Spent to date', money.format(actual), planned ? `${Math.round((actual / planned) * 100)}% of budget` : '—'),
    statTile('Remaining budget', money.format(remaining), remaining < 0 ? 'Over budget' : 'Budget − spent', remaining < 0 ? 'negative' : ''),
    statTile('Items over budget', String(over), over ? 'Actual above planned' : 'None', over ? 'negative' : ''),
  ].join('');

  if (!items.length) {
    $('#boq-table').innerHTML = '<div class="empty-state">No BOQ items yet — click Add BOQ Item to build the budget.</div>';
    $('#cashflow-months').innerHTML = '<div class="empty-state">The monthly cash flow appears once BOQ items have due dates.</div>';
    return;
  }

  // ---- BOQ table ----
  const rows = items.map((i) => `
    <tr class="${i.status === 'cancelled' ? 'is-cancelled' : ''}">
      <td>
        <p class="text-white">${esc(i.boq_item)}</p>
        <p class="text-xs text-slate-500">${esc(i.category || 'Uncategorised')}</p>
      </td>
      <td class="num">${i.quantity != null ? qtyFormat.format(i.quantity) : '—'} <span class="text-slate-500">${esc(i.unit || '')}</span></td>
      <td class="num">${i.rate != null ? money2.format(i.rate) : '—'}</td>
      <td class="num">${money.format(i.planned_cost)}</td>
      <td class="num">${money.format(i.actual_cost)}</td>
      <td class="num">${varianceCell(i)}</td>
      <td><span class="status-chip ${BOQ_STATUS_CHIP[i.status] ?? 'status-pending'}">${esc(BOQ_STATUSES[i.status] ?? i.status)}</span></td>
      <td class="whitespace-nowrap">${i.due_date ? esc(formatDate(i.due_date)) : '<span class="text-slate-500">—</span>'}</td>
      <td class="text-right whitespace-nowrap">
        <button type="button" class="table-action" data-boq-edit="${esc(i.id)}">Edit</button>
        <button type="button" class="table-action is-danger" data-boq-delete="${esc(i.id)}">Delete</button>
      </td>
    </tr>`).join('');

  const totalDiff = actual - planned;
  $('#boq-table').innerHTML = `
    <table class="data-table">
      <thead>
        <tr>
          <th>Item</th><th class="num">Qty</th><th class="num">Rate</th><th class="num">Planned</th>
          <th class="num">Actual</th><th class="num">Variance</th><th>Status</th><th>Due</th><th></th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
      <tfoot>
        <tr>
          <td colspan="3">Total <span class="text-slate-500 font-normal">(excl. cancelled)</span></td>
          <td class="num">${money.format(planned)}</td>
          <td class="num">${money.format(actual)}</td>
          <td class="num">${actual ? varianceCell({ planned_cost: planned, actual_cost: actual }) : '—'}</td>
          <td colspan="3" class="text-slate-500 font-normal">${totalDiff > 0 ? 'Over budget' : ''}</td>
        </tr>
      </tfoot>
    </table>`;

  // ---- Monthly cash flow ----
  const byMonth = new Map();
  const unscheduled = { planned: 0, actual: 0 };
  for (const i of live) {
    const bucket = i.due_date
      ? (byMonth.get(i.due_date.slice(0, 7)) ?? byMonth.set(i.due_date.slice(0, 7), { planned: 0, actual: 0 }).get(i.due_date.slice(0, 7)))
      : unscheduled;
    bucket.planned += Number(i.planned_cost || 0);
    bucket.actual += Number(i.actual_cost || 0);
  }

  const months = [...byMonth.keys()].sort();
  if (!months.length) {
    $('#cashflow-months').innerHTML = '<div class="empty-state">Add due dates to BOQ items to see the monthly cash flow.</div>';
    return;
  }

  const thisMonth = todayISO().slice(0, 7);
  let cumPlanned = 0;
  let cumActual = 0;
  const monthRows = months.map((ym) => {
    const m = byMonth.get(ym);
    cumPlanned += m.planned;
    cumActual += m.actual;
    return `
      <tr class="${ym === thisMonth ? 'is-current' : ''}">
        <td>${esc(monthLabel(ym))}${ym === thisMonth ? ' <span class="text-xs text-brand-400">· this month</span>' : ''}</td>
        <td class="num">${money.format(m.planned)}</td>
        <td class="num">${money.format(m.actual)}</td>
        <td class="num">${money.format(cumPlanned)}</td>
        <td class="num">${money.format(cumActual)}</td>
      </tr>`;
  }).join('');

  const unscheduledRow = unscheduled.planned || unscheduled.actual ? `
    <tr class="is-muted">
      <td>No due date</td>
      <td class="num">${money.format(unscheduled.planned)}</td>
      <td class="num">${money.format(unscheduled.actual)}</td>
      <td></td><td></td>
    </tr>` : '';

  $('#cashflow-months').innerHTML = `
    <table class="data-table">
      <thead>
        <tr>
          <th>Month</th><th class="num">Planned</th><th class="num">Actual</th>
          <th class="num">Cumulative planned</th><th class="num">Cumulative actual</th>
        </tr>
      </thead>
      <tbody>${monthRows}${unscheduledRow}</tbody>
    </table>`;
}

function openBoqModal(item) {
  if (!requireProject()) return;
  const form = $('#form-boq');
  const f = form.elements;
  form.reset();
  showFormError(form, '');
  $('#boq-title').textContent = item ? 'Edit BOQ Item' : 'Add BOQ Item';

  f.id.value = item?.id ?? '';
  if (item) {
    f.boq_item.value = item.boq_item;
    f.category.value = item.category ?? '';
    f.due_date.value = item.due_date ?? '';
    f.quantity.value = item.quantity ?? '';
    f.unit.value = item.unit ?? '';
    f.rate.value = item.rate ?? '';
    f.planned_cost.value = item.planned_cost;
    f.actual_cost.value = item.actual_cost;
    f.status.value = item.status;
  }
  openModal('modal-boq');
}

// Planned cost follows quantity × rate while both are filled in.
function onBoqInput(e) {
  if (!['quantity', 'rate'].includes(e.target.name)) return;
  const f = e.currentTarget.elements;
  const qty = parseFloat(f.quantity.value);
  const rate = parseFloat(f.rate.value);
  if (qty >= 0 && rate >= 0) f.planned_cost.value = (Math.round(qty * rate * 100) / 100).toFixed(2);
}

async function saveBoq(e) {
  e.preventDefault();
  const form = e.currentTarget;
  const btn  = $('[type=submit]', form);
  const fd   = new FormData(form);
  const numOrNull = (v) => (v === '' || v == null ? null : Number(v));

  const id = fd.get('id');
  const row = {
    boq_item:     fd.get('boq_item').trim(),
    category:     fd.get('category').trim() || null,
    unit:         fd.get('unit') || null,
    quantity:     numOrNull(fd.get('quantity')),
    rate:         numOrNull(fd.get('rate')),
    planned_cost: Number(fd.get('planned_cost') || 0),
    actual_cost:  Number(fd.get('actual_cost') || 0),
    status:       fd.get('status'),
    due_date:     fd.get('due_date') || null,
  };

  showFormError(form, '');
  setBusy(btn, true);
  const { error } = id
    ? await db.from('cash_flow').update(row).eq('id', id)
    : await db.from('cash_flow').insert({ ...row, project_id: state.projectId });
  setBusy(btn, false);

  if (error) {
    showFormError(form, error.message);
    return;
  }

  closeModal('modal-boq');
  toast(id ? 'BOQ item updated.' : 'BOQ item added.', 'success');
  loadBoq(state.projectId);
  refreshDashboard(state.projectId);
}

async function onBoqTableClick(e) {
  const edit = e.target.closest('[data-boq-edit]');
  if (edit) {
    openBoqModal(state.boq.find((i) => i.id === edit.dataset.boqEdit));
    return;
  }

  const del = e.target.closest('[data-boq-delete]');
  if (!del) return;
  const item = state.boq.find((i) => i.id === del.dataset.boqDelete);
  if (!item || !confirm(`Delete BOQ item "${item.boq_item}"?`)) return;

  const { error } = await db.from('cash_flow').delete().eq('id', item.id);
  if (error) {
    toast(`Could not delete item: ${error.message}`, 'error');
    return;
  }
  toast('BOQ item deleted.', 'success');
  loadBoq(state.projectId);
  refreshDashboard(state.projectId);
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

  $('#boq-unit').innerHTML = '<option value="">—</option>'
    + BOQ_UNITS.map((u) => `<option value="${esc(u)}">${esc(u)}</option>`).join('');
  $('#boq-status').innerHTML = Object.entries(BOQ_STATUSES)
    .map(([value, label]) => `<option value="${value}">${esc(label)}</option>`).join('');
  $('#boq-categories').innerHTML = BOQ_CATEGORIES.map((c) => `<option value="${esc(c)}"></option>`).join('');
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
    notes:      fd.get('notes').trim() || null,
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
}

// ---------- Delay ----------
function openDelayModal() {
  if (!requireProject()) return;
  const form = $('#form-delay');
  form.reset();
  $('#delay-flat').innerHTML = '<option value="">Site-wide (no specific flat)</option>'
    + state.flats.map((f) => `
      <option value="${esc(f.id)}">Block ${esc(f.block)} · Flat ${esc(f.flat_number)} (${esc(floorLabel(f.floor))})</option>
    `).join('');
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
}

// =============================================================
// PDF export
// =============================================================
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
    const { aiNote } = await generateDailyReport({ db, project, userEmail: state.user?.email });
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
$('#flat-matrix-container').addEventListener('click', onMatrixClick);
$('#projects-container').addEventListener('click', onProjectsClick);
$('#btn-new-project').addEventListener('click', openProjectModal);
$('#form-project').addEventListener('submit', saveProject);
$('#btn-add-flats').addEventListener('click', openFlatsModal);
$('#btn-edit-project').addEventListener('click', openEditProjectModal);
$('#form-edit-project').addEventListener('submit', saveEditProject);
$('#btn-add-boq').addEventListener('click', () => openBoqModal(null));
$('#form-boq').addEventListener('submit', saveBoq);
$('#form-boq').addEventListener('input', onBoqInput);
$('#boq-table').addEventListener('click', onBoqTableClick);
$('#form-flats').addEventListener('submit', saveFlats);
$('#form-flats').addEventListener('input', updateFlatsPreview);
$('#btn-export-pdf').addEventListener('click', exportDailyReport);
$('#btn-report-daily').addEventListener('click', exportDailyReport);

if (db) {
  $('#form-login').addEventListener('submit', signIn);
  $$('[data-sign-out]').forEach((el) => el.addEventListener('click', signOut));
  initAuth();
} else {
  showSetupNotice();
}
