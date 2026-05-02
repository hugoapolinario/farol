import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// Rate limiting — same as ingest
const rateLimitMap = new Map<string, { count: number; resetAt: number }>();
function checkRateLimit(key: string, limit = 100, windowMs = 3600000): boolean {
  const now = Date.now();
  const entry = rateLimitMap.get(key);
  if (!entry || entry.resetAt < now) {
    rateLimitMap.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }
  if (entry.count >= limit) return false;
  entry.count++;
  return true;
}

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, x-farol-key",
};

function getAttr(attrs: any[], key: string): string | number | null {
  const attr = attrs?.find((a: any) => a.key === key);
  if (!attr) return null;
  const v = attr.value;
  return v?.stringValue ?? v?.intValue ?? v?.doubleValue ?? null;
}

function otelStatusToFarol(status: any): string {
  if (!status) return "success";
  const code = status.code ?? status.statusCode ?? 0;
  // OTEL: 0=unset, 1=ok, 2=error
  return code === 2 ? "error" : "success";
}

function otelTimeToMs(timeUnixNano: string | number): number {
  return Math.round(Number(timeUnixNano) / 1_000_000);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  // Auth — farol_key from header or query param
  const url = new URL(req.url);
  const farolKey = req.headers.get("x-farol-key") || url.searchParams.get("farol_key");

  if (!farolKey) {
    return new Response(JSON.stringify({ error: "Missing farol key" }), {
      status: 401,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  // Validate farol key
  const { data: keyData, error: keyError } = await supabase
    .from("api_keys")
    .select("user_id")
    .eq("api_key", farolKey)
    .single();

  if (keyError || !keyData) {
    return new Response(JSON.stringify({ error: "Invalid farol key" }), {
      status: 401,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const userId = keyData.user_id;

  // Rate limit per user
  if (!checkRateLimit(userId)) {
    return new Response(JSON.stringify({ error: "Rate limit exceeded" }), {
      status: 429,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  // OTLP/HTTP JSON structure: { resourceSpans: [...] }
  const resourceSpans = body?.resourceSpans ?? body?.resource_spans ?? [];
  if (!Array.isArray(resourceSpans) || resourceSpans.length === 0) {
    return new Response(JSON.stringify({ error: "No resourceSpans found" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  let runsInserted = 0;
  let spansInserted = 0;
  const errors: string[] = [];

  for (const resourceSpan of resourceSpans) {
    const resourceAttrs = resourceSpan.resource?.attributes ?? [];
    const serviceName = (getAttr(resourceAttrs, "service.name") as string) || "unknown";

    for (const scopeSpan of resourceSpan.scopeSpans ?? resourceSpan.scope_spans ?? []) {
      const spans = scopeSpan.spans ?? [];

      // Find root span (no parentSpanId)
      const rootSpan = spans.find((s: any) => !s.parentSpanId && !s.parent_span_id);
      if (!rootSpan) continue;

      const spanAttrs = rootSpan.attributes ?? [];
      const startMs = otelTimeToMs(
        rootSpan.startTimeUnixNano ?? rootSpan.start_time_unix_nano ?? 0,
      );
      const endMs = otelTimeToMs(rootSpan.endTimeUnixNano ?? rootSpan.end_time_unix_nano ?? 0);
      const durationMs = endMs - startMs;

      // Map to Farol run
      const agentName =
        (getAttr(spanAttrs, "agent.name") as string) ||
        (getAttr(spanAttrs, "farol.agent_name") as string) ||
        rootSpan.name ||
        serviceName;

      const topic =
        (getAttr(spanAttrs, "farol.topic") as string) ||
        (getAttr(spanAttrs, "topic") as string) ||
        rootSpan.name ||
        "";

      const model =
        (getAttr(spanAttrs, "llm.model") as string) ||
        (getAttr(spanAttrs, "gen_ai.request.model") as string) ||
        (getAttr(spanAttrs, "farol.model") as string) ||
        "unknown";

      const inputTokens = Number(
        getAttr(spanAttrs, "llm.token_count.prompt") ??
          getAttr(spanAttrs, "gen_ai.usage.prompt_tokens") ??
          getAttr(spanAttrs, "farol.input_tokens") ?? 0,
      );

      const outputTokens = Number(
        getAttr(spanAttrs, "llm.token_count.completion") ??
          getAttr(spanAttrs, "gen_ai.usage.completion_tokens") ??
          getAttr(spanAttrs, "farol.output_tokens") ?? 0,
      );

      const costUsd = Number(getAttr(spanAttrs, "farol.cost_usd") ?? 0);
      const status = otelStatusToFarol(rootSpan.status);
      const errorMsg = status === "error"
        ? ((getAttr(spanAttrs, "error.message") as string) || rootSpan.status?.message || "")
        : null;

      const parentTraceId = (getAttr(spanAttrs, "farol.parent_trace_id") as string) || null;
      const promptVersion = (getAttr(spanAttrs, "farol.prompt_version") as string) || null;

      const runId = crypto.randomUUID();
      const timestamp = new Date(startMs).toISOString();

      const childSpans = spans.filter((s: any) => s !== rootSpan);
      const steps = childSpans.map((s: any) => ({
        step: (s.name ?? "span").toString().slice(0, 200),
      }));

      // Insert run
      const { error: runError } = await supabase.from("runs").insert({
        id: runId,
        user_id: userId,
        agent: agentName.toString().slice(0, 100),
        model: model.toString().slice(0, 100),
        topic: topic.toString().slice(0, 500),
        status,
        duration_ms: durationMs,
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        cost_usd: costUsd,
        error: errorMsg,
        timestamp,
        steps,
        parent_trace_id: parentTraceId,
        prompt_version: promptVersion,
        notes: "Ingested via OpenTelemetry bridge (beta)",
      });

      if (runError) {
        errors.push(`Run insert failed: ${runError.message}`);
        continue;
      }

      runsInserted++;

      // Insert child spans
      for (const span of childSpans) {
        const attrs = span.attributes ?? [];
        const spanStart = otelTimeToMs(
          span.startTimeUnixNano ?? span.start_time_unix_nano ?? 0,
        );
        const spanEnd = otelTimeToMs(span.endTimeUnixNano ?? span.end_time_unix_nano ?? 0);

        const spanKind = span.kind ?? 0;
        // OTEL span kind: 0=unspecified, 1=internal, 2=server, 3=client, 4=producer, 5=consumer
        const spanType = (getAttr(attrs, "farol.span_type") as string) ||
          (spanKind === 3 ? "tool" : "llm");

        const { error: spanError } = await supabase.from("spans").insert({
          id: crypto.randomUUID(),
          run_id: runId,
          user_id: userId,
          name: (span.name ?? "span").toString().slice(0, 200),
          type: spanType,
          started_at: new Date(spanStart).toISOString(),
          ended_at: new Date(spanEnd).toISOString(),
          duration_ms: spanEnd - spanStart,
          input_tokens: Number(
            getAttr(attrs, "llm.token_count.prompt") ??
              getAttr(attrs, "gen_ai.usage.prompt_tokens") ?? 0,
          ),
          output_tokens: Number(
            getAttr(attrs, "llm.token_count.completion") ??
              getAttr(attrs, "gen_ai.usage.completion_tokens") ?? 0,
          ),
          cost_usd: Number(getAttr(attrs, "farol.cost_usd") ?? 0),
          metadata: { otel_span_id: span.spanId ?? span.span_id },
          error: otelStatusToFarol(span.status) === "error"
            ? (span.status?.message || "error")
            : null,
        });

        if (!spanError) spansInserted++;
        else errors.push(`Span insert failed: ${spanError.message}`);
      }
    }
  }

  return new Response(
    JSON.stringify({
      ok: true,
      runs_inserted: runsInserted,
      spans_inserted: spansInserted,
      errors: errors.length > 0 ? errors : undefined,
    }),
    {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    },
  );
});
