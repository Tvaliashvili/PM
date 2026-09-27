// =============================================================
// Supabase Edge Function: ask-project
// Answers a free-text question about one project from all of its data -
// daily logs, timetable, contractors, delays and payments - via Gemini.
// Data is read as the signed-in caller, so row-level security applies.
//
// Deploy:
//   supabase functions deploy ask-project
// =============================================================
import { generateJson, json, serveJson, userClient } from "../_shared/gemini.ts";

const MAX_QUESTION_CHARS = 1_000;
const MAX_CONTEXT_CHARS = 400_000; // oldest logs are dropped beyond this

const SYSTEM_PROMPT = `You are the assistant of a construction project manager in Georgia. You answer questions about one construction project (flats, offices, a stadium, infrastructure…) using only the project data provided: daily site logs (Georgian notes with English translations), the timetable (work items with planned dates, % complete, contractor and budget), contractors, delays (counted in whole days lost, described in Georgian and English), payments to contractors, daily workers (manpower.day_workers, each paid the log's day_rate for that day) and equipment rentals (daily_rate × days).

Rules:
- Answer in the same language as the question (Georgian or English). Project, location, client and contractor names are spelled by hand in both languages (name / name_ka, location / location_ka, client_name / client_name_ka): use the Georgian spelling in Georgian answers and the English one in English answers.
- Be specific: give dates, figures, names and units. Keep it short; for lists, put each point on its own line starting with "- ".
- When you add things up (workers, hours, days, money), say what you counted.
- Use only the data. If it doesn't contain the answer, say so plainly and, if useful, say what information is missing. Never invent facts.
- Today's date is given; use it for questions like "this week" or "last month".`;

const SCHEMA = {
  type: "OBJECT",
  properties: { answer: { type: "STRING" } },
  required: ["answer"],
};

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
      .select("id, name, planned_start, planned_finish, progress_pct, done_at, contractor_id, budget")
      .eq("project_id", projectId).order("planned_start"),
    sb.from("contractors").select("id, name, name_ka, trade").eq("project_id", projectId),
    sb.from("daily_logs")
      .select("log_date, weather, manpower, day_rate, notes, notes_en")
      .eq("project_id", projectId).order("log_date", { ascending: false }).limit(1000),
    sb.from("delays")
      .select("created_at, delay_cause, duration_days, description, description_en, contractor_id, flats(block, flat_number)")
      .eq("project_id", projectId).order("created_at", { ascending: false }).limit(1000),
    sb.from("task_payments").select("task_id, paid_on, amount, note").eq("project_id", projectId).order("paid_on"),
    sb.from("equipment_rentals").select("equipment, supplier, start_date, days, daily_rate, note").eq("project_id", projectId).order("start_date"),
  ]);

  const failed = [project, tasks, contractors, logs, delays, payments, rentals].find((r) => r.error);
  if (failed) {
    console.error(failed.error);
    return json({ error: "Could not read the project data" }, 500);
  }

  const contractorName = new Map((contractors.data ?? []).map((c) => [c.id, c.name]));
  const taskName = new Map((tasks.data ?? []).map((t) => [t.id, t.name]));
  const context = {
    project: project.data,
    timetable: (tasks.data ?? []).map((t) => ({
      item: t.name,
      planned_start: t.planned_start,
      planned_finish: t.planned_finish,
      percent_complete: t.progress_pct,
      finished_on: t.done_at,
      contractor: contractorName.get(t.contractor_id) ?? null,
      budget: t.budget,
    })),
    contractors: contractors.data,
    delays: (delays.data ?? []).map((d: any) => ({
      date: String(d.created_at).slice(0, 10),
      cause: d.delay_cause,
      days_lost: d.duration_days,
      ...(project.data?.has_rooms ? { room: d.flats ? `${d.flats.block}-${d.flats.flat_number}` : "site-wide" } : {}),
      contractor: contractorName.get(d.contractor_id) ?? null,
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
  let text = JSON.stringify(context);
  while (text.length > MAX_CONTEXT_CHARS && context.daily_logs.length) {
    context.daily_logs = context.daily_logs.slice(0, Math.floor(context.daily_logs.length * 0.8));
    text = JSON.stringify(context);
  }

  const { result, model } = await generateJson({
    systemPrompt: SYSTEM_PROMPT,
    userText: `Today is ${payload.today ?? "unknown"}.\n\nProject data (JSON):\n${text}\n\nQuestion:\n${question}`,
    schema: SCHEMA,
    temperature: 0.2,
  });

  const answer = String(result.answer ?? "").trim();
  if (!answer) return json({ error: "Gemini returned an empty answer" }, 502);
  return json({ answer, logs_used: context.daily_logs.length, model });
});
