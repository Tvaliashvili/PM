// =============================================================
// Supabase Edge Function: parse-log
// Reads a daily site log pasted as free text (often copied from WhatsApp,
// in Georgian) and returns the date, weather, headcount per trade,
// corrected Georgian notes and an English translation for the Daily Log form.
//
// Deploy:
//   supabase functions deploy parse-log
// =============================================================
import { generateJson, json, serveJson } from "../_shared/gemini.ts";

const MAX_TEXT_CHARS = 20_000;

type Option = { key: string; label: string; ka?: string };

const SYSTEM_PROMPT = `You process daily site logs from a construction project in Georgia. The site manager writes them in Georgian, usually as WhatsApp messages, so the text may contain WhatsApp headers like "[26/09/2026, 18:30] Name:", emojis, abbreviations and spelling or grammar mistakes. The company is international, so every log is kept in Georgian and English.

Return:
- date: the date the log is for, as YYYY-MM-DD. WhatsApp dates are day/month/year. Use "" if the text gives no date.
- weather: one of the allowed weather keys, or "none" if the weather isn't mentioned.
- manpower: people on site per trade, using only the allowed trade keys. Match Georgian or English wording and synonyms to the closest trade (e.g. "მუშა", "labour", "helpers" → day_workers). Add up counts for the same trade. If a count is for people you cannot place in any trade, use "day_workers". Leave out trades that aren't mentioned; never invent numbers.
- notes_ka: the log as clean, professional Georgian - fix spelling, grammar and punctuation, expand obvious abbreviations, and drop WhatsApp headers and emojis. Keep every fact, figure, name, unit number and date exactly as written; do not add, remove or soften anything. That includes the weather and headcount lines: notes_ka must still read as the complete log on its own, even though those details are also returned as fields. Keep the writer's order and line breaks where they help (one item per line).
- notes_en: a faithful English translation of notes_ka, using standard construction terminology, with the same facts, figures and line structure.`;

serveJson(async (payload: { text?: string; today?: string; trades?: Option[]; weather?: Option[] }) => {
  const text = String(payload.text ?? "").trim();
  if (!text) return json({ error: "Paste the log text first" }, 400);
  if (text.length > MAX_TEXT_CHARS) return json({ error: "Log text is too long" }, 413);

  const trades = (payload.trades ?? []).filter((t) => t?.key);
  const weather = (payload.weather ?? []).filter((w) => w?.key);
  if (!trades.length) return json({ error: "No trades supplied" }, 400);

  const schema = {
    type: "OBJECT",
    properties: {
      date: { type: "STRING" },
      weather: { type: "STRING", enum: ["none", ...weather.map((w) => w.key)] },
      manpower: {
        type: "ARRAY",
        items: {
          type: "OBJECT",
          properties: {
            trade: { type: "STRING", enum: trades.map((t) => t.key) },
            count: { type: "INTEGER" },
          },
          required: ["trade", "count"],
        },
      },
      notes_ka: { type: "STRING" },
      notes_en: { type: "STRING" },
    },
    required: ["date", "weather", "manpower", "notes_ka", "notes_en"],
  };

  const describe = (list: Option[]) =>
    list.map((o) => `- ${o.key}: ${o.label}${o.ka ? ` / ${o.ka}` : ""}`).join("\n");

  const { result, model } = await generateJson({
    systemPrompt: SYSTEM_PROMPT,
    userText: `Today is ${payload.today ?? "unknown"}.

Allowed trades:
${describe(trades)}

Allowed weather:
${describe(weather)}

Log text:
"""
${text}
"""`,
    schema,
    temperature: 0,
  });

  // Keep only valid values; merge duplicate trades.
  const tradeKeys = new Set(trades.map((t) => t.key));
  const manpower: Record<string, number> = {};
  for (const row of Array.isArray(result.manpower) ? result.manpower : []) {
    const count = Math.round(Number(row?.count));
    if (tradeKeys.has(row?.trade) && count > 0) manpower[row.trade] = (manpower[row.trade] ?? 0) + count;
  }
  const date = /^\d{4}-\d{2}-\d{2}$/.test(result.date ?? "") ? result.date : "";
  const weatherKey = weather.some((w) => w.key === result.weather) ? result.weather : "";

  return json({
    date,
    weather: weatherKey,
    manpower,
    notes_ka: String(result.notes_ka ?? "").trim(),
    notes_en: String(result.notes_en ?? "").trim(),
    model,
  });
});
