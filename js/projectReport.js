// =============================================================
// Full project report — bilingual (Georgian / English), print-ready.
// Built from the open project's data; shown in the app and saved as PDF.
// =============================================================
import {
  taskState, costPosition, contractorPerformance, plannedSpendByMonth, actualSpendByMonth,
} from './schedule.js';
import { bi, dateKa, dateEn, signatureHtml } from './bilingual.js';
import { MANPOWER_TRADES, REPORT_AUTHOR } from './config.js';

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

// Language-neutral dates for tables: 26.09.2026
const d = (iso) => (iso ? iso.slice(0, 10).split('-').reverse().join('.') : '—');
const ym = (key) => key.split('-').reverse().join('.');           // 2026-09 → 09.2026
const num = new Intl.NumberFormat('en-GB', { maximumFractionDigits: 2 });

// Georgian label with the English beneath / beside it.
const L = (ka, en) => `${esc(ka)}<em>${esc(en)}</em>`;
const H = (ka, en) => `<h2>${esc(ka)} <em>${esc(en)}</em></h2>`;
const none = `<p class="rpt-none">${L('მონაცემები არ არის', 'No data yet')}</p>`;

const TASK_STATUS = {
  done:     { ka: 'დასრულდა',          en: 'Done',        tone: 'ok' },
  overdue:  { ka: 'ვადაგადაცილებული',  en: 'Overdue',     tone: 'bad' },
  active:   { ka: 'მიმდინარე',          en: 'In progress', tone: 'warn' },
  upcoming: { ka: 'დაგეგმილი',          en: 'Upcoming',    tone: 'muted' },
};

const UNIT_STATUS = {
  not_started: ['არ დაწყებულა', 'Not started'],
  in_progress: ['მიმდინარე', 'In progress'],
  finished:    ['დასრულებული', 'Finished'],
  handed_over: ['გადაცემული', 'Handed over'],
};

const chip = (s, extra = '') => `<span class="rpt-chip rpt-${s.tone}">${esc(s.ka)} / ${esc(s.en)}${extra}</span>`;

function bar(ka, en, pct, tone) {
  return `
    <div class="rpt-bar">
      <div class="rpt-bar-label"><span>${L(ka, en)}</span><strong>${pct}%</strong></div>
      <div class="rpt-bar-track"><div class="rpt-bar-fill rpt-fill-${tone}" style="width:${Math.min(100, pct)}%"></div></div>
    </div>`;
}

const tile = (ka, en, value, sub = '', tone = '') => `
  <div class="rpt-tile ${tone ? `rpt-tile-${tone}` : ''}">
    <span>${L(ka, en)}</span>
    <strong>${esc(value)}</strong>
    ${sub ? `<small>${sub}</small>` : ''}
  </div>`;

// Recent logs and delays aren't kept in app state, so fetch them here.
async function fetchExtras(db, projectId, today) {
  const since = new Date(`${today}T00:00`);
  since.setDate(since.getDate() - 30);
  const [logs, delays] = await Promise.all([
    db.from('daily_logs')
      .select('log_date, weather, manpower, notes, notes_en')
      .eq('project_id', projectId)
      .order('log_date', { ascending: false })
      .limit(7),
    db.from('delays')
      .select('created_at, delay_cause, duration_hours, description, contractor_id, flats(block, flat_number)')
      .eq('project_id', projectId)
      .gte('created_at', since.toISOString())
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
  db, project, tasks, payments, contractors, contractorDelays, units, progress, money, userEmail,
}) {
  const today = new Date().toLocaleDateString('en-CA');
  const { logs, delays } = await fetchExtras(db, project.id, today);
  const cost = costPosition(tasks, payments, today);
  const perf = contractorPerformance(tasks, contractorDelays, payments, today); // all-time delays
  const nameOf = (id) => contractors.find((c) => c.id === id)?.name ?? '—';
  const paidOn = (taskId) => payments.filter((p) => p.task_id === taskId).reduce((s, p) => s + Number(p.amount), 0);
  const m = (n) => money.format(n);

  // ---------- Header ----------
  const header = `
    <header class="rpt-header">
      <div>
        <p class="rpt-eyebrow">პროექტის ანგარიში · Project Report</p>
        <h1>${esc(project.name)}</h1>
        <p class="rpt-muted">${esc([project.location, project.currency].filter(Boolean).join(' · '))}</p>
      </div>
      <div class="rpt-header-date">
        <p class="rpt-eyebrow">თარიღი · Date</p>
        <p class="rpt-strong">${esc(dateKa(today))}</p>
        <p class="rpt-muted">${esc(dateEn(today))}</p>
      </div>
    </header>`;

  // ---------- Key figures ----------
  const area = units.reduce((s, u) => s + Number(u.area_m2 || 0), 0);
  const delayHours = delays.reduce((s, x) => s + Number(x.duration_hours || 0), 0);
  const gap = progress.actualPct - progress.plannedPct;
  const keyFigures = `
    <section class="rpt-section rpt-avoid">
      <div class="rpt-tiles">
        ${tile('პროგრესი', 'Progress', `${progress.actualPct}%`,
          `${L('გეგმა', 'Plan')} ${progress.plannedPct}%`, gap < -5 ? 'bad' : 'ok')}
        ${tile('ვადაგადაცილებული', 'Overdue items', String(progress.overdue.length),
          `${progress.count} ${L('პუნქტიდან', 'items in total')}`, progress.overdue.length ? 'bad' : '')}
        ${tile('ბიუჯეტი', 'Budget', m(cost.budget), `${L('შესრულებული', 'Work done')} ${m(cost.earned)}`)}
        ${tile('დახარჯული', 'Spent', m(cost.spent),
          cost.budget ? `${Math.round((cost.spent / cost.budget) * 100)}% ${L('ბიუჯეტის', 'of budget')}` : '',
          cost.spent > cost.budget && cost.budget ? 'bad' : '')}
        ${tile('ერთეულები', 'Units', String(units.length), area ? `${num.format(area)} m²` : '')}
        ${tile('შეფერხებები (30 დღე)', 'Delays (30 days)', String(delays.length),
          delayHours ? `${num.format(delayHours)} ${L('საათი', 'hours')}` : '')}
      </div>
    </section>`;

  // ---------- Progress & time ----------
  let timeBar = '';
  let timeLine = '';
  if (project.start_date && project.end_date) {
    const start = new Date(`${project.start_date}T00:00`);
    const end = new Date(`${project.end_date}T00:00`);
    const now = new Date(`${today}T00:00`);
    const total = Math.max(1, Math.round((end - start) / 86_400_000));
    const elapsed = Math.min(total, Math.max(0, Math.round((now - start) / 86_400_000)));
    timeBar = bar('გასული დრო', 'Time elapsed', Math.round((elapsed / total) * 100), 'time');
    timeLine = `<p class="rpt-muted">${d(project.start_date)} → ${d(project.end_date)} · ${total} ${L('დღე', 'days')}</p>`;
  }
  const progressSection = `
    <section class="rpt-section rpt-avoid">
      ${H('პროგრესი და ვადები', 'Progress & Schedule')}
      ${timeLine}
      <div class="rpt-bars">
        ${timeBar}
        ${bar('გეგმით დღემდე', 'Planned by today', progress.plannedPct, 'plan')}
        ${bar('შესრულებული', 'Work complete', progress.actualPct, 'done')}
      </div>
      ${progress.overdue.length ? `
        <ul class="rpt-alerts">
          ${progress.overdue.map((t) => `
            <li>! ${esc(t.name)} — ${t.daysLate} ${L('დღით გადაცილებული', 'days overdue')}</li>`).join('')}
        </ul>` : ''}
    </section>`;

  // ---------- Timetable ----------
  const timetable = `
    <section class="rpt-section">
      ${H('სამუშაო გრაფიკი', 'Timetable')}
      ${tasks.length ? `
        <table>
          <thead>
            <tr>
              <th>${L('სამუშაო', 'Work item')}</th><th>${L('კონტრაქტორი', 'Contractor')}</th>
              <th>${L('დაწყება', 'Start')}</th><th>${L('დასრულება', 'Finish')}</th>
              <th class="num">${L('ბიუჯეტი', 'Budget')}</th><th class="num">${L('გადახდილი', 'Paid')}</th>
              <th>${L('სტატუსი', 'Status')}</th>
            </tr>
          </thead>
          <tbody>
            ${tasks.map((t) => {
              const s = taskState(t, today);
              const late = s.daysLate ? ` · ${s.daysLate}d` : '';
              return `
                <tr>
                  <td>${esc(t.name)}</td>
                  <td>${t.contractor_id ? esc(nameOf(t.contractor_id)) : '—'}</td>
                  <td>${d(t.planned_start)}</td>
                  <td>${d(t.planned_finish)}</td>
                  <td class="num">${Number(t.budget) ? m(t.budget) : '—'}</td>
                  <td class="num">${paidOn(t.id) ? m(paidOn(t.id)) : '—'}</td>
                  <td>${chip(TASK_STATUS[s.key], late)}</td>
                </tr>`;
            }).join('')}
          </tbody>
        </table>` : none}
    </section>`;

  // ---------- Contractors ----------
  const onProject = contractors; // already this project's contractors
  const rating = (s) => {
    if (!s?.items) return '—';
    if (s.overdue) return chip({ ka: 'ვადაგადაცილება', en: 'Overdue', tone: 'bad' });
    if (s.late) return chip({ ka: 'დაგვიანება', en: 'Late', tone: 'warn' }, ` · ${s.avgDaysLate}d`);
    if (s.onTime) return chip({ ka: 'ვადაში', en: 'On time', tone: 'ok' });
    return chip({ ka: 'მიმდინარე', en: 'Ongoing', tone: 'muted' });
  };
  const contractorsSection = `
    <section class="rpt-section">
      ${H('კონტრაქტორები', 'Contractors')}
      ${onProject.length ? `
        <table>
          <thead>
            <tr>
              <th>${L('კონტრაქტორი', 'Contractor')}</th><th class="num">${L('სამუშაო', 'Jobs')}</th>
              <th class="num">${L('ვადაში', 'On time')}</th><th class="num">${L('დაგვიანებით', 'Late')}</th>
              <th class="num">${L('გადაცილებული', 'Overdue')}</th><th class="num">${L('შეფერხება', 'Delay')}</th>
              <th class="num">${L('გადახდილი', 'Paid')}</th><th>${L('შეფასება', 'Rating')}</th>
            </tr>
          </thead>
          <tbody>
            ${onProject.map((c) => {
              const s = perf.get(c.id);
              return `
                <tr>
                  <td><strong>${esc(c.name)}</strong>${c.trade ? `<br><span class="rpt-muted">${esc(c.trade)}</span>` : ''}</td>
                  <td class="num">${s?.items ?? 0}</td>
                  <td class="num">${s?.onTime ?? 0}</td>
                  <td class="num">${s?.late ?? 0}</td>
                  <td class="num">${s?.overdue ?? 0}</td>
                  <td class="num">${s?.delayHours ? `${num.format(s.delayHours)} h` : '—'}</td>
                  <td class="num">${s?.paid ? m(s.paid) : '—'}</td>
                  <td>${rating(s)}</td>
                </tr>`;
            }).join('')}
          </tbody>
        </table>` : none}
    </section>`;

  // ---------- Cost & cash flow ----------
  const planned = plannedSpendByMonth(tasks);
  const actual = actualSpendByMonth(payments);
  const months = [...new Set([...planned.keys(), ...actual.keys()])].sort();
  let cumP = 0;
  let cumA = 0;
  const thisMonth = today.slice(0, 7);
  const costSection = `
    <section class="rpt-section">
      ${H('ბიუჯეტი და ფულადი ნაკადი', 'Budget & Cash Flow')}
      <div class="rpt-tiles rpt-tiles-4 rpt-avoid">
        ${tile('ბიუჯეტი', 'Budget', m(cost.budget))}
        ${tile('გეგმით დღემდე', 'Planned by today', m(cost.planned))}
        ${tile('შესრულებული სამუშაო', 'Work done', m(cost.earned), '', cost.earned < cost.planned - 0.5 ? 'bad' : '')}
        ${tile('დახარჯული', 'Spent', m(cost.spent), '', cost.spent > cost.earned + 0.5 ? 'warn' : '')}
      </div>
      ${months.length ? `
        <table>
          <thead>
            <tr>
              <th>${L('თვე', 'Month')}</th><th class="num">${L('გეგმა', 'Planned')}</th>
              <th class="num">${L('გადახდილი', 'Paid')}</th><th class="num">${L('ჯამური გეგმა', 'Cumulative plan')}</th>
              <th class="num">${L('ჯამური გადახდა', 'Cumulative paid')}</th>
            </tr>
          </thead>
          <tbody>
            ${months.map((k) => {
              const p = planned.get(k) ?? 0;
              const a = actual.get(k) ?? 0;
              cumP += p;
              cumA += a;
              return `
                <tr class="${k === thisMonth ? 'rpt-current' : ''}">
                  <td>${ym(k)}</td>
                  <td class="num">${m(p)}</td>
                  <td class="num">${a ? m(a) : '—'}</td>
                  <td class="num">${m(cumP)}</td>
                  <td class="num">${k <= thisMonth ? m(cumA) : '—'}</td>
                </tr>`;
            }).join('')}
          </tbody>
        </table>` : none}
    </section>`;

  // ---------- Units ----------
  const byType = new Map();
  for (const u of units) {
    const key = u.unit_type || '—';
    const e = byType.get(key) ?? { n: 0, area: 0 };
    e.n += 1;
    e.area += Number(u.area_m2 || 0);
    byType.set(key, e);
  }
  const unitsSection = `
    <section class="rpt-section rpt-avoid">
      ${H('ერთეულები', 'Units')}
      ${units.length ? `
        <div class="rpt-two">
          <table>
            <thead><tr><th>${L('სტატუსი', 'Status')}</th><th class="num">${L('რაოდენობა', 'Count')}</th></tr></thead>
            <tbody>
              ${Object.entries(UNIT_STATUS).map(([key, [ka, en]]) => `
                <tr><td>${esc(ka)} / ${esc(en)}</td><td class="num">${units.filter((u) => (u.status ?? 'not_started') === key).length}</td></tr>`).join('')}
            </tbody>
          </table>
          <table>
            <thead><tr><th>${L('ტიპი', 'Type')}</th><th class="num">${L('რაოდენობა', 'Count')}</th><th class="num">m²</th></tr></thead>
            <tbody>
              ${[...byType].sort((a, b) => b[1].n - a[1].n).map(([type, e]) => `
                <tr><td>${esc(type)}</td><td class="num">${e.n}</td><td class="num">${e.area ? num.format(e.area) : '—'}</td></tr>`).join('')}
            </tbody>
          </table>
        </div>` : none}
    </section>`;

  // ---------- Recent daily logs ----------
  const tradeLabel = (key) => MANPOWER_TRADES.find((t) => t.key === key)?.label ?? key;
  const logsSection = `
    <section class="rpt-section">
      ${H('ბოლო დღიური ჩანაწერები', 'Recent Daily Logs')}
      ${logs.length ? logs.map((l) => {
        const crew = Object.entries(l.manpower || {}).filter(([, n]) => n > 0);
        const total = crew.reduce((s, [, n]) => s + Number(n), 0);
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
              <p class="rpt-notes">${esc(l.notes || '—')}</p>
              <p class="rpt-notes">${esc(l.notes_en || '—')}</p>
            </div>
          </article>`;
      }).join('') : none}
    </section>`;

  // ---------- Delays ----------
  const delaysSection = `
    <section class="rpt-section">
      ${H('შეფერხებები (ბოლო 30 დღე)', 'Delays (last 30 days)')}
      ${delays.length ? `
        <table>
          <thead>
            <tr>
              <th>${L('თარიღი', 'Date')}</th><th>${L('მიზეზი', 'Cause')}</th><th>${L('ადგილი', 'Location')}</th>
              <th>${L('კონტრაქტორი', 'Contractor')}</th><th class="num">${L('საათი', 'Hours')}</th><th>${L('აღწერა', 'Description')}</th>
            </tr>
          </thead>
          <tbody>
            ${delays.map((x) => `
              <tr>
                <td>${d(x.created_at)}</td>
                <td>${esc(bi(x.delay_cause))}</td>
                <td>${x.flats ? `${esc(x.flats.block)}-${esc(x.flats.flat_number)}` : esc(bi('Site-wide'))}</td>
                <td>${x.contractor_id ? esc(nameOf(x.contractor_id)) : '—'}</td>
                <td class="num">${num.format(Number(x.duration_hours))}</td>
                <td>${esc(x.description || '—')}</td>
              </tr>`).join('')}
          </tbody>
          <tfoot>
            <tr><td colspan="4">${L('სულ', 'Total')}</td><td class="num">${num.format(delayHours)}</td><td></td></tr>
          </tfoot>
        </table>` : none}
    </section>`;

  const footer = `
    <div class="rpt-avoid">${signatureHtml(REPORT_AUTHOR)}</div>
    <p class="pdf-footer">${esc(bi('Generated'))} ${esc(new Date().toLocaleString('en-GB'))}${userEmail ? ` · ${esc(userEmail)}` : ''} · CPMG PM</p>`;

  const page = document.createElement('div');
  page.className = 'pdf-page rpt';
  page.innerHTML = header + keyFigures + progressSection + timetable + contractorsSection
    + costSection + unitsSection + logsSection + delaysSection + footer;
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
  const today = new Date().toLocaleDateString('en-CA');
  await window.html2pdf()
    .set({
      margin: [10, 10, 12, 10],
      filename: `Project_Report_${fileSafe(project.name)}_${today}.pdf`,
      image: { type: 'jpeg', quality: 0.98 },
      html2canvas: { scale: 2, useCORS: true, backgroundColor: '#ffffff' },
      jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' },
      pagebreak: { mode: ['css', 'legacy'], avoid: ['tr', '.rpt-avoid', 'h2'] },
    })
    .from(page)
    .save();
}
