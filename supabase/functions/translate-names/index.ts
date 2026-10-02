// =============================================================
// Supabase Edge Function: translate-names
// Takes short names - timetable activities - each written in Georgian or
// English, and returns every one in both languages, in the same order.
//
// Deploy:
//   supabase functions deploy translate-names
// =============================================================
import { generateJson, json, serveJson } from "../_shared/gemini.ts";

const MAX_NAMES = 200;
const MAX_NAME_CHARS = 200;

const SYSTEM_PROMPT = `You keep the programme of a construction project in Georgia. Every activity name is stored in Georgian and English. You receive a list of activity names, each written in Georgian or in English.

For each name, in the same order, return:
- ka: the Georgian name. If the name was given in Georgian, return it exactly as written.
- en: the English name. If the name was given in English, return it exactly as written.
Translate only the missing language, using the standard construction terms a Georgian site team and an English-speaking engineer would use (e.g. "ფილის ჩასხმა" → "Slab pouring", "Brickwork" → "აგურის წყობა").

Keep every block, floor, axis, room and section reference, number, code and name exactly as written. Keep it short like a programme line - no explanations.`;

const SCHEMA = {
  type: "OBJECT",
  properties: {
    items: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: { ka: { type: "STRING" }, en: { type: "STRING" } },
        required: ["ka", "en"],
      },
    },
  },
  required: ["items"],
};

serveJson(async (payload: { names?: unknown }) => {
  const names = Array.isArray(payload.names) ? payload.names.map((n) => String(n ?? "").trim()) : [];
  if (!names.length || names.some((n) => !n)) return json({ error: "No names to translate" }, 400);
  if (names.length > MAX_NAMES) return json({ error: `At most ${MAX_NAMES} names at a time` }, 413);
  if (names.some((n) => n.length > MAX_NAME_CHARS)) return json({ error: "A name is too long" }, 413);

  const { result, model, skipped } = await generateJson({
    systemPrompt: SYSTEM_PROMPT,
    userText: JSON.stringify(names, null, 2),
    schema: SCHEMA,
    temperature: 0.2,
    quick: true,
  });

  const items = (Array.isArray(result.items) ? result.items : [])
    .map((i: any) => ({ ka: String(i?.ka ?? "").trim(), en: String(i?.en ?? "").trim() }));
  if (items.length !== names.length || items.some((i: any) => !i.ka || !i.en)) {
    return json({ error: "Gemini returned an incomplete translation" }, 502);
  }
  return json({ items, model, ...(skipped.length ? { skipped } : {}) });
});
