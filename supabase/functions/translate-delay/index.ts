// =============================================================
// Supabase Edge Function: translate-delay
// Takes a short text - a delay, a safety event, a variation, a daily log's
// site notes - written in Georgian and/or English and returns both: corrected
// Georgian and a faithful English version (or the reverse).
//
// Deploy:
//   supabase functions deploy translate-delay
// =============================================================
import { generateJson, json, serveJson } from "../_shared/gemini.ts";

const MAX_TEXT_CHARS = 20_000; // a daily log pasted from WhatsApp can be long

const SYSTEM_PROMPT = `You keep the records of a construction project in Georgia - delays, safety events, variations and daily site notes. Every record is stored in Georgian and English. You receive a text written by the site team - in Georgian ("ka"), English ("en") or both - and may be given what it is about for context.

Return:
- ka: the description as clean, professional Georgian as used in Georgian construction reporting. If Georgian text was given, fix its spelling, grammar and punctuation and expand obvious abbreviations, but keep its meaning. If only English was given, translate it.
- en: the description in English with standard construction terminology. If only Georgian was given, or both were given, write it as a faithful translation of the final Georgian text. If only English was given, return it exactly as written - word for word, without rephrasing - and translate it into Georgian for ka.

Keep every fact, figure, name, room number and date exactly as written; do not add, remove or soften anything. Keep it about as long as the original.`;

const SCHEMA = {
  type: "OBJECT",
  properties: { ka: { type: "STRING" }, en: { type: "STRING" } },
  required: ["ka", "en"],
};

serveJson(async (payload: { ka?: string; en?: string; cause?: string }) => {
  const ka = String(payload.ka ?? "").trim();
  const en = String(payload.en ?? "").trim();
  if (!ka && !en) return json({ error: "Write a description first" }, 400);
  if (ka.length + en.length > MAX_TEXT_CHARS) return json({ error: "Description is too long" }, 413);

  const { result, model, skipped } = await generateJson({
    systemPrompt: SYSTEM_PROMPT,
    userText: JSON.stringify({ cause: payload.cause ?? null, ka: ka || null, en: en || null }, null, 2),
    schema: SCHEMA,
    temperature: 0.2,
    quick: true,
  });

  const out = { ka: String(result.ka ?? "").trim(), en: String(result.en ?? "").trim() };
  if (!out.ka || !out.en) return json({ error: "Gemini returned an empty translation" }, 502);
  return json({ ...out, model, ...(skipped.length ? { skipped } : {}) });
});
