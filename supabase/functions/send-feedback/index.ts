const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");

const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const rateLimitMap = new Map<string, number[]>();

function isRateLimited(ip: string): boolean {
  const now = Date.now();
  const windowMs = 60 * 60 * 1000; // 1 hour
  const maxRequests = 10; // max 10 feedback submissions per hour per IP

  const timestamps = (rateLimitMap.get(ip) ?? []).filter((t) => now - t < windowMs);
  if (timestamps.length >= maxRequests) return true;
  timestamps.push(now);
  rateLimitMap.set(ip, timestamps);
  return false;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: corsHeaders,
    });
  }

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  if (!RESEND_API_KEY) {
    console.error("[send-feedback] Missing RESEND_API_KEY");
    return new Response(JSON.stringify({ error: "Server misconfiguration" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
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
    const { category, subject, message, email } = await req.json();

    if (!category || !subject || !message) {
      return new Response(JSON.stringify({ error: "Missing required fields" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const categoryLabel = category === "bug"
      ? "Bug"
      : category === "feature"
      ? "Feature"
      : "Feedback";
    const emailSubject = `[${categoryLabel}] ${subject}`;

    const confirmationBody = category === "bug"
      ? `Hi,\n\nThanks for the report — we'll look into it and fix it as soon as possible.\n\n— Farol`
      : category === "feature"
      ? `Hi,\n\nThanks for the suggestion! We read every request and use them to shape what we build next.\n\n— Farol`
      : `Hi,\n\nThanks for taking the time to share your thoughts — it genuinely helps us improve Farol.\n\n— Farol`;

    const supportRes = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: "Farol <alerts@usefarol.dev>",
        to: ["hfaworkz@gmail.com"],
        reply_to: email || undefined,
        subject: emailSubject,
        text:
          `Category: ${categoryLabel}\nFrom: ${email || "anonymous"}\n\n${message}`,
      }),
    });

    if (!supportRes.ok) {
      const errText = await supportRes.text();
      console.error("[send-feedback] Resend (support):", supportRes.status, errText);
      return new Response(
        JSON.stringify({ error: "Failed to send message" }),
        { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    if (email) {
      const confirmRes = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${RESEND_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: "Farol <alerts@usefarol.dev>",
          to: [email],
          subject: "We got your feedback",
          text: confirmationBody,
        }),
      });
      if (!confirmRes.ok) {
        const errText = await confirmRes.text();
        console.error("[send-feedback] Resend (confirm):", confirmRes.status, errText);
        return new Response(
          JSON.stringify({ ok: true, confirmationEmailSent: false }),
          { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({ ok: true, confirmationEmailSent: true }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    return new Response(
      JSON.stringify({ ok: true, confirmationEmailSent: true }),
      {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
