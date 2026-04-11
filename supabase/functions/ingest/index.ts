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
    const rawBody = await req.text();
    if (rawBody.length > 1_048_576) {
      return new Response(
        JSON.stringify({
          success: false,
          error: "Payload too large. Maximum size is 1MB.",
        }),
        {
          status: 413,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }
    const body = JSON.parse(rawBody) as Record<string, unknown>;
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

    const userId = keyData.user_id;

    // ── Fetch subscription ────────────────────────────────────────────
    const { data: sub } = await supabase
      .from("subscriptions")
      .select("plan, event_count, agent_names, period_start")
      .eq("user_id", userId)
      .single();

    // Provision a free-tier row for first-time users
    if (!sub) {
      await supabase.from("subscriptions").insert({
        user_id: userId,
        plan: "free",
        status: "active",
        event_count: 0,
        agent_names: [],
        period_start: new Date().toISOString(),
      });
    }

    // ── Plan limits ───────────────────────────────────────────────────
    const plan = sub?.plan ?? "free";
    const LIMITS: Record<string, { agents: number; events: number }> = {
      free:    { agents: 1,        events: 50_000 },
      starter: { agents: 3,        events: 300_000 },
      builder: { agents: Infinity, events: 1_000_000 },
      studio:  { agents: Infinity, events: 1_000_000 },
    };
    const limit = LIMITS[plan] ?? LIMITS.free;

    // ── Billing period reset ──────────────────────────────────────────
    const periodStart = sub?.period_start ? new Date(sub.period_start) : new Date();
    const now = new Date();
    const isNewPeriod =
      now.getMonth() !== periodStart.getMonth() ||
      now.getFullYear() !== periodStart.getFullYear();

    let currentEvents = sub?.event_count ?? 0;
    let currentAgents: string[] = sub?.agent_names ?? [];

    if (isNewPeriod) {
      const firstOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
      await supabase
        .from("subscriptions")
        .update({ event_count: 0, agent_names: [], period_start: firstOfMonth })
        .eq("user_id", userId);
      currentEvents = 0;
      currentAgents = [];
    }

    // ── Agent limit check ─────────────────────────────────────────────
    const agentName = typeof run.agent === "string" ? run.agent : "";
    const isNewAgent = agentName !== "" && !currentAgents.includes(agentName);

    if (isNewAgent && currentAgents.length >= limit.agents) {
      return new Response(
        JSON.stringify({
          success: false,
          error: `Agent limit reached. Your ${plan} plan allows ${limit.agents} agent(s). Upgrade at https://usefarol.dev/settings`,
        }),
        { status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ── Event limit check ─────────────────────────────────────────────
    const spanCount = spans.length > 0 ? spans.length : 1;
    if (currentEvents + spanCount > limit.events) {
      return new Response(
        JSON.stringify({
          success: false,
          error: `Event limit reached. Your ${plan} plan allows ${limit.events.toLocaleString()} events/month. Upgrade at https://usefarol.dev/settings`,
        }),
        { status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ── Insert run ────────────────────────────────────────────────────
    const { error: insertError } = await supabase
      .from("runs")
      .insert({ ...run, user_id: userId });

    if (insertError) {
      return new Response(
        JSON.stringify({ success: false, error: insertError.message }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (spans.length > 0 && run.id != null) {
      const spansToInsert = (spans as Record<string, unknown>[]).map((s) => {
        let metadata: unknown = s.metadata ?? {};
        if (metadata != null && typeof metadata === "object") {
          try {
            if (JSON.stringify(metadata).length > 10000) {
              metadata = { truncated: true, reason: "metadata too large" };
            }
          } catch {
            metadata = { truncated: true, reason: "metadata too large" };
          }
        }

        let inputVal: unknown = s.input ?? null;
        if (inputVal != null) {
          const str =
            typeof inputVal === "string"
              ? inputVal
              : (() => {
                  try {
                    return JSON.stringify(inputVal);
                  } catch {
                    return String(inputVal);
                  }
                })();
          if (str.length > 50000) {
            inputVal = str.slice(0, 50000) + "... [truncated]";
          }
        }

        let outputVal: unknown = s.output ?? null;
        if (outputVal != null) {
          const str =
            typeof outputVal === "string"
              ? outputVal
              : (() => {
                  try {
                    return JSON.stringify(outputVal);
                  } catch {
                    return String(outputVal);
                  }
                })();
          if (str.length > 50000) {
            outputVal = str.slice(0, 50000) + "... [truncated]";
          }
        }

        return {
          id: crypto.randomUUID(),
          name: s.name,
          type: s.type ?? "tool",
          started_at: s.started_at,
          ended_at: s.ended_at,
          duration_ms: s.duration_ms,
          input_tokens: s.input_tokens ?? null,
          output_tokens: s.output_tokens ?? null,
          cost_usd: s.cost_usd ?? null,
          metadata,
          error: s.error ?? null,
          input: inputVal,
          output: outputVal,
          run_id: run.id,
          user_id: keyData.user_id,
        };
      });

      const { error: spansBulkError } = await supabase
        .from("spans")
        .insert(spansToInsert);

      if (spansBulkError) {
        console.error(
          "[ingest] Span bulk insert failed:",
          spansBulkError.message,
          spansBulkError,
        );
      }
    }

    // ── Update usage counters ─────────────────────────────────────────
    const updatedAgents = isNewAgent ? [...currentAgents, agentName] : currentAgents;
    await supabase.from("subscriptions").upsert({
      user_id: userId,
      event_count: currentEvents + spanCount,
      agent_names: updatedAgents,
      updated_at: new Date().toISOString(),
    }, { onConflict: "user_id" });

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
