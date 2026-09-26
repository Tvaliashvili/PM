// =============================================================
// CPMG PM — main app logic
// =============================================================
import {
  SUPABASE_URL, SUPABASE_KEY, CURRENCY_CODE,
  STAGES, STATUSES, STATUS_LABELS,
  MANPOWER_TRADES, WEATHER_OPTIONS, DELAY_CAUSES,
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
  ['#btn-new-log', '#btn-new-delay', '#btn-export-pdf', '#btn-report-daily'].forEach((sel) => { $(sel).disabled = !enabled; });
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
  const select = $('#project-select');
  select.innerHTML = '<option value="">Supabase not configured</option>';
  select.disabled = true;
  $('#btn-new-project').disabled = true;
  $('#projects-container').textContent = 'Add your Supabase URL and anon key in js/config.js to get started.';
}

// =============================================================
// Projects
// =============================================================
async function loadProjects() {
  const select = $('#project-select');
  select.disabled = true;
  select.innerHTML = '<option value="">Loading projects…</option>';

  const { data, error } = await db
    .from('projects')
    .select('id, name, location, total_flats, created_at')
    .order('created_at', { ascending: false });

  if (error) {
    select.innerHTML = '<option value="">Failed to load</option>';
    $('#projects-container').textContent = `Could not load projects: ${error.message}`;
    toast(`Could not load projects: ${error.message}`, 'error');
    return;
  }

  state.projects = data;
  select.innerHTML = `<option value="">${data.length ? 'Select a project…' : 'No projects yet'}</option>`
    + data.map((p) => `
      <option value="${esc(p.id)}">${esc(p.name)}${p.location ? ` — ${esc(p.location)}` : ''}</option>
    `).join('');
  select.disabled = !data.length;

  // Reopen the last project after a refresh; otherwise start on the list.
  const saved = storage.get('cpm.projectId');
  state.projectsLoaded = true;
  selectProject(data.some((p) => p.id === saved) ? saved : null);
  route();
}

async function selectProject(projectId) {
  state.projectId = projectId || null;
  state.flats = [];
  setProjectActionsEnabled(Boolean(state.projectId));
  $('#project-select').value = state.projectId ?? '';

  const project = state.projects.find((p) => p.id === state.projectId);
  const navLabel = $('#nav-project-name');
  navLabel.textContent = project?.name ?? '';
  navLabel.classList.toggle('hidden', !project);

  if (!project) {
    storage.set('cpm.projectId', '');
    $('#dashboard-subtitle').textContent = 'Select a project to view its status.';
    return;
  }

  storage.set('cpm.projectId', project.id);
  $('#dashboard-subtitle').textContent = [project.name, project.location].filter(Boolean).join(' · ');

  await Promise.all([renderFlatMatrix(project.id), refreshDashboard(project.id)]);
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
const MAX_FLATS = 2000;
const clampInt = (value, min, max) => Math.min(max, Math.max(min, parseInt(value, 10) || 0));

// Flat numbers: floor + 2-digit position, e.g. 101, 102 … ground floor G01, G02.
function planFlats(form) {
  const blocks = [...new Set(form.elements.blocks.value.split(',').map((b) => b.trim()).filter(Boolean))];
  const floors = clampInt(form.elements.floors.value, 0, 60);
  const perFloor = clampInt(form.elements.flats_per_floor.value, 0, 30);
  const start = form.elements.start_floor.value === '0' ? 0 : 1;

  const flats = [];
  for (const block of blocks) {
    for (let floor = start; floor < start + floors; floor++) {
      for (let i = 1; i <= perFloor; i++) {
        flats.push({
          block,
          floor,
          flat_number: `${floor === 0 ? 'G' : floor}${String(i).padStart(2, '0')}`,
          stage_status: {},
        });
      }
    }
  }
  return { blocks, flats };
}

function updateFlatPreview() {
  const { blocks, flats } = planFlats($('#form-project'));
  const preview = $('#project-flat-preview');
  if (!flats.length) {
    preview.textContent = 'No flats will be created — you can add them later.';
  } else if (flats.length > MAX_FLATS) {
    preview.textContent = `${flats.length} flats is more than the ${MAX_FLATS} limit — reduce blocks, floors or flats per floor.`;
  } else {
    preview.textContent = `Creates ${flats.length} flats (${flats[0].flat_number} to ${flats[flats.length - 1].flat_number})`
      + ` in ${blocks.length > 1 ? 'blocks' : 'block'} ${blocks.join(', ')}.`;
  }
}

function openProjectModal() {
  const form = $('#form-project');
  form.reset();
  updateFlatPreview();
  showFormError(form, '');
  openModal('modal-project');
}

async function saveProject(e) {
  e.preventDefault();
  const form = e.currentTarget;
  const btn  = $('[type=submit]', form);
  const fd   = new FormData(form);
  const { flats } = planFlats(form);

  if (flats.length > MAX_FLATS) {
    showFormError(form, `A project can have at most ${MAX_FLATS} flats.`);
    return;
  }

  showFormError(form, '');
  setBusy(btn, true, 'Creating…');

  const { data: project, error } = await db
    .from('projects')
    .insert({
      name: fd.get('name').trim(),
      location: fd.get('location').trim() || null,
      total_flats: flats.length,
    })
    .select('id')
    .single();

  if (error) {
    setBusy(btn, false);
    showFormError(form, error.message);
    return;
  }

  if (flats.length) {
    const { error: flatsError } = await db
      .from('flats')
      .insert(flats.map((f) => ({ ...f, project_id: project.id })));

    if (flatsError) {
      await db.from('projects').delete().eq('id', project.id); // don't leave a half-created project
      setBusy(btn, false);
      showFormError(form, `Could not create flats: ${flatsError.message}`);
      return;
    }
  }

  setBusy(btn, false);
  closeModal('modal-project');
  toast(`Project created with ${flats.length} flats.`, 'success');

  storage.set('cpm.projectId', project.id);
  await loadProjects();
  goTo('dashboard');
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
    container.textContent = 'No flats in this project yet.';
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
      <h3 class="matrix-block-title">Block ${esc(block)}</h3>
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

async function onMatrixClick(e) {
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
$('#form-project').addEventListener('input', updateFlatPreview);
$('#btn-export-pdf').addEventListener('click', exportDailyReport);
$('#btn-report-daily').addEventListener('click', exportDailyReport);

if (db) {
  $('#form-login').addEventListener('submit', signIn);
  $$('[data-sign-out]').forEach((el) => el.addEventListener('click', signOut));
  $('#project-select').addEventListener('change', (e) => {
    if (e.target.value) openProject(e.target.value);
    else { selectProject(null); goTo('projects'); }
  });
  initAuth();
} else {
  showSetupNotice();
}
