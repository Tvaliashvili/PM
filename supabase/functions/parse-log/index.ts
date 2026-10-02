// =============================================================
// Supabase Edge Function: parse-log
// Reads a daily site log pasted as free text (often copied from WhatsApp,
// in Georgian) and returns the date, weather, headcount per trade, the work
// done (where, what, how much, by whom), corrected Georgian notes and an
// English translation for the Daily Log form.
//
// Deploy:
//   supabase functions deploy parse-log
// =============================================================
import { generateJson, json, serveJson } from "../_shared/gemini.ts";

const MAX_TEXT_CHARS = 20_000;

type Option = { key: string; label: string; ka?: string };

const MAX_WORK_LINES = 60;

const SYSTEM_PROMPT = `You process daily site logs from a construction project in Georgia. The site manager writes them in Georgian, usually as WhatsApp messages, so the text may contain WhatsApp headers like "[26/09/2026, 18:30] Name:", emojis, abbreviations and spelling or grammar mistakes. The company is international, so every log is kept in Georgian and English.

Return:
- date: the date the log is for, as YYYY-MM-DD. WhatsApp dates are day/month/year. Use "" if the text gives no date.
- weather: one of the allowed weather keys, or "none" if the weather isn't mentioned.
- manpower: people on site per trade, using only the allowed trade keys. Match Georgian or English wording and synonyms to the closest trade (e.g. "მუშა", "labour", "helpers" → day_workers). Add up counts for the same trade. If a count is for people you cannot place in any trade, use "day_workers". Leave out trades that aren't mentioned; never invent numbers.
- notes_ka: the log as clean, professional Georgian - fix spelling, grammar and punctuation, expand obvious abbreviations, and drop WhatsApp headers and emojis. Keep every fact, figure, name, unit number and date exactly as written; do not add, remove or soften anything. That includes the weather and headcount lines: notes_ka must still read as the complete log on its own, even though those details are also returned as fields. Keep the writer's order and line breaks where they help (one item per line).
- notes_en: a faithful English translation of notes_ka, using standard construction terminology, with the same facts, figures and line structure.
- work: one line for each piece of work the log says was done (installed, poured, plastered, finished, fixed…) - not for deliveries, plans, problems or headcounts. For each line:
  - room: the key of the allowed room it was done in, matched by block, floor and number however they are written (e.g. "A ბლოკი 301", "ბ-12", "flat 5"); "none" when it was not in a room (facade, roof, yard, stairwell…) or the room is not on the list.
  - contractor: the key of the allowed contractor who did it, matched by company or person name; "none" when no one is named.
  - work_ka and work_en: what was done, short like a work line ("თაბაშირ-მუყაოს ფილების მონტაჟი" / "Gypsum board installation"), in Georgian and English. Leave the quantity, room and contractor out of this text.
  - quantity and unit: the amount, only when the log gives one, with the closest allowed unit; quantity 0 and unit "" when there is none. Never invent a figure.
  If the same work is reported for several rooms, write one line per room.`;

serveJson(async (payload: {
  text?: string; today?: string; trades?: Option[]; weather?: Option[];
  rooms?: Option[]; contractors?: Option[]; units?: string[];
}) => {
  const text = String(payload.text ?? "").trim();
  if (!text) return json({ error: "Paste the log text first" }, 400);
  if (text.length > MAX_TEXT_CHARS) return json({ error: "Log text is too long" }, 413);

  const trades = (payload.trades ?? []).filter((t) => t?.key);
  const weather = (payload.weather ?? []).filter((w) => w?.key);
  if (!trades.length) return json({ error: "No trades supplied" }, 400);
  const rooms = (payload.rooms ?? []).filter((r) => r?.key);
  const contractors = (payload.contractors ?? []).filter((c) => c?.key);
  const units = (payload.units ?? []).filter(Boolean);

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
      work: {
        type: "ARRAY",
        items: {
          type: "OBJECT",
          properties: {
            room: { type: "STRING", enum: ["none", ...rooms.map((r) => r.key)] },
            contractor: { type: "STRING", enum: ["none", ...contractors.map((c) => c.key)] },
            work_ka: { type: "STRING" },
            work_en: { type: "STRING" },
            quantity: { type: "NUMBER" },
            unit: { type: "STRING", enum: ["", ...units] },
          },
          required: ["room", "contractor", "work_ka", "work_en", "quantity", "unit"],
        },
      },
    },
    required: ["date", "weather", "manpower", "notes_ka", "notes_en", "work"],
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

Allowed rooms:
${rooms.length ? describe(rooms) : "(this site has no rooms - use none)"}

Allowed contractors:
${contractors.length ? describe(contractors) : "(none - use none)"}

Allowed units: ${units.join(", ") || "(none)"}

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
  const roomKeys = new Set(rooms.map((r) => r.key));
  const contractorKeys = new Set(contractors.map((c) => c.key));
  const work = (Array.isArray(result.work) ? result.work : [])
    .map((w: any) => {
      const quantity = Number(w?.quantity);
      return {
        room: roomKeys.has(w?.room) ? w.room : null,
        contractor: contractorKeys.has(w?.contractor) ? w.contractor : null,
        work_ka: String(w?.work_ka ?? "").trim(),
        work_en: String(w?.work_en ?? "").trim(),
        quantity: quantity > 0 ? quantity : null,
        unit: quantity > 0 && units.includes(w?.unit) ? w.unit : null,
      };
    })
    .filter((w: any) => w.work_ka || w.work_en)
    .slice(0, MAX_WORK_LINES);

  return json({
    date,
    weather: weatherKey,
    manpower,
    notes_ka: String(result.notes_ka ?? "").trim(),
    notes_en: String(result.notes_en ?? "").trim(),
    work,
    model,
  });
});
