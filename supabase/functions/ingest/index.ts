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

function asNumberRecord(val: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (!val || typeof val !== "object" || Array.isArray(val)) return out;
  for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
    const n = typeof v === "number" ? v : Number(v);
    if (Number.isFinite(n)) out[k] = n;
  }
  return out;
}

function asBooleanRecord(val: unknown): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  if (!val || typeof val !== "object" || Array.isArray(val)) return out;
  for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
    out[k] = Boolean(v);
  }
  return out;
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
      .select(
        "plan, event_count, agent_names, period_start, webhook_url, budget_limits, monthly_cost_usd, budget_period_start, budget_alerted",
      )
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

    let monthlyCostMap = asNumberRecord(sub?.monthly_cost_usd);
    let budgetAlertedMap = asBooleanRecord(sub?.budget_alerted);
    if (sub) {
      const firstOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
      const budgetPeriodStart = sub.budget_period_start
        ? new Date(sub.budget_period_start as string)
        : null;
      if (!budgetPeriodStart) {
        await supabase.from("subscriptions").update({
          budget_period_start: firstOfMonth,
        }).eq("user_id", userId);
      } else if (
        budgetPeriodStart.getMonth() !== now.getMonth() ||
        budgetPeriodStart.getFullYear() !== now.getFullYear()
      ) {
        await supabase.from("subscriptions").update({
          monthly_cost_usd: {},
          budget_alerted: {},
          budget_period_start: firstOfMonth,
        }).eq("user_id", userId);
        monthlyCostMap = {};
        budgetAlertedMap = {};
      }
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

    if (agentName) {
      const runCost = typeof run.cost_usd === "number"
        ? run.cost_usd
        : Number(run.cost_usd) || 0;
      const currentMonthlyCost = monthlyCostMap[agentName] ?? 0;
      const newMonthlyCost = currentMonthlyCost + runCost;
      const budgetLimits = asNumberRecord(sub?.budget_limits);
      const agentBudget = budgetLimits[agentName];

      if (
        agentBudget != null &&
        agentBudget > 0 &&
        newMonthlyCost >= agentBudget &&
        !budgetAlertedMap[agentName]
      ) {
        console.log(
          "[budget alert] threshold exceeded for",
          agentName,
          "spent:",
          newMonthlyCost,
          "limit:",
          agentBudget,
        );

        const resendKey = Deno.env.get("RESEND_API_KEY");
        if (resendKey) {
          const { data: userData } = await supabase.auth.admin.getUserById(userId);
          const userEmail = userData?.user?.email;
          if (userEmail) {
            console.log("[budget alert] sending email to", userEmail);
            try {
              const emailRes = await fetch("https://api.resend.com/emails", {
                method: "POST",
                headers: {
                  Authorization: `Bearer ${resendKey}`,
                  "Content-Type": "application/json",
                },
                body: JSON.stringify({
                  from: "Farol <alerts@usefarol.dev>",
                  to: [userEmail],
                  subject:
                    `[Farol] Budget alert — ${agentName} exceeded $${agentBudget}`,
                  text:
                    `Your agent "${agentName}" has exceeded its monthly budget of $${agentBudget}.\n\nSpent this month: $${newMonthlyCost.toFixed(6)}\n\nView your dashboard: https://usefarol.dev/app`,
                }),
              });
              console.log("[budget alert] email result:", emailRes.status);
              await emailRes.text().catch(() => {});
            } catch (e) {
              console.error("[budget alert] email fetch error:", e);
            }
          }
        }

        const wh = typeof sub?.webhook_url === "string"
          ? sub.webhook_url.trim()
          : "";
        if (wh && ["builder", "studio"].includes(plan)) {
          console.log("[budget alert] sending webhook");
          try {
            const webhookRes = await fetch(wh, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                event: "budget_exceeded",
                agent: agentName,
                budget_usd: agentBudget,
                spent_usd: newMonthlyCost,
                dashboard: "https://usefarol.dev/app",
              }),
            });
            console.log("[budget alert] webhook result:", webhookRes.status);
            await webhookRes.text().catch(() => {});
          } catch (e) {
            console.error("[budget alert] webhook fetch error:", e);
          }
        }

        budgetAlertedMap[agentName] = true;
      }

      monthlyCostMap[agentName] = newMonthlyCost;
      await supabase.from("subscriptions").update({
        monthly_cost_usd: monthlyCostMap,
        budget_alerted: budgetAlertedMap,
      }).eq("user_id", userId);
    }

    const webhookUrl =
      typeof sub?.webhook_url === "string" ? sub.webhook_url.trim() : "";
    if (webhookUrl && ["builder", "studio"].includes(plan) && run.anomaly) {
      const tsVal = run.timestamp;
      const webhookPayload = {
        event: "cost_anomaly",
        agent: run.agent,
        topic: run.topic ?? null,
        reason: run.anomaly_reason ?? null,
        cost_usd: run.cost_usd ?? null,
        timestamp:
          typeof tsVal === "string" && tsVal
            ? tsVal
            : new Date().toISOString(),
        dashboard: "https://usefarol.dev/app",
      };

      try {
        const webhookRes = await fetch(webhookUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(webhookPayload),
        });

        await supabase.from("subscriptions").update({
          webhook_last_fired_at: new Date().toISOString(),
          webhook_last_status: webhookRes.ok
            ? "success"
            : `failed: ${webhookRes.status}`,
        }).eq("user_id", userId);
      } catch (err) {
        await supabase.from("subscriptions").update({
          webhook_last_fired_at: new Date().toISOString(),
          webhook_last_status: `failed: ${String(err)}`,
        }).eq("user_id", userId);
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
