// =============================================================
// Supabase Edge Function: manage-users
// Adds, invites and removes accounts from the app's Users & access, for the
// administrator alone. These need Supabase's service key, which never leaves
// this function.
//
//   invite { email, name, redirectTo }       Supabase emails an invitation
//   create { email, name, password }         a ready account, no email sent
//   link   { email, name, redirectTo }       a one-time link to send by hand:
//                                            an invitation for a new address,
//                                            a "choose your password" link
//                                            for one already there
//   delete { userId }                        the account and its access
//
// Deploy: supabase functions deploy manage-users
// =============================================================
import { createClient } from "npm:@supabase/supabase-js@2";
import { json, serveJson, userClient } from "../_shared/gemini.ts";

const ADMIN_EMAIL = "st@cpmgroup.ge";
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const admin = () => createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { autoRefreshToken: false, persistSession: false } },
);

// The name where the Supabase dashboard and the app both read it.
const named = (name?: string) => (name?.trim()
  ? { full_name: name.trim(), name: name.trim(), display_name: name.trim() }
  : {});

serveJson(async (payload: {
  action?: string; email?: string; name?: string; password?: string; redirectTo?: string; userId?: string;
}, req: Request) => {
  const { data: { user } } = await userClient(req).auth.getUser();
  if (user?.email?.toLowerCase() !== ADMIN_EMAIL) return json({ error: "Only the administrator manages accounts" }, 403);

  const sb = admin().auth.admin;
  const email = (payload.email ?? "").trim().toLowerCase();
  const redirectTo = payload.redirectTo;

  switch (payload.action) {
    case "invite": {
      if (!EMAIL.test(email)) return json({ error: "Enter a valid email address" }, 400);
      const { data, error } = await sb.inviteUserByEmail(email, { data: named(payload.name), redirectTo });
      if (error) return json({ error: error.message }, 400);
      return json({ id: data.user?.id });
    }
    case "create": {
      if (!EMAIL.test(email)) return json({ error: "Enter a valid email address" }, 400);
      if ((payload.password ?? "").length < 6) return json({ error: "The password needs at least 6 characters" }, 400);
      const { data, error } = await sb.createUser({
        email, password: payload.password, email_confirm: true, user_metadata: named(payload.name),
      });
      if (error) return json({ error: error.message }, 400);
      return json({ id: data.user?.id });
    }
    case "link": {
      if (!EMAIL.test(email)) return json({ error: "Enter a valid email address" }, 400);
      // A new address gets an invitation; one already there, a link to choose a password.
      const invite = await sb.generateLink({ type: "invite", email, options: { data: named(payload.name), redirectTo } });
      if (!invite.error) return json({ link: invite.data.properties?.action_link, kind: "invite" });
      const reset = await sb.generateLink({ type: "recovery", email, options: { redirectTo } });
      if (reset.error) return json({ error: reset.error.message }, 400);
      return json({ link: reset.data.properties?.action_link, kind: "recovery" });
    }
    case "delete": {
      if (!payload.userId) return json({ error: "No account given" }, 400);
      if (payload.userId === user.id) return json({ error: "The administrator's own account cannot be deleted here" }, 400);
      const { error } = await sb.deleteUser(payload.userId);
      if (error) return json({ error: error.message }, 400);
      return json({ deleted: true });
    }
    default:
      return json({ error: "Unknown action" }, 400);
  }
});
