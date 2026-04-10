import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const RATE_LIMIT_MAX = 10;
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

function generateApiKey(): string {
  return (
    "frl_" +
    Array.from(crypto.getRandomValues(new Uint8Array(18)))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("")
  );
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

  const userId = authData.user.id;

  const rl = checkRateLimit(userId);
  if (!rl.ok) {
    return jsonResponse(
      { success: false, error: "Rate limit exceeded." },
      429,
      { "Retry-After": String(rl.retryAfterSec) },
    );
  }

  const newKey = generateApiKey();

  const { error: deleteError } = await supabase
    .from("api_keys")
    .delete()
    .eq("user_id", userId);

  if (deleteError) {
    return jsonResponse(
      { success: false, error: `Failed to remove old API key: ${deleteError.message}` },
      500,
    );
  }

  const { error: insertError } = await supabase.from("api_keys").insert({
    api_key: newKey,
    user_id: userId,
  });

  if (insertError) {
    return jsonResponse(
      { success: false, error: `Failed to store new API key: ${insertError.message}` },
      500,
    );
  }

  return jsonResponse({ success: true, api_key: newKey }, 200);
});
