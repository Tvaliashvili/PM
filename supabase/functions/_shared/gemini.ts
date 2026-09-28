// =============================================================
// Shared helpers for the Edge Functions: CORS, auth check and a
// Gemini JSON call with model fallback. GEMINI_API_KEY stays server-side.
// =============================================================
import { createClient } from "npm:@supabase/supabase-js@2";

export const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

/** Supabase client acting as the caller, so row-level security applies to its queries. */
export const userClient = (req: Request) =>
  createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
    { global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } } },
  );

/** Returns an error Response unless the caller is a signed-in user. */
export async function requireUser(req: Request): Promise<Response | null> {
  // The anon key is itself a valid JWT, so require a real signed-in user.
  const { data: { user } } = await userClient(req).auth.getUser();
  return user ? null : json({ error: "Not signed in" }, 401);
}

// Tried in order; the next one is used when a model is overloaded (429/500/503) or retired (404).
// "gemini-flash-latest" tracks Google's current Flash model, so it survives model retirements.
const GEMINI_MODELS = [
  ...new Set([Deno.env.get("GEMINI_MODEL") ?? "gemini-flash-latest", "gemini-3.8-flash", "gemini-3.5-flash"]),
];
const RETRYABLE = new Set([404, 429, 500, 503]);
const geminiUrl = (model: string) =>
  `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

/** A failure with a message safe to show the user and the HTTP status to return. */
export class GeminiError extends Error {
  constructor(message: string, public status: number) {
    super(message);
  }
}

/** Calls Gemini with a response schema and returns the parsed JSON. Throws GeminiError. */
export async function generateJson(
  { systemPrompt, userText, schema, temperature = 0.3, quick = false }:
  { systemPrompt: string; userText: string; schema: unknown; temperature?: number; quick?: boolean },
): Promise<{ result: any; model: string; skipped: string[] }> {
  const apiKey = Deno.env.get("GEMINI_API_KEY");
  if (!apiKey) {
    console.error("GEMINI_API_KEY secret is not set");
    throw new GeminiError("AI service is not configured", 500);
  }

  // quick: simple tasks (e.g. translating a sentence) skip the model's long "thinking" step.
  const request = (lowThinking: boolean) => JSON.stringify({
    systemInstruction: { parts: [{ text: systemPrompt }] },
    contents: [{ role: "user", parts: [{ text: userText }] }],
    generationConfig: {
      temperature,
      responseMimeType: "application/json",
      responseSchema: schema,
      ...(lowThinking ? { thinkingConfig: { thinkingLevel: "low" } } : {}),
    },
  });
  let body = request(quick);

  let res!: Response;
  let data: any = {};
  let model = GEMINI_MODELS[0];
  const skipped: string[] = []; // "model status (ms)" for each failed attempt

  // Two passes over the model list; Gemini's "high demand" 503s are usually brief.
  attempts: for (let pass = 0; pass < 2; pass++) {
    if (pass > 0) await new Promise((r) => setTimeout(r, 2000));
    for (model of GEMINI_MODELS) {
      const started = Date.now();
      res = await fetch(geminiUrl(model), {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
        body,
      });
      data = await res.json().catch(() => ({}));
      if (res.status === 400 && body !== request(false)) {
        // This model doesn't take the thinking setting: ask it again without.
        skipped.push(`${model} 400 thinkingConfig (${Date.now() - started}ms)`);
        body = request(false);
        res = await fetch(geminiUrl(model), {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
          body,
        });
        data = await res.json().catch(() => ({}));
      }
      if (!RETRYABLE.has(res.status)) break attempts;
      console.warn(`Gemini ${model} returned ${res.status}, trying next model`);
      skipped.push(`${model} ${res.status} (${Date.now() - started}ms)`);
    }
  }

  if (!res.ok) {
    console.error(`Gemini API error ${res.status}:`, data?.error?.message, skipped.join("; "));
    // Every model 404s = the names are retired or the GEMINI_MODEL secret is
    // wrong. That is a configuration problem, not a busy service, and saying
    // "try again in a minute" would hide it for good.
    if (res.status === 404) {
      throw new GeminiError(`No Gemini model answered - check GEMINI_MODEL (tried ${GEMINI_MODELS.join(", ")})`, 502);
    }
    if (res.status === 429) {
      throw new GeminiError("Gemini usage limit reached for now - try again later (the free Gemini plan has a daily limit)", 429);
    }
    if (RETRYABLE.has(res.status)) throw new GeminiError("Gemini is busy - try again in a minute", 503);
    if (res.status === 400 || res.status === 403) throw new GeminiError("AI service is not configured correctly", 500);
    throw new GeminiError(`Gemini API error (${res.status})`, 502);
  }

  const candidate = data.candidates?.[0];
  if (data.promptFeedback?.blockReason || candidate?.finishReason === "SAFETY") {
    throw new GeminiError("Gemini declined this request", 422);
  }

  // House style: short hyphens only, so long dashes Gemini writes become "-".
  const text = (candidate?.content?.parts ?? []).map((p: { text?: string }) => p.text ?? "").join("")
    .replace(/[–—]/g, "-");
  try {
    return { result: JSON.parse(text), model, skipped };
  } catch {
    throw new GeminiError("Gemini returned an unreadable answer", 502);
  }
}

/** Standard wrapper: CORS preflight, POST only, signed-in user, JSON body, error mapping. */
export function serveJson(handler: (payload: any, req: Request) => Promise<Response>) {
  Deno.serve(async (req) => {
    if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
    if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

    const denied = await requireUser(req);
    if (denied) return denied;

    let payload: unknown;
    try {
      payload = await req.json();
    } catch {
      return json({ error: "Invalid JSON body" }, 400);
    }

    try {
      return await handler(payload, req);
    } catch (err) {
      if (err instanceof GeminiError) return json({ error: err.message }, err.status);
      console.error(err);
      return json({ error: "Request failed" }, 500);
    }
  });
}
