// =============================================================
// Supabase Edge Function: daily-summary
// Turns one day's site data into a 3-bullet executive summary via Google Gemini.
// Keeps GEMINI_API_KEY server-side — the browser never sees it.
//
// Deploy:
//   supabase secrets set GEMINI_API_KEY=...
//   supabase functions deploy daily-summary
// =============================================================
import { createClient } from "npm:@supabase/supabase-js@2";

// Tried in order; the next one is used when a model is overloaded (429/500/503) or retired (404).
// "gemini-flash-latest" tracks Google's current Flash model, so it survives model retirements.
const GEMINI_MODELS = [
  ...new Set([Deno.env.get("GEMINI_MODEL") ?? "gemini-flash-latest", "gemini-3.8-flash", "gemini-3.5-flash"]),
];
const RETRYABLE = new Set([404, 429, 500, 503]);
const geminiUrl = (model: string) =>
  `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

const MAX_PAYLOAD_CHARS = 50_000;

const SYSTEM_PROMPT = `You write the executive summary for a daily site report on a residential flat development. The report is read by the client and senior management, who want the day's position at a glance.

Write exactly three bullets:
1. Progress — what work was done on site today.
2. Resources — manpower on site and any weather impact.
3. Delays and risks — what was lost, why, and the next action needed.

Each bullet is one or two plain sentences with specific figures from the data. Use only the data provided; if something is missing, say so briefly instead of guessing.`;

// Gemini structured output (OpenAPI-style schema)
const SUMMARY_SCHEMA = {
  type: "OBJECT",
  properties: {
    bullets: { type: "ARRAY", items: { type: "STRING" } },
  },
  required: ["bullets"],
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  // The anon key is itself a valid JWT, so require a real signed-in user.
  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
    { global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } } },
  );
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return json({ error: "Not signed in" }, 401);

  const apiKey = Deno.env.get("GEMINI_API_KEY");
  if (!apiKey) {
    console.error("GEMINI_API_KEY secret is not set");
    return json({ error: "AI service is not configured" }, 500);
  }

  let payload: { date?: string };
  try {
    payload = await req.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const siteData = JSON.stringify(payload, null, 2);
  if (siteData.length > MAX_PAYLOAD_CHARS) return json({ error: "Report data too large" }, 413);

  const requestBody = JSON.stringify({
    systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
    contents: [
      { role: "user", parts: [{ text: `Site data for ${payload.date ?? "today"}:\n\n${siteData}` }] },
    ],
    generationConfig: {
      temperature: 0.3,
      responseMimeType: "application/json",
      responseSchema: SUMMARY_SCHEMA,
    },
  });

  try {
    let res!: Response;
    let data: any = {};
    let model = GEMINI_MODELS[0];

    for (model of GEMINI_MODELS) {
      res = await fetch(geminiUrl(model), {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
        body: requestBody,
      });
      data = await res.json().catch(() => ({}));
      if (!RETRYABLE.has(res.status)) break;
      console.warn(`Gemini ${model} returned ${res.status}, trying next model`);
    }

    if (!res.ok) {
      console.error(`Gemini API error ${res.status}:`, data?.error?.message);
      if (RETRYABLE.has(res.status)) return json({ error: "Gemini is busy — try again in a minute" }, 503);
      if (res.status === 400 || res.status === 403) return json({ error: "AI service is not configured correctly" }, 500);
      return json({ error: `Gemini API error (${res.status})` }, 502);
    }

    const candidate = data.candidates?.[0];
    if (data.promptFeedback?.blockReason || candidate?.finishReason === "SAFETY") {
      return json({ error: "Gemini declined to summarise this report" }, 422);
    }

    const text = (candidate?.content?.parts ?? []).map((p: { text?: string }) => p.text ?? "").join("");
    const bullets = (JSON.parse(text).bullets as string[])
      .map((b) => b.trim())
      .filter(Boolean)
      .slice(0, 3);

    if (!bullets.length) return json({ error: "Gemini returned an empty summary" }, 502);
    return json({ bullets, model });
  } catch (err) {
    console.error(err);
    return json({ error: "Summary generation failed" }, 500);
  }
});
