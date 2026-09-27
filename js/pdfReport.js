// =============================================================
// Daily PDF report — bilingual (Georgian / English)
// Today's daily_logs + delays → Gemini summary in both languages
// (via Edge Function) → html2pdf
// =============================================================
import { MANPOWER_TRADES, REPORT_AUTHOR } from './config.js';
import { ka, bi, biName, dateKa, dateEn, signatureHtml } from './bilingual.js';

const SUMMARY_FUNCTION = 'daily-summary';

// ---------- Helpers ----------
function todayRange() {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return {
    date: start.toLocaleDateString('en-CA'), // YYYY-MM-DD, local time
    startISO: start.toISOString(),
    endISO: end.toISOString(),
  };
}

// Project name for a file name: keeps letters (Georgian too) and digits, spaces → "_".
const fileSafe = (name) => (name || 'Project')
  .replace(/[\\/:*?"<>|]+/g, '')
  .trim()
  .replace(/\s+/g, '_')
  .slice(0, 60) || 'Project';

const tradeLabel = (key) => MANPOWER_TRADES.find((t) => t.key === key)?.label ?? key.replace(/_/g, ' ');

// English label (sent to Gemini) and bilingual label (printed).
const flatLabel = (flat) => (flat ? `Block ${flat.block} · Room ${flat.flat_number}` : 'Site-wide');
const flatLabelBi = (flat) => (flat
  ? `${ka('Block')}/Block ${flat.block} · ${ka('Room')}/Room ${flat.flat_number}`
  : bi('Site-wide'));

function mergeManpower(logs) {
  const totals = {};
  for (const log of logs) {
    for (const [trade, count] of Object.entries(log.manpower || {})) {
      totals[trade] = (totals[trade] || 0) + Number(count || 0);
    }
  }
  return Object.entries(totals).filter(([, n]) => n > 0);
}

// ---------- 1. Query today's data ----------
async function fetchTodayData(db, projectId, day) {
  const [logs, delays] = await Promise.all([
    db.from('daily_logs')
      .select('log_date, weather, manpower, notes, notes_en')
      .eq('project_id', projectId)
      .eq('log_date', day.date),
    db.from('delays')
      .select('delay_cause, duration_days, description, description_en, created_at, flats(block, floor, flat_number)')
      .eq('project_id', projectId)
      .gte('created_at', day.startISO)
      .lt('created_at', day.endISO)
      .order('created_at'),
  ]);

  const failed = [logs, delays].find((r) => r.error);
  if (failed) throw new Error(`Could not load today's data: ${failed.error.message}`);
  return { logs: logs.data, delays: delays.data };
}

// ---------- 2. AI summary (both languages) ----------
async function fetchSummary(db, payload) {
  if (!payload.daily_logs.length && !payload.delays.length) {
    const none = 'No daily log or delays were recorded for this project today.';
    return { ka: [ka(none)], en: [none], source: 'none' };
  }

  const { data, error } = await db.functions.invoke(SUMMARY_FUNCTION, { body: payload });
  if (error) {
    let message = error.message;
    try {
      const body = await error.context?.json();
      if (body?.error) message = body.error;
    } catch { /* non-JSON error body */ }
    return { ka: [], en: [], source: 'error', note: `${bi('AI summary unavailable')}: ${message}` };
  }
  return { ka: data.ka ?? [], en: data.en ?? [], source: 'ai' };
}

// ---------- 3. Populate the printable template ----------
function addRow(tbody, cells) {
  const tr = document.createElement('tr');
  for (const { text, className } of cells) {
    const td = document.createElement('td');
    td.textContent = text;
    if (className) td.className = className;
    tr.appendChild(td);
  }
  tbody.appendChild(tr);
}

function addEmptyRow(tbody, colspan, text) {
  const tr = document.createElement('tr');
  const td = document.createElement('td');
  td.colSpan = colspan;
  td.className = 'pdf-empty';
  td.textContent = text;
  tr.appendChild(td);
  tbody.appendChild(tr);
}

function fillList(list, items) {
  for (const text of items) {
    const li = document.createElement('li');
    li.textContent = text;
    list.appendChild(li);
  }
}

function buildReport({ project, day, logs, delays, manpower, summary, progress, userEmail }) {
  const page = document.getElementById('daily-report-template').content.firstElementChild.cloneNode(true);
  const set = (field, value) => { page.querySelector(`[data-field="${field}"]`).textContent = value; };

  // Site details
  const workers = manpower.reduce((sum, [, n]) => sum + n, 0);
  const daysLost = delays.reduce((sum, d) => sum + Number(d.duration_days || 0), 0);
  const weather = [...new Set(logs.map((l) => l.weather).filter(Boolean))].map(bi).join(', ');

  set('project', project.name);
  set('location', project.location || '');
  const client = biName(project.client_name, project.client_name_ka);
  set('client', client ? `დამკვეთი / Client: ${client}` : '');
  set('date-ka', dateKa(day.date));
  set('date-en', dateEn(day.date));
  set('weather', weather || bi('Not recorded'));
  set('manpower-total', workers);
  set('delay-count', delays.length);
  set('delay-days', daysLost.toLocaleString('en-GB'));
  set('total-flats', project.total_flats ?? '—');
  set('progress', progress?.count
    ? `${progress.actualPct}% (${ka('plan')}/plan ${progress.plannedPct}%)`
    : bi('No timetable'));

  // Executive summary — Georgian and English columns
  fillList(page.querySelector('[data-list="summary-ka"]'), summary.ka);
  fillList(page.querySelector('[data-list="summary-en"]'), summary.en);
  set('summary-note', {
    ai: bi('Summary written by Gemini from the log and delay entries in this report.'),
    error: summary.note,
    none: '',
  }[summary.source]);

  // Manpower
  const mpRows = page.querySelector('[data-rows="manpower"]');
  if (manpower.length) {
    manpower.forEach(([trade, n]) => addRow(mpRows, [{ text: bi(tradeLabel(trade)) }, { text: n, className: 'num' }]));
    addRow(mpRows, [{ text: bi('Total'), className: 'pdf-strong' }, { text: workers, className: 'num pdf-strong' }]);
  } else {
    addEmptyRow(mpRows, 2, bi('No manpower recorded.'));
  }

  // Delays
  const delayRows = page.querySelector('[data-rows="delays"]');
  if (delays.length) {
    delays.forEach((d) => addRow(delayRows, [
      { text: bi(d.delay_cause) },
      { text: flatLabelBi(d.flats) },
      { text: Number(d.duration_days).toLocaleString('en-GB'), className: 'num' },
      { text: [d.description, d.description_en].filter(Boolean).join('\n') || '—', className: 'pdf-bi' },
    ]));
  } else {
    addEmptyRow(delayRows, 4, bi('No delays recorded today.'));
  }

  // Site notes (Gemini-corrected Georgian + English) + footer
  const joinNotes = (key) => logs.map((l) => l[key]).filter(Boolean).join('\n\n');
  set('notes-ka', joinNotes('notes') || ka('No site notes recorded.'));
  set('notes-en', joinNotes('notes_en') || 'No site notes recorded.');
  const stamp = new Date().toLocaleString('en-GB');
  set('generated', `${bi('Generated')} ${stamp}${userEmail ? ` · ${userEmail}` : ''}`);
  page.querySelector('[data-signature]').innerHTML = signatureHtml(REPORT_AUTHOR);

  return page;
}

// ---------- 4. Export ----------
/**
 * Builds today's bilingual report for `project` and downloads Daily_Report_[YYYY-MM-DD].pdf.
 * Returns { aiNote } — set when the PDF was saved without an AI summary.
 */
export async function generateDailyReport({ db, project, progress, userEmail }) {
  const day = todayRange();
  const { logs, delays } = await fetchTodayData(db, project.id, day);
  const manpower = mergeManpower(logs);

  const summary = await fetchSummary(db, {
    date: day.date,
    project: {
      name: project.name,
      location: project.location,
      // the company that hired us — the report's main reader; spelled by hand in both languages
      client: { en: project.client_name, ka: project.client_name_ka },
      total_rooms: project.total_flats,
    },
    // Timetable position (progress is weighted by planned duration).
    schedule: progress?.count ? {
      progress_pct: progress.actualPct,
      planned_by_today_pct: progress.plannedPct,
      overdue_activities: progress.overdue.map((t) => ({ activity: t.name, days_late: t.daysLate })),
    } : null,
    daily_logs: logs.map((l) => ({ weather: l.weather, notes_ka: l.notes, notes_en: l.notes_en })),
    manpower: Object.fromEntries(manpower.map(([trade, n]) => [tradeLabel(trade), n])),
    delays: delays.map((d) => ({
      cause: d.delay_cause,
      location: flatLabel(d.flats),
      duration_days: Number(d.duration_days),
      description_ka: d.description,
      description_en: d.description_en,
    })),
  });

  const page = buildReport({ project, day, logs, delays, manpower, summary, progress, userEmail });
  const root = document.getElementById('pdf-export-root');
  root.replaceChildren(page);

  try {
    await document.fonts?.ready; // make sure the Georgian font is loaded before rendering
    await window.html2pdf()
      .set({
        margin: [10, 10, 12, 10], // mm: top, right, bottom, left
        filename: `Daily_Report_${fileSafe(project.name)}_${day.date}.pdf`,
        image: { type: 'jpeg', quality: 0.98 },
        html2canvas: { scale: 2, useCORS: true, backgroundColor: '#ffffff' },
        jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' },
        pagebreak: { mode: ['css', 'legacy'], avoid: ['tr', '.pdf-avoid-break'] },
      })
      .from(page)
      .save();
  } finally {
    root.replaceChildren();
  }

  return { aiNote: summary.source === 'error' ? summary.note : null };
}
