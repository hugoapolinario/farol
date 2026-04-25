import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ONBOARDING_EMAIL_SECRET = Deno.env.get("ONBOARDING_EMAIL_SECRET");

const welcomeEmail = (email: string) => ({
  from: "Farol <alerts@usefarol.dev>",
  to: [email],
  subject: "Welcome to Farol — get your first run tracked in 5 minutes",
  html: `
    <div style="font-family:sans-serif;max-width:520px;margin:0 auto;color:#e2e8f0;background:#0f1117;padding:32px;border-radius:12px">
      <img src="https://usefarol.dev/frontend/assets/logo.svg" alt="Farol" height="28" style="margin-bottom:24px">
      <h2 style="color:#f1f5f9;margin:0 0 12px">Welcome to Farol 👋</h2>
      <p style="color:#94a3b8;line-height:1.6">You're one decorator away from monitoring your first agent.</p>
      <div style="background:#1e2530;border-radius:8px;padding:16px;margin:20px 0;font-family:monospace;font-size:13px;color:#86efac">
        pip install farol-sdk
      </div>
      <p style="color:#94a3b8;line-height:1.6">Then wrap your agent:</p>
      <div style="background:#1e2530;border-radius:8px;padding:16px;margin:20px 0;font-family:monospace;font-size:13px;color:#f1f5f9">
        @trace(agent_name="my-agent", farol_key="<span style='color:#f97316'>your_key_here</span>")<br>
        def my_agent(task, run=None):<br>
        &nbsp;&nbsp;&nbsp;&nbsp;# your agent code here
      </div>
      <p style="color:#94a3b8;line-height:1.6">Get your API key from your dashboard and you're done.</p>
      <a href="https://usefarol.dev/settings" style="display:inline-block;background:#f97316;color:#fff;padding:10px 20px;border-radius:6px;text-decoration:none;font-weight:600;margin:8px 0">Get your API key →</a>
      <p style="color:#475569;font-size:12px;margin-top:32px">Need help? Reply to this email or check the <a href="https://usefarol.dev/docs" style="color:#f97316">docs</a>.</p>
    </div>
  `,
});

const followupEmail = (email: string) => ({
  from: "Farol <alerts@usefarol.dev>",
  to: [email],
  subject: "Did you get Farol working? (quick question)",
  html: `
    <div style="font-family:sans-serif;max-width:520px;margin:0 auto;color:#e2e8f0;background:#0f1117;padding:32px;border-radius:12px">
      <img src="https://usefarol.dev/frontend/assets/logo.svg" alt="Farol" height="28" style="margin-bottom:24px">
      <h2 style="color:#f1f5f9;margin:0 0 12px">Quick question 👋</h2>
      <p style="color:#94a3b8;line-height:1.6">Did you manage to get your first agent run tracked in Farol?</p>
      <p style="color:#94a3b8;line-height:1.6">If yes — great! Your dashboard should be showing runs, costs, and traces automatically.</p>
      <p style="color:#94a3b8;line-height:1.6">If not — I'd love to know what got in the way. Just reply to this email and I'll help you get set up personally.</p>
      <a href="https://usefarol.dev/app" style="display:inline-block;background:#f97316;color:#fff;padding:10px 20px;border-radius:6px;text-decoration:none;font-weight:600;margin:8px 0">Open your dashboard →</a>
      <p style="color:#94a3b8;line-height:1.6;margin-top:20px">Also — if you have 2 minutes, I'd love to hear what you're building. What kind of agent are you working on?</p>
      <p style="color:#475569;font-size:12px;margin-top:32px">— Hugo, founder of Farol</p>
    </div>
  `,
});

Deno.serve(async (req) => {
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, content-type, apikey, x-client-info, x-onboarding-secret",
  };

  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  try {
    const body = await req.json() as { email?: string; user_id?: string; event?: string };
    const { email, user_id, event } = body;
    console.log("Starting onboarding email", { email, user_id, event });

    if (!RESEND_API_KEY || !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
      return new Response(
        JSON.stringify({ error: "Server misconfiguration" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    if (ONBOARDING_EMAIL_SECRET) {
      const h = req.headers.get("x-onboarding-secret");
      if (h !== ONBOARDING_EMAIL_SECRET) {
        return new Response(
          JSON.stringify({ error: "Unauthorized" }),
          { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
    }

    if (!event || !user_id) {
      return new Response(
        JSON.stringify({ error: "Missing user_id or event" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    if (event !== "welcome" && event !== "followup") {
      return new Response(
        JSON.stringify({ error: "event must be \"welcome\" or \"followup\"" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    const { data: authData, error: authErr } = await supabase.auth.admin.getUserById(user_id);
    if (authErr || !authData.user) {
      return new Response(
        JSON.stringify({ error: "User not found" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const authUser = authData.user;
    const canonicalEmail = authUser.email;
    if (!canonicalEmail) {
      return new Response(
        JSON.stringify({ error: "User has no email" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }
    if (!authUser.email_confirmed_at) {
      return new Response(
        JSON.stringify({ error: "Email not confirmed" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }
    if (email && email.trim().toLowerCase() !== canonicalEmail.trim().toLowerCase()) {
      return new Response(
        JSON.stringify({ error: "email does not match user_id" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const { data: subRow, error: subErr } = await supabase
      .from("subscriptions")
      .select("user_id")
      .eq("user_id", user_id)
      .maybeSingle();

    if (subErr || !subRow) {
      return new Response(
        JSON.stringify({ error: "No subscription for this user" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const toEmail = canonicalEmail;
    const payload = event === "welcome" ? welcomeEmail(toEmail) : followupEmail(toEmail);

    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const err = await res.text();
      return new Response(
        JSON.stringify({ error: err }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const column = event === "welcome" ? "welcome_email_sent_at" : "followup_email_sent_at";
    const patchRes = await fetch(
      `${SUPABASE_URL}/rest/v1/subscriptions?user_id=eq.${encodeURIComponent(user_id)}`,
      {
        method: "PATCH",
        headers: {
          apikey: SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
          "Content-Type": "application/json",
          Prefer: "return=minimal",
        },
        body: JSON.stringify({ [column]: new Date().toISOString() }),
      },
    );

    if (!patchRes.ok) {
      const err = await patchRes.text();
      return new Response(
        JSON.stringify({ error: `Resend ok but DB update failed: ${err}` }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    return new Response(
      JSON.stringify({ ok: true }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (err) {
    console.error("Onboarding email error:", err);
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
