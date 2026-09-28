// =============================================================
// Supabase Edge Function: photo-url
// Signs Cloudflare R2 URLs so the browser can put, read and delete photos
// without ever holding the R2 credentials.
//
// The bucket stays private: every link is signed and expires within the hour.
//
// Deploy:
//   supabase secrets set R2_ACCOUNT_ID=... R2_BUCKET=site-photos \
//     R2_ACCESS_KEY_ID=... R2_SECRET_ACCESS_KEY=...
//   supabase functions deploy photo-url
// =============================================================
import { json, serveJson } from "../_shared/gemini.ts";
import { AwsClient } from "npm:aws4fetch@1.0.20";

const EXPIRES = 3600;   // seconds a signed link stays valid
const MAX_PATHS = 48;   // a day's photos is 12, each with a thumbnail

serveJson(async (payload: { paths?: string[]; method?: string }) => {
  const account = Deno.env.get("R2_ACCOUNT_ID");
  const bucket = Deno.env.get("R2_BUCKET");
  const accessKeyId = Deno.env.get("R2_ACCESS_KEY_ID");
  const secretAccessKey = Deno.env.get("R2_SECRET_ACCESS_KEY");
  if (!account || !bucket || !accessKeyId || !secretAccessKey) {
    console.error("R2 secrets are not set");
    return json({ error: "Photo storage is not configured" }, 500);
  }

  // A secret pasted with a stray space or quote builds a hostname with nothing
  // before the dot, and the browser fails on DNS with no useful message. Say it
  // here instead.
  if (!/^[0-9a-f]{32}$/.test(account.trim())) {
    console.error("R2_ACCOUNT_ID is not a 32-character account id");
    return json({ error: "R2_ACCOUNT_ID is not set correctly - check the Supabase secret" }, 500);
  }

  const method = payload.method === "PUT" || payload.method === "DELETE" ? payload.method : "GET";
  // A path is built by the app from ids it already holds; anything that tries
  // to climb out of the project's own folder is refused outright.
  const paths = (payload.paths ?? [])
    .filter((p) => typeof p === "string" && p.length > 0 && !p.includes("..") && !p.startsWith("/"));
  if (!paths.length) return json({ error: "No paths given" }, 400);
  if (paths.length > MAX_PATHS) return json({ error: "Too many photos in one request" }, 413);

  const client = new AwsClient({ accessKeyId, secretAccessKey, service: "s3", region: "auto" });
  const urls = await Promise.all(paths.map(async (path) => {
    const url = new URL(`https://${account.trim()}.r2.cloudflarestorage.com/${bucket.trim()}/${path}`);
    url.searchParams.set("X-Amz-Expires", String(EXPIRES));
    const signed = await client.sign(new Request(url, { method }), { aws: { signQuery: true } });
    return signed.url;
  }));

  return json({ urls });
});
