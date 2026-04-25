import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY")!;

Deno.serve(async (req) => {
  const DIGEST_SECRET = Deno.env.get("WEEKLY_DIGEST_SECRET");
  if (!DIGEST_SECRET) {
    return new Response(JSON.stringify({ error: "Digest secret not configured" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }

  const authHeader = req.headers.get("x-digest-secret");
  if (authHeader !== DIGEST_SECRET) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  try {
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

    const now = new Date();
    const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const twoWeeksAgo = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000);

    // Get all paid users
    const { data: subscriptions } = await supabase
      .from("subscriptions")
      .select("user_id, plan")
      .in("plan", ["starter", "builder", "studio"]);

    if (!subscriptions?.length) {
      return new Response(
        JSON.stringify({ ok: true, sent: 0, failed: 0, skippedErrors: 0 }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    let sent = 0;
    let failed = 0;
    let skippedErrors = 0;

    for (const sub of subscriptions) {
      try {
        // Get user email
        const { data: userData, error: userErr } = await supabase.auth.admin.getUserById(
          sub.user_id,
        );
        const email = userData?.user?.email;
        if (userErr || !email) {
          console.error("[digest] getUserById failed:", userErr, "user_id:", sub.user_id);
          skippedErrors++;
          continue;
        }

        // Get this week's runs
        const { data: thisWeekRuns, error: runsErr } = await supabase
          .from("runs")
          .select("agent, status, cost_usd, duration_ms, anomaly, timestamp, quality_score")
          .eq("user_id", sub.user_id)
          .gte("timestamp", weekAgo.toISOString())
          .order("timestamp", { ascending: false });

        if (runsErr) {
          console.error("[digest] runs query failed:", runsErr);
          skippedErrors++;
          continue;
        }

        if (!thisWeekRuns?.length) continue; // Skip users with no runs

        // Get last week's runs for comparison
        const { data: lastWeekRuns, error: lastWeekErr } = await supabase
          .from("runs")
          .select("agent, status, cost_usd")
          .eq("user_id", sub.user_id)
          .gte("timestamp", twoWeeksAgo.toISOString())
          .lt("timestamp", weekAgo.toISOString());

        if (lastWeekErr) {
          console.error("[digest] last week runs query failed:", lastWeekErr);
          skippedErrors++;
          continue;
        }

        // Compute overall stats
        const totalRuns = thisWeekRuns.length;
        const successRate = Math.round(
          thisWeekRuns.filter((r) => r.status === "success").length / totalRuns * 100,
        );
        const totalCost = thisWeekRuns.reduce((s, r) => s + (r.cost_usd ?? 0), 0);
        const anomalyCount = thisWeekRuns.filter((r) => r.anomaly).length;

        const qualityByAgent: Record<string, { rated: number; good: number }> = {};
        for (const run of thisWeekRuns) {
          const q = run.quality_score;
          const qn = typeof q === "number" ? q : Number(q);
          if (qn !== 1 && qn !== -1) continue;
          const name = run.agent ?? "—";
          if (!qualityByAgent[name]) qualityByAgent[name] = { rated: 0, good: 0 };
          qualityByAgent[name].rated++;
          if (qn === 1) qualityByAgent[name].good++;
        }
        const qualityAgentRows = Object.entries(qualityByAgent)
          .map(([name, s]) => {
            const pct = s.rated > 0 ? Math.round(s.good / s.rated * 100) : 0;
            return `<tr>
            <td style="padding:8px 0;color:#e2e8f0;font-family:monospace">${name}</td>
            <td style="padding:8px 12px;color:${pct >= 80 ? "#4ade80" : pct >= 50 ? "#e2e8f0" : "#f97316"}">${pct}% good outputs (${s.rated} rated)</td>
          </tr>`;
          })
          .join("");

        // Last week comparison
        const lastWeekList = lastWeekRuns ?? [];
        const lastTotal = lastWeekList.length;
        const lastSuccessRate = lastTotal > 0
          ? Math.round(
            lastWeekList.filter((r) => r.status === "success").length / lastTotal * 100,
          )
          : null;
        const lastCost = lastWeekList.reduce((s, r) => s + (r.cost_usd ?? 0), 0);

        // Per-agent breakdown
        const agents: Record<
          string,
          { runs: number; success: number; cost: number; anomalies: number }
        > = {};
        for (const run of thisWeekRuns) {
          if (!agents[run.agent]) {
            agents[run.agent] = { runs: 0, success: 0, cost: 0, anomalies: 0 };
          }
          agents[run.agent].runs++;
          if (run.status === "success") agents[run.agent].success++;
          agents[run.agent].cost += run.cost_usd ?? 0;
          if (run.anomaly) agents[run.agent].anomalies++;
        }

        // Build email HTML
        const successDiff = lastSuccessRate !== null ? successRate - lastSuccessRate : null;
        const costDiff = lastCost > 0 ? ((totalCost - lastCost) / lastCost * 100) : null;

        const agentRows = Object.entries(agents).map(([name, stats]) => {
          const agentSuccessRate = Math.round(stats.success / stats.runs * 100);
          const anomalyText = stats.anomalies > 0
            ? ` · <a href="https://usefarol.dev/app" style="color:#fca5a5;text-decoration:none">⚠ ${stats.anomalies} spike${stats.anomalies > 1 ? "s" : ""}</a>`
            : "";
          return `<tr>
            <td style="padding:8px 0;color:#e2e8f0;font-family:monospace">${name}</td>
            <td style="padding:8px 12px;color:#e2e8f0">${stats.runs}</td>
            <td style="padding:8px 12px;color:${agentSuccessRate >= 80 ? "#4ade80" : "#f97316"}">${agentSuccessRate}%</td>
            <td style="padding:8px 12px;color:#e2e8f0">$${stats.cost.toFixed(6)}${anomalyText}</td>
          </tr>`;
        }).join("");

        // Compute health score per agent
        const agentHealthRows = Object.entries(agents).map(([name, stats]) => {
          const agentSuccessScore = Math.round(stats.success / stats.runs * 100);
          const costScore = Math.max(0, 100 - stats.anomalies * 20);
          const healthTotal = Math.round(agentSuccessScore * 0.55 + costScore * 0.45);
          const color = healthTotal >= 80 ? "#4ade80" : healthTotal >= 50 ? "#f97316" : "#ef4444";
          return `<tr><td style="padding:6px 0;color:#e2e8f0;font-family:monospace">${name}</td><td style="padding:6px 12px;color:${color};font-weight:700">${healthTotal}/100</td></tr>`;
        }).join("");

        const successDiffText = successDiff !== null
          ? `<span style="color:${successDiff >= 0 ? "#4ade80" : "#f97316"}">${successDiff >= 0 ? "↑" : "↓"}${Math.abs(successDiff)}pts vs last week</span>`
          : "";

        const costDiffText = costDiff !== null
          ? `<span style="color:${costDiff <= 0 ? "#4ade80" : "#f97316"}">${costDiff >= 0 ? "↑" : "↓"}${Math.abs(Math.round(costDiff))}% vs last week</span>`
          : "";

        const html = `<!DOCTYPE html>
<html>
<body style="background:#0a0c0f;margin:0;padding:24px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
  <div style="max-width:560px;margin:0 auto">
    <div style="margin-bottom:24px">
      <span style="background:#f97316;color:#fff;padding:4px 10px;border-radius:6px;font-size:13px;font-weight:600">Farol</span>
    </div>
    <h1 style="color:#f1f5f9;font-size:22px;margin:0 0 4px">Weekly digest</h1>
    <p style="color:#94a3b8;font-size:14px;margin:0 0 24px">${weekAgo.toLocaleDateString("en-GB", { day: "numeric", month: "short" })} – ${now.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}</p>

    <div style="background:#111318;border-radius:10px;padding:20px;margin-bottom:16px">
      <table style="width:100%;border-collapse:collapse">
        <tr>
          <td style="padding:0 16px 16px 0;vertical-align:top;width:33%">
            <div style="color:#94a3b8;font-size:11px;text-transform:uppercase;letter-spacing:.08em;margin-bottom:4px">Total runs</div>
            <div style="color:#f1f5f9;font-size:26px;font-weight:700">${totalRuns}</div>
          </td>
          <td style="padding:0 16px 16px 0;vertical-align:top;width:33%">
            <div style="color:#94a3b8;font-size:11px;text-transform:uppercase;letter-spacing:.08em;margin-bottom:4px">Success rate</div>
            <div style="color:${successRate >= 80 ? "#4ade80" : "#f97316"};font-size:26px;font-weight:700">${successRate}%</div>
            ${successDiffText ? `<div style="font-size:12px;margin-top:2px">${successDiffText}</div>` : ""}
          </td>
          <td style="padding:0 0 16px 0;vertical-align:top;width:33%">
            <div style="color:#94a3b8;font-size:11px;text-transform:uppercase;letter-spacing:.08em;margin-bottom:4px">Total cost</div>
            <div style="color:#f97316;font-size:26px;font-weight:700">$${totalCost.toFixed(5)}</div>
            ${costDiffText ? `<div style="font-size:12px;margin-top:2px">${costDiffText}</div>` : ""}
          </td>
        </tr>
      </table>
    </div>

    ${anomalyCount > 0 ? `<div style="background:rgba(239,68,68,0.1);border:1px solid rgba(239,68,68,0.3);border-radius:8px;padding:12px 16px;margin-bottom:16px;color:#fca5a5;font-size:14px">⚠ ${anomalyCount} cost spike${anomalyCount > 1 ? "s" : ""} detected this week</div>` : ""}

    ${qualityAgentRows
      ? `<div style="background:#111318;border-radius:10px;padding:20px;margin-bottom:16px;border:1px solid rgba(96,165,250,0.2)">
      <div style="color:#94a3b8;font-size:11px;text-transform:uppercase;letter-spacing:0.08em;margin-bottom:12px">Output quality (rated this week)</div>
      <table style="width:100%;border-collapse:collapse">
        <tr style="border-bottom:1px solid #1e2530">
          <th style="text-align:left;padding:0 0 8px;color:#64748b;font-size:11px;font-weight:500">AGENT</th>
          <th style="text-align:left;padding:0 12px 8px;color:#64748b;font-size:11px;font-weight:500">QUALITY</th>
        </tr>
        ${qualityAgentRows}
      </table>
    </div>`
      : ""}

    <div style="background:#111318;border-radius:10px;padding:20px;margin-bottom:24px">
      <div style="color:#94a3b8;font-size:11px;text-transform:uppercase;letter-spacing:.08em;margin-bottom:12px">By agent</div>
      <table style="width:100%;border-collapse:collapse">
        <tr style="border-bottom:1px solid #1e2530">
          <th style="text-align:left;padding:0 0 8px;color:#64748b;font-size:11px;font-weight:500">AGENT</th>
          <th style="text-align:left;padding:0 12px 8px;color:#64748b;font-size:11px;font-weight:500">RUNS</th>
          <th style="text-align:left;padding:0 12px 8px;color:#64748b;font-size:11px;font-weight:500">SUCCESS</th>
          <th style="text-align:left;padding:0 12px 8px;color:#64748b;font-size:11px;font-weight:500">COST</th>
        </tr>
        ${agentRows}
      </table>
    </div>

    <div style="background:#111318;border-radius:10px;padding:20px;margin-bottom:16px">
      <div style="color:#94a3b8;font-size:11px;text-transform:uppercase;letter-spacing:.08em;margin-bottom:12px">Agent health scores</div>
      <table style="width:100%;border-collapse:collapse">
        <tr style="border-bottom:1px solid #1e2530">
          <th style="text-align:left;padding:0 0 8px;color:#64748b;font-size:11px;font-weight:500">AGENT</th>
          <th style="text-align:left;padding:0 12px 8px;color:#64748b;font-size:11px;font-weight:500">HEALTH</th>
        </tr>
        ${agentHealthRows}
      </table>
    </div>

    <a href="https://usefarol.dev/app" style="display:inline-block;background:#f97316;color:#fff;text-decoration:none;padding:12px 24px;border-radius:8px;font-weight:600;font-size:15px;margin-bottom:24px">View dashboard →</a>

    <p style="color:#475569;font-size:12px;margin:0">Powered by <a href="https://usefarol.dev" style="color:#f97316;text-decoration:none">Farol</a> · You're receiving this because you have a paid Farol plan. <a href="https://usefarol.dev/settings" style="color:#475569">Account settings</a></p>
  </div>
</body>
</html>`;

        const subject = `Your agents last week: ${successRate}% success · $${totalCost.toFixed(5)} spent`;

        const resendRes = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${RESEND_API_KEY}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            from: "Farol <alerts@usefarol.dev>",
            to: [email],
            subject,
            html,
          }),
        });
        if (!resendRes.ok) {
          const resBody = await resendRes.text().catch(() => "");
          console.error("[digest] Resend failed:", resendRes.status, resBody);
          failed++;
        } else {
          await resendRes.text().catch(() => {});
          sent++;
        }

        // Small delay between emails to avoid rate limits
        await new Promise((resolve) => setTimeout(resolve, 200));
      } catch (userErr) {
        console.error("Error processing user", sub.user_id, userErr);
      }
    }

    return new Response(
      JSON.stringify({ ok: true, sent, failed, skippedErrors }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    );
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
});
