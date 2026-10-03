// =============================================================
// Project archive - the whole project in one ZIP, to hand to the client and
// keep after the project is deleted from the app.
//
//   index.html  the interactive archive: overview, a day-by-day journal of
//               the whole project, timeline, every item, every contractor,
//               every payment, the registers and every photo
//   report.html the interactive project report, as it stood on the day
//   photos/     every photo, full size and thumbnail
//   documents/  the contracts and acceptance acts (PDF)
//   data/       every table in one Excel workbook, and backup.json with the
//               rows as they were in the database
//
// Everything is collected in the browser: the photos and PDFs are fetched
// through their signed links (which expire within the hour) and written into
// the ZIP, so the archive needs neither the app nor a login to be read.
// =============================================================
import { signedUrls } from './photos.js';
import { KA } from './bilingual.js';
import { delayStart, delayEnd, delayDaysLost, delayIsOngoing, causeOf, taskState, rentalTotal } from './schedule.js';
import { MANPOWER_TRADES, CLOSED_HOW } from './config.js';

const JSZIP_URL = 'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js';
let jszip = null;
function loadJsZip() {
  jszip ??= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = JSZIP_URL;
    s.onload = () => resolve(window.JSZip);
    s.onerror = () => {
      jszip = null;
      reject(new Error('Could not load the ZIP maker - check the connection and try again.'));
    };
    document.head.append(s);
  });
  return jszip;
}

const fileSafe = (name) => String(name || '').replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || 'file';

/** Runs `job` over `items`, `limit` at a time; `tick` after each. */
async function inBatches(items, limit, job, tick) {
  let next = 0;
  let done = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      await job(items[i], i);
      tick?.(++done, items.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

/** Fetches what the app does not keep in memory: every log in full, and every photo. */
async function fetchRest(db, projectId) {
  const [logs, photos] = await Promise.all([
    db.from('daily_logs')
      .select('id, log_date, weather, manpower, notes, notes_en, day_rate, guard_rate, crew:daily_manpower(contractor_id, trade, workers)')
      .eq('project_id', projectId)
      .order('log_date'),
    db.from('photos')
      .select('id, daily_log_id, delay_id, path, thumb_path, caption, created_at')
      .eq('project_id', projectId)
      .order('created_at'),
  ]);
  const failed = [logs, photos].find((r) => r.error);
  if (failed) throw new Error(`Could not load the project: ${failed.error.message}`);
  return { logs: logs.data, photos: photos.data };
}

/**
 * Builds the archive and returns it as a Blob (application/zip).
 * `progress(text)` is told what is happening, for the button.
 */
export async function buildArchive({
  db, project, tasks, payments, contractors, units, siteCosts, rentals, materials, sitePayments, work,
  delays, events, variations, contracts, progress, cost, finance, usdRate, reportHtml, XLSX, moneyIn = [], onProgress = () => {},
}) {
  const today = new Date().toLocaleDateString('en-CA');
  const JSZip = await loadJsZip();
  const zip = new JSZip();

  onProgress('Collecting the records…');
  const { logs, photos } = await fetchRest(db, project.id);

  // ---- Photos: full size and thumbnail, through their signed links ----
  const logDate = new Map(logs.map((l) => [l.id, l.log_date]));
  const delayById = new Map(delays.map((d) => [d.id, d]));
  const missing = [];
  const photoRows = [];
  if (photos.length) {
    onProgress(`Photos 0 / ${photos.length}`);
    const paths = photos.flatMap((ph) => [ph.path, ph.thumb_path]);
    const urls = await signedUrls(db, paths, 'GET');
    await inBatches(photos, 6, async (ph, i) => {
      const full = `photos/${ph.id}.jpg`;
      const thumb = `photos/${ph.id}_t.jpg`;
      try {
        const [a, b] = await Promise.all([fetch(urls[i * 2]), fetch(urls[i * 2 + 1])]);
        if (!a.ok) throw new Error(String(a.status));
        zip.file(full, await a.arrayBuffer());
        zip.file(thumb, b.ok ? await b.arrayBuffer() : await (await fetch(urls[i * 2])).arrayBuffer());
        photoRows[i] = {
          id: ph.id,
          log_id: ph.daily_log_id,
          delay_id: ph.delay_id,
          date: ph.daily_log_id ? logDate.get(ph.daily_log_id)
            : delayById.get(ph.delay_id) ? delayStart(delayById.get(ph.delay_id)) : ph.created_at.slice(0, 10),
          caption: ph.caption ?? '',
          full,
          thumb,
        };
      } catch {
        missing.push(ph.path);
      }
    }, (done, total) => onProgress(`Photos ${done} / ${total}`));
  }

  // ---- Contracts and acceptance acts ----
  const contractorName = new Map(contractors.map((c) => [c.id, c.name]));
  const docRows = [];
  if (contracts.length) {
    onProgress(`Documents 0 / ${contracts.length}`);
    const urls = await signedUrls(db, contracts.map((c) => c.path), 'GET');
    const used = new Set();
    await inBatches(contracts, 4, async (c, i) => {
      const folder = fileSafe(contractorName.get(c.contractor_id) || 'Contractor');
      let name = `documents/${folder}/${fileSafe([c.signed_on, c.title].filter(Boolean).join(' '))}.pdf`;
      if (used.has(name)) name = name.replace(/\.pdf$/, ` (${c.id.slice(0, 6)}).pdf`);
      used.add(name);
      try {
        const res = await fetch(urls[i]);
        if (!res.ok) throw new Error(String(res.status));
        zip.file(name, await res.arrayBuffer());
        docRows.push({ ...c, file: name });
      } catch {
        missing.push(c.file_name || c.title);
        docRows.push({ ...c, file: null });
      }
    }, (done, total) => onProgress(`Documents ${done} / ${total}`));
  }

  onProgress('Writing the archive…');
  const flatLabel = (id) => {
    const u = units.find((x) => x.id === id);
    return u ? [u.block, u.flat_number].filter(Boolean).join(' · ') : '';
  };
  const trades = Object.fromEntries(MANPOWER_TRADES.map((t) => [t.key, t.label]));

  // Everything the archive page shows, as plain data. Paths into R2 and
  // anything else that only works inside the app are left out.
  const data = {
    generatedOn: today,
    project: {
      name: project.name, name_ka: project.name_ka, location: project.location, location_ka: project.location_ka,
      client_name: project.client_name, client_name_ka: project.client_name_ka, currency: project.currency || 'USD',
      start_date: project.start_date, end_date: project.end_date, has_rooms: Boolean(project.has_rooms),
      income_from: project.income_from ?? null, retention_pct: Number(project.retention_pct) || 0,
      closed: project.closed_how ? { how: project.closed_how, ...CLOSED_HOW[project.closed_how], on: project.closed_on, note: project.closed_note } : null,
    },
    usdRate,
    KA,
    trades,
    progress: { actual: progress.actualPct, planned: progress.plannedPct, count: progress.count },
    cost,
    finance: finance?.source && finance.income > 0 && project.finance_in_report !== false ? {
      source: finance.source, income: finance.income, cost: finance.cost, profit: finance.profit,
      budget: finance.budget, variations: finance.variations, siteSoFar: finance.siteSoFar, unbudgeted: finance.unbudgeted,
    } : null,
    // Money that came in: income (employer, buyers) and funding (loans, own money, partners).
    moneyIn: moneyIn.map((x) => ({
      kind: x.kind, date: x.received_on, amount: Number(x.amount), from: x.from_name, certificate_no: x.certificate_no,
      flat: x.flat_id ? flatLabel(x.flat_id) : '', interest_pct: x.interest_pct, note: x.note,
    })),
    contractors: contractors.map((c) => ({
      id: c.id, name: c.name, name_ka: c.name_ka, trade: c.trade, contact_person: c.contact_person, phone: c.phone, email: c.email,
    })),
    tasks: tasks.map((t) => ({
      id: t.id, name: t.name, name_ka: t.name_ka, contractor_id: t.contractor_id,
      planned_start: t.planned_start, planned_finish: t.planned_finish,
      baseline_start: t.baseline_start, baseline_finish: t.baseline_finish,
      done: t.done, done_at: t.done_at, progress_pct: Number(t.progress_pct) || 0,
      quantity: t.quantity, unit: t.unit, rate: t.rate, budget: Number(t.budget) || 0,
      material_budget: Number(t.material_budget) || 0, employer_price: Number(t.employer_price) || 0,
      extension_days: Number(t.extension_days) || 0, state: taskState(t, today).key,
    })),
    payments: payments.map((p) => ({ id: p.id, task_id: p.task_id, paid_on: p.paid_on, amount: Number(p.amount), retention: Number(p.retention) || 0, note: p.note })),
    materials: materials.map((m) => ({
      id: m.id, task_id: m.task_id, kind: m.kind ?? 'material', bought_on: m.bought_on, item: m.item, item_ka: m.item_ka,
      quantity: m.quantity, unit: m.unit, unit_price: m.unit_price, amount: Number(m.amount),
      supplier: m.supplier, paid_on: m.paid_on, due_on: m.due_on, note: m.note,
    })),
    rentals: rentals.map((r) => ({
      id: r.id, equipment: r.equipment, equipment_ka: r.equipment_ka, supplier: r.supplier, start_date: r.start_date,
      days: r.days, daily_rate: Number(r.daily_rate), total: rentalTotal(r), note: r.note,
    })),
    sitePayments: sitePayments.map((p) => ({ id: p.id, kind: p.kind, month: p.month, rental_id: p.rental_id, amount: Number(p.amount), paid_on: p.paid_on, note: p.note })),
    siteCosts: siteCosts.filter((e) => e.kind === 'labour' || e.kind === 'guard').map((e) => ({ kind: e.kind, date: e.date, amount: e.amount })),
    logs: logs.map((l) => ({
      id: l.id, date: l.log_date, weather: l.weather, notes: l.notes, notes_en: l.notes_en,
      crew: (l.crew ?? []).filter((c) => Number(c.workers) > 0),
    })),
    work: work.map((w) => ({
      id: w.id, date: w.work_date, flat: flatLabel(w.flat_id), flat_id: w.flat_id, task_id: w.task_id ?? null, by_day_workers: Boolean(w.by_day_workers),
      contractor_id: w.contractor_id, work: w.work, work_en: w.work_en, quantity: w.quantity, unit: w.unit,
    })),
    delays: delays.map((d) => ({
      id: d.id, cause: d.delay_cause, start: delayStart(d), end: delayIsOngoing(d) ? null : delayEnd(d, today),
      days: delayDaysLost(d, today), ongoing: delayIsOngoing(d), contractor_id: causeOf(d),
      flat: d.flat_id ? flatLabel(d.flat_id) : '', description: d.description, description_en: d.description_en,
      tasks: (d.impacts ?? []).map((i) => i.task_id),
    })),
    events: events.map((e) => ({
      id: e.id, date: e.event_date, kind: e.kind, severity: e.severity, title: e.title,
      description: e.description, description_en: e.description_en, contractor_id: e.contractor_id, action: e.action, closed: e.closed,
    })),
    variations: variations.map((v) => ({
      id: v.id, ref: v.ref, title: v.title, description: v.description, description_en: v.description_en,
      contractor_id: v.contractor_id, instructed_on: v.instructed_on, status: v.status, amount: Number(v.amount) || 0,
      days_claimed: v.days_claimed, decided_on: v.decided_on,
    })),
    units: units.map((u) => ({
      id: u.id, block: u.block, floor: u.floor, flat_number: u.flat_number, unit_type: u.unit_type, area_m2: u.area_m2,
      status: u.status, notes: u.notes, sale_status: u.sale_status, asking_price: u.asking_price, sale_price: u.sale_price,
      buyer: u.buyer, sold_on: u.sold_on,
    })),
    documents: docRows.map((c) => ({
      id: c.id, contractor_id: c.contractor_id, contract_id: c.contract_id, title: c.title, act_no: c.act_no,
      amount: c.amount, signed_on: c.signed_on, file: c.file,
    })),
    photos: photoRows.filter(Boolean),
    missing,
  };

  zip.file('index.html', archiveHtml(data));
  if (reportHtml) zip.file('report.html', reportHtml);
  zip.file('data/backup.json', JSON.stringify(data, null, 1));
  if (XLSX) zip.file('data/project.xlsx', workbook(XLSX, data));

  onProgress('Packing the ZIP…');
  // Photos and PDFs are compressed already; storing them saves minutes.
  return zip.generateAsync({ type: 'blob', compression: 'STORE' });
}

/** Every table as a sheet, with readable headings. */
function workbook(XLSX, d) {
  const book = XLSX.utils.book_new();
  const who = (id) => d.contractors.find((c) => c.id === id)?.name ?? '';
  const item = (id) => d.tasks.find((t) => t.id === id)?.name ?? '';
  const sheet = (name, rows) => {
    if (!rows.length) return;
    XLSX.utils.book_append_sheet(book, XLSX.utils.json_to_sheet(rows), name);
  };
  sheet('Items', d.tasks.map((t) => ({
    Item: t.name, 'Item (KA)': t.name_ka, Contractor: who(t.contractor_id), 'Planned start': t.planned_start,
    'Planned finish': t.planned_finish, 'Baseline start': t.baseline_start, 'Baseline finish': t.baseline_finish,
    'Done %': t.progress_pct, 'Done on': t.done_at, Quantity: t.quantity, Unit: t.unit, Rate: t.rate,
    'Contract budget': t.budget, 'Materials budget': t.material_budget, "Employer's price": t.employer_price || null,
  })));
  sheet('Contract payments', d.payments.map((p) => ({
    Date: p.paid_on, Item: item(p.task_id), Contractor: who(d.tasks.find((t) => t.id === p.task_id)?.contractor_id),
    Paid: p.amount, Retention: p.retention, Note: p.note,
  })));
  sheet('Purchases', d.materials.map((m) => ({
    Date: m.bought_on, Type: m.kind, Item: m.item, 'Item (KA)': m.item_ka, 'For job': item(m.task_id), Quantity: m.quantity,
    Unit: m.unit, 'Unit price': m.unit_price, Amount: m.amount, Supplier: m.supplier, 'Paid on': m.paid_on, Due: m.due_on,
  })));
  sheet('Rentals', d.rentals.map((r) => ({
    Equipment: r.equipment, Supplier: r.supplier, Start: r.start_date, Days: r.days, 'Daily rate': r.daily_rate, Total: r.total,
  })));
  sheet('Site payments', d.sitePayments.map((p) => ({
    'Paid on': p.paid_on, For: p.kind, Month: p.month, Rental: d.rentals.find((r) => r.id === p.rental_id)?.equipment ?? '', Amount: p.amount, Note: p.note,
  })));
  sheet('Daily logs', d.logs.map((l) => ({
    Date: l.date, Weather: l.weather, Workers: l.crew.reduce((s, c) => s + Number(c.workers), 0), Notes: l.notes, 'Notes (EN)': l.notes_en,
  })));
  sheet('Crew', d.logs.flatMap((l) => l.crew.map((c) => ({
    Date: l.date, Contractor: who(c.contractor_id) || 'Hired by the client', Trade: d.trades[c.trade] ?? c.trade, Workers: c.workers,
  }))));
  sheet('Work done', d.work.map((w) => ({
    Date: w.date, Where: w.flat || item(w.task_id) || 'Site', Work: w.work, 'Work (EN)': w.work_en, 'Done by': w.by_day_workers ? 'Daily workers' : who(w.contractor_id), Quantity: w.quantity, Unit: w.unit,
  })));
  sheet('Delays', d.delays.map((x) => ({
    Start: x.start, End: x.end, Days: x.days, Cause: x.cause, 'Caused by': who(x.contractor_id), Room: x.flat,
    Description: x.description, 'Description (EN)': x.description_en, 'Held up': x.tasks.map(item).join('; '),
  })));
  sheet('Variations', d.variations.map((v) => ({
    Ref: v.ref, Instructed: v.instructed_on, Title: v.title, Contractor: who(v.contractor_id), Status: v.status,
    Amount: v.amount, 'Days claimed': v.days_claimed, Decided: v.decided_on,
  })));
  sheet('Safety', d.events.map((e) => ({
    Date: e.date, Kind: e.kind, Severity: e.severity, Title: e.title, Contractor: who(e.contractor_id), Action: e.action, Closed: e.closed ? 'yes' : 'no',
  })));
  sheet('Rooms', d.units.map((u) => ({
    Block: u.block, Floor: u.floor, Room: u.flat_number, Type: u.unit_type, 'Area m²': u.area_m2, Status: u.status,
    Sale: u.sale_status, 'Asking price': u.asking_price, 'Sale price': u.sale_price, Buyer: u.buyer, 'Sold on': u.sold_on,
  })));
  sheet('Money in', (d.moneyIn ?? []).map((x) => ({
    Date: x.date, What: x.kind, From: x.from, 'Certificate №': x.certificate_no, Room: x.flat, 'Interest % a year': x.interest_pct,
    Amount: x.amount, Note: x.note,
  })));
  sheet('Contractors', d.contractors.map((c) => ({
    Name: c.name, 'Name (KA)': c.name_ka, Trade: c.trade, Contact: c.contact_person, Phone: c.phone, Email: c.email,
  })));
  sheet('Contracts & acts', d.documents.map((c) => ({
    Contractor: who(c.contractor_id), Document: c.contract_id ? 'Acceptance act' : 'Contract', Title: c.title, 'Act №': c.act_no,
    Date: c.signed_on, Amount: c.amount, File: c.file,
  })));
  return XLSX.write(book, { bookType: 'xlsx', type: 'array' });
}

// =============================================================
// index.html - the page, its data and the script that draws it
// =============================================================
function archiveHtml(data) {
  const json = JSON.stringify(data).replace(/</g, '\\u003c');
  const p = data.project;
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  return `<!doctype html>
<html lang="ka">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(p.name_ka || p.name)} - არქივი · Archive</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Noto+Sans+Georgian:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>${ARCHIVE_CSS}</style>
</head>
<body>
<header class="top">
  <div class="top-in">
    <div class="who">
      <p class="eyebrow">პროექტის არქივი · Project archive</p>
      <h1 id="title"></h1>
      <p id="sub" class="muted"></p>
    </div>
    <div id="cur" class="cur" hidden><button data-cur="USD">$</button><button data-cur="GEL">₾</button></div>
  </div>
  <nav id="tabs" class="tabs"></nav>
</header>
<main id="view"></main>
<dialog id="pop"><button class="x" aria-label="Close">&times;</button><div id="pop-body"></div></dialog>
<dialog id="lightbox"><button class="x" aria-label="Close">&times;</button><button class="lb-prev" aria-label="Previous">‹</button>
  <img id="lb-img" alt=""><button class="lb-next" aria-label="Next">›</button><p id="lb-cap"></p></dialog>
<script>(${archiveViewer.toString()})(${json});</script>
</body>
</html>`;
}

const ARCHIVE_CSS = `
:root { --ink: #0f172a; --muted: #64748b; --line: #e2e8f0; --soft: #f8fafc; --brand: #2563eb; --ok: #059669; --bad: #be123c; --warn: #b45309; }
* { box-sizing: border-box; }
body { margin: 0; background: #eef2f6; color: var(--ink); font: 14px/1.5 Inter, 'Noto Sans Georgian', system-ui, sans-serif; }
h1 { margin: 2px 0 0; font-size: 22px; line-height: 1.25; }
h2 { margin: 28px 0 10px; font-size: 17px; }
h3 { margin: 18px 0 8px; font-size: 14px; }
em { font-style: normal; color: var(--muted); font-weight: 400; margin-left: 4px; font-size: 0.92em; }
.muted { color: var(--muted); margin: 2px 0 0; }
.eyebrow { margin: 0; font-size: 11px; letter-spacing: .06em; text-transform: uppercase; color: var(--muted); }
.top { position: sticky; top: 0; z-index: 5; background: #fff; border-bottom: 1px solid var(--line); }
.top-in { max-width: 1180px; margin: 0 auto; padding: 14px 16px 8px; display: flex; gap: 12px; align-items: flex-start; justify-content: space-between; }
.tabs { max-width: 1180px; margin: 0 auto; padding: 0 12px 8px; display: flex; gap: 4px; overflow-x: auto; }
.tabs button { flex: none; padding: 6px 12px; border: 1px solid var(--line); border-radius: 999px; background: #fff; font: inherit; font-size: 13px; color: #334155; cursor: pointer; white-space: nowrap; }
.tabs button.on { background: var(--ink); border-color: var(--ink); color: #fff; }
.tabs button.on em { color: #cbd5e1; }
.cur { display: inline-flex; border: 1px solid #cbd5e1; border-radius: 999px; overflow: hidden; flex: none; }
.cur button { padding: 4px 12px; border: 0; background: #fff; font: inherit; font-weight: 600; color: var(--muted); cursor: pointer; }
.cur button.on { background: var(--ink); color: #fff; }
main { max-width: 1180px; margin: 0 auto; padding: 8px 16px 60px; }
.panel { background: #fff; border: 1px solid var(--line); border-radius: 10px; padding: 16px; margin-top: 14px; }
.tiles { display: grid; grid-template-columns: repeat(auto-fill, minmax(190px, 1fr)); gap: 10px; margin-top: 14px; }
.tile { background: #fff; border: 1px solid var(--line); border-left: 3px solid var(--brand); border-radius: 8px; padding: 10px 12px; }
.tile span { display: block; font-size: 12px; color: var(--muted); }
.tile b { display: block; font-size: 19px; margin-top: 2px; }
.tile small { display: block; color: var(--muted); font-size: 12px; margin-top: 2px; }
.tile.bad { border-left-color: var(--bad); } .tile.bad b { color: var(--bad); }
.tile.ok { border-left-color: var(--ok); }
table { width: 100%; border-collapse: collapse; font-size: 13px; }
th { text-align: left; font-weight: 600; font-size: 12px; color: #475569; padding: 6px 8px; border-bottom: 1px solid var(--line); background: var(--soft); vertical-align: bottom; }
th em { display: block; margin: 0; font-size: 11px; }
td { padding: 6px 8px; border-bottom: 1px solid #f1f5f9; vertical-align: top; }
tfoot td { font-weight: 600; background: var(--soft); }
.num { text-align: right; white-space: nowrap; }
.scroll { overflow-x: auto; }
tr.click { cursor: pointer; } tr.click:hover td { background: #eff6ff; }
.neg { color: var(--bad); font-weight: 600; }
.chip { display: inline-block; padding: 1px 8px; border-radius: 999px; font-size: 11px; font-weight: 600; background: #f1f5f9; color: #475569; white-space: nowrap; }
.chip.ok { background: #dcfce7; color: #15803d; } .chip.bad { background: #ffe4e6; color: var(--bad); }
.chip.info { background: #dbeafe; color: #1d4ed8; } .chip.warn { background: #fef3c7; color: var(--warn); }
.filters { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-top: 14px; }
.filters select, .filters input { font: inherit; padding: 6px 10px; border: 1px solid #cbd5e1; border-radius: 8px; background: #fff; }
.filters input { flex: 1; min-width: 180px; }
.month { margin-top: 26px; font-size: 16px; }
.day { background: #fff; border: 1px solid var(--line); border-radius: 10px; padding: 12px 14px; margin-top: 10px; }
.day-h { display: flex; flex-wrap: wrap; gap: 4px 12px; align-items: baseline; }
.day-h b { font-size: 15px; }
.day-h .muted { font-size: 12px; }
.day ul { margin: 6px 0 0; padding-left: 0; list-style: none; }
.day li { padding: 3px 0 3px 26px; position: relative; }
.day li::before { content: attr(data-i); position: absolute; left: 0; top: 2px; width: 20px; text-align: center; }
.thumbs { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
.thumbs img { width: 96px; height: 72px; object-fit: cover; border-radius: 6px; cursor: zoom-in; background: var(--soft); }
.gallery { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 8px; }
.gallery img { width: 100%; aspect-ratio: 4/3; object-fit: cover; border-radius: 6px; cursor: zoom-in; background: var(--soft); }
.gantt { position: relative; }
.g-row { display: grid; grid-template-columns: minmax(160px, 30%) 1fr; gap: 10px; align-items: center; padding: 4px 0; border-bottom: 1px solid #f1f5f9; cursor: pointer; }
.g-row:hover { background: #eff6ff; }
.g-name { font-size: 12.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.g-track { position: relative; height: 22px; }
.g-bar { position: absolute; height: 8px; border-radius: 4px; }
.g-plan { top: 2px; background: #cbd5e1; }
.g-base { top: 2px; height: 8px; border: 1px dashed #64748b; background: transparent; }
.g-act { top: 12px; background: var(--ok); }
.g-act.late { background: var(--bad); } .g-act.open { background: #60a5fa; }
.g-today { position: absolute; top: 0; bottom: 0; width: 2px; background: #f59e0b; }
.legend { display: flex; flex-wrap: wrap; gap: 14px; font-size: 12px; color: var(--muted); margin: 6px 0 4px; }
.legend i { display: inline-block; width: 18px; height: 8px; border-radius: 3px; margin-right: 5px; vertical-align: middle; }
.cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 10px; margin-top: 14px; }
.card { background: #fff; border: 1px solid var(--line); border-radius: 10px; padding: 12px 14px; cursor: pointer; }
.card:hover { border-color: var(--brand); }
.card p { margin: 3px 0 0; font-size: 12.5px; color: #475569; }
dialog { border: 1px solid var(--line); border-radius: 10px; padding: 0; width: min(60rem, calc(100vw - 2rem)); max-height: calc(100vh - 3rem); box-shadow: 0 25px 50px -12px rgba(15,23,42,.35); }
dialog::backdrop { background: rgba(15,23,42,.5); }
#pop-body { padding: 18px 20px 22px; overflow: auto; }
#pop-body h2 { margin-top: 0; margin-right: 36px; }
.x { position: absolute; top: 10px; right: 12px; width: 32px; height: 32px; border: 0; border-radius: 6px; background: #fff; font-size: 24px; line-height: 1; color: var(--muted); cursor: pointer; z-index: 2; }
.x:hover { background: #f1f5f9; }
#lightbox { background: #0b1220; width: min(96vw, 1400px); border: 0; text-align: center; }
#lb-img { max-width: 100%; max-height: calc(100vh - 7rem); display: block; margin: 0 auto; }
#lb-cap { color: #cbd5e1; margin: 8px 12px 12px; font-size: 13px; }
.lb-prev, .lb-next { position: absolute; top: 45%; border: 0; background: rgba(255,255,255,.15); color: #fff; font-size: 36px; width: 44px; height: 64px; border-radius: 8px; cursor: pointer; }
.lb-prev { left: 8px; } .lb-next { right: 8px; }
.facts { display: grid; grid-template-columns: repeat(auto-fill, minmax(170px, 1fr)); gap: 8px; margin: 8px 0; }
.facts div { border: 1px solid var(--line); border-radius: 8px; padding: 8px 10px; background: var(--soft); }
.facts span { display: block; font-size: 11px; color: var(--muted); }
.facts b { font-size: 13.5px; }
a { color: var(--brand); }
.empty { color: var(--muted); padding: 10px 0; }
.links { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 10px; }
.links a { padding: 6px 12px; border: 1px solid var(--line); border-radius: 8px; background: #fff; text-decoration: none; }
@media (max-width: 640px) { .g-row { grid-template-columns: 1fr; } h1 { font-size: 19px; } }
@media print { .top { position: static; } .tabs, .cur, .filters { display: none; } body { background: #fff; } }
`;

/**
 * The archive page's own script, written out into index.html as source
 * (archiveViewer.toString()), so it can use nothing from outside itself.
 * D is the archive's data (see buildArchive).
 */
function archiveViewer(D) {
  const $ = (s, r = document) => r.querySelector(s);
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const L = (ka, en) => `${esc(ka)}<em>${esc(en)}</em>`;
  const ka = (en) => D.KA[en] ?? en;
  const bi = (en) => (en ? (D.KA[en] ? L(D.KA[en], en) : esc(en)) : '');
  const nameBi = (en, k) => (k && en && k !== en ? `${esc(k)}<em>${esc(en)}</em>` : esc(k || en || ''));
  const d = (iso) => (iso ? String(iso).slice(0, 10).split('-').reverse().join('.') : '-');
  const MONTHS_KA = ['იანვარი', 'თებერვალი', 'მარტი', 'აპრილი', 'მაისი', 'ივნისი', 'ივლისი', 'აგვისტო', 'სექტემბერი', 'ოქტომბერი', 'ნოემბერი', 'დეკემბერი'];
  const MONTHS_EN = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const monthName = (ym) => L(`${MONTHS_KA[Number(ym.slice(5, 7)) - 1]} ${ym.slice(0, 4)}`, `${MONTHS_EN[Number(ym.slice(5, 7)) - 1]} ${ym.slice(0, 4)}`);
  const WEEK_KA = ['კვირა', 'ორშაბათი', 'სამშაბათი', 'ოთხშაბათი', 'ხუთშაბათი', 'პარასკევი', 'შაბათი'];
  const WEEK_EN = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const sum = (list, f) => list.reduce((s, x) => s + (Number(typeof f === 'function' ? f(x) : x[f]) || 0), 0);
  const P = D.project;
  const own = P.currency;

  // ---- money, in the currency picked on the $ / ₾ switch ----
  let shown = own;
  const fmt = new Map();
  const money = (n) => {
    const value = shown === own || !D.usdRate ? Number(n) : own === 'USD' ? n * D.usdRate.rate : n / D.usdRate.rate;
    if (!fmt.has(shown)) fmt.set(shown, new Intl.NumberFormat('en-US', { style: 'currency', currency: shown, currencyDisplay: 'narrowSymbol', minimumFractionDigits: 2, maximumFractionDigits: 2 }));
    return fmt.get(shown).formatToParts(value || 0).map((x) => (x.type === 'group' ? ' ' : x.value)).join('');
  };
  const qty = (q, unit) => (q == null ? '' : `${new Intl.NumberFormat('en-GB', { maximumFractionDigits: 3 }).format(q)}${unit ? ` ${esc(unit)}` : ''}`);

  // ---- lookups ----
  const byId = (list) => new Map(list.map((x) => [x.id, x]));
  const contractors = byId(D.contractors);
  const tasks = byId(D.tasks);
  const who = (id) => {
    const c = contractors.get(id);
    return c ? nameBi(c.name, c.name_ka) : '';
  };
  const whoText = (id) => contractors.get(id)?.name ?? '';
  const taskName = (id) => {
    const t = tasks.get(id);
    return t ? nameBi(t.name, t.name_ka) : '';
  };
  const taskOf = (paymentOrMaterial) => tasks.get(paymentOrMaterial.task_id);
  const photosOfLog = new Map();
  const photosOfDelay = new Map();
  for (const ph of D.photos) {
    if (ph.log_id) (photosOfLog.get(ph.log_id) ?? photosOfLog.set(ph.log_id, []).get(ph.log_id)).push(ph);
    if (ph.delay_id) (photosOfDelay.get(ph.delay_id) ?? photosOfDelay.set(ph.delay_id, []).get(ph.delay_id)).push(ph);
  }
  const STATE = {
    done: ['დასრულდა', 'Done', 'ok'], overdue: ['ვადაგადაცილება', 'Overdue', 'bad'],
    active: ['მიმდინარე', 'In progress', 'info'], upcoming: ['დაგეგმილი', 'Upcoming', ''],
    closed: ['არ შესრულდა - პროექტი დაიხურა', 'Not done - project closed', ''],
  };
  const chip = (ka_, en, tone = '') => `<span class="chip ${tone}">${esc(ka_)} · ${esc(en)}</span>`;
  const stateChip = (t) => chip(...(STATE[t.state] ?? STATE.upcoming));
  const VAR = { instructed: ['დავალებული', 'Instructed', 'warn'], priced: ['შეფასებული', 'Priced', 'info'], approved: ['დამტკიცებული', 'Approved', 'ok'], rejected: ['უარყოფილი', 'Rejected', ''] };
  const KIND = { material: ['მასალა', 'Material'], tool: ['ხელსაწყო / ინვენტარი', 'Tool / equipment'], other: ['სხვა', 'Other'] };
  const SITE = { labour: ['დღიური მუშები', 'Daily workers'], guard: ['დარაჯები', 'Guards'], rental: ['ტექნიკის ქირა', 'Equipment hire'] };
  const MONEY_IN = {
    employer: ['დამკვეთის გადახდა', 'Employer payment'], buyer: ['მყიდველის გადახდა', 'Buyer payment'],
    loan: ['სესხი', 'Loan draw'], own: ['დამკვეთის საკუთარი თანხა', "Client's own money"], partner: ['პარტნიორი', 'Partner'],
  };
  const tradeName = (key) => bi(D.trades[key] ?? key);
  const table = (heads, rows, foot = '') => (rows.length ? `<div class="scroll"><table>
    <thead><tr>${heads.map(([k, e, cls = '']) => `<th class="${cls}">${L(k, e)}</th>`).join('')}</tr></thead>
    <tbody>${rows.join('')}</tbody>${foot ? `<tfoot>${foot}</tfoot>` : ''}</table></div>` : `<p class="empty">${L('ჩანაწერი არ არის', 'Nothing recorded')}</p>`);
  const tile = (k, e, value, sub = '', tone = '') => `<div class="tile ${tone}"><span>${L(k, e)}</span><b>${value}</b>${sub ? `<small>${sub}</small>` : ''}</div>`;
  const thumbs = (list) => (list?.length ? `<div class="thumbs">${list.map((ph) => `<img loading="lazy" src="${esc(ph.thumb)}" data-photo="${esc(ph.id)}" alt="">`).join('')}</div>` : '');

  // ---- header ----
  $('#title').innerHTML = nameBi(P.name, P.name_ka);
  $('#sub').innerHTML = [
    nameBi(P.location, P.location_ka),
    P.client_name || P.client_name_ka ? `${L('დამკვეთი', 'Client')}: ${nameBi(P.client_name, P.client_name_ka)}` : '',
    `${L('შექმნილია', 'Made')} ${d(D.generatedOn)}`,
  ].filter(Boolean).join(' · ');
  document.title = `${P.name_ka || P.name} - არქივი · Archive`;

  // =============================================================
  // Views
  // =============================================================
  const views = {};

  // ---- Overview ----
  views.overview = () => {
    const c = D.cost;
    const f = D.finance;
    const lastLog = D.logs.at(-1)?.date;
    const doneItems = D.tasks.filter((t) => t.state === 'done').length;
    const paidAll = sum(D.payments, 'amount') + sum(D.sitePayments, 'amount') + sum(D.materials.filter((m) => m.paid_on), 'amount');
    return `
      <div class="tiles">
        ${tile('შესრულებული', 'Work complete', `${D.progress.actual}%`, `${doneItems} / ${D.tasks.length} ${L('სამუშაო', 'items done')}`)}
        ${P.closed ? tile('პროექტი დაიხურა', 'Project ended', `${esc(P.closed.ka)}`, `${esc(P.closed.en)}${P.closed.on ? ` · ${d(P.closed.on)}` : ''}${P.closed.note ? `<br>${esc(P.closed.note)}` : ''}`, P.closed.how === 'completed' ? 'ok' : '') : ''}
        ${tile('ვადები', 'Dates', `${d(P.start_date)} → ${d(P.end_date)}`, lastLog ? `${L('ბოლო ჩანაწერი', 'last log')} ${d(lastLog)}` : '')}
        ${tile('ბიუჯეტი', 'Budget', money(c.budget), L('კონტრაქტები + მასალა', 'contracts + materials'))}
        ${tile('დახარჯული', 'Spent', money(c.spent), `${L('გადახდილი', 'paid out')} ${money(paidAll)}`, c.spent > c.budget && c.budget ? 'bad' : '')}
        ${f ? tile(f.profit < 0 ? 'ზარალი' : 'მოგება', f.profit < 0 ? 'Loss' : 'Profit', money(f.profit), `${L('შემოსავალი', 'income')} ${money(f.income)} − ${L('ხარჯი', 'cost')} ${money(f.cost)}`, f.profit < 0 ? 'bad' : 'ok') : ''}
        ${tile('დღიური ჩანაწერები', 'Daily logs', String(D.logs.length), `${D.photos.length} ${L('ფოტო', 'photos')}`)}
        ${tile('კონტრაქტორები', 'Contractors', String(D.contractors.length), `${D.documents.filter((x) => !x.contract_id).length} ${L('ხელშეკრულება', 'contracts')}`)}
        ${tile('შეფერხებები', 'Delays', String(D.delays.length), `${sum(D.delays, 'days')} ${L('დღე', 'days lost')}`, D.delays.length ? 'bad' : '')}
      </div>
      <div class="panel">
        <h3 style="margin-top:0">${L('არქივში', 'In this archive')}</h3>
        <p class="muted">${L(
    'ეს ფაილი პროექტის სრული ისტორიაა: ყოველი დღე, გადახდა, სამუშაო და ფოტო. ზედა ჩანართებით გადადით განყოფილებებზე.',
    'This file is the full history of the project: every day, payment, job and photo. Use the tabs above to move between parts.',
  )}</p>
        <div class="links">
          <a href="report.html" target="_blank">${L('პროექტის ანგარიში', 'Project report')}</a>
          <a href="data/project.xlsx">${L('ყველა მონაცემი (Excel)', 'All data (Excel)')}</a>
          <a href="data/backup.json">${L('სარეზერვო ასლი (JSON)', 'Backup (JSON)')}</a>
        </div>
        ${D.missing.length ? `<p class="muted" style="margin-top:10px">${L(`${D.missing.length} ფაილის ჩამოტვირთვა ვერ მოხერხდა`, `${D.missing.length} file(s) could not be downloaded when the archive was made`)}</p>` : ''}
      </div>`;
  };

  // ---- Journal: every day of the project, in order ----
  const journalDays = () => {
    const days = new Map();
    const day = (date) => {
      const key = String(date).slice(0, 10);
      if (!days.has(key)) days.set(key, { date: key, log: null, entries: [], photos: [], contractors: new Set() });
      return days.get(key);
    };
    const add = (date, icon, html, text, contractorId = null) => {
      if (!date) return;
      const dd = day(date);
      dd.entries.push({ icon, html, text: text.toLowerCase(), who: contractorId });
      if (contractorId) dd.contractors.add(contractorId);
    };
    for (const l of D.logs) {
      const dd = day(l.date);
      dd.log = l;
      dd.photos.push(...(photosOfLog.get(l.id) ?? []));
      l.crew.forEach((c) => c.contractor_id && dd.contractors.add(c.contractor_id));
    }
    for (const w of D.work) {
      const where = w.flat ? esc(w.flat) : taskName(w.task_id);
      add(w.date, w.by_day_workers ? '👷' : '🔨', `${where ? `<b>${where}</b> - ` : ''}${nameBi(w.work_en, w.work)}${w.quantity != null ? ` · ${qty(w.quantity, w.unit)}` : ` · ${L('მიმდინარეობს', 'in progress')}`}${w.contractor_id ? ` · ${who(w.contractor_id)}` : w.by_day_workers ? ` · ${L('დღიური მუშები', 'Daily workers')}` : ''}`,
        `${w.flat} ${w.work} ${w.work_en} ${whoText(w.contractor_id)}`, w.contractor_id);
    }
    for (const p of D.payments) {
      const t = taskOf(p);
      add(p.paid_on, '💵', `${L('გადახდა', 'Payment')} <b>${money(p.amount)}</b>${p.retention ? ` + ${money(p.retention)} ${L('გარანტია', 'retention')}` : ''} - ${taskName(p.task_id)}${t?.contractor_id ? ` · ${who(t.contractor_id)}` : ''}${p.note ? ` · ${esc(p.note)}` : ''}`,
        `payment ${t?.name ?? ''} ${whoText(t?.contractor_id)} ${p.note ?? ''}`, t?.contractor_id);
    }
    for (const p of D.sitePayments) {
      const r = D.rentals.find((x) => x.id === p.rental_id);
      add(p.paid_on, '💵', `${L('გადახდა', 'Payment')} <b>${money(p.amount)}</b> - ${L(...(SITE[p.kind] ?? [p.kind, p.kind]))}${p.month ? ` (${monthName(p.month.slice(0, 7))})` : ''}${r ? ` · ${nameBi(r.equipment, r.equipment_ka)}` : ''}`,
        `payment ${p.kind} ${r?.equipment ?? ''}`);
    }
    for (const m of D.materials) {
      const t = taskOf(m);
      add(m.bought_on, '🧱', `${L(...(KIND[m.kind] ?? KIND.material))}: <b>${nameBi(m.item, m.item_ka)}</b>${m.quantity != null ? ` ${qty(m.quantity, m.unit)}` : ''} - ${money(m.amount)}${m.supplier ? ` · ${esc(m.supplier)}` : ''}${t ? ` · ${taskName(t.id)}` : ''}${m.paid_on ? '' : ` · ${L('ნისიად', 'on credit')}`}`,
        `${m.item} ${m.item_ka ?? ''} ${m.supplier ?? ''}`, t?.contractor_id);
      if (m.paid_on && m.paid_on !== m.bought_on) add(m.paid_on, '💵', `${L('ნისიის გადახდა', 'Credit paid')} - ${nameBi(m.item, m.item_ka)} ${money(m.amount)}`, `credit ${m.item}`);
    }
    for (const r of D.rentals) {
      add(r.start_date, '🚜', `${L('ტექნიკა ქირით', 'Equipment hired')}: <b>${nameBi(r.equipment, r.equipment_ka)}</b> · ${r.days} ${L('დღე', 'days')} × ${money(r.daily_rate)} = ${money(r.total)}${r.supplier ? ` · ${esc(r.supplier)}` : ''}`,
        `${r.equipment} ${r.supplier ?? ''}`);
    }
    for (const x of D.delays) {
      const dd = day(x.start);
      dd.photos.push(...(photosOfDelay.get(x.id) ?? []));
      add(x.start, '⚠️', `${L('შეფერხება დაიწყო', 'Delay started')}: <b>${bi(x.cause)}</b>${x.flat ? ` · ${esc(x.flat)}` : ''}${x.contractor_id ? ` · ${who(x.contractor_id)}` : ''}${x.description || x.description_en ? ` - ${nameBi(x.description_en, x.description)}` : ''}${x.tasks.length ? ` · ${L('შეაფერხა', 'held up')}: ${x.tasks.map(taskName).join(', ')}` : ''}`,
        `delay ${x.cause} ${x.description ?? ''} ${x.description_en ?? ''} ${whoText(x.contractor_id)}`, x.contractor_id);
      if (x.end) add(x.end, '✅', `${L('შეფერხება დასრულდა', 'Delay over')}: ${bi(x.cause)} · ${x.days} ${L('დღე', 'days')}`, `delay over ${x.cause}`, x.contractor_id);
    }
    for (const v of D.variations) {
      add(v.instructed_on, '✏️', `${L('ცვლილება დაევალა', 'Variation instructed')}${v.ref ? ` ${esc(v.ref)}` : ''}: <b>${esc(v.title)}</b>${v.amount ? ` · ${money(v.amount)}` : ''}${v.contractor_id ? ` · ${who(v.contractor_id)}` : ''}`,
        `variation ${v.ref ?? ''} ${v.title}`, v.contractor_id);
      if (v.decided_on && (v.status === 'approved' || v.status === 'rejected')) {
        add(v.decided_on, v.status === 'approved' ? '✅' : '✖️', `${L(...(VAR[v.status] ?? VAR.approved).slice(0, 2))}: ${esc(v.title)}${v.amount ? ` · ${money(v.amount)}` : ''}${v.days_claimed ? ` · +${v.days_claimed} ${L('დღე', 'days')}` : ''}`,
          `variation ${v.title}`, v.contractor_id);
      }
    }
    for (const e of D.events) {
      add(e.date, e.kind === 'incident' ? '🚑' : '🦺', `${bi(e.kind === 'toolbox_talk' ? 'Toolbox talk' : e.kind === 'inspection' ? 'Inspection' : 'Incident')}${e.severity ? ` (${bi(e.severity === 'first_aid' ? 'First aid' : e.severity === 'lost_time' ? 'Lost time' : 'Reportable')})` : ''}: <b>${esc(e.title)}</b>${e.contractor_id ? ` · ${who(e.contractor_id)}` : ''}${e.action ? ` - ${esc(e.action)}` : ''}`,
        `${e.kind} ${e.title} ${e.action ?? ''}`, e.contractor_id);
    }
    for (const t of D.tasks) {
      if (t.done && t.done_at) add(t.done_at, '🏁', `${L('დასრულდა', 'Finished')}: <b>${taskName(t.id)}</b>${t.contractor_id ? ` · ${who(t.contractor_id)}` : ''}`, `finished ${t.name} ${t.name_ka ?? ''}`, t.contractor_id);
    }
    for (const doc of D.documents) {
      add(doc.signed_on, '📄', `${doc.contract_id ? L('მიღება-ჩაბარების აქტი', 'Acceptance act') : L('ხელშეკრულება', 'Contract')}: ${doc.file ? `<a href="${esc(doc.file)}" target="_blank">${esc(doc.title)}</a>` : esc(doc.title)}${doc.amount ? ` · ${money(doc.amount)}` : ''} · ${who(doc.contractor_id)}`,
        `${doc.title} ${whoText(doc.contractor_id)}`, doc.contractor_id);
    }
    return [...days.values()].sort((a, b) => a.date.localeCompare(b.date));
  };

  let journalFilter = { month: '', contractor: '', text: '' };
  views.journal = () => {
    const all = journalDays();
    const months = [...new Set(all.map((x) => x.date.slice(0, 7)))];
    return `
      <div class="filters">
        <select id="j-month"><option value="">${esc('ყველა თვე · All months')}</option>${months.map((m) => `<option value="${m}"${journalFilter.month === m ? ' selected' : ''}>${m}</option>`).join('')}</select>
        <select id="j-who"><option value="">${esc('ყველა კონტრაქტორი · All contractors')}</option>${D.contractors.map((c) => `<option value="${esc(c.id)}"${journalFilter.contractor === c.id ? ' selected' : ''}>${esc(c.name)}</option>`).join('')}</select>
        <input id="j-text" type="search" placeholder="ძებნა · Search" value="${esc(journalFilter.text)}">
      </div>
      <div id="j-list">${journalList(all)}</div>`;
  };
  const journalList = (all) => {
    const text = journalFilter.text.trim().toLowerCase();
    const days = all.filter((x) => (!journalFilter.month || x.date.startsWith(journalFilter.month))
      && (!journalFilter.contractor || x.contractors.has(journalFilter.contractor))
      && (!text || x.entries.some((e) => e.text.includes(text))
        || `${x.log?.notes ?? ''} ${x.log?.notes_en ?? ''} ${x.log?.weather ?? ''}`.toLowerCase().includes(text)));
    if (!days.length) return `<p class="empty">${L('ამ ფილტრით არაფერი მოიძებნა', 'Nothing matches these filters')}</p>`;
    let month = '';
    return days.map((x) => {
      const ym = x.date.slice(0, 7);
      const head = ym !== month ? `<h2 class="month">${monthName(ym)}</h2>` : '';
      month = ym;
      const wd = new Date(`${x.date}T00:00`).getDay();
      const l = x.log;
      const crew = l?.crew ?? [];
      const byWho = new Map();
      for (const c of crew) {
        const k = c.contractor_id ?? '';
        if (!byWho.has(k)) byWho.set(k, []);
        byWho.get(k).push(`${tradeName(c.trade)} ${c.workers}`);
      }
      const workers = sum(crew, 'workers');
      const wages = sum(D.siteCosts.filter((e) => e.date === x.date), 'amount');
      // Filtered to a contractor: only what was theirs that day.
      const entries = journalFilter.contractor ? x.entries.filter((e) => e.who === journalFilter.contractor) : x.entries;
      const crewShown = journalFilter.contractor ? [...byWho].filter(([id]) => id === journalFilter.contractor) : [...byWho];
      return `${head}
        <article class="day">
          <div class="day-h"><b>${d(x.date)}</b><span class="muted">${L(WEEK_KA[wd], WEEK_EN[wd])}</span>
            ${l?.weather ? `<span class="muted">${bi(l.weather)}</span>` : ''}
            ${workers ? `<span class="muted">${workers} ${L('მუშა', 'workers')}</span>` : ''}
            ${wages ? `<span class="muted">${L('დღიური ანაზღაურება', 'day wages')} ${money(wages)}</span>` : ''}</div>
          <ul>
            ${crewShown.map(([id, parts]) => `<li data-i="👷">${id ? who(id) : L('დამკვეთის მიერ დაქირავებული', 'Hired by the client')}: ${parts.join(', ')}</li>`).join('')}
            ${entries.map((e) => `<li data-i="${e.icon}">${e.html}</li>`).join('')}
            ${l?.notes || l?.notes_en ? `<li data-i="📝">${esc(l.notes || '')}${l.notes_en && l.notes_en !== l.notes ? `<em>${esc(l.notes_en)}</em>` : ''}</li>` : ''}
          </ul>
          ${thumbs(x.photos)}
        </article>`;
    }).join('');
  };

  // ---- Timeline: planned, baseline and actual for every item ----
  views.timeline = () => {
    if (!D.tasks.length) return `<p class="empty">${L('გრაფიკი არ არის', 'No timetable')}</p>`;
    const ts = (iso) => new Date(`${iso}T00:00`).getTime();
    const dates = D.tasks.flatMap((t) => [t.planned_start, t.planned_finish, t.baseline_start, t.baseline_finish, t.done_at]).filter(Boolean);
    const lo = ts(dates.reduce((a, b) => (a < b ? a : b)));
    const hi = ts(dates.reduce((a, b) => (a > b ? a : b))) + 86400000;
    const pos = (iso) => ((ts(iso) - lo) / (hi - lo)) * 100;
    const span = (a, b) => `left:${pos(a)}%;width:${Math.max(0.6, pos(b) - pos(a) + (86400000 / (hi - lo)) * 100)}%`;
    const today = D.generatedOn;
    const rows = [...D.tasks].sort((a, b) => a.planned_start.localeCompare(b.planned_start)).map((t) => {
      const finish = t.done_at ?? (t.progress_pct > 0 ? today : null);
      const late = t.done_at && t.done_at > t.planned_finish;
      return `<div class="g-row" data-task="${esc(t.id)}" title="${esc(t.name)}">
        <div class="g-name">${taskName(t.id)} <span class="muted">${t.progress_pct}%</span></div>
        <div class="g-track">
          <i class="g-bar g-plan" style="${span(t.planned_start, t.planned_finish)}"></i>
          ${t.baseline_start && t.baseline_finish ? `<i class="g-bar g-base" style="${span(t.baseline_start, t.baseline_finish)}"></i>` : ''}
          ${finish && finish >= t.planned_start ? `<i class="g-bar g-act ${t.done ? (late ? 'late' : '') : 'open'}" style="${span(t.planned_start, finish)}"></i>` : ''}
          ${today >= dates[0] && ts(today) <= hi ? `<i class="g-today" style="left:${pos(today)}%"></i>` : ''}
        </div></div>`;
    }).join('');
    return `<div class="panel">
      <div class="legend"><span><i style="background:#cbd5e1"></i>${L('დაგეგმილი', 'Planned')}</span>
        <span><i style="border:1px dashed #64748b"></i>${L('დამტკიცებული', 'Baseline')}</span>
        <span><i style="background:#059669"></i>${L('შესრულდა ვადაში', 'Done on time')}</span>
        <span><i style="background:#be123c"></i>${L('შესრულდა დაგვიანებით', 'Done late')}</span>
        <span><i style="background:#60a5fa"></i>${L('მიმდინარე', 'Still open')}</span></div>
      <p class="muted">${d(new Date(lo).toLocaleDateString('en-CA'))} → ${d(new Date(hi - 86400000).toLocaleDateString('en-CA'))} · ${L('დააჭირეთ სამუშაოს დეტალებისთვის', 'click an item for its full history')}</p>
      <div class="gantt">${rows}</div></div>`;
  };

  // ---- Every item, with everything recorded on it ----
  const paidOn = (id) => sum(D.payments.filter((p) => p.task_id === id), 'amount');
  views.items = () => {
    const rows = D.tasks.map((t) => `<tr class="click" data-task="${esc(t.id)}">
      <td>${taskName(t.id)}</td><td>${who(t.contractor_id) || '-'}</td>
      <td>${d(t.planned_start)} → ${d(t.planned_finish)}</td><td>${t.done_at ? d(t.done_at) : '-'}</td>
      <td class="num">${t.progress_pct}%</td><td class="num">${t.budget ? money(t.budget) : '-'}</td>
      <td class="num">${paidOn(t.id) ? money(paidOn(t.id)) : '-'}</td><td>${stateChip(t)}</td></tr>`);
    return `<div class="panel">${table([['სამუშაო', 'Item'], ['კონტრაქტორი', 'Contractor'], ['დაგეგმილი', 'Planned'], ['დასრულდა', 'Finished'],
      ['შესრულება', 'Done', 'num'], ['ბიუჯეტი', 'Budget', 'num'], ['გადახდილი', 'Paid', 'num'], ['სტატუსი', 'Status']], rows,
    `<tr><td colspan="5">${L('სულ', 'Total')}</td><td class="num">${money(sum(D.tasks, 'budget'))}</td><td class="num">${money(sum(D.payments, 'amount'))}</td><td></td></tr>`)}</div>`;
  };
  const taskPop = (t) => {
    const pays = D.payments.filter((p) => p.task_id === t.id).sort((a, b) => a.paid_on.localeCompare(b.paid_on));
    const mats = D.materials.filter((m) => m.task_id === t.id);
    const work = D.work.filter((w) => w.task_id === t.id || false);
    const held = D.delays.filter((x) => x.tasks.includes(t.id));
    const photos = held.flatMap((x) => photosOfDelay.get(x.id) ?? []);
    return `<h2>${taskName(t.id)}</h2>
      <p>${stateChip(t)} ${t.contractor_id ? who(t.contractor_id) : ''}</p>
      <div class="facts">
        <div><span>${L('დაგეგმილი', 'Planned')}</span><b>${d(t.planned_start)} → ${d(t.planned_finish)}</b></div>
        ${t.baseline_finish ? `<div><span>${L('დამტკიცებული', 'Baseline')}</span><b>${d(t.baseline_start)} → ${d(t.baseline_finish)}</b></div>` : ''}
        ${t.extension_days ? `<div><span>${L('გაგრძელება შეფერხებით', 'Extended by delays')}</span><b>+${t.extension_days} ${L('დღე', 'days')}</b></div>` : ''}
        <div><span>${L('შესრულება', 'Done')}</span><b>${t.progress_pct}%${t.done_at ? ` · ${d(t.done_at)}` : ''}</b></div>
        ${t.budget ? `<div><span>${L('ბიუჯეტი', 'Budget')}</span><b>${money(t.budget)}${t.quantity != null ? ` <em>${qty(t.quantity, t.unit)}</em>` : ''}</b></div>` : ''}
        ${t.material_budget ? `<div><span>${L('მასალის ბიუჯეტი', 'Materials budget')}</span><b>${money(t.material_budget)}</b></div>` : ''}
        ${t.employer_price ? `<div><span>${L('დამკვეთის ფასი', "Employer's price")}</span><b>${money(t.employer_price)}</b></div>` : ''}
        <div><span>${L('გადახდილი', 'Paid')}</span><b>${money(sum(pays, 'amount'))}</b></div>
      </div>
      <h3>${L('გადახდები', 'Payments')}</h3>
      ${table([['თარიღი', 'Date'], ['თანხა', 'Paid', 'num'], ['გარანტია', 'Retention', 'num'], ['შენიშვნა', 'Note']],
    pays.map((p) => `<tr><td>${d(p.paid_on)}</td><td class="num">${money(p.amount)}</td><td class="num">${p.retention ? money(p.retention) : '-'}</td><td>${esc(p.note || '')}</td></tr>`))}
      ${mats.length ? `<h3>${L('მასალები', 'Materials')}</h3>${table([['თარიღი', 'Date'], ['მასალა', 'Material'], ['რაოდენობა', 'Quantity', 'num'], ['თანხა', 'Amount', 'num']],
    mats.map((m) => `<tr><td>${d(m.bought_on)}</td><td>${nameBi(m.item, m.item_ka)}</td><td class="num">${qty(m.quantity, m.unit) || '-'}</td><td class="num">${money(m.amount)}</td></tr>`))}` : ''}
      ${work.length ? `<h3>${L('შესრულებული სამუშაოები', 'Work recorded')}</h3>${table([['თარიღი', 'Date'], ['სამუშაო', 'Work'], ['კონტრაქტორი', 'Contractor'], ['რაოდენობა', 'Quantity', 'num']],
    work.map((w) => `<tr><td>${d(w.date)}</td><td>${nameBi(w.work_en, w.work)}</td><td>${w.by_day_workers ? L('დღიური მუშები', 'Daily workers') : who(w.contractor_id) || '-'}</td><td class="num">${w.quantity != null ? qty(w.quantity, w.unit) : L('მიმდინარე', 'in progress')}</td></tr>`))}` : ''}
      ${held.length ? `<h3>${L('შეაფერხა', 'Held up by')}</h3>${table([['დაიწყო', 'Started'], ['მიზეზი', 'Cause'], ['დღე', 'Days', 'num']],
    held.map((x) => `<tr><td>${d(x.start)}</td><td>${bi(x.cause)}${x.description || x.description_en ? `<em>${esc(x.description_en || x.description)}</em>` : ''}</td><td class="num">${x.days}</td></tr>`))}` : ''}
      ${thumbs(photos)}`;
  };

  // ---- Contractors ----
  views.contractors = () => {
    if (!D.contractors.length) return `<p class="empty">${L('კონტრაქტორები არ არის', 'No contractors')}</p>`;
    return `<div class="cards">${D.contractors.map((c) => {
      const jobs = D.tasks.filter((t) => t.contractor_id === c.id);
      const paid = sum(D.payments.filter((p) => tasks.get(p.task_id)?.contractor_id === c.id), 'amount');
      return `<div class="card" data-contractor="${esc(c.id)}"><b>${who(c.id)}</b>
        <p>${esc(c.trade || '')}</p>
        <p>${jobs.length} ${L('სამუშაო', 'jobs')} · ${L('ბიუჯეტი', 'budget')} ${money(sum(jobs, 'budget'))} · ${L('გადახდილი', 'paid')} ${money(paid)}</p></div>`;
    }).join('')}</div>`;
  };
  const contractorPop = (c) => {
    const jobs = D.tasks.filter((t) => t.contractor_id === c.id);
    const ids = new Set(jobs.map((t) => t.id));
    const pays = D.payments.filter((p) => ids.has(p.task_id)).sort((a, b) => a.paid_on.localeCompare(b.paid_on));
    const docs = D.documents.filter((x) => x.contractor_id === c.id);
    const contractsOf = docs.filter((x) => !x.contract_id);
    const caused = D.delays.filter((x) => x.contractor_id === c.id);
    const crewDays = D.logs.filter((l) => l.crew.some((x) => x.contractor_id === c.id));
    const manDays = sum(D.logs.flatMap((l) => l.crew.filter((x) => x.contractor_id === c.id)), 'workers');
    const work = D.work.filter((w) => w.contractor_id === c.id);
    const docLink = (x) => (x.file ? `<a href="${esc(x.file)}" target="_blank">${esc(x.title)}</a>` : esc(x.title));
    return `<h2>${who(c.id)}</h2>
      <p class="muted">${[c.trade, c.contact_person, c.phone, c.email].filter(Boolean).map(esc).join(' · ')}</p>
      <div class="facts">
        <div><span>${L('სამუშაოები', 'Jobs')}</span><b>${jobs.length}</b></div>
        <div><span>${L('ბიუჯეტი', 'Budget')}</span><b>${money(sum(jobs, 'budget'))}</b></div>
        <div><span>${L('გადახდილი', 'Paid')}</span><b>${money(sum(pays, 'amount'))}</b></div>
        <div><span>${L('ობიექტზე', 'On site')}</span><b>${crewDays.length} ${L('დღე', 'days')} · ${manDays} ${L('კაც-დღე', 'man-days')}</b></div>
        <div><span>${L('მისი ბრალით შეფერხება', 'Delays they caused')}</span><b>${caused.length} · ${sum(caused, 'days')} ${L('დღე', 'days')}</b></div>
      </div>
      ${contractsOf.length ? `<h3>${L('ხელშეკრულებები და აქტები', 'Contracts and acceptance acts')}</h3>${table([['დოკუმენტი', 'Document'], ['თარიღი', 'Date'], ['თანხა', 'Amount', 'num']],
    contractsOf.flatMap((x) => [`<tr><td><b>${docLink(x)}</b></td><td>${d(x.signed_on)}</td><td class="num">-</td></tr>`,
      ...docs.filter((a) => a.contract_id === x.id).map((a) => `<tr><td>↳ ${docLink(a)}${a.act_no ? ` <em>№ ${esc(a.act_no)}</em>` : ''}</td><td>${d(a.signed_on)}</td><td class="num">${a.amount != null ? money(a.amount) : '-'}</td></tr>`)]))}` : ''}
      <h3>${L('სამუშაოები', 'Jobs')}</h3>
      ${table([['სამუშაო', 'Item'], ['დაგეგმილი', 'Planned'], ['შესრულება', 'Done', 'num'], ['ბიუჯეტი', 'Budget', 'num'], ['სტატუსი', 'Status']],
    jobs.map((t) => `<tr class="click" data-task="${esc(t.id)}"><td>${taskName(t.id)}</td><td>${d(t.planned_start)} → ${d(t.planned_finish)}</td><td class="num">${t.progress_pct}%</td><td class="num">${t.budget ? money(t.budget) : '-'}</td><td>${stateChip(t)}</td></tr>`))}
      <h3>${L('გადახდები', 'Payments')}</h3>
      ${table([['თარიღი', 'Date'], ['სამუშაო', 'Item'], ['თანხა', 'Paid', 'num'], ['გარანტია', 'Retention', 'num']],
    pays.map((p) => `<tr><td>${d(p.paid_on)}</td><td>${taskName(p.task_id)}</td><td class="num">${money(p.amount)}</td><td class="num">${p.retention ? money(p.retention) : '-'}</td></tr>`),
    pays.length ? `<tr><td colspan="2">${L('სულ', 'Total')}</td><td class="num">${money(sum(pays, 'amount'))}</td><td class="num">${money(sum(pays, 'retention'))}</td></tr>` : '')}
      ${work.length ? `<h3>${L('შესრულებული სამუშაოები', 'Work recorded')}</h3>${table([['თარიღი', 'Date'], ['სად', 'Where'], ['სამუშაო', 'Work'], ['რაოდენობა', 'Quantity', 'num']],
    work.map((w) => `<tr><td>${d(w.date)}</td><td>${w.flat ? esc(w.flat) : taskName(w.task_id)}</td><td>${nameBi(w.work_en, w.work)}</td><td class="num">${w.quantity != null ? qty(w.quantity, w.unit) : L('მიმდინარე', 'in progress')}</td></tr>`))}` : ''}
      ${caused.length ? `<h3>${L('მისი ბრალით შეფერხებები', 'Delays they caused')}</h3>${table([['დაიწყო', 'Started'], ['მიზეზი', 'Cause'], ['დღე', 'Days', 'num']],
    caused.map((x) => `<tr><td>${d(x.start)}</td><td>${bi(x.cause)}${x.description || x.description_en ? `<em>${esc(x.description_en || x.description)}</em>` : ''}</td><td class="num">${x.days}</td></tr>`))}` : ''}`;
  };

  // ---- Money: every coin, in order ----
  views.money = () => {
    const ledger = [
      ...D.payments.map((p) => ({ date: p.paid_on, what: `${L('კონტრაქტი', 'Contract')}: ${taskName(p.task_id)}`, who: who(taskOf(p)?.contractor_id), amount: p.amount, extra: p.retention ? `+ ${money(p.retention)} ${L('გარანტია', 'retention')}` : '' })),
      ...D.sitePayments.map((p) => {
        const r = D.rentals.find((x) => x.id === p.rental_id);
        return { date: p.paid_on, what: `${L(...(SITE[p.kind] ?? [p.kind, p.kind]))}${p.month ? ` · ${monthName(p.month.slice(0, 7))}` : ''}${r ? ` · ${nameBi(r.equipment, r.equipment_ka)}` : ''}`, who: r?.supplier ? esc(r.supplier) : '', amount: p.amount, extra: esc(p.note || '') };
      }),
      ...D.materials.map((m) => ({ date: m.paid_on ?? m.bought_on, what: `${L(...(KIND[m.kind] ?? KIND.material))}: ${nameBi(m.item, m.item_ka)}${m.quantity != null ? ` ${qty(m.quantity, m.unit)}` : ''}`, who: esc(m.supplier || ''), amount: m.amount, extra: m.paid_on ? '' : L('ნისია - გადაუხდელი', 'on credit - unpaid') })),
    ].sort((a, b) => a.date.localeCompare(b.date));
    const c = D.cost;
    const f = D.finance;
    const byMonth = new Map();
    for (const x of ledger) byMonth.set(x.date.slice(0, 7), (byMonth.get(x.date.slice(0, 7)) ?? 0) + x.amount);
    let running = 0;
    return `
      <div class="tiles">
        ${tile('ბიუჯეტი', 'Budget', money(c.budget))}
        ${tile('კონტრაქტორებს გადაუხადეს', 'Paid to contractors', money(c.contracts))}
        ${tile('დღიური მუშები და დარაჯები', 'Day workers & guards', money(c.labour + c.guard))}
        ${tile('ტექნიკის ქირა', 'Equipment hire', money(c.rental))}
        ${tile('შესყიდვები', 'Purchases', money(c.material))}
        ${tile('სულ დახარჯული', 'Spent in all', money(c.spent), '', c.spent > c.budget && c.budget ? 'bad' : '')}
        ${f ? tile(f.profit < 0 ? 'ზარალი' : 'მოგება', f.profit < 0 ? 'Loss' : 'Profit', money(f.profit), `${L('შემოსავალი', 'income')} ${money(f.income)}`, f.profit < 0 ? 'bad' : 'ok') : ''}
      </div>
      <div class="panel"><h3 style="margin-top:0">${L('თვეების მიხედვით', 'By month')}</h3>
        ${table([['თვე', 'Month'], ['გადახდილი', 'Paid out', 'num'], ['ჯამურად', 'Running total', 'num']],
    [...byMonth].sort().map(([ym, v]) => { running += v; return `<tr><td>${monthName(ym)}</td><td class="num">${money(v)}</td><td class="num">${money(running)}</td></tr>`; }))}</div>
      ${(D.moneyIn ?? []).length ? `<div class="panel"><h3 style="margin-top:0">${L('შემოსული თანხები', 'Money in')} <em>${D.moneyIn.length}</em></h3>
        ${table([['თარიღი', 'Date'], ['რა', 'What'], ['ვისგან', 'From'], ['თანხა', 'Amount', 'num']],
    D.moneyIn.map((x) => `<tr><td>${d(x.date)}</td><td>${L(...(MONEY_IN[x.kind] ?? [x.kind, x.kind]))}</td><td>${esc([x.from, x.certificate_no ? `№ ${x.certificate_no}` : '', x.flat].filter(Boolean).join(' · ')) || '-'}</td><td class="num">${money(x.amount)}</td></tr>`),
    `<tr><td colspan="3">${L('სულ', 'Total')}</td><td class="num">${money(sum(D.moneyIn, 'amount'))}</td></tr>`)}</div>` : ''}
      <div class="panel"><h3 style="margin-top:0">${L('ყველა გადახდა', 'Every payment')} <em>${ledger.length}</em></h3>
        ${table([['თარიღი', 'Date'], ['რისთვის', 'For'], ['ვის', 'To'], ['თანხა', 'Amount', 'num'], ['', '']],
    ledger.map((x) => `<tr><td>${d(x.date)}</td><td>${x.what}</td><td>${x.who || '-'}</td><td class="num">${money(x.amount)}</td><td>${x.extra}</td></tr>`),
    `<tr><td colspan="3">${L('სულ', 'Total')}</td><td class="num">${money(sum(ledger, 'amount'))}</td><td></td></tr>`)}</div>`;
  };

  // ---- Registers ----
  views.registers = () => {
    const units = D.units;
    return `
      <h2>${L('შეფერხებები', 'Delays')} <em>${D.delays.length}</em></h2>
      <div class="panel">${table([['დაიწყო', 'Started'], ['დასრულდა', 'Ended'], ['დღე', 'Days', 'num'], ['მიზეზი', 'Cause'], ['ვისი ბრალით', 'Caused by'], ['შეაფერხა', 'Held up']],
    [...D.delays].sort((a, b) => a.start.localeCompare(b.start)).map((x) => `<tr><td>${d(x.start)}</td><td>${x.ongoing ? L('მიმდინარე', 'ongoing') : d(x.end)}</td><td class="num">${x.days}</td>
      <td>${bi(x.cause)}${x.description || x.description_en ? `<em>${esc(x.description_en || x.description)}</em>` : ''}${thumbs(photosOfDelay.get(x.id))}</td><td>${who(x.contractor_id) || '-'}</td><td>${x.tasks.map(taskName).join('<br>') || '-'}</td></tr>`))}</div>
      <h2>${L('ცვლილებები', 'Variations')} <em>${D.variations.length}</em></h2>
      <div class="panel">${table([['ნომერი', 'Ref'], ['დაევალა', 'Instructed'], ['რა', 'What'], ['კონტრაქტორი', 'Contractor'], ['თანხა', 'Amount', 'num'], ['დღე', 'Days', 'num'], ['სტატუსი', 'Status']],
    D.variations.map((v) => `<tr><td>${esc(v.ref || '-')}</td><td>${d(v.instructed_on)}</td><td>${esc(v.title)}${v.description || v.description_en ? `<em>${esc(v.description_en || v.description)}</em>` : ''}</td><td>${who(v.contractor_id) || '-'}</td><td class="num">${v.amount ? money(v.amount) : '-'}</td><td class="num">${v.days_claimed || '-'}</td><td>${chip(...(VAR[v.status] ?? VAR.instructed))}${v.decided_on ? ` ${d(v.decided_on)}` : ''}</td></tr>`))}</div>
      <h2>${L('უსაფრთხოება და ხარისხი', 'Safety & quality')} <em>${D.events.length}</em></h2>
      <div class="panel">${table([['თარიღი', 'Date'], ['ტიპი', 'Kind'], ['რა მოხდა', 'What happened'], ['კონტრაქტორი', 'Contractor'], ['ზომა', 'Action'], ['სტატუსი', 'Status']],
    D.events.map((e) => `<tr><td>${d(e.date)}</td><td>${bi(e.kind === 'toolbox_talk' ? 'Toolbox talk' : e.kind === 'inspection' ? 'Inspection' : 'Incident')}</td><td>${esc(e.title)}${e.description || e.description_en ? `<em>${esc(e.description_en || e.description)}</em>` : ''}</td><td>${who(e.contractor_id) || '-'}</td><td>${esc(e.action || '-')}</td><td>${e.closed ? chip('დახურული', 'Closed', 'ok') : chip('ღია', 'Open', 'warn')}</td></tr>`))}</div>
      ${units.length ? `<h2>${L('ოთახები', 'Rooms')} <em>${units.length}</em></h2>
      <div class="panel">${table([['ბლოკი', 'Block'], ['სართული', 'Floor'], ['ოთახი', 'Room'], ['ტიპი', 'Type'], ['ფართი', 'Area', 'num'], ['სტატუსი', 'Status'], ['სამუშაოები', 'Work entries', 'num']],
    units.map((u) => `<tr><td>${esc(u.block || '-')}</td><td>${u.floor ?? '-'}</td><td>${esc(u.flat_number)}</td><td>${u.unit_type ? bi(u.unit_type) : '-'}</td><td class="num">${u.area_m2 != null ? `${u.area_m2} m²` : '-'}</td><td>${bi({ not_started: 'Not started', in_progress: 'In progress', finished: 'Finished', handed_over: 'Handed over' }[u.status] ?? u.status)}</td><td class="num">${D.work.filter((w) => w.flat_id === u.id).length || '-'}</td></tr>`))}</div>` : ''}`;
  };

  // ---- Photos ----
  views.photos = () => {
    if (!D.photos.length) return `<p class="empty">${L('ფოტოები არ არის', 'No photos')}</p>`;
    const byDay = new Map();
    for (const ph of [...D.photos].sort((a, b) => String(a.date).localeCompare(String(b.date)))) {
      if (!byDay.has(ph.date)) byDay.set(ph.date, []);
      byDay.get(ph.date).push(ph);
    }
    return [...byDay].map(([date, list]) => `<h3>${d(date)} <em>${list.length}</em></h3>
      <div class="gallery">${list.map((ph) => `<img loading="lazy" src="${esc(ph.thumb)}" data-photo="${esc(ph.id)}" alt="">`).join('')}</div>`).join('');
  };

  // =============================================================
  // Tabs, pop-ups, photo viewer, $ / ₾
  // =============================================================
  const TABS = [
    ['overview', 'მიმოხილვა', 'Overview'], ['journal', 'ჟურნალი', 'Day by day'], ['timeline', 'გრაფიკი', 'Timeline'],
    ['items', 'სამუშაოები', 'Items'], ['contractors', 'კონტრაქტორები', 'Contractors'], ['money', 'ფინანსები', 'Money'],
    ['registers', 'რეესტრები', 'Registers'], ['photos', 'ფოტოები', 'Photos'],
  ];
  let current = (location.hash.slice(1) && views[location.hash.slice(1)]) ? location.hash.slice(1) : 'overview';
  const render = () => {
    $('#tabs').innerHTML = TABS.map(([key, k, e]) => `<button data-tab="${key}" class="${key === current ? 'on' : ''}">${L(k, e)}</button>`).join('');
    $('#view').innerHTML = views[current]();
  };
  document.addEventListener('click', (e) => {
    const tab = e.target.closest('[data-tab]');
    if (tab) {
      current = tab.dataset.tab;
      render();
      scrollTo(0, 0);
      // Remembered in the address so a reload stays on the tab - where the
      // browser allows it: some refuse to touch a file:// address.
      try { history.replaceState(null, '', `#${current}`); } catch { /* stays as it was */ }
      return;
    }
    const photo = e.target.closest('[data-photo]');
    if (photo) return openPhoto(photo);
    const t = e.target.closest('[data-task]');
    if (t && tasks.get(t.dataset.task)) return openPop(taskPop(tasks.get(t.dataset.task)));
    const c = e.target.closest('[data-contractor]');
    if (c && contractors.get(c.dataset.contractor)) return openPop(contractorPop(contractors.get(c.dataset.contractor)));
    const cur = e.target.closest('[data-cur]');
    if (cur) {
      shown = cur.dataset.cur;
      document.querySelectorAll('[data-cur]').forEach((b) => b.classList.toggle('on', b.dataset.cur === shown));
      render();
    }
  });
  document.addEventListener('input', (e) => {
    if (!['j-month', 'j-who', 'j-text'].includes(e.target.id)) return;
    journalFilter = { month: $('#j-month').value, contractor: $('#j-who').value, text: $('#j-text').value };
    $('#j-list').innerHTML = journalList(journalDays());
  });

  const pop = $('#pop');
  const openPop = (html) => {
    $('#pop-body').innerHTML = html;
    if (!pop.open) pop.showModal();
    $('#pop-body').scrollTop = 0;
  };
  pop.querySelector('.x').addEventListener('click', () => pop.close());
  pop.addEventListener('click', (e) => { if (e.target === pop) pop.close(); });

  // The photo viewer flips through the photos beside the one clicked.
  const lb = $('#lightbox');
  let group = [];
  let at = 0;
  const showPhoto = () => {
    const ph = group[at];
    $('#lb-img').src = ph.full;
    $('#lb-cap').textContent = [d(ph.date), ph.caption, `${at + 1} / ${group.length}`].filter(Boolean).join(' · ');
  };
  const photoById = new Map(D.photos.map((ph) => [ph.id, ph]));
  const openPhoto = (img) => {
    const box = img.closest('.thumbs, .gallery') ?? img.parentElement;
    group = [...box.querySelectorAll('[data-photo]')].map((x) => photoById.get(x.dataset.photo)).filter(Boolean);
    at = Math.max(0, group.findIndex((ph) => ph.id === img.dataset.photo));
    showPhoto();
    lb.showModal();
  };
  const step = (n) => { at = (at + n + group.length) % group.length; showPhoto(); };
  lb.querySelector('.lb-prev').addEventListener('click', () => step(-1));
  lb.querySelector('.lb-next').addEventListener('click', () => step(1));
  lb.querySelector('.x').addEventListener('click', () => lb.close());
  lb.addEventListener('click', (e) => { if (e.target === lb) lb.close(); });
  document.addEventListener('keydown', (e) => {
    if (!lb.open) return;
    if (e.key === 'ArrowLeft') step(-1);
    if (e.key === 'ArrowRight') step(1);
  });

  if (D.usdRate) {
    const cur = $('#cur');
    cur.hidden = false;
    cur.title = `ეროვნული ბანკის კურსი · National Bank rate ${d(D.usdRate.date)}: $1 = ${D.usdRate.rate.toFixed(4)} ₾`;
    cur.querySelectorAll('[data-cur]').forEach((b) => b.classList.toggle('on', b.dataset.cur === shown));
  }
  render();
}
