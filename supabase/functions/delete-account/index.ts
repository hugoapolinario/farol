import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const RATE_LIMIT_MAX = 3;
const RATE_WINDOW_MS = 60 * 60 * 1000;

type RateBucket = { count: number; resetAt: number };

const rateLimitMap = new Map<string, RateBucket>();

function checkRateLimit(userId: string): { ok: true } | { ok: false; retryAfterSec: number } {
  const now = Date.now();
  let bucket = rateLimitMap.get(userId);
  if (!bucket || now >= bucket.resetAt) {
    bucket = { count: 0, resetAt: now + RATE_WINDOW_MS };
    rateLimitMap.set(userId, bucket);
  }
  if (bucket.count >= RATE_LIMIT_MAX) {
    const retryAfterSec = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
    return { ok: false, retryAfterSec };
  }
  bucket.count += 1;
  return { ok: true };
}

function jsonResponse(
  body: Record<string, unknown>,
  status: number,
  extraHeaders: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json",
      ...extraHeaders,
    },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return jsonResponse({ success: false, error: "Method not allowed" }, 405);
  }

  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return jsonResponse(
      { success: false, error: "Missing or invalid Authorization header" },
      401,
    );
  }

  const jwt = authHeader.slice("Bearer ".length).trim();
  if (!jwt) {
    return jsonResponse({ success: false, error: "Missing JWT" }, 401);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

  if (!supabaseUrl || !serviceRoleKey) {
    return jsonResponse(
      { success: false, error: "Server configuration error" },
      500,
    );
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });

  const { data: authData, error: authError } = await supabase.auth.getUser(jwt);

  if (authError || !authData.user) {
    return jsonResponse(
      {
        success: false,
        error: authError?.message ?? "Invalid or expired session",
      },
      401,
    );
  }

  const user = authData.user;
  const userId = user.id;
  const email = user.email;

  const rl = checkRateLimit(userId);
  if (!rl.ok) {
    return jsonResponse(
      { success: false, error: "Rate limit exceeded." },
      429,
      { "Retry-After": String(rl.retryAfterSec) },
    );
  }

  const { error: spansError } = await supabase
    .from("spans")
    .delete()
    .eq("user_id", userId);

  if (spansError) {
    return jsonResponse(
      { success: false, error: `Failed to delete spans: ${spansError.message}` },
      500,
    );
  }

  const { error: runsError } = await supabase
    .from("runs")
    .delete()
    .eq("user_id", userId);

  if (runsError) {
    return jsonResponse(
      { success: false, error: `Failed to delete runs: ${runsError.message}` },
      500,
    );
  }

  const { error: keysError } = await supabase
    .from("api_keys")
    .delete()
    .eq("user_id", userId);

  if (keysError) {
    return jsonResponse(
      { success: false, error: `Failed to delete API keys: ${keysError.message}` },
      500,
    );
  }

  const { error: deleteUserError } = await supabase.auth.admin.deleteUser(userId);

  if (deleteUserError) {
    return jsonResponse(
      {
        success: false,
        error: `Failed to delete auth user: ${deleteUserError.message}`,
      },
      500,
    );
  }

  const resendKey = Deno.env.get("RESEND_API_KEY");
  if (resendKey && email) {
    try {
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${resendKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: "Farol <noreply@usefarol.dev>",
          to: [email],
          subject: "Your Farol account has been deleted",
          text: "Your Farol account has been deleted",
        }),
      });
      if (!res.ok) {
        const body = await res.text();
        console.error("[delete-account] Resend failed:", res.status, body);
      }
    } catch (e) {
      console.error("[delete-account] Resend error:", e);
    }
  }

  return jsonResponse({ success: true }, 200);
});
