import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY")!;

Deno.serve(async (_req) => {
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
      return new Response(JSON.stringify({ ok: true, sent: 0 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    let sent = 0;

    for (const sub of subscriptions) {
      try {
        // Get user email
        const { data: userData } = await supabase.auth.admin.getUserById(sub.user_id);
        const email = userData?.user?.email;
        if (!email) continue;

        // Get this week's runs
        const { data: thisWeekRuns } = await supabase
          .from("runs")
          .select("agent, status, cost_usd, duration_ms, anomaly, timestamp")
          .eq("user_id", sub.user_id)
          .gte("timestamp", weekAgo.toISOString())
          .order("timestamp", { ascending: false });

        if (!thisWeekRuns?.length) continue; // Skip users with no runs

        // Get last week's runs for comparison
        const { data: lastWeekRuns } = await supabase
          .from("runs")
          .select("agent, status, cost_usd")
          .eq("user_id", sub.user_id)
          .gte("timestamp", twoWeeksAgo.toISOString())
          .lt("timestamp", weekAgo.toISOString());

        // Compute overall stats
        const totalRuns = thisWeekRuns.length;
        const successRate = Math.round(
          thisWeekRuns.filter((r) => r.status === "success").length / totalRuns * 100,
        );
        const totalCost = thisWeekRuns.reduce((s, r) => s + (r.cost_usd ?? 0), 0);
        const anomalyCount = thisWeekRuns.filter((r) => r.anomaly).length;

        // Last week comparison
        const lastTotal = lastWeekRuns?.length ?? 0;
        const lastSuccessRate = lastTotal > 0
          ? Math.round(
            lastWeekRuns!.filter((r) => r.status === "success").length / lastTotal * 100,
          )
          : null;
        const lastCost = lastWeekRuns?.reduce((s, r) => s + (r.cost_usd ?? 0), 0) ?? 0;

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
        await resendRes.text().catch(() => {});

        sent++;

        // Small delay between emails to avoid rate limits
        await new Promise((resolve) => setTimeout(resolve, 200));
      } catch (userErr) {
        console.error("Error processing user", sub.user_id, userErr);
      }
    }

    return new Response(JSON.stringify({ ok: true, sent }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
});
