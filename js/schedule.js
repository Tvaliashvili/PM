// =============================================================
// Timetable progress maths (pure — no DOM, no database)
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

/** Planned duration in days, inclusive of both ends (a one-day task weighs 1). */
export const durationDays = (task) => dayDiff(task.planned_start, task.planned_finish) + 1;

/** How complete an item is, 0…1. 100% (or the older done flag) means finished. */
export const completionOf = (task) =>
  (task.done ? 1 : Math.min(100, Math.max(0, Number(task.progress_pct || 0))) / 100);

/** Share of a task's duration that has passed by `todayIso` (0…1). */
function plannedFraction(task, todayIso) {
  if (todayIso < task.planned_start) return 0;
  if (todayIso >= task.planned_finish) return 1;
  return (dayDiff(task.planned_start, todayIso) + 1) / durationDays(task);
}

/**
 * State of one activity on `todayIso`:
 *   { key: 'done' | 'overdue' | 'active' | 'upcoming', daysLate }
 * daysLate is set for overdue tasks and for tasks finished after their planned date.
 */
export function taskState(task, todayIso) {
  if (task.done) {
    const late = task.done_at ? dayDiff(task.planned_finish, task.done_at) : 0;
    return { key: 'done', daysLate: Math.max(0, late) };
  }
  if (todayIso > task.planned_finish) return { key: 'overdue', daysLate: dayDiff(task.planned_finish, todayIso) };
  if (todayIso >= task.planned_start) return { key: 'active', daysLate: 0 };
  return { key: 'upcoming', daysLate: 0 };
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

/**
 * Cost position on `todayIso`:
 *   budget  — total of all item budgets
 *   planned — value of work that should be done by today (budget × planned share)
 *   earned  — value of work actually done (budget × % complete)
 *   spent   — sum of payments made up to today
 */
export function costPosition(tasks, payments, todayIso) {
  let budget = 0;
  let planned = 0;
  let earned = 0;
  for (const task of tasks) {
    const b = budgetOf(task);
    budget += b;
    planned += b * plannedFraction(task, todayIso);
    earned += b * completionOf(task);
  }
  const spent = payments
    .filter((p) => p.paid_on <= todayIso)
    .reduce((sum, p) => sum + Number(p.amount || 0), 0);
  return { budget, planned, earned, spent };
}

/**
 * Per-contractor performance on one project. Keyed by contractor_id ('' = unassigned).
 * Each entry: { items, onTime, late, avgDaysLate, overdue, open, delayDays, budget, paid }
 *   onTime/late — finished items, split by whether done_at was after planned_finish
 *   overdue     — unfinished items past their planned finish today
 *   open        — unfinished items not yet overdue (in progress or upcoming)
 */
export function contractorPerformance(tasks, delays, payments, todayIso) {
  const stats = new Map();
  const entry = (id) => {
    const key = id ?? '';
    if (!stats.has(key)) {
      stats.set(key, { items: 0, onTime: 0, late: 0, lateDays: 0, overdue: 0, open: 0, delayDays: 0, budget: 0, paid: 0 });
    }
    return stats.get(key);
  };

  const taskContractor = new Map();
  for (const task of tasks) {
    taskContractor.set(task.id, task.contractor_id ?? '');
    const s = entry(task.contractor_id);
    const state = taskState(task, todayIso);
    s.items += 1;
    s.budget += budgetOf(task);
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
  for (const d of delays) if (d.contractor_id) entry(d.contractor_id).delayDays += Number(d.duration_days || 0);
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
