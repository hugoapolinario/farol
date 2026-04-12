import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function jsonResponse(
  body: Record<string, unknown>,
  status: number,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return jsonResponse({ success: false, error: "Method not allowed" }, 405);
  }

  try {
    const authHeader = req.headers.get("Authorization") ?? "";
    const jwt = authHeader.replace(/^Bearer\s+/i, "").trim();
    if (!jwt) {
      return jsonResponse({ success: false, error: "Missing authorization" }, 401);
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
    const supabase = createClient(supabaseUrl, serviceKey);

    const { data: { user }, error: userErr } = await supabase.auth.getUser(jwt);
    if (userErr || !user) {
      return jsonResponse({ success: false, error: "Invalid session" }, 401);
    }

    let body: Record<string, unknown>;
    try {
      body = await req.json() as Record<string, unknown>;
    } catch {
      return jsonResponse({ success: false, error: "Invalid JSON body" }, 400);
    }

    const webhookUrlRaw = typeof body.webhook_url === "string" ? body.webhook_url.trim() : "";
    if (!webhookUrlRaw || !webhookUrlRaw.startsWith("https://")) {
      return jsonResponse({ success: false, error: "Invalid webhook URL" }, 400);
    }

    if (body.user_id != null && body.user_id !== user.id) {
      return jsonResponse({ success: false, error: "Forbidden" }, 403);
    }

    const { data: sub, error: subErr } = await supabase
      .from("subscriptions")
      .select("plan, webhook_url")
      .eq("user_id", user.id)
      .maybeSingle();

    if (subErr) {
      return jsonResponse({ success: false, error: subErr.message }, 500);
    }

    const plan = sub?.plan ?? "free";
    if (!["builder", "studio"].includes(plan)) {
      return jsonResponse(
        { success: false, error: "Webhook alerts require Builder or Studio" },
        403,
      );
    }

    const saved = (typeof sub?.webhook_url === "string" && sub.webhook_url.trim()) || "";
    if (saved && saved !== webhookUrlRaw) {
      return jsonResponse(
        { success: false, error: "URL does not match your saved webhook" },
        403,
      );
    }

    const testPayload = {
      event: "test",
      message: "This is a test alert from Farol",
      agent: "your-agent",
      dashboard: "https://usefarol.dev/app",
      timestamp: new Date().toISOString(),
    };

    let webhookRes: Response;
    try {
      webhookRes = await fetch(webhookUrlRaw, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(testPayload),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await supabase.from("subscriptions").update({
        webhook_last_fired_at: new Date().toISOString(),
        webhook_last_status: `failed: ${msg}`,
      }).eq("user_id", user.id);
      return jsonResponse({ success: false, error: msg }, 200);
    }

    const ok = webhookRes.ok;
    const statusLine = ok ? "success" : `failed: ${webhookRes.status}`;
    await supabase.from("subscriptions").update({
      webhook_last_fired_at: new Date().toISOString(),
      webhook_last_status: statusLine,
    }).eq("user_id", user.id);

    if (!ok) {
      return jsonResponse(
        { success: false, error: `HTTP ${webhookRes.status}` },
        200,
      );
    }

    return jsonResponse({ success: true }, 200);
  } catch (err) {
    return jsonResponse({ success: false, error: String(err) }, 500);
  }
});
