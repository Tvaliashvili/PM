// =============================================================
// Timetable progress maths (pure — no DOM, no database)
// Each activity weighs its planned duration in days.
//   actual  = share of total weight that is ticked done
//   planned = share of total weight that should be done by today
//             (an activity in progress counts pro rata)
//   overdue = not done and its planned finish is before today
// =============================================================
const DAY_MS = 86_400_000;

const toDate = (iso) => new Date(`${iso}T00:00`);
const dayDiff = (a, b) => Math.round((toDate(b) - toDate(a)) / DAY_MS);

/** Planned duration in days, inclusive of both ends (a one-day task weighs 1). */
export const durationDays = (task) => dayDiff(task.planned_start, task.planned_finish) + 1;

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

/** Whole-project figures for the dashboard and reports. Percentages are 0…100 integers. */
export function scheduleProgress(tasks, todayIso) {
  let total = 0;
  let done = 0;
  let planned = 0;
  const overdue = [];

  for (const task of tasks) {
    const weight = durationDays(task);
    total += weight;
    if (task.done) done += weight;
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
