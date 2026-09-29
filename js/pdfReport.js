// =============================================================
// Daily PDF report - bilingual (Georgian / English)
// Today's daily_logs + delays → the browser's print engine
// =============================================================
import {
  MANPOWER_TRADES, REPORT_AUTHOR, DAY_WORKER_KEY,
  SITE_EVENT_KINDS, INCIDENT_SEVERITIES, VARIATION_STATUSES,
} from './config.js';
import { rentalEnd, delayIsOngoing, delayDaysLost } from './schedule.js';
import { ka, bi, biName, dateKa, dateEn, signatureHtml, roomLabelBi } from './bilingual.js';
import { fetchPhotos, signPhotos } from './photos.js';
import { printDocument } from './print.js';

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

// "დაწყებული <ka date> / since <en date>" - a delay carried over from an earlier day.
const sinceBi = (iso) => `${ka('since')} ${dateKa(iso)} / since ${dateEn(iso)}`;

// Bilingual room label; left out in a building that has none.
const flatLabelBi = roomLabelBi;

// Daily workers' pay for the day: headcount × the log's day rate.
function dayWorkerPay(logs) {
  let workers = 0;
  let pay = 0;
  let rate = null;
  for (const l of logs) {
    const n = Number(l.manpower?.[DAY_WORKER_KEY] || 0);
    workers += n;
    if (l.day_rate != null) {
      rate = Number(l.day_rate);
      pay += n * rate;
    }
  }
  return { workers, rate, pay };
}

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
async function fetchTodayData(db, projectId, day, { withRooms = false } = {}) {
  const [logs, delays, rentals, rooms, events, variations] = await Promise.all([
    db.from('daily_logs')
      .select('id, log_date, weather, manpower, notes, notes_en, day_rate')
      .eq('project_id', projectId)
      .eq('log_date', day.date),
    // Logged today, plus anything still running from an earlier day - an open
    // delay is today's problem too.
    db.from('delays')
      .select('id, delay_cause, duration_days, resolved_on, description, description_en, created_at, flats(block, floor, flat_number)')
      .eq('project_id', projectId)
      .lt('created_at', day.endISO)
      .or(`created_at.gte.${day.startISO},duration_days.is.null`)
      .order('created_at'),
    db.from('equipment_rentals')
      .select('equipment, equipment_ka, supplier, supplier_ka, start_date, days, daily_rate')
      .eq('project_id', projectId)
      .lte('start_date', day.date)
      .order('start_date'),
    withRooms
      ? db.from('flats').select('status').eq('project_id', projectId)
      : Promise.resolve({ data: [] }),
    // An incident is the thing nobody should hear about a week late, so it goes
    // in the day's own report. Like a delay, one that is still open comes back
    // every day until it is closed out - the contractor reads it each morning.
    db.from('site_events')
      .select('event_date, kind, severity, title, description, description_en, action, closed, contractors(name, name_ka)')
      .eq('project_id', projectId)
      .lte('event_date', day.date)
      .or(`event_date.eq.${day.date},closed.is.false`)
      .order('event_date'),
    // The value and the pricing live in the variation register; what matters
    // here is the instruction. It stays in the report until it is settled one
    // way or the other - still instructed or priced means still outstanding.
    db.from('variations')
      .select('ref, title, description, description_en, instructed_on, status, contractors(name, name_ka)')
      .eq('project_id', projectId)
      .lte('instructed_on', day.date)
      .or(`instructed_on.eq.${day.date},status.in.(instructed,priced)`)
      .order('instructed_on'),
  ]);

  const failed = [logs, delays, rentals, rooms, events, variations].find((r) => r.error);
  if (failed) throw new Error(`Could not load today's data: ${failed.error.message}`);
  // Equipment on hire today: started on or before today and not yet returned.
  const onHire = rentals.data.filter((r) => rentalEnd(r) >= day.date);
  // Today's figures count today's delays; the ones carried over are listed apart.
  const today = delays.data.filter((d) => d.created_at >= day.startISO);
  const carried = delays.data.filter((d) => d.created_at < day.startISO);
  // A room counts as done once it is finished or handed over.
  const roomProgress = {
    total: rooms.data.length,
    done: rooms.data.filter((r) => r.status === 'finished' || r.status === 'handed_over').length,
  };
  return {
    logs: logs.data,
    delays: today,
    carriedDelays: carried,
    rentals: onHire,
    roomProgress,
    events: events.data,
    variations: variations.data,
  };
}

/**
 * The day's photos, as signed links to the 1280 px copies: the logs' own, plus
 * anything filed against the delays this report lists.
 */
async function fetchPhotoUrls(db, { logs, delays, carriedDelays }) {
  const photos = await fetchPhotos(db, {
    dailyLogIds: logs.map((l) => l.id),
    delayIds: [...delays, ...carriedDelays].map((d) => d.id),
  });
  const urls = await signPhotos(db, photos, { full: true });
  return photos.map((p) => urls.get(p.id)).filter(Boolean);
}

// ---------- 2. Populate the printable template ----------
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

function buildReport({ project, day, logs, delays, carriedDelays = [], rentals, roomProgress, photoUrls = [], manpower, progress, money, events = [], variations = [] }) {
  const page = document.getElementById('daily-report-template').content.firstElementChild.cloneNode(true);
  const set = (field, value) => { page.querySelector(`[data-field="${field}"]`).textContent = value; };
  const rooms = Boolean(project.has_rooms);
  if (!rooms) {
    page.querySelectorAll('[data-rooms-only]').forEach((el) => el.remove());
    page.querySelector('.pdf-facts').classList.add('pdf-facts-5');
  }

  // Site details
  const workers = manpower.reduce((sum, [, n]) => sum + n, 0);
  // Every delay the report lists counts here - the ones carried over from an
  // earlier day are still today's problem.
  const allDelays = [...delays, ...carriedDelays];
  const daysLost = allDelays.reduce((sum, d) => sum + delayDaysLost(d, day.date), 0);
  const weather = [...new Set(logs.map((l) => l.weather).filter(Boolean))].map(bi).join(', ');

  set('project', biName(project.name, project.name_ka));
  set('location', biName(project.location, project.location_ka));
  const client = biName(project.client_name, project.client_name_ka);
  set('client', client ? `დამკვეთი / Client: ${client}` : '');
  set('date-ka', dateKa(day.date));
  set('date-en', dateEn(day.date));
  set('weather', weather || bi('Not recorded'));
  set('manpower-total', workers);
  set('delay-count', allDelays.length);
  set('delay-days', daysLost.toLocaleString('en-GB'));
  if (rooms) set('total-flats', roomProgress.total
    ? `${roomProgress.done} / ${roomProgress.total} (${Math.round((roomProgress.done / roomProgress.total) * 100)}%)`
    : '-');
  set('progress', progress?.count
    ? `${progress.actualPct}% (${ka('plan')}/plan ${progress.plannedPct}%)`
    : bi('No timetable'));

  // Manpower
  const mpRows = page.querySelector('[data-rows="manpower"]');
  if (manpower.length) {
    manpower.forEach(([trade, n]) => addRow(mpRows, [{ text: bi(tradeLabel(trade)) }, { text: n, className: 'num' }]));
    addRow(mpRows, [{ text: bi('Total'), className: 'pdf-strong' }, { text: workers, className: 'num pdf-strong' }]);
    const dw = dayWorkerPay(logs);
    if (dw.workers && dw.rate != null) {
      addRow(mpRows, [
        { text: 'დღიური მუშების ანაზღაურება / Daily workers’ pay' },
        { text: `${dw.workers} × ${money.format(dw.rate)} = ${money.format(dw.pay)}`, className: 'num' },
      ]);
    }
  } else {
    addEmptyRow(mpRows, 2, bi('No manpower recorded.'));
  }

  // Equipment on hire today (section hidden when there is none)
  const rentalRows = page.querySelector('[data-rows="rentals"]');
  if (rentals.length) {
    rentals.forEach((r) => addRow(rentalRows, [
      { text: biName(r.equipment, r.equipment_ka) },
      { text: biName(r.supplier, r.supplier_ka) || '-' },
      { text: `${Math.round((new Date(`${day.date}T00:00`) - new Date(`${r.start_date}T00:00`)) / 86_400_000) + 1} / ${r.days}` },
      { text: money.format(r.daily_rate), className: 'num' },
    ]));
  } else {
    page.querySelector('[data-section="rentals"]').remove();
  }

  // Delays (the location column only applies to sites with rooms)
  const delayRows = page.querySelector('[data-rows="delays"]');
  const carried = new Set(carriedDelays);
  if (delays.length || carriedDelays.length) {
    [...delays, ...carriedDelays].forEach((d) => addRow(delayRows, [
      { text: bi(d.delay_cause) + (carried.has(d) ? ` (${sinceBi(d.created_at.slice(0, 10))})` : '') },
      ...(rooms ? [{ text: flatLabelBi(d.flats) }] : []),
      { text: delayIsOngoing(d)
        ? `${delayDaysLost(d, day.date).toLocaleString('en-GB')} · ${bi('Ongoing')}`
        : delayDaysLost(d, day.date).toLocaleString('en-GB'), className: 'num' },
      { text: [d.description, d.description_en].filter(Boolean).join('\n') || '-', className: 'pdf-bi' },
    ]));
  } else {
    addEmptyRow(delayRows, rooms ? 4 : 3, bi('No delays recorded today.'));
  }

  // Safety and quality, and variations instructed. Anything still unresolved is
  // repeated every day, tagged with the date it started, exactly as a delay is.
  // Both sections drop out when there is nothing to carry.
  if (events.length) {
    const eventRows = page.querySelector('[data-rows="events"]');
    events.forEach((e) => addRow(eventRows, [
      { text: bi(SITE_EVENT_KINDS[e.kind] ?? e.kind) },
      { text: [e.title, e.description, e.description_en].filter(Boolean).join('\n'), className: 'pdf-bi' },
      { text: biName(e.contractors?.name, e.contractors?.name_ka) || '-' },
      { text: e.action || '-' },
      { text: [
        e.severity ? bi(INCIDENT_SEVERITIES[e.severity] ?? e.severity) : '',
        bi(e.closed ? 'Closed' : 'Open'),
        e.event_date < day.date ? sinceBi(e.event_date) : '',
      ].filter(Boolean).join(' · ') },
    ]));
  } else {
    page.querySelector('[data-section="events"]').remove();
  }

  if (variations.length) {
    const variationRows = page.querySelector('[data-rows="variations"]');
    variations.forEach((v) => addRow(variationRows, [
      { text: v.ref || '-' },
      { text: [v.title, v.description, v.description_en].filter(Boolean).join('\n'), className: 'pdf-bi' },
      { text: biName(v.contractors?.name, v.contractors?.name_ka) || '-' },
      { text: [
        bi(VARIATION_STATUSES[v.status] ?? v.status),
        v.instructed_on < day.date ? sinceBi(v.instructed_on) : '',
      ].filter(Boolean).join(' · ') },
    ]));
  } else {
    page.querySelector('[data-section="variations"]').remove();
  }

  // Site notes (Gemini-corrected Georgian + English) + footer
  const joinNotes = (key) => logs.map((l) => l[key]).filter(Boolean).join('\n\n');
  set('notes-ka', joinNotes('notes') || ka('No site notes recorded.'));
  set('notes-en', joinNotes('notes_en') || 'No site notes recorded.');
  // Photos, two to a row, in a table: a row keeps its pair together across a
  // page break, and every frame is the same size so the shots line up.
  if (photoUrls.length) {
    const body = page.querySelector('[data-photos]');
    for (let i = 0; i < photoUrls.length; i += 2) {
      const tr = document.createElement('tr');
      for (const url of photoUrls.slice(i, i + 2)) {
        const td = document.createElement('td');
        const frame = document.createElement('div');
        const img = document.createElement('img');
        img.crossOrigin = 'anonymous'; // html2canvas cannot draw a tainted image
        img.src = url;
        frame.appendChild(img);
        td.appendChild(frame);
        tr.appendChild(td);
      }
      if (tr.children.length === 1) tr.appendChild(document.createElement('td'));
      body.appendChild(tr);
    }
  } else {
    page.querySelector('[data-section="photos"]').remove();
  }

  page.querySelector('[data-signature]').innerHTML = signatureHtml(REPORT_AUTHOR);

  return page;
}

// ---------- 4. Export ----------
/**
 * Builds today's bilingual report for `project` and sends it to the printer,
 * where it can be saved as Daily_Report_[YYYY-MM-DD].pdf.
 */
export async function generateDailyReport({ db, project, progress, money }) {
  const day = todayRange();
  const { logs, delays, carriedDelays, rentals, roomProgress, events, variations } =
    await fetchTodayData(db, project.id, day, { withRooms: Boolean(project.has_rooms) });
  const manpower = mergeManpower(logs);

  const photoUrls = await fetchPhotoUrls(db, { logs, delays, carriedDelays });
  const page = buildReport({
    project, day, logs, delays, carriedDelays, rentals, roomProgress, photoUrls,
    manpower, progress, money, events, variations,
  });
  await printDocument(page, `Daily_Report_${fileSafe(project.name)}_${day.date}`);
}
