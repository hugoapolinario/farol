import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { crypto } from "https://deno.land/std@0.177.0/crypto/mod.ts";

const SIGNING_SECRET = Deno.env.get("LEMONSQUEEZY_WEBHOOK_SECRET")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const VARIANT_PLAN_MAP: Record<string, string> = {
  "1515272": "starter",
  "1515252": "builder",
  "1515290": "studio",
};

Deno.serve(async (req) => {
  const rawBody = await req.text();
  const signature = req.headers.get("x-signature") ?? "";

  // Verify webhook signature
  if (SIGNING_SECRET) {
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(SIGNING_SECRET),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"],
    );
    const sigBytes = hexToBytes(signature);
    const bodyBytes = new TextEncoder().encode(rawBody);
    const valid = await crypto.subtle.verify("HMAC", key, sigBytes, bodyBytes);
    if (!valid) {
      return new Response(JSON.stringify({ error: "Invalid signature" }), { status: 401 });
    }
  }

  const event = JSON.parse(rawBody);
  const eventName = event.meta?.event_name;
  const data = event.data?.attributes;
  const meta = event.meta?.custom_data;

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

  // user_id is passed via custom_data during Lemon Squeezy checkout
  const userId = meta?.user_id;
  if (!userId) return new Response(JSON.stringify({ error: "No user_id" }), { status: 400 });

  const variantId = String(data?.variant_id);
  const plan = VARIANT_PLAN_MAP[variantId] ?? "starter";
  const lsSubscriptionId = String(event.data?.id);
  const lsCustomerId = String(data?.customer_id);
  const currentPeriodEndsAt = data?.ends_at ?? data?.renews_at ?? null;

  if (
    ["subscription_created", "subscription_updated", "subscription_resumed"].includes(eventName)
  ) {
    const { error } = await supabase.from("subscriptions").upsert({
      user_id: userId,
      plan,
      status: data?.status ?? "active",
      lemonsqueezy_subscription_id: lsSubscriptionId,
      lemonsqueezy_customer_id: lsCustomerId,
      current_period_ends_at: currentPeriodEndsAt,
      updated_at: new Date().toISOString(),
    }, { onConflict: "user_id" });

    if (error) {
      console.error("Upsert error:", JSON.stringify(error));
      return new Response(JSON.stringify({ error: error.message }), { status: 500 });
    }
  }

  if (["subscription_cancelled", "subscription_expired"].includes(eventName)) {
    const { error } = await supabase.from("subscriptions").upsert({
      user_id: userId,
      plan: "free",
      status: "cancelled",
      lemonsqueezy_subscription_id: lsSubscriptionId,
      updated_at: new Date().toISOString(),
    }, { onConflict: "user_id" });

    if (error) {
      console.error("Upsert error:", JSON.stringify(error));
      return new Response(JSON.stringify({ error: error.message }), { status: 500 });
    }
  }

  return new Response(JSON.stringify({ ok: true }), { status: 200 });
});

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  return bytes;
}
