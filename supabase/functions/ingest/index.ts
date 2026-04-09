import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const RATE_LIMIT_MAX = 100;
const RATE_WINDOW_MS = 60 * 60 * 1000;

type RateBucket = { count: number; resetAt: number };

const rateLimitMap = new Map<string, RateBucket>();

function rateLimitKey(body: Record<string, unknown>, req: Request): string {
  const fk = body.farol_key;
  if (typeof fk === "string" && fk.trim() !== "") {
    return `key:${fk}`;
  }
  const xf = req.headers.get("x-forwarded-for");
  if (xf) {
    const first = xf.split(",")[0]?.trim();
    if (first) return `ip:${first}`;
  }
  return "ip:unknown";
}

function checkRateLimit(key: string): { ok: true } | { ok: false; retryAfterSec: number } {
  const now = Date.now();
  let bucket = rateLimitMap.get(key);
  if (!bucket || now >= bucket.resetAt) {
    bucket = { count: 0, resetAt: now + RATE_WINDOW_MS };
    rateLimitMap.set(key, bucket);
  }
  if (bucket.count >= RATE_LIMIT_MAX) {
    const retryAfterSec = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
    return { ok: false, retryAfterSec };
  }
  bucket.count += 1;
  return { ok: true };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const body = await req.json() as Record<string, unknown>;
    const rl = checkRateLimit(rateLimitKey(body, req));
    if (!rl.ok) {
      return new Response(
        JSON.stringify({
          success: false,
          error: "Rate limit exceeded. Max 100 requests per hour.",
        }),
        {
          status: 429,
          headers: {
            ...corsHeaders,
            "Content-Type": "application/json",
            "Retry-After": String(rl.retryAfterSec),
          },
        }
      );
    }

    const { farol_key, spans: rawSpans, ...run } = body as {
      farol_key?: string;
      spans?: unknown;
      [key: string]: unknown;
    };
    const spans = Array.isArray(rawSpans) ? rawSpans : [];

    if (!farol_key) {
      return new Response(
        JSON.stringify({ success: false, error: "Missing farol_key" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
    );

    const { data: keyData, error: keyError } = await supabase
      .from("api_keys")
      .select("user_id")
      .eq("api_key", farol_key)
      .single();

    if (keyError || !keyData) {
      return new Response(
        JSON.stringify({ success: false, error: "Invalid API key" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const { error: insertError } = await supabase
      .from("runs")
      .insert({ ...run, user_id: keyData.user_id });

    if (insertError) {
      return new Response(
        JSON.stringify({ success: false, error: insertError.message }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (spans.length > 0 && run.id != null) {
      for (const span of spans) {
        const s = span as Record<string, unknown>;
        const { error: spanError } = await supabase.from("spans").insert({
          id: s.id,
          name: s.name,
          type: s.type ?? "tool",
          started_at: s.started_at,
          ended_at: s.ended_at,
          duration_ms: s.duration_ms,
          input_tokens: s.input_tokens ?? null,
          output_tokens: s.output_tokens ?? null,
          cost_usd: s.cost_usd ?? null,
          metadata: s.metadata ?? {},
          error: s.error ?? null,
          input: s.input ?? null,
          output: s.output ?? null,
          run_id: run.id,
          user_id: keyData.user_id,
        });
        if (spanError) {
          console.error("[ingest] Span insert failed:", spanError.message, span);
        }
      }
    }

    return new Response(
      JSON.stringify({ success: true }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );

  } catch (err) {
    return new Response(
      JSON.stringify({ success: false, error: String(err) }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
