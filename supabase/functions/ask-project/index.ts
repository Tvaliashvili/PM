// =============================================================
// Supabase Edge Function: ask-project
// Answers a free-text question about one project from all of its data -
// daily logs, timetable, contractors, delays and payments - via Gemini.
// The answer comes back in Georgian and English, the same facts in both.
// Data is read as the signed-in caller, so row-level security applies.
//
// Deploy:
//   supabase functions deploy ask-project
// =============================================================
import { generateJson, json, serveJson, userClient } from "../_shared/gemini.ts";

const MAX_QUESTION_CHARS = 1_000;
// Gemini Flash reads a million tokens, so years of site history still fit:
// roughly 1.5M characters of JSON. Only past that are the oldest logs dropped.
const MAX_CONTEXT_CHARS = 1_500_000;

const SYSTEM_PROMPT = `You are the assistant of a construction project manager in Georgia. You answer questions about one construction project (flats, offices, a stadium, infrastructure…) using only the project data provided: daily site logs (Georgian notes with English translations), the timetable (work items with planned dates, % complete, contractor and budget; due is the planned finish pushed out by extension_days, the days delays held the item up - judge an item late or overdue against due, never planned_finish), contractors, delays (counted in whole days lost, described in Georgian and English; a delay with ongoing=true has not been settled yet - its days_lost is the count so far and keeps growing; contractor_at_fault caused it and held_up lists the work it stopped, with the contractor who was waiting - each of those items lost this delay's whole days_lost, so when judging whether someone is running late, take those days off the waiting contractor and count them against the one at fault, and say so), payments to contractors, daily workers (manpower.day_workers, each paid the log's day_rate for that day) and equipment rentals (daily_rate × days).

Rules:
- Answer twice, whatever language the question is in: "ka" in natural, professional Georgian as used in Georgian construction reporting, and "en" in English. The two must state the same facts and figures - neither leaves out something the other says. Write each as it would be written in that language, not word for word from the other.
- Project, location, client, contractor, work item and equipment names are spelled by hand in both languages (name / name_ka, location / location_ka, client_name / client_name_ka, item / item_ka, equipment / equipment_ka): use the Georgian spelling in the Georgian answer and the English one in the English answer, exactly as given.
- Be specific: give dates, figures, names and units. Keep it short; for lists, put each point on its own line starting with "- ".
- When you add things up (workers, hours, days, money), say what you counted.
- Use only the data. If it doesn't contain the answer, say so plainly and, if useful, say what information is missing. Never invent facts.
- Today's date is given; use it for questions like "this week" or "last month".`;

const SCHEMA = {
  type: "OBJECT",
  properties: { ka: { type: "STRING" }, en: { type: "STRING" } },
  required: ["ka", "en"],
};

// A question with a Georgian letter in it is a Georgian question, so that
// version of the answer is the one shown first.
const isGeorgian = (text: string) => /[Ⴀ-ჿ]/.test(text);

serveJson(async (payload: { project_id?: string; question?: string; today?: string }, req) => {
  const question = String(payload.question ?? "").trim();
  const projectId = String(payload.project_id ?? "");
  if (!question) return json({ error: "Type a question first" }, 400);
  if (question.length > MAX_QUESTION_CHARS) return json({ error: "Question is too long" }, 413);
  if (!projectId) return json({ error: "No project selected" }, 400);

  const sb = userClient(req);
  const [project, tasks, contractors, logs, delays, payments, rentals] = await Promise.all([
    sb.from("projects").select("name, name_ka, location, location_ka, client_name, client_name_ka, start_date, end_date, currency, has_rooms").eq("id", projectId).single(),
    sb.from("schedule_tasks")
      .select("id, name, name_ka, planned_start, planned_finish, progress_pct, done_at, contractor_id, budget")
      .eq("project_id", projectId).order("planned_start"),
    sb.from("contractors").select("id, name, name_ka, trade").eq("project_id", projectId),
    sb.from("daily_logs")
      .select("log_date, weather, manpower, day_rate, notes, notes_en")
      // Every log, newest first - four years of daily logs on one project.
      .eq("project_id", projectId).order("log_date", { ascending: false }).limit(1500),
    sb.from("delays")
      .select("created_at, delay_cause, duration_days, resolved_on, description, description_en, cause_contractor_id, flats(block, flat_number), impacts:delay_impacts(task_id)")
      .eq("project_id", projectId).order("created_at", { ascending: false }).limit(1000),
    sb.from("task_payments").select("task_id, paid_on, amount, note").eq("project_id", projectId).order("paid_on"),
    sb.from("equipment_rentals").select("equipment, equipment_ka, supplier, supplier_ka, start_date, days, daily_rate, note").eq("project_id", projectId).order("start_date"),
  ]);

  const failed = [project, tasks, contractors, logs, delays, payments, rentals].find((r) => r.error);
  if (failed) {
    console.error(failed.error);
    return json({ error: "Could not read the project data" }, 500);
  }

  // Each item's finish, pushed out by the delays that held it up - the same
  // rule as the app (js/schedule.js extensionsByTask): a delay covers its start
  // day and its days lost after it, and days two delays share count once.
  const today = String(payload.today ?? new Date().toISOString().slice(0, 10));
  const day = (iso: string) => new Date(`${iso}T00:00:00Z`).getTime();
  const addDays = (iso: string, n: number) => new Date(day(iso) + n * 86_400_000).toISOString().slice(0, 10);
  const daysLost = (d: any) => d.duration_days ?? Math.max(1,
    Math.round((day(today) - day(String(d.created_at).slice(0, 10))) / 86_400_000) + 1);
  const spans = new Map<string, [string, string][]>();
  for (const d of delays.data ?? []) {
    const start = String(d.created_at).slice(0, 10);
    for (const i of (d as any).impacts ?? []) {
      if (!spans.has(i.task_id)) spans.set(i.task_id, []);
      spans.get(i.task_id)!.push([start, addDays(start, daysLost(d) - 1)]);
    }
  }
  const extension = new Map<string, number>();
  for (const [taskId, list] of spans) {
    list.sort((a, b) => a[0].localeCompare(b[0]));
    let total = 0;
    let [from, to] = list[0];
    for (const [s, e] of list.slice(1)) {
      if (s <= addDays(to, 1)) { if (e > to) to = e; } else {
        total += (day(to) - day(from)) / 86_400_000 + 1;
        [from, to] = [s, e];
      }
    }
    extension.set(taskId, total + (day(to) - day(from)) / 86_400_000 + 1);
  }

  const contractorName = new Map((contractors.data ?? []).map((c) => [c.id, c.name]));
  const taskName = new Map((tasks.data ?? []).map((t) => [t.id, t.name]));
  const taskContractor = new Map((tasks.data ?? []).map((t) => [t.id, t.contractor_id]));
  const context = {
    project: project.data,
    timetable: (tasks.data ?? []).map((t) => ({
      item: t.name,
      item_ka: t.name_ka,
      planned_start: t.planned_start,
      planned_finish: t.planned_finish,
      // Days delays added to this item, and the finish it is held to because of them.
      extension_days: extension.get(t.id) ?? 0,
      due: addDays(t.planned_finish, extension.get(t.id) ?? 0),
      percent_complete: t.progress_pct,
      finished_on: t.done_at,
      contractor: contractorName.get(t.contractor_id) ?? null,
      budget: t.budget,
    })),
    contractors: contractors.data,
    delays: (delays.data ?? []).map((d: any) => ({
      date: String(d.created_at).slice(0, 10),
      cause: d.delay_cause,
      // No duration written down means the delay is still running: count the
      // days it has cost so far, up to today.
      days_lost: d.duration_days ?? Math.max(1, Math.round(
        (Date.now() - new Date(String(d.created_at).slice(0, 10)).getTime()) / 86_400_000,
      ) + 1),
      ongoing: d.duration_days === null,
      ended_on: d.resolved_on ?? null,
      ...(project.data?.has_rooms ? { room: d.flats ? `${d.flats.block}-${d.flats.flat_number}` : "site-wide" } : {}),
      // Whose fault it was, and the work it held up. Days a delay cost someone
      // else's item are that item's holder's lateness only on paper - they are
      // owed to the contractor at fault, so never blame them on the item's own
      // contractor when asked who is running late.
      contractor_at_fault: contractorName.get(d.cause_contractor_id) ?? null,
      // Each held-up item loses this delay's own days_lost, above - the delay
      // is why the work is standing, so the two last exactly as long.
      held_up: (d.impacts ?? []).map((i: any) => ({
        item: taskName.get(i.task_id) ?? null,
        contractor: contractorName.get(taskContractor.get(i.task_id)) ?? null,
      })),
      description_ka: d.description,
      description_en: d.description_en,
    })),
    payments: (payments.data ?? []).map((p) => ({
      item: taskName.get(p.task_id) ?? null, paid_on: p.paid_on, amount: p.amount, note: p.note,
    })),
    // Equipment hire: cost = daily_rate × days, from start_date.
    equipment_rentals: rentals.data ?? [],
    daily_logs: logs.data ?? [], // newest first; manpower.day_workers are paid day_rate each per day
  };

  // Keep within the budget by dropping the oldest logs.
  const logsFound = context.daily_logs.length;
  let text = JSON.stringify(context);
  while (text.length > MAX_CONTEXT_CHARS && context.daily_logs.length) {
    context.daily_logs = context.daily_logs.slice(0, Math.floor(context.daily_logs.length * 0.8));
    text = JSON.stringify(context);
  }

  // Say so plainly when the oldest logs did not fit, so an answer is never
  // passed off as covering the whole project.
  const dropped = logsFound - context.daily_logs.length;
  const note = dropped
    ? `\n\nNote: only the most recent ${context.daily_logs.length} daily logs fitted in this context; `
      + `the ${dropped} oldest are missing. Say so if the question reaches back that far.`
    : "";

  const { result, model } = await generateJson({
    systemPrompt: SYSTEM_PROMPT,
    userText: `Today is ${payload.today ?? "unknown"}.${note}\n\nProject data (JSON):\n${text}\n\nQuestion:\n${question}`,
    schema: SCHEMA,
    temperature: 0.2,
  });

  const ka = String(result.ka ?? "").trim();
  const en = String(result.en ?? "").trim();
  if (!ka || !en) return json({ error: "Gemini returned an empty answer" }, 502);
  // asked: the question's own language, shown first; answer: that version alone.
  const asked = isGeorgian(question) ? "ka" : "en";
  return json({
    ka, en, asked, answer: asked === "ka" ? ka : en,
    logs_used: context.daily_logs.length, logs_found: logsFound, model,
  });
});
