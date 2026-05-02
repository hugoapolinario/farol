import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY");
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type",
};

const EVAL_PROMPTS: Record<string, (config: Record<string, unknown>, output: string) => string> = {
  correctness: (config, output) =>
    `You are an evaluator. Assess whether the following AI agent output is factually correct and answers the task accurately.
${config.criteria ? `Additional criteria: ${config.criteria}` : ""}
Output to evaluate:
"""
${output}
"""
Respond with JSON only, no markdown:
{"passed": true|false, "score": 0.0-1.0, "reason": "one sentence explanation"}`,

  groundedness: (config, output) =>
    `You are an evaluator. Assess whether the following AI agent output is grounded — it does not hallucinate, invent facts, or make unsupported claims.
${config.criteria ? `Additional criteria: ${config.criteria}` : ""}
Output to evaluate:
"""
${output}
"""
Respond with JSON only, no markdown:
{"passed": true|false, "score": 0.0-1.0, "reason": "one sentence explanation"}`,

  json_validity: (_config, output) =>
    `You are an evaluator. Check whether the following AI agent output is valid JSON. If it contains a JSON block, extract and validate it.
Output to evaluate:
"""
${output}
"""
Respond with JSON only, no markdown:
{"passed": true|false, "score": 0.0-1.0, "reason": "one sentence explanation"}`,

  tone: (config, output) =>
    `You are an evaluator. Assess whether the following AI agent output matches the expected tone.
Expected tone: ${config.expected_tone || "professional and helpful"}
Output to evaluate:
"""
${output}
"""
Respond with JSON only, no markdown:
{"passed": true|false, "score": 0.0-1.0, "reason": "one sentence explanation"}`,
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: corsHeaders });

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const userClient = createClient(SUPABASE_URL, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: authHeader } },
    });

    const { data: { user }, error: authError } = await userClient.auth.getUser();
    if (authError || !user) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: corsHeaders });

    const { eval_id, trace_id } = await req.json();
    if (!eval_id || !trace_id) return new Response(JSON.stringify({ error: "eval_id and trace_id required" }), { status: 400, headers: corsHeaders });

    // Fetch eval definition — RLS ensures ownership
    const { data: evalDef, error: evalError } = await userClient
      .from("evals")
      .select("*")
      .eq("id", eval_id)
      .eq("user_id", user.id)
      .single();

    if (evalError || !evalDef) return new Response(JSON.stringify({ error: "Eval not found" }), { status: 404, headers: corsHeaders });
    if (!evalDef.active) return new Response(JSON.stringify({ error: "Eval is inactive" }), { status: 400, headers: corsHeaders });

    // Fetch trace metadata (+ run-level output fallback when spans lack output)
    const { data: trace, error: traceError } = await userClient
      .from("runs")
      .select("id, agent, status, output")
      .eq("id", trace_id)
      .eq("user_id", user.id)
      .single();

    if (traceError || !trace) return new Response(JSON.stringify({ error: "Trace not found" }), { status: 404, headers: corsHeaders });

    // Fetch output from spans ( newest first; combine up to 5 non-null outputs )
    const { data: spans } = await userClient
      .from("spans")
      .select("output")
      .eq("run_id", trace_id)
      .eq("user_id", user.id)
      .not("output", "is", null)
      .order("started_at", { ascending: false })
      .limit(5);

    const spanCombined =
      spans
        ?.map((s) => (typeof s.output === "string" ? s.output : JSON.stringify(s.output)))
        .filter(Boolean)
        .join("\n\n---\n\n") || "";

    const runLevel =
      trace.output != null && trace.output !== ""
        ? typeof trace.output === "string"
          ? trace.output
          : JSON.stringify(trace.output)
        : "";

    const output =
      spanCombined ||
      (runLevel && runLevel !== "null" ? runLevel : "");

    if (!output) {
      return new Response(JSON.stringify({ error: "Trace has no output to evaluate" }), { status: 400, headers: corsHeaders });
    }

    // Build prompt
    const promptFn = EVAL_PROMPTS[evalDef.type];
    if (!promptFn) return new Response(JSON.stringify({ error: "Unknown eval type" }), { status: 400, headers: corsHeaders });

    const prompt = promptFn(evalDef.config || {}, output);

    // Call Anthropic
    const anthropicRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY!,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 256,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    if (!anthropicRes.ok) {
      const err = await anthropicRes.text();
      return new Response(JSON.stringify({ error: "LLM call failed", detail: err }), { status: 502, headers: corsHeaders });
    }

    const anthropicData = await anthropicRes.json();
    const rawText = anthropicData.content?.[0]?.text || "";

    let judgement: { passed: boolean; score: number; reason: string };
    try {
      const cleaned = rawText.replace(/```json|```/g, "").trim();
      judgement = JSON.parse(cleaned);
    } catch {
      return new Response(JSON.stringify({ error: "Failed to parse LLM response", raw: rawText }), { status: 502, headers: corsHeaders });
    }

    // Store result using service role (no INSERT RLS for authenticated users)
    const { data: result, error: insertError } = await supabase
      .from("eval_results")
      .insert({
        eval_id: evalDef.id,
        trace_id: trace_id,
        user_id: user.id,
        passed: judgement.passed,
        score: judgement.score,
        details: { reason: judgement.reason, eval_type: evalDef.type },
        evaluated_at: new Date().toISOString(),
      })
      .select()
      .single();

    if (insertError) return new Response(JSON.stringify({ error: "Failed to store result", detail: insertError.message }), { status: 500, headers: corsHeaders });

    return new Response(JSON.stringify({ success: true, result }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  } catch (err) {
    return new Response(JSON.stringify({ error: "Internal error", detail: String(err) }), { status: 500, headers: corsHeaders });
  }
});