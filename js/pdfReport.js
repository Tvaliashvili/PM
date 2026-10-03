// =============================================================
// Daily PDF report - bilingual (Georgian / English)
// One day's daily_logs + delays → html2pdf
// =============================================================
import {
  MANPOWER_TRADES, REPORT_AUTHOR,
  SITE_EVENT_KINDS, INCIDENT_SEVERITIES, VARIATION_STATUSES,
} from './config.js';
import { rentalEnd, delayIsOngoing, delayDaysLost, delayCovers } from './schedule.js';
import { ka, bi, biName, dateKa, dateEn, signatureHtml, roomLabelBi } from './bilingual.js';
import { fetchPhotos, signPhotos } from './photos.js';
import { savePdf } from './pdfSave.js';
import { saveDocx } from './docxSave.js';

// ---------- Helpers ----------
/** One day, local time: today, or the YYYY-MM-DD given. */
function dayRange(date) {
  const start = date ? new Date(`${date}T00:00`) : new Date();
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

function mergeManpower(logs) {
  const totals = {};
  for (const log of logs) {
    for (const [trade, count] of Object.entries(log.manpower || {})) {
      totals[trade] = (totals[trade] || 0) + Number(count || 0);
    }
  }
  return Object.entries(totals).filter(([, n]) => n > 0);
}

/**
 * The day's crew grouped by whoever brought them: [{ name, trades, total }].
 * Men the client hired themselves come last, under their own heading: they
 * answer to no contractor and should not be counted against one.
 */
function crewByContractor(logs) {
  const groups = new Map();
  for (const log of logs) {
    for (const c of log.crew ?? []) {
      const workers = Number(c.workers) || 0;
      if (workers <= 0) continue;
      const name = biName(c.contractors?.name, c.contractors?.name_ka) || bi('Hired by the client');
      if (!groups.has(name)) groups.set(name, { name, trades: new Map(), total: 0, direct: !c.contractors });
      const g = groups.get(name);
      g.trades.set(c.trade, (g.trades.get(c.trade) || 0) + workers);
      g.total += workers;
    }
  }
  return [...groups.values()].sort((a, b) => (a.direct === b.direct ? b.total - a.total : a.direct - b.direct));
}

// ---------- 1. Query today's data ----------
async function fetchTodayData(db, projectId, day) {
  const [logs, delays, rentals, work, events, variations] = await Promise.all([
    db.from('daily_logs')
      .select('id, log_date, weather, manpower, notes, notes_en, day_rate, '
        + 'crew:daily_manpower(trade, workers, contractor_id, contractors(name, name_ka))')
      .eq('project_id', projectId)
      .eq('log_date', day.date),
    // Logged that day, plus anything from an earlier day still running on it -
    // an open delay is that day's problem too. Which earlier ones were still
    // running is worked out below, from each delay's own days.
    db.from('delays')
      .select('id, delay_cause, duration_days, resolved_on, description, description_en, created_at, flats(block, floor, flat_number)')
      .eq('project_id', projectId)
      .lt('created_at', day.endISO)
      .order('created_at'),
    db.from('equipment_rentals')
      .select('equipment, equipment_ka, supplier, supplier_ka, start_date, days')
      .eq('project_id', projectId)
      .lte('start_date', day.date)
      .order('start_date'),
    // Work recorded in the rooms on this day.
    db.from('work_done')
      .select('flat_id, work, work_en, quantity, unit, created_at, contractors(name, name_ka), flats(block, floor, flat_number)')
      .eq('project_id', projectId)
      .eq('work_date', day.date)
      .order('created_at'),
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

  const failed = [logs, delays, rentals, work, events, variations].find((r) => r.error);
  if (failed) throw new Error(`Could not load today's data: ${failed.error.message}`);
  // Equipment on hire today: started on or before today and not yet returned.
  const onHire = rentals.data.filter((r) => rentalEnd(r) >= day.date);
  // Today's figures count today's delays; the ones carried over are listed apart.
  const today = delays.data.filter((d) => d.created_at >= day.startISO);
  const carried = delays.data.filter((d) => d.created_at < day.startISO && delayCovers(d, day.date));
  return {
    logs: logs.data,
    delays: today,
    carriedDelays: carried,
    rentals: onHire,
    work: work.data,
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

/** A heading row across the table: the room the lines under it belong to. */
function addGroupRow(tbody, colspan, text) {
  const tr = document.createElement('tr');
  tr.className = 'pdf-group-row';
  const td = document.createElement('td');
  td.colSpan = colspan;
  td.textContent = text;
  tr.appendChild(td);
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

/**
 * Where the day falls in the programme: "214 / 365" - day 214 of a 365-day
 * project, both counted from the start date. '-' without both dates, or before
 * the start.
 */
function projectDay(project, date) {
  const { start_date: start, end_date: end } = project;
  if (!start || !end || date < start) return '-';
  const days = (a, b) => Math.round((new Date(`${b}T00:00`) - new Date(`${a}T00:00`)) / 86_400_000) + 1;
  return `${days(start, date)} / ${days(start, end)}`;
}

/** "200 m²" - or '' when no quantity was given. */
const quantityOf = (w) => (w.quantity != null
  ? `${Number(w.quantity).toLocaleString('en-GB', { maximumFractionDigits: 3 }).replace(/,/g, ' ')}${w.unit ? ` ${w.unit}` : ''}`
  : '');

function buildReport({ project, day, logs, delays, carriedDelays = [], rentals, work = [], photoUrls = [], manpower, events = [], variations = [] }) {
  const page = document.getElementById('daily-report-template').content.firstElementChild.cloneNode(true);
  const set = (field, value) => { page.querySelector(`[data-field="${field}"]`).textContent = value; };
  const rooms = Boolean(project.has_rooms);
  // Columns that only mean something where the site has rooms.
  if (!rooms) page.querySelectorAll('[data-rooms-only]').forEach((el) => el.remove());

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
  // Companies with anyone on site; the client's own men are not one.
  set('contractors-on-site', new Set(logs.flatMap((l) => l.crew ?? [])
    .filter((c) => c.contractor_id && Number(c.workers) > 0).map((c) => c.contractor_id)).size);
  set('project-day', projectDay(project, day.date));
  set('delay-count', allDelays.length);
  set('delay-days', daysLost.toLocaleString('en-GB').replace(/,/g, '\u00A0'));

  // Manpower. Heads only: what the day's labour and hire cost belongs in the
  // project report, as one figure for the whole job. A price standing next to a
  // headcount here only invited the two to be read as the same number.
  const mpRows = page.querySelector('[data-rows="manpower"]');
  if (manpower.length) {
    // Grouped by contractor where the crew was recorded that way, so the day
    // says whose men were on site and not only how many.
    const groups = crewByContractor(logs);
    if (groups.length) {
      for (const g of groups) {
        addRow(mpRows, [
          { text: g.name, className: 'pdf-strong' },
          { text: g.total, className: 'num pdf-strong' },
        ]);
        for (const [trade, n] of g.trades) {
          addRow(mpRows, [{ text: bi(tradeLabel(trade)), className: 'pdf-indent' }, { text: n, className: 'num' }]);
        }
      }
    } else {
      manpower.forEach(([trade, n]) => addRow(mpRows, [{ text: bi(tradeLabel(trade)) }, { text: n, className: 'num' }]));
    }
    addRow(mpRows, [{ text: bi('Total'), className: 'pdf-strong' }, { text: workers, className: 'num pdf-strong' }]);
  } else {
    addEmptyRow(mpRows, 2, bi('No manpower recorded.'));
  }

  // Work done that day: each room once, as a heading, and under it each kind
  // of work once - two contractors on the same work share its line, each with
  // their part. A quantity is what was measured that day; work with none went
  // on unmeasured, "in progress" (section hidden when none was recorded).
  if (work.length) {
    const workRows = page.querySelector('[data-rows="work"]');
    const byNumber = (a, b) => String(a ?? '').localeCompare(String(b ?? ''), undefined, { numeric: true });
    const roomsOfDay = new Map();
    for (const w of work) {
      const room = w.flat_id ?? '';
      if (!roomsOfDay.has(room)) roomsOfDay.set(room, { flat: w.flats, works: new Map() });
      const key = String(w.work || w.work_en || '').trim().toLowerCase();
      const works = roomsOfDay.get(room).works;
      if (!works.has(key)) works.set(key, { ka: w.work, en: w.work_en, byUnit: new Map(), who: new Map() });
      const g = works.get(key);
      const name = biName(w.contractors?.name, w.contractors?.name_ka);
      if (!g.who.has(name)) g.who.set(name, new Map());
      const q = Number(w.quantity) || 0;
      if (q > 0) {
        for (const map of [g.byUnit, g.who.get(name)]) map.set(w.unit ?? '', (map.get(w.unit ?? '') ?? 0) + q);
      }
    }
    // "200 m²" - or "200 m² · 12 pcs" when measured in two units; '' when not measured.
    const measured = (byUnit) => [...byUnit].map(([unit, q]) => quantityOf({ quantity: q, unit })).join(' · ');
    const inProgress = 'მიმდინარეობს / In progress';
    const ordered = [...roomsOfDay.values()].sort((a, b) => (!a.flat) - (!b.flat)
      || byNumber(a.flat?.block, b.flat?.block) || byNumber(a.flat?.floor, b.flat?.floor)
      || byNumber(a.flat?.flat_number, b.flat?.flat_number));
    for (const { flat, works } of ordered) {
      if (rooms) addGroupRow(workRows, 3, flat ? flatLabelBi(flat) : bi('Site-wide'));
      for (const g of works.values()) {
        const named = [...g.who].filter(([name]) => name);
        addRow(workRows, [
          { text: [g.ka, g.en !== g.ka ? g.en : ''].filter(Boolean).join('\n'), className: 'pdf-bi' },
          { text: named.length > 1
            ? named.map(([name, m]) => `${name} - ${measured(m) || inProgress}`).join('\n')
            : named[0]?.[0] || '-', className: 'pdf-bi' },
          { text: measured(g.byUnit) || inProgress, className: 'num pdf-bi' },
        ]);
      }
    }
  } else {
    page.querySelector('[data-section="work"]').remove();
  }

  // Equipment on hire today (section hidden when there is none)
  const rentalRows = page.querySelector('[data-rows="rentals"]');
  if (rentals.length) {
    rentals.forEach((r) => addRow(rentalRows, [
      { text: biName(r.equipment, r.equipment_ka) },
      { text: biName(r.supplier, r.supplier_ka) || '-' },
      { text: `${Math.round((new Date(`${day.date}T00:00`) - new Date(`${r.start_date}T00:00`)) / 86_400_000) + 1} / ${r.days}` },
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
        ? `${delayDaysLost(d, day.date).toLocaleString('en-GB').replace(/,/g, '\u00A0')} · ${bi('Ongoing')}`
        : delayDaysLost(d, day.date).toLocaleString('en-GB').replace(/,/g, '\u00A0'), className: 'num' },
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
  // Photos, two to a row. They go in a table because that is the one thing
  // html2pdf keeps whole across a page break - a grid item it happily slices.
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
 * Builds the bilingual report of one day (today unless `date` is given) for
 * `project`: { page, name, title } - the page not yet in the document, and the
 * file name (without extension) and title it is saved under.
 */
export async function buildDailyReport({ db, project, date }) {
  const day = dayRange(date);
  const { logs, delays, carriedDelays, rentals, work, events, variations } =
    await fetchTodayData(db, project.id, day);
  const manpower = mergeManpower(logs);

  const photoUrls = await fetchPhotoUrls(db, { logs, delays, carriedDelays });
  const page = buildReport({
    project, day, logs, delays, carriedDelays, rentals, work, photoUrls,
    manpower, events, variations,
  });
  return {
    page,
    name: `Daily_Report_${fileSafe(project.name)}_${day.date}`,
    title: `Daily Report - ${project.name} - ${day.date}`,
  };
}

/**
 * Saves a built daily report as <name>.pdf - or, with `word`, as a .docx to
 * arrange by hand before printing. Drawn from a copy, so the page shown in the
 * preview is left as it is.
 */
export async function saveDailyReport({ page, name, title }, { printable = false, word = false } = {}) {
  const root = document.getElementById('pdf-export-root');
  const copy = page.cloneNode(true);
  root.replaceChildren(copy);
  try {
    if (word) await saveDocx(copy, `${name}.docx`, { title });
    else await savePdf(copy, `${name}.pdf`, { printable });
  } finally {
    root.replaceChildren();
  }
}

/** Builds the report of one day and downloads it straight away (see saveDailyReport). */
export async function generateDailyReport({ db, project, date, printable = false, word = false }) {
  await saveDailyReport(await buildDailyReport({ db, project, date }), { printable, word });
}
