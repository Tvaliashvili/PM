// =============================================================
// Timetable progress maths (pure - no DOM, no database)
// Each item has a % complete (100% = finished) and weighs its planned
// duration in days.
//   actual  = weighted average of the items' % complete
//   planned = share of total weight that should be done by today
//             (an item in progress counts pro rata)
//   overdue = below 100% and its planned finish is before today
// =============================================================
const DAY_MS = 86_400_000;

const toDate = (iso) => new Date(`${iso}T00:00`);
const dayDiff = (a, b) => Math.round((toDate(b) - toDate(a)) / DAY_MS);
const addDays = (iso, n) => {
  const d = toDate(iso);
  d.setDate(d.getDate() + n);
  return d.toLocaleDateString('en-CA');
};

// ---------- Delays ----------
// A delay with no days lost written down is still running: it costs another day
// every day until someone records the date it ended.
export const delayStart = (d) => new Date(d.created_at).toLocaleDateString('en-CA');
export const delayIsOngoing = (d) => d.duration_days === null || d.duration_days === undefined;

/** Days lost: what was written down once it ended, or the days it has run so far. */
export const delayDaysLost = (d, today = new Date().toLocaleDateString('en-CA')) => (
  delayIsOngoing(d)
    ? Math.max(1, dayDiff(delayStart(d), today) + 1)
    : Number(d.duration_days || 0)
);

/**
 * The last day a delay covers: the day it was settled if that was written down,
 * otherwise the last of the days lost. An ongoing delay runs to today.
 */
export const delayEnd = (d, today = new Date().toLocaleDateString('en-CA')) => {
  if (d.resolved_on) return d.resolved_on;
  if (delayIsOngoing(d)) return today;
  return addDays(delayStart(d), Math.max(0, delayDaysLost(d, today) - 1));
};

/** Whether a delay was running on one calendar day. */
export const delayCovers = (d, iso, today = new Date().toLocaleDateString('en-CA')) =>
  delayStart(d) <= iso && iso <= delayEnd(d, today);

/**
 * The contractor at fault. Older rows called the column contractor_id, which
 * read as "the contractor this delay concerns" - it always meant the cause.
 */
export const causeOf = (d) => d.cause_contractor_id ?? d.contractor_id ?? null;

// ---------- Extensions of time ----------
/**
 * Days each timetable item's finish is pushed out by the delays that held it
 * up: task id → days. Never typed - an item waits for exactly as long as the
 * delay lasts, so an ongoing one pushes the finish out a day at a time until
 * it is settled. Each delay covers its start date and its days lost after it;
 * two delays over the same days hold the item up once, because a day the work
 * stood still is one day however many reasons it had.
 */
export function extensionsByTask(impacts = [], today = new Date().toLocaleDateString('en-CA')) {
  const spans = new Map();
  for (const i of impacts) {
    if (!i.delay) continue; // the delay it belongs to was not loaded
    const start = delayStart(i.delay);
    const end = addDays(start, delayDaysLost(i.delay, today) - 1);
    if (!spans.has(i.task_id)) spans.set(i.task_id, []);
    spans.get(i.task_id).push([start, end]);
  }
  const days = new Map();
  for (const [taskId, list] of spans) {
    list.sort((a, b) => a[0].localeCompare(b[0]));
    let total = 0;
    let [from, to] = list[0];
    for (const [s, e] of list.slice(1)) {
      if (s <= addDays(to, 1)) {
        if (e > to) to = e;
      } else {
        total += dayDiff(from, to) + 1;
        [from, to] = [s, e];
      }
    }
    days.set(taskId, total + dayDiff(from, to) + 1);
  }
  return days;
}

/**
 * The timetable with each item's extension on it, as extension_days. Worked
 * out afresh on every load rather than stored, so it can never fall out of step
 * with the delays: untick an item or delete the delay and the date comes back.
 */
export const withExtensions = (tasks, impacts, today) => {
  const ext = extensionsByTask(impacts, today);
  return tasks.map((t) => ({ ...t, extension_days: ext.get(t.id) ?? 0 }));
};

/**
 * When an item is due: its planned finish, pushed out by any extension. The
 * planned finish itself is left alone, so the date the programme promised and
 * the one the delays have moved it to can both be shown.
 */
export const dueDate = (task) => addDays(task.planned_finish, Number(task.extension_days) || 0);

/** Planned duration in days, inclusive of both ends (a one-day task weighs 1). */
export const durationDays = (task) => dayDiff(task.planned_start, task.planned_finish) + 1;

/** How complete an item is, 0…1. 100% (or the older done flag) means finished. */
export const completionOf = (task) =>
  (task.done ? 1 : Math.min(100, Math.max(0, Number(task.progress_pct || 0))) / 100);

/**
 * Share of a task's time that has passed by `todayIso` (0…1). Its time runs to
 * the due date: days it stood waiting on someone else's delay are not days it
 * should have been working through.
 */
function plannedFraction(task, todayIso) {
  const due = dueDate(task);
  if (todayIso < task.planned_start) return 0;
  if (todayIso >= due) return 1;
  return (dayDiff(task.planned_start, todayIso) + 1) / (dayDiff(task.planned_start, due) + 1);
}

/** What share of an item should be done by `todayIso`, 0-100, from its dates alone. */
export const expectedPct = (task, todayIso) => Math.round(plannedFraction(task, todayIso) * 100);

/**
 * State of one activity on `todayIso`:
 *   { key: 'done' | 'overdue' | 'active' | 'upcoming', daysLate }
 * daysLate is set for overdue tasks and for tasks finished after their planned date.
 */
export function taskState(task, todayIso) {
  // Late means late against the due date: an extension is time the contractor
  // was given, not time he took.
  const due = dueDate(task);
  if (task.done) {
    const late = task.done_at ? dayDiff(due, task.done_at) : 0;
    return { key: 'done', daysLate: Math.max(0, late) };
  }
  if (todayIso > due) return { key: 'overdue', daysLate: dayDiff(due, todayIso) };
  if (todayIso >= task.planned_start) return { key: 'active', daysLate: 0 };
  return { key: 'upcoming', daysLate: 0 };
}

// ---------- Work that is not moving ----------
/**
 * Items the calendar says should be under way but the figures say are not,
 * worst first. Two different problems, kept apart because they read differently:
 *   'not_started' - the start date passed and nothing at all is recorded
 *   'behind'      - it is running far under the share of its time already spent
 * `gap` is how many percentage points short of today's expectation it is.
 */
export function stalledTasks(tasks, todayIso) {
  const out = [];
  for (const task of tasks) {
    if (task.done || completionOf(task) >= 1) continue;
    if (todayIso <= task.planned_start) continue;

    const actual = Math.round(completionOf(task) * 100);
    const expected = Math.round(plannedFraction(task, todayIso) * 100);
    const elapsed = dayDiff(task.planned_start, todayIso);
    // A day or two late is not news; a long item deserves a longer grace.
    const grace = Math.max(3, Math.round(durationDays(task) * 0.2));

    if (actual === 0 && elapsed >= grace) {
      out.push({ task, kind: 'not_started', elapsed, expected, actual, gap: expected });
    } else if (actual > 0 && expected - actual > 25) {
      out.push({ task, kind: 'behind', elapsed, expected, actual, gap: expected - actual });
    }
  }
  return out.sort((a, b) => b.gap - a.gap);
}

/**
 * When the work finishes if it carries on at the pace kept so far.
 * Null while it is too early to mean anything - a fortnight in, or under 5%
 * done, the arithmetic says more about the start than about the project.
 */
export function forecastFinish({ tasks, startDate, todayIso, actualPct }) {
  if (!tasks.length || actualPct <= 0 || actualPct >= 100) return null;
  const start = startDate || [...tasks.map((t) => t.planned_start)].sort()[0];
  if (!start || todayIso <= start) return null;

  const elapsed = dayDiff(start, todayIso);
  if (elapsed < 14 || actualPct < 5) return null;

  const pctPerDay = actualPct / elapsed;
  const remainingDays = Math.ceil((100 - actualPct) / pctPerDay);
  const date = toDate(todayIso);
  date.setDate(date.getDate() + remainingDays);
  return { date: date.toLocaleDateString('en-CA'), remainingDays, elapsed, pctPerDay };
}

// ---------- Money (each item's budget, its payments) ----------
const budgetOf = (task) => Number(task.budget || 0);
const monthOf = (iso) => iso.slice(0, 7);

/** Planned spend per month (YYYY-MM → amount): each budget spread evenly over its planned days. */
export function plannedSpendByMonth(tasks) {
  const months = new Map();
  for (const task of tasks) {
    const budget = budgetOf(task);
    if (!budget) continue;
    const perDay = budget / durationDays(task);
    const d = toDate(task.planned_start);
    const end = toDate(task.planned_finish);
    while (d <= end) {
      const key = d.toLocaleDateString('en-CA').slice(0, 7);
      months.set(key, (months.get(key) ?? 0) + perDay);
      d.setDate(d.getDate() + 1);
    }
  }
  return months;
}

/** Actual spend per month (YYYY-MM → amount) from dated payments. */
export function actualSpendByMonth(payments) {
  const months = new Map();
  for (const p of payments) {
    const key = monthOf(p.paid_on);
    months.set(key, (months.get(key) ?? 0) + Number(p.amount || 0));
  }
  return months;
}

// ---------- Site costs outside the BOQ: daily workers and equipment rentals ----------
// Both become dated entries { date, amount, kind: 'labour' | 'rental' } so they
// can be added to spending and to the monthly cash flow.

/**
 * What the client pays by the day for one trade: headcount × that log's rate.
 *
 * Only the client's own are counted - the crew lines with no contractor against
 * them. A contractor's men are the contractor's to pay, and are already inside
 * the price of their work; charging them here as well would count the same
 * people twice. A log recorded before the crew was split by contractor has no
 * lines, so its old headcount stands as the client's, which is what it was.
 */
function dayRateCosts(logs, tradeKey, rateField, kind) {
  return logs
    .map((l) => {
      const crew = l.crew ?? [];
      const workers = crew.length
        ? crew.reduce((n, c) => (
          !c.contractor_id && c.trade === tradeKey ? n + (Number(c.workers) || 0) : n
        ), 0)
        : Number(l.manpower?.[tradeKey] || 0);
      return { date: l.log_date, amount: workers * Number(l[rateField] || 0), workers, kind };
    })
    .filter((e) => e.workers > 0);
}

/** Daily-worker pay per log. */
export const labourCosts = (logs, dayWorkerKey = 'day_workers') => (
  dayRateCosts(logs, dayWorkerKey, 'day_rate', 'labour')
);

/** Guards, on the same footing but at their own rate. */
export const guardCosts = (logs, guardKey = 'guards') => (
  dayRateCosts(logs, guardKey, 'guard_rate', 'guard')
);

/** Total hire cost of one rental (daily rate × days). */
export const rentalTotal = (r) => Number(r.daily_rate || 0) * Number(r.days || 0);

/** Last day of a rental (inclusive). */
export function rentalEnd(r) {
  const d = toDate(r.start_date);
  d.setDate(d.getDate() + Number(r.days || 1) - 1);
  return d.toLocaleDateString('en-CA');
}

/** A rental's cost accrues day by day from its start date. */
export function rentalCosts(rentals) {
  const out = [];
  for (const r of rentals) {
    const rate = Number(r.daily_rate || 0);
    if (!rate) continue;
    const d = toDate(r.start_date);
    for (let i = 0; i < Number(r.days || 0); i += 1) {
      out.push({ date: d.toLocaleDateString('en-CA'), amount: rate, kind: 'rental', rentalId: r.id });
      d.setDate(d.getDate() + 1);
    }
  }
  return out;
}

/** Site costs per month up to `todayIso` (YYYY-MM → { labour, rental }). */
export function siteCostsByMonth(entries, todayIso) {
  const months = new Map();
  for (const e of entries) {
    if (e.date > todayIso) continue;
    const key = monthOf(e.date);
    const m = months.get(key) ?? { labour: 0, guard: 0, rental: 0 };
    m[e.kind] += e.amount;
    months.set(key, m);
  }
  return months;
}

/**
 * Cost position on `todayIso`:
 *   budget    - total of all item budgets
 *   planned   - value of work that should be done by today (budget × planned share)
 *   earned    - value of work actually done (budget × % complete)
 *   contracts - payments against timetable items made up to today
 *   labour    - daily-worker pay up to today
 *   rental    - equipment hire accrued up to today
 *   spent     - all of the above money: contracts + labour + rental
 */
export function costPosition(tasks, payments, todayIso, siteCosts = []) {
  let budget = 0;
  let planned = 0;
  let earned = 0;
  for (const task of tasks) {
    const b = budgetOf(task);
    budget += b;
    planned += b * plannedFraction(task, todayIso);
    earned += b * completionOf(task);
  }
  const contracts = payments
    .filter((p) => p.paid_on <= todayIso)
    .reduce((sum, p) => sum + Number(p.amount || 0), 0);
  const upToToday = (kind) => siteCosts
    .filter((e) => e.kind === kind && e.date <= todayIso)
    .reduce((sum, e) => sum + e.amount, 0);
  const labour = upToToday('labour');
  const guard = upToToday('guard');
  const rental = upToToday('rental');
  return {
    budget, planned, earned, contracts, labour, guard, rental,
    spent: contracts + labour + guard + rental,
  };
}

/**
 * Man-days per contractor across the logs given, keyed by contractor_id
 * ('' = labour engaged directly). One worker on site for one day is one
 * man-day, so this is what a contractor has actually put into the job - the
 * figure that tells you whether a late trade was ever manned to finish.
 *
 * Each entry: { days, byTrade: { [trade]: days }, onSite }
 *   onSite - the number of days that contractor had anyone on site at all
 */
export function contractorManDays(logs) {
  const stats = new Map();
  const entry = (id) => {
    const key = id ?? '';
    if (!stats.has(key)) stats.set(key, { days: 0, byTrade: {}, onSite: 0 });
    return stats.get(key);
  };

  for (const log of logs) {
    const seen = new Set();
    for (const c of log.crew ?? []) {
      const workers = Number(c.workers) || 0;
      if (workers <= 0) continue;
      const s = entry(c.contractor_id);
      s.days += workers;
      s.byTrade[c.trade] = (s.byTrade[c.trade] || 0) + workers;
      seen.add(c.contractor_id ?? '');
    }
    for (const key of seen) entry(key).onSite += 1;
  }
  return stats;
}

/**
 * Per-contractor performance on one project. Keyed by contractor_id ('' = unassigned).
 * Each entry: { items, onTime, late, avgDaysLate, overdue, open, delayDays,
 *               excusedDays, excusedItems, budget, paid }
 *   onTime/late - finished items, split by whether done_at was after the due date
 *   overdue     - unfinished items past their due date today
 *   open        - unfinished items not yet overdue (in progress or upcoming)
 *   delayDays   - days of the delays this contractor caused
 *   excusedDays - days his own items were extended by other people's delays
 * `tasks` must carry extension_days (see withExtensions), or nothing is excused.
 */
export function contractorPerformance(tasks, delays, payments, todayIso) {
  const stats = new Map();
  const entry = (id) => {
    const key = id ?? '';
    if (!stats.has(key)) {
      stats.set(key, {
        items: 0, onTime: 0, late: 0, lateDays: 0, overdue: 0, open: 0,
        delayDays: 0, excusedDays: 0, excusedItems: 0, budget: 0, paid: 0,
      });
    }
    return stats.get(key);
  };

  const taskContractor = new Map();
  for (const task of tasks) {
    taskContractor.set(task.id, task.contractor_id ?? '');
    const s = entry(task.contractor_id);
    // Measured against the due date, so days another contractor's delay held
    // this item up are already off its lateness.
    const state = taskState(task, todayIso);
    s.items += 1;
    s.budget += budgetOf(task);
    // Counted from the day the delay is logged, not once the item runs late:
    // the time was given to him whether or not he has needed it yet.
    const ext = Number(task.extension_days) || 0;
    if (ext > 0) {
      s.excusedDays += ext;
      s.excusedItems += 1;
    }
    if (state.key === 'done') {
      if (state.daysLate > 0) {
        s.late += 1;
        s.lateDays += state.daysLate;
      } else {
        s.onTime += 1;
      }
    } else if (state.key === 'overdue') {
      s.overdue += 1;
    } else {
      s.open += 1;
    }
  }
  for (const d of delays) if (causeOf(d)) entry(causeOf(d)).delayDays += delayDaysLost(d);
  for (const p of payments) entry(taskContractor.get(p.task_id)).paid += Number(p.amount || 0);

  for (const s of stats.values()) {
    s.avgDaysLate = s.late ? Math.round(s.lateDays / s.late) : 0;
    delete s.lateDays;
  }
  return stats;
}

/** Whole-project figures for the dashboard and reports. Percentages are 0…100 integers. */
export function scheduleProgress(tasks, todayIso) {
  let total = 0;
  let done = 0;
  let planned = 0;
  const overdue = [];

  for (const task of tasks) {
    const weight = durationDays(task);
    total += weight;
    done += weight * completionOf(task);
    planned += weight * plannedFraction(task, todayIso);

    const state = taskState(task, todayIso);
    if (state.key === 'overdue') overdue.push({ ...task, daysLate: state.daysLate });
  }

  overdue.sort((a, b) => b.daysLate - a.daysLate);
  return {
    count: tasks.length,
    doneCount: tasks.filter((t) => t.done).length,
    actualPct: total ? Math.round((done / total) * 100) : 0,
    plannedPct: total ? Math.round((planned / total) * 100) : 0,
    weightPct: (task) => (total ? (durationDays(task) / total) * 100 : 0),
    overdue,
  };
}
