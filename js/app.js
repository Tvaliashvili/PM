// =============================================================
// CPMG PM - main app logic
// =============================================================
import {
  SUPABASE_URL, SUPABASE_KEY, ADMIN_EMAIL, CURRENCIES, DEFAULT_CURRENCY,
  UNIT_TYPES, UNIT_STATUSES,
  MANPOWER_TRADES, WEATHER_OPTIONS, DELAY_CAUSES, DAY_WORKER_KEY, GUARD_KEY, EQUIPMENT_SUGGESTIONS,
  SITE_EVENT_KINDS, INCIDENT_SEVERITIES, VARIATION_STATUSES,
  BOQ_UNITS, CONTRACTOR_TRADES, INCOME_SOURCES, SALE_STATUSES, PURCHASE_KINDS, CLOSED_HOW,
} from './config.js';
import { buildDailyReport, saveDailyReport } from './pdfReport.js';
import { buildProjectReport, downloadProjectReport, interactiveReportHtml } from './projectReport.js';
import { buildArchive } from './archive.js';
import {
  scheduleProgress, taskState, durationDays, completionOf, expectedPct,
  plannedSpendByMonth, actualSpendByMonth, costPosition, contractorPerformance,
  labourCosts, guardCosts, rentalCosts, rentalTotal, rentalEnd, siteCostsByMonth, materialCosts, budgetOf,
  delayIsOngoing, delayDaysLost, delayStart, delayEnd, delayCovers, causeOf, withExtensions, dueDate, planVerdict,
  closeTasks, scheduleDay,
} from './schedule.js';
import { ka, roomLabel } from './bilingual.js';
import { isKa, setLang, startTranslating, dateLocale } from './i18n.js';
import { initMobile } from './mobile.js';
import {
  MAX_CONTRACT_MB, fetchContracts, uploadContract, contractUrl, deleteContracts, deleteProjectContracts,
} from './contracts.js';
import { roomIncome, financePosition, salesByType, INCOME_KINDS } from './finance.js';
import {
  MAX_PHOTOS, uploadPhotos, fetchPhotos, signPhotos, photosBy, deletePhoto, deletePhotosFor, deleteProjectPhotos,
} from './photos.js';

// ---------- Supabase ----------
// What brought the browser here, read before the Supabase client takes the
// link apart: an invite or a reset link means a password must be chosen; an
// expired link says so in its error.
const authLink = (() => {
  const params = new URLSearchParams(location.hash.slice(1) || location.search.slice(1));
  return { type: params.get('type'), error: params.get('error_description') };
})();
const isConfigured = !SUPABASE_URL.includes('YOUR-') && !SUPABASE_KEY.includes('YOUR-');
const db = isConfigured ? window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY) : null;

const state = {
  user: null,
  projects: [],
  projectsLoaded: false,
  projectId: null,
  // Open project:
  flats: [],            // units
  unitFloor: null,      // the floor tab shown in the room list, or 'all'
  tasks: [],            // timetable items (also the BOQ)
  payments: [],         // task_payments
  contractorDelays: [], // delays with cause_contractor_id + days
  delayImpacts: [],     // { delay_id, task_id, delay } - work a delay held up, which extends it
  contractors: [],      // this project's contractors
  contracts: [],        // contract_files: signed PDFs per contractor, with their acts
  siteLogs: [],         // every daily log's date, manpower and day rate (daily-worker pay)
  events: [],           // safety and quality events, newest first
  variations: [],       // change orders, newest first
  moneyIn: [],          // money_in: income and funding received, oldest first
  rentals: [],          // equipment_rentals
  materials: [],        // materials the client bought, newest first
  sitePayments: [],     // what was paid for daily workers, guards (by month) and rentals
  work: [],             // work_done: what was done in each room, oldest first
  delays: [],           // every delay on the project, newest first
  siteCosts: [],        // labour, guard, rental and material cost entries
  progress: null,       // scheduleProgress() result
};

// ---------- Helpers ----------
const $  = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

// Thousands are grouped with a (non-breaking) space - 204 300.00, not 204,300.00 -
// so a comma is never mistaken for the decimal point.
const spaced = (fmt) => ({
  format: (n) => fmt.formatToParts(n).map((p) => (p.type === 'group' ? ' ' : p.value)).join(''),
});

// Money is shown always with the cents (280 140.00), so a round sum is never
// read as a rounded one. Amounts are stored in the project's currency; the
// $ / ₾ switch in the top bar shows them in either, converting at today's
// National Bank rate (see loadDollarRate).
const moneyFormats = new Map();
function formatIn(currency) {
  if (!moneyFormats.has(currency)) {
    moneyFormats.set(currency, spaced(new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency,
      currencyDisplay: 'narrowSymbol',
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })));
  }
  return moneyFormats.get(currency);
}
let usdRate = null; // lari per dollar today, once the National Bank has answered
const SHOWN_CURRENCY_KEY = 'cpm.shownCurrency';
const projectCurrency = () => state.projects.find((p) => p.id === state.projectId)?.currency ?? DEFAULT_CURRENCY;
// The currency amounts are shown in: the one picked on the switch, once there
// is a rate to convert by; else the project's own.
function shownCurrency() {
  const picked = storage.get(SHOWN_CURRENCY_KEY);
  return picked && CURRENCIES[picked] && usdRate ? picked : projectCurrency();
}
function toShown(n) {
  const from = projectCurrency();
  const to = shownCurrency();
  if (from === to) return n;
  return from === 'USD' ? n * usdRate : n / usdRate;
}
const money  = { format: (n) => formatIn(shownCurrency()).format(toShown(Number(n))) };
const money2 = money;
// Forms take amounts in the project's currency, so their hints show it too.
const moneyOwn = { format: (n) => formatIn(projectCurrency()).format(Number(n)) };

const todayISO = () => new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD, local time

const MONTHS_KA = ['იან', 'თებ', 'მარ', 'აპრ', 'მაი', 'ივნ', 'ივლ', 'აგვ', 'სექ', 'ოქტ', 'ნოე', 'დეკ'];
const formatDate = (iso) => {
  if (isKa && iso) {
    const [y, m, d] = String(iso).slice(0, 10).split('-').map(Number);
    return `${d} ${MONTHS_KA[m - 1]} ${y}`;
  }
  return new Date(`${iso}T00:00`).toLocaleDateString(dateLocale, { day: 'numeric', month: 'short', year: 'numeric' });
};

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
  ['#btn-new-log-page', '#btn-new-delay', '#btn-add-unit', '#btn-rooms-template', '#btn-rooms-import', '#btn-add-task', '#btn-import-mpp', '#btn-import-template', '#btn-baseline', '#btn-new-event', '#btn-new-variation', '#btn-add-contractor', '#btn-add-rental', '#btn-add-material',
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
  if (target === 'reports' && state.projectId) prepareDailyReport();
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
  db.auth.onAuthStateChange((event, session) => {
    // Deferred: Supabase advises against awaiting client calls inside this callback.
    setTimeout(() => {
      handleSession(session);
      // An invite or reset link signs the person in; they still need a password.
      if (session && (event === 'PASSWORD_RECOVERY' || ['invite', 'recovery'].includes(authLink.type))) {
        openSetPassword(event === 'PASSWORD_RECOVERY' ? 'recovery' : authLink.type);
        authLink.type = null;
      }
    }, 0);
  });
  if (authLink.error) {
    setTimeout(() => showFormError($('#form-login'), `${authLink.error} - ask for a new link, or use Forgot password.`), 0);
  }
}

// An account's name, from its user metadata.
const userName = (user) => user?.user_metadata?.full_name || user?.user_metadata?.name || user?.user_metadata?.display_name || '';

// Who is signed in, by name (the email on hover); the email while there is no name yet.
function showSignedIn(user) {
  const viewOnly = Boolean(user) && user.email?.toLowerCase() !== ADMIN_EMAIL;
  $$('[data-user-email]').forEach((el) => {
    el.textContent = user ? `${userName(user) || user.email}${viewOnly ? ' · view only' : ''}` : 'Not signed in';
    el.title = user?.email ?? '';
  });
}

function handleSession(session) {
  // Sign-in is known now: show the page (hidden until then, so nobody sees
  // the dashboard for a moment before the sign-in box covers it).
  document.body.classList.remove('auth-pending');
  const user = session?.user ?? null;
  if (user && user.id === state.user?.id) return; // token refresh, same user

  state.user = user;
  // Only the administrator changes anything; everyone else gets the same pages
  // without the controls that write (the database refuses them anyway).
  const viewOnly = Boolean(user) && user.email?.toLowerCase() !== ADMIN_EMAIL;
  document.body.classList.toggle('read-only', viewOnly);
  showSignedIn(user);
  $$('[data-sign-out]').forEach((el) => el.classList.toggle('hidden', !user));

  if (user) {
    closeModal('modal-login');
    loadProjects();
  } else {
    openModal('modal-login');
  }
}

// The sign-in form's two ways in. Accounts are made only by invitation.
const LOGIN_MODES = {
  signin: { title: 'Sign in', sub: 'Use your account to continue.', submit: 'Sign in' },
  reset:  { title: 'Forgot password', sub: 'We will email you a link to choose a new password.', submit: 'Send the link' },
};

function setLoginMode(mode) {
  const form = $('#form-login');
  const m = LOGIN_MODES[mode];
  form.dataset.mode = mode;
  $('#login-title').textContent = m.title;
  $('#login-sub').textContent = m.sub;
  $('#login-submit').textContent = m.submit;
  $('#login-password').classList.toggle('hidden', mode === 'reset');
  form.elements.password.required = mode !== 'reset';
  $$('[data-login-mode]', form).forEach((b) => b.classList.toggle('hidden', b.dataset.loginMode === mode));
  $('#login-note').classList.add('hidden');
  showFormError(form, '');
}

// Where a link in an email brings the person back to: this page.
const appUrl = () => `${location.origin}${location.pathname}`;

async function signIn(e) {
  e.preventDefault();
  const form = e.currentTarget;
  const btn  = $('#login-submit');
  const fd   = new FormData(form);
  const mode = form.dataset.mode;
  const email = fd.get('email').trim();
  const note = (text) => {
    $('#login-note').textContent = text;
    $('#login-note').classList.remove('hidden');
  };

  showFormError(form, '');
  $('#login-note').classList.add('hidden');
  setBusy(btn, true, mode === 'signin' ? 'Signing in…' : 'Sending…');
  let error;
  if (mode === 'reset') {
    ({ error } = await db.auth.resetPasswordForEmail(email, { redirectTo: appUrl() }));
    if (!error) note(`If ${email} has an account, a link to choose a new password is on its way.`);
  } else {
    ({ error } = await db.auth.signInWithPassword({ email, password: fd.get('password') }));
    // On success, onAuthStateChange takes over.
  }
  setBusy(btn, false);
  if (error) showFormError(form, error.message);
}

// After an invite or reset link: choose a password (and say who you are).
function openSetPassword(kind) {
  const form = $('#form-set-password');
  form.reset();
  form.elements.name.value = userName(state.user);
  $('#set-password-title').textContent = kind === 'invite' ? 'Welcome - set your password' : 'Choose a new password';
  $('#set-password-sub').textContent = kind === 'invite'
    ? `You were invited as ${state.user?.email ?? ''}. Choose the password you will sign in with.`
    : 'Choose the password you will sign in with from now on.';
  showFormError(form, '');
  closeModal('modal-login');
  openModal('modal-set-password');
}

async function savePassword(e) {
  e.preventDefault();
  const form = e.currentTarget;
  const btn = $('[type=submit]', form);
  const fd = new FormData(form);
  if (fd.get('password') !== fd.get('password2')) {
    showFormError(form, 'The two passwords are not the same.');
    return;
  }
  const name = fd.get('name').trim();
  if (!name) {
    showFormError(form, 'Enter your name - it is shown on the site instead of your email.');
    return;
  }
  showFormError(form, '');
  setBusy(btn, true);
  const { data, error } = await db.auth.updateUser({
    password: fd.get('password'),
    ...(name ? { data: { full_name: name, name, display_name: name } } : {}),
  });
  setBusy(btn, false);
  if (error) {
    showFormError(form, error.message);
    return;
  }
  if (data?.user) {
    state.user = data.user;
    showSignedIn(data.user);
  }
  closeModal('modal-set-password');
  toast('Password saved. Use it to sign in from now on.', 'success');
}

async function signOut() {
  await db.auth.signOut();
  location.reload();
}

function showSetupNotice() {
  document.body.classList.remove('auth-pending');
  $('#btn-new-project').disabled = true;
  $('#projects-container').textContent = 'Add your Supabase URL and anon key in js/config.js to get started.';
}

// =============================================================
// Projects
// =============================================================
async function loadProjects() {
  const { data, error } = await db
    .from('projects')
    .select('id, name, name_ka, location, location_ka, client_name, client_name_ka, total_flats, has_rooms, day_rate, guard_rate, created_at, start_date, end_date, currency, baseline_set_on, retention_pct, income_from, price_per_m2, closed_how, closed_on, closed_note, finance_in_report')
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
  // Nothing of the last project carries over - a new one starts from scratch.
  state.flats = [];
  state.unitFloor = null;
  state.delayImpacts = [];
  state.progress = null;
  state.tasks = [];
  state.payments = [];
  state.contractorDelays = [];
  state.contractors = [];
  state.contracts = [];
  state.siteLogs = [];
  state.rentals = [];
  state.materials = [];
  state.sitePayments = [];
  state.work = [];
  state.siteCosts = [];
  state.delays = [];
  state.events = [];
  state.variations = [];
  state.moneyIn = [];
  setProjectActionsEnabled(Boolean(state.projectId));
  syncCurrencySwitch();

  const project = currentProject();
  applyProjectHeader(project);

  if (!project) {
    storage.set('cpm.projectId', '');
    return;
  }

  storage.set('cpm.projectId', project.id);
  resetLogFilter(); // a new project starts with a clean, unfiltered log list
  await Promise.all([
    loadContracts(project.id),
    loadMoneyIn(project.id),
    loadUnits(project.id), loadWork(project.id), loadSchedule(project.id), refreshDashboard(project.id), loadLogs(project.id),
    loadEvents(project.id), loadVariations(project.id),
  ]);
}

// The UI is English: show the English client name, else the Georgian one.
// A project's name, location and client in the language the app is shown in -
// the other language when that one was not written.
const inLang = (en, ka) => (isKa ? ka || en : en || ka) || '';
const projectNameOf = (p) => inLang(p?.name, p?.name_ka);
const clientOf = (p) => inLang(p?.client_name, p?.client_name_ka);
const locationOf = (p) => inLang(p?.location, p?.location_ka);
// Sites without rooms (e.g. a stadium) hide the Rooms page and every room field.
const hasRooms = (p) => Boolean(p?.has_rooms);
// Where the project's income comes from: 'sales', 'contract', or null when not chosen yet.
const incomeFrom = (p) => p?.income_from ?? null;

const currentProject = () => state.projects.find((p) => p.id === state.projectId);

// Project name/location wherever it's shown in the workspace.
function applyProjectHeader(project) {
  $('#topbar-project-name').textContent = projectNameOf(project);
  $('#topbar-project-location').textContent = [
    locationOf(project), clientOf(project) && `Client: ${clientOf(project)}`,
    project?.closed_how && `${CLOSED_HOW[project.closed_how].en}${project.closed_on ? ` ${formatDate(project.closed_on)}` : ''}`,
  ].filter(Boolean).join(' · ');

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
    // A view-only account sees only the projects it was given.
    el.innerHTML = document.body.classList.contains('read-only') ? `
      <div class="space-y-2 py-6">
        <p class="text-base font-medium text-white">No projects shared with this account yet</p>
        <p>Ask the administrator to give you access to your project.</p>
      </div>` : `
      <div class="space-y-2 py-6">
        <p class="text-base font-medium text-white">No projects yet</p>
        <p>Click <span class="text-brand-400">New Project</span> above to create your first one.</p>
      </div>`;
    return;
  }

  const request = ++projectListRequest;
  const [tasks, delays, impacts] = await Promise.all([
    db.from('schedule_tasks').select('id, project_id, planned_start, planned_finish, done'),
    db.from('delays').select('project_id'),
    // An item a delay held up is not overdue until its extension runs out.
    db.from('delay_impacts').select('task_id, delay:delays(duration_days, created_at)'),
  ]);
  if (request !== projectListRequest) return; // a newer render started
  if (tasks.error || delays.error || impacts.error) toast('Could not load project stats.', 'error');

  const tasksByProject = new Map(state.projects.map((p) => [p.id, []]));
  const projectById = new Map(state.projects.map((p) => [p.id, p]));
  for (const t of withExtensions(tasks.data ?? [], impacts.data ?? [], todayISO())) {
    tasksByProject.get(t.project_id)?.push(...closeTasks([t], projectById.get(t.project_id)));
  }
  const delayCount = new Map();
  for (const d of delays.data ?? []) delayCount.set(d.project_id, (delayCount.get(d.project_id) ?? 0) + 1);

  const today = todayISO();
  el.className = 'projects-grid';
  el.innerHTML = state.projects.map((p) => {
    const prog = scheduleProgress(tasksByProject.get(p.id) ?? [], scheduleDay(p, today));
    const s = { units: p.total_flats ?? 0, overdue: prog.overdue.length, delays: delayCount.get(p.id) ?? 0 };
    const pct = prog.actualPct;
    return `
      <article class="project-card${p.id === state.projectId ? ' is-active' : ''}">
        <button type="button" class="project-card-open" data-open-project="${esc(p.id)}">
          <p class="pr-8 font-semibold text-white truncate">${esc(projectNameOf(p))}</p>
          ${p.closed_how ? `<p class="mt-1"><span class="status-chip ${p.closed_how === 'completed' ? 'status-done' : 'status-handed'}">${esc(CLOSED_HOW[p.closed_how].en)}${p.closed_on ? ` · ${esc(formatDate(p.closed_on))}` : ''}</span></p>` : ''}
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

  btn.textContent = 'Deleting…'; // still busy; setBusy keeps the original label to restore
  const deleted = await deleteProject(projectId);
  setBusy(btn, false);
  if (deleted) closeModal('modal-delete-project');
}

/** Removes the project and everything that cascades from it. True when it went. */
async function deleteProject(projectId) {
  const project = state.projects.find((p) => p.id === projectId);
  if (!project) return false;

  // The photo files first: the rows go with the project, the files would not.
  try {
    await deleteProjectPhotos(db, projectId);
    if (isAdmin()) await deleteProjectContracts(db, projectId);
  } catch (err) {
    toast(`Could not delete project: ${err.message}. Nothing was deleted - try again.`, 'error');
    return false;
  }
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

// ---------- Users & access (administrator only) ----------
// Every registered account, and the projects each may see. The database
// enforces it (schema.sql section 37): an account reads only its projects.
let accessUsers = [];
let accessRows = []; // project_members: { project_id, user_id }

async function openAccess() {
  openModal('modal-access');
  $('#access-list').innerHTML = '<div class="empty-state">Loading accounts…</div>';
  const [users, members] = await Promise.all([
    db.rpc('list_users'),
    db.from('project_members').select('project_id, user_id'),
  ]);
  const failed = [users, members].find((r) => r.error);
  if (failed) {
    $('#access-list').innerHTML = `<div class="empty-state">Could not load the accounts: ${esc(failed.error.message)}</div>`;
    return;
  }
  accessUsers = users.data;
  accessRows = members.data;
  renderAccess();
}

function renderAccess() {
  const projects = [...state.projects].sort((a, b) => a.name.localeCompare(b.name));
  const when = (iso) => (iso ? formatDate(iso.slice(0, 10)) : 'never');
  $('#access-list').innerHTML = accessUsers.map((u) => {
    const head = `
      <div class="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <p class="text-white font-medium">${u.name ? esc(u.name) : '<span class="text-slate-500">No name</span>'}</p>
        <p class="text-sm text-slate-400">${esc(u.email)}</p>
        <p class="text-xs text-slate-500">last signed in ${esc(when(u.last_sign_in_at))}</p>
        <button type="button" class="table-action" data-access-rename="${esc(u.id)}">${u.name ? 'Rename' : 'Add name'}</button>`;
    if (u.email?.toLowerCase() === ADMIN_EMAIL) {
      return `<div class="panel">${head}
        <span class="status-chip status-done">Administrator - sees and changes every project</span></div></div>`;
    }
    const given = new Set(accessRows.filter((r) => r.user_id === u.id).map((r) => r.project_id));
    return `<div class="panel">${head}
        <span class="text-xs ${given.size ? 'text-slate-400' : 'text-amber-400'}">${given.size} of ${projects.length} projects</span>
        <span class="ml-auto flex gap-1">
          <button type="button" class="table-action" data-access-all="${esc(u.id)}">All</button>
          <button type="button" class="table-action" data-access-none="${esc(u.id)}">None</button>
        </span>
      </div>
      <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-x-4 gap-y-1 mt-2">
        ${projects.map((p) => `
          <label class="check-row">
            <input type="checkbox" data-access-user="${esc(u.id)}" data-access-project="${esc(p.id)}"${given.has(p.id) ? ' checked' : ''}>
            <span>${esc(p.name)}${p.name_ka ? `<small>${esc(p.name_ka)}</small>` : ''}</span>
          </label>`).join('')}
      </div>
    </div>`;
  }).join('') || '<div class="empty-state">No accounts registered yet.</div>';
}

// Gives (or takes back) projects from one account, then redraws.
async function setAccess(userId, projectIds, give) {
  if (!projectIds.length) return;
  const { error } = give
    ? await db.from('project_members').upsert(projectIds.map((project_id) => ({ project_id, user_id: userId })), { onConflict: 'project_id,user_id' })
    : await db.from('project_members').delete().eq('user_id', userId).in('project_id', projectIds);
  if (error) {
    toast(`Could not change access: ${error.message}`, 'error');
  } else if (give) {
    for (const id of projectIds) {
      if (!accessRows.some((r) => r.user_id === userId && r.project_id === id)) accessRows.push({ project_id: id, user_id: userId });
    }
  } else {
    accessRows = accessRows.filter((r) => r.user_id !== userId || !projectIds.includes(r.project_id));
  }
  renderAccess();
}

async function renameUser(userId) {
  const u = accessUsers.find((x) => x.id === userId);
  if (!u) return;
  const name = prompt(`Name for ${u.email}:`, u.name ?? '');
  if (name === null || !name.trim() || name.trim() === u.name) return;
  const { error } = await db.rpc('set_user_name', { target: userId, new_name: name.trim() });
  if (error) {
    toast(`Could not rename: ${error.message}`, 'error');
    return;
  }
  u.name = name.trim();
  if (userId === state.user?.id) {
    const { data } = await db.auth.refreshSession();
    if (data?.user) {
      state.user = data.user;
      showSignedIn(data.user);
    }
  }
  renderAccess();
}

function onAccessClick(e) {
  const rename = e.target.closest('[data-access-rename]');
  if (rename) return renameUser(rename.dataset.accessRename);
  const all = e.target.closest('[data-access-all]');
  if (all) return setAccess(all.dataset.accessAll, state.projects.map((p) => p.id), true);
  const none = e.target.closest('[data-access-none]');
  if (none) {
    const userId = none.dataset.accessNone;
    return setAccess(userId, accessRows.filter((r) => r.user_id === userId).map((r) => r.project_id), false);
  }
}

function onAccessChange(e) {
  const box = e.target.closest('[data-access-user]');
  if (box) setAccess(box.dataset.accessUser, [box.dataset.accessProject], box.checked);
}

// ---------- New project ----------
function openProjectModal() {
  const form = $('#form-project');
  form.reset();
  syncRoomsTick(form);
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
      has_rooms: fd.has('has_rooms') || fd.get('income_from') === 'sales',
      income_from: fd.get('income_from') || null,
    })
    .select('id')
    .single();
  setBusy(btn, false);

  if (error) {
    showFormError(form, error.message);
    return;
  }

  closeModal('modal-project');
  toast(`Project created. Add its timetable${fd.has('has_rooms') || fd.get('income_from') === 'sales' ? ', rooms' : ''} and dates next.`, 'success');

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
const SALE_STATUS_CHIP = {
  for_sale:     'status-pending',
  reserved:     'status-in_progress',
  sold:         'status-done',
  not_for_sale: 'status-handed',
};
const areaFormat = spaced(new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }));
const numOrNull = (v) => (v === '' || v == null ? null : Number(v));

async function loadUnits(projectId) {
  const { data, error } = await db
    .from('flats')
    .select('id, block, floor, flat_number, unit_type, area_m2, rooms, status, notes, sale_status, asking_price, sale_price, buyer, sold_on')
    .eq('project_id', projectId)
    .order('block')
    .order('floor')
    .order('flat_number');

  if (projectId !== state.projectId) return; // project switched mid-request
  if (error) {
    $('#units-table').innerHTML = `<div class="empty-state">Could not load units: ${esc(error.message)}</div>`;
    return;
  }
  // Postgres sorts room numbers as text (1, 10, 11, 2); sort them as people count.
  const byNumber = (a, b) => String(a ?? '').localeCompare(String(b ?? ''), undefined, { numeric: true });
  state.flats = data.sort((a, b) => byNumber(a.block, b.block)
    || byNumber(a.floor, b.floor) || byNumber(a.flat_number, b.flat_number));
  renderUnits();
  renderFinance(); // room prices are income
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
    $('#units-table').innerHTML = '<div class="empty-state">No rooms yet.</div>';
    return;
  }

  const anyBlock = units.some((u) => u.block);

  // One tab per floor (per block and floor), so a building of a few hundred
  // rooms is read a floor at a time rather than scrolled.
  const floorKey = (u) => `${u.block ?? ''}|${u.floor ?? ''}`;
  const floors = new Map();
  for (const u of units) {
    const key = floorKey(u);
    if (!floors.has(key)) {
      floors.set(key, { label: [anyBlock && u.block, u.floor != null && floorLabel(u.floor)].filter(Boolean).join(' · ') || 'No floor', n: 0 });
    }
    floors.get(key).n++;
  }
  if (state.unitFloor !== 'all' && !floors.has(state.unitFloor)) state.unitFloor = floors.keys().next().value;
  const shown = state.unitFloor === 'all' ? units : units.filter((u) => floorKey(u) === state.unitFloor);
  const shownArea = sumOf(shown.filter((u) => u.area_m2 != null), 'area_m2');
  const tab = (key, label) => `<button type="button" class="floor-tab${key === state.unitFloor ? ' is-active' : ''}" `
    + `data-unit-floor="${esc(key)}">${esc(label)}</button>`;
  const tabs = floors.size > 1 ? `
    <div class="floor-tabs">
      ${[...floors].map(([key, f]) => tab(key, f.label)).join('')}
      ${tab('all', 'All floors')}
    </div>` : '';
  const totals = `<p class="floor-totals"><b>${shown.length}</b> rooms · <b>${areaFormat.format(shownArea)}</b> m²</p>`;

  // A project that sells its rooms shows each one's sale and the price it counts at.
  const selling = incomeFrom(currentProject()) === 'sales';
  const pricePerM2 = currentProject()?.price_per_m2;
  const saleCells = (u) => {
    const { amount, source } = roomIncome(u, pricePerM2);
    const status = u.sale_status ?? 'for_sale';
    const price = source === 'kept' ? '<span class="text-slate-500">-</span>'
      : source === 'none' ? '<span class="text-slate-500">no price</span>'
      : source === 'sale' ? money.format(amount)
      : `<span class="text-slate-400" title="${source === 'per_m2' ? 'Area × the project\'s price per m²' : 'Asking price'}">${money.format(amount)}</span>`;
    return `
      <td><span class="status-chip ${SALE_STATUS_CHIP[status]}">${esc(SALE_STATUSES[status])}</span>${
        u.buyer ? `<span class="block text-xs text-slate-500">${esc(u.buyer)}</span>` : ''}</td>
      <td class="num">${price}</td>`;
  };

  const rows = shown.map((u) => `
    <tr>
      <td class="font-medium text-white whitespace-nowrap">${esc(u.flat_number)}</td>
      ${anyBlock ? `<td>${esc(u.block || '-')}</td>` : ''}
      <td class="whitespace-nowrap">${esc(floorLabel(u.floor))}</td>
      <td>${u.unit_type ? esc(u.unit_type) : '<span class="text-slate-500">-</span>'}</td>
      <td class="num">${u.area_m2 != null ? areaFormat.format(u.area_m2) : '-'}</td>
      <td><span class="status-chip ${UNIT_STATUS_CHIP[u.status] ?? 'status-pending'}">${esc(UNIT_STATUSES[u.status] ?? u.status)}</span></td>
      ${selling ? saleCells(u) : ''}
      <td class="max-w-[16rem] truncate text-slate-400" title="${esc(u.notes ?? '')}">${esc(u.notes ?? '')}</td>
      <td class="text-right whitespace-nowrap">
        <button type="button" class="table-action" data-unit-work="${esc(u.id)}">Work${
          workCount(u.id) ? ` (${workCount(u.id)})` : ''}</button>
        <button type="button" class="table-action" data-unit-edit="${esc(u.id)}">Edit</button>
        <button type="button" class="table-action is-danger" data-unit-delete="${esc(u.id)}">Delete</button>
      </td>
    </tr>`).join('');

  $('#units-table').innerHTML = `${tabs}${totals}
    <table class="data-table">
      <thead>
        <tr>
          <th>Room</th>${anyBlock ? '<th>Block</th>' : ''}<th>Floor</th><th>Type</th><th class="num">Area m²</th>
          <th>Status</th>${selling ? '<th>Sale</th><th class="num">Price</th>' : ''}<th>Notes</th><th></th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
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
    f.sale_status.value = unit.sale_status ?? 'for_sale';
    f.asking_price.value = unit.asking_price ?? '';
    f.sale_price.value = unit.sale_price ?? '';
    f.buyer.value = unit.buyer ?? '';
    f.sold_on.value = unit.sold_on ?? '';
  } else {
    const last = state.flats.at(-1); // continue where the list ends
    f.block.value = last?.block ?? '';
    f.floor.value = last?.floor ?? 1;
    f.status.value = 'not_started';
    f.sale_status.value = 'for_sale';
  }
  // Only a project that sells what it builds has sales.
  $('#unit-sale').classList.toggle('hidden', incomeFrom(currentProject()) !== 'sales');
  updateUnitPriceHint();
  openModal('modal-unit');
}

// What the room counts for in the project's income, as its sale is filled in.
function updateUnitPriceHint() {
  const f = $('#form-unit').elements;
  const pricePerM2 = currentProject()?.price_per_m2;
  const room = {
    sale_status: f.sale_status.value,
    area_m2: numOrNull(f.area_m2.value),
    asking_price: numOrNull(f.asking_price.value),
    sale_price: numOrNull(f.sale_price.value),
  };
  const { amount, source } = roomIncome(room, pricePerM2);
  const perM2 = room.area_m2 ? ` - ${moneyOwn.format(amount / room.area_m2)} per m²` : '';
  $('#unit-price-hint').textContent = {
    kept: 'Not for sale: kept or given away, it adds nothing to income.',
    sale: `Counts in income at its sale price, ${moneyOwn.format(amount)}${perM2}.`,
    asking: room.sale_status === 'sold'
      ? `Sold with no sale price yet: counts at its asking price, ${moneyOwn.format(amount)}${perM2}.`
      : `Counts in income at its asking price, ${moneyOwn.format(amount)}${perM2}.`,
    per_m2: `No asking price: counts at area × the project's ${moneyOwn.format(pricePerM2)} per m², ${moneyOwn.format(amount)}.`,
    none: 'No price yet: give it an asking price (or set a price per m² in Edit Project) for it to count in income.',
  }[source];
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
    sale_status:  fd.get('sale_status') || 'for_sale',
    asking_price: numOrNull(fd.get('asking_price')),
    sale_price:   numOrNull(fd.get('sale_price')),
    buyer:        fd.get('buyer').trim() || null,
    sold_on:      fd.get('sold_on') || null,
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

// ---------- Work done in each room, or on a timetable item ----------
// Entered by hand from a room's Work popup, or a timetable item's for work in
// no room (a slab pour, the facade): the day, what was done (Georgian and
// English), who did it and, when measured, how much.
let workTarget = {}; // { flatId }, { taskId } or { day, logId } (the daily workers' day): whose Work popup is open
// "Done by" value for the client's own daily workers, who are nobody's contractor.
const DAY_WORKERS = '__day';
// Who did a work entry, in words.
const workBy = (w) => (w.by_day_workers ? 'Daily workers' : w.contractor_id ? contractorName(w.contractor_id) : '');

async function loadWork(projectId) {
  const { data, error } = await db.from('work_done')
    .select('id, flat_id, task_id, daily_log_id, by_day_workers, contractor_id, work_date, work, work_en, quantity, unit, created_at')
    .eq('project_id', projectId)
    .order('work_date')
    .order('created_at');
  if (projectId !== state.projectId) return;
  if (error) {
    toast(`Could not load the work done: ${error.message}`, 'error');
    return;
  }
  state.work = data;
  renderUnits();
  renderWeek();
  if (state.tasks.length) renderSchedule(); // each item's Work count
  // Each log card shows what was done on its day.
  $$('[data-log-work]').forEach((el) => { el.innerHTML = workList(workOn(el.dataset.logWork)); });
  $$('[data-log-day-workers]').forEach((el) => {
    const n = dayWorkCount(el.dataset.day);
    el.textContent = `Daily workers${n ? ` (${n})` : ''}`;
  });
  if ($('#modal-room-work').open) renderRoomWork();
}

function openRoomWork(flatId) {
  const flat = state.flats.find((f) => f.id === flatId);
  if (!flat) return;
  workTarget = { flatId };
  $('#room-work-title').textContent = `Work done - ${roomLabel(flat)}`;
  $('#room-work-sub').textContent = [`Floor ${flat.floor}`, flat.unit_type, UNIT_STATUSES[flat.status]].filter(Boolean).join(' · ');
  resetRoomWorkForm();
  renderRoomWork();
  openModal('modal-room-work');
  $('#room-work-pick').focus();
}

// Work in no room, on a timetable item: the pour, the facade, the yard.
function openTaskWork(taskId) {
  const task = state.tasks.find((t) => t.id === taskId);
  if (!task) return;
  workTarget = { taskId };
  $('#room-work-title').textContent = `Work done - ${task.name}`;
  resetRoomWorkForm();
  renderRoomWork();
  openModal('modal-room-work');
  $('#room-work-pick').focus();
}

const workOfTarget = () => state.work.filter((w) => (workTarget.day
  ? w.by_day_workers && w.work_date === workTarget.day
  : workTarget.taskId
    ? w.task_id === workTarget.taskId
    : w.flat_id === workTarget.flatId));

// What the client's daily workers did on one day: cleaning, arranging the
// site, or work in a room or on an item.
function openDayWorkersWork(logId) {
  const log = shownLogs.find((l) => l.id === logId);
  if (!log) return;
  workTarget = { day: log.log_date, logId };
  const crew = (log.crew ?? []).filter((c) => !c.contractor_id && c.trade === DAY_WORKER_KEY);
  const count = crew.reduce((s, c) => s + Number(c.workers || 0), 0) || Number(log.manpower?.[DAY_WORKER_KEY]) || 0;
  $('#room-work-title').textContent = `Daily workers - ${formatDate(log.log_date)}`;
  $('#room-work-sub').textContent = count ? `${count} daily worker${count === 1 ? '' : 's'} on site that day` : 'No daily workers counted in this log';
  resetRoomWorkForm();
  renderRoomWork();
  openModal('modal-room-work');
  $('#room-work-pick').focus();
}

// The day-workers popup asks where the work was; the others know already.
function whereOptions(entry) {
  const value = entry?.flat_id ? `flat:${entry.flat_id}` : entry?.task_id ? `task:${entry.task_id}` : '';
  const opt = (v, label) => `<option value="${esc(v)}"${v === value ? ' selected' : ''}>${esc(label)}</option>`;
  return opt('', 'General - the site (cleaning, arranging…)')
    + (state.flats.length ? `<optgroup label="Room">${state.flats.map((u) => opt(`flat:${u.id}`, roomLabel(u))).join('')}</optgroup>` : '')
    + (state.tasks.length ? `<optgroup label="Timetable item">${state.tasks.map((t) => opt(`task:${t.id}`, t.name)).join('')}</optgroup>` : '');
}

/**
 * What an item's recorded work adds up to against its BOQ quantity: the
 * quantities measured in the item's own unit. null when the item has no
 * quantity to measure against.
 */
function taskMeasured(task) {
  const total = Number(task.quantity);
  if (!(total > 0)) return null;
  const done = state.work
    .filter((w) => w.task_id === task.id && w.quantity != null && (w.unit ?? '') === (task.unit ?? ''))
    .reduce((sum, w) => sum + Number(w.quantity), 0);
  return { done, total, pct: Math.min(100, Math.round((done / total) * 100)) };
}

/**
 * The project's kinds of work, like tags: every work written in this project,
 * once each, with its English, unit and contractor from the last time. A work
 * no entry uses any more drops off the list by itself. Picking from it keeps
 * the spelling the same, which is what lets the project report add work up.
 */
const workTagKey = (w) => String(w.work || w.work_en || '').trim().toLowerCase().replace(/\s+/g, ' ');
function workTags() {
  const tags = new Map();
  const named = new Map(); // the latest entry with both languages, so a work translated once is never translated again
  for (const w of state.work) { // oldest first, so the last one stays
    tags.set(workTagKey(w), w);
    if (w.work && w.work_en && w.work_en !== w.work) named.set(workTagKey(w), w);
  }
  return [...tags].map(([key, w]) => {
    const names = named.get(key) ?? w;
    return { key, ka: names.work, en: names.work_en, unit: w.unit, contractor_id: w.contractor_id };
  })
    .sort((a, b) => String(a.ka || a.en).localeCompare(String(b.ka || b.en)));
}

const NEW_WORK = '__new';
const biNameText = (t) => (t.ka && t.en && t.ka !== t.en ? `${t.ka} / ${t.en}` : (t.ka || t.en || ''));

/** The picker, and the two name fields when a new work is being written. */
function syncWorkPicker() {
  const pick = $('#room-work-pick');
  const isNew = pick.value === NEW_WORK || pick.options.length <= 1;
  $('#room-work-new').classList.toggle('hidden', !isNew);
  $('#room-work-pick-wrap').classList.toggle('hidden', pick.options.length <= 1);
}

function resetRoomWorkForm(entry = null) {
  const form = $('#form-room-work');
  const f = form.elements;
  form.reset();
  f.id.value = entry?.id ?? '';
  f.work_date.value = entry?.work_date ?? todayISO();
  f.work_date.max = todayISO();
  f.work.value = entry?.work ?? '';
  f.work_en.value = entry?.work_en ?? '';
  const tags = workTags();
  const selected = entry ? workTagKey(entry) : '';
  $('#room-work-pick').innerHTML = '<option value="">- Pick the work -</option>'
    + tags.map((t) => `<option value="${esc(t.key)}"${t.key === selected ? ' selected' : ''}>${esc(biNameText(t))}</option>`).join('')
    + `<option value="${NEW_WORK}">+ New work…</option>`;
  // No work in the project yet: there is nothing to pick, so it is a new one.
  if (!tags.length) $('#room-work-pick').innerHTML = `<option value="${NEW_WORK}">+ New work…</option>`;
  syncWorkPicker();
  // Done by: a contractor, or the client's own daily workers.
  $('#room-work-contractor').innerHTML = contractorOptions(entry?.by_day_workers ? '' : entry?.contractor_id ?? '')
    + `<option value="${DAY_WORKERS}"${entry?.by_day_workers ? ' selected' : ''}>Daily workers (hired by the client)</option>`;
  const dayMode = Boolean(workTarget.day);
  $('#room-work-who').classList.toggle('hidden', dayMode);
  $('#room-work-where-wrap').classList.toggle('hidden', !dayMode);
  if (dayMode) {
    f.contractor_id.value = DAY_WORKERS;
    $('#room-work-where').innerHTML = whereOptions(entry);
    if (!entry) f.work_date.value = workTarget.day;
  }
  f.quantity.value = entry?.quantity ?? '';
  f.unit.value = entry?.unit ?? '';
  // A new entry on an item starts from the item: its contractor and BOQ unit,
  // and its name as the work when the project already has that work.
  const task = !entry && workTarget.taskId ? state.tasks.find((t) => t.id === workTarget.taskId) : null;
  if (task) {
    f.contractor_id.value = task.contractor_id ?? '';
    f.unit.value = task.unit ?? '';
    const tag = tags.find((t) => t.key === workTagKey({ work: task.name_ka || task.name }));
    if (tag) {
      f.pick.value = tag.key;
      f.work.value = tag.ka ?? '';
      f.work_en.value = tag.en ?? '';
      syncWorkPicker();
    }
  }
  $('[type=submit]', form).textContent = entry ? 'Save changes' : 'Add work';
  $('#btn-room-work-cancel').classList.toggle('hidden', !entry);
  showFormError(form, '');
}

function renderRoomWork() {
  const list = $('#room-work-list');
  if (workTarget.taskId) renderTaskWorkSub();
  const dayMode = Boolean(workTarget.day);
  const whereOf = (w) => flatName(w.flat_id) || state.tasks.find((t) => t.id === w.task_id)?.name || 'General - the site';
  const work = workOfTarget()
    .sort((a, b) => b.work_date.localeCompare(a.work_date) || String(b.created_at).localeCompare(String(a.created_at)));
  if (!work.length) {
    list.innerHTML = `<div class="empty-state">No work recorded yet.</div>`;
    return;
  }
  list.innerHTML = `
    <table class="data-table">
      <thead><tr><th>Date</th><th>Work</th><th>${dayMode ? 'Where' : 'Done by'}</th><th class="num">Measured</th><th></th></tr></thead>
      <tbody>
        ${work.map((w) => `
          <tr>
            <td class="whitespace-nowrap">${esc(formatDate(w.work_date))}</td>
            <td>${esc(w.work || w.work_en)}${w.work_en && w.work_en !== w.work ? `<span class="block text-xs text-slate-500">${esc(w.work_en)}</span>` : ''}</td>
            <td>${dayMode ? esc(whereOf(w)) : workBy(w) ? esc(workBy(w)) : '<span class="text-slate-500">-</span>'}</td>
            <td class="num whitespace-nowrap">${esc(quantityText(w)) || '<span class="status-chip status-pending">In progress</span>'}</td>
            <td class="text-right whitespace-nowrap">
              <button type="button" class="table-action" data-room-work-edit="${esc(w.id)}">Edit</button>
              <button type="button" class="table-action is-danger" data-room-work-delete="${esc(w.id)}">Delete</button>
            </td>
          </tr>`).join('')}
      </tbody>
    </table>`;
}

// Leaving one language with the other empty fills the other in, to check
// before saving - the same as an activity's names.
// An item's popup says what its work adds up to against the BOQ, and offers
// to set the item's % complete from that.
function renderTaskWorkSub() {
  const task = state.tasks.find((t) => t.id === workTarget.taskId);
  if (!task) return;
  const m = taskMeasured(task);
  const now = Math.round(completionOf(task) * 100);
  const parts = [
    `${formatDate(task.planned_start)} → ${formatDate(task.planned_finish)}`,
    task.contractor_id ? contractorName(task.contractor_id) : '',
    m ? `measured ${qtyFormat.format(m.done)} of ${qtyFormat.format(m.total)} ${task.unit ?? ''} (${m.pct}%)` : '',
  ].filter(Boolean).map(esc).join(' · ');
  $('#room-work-sub').innerHTML = parts + (m && m.pct !== now
    ? ` <button type="button" class="table-action" data-task-work-pct="${m.pct}">Set % done to ${m.pct}% (now ${now}%)</button>`
    : '');
}

async function onRoomWorkNameChange(e) {
  const f = e.currentTarget.elements;
  // A work picked from the list brings its names, and its unit and contractor
  // from the last time, with no translation to wait for.
  if (e.target === f.pick) {
    const tag = workTags().find((t) => t.key === f.pick.value);
    f.work.value = tag?.ka ?? '';
    f.work_en.value = tag?.en ?? '';
    if (tag?.unit && !f.unit.value) f.unit.value = tag.unit;
    if (tag?.contractor_id && !f.contractor_id.value) f.contractor_id.value = tag.contractor_id;
    syncWorkPicker();
    if (f.pick.value === NEW_WORK) f.work.focus();
    return;
  }
  if (e.target !== f.work && e.target !== f.work_en) return;
  const other = e.target === f.work ? f.work_en : f.work;
  const text = e.target.value.trim();
  const both = splitBilingual(text);
  if (both && (!other.value.trim() || other.value.trim() === text)) {
    f.work.value = both.ka;
    f.work_en.value = both.en;
    return;
  }
  if (!text || other.value.trim()) return;
  const row = e.target === f.work ? { name: text, name_ka: text } : { name: text, name_ka: null };
  const placeholder = other.placeholder;
  other.placeholder = 'Translating…';
  const err = await translateNames([row]);
  other.placeholder = placeholder;
  if (err || other.value.trim() || e.target.value.trim() !== text) return;
  other.value = e.target === f.work ? row.name : row.name_ka;
}

async function saveRoomWork(e) {
  e.preventDefault();
  const form = e.currentTarget;
  const btn = $('[type=submit]', form);
  const fd = new FormData(form);
  let ka = fd.get('work').trim();
  let en = fd.get('work_en').trim();
  for (const cell of [ka, en]) {
    const both = splitBilingual(cell);
    if (!both) continue;
    if (!ka || ka === cell) ka = both.ka;
    if (!en || en === cell) en = both.en;
  }
  if (!ka && !en) {
    showFormError(form, fd.get('pick') === NEW_WORK
      ? 'Write the new work, in Georgian or English.'
      : 'Pick the work, or choose + New work.');
    return;
  }
  const quantity = numOrNull(fd.get('quantity'));
  const id = fd.get('id');
  const byDayWorkers = fd.get('contractor_id') === DAY_WORKERS;
  // The daily workers' popup says where; a room's or an item's is that room or item.
  const [whereKind, whereId] = String(fd.get('where') || '').split(':');
  const row = workTarget.day ? {
    flat_id: whereKind === 'flat' ? whereId : null,
    task_id: whereKind === 'task' ? whereId : null,
    daily_log_id: workTarget.logId ?? null,
  } : {
    flat_id: workTarget.flatId ?? null,
    task_id: workTarget.taskId ?? null,
  };
  Object.assign(row, {
    by_day_workers: byDayWorkers,
    work_date: fd.get('work_date'),
    contractor_id: byDayWorkers ? null : fd.get('contractor_id') || null,
    quantity: quantity > 0 ? quantity : null,
    unit: quantity > 0 ? fd.get('unit') || null : null,
  });

  showFormError(form, '');
  setBusy(btn, true, ka && en ? 'Saving…' : 'Translating…');
  // The missing language, if Gemini can be reached; if not, it is saved in
  // the one it was written in.
  const names = { name: en || ka, name_ka: ka || null };
  const untranslated = ka && en ? '' : await translateNames([names]);
  row.work = names.name_ka || names.name;
  row.work_en = names.name !== names.name_ka ? names.name : null;
  btn.textContent = 'Saving…';
  const { error } = id
    ? await db.from('work_done').update(row).eq('id', id)
    : await db.from('work_done').insert({ ...row, project_id: state.projectId });
  setBusy(btn, false);
  if (error) {
    showFormError(form, error.message);
    return;
  }
  toast(untranslated ? `Saved in one language - Gemini couldn't translate it: ${untranslated}` : 'Work saved.',
    untranslated ? 'error' : 'success');
  resetRoomWorkForm();
  loadWork(state.projectId);
}

async function onRoomWorkListClick(e) {
  const edit = e.target.closest('[data-room-work-edit]');
  if (edit) {
    resetRoomWorkForm(state.work.find((w) => w.id === edit.dataset.roomWorkEdit));
    $('#room-work-pick').focus();
    return;
  }
  const del = e.target.closest('[data-room-work-delete]');
  if (!del) return;
  const w = state.work.find((x) => x.id === del.dataset.roomWorkDelete);
  if (!w || !confirm(`Delete "${w.work || w.work_en}" of ${formatDate(w.work_date)}?`)) return;
  const { error } = await db.from('work_done').delete().eq('id', w.id);
  if (error) {
    toast(`Could not delete: ${error.message}`, 'error');
    return;
  }
  toast('Work deleted.', 'success');
  loadWork(state.projectId);
}

async function onUnitsTableClick(e) {
  const floor = e.target.closest('[data-unit-floor]');
  if (floor) {
    state.unitFloor = floor.dataset.unitFloor;
    renderUnits();
    return;
  }

  const work = e.target.closest('[data-unit-work]');
  if (work) {
    openRoomWork(work.dataset.unitWork);
    return;
  }
  const edit = e.target.closest('[data-unit-edit]');
  if (edit) {
    openUnitModal(state.flats.find((u) => u.id === edit.dataset.unitEdit));
    return;
  }

  const del = e.target.closest('[data-unit-delete]');
  if (!del) return;
  const unit = state.flats.find((u) => u.id === del.dataset.unitDelete);
  if (!unit) return;
  // Its work entries go with it (deleted first, and the database cascades them
  // too - schema.sql section 28); the same work
  // in other rooms is not touched.
  const entries = workCount(unit.id);
  const workNote = entries
    ? `\n\nIts ${entries} work entr${entries === 1 ? 'y is' : 'ies are'} deleted too - the same work in other rooms is not touched.`
    : '';
  if (!confirm(`Delete ${roomLabel(unit)}?${workNote}\n\nDelays linked to it are kept as site-wide.`)) return;

  const projectId = state.projectId;
  const { error: workError } = entries ? await db.from('work_done').delete().eq('flat_id', unit.id) : {};
  if (workError) {
    toast(`Could not delete room: ${workError.message}`, 'error');
    return;
  }
  const { error } = await db.from('flats').delete().eq('id', unit.id);
  if (error) {
    toast(`Could not delete room: ${error.message}`, 'error');
    return;
  }
  toast(`Deleted room ${unit.flat_number}.`, 'success');
  await syncFlatCount(projectId);
  if (projectId === state.projectId) {
    loadUnits(projectId);
    loadWork(projectId);
  }
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

const contractorName = (id) => {
  const c = state.contractors.find((x) => x.id === id);
  return c ? inLang(c.name, c.name_ka) : '';
};
const taskName = (t) => inLang(t?.name, t?.name_ka);
// An item's name for a table cell: in the app's language, the other one small beneath.
function taskNameHtml(t) {
  const main = taskName(t);
  const other = inLang(t.name_ka, t.name);
  return `${esc(main)}${other && other !== main ? `<span class="block text-xs text-slate-500">${esc(other)}</span>` : ''}`;
}
const paidOn = (taskId) => sumOf(state.payments.filter((p) => p.task_id === taskId), 'amount');
const materialsOn = (taskId) => sumOf(state.materials.filter((m) => m.task_id === taskId), 'amount');

// Items, payments and contractor-linked delays for one project, then every view built on them.
async function loadSchedule(projectId) {
  const [tasks, payments, delays, impacts, contractors, siteLogs, rentals, materials, sitePayments] = await Promise.all([
    db.from('schedule_tasks')
      .select('id, name, name_ka, planned_start, planned_finish, baseline_start, baseline_finish, done, done_at, progress_pct, contractor_id, quantity, unit, rate, budget, material_budget, employer_price')
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
    // Work each delay held up. The delay comes with it: the days an item is
    // excused are the days that delay lasted, counted from it rather than typed.
    db.from('delay_impacts')
      .select('delay_id, task_id, delay:delays!inner(project_id, delay_cause, duration_days, created_at, resolved_on)')
      .eq('delay.project_id', projectId),
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
    db.from('materials')
      .select('id, task_id, kind, bought_on, item, item_ka, quantity, unit, unit_price, amount, supplier, supplier_ka, note, paid_on, due_on')
      .eq('project_id', projectId)
      .order('bought_on', { ascending: false })
      .order('created_at', { ascending: false }),
    db.from('site_payments')
      .select('id, kind, month, rental_id, amount, paid_on, note')
      .eq('project_id', projectId)
      .order('paid_on'),
  ]);

  if (projectId !== state.projectId) return;
  const failed = [tasks, payments, delays, impacts, contractors, siteLogs, rentals, materials, sitePayments].find((r) => r.error);
  if (failed) {
    $('#schedule-table').innerHTML = `<div class="empty-state">Could not load timetable: ${esc(failed.error.message)}</div>`;
    return;
  }
  // Each item's finish, pushed out by the delays that held it up.
  // A project that has ended is read as of its last day; items not done by then are closed.
  const project = currentProject();
  state.tasks = closeTasks(withExtensions(tasks.data, impacts.data, scheduleDay(project, todayISO())), project);
  state.payments = payments.data;
  state.contractorDelays = delays.data;
  state.delayImpacts = impacts.data;
  state.contractors = contractors.data;
  state.siteLogs = siteLogs.data;
  state.rentals = rentals.data;
  state.materials = materials.data;
  state.sitePayments = sitePayments.data;
  state.siteCosts = [
    ...labourCosts(state.siteLogs, DAY_WORKER_KEY),
    ...guardCosts(state.siteLogs, GUARD_KEY),
    ...rentalCosts(state.rentals),
    ...materialCosts(state.materials),
  ];
  renderScheduleViews();
}

function renderScheduleViews() {
  renderSchedule();
  renderWeek();
  renderComingUp();
  renderCosts();
  renderFinance();
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
  if (s.key === 'closed') {
    return `<span class="status-chip status-handed" title="Not done when the project ended">Not done · project closed · ${Math.round(completionOf(task) * 100)}%</span>`;
  }
  return '<span class="status-chip status-pending">Upcoming</span>';
}

// Where the project stands, in words - behind also when anything is overdue
// or the pace so far finishes late (see planVerdict).
const PLAN_WORDS = { behind: 'Behind plan', ahead: 'Ahead of plan', on_track: 'On track', closed: 'Project closed' };
function projectVerdict(p) {
  const project = currentProject();
  // An ended project is not behind or ahead of anything any more.
  if (project?.closed_how) return { key: 'closed', gap: 0, late: false };
  return planVerdict(p, {
    tasks: state.tasks, startDate: project?.start_date, endDate: project?.end_date, todayIso: todayISO(),
  });
}

/** Why an item's finish moved: the causes of the delays that held it up. */
const extendedBy = (taskId) => [...new Set(state.delayImpacts
  .filter((i) => i.task_id === taskId && i.delay)
  .map((i) => i.delay.delay_cause))];

/**
 * The finish an item is held to. Once a delay has held it up, the date the
 * programme promised stays on show, struck through, above the one it has
 * been extended to - so nobody mistakes the new date for the old.
 */
function finishCell(t) {
  const ext = Number(t.extension_days) || 0;
  if (!ext) return esc(formatDate(t.planned_finish));
  const why = extendedBy(t.id).join(', ');
  return `<span class="finish-was">${esc(formatDate(t.planned_finish))}</span>
    <span class="finish-extended" title="Extended by delays: ${esc(why)}">${esc(formatDate(dueDate(t)))}
      <span class="finish-ext-days">+${ext} d</span></span>`;
}

function renderSchedule() {
  const today = scheduleDay(currentProject(), todayISO());
  const p = scheduleProgress(state.tasks, today);
  state.progress = p;
  updateProgressKpi();

  const verdict = projectVerdict(p);
  $('#schedule-summary').innerHTML = [
    statTile('Progress', `${p.actualPct}%`, `${p.doneCount} of ${p.count} items done`),
    statTile('Planned by today', `${p.plannedPct}%`,
      !p.count ? '-' : `${PLAN_WORDS[verdict.key]}${verdict.late ? ' · finishing late at this pace' : ''}`,
      p.count && verdict.key === 'behind' ? 'negative' : ''),
    statTile('Overdue', String(p.overdue.length),
      p.overdue.length ? `Longest: ${p.overdue[0].daysLate} days late` : 'Nothing overdue', p.overdue.length ? 'negative' : ''),
    statTile('Remaining', `${100 - p.actualPct}%`, `${p.count - p.doneCount} items left`),
  ].join('');

  if (!state.tasks.length) {
    $('#schedule-table').innerHTML = '<div class="empty-state">No items yet.</div>';
    return;
  }

  const rows = state.tasks.map((t) => {
    const s = taskState(t, today);
    // What the dates say should be done by today - a guide when the real figure
    // is hard to measure, and a nudge when nobody has updated it.
    const donePct = Math.round(completionOf(t) * 100);
    const plan = expectedPct(t, today);
    const showPlan = !t.done && !t.closed && donePct < 100 && today >= t.planned_start;
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
        <td class="task-name">${taskNameHtml(t)}</td>
        <td>
          <select class="select-dark select-inline select-contractor" data-task-contractor="${esc(t.id)}"
                  title="${esc(contractorName(t.contractor_id) || 'No contractor')}"
                  aria-label="Contractor for ${esc(t.name)}">${contractorOptions(t.contractor_id ?? '')}</select>
        </td>
        <td class="whitespace-nowrap">${esc(formatDate(t.planned_start))}</td>
        <td class="whitespace-nowrap">${finishCell(t)}</td>
        <td class="num">${durationDays(t)} d</td>
        <td class="num">${Number(t.budget) ? money.format(t.budget) : '-'}</td>
        <td class="whitespace-nowrap">${taskStateChip(t, s)}</td>
        <td class="text-right whitespace-nowrap">
          <button type="button" class="table-action" data-task-work="${esc(t.id)}" title="Work done on this item - for work in no room, like a pour or the facade">Work${
            taskWorkCount(t.id) ? ` (${taskWorkCount(t.id)})` : ''}</button>
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
        ${esc(inLang(c.name, c.name_ka))}${c.trade ? ` · ${esc(c.trade)}` : ''}
      </option>`).join('');
}

function updateTaskDuration() {
  const f = $('#form-task').elements;
  const start = f.planned_start.value;
  const finish = f.planned_finish.value;
  // The extension rides on whatever finish is typed here. Say so, or the date
  // in the box reads as the one the item is held to.
  const ext = Number(state.tasks.find((t) => t.id === f.id.value)?.extension_days) || 0;
  $('#task-duration').textContent = start && finish
    ? (finish < start ? 'Finish is before start.' : `${durationDays({ planned_start: start, planned_finish: finish })} days`
      + (ext ? ` · plus ${ext} d from delays that held it up - due ${formatDate(addDays(finish, ext))}` : ''))
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
    f.material_budget.value = Number(task.material_budget) ? task.material_budget : '';
    f.employer_price.value = Number(task.employer_price) ? task.employer_price : '';
  } else {
    // Start the day after the last item, else at the project start, else today.
    const last = state.tasks.reduce((max, t) => (t.planned_finish > max ? t.planned_finish : max), '');
    const start = last ? addDays(last, 1) : (currentProject()?.start_date ?? todayISO());
    f.planned_start.value = start;
    f.planned_finish.value = addDays(start, 6);
  }
  updateTaskDuration();
  // Only a project built for an employer is paid by the item.
  $('#task-income').classList.toggle('hidden', incomeFrom(currentProject()) !== 'contract');
  updateTaskMargin();
  openModal('modal-task');
  f.name_ka.focus();
}

/**
 * Leaving one name field with the other still empty fills the other in with
 * Gemini's translation, there and then, so it can be checked and corrected
 * before the item is saved.
 */
async function onTaskNameChange(e) {
  const f = e.currentTarget.elements;
  if (e.target !== f.name && e.target !== f.name_ka) return;
  const other = e.target === f.name ? f.name_ka : f.name;
  const text = e.target.value.trim();
  // "კედელი / Wall" typed into one field: each half goes to its own.
  const both = splitBilingual(text);
  if (both && (!other.value.trim() || other.value.trim() === text)) {
    f.name_ka.value = both.ka;
    f.name.value = both.en;
    return;
  }
  if (!text || other.value.trim()) return;
  const row = e.target === f.name_ka ? { name: text, name_ka: text } : { name: text, name_ka: null };
  const placeholder = other.placeholder;
  other.placeholder = 'Translating…';
  const err = await translateNames([row]);
  other.placeholder = placeholder;
  // Typed into in the meantime, or the source changed: leave it.
  if (err || other.value.trim() || e.target.value.trim() !== text) return;
  other.value = e.target === f.name_ka ? row.name : row.name_ka;
}

// Dates → duration hint; quantity × rate → budget.
function onTaskInput(e) {
  updateTaskDuration();
  updateTaskMargin();
  if (!['quantity', 'rate'].includes(e.target.name)) return;
  const f = e.currentTarget.elements;
  const qty = parseFloat(f.quantity.value);
  const rate = parseFloat(f.rate.value);
  if (qty >= 0 && rate >= 0) f.budget.value = (Math.round(qty * rate * 100) / 100).toFixed(2);
}

// The item's margin as its prices are typed: the employer's price less its budgets.
function updateTaskMargin() {
  const f = $('#form-task').elements;
  const price = Number(f.employer_price.value || 0);
  const cost = Number(f.budget.value || 0) + Number(f.material_budget.value || 0);
  const el = $('#task-margin');
  if (!price) {
    el.textContent = 'What the employer pays your client for this item. Less the contract and materials budgets, it is the item\'s margin.';
    return;
  }
  const margin = price - cost;
  el.innerHTML = `Margin: <span class="${margin < 0 ? 'variance-over' : 'variance-under'}">${esc(moneyOwn.format(margin))}</span>`
    + ` (${(margin / price * 100).toFixed(1)}% of the price)${margin < 0 ? ' - this item loses money' : ''}.`;
}

async function saveTask(e) {
  e.preventDefault();
  const form = e.currentTarget;
  const btn  = $('[type=submit]', form);
  const fd   = new FormData(form);

  const id = fd.get('id');
  // Either language will do; the English column falls back to the Georgian
  // text until a translation fills it (see translateNames below).
  let nameKa = fd.get('name_ka').trim();
  let nameEn = fd.get('name').trim();
  for (const cell of [nameKa, nameEn]) {
    const both = splitBilingual(cell);
    if (!both) continue;
    if (!nameKa || nameKa === cell) nameKa = both.ka;
    if (!nameEn || nameEn === cell) nameEn = both.en;
  }
  if (!nameKa && !nameEn) {
    showFormError(form, 'Enter the activity in Georgian or English.');
    return;
  }
  const oneLanguage = !nameKa || !nameEn;
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
    material_budget: Number(fd.get('material_budget') || 0),
    employer_price: Number(fd.get('employer_price') || 0),
  };
  if (row.planned_finish < row.planned_start) {
    showFormError(form, 'Planned finish must be on or after the planned start.');
    return;
  }

  showFormError(form, '');
  setBusy(btn, true, oneLanguage ? 'Translating…' : 'Saving…');
  const untranslated = oneLanguage ? await translateNames([row]) : '';
  btn.textContent = 'Saving…';
  const { error } = id
    ? await db.from('schedule_tasks').update(row).eq('id', id)
    : await db.from('schedule_tasks').insert({ ...row, project_id: state.projectId });
  setBusy(btn, false);

  if (error) {
    showFormError(form, error.message);
    return;
  }

  closeModal('modal-task');
  if (untranslated) {
    toast(`${id ? 'Item updated' : 'Item added'} in one language - Gemini couldn't translate it: ${untranslated}`, 'error');
  } else {
    toast(id ? 'Item updated.' : 'Item added.', 'success');
  }
  loadSchedule(state.projectId);
}

/**
 * Fills in the missing language of names written in one: rows of
 * { name, name_ka }, changed in place. Georgian-only rows have name ===
 * name_ka, English-only ones no name_ka; the text that was written is kept
 * exactly, and only the other language is added. Returns an error message, or
 * '' - a row Gemini didn't reach keeps the one language it has, so it can
 * still be saved.
 */
async function translateNames(rows) {
  const todo = rows.filter((r) => r.name && (!r.name_ka || r.name === r.name_ka));
  for (let i = 0; i < todo.length; i += 100) {
    const chunk = todo.slice(i, i + 100);
    const { data, error } = await db.functions.invoke('translate-names', {
      body: { names: chunk.map((r) => r.name_ka || r.name) },
    });
    if (error) return functionErrorMessage(error);
    chunk.forEach((r, j) => {
      const { ka, en } = data.items[j];
      if (r.name_ka) r.name = en;
      else r.name_ka = ka;
    });
  }
  return '';
}

async function deleteTask(taskId) {
  const task = state.tasks.find((t) => t.id === taskId);
  const payments = state.payments.filter((p) => p.task_id === taskId).length;
  const bought = state.materials.filter((m) => m.task_id === taskId).length;
  const extra = [
    payments ? `\n\nIts ${payments} payment(s) will be deleted too.` : '',
    bought ? `\n\nIts ${bought} material purchase(s) are kept, as general materials.` : '',
  ].join('');
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
  if (document.body.classList.contains('read-only')) return; // keyboard can still reach the fields
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
  if (pay) return openPaymentsModal(pay.dataset.taskPayments);

  const work = e.target.closest('[data-task-work]');
  if (work) openTaskWork(work.dataset.taskWork);
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
      .select('id, delay_cause, duration_days, resolved_on, description, description_en, created_at, flat_id, cause_contractor_id, flats(block, flat_number), impacts:delay_impacts(task_id)')
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
  $('#kpi-delays-meta').textContent = `${areaFormat.format(days)} ${days === 1 ? 'day' : 'days'} lost`
    + (stillOpen ? ` · ${stillOpen} ongoing` : '');

  state.delays = delays.data;
  loadLatestPhotos(projectId);
  renderRecentLogs(logs.data);
  renderRecentDelays(delays.data.slice(0, 5));
  await loadDelayPhotos();
  renderDelays();
}

// ---------- The week at a glance (top of the dashboard) ----------
// What a client opens the app for: what happened on site this week, what is
// coming, and the latest photos.
const DAY_MS_APP = 86_400_000;
const isoMinus = (iso, days) => new Date(new Date(`${iso}T00:00`).getTime() - days * DAY_MS_APP).toLocaleDateString('en-CA');
const isoPlus = (iso, days) => isoMinus(iso, -days);

function renderWeek() {
  const el = $('#dash-week');
  if (!el || !state.projectId) return;
  const end = scheduleDay(currentProject(), todayISO());
  const from = isoMinus(end, 6);
  const inWeek = (d) => d && d >= from && d <= end;
  const logs = state.siteLogs.filter((l) => inWeek(l.log_date));
  const workers = logs.map((l) => (l.crew ?? []).reduce((n, c) => n + (Number(c.workers) || 0), 0));
  const avg = workers.length ? Math.round(workers.reduce((a, b) => a + b, 0) / workers.length) : 0;
  const finished = state.tasks.filter((t) => t.done && inWeek(t.done_at));

  // Each kind of work done this week, added up, with who did it.
  const kinds = new Map();
  for (const w of state.work.filter((x) => inWeek(x.work_date))) {
    const key = workTagKey(w);
    const k = kinds.get(key) ?? { name: w.work || w.work_en, en: w.work_en, qty: new Map(), who: new Set(), days: new Set() };
    if (w.quantity != null) k.qty.set(w.unit ?? '', (k.qty.get(w.unit ?? '') ?? 0) + Number(w.quantity));
    if (workBy(w)) k.who.add(workBy(w));
    k.days.add(w.work_date);
    kinds.set(key, k);
  }
  const list = [...kinds.values()].sort((a, b) => b.days.size - a.days.size).slice(0, 8);

  if (!logs.length && !list.length && !finished.length) {
    el.innerHTML = '<p class="text-slate-500">Nothing recorded this week.</p>';
    return;
  }
  el.innerHTML = `
    <div class="week-stats">
      <div><b>${logs.length}</b><span>days logged</span></div>
      <div><b>${avg}</b><span>workers a day</span></div>
      <div><b>${finished.length}</b><span>items finished</span></div>
    </div>
    ${list.length ? `<ul class="week-list">${list.map((k) => `
      <li><span class="text-white">${esc(inLang(k.en, k.name))}</span>${k.en && k.en !== k.name ? ` <span class="text-slate-500">${esc(inLang(k.name, k.en))}</span>` : ''}
        <span class="text-slate-400">· ${k.qty.size ? esc([...k.qty].map(([u, q]) => `${qtyFormat.format(q)}${u ? ` ${u}` : ''}`).join(' · ')) : 'in progress'}${
          k.who.size ? ` · ${esc([...k.who].join(', '))}` : ''}</span></li>`).join('')}</ul>` : ''}
    ${finished.length ? `<p class="mt-2 text-xs text-slate-500">Finished: ${finished.map((t) => esc(taskName(t))).join(', ')}</p>` : ''}`;
}

function renderComingUp() {
  const el = $('#dash-next');
  if (!el || !state.projectId) return;
  if (currentProject()?.closed_how) {
    el.innerHTML = '<p class="text-slate-500">The project has ended.</p>';
    return;
  }
  const today = todayISO();
  const horizon = isoPlus(today, 14);
  // Starting in the next two weeks, or due in them and not done.
  const next = state.tasks
    .filter((t) => !t.done && ((t.planned_start >= today && t.planned_start <= horizon) || (dueDate(t) >= today && dueDate(t) <= horizon)))
    .sort((a, b) => (a.planned_start >= today ? a.planned_start : dueDate(a)).localeCompare(b.planned_start >= today ? b.planned_start : dueDate(b)))
    .slice(0, 7);
  if (!next.length) {
    el.innerHTML = '<p class="text-slate-500">Nothing starts or is due in the next two weeks.</p>';
    return;
  }
  el.innerHTML = `<ul class="week-list">${next.map((t) => {
    const starting = t.planned_start >= today;
    return `<li><span class="text-white">${esc(taskName(t))}</span>
      <span class="text-slate-400">· ${starting ? `starts ${esc(formatDate(t.planned_start))}` : `due ${esc(formatDate(dueDate(t)))} · ${Math.round(completionOf(t) * 100)}%`}${
        t.contractor_id ? ` · ${esc(contractorName(t.contractor_id))}` : ''}</span></li>`;
  }).join('')}</ul>`;
}

// The newest photos on the project, tapped to see them full size.
let latestPhotos = { thumbs: [], full: [] };
async function loadLatestPhotos(projectId) {
  const el = $('#dash-photos');
  const { data, error } = await db.from('photos')
    .select('id, daily_log_id, delay_id, path, thumb_path, created_at')
    .eq('project_id', projectId)
    .order('created_at', { ascending: false })
    .limit(8);
  if (projectId !== state.projectId || error) return;
  if (!data.length) {
    el.innerHTML = '<p class="text-slate-500">No photos yet.</p>';
    return;
  }
  const [thumbs, full] = await Promise.all([signPhotos(db, data), signPhotos(db, data, { full: true })]);
  if (projectId !== state.projectId) return;
  latestPhotos = { thumbs: data.map((ph) => thumbs.get(ph.id)), full: data.map((ph) => full.get(ph.id)) };
  el.innerHTML = `<div class="latest-photos">${data.map((ph, i) => (thumbs.get(ph.id)
    ? `<button type="button" data-latest-photo="${i}"><img src="${esc(thumbs.get(ph.id))}" alt="" loading="lazy"></button>` : '')).join('')}</div>`;
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
  // Every held-up item loses the delay's own days, so the figure is said once.
  const days = delayDaysLost(delay);
  const byContractor = new Map();
  for (const i of impacts) {
    const task = state.tasks.find((t) => t.id === i.task_id);
    const who = task?.contractor_id ? contractorName(task.contractor_id) : 'No contractor';
    if (!byContractor.has(who)) byContractor.set(who, []);
    byContractor.get(who).push(task ? taskName(task) : 'Item removed');
  }
  return [...byContractor].map(([who, items]) => `
    <p class="text-xs"><span class="text-white">${esc(who)}</span>
      <span class="text-sky-300">${days} d</span>
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
    $('#delays-table').innerHTML = '<div class="empty-state">No delays yet.</div>';
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
          ${inLang(d.description_en, d.description) ? `<p>${esc(inLang(d.description_en, d.description))}</p>` : ''}
          ${inLang(d.description, d.description_en) !== inLang(d.description_en, d.description) ? `<p class="text-slate-500">${esc(inLang(d.description, d.description_en))}</p>` : ''}
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
    const text = [where, inLang(d.description_en, d.description)].filter(Boolean).join(' - ');
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
    // Counted with both ends in, as the daily report's project day is: the
    // first day is day 1, and Aug 1 → Jul 31 is 365 days.
    const total = Math.max(1, daysBetween(start, end) + 1);
    const elapsed = Math.min(total, Math.max(0, daysBetween(start, today) + 1));
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
    const verdict = projectVerdict(p);
    const ended = currentProject()?.closed_how;
    chips.push(ended
      ? { cls: ended === 'completed' ? 'status-done' : 'status-handed', text: CLOSED_HOW[ended].en }
      : verdict.key !== 'behind'
      ? { cls: 'status-done', text: `✓ ${PLAN_WORDS[verdict.key]}` }
      : { cls: verdict.gap >= -15 && !verdict.late ? 'status-in_progress' : 'status-blocked', text: `! ${PLAN_WORDS.behind}` });
    if (p.overdue.length) chips.push({ cls: 'status-blocked', text: `! ${p.overdue.length} overdue` });
  }

  const overdueList = p.overdue.length ? `
    <ul class="mt-3 space-y-1 text-xs">
      ${p.overdue.slice(0, 3).map((t) => `
        <li class="text-rose-300">! ${esc(taskName(t))} - ${t.daysLate} days past its finish date</li>`).join('')}
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
  f.income_from.value = incomeFrom(project) ?? '';
  f.price_per_m2.value = project.price_per_m2 ?? '';
  f.finance_in_report.checked = project.finance_in_report !== false;
  f.closed_how.value = project.closed_how ?? '';
  f.closed_on.value = project.closed_on ?? '';
  f.closed_note.value = project.closed_note ?? '';
  syncIncomeFields();
  syncClosedFields();
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
    has_rooms: fd.has('has_rooms') || fd.get('income_from') === 'sales',
    day_rate: fd.get('day_rate') === '' ? null : Number(fd.get('day_rate')),
    guard_rate: fd.get('guard_rate') === '' ? null : Number(fd.get('guard_rate')),
    retention_pct: Number(fd.get('retention_pct') || 0),
    finance_in_report: fd.has('finance_in_report'),
    income_from: fd.get('income_from') || null,
    price_per_m2: numOrNull(fd.get('price_per_m2')),
    closed_how: fd.get('closed_how') || null,
    closed_on: fd.get('closed_how') ? fd.get('closed_on') || todayISO() : null,
    closed_note: fd.get('closed_how') ? fd.get('closed_note').trim() || null : null,
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
  syncCurrencySwitch();
  renderTimeline();
  renderScheduleViews();           // amounts in the (possibly new) currency
  renderUnits();                   // sale columns come and go with Income from
  loadSchedule(project.id);        // an ended project reads its items as of the day it ended
}

// An ended project has the day it ended and, if wanted, a word on why.
function syncClosedFields() {
  const f = $('#form-edit-project').elements;
  const ended = Boolean(f.closed_how.value);
  $('#edit-closed-on').classList.toggle('hidden', !ended);
  $('#edit-closed-note').classList.toggle('hidden', !ended);
  f.closed_on.max = todayISO();
  if (ended && !f.closed_on.value) f.closed_on.value = todayISO();
}

// A price per m² only prices rooms for sale.
function syncIncomeFields() {
  const form = $('#form-edit-project');
  $('#edit-price-m2').classList.toggle('hidden', form.elements.income_from.value !== 'sales');
  syncRoomsTick(form);
}

// A project that sells what it builds sells rooms, so it has them: the tick is
// set and locked. One built for an employer may or may not have rooms.
// (A locked box is not sent with the form - saving counts it in by income_from.)
function syncRoomsTick(form) {
  const f = form.elements;
  const selling = f.income_from.value === 'sales';
  if (selling) f.has_rooms.checked = true;
  f.has_rooms.disabled = selling;
  f.has_rooms.closest('label').title = selling ? 'A project that sells its flats always has rooms' : '';
}

// =============================================================
// BOQ & cash flow - built from timetable items and their payments
// =============================================================
const qtyFormat = spaced(new Intl.NumberFormat('en-US', { maximumFractionDigits: 3 }));
const sumOf = (items, key) => items.reduce((sum, i) => sum + Number(i[key] || 0), 0);
const monthLabel = (ym) => (isKa
  ? `${MONTHS_KA[Number(ym.slice(5, 7)) - 1]} ${ym.slice(0, 4)}`
  : new Date(`${ym}-01T00:00`).toLocaleDateString(dateLocale, { month: 'short', year: 'numeric' }));

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
    : 'No budgets yet';
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
    c.material ? `materials ${money.format(c.material)}` : '',
  ].filter(Boolean).join(' · ');
  const contractTotal = sumOf(state.tasks, 'budget');
  const materialBudget = sumOf(state.tasks, 'material_budget');
  $('#cash-summary').innerHTML = [
    statTile('Budget', money.format(c.budget), materialBudget
      ? `Contracts ${money.format(contractTotal)} + materials ${money.format(materialBudget)}`
      : `${state.tasks.filter((t) => budgetOf(t)).length} priced items`),
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
    const over = c.contracts - c.earnedWork;
    lines.push(over > 0.5
      ? `Cost: ${money.format(over)} more has been paid to contractors than the value of work done (advances or overspend).`
      : `Cost: contract payments are ${money.format(-over)} below the value of work done.`);
  }
  if (c.labour || c.guard || c.rental || c.material) {
    const extra = [
      c.labour ? `${money.format(c.labour)} on daily workers` : '',
      c.guard ? `${money.format(c.guard)} on guards` : '',
      c.rental ? `${money.format(c.rental)} on equipment rentals` : '',
      c.material ? `${money.format(c.material)} on materials${materialBudget ? ` (of ${money.format(materialBudget)} planned)` : ''}` : '',
    ].filter(Boolean).join(', ');
    lines.push(`On top of contracts: ${extra} so far.`);
  }
  const owed = owedNow();
  const owedParts = [
    owed.labour > 0.5 ? `daily workers ${money.format(owed.labour)}` : '',
    owed.guard > 0.5 ? `guards ${money.format(owed.guard)}` : '',
    owed.rental > 0.5 ? `rentals ${money.format(owed.rental)}` : '',
    owed.material > 0.5 ? `materials on credit ${money.format(owed.material)}` : '',
  ].filter(Boolean);
  if (owedParts.length) {
    const all = owed.labour + owed.guard + owed.rental + owed.material;
    lines.push(`Still owed: ${money.format(all)} - ${owedParts.join(', ')}.`);
  }
  $('#cash-position').textContent = lines.join(' ');

  renderLabour();
  renderGuards();
  renderRentals();
  renderMaterials();

  // ---- BOQ table ----
  if (!state.tasks.length) {
    $('#boq-table').innerHTML = '<div class="empty-state">No items yet.</div>';
  } else {
    const rows = state.tasks.map((t) => {
      const budget = Number(t.budget || 0);
      const paid = paidOn(t.id);
      // Retention is earned but held back: it is not work left to pay for.
      const held = sumOf(state.payments.filter((p) => p.task_id === t.id), 'retention');
      const left = budget - paid - held;
      const matBudget = Number(t.material_budget || 0);
      const bought = materialsOn(t.id);
      const qty = t.quantity != null
        ? `${qtyFormat.format(t.quantity)} ${esc(t.unit || '')}${t.rate != null ? ` × ${money2.format(t.rate)}` : ''}`
        : '<span class="text-slate-500">-</span>';
      return `
        <tr>
          <td class="task-name">${taskNameHtml(t)}</td>
          <td>${t.contractor_id ? esc(contractorName(t.contractor_id)) : '<span class="text-slate-500">-</span>'}</td>
          <td class="num">${qty}</td>
          <td class="num">${budget ? money.format(budget) : '-'}</td>
          <td class="num">${paid ? money.format(paid) : '-'}${held
            ? `<span class="block text-xs text-slate-500">+ ${money.format(held)} retention held</span>` : ''}</td>
          <td class="num">${!budget ? '-' : left < 0
            ? `<span class="variance-over">${money.format(-left)} over</span>`
            : money.format(left)}</td>
          <td class="num">${materialsCell(bought, matBudget)}</td>
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
            <th>Work item</th><th>Contractor</th><th class="num">Qty × rate</th><th class="num">Contract</th>
            <th class="num">Paid</th><th class="num">Left to pay</th><th class="num">Materials</th><th>Status</th><th></th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
        <tfoot>
          <tr>
            <td colspan="3">Total</td>
            <td class="num">${money.format(contractTotal)}</td>
            <td class="num">${money.format(sumOf(state.payments, 'amount'))}</td>
            <td class="num">${money.format(contractTotal - sumOf(state.payments, 'amount') - sumOf(state.payments, 'retention'))}</td>
            <td class="num">${materialsCell(sumOf(state.materials.filter((m) => m.task_id), 'amount'), materialBudget)}</td>
            <td colspan="2"></td>
          </tr>
        </tfoot>
      </table>`;
  }

  // ---- Monthly cash flow: planned budget vs everything actually spent ----
  const planned = plannedSpendByMonth(state.tasks);
  const actual = actualSpendByMonth(state.payments);
  const site = siteCostsByMonth(state.siteCosts, today);
  // Money in by month, for the balance.
  const moneyIn = new Map();
  for (const m of state.moneyIn) moneyIn.set(m.received_on.slice(0, 7), (moneyIn.get(m.received_on.slice(0, 7)) ?? 0) + Number(m.amount));
  const months = [...new Set([...planned.keys(), ...actual.keys(), ...site.keys(), ...moneyIn.keys()])].sort();
  if (!months.length) {
    $('#cashflow-months').innerHTML = '<div class="empty-state">Nothing recorded yet.</div>';
    return;
  }

  const thisMonth = today.slice(0, 7);
  const cell = (v) => (v ? money.format(v) : '<span class="text-slate-500">-</span>');
  let cumPlanned = 0;
  let cumSpent = 0;
  let cumIn = 0;
  const showIn = state.moneyIn.length > 0;
  const totals = { p: 0, a: 0, labour: 0, guard: 0, rental: 0, material: 0, in: 0 };
  const monthRows = months.map((ym) => {
    const p = planned.get(ym) ?? 0;
    const a = actual.get(ym) ?? 0;
    const { labour = 0, guard = 0, rental = 0, material = 0 } = site.get(ym) ?? {};
    const spent = a + labour + guard + rental + material;
    const got = moneyIn.get(ym) ?? 0;
    cumPlanned += p;
    cumSpent += spent;
    cumIn += got;
    totals.in += got;
    totals.p += p;
    totals.a += a;
    totals.labour += labour;
    totals.guard += guard;
    totals.rental += rental;
    totals.material += material;
    return `
      <tr class="${ym === thisMonth ? 'is-current' : ''}">
        <td>${esc(monthLabel(ym))}${ym === thisMonth ? ' <span class="text-xs text-brand-400">· this month</span>' : ''}</td>
        <td class="num">${money.format(p)}</td>
        <td class="num">${cell(a)}</td>
        <td class="num">${cell(labour)}</td>
        <td class="num">${cell(guard)}</td>
        <td class="num">${cell(rental)}</td>
        <td class="num">${cell(material)}</td>
        <td class="num font-semibold text-white">${cell(spent)}</td>
        <td class="num">${money.format(cumPlanned)}</td>
        <td class="num">${ym <= thisMonth ? money.format(cumSpent) : '-'}</td>
        ${showIn ? `<td class="num">${cell(got)}</td>
        <td class="num">${ym <= thisMonth ? `<span class="${cumIn - cumSpent < 0 ? 'variance-over' : ''}">${money.format(cumIn - cumSpent)}</span>` : '-'}</td>` : ''}
      </tr>`;
  }).join('');

  $('#cashflow-months').innerHTML = `
    <table class="data-table">
      <thead>
        <tr>
          <th>Month</th><th class="num">Planned</th><th class="num">Contracts paid</th><th class="num">Daily workers</th>
          <th class="num">Guards</th><th class="num">Rentals</th><th class="num">Materials</th><th class="num">Total spent</th>
          <th class="num">Cumulative planned</th><th class="num">Cumulative spent</th>
          ${showIn ? '<th class="num">Money in</th><th class="num">Balance</th>' : ''}
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
          <td class="num">${money.format(totals.material)}</td>
          <td class="num">${money.format(totals.a + totals.labour + totals.guard + totals.rental + totals.material)}</td>
          <td colspan="2"></td>
          ${showIn ? `<td class="num">${money.format(totals.in)}</td><td></td>` : ''}
        </tr>
      </tfoot>
    </table>`;
}

// =============================================================
// Finance - what the project earns against what it costs
// Income is the employer's price for each item (plus what the employer pays
// for approved variations), or the rooms' sale prices. Cost is the forecast
// of the final cost plus loan interest (see finance.js). Money in - income
// and funding - gives the cash position; funding is never profit.
// =============================================================
const pctFormat = (part, whole) => (whole ? `${(part / whole * 100).toFixed(1)}%` : '-');

function renderFinance() {
  const project = currentProject();
  if (!project) return;
  const source = incomeFrom(project);

  const today = todayISO();
  const fin = financePosition({
    project, tasks: state.tasks, rooms: state.flats, variations: state.variations, materials: state.materials,
    payments: state.payments, siteCosts: state.siteCosts, moneyIn: state.moneyIn, today,
  });
  const { sales, items, income, cost, profit, forecast } = fin;
  const spentSoFar = costPosition(state.tasks, state.payments, today, state.siteCosts).spent;
  const received = fin.received.income + fin.received.funding;

  // Always: what it will cost, the cash, and what came in.
  renderForecast(fin);
  renderMoneyIn();

  const over = forecast.total - forecast.budget;
  const cashTiles = [
    statTile('Money in so far', money.format(received),
      `income ${money.format(fin.received.income)} · funding ${money.format(fin.received.funding)}`),
    statTile('Paid out so far', money.format(spentSoFar), 'Contracts, workers, guards, rentals, purchases'),
    statTile('Cash balance now', money.format(received - spentSoFar), received ? 'Money in − paid out' : 'Add money in to see it',
      received - spentSoFar < 0 ? 'negative' : ''),
  ];

  if (!source) {
    $('#finance-summary').innerHTML = [
      statTile('Forecast final cost', money.format(forecast.total + fin.interest),
        forecast.budget ? `${money.format(Math.abs(over))} ${over > 0 ? 'over' : 'under'} budget` : 'No budgets yet', over > 0.5 ? 'negative' : ''),
      ...cashTiles,
    ].join('');
    $('#finance-position').textContent = '';
    $('#finance-detail').innerHTML = `
      <div class="panel"><div class="empty-state">
        No income source chosen yet.
      </div></div>`;
    return;
  }

  // Still to come in: earned from the employer but not paid, or sold but not collected.
  const due = sales
    ? Math.max(0, sales.sold.amount - fin.received.buyer)
    : Math.max(0, fin.earned + fin.variationIncome - fin.received.employer);
  const incomeMeta = sales
    ? `${sales.sold.count} sold · ${sales.reserved.count} reserved · ${sales.forSale.count} for sale`
    : `Employer's prices${fin.variationIncome ? ` + variations ${money.format(fin.variationIncome)}` : ''} · ${money.format(fin.earned)} earned by the work done`;
  $('#finance-summary').innerHTML = [
    statTile('Income', money.format(income), incomeMeta),
    statTile('Forecast final cost', money.format(cost),
      forecast.budget ? `${money.format(Math.abs(over))} ${over > 0 ? 'over' : 'under'} budget${fin.interest ? ` · interest ${money.format(fin.interest)}` : ''}` : 'No budgets yet',
      over > 0.5 ? 'negative' : ''),
    statTile(profit < 0 ? 'Expected loss' : 'Expected profit', money.format(profit), 'Income − forecast cost',
      profit < 0 ? 'negative' : profit > 0 ? 'positive' : ''),
    statTile('Margin', pctFormat(profit, income), income ? 'Of income' : 'No income entered yet',
      profit < 0 ? 'negative' : ''),
    ...cashTiles,
    statTile(sales ? 'Still to collect' : 'Due from the employer', money.format(due),
      sales ? 'Sold, not yet paid by buyers' : 'Earned by the work done, not yet paid'),
  ].join('');

  // What the figures leave out, so the profit is read for what it is.
  const lines = [];
  if (sales && sales.unpriced) {
    lines.push(`${sales.unpriced} room${sales.unpriced === 1 ? ' has' : 's have'} no price, so ${sales.unpriced === 1 ? 'it adds' : 'they add'} nothing to income - give ${sales.unpriced === 1 ? 'it' : 'them'} an asking price or set a price per m² in Edit Project.`);
  }
  if (sales && sales.forSale.amount + sales.reserved.amount > 0.5) {
    lines.push(`${money.format(sales.forSale.amount + sales.reserved.amount)} of the income is rooms not sold yet, at their asking prices.`);
  }
  if (!sales) {
    const unpriced = items.filter((i) => !i.income && i.cost).length;
    const losing = items.filter((i) => i.income && i.margin < 0);
    const unpaidChanges = state.variations.filter((v) => v.status === 'approved' && Number(v.amount) && !Number(v.employer_amount)).length;
    if (unpriced) lines.push(`${unpriced} item${unpriced === 1 ? ' has' : 's have'} a budget but no employer's price, so ${unpriced === 1 ? 'it counts' : 'they count'} as cost with no income.`);
    if (losing.length) lines.push(`${losing.length} item${losing.length === 1 ? ' loses' : 's lose'} money: ${money.format(-sumOf(losing, 'margin'))} in all.`);
    if (unpaidChanges) lines.push(`${unpaidChanges} approved variation${unpaidChanges === 1 ? ' has' : 's have'} no employer's amount - add it on the Variations page if the employer pays for it.`);
  }
  if (forecast.pendingVariations) lines.push(`Variations not yet decided would add ${money.format(forecast.pendingVariations)} to the cost if approved.`);
  $('#finance-position').textContent = lines.join(' ');

  $('#finance-detail').innerHTML = sales ? salesDetail(sales, cost) : marginDetail(items);
}

// Budget against forecast, line by line.
function renderForecast(fin) {
  const f = fin.forecast;
  const contractBudget = sumOf(state.tasks, 'budget');
  const materialBudget = sumOf(state.tasks, 'material_budget');
  const dash = '<span class="text-slate-500">-</span>';
  const line = (label, budget, value, note = '') => `
    <tr>
      <td>${esc(label)}${note ? `<span class="block text-xs text-slate-500">${esc(note)}</span>` : ''}</td>
      <td class="num">${budget == null ? dash : money.format(budget)}</td>
      <td class="num">${money.format(value)}</td>
      <td class="num">${budget == null || Math.abs(value - budget) < 0.5 ? dash
        : `<span class="${value > budget ? 'variance-over' : 'variance-under'}">${value > budget ? '+' : '−'}${money.format(Math.abs(value - budget))}</span>`}</td>
    </tr>`;
  const total = f.total + fin.interest;
  $('#finance-forecast').innerHTML = `
    <table class="data-table">
      <thead><tr><th>Cost</th><th class="num">Budget</th><th class="num">Forecast</th><th class="num">Difference</th></tr></thead>
      <tbody>
        ${line('Contracts', contractBudget, f.contracts, 'Each item at its budget, or what it was paid when more')}
        ${line('Materials', materialBudget, f.materials, 'Each item at its materials budget, or what was bought when more')}
        ${line('Approved variations', null, f.variations)}
        ${line('Daily workers, guards and rentals', null, f.siteSoFar + f.siteToCome,
    f.siteToCome ? `${money.format(f.siteSoFar)} so far + ${money.format(f.siteToCome)} to completion at the same rate` : 'So far')}
        ${line('Purchases for the site', null, f.unbudgeted)}
        ${line('Loan interest', null, fin.interest, fin.interest ? `${money.format(fin.interestSoFar)} so far` : 'No loans with a rate')}
      </tbody>
      <tfoot>${line('Total', f.budget, total)}</tfoot>
    </table>`;
}

// ---------- Money in ----------
const MONEY_IN_KINDS = {
  employer: 'Employer payment',
  buyer: 'Buyer payment',
  loan: 'Loan draw',
  own: "Client's own money",
  partner: 'Partner',
};

async function loadMoneyIn(projectId) {
  const { data, error } = await db.from('money_in')
    .select('id, kind, received_on, amount, from_name, certificate_no, flat_id, interest_pct, note')
    .eq('project_id', projectId)
    .order('received_on');
  if (projectId !== state.projectId) return;
  if (error) {
    toast(`Could not load money in: ${error.message}`, 'error');
    return;
  }
  state.moneyIn = data;
  renderFinance();
  renderCosts(); // the monthly cash flow's money in and balance
}

function renderMoneyIn() {
  const el = $('#finance-money-in');
  if (!state.moneyIn.length) {
    el.innerHTML = '<div class="empty-state">Nothing recorded yet.</div>';
    return;
  }
  const rows = [...state.moneyIn].reverse().map((m) => {
    const flat = state.flats.find((u) => u.id === m.flat_id);
    const detail = [
      m.certificate_no ? `№ ${m.certificate_no}` : '',
      flat ? roomLabel(flat) : '',
      m.interest_pct != null ? `${Number(m.interest_pct)}% a year` : '',
      m.note || '',
    ].filter(Boolean).join(' · ');
    return `
      <tr>
        <td class="whitespace-nowrap">${esc(formatDate(m.received_on))}</td>
        <td><span class="status-chip ${INCOME_KINDS.includes(m.kind) ? 'status-done' : 'status-in_progress'}">${esc(MONEY_IN_KINDS[m.kind])}</span></td>
        <td>${esc(m.from_name || '')}${detail ? `<span class="block text-xs text-slate-500">${esc(detail)}</span>` : ''}</td>
        <td class="num">${money.format(m.amount)}</td>
        <td class="text-right whitespace-nowrap">
          <button type="button" class="table-action" data-money-in-edit="${esc(m.id)}">Edit</button>
          <button type="button" class="table-action is-danger" data-money-in-delete="${esc(m.id)}">Delete</button>
        </td>
      </tr>`;
  }).join('');
  const income = sumOf(state.moneyIn.filter((m) => INCOME_KINDS.includes(m.kind)), 'amount');
  const all = sumOf(state.moneyIn, 'amount');
  el.innerHTML = `
    <table class="data-table">
      <thead><tr><th>Received</th><th>What</th><th>From</th><th class="num">Amount</th><th></th></tr></thead>
      <tbody>${rows}</tbody>
      <tfoot><tr><td colspan="3">Total · income ${esc(money.format(income))} · funding ${esc(money.format(all - income))}</td>
        <td class="num">${money.format(all)}</td><td></td></tr></tfoot>
    </table>`;
}

function syncMoneyInKind() {
  const kind = $('#money-in-kind').value;
  $('#money-in-cert').classList.toggle('hidden', kind !== 'employer');
  $('#money-in-flat').classList.toggle('hidden', kind !== 'buyer' || !state.flats.length);
  $('#money-in-rate').classList.toggle('hidden', kind !== 'loan');
  $('#money-in-from-label').textContent = { employer: 'Employer', buyer: 'Buyer', loan: 'Bank / lender', own: 'From', partner: 'Partner' }[kind];
}

function openMoneyIn(entry = null) {
  if (!requireProject()) return;
  const form = $('#form-money-in');
  const f = form.elements;
  form.reset();
  $('#money-in-title').textContent = entry ? 'Edit money in' : 'Add money in';
  $('#money-in-flat-select').innerHTML = '<option value="">- Not for one room -</option>'
    + state.flats.map((u) => `<option value="${esc(u.id)}">${esc(roomLabel(u))}${u.buyer ? ` · ${esc(u.buyer)}` : ''}</option>`).join('');
  f.id.value = entry?.id ?? '';
  f.kind.value = entry?.kind ?? (incomeFrom(currentProject()) === 'sales' ? 'buyer' : 'employer');
  f.received_on.value = entry?.received_on ?? todayISO();
  f.amount.value = entry?.amount ?? '';
  f.from_name.value = entry?.from_name ?? '';
  f.certificate_no.value = entry?.certificate_no ?? '';
  f.flat_id.value = entry?.flat_id ?? '';
  f.interest_pct.value = entry?.interest_pct ?? '';
  f.note.value = entry?.note ?? '';
  syncMoneyInKind();
  showFormError(form, '');
  openModal('modal-money-in');
}

async function saveMoneyIn(e) {
  e.preventDefault();
  const form = e.currentTarget;
  const btn = $('[type=submit]', form);
  const fd = new FormData(form);
  const kind = fd.get('kind');
  const amount = Number(fd.get('amount'));
  if (!(amount > 0)) {
    showFormError(form, 'Enter the amount received.');
    return;
  }
  const id = fd.get('id');
  const row = {
    kind,
    received_on: fd.get('received_on'),
    amount,
    from_name: fd.get('from_name').trim() || null,
    certificate_no: kind === 'employer' ? fd.get('certificate_no').trim() || null : null,
    flat_id: kind === 'buyer' ? fd.get('flat_id') || null : null,
    interest_pct: kind === 'loan' ? numOrNull(fd.get('interest_pct')) : null,
    note: fd.get('note').trim() || null,
  };
  showFormError(form, '');
  setBusy(btn, true);
  const { error } = id
    ? await db.from('money_in').update(row).eq('id', id)
    : await db.from('money_in').insert({ ...row, project_id: state.projectId });
  setBusy(btn, false);
  if (error) {
    showFormError(form, error.message);
    return;
  }
  closeModal('modal-money-in');
  toast(id ? 'Money in updated.' : 'Money in recorded.', 'success');
  loadMoneyIn(state.projectId);
}

async function onMoneyInClick(e) {
  const edit = e.target.closest('[data-money-in-edit]');
  if (edit) return openMoneyIn(state.moneyIn.find((m) => m.id === edit.dataset.moneyInEdit));
  const del = e.target.closest('[data-money-in-delete]');
  if (!del) return;
  const m = state.moneyIn.find((x) => x.id === del.dataset.moneyInDelete);
  if (!m || !confirm(`Delete ${MONEY_IN_KINDS[m.kind]} of ${money.format(m.amount)} (${formatDate(m.received_on)})?`)) return;
  const { error } = await db.from('money_in').delete().eq('id', m.id);
  if (error) {
    toast(`Could not delete: ${error.message}`, 'error');
    return;
  }
  toast('Money in deleted.', 'success');
  loadMoneyIn(state.projectId);
}

// Contract: each item's price against its cost, the losing ones in red.
function marginDetail(items) {
  if (!items.length) {
    return '<div class="panel"><div class="empty-state">No items yet.</div></div>';
  }
  const dash = '<span class="text-slate-500">-</span>';
  const rows = items.map(({ task: t, income, cost, margin, earned }) => `
    <tr>
      <td class="task-name">${taskNameHtml(t)}</td>
      <td>${t.contractor_id ? esc(contractorName(t.contractor_id)) : dash}</td>
      <td class="num">${income ? money.format(income) : '<span class="text-slate-500">no price</span>'}</td>
      <td class="num">${cost ? money.format(cost) : dash}</td>
      <td class="num">${!income && !cost ? dash
        : `<span class="${margin < 0 ? 'variance-over' : 'variance-under'}">${money.format(margin)}</span>`}</td>
      <td class="num">${income ? pctFormat(margin, income) : dash}</td>
      <td class="num">${earned ? money.format(earned) : dash}</td>
      <td class="text-right whitespace-nowrap">
        <button type="button" class="table-action" data-task-edit="${esc(t.id)}">Edit</button>
      </td>
    </tr>`).join('');
  const income = sumOf(items, 'income');
  const margin = sumOf(items, 'margin');
  return `
    <div class="panel">
      <h2 class="panel-title mb-1">Margin by item</h2>
      <p class="hint text-xs text-slate-500 mb-3">
        Employer's price less the item's budget (contract + materials). Earned = the employer's price × the item's % complete.
      </p>
      <div class="overflow-x-auto">
        <table class="data-table">
          <thead>
            <tr>
              <th>Work item</th><th>Contractor</th><th class="num">Employer's price</th><th class="num">Cost</th>
              <th class="num">Margin</th><th class="num">Margin %</th><th class="num">Earned</th><th></th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
          <tfoot>
            <tr>
              <td colspan="2">Total</td>
              <td class="num">${money.format(income)}</td>
              <td class="num">${money.format(sumOf(items, 'cost'))}</td>
              <td class="num"><span class="${margin < 0 ? 'variance-over' : 'variance-under'}">${money.format(margin)}</span></td>
              <td class="num">${pctFormat(margin, income)}</td>
              <td class="num">${money.format(sumOf(items, 'earned'))}</td>
              <td></td>
            </tr>
          </tfoot>
        </table>
      </div>
    </div>`;
}

// Sales: where the rooms stand, and cost against price per m² of what is sold.
function salesDetail(sales, cost) {
  if (!state.flats.length) {
    return `<div class="panel"><div class="empty-state">No rooms yet.</div></div>`;
  }
  const perM2 = (amount, area) => (area ? money.format(amount / area) : '-');
  const row = (label, b) => `
    <tr>
      <td>${esc(label)}</td>
      <td class="num">${b.count}</td>
      <td class="num">${areaFormat.format(b.area)} m²</td>
      <td class="num">${money.format(b.amount)}</td>
      <td class="num">${perM2(b.amount, b.area)}</td>
    </tr>`;
  const all = {
    count: sales.sold.count + sales.reserved.count + sales.forSale.count,
    area: sales.sellable,
    amount: sales.income,
  };

  // Rooms by type: what sells for what.
  const typeRows = salesByType(state.flats, currentProject()?.price_per_m2).map(([type, t]) => `
    <tr>
      <td>${esc(type || 'No type')}</td>
      <td class="num">${t.count}</td>
      <td class="num">${t.sold}</td>
      <td class="num">${areaFormat.format(t.area)} m²</td>
      <td class="num">${money.format(t.amount)}</td>
      <td class="num">${perM2(t.amount, t.area)}</td>
    </tr>`).join('');

  const costPerM2 = sales.sellable ? cost / sales.sellable : 0;
  const pricePerM2 = sales.sellable ? sales.income / sales.sellable : 0;
  const soldPerM2 = sales.sold.area ? sales.sold.amount / sales.sold.area : 0;
  return `
    <div class="space-y-4">
      <div class="grid grid-cols-1 sm:grid-cols-3 gap-4">
        ${statTile('Cost per m²', sales.sellable ? money.format(costPerM2) : '-',
          sales.sellable ? `Cost ÷ ${areaFormat.format(sales.sellable)} m² for sale` : 'No areas entered')}
        ${statTile('Price per m²', sales.sellable ? money.format(pricePerM2) : '-',
          soldPerM2 ? `Sold so far at ${money.format(soldPerM2)}` : 'Nothing sold yet')}
        ${statTile('Profit per m²', sales.sellable ? money.format(pricePerM2 - costPerM2) : '-', 'Price − cost',
          pricePerM2 < costPerM2 ? 'negative' : '')}
      </div>
      <div class="grid grid-cols-1 xl:grid-cols-2 gap-4">
        <div class="panel">
          <h2 class="panel-title">Sales</h2>
          <div class="overflow-x-auto">
            <table class="data-table">
              <thead><tr><th></th><th class="num">Rooms</th><th class="num">Area</th><th class="num">Income</th><th class="num">Per m²</th></tr></thead>
              <tbody>
                ${row('Sold', sales.sold)}
                ${row('Reserved', sales.reserved)}
                ${row('For sale', sales.forSale)}
              </tbody>
              <tfoot>${row('Total', all)}</tfoot>
            </table>
          </div>
          ${sales.kept ? `<p class="mt-3 text-xs text-slate-500">${sales.kept} room${sales.kept === 1 ? '' : 's'} not for sale, left out.</p>` : ''}
        </div>
        <div class="panel">
          <h2 class="panel-title">By type</h2>
          <div class="overflow-x-auto">
            <table class="data-table">
              <thead><tr><th>Type</th><th class="num">Rooms</th><th class="num">Sold</th><th class="num">Area</th><th class="num">Income</th><th class="num">Per m²</th></tr></thead>
              <tbody>${typeRows}</tbody>
            </table>
          </div>
        </div>
      </div>
    </div>`;
}

// ---------- Daily workers and guards (from daily logs), paid by the month ----------
const sitePaid = (match) => sumOf(state.sitePayments.filter(match), 'amount');
const monthPaid = (kind, ym) => sitePaid((p) => p.kind === kind && p.month?.slice(0, 7) === ym);
const rentalPaid = (rentalId) => sitePaid((p) => p.rental_id === rentalId);

/** What is still owed against what it cost: amber while owed, a note when overpaid. */
function owedCell(cost, paid) {
  const owed = cost - paid;
  if (owed > 0.5) return `<span class="text-amber-400 font-semibold">${money.format(owed)}</span>`;
  if (owed < -0.5) return `<span class="text-sky-300">${money.format(-owed)} ahead</span>`;
  return cost ? '<span class="text-emerald-400">Paid</span>' : '-';
}

function renderDayPay(kind, el, emptyText) {
  const entries = state.siteCosts.filter((e) => e.kind === kind);
  const months = new Map();
  for (const e of entries) {
    const key = e.date.slice(0, 7);
    const m = months.get(key) ?? { workerDays: 0, cost: 0, unpriced: 0 };
    m.workerDays += e.workers;
    m.cost += e.amount;
    if (!e.amount) m.unpriced += 1;
    months.set(key, m);
  }
  // A payment for a month with nothing logged still shows.
  for (const p of state.sitePayments) {
    if (p.kind === kind && p.month && !months.has(p.month.slice(0, 7))) {
      months.set(p.month.slice(0, 7), { workerDays: 0, cost: 0, unpriced: 0 });
    }
  }
  if (!months.size) {
    el.innerHTML = `<div class="empty-state">${esc(emptyText)}</div>`;
    return;
  }
  const word = kind === 'guard' ? 'Guard-days' : 'Worker-days';
  let totalCost = 0;
  let totalPaid = 0;
  const rows = [...months].sort((a, b) => b[0].localeCompare(a[0])).map(([ym, m]) => {
    const paid = monthPaid(kind, ym);
    totalCost += m.cost;
    totalPaid += paid;
    return `
      <tr>
        <td class="whitespace-nowrap">${esc(monthLabel(ym))}${m.unpriced
          ? `<span class="block text-xs text-amber-400">${m.unpriced} day${m.unpriced === 1 ? '' : 's'} without a rate</span>` : ''}</td>
        <td class="num">${m.workerDays}</td>
        <td class="num">${money.format(m.cost)}</td>
        <td class="num">${paid ? money.format(paid) : '-'}</td>
        <td class="num">${owedCell(m.cost, paid)}</td>
        <td class="text-right"><button type="button" class="table-action" data-site-pay="${kind}" data-month="${ym}">Pay</button></td>
      </tr>`;
  }).join('');
  el.innerHTML = `
    <table class="data-table">
      <thead><tr><th>Month</th><th class="num">${word}</th><th class="num">Cost</th><th class="num">Paid</th><th class="num">Owed</th><th></th></tr></thead>
      <tbody>${rows}</tbody>
      <tfoot>
        <tr><td>Total</td><td></td><td class="num">${money.format(totalCost)}</td><td class="num">${money.format(totalPaid)}</td>
          <td class="num">${owedCell(totalCost, totalPaid)}</td><td></td></tr>
      </tfoot>
    </table>`;
}

const renderLabour = () => renderDayPay('labour', $('#labour-table'),
  'No daily workers logged yet.');
const renderGuards = () => renderDayPay('guard', $('#guards-table'),
  'No guards logged yet.');

/** Everything still owed now: by kind, and in all. */
function owedNow() {
  const today = todayISO();
  const upTo = (kind) => state.siteCosts.filter((e) => e.kind === kind && e.date <= today).reduce((s, e) => s + e.amount, 0);
  const paidOf = (kind) => sitePaid((p) => p.kind === kind);
  const owed = {
    labour: upTo('labour') - paidOf('labour'),
    guard: upTo('guard') - paidOf('guard'),
    rental: upTo('rental') - paidOf('rental'),
    material: sumOf(state.materials.filter((m) => !m.paid_on), 'amount'),
  };
  for (const k of Object.keys(owed)) owed[k] = Math.max(0, owed[k]);
  return owed;
}

// ---------- Recording a payment ----------
let sitePayTarget = null; // { kind, month } or { kind: 'rental', rentalId }

function openSitePay(target) {
  sitePayTarget = target;
  const form = $('#form-site-pay');
  form.reset();
  form.elements.paid_on.value = todayISO();
  form.elements.paid_on.max = todayISO();
  showFormError(form, '');
  renderSitePay();
  const owed = sitePayOwed();
  if (owed > 0.5) form.elements.amount.value = owed.toFixed(2);
  openModal('modal-site-pay');
  form.elements.amount.focus();
}

const sitePayMatch = (p) => (sitePayTarget.kind === 'rental'
  ? p.rental_id === sitePayTarget.rentalId
  : p.kind === sitePayTarget.kind && p.month?.slice(0, 7) === sitePayTarget.month);

function sitePayCost() {
  const t = sitePayTarget;
  if (t.kind === 'rental') {
    const today = todayISO();
    return state.siteCosts.filter((e) => e.rentalId === t.rentalId && e.date <= today).reduce((s, e) => s + e.amount, 0);
  }
  return state.siteCosts.filter((e) => e.kind === t.kind && e.date.slice(0, 7) === t.month).reduce((s, e) => s + e.amount, 0);
}
const sitePayOwed = () => sitePayCost() - sitePaid(sitePayMatch);

function renderSitePay() {
  const t = sitePayTarget;
  const rental = t.kind === 'rental' ? state.rentals.find((r) => r.id === t.rentalId) : null;
  $('#site-pay-title').textContent = rental ? `Pay - ${rental.equipment}`
    : `Pay - ${t.kind === 'guard' ? 'Guards' : 'Daily workers'}, ${monthLabel(t.month)}`;
  const cost = sitePayCost();
  const paid = sitePaid(sitePayMatch);
  $('#site-pay-sub').textContent = `${rental ? 'Cost so far' : 'Cost'} ${moneyOwn.format(cost)} · paid ${moneyOwn.format(paid)} · `
    + (cost - paid > 0.5 ? `owed ${moneyOwn.format(cost - paid)}` : cost - paid < -0.5 ? `${moneyOwn.format(paid - cost)} paid ahead` : 'nothing owed');
  const payments = state.sitePayments.filter(sitePayMatch).sort((a, b) => b.paid_on.localeCompare(a.paid_on));
  $('#site-pay-list').innerHTML = payments.length ? `
    <table class="data-table">
      <thead><tr><th>Paid on</th><th class="num">Amount</th><th>Note</th><th></th></tr></thead>
      <tbody>
        ${payments.map((p) => `
          <tr>
            <td class="whitespace-nowrap">${esc(formatDate(p.paid_on))}</td>
            <td class="num">${moneyOwn.format(p.amount)}</td>
            <td class="text-slate-400">${esc(p.note || '-')}</td>
            <td class="text-right"><button type="button" class="table-action is-danger" data-site-pay-delete="${esc(p.id)}">Delete</button></td>
          </tr>`).join('')}
      </tbody>
    </table>` : '<div class="empty-state">No payments yet.</div>';
}

async function saveSitePay(e) {
  e.preventDefault();
  const form = e.currentTarget;
  const btn = $('[type=submit]', form);
  const fd = new FormData(form);
  const amount = Number(fd.get('amount'));
  if (!(amount > 0)) {
    showFormError(form, 'Enter the amount paid.');
    return;
  }
  const t = sitePayTarget;
  const row = {
    project_id: state.projectId,
    kind: t.kind,
    month: t.kind === 'rental' ? null : `${t.month}-01`,
    rental_id: t.kind === 'rental' ? t.rentalId : null,
    amount,
    paid_on: fd.get('paid_on'),
    note: fd.get('note').trim() || null,
  };
  showFormError(form, '');
  setBusy(btn, true);
  const { data, error } = await db.from('site_payments').insert(row).select('id, kind, month, rental_id, amount, paid_on, note').single();
  setBusy(btn, false);
  if (error) {
    showFormError(form, error.message);
    return;
  }
  state.sitePayments.push(data);
  toast('Payment recorded.', 'success');
  closeModal('modal-site-pay');
  renderCosts();
}

async function onSitePayListClick(e) {
  const del = e.target.closest('[data-site-pay-delete]');
  if (!del) return;
  const p = state.sitePayments.find((x) => x.id === del.dataset.sitePayDelete);
  if (!p || !confirm(`Delete the payment of ${money.format(p.amount)} on ${formatDate(p.paid_on)}?`)) return;
  const { error } = await db.from('site_payments').delete().eq('id', p.id);
  if (error) {
    toast(`Could not delete: ${error.message}`, 'error');
    return;
  }
  state.sitePayments = state.sitePayments.filter((x) => x.id !== p.id);
  renderSitePay();
  renderCosts();
}

function onSitePayClick(e) {
  const btn = e.target.closest('[data-site-pay]');
  if (!btn) return;
  openSitePay(btn.dataset.sitePay === 'rental'
    ? { kind: 'rental', rentalId: btn.dataset.rental }
    : { kind: btn.dataset.sitePay, month: btn.dataset.month });
}

// ---------- Equipment rentals ----------
function renderRentals() {
  const el = $('#rentals-table');
  if (!state.rentals.length) {
    el.innerHTML = '<div class="empty-state">No rentals yet.</div>';
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
        <td class="num">${rentalPaid(r.id) ? money.format(rentalPaid(r.id)) : '-'}</td>
        <td class="num">${owedCell(accrued.get(r.id) ?? 0, rentalPaid(r.id))}</td>
        <td class="text-right whitespace-nowrap">
          <button type="button" class="table-action" data-site-pay="rental" data-rental="${esc(r.id)}">Pay</button>
          <button type="button" class="table-action" data-rental-edit="${esc(r.id)}">Edit</button>
          <button type="button" class="table-action is-danger" data-rental-delete="${esc(r.id)}">Delete</button>
        </td>
      </tr>`;
  }).join('');
  el.innerHTML = `
    <table class="data-table">
      <thead><tr><th>Equipment</th><th>Dates</th><th class="num">Days × price</th><th class="num">Cost</th><th class="num">Paid</th><th class="num">Owed so far</th><th></th></tr></thead>
      <tbody>${rows}</tbody>
      <tfoot>
        <tr><td colspan="3">Total</td><td class="num">${money.format(state.rentals.reduce((s, r) => s + rentalTotal(r), 0))}</td>
          <td class="num">${money.format(sitePaid((p) => p.kind === 'rental'))}</td>
          <td class="num">${owedCell([...accrued.values()].reduce((s, v) => s + v, 0), sitePaid((p) => p.kind === 'rental'))}</td><td></td></tr>
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
    ? `Total: ${days} day${days === 1 ? '' : 's'} × ${moneyOwn.format(rate)} = ${moneyOwn.format(days * rate)}`
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

// ---------- Materials the client buys ----------
// What was bought for a job against what was planned for it.
function materialsCell(bought, planned) {
  if (!bought && !planned) return '<span class="text-slate-500">-</span>';
  const of = planned ? `<span class="block text-xs text-slate-500">of ${money.format(planned)}</span>` : '';
  return bought > planned && planned
    ? `<span class="variance-over">${money.format(bought)}</span>${of}`
    : `${bought ? money.format(bought) : '-'}${of}`;
}

/** Paid on purchase, paid later, or still owed on credit (ნისია) - red once past due. */
function materialPayment(m) {
  if (m.paid_on) {
    return m.paid_on === m.bought_on
      ? '<span class="text-slate-400">Paid</span>'
      : `<span class="text-slate-400">Paid ${esc(formatDate(m.paid_on))}</span><span class="block text-xs text-slate-500">on credit</span>`;
  }
  const late = m.due_on && m.due_on < todayISO();
  return `<span class="${late ? 'variance-over' : 'text-amber-400'}">On credit · owed</span>${m.due_on
    ? `<span class="block text-xs ${late ? 'text-rose-300' : 'text-slate-500'}">due ${esc(formatDate(m.due_on))}</span>` : ''}`;
}

function renderMaterials() {
  const el = $('#materials-table');
  if (!state.materials.length) {
    el.innerHTML = '<div class="empty-state">Nothing bought yet.</div>';
    return;
  }
  const rows = state.materials.map((m) => {
    const task = state.tasks.find((t) => t.id === m.task_id);
    const kind = m.kind ?? 'material';
    const job = kind !== 'material'
      ? `<span class="status-chip status-handed">${esc(PURCHASE_KINDS[kind])}</span>`
      : task
        ? `${esc(taskName(task))}${task.contractor_id ? `<span class="block text-xs text-slate-500">${esc(contractorName(task.contractor_id))}</span>` : ''}`
        : '<span class="text-slate-500">General</span>';
    const qty = m.quantity != null
      ? `${qtyFormat.format(m.quantity)} ${esc(m.unit || '')}${m.unit_price != null ? ` × ${money2.format(m.unit_price)}` : ''}`
      : '<span class="text-slate-500">-</span>';
    return `
      <tr>
        <td class="whitespace-nowrap">${esc(formatDate(m.bought_on))}</td>
        <td>
          <p class="text-white font-medium">${esc(m.item)}${m.item_ka && m.item_ka !== m.item ? ` <span class="text-slate-400 font-normal">· ${esc(m.item_ka)}</span>` : ''}</p>
          <p class="text-xs text-slate-500">${esc([m.supplier, m.note].filter(Boolean).join(' · ') || '-')}</p>
        </td>
        <td>${job}</td>
        <td class="num">${qty}</td>
        <td class="num">${money.format(m.amount)}</td>
        <td class="whitespace-nowrap">${materialPayment(m)}</td>
        <td class="text-right whitespace-nowrap">
          ${m.paid_on ? '' : `<button type="button" class="table-action" data-material-paid="${esc(m.id)}">Mark paid</button>`}
          <button type="button" class="table-action" data-material-edit="${esc(m.id)}">Edit</button>
          <button type="button" class="table-action is-danger" data-material-delete="${esc(m.id)}">Delete</button>
        </td>
      </tr>`;
  }).join('');
  el.innerHTML = `
    <table class="data-table">
      <thead><tr><th>Bought</th><th>Item</th><th>For job</th><th class="num">Qty × price</th><th class="num">Amount</th><th>Payment</th><th></th></tr></thead>
      <tbody>${rows}</tbody>
      <tfoot>
        <tr><td colspan="4">Total${purchaseSplit()}</td><td class="num">${money.format(sumOf(state.materials, 'amount'))}</td>
          <td>${sumOf(state.materials.filter((m) => !m.paid_on), 'amount')
            ? `<span class="text-amber-400">${money.format(sumOf(state.materials.filter((m) => !m.paid_on), 'amount'))} owed</span>` : ''}</td><td></td></tr>
      </tfoot>
    </table>`;
}

// "materials $X · tools $Y · other $Z" when the purchases are of more than one type.
function purchaseSplit() {
  const parts = Object.entries(PURCHASE_KINDS)
    .map(([kind, label]) => [label, sumOf(state.materials.filter((m) => (m.kind ?? 'material') === kind), 'amount')])
    .filter(([, amount]) => amount);
  return parts.length > 1
    ? `<span class="block text-xs text-slate-500 font-normal">${esc(parts.map(([label, amount]) => `${label} ${money.format(amount)}`).join(' · '))}</span>`
    : '';
}

// Only a material can be for one job; a tool or other purchase is for the site.
function syncMaterialKind() {
  const f = $('#form-material').elements;
  const material = f.kind.value === 'material';
  $('#material-task-wrap').classList.toggle('hidden', !material);
  if (!material) f.task_id.value = '';
}

function openMaterialModal(material = null) {
  if (!requireProject()) return;
  const form = $('#form-material');
  const f = form.elements;
  form.reset();
  $('#material-title').textContent = material ? `Edit Purchase - ${material.item}` : 'Add Purchase';
  $('#material-kind').innerHTML = Object.entries(PURCHASE_KINDS)
    .map(([value, label]) => `<option value="${value}">${esc(label)}</option>`).join('');
  const taskId = material?.task_id ?? '';
  $('#material-task').innerHTML = '<option value="">General - not for one job</option>'
    + state.tasks.map((t) => `
      <option value="${esc(t.id)}"${t.id === taskId ? ' selected' : ''}>
        ${esc(taskName(t))}${t.contractor_id ? ` · ${esc(contractorName(t.contractor_id))}` : ''}
      </option>`).join('');
  f.id.value = material?.id ?? '';
  f.kind.value = material?.kind ?? 'material';
  syncMaterialKind();
  f.item_ka.value = material?.item_ka ?? '';
  f.item.value = material?.item_ka && material.item === material.item_ka ? '' : (material?.item ?? '');
  f.bought_on.value = material?.bought_on ?? todayISO();
  f.quantity.value = material?.quantity ?? '';
  f.unit.value = material?.unit ?? '';
  f.unit_price.value = material?.unit_price ?? '';
  f.amount.value = material?.amount ?? '';
  f.supplier_ka.value = material?.supplier_ka ?? '';
  f.supplier.value = material?.supplier_ka && material.supplier === material.supplier_ka ? '' : (material?.supplier ?? '');
  f.note.value = material?.note ?? '';
  // Paid on the day it was bought, or taken on credit and paid (or not) later.
  const credit = material && material.paid_on !== material.bought_on;
  f.payment.value = credit ? 'credit' : 'paid';
  f.due_on.value = material?.due_on ?? '';
  f.paid_on.value = credit ? material.paid_on ?? '' : '';
  syncMaterialPayment();
  showFormError(form, '');
  openModal('modal-material');
  f.item_ka.focus();
}

function syncMaterialPayment() {
  $('#material-credit').classList.toggle('hidden', $('#form-material').elements.payment.value !== 'credit');
}

// Quantity × unit price → amount.
function onMaterialInput(e) {
  if (e.target.name === 'payment') syncMaterialPayment();
  if (e.target.name === 'kind') syncMaterialKind();
  if (!['quantity', 'unit_price'].includes(e.target.name)) return;
  const f = e.currentTarget.elements;
  const qty = parseFloat(f.quantity.value);
  const price = parseFloat(f.unit_price.value);
  if (qty >= 0 && price >= 0) f.amount.value = (Math.round(qty * price * 100) / 100).toFixed(2);
}

async function saveMaterial(e) {
  e.preventDefault();
  const form = e.currentTarget;
  const btn = $('[type=submit]', form);
  const fd = new FormData(form);
  const itemKa = fd.get('item_ka').trim();
  const itemEn = fd.get('item').trim();
  if (!itemKa && !itemEn) {
    showFormError(form, 'Enter what was bought, in Georgian or English.');
    return;
  }
  const amount = Number(fd.get('amount'));
  if (fd.get('amount') === '' || !Number.isFinite(amount) || amount < 0) {
    showFormError(form, 'Enter the amount paid.');
    return;
  }
  const id = fd.get('id');
  const kind = fd.get('kind') || 'material';
  const row = {
    kind,
    task_id: kind === 'material' ? fd.get('task_id') || null : null,
    bought_on: fd.get('bought_on'),
    item: itemEn || itemKa,
    item_ka: itemKa || null,
    quantity: numOrNull(fd.get('quantity')),
    unit: fd.get('unit') || null,
    unit_price: numOrNull(fd.get('unit_price')),
    amount,
    supplier: fd.get('supplier').trim() || fd.get('supplier_ka').trim() || null,
    supplier_ka: fd.get('supplier_ka').trim() || null,
    note: fd.get('note').trim() || null,
  };
  if (fd.get('payment') === 'credit') {
    row.due_on = fd.get('due_on') || null;
    row.paid_on = fd.get('paid_on') || null;
  } else {
    row.due_on = null;
    row.paid_on = row.bought_on;
  }

  showFormError(form, '');
  setBusy(btn, true);
  const { error } = id
    ? await db.from('materials').update(row).eq('id', id)
    : await db.from('materials').insert({ ...row, project_id: state.projectId });
  setBusy(btn, false);
  if (error) {
    showFormError(form, error.message);
    return;
  }
  closeModal('modal-material');
  toast(id ? 'Purchase updated.' : 'Purchase added.', 'success');
  loadSchedule(state.projectId);
}

async function onMaterialsTableClick(e) {
  const paid = e.target.closest('[data-material-paid]');
  if (paid) {
    const m = state.materials.find((x) => x.id === paid.dataset.materialPaid);
    if (!m || !confirm(`Mark ${m.item} (${money.format(m.amount)}) as paid today?`)) return;
    const { error } = await db.from('materials').update({ paid_on: todayISO() }).eq('id', m.id);
    if (error) {
      toast(`Could not save: ${error.message}`, 'error');
      return;
    }
    m.paid_on = todayISO();
    toast('Marked paid. To give another date, use Edit.', 'success');
    renderCosts();
    return;
  }
  const edit = e.target.closest('[data-material-edit]');
  if (edit) {
    openMaterialModal(state.materials.find((m) => m.id === edit.dataset.materialEdit));
    return;
  }
  const del = e.target.closest('[data-material-delete]');
  if (!del) return;
  const material = state.materials.find((m) => m.id === del.dataset.materialDelete);
  if (!material || !confirm(`Delete ${material.item} (${money.format(material.amount)})?`)) return;
  const { error } = await db.from('materials').delete().eq('id', material.id);
  if (error) {
    toast(`Could not delete: ${error.message}`, 'error');
    return;
  }
  toast('Material deleted.', 'success');
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
  const certified = paid + held;
  $('#payments-summary').textContent = (budget
    ? `Budget ${moneyOwn.format(budget)} · paid ${moneyOwn.format(paid)} · ${certified > budget ? `${moneyOwn.format(certified - budget)} over budget` : `${moneyOwn.format(budget - certified)} left`}`
    : `Paid ${moneyOwn.format(paid)} · no budget set for this item`)
    + (held ? ` · ${moneyOwn.format(held)} retention held` : '');

  $('#payments-list').innerHTML = payments.length ? `
    <table class="data-table">
      <thead><tr><th>Date</th><th class="num">Paid</th><th class="num">Retention</th><th>Note</th><th></th></tr></thead>
      <tbody>
        ${payments.map((p) => `
          <tr>
            <td class="whitespace-nowrap">${esc(formatDate(p.paid_on))}</td>
            <td class="num">${moneyOwn.format(p.amount)}</td>
            <td class="num">${Number(p.retention) ? moneyOwn.format(p.retention) : '<span class="text-slate-500">-</span>'}</td>
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
  form.elements.gross.focus();
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
    ? `${moneyOwn.format(gross)} certified - ${moneyOwn.format(retention)} retention = ${moneyOwn.format(gross - retention)} paid`
    : `${moneyOwn.format(gross)} paid, nothing held`;
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
  const perf = contractorPerformance(state.tasks, state.contractorDelays, state.payments, todayISO(), state.materials);
  const el = $('#contractors-table');
  const list = [...state.contractors].sort((a, b) =>
    (perf.get(b.id)?.items ?? 0) - (perf.get(a.id)?.items ?? 0) || a.name.localeCompare(b.name));

  if (!list.length) {
    el.innerHTML = '<div class="empty-state">No contractors yet.</div>';
    return;
  }

  const contact = (c) => [c.trade, c.contact_person, c.phone, c.email].filter(Boolean).map(esc).join(' · ');
  const rows = list.map((c) => {
    const s = perf.get(c.id);
    return `
      <tr>
        <td>
          <p class="text-white font-medium">${esc(inLang(c.name, c.name_ka))}${inLang(c.name_ka, c.name) !== inLang(c.name, c.name_ka) ? ` <span class="text-slate-400 font-normal">· ${esc(inLang(c.name_ka, c.name))}</span>` : ''}</p>
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
        <td class="num">${s?.paid ? money.format(s.paid) : '-'}${s?.materials
          ? `<span class="block text-xs text-slate-500">+ ${money.format(s.materials)} materials</span>` : ''}</td>
        <td class="whitespace-nowrap">${contractorRating(s)}</td>
        <td class="text-right whitespace-nowrap">
          <button type="button" class="table-action" data-contractor-jobs="${esc(c.id)}">Jobs</button>
          <button type="button" class="table-action" data-contractor-contracts="${esc(c.id)}">Contracts${
            contractCount(c.id) ? ` (${contractCount(c.id)})` : ''}</button>
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
  const papers = state.contracts.filter((x) => x.contractor_id === contractorId);
  const contractsNote = papers.length ? `\n\nTheir ${papers.length} contract PDF(s) will be deleted too.` : '';
  if (!confirm(`Delete contractor "${contractor.name}"?${extra}${contractsNote}`)) return;

  // The contract files first: the rows go with the contractor, the files would not.
  try {
    await deleteContracts(db, papers);
  } catch (err) {
    toast(`Could not delete contractor: ${err.message}`, 'error');
    return;
  }
  const { error } = await db.from('contractors').delete().eq('id', contractorId);
  if (error) {
    toast(`Could not delete contractor: ${error.message}`, 'error');
    return;
  }
  toast(`Deleted ${contractor.name}.`, 'success');
  loadSchedule(state.projectId);
}

// ---------- Contracts (PDFs) with each contractor ----------
// Everyone signed in can read them; only the administrator uploads or deletes.
const isAdmin = () => state.user?.email?.toLowerCase() === ADMIN_EMAIL;
// Contracts only - an act is counted under its contract, not beside it.
const contractCount = (contractorId) => state.contracts.filter((x) => x.contractor_id === contractorId && !x.contract_id).length;
const actsOf = (contractId) => state.contracts.filter((x) => x.contract_id === contractId)
  .sort((a, b) => String(a.signed_on ?? a.created_at).localeCompare(String(b.signed_on ?? b.created_at)));
let contractsFor = null; // the contractor whose Contracts popup is open

async function loadContracts(projectId) {
  try {
    const data = await fetchContracts(db, projectId);
    if (projectId !== state.projectId) return;
    state.contracts = data;
  } catch (err) {
    toast(`Could not load the contracts: ${err.message}`, 'error');
    return;
  }
  if (state.contractors.length) renderContractors();
  if ($('#modal-contracts').open) renderContracts();
}

function openContracts(contractorId) {
  const c = state.contractors.find((x) => x.id === contractorId);
  if (!c) return;
  contractsFor = contractorId;
  $('#contracts-title').textContent = `Contracts - ${c.name}`;
  const form = $('#form-contract');
  form.reset();
  $('#contract-parent').innerHTML = ''; // the last contractor's contracts are not this one's
  showFormError(form, '');
  renderContracts();
  openModal('modal-contracts');
}

const fileSize = (bytes) => (bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);

function renderContracts() {
  const contracts = state.contracts.filter((x) => x.contractor_id === contractsFor && !x.contract_id);
  // The form's contract picker, for an act.
  const parent = $('#contract-parent');
  const picked = parent.value;
  parent.innerHTML = contracts.map((x) => `<option value="${esc(x.id)}">${esc(x.title)}${
    x.signed_on ? ` · ${esc(formatDate(x.signed_on))}` : ''}</option>`).join('');
  if (contracts.some((x) => x.id === picked)) parent.value = picked;
  syncContractForm();

  const dash = '<span class="text-slate-500">-</span>';
  const fileCell = (x) => `<span class="text-slate-400">${esc(x.file_name || '')}</span>${
    x.bytes ? ` <span class="text-xs text-slate-500">· ${fileSize(x.bytes)}</span>` : ''}`;
  const buttons = (x) => `
    <td class="text-right whitespace-nowrap">
      <button type="button" class="table-action" data-contract-open="${esc(x.id)}">Open</button>
      <button type="button" class="table-action is-danger" data-contract-delete="${esc(x.id)}">Delete</button>
    </td>`;
  $('#contracts-list').innerHTML = !contracts.length
    ? '<div class="empty-state">No contracts yet.</div>'
    : `
      <table class="data-table">
        <thead><tr><th>Document</th><th>Date</th><th class="num">Amount</th><th>File</th><th></th></tr></thead>
        ${contracts.map((x) => {
    const acts = actsOf(x.id);
    const certified = sumOf(acts, 'amount');
    return `
          <tbody>
            <tr>
              <td class="text-white font-medium">${esc(x.title)}
                <span class="block text-xs text-slate-500 font-normal">Contract${acts.length
    ? ` · ${acts.length} act${acts.length === 1 ? '' : 's'}${certified ? `, ${esc(moneyOwn.format(certified))} certified` : ''}` : ''}</span></td>
              <td class="whitespace-nowrap">${x.signed_on ? esc(formatDate(x.signed_on)) : dash}</td>
              <td class="num">${dash}</td>
              <td>${fileCell(x)}</td>
              ${buttons(x)}
            </tr>
            ${acts.map((a) => `
            <tr>
              <td class="pl-8">↳ ${esc(a.title)}<span class="block text-xs text-slate-500">Acceptance act · მიღება-ჩაბარება</span></td>
              <td class="whitespace-nowrap">${a.signed_on ? esc(formatDate(a.signed_on)) : dash}</td>
              <td class="num">${a.amount != null ? esc(moneyOwn.format(a.amount)) : dash}</td>
              <td>${fileCell(a)}</td>
              ${buttons(a)}
            </tr>`).join('')}
          </tbody>`;
  }).join('')}
      </table>`;
}

// An act needs a contract to go under, and has a number and an amount.
function syncContractForm() {
  const f = $('#form-contract').elements;
  const hasContracts = $('#contract-parent').options.length > 0;
  if (f.doc.value === 'act' && !hasContracts) f.doc.value = 'contract';
  f.doc.querySelector('[value=act]').disabled = !hasContracts;
  const act = f.doc.value === 'act';
  $('#contract-parent-wrap').classList.toggle('hidden', !act);
  $('#contract-act-fields').classList.toggle('hidden', !act);
  $('#contract-date-label').textContent = act ? 'Act date' : 'Signed on';
}

async function saveContract(e) {
  e.preventDefault();
  const form = e.currentTarget;
  const btn = $('[type=submit]', form);
  const fd = new FormData(form);
  const file = fd.get('file');
  if (!file?.size) {
    showFormError(form, 'Choose the PDF.');
    return;
  }
  if (file.size > MAX_CONTRACT_MB * 1024 * 1024) {
    showFormError(form, `The file is over ${MAX_CONTRACT_MB} MB.`);
    return;
  }
  showFormError(form, '');
  setBusy(btn, true, 'Uploading…');
  try {
    const act = fd.get('doc') === 'act';
    await uploadContract(db, {
      projectId: state.projectId,
      contractorId: contractsFor,
      file,
      title: fd.get('title').trim(),
      signedOn: fd.get('signed_on'),
      contractId: act ? fd.get('contract_id') || null : null,
      actNo: act ? fd.get('act_no').trim() : null,
      amount: act ? numOrNull(fd.get('amount')) : null,
    });
  } catch (err) {
    showFormError(form, err.message);
    return;
  } finally {
    setBusy(btn, false);
  }
  const doc = form.elements.doc.value;
  const parentId = form.elements.contract_id.value;
  form.reset();
  // The next upload is most likely another act under the same contract.
  form.elements.doc.value = doc;
  if (parentId) form.elements.contract_id.value = parentId;
  toast(doc === 'act' ? 'Act uploaded.' : 'Contract uploaded.', 'success');
  loadContracts(state.projectId);
}

async function onContractsClick(e) {
  const open = e.target.closest('[data-contract-open]');
  if (open) {
    const contract = state.contracts.find((x) => x.id === open.dataset.contractOpen);
    if (!contract) return;
    // Opened at once, so the browser doesn't take it for a pop-up; the link follows.
    const tab = window.open('', '_blank');
    try {
      const url = await contractUrl(db, contract);
      if (tab) tab.location.href = url;
      else window.location.assign(url);
    } catch (err) {
      tab?.close();
      toast(`Could not open the contract: ${err.message}`, 'error');
    }
    return;
  }
  const del = e.target.closest('[data-contract-delete]');
  if (!del) return;
  const contract = state.contracts.find((x) => x.id === del.dataset.contractDelete);
  if (!contract) return;
  const acts = contract.contract_id ? [] : actsOf(contract.id);
  if (!confirm(`Delete "${contract.title}"?${acts.length
    ? ` Its ${acts.length} acceptance act${acts.length === 1 ? '' : 's'} go with it.` : ''} The PDFs are removed for good.`)) return;
  try {
    await deleteContracts(db, [contract, ...acts]);
  } catch (err) {
    toast(`Could not delete: ${err.message}`, 'error');
    return;
  }
  toast('Contract deleted.', 'success');
  loadContracts(state.projectId);
}

// Pop-up with every timetable item assigned to one contractor.
function openContractorJobs(contractorId) {
  const c = state.contractors.find((x) => x.id === contractorId);
  if (!c) return;
  const today = todayISO();
  const jobs = state.tasks
    .filter((t) => t.contractor_id === c.id)
    .sort((a, b) => a.planned_start.localeCompare(b.planned_start));
  const s = contractorPerformance(state.tasks, state.contractorDelays, state.payments, today, state.materials).get(c.id);

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
    statTile('Materials supplied', money.format(s?.materials ?? 0),
      s?.materialBudget ? `of ${money.format(s.materialBudget)} planned` : 'Bought by the client for their jobs',
      s?.materialBudget && s.materials > s.materialBudget ? 'negative' : ''),
  ].join('');

  $('#contractor-jobs-list').innerHTML = jobs.length ? `
    <table class="data-table">
      <thead>
        <tr><th>Work item</th><th>Dates</th><th class="num">Done</th><th class="num">Budget</th><th class="num">Paid</th><th class="num">Materials</th><th>Status</th></tr>
      </thead>
      <tbody>
        ${jobs.map((t) => {
          const pct = Math.round(completionOf(t) * 100);
          return `
            <tr>
              <td class="task-name">${taskNameHtml(t)}</td>
              <td class="whitespace-nowrap">${esc(formatDate(t.planned_start))} → ${finishCell(t)}</td>
              <td class="num">
                ${pct}%
                <div class="task-pct-bar"><div style="width:${pct}%"></div></div>
              </td>
              <td class="num">${Number(t.budget) ? money.format(t.budget) : '-'}</td>
              <td class="num">${paidOn(t.id) ? money.format(paidOn(t.id)) : '-'}</td>
              <td class="num">${materialsOn(t.id) ? money.format(materialsOn(t.id)) : '-'}</td>
              <td class="whitespace-nowrap">${taskStateChip(t, taskState(t, today))}</td>
            </tr>`;
        }).join('')}
      </tbody>
    </table>`
    : '<div class="empty-state">No jobs yet</div>';
  openModal('modal-contractor-jobs');
}

function onContractorsClick(e) {
  const jobs = e.target.closest('[data-contractor-jobs]');
  if (jobs) return openContractorJobs(jobs.dataset.contractorJobs);

  const contracts = e.target.closest('[data-contractor-contracts]');
  if (contracts) return openContracts(contracts.dataset.contractorContracts);

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

const flatName = (id) => {
  const flat = state.flats.find((f) => f.id === id);
  return flat ? roomLabel(flat) : '';
};
const quantityText = (w) => (w.quantity != null ? `${qtyFormat.format(w.quantity)}${w.unit ? ` ${w.unit}` : ''}` : '');

const workOn = (date) => state.work.filter((w) => w.work_date === date);
const workCount = (flatId) => state.work.filter((w) => w.flat_id === flatId).length;
const taskWorkCount = (taskId) => state.work.filter((w) => w.task_id === taskId).length;
const dayWorkCount = (date) => state.work.filter((w) => w.by_day_workers && w.work_date === date).length;

/** The day's work on its log card: "Block A · Room 301 - Gypsum board 200 m² (Giorgi)". */
function workList(work) {
  if (!work?.length) return '';
  const items = [...work]
    .sort((a, b) => String(a.created_at ?? '').localeCompare(String(b.created_at ?? '')))
    .map((w) => {
      const where = flatName(w.flat_id) || (state.tasks.find((t) => t.id === w.task_id)?.name ?? '');
      // Measured that day, or work that went on unmeasured.
      const extra = [quantityText(w) ? `${quantityText(w)} measured` : 'in progress', workBy(w)].filter(Boolean).join(' · ');
      return `<li>${where ? `<span class="text-white">${esc(where)}</span> - ` : ''}${esc(w.work || w.work_en)}`
        + `${w.work_en && w.work_en !== w.work ? ` <span class="text-slate-500">/ ${esc(w.work_en)}</span>` : ''}`
        + `${extra ? ` <span class="text-slate-400">(${esc(extra)})</span>` : ''}</li>`;
    });
  return `<ul class="log-card-work">${items.join('')}</ul>`;
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
          <button type="button" class="table-action" data-log-day-workers="${esc(l.id)}" data-day="${esc(l.log_date)}" title="What the client's daily workers did that day">Daily workers${
            dayWorkCount(l.log_date) ? ` (${dayWorkCount(l.log_date)})` : ''}</button>
          <button type="button" class="table-action" data-log-edit="${esc(l.id)}">Edit</button>
          <button type="button" class="table-action is-danger" data-log-delete="${esc(l.id)}">Delete</button>
        </span>
      </div>
      ${crew.length ? `<p class="log-card-crew">${crew.map((line) => esc(line)).join(' &middot; ')}</p>` : ''}
      <div data-log-work="${esc(l.log_date)}">${workList(workOn(l.log_date))}</div>
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
      : "<div class=\"panel empty-state\">No daily logs yet.</div>";
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
  const dayWorkers = e.target.closest('[data-log-day-workers]');
  if (dayWorkers) return openDayWorkersWork(dayWorkers.dataset.logDayWorkers);
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
  $('#material-unit').innerHTML = $('#task-unit').innerHTML;
  $('#room-work-unit').innerHTML = $('#task-unit').innerHTML;
  $('#contractor-trades').innerHTML = CONTRACTOR_TRADES.map((t) => `<option value="${esc(t)}"></option>`).join('');

  const currencyOptions = Object.entries(CURRENCIES)
    .map(([code, label]) => `<option value="${code}">${esc(label)}</option>`).join('');
  $$('[data-currency-options]').forEach((sel) => { sel.innerHTML = currencyOptions; });

  const typeOptions = '<option value="">-</option>'
    + UNIT_TYPES.map((u) => `<option value="${esc(u)}">${esc(u)}</option>`).join('');
  $('#unit-type').innerHTML = typeOptions;
  $('#unit-status').innerHTML = Object.entries(UNIT_STATUSES)
    .map(([value, label]) => `<option value="${value}">${esc(label)}</option>`).join('');
  $('#unit-sale-status').innerHTML = Object.entries(SALE_STATUSES)
    .map(([value, label]) => `<option value="${value}">${esc(label)}</option>`).join('');

  const incomeOptions = '<option value="">Not chosen yet</option>'
    + Object.entries(INCOME_SOURCES).map(([value, label]) => `<option value="${value}">${esc(label)}</option>`).join('');
  $$('[data-income-options]').forEach((sel) => { sel.innerHTML = incomeOptions; });
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
    `<option value="${esc(c.id)}"${c.id === chosen ? ' selected' : ''}>${esc(inLang(c.name, c.name_ka))}</option>`
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
    el.textContent = `${workers} × ${moneyOwn.format(rate)} = ${moneyOwn.format(workers * rate)} today`;
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
  // Notes written by hand in one language: Gemini writes the other before
  // saving, as it does for delays. If it can't, the log is saved as written.
  if (!row.notes !== !row.notes_en) {
    btn.textContent = 'Translating…';
    const { data, error: tError } = await db.functions.invoke('translate-delay', {
      body: { ka: row.notes ?? '', en: row.notes_en ?? '', cause: 'Daily site log' },
    });
    if (tError) {
      toast(`Saved without translation - ${await functionErrorMessage(tError)}`, 'error');
    } else {
      row.notes = data.ka || row.notes;
      row.notes_en = data.en || row.notes_en;
    }
    btn.textContent = 'Saving…';
  }
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
    .select('id, ref, title, description, description_en, contractor_id, instructed_on, status, amount, employer_amount, days_claimed, decided_on')
    .eq('project_id', projectId)
    .order('instructed_on', { ascending: false });
  if (projectId !== state.projectId) return;
  if (error) {
    $('#variations-table').innerHTML = `<div class="empty-state">Could not load variations: ${esc(error.message)}</div>`;
    return;
  }
  state.variations = data;
  renderVariations();
  renderFinance(); // approved variations are cost
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
    $('#variations-table').innerHTML = '<div class="empty-state">No variations yet.</div>';
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
  f.employer_amount.value = Number(variation?.employer_amount) || '';
  // Only a project built for an employer is paid for its changes.
  $('#variation-employer').classList.toggle('hidden', incomeFrom(currentProject()) !== 'contract');
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
    employer_amount: numOrNull(fd.get('employer_amount')),
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
    $('#events-table').innerHTML = '<div class="empty-state">Nothing recorded yet.</div>';
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

// =============================================================
// Import activities: an Excel sheet (from the template) or MS Project XML
// .mpp is a closed binary format nothing in the browser reads reliably, so a
// programme comes in either pasted into the Excel template or as MS Project's
// own XML (File → Save As → XML).
// =============================================================
let importRows = [];

const isGeorgian = (text) => /[Ⴀ-ჿ]/.test(text);
const nameKey = (text) => String(text ?? '').trim().toLowerCase();

/**
 * Both languages written in one name, either way round: "კედელი / Wall" →
 * { ka: 'კედელი', en: 'Wall' }. Only a slash with spaces around it splits, and
 * only when one side is Georgian and the other has none, so "ბლოკი A/B" stays
 * whole. null when the name is in one language.
 */
function splitBilingual(text) {
  const parts = String(text ?? '').split(/\s+[/|]\s+/).map((p) => p.trim());
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  const [a, b] = parts;
  if (isGeorgian(a) && !isGeorgian(b)) return { ka: a, en: b };
  if (isGeorgian(b) && !isGeorgian(a)) return { ka: b, en: a };
  return null;
}
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

// SheetJS is only needed here, so it loads the first time it is.
let sheetJs = null;
function loadSheetJs() {
  sheetJs ??= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';
    s.onload = () => resolve(window.XLSX);
    s.onerror = () => {
      sheetJs = null;
      reject(new Error('Could not load the Excel reader - check the connection and try again.'));
    };
    document.head.append(s);
  });
  return sheetJs;
}

const TEMPLATE_HEADERS = ['Activity - ქართული', 'Activity - English', 'Start', 'Finish',
  'Quantity', 'Unit', 'Rate', 'Contract budget', 'Materials budget', "Employer's price"];
// The money columns of the timetable sheet: column heading → task field.
// An empty cell leaves the item's value as it is.
const MONEY_COLUMNS = [
  { field: 'quantity', re: /quantity|რაოდ/, label: 'quantity' },
  { field: 'unit', re: /^unit$|ერთეული$/, label: 'unit', text: true },
  { field: 'rate', re: /^rate|ერთეულის ფასი|განფასება/, label: 'rate' },
  { field: 'material_budget', re: /material|მასალ/, label: 'materials budget' },
  { field: 'budget', re: /contract budget|^budget|კონტრაქტის ბიუჯეტი|^ბიუჯეტი/, label: 'contract budget' },
  { field: 'employer_price', re: /employer|დამკვეთის ფასი/, label: "employer's price" },
];
// A number cell: '' when empty (leave as is), NaN when not a number.
const cellNumber = (v) => {
  const text = String(v ?? '').trim().replace(/\s/g, '').replace(',', '.');
  return text === '' ? '' : Number(text);
};

/** The template, filled with the timetable as it stands, so dates can be changed there too. */
async function downloadTemplate() {
  if (!requireProject()) return;
  let XLSX;
  try {
    XLSX = await loadSheetJs();
  } catch (err) {
    toast(err.message, 'error');
    return;
  }
  // Excel counts days from 30 Dec 1899; a serial with a date format shows as a date.
  const serial = (iso) => Date.UTC(...iso.split('-').map((n, i) => Number(n) - (i === 1 ? 1 : 0))) / 86_400_000 + 25_569;
  const num = (v) => (v == null || v === '' || Number(v) === 0 ? '' : Number(v));
  const rows = state.tasks.map((t) => [
    t.name_ka ?? '',
    t.name_ka && t.name === t.name_ka ? '' : t.name,
    { t: 'n', v: serial(t.planned_start), z: 'dd.mm.yyyy' },
    { t: 'n', v: serial(t.planned_finish), z: 'dd.mm.yyyy' },
    num(t.quantity), t.unit ?? '', num(t.rate), num(t.budget), num(t.material_budget), num(t.employer_price),
  ]);
  const sheet = XLSX.utils.aoa_to_sheet([TEMPLATE_HEADERS, ...rows]);
  sheet['!cols'] = [{ wch: 45 }, { wch: 45 }, { wch: 12 }, { wch: 12 }, { wch: 10 }, { wch: 8 }, { wch: 10 }, { wch: 15 }, { wch: 15 }, { wch: 15 }];
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, sheet, 'Timetable');
  const project = currentProject();
  XLSX.writeFile(book, `${(project?.name || 'Timetable').replace(/[\\/:*?"<>|]+/g, ' ').trim()} - timetable.xlsx`);
}

// Weekday a date is written with, as MS Project puts it in front ("Mon 1/5/26"):
// the first letters of the name → 0 (Sunday) … 6.
const WEEKDAYS = [
  ['sun', 'კვ'], ['mon', 'ორ'], ['tue', 'სა'], ['wed', 'ოთ'], ['thu', 'ხუ'], ['fri', 'პა'], ['sat', 'შა'],
];
const weekdayOf = (word) => WEEKDAYS.findIndex((names) => names.some((n) => word.toLowerCase().startsWith(n)));
const NUMERIC_DATE = /^(\d{1,2})[./-](\d{1,2})[./-](\d{2}|\d{4})\b/;

/**
 * Whether a column of text dates is written day first or month first. MS
 * Project in US format writes 1/5/26 for 5 January, a Georgian sheet 05.01.26:
 * any first number above 12 settles it as day first, any second one above 12
 * as month first. Day first, as dates are written in Georgia, when nothing
 * tells them apart.
 */
function dateOrder(values) {
  for (const v of values) {
    const m = String(v ?? '').trim().replace(/^[^\d\s]+\.?\s+/, '').match(NUMERIC_DATE);
    if (!m) continue;
    if (Number(m[1]) > 12) return 'dmy';
    if (Number(m[2]) > 12) return 'mdy';
  }
  return 'dmy';
}

/**
 * A date cell to YYYY-MM-DD: an Excel date, or text the way people type or
 * paste it - 2026-01-05, 05.01.2026, 5/1/26, "Mon 1/5/26". `order` says which
 * of day and month comes first (see dateOrder); a weekday written in front
 * overrules it when only the other reading falls on that day. '' when it
 * can't be read.
 */
function cellDate(v, order = 'dmy') {
  if (typeof v === 'number' && v > 0) {
    return new Date(Math.round((v - 25_569) * 86_400_000)).toISOString().slice(0, 10);
  }
  const raw = String(v ?? '').trim();
  const weekday = raw.match(/^([^\d\s]+)\.?\s+/);
  const text = weekday ? raw.slice(weekday[0].length) : raw;
  let m = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return isoOf(m[1], m[2], m[3]);
  m = text.match(NUMERIC_DATE);
  if (!m) return '';
  const year = m[3].length === 2 ? `20${m[3]}` : m[3];
  const dmy = isoOf(year, m[2], m[1]);
  const mdy = isoOf(year, m[1], m[2]);
  const day = weekday ? weekdayOf(weekday[1]) : -1;
  const falls = (iso) => iso && new Date(`${iso}T00:00`).getDay() === day;
  if (day >= 0 && falls(dmy) !== falls(mdy)) return falls(dmy) ? dmy : mdy;
  return order === 'mdy' ? mdy : dmy;
}

function isoOf(y, mo, d) {
  const iso = `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  const back = new Date(`${iso}T00:00`);
  return Number.isNaN(back.getTime()) || back.getDate() !== Number(d) ? '' : iso;
}

/**
 * Activities in the first sheet of a workbook. Columns are found by their
 * headings (the template's, or MS Project's Task Name / Start / Finish); a
 * sheet without headings is read in the template's order.
 */
async function parseWorkbook(buffer) {
  const XLSX = await loadSheetJs();
  const book = XLSX.read(buffer, { type: 'array' });
  const sheet = book.Sheets[book.SheetNames[0]];
  const grid = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: '' });

  const heads = (grid[0] ?? []).map((h) => String(h).toLowerCase());
  const col = (re) => heads.findIndex((h) => re.test(h));
  let ka = col(/ქართ/);
  let en = col(/english|ინგლ/);
  let name = col(/activity|task|name|სამუშაო|დასახელ/);
  let start = col(/start|დაწყ/);
  let finish = col(/finish|end|დასრ/);
  const hasHeader = start >= 0 && finish >= 0;
  if (!hasHeader) [ka, en, name, start, finish] = [0, 1, -1, 2, 3];
  if (ka < 0 && en < 0) en = name;

  const rows = grid.slice(hasHeader ? 1 : 0);
  const order = dateOrder(rows.flatMap((row) => [row[start], row[finish]]));
  // Money columns, found by their headings (a sheet without headings has none).
  const used = new Set([ka, en, name, start, finish]);
  const moneyAt = hasHeader ? MONEY_COLUMNS.map((m) => {
    const i = heads.findIndex((h, j) => !used.has(j) && m.re.test(h));
    if (i >= 0) used.add(i);
    return { ...m, i };
  }).filter((m) => m.i >= 0) : [];
  return rows.map((row) => {
    let nameKa = ka >= 0 ? String(row[ka] ?? '').trim() : '';
    let nameEn = en >= 0 ? String(row[en] ?? '').trim() : '';
    // "კედელი / Wall" in either column is both names.
    for (const cell of [nameKa, nameEn]) {
      const both = splitBilingual(cell);
      if (!both) continue;
      if (!nameKa || nameKa === cell) nameKa = both.ka;
      if (!nameEn || nameEn === cell) nameEn = both.en;
    }
    // A single name column in Georgian is the Georgian name.
    const georgianOnly = !nameKa && isGeorgian(nameEn) && ka < 0;
    // A blank date is null - left as it is on the timetable - and one that
    // can't be read is ''.
    const date = (v) => (String(v ?? '').trim() ? cellDate(v, order) : null);
    const money = {};
    const unreadable = [];
    for (const m of moneyAt) {
      if (m.text) {
        const t = String(row[m.i] ?? '').trim();
        if (t) money[m.field] = t;
        continue;
      }
      const v = cellNumber(row[m.i]);
      if (v === '') continue;
      if (Number.isFinite(v) && v >= 0) money[m.field] = v;
      else unreadable.push(m.label);
    }
    return {
      name: nameEn || nameKa,
      nameKa: georgianOnly ? nameEn : nameKa || null,
      start: date(row[start]),
      finish: date(row[finish]),
      money,
      unreadable,
      level: 1,
    };
  }).filter((r) => r.name);
}

/** Tasks in an MS Project XML file: { name, start, finish, summary, milestone, level }. */
function parseMsProject(xml) {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  const root = doc.documentElement;
  if (doc.querySelector('parsererror') || root.localName !== 'Project') {
    throw new Error('This is not an MS Project XML file.');
  }
  const kids = (el, name) => [...el.children].filter((c) => c.localName === name);
  const text = (el, name) => kids(el, name)[0]?.textContent.trim() ?? '';
  const tasksEl = kids(root, 'Tasks')[0];
  return (tasksEl ? kids(tasksEl, 'Task') : [])
    .filter((t) => text(t, 'UID') !== '0' && text(t, 'IsNull') !== '1' && text(t, 'Active') !== '0')
    .map((t) => {
      const start = text(t, 'Start').slice(0, 10);
      const finish = text(t, 'Finish').slice(0, 10);
      return {
        name: splitBilingual(text(t, 'Name'))?.en ?? text(t, 'Name'),
        nameKa: splitBilingual(text(t, 'Name'))?.ka,
        start,
        finish: finish < start ? start : finish,
        summary: text(t, 'Summary') === '1',
        milestone: text(t, 'Milestone') === '1',
        level: Math.max(1, Number(text(t, 'OutlineLevel')) || 1),
      };
    })
    .filter((t) => t.name && ISO_DATE.test(t.start) && ISO_DATE.test(t.finish));
}

async function onImportFile(e) {
  const file = e.target.files[0];
  e.target.value = ''; // picking the same file again still fires
  if (!file) return;
  if (/\.mpp$/i.test(file.name)) {
    toast('An .mpp file can\'t be read directly. Copy its tasks into the Excel template, or in MS Project use File → Save As → XML.', 'error');
    return;
  }
  let tasks;
  try {
    tasks = /\.xml$/i.test(file.name)
      ? parseMsProject(await file.text())
      : await parseWorkbook(await file.arrayBuffer());
  } catch (err) {
    toast(err.message || 'Could not read this file.', 'error');
    return;
  }
  if (!tasks.length) {
    toast('No activities found in this file.', 'error');
    return;
  }

  const existing = new Map();
  for (const t of state.tasks) {
    existing.set(nameKey(t.name), t);
    if (t.name_ka) existing.set(nameKey(t.name_ka), t);
  }
  importRows = tasks.map((t) => {
    const match = existing.get(nameKey(t.name)) ?? (t.nameKa ? existing.get(nameKey(t.nameKa)) : undefined);
    // A date left blank keeps the one the activity already has; a new
    // activity needs both.
    const start = t.start ?? match?.planned_start ?? '';
    const finish = t.finish ?? match?.planned_finish ?? '';
    const problem = t.start === '' || t.finish === '' ? 'Dates not readable - skipped'
      : !start || !finish ? 'New activity needs both dates - skipped'
      : finish < start ? 'Finish is before start - skipped'
      : t.unreadable?.length ? `Not a number: ${t.unreadable.join(', ')} - skipped`
      : '';
    const money = { ...(t.money ?? {}) };
    // Quantity × rate with no budget written: the budget is what they make.
    if (money.budget == null && (money.quantity != null || money.rate != null)) {
      const q = money.quantity ?? match?.quantity;
      const r = money.rate ?? match?.rate;
      if (q != null && r != null) money.budget = Math.round(Number(q) * Number(r) * 100) / 100;
    }
    // On an item already there: only what the sheet changes.
    const changes = {};
    if (match) {
      if (match.planned_start !== start) changes.planned_start = start;
      if (match.planned_finish !== finish) changes.planned_finish = finish;
      for (const [field, v] of Object.entries(money)) {
        if (String(v) !== String(match[field] ?? '') && !(Number(v) === Number(match[field] ?? 0) && typeof v === 'number')) changes[field] = v;
      }
    }
    const same = match && !Object.keys(changes).length;
    return {
      ...t, start, finish, money, changes, match, same, problem, bad: Boolean(problem),
      checked: !problem && !same && !t.summary && !t.milestone,
    };
  });

  const form = $('#form-import');
  $('#import-title').textContent = `Import activities - ${file.name}`;
  const label = (r) => [r.nameKa, r.name !== r.nameKa ? r.name : ''].filter(Boolean).map(esc).join(' · ') || esc(r.name);
  const dateCell = (iso) => (ISO_DATE.test(iso) ? esc(formatDate(iso)) : '<span class="variance-over">?</span>');
  $('#import-list').innerHTML = `
    <table class="data-table">
      <thead><tr><th></th><th>Activity</th><th>Start</th><th>Finish</th><th>On the timetable</th></tr></thead>
      <tbody>
        ${importRows.map((r, i) => `
          <tr>
            <td><input type="checkbox" data-import-row="${i}"${r.checked ? ' checked' : ''}${r.same || r.bad ? ' disabled' : ''}></td>
            <td style="padding-left:${0.75 + (r.level - 1) * 1}rem" class="${r.summary ? 'font-semibold text-white' : ''}">
              ${label(r)}${r.summary ? ' <span class="text-xs text-slate-500">summary</span>' : ''}${r.milestone ? ' <span class="text-xs text-slate-500">milestone</span>' : ''}
            </td>
            <td class="whitespace-nowrap">${dateCell(r.start)}</td>
            <td class="whitespace-nowrap">${dateCell(r.finish)}</td>
            <td class="whitespace-nowrap text-xs">${r.bad ? `<span class="variance-over">${r.problem}</span>`
              : !r.match ? '<span class="text-emerald-400">New</span>'
              : r.same ? '<span class="text-slate-500">Already there, nothing to change</span>'
              : importChangeText(r)}</td>
          </tr>`).join('')}
      </tbody>
    </table>`;
  showFormError(form, '');
  updateImportCount();
  openModal('modal-import');
}

// What an import changes on an item already on the timetable, in words.
function importChangeText(r) {
  const dates = 'planned_start' in r.changes || 'planned_finish' in r.changes;
  const money = MONEY_COLUMNS.filter((m) => m.field in r.changes).map((m) => m.label);
  return [
    dates ? `<span class="text-amber-400">Dates change</span> <span class="text-slate-500">from ${esc(formatDate(r.match.planned_start))} → ${esc(formatDate(r.match.planned_finish))}</span>` : '',
    money.length ? `<span class="text-amber-400">Updates ${esc(money.join(', '))}</span>` : '',
  ].filter(Boolean).join('<br>');
}

function updateImportCount() {
  for (const box of $$('[data-import-row]')) importRows[box.dataset.importRow].checked = box.checked;
  const picked = importRows.filter((r) => r.checked);
  const added = picked.filter((r) => !r.match).length;
  const moved = picked.length - added;
  const bad = importRows.filter((r) => r.bad).length;
  $('#import-summary').textContent = `${importRows.length} activities in the file. Ticked: ${added} new`
    + `${moved ? `, ${moved} to update` : ''}.`
    + `${bad ? ` ${bad} skipped - see the red notes (write dates like 05.01.2026).` : ''}`;
  $('[type=submit]', $('#form-import')).disabled = !picked.length;
}

async function saveImport(e) {
  e.preventDefault();
  const form = e.currentTarget;
  const btn = $('[type=submit]', form);
  const picked = importRows.filter((r) => r.checked);
  if (!picked.length) return;

  const inserts = picked.filter((r) => !r.match).map((r) => ({
    project_id: state.projectId,
    name: r.name,
    name_ka: r.nameKa ?? (isGeorgian(r.name) ? r.name : null),
    planned_start: r.start,
    planned_finish: r.finish,
    ...r.money,
  }));
  // Each item already there gets only what the sheet changed on it.
  const updates = picked.filter((r) => r.match);

  showFormError(form, '');
  setBusy(btn, true, inserts.length ? 'Translating…' : 'Importing…');
  const untranslated = await translateNames(inserts);
  btn.textContent = 'Importing…';
  const results = await Promise.all([
    inserts.length ? db.from('schedule_tasks').insert(inserts) : {},
    ...updates.map((r) => db.from('schedule_tasks').update(r.changes).eq('id', r.match.id)),
  ]);
  setBusy(btn, false);
  const failed = results.find((r) => r.error);
  if (failed) {
    showFormError(form, failed.error.message);
    loadSchedule(state.projectId);
    return;
  }
  closeModal('modal-import');
  toast([
    inserts.length ? `${inserts.length} activit${inserts.length === 1 ? 'y' : 'ies'} added` : '',
    updates.length ? `${updates.length} updated` : '',
  ].filter(Boolean).join(', ') + (untranslated
    ? ` - in one language only, Gemini couldn't translate them: ${untranslated}`
    : '.'), untranslated ? 'error' : 'success');
  loadSchedule(state.projectId);
}

// =============================================================
// Rooms from an Excel sheet: the template comes filled with the rooms as they
// stand, and a room already there (same block and number) is updated.
// =============================================================
const ROOM_HEADERS = ['Block', 'Floor', 'Room no.', 'Type', 'Area m²', 'Status', 'Notes',
  'Sale status', 'Asking price', 'Sale price', 'Buyer', 'Sold on'];
let roomImportRows = [];

async function downloadRoomsTemplate() {
  if (!requireProject()) return;
  let XLSX;
  try {
    XLSX = await loadSheetJs();
  } catch (err) {
    toast(err.message, 'error');
    return;
  }
  const rows = state.flats.map((u) => [
    u.block || '', u.floor, u.flat_number, u.unit_type || '',
    u.area_m2 != null ? Number(u.area_m2) : '', UNIT_STATUSES[u.status] ?? '', u.notes || '',
    SALE_STATUSES[u.sale_status ?? 'for_sale'] ?? '', u.asking_price != null ? Number(u.asking_price) : '',
    u.sale_price != null ? Number(u.sale_price) : '', u.buyer || '', u.sold_on ? formatDate(u.sold_on) : '',
  ]);
  const sheet = XLSX.utils.aoa_to_sheet([ROOM_HEADERS, ...rows]);
  sheet['!cols'] = [{ wch: 8 }, { wch: 7 }, { wch: 10 }, { wch: 14 }, { wch: 10 }, { wch: 13 }, { wch: 40 },
    { wch: 13 }, { wch: 13 }, { wch: 13 }, { wch: 24 }, { wch: 12 }];
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, sheet, 'Rooms');
  const project = currentProject();
  XLSX.writeFile(book, `${(project?.name || 'Project').replace(/[\\/:*?"<>|]+/g, ' ').trim()} - rooms.xlsx`);
}

/** A type or status as written in the sheet - English or Georgian, any case - to the app's own. */
function pickFrom(text, options) {
  const t = String(text ?? '').trim().toLowerCase();
  if (!t) return null;
  return options.find((o) => [o.value, o.label, ka(o.label)].some((x) => String(x).toLowerCase() === t))?.value;
}

async function parseRoomsWorkbook(buffer) {
  const XLSX = await loadSheetJs();
  const book = XLSX.read(buffer, { type: 'array' });
  const grid = XLSX.utils.sheet_to_json(book.Sheets[book.SheetNames[0]], { header: 1, raw: true, defval: '' });
  const heads = (grid[0] ?? []).map((h) => String(h).toLowerCase());
  const col = (re) => heads.findIndex((h) => re.test(h));
  const at = {
    block: col(/block|ბლოკ/), floor: col(/floor|სართ/), number: col(/room|no\b|number|ოთახ|ნომ/),
    type: col(/type|ტიპ/), area: col(/area|m²|m2|ფართ/), status: heads.findIndex((h) => /status|სტატ/.test(h) && !/sale|გაყიდ/.test(h)),
    notes: col(/note|შენიშ/), sale: col(/sale status|გაყიდვის სტატ/), asking: col(/asking|მოთხოვნ/),
    price: col(/^sale price|გაყიდვის ფასი/), buyer: col(/buyer|მყიდველ/), sold: col(/sold|გაყიდვის თარ/),
  };
  const hasHeader = at.floor >= 0 && at.number >= 0;
  if (!hasHeader) Object.assign(at, { block: 0, floor: 1, number: 2, type: 3, area: 4, status: 5, notes: 6 });
  const cell = (row, i) => (i >= 0 ? String(row[i] ?? '').trim() : '');
  const types = UNIT_TYPES.map((t) => ({ value: t, label: t }));
  const statuses = Object.entries(UNIT_STATUSES).map(([value, label]) => ({ value, label }));
  const saleStatuses = Object.entries(SALE_STATUSES).map(([value, label]) => ({ value, label }));
  const order = dateOrder(grid.slice(1).map((row) => row[at.sold]));

  return grid.slice(hasHeader ? 1 : 0).map((row) => {
    const number = cell(row, at.number);
    const floorText = cell(row, at.floor);
    if (!number && !floorText) return null;
    const problems = [];
    const floor = Number(floorText);
    if (!number) problems.push('no room number');
    if (!floorText || !Number.isInteger(floor) || floor < -5 || floor > 80) problems.push('floor must be a whole number');
    const typeText = cell(row, at.type);
    const unitType = pickFrom(typeText, types);
    const statusText = cell(row, at.status);
    const status = pickFrom(statusText, statuses);
    const areaText = cell(row, at.area).replace(',', '.');
    const area = areaText === '' ? null : Number(areaText);
    if (areaText !== '' && !(area >= 0)) problems.push('area is not a number');
    // The sale: an empty cell leaves that detail of the room as it is.
    const saleText = cell(row, at.sale);
    const saleStatus = pickFrom(saleText, saleStatuses);
    const money = (i, what) => {
      const v = cellNumber(i >= 0 ? row[i] : '');
      if (v === '') return null;
      if (!(v >= 0)) { problems.push(`${what} is not a number`); return null; }
      return v;
    };
    const asking = money(at.asking, 'asking price');
    const price = money(at.price, 'sale price');
    const soldText = cell(row, at.sold);
    const soldOn = soldText ? cellDate(at.sold >= 0 ? row[at.sold] : '', order) : null;
    if (soldText && !soldOn) problems.push('sold on is not a date');
    return {
      block: cell(row, at.block),
      floor,
      flat_number: number,
      // An empty cell is null: on a room already there, it leaves that detail alone.
      unit_type: typeText ? unitType ?? undefined : null,
      area_m2: areaText === '' ? null : area,
      status: statusText ? status ?? undefined : null,
      notes: cell(row, at.notes) || null,
      sale_status: saleText ? saleStatus ?? undefined : null,
      asking_price: asking,
      sale_price: price,
      buyer: cell(row, at.buyer) || null,
      sold_on: soldOn || null,
      notes_ignored: [typeText && !unitType ? `type "${typeText}"` : '', statusText && !status ? `status "${statusText}"` : '',
        saleText && !saleStatus ? `sale status "${saleText}"` : '']
        .filter(Boolean),
      problems,
    };
  }).filter(Boolean);
}

const roomKey = (block, number) => `${String(block ?? '').trim().toLowerCase()}|${String(number ?? '').trim().toLowerCase()}`;

async function onRoomsImportFile(e) {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  let rows;
  try {
    rows = await parseRoomsWorkbook(await file.arrayBuffer());
  } catch (err) {
    toast(err.message || 'Could not read this file.', 'error');
    return;
  }
  if (!rows.length) {
    toast('No rooms found in this file.', 'error');
    return;
  }

  const existing = new Map(state.flats.map((u) => [roomKey(u.block, u.flat_number), u]));
  const seen = new Set();
  roomImportRows = rows.map((r) => {
    const key = roomKey(r.block, r.flat_number);
    if (seen.has(key)) r.problems.push('listed twice in the file');
    seen.add(key);
    const match = existing.get(key);
    // What would change on a room already there - only what the sheet fills in.
    const changes = {};
    if (match) {
      if (r.floor !== match.floor && Number.isInteger(r.floor)) changes.floor = r.floor;
      for (const field of ['unit_type', 'area_m2', 'status', 'notes', 'sale_status', 'asking_price', 'sale_price', 'buyer', 'sold_on']) {
        const v = r[field];
        if (v != null && String(v) !== String(match[field] ?? '') && !(typeof v === 'number' && Number(match[field]) === v)) changes[field] = v;
      }
    }
    const bad = r.problems.length > 0;
    const same = match && !Object.keys(changes).length;
    return { ...r, match, changes, bad, same, checked: !bad && !same };
  });

  const label = {
    floor: 'floor', unit_type: 'type', area_m2: 'area', status: 'status', notes: 'notes',
    sale_status: 'sale', asking_price: 'asking price', sale_price: 'sale price', buyer: 'buyer', sold_on: 'sold on',
  };
  $('#rooms-import-title').textContent = `Import rooms - ${file.name}`;
  $('#rooms-import-list').innerHTML = `
    <table class="data-table">
      <thead><tr><th></th><th>Room</th><th>Floor</th><th>Type</th><th class="num">Area m²</th><th>Status</th><th>In the app</th></tr></thead>
      <tbody>
        ${roomImportRows.map((r, i) => `
          <tr>
            <td><input type="checkbox" data-room-import="${i}"${r.checked ? ' checked' : ''}${r.bad || r.same ? ' disabled' : ''}></td>
            <td class="text-white whitespace-nowrap">${esc(roomLabel(r))}</td>
            <td>${Number.isInteger(r.floor) ? esc(floorLabel(r.floor)) : '<span class="variance-over">?</span>'}</td>
            <td>${esc(r.unit_type ?? '') || '<span class="text-slate-500">-</span>'}</td>
            <td class="num">${r.area_m2 != null ? esc(String(r.area_m2)) : '-'}</td>
            <td>${r.status ? esc(UNIT_STATUSES[r.status]) : '<span class="text-slate-500">-</span>'}</td>
            <td class="text-xs">${r.bad ? `<span class="variance-over">${esc(r.problems.join(', '))} - skipped</span>`
              : !r.match ? '<span class="text-emerald-400">New</span>'
              : r.same ? '<span class="text-slate-500">Already there, nothing to change</span>'
              : `<span class="text-amber-400">Updates ${esc(Object.keys(r.changes).map((k) => label[k]).join(', '))}</span>`}
              ${r.notes_ignored.length ? `<span class="block text-slate-500">${esc(r.notes_ignored.join(', '))} not recognised - left as is</span>` : ''}</td>
          </tr>`).join('')}
      </tbody>
    </table>`;
  showFormError($('#form-rooms-import'), '');
  updateRoomsImportCount();
  openModal('modal-rooms-import');
}

function updateRoomsImportCount() {
  for (const box of $$('[data-room-import]')) roomImportRows[box.dataset.roomImport].checked = box.checked;
  const picked = roomImportRows.filter((r) => r.checked);
  const added = picked.filter((r) => !r.match).length;
  const bad = roomImportRows.filter((r) => r.bad).length;
  $('#rooms-import-summary').textContent = `${roomImportRows.length} rooms in the file. Ticked: ${added} new`
    + `${picked.length - added ? `, ${picked.length - added} to update` : ''}.`
    + `${bad ? ` ${bad} skipped - see the red notes.` : ''}`;
  $('[type=submit]', $('#form-rooms-import')).disabled = !picked.length;
}

async function saveRoomsImport(e) {
  e.preventDefault();
  const form = e.currentTarget;
  const btn = $('[type=submit]', form);
  const picked = roomImportRows.filter((r) => r.checked);
  if (!picked.length) return;
  const projectId = state.projectId;

  const inserts = picked.filter((r) => !r.match).map((r) => ({
    project_id: projectId,
    block: r.block,
    floor: r.floor,
    flat_number: r.flat_number,
    unit_type: r.unit_type ?? null,
    area_m2: r.area_m2,
    status: r.status ?? 'not_started',
    notes: r.notes,
    sale_status: r.sale_status ?? 'for_sale',
    asking_price: r.asking_price,
    sale_price: r.sale_price,
    buyer: r.buyer,
    sold_on: r.sold_on,
    stage_status: {},
  }));
  const updates = picked.filter((r) => r.match);

  showFormError(form, '');
  setBusy(btn, true, 'Importing…');
  const results = await Promise.all([
    inserts.length ? db.from('flats').insert(inserts) : {},
    ...updates.map((r) => db.from('flats').update(r.changes).eq('id', r.match.id)),
  ]);
  setBusy(btn, false);
  const failed = results.find((r) => r.error);
  await syncFlatCount(projectId);
  state.unitFloor = 'all'; // the rooms just imported, on every floor
  if (projectId === state.projectId) loadUnits(projectId);
  if (failed) {
    showFormError(form, failed.error.message);
    return;
  }
  closeModal('modal-rooms-import');
  toast([
    inserts.length ? `${inserts.length} room${inserts.length === 1 ? '' : 's'} added` : '',
    updates.length ? `${updates.length} updated` : '',
  ].filter(Boolean).join(', ') + '.', 'success');
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
  const already = new Set((delay?.impacts ?? []).map((i) => i.task_id));
  if (!state.tasks.length) {
    el.innerHTML = '<div class="empty-state">No timetable items yet.</div>';
    return;
  }
  el.innerHTML = state.tasks.map((t) => {
    const who = t.contractor_id ? contractorName(t.contractor_id) : 'No contractor';
    return `
      <label class="impact-row">
        <input type="checkbox" data-impact-task="${esc(t.id)}"${already.has(t.id) ? ' checked' : ''}>
        <span class="impact-row-name">${esc(taskName(t))}
          <span class="impact-row-who">${esc(who)} · ${esc(formatDate(t.planned_start))} → ${esc(formatDate(t.planned_finish))}</span>
        </span>
      </label>`;
  }).join('');
}

/** What the picker has: one entry per ticked item. */
const impactsFromPicker = () =>
  $$('#delay-impacts [data-impact-task]').filter((b) => b.checked)
    .map((b) => ({ task_id: b.dataset.impactTask }));

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
    units: state.flats,
    siteLogs: state.siteLogs,
    siteCosts: state.siteCosts,
    rentals: state.rentals,
    delayImpacts: state.delayImpacts,
    materials: state.materials,
    work: state.work,
    progress: state.progress ?? scheduleProgress([], todayISO()),
    moneyIn: state.moneyIn,
    // The report is in the project's own currency; the interactive one can
    // switch, at the National Bank rate given here.
    money: moneyOwn,
    usdRate: usdRate ? { rate: usdRate, date: usdRateDate } : null,
  };
}

/** Builds the project report and opens it to read; downloading is done from there. */
async function exportProjectReport(e) {
  e.preventDefault();
  if (exporting || !requireProject()) return;
  const form = e.currentTarget;
  const btn = $('[type=submit]', form);
  const label = btn.querySelector('span') ?? btn;
  const original = label.textContent;
  exporting = true;
  btn.disabled = true;
  label.textContent = 'Building…';
  showFormError(form, '');
  try {
    const project = currentProject();
    const page = await buildProjectReport(projectReportArgs(project));
    const html = await interactiveReportHtml(page, project);
    openPreview({
      title: `Project Report - ${project.name}`,
      html,
      download: { label: 'Download .html', run: () => downloadProjectReport(page, project, { html: true }) },
      word: () => downloadProjectReport(page, project, { word: true }),
    });
  } catch (err) {
    showFormError(form, err.message || 'Could not build the report.');
  } finally {
    exporting = false;
    btn.disabled = false;
    label.textContent = original;
  }
}

let exporting = false;

// The whole project in one ZIP, for the client and for keeping (see archive.js).
async function exportArchive() {
  if (exporting || !requireProject()) return;
  const project = currentProject();
  const btn = $('#btn-archive');
  const label = btn.querySelector('span');
  const progressEl = $('#archive-progress');
  exporting = true;
  btn.disabled = true;
  label.textContent = 'Building…';
  try {
    const today = todayISO();
    const page = await buildProjectReport(projectReportArgs(project));
    const reportHtml = await interactiveReportHtml(page, project);
    const cost = costPosition(state.tasks, state.payments, today, state.siteCosts);
    let XLSX = null;
    try { XLSX = await loadSheetJs(); } catch { /* the archive goes without its Excel file */ }
    const blob = await buildArchive({
      db,
      project,
      tasks: state.tasks,
      payments: state.payments,
      contractors: state.contractors,
      units: state.flats,
      siteCosts: state.siteCosts,
      rentals: state.rentals,
      materials: state.materials,
      sitePayments: state.sitePayments,
      work: state.work,
      delays: state.delays,
      events: state.events,
      variations: state.variations,
      contracts: state.contracts,
      progress: state.progress ?? scheduleProgress([], today),
      cost,
      finance: financePosition({
        project, tasks: state.tasks, rooms: state.flats, variations: state.variations, materials: state.materials,
        payments: state.payments, siteCosts: state.siteCosts, moneyIn: state.moneyIn, today,
      }),
      moneyIn: state.moneyIn,
      usdRate: usdRate ? { rate: usdRate, date: usdRateDate } : null,
      reportHtml,
      XLSX,
      onProgress: (text) => { progressEl.textContent = text; },
    });
    const name = `${(project.name || 'Project').replace(/[\\/:*?"<>|]+/g, '').trim().replace(/\s+/g, '_').slice(0, 60)}_Archive_${today}.zip`;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    progressEl.textContent = `Done - ${(blob.size / 1024 / 1024).toFixed(1)} MB`;
    toast('Archive downloaded. Unzip it and open index.html.', 'success');
  } catch (err) {
    progressEl.textContent = '';
    toast(err.message || 'Could not build the archive.', 'error');
  } finally {
    exporting = false;
    btn.disabled = false;
    label.textContent = 'Download archive';
  }
}

// The daily report of any day - a client may ask for last Tuesday's. The day
// starts at today whenever the Reports page opens on a new project.
function prepareDailyReport() {
  const form = $('#form-daily-report');
  form.elements.date.max = todayISO();
  if (!form.elements.date.value || form.dataset.project !== state.projectId) form.elements.date.value = todayISO();
  form.dataset.project = state.projectId ?? '';
  showFormError(form, '');
  updateDailyReportHint();
}

function updateDailyReportHint() {
  const date = $('#form-daily-report').elements.date.value;
  const logged = state.siteLogs.some((l) => l.log_date === date);
  $('#daily-report-hint').textContent = !date || logged ? ''
    : 'No daily log on this day - the report will have only its delays, equipment and events.';
}

async function exportDailyReport(e) {
  e.preventDefault();
  if (exporting || !requireProject()) return;
  const form = e.currentTarget;
  const date = form.elements.date.value;
  if (!date) {
    showFormError(form, 'Pick the day.');
    return;
  }
  const btn = $('[type=submit]', form);
  const label = btn.querySelector('span') ?? btn;
  const original = label.textContent;
  const project = currentProject();
  exporting = true;
  btn.disabled = true;
  label.textContent = 'Generating…';
  showFormError(form, '');
  try {
    const built = await buildDailyReport({ db, project, date });
    openPreview({
      title: `Daily Report - ${project.name} - ${formatDate(date)}`,
      html: await pagePreviewHtml(built.page),
      download: { label: 'Download PDF', run: () => saveDailyReport(built) },
      word: () => saveDailyReport(built, { word: true }),
    });
  } catch (err) {
    showFormError(form, err.message || 'Could not generate the report.');
  } finally {
    exporting = false;
    btn.disabled = false;
    label.textContent = original;
  }
}

// ---------- Report preview ----------
// A report opens full screen to be read first; from its bar it is printed
// (or saved as PDF from the print window), or downloaded as a file.
let previewing = null; // { download: { label, run }, word }

/** A built report page as a page of its own, styled as in the app, fitted to a phone. */
async function pagePreviewHtml(page) {
  const css = await (await fetch('css/styles.css')).text();
  return `<!doctype html>
<html lang="ka"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Noto+Sans+Georgian:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>${css}</style>
<style>
  body { margin: 0; padding: 24px 12px; background: #eef2f6; font-family: Inter, 'Noto Sans Georgian', system-ui, sans-serif; }
  /* The sheet with its own margins: the PDF adds them when it saves, a browser does not. */
  .pdf-page { box-sizing: content-box; margin: 0 auto; padding: 36px 40px 44px; border-radius: 6px;
    box-shadow: 0 2px 12px rgba(15, 23, 42, 0.12); }
  @media (max-width: 820px) { body { padding: 0; } .pdf-page { padding: 20px 16px 28px; border-radius: 0; } }
  @media print { body { padding: 0; background: #fff; } .pdf-page { box-shadow: none; padding: 0; } }
</style></head>
<body>${page.outerHTML}
<script>
  // A phone is narrower than the sheet: shrink it to fit rather than scroll sideways.
  const sheet = document.querySelector('.pdf-page');
  const fit = () => { sheet.style.zoom = ''; const w = sheet.offsetWidth, room = document.documentElement.clientWidth - 24; if (w > room) sheet.style.zoom = String(room / w); };
  addEventListener('resize', fit); addEventListener('load', fit); fit();
<\/script>
</body></html>`;
}

function openPreview({ title, html, download, word }) {
  previewing = { download, word };
  $('#preview-title').textContent = title;
  $('#preview-download').textContent = download.label;
  $('#preview-frame').srcdoc = html;
  openModal('modal-preview');
}

async function onPreviewAction(e) {
  const btn = e.target.closest('[data-preview-action]');
  if (!btn || !previewing) return;
  const action = btn.dataset.previewAction;
  if (action === 'print') {
    $('#preview-frame').contentWindow?.print();
    return;
  }
  const label = btn.querySelector('span') ?? btn;
  const original = label.textContent;
  btn.disabled = true;
  label.textContent = action === 'word' ? 'Making Word…' : 'Downloading…';
  try {
    await (action === 'word' ? previewing.word() : previewing.download.run());
    toast('Downloaded.', 'success');
  } catch (err) {
    toast(err.message || 'Could not download the report.', 'error');
  } finally {
    btn.disabled = false;
    label.textContent = original;
  }
}

// =============================================================
// Today's dollar rate// =============================================================
// Today's dollar rate - the National Bank of Georgia's official USD → GEL
// rate, shown in the top bar. Read straight from the bank (it allows
// browsers to), once a day: the day's answer is kept in this browser, so
// opening the app again that day asks nothing.
// =============================================================
const NBG_RATES = 'https://nbg.gov.ge/gw/api/ct/monetarypolicy/currencies/en/json/?currencies=USD';

let usdRateDate = null; // the day the bank's rate is for

// The $ / ₾ switch: shows every amount in the app in either currency. Only
// there once a project is open and the bank's rate is in.
function syncCurrencySwitch() {
  const el = $('#currency-switch');
  el.classList.toggle('hidden', !usdRate || !state.projectId);
  const shown = shownCurrency();
  const own = projectCurrency();
  $$('[data-show-currency]', el).forEach((b) => {
    const active = b.dataset.showCurrency === shown;
    b.classList.toggle('is-active', active);
    b.setAttribute('aria-pressed', String(active));
    b.title = b.dataset.showCurrency === own
      ? `Amounts as entered, in ${own}`
      : `Converted from ${own} at today's National Bank rate${usdRate ? ` ($1 = ${usdRate.toFixed(4)} ₾)` : ''}`;
  });
}

function onCurrencySwitch(e) {
  const btn = e.target.closest('[data-show-currency]');
  if (!btn) return;
  storage.set(SHOWN_CURRENCY_KEY, btn.dataset.showCurrency);
  syncCurrencySwitch();
  rerenderMoney();
}

// Every view that shows amounts, drawn again in the currency now shown.
function rerenderMoney() {
  if (!state.projectId) return;
  renderScheduleViews();
  renderUnits();
  renderVariations();
}

async function loadDollarRate() {
  const key = `cpm.usdRate.${todayISO()}`;
  let rate = null;
  try { rate = JSON.parse(storage.get(key) || 'null'); } catch { rate = null; }
  if (!rate) {
    try {
      const res = await fetch(NBG_RATES);
      if (!res.ok) return;
      const usd = (await res.json())?.[0]?.currencies?.find((c) => c.code === 'USD');
      if (!usd || !(usd.rate > 0)) return;
      rate = { rate: usd.rate, diff: Number(usd.diff) || 0, validFrom: String(usd.validFromDate ?? '').slice(0, 10) };
      storage.set(key, JSON.stringify(rate));
    } catch {
      return; // the bank can't be reached: the top bar just goes without it
    }
  }
  usdRate = rate.rate;
  usdRateDate = rate.validFrom || todayISO();
  syncCurrencySwitch();
  if (state.projectId && shownCurrency() !== projectCurrency()) rerenderMoney();
  const el = $('#fx-rate');
  const arrow = rate.diff > 0 ? '▲' : rate.diff < 0 ? '▼' : '';
  // ▲ = the dollar got dearer in lari since the last rate.
  el.innerHTML = `<span class="fx-label">NBG</span> $1 = <b>${rate.rate.toFixed(4)} ₾</b>`
    + (arrow ? ` <span class="fx-diff ${rate.diff > 0 ? 'is-up' : 'is-down'}">${arrow} ${Math.abs(rate.diff).toFixed(4)}</span>` : '');
  el.title = `National Bank of Georgia official rate${rate.validFrom ? ` for ${formatDate(rate.validFrom)}` : ''}`
    + (rate.diff ? ` · ${rate.diff > 0 ? 'up' : 'down'} ${Math.abs(rate.diff).toFixed(4)} ₾ on the previous rate` : '');
  el.classList.remove('hidden');
}

// =============================================================
// Boot
// =============================================================
// ENG | ქარ: both languages on the switch, the one in use highlighted.
$$('[data-lang]').forEach((b) => {
  const active = b.dataset.lang === (isKa ? 'ka' : 'en');
  b.classList.toggle('is-active', active);
  b.setAttribute('aria-pressed', String(active));
  b.addEventListener('click', () => { if (!active) setLang(b.dataset.lang); });
});
startTranslating();
initMobile({ openMenu: () => setSidebar(true) });

loadDollarRate();
$('#currency-switch').addEventListener('click', onCurrencySwitch);
$('#form-contract').addEventListener('submit', saveContract);
$('#form-contract').addEventListener('change', syncContractForm);
$('#contracts-list').addEventListener('click', onContractsClick);
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
$('#delays-table').addEventListener('click', onDelaysTableClick);
$('#btn-add-rental').addEventListener('click', () => openRentalModal());
$('#form-rental').addEventListener('submit', saveRental);
$('#form-rental').addEventListener('input', onRentalInput);
$('#rentals-table').addEventListener('click', onRentalsTableClick);
$('#rentals-table').addEventListener('click', onSitePayClick);
$('#labour-table').addEventListener('click', onSitePayClick);
$('#guards-table').addEventListener('click', onSitePayClick);
$('#form-site-pay').addEventListener('submit', saveSitePay);
$('#site-pay-list').addEventListener('click', onSitePayListClick);
$('#btn-add-material').addEventListener('click', () => openMaterialModal());
$('#form-material').addEventListener('submit', saveMaterial);
$('#form-material').addEventListener('input', onMaterialInput);
$('#materials-table').addEventListener('click', onMaterialsTableClick);
$('#equipment-options').innerHTML = EQUIPMENT_SUGGESTIONS.map((x) => `<option value="${esc(x)}"></option>`).join('');
$('#equipment-options-ka').innerHTML = EQUIPMENT_SUGGESTIONS.map((x) => `<option value="${esc(ka(x))}"></option>`).join('');
$('#units-table').addEventListener('click', onUnitsTableClick);
$('#btn-add-unit').addEventListener('click', () => openUnitModal(null));
$('#btn-rooms-template').addEventListener('click', downloadRoomsTemplate);
$('#btn-rooms-import').addEventListener('click', () => requireProject() && $('#input-rooms-import').click());
$('#input-rooms-import').addEventListener('change', onRoomsImportFile);
$('#form-rooms-import').addEventListener('submit', saveRoomsImport);
$('#form-rooms-import').addEventListener('change', updateRoomsImportCount);
$('#form-unit').addEventListener('submit', saveUnit);
$('#form-unit').addEventListener('input', updateUnitPriceHint);
$('#btn-add-task').addEventListener('click', () => openTaskModal(null));
$('#btn-baseline').addEventListener('click', setBaseline);
$('#btn-import-mpp').addEventListener('click', () => requireProject() && $('#input-import-mpp').click());
$('#btn-import-template').addEventListener('click', downloadTemplate);
$('#input-import-mpp').addEventListener('change', onImportFile);
$('#form-import').addEventListener('submit', saveImport);
$('#form-import').addEventListener('change', updateImportCount);
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
$('#form-task').addEventListener('change', onTaskNameChange);
$('#form-room-work').addEventListener('submit', saveRoomWork);
$('#form-room-work').addEventListener('change', onRoomWorkNameChange);
$('#room-work-list').addEventListener('click', onRoomWorkListClick);
// An item's measured work sets its % complete, when asked.
$('#room-work-sub').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-task-work-pct]');
  if (!btn || !workTarget.taskId) return;
  await setTaskPercent(workTarget.taskId, btn.dataset.taskWorkPct);
  renderTaskWorkSub();
});
$('#btn-room-work-cancel').addEventListener('click', () => resetRoomWorkForm());
$('#schedule-table').addEventListener('change', onScheduleChange);
$('#schedule-table').addEventListener('click', onTaskTableClick);
$('#boq-table').addEventListener('click', onTaskTableClick);
$('#finance-detail').addEventListener('click', onTaskTableClick);
$('#form-payment').addEventListener('submit', savePayment);
$('#form-payment').addEventListener('input', updatePaymentNet);
$('#payments-list').addEventListener('click', onPaymentsClick);
$('#btn-add-contractor').addEventListener('click', () => openContractorModal(null));
$('#form-contractor').addEventListener('submit', saveContractor);
$('#contractors-table').addEventListener('click', onContractorsClick);
$('#projects-container').addEventListener('click', onProjectsClick);
$('#btn-new-project').addEventListener('click', openProjectModal);
$('#form-project').addEventListener('submit', saveProject);
$('#btn-access').addEventListener('click', openAccess);
$('#access-list').addEventListener('click', onAccessClick);
$('#access-list').addEventListener('change', onAccessChange);
$('#form-project').elements.income_from.addEventListener('change', (e) => syncRoomsTick(e.target.form));
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
$('#edit-income-from').addEventListener('change', syncIncomeFields);
$('#edit-closed-how').addEventListener('change', syncClosedFields);
$('#form-delete-project').addEventListener('submit', confirmDeleteProject);
$('#form-daily-report').addEventListener('submit', exportDailyReport);
$('#form-daily-report').addEventListener('input', updateDailyReportHint);
$('#form-project-report').addEventListener('submit', exportProjectReport);
$('#modal-preview').addEventListener('click', onPreviewAction);
// The preview is left empty once closed, so a big report is not kept in memory.
$('#modal-preview').addEventListener('close', () => { $('#preview-frame').srcdoc = ''; previewing = null; });
$('#btn-archive').addEventListener('click', exportArchive);
$('#btn-add-money-in').addEventListener('click', () => openMoneyIn());
$('#form-money-in').addEventListener('submit', saveMoneyIn);
$('#money-in-kind').addEventListener('change', syncMoneyInKind);
$('#finance-money-in').addEventListener('click', onMoneyInClick);
$('#dash-photos').addEventListener('click', (e) => {
  const b = e.target.closest('[data-latest-photo]');
  if (b) openPhotoViewer(latestPhotos.full.filter(Boolean), Number(b.dataset.latestPhoto));
});

if (db) {
  $('#form-login').addEventListener('submit', signIn);
  $('#form-login').addEventListener('click', (e) => {
    const mode = e.target.closest('[data-login-mode]');
    if (mode) setLoginMode(mode.dataset.loginMode);
  });
  $('#form-set-password').addEventListener('submit', savePassword);
  $$('[data-sign-out]').forEach((el) => el.addEventListener('click', signOut));
  initAuth();
} else {
  showSetupNotice();
}
