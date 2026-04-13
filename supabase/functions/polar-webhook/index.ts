import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const POLAR_WEBHOOK_SECRET = Deno.env.get("POLAR_WEBHOOK_SECRET")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const STARTER_PRODUCT_ID = "b7ba9826-6409-4788-8798-1e941efa6d6a";
const BUILDER_PRODUCT_ID = "7c8c17c9-7089-434a-92ea-7af1ebc367ff";

async function verifyWebhook(req: Request): Promise<{ valid: boolean; body: string }> {
  const body = await req.text();
  const signature = req.headers.get("webhook-signature") ?? "";
  
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(POLAR_WEBHOOK_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"]
  );

  const sigBytes = hexToBytes(signature.replace("sha256=", ""));
  const valid = await crypto.subtle.verify(
    "HMAC",
    key,
    sigBytes,
    new TextEncoder().encode(body)
  );

  return { valid, body };
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  return bytes;
}

function getPlan(productId: string): string {
  if (productId === STARTER_PRODUCT_ID) return "starter";
  if (productId === BUILDER_PRODUCT_ID) return "builder";
  return "free";
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204 });
  }

  try {
    const { valid, body } = await verifyWebhook(req);
    if (!valid) {
      return new Response(JSON.stringify({ error: "Invalid signature" }), { status: 401 });
    }

    const event = JSON.parse(body);
    const eventType = event.type;
    const data = event.data;

    console.log(`[polar-webhook] event: ${eventType}`);

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

    if (["subscription.created", "subscription.updated", "subscription.canceled"].includes(eventType)) {
      const subscription = data;
      const customerId = subscription.customer_id;
      const productId = subscription.product_id;
      const status = subscription.status;
      const currentPeriodEnd = subscription.current_period_end;
      const userEmail = subscription.customer?.email;

      if (!userEmail) {
        console.error("[polar-webhook] No customer email found");
        return new Response(JSON.stringify({ error: "No email" }), { status: 400 });
      }

      // Find user by email
      const { data: userData } = await supabase.auth.admin.listUsers();
      const user = userData?.users?.find(u => u.email === userEmail);

      if (!user) {
        console.error("[polar-webhook] User not found:", userEmail);
        return new Response(JSON.stringify({ error: "User not found" }), { status: 404 });
      }

      const plan = status === "canceled" || status === "revoked" ? "free" : getPlan(productId);

      const { error } = await supabase.from("subscriptions").upsert({
        user_id: user.id,
        plan,
        status,
        polar_subscription_id: subscription.id,
        polar_customer_id: customerId,
        current_period_ends_at: currentPeriodEnd,
      }, { onConflict: "user_id" });

      if (error) {
        console.error("[polar-webhook] DB error:", error);
        return new Response(JSON.stringify({ error: "DB error" }), { status: 500 });
      }

      console.log(`[polar-webhook] Updated user ${user.id} to plan: ${plan}`);
    }

    return new Response(JSON.stringify({ ok: true }), { status: 200 });

  } catch (err) {
    console.error("[polar-webhook] Error:", err);
    return new Response(JSON.stringify({ error: String(err) }), { status: 500 });
  }
});
