// =============================================================
// Full project report - bilingual (Georgian / English), print-ready.
// Built from the open project's data; shown in the app and saved as PDF.
// Charts are plain HTML/CSS (plus one inline SVG) so html2pdf renders them as-is.
// =============================================================
import {
  taskState, completionOf, costPosition, contractorPerformance, plannedSpendByMonth, actualSpendByMonth,
  siteCostsByMonth, rentalTotal, rentalEnd, delayIsOngoing, delayDaysLost,
  stalledTasks, forecastFinish, durationDays,
} from './schedule.js';
import { bi, biName, dateKa, dateEn, signatureHtml } from './bilingual.js';
import { MANPOWER_TRADES, REPORT_AUTHOR } from './config.js';

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
const num = new Intl.NumberFormat('en-GB', { maximumFractionDigits: 2 });
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
const none = `<p class="rpt-none">${L('მონაცემები არ არის', 'No data yet')}</p>`;
// Free text kept in both languages: Georgian first, English muted below.
const biText = (ka, en) => (ka && en
  ? `${esc(ka)}<br><span class="rpt-muted">${esc(en)}</span>`
  : esc(ka || en || '-'));

const TASK_STATUS = {
  done:     { ka: 'დასრულდა',         en: 'Done',        tone: 'ok' },
  overdue:  { ka: 'ვადაგასული',        en: 'Overdue',     tone: 'bad' },
  active:   { ka: 'მიმდინარე',         en: 'In progress', tone: 'info' },
  upcoming: { ka: 'დაგეგმილი',         en: 'Upcoming',    tone: 'muted' },
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

const chip = (s, extra = '') => `<span class="rpt-chip rpt-${s.tone}">${esc(s.ka)} / ${esc(s.en)}${extra}</span>`;
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
function verdict(gap, count) {
  if (!count) return { ka: 'გრაფიკი არ არის', en: 'No timetable', tone: 'muted' };
  if (gap < -5) return { ka: 'გეგმას ჩამორჩება', en: 'Behind plan', tone: 'bad' };
  if (gap > 5) return { ka: 'გეგმას უსწრებს', en: 'Ahead of plan', tone: 'ok' };
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
  const [logs, delays] = await Promise.all([
    db.from('daily_logs')
      .select('log_date, weather, manpower, notes, notes_en')
      .eq('project_id', projectId)
      .order('log_date', { ascending: false })
      .limit(14),
    db.from('delays')
      .select('created_at, delay_cause, duration_days, resolved_on, description, description_en, contractor_id, flats(block, flat_number)')
      .eq('project_id', projectId)
      // The last 30 days, plus anything still running from before - an open
      // delay belongs in the report however old it is.
      .or(`created_at.gte.${since.toISOString()},duration_days.is.null`)
      .order('created_at', { ascending: false }),
  ]);
  const failed = [logs, delays].find((r) => r.error);
  if (failed) throw new Error(`Could not load report data: ${failed.error.message}`);
  return { logs: logs.data, delays: delays.data };
}

/**
 * Builds the report page element (not yet in the DOM).
 * `money` formats amounts in the project's currency.
 */
export async function buildProjectReport({
  db, project, tasks, payments, contractors, contractorDelays, units, progress, money,
  siteCosts = [], rentals = [],
}) {
  const today = iso(new Date());
  const { logs, delays } = await fetchExtras(db, project.id, today);
  const cost = costPosition(tasks, payments, today, siteCosts);
  const perf = contractorPerformance(tasks, contractorDelays, payments, today); // all-time delays
  const rooms = Boolean(project.has_rooms); // sites like a stadium have no rooms
  const contractorById = new Map(contractors.map((c) => [c.id, c]));
  const nameOf = (id) => {
    const c = contractorById.get(id);
    return c ? biName(c.name, c.name_ka) : '';
  };
  const paidOn = (taskId) => payments.filter((p) => p.task_id === taskId).reduce((s, p) => s + Number(p.amount), 0);
  const m = (n) => money.format(n);
  // `money` is a plain { format } wrapper (see app.js), not a full Intl.NumberFormat,
  // so the currency symbol for the compact axis labels is derived separately.
  const symbol = new Intl.NumberFormat(undefined, {
    style: 'currency', currency: project.currency || 'USD', currencyDisplay: 'narrowSymbol',
  }).formatToParts(0).find((p) => p.type === 'currency')?.value ?? '';
  const compact = new Intl.NumberFormat('en-GB', { notation: 'compact', maximumFractionDigits: 1 });
  const mc = (n) => `${symbol}${compact.format(n)}`;

  const gap = progress.actualPct - progress.plannedPct;
  const status = verdict(gap, progress.count);
  const spentSub = [
    cost.budget ? `${pctOf(cost.spent, cost.budget)}% ${L('ბიუჯეტის', 'of budget')}` : '',
    cost.labour || cost.rental ? `${L('მ.შ. დღიური მუშები და ქირა', 'incl. daily workers & rentals')} ${m(cost.labour + cost.rental)}` : '',
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
            : `<strong class="rpt-strip-late">${-left} ${L('დღით გადაცილებული', 'days past completion date')}</strong>`}</span>
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
            ? `<p class="rpt-currency">${L(currencyKa(project.currency), `All amounts in ${project.currency}`)}</p>`
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
        ${tile('ბიუჯეტი', 'Budget', m(cost.budget), `${L('შესრულებული', 'Work done')} ${m(cost.earned)}`)}
        ${tile('დახარჯული', 'Spent', m(cost.spent), spentSub,
          cost.budget && cost.spent > cost.budget ? 'bad' : '')}
        ${tile('ვადაგასული პუნქტები', 'Overdue items', String(progress.overdue.length),
          `${progress.count} ${L('პუნქტიდან', 'items in total')}`, progress.overdue.length ? 'bad' : 'ok')}
        ${rooms
          ? tile('ოთახები', 'Rooms', String(units.length), area ? `${num.format(area)} m²` : '')
          : tile('შეფერხებები (30 დღე)', 'Delays (30 days)', String(delays.length),
            delayDays ? `${delayDays} ${L('დღე დაკარგული', 'days lost')}` : '', delays.length ? 'warn' : '')}
      </div>
    </section>`;

  // ---------- Needs attention + next 14 days ----------
  const alerts = [];
  if (progress.count && gap < -5) {
    alerts.push(['bad', `გეგმას ჩამორჩება: შესრულებულია ${progress.actualPct}%, გეგმით ${progress.plannedPct}%`,
      `Behind plan: ${progress.actualPct}% done vs ${progress.plannedPct}% planned by today`]);
  }
  for (const t of progress.overdue.slice(0, 5)) {
    const who = nameOf(t.contractor_id);
    alerts.push(['bad', `${taskKa(t)} - ${t.daysLate} დღით გადაცილებული${who ? ` (${who})` : ''}`,
      `${t.name} - ${t.daysLate} days overdue${who ? ` (${who})` : ''}`]);
  }
  if (progress.overdue.length > 5) {
    alerts.push(['bad', `და კიდევ ${progress.overdue.length - 5} ვადაგასული პუნქტი`,
      `and ${progress.overdue.length - 5} more overdue items`]);
  }
  if (project.end_date && today > project.end_date && progress.actualPct < 100) {
    alerts.push(['bad', 'დასრულების დაგეგმილი თარიღი გავიდა', 'Planned completion date has passed']);
  }
  if (cost.budget && cost.spent > cost.budget) {
    alerts.push(['bad', `ბიუჯეტი გადაჭარბებულია ${m(cost.spent - cost.budget)}-ით`,
      `Over budget by ${m(cost.spent - cost.budget)}`]);
  } else if (cost.contracts > cost.earned + 0.5) {
    alerts.push(['warn', `კონტრაქტორებს გადაუხადეს შესრულებულ სამუშაოზე ${m(cost.contracts - cost.earned)}-ით მეტი`,
      `Contractors paid ${m(cost.contracts - cost.earned)} ahead of work done`]);
  }
  if (delays.length) {
    const byCause = new Map();
    for (const x of delays) byCause.set(x.delay_cause, (byCause.get(x.delay_cause) ?? 0) + delayDaysLost(x, today));
    const [topCause, topDays] = [...byCause].sort((a, b) => b[1] - a[1])[0];
    alerts.push(['warn', `ბოლო 30 დღეში ${delays.length} შეფერხება, ${delayDays} დღე; ძირითადად - ${bi(topCause).split(' / ')[0]} (${topDays} დღე)`,
      `${delays.length} delays in the last 30 days, ${delayDays} days lost; mostly ${topCause} (${topDays} days)`]);
  }

  if (ongoingDelays.length) {
    alerts.push(['bad',
      `${ongoingDelays.length} შეფერხება ჯერ არ დასრულებულა - ${ongoingDays} დღე დღემდე`,
      `${ongoingDelays.length} ${ongoingDelays.length === 1 ? 'delay is' : 'delays are'} still ongoing - ${ongoingDays} days so far`]);
  }

  const stalled = stalledTasks(tasks, today);
  // Overdue items already have their own line above - don't say it twice.
  const overdueIds = new Set(progress.overdue.map((t) => t.id));
  for (const st of stalled.filter((x) => !overdueIds.has(x.task.id)).slice(0, 3)) {
    alerts.push(st.kind === 'not_started'
      ? ['bad', `${taskKa(st.task)} - ${st.elapsed} დღეა უნდა დაწყებულიყო, ჯერ 0%`,
        `${st.task.name} - due to start ${st.elapsed} days ago, still 0%`]
      : ['bad', `${taskKa(st.task)} - ${st.actual}%, გეგმით დღეისთვის ${st.expected}%`,
        `${st.task.name} - ${st.actual}% done, ${st.expected}% expected by today`]);
  }

  const horizon = addDays(today, 14);
  const lookAhead = tasks
    .filter((t) => !t.done && completionOf(t) < 1)
    .flatMap((t) => {
      const out = [];
      if (t.planned_start > today && t.planned_start <= horizon) out.push({ t, date: t.planned_start, kind: 'start' });
      if (t.planned_finish >= today && t.planned_finish <= horizon) out.push({ t, date: t.planned_finish, kind: 'finish' });
      return out;
    })
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(0, 8);

  const attention = `
    <section class="rpt-section rpt-two rpt-avoid">
      <div class="rpt-panel">
        <h3>${L('ყურადღება მიაქციეთ', 'Needs attention')}</h3>
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

  // ---------- Timeline (Gantt) ----------
  let gantt = none;
  if (tasks.length) {
    const starts = tasks.map((t) => t.planned_start).concat(project.start_date ? [project.start_date] : []);
    const ends = tasks.map((t) => t.planned_finish).concat(project.end_date ? [project.end_date] : []);
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
      const who = nameOf(t.contractor_id);
      return `
        <div class="rpt-g-row rpt-avoid">
          <div class="rpt-g-label">
            <strong>${esc(taskKa(t))}</strong>
            ${t.name_ka && t.name !== t.name_ka ? `<span class="rpt-g-en">${esc(t.name)}</span>` : ''}
            <span>${d(t.planned_start)} → ${d(t.planned_finish)}${who ? ` · ${esc(who)}` : ''}</span>
          </div>
          <div class="rpt-g-track">
            ${grid}
            <div class="rpt-g-bar rpt-g-${s.key}" style="left:${left.toFixed(2)}%;width:${width.toFixed(2)}%">
              <div class="rpt-g-fill" style="width:${done}%"></div>
            </div>
          </div>
          <div class="rpt-g-pct">
            <strong>${done}%</strong>
            <span class="rpt-g-state rpt-g-state-${s.key}">${esc(TASK_STATUS[s.key].ka)}${s.daysLate ? ` +${s.daysLate}დღ` : ''}<br>${esc(TASK_STATUS[s.key].en)}${s.daysLate ? ` +${s.daysLate}d` : ''}</span>
          </div>
        </div>`;
    }).join('');

    gantt = `
      <div class="rpt-legend">
        ${legendItem('ok', 'დასრულდა', 'Done')}
        ${legendItem('info', 'მიმდინარე', 'In progress')}
        ${legendItem('bad', 'ვადაგასული', 'Overdue')}
        ${legendItem('muted', 'დაგეგმილი', 'Upcoming')}
        <span class="rpt-legend-item"><i class="rpt-sw rpt-sw-fill"></i>${L('მუქი ნაწილი = შესრულებული %', 'dark part = % complete')}</span>
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
      ${H('სამუშაო გრაფიკი', 'Timeline', `${progress.count} ${L('პუნქტი', 'items')}`)}
      ${gantt}
    </section>`;

  // ---------- Work that isn't moving ----------
  // 0% against a start date that has passed usually means one of two things:
  // nobody is on it, or nobody has updated the figure. Both are worth asking about.
  const notMoving = !stalled.length ? '' : `
    <section class="rpt-section rpt-avoid">
      ${H('არ მოძრაობს', 'Not moving', `${stalled.length} ${L('პუნქტი', 'items')}`)}
      <table class="rpt-compact">
        <thead>
          <tr>
            <th>${L('სამუშაო', 'Work item')}</th><th>${L('კონტრაქტორი', 'Contractor')}</th>
            <th>${L('დაგეგმილი', 'Planned')}</th>
            <th class="num">${L('გეგმით', 'Expected')}</th><th class="num">${L('ფაქტი', 'Actual')}</th>
            <th>${L('რა ხდება', 'What it means')}</th>
          </tr>
        </thead>
        <tbody>
          ${stalled.map((st) => `
            <tr>
              <td>${esc(taskBi(st.task))}</td>
              <td>${st.task.contractor_id ? esc(nameOf(st.task.contractor_id)) : '-'}</td>
              <td>${d(st.task.planned_start)} → ${d(st.task.planned_finish)}</td>
              <td class="num">${st.expected}%</td>
              <td class="num rpt-late">${st.actual}%</td>
              <td>${st.kind === 'not_started'
    ? L(`${st.elapsed} დღეა უნდა დაწყებულიყო - 0% ჩაწერილია`,
      `Due to start ${st.elapsed} days ago - 0% recorded`)
    : L(`დღევანდელ გეგმას ${st.gap}%-ით ჩამორჩება`,
      `${st.gap}% short of where today's plan puts it`)}</td>
            </tr>`).join('')}
        </tbody>
      </table>
      <p class="rpt-foot-note">${L(
    '0% ნიშნავს ან იმას, რომ სამუშაო არ დაწყებულა, ან იმას, რომ პროცენტი არ განახლებულა.',
    'A 0% means either the work has not begun or the figure has not been updated.',
  )}</p>
    </section>`;

  // ---------- Road to completion ----------
  const remaining = tasks.filter((t) => !t.done && completionOf(t) < 1);
  const forecast = forecastFinish({
    tasks, startDate: project.start_date, todayIso: today, actualPct: progress.actualPct,
  });
  const lateBy = forecast && project.end_date ? dayDiff(project.end_date, forecast.date) : null;

  // What is left, month by month: what starts, what is due, and the money riding on it.
  const ahead = new Map();
  const bucket = (key) => {
    if (!ahead.has(key)) ahead.set(key, { starts: 0, due: 0, budget: 0 });
    return ahead.get(key);
  };
  for (const t of remaining) {
    if (t.planned_start > today) bucket(t.planned_start.slice(0, 7)).starts += 1;
    const b = bucket(t.planned_finish.slice(0, 7));
    b.due += 1;
    b.budget += Number(t.budget || 0) * (1 - completionOf(t));
  }
  const aheadRows = [...ahead].sort((a, b) => a[0].localeCompare(b[0]));
  const monthLabel = (key) => {
    const [y, mo] = key.split('-');
    return `${MONTHS_KA[Number(mo) - 1]}<em>${MONTHS_EN[Number(mo) - 1]} ’${y.slice(2)}</em>`;
  };
  const remainingPct = Math.max(0, 100 - progress.actualPct);
  const remainingBudget = remaining.reduce((sum, t) => sum + Number(t.budget || 0) * (1 - completionOf(t)), 0);

  const roadAhead = !remaining.length ? '' : `
    <section class="rpt-section rpt-avoid">
      ${H('დასრულებამდე', 'Road to completion', `${remaining.length} ${L('პუნქტი დარჩა', 'items left')}`)}
      <div class="rpt-tiles">
        ${tile('დარჩენილი სამუშაო', 'Work left', `${remainingPct}%`,
    `${remaining.length} ${L('პუნქტი', 'items')} · ${m(remainingBudget)} ${L('ბიუჯეტით', 'of budget')}`)}
        ${project.end_date
    ? tile('დაგეგმილი დასრულება', 'Planned completion', d(project.end_date),
      dayDiff(today, project.end_date) >= 0
        ? `${dayDiff(today, project.end_date)} ${L('დღე დარჩა', 'days left')}`
        : L('თარიღი გასულია', 'date has passed'),
      dayDiff(today, project.end_date) < 0 ? 'bad' : '')
    : ''}
        ${forecast
    ? tile('პროგნოზი ამ ტემპით', 'Forecast at this pace', d(forecast.date),
      lateBy === null
        ? `${forecast.remainingDays} ${L('დღე კიდევ', 'more days')}`
        : lateBy > 0
          ? `${lateBy} ${L('დღით აგვიანებს', 'days later than planned')}`
          : `${Math.abs(lateBy)} ${L('დღით ადრე', 'days earlier than planned')}`,
      lateBy !== null && lateBy > 0 ? 'bad' : 'ok')
    : tile('პროგნოზი ამ ტემპით', 'Forecast at this pace', '-',
      L('ჯერ ნაადრევია', 'too early to say'), 'muted')}
      </div>
      ${aheadRows.length ? `
        <table class="rpt-compact">
          <thead>
            <tr>
              <th>${L('თვე', 'Month')}</th>
              <th class="num">${L('იწყება', 'Starts')}</th>
              <th class="num">${L('უნდა დასრულდეს', 'Due to finish')}</th>
              <th class="num">${L('დარჩენილი ბიუჯეტი', 'Budget left')}</th>
            </tr>
          </thead>
          <tbody>
            ${aheadRows.map(([key, v]) => `
              <tr${key === today.slice(0, 7) ? ' class="rpt-current"' : ''}>
                <td>${monthLabel(key)}</td>
                <td class="num">${v.starts || '-'}</td>
                <td class="num">${v.due || '-'}</td>
                <td class="num">${v.budget ? m(v.budget) : '-'}</td>
              </tr>`).join('')}
          </tbody>
        </table>` : ''}
      ${forecast ? `<p class="rpt-foot-note">${L(
    `პროგნოზი ეყრდნობა აქამდე ნაჩვენებ ტემპს: ${forecast.elapsed} დღეში ${progress.actualPct}%.`,
    `The forecast follows the pace kept so far: ${progress.actualPct}% in ${forecast.elapsed} days.`,
  )}</p>` : ''}
    </section>`;

  // ---------- Money: S-curve, monthly table, cost per item ----------
  const planned = plannedSpendByMonth(tasks);
  const actual = actualSpendByMonth(payments);
  const site = siteCostsByMonth(siteCosts, today);
  const spentIn = (k) => (actual.get(k) ?? 0) + (site.get(k)?.labour ?? 0) + (site.get(k)?.rental ?? 0);
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
          ${lastPaid ? `<text x="${px(lastPaid.i) + 7}" y="${py(lastPaid.ca) - 6}" font-size="10" font-weight="700" fill="#b45309">${esc(mc(lastPaid.ca))}</text>` : ''}
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
          ${hasSite ? `<th class="num">${L('დღიური მუშები', 'Daily workers')}</th><th class="num">${L('ქირა', 'Rentals')}</th>` : ''}
          <th class="num">${L('ჯამური გეგმა', 'Cumulative plan')}</th>
          <th class="num">${L('ჯამური ხარჯი', 'Cumulative spent')}</th>
        </tr>
      </thead>
      <tbody>
        ${monthKeys.map((k) => {
          const p = planned.get(k) ?? 0;
          const a = actual.get(k) ?? 0;
          const sc = site.get(k) ?? { labour: 0, rental: 0 };
          cp += p;
          ca += spentIn(k);
          return `
            <tr class="${k === thisMonth ? 'rpt-current' : ''}">
              <td>${MONTHS_KA[Number(k.slice(5)) - 1]} / ${MONTHS_EN[Number(k.slice(5)) - 1]} ${k.slice(0, 4)}</td>
              <td class="num">${m(p)}</td>
              <td class="num">${a ? m(a) : '-'}</td>
              ${hasSite ? `<td class="num">${sc.labour ? m(sc.labour) : '-'}</td><td class="num">${sc.rental ? m(sc.rental) : '-'}</td>` : ''}
              <td class="num">${m(cp)}</td>
              <td class="num">${k <= thisMonth ? m(ca) : '-'}</td>
            </tr>`;
        }).join('')}
      </tbody>
    </table>` : '';

  const budgeted = tasks.filter((t) => Number(t.budget) > 0).sort((a, b) => Number(b.budget) - Number(a.budget));
  const maxBudget = Math.max(1, ...budgeted.map((t) => Number(t.budget)));
  const itemCosts = budgeted.length ? `
    <h3 class="rpt-sub-h">${L('ღირებულება პუნქტების მიხედვით', 'Cost by item')}</h3>
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
            <span class="rpt-hbar-label">${esc(taskBi(t))}</span>
            <div class="rpt-hbar-track">
              <div class="rpt-hbar-budget" style="width:${w.toFixed(2)}%">
                <div class="rpt-hbar-done" style="width:${Math.round(completionOf(t) * 100)}%"></div>
                <i class="rpt-hbar-paid" style="left:${clamp((paid / b) * 100, 0, 100).toFixed(2)}%"></i>
              </div>
            </div>
            <span class="rpt-hbar-value">${m(b)}<em>${paid ? `${L('გადახდ.', 'paid')} ${m(paid)}` : L('გადაუხდელი', 'unpaid')}</em></span>
          </div>`;
      }).join('')}
    </div>` : '';

  // Daily workers and equipment rentals (money outside the BOQ)
  const labour = siteCosts.filter((e) => e.kind === 'labour');
  const workerDays = labour.reduce((sum, e) => sum + e.workers, 0);
  const siteCostsBlock = labour.length || rentals.length ? `
    <h3 class="rpt-sub-h">${L('ობიექტის სხვა ხარჯები', 'Other site costs')}</h3>
    <div class="rpt-tiles rpt-tiles-4 rpt-avoid">
      ${tile('კონტრაქტები', 'Contract payments', m(cost.contracts))}
      ${tile('დღიური მუშები', 'Daily workers', m(cost.labour),
        workerDays ? `${workerDays} ${L('კაც-დღე', 'worker-days')}` : '')}
      ${tile('ტექნიკის ქირა', 'Equipment rentals', m(cost.rental),
        rentals.length ? `${rentals.length} ${L('ქირა', 'rentals')}` : '')}
      ${tile('სულ დახარჯული', 'Total spent', m(cost.spent))}
    </div>
    ${rentals.length ? `
      <table class="rpt-compact">
        <thead>
          <tr>
            <th>${L('ტექნიკა', 'Equipment')}</th><th>${L('მომწოდებელი', 'Supplier')}</th>
            <th>${L('პერიოდი', 'Period')}</th><th class="num">${L('დღე × ფასი', 'Days × price')}</th>
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

  const costSection = `
    <section class="rpt-section">
      ${H('ბიუჯეტი და ფულადი ნაკადი', 'Budget & Cash Flow')}
      <div class="rpt-tiles rpt-tiles-4 rpt-avoid">
        ${tile('ბიუჯეტი', 'Budget', m(cost.budget))}
        ${tile('გეგმით დღემდე', 'Planned by today', m(cost.planned))}
        ${tile('შესრულებული სამუშაო', 'Work done', m(cost.earned), '', cost.earned < cost.planned - 0.5 ? 'bad' : 'ok')}
        ${tile('დახარჯული', 'Spent', m(cost.spent), '', cost.contracts > cost.earned + 0.5 ? 'warn' : '')}
      </div>
      ${monthKeys.length ? sCurve + monthTable : none}
      ${itemCosts}
      ${siteCostsBlock}
    </section>`;

  // ---------- Contractors: one card each ----------
  const rating = (s) => {
    if (!s?.items) return chip({ ka: 'სამუშაო არ აქვს', en: 'No work yet', tone: 'muted' });
    if (s.overdue) return chip({ ka: 'ვადაგადაცილება', en: 'Overdue', tone: 'bad' });
    if (s.late) return chip({ ka: 'დაგვიანება', en: 'Late', tone: 'warn' }, ` · ${s.avgDaysLate}დღ / ${s.avgDaysLate}d`);
    if (s.onTime) return chip({ ka: 'ვადაში', en: 'On time', tone: 'ok' });
    return chip({ ka: 'მიმდინარე', en: 'Ongoing', tone: 'info' });
  };
  const seg = (n, total, tone) => (n ? `<i class="rpt-seg rpt-seg-${tone}" style="width:${(n / total) * 100}%"></i>` : '');
  const contractorsSection = `
    <section class="rpt-section">
      ${H('კონტრაქტორები', 'Contractors', `${contractors.length}`)}
      ${contractors.length ? `
        <div class="rpt-cards">
          ${contractors.map((c) => {
            const s = perf.get(c.id);
            const items = s?.items ?? 0;
            const budget = s?.budget ?? 0;
            const paid = s?.paid ?? 0;
            return `
              <article class="rpt-card rpt-avoid">
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
                    <span><i class="rpt-sw rpt-sw-bad"></i>${s.overdue} ${L('გადაცილებული', 'overdue')}</span>
                    <span><i class="rpt-sw rpt-sw-muted"></i>${s.open} ${L('ღია', 'open')}</span>
                  </p>` : ''}
                <div class="rpt-card-money">
                  <span>${L('გადახდილი', 'Paid')} <b>${m(paid)}</b>${budget ? ` / ${m(budget)}` : ''}</span>
                  <span>${L('შეფერხება', 'Delays')} <b>${s?.delayDays ?? 0}</b> ${L('დღე', 'days')}</span>
                </div>
                ${budget ? `<div class="rpt-minibar"><i style="width:${clamp(pctOf(paid, budget))}%"></i></div>` : ''}
                ${c.phone || c.email ? `<p class="rpt-card-contact">${esc([c.contact_person, c.phone, c.email].filter(Boolean).join(' · '))}</p>` : ''}
              </article>`;
          }).join('')}
        </div>` : none}
    </section>`;

  // ---------- Rooms (only for sites that have them) ----------
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
              <span class="rpt-type"><b>${e.n}</b> ${esc(bi(type))}${e.area ? ` · ${num.format(e.area)} m²` : ''}</span>`).join('')}
          </div>` : none}
      </section>`;
  }

  // ---------- Site activity: manpower chart + latest logs ----------
  const tradeLabel = (key) => MANPOWER_TRADES.find((t) => t.key === key)?.label ?? key;
  const workersOf = (l) => Object.values(l.manpower || {}).reduce((s, n) => s + Number(n || 0), 0);
  const series = [...logs].reverse(); // oldest → newest
  const peak = Math.max(1, ...series.map(workersOf));
  const avg = series.length ? Math.round(series.reduce((s, l) => s + workersOf(l), 0) / series.length) : 0;
  const manpowerChart = series.length ? `
    <div class="rpt-columns rpt-avoid">
      ${series.map((l) => {
        const n = workersOf(l);
        return `
          <div class="rpt-col">
            <span class="rpt-col-value">${n}</span>
            <div class="rpt-col-bar" style="height:${Math.max(2, (n / peak) * 82)}%"></div>
            <span class="rpt-col-label">${dm(l.log_date)}</span>
          </div>`;
      }).join('')}
    </div>
    <p class="rpt-muted rpt-col-note">${L('საშუალოდ', 'Average')} <b>${avg}</b> · ${L('მაქსიმუმი', 'Peak')} <b>${peak}</b> ${L('მუშა ობიექტზე', 'workers on site')}</p>` : '';

  const logsSection = `
    <section class="rpt-section">
      ${H('ობიექტზე აქტივობა', 'Site Activity', series.length ? `${series.length} ${L('ჩანაწერი', 'logs')}` : '')}
      ${manpowerChart}
      ${logs.length ? logs.slice(0, 5).map((l) => {
        const crew = Object.entries(l.manpower || {}).filter(([, n]) => n > 0);
        const total = workersOf(l);
        return `
          <article class="rpt-log rpt-avoid">
            <div class="rpt-log-head">
              <strong>${esc(dateKa(l.log_date))}</strong>
              <span class="rpt-muted">${esc(dateEn(l.log_date))}</span>
              <span class="rpt-log-meta">
                ${l.weather ? esc(bi(l.weather)) : ''}${total ? ` · ${total} ${L('მუშა', 'workers')}` : ''}
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
  const causeDays = new Map();
  for (const x of delays) {
    const e = causeDays.get(x.delay_cause) ?? { days: 0, n: 0 };
    e.days += delayDaysLost(x, today);
    e.n += 1;
    causeDays.set(x.delay_cause, e);
  }
  const causes = [...causeDays].sort((a, b) => b[1].days - a[1].days);
  const maxCause = Math.max(1, ...causes.map(([, e]) => e.days));
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
        <table class="rpt-compact">
          <thead>
            <tr>
              <th>${L('თარიღი', 'Date')}</th><th>${L('მიზეზი', 'Cause')}</th>${rooms ? `<th>${L('ადგილი', 'Location')}</th>` : ''}
              <th>${L('კონტრაქტორი', 'Contractor')}</th><th class="num">${L('დღე', 'Days')}</th>
              <th>${L('სტატუსი', 'Status')}</th><th>${L('აღწერა', 'Description')}</th>
            </tr>
          </thead>
          <tbody>
            ${delays.map((x) => `
              <tr>
                <td>${d(x.created_at)}</td>
                <td>${esc(bi(x.delay_cause))}</td>
                ${rooms ? `<td>${x.flats ? `${esc(x.flats.block)}-${esc(x.flats.flat_number)}` : esc(bi('Site-wide'))}</td>` : ''}
                <td>${x.contractor_id ? esc(nameOf(x.contractor_id)) : '-'}</td>
                <td class="num">${num.format(delayDaysLost(x, today))}${delayIsOngoing(x) ? '+' : ''}</td>
                <td>${delayIsOngoing(x)
    ? `<span class="rpt-chip rpt-bad">${L('მიმდინარე', 'Ongoing')}</span>`
    : `${L('დასრულდა', 'Ended')} ${x.resolved_on ? d(x.resolved_on) : ''}`.trim()}</td>
                <td>${biText(x.description, x.description_en)}</td>
              </tr>`).join('')}
          </tbody>
        </table>` : `<p class="rpt-all-good">✓ ${L('ბოლო 30 დღეში შეფერხება არ ყოფილა', 'No delays in the last 30 days')}</p>`}
    </section>`;

  const footer = `<div class="rpt-avoid">${signatureHtml(REPORT_AUTHOR)}</div>`;

  const page = document.createElement('div');
  page.className = 'pdf-page rpt';
  page.innerHTML = header + glance + attention + notMoving + timeline + roadAhead
    + costSection + contractorsSection + unitsSection + logsSection + delaysSection + footer;
  return page;
}

const fileSafe = (name) => (name || 'Project')
  .replace(/[\\/:*?"<>|]+/g, '')
  .trim()
  .replace(/\s+/g, '_')
  .slice(0, 60) || 'Project';

/** Saves a page built by buildProjectReport() as Project_Report_<name>_<date>.pdf. */
export async function downloadProjectReport(page, project) {
  await document.fonts?.ready; // Georgian font must be loaded before rendering
  const today = iso(new Date());
  await window.html2pdf()
    .set({
      margin: [10, 10, 12, 10],
      filename: `Project_Report_${fileSafe(project.name)}_${today}.pdf`,
      image: { type: 'jpeg', quality: 0.98 },
      html2canvas: { scale: 2, useCORS: true, backgroundColor: '#ffffff' },
      jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' },
      pagebreak: { mode: ['css', 'legacy'], avoid: ['tr', '.rpt-avoid', 'h2', '.rpt-h'] },
    })
    .from(page)
    .save();
}
