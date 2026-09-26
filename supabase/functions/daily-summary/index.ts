// =============================================================
// Supabase Edge Function: daily-summary
// Turns one day's site data into a 3-bullet executive summary, in Georgian and English, via Google Gemini.
//
// Deploy:
//   supabase secrets set GEMINI_API_KEY=...
//   supabase functions deploy daily-summary
// =============================================================
import { generateJson, json, serveJson } from "../_shared/gemini.ts";

const MAX_PAYLOAD_CHARS = 50_000;

const SYSTEM_PROMPT = `You write the executive summary for a daily site report on a residential flat development in Georgia, prepared by the contractor's project manager. The report's main reader is the client — the company that hired the contractor, given as project.client — together with senior management. The company works internationally and locally, so every report is bilingual: they read it in Georgian or English and want the day's position at a glance. Write as the contractor reporting to its employer: factual and professional, refer to the client by name only where it helps (e.g. a decision or approval needed from them), and never present internal problems as the client's fault unless the data says so.

Write exactly three bullets:
1. Progress — what work was done on site today.
2. Resources — manpower on site and any weather impact.
3. Delays and risks — what was lost, why, and the next action needed.

Each bullet is one or two plain sentences with specific figures from the data. Use only the data provided; if something is missing, say so briefly instead of guessing.

Return the same three bullets twice: "ka" in natural, professional Georgian as used in Georgian construction reporting, and "en" in English. The two versions must state the same facts and figures. Start the Georgian bullets with "პროგრესი:", "რესურსები:" and "შეფერხებები და რისკები:", and the English ones with "Progress:", "Resources:" and "Delays and risks:". Site notes may be in either language — translate their content as needed.`;

// Gemini structured output (OpenAPI-style schema)
const SUMMARY_SCHEMA = {
  type: "OBJECT",
  properties: {
    ka: { type: "ARRAY", items: { type: "STRING" } },
    en: { type: "ARRAY", items: { type: "STRING" } },
  },
  required: ["ka", "en"],
};

const cleanBullets = (list: unknown) =>
  (Array.isArray(list) ? list : [])
    .map((b) => String(b).trim())
    .filter(Boolean)
    .slice(0, 3);

serveJson(async (payload: { date?: string }) => {
  const siteData = JSON.stringify(payload, null, 2);
  if (siteData.length > MAX_PAYLOAD_CHARS) return json({ error: "Report data too large" }, 413);

  const { result, model } = await generateJson({
    systemPrompt: SYSTEM_PROMPT,
    userText: `Site data for ${payload.date ?? "today"}:\n\n${siteData}`,
    schema: SUMMARY_SCHEMA,
  });

  const ka = cleanBullets(result.ka);
  const en = cleanBullets(result.en);
  if (!ka.length || !en.length) return json({ error: "Gemini returned an empty summary" }, 502);
  return json({ ka, en, model });
});
