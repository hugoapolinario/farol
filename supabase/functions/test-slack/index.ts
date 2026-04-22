const rateLimitMap = new Map<string, number[]>();

function isRateLimited(ip: string): boolean {
  const now = Date.now();
  const windowMs = 60 * 60 * 1000;
  const maxRequests = 10;
  const timestamps = (rateLimitMap.get(ip) ?? []).filter((t) => now - t < windowMs);
  if (timestamps.length >= maxRequests) return true;
  timestamps.push(now);
  rateLimitMap.set(ip, timestamps);
  return false;
}

Deno.serve(async (req) => {
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, content-type",
  };

  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  const ip = req.headers.get("x-forwarded-for") ??
    req.headers.get("cf-connecting-ip") ??
    "unknown";

  if (isRateLimited(ip)) {
    return new Response(JSON.stringify({ error: "Too many requests" }), {
      status: 429,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  try {
    const { slack_url } = await req.json();
    if (!slack_url) {
      return new Response(JSON.stringify({ error: "No Slack URL provided" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const res = await fetch(slack_url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        blocks: [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: "*Farol test message* ✓\nYour Slack integration is working.",
            },
          },
        ],
      }),
    });

    if (res.ok) {
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    } else {
      const body = await res.text();
      return new Response(
        JSON.stringify({ error: `Slack returned ${res.status}: ${body}` }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
