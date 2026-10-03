// =============================================================
// Full project report - bilingual (Georgian / English), print-ready.
// Built from the open project's data; shown in the app and saved as PDF.
// Charts are plain HTML/CSS (plus one inline SVG) so html2pdf renders them as-is.
// =============================================================
import {
  taskState, completionOf, costPosition, contractorPerformance, plannedSpendByMonth, actualSpendByMonth,
  siteCostsByMonth, rentalTotal, rentalEnd, delayIsOngoing, delayDaysLost, causeOf, dueDate, delayStart,
  stalledTasks, forecastFinish, durationDays, contractorManDays, planVerdict,
} from './schedule.js';
import { bi, biName, dateKa, dateEn, signatureHtml } from './bilingual.js';
import { MANPOWER_TRADES, REPORT_AUTHOR, CLOSED_HOW } from './config.js';
import { financePosition, salesByType } from './finance.js';
import { savePdf } from './pdfSave.js';
import { saveDocx } from './docxSave.js';

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

const DAY_MS = 86_400_000;
const toDate = (iso) => new Date(`${iso.slice(0, 10)}T00:00`);
const iso = (date) => date.toLocaleDateString('en-CA');
const addDays = (isoDate, n) => { const x = toDate(isoDate); x.setDate(x.getDate() + n); return iso(x); };
const dayDiff = (a, b) => Math.round((toDate(b) - toDate(a)) / DAY_MS);

// Language-neutral dates: 26.09.2026 / 26.09
const d = (v) => (v ? v.slice(0, 10).split('-').reverse().join('.') : '-');
const dm = (v) => v.slice(5, 10).split('-').reverse().join('.');
// Thousands grouped with a non-breaking space, matching money in app.js.
const numFmt = new Intl.NumberFormat('en-GB', { maximumFractionDigits: 2 });
const num = { format: (n) => numFmt.formatToParts(n).map((p) => (p.type === 'group' ? ' ' : p.value)).join('') };
const pctOf = (part, whole) => (whole ? Math.round((part / whole) * 100) : 0);
const clamp = (v, lo = 0, hi = 100) => Math.min(hi, Math.max(lo, v));

const MONTHS_KA = ['იან', 'თებ', 'მარ', 'აპრ', 'მაი', 'ივნ', 'ივლ', 'აგვ', 'სექ', 'ოქტ', 'ნოე', 'დეკ'];
const MONTHS_EN = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Georgian label with the English beside / beneath it.
const L = (ka, en) => `${esc(ka)}<em>${esc(en)}</em>`;
const H = (ka, en, note = '') => `
  <div class="rpt-h">
    <h2>${esc(ka)} <em>${esc(en)}</em></h2>
    ${note ? `<span class="rpt-h-note">${note}</span>` : ''}
  </div>`;
// A line only the interactive (.html) report shows, saying what can be clicked.
const clickHint = (ka, en) => `<p class="rpt-html-only rpt-click-note">👆 ${L(ka, en)}</p>`;
const none = `<p class="rpt-none">${L('მონაცემები არ არის', 'No data yet')}</p>`;
// Free text kept in both languages: Georgian first, English muted below.
const biText = (ka, en) => (ka && en
  ? `${esc(ka)}<br><span class="rpt-muted">${esc(en)}</span>`
  : esc(ka || en || '-'));

const TASK_STATUS = {
  done:     { ka: 'დასრულდა',         en: 'Done',        tone: 'ok' },
  overdue:  { ka: 'ვადაგადაცილება',    en: 'Overdue',     tone: 'bad' },
  active:   { ka: 'მიმდინარე',         en: 'In progress', tone: 'info' },
  upcoming: { ka: 'დაგეგმილი',         en: 'Upcoming',    tone: 'muted' },
  closed:   { ka: 'არ შესრულდა - პროექტი დაიხურა', en: 'Not done - project closed', tone: 'muted' },
};

const UNIT_STATUS = [
  ['not_started', 'არ დაწყებულა', 'Not started', 'muted'],
  ['in_progress', 'მიმდინარე', 'In progress', 'info'],
  ['finished', 'დასრულებული', 'Finished', 'ok'],
  ['handed_over', 'გადაცემული', 'Handed over', 'dark'],
];

// Timetable item / rental names typed in both languages.
const taskKa = (t) => t.name_ka || t.name;
const taskBi = (t) => biName(t.name, t.name_ka);
// The finish an item is held to. Where delays have extended it, the date the
// programme promised stays beside it, struck through, so neither is mistaken
// for the other.
const finishOf = (t) => (Number(t.extension_days)
  ? `<span class="rpt-was">${d(t.planned_finish)}</span> ${d(dueDate(t))}`
  : d(t.planned_finish));

const chip = (s, extraKa = '', extraEn = '') => `<span class="rpt-chip rpt-${s.tone}">`
  + `${esc(s.ka)}${esc(extraKa)}<br>${esc(s.en)}${esc(extraEn)}</span>`;
const legendItem = (tone, ka, en) => `<span class="rpt-legend-item"><i class="rpt-sw rpt-sw-${tone}"></i>${L(ka, en)}</span>`;

const tile = (ka, en, value, sub = '', tone = '') => `
  <div class="rpt-tile ${tone ? `rpt-tile-${tone}` : ''}">
    <span>${L(ka, en)}</span>
    <strong>${esc(value)}</strong>
    ${sub ? `<small>${sub}</small>` : ''}
  </div>`;

// "All amounts in GEL", said the Georgian way.
const CURRENCY_KA = { GEL: 'ლარშია', USD: 'დოლარშია' };
const currencyKa = (code) => `ყველა თანხა ${CURRENCY_KA[code] ?? `${code}-შია`}`;

// Where the project stands against its plan, in words (never colour alone).
// Behind also when anything is overdue or the pace so far finishes late (planVerdict).
function verdict(v, count, project = null) {
  // An ended project says how it ended, not where it stands against a plan.
  if (project?.closed_how) {
    const how = CLOSED_HOW[project.closed_how];
    return { ka: `${how.ka}${project.closed_on ? ` ${d(project.closed_on)}` : ''}`, en: `${how.en}${project.closed_on ? ` ${d(project.closed_on)}` : ''}`, tone: project.closed_how === 'completed' ? 'ok' : 'muted' };
  }
  if (!count) return { ka: 'გრაფიკი არ არის', en: 'No timetable', tone: 'muted' };
  if (v.key === 'behind') return { ka: 'გეგმას ჩამორჩება', en: 'Behind plan', tone: 'bad' };
  if (v.key === 'ahead') return { ka: 'გეგმას უსწრებს', en: 'Ahead of plan', tone: 'ok' };
  return { ka: 'გეგმის მიხედვით', en: 'On track', tone: 'ok' };
}

// Progress ring: outer = work complete, inner = planned by today.
function ring(actual, planned) {
  const arc = (r, pct) => {
    const c = 2 * Math.PI * r;
    return `stroke-dasharray="${((clamp(pct) / 100) * c).toFixed(1)} ${c.toFixed(1)}"`;
  };
  return `
    <svg class="rpt-ring" viewBox="0 0 120 120" width="116" height="116" aria-hidden="true">
      <circle cx="60" cy="60" r="50" fill="none" stroke="#e2e8f0" stroke-width="12"/>
      <circle cx="60" cy="60" r="50" fill="none" stroke="#059669" stroke-width="12" stroke-linecap="round"
              ${arc(50, actual)} transform="rotate(-90 60 60)"/>
      <circle cx="60" cy="60" r="35" fill="none" stroke="#f1f5f9" stroke-width="6"/>
      <circle cx="60" cy="60" r="35" fill="none" stroke="#64748b" stroke-width="6" stroke-linecap="round"
              ${arc(35, planned)} transform="rotate(-90 60 60)"/>
      <text x="60" y="64" text-anchor="middle" font-size="22" font-weight="700" fill="#0f172a"
            font-family="Inter, sans-serif">${actual}%</text>
    </svg>`;
}

// Recent logs and delays aren't kept in app state, so fetch them here.
async function fetchExtras(db, projectId, today) {
  const since = toDate(today);
  since.setDate(since.getDate() - 30);
  const [logs, delays, events, variations] = await Promise.all([
    db.from('daily_logs')
      .select('log_date, weather, manpower, notes, notes_en')
      .eq('project_id', projectId)
      .order('log_date', { ascending: false })
      .limit(14),
    db.from('delays')
      .select('created_at, delay_cause, duration_days, resolved_on, description, description_en, cause_contractor_id, flats(block, flat_number), impacts:delay_impacts(task_id)')
      .eq('project_id', projectId)
      // The last 30 days, plus anything still running from before - an open
      // delay belongs in the report however old it is.
      .or(`created_at.gte.${since.toISOString()},duration_days.is.null`)
      .order('created_at', { ascending: false }),
    // Safety is reported for the whole project, not a window: "42 days without
    // an incident" only means something counted from the start.
    db.from('site_events')
      .select('event_date, kind, severity, title, description, description_en, contractor_id, action, closed')
      .eq('project_id', projectId)
      .order('event_date', { ascending: false }),
    // Variations run for the life of the contract, so they are never windowed.
    db.from('variations')
      .select('ref, title, description, description_en, contractor_id, instructed_on, status, amount, days_claimed, decided_on')
      .eq('project_id', projectId)
      .order('instructed_on', { ascending: false }),
  ]);
  const failed = [logs, delays, events, variations].find((r) => r.error);
  if (failed) throw new Error(`Could not load report data: ${failed.error.message}`);
  return { logs: logs.data, delays: delays.data, events: events.data, variations: variations.data };
}

/**
 * Builds the report page element (not yet in the DOM).
 * `money` formats amounts in the project's currency.
 */
export async function buildProjectReport({
  db, project, tasks, payments, contractors, contractorDelays, units, progress, money,
  siteCosts = [], rentals = [], siteLogs = [], materials = [], work = [], delayImpacts = [], usdRate = null, moneyIn = [],
}) {
  const today = iso(new Date());
  const { logs, delays, events, variations } = await fetchExtras(db, project.id, today);
  const cost = costPosition(tasks, payments, today, siteCosts);
  const perf = contractorPerformance(tasks, contractorDelays, payments, today, materials); // all-time delays
  const manDays = contractorManDays(siteLogs); // who actually put men on the job
  const rooms = Boolean(project.has_rooms); // sites like a stadium have no rooms
  const contractorById = new Map(contractors.map((c) => [c.id, c]));
  // DAY_WORKERS stands for the client's own daily workers on a work entry.
  const DAY_WORKERS = '__day';
  const nameOf = (id) => {
    if (id === DAY_WORKERS) return 'დღიური მუშები / Daily workers';
    const c = contractorById.get(id);
    return c ? biName(c.name, c.name_ka) : '';
  };
  const workerOf = (w) => w.contractor_id ?? (w.by_day_workers ? DAY_WORKERS : '');
  const paidOn = (taskId) => payments.filter((p) => p.task_id === taskId).reduce((s, p) => s + Number(p.amount), 0);
  // Retention is money the contractor has earned and not been given yet, so it
  // is owed, not spent - it never touches the cost figures, only its own line.
  const taskContractor = new Map(tasks.map((t) => [t.id, t.contractor_id]));
  const retentionByContractor = new Map();
  let retentionHeld = 0;
  for (const p of payments) {
    const held = Number(p.retention || 0);
    if (!held) continue;
    retentionHeld += held;
    const id = taskContractor.get(p.task_id);
    if (id) retentionByContractor.set(id, (retentionByContractor.get(id) ?? 0) + held);
  }
  const m = (n) => money.format(n);
  // `money` is a plain { format } wrapper (see app.js), not a full Intl.NumberFormat,
  // so the currency symbol for the compact axis labels is derived separately.
  const symbol = new Intl.NumberFormat(undefined, {
    style: 'currency', currency: project.currency || 'USD', currencyDisplay: 'narrowSymbol',
  }).formatToParts(0).find((p) => p.type === 'currency')?.value ?? '';
  const compact = new Intl.NumberFormat('en-GB', { notation: 'compact', maximumFractionDigits: 1 });
  const mc = (n) => `${symbol}${compact.format(n)}`;

  const gap = progress.actualPct - progress.plannedPct;
  const status = verdict(planVerdict(progress, {
    tasks, startDate: project.start_date, endDate: project.end_date, todayIso: today,
  }), progress.count, project);
  const spentSub = [
    cost.budget ? `${pctOf(cost.spent, cost.budget)}% ${L('ბიუჯეტის', 'of budget')}` : '',
    cost.labour || cost.guard || cost.rental
      ? `${L('მ.შ. ობიექტის ხარჯები', 'incl. site costs')} ${m(cost.labour + cost.guard + cost.rental)}`
      : '',
    cost.material ? `${L('მ.შ. მასალები', 'incl. materials')} ${m(cost.material)}` : '',
  ].filter(Boolean).join('<br>');
  const delayDays = delays.reduce((s, x) => s + delayDaysLost(x, today), 0);
  const ongoingDelays = delays.filter(delayIsOngoing);
  const ongoingDays = ongoingDelays.reduce((s, x) => s + delayDaysLost(x, today), 0);

  // ---------- Header: name, client, verdict and the project's time strip ----------
  let timeStrip = '';
  if (project.start_date && project.end_date) {
    const total = Math.max(1, dayDiff(project.start_date, project.end_date));
    const elapsed = clamp(dayDiff(project.start_date, today), 0, total);
    const timePct = pctOf(elapsed, total);
    const left = dayDiff(today, project.end_date);
    timeStrip = `
      <div class="rpt-strip">
        <div class="rpt-strip-ends">
          <span>${L('დაწყება', 'Start')} <strong>${d(project.start_date)}</strong></span>
          <span>${left >= 0
            ? `${L('დარჩა', 'Left')} <strong>${left} ${L('დღე', 'days')}</strong>`
            : `<strong class="rpt-strip-late">${-left} ${L('დღით ვადაგადაცილებული', 'days past completion date')}</strong>`}</span>
          <span>${L('დასრულება', 'Completion')} <strong>${d(project.end_date)}</strong></span>
        </div>
        <div class="rpt-strip-track">
          <div class="rpt-strip-time" style="width:${timePct}%"></div>
          <div class="rpt-strip-work" style="width:${clamp(progress.actualPct)}%"></div>
          <div class="rpt-strip-today" style="left:${timePct}%"><span>${L('დღეს', 'Today')}</span></div>
        </div>
        <div class="rpt-strip-legend">
          ${L('გასული დრო', 'Time elapsed')} <strong>${timePct}%</strong>
          <span class="rpt-dot">·</span>
          ${L('შესრულებული სამუშაო', 'Work complete')} <strong>${progress.actualPct}%</strong>
        </div>
      </div>`;
  }

  const clientKa = project.client_name_ka || project.client_name || '';
  const clientEn = project.client_name || '';

  const header = `
    <header class="rpt-header">
      <div class="rpt-header-top">
        <div>
          <p class="rpt-eyebrow">პროექტის ანგარიში · Project Report</p>
          <h1>${esc(project.name_ka || project.name)}</h1>
          ${project.name_ka ? `<p class="rpt-h1-en">${esc(project.name)}</p>` : ''}
          <p class="rpt-sub">${esc(biName(project.location, project.location_ka))}</p>
          ${clientKa
            ? `<p class="rpt-client">დამკვეთი · Client: <strong>${esc(clientKa)}</strong>
                 ${clientEn && clientEn !== clientKa ? `<span class="rpt-client-en">${esc(clientEn)}</span>` : ''}</p>`
            : ''}
          ${project.currency
            ? `<p class="rpt-currency" id="rpt-currency">${L(currencyKa(project.currency), `All amounts in ${project.currency}`)}</p>`
            : ''}
          ${usdRate
            ? `<p class="rpt-currency" data-fx-skip>${L(`ეროვნული ბანკის კურსი ${d(usdRate.date)}: $1 = ${usdRate.rate.toFixed(4)} ₾`,
              `National Bank of Georgia rate ${d(usdRate.date)}`)}</p>`
            : ''}
        </div>
        <div class="rpt-header-date">
          <p class="rpt-eyebrow">თარიღი · Date</p>
          <p class="rpt-strong">${esc(dateKa(today))}</p>
          <p class="rpt-sub">${esc(dateEn(today))}</p>
          <p class="rpt-verdict rpt-verdict-${status.tone}">${esc(status.ka)} · ${esc(status.en)}</p>
        </div>
      </div>
      ${timeStrip}
    </header>`;

  // ---------- At a glance: ring + key figures ----------
  const area = units.reduce((s, u) => s + Number(u.area_m2 || 0), 0);
  const glance = `
    <section class="rpt-section rpt-glance rpt-avoid">
      <div class="rpt-ring-box">
        ${ring(progress.actualPct, progress.plannedPct)}
        <div class="rpt-ring-legend">
          <p><i class="rpt-sw rpt-sw-ok"></i><span>${L('შესრულებული', 'Work complete')}</span> <strong>${progress.actualPct}%</strong></p>
          <p><i class="rpt-sw rpt-sw-plan"></i><span>${L('გეგმით დღემდე', 'Planned by today')}</span> <strong>${progress.plannedPct}%</strong></p>
          <p class="rpt-gap">${progress.count
            ? `${gap >= 0 ? '+' : ''}${gap}% ${L('გეგმასთან შედარებით', 'vs plan')}`
            : L('დაამატეთ გრაფიკი', 'Add a timetable')}</p>
        </div>
      </div>
      <div class="rpt-tiles rpt-tiles-2">
        ${tile('ბიუჯეტი', 'Budget', m(cost.budget))}
        ${tile('დახარჯული', 'Spent', m(cost.spent), spentSub,
          cost.budget && cost.spent > cost.budget ? 'bad' : '')}
        ${tile('ვადაგადაცილებული სამუშაოები', 'Overdue items', String(progress.overdue.length),
          `${progress.count} ${L('სამუშაოდან', 'items in total')}`, progress.overdue.length ? 'bad' : 'ok')}
        ${rooms
          ? tile('ოთახები', 'Rooms', String(units.length), area ? `${num.format(area)} m²` : '')
          : tile('შეფერხებები (30 დღე)', 'Delays (30 days)', String(delays.length),
            delayDays
              ? `${delayDays} ${L(delayDays === 1 ? 'დაკარგული დღე' : 'დაკარგული დღეები', 'days lost')}`
              : '', delays.length ? 'warn' : '')}
      </div>
    </section>`;

  // ---------- Needs attention + next 14 days ----------
  const alerts = [];
  // Items behind their own dates, not counting the overdue ones named below.
  const stalled = stalledTasks(tasks, today);
  const overdueIds = new Set(progress.overdue.map((t) => t.id));
  const stalledCount = stalled.filter((x) => !overdueIds.has(x.task.id)).length;
  const lagging = stalledCount
    ? [`${stalledCount} სამუშაო ჩამორჩება გეგმას`, `${stalledCount} ${stalledCount === 1 ? 'item is' : 'items are'} behind plan`]
    : null;
  // How far behind the project is, and how many items it is behind on, are one
  // question at two sizes: one line. The ring beside this list already gives
  // both percentages, so it says only the gap.
  if (progress.count && gap < -5) {
    alerts.push(['bad',
      `გეგმას ჩამორჩება ${Math.abs(gap)}%-ით${stalledCount ? ` · ${stalledCount} სამუშაო` : ''}`,
      `Behind plan by ${Math.abs(gap)}%${stalledCount ? ` · ${stalledCount} ${stalledCount === 1 ? 'item' : 'items'}` : ''}`]);
  } else if (lagging) {
    alerts.push(['bad', ...lagging]);
  }
  for (const t of progress.overdue.slice(0, 5)) {
    const who = nameOf(t.contractor_id);
    alerts.push(['bad', `${taskKa(t)} - ${t.daysLate} დღით ვადაგადაცილებული${who ? ` (${who})` : ''}`,
      `${t.name} - ${t.daysLate} days overdue${who ? ` (${who})` : ''}`]);
  }
  if (progress.overdue.length > 5) {
    alerts.push(['bad', `და კიდევ ${progress.overdue.length - 5} ვადაგადაცილებული სამუშაო`,
      `and ${progress.overdue.length - 5} more overdue items`]);
  }
  if (project.end_date && today > project.end_date && progress.actualPct < 100) {
    alerts.push(['bad', 'დასრულების დაგეგმილი თარიღი გავიდა', 'Planned completion date has passed']);
  }
  if (cost.budget && cost.spent > cost.budget) {
    alerts.push(['bad', `ბიუჯეტი გადაჭარბებულია ${m(cost.spent - cost.budget)}-ით`,
      `Over budget by ${m(cost.spent - cost.budget)}`]);
  } else if (cost.contracts > cost.earnedWork + 0.5) {
    alerts.push(['warn', `კონტრაქტორებზე გადახდილია ${m(cost.contracts - cost.earnedWork)}-ით მეტი, ვიდრე შესრულებულია`,
      `Contractors paid ${m(cost.contracts - cost.earnedWork)} ahead of work done`]);
  }
  if (delays.length) {
    const byCause = new Map();
    for (const x of delays) byCause.set(x.delay_cause, (byCause.get(x.delay_cause) ?? 0) + delayDaysLost(x, today));
    const [topCause, topDays] = [...byCause].sort((a, b) => b[1] - a[1])[0];
    alerts.push(['warn', `ბოლო 30 დღეში ${delays.length} შეფერხება, ${delayDays} დღე; ძირითადი მიზეზი: ${bi(topCause).split(' / ')[0]} (${topDays} დღე)`,
      `${delays.length} ${delays.length === 1 ? 'delay' : 'delays'} in the last 30 days, ${delayDays} ${delayDays === 1 ? 'day' : 'days'} lost; mostly ${topCause} (${topDays} ${topDays === 1 ? 'day' : 'days'})`]);
  }


  const horizon = addDays(today, 14);
  const lookAhead = tasks
    .filter((t) => !t.done && completionOf(t) < 1)
    .flatMap((t) => {
      const out = [];
      if (t.planned_start > today && t.planned_start <= horizon) out.push({ t, date: t.planned_start, kind: 'start' });
      const due = dueDate(t);
      if (due >= today && due <= horizon) out.push({ t, date: due, kind: 'finish' });
      return out;
    })
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(0, 8);

  const attention = `
    <section class="rpt-section rpt-two rpt-avoid">
      <div class="rpt-panel">
        <h3>${L('საჭიროებს ყურადღებას', 'Needs attention')}</h3>
        ${alerts.length ? `
          <ul class="rpt-alert-list">
            ${alerts.map(([tone, ka, en]) => `
              <li class="rpt-alert-${tone}"><b>${tone === 'bad' ? '!' : '•'}</b><span>${esc(ka)}<em>${esc(en)}</em></span></li>`).join('')}
          </ul>`
          : `<p class="rpt-all-good">✓ ${L('ყველაფერი გეგმის მიხედვით მიდის', 'Everything is going to plan')}</p>`}
      </div>
      <div class="rpt-panel">
        <h3>${L('მომდევნო 14 დღე', 'Next 14 days')}</h3>
        ${lookAhead.length ? `
          <ul class="rpt-ahead">
            ${lookAhead.map(({ t, date, kind }) => `
              <li>
                <span class="rpt-ahead-date">${dm(date)}</span>
                <span class="rpt-ahead-what">
                  <strong>${esc(taskBi(t))}</strong>
                  <em>${kind === 'start'
                    ? `${esc('იწყება')} · Starts`
                    : `${esc('უნდა დასრულდეს')} · Due - ${Math.round(completionOf(t) * 100)}% ${esc('შესრულებული')} / done`}${
                    t.contractor_id ? ` · ${esc(nameOf(t.contractor_id))}` : ''}</em>
                </span>
              </li>`).join('')}
          </ul>`
          : `<p class="rpt-none">${L('ორ კვირაში დაწყება ან დასრულება არ იგეგმება', 'Nothing starts or is due in the next two weeks')}</p>`}
      </div>
    </section>`;

  // ---------- Drift since the approved programme ----------
  // Planned dates move as work slips, so "on time" always means on time
  // against today's plan. The baseline is what the client approved; the gap
  // between the two is the question they actually ask.
  // Measured to the due date: time a delay added is as much a move since
  // approval as a date someone changed by hand.
  const drifted = tasks
    .filter((t) => t.baseline_finish && dueDate(t) !== t.baseline_finish)
    .map((t) => ({ t, days: dayDiff(t.baseline_finish, dueDate(t)) }))
    .sort((a, b) => b.days - a.days);
  const baselined = tasks.filter((t) => t.baseline_finish);
  // When the project finishes is when its last activity finishes, so this is
  // the last approved finish against the last planned one. An activity in the
  // middle of the programme can slip a long way without touching either: that
  // is why this can read 0 while the table below lists work that has moved.
  const baseEnd = baselined.map((t) => t.baseline_finish).sort().at(-1);
  const plannedEnd = baselined.map(dueDate).sort().at(-1);
  const projectDrift = baselined.length ? dayDiff(baseEnd, plannedEnd) : 0;
  // Said as a phrase rather than a signed number: "20 days later" is read at a
  // glance, where "+20 days" leaves the reader to work out later than what.
  const driftDays = Math.abs(projectDrift);
  const driftPhrase = projectDrift > 0
    ? L(`${driftDays} დღით მეტი`, `${driftDays} day${driftDays === 1 ? '' : 's'} later`)
    : L(`${driftDays} დღით ნაკლები`, `${driftDays} day${driftDays === 1 ? '' : 's'} earlier`);

  const driftSection = !baselined.length ? '' : `
    <section class="rpt-section rpt-avoid">
      ${H('გადახრა დამტკიცებული გრაფიკიდან', 'Drift since baseline',
    project.baseline_set_on ? `${L('დამტკიცდა', 'approved')} ${d(project.baseline_set_on)}` : '')}
      <div class="rpt-tiles rpt-tiles-2 rpt-avoid">
        ${/* The date itself, not the shift in it. A bare "0" at the head of a
             section about slippage reads as a fault; a date with "unchanged"
             under it says the same thing and needs no working out. */ ''}
        ${tile('დასრულების თარიღი', 'Completion date', d(plannedEnd),
    projectDrift
      ? `${driftPhrase} · ${L('დამტკიცებული იყო', 'approved')} ${d(baseEnd)}`
      : L('უცვლელი დამტკიცების დღიდან', 'unchanged since baseline'),
    projectDrift > 0 ? 'bad' : 'ok')}
        ${tile('სამუშაოები გადაიწია', 'Activities moved', `${drifted.length} / ${baselined.length}`,
    '', drifted.length ? 'warn' : 'ok')}
      </div>
      ${drifted.length ? `
        <table class="rpt-compact">
          <thead>
            <tr>
              <th>${L('სამუშაო', 'Work item')}</th><th>${L('კონტრაქტორი', 'Contractor')}</th>
              <th>${L('დამტკიცებულის დასრულება', 'Baseline finish')}</th>
              <th>${L('ახლანდელი', 'Now')}</th><th class="num">${L('სხვაობა', 'Moved')}</th>
            </tr>
          </thead>
          <tbody>
            ${drifted.map(({ t, days }) => `
              <tr>
                <td>${esc(taskBi(t))}</td>
                <td>${t.contractor_id ? esc(nameOf(t.contractor_id)) : '-'}</td>
                <td><span class="rpt-was">${d(t.baseline_finish)}</span></td>
                <td>${d(dueDate(t))}</td>
                <td class="num ${days > 0 ? 'rpt-late' : ''}">${days > 0 ? '+' : ''}${days}</td>
              </tr>`).join('')}
          </tbody>
        </table>`
    : `<p class="rpt-all-good">✓ ${L('გრაფიკი დამტკიცების შემდეგ არ შეცვლილა', 'No dates have moved since the programme was approved')}</p>`}
    </section>`;

  // ---------- Timeline (Gantt) ----------
  let gantt = none;
  if (tasks.length) {
    const starts = tasks.map((t) => t.planned_start).concat(project.start_date ? [project.start_date] : []);
    const ends = tasks.map(dueDate).concat(project.end_date ? [project.end_date] : []);
    const first = toDate(starts.sort()[0]);
    const rangeStart = iso(new Date(first.getFullYear(), first.getMonth(), 1));
    const last = toDate(ends.sort().at(-1));
    const rangeEnd = iso(new Date(last.getFullYear(), last.getMonth() + 1, 1)); // exclusive
    const span = Math.max(1, dayDiff(rangeStart, rangeEnd));
    const x = (v) => (dayDiff(rangeStart, v) / span) * 100;

    const months = [];
    for (let c = toDate(rangeStart); c < toDate(rangeEnd); c.setMonth(c.getMonth() + 1)) months.push(new Date(c));
    const every = Math.ceil(months.length / 12); // keep month labels readable
    const grid = months.map((mo, i) => `<i class="rpt-g-line" style="left:${x(iso(mo)).toFixed(2)}%"></i>`).join('')
      + (today >= rangeStart && today < rangeEnd ? `<i class="rpt-g-today" style="left:${x(today).toFixed(2)}%"></i>` : '')
      + (project.end_date ? `<i class="rpt-g-end" style="left:${x(addDays(project.end_date, 1)).toFixed(2)}%"></i>` : '');

    const monthHead = months.map((mo, i) => {
      const w = (dayDiff(iso(mo), iso(new Date(mo.getFullYear(), mo.getMonth() + 1, 1))) / span) * 100;
      const show = i % every === 0;
      const year = i === 0 || mo.getMonth() === 0 ? ` ’${String(mo.getFullYear()).slice(2)}` : '';
      return `<span class="rpt-g-month" style="left:${x(iso(mo)).toFixed(2)}%;width:${w.toFixed(2)}%">${show
        ? `${MONTHS_KA[mo.getMonth()]}<em>${MONTHS_EN[mo.getMonth()]}${year}</em>` : ''}</span>`;
    }).join('');

    const rows = tasks.map((t) => {
      const s = taskState(t, today);
      const done = Math.round(completionOf(t) * 100);
      const left = x(t.planned_start);
      const width = Math.max(0.8, x(addDays(t.planned_finish, 1)) - left);
      // The time delays added, drawn on past the planned bar in a colour of its own.
      // It starts a hair inside the bar, so rounding leaves no seam between them.
      const ext = Number(t.extension_days) || 0;
      const extLeft = left + width;
      const extWidth = ext ? Math.max(0.4, x(addDays(dueDate(t), 1)) - extLeft) : 0;
      const who = nameOf(t.contractor_id);
      return `
        <div class="rpt-g-row rpt-avoid" data-pop="task:${esc(t.id)}">
          <div class="rpt-g-label">
            <strong>${esc(taskKa(t))}</strong>
            ${t.name_ka && t.name !== t.name_ka ? `<span class="rpt-g-en">${esc(t.name)}</span>` : ''}
            <span>${d(t.planned_start)} → ${finishOf(t)}${who ? ` · ${esc(who)}` : ''}</span>
          </div>
          <div class="rpt-g-track">
            ${grid}
            <div class="rpt-g-bar rpt-g-${s.key}${ext ? ' rpt-g-bar-extended' : ''}" style="left:${left.toFixed(2)}%;width:${width.toFixed(2)}%">
              <div class="rpt-g-fill" style="width:${done}%"></div>
            </div>
            ${ext ? `<div class="rpt-g-ext" style="left:${(extLeft - 0.1).toFixed(2)}%;width:${(extWidth + 0.1).toFixed(2)}%"></div>` : ''}
          </div>
          <div class="rpt-g-pct">
            <strong>${done}%</strong>
            <span class="rpt-g-state rpt-g-state-${s.key}">${esc(TASK_STATUS[s.key].ka)}${s.daysLate ? ` +${s.daysLate}` : ''}<br>${esc(TASK_STATUS[s.key].en)}${s.daysLate ? ` +${s.daysLate}` : ''}</span>
          </div>
        </div>`;
    }).join('');

    gantt = `
      <div class="rpt-legend">
        ${legendItem('ok', 'დასრულდა', 'Done')}
        ${legendItem('info', 'მიმდინარე', 'In progress')}
        ${legendItem('bad', 'ვადაგადაცილება', 'Overdue')}
        ${legendItem('muted', 'დაგეგმილი', 'Upcoming')}
        <span class="rpt-legend-item"><i class="rpt-sw rpt-sw-fill"></i>${L('მუქი ნაწილი = შესრულებული %', 'dark part = % complete')}</span>
        ${tasks.some((t) => Number(t.extension_days)) ? `<span class="rpt-legend-item"><i class="rpt-sw rpt-sw-ext"></i>${L('შეფერხებით გაგრძელებული ვადა', 'extended by delays')}</span>` : ''}
        <span class="rpt-legend-item"><i class="rpt-sw-line rpt-sw-today"></i>${L('დღეს', 'Today')}</span>
        ${project.end_date ? `<span class="rpt-legend-item"><i class="rpt-sw-line rpt-sw-end"></i>${L('დასრულების თარიღი', 'Completion date')}</span>` : ''}
      </div>
      <div class="rpt-gantt">
        <div class="rpt-g-row rpt-g-head">
          <div class="rpt-g-label">${L('სამუშაო', 'Work item')}</div>
          <div class="rpt-g-track rpt-g-months">${monthHead}</div>
          <div class="rpt-g-pct">${L('შესრ.', 'Done')}</div>
        </div>
        ${rows}
      </div>`;
  }
  const timeline = `
    <section class="rpt-section">
      ${H('სამუშაო გრაფიკი', 'Timeline', `${progress.count} ${L('სამუშაო', 'items')}`)}
      ${tasks.length ? clickHint('სამუშაოზე დაჭერით ნახავთ ვადებს, გადახდებს, მასალებს და შეფერხებებს', 'Click an activity to see its dates, payments, materials and delays') : ''}
      ${gantt}
    </section>`;

  // ---------- Work that isn't moving ----------
  // 0% against a start date that has passed usually means one of two things:
  // nobody is on it, or nobody has updated the figure. Both are worth asking about.
  const notMoving = !stalled.length ? '' : `
    <section class="rpt-section rpt-avoid">
      ${H('გეგმას ჩამორჩენილი სამუშაოები', 'Work behind plan', `${stalled.length} ${L('სამუშაო', 'items')}`)}
      <table class="rpt-compact">
        <thead>
          <tr>
            <th>${L('სამუშაო', 'Work item')}</th><th>${L('კონტრაქტორი', 'Contractor')}</th>
            <th>${L('დაგეგმილი', 'Planned')}</th>
            <th class="num">${L('გეგმით', 'Expected')}</th><th class="num">${L('ფაქტიური', 'Actual')}</th>
            <th>${L('განმარტება', 'What it means')}</th>
          </tr>
        </thead>
        <tbody>
          ${stalled.map((st) => `
            <tr>
              <td>${esc(taskBi(st.task))}</td>
              <td>${st.task.contractor_id ? esc(nameOf(st.task.contractor_id)) : '-'}</td>
              <td>${d(st.task.planned_start)} → ${finishOf(st.task)}</td>
              <td class="num">${st.expected}%</td>
              <td class="num rpt-late">${st.actual}%</td>
              <td>${st.kind === 'not_started'
    ? L(`უნდა დაწყებულიყო ${st.elapsed} დღის წინ`,
      `Due to start ${st.elapsed} days ago`)
    : L(`დღევანდელ გეგმას ${st.gap}%-ით ჩამორჩება`,
      `${st.gap}% short of where today's plan puts it`)}</td>
            </tr>`).join('')}
        </tbody>
      </table>
    </section>`;

  // ---------- Road to completion ----------
  const remaining = tasks.filter((t) => !t.done && completionOf(t) < 1);
  const forecast = forecastFinish({
    tasks, startDate: project.start_date, todayIso: today, actualPct: progress.actualPct,
  });
  const lateBy = forecast && project.end_date ? dayDiff(project.end_date, forecast.date) : null;

  // What is left, listed by the month it is due: a count says how much is
  // coming, but not which work it is - and that is what gets chased.
  const AHEAD_MAX = 15; // a long project would otherwise fill pages with rows
  const byFinish = [...remaining].sort((a, b) => dueDate(a).localeCompare(dueDate(b)));
  const aheadShown = byFinish.slice(0, AHEAD_MAX);
  const aheadMore = byFinish.length - aheadShown.length;
  const aheadMonths = new Map();
  for (const t of aheadShown) {
    const key = dueDate(t).slice(0, 7);
    if (!aheadMonths.has(key)) aheadMonths.set(key, []);
    aheadMonths.get(key).push(t);
  }
  const monthLabel = (key) => {
    const [y, mo] = key.split('-');
    return `${MONTHS_KA[Number(mo) - 1]}<em>${MONTHS_EN[Number(mo) - 1]} ’${y.slice(2)}</em>`;
  };
  const remainingPct = Math.max(0, 100 - progress.actualPct);
  const remainingBudget = remaining.reduce((sum, t) => sum + Number(t.budget || 0) * (1 - completionOf(t)), 0);

  const roadAhead = !remaining.length ? '' : `
    <section class="rpt-section rpt-avoid">
      ${H('პროექტის დასრულებამდე', 'Road to completion', `${remaining.length} ${L('დარჩენილი სამუშაო', 'items left')}`)}
      <div class="rpt-tiles rpt-tiles-2">
        ${tile('დარჩენილი სამუშაო', 'Work left', `${remainingPct}%`,
    `${remaining.length} ${L('სამუშაო', 'items')} · ${m(remainingBudget)} ${L('ბიუჯეტით', 'of budget')}`)}
        ${/* The planned date and the days left are in the header's time strip. */ ''}
        ${forecast
    ? tile('პროგნოზი ამ ტემპით', 'Forecast at this pace', d(forecast.date),
      lateBy === null
        ? L(`კიდევ ${forecast.remainingDays} დღე`, `${forecast.remainingDays} more days`)
        : lateBy > 0
          ? `${lateBy} ${L('დღით აგვიანებს', 'days later than planned')}`
          : `${Math.abs(lateBy)} ${L('დღით ადრე', 'days earlier than planned')}`,
      lateBy !== null && lateBy > 0 ? 'bad' : 'ok')
    : tile('პროგნოზი ამ ტემპით', 'Forecast at this pace', '-',
      L('ჯერ ნაადრევია', 'too early to say'), 'muted')}
      </div>
      ${aheadMonths.size ? `
        <table class="rpt-compact">
          <thead>
            <tr>
              <th>${L('სამუშაო', 'Work item')}</th>
              <th>${L('კონტრაქტორი', 'Contractor')}</th>
              <th>${L('უნდა დასრულდეს', 'Due to finish')}</th>
              <th class="num">${L('შესრ.', 'Done')}</th>
              <th class="num">${L('დარჩენილი თანხა', 'Value left')}</th>
            </tr>
          </thead>
          ${[...aheadMonths].map(([key, list]) => `
            <tbody>
              <tr class="rpt-month-row${key === today.slice(0, 7) ? ' rpt-current' : ''}">
                <td colspan="5">${monthLabel(key)} · ${list.length} ${L('სამუშაო', 'items')}</td>
              </tr>
              ${list.map((t) => {
    const leftValue = Number(t.budget || 0) * (1 - completionOf(t));
    return `
              <tr>
                <td>${esc(taskBi(t))}</td>
                <td>${t.contractor_id ? esc(nameOf(t.contractor_id)) : '-'}</td>
                <td>${finishOf(t)}</td>
                <td class="num">${Math.round(completionOf(t) * 100)}%</td>
                <td class="num">${leftValue ? m(leftValue) : '-'}</td>
              </tr>`;
  }).join('')}
            </tbody>`).join('')}
        </table>
        ${aheadMore ? `<p class="rpt-foot-note">${L(
    `და კიდევ ${aheadMore} სამუშაო - სრული სია გრაფიკშია.`,
    `and ${aheadMore} more - the timeline above lists them all.`,
  )}</p>` : ''}` : ''}
      ${forecast ? `<p class="rpt-foot-note">${L(
    `პროგნოზი ეყრდნობა აქამდე ნაჩვენებ ტემპს: ${forecast.elapsed} დღეში ${progress.actualPct}%.`,
    `The forecast follows the pace kept so far: ${progress.actualPct}% in ${forecast.elapsed} days.`,
  )}</p>` : ''}
    </section>`;

  // ---------- Money: S-curve, monthly table, cost per item ----------
  const planned = plannedSpendByMonth(tasks);
  const actual = actualSpendByMonth(payments);
  const site = siteCostsByMonth(siteCosts, today);
  const spentIn = (k) => (actual.get(k) ?? 0)
    + (site.get(k)?.labour ?? 0) + (site.get(k)?.guard ?? 0) + (site.get(k)?.rental ?? 0)
    + (site.get(k)?.material ?? 0);
  const monthKeys = [...new Set([...planned.keys(), ...actual.keys(), ...site.keys()])].sort();
  const thisMonth = today.slice(0, 7);
  const hasSite = site.size > 0;

  let sCurve = '';
  if (monthKeys.length) {
    let cp = 0;
    let ca = 0;
    const pts = monthKeys.map((k) => {
      cp += planned.get(k) ?? 0;
      ca += spentIn(k);
      return { k, cp, ca };
    });
    const W = 718; const Hh = 190; const padL = 52; const padR = 16; const padT = 14; const padB = 26;
    const max = Math.max(1, cost.budget, ...pts.map((p) => Math.max(p.cp, p.ca)));
    const px = (i) => padL + (pts.length === 1 ? (W - padL - padR) / 2 : (i / (pts.length - 1)) * (W - padL - padR));
    const py = (v) => padT + (1 - v / max) * (Hh - padT - padB);
    const line = (arr) => arr.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ');
    const planPath = line(pts.map((p, i) => [px(i), py(p.cp)]));
    const paidPts = pts.map((p, i) => ({ ...p, i })).filter((p) => p.k <= thisMonth);
    const paidPath = paidPts.length ? line(paidPts.map((p) => [px(p.i), py(p.ca)])) : '';
    const nowIdx = pts.findIndex((p) => p.k === thisMonth);
    const every = Math.ceil(pts.length / 10);
    const ticks = [0, 0.5, 1].map((f) => `
      <line x1="${padL}" x2="${W - padR}" y1="${py(max * f)}" y2="${py(max * f)}" stroke="#e2e8f0"/>
      <text x="${padL - 6}" y="${py(max * f) + 3}" text-anchor="end" font-size="9" fill="#64748b">${esc(mc(max * f))}</text>`).join('');
    const xLabels = pts.map((p, i) => (i % every === 0 || i === pts.length - 1 ? `
      <text x="${px(i)}" y="${Hh - 8}" text-anchor="middle" font-size="9" fill="${p.k === thisMonth ? '#0f172a' : '#64748b'}"
            font-weight="${p.k === thisMonth ? 700 : 400}">${p.k.slice(5)}.${p.k.slice(2, 4)}</text>` : '')).join('');
    const lastPaid = paidPts.at(-1);
    // The spent figure normally sits to the right of its last point. On the
    // right-hand edge there is no room, so it turns and sits to the left of it
    // instead - otherwise the amount runs off the chart and is cut in half.
    const lastPaidAtEdge = Boolean(lastPaid) && px(lastPaid.i) > W - padR - 70;
    sCurve = `
      <div class="rpt-chart rpt-avoid">
        <div class="rpt-legend">
          <span class="rpt-legend-item"><i class="rpt-sw-line rpt-sw-plan-line"></i>${L('გეგმა (ჯამური)', 'Planned (cumulative)')}</span>
          <span class="rpt-legend-item"><i class="rpt-sw-line rpt-sw-paid-line"></i>${L('დახარჯული (ჯამური)', 'Spent (cumulative)')}</span>
          <span class="rpt-legend-item"><i class="rpt-sw rpt-sw-ok rpt-sw-round"></i>${L('შესრულებული სამუშაო დღეს', 'Work done today')}</span>
        </div>
        <svg viewBox="0 0 ${W} ${Hh}" width="${W}" height="${Hh}" aria-hidden="true">
          ${ticks}
          ${nowIdx >= 0 ? `<line x1="${px(nowIdx)}" x2="${px(nowIdx)}" y1="${padT}" y2="${Hh - padB}" stroke="#e11d48" stroke-dasharray="3 3"/>` : ''}
          <path d="${planPath} L${px(pts.length - 1)},${py(0)} L${px(0)},${py(0)} Z" fill="#64748b" fill-opacity="0.08"/>
          <path d="${planPath}" fill="none" stroke="#64748b" stroke-width="2" stroke-dasharray="5 4"/>
          ${paidPath ? `<path d="${paidPath}" fill="none" stroke="#f59e0b" stroke-width="2.5"/>` : ''}
          ${paidPts.map((p) => `<circle cx="${px(p.i)}" cy="${py(p.ca)}" r="2.5" fill="#f59e0b"/>`).join('')}
          ${nowIdx >= 0 ? `<circle cx="${px(nowIdx)}" cy="${py(cost.earned)}" r="5" fill="#059669" stroke="#fff" stroke-width="1.5"/>` : ''}
          ${lastPaid ? `<text x="${px(lastPaid.i) + (lastPaidAtEdge ? -7 : 7)}" y="${py(lastPaid.ca) - 6}"
            text-anchor="${lastPaidAtEdge ? 'end' : 'start'}" font-size="10" font-weight="700" fill="#b45309">${esc(mc(lastPaid.ca))}</text>` : ''}
          <text x="${px(pts.length - 1) - 2}" y="${py(pts.at(-1).cp) - 6}" text-anchor="end" font-size="10" font-weight="700" fill="#475569">${esc(mc(pts.at(-1).cp))}</text>
          ${xLabels}
        </svg>
      </div>`;
  }

  let cp = 0;
  let ca = 0;
  const monthTable = monthKeys.length ? `
    <table class="rpt-compact">
      <thead>
        <tr>
          <th>${L('თვე', 'Month')}</th><th class="num">${L('გეგმა', 'Planned')}</th>
          <th class="num">${L('კონტრაქტები', 'Contracts')}</th>
          ${hasSite ? `<th class="num">${L('დღიური მუშები', 'Daily workers')}</th>
            <th class="num">${L('დარაჯები', 'Guards')}</th>
            <th class="num">${L('ქირა', 'Rentals')}</th>
            <th class="num">${L('მასალები', 'Materials')}</th>` : ''}
          <th class="num">${L('ჯამური გეგმა', 'Cumulative plan')}</th>
          <th class="num">${L('ჯამური ხარჯი', 'Cumulative spent')}</th>
        </tr>
      </thead>
      <tbody>
        ${monthKeys.map((k) => {
          const p = planned.get(k) ?? 0;
          const a = actual.get(k) ?? 0;
          const sc = site.get(k) ?? { labour: 0, guard: 0, rental: 0, material: 0 };
          cp += p;
          ca += spentIn(k);
          return `
            <tr class="${k === thisMonth ? 'rpt-current' : ''}" data-pop="month:${k}">
              <td>${MONTHS_KA[Number(k.slice(5)) - 1]} / ${MONTHS_EN[Number(k.slice(5)) - 1]} ${k.slice(0, 4)}</td>
              <td class="num">${m(p)}</td>
              <td class="num">${a ? m(a) : '-'}</td>
              ${hasSite ? `<td class="num">${sc.labour ? m(sc.labour) : '-'}</td>
                <td class="num">${sc.guard ? m(sc.guard) : '-'}</td>
                <td class="num">${sc.rental ? m(sc.rental) : '-'}</td>
                <td class="num">${sc.material ? m(sc.material) : '-'}</td>` : ''}
              <td class="num">${m(cp)}</td>
              <td class="num">${k <= thisMonth ? m(ca) : '-'}</td>
            </tr>`;
        }).join('')}
      </tbody>
    </table>` : '';

  const budgeted = tasks.filter((t) => Number(t.budget) > 0).sort((a, b) => Number(b.budget) - Number(a.budget));
  const maxBudget = Math.max(1, ...budgeted.map((t) => Number(t.budget)));
  const itemCosts = budgeted.length ? `
    <h3 class="rpt-sub-h">${L('ღირებულება სამუშაოების მიხედვით', 'Cost by item')}</h3>
    <div class="rpt-legend">
      <span class="rpt-legend-item"><i class="rpt-sw rpt-sw-plan-light"></i>${L('ბიუჯეტი', 'Budget')}</span>
      <span class="rpt-legend-item"><i class="rpt-sw rpt-sw-ok"></i>${L('შესრულებული', 'Work done')}</span>
      <span class="rpt-legend-item"><i class="rpt-sw-line rpt-sw-paid-line"></i>${L('გადახდილი', 'Paid')}</span>
    </div>
    <div class="rpt-hbars">
      ${budgeted.map((t) => {
        const b = Number(t.budget);
        const paid = paidOn(t.id);
        const w = (b / maxBudget) * 100;
        return `
          <div class="rpt-hbar rpt-avoid">
            <span class="rpt-hbar-label">${esc(t.name_ka || t.name)}${
              t.name_ka && t.name && t.name_ka !== t.name ? `<em>${esc(t.name)}</em>` : ''}</span>
            <div class="rpt-hbar-track">
              <div class="rpt-hbar-budget" style="width:${w.toFixed(2)}%">
                <div class="rpt-hbar-done" style="width:${Math.round(completionOf(t) * 100)}%"></div>
                <i class="rpt-hbar-paid" style="left:${clamp((paid / b) * 100, 0, 100).toFixed(2)}%"></i>
              </div>
            </div>
            <span class="rpt-hbar-value">${m(b)}<em>${paid ? `${L('გადახდილი', 'paid')} ${m(paid)}` : L('გადაუხდელი', 'unpaid')}</em></span>
          </div>`;
      }).join('')}
    </div>` : '';

  // Daily workers, guards and equipment rentals (money outside the BOQ)
  const labour = siteCosts.filter((e) => e.kind === 'labour');
  const workerDays = labour.reduce((sum, e) => sum + e.workers, 0);
  const guards = siteCosts.filter((e) => e.kind === 'guard');
  const guardDays = guards.reduce((sum, e) => sum + e.workers, 0);
  const siteCostsBlock = labour.length || guards.length || rentals.length ? `
    <h3 class="rpt-sub-h">${L('ობიექტის სხვა ხარჯები', 'Other site costs')}</h3>
    ${/* Contract payments and the total are tiles at the head of this section. */ ''}
    <div class="rpt-tiles rpt-avoid">
      ${tile('დღიური მუშები', 'Daily workers', m(cost.labour),
        workerDays ? `${workerDays} ${L('კაც-დღე', 'worker-days')}` : '')}
      ${tile('დარაჯები', 'Guards', m(cost.guard),
        guardDays ? `${guardDays} ${L('კაც-დღე', 'guard-days')}` : '')}
      ${tile('ტექნიკის ქირა', 'Equipment rentals', m(cost.rental),
        rentals.length ? `${rentals.length} ${L('ქირა', 'rentals')}` : '')}
    </div>
    ${rentals.length ? `
      <table class="rpt-compact">
        <thead>
          <tr>
            <th>${L('ტექნიკა', 'Equipment')}</th><th>${L('მომწოდებელი', 'Supplier')}</th>
            <th>${L('პერიოდი', 'Period')}</th><th class="num">${L('დღე × ტარიფი', 'Days × price')}</th>
            <th class="num">${L('ღირებულება', 'Cost')}</th>
          </tr>
        </thead>
        <tbody>
          ${rentals.map((r) => `
            <tr>
              <td>${esc(biName(r.equipment, r.equipment_ka))}</td>
              <td>${esc(biName(r.supplier, r.supplier_ka) || '-')}</td>
              <td>${d(r.start_date)} → ${d(rentalEnd(r))}</td>
              <td class="num">${r.days} × ${m(r.daily_rate)}</td>
              <td class="num">${m(rentalTotal(r))}</td>
            </tr>`).join('')}
        </tbody>
      </table>` : ''}` : '';

  // Materials the client bought and handed to a contractor, by job
  const taskById = new Map(tasks.map((t) => [t.id, t]));
  const materialsBlock = materials.length ? `
    <h3 class="rpt-sub-h">${L('დამკვეთის მიერ შეძენილი მასალები და ინვენტარი', 'Materials and purchases by the client')}</h3>
    <table class="rpt-compact">
      <thead>
        <tr>
          <th>${L('თარიღი', 'Date')}</th><th>${L('დასახელება', 'Item')}</th>
          <th>${L('სამუშაო / კონტრაქტორი', 'Job / contractor')}</th>
          <th class="num">${L('რაოდენობა', 'Quantity')}</th><th class="num">${L('თანხა', 'Amount')}</th>
        </tr>
      </thead>
      <tbody>
        ${[...materials].sort((a, b) => a.bought_on.localeCompare(b.bought_on)).map((x) => {
          const t = taskById.get(x.task_id);
          const job = x.kind === 'tool' ? L('ხელსაწყო / ინვენტარი', 'Tool / equipment')
            : x.kind === 'other' ? L('სხვა', 'Other')
            : t ? [esc(taskBi(t)), t.contractor_id ? esc(nameOf(t.contractor_id)) : ''].filter(Boolean).join(' · ')
            : L('ზოგადი', 'General');
          return `
            <tr>
              <td>${d(x.bought_on)}</td>
              <td>${esc(biName(x.item, x.item_ka))}</td>
              <td>${job}</td>
              <td class="num">${x.quantity != null ? `${num.format(x.quantity)} ${esc(x.unit || '')}` : '-'}</td>
              <td class="num">${m(x.amount)}</td>
            </tr>`;
        }).join('')}
      </tbody>
      <tfoot>
        <tr><td colspan="4">${L('სულ', 'Total')}</td><td class="num">${m(materials.reduce((s, x) => s + Number(x.amount || 0), 0))}</td></tr>
      </tfoot>
    </table>` : '';

  // ---------- Variations ----------
  // The contract sum the client signed, plus what has been approved on top of
  // it. An instructed-but-unpriced variation is work already being done that
  // nobody has agreed a figure for, which is why it is shown, not hidden.
  const VARIATION_STATUS = {
    instructed: { ka: 'დავალებული', en: 'Instructed', tone: 'warn' },
    priced: { ka: 'შეფასებული', en: 'Priced', tone: 'info' },
    approved: { ka: 'დამტკიცებული', en: 'Approved', tone: 'ok' },
    rejected: { ka: 'უარყოფილი', en: 'Rejected', tone: 'muted' },
  };
  const approvedVars = variations.filter((v) => v.status === 'approved');
  const openVars = variations.filter((v) => v.status === 'instructed' || v.status === 'priced');
  const approvedValue = approvedVars.reduce((sum, v) => sum + Number(v.amount || 0), 0);
  const openValue = openVars.reduce((sum, v) => sum + Number(v.amount || 0), 0);
  const approvedDays = approvedVars.reduce((sum, v) => sum + Number(v.days_claimed || 0), 0);
  const contractSum = tasks.reduce((sum, t) => sum + Number(t.budget || 0), 0);

  const variationsBlock = !variations.length ? '' : `
    <h3 class="rpt-sub-h">${L('ცვლილებები (დამატებითი სამუშაოები)', 'Variations')}</h3>
    <div class="rpt-tiles rpt-avoid">
      ${tile('დამტკიცებული ცვლილებები', 'Variations approved', m(approvedValue),
    `${approvedVars.length} ${L('ცვლილება', approvedVars.length === 1 ? 'variation' : 'variations')}`)}
      ${tile('გადაწყვეტილების მოლოდინში', 'Awaiting a decision', m(openValue),
    openVars.length ? `${openVars.length} ${L('ღია', 'not settled')}` : '', openVars.length ? 'warn' : 'ok')}
      ${tile('კონტრაქტის შესწორებული ღირებულება', 'Revised contract sum', m(contractSum + approvedValue),
    approvedDays ? `+${approvedDays} ${L('დღე', approvedDays === 1 ? 'day' : 'days')}` : '')}
    </div>
    <table class="rpt-compact rpt-avoid">
      <thead>
        <tr>
          <th>${L('ნომერი', 'Ref')}</th><th>${L('დავალების თარიღი', 'Instructed')}</th>
          <th>${L('რა დაევალა', 'What was instructed')}</th>
          <th>${L('კონტრაქტორი', 'Contractor')}</th>
          <th class="num">${L('ღირებულება', 'Value')}</th><th class="num">${L('დღე', 'Days')}</th>
          <th>${L('სტატუსი', 'Status')}</th>
        </tr>
      </thead>
      <tbody>
        ${variations.map((v) => `
          <tr>
            <td>${v.ref ? esc(v.ref) : '-'}</td>
            <td>${d(v.instructed_on)}</td>
            <td class="rpt-prose">${esc(v.title)}${v.description || v.description_en
    ? `<em class="rpt-block">${esc(v.description_en || v.description)}</em>` : ''}</td>
            <td>${v.contractor_id ? esc(nameOf(v.contractor_id)) : '-'}</td>
            <td class="num">${Number(v.amount) ? m(v.amount) : '-'}</td>
            <td class="num">${Number(v.days_claimed) || '-'}</td>
            <td>${chip(VARIATION_STATUS[v.status] ?? { ka: v.status, en: v.status, tone: 'muted' })}</td>
          </tr>`).join('')}
      </tbody>
    </table>`;

  const costSection = `
    <section class="rpt-section">
      ${H('ბიუჯეტი და ფულადი ნაკადი', 'Budget & Cash Flow')}
      ${/* The budget itself is a tile at a glance, and the line in the chart below. */ ''}
      <div class="rpt-tiles${retentionHeld ? '' : ' rpt-tiles-2'} rpt-avoid">
        ${tile('გეგმით დღემდე', 'Planned by today', m(cost.planned))}
        ${tile('შესრულებული სამუშაო', 'Work done', m(cost.earned), '', cost.earned < cost.planned - 0.5 ? 'bad' : 'ok')}
        ${retentionHeld ? tile('დაკავებული გარანტია', 'Retention held', m(retentionHeld),
    project.retention_pct ? `${Number(project.retention_pct)}% ${L('ყოველი გადახდიდან', 'of each payment')}` : '', 'muted') : ''}
      </div>
      ${monthKeys.length ? sCurve + clickHint('თვეზე დაჭერით ნახავთ, რაზე დაიხარჯა თანხა', 'Click a month to see what the money was spent on') + monthTable : none}
      ${variationsBlock}
      ${itemCosts}
      ${siteCostsBlock}
      ${materialsBlock}
    </section>`;

  // ---------- Finance: what the project earns against what it costs ----------
  // Shown once the project says where its income comes from (see finance.js).
  const fin = financePosition({ project, tasks, rooms: units, variations, materials, payments, siteCosts, moneyIn, today });
  let financeSection = '';
  // Only with prices to show, and only when the project lets the client see it.
  if (fin.source && fin.income > 0 && project.finance_in_report !== false) {
    const pct = (part, whole) => (whole ? `${(part / whole * 100).toFixed(1)}%` : '-');
    const tone = (v) => (v < 0 ? 'bad' : v > 0 ? 'ok' : '');
    // The forecast of the final cost, against the budget.
    const over = fin.forecast.total - fin.forecast.budget;
    const costSub = [
      `${L('ბიუჯეტი', 'budget')} ${m(fin.forecast.budget)}`,
      Math.abs(over) >= 0.5 ? `${m(Math.abs(over))} ${over > 0 ? L('ბიუჯეტს ზემოთ', 'over budget') : L('ბიუჯეტზე ნაკლები', 'under budget')}` : '',
      fin.interest ? `${L('სესხის პროცენტი', 'loan interest')} ${m(fin.interest)}` : '',
    ].filter(Boolean).join(' · ');
    const sales = fin.sales;
    const incomeSub = sales
      ? `${sales.sold.count} ${L('გაყიდული', 'sold')} · ${sales.reserved.count} ${L('დაჯავშნილი', 'reserved')} · ${sales.forSale.count} ${L('იყიდება', 'for sale')}`
      : `${m(fin.earned)} ${L('გამომუშავებული', 'earned by the work done')}`;
    const tiles = `
      <div class="rpt-tiles rpt-tiles-4 rpt-avoid">
        ${tile('შემოსავალი', 'Income', m(fin.income), incomeSub)}
        ${tile('მოსალოდნელი საბოლოო ხარჯი', 'Forecast final cost', m(fin.cost), costSub, over > 0.5 ? 'bad' : '')}
        ${fin.profit < 0
    ? tile('მოსალოდნელი ზარალი', 'Expected loss', m(fin.profit), L('შემოსავალი − ხარჯი', 'Income − cost'), 'bad')
    : tile('მოსალოდნელი მოგება', 'Expected profit', m(fin.profit), L('შემოსავალი − ხარჯი', 'Income − cost'), tone(fin.profit))}
        ${tile('მარჟა', 'Margin', pct(fin.profit, fin.income), L('შემოსავლიდან', 'of income'), tone(fin.profit))}
      </div>`;
    const note = `<p class="rpt-muted">${L(
      'საბოლოო ხარჯის პროგნოზი: სამუშაო ბიუჯეტით ან რეალური ხარჯით (თუ მეტია), დღიური მუშები, დარაჯები და ქირა - დღევანდელი ტემპით დასრულებამდე.',
      'Forecast final cost: each item at its budget or what really went into it when more; daily workers, guards and rentals at today\'s rate to completion.',
    )}</p>`;

    let detail = '';
    if (sales) {
      const perM2 = (amount, area) => (area ? m(amount / area) : '-');
      const row = (ka, en, b) => `
        <tr><td>${L(ka, en)}</td><td class="num">${b.count}</td><td class="num">${num.format(b.area)} m²</td>
          <td class="num">${m(b.amount)}</td><td class="num">${perM2(b.amount, b.area)}</td></tr>`;
      const all = { count: sales.sold.count + sales.reserved.count + sales.forSale.count, area: sales.sellable, amount: sales.income };
      const costPerM2 = sales.sellable ? fin.cost / sales.sellable : 0;
      const pricePerM2 = sales.sellable ? sales.income / sales.sellable : 0;
      const types = salesByType(units, project.price_per_m2);
      detail = `
        <div class="rpt-tiles rpt-avoid">
          ${tile('ხარჯი 1 მ²-ზე', 'Cost per m²', sales.sellable ? m(costPerM2) : '-',
    sales.sellable ? `${num.format(sales.sellable)} m² ${L('გასაყიდი', 'for sale')}` : '')}
          ${tile('ფასი 1 მ²-ზე', 'Price per m²', sales.sellable ? m(pricePerM2) : '-',
    sales.sold.area ? `${L('გაიყიდა', 'sold at')} ${m(sales.sold.amount / sales.sold.area)}` : L('ჯერ არაფერი გაყიდულა', 'nothing sold yet'))}
          ${tile('მოგება 1 მ²-ზე', 'Profit per m²', sales.sellable ? m(pricePerM2 - costPerM2) : '-', '', tone(pricePerM2 - costPerM2))}
        </div>
        <h3 class="rpt-sub-h">${L('გაყიდვები', 'Sales')}</h3>
        <table class="rpt-compact rpt-avoid">
          <thead><tr><th></th><th class="num">${L('ოთახი', 'Rooms')}</th><th class="num">${L('ფართი', 'Area')}</th>
            <th class="num">${L('შემოსავალი', 'Income')}</th><th class="num">${L('1 მ²', 'Per m²')}</th></tr></thead>
          <tbody>
            ${row('გაყიდული', 'Sold', sales.sold)}
            ${row('დაჯავშნილი', 'Reserved', sales.reserved)}
            ${row('იყიდება', 'For sale', sales.forSale)}
          </tbody>
          <tfoot>${row('სულ', 'Total', all)}</tfoot>
        </table>
        ${types.length ? `
        <h3 class="rpt-sub-h">${L('ტიპების მიხედვით', 'By type')}</h3>
        <table class="rpt-compact rpt-avoid">
          <thead><tr><th>${L('ტიპი', 'Type')}</th><th class="num">${L('ოთახი', 'Rooms')}</th><th class="num">${L('გაყიდული', 'Sold')}</th>
            <th class="num">${L('ფართი', 'Area')}</th><th class="num">${L('შემოსავალი', 'Income')}</th><th class="num">${L('1 მ²', 'Per m²')}</th></tr></thead>
          <tbody>
            ${types.map(([type, t]) => `
              <tr><td>${type ? esc(bi(type)) : L('ტიპის გარეშე', 'No type')}</td><td class="num">${t.count}</td><td class="num">${t.sold}</td>
                <td class="num">${num.format(t.area)} m²</td><td class="num">${m(t.amount)}</td><td class="num">${perM2(t.amount, t.area)}</td></tr>`).join('')}
          </tbody>
        </table>` : ''}`;
    } else if (fin.items.length) {
      detail = `
        <h3 class="rpt-sub-h">${L('მარჟა სამუშაოების მიხედვით', 'Margin by item')}</h3>
        <table class="rpt-compact">
          <thead>
            <tr>
              <th>${L('სამუშაო', 'Work item')}</th><th class="num">${L('დამკვეთის ფასი', "Employer's price")}</th>
              <th class="num">${L('ხარჯი', 'Cost')}</th><th class="num">${L('მარჟა', 'Margin')}</th>
              <th class="num">%</th><th class="num">${L('გამომუშავებული', 'Earned')}</th>
            </tr>
          </thead>
          <tbody>
            ${fin.items.map(({ task: t, income, cost: c, margin, earned }) => `
              <tr>
                <td>${esc(taskBi(t))}</td>
                <td class="num">${income ? m(income) : L('ფასი არ აქვს', 'no price')}</td>
                <td class="num">${c ? m(c) : '-'}</td>
                <td class="num">${!income && !c ? '-' : `<span class="${margin < 0 ? 'rpt-neg' : ''}">${m(margin)}</span>`}</td>
                <td class="num">${income ? pct(margin, income) : '-'}</td>
                <td class="num">${earned ? m(earned) : '-'}</td>
              </tr>`).join('')}
          </tbody>
          <tfoot>
            <tr>
              <td>${L('სულ', 'Total')}</td><td class="num">${m(fin.income)}</td>
              <td class="num">${m(fin.items.reduce((s, i) => s + i.cost, 0))}</td>
              <td class="num">${m(fin.income - fin.items.reduce((s, i) => s + i.cost, 0))}</td>
              <td class="num">${pct(fin.income - fin.items.reduce((s, i) => s + i.cost, 0), fin.income)}</td>
              <td class="num">${m(fin.earned)}</td>
            </tr>
          </tfoot>
        </table>`;
    }
    financeSection = `
      <section class="rpt-section">
        ${H('ფინანსები: მოგება და ზარალი', 'Finance: profit and loss')}
        ${tiles}
        ${note}
        ${detail}
      </section>`;
  }

  // ---------- Contractors: one card each ----------
  const rating = (s) => {
    if (!s?.items) return chip({ ka: 'სამუშაო არ აქვს', en: 'No work yet', tone: 'muted' });
    if (s.overdue) return chip({ ka: 'ვადაგადაცილება', en: 'Overdue', tone: 'bad' });
    if (s.late) return chip({ ka: 'დაგვიანება', en: 'Late', tone: 'warn' },
      ` · ${s.avgDaysLate} დღე`, ` · ${s.avgDaysLate} ${s.avgDaysLate === 1 ? 'day' : 'days'}`);
    if (s.onTime) return chip({ ka: 'ვადაში', en: 'On time', tone: 'ok' });
    return chip({ ka: 'მიმდინარე', en: 'Ongoing', tone: 'info' });
  };
  const seg = (n, total, tone) => (n ? `<i class="rpt-seg rpt-seg-${tone}" style="width:${(n / total) * 100}%"></i>` : '');
  const contractorsSection = `
    <section class="rpt-section">
      ${H('კონტრაქტორები', 'Contractors', `${contractors.length}`)}
      ${contractors.length ? clickHint('კონტრაქტორზე დაჭერით ნახავთ მის სამუშაოებს, გადახდებს და შეფერხებებს', 'Click a contractor to see their jobs, payments and delays') : ''}
      ${contractors.length ? `
        <div class="rpt-cards">
          ${contractors.map((c) => {
            const s = perf.get(c.id);
            const items = s?.items ?? 0;
            const budget = s?.budget ?? 0;
            const paid = s?.paid ?? 0;
            const held = retentionByContractor.get(c.id) ?? 0;
            const crew = manDays.get(c.id);
            return `
              <article class="rpt-card rpt-avoid" data-pop="con:${esc(c.id)}">
                <div class="rpt-card-head">
                  <div>
                    <strong>${esc(biName(c.name, c.name_ka))}</strong>
                    ${c.trade ? `<span class="rpt-muted">${esc(bi(c.trade))}</span>` : ''}
                  </div>
                  ${rating(s)}
                </div>
                ${items ? `
                  <div class="rpt-segbar">${seg(s.onTime, items, 'ok')}${seg(s.late, items, 'warn')}${seg(s.overdue, items, 'bad')}${seg(s.open, items, 'muted')}</div>
                  <p class="rpt-card-stats">
                    <span><b>${items}</b> ${L('სამუშაო', 'items')}</span>
                    <span><i class="rpt-sw rpt-sw-ok"></i>${s.onTime} ${L('ვადაში', 'on time')}</span>
                    <span><i class="rpt-sw rpt-sw-warn"></i>${s.late} ${L('დაგვიანებით', 'late')}</span>
                    <span><i class="rpt-sw rpt-sw-bad"></i>${s.overdue} ${L('ვადაგადაცილებული', 'overdue')}</span>
                    <span><i class="rpt-sw rpt-sw-muted"></i>${s.open} ${L('ღია', 'open')}</span>
                  </p>` : ''}
                <div class="rpt-card-money">
                  <span>${L('გადახდილი', 'Paid')}<span class="rpt-card-value"><b>${m(paid)}</b>${budget ? ` / ${m(budget)}` : ''}</span></span>
                  ${s?.materials ? `<span>${L('მიწოდებული მასალა', 'Materials supplied')}<span class="rpt-card-value"><b>${m(s.materials)}</b></span></span>` : ''}
                  <span>${L('შეფერხება (დღე)', 'Delays (days)')}<span class="rpt-card-value"><b>${s?.delayDays ?? 0}</b></span></span>
                  ${s?.excusedDays ? `<span>${L('სხვისი ბრალით (დღე)', 'Excused (days)')}<span class="rpt-card-value"><b>${s.excusedDays}</b></span></span>` : ''}
                </div>
                ${crew ? `
                  <p class="rpt-card-contact">
                    ${L('კაც-დღე', 'Man-days')} <b>${num.format(crew.days)}</b>
                    · ${L('ობიექტზე', 'on site')} <b>${crew.onSite}</b> ${L('დღე', 'days')}
                    ${crew.onSite ? `· ${L('საშუალოდ', 'avg')} <b>${(crew.days / crew.onSite).toFixed(1)}</b> ${L('კაცი/დღე', 'men/day')}` : ''}
                  </p>` : ''}
                ${held ? `<p class="rpt-card-contact">${L('დაკავებული გარანტია', 'Retention held')} <b>${m(held)}</b></p>` : ''}
                ${budget ? `<div class="rpt-minibar"><i style="width:${clamp(pctOf(paid, budget))}%"></i></div>` : ''}
                ${c.phone || c.email ? `<p class="rpt-card-contact">${esc([c.contact_person, c.phone, c.email].filter(Boolean).join(' · '))}</p>` : ''}
              </article>`;
          }).join('')}
        </div>` : none}
    </section>`;

  // ---------- Rooms (only for sites that have them) ----------
  const roomsWithWork = new Set(work.map((w) => w.flat_id).filter(Boolean));
  let unitsSection = '';
  if (rooms) {
    const byType = new Map();
    for (const u of units) {
      const key = u.unit_type || '-';
      const e = byType.get(key) ?? { n: 0, area: 0 };
      e.n += 1;
      e.area += Number(u.area_m2 || 0);
      byType.set(key, e);
    }
    const counts = UNIT_STATUS.map(([key, ka, en, tone]) => ({
      ka, en, tone, n: units.filter((u) => (u.status ?? 'not_started') === key).length,
    }));
    // Every room, grouped block by block and floor by floor, highest floor first
    // - the colour carries the status, the number is there when you need it.
    const blocks = new Map();
    for (const u of units) {
      const block = u.block || ''; // a building with one entrance has none
      if (!blocks.has(block)) blocks.set(block, new Map());
      const floors = blocks.get(block);
      const floor = Number(u.floor ?? 0);
      if (!floors.has(floor)) floors.set(floor, []);
      floors.get(floor).push(u);
    }
    const toneOf = (u) => (UNIT_STATUS.find(([key]) => key === (u.status ?? 'not_started'))?.[3] ?? 'muted');
    // Georgian ordinals: 1-ლი, then მე-2, მე-3 … Floor 0 is its own word.
    const ordinalKa = (n) => (n === 1 ? '1-ლი' : `მე-${n}`);
    const floorKa = (f) => (f === 0 ? 'ნულოვანი სართული' : f < 0 ? `სარდაფი ${-f}` : `${ordinalKa(f)} სართული`);
    const floorEn = (f) => (f === 0 ? 'Ground' : f < 0 ? `Basement ${-f}` : `Floor ${f}`);
    const roomGrid = `
      <div class="rpt-rooms">
        ${[...blocks].sort((a, b) => String(a[0]).localeCompare(String(b[0]), undefined, { numeric: true }))
    .map(([block, floors]) => `
          <div class="rpt-room-block rpt-avoid">
            ${blocks.size > 1 && block ? `<p class="rpt-room-block-name">${L(`ბლოკი ${block}`, `Block ${block}`)}</p>` : ''}
            ${[...floors].sort((a, b) => b[0] - a[0]).map(([floor, list]) => `
              <div class="rpt-room-floor">
                <span class="rpt-room-floor-name">${esc(floorKa(floor))}<em>${esc(floorEn(floor))}</em></span>
                <span class="rpt-room-list">
                  ${list
    .sort((a, b) => String(a.flat_number).localeCompare(String(b.flat_number), undefined, { numeric: true }))
    .map((u) => `<i class="rpt-room rpt-room-${toneOf(u)}${roomsWithWork.has(u.id) ? ' rpt-room-has-work' : ''}" data-pop="room:${esc(u.id)}" title="${esc(bi(u.unit_type || ''))}">${esc(u.flat_number)}</i>`)
    .join('')}
                </span>
              </div>`).join('')}
          </div>`).join('')}
      </div>`;

    unitsSection = `
      <section class="rpt-section rpt-avoid">
        ${H('ოთახები', 'Rooms', `${units.length}${area ? ` · ${num.format(area)} m²` : ''}`)}
        ${units.length ? `
          <div class="rpt-segbar rpt-segbar-lg">${counts.map((c) => seg(c.n, units.length, c.tone)).join('')}</div>
          <p class="rpt-card-stats">
            ${counts.map((c) => `<span><i class="rpt-sw rpt-sw-${c.tone}"></i><b>${c.n}</b> ${L(c.ka, c.en)}</span>`).join('')}
          </p>
          <div class="rpt-type-chips">
            ${[...byType].sort((a, b) => b[1].n - a[1].n).map(([type, e]) => `
              <span class="rpt-type">${esc(bi(type))} <b>× ${e.n}</b>${e.area ? ` · ${num.format(e.area)} m²` : ''}</span>`).join('')}
          </div>
          <p class="rpt-html-only rpt-click-note">👆 ${L('ოთახზე დაჭერით ნახავთ მის მონაცემებს და შესრულებულ სამუშაოებს', 'Click a room to see its details and the work done in it')}${roomsWithWork.size
            ? `<span class="rpt-click-key"><span class="rpt-room rpt-room-has-work rpt-room-key"></span> ${L('სამუშაო ჩაწერილია', 'work recorded')}</span>` : ''}</p>
          ${roomGrid}` : none}
      </section>`;
  }

  // ---------- Work done: room by room, each kind of work added up ----------
  // An entry with a quantity is a measurement, and measurements add up: 200 m²
  // of gypsum one day and 300 m² the next reads as 500 m². One without is work
  // that went on that day unmeasured - "in progress". Work is the same work
  // when it is written the same way (the room form picks it from a list); each
  // unit it was measured in adds up on its own. The date is the last
  // measurement.
  const workKey = (w) => `${w.flat_id ?? ''}|${String(w.work || w.work_en || '').trim().toLowerCase().replace(/\s+/g, ' ')}`;
  const addTo = (map, unit, q) => map.set(unit, (map.get(unit) ?? 0) + q);
  const workGroups = new Map();
  for (const w of [...work].sort((a, b) => a.work_date.localeCompare(b.work_date))) {
    const key = workKey(w);
    if (!workGroups.has(key)) {
      workGroups.set(key, { flatId: w.flat_id ?? null, byUnit: new Map(), byContractor: new Map() });
    }
    const g = workGroups.get(key);
    // The latest spelling stands for the group.
    g.ka = w.work;
    g.en = w.work_en;
    g.last = w.work_date;
    const who = workerOf(w);
    if (!g.byContractor.has(who)) g.byContractor.set(who, new Map());
    const q = Number(w.quantity) || 0;
    if (q > 0) {
      addTo(g.byUnit, w.unit ?? '', q);
      addTo(g.byContractor.get(who), w.unit ?? '', q);
      g.measured = w.work_date;
    }
  }
  // Each room's work, for its pop-up.
  const workRooms = new Map();
  for (const g of workGroups.values()) {
    if (!workRooms.has(g.flatId)) workRooms.set(g.flatId, []);
    workRooms.get(g.flatId).push(g);
  }
  const roomName = (id) => {
    const u = units.find((x) => x.id === id);
    if (!u) return L('ოთახის გარეშე', 'Not in a room');
    return [u.block ? L(`ბლოკი ${u.block}`, `Block ${u.block}`) : '', L(`ოთახი ${u.flat_number}`, `Room ${u.flat_number}`),
      `<span class="rpt-muted">${L(`${u.floor} სართ.`, `floor ${u.floor}`)}</span>`].filter(Boolean).join(' · ');
  };
  // "500 m²", or "500 m² · 12 pcs" for work measured in two units.
  const qtyList = (byUnit) => [...byUnit].map(([unit, q]) => `${num.format(q)}${unit ? ` ${esc(unit)}` : ''}`).join(' · ');
  const inProgress = L('მიმდინარეობს', 'In progress');
  // Who did it - with each one's share when more than one contractor did the same work.
  const whoDid = (g) => {
    const named = [...g.byContractor].filter(([id]) => id);
    if (!named.length) return '-';
    if (named.length === 1) return esc(nameOf(named[0][0]));
    const total = (m) => [...m.values()].reduce((s, q) => s + q, 0);
    return named.sort((a, b) => total(b[1]) - total(a[1]))
      .map(([id, m]) => `${esc(nameOf(id))} <span class="rpt-muted">${qtyList(m) || inProgress}</span>`)
      .join('<br>');
  };
  // Measured so far; and whether work went on after the last measurement.
  const totalCell = (g) => {
    if (!g.measured) return inProgress;
    const after = g.last > g.measured ? `<br><span class="rpt-muted">+ ${inProgress}</span>` : '';
    return `<b>${qtyList(g.byUnit)}</b>${after}`;
  };
  // The project as a whole: each kind of work added up over every room, so the
  // section stays a few lines long however many rooms there are. What was done
  // in one room is in that room's pop-up (the interactive report).
  const workTypeKey = (w) => String(w.work || w.work_en || '').trim().toLowerCase().replace(/\s+/g, ' ');
  const totals = new Map();
  for (const w of [...work].sort((a, b) => a.work_date.localeCompare(b.work_date))) {
    const key = workTypeKey(w);
    if (!totals.has(key)) totals.set(key, { byUnit: new Map(), byContractor: new Map(), rooms: new Set() });
    const g = totals.get(key);
    g.ka = w.work;
    g.en = w.work_en;
    g.last = w.work_date;
    if (w.flat_id) g.rooms.add(w.flat_id);
    const who = workerOf(w);
    if (!g.byContractor.has(who)) g.byContractor.set(who, new Map());
    const q = Number(w.quantity) || 0;
    if (q > 0) {
      addTo(g.byUnit, w.unit ?? '', q);
      addTo(g.byContractor.get(who), w.unit ?? '', q);
      g.measured = w.work_date;
    }
  }
  const workTable = (list, { roomsColumn }) => `
      <table class="rpt-compact">
        <thead>
          <tr>
            <th>${L('სამუშაო', 'Work')}</th>
            <th class="num">${L('სულ', 'Total')}</th>
            ${roomsColumn ? `<th class="num">${L('ოთახი', 'Rooms')}</th>` : ''}
            <th>${L('კონტრაქტორი', 'Contractor')}</th>
            <th>${L('გაზომვის თარიღი', 'Date measured')}</th>
          </tr>
        </thead>
        <tbody>
          ${[...list].sort((a, b) => b.last.localeCompare(a.last)).map((g) => `
            <tr>
              <td class="rpt-prose">${biText(g.ka, g.en !== g.ka ? g.en : '')}</td>
              <td class="num">${totalCell(g)}</td>
              ${roomsColumn ? `<td class="num">${g.rooms.size || '-'}</td>` : ''}
              <td>${whoDid(g)}</td>
              <td>${g.measured ? d(g.measured) : '-'}</td>
            </tr>`).join('')}
        </tbody>
      </table>`;
  // Only the PDF and Word: in the interactive report the same lines are in
  // each room's pop-up, so the table would only repeat them.
  const workSection = !totals.size ? '' : `
    <section class="rpt-section rpt-avoid${rooms ? ' rpt-print-only' : ''}">
      ${H('შესრულებული სამუშაოები', 'Work Done', `${roomsWithWork.size} ${L('ოთახში', 'rooms')}`)}
      ${workTable(totals.values(), { roomsColumn: rooms })}
    </section>`;

  // Each room's pop-up in the interactive report: its details and its work.
  const statusOf = (u) => UNIT_STATUS.find(([key]) => key === (u.status ?? 'not_started'));
  const roomPopups = {};
  for (const u of units) {
    const [, ska, sen, tone] = statusOf(u) ?? [null, '', '', 'muted'];
    const list = workRooms.get(u.id) ?? [];
    roomPopups[u.id] = `
      <h3>${roomName(u.id)}</h3>
      <p class="rpt-pop-facts">
        ${chip({ ka: ska, en: sen, tone })}
        ${u.unit_type ? `<span>${esc(bi(u.unit_type))}</span>` : ''}
        ${u.area_m2 != null ? `<span>${num.format(Number(u.area_m2))} m²</span>` : ''}
      </p>
      ${u.notes ? `<p class="rpt-pop-notes">${esc(u.notes)}</p>` : ''}
      ${list.length ? workTable(list, { roomsColumn: false })
        : `<p class="rpt-none">${L('ამ ოთახში სამუშაოები ჯერ არ არის აღწერილი', 'No work recorded in this room yet')}</p>`}`;
  }

  // ---------- Site activity: manpower chart + latest logs ----------
  const tradeLabel = (key) => MANPOWER_TRADES.find((t) => t.key === key)?.label ?? key;
  const workersOf = (l) => Object.values(l.manpower || {}).reduce((s, n) => s + Number(n || 0), 0);
  const series = [...logs].reverse(); // oldest → newest
  const peak = Math.max(1, ...series.map(workersOf));
  const manpowerChart = series.length > 1 ? `
    <div class="rpt-columns rpt-avoid">
      ${series.map((l) => {
        const n = workersOf(l);
        return `
          <div class="rpt-col" data-pop="day:${l.log_date}">
            <span class="rpt-col-value">${n}</span>
            <div class="rpt-col-bar" style="height:${Math.max(2, (n / peak) * 82)}%"></div>
            <span class="rpt-col-label">${dm(l.log_date)}</span>
          </div>`;
      }).join('')}
    </div>` : '';

  // ---------- Labour: how many are on site on a working day ----------
  // Everyone counts, not just the daily workers, because everyone takes a day.
  const siteWorkerDays = siteLogs.reduce((sum, l) => (
    sum + Object.values(l.manpower || {}).reduce((n, v) => n + Number(v || 0), 0)
  ), 0);
  // Days that were actually worked - spreading the total over idle days would
  // read low for no reason anyone would recognise.
  const daysWorked = siteLogs.filter((l) => (
    Object.values(l.manpower || {}).some((v) => Number(v) > 0)
  )).length;
  const allAvg = daysWorked ? Math.round(siteWorkerDays / daysWorked) : 0;

  // The average stands beside the chart it summarises, rather than under a
  // heading of its own: the bars show the shape, the tile gives the figure.
  const activityBlock = series.length > 1 || siteWorkerDays ? `
    <div class="rpt-activity rpt-avoid">
      ${manpowerChart || '<div></div>'}
      ${siteWorkerDays ? tile('საშუალო დასწრება', 'Average on site', num.format(allAvg),
    `${L('სამუშაო ძალა დღეში', 'manpower a day')} · ${num.format(siteWorkerDays)} ${L('კაც-დღე', 'worker-days')} ${L('სულ', 'in all')}`) : ''}
    </div>` : '';

  const logsSection = `
    <section class="rpt-section">
      ${H('ობიექტზე აქტივობა', 'Site Activity', series.length ? `${series.length} ${L('ჩანაწერი', 'logs')}` : '')}
      ${series.length > 1 ? clickHint('დღის სვეტზე დაჭერით ნახავთ, ვინ იყო ობიექტზე და რა გაკეთდა', 'Click a day’s bar to see who was on site and what was done') : ''}
      ${activityBlock}
      ${logs.length ? logs.slice(0, 5).map((l) => {
        const crew = Object.entries(l.manpower || {}).filter(([, n]) => n > 0);
        const total = workersOf(l);
        return `
          <article class="rpt-log rpt-avoid">
            <div class="rpt-log-head">
              <strong>${esc(dateKa(l.log_date))}</strong>
              <span class="rpt-muted">${esc(dateEn(l.log_date))}</span>
              <span class="rpt-log-meta">
                ${l.weather ? esc(bi(l.weather)) : ''}${total ? ` · ${L('სამუშაო ძალა', 'Manpower')} ${total}` : ''}
              </span>
            </div>
            ${crew.length ? `<p class="rpt-muted rpt-crew">${crew.map(([k, n]) => `${esc(bi(tradeLabel(k)))} ${n}`).join(' · ')}</p>` : ''}
            <div class="rpt-two">
              <p class="rpt-notes">${esc(l.notes || '-')}</p>
              <p class="rpt-notes rpt-notes-en">${esc(l.notes_en || '-')}</p>
            </div>
          </article>`;
      }).join('') : none}
    </section>`;

  // ---------- Delays: by cause, then the list ----------
  // The work a delay held up, under whoever holds it: these are the days that
  // come off his record and stay on the contractor at fault.
  const heldUp = (x) => {
    const impacts = x.impacts ?? [];
    if (!impacts.length) return '-';
    const byWho = new Map();
    for (const i of impacts) {
      const t = tasks.find((z) => z.id === i.task_id);
      const who = t?.contractor_id ? nameOf(t.contractor_id) : bi('No contractor');
      if (!byWho.has(who)) byWho.set(who, []);
      byWho.get(who).push(t ? taskBi(t) : bi('Item removed'));
    }
    return [...byWho].map(([who, items]) =>
      `${esc(who)}<br><span class="rpt-muted">${items.map(esc).join(', ')}</span>`).join('<br>');
  };

  const causeDays = new Map();
  for (const x of delays) {
    const e = causeDays.get(x.delay_cause) ?? { days: 0, n: 0 };
    e.days += delayDaysLost(x, today);
    e.n += 1;
    causeDays.set(x.delay_cause, e);
  }
  const causes = [...causeDays].sort((a, b) => b[1].days - a[1].days);
  const maxCause = Math.max(1, ...causes.map(([, e]) => e.days));
  // Who and how often, over the whole project rather than the last 30 days.
  // One six-day delay is bad luck; the same cause three times from the same
  // contractor is a pattern, and that is a different conversation.
  const byContractor = new Map();
  for (const x of contractorDelays) {
    if (!causeOf(x)) continue;
    const e = byContractor.get(causeOf(x)) ?? { n: 0, days: 0, causes: new Map() };
    e.n += 1;
    e.days += delayDaysLost(x, today);
    e.causes.set(x.delay_cause, (e.causes.get(x.delay_cause) ?? 0) + 1);
    byContractor.set(causeOf(x), e);
  }
  const blame = [...byContractor]
    .map(([id, e]) => {
      const [cause, times] = [...e.causes].sort((a, b) => b[1] - a[1])[0] ?? ['', 0];
      return { id, ...e, cause, times };
    })
    .sort((a, b) => b.days - a.days);

  const blameTable = blame.length ? `
    <h3 class="rpt-sub-h">${L('შეფერხებები კონტრაქტორების მიხედვით (მთელი პროექტი)', 'Delays by contractor (whole project)')}</h3>
    <table class="rpt-compact rpt-avoid">
      <thead>
        <tr>
          <th>${L('კონტრაქტორი', 'Contractor')}</th>
          <th class="num">${L('შემთხვევა', 'Times')}</th>
          <th class="num">${L('დაკარგული დღე', 'Days lost')}</th>
          <th>${L('ყველაზე ხშირი მიზეზი', 'Most frequent cause')}</th>
        </tr>
      </thead>
      <tbody>
        ${blame.map((b) => `
          <tr>
            <td>${esc(nameOf(b.id))}</td>
            <td class="num">${b.n}</td>
            <td class="num rpt-late">${num.format(b.days)}</td>
            <td>${esc(bi(b.cause))}${b.times > 1
    ? ` ${chip({ ka: `${b.times}-ჯერ`, en: `${b.times}×`, tone: 'warn' })}` : ''}</td>
          </tr>`).join('')}
      </tbody>
    </table>` : '';

  const delaysSection = `
    <section class="rpt-section">
      ${H('შეფერხებები (ბოლო 30 დღე)', 'Delays (last 30 days)', delays.length ? `${delayDays} ${L('დღე', 'days')}` : '')}
      ${ongoingDelays.length ? `
        <p class="rpt-ongoing-note">${L(
    `${ongoingDelays.length} შეფერხება მიმდინარეა - დასრულების თარიღი ჯერ უცნობია; ${ongoingDays} დღე დღემდე`,
    `${ongoingDelays.length} ${ongoingDelays.length === 1 ? 'delay is' : 'delays are'} still ongoing - no end date yet; ${ongoingDays} days so far`,
  )}</p>` : ''}
      ${delays.length ? `
        <div class="rpt-hbars rpt-avoid">
          ${causes.map(([cause, e]) => `
            <div class="rpt-hbar">
              <span class="rpt-hbar-label">${esc(bi(cause))}</span>
              <div class="rpt-hbar-track"><div class="rpt-hbar-cause" style="width:${((e.days / maxCause) * 100).toFixed(2)}%"></div></div>
              <span class="rpt-hbar-value">${e.days} ${L('დღე', 'days')}<em>${e.n}× </em></span>
            </div>`).join('')}
        </div>
        ${delays.map((x) => {
    // One delay to a table, its headings down the side: the values get the
    // width of the page instead of an eighth of it each.
    const row = (ka, en, value) => `<tr><th scope="row">${L(ka, en)}</th><td>${value}</td></tr>`;
    return `
        <table class="rpt-compact rpt-delay">
          <tbody>
            ${row('თარიღი', 'Date', d(x.created_at))}
            ${row('მიზეზი', 'Cause', esc(bi(x.delay_cause)))}
            ${rooms ? row('ადგილი', 'Location',
    x.flats ? esc([x.flats.block, x.flats.flat_number].filter(Boolean).join('-')) : esc(bi('Site-wide'))) : ''}
            ${row('ბრალეულობა', 'At fault', causeOf(x) ? esc(nameOf(causeOf(x))) : '-')}
            ${row('შეაფერხა სამუშაო', 'Work held up', heldUp(x))}
            ${row('დღე', 'Days', `${num.format(delayDaysLost(x, today))}${delayIsOngoing(x) ? '+' : ''}`)}
            ${row('სტატუსი', 'Status', delayIsOngoing(x)
    ? chip({ ka: 'მიმდინარე', en: 'Ongoing', tone: 'bad' })
    : `${L('დასრულდა', 'Ended')} ${x.resolved_on ? d(x.resolved_on) : ''}`.trim())}
            ${row('აღწერა', 'Description', biText(x.description, x.description_en))}
          </tbody>
        </table>`;
  }).join('')}` : `<p class="rpt-all-good">✓ ${L('ბოლო 30 დღეში შეფერხება არ ყოფილა', 'No delays in the last 30 days')}</p>`}
      ${blameTable}
    </section>`;

  // ---------- Safety and quality ----------
  // A client reads this section first when something has gone wrong and never
  // otherwise, so it leads with the plain figures and lists only what is open.
  const EVENT_KIND = {
    incident: { ka: 'შემთხვევა', en: 'Incident' },
    inspection: { ka: 'ინსპექცია', en: 'Inspection' },
    toolbox_talk: { ka: 'უსაფრთხოების ბრიფინგი', en: 'Toolbox talk' },
  };
  const SEVERITY = {
    first_aid: { ka: 'პირველადი დახმარება', en: 'First aid' },
    lost_time: { ka: 'სამუშაო დროის დაკარგვით', en: 'Lost time' },
    reportable: { ka: 'შესატყობინებელი', en: 'Reportable' },
  };
  const incidents = events.filter((e) => e.kind === 'incident');
  const inspections = events.filter((e) => e.kind === 'inspection');
  const openEvents = events.filter((e) => !e.closed);
  const lastIncident = incidents[0]?.event_date;
  const sinceDate = lastIncident ?? events.at(-1)?.event_date;
  const daysClear = sinceDate ? dayDiff(sinceDate, today) : null;

  const safetySection = !events.length ? '' : `
    <section class="rpt-section rpt-avoid">
      ${H('უსაფრთხოება და ხარისხი', 'Safety & Quality', `${events.length} ${L('ჩანაწერი', 'records')}`)}
      <div class="rpt-tiles rpt-avoid">
        ${tile('დღე შემთხვევის გარეშე', 'Days without an incident', daysClear == null ? '-' : `${daysClear}`,
          lastIncident ? `${L('ბოლო', 'last')} ${d(lastIncident)}` : L('არცერთი', 'none recorded'),
          incidents.length ? '' : 'ok')}
        ${tile('შემთხვევა', 'Incidents', `${incidents.length}`,
          incidents.filter((e) => e.severity === 'lost_time' || e.severity === 'reportable').length
            ? `${incidents.filter((e) => e.severity === 'lost_time' || e.severity === 'reportable').length} ${L('მძიმე', 'serious')}`
            : '', incidents.length ? 'bad' : 'ok')}
        ${tile('ინსპექცია', 'Inspections', `${inspections.length}`, '', 'muted')}
      </div>
      ${openEvents.length ? `
        <h3 class="rpt-sub-h">${L('დახურვის მოლოდინში', 'Still open')}</h3>
        <table class="rpt-compact">
          <thead>
            <tr>
              <th>${L('თარიღი', 'Date')}</th><th>${L('ტიპი', 'Type')}</th>
              <th>${L('რა მოხდა', 'What happened')}</th>
              <th>${L('კონტრაქტორი', 'Contractor')}</th><th>${L('ზომა', 'Action')}</th>
              <th>${L('სტატუსი', 'Status')}</th>
            </tr>
          </thead>
          <tbody>
            ${openEvents.map((e) => `
              <tr>
                <td>${d(e.event_date)}</td>
                <td>${L(EVENT_KIND[e.kind]?.ka ?? e.kind, EVENT_KIND[e.kind]?.en ?? e.kind)}</td>
                <td class="rpt-prose">${esc(e.title)}${e.description || e.description_en
                  ? `<em class="rpt-block">${esc(e.description_en || e.description)}</em>` : ''}</td>
                <td>${e.contractor_id ? esc(nameOf(e.contractor_id)) : '-'}</td>
                <td>${e.action ? esc(e.action) : '-'}</td>
                <td>${e.severity
                  ? chip({ ...SEVERITY[e.severity], tone: 'bad' })
                  : chip({ ka: 'ღიაა', en: 'Open', tone: 'warn' })}</td>
              </tr>`).join('')}
          </tbody>
        </table>`
        : `<p class="rpt-all-good">✓ ${L('ყველა ჩანაწერი დახურულია', 'Every record has been closed out')}</p>`}
    </section>`;

  // ---------- Pop-ups for the interactive (.html) report ----------
  // Every click-able part of the page - an activity on the timeline, a
  // contractor, a day on the site activity chart, a month of the cash flow, a
  // room - has its pop-up here, keyed as on its data-pop attribute.
  const popups = {};
  const popTable = (heads, rows) => (rows.length ? `
    <table class="rpt-compact">
      <thead><tr>${heads.map(([ka, en, cls = '']) => `<th class="${cls}">${L(ka, en)}</th>`).join('')}</tr></thead>
      <tbody>${rows.join('')}</tbody>
    </table>` : '');
  const popH = (ka, en) => `<h4 class="rpt-pop-h">${L(ka, en)}</h4>`;
  const facts = (list) => `<div class="rpt-pop-grid">${list.filter(Boolean).map(([ka, en, v]) => `
    <div><span>${L(ka, en)}</span><b>${v}</b></div>`).join('')}</div>`;
  const tradeName = (key) => bi(MANPOWER_TRADES.find((t) => t.key === key)?.label ?? key);
  const qtyText = (q, unit) => `${num.format(q)}${unit ? ` ${esc(unit)}` : ''}`;
  const delayRow = (dl, extra = '') => `
    <tr><td>${d(delayStart(dl))}</td><td>${esc(bi(dl.delay_cause))}</td>
      <td class="num">${delayDaysLost(dl, today)}${delayIsOngoing(dl) ? ` · ${L('მიმდინარე', 'ongoing')}` : ''}</td>${extra}</tr>`;

  // An activity on the timeline: its dates, money, materials and what held it up.
  for (const t of tasks) {
    const s = taskState(t, today);
    const own = payments.filter((p) => p.task_id === t.id).sort((a, b) => a.paid_on.localeCompare(b.paid_on));
    const paid = own.reduce((sum, p) => sum + Number(p.amount || 0), 0);
    const held = own.reduce((sum, p) => sum + Number(p.retention || 0), 0);
    const mats = materials.filter((x) => x.task_id === t.id);
    const holdUps = delayImpacts.filter((i) => i.task_id === t.id && i.delay);
    // Work in no room is recorded on its item (a pour, the facade).
    const onTask = work.filter((w) => w.task_id === t.id).sort((a, b) => a.work_date.localeCompare(b.work_date));
    popups[`task:${t.id}`] = `
      <h3>${esc(taskBi(t))}</h3>
      <p class="rpt-pop-facts">${chip({ ...TASK_STATUS[s.key], tone: TASK_STATUS[s.key].tone })}
        ${t.contractor_id ? `<span>${esc(nameOf(t.contractor_id))}</span>` : ''}</p>
      ${facts([
        ['დაგეგმილი', 'Planned', `${d(t.planned_start)} → ${d(t.planned_finish)}`],
        t.baseline_finish ? ['დამტკიცებული', 'Baseline', `${d(t.baseline_start)} → ${d(t.baseline_finish)}`] : null,
        Number(t.extension_days) ? ['ვადა შეფერხებით', 'Due with delays', `${d(dueDate(t))} (+${t.extension_days})`] : null,
        ['შესრულებული', 'Done', `${Math.round(completionOf(t) * 100)}%${s.daysLate ? ` · ${s.daysLate} ${L('დღე', 'days')} ${L('დაგვიანება', 'late')}` : ''}`],
        Number(t.budget) ? ['ბიუჯეტი', 'Budget', `${m(Number(t.budget))}${t.quantity != null ? ` <span class="rpt-muted">${num.format(t.quantity)} ${esc(t.unit || '')}${t.rate != null ? ` × ${m(t.rate)}` : ''}</span>` : ''}`] : null,
        own.length ? ['გადახდილი', 'Paid', `${m(paid)}${held ? ` <span class="rpt-muted">+ ${m(held)} ${L('გარანტია', 'retention')}</span>` : ''}`] : null,
        Number(t.material_budget) || mats.length ? ['მასალა', 'Materials', `${m(mats.reduce((sum, x) => sum + Number(x.amount || 0), 0))}${Number(t.material_budget) ? ` / ${m(Number(t.material_budget))}` : ''}`] : null,
      ])}
      ${own.length ? popH('გადახდები', 'Payments') + popTable(
        [['თარიღი', 'Date'], ['თანხა', 'Paid', 'num'], ['გარანტია', 'Retention', 'num'], ['შენიშვნა', 'Note']],
        own.map((p) => `<tr><td>${d(p.paid_on)}</td><td class="num">${m(Number(p.amount))}</td>
          <td class="num">${Number(p.retention) ? m(Number(p.retention)) : '-'}</td><td>${esc(p.note || '-')}</td></tr>`),
      ) : ''}
      ${mats.length ? popH('მასალები', 'Materials') + popTable(
        [['თარიღი', 'Date'], ['მასალა', 'Material'], ['რაოდენობა', 'Quantity', 'num'], ['თანხა', 'Amount', 'num']],
        mats.map((x) => `<tr><td>${d(x.bought_on)}</td><td>${esc(biName(x.item, x.item_ka))}</td>
          <td class="num">${x.quantity != null ? qtyText(Number(x.quantity), x.unit) : '-'}</td><td class="num">${m(Number(x.amount))}</td></tr>`),
      ) : ''}
      ${holdUps.length ? popH('შეაფერხა', 'Held up by') + popTable(
        [['თარიღი', 'Date'], ['მიზეზი', 'Cause'], ['დღე', 'Days', 'num']],
        holdUps.map((i) => delayRow(i.delay)),
      ) : ''}
      ${onTask.length ? popH('შესრულებული სამუშაოები', 'Work recorded') + popTable(
        [['თარიღი', 'Date'], ['სამუშაო', 'Work'], ['კონტრაქტორი', 'Contractor'], ['რაოდენობა', 'Quantity', 'num']],
        onTask.map((w) => `<tr><td>${d(w.work_date)}</td><td>${biText(w.work, w.work_en !== w.work ? w.work_en : '')}</td>
          <td>${workerOf(w) ? esc(nameOf(workerOf(w))) : '-'}</td>
          <td class="num">${w.quantity != null ? qtyText(Number(w.quantity), w.unit) : inProgress}</td></tr>`),
      ) : ''}`;
  }

  // A contractor: their jobs, money, delays, crew and the work recorded for them.
  for (const c of contractors) {
    const jobs = tasks.filter((t) => t.contractor_id === c.id);
    const jobIds = new Set(jobs.map((t) => t.id));
    const own = payments.filter((p) => jobIds.has(p.task_id)).sort((a, b) => a.paid_on.localeCompare(b.paid_on));
    const mats = materials.filter((x) => jobIds.has(x.task_id));
    const caused = contractorDelays.filter((dl) => causeOf(dl) === c.id);
    const crewDays = siteLogs.filter((l) => (l.crew ?? []).some((x) => x.contractor_id === c.id && Number(x.workers) > 0));
    const theirWork = new Map();
    for (const w of work.filter((x) => x.contractor_id === c.id)) {
      const key = String(w.work || w.work_en || '').trim().toLowerCase();
      const g = theirWork.get(key) ?? { ka: w.work, en: w.work_en, byUnit: new Map(), rooms: new Set() };
      if (Number(w.quantity) > 0) addTo(g.byUnit, w.unit ?? '', Number(w.quantity));
      if (w.flat_id) g.rooms.add(w.flat_id);
      theirWork.set(key, g);
    }
    popups[`con:${c.id}`] = `
      <h3>${esc(biName(c.name, c.name_ka))}</h3>
      <p class="rpt-pop-facts">${c.trade ? `<span>${esc(bi(c.trade))}</span>` : ''}
        ${[c.contact_person, c.phone, c.email].filter(Boolean).map((x) => `<span>${esc(x)}</span>`).join('')}</p>
      ${jobs.length ? popH('სამუშაოები', 'Jobs') + popTable(
        [['სამუშაო', 'Work item'], ['ვადა', 'Due'], ['შესრ.', 'Done', 'num'], ['ბიუჯეტი', 'Budget', 'num']],
        jobs.map((t) => `<tr><td>${esc(taskBi(t))}</td><td>${d(dueDate(t))}</td>
          <td class="num">${Math.round(completionOf(t) * 100)}%</td><td class="num">${Number(t.budget) ? m(Number(t.budget)) : '-'}</td></tr>`),
      ) : `<p class="rpt-none">${L('სამუშაო არ აქვს', 'No jobs assigned')}</p>`}
      ${own.length ? popH('გადახდები', 'Payments') + popTable(
        [['თარიღი', 'Date'], ['სამუშაო', 'Work item'], ['თანხა', 'Paid', 'num'], ['გარანტია', 'Retention', 'num']],
        own.map((p) => `<tr><td>${d(p.paid_on)}</td><td>${esc(taskBi(taskById.get(p.task_id) ?? {}))}</td>
          <td class="num">${m(Number(p.amount))}</td><td class="num">${Number(p.retention) ? m(Number(p.retention)) : '-'}</td></tr>`),
      ) : ''}
      ${mats.length ? popH('მიწოდებული მასალა', 'Materials supplied') + popTable(
        [['თარიღი', 'Date'], ['მასალა', 'Material'], ['თანხა', 'Amount', 'num']],
        mats.map((x) => `<tr><td>${d(x.bought_on)}</td><td>${esc(biName(x.item, x.item_ka))}</td><td class="num">${m(Number(x.amount))}</td></tr>`),
      ) : ''}
      ${theirWork.size ? popH('შესრულებული სამუშაოები', 'Work recorded') + popTable(
        [['სამუშაო', 'Work'], ['გაზომილი', 'Measured', 'num'], ['ოთახი', 'Rooms', 'num']],
        [...theirWork.values()].map((g) => `<tr><td>${biText(g.ka, g.en !== g.ka ? g.en : '')}</td>
          <td class="num">${g.byUnit.size ? [...g.byUnit].map(([u, q]) => qtyText(q, u)).join(' · ') : L('მიმდინარეობს', 'In progress')}</td>
          <td class="num">${g.rooms.size || '-'}</td></tr>`),
      ) : ''}
      ${caused.length ? popH('მისი ბრალით შეფერხებები', 'Delays they caused') + popTable(
        [['თარიღი', 'Date'], ['მიზეზი', 'Cause'], ['დღე', 'Days', 'num']], caused.map((dl) => delayRow(dl)),
      ) : ''}
      ${crewDays.length ? `<p class="rpt-pop-foot">${L('ობიექტზე იყო', 'On site on')} <b>${crewDays.length}</b> ${L('დღე', 'days')}
        · ${L('ბოლოს', 'last')} ${d(crewDays.at(-1).log_date)}</p>` : ''}`;
  }

  // A day on the site activity chart: its log, crew and the work recorded.
  for (const l of logs) {
    const crew = siteLogs.find((x) => x.log_date === l.log_date)?.crew ?? [];
    const byWho = new Map();
    for (const x of crew) {
      if (!(Number(x.workers) > 0)) continue;
      const who = x.contractor_id ? nameOf(x.contractor_id) : bi('Hired by the client');
      if (!byWho.has(who)) byWho.set(who, []);
      byWho.get(who).push(`${tradeName(x.trade)} ${x.workers}`);
    }
    const dayWork = work.filter((w) => w.work_date === l.log_date);
    popups[`day:${l.log_date}`] = `
      <h3>${esc(dateKa(l.log_date))} <span class="rpt-muted">${esc(dateEn(l.log_date))}</span></h3>
      <p class="rpt-pop-facts">${l.weather ? `<span>${esc(bi(l.weather))}</span>` : ''}
        <span>${L('სამუშაო ძალა', 'Manpower')} <b>${workersOf(l)}</b></span></p>
      ${byWho.size ? popH('ვინ იყო ობიექტზე', 'On site') + popTable(
        [['ვინ', 'Who'], ['სპეციალობა', 'Trades']],
        [...byWho].map(([who, list]) => `<tr><td>${esc(who)}</td><td>${esc(list.join(' · '))}</td></tr>`),
      ) : ''}
      ${dayWork.length ? popH('შესრულებული სამუშაოები', 'Work recorded') + popTable(
        [['ოთახი', 'Room'], ['სამუშაო', 'Work'], ['კონტრაქტორი', 'Contractor'], ['რაოდენობა', 'Quantity', 'num']],
        dayWork.map((w) => {
          const u = units.find((x) => x.id === w.flat_id);
          return `<tr><td>${u ? esc(u.flat_number) : '-'}</td><td>${biText(w.work, w.work_en !== w.work ? w.work_en : '')}</td>
            <td>${workerOf(w) ? esc(nameOf(workerOf(w))) : '-'}</td>
            <td class="num">${Number(w.quantity) > 0 ? qtyText(Number(w.quantity), w.unit) : L('მიმდინარეობს', 'In progress')}</td></tr>`;
        }),
      ) : ''}
      ${l.notes || l.notes_en ? popH('ჩანაწერები', 'Site notes') + `<div class="rpt-pop-notes">${biText(l.notes, l.notes_en)}</div>` : ''}`;
  }

  // A month of the cash flow: what the spending was made of.
  for (const k of monthKeys) {
    const inMonth = (dt) => String(dt ?? '').slice(0, 7) === k;
    const pays = payments.filter((p) => inMonth(p.paid_on));
    const mats = materials.filter((x) => inMonth(x.bought_on));
    const costs = siteCosts.filter((e) => inMonth(e.date) && e.date <= today);
    const byRental = new Map();
    for (const e of costs.filter((x) => x.kind === 'rental')) byRental.set(e.rentalId, (byRental.get(e.rentalId) ?? 0) + e.amount);
    const dayRate = (kind) => {
      const list = costs.filter((x) => x.kind === kind);
      return { days: list.reduce((s, x) => s + (x.workers || 0), 0), cost: list.reduce((s, x) => s + x.amount, 0) };
    };
    const labour = dayRate('labour');
    const guard = dayRate('guard');
    popups[`month:${k}`] = `
      <h3>${MONTHS_KA[Number(k.slice(5)) - 1]} <span class="rpt-muted">${MONTHS_EN[Number(k.slice(5)) - 1]} ${k.slice(0, 4)}</span></h3>
      ${facts([
        ['გეგმა', 'Planned', m(planned.get(k) ?? 0)],
        ['დახარჯული', 'Spent', m(spentIn(k))],
      ])}
      ${pays.length ? popH('გადახდები კონტრაქტორებზე', 'Contract payments') + popTable(
        [['თარიღი', 'Date'], ['სამუშაო', 'Work item'], ['კონტრაქტორი', 'Contractor'], ['თანხა', 'Paid', 'num']],
        pays.map((p) => {
          const t = taskById.get(p.task_id) ?? {};
          return `<tr><td>${d(p.paid_on)}</td><td>${esc(taskBi(t))}</td><td>${t.contractor_id ? esc(nameOf(t.contractor_id)) : '-'}</td>
            <td class="num">${m(Number(p.amount))}</td></tr>`;
        }),
      ) : ''}
      ${mats.length ? popH('მასალები', 'Materials') + popTable(
        [['თარიღი', 'Date'], ['მასალა', 'Material'], ['თანხა', 'Amount', 'num']],
        mats.map((x) => `<tr><td>${d(x.bought_on)}</td><td>${esc(biName(x.item, x.item_ka))}</td><td class="num">${m(Number(x.amount))}</td></tr>`),
      ) : ''}
      ${byRental.size ? popH('ტექნიკის ქირა', 'Equipment rentals') + popTable(
        [['ტექნიკა', 'Equipment'], ['ამ თვეში', 'This month', 'num']],
        [...byRental].map(([id, sum]) => {
          const r = rentals.find((x) => x.id === id);
          return `<tr><td>${esc(r ? biName(r.equipment, r.equipment_ka) : '-')}</td><td class="num">${m(sum)}</td></tr>`;
        }),
      ) : ''}
      ${labour.cost || guard.cost ? popH('დღიური ანაზღაურება', 'Paid by the day') + popTable(
        [['ვინ', 'Who'], ['კაც-დღე', 'Person-days', 'num'], ['ღირებულება', 'Cost', 'num']],
        [labour.cost ? `<tr><td>${L('დღიური მუშები', 'Daily workers')}</td><td class="num">${labour.days}</td><td class="num">${m(labour.cost)}</td></tr>` : '',
          guard.cost ? `<tr><td>${L('დარაჯები', 'Guards')}</td><td class="num">${guard.days}</td><td class="num">${m(guard.cost)}</td></tr>` : ''].filter(Boolean),
      ) : ''}
      ${!pays.length && !mats.length && !byRental.size && !labour.cost && !guard.cost
        ? `<p class="rpt-none">${L('ამ თვეში ხარჯი არ ყოფილა', 'Nothing was spent this month')}</p>` : ''}`;
  }

  // Each room, from the room map.
  for (const [id, html] of Object.entries(roomPopups)) popups[`room:${id}`] = html;

  const footer = `<div class="rpt-avoid">${signatureHtml(REPORT_AUTHOR)}</div>`;

  const page = document.createElement('div');
  page.className = 'pdf-page rpt';
  page.innerHTML = header + glance + attention + notMoving + driftSection + timeline + roadAhead
    + costSection + financeSection + contractorsSection + unitsSection + workSection + logsSection + delaysSection + safetySection + footer;
  page.popups = popups; // read by the interactive (.html) export only
  // The interactive report's $ / ₾ switch: the rate, and the currency line in each.
  const other = project.currency === 'GEL' ? 'USD' : 'GEL';
  page.fx = usdRate && project.currency ? {
    rate: usdRate.rate,
    own: project.currency,
    labels: {
      [project.currency]: L(currencyKa(project.currency), `All amounts in ${project.currency}`),
      [other]: L(`${currencyKa(other)} (ეროვნული ბანკის კურსით)`, `All amounts in ${other}, at the National Bank rate`),
    },
  } : null;
  return page;
}

const fileSafe = (name) => (name || 'Project')
  .replace(/[\\/:*?"<>|]+/g, '')
  .trim()
  .replace(/\s+/g, '_')
  .slice(0, 60) || 'Project';

/**
 * Saves a page built by buildProjectReport() as Project_Report_<name>_<date>,
 * a .pdf - or, with `word`, a .docx to arrange by hand before printing.
 */
export async function downloadProjectReport(page, project, { printable = false, word = false, html = false } = {}) {
  const today = iso(new Date());
  if (html) {
    await saveInteractive(page, project, `Project_Report_${fileSafe(project.name)}_${today}.html`);
    return;
  }
  // Rendered from a copy, off-screen: the printable version has spacers put
  // into it, and the preview on screen should not gain those blank gaps.
  const root = document.getElementById('pdf-export-root');
  const printed = page.cloneNode(true);
  root.replaceChildren(printed);
  const name = `Project_Report_${fileSafe(project.name)}_${today}`;
  try {
    if (word) await saveDocx(printed, `${name}.docx`, { title: `Project Report - ${project.name}` });
    else await savePdf(printed, `${name}.pdf`, { printable });
  } finally {
    root.replaceChildren();
  }
}

/**
 * The report as one web page that works on its own - no login, no internet
 * past the fonts: the same page as the PDF, with the app's stylesheet inlined
 * and a pop-up for each room on the room map. It is a file to email, like the
 * PDF, and opens in any browser.
 */
async function saveInteractive(page, project, fileName) {
  const doc = await interactiveReportHtml(page, project);
  const url = URL.createObjectURL(new Blob([doc], { type: 'text/html;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** The interactive report as the text of one .html file (saved as it is, or put in the archive). */
export async function interactiveReportHtml(page, project) {
  const css = await (await fetch(new URL('../css/styles.css', import.meta.url))).text();
  // Only what the report needs to be read: the room map's pop-up data, as JSON
  // a <script> can't be broken out of.
  const data = JSON.stringify(page.popups ?? {}).replace(/</g, '\\u003c');
  const fx = JSON.stringify(page.fx ?? null).replace(/</g, '\\u003c');
  const title = `Project Report - ${project.name}`;
  const doc = `<!doctype html>
<html lang="ka">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Noto+Sans+Georgian:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>${css}</style>
<style>
  body { margin: 0; padding: 24px 12px; background: #eef2f6; font-family: Inter, 'Noto Sans Georgian', system-ui, sans-serif; }
  /* The sheet with its own margins: the PDF adds them when it prints, a browser does not. */
  .pdf-page.rpt { box-sizing: content-box; margin: 0 auto; padding: 36px 40px 44px; border-radius: 6px;
    box-shadow: 0 2px 12px rgba(15, 23, 42, 0.12); }
  @media (max-width: 820px) { body { padding: 0; } .pdf-page.rpt { padding: 20px 16px 28px; border-radius: 0; } }
  .rpt .rpt-html-only { display: block; }
  .rpt .rpt-print-only { display: none; }
  .rpt [data-pop] { cursor: pointer; transition: background-color 0.12s, outline-color 0.12s; }
  .rpt .rpt-room[data-pop]:hover, .rpt .rpt-card[data-pop]:hover { outline: 2px solid #2563eb; outline-offset: 1px; }
  .rpt .rpt-g-row[data-pop]:hover, .rpt tr[data-pop]:hover td { background: #eff6ff; }
  .rpt .rpt-col[data-pop]:hover .rpt-col-bar { background: #2563eb; }
  /* Contents, fixed above the sheet */
  .rpt-bar { position: sticky; top: 0; z-index: 5; display: flex; flex-wrap: wrap; align-items: center; justify-content: flex-end; gap: 6px 14px;
    max-width: 798px; margin: -24px auto 16px; padding: 10px 12px; background: rgba(238, 242, 246, 0.95);
    backdrop-filter: blur(4px); border-bottom: 1px solid #e2e8f0; font-size: 12px; }
  .rpt-bar nav { display: flex; gap: 4px; flex: 1; min-width: 0; overflow-x: auto; scrollbar-width: thin; padding-bottom: 2px; }
  .rpt-bar a { flex: none; white-space: nowrap; }
  .rpt-bar a .le { margin-left: 4px; color: #64748b; }
  .rpt-bar a { padding: 3px 8px; border-radius: 999px; color: #334155; text-decoration: none; background: #fff; border: 1px solid #e2e8f0; }
  .rpt-bar a:hover { border-color: #2563eb; color: #2563eb; }
  .rpt h2[id] { scroll-margin-top: 64px; }
  @media (max-width: 820px) { .rpt-bar { margin: 0 0 8px; } }
  dialog.rpt-pop { width: min(46rem, calc(100vw - 2rem)); padding: 0; border: 1px solid #e2e8f0; border-radius: 8px;
    box-shadow: 0 25px 50px -12px rgba(15, 23, 42, 0.35); }
  dialog.rpt-pop::backdrop { background: rgba(15, 23, 42, 0.45); }
  .rpt-pop-body.pdf-page { width: auto; min-height: 0; margin: 0; padding: 18px 20px 20px; box-shadow: none; }
  .rpt-pop-body table { width: 100%; }
  .rpt-pop-body h3 { margin: 0 32px 8px 0; font-size: 16px; }
  .rpt-pop-close { position: absolute; top: 10px; right: 12px; width: 30px; height: 30px; border: 0; border-radius: 6px;
    background: transparent; font-size: 22px; line-height: 1; color: #64748b; cursor: pointer; }
  .rpt-pop-close:hover { background: #f1f5f9; }
  .rpt-pop-h { margin: 14px 0 6px; font-size: 12px; font-weight: 700; color: #0f172a; }
  .rpt-pop-h em { font-weight: 400; color: #64748b; margin-left: 4px; }
  .rpt-pop-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 8px; margin: 4px 0 6px; }
  .rpt-pop-grid > div { padding: 8px 10px; border: 1px solid #e2e8f0; border-radius: 6px; background: #f8fafc; }
  .rpt-pop-grid span { display: block; font-size: 10px; color: #64748b; }
  .rpt-pop-grid span em { display: inline; margin-left: 3px; }
  .rpt-pop-grid b { display: block; margin-top: 2px; font-size: 13px; color: #0f172a; }
  .rpt-pop-foot { margin-top: 10px; font-size: 11px; color: #475569; }
  .rpt-pop-body table { margin-top: 2px; }
  .rpt-cur { display: inline-flex; flex: none; border: 1px solid #cbd5e1; border-radius: 999px; overflow: hidden; background: #fff; }
  .rpt-cur button { padding: 3px 10px; border: 0; background: transparent; font: inherit; font-weight: 600; color: #64748b; cursor: pointer; }
  .rpt-cur button.is-active { background: #0f172a; color: #fff; }
  /* Printed (or saved as PDF from the print window): the sheet alone. */
  @media print {
    .rpt-bar, dialog { display: none !important; }
    body { padding: 0; background: #fff; }
    .pdf-page.rpt { box-shadow: none; padding: 0; zoom: 1 !important; }
  }
</style>
</head>
<body>
${page.fx ? '<div class="rpt-bar"><div class="rpt-cur" id="rpt-cur" role="group" aria-label="Currency"><button type="button" data-cur="USD">$</button><button type="button" data-cur="GEL">₾</button></div></div>' : ''}
${page.outerHTML}
<dialog class="rpt-pop" id="room-pop"><button class="rpt-pop-close" aria-label="Close">&times;</button><div class="rpt-pop-body pdf-page rpt"></div></dialog>
<script>(${reportViewer.toString()})(${data}, ${fx});</script>
</body>
</html>`;
  return doc;
}

/**
 * The interactive report's own script, written out into the .html as source
 * (reportViewer.toString()): pop-ups for whatever has a data-pop key, the
 * contents bar, and fitting the sheet to a phone.
 */
function reportViewer(POPUPS, FX) {
  const pop = document.getElementById('room-pop');

  // $ / ₾: every amount on the sheet and in the pop-ups, converted at the
  // National Bank rate printed in the header. Amounts are found in the text as
  // the report writes them - "$1 200.00", "-₾300.00", or "$1.2K" on a chart.
  let shown = FX ? FX.own : null;
  const original = new WeakMap();
  const AMOUNT = /(-?)([$₾])(-?)(\d{1,3}(?:[ \u00a0]\d{3})*(?:\.\d+)?|\d+(?:\.\d+)?)([KMB]?)/g;
  const SYMBOL = { USD: '$', GEL: '₾' };
  const full = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const short = new Intl.NumberFormat('en-GB', { notation: 'compact', maximumFractionDigits: 1 });
  const spaced = (fmt, n) => fmt.formatToParts(n).map((x) => (x.type === 'group' ? ' ' : x.value)).join('');
  const convertText = (text) => text.replace(AMOUNT, (all, signBefore, symbol, signAfter, digits, suffix) => {
    const value = Number(digits.replace(/[ \u00a0]/g, '')) * ({ K: 1e3, M: 1e6, B: 1e9 }[suffix] ?? 1);
    const to = FX.own === 'USD' ? value * FX.rate : value / FX.rate;
    const compact = suffix || !digits.includes('.');
    return signBefore + SYMBOL[shown] + signAfter + (compact ? short.format(to) : spaced(full, to));
  });
  const convert = (root) => {
    if (!FX) return;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (node.parentElement?.closest('[data-fx-skip], .rpt-bar')) continue;
      if (!original.has(node)) original.set(node, node.textContent);
      const text = original.get(node);
      node.textContent = shown === FX.own ? text : convertText(text);
    }
    const line = document.getElementById('rpt-currency');
    if (line) line.innerHTML = FX.labels[shown];
  };
  const showIn = (currency) => {
    shown = currency;
    document.querySelectorAll('#rpt-cur [data-cur]').forEach((b) => b.classList.toggle('is-active', b.dataset.cur === shown));
    convert(document.querySelector('body > .pdf-page.rpt'));
    if (pop.open) convert(pop.querySelector('.rpt-pop-body'));
  };
  if (FX) {
    document.getElementById('rpt-cur').addEventListener('click', (e) => {
      const b = e.target.closest('[data-cur]');
      if (b) showIn(b.dataset.cur);
    });
    showIn(FX.own);
  }
  document.addEventListener('click', (e) => {
    const target = e.target.closest('[data-pop]');
    if (!target) return;
    if (target && POPUPS[target.dataset.pop]) {
      const body = pop.querySelector('.rpt-pop-body');
      body.innerHTML = POPUPS[target.dataset.pop];
      if (FX && shown !== FX.own) convert(body);
      pop.showModal();
      body.scrollTop = 0;
    }
  });
  // Every click-able part gets a tooltip saying so.
  document.querySelectorAll('[data-pop]').forEach((el) => {
    if (!el.title) el.title = 'დაჭერით ნახავთ დეტალებს · Click for details';
  });
  pop.querySelector('.rpt-pop-close').addEventListener('click', () => pop.close());
  pop.addEventListener('click', (e) => { if (e.target === pop) pop.close(); });
  // A phone is narrower than the sheet: shrink it to fit rather than scroll sideways.
  const sheet = document.querySelector('body > .pdf-page.rpt');
  const fit = () => {
    sheet.style.zoom = '';
    const room = document.documentElement.clientWidth;
    const width = sheet.offsetWidth;
    if (width > room) sheet.style.zoom = String(room / width);
  };
  addEventListener('resize', fit);
  fit();
}
