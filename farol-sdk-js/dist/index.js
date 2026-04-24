"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/index.ts
var index_exports = {};
__export(index_exports, {
  Run: () => Run,
  Span: () => Span,
  trace: () => trace
});
module.exports = __toCommonJS(index_exports);
var DEFAULT_ENDPOINT = "https://drmyexzztahpudgrfjsk.supabase.co/functions/v1/ingest";
var Span = class {
  constructor(name, options = {}) {
    this.inputTokens = 0;
    this.outputTokens = 0;
    this.costUsd = 0;
    this.name = name;
    this.type = options.type ?? "tool";
    this.metadata = options.metadata ?? {};
    this.startedAt = (/* @__PURE__ */ new Date()).toISOString();
    this._startTime = Date.now();
  }
  end(error) {
    this.endedAt = (/* @__PURE__ */ new Date()).toISOString();
    this.durationMs = Date.now() - this._startTime;
    if (error) this.error = error.message;
  }
  toDict(captureIo) {
    const d = {
      name: this.name,
      type: this.type,
      metadata: this.metadata,
      started_at: this.startedAt,
      ended_at: this.endedAt,
      duration_ms: this.durationMs,
      input_tokens: this.inputTokens,
      output_tokens: this.outputTokens,
      cost_usd: this.costUsd,
      error: this.error ?? null
    };
    if (captureIo) {
      d.input = this.input ?? null;
      d.output = this.output ?? null;
    }
    return d;
  }
};
var Run = class {
  constructor(agentName, model) {
    this.status = "running";
    this.steps = [];
    this.spans = [];
    this.inputTokens = 0;
    this.outputTokens = 0;
    this.costUsd = 0;
    this.durationMs = 0;
    this.anomaly = false;
    this.id = `run_${Date.now()}`;
    this.agent = agentName;
    this.model = model;
    this.timestamp = (/* @__PURE__ */ new Date()).toISOString();
  }
  startSpan(name, options = {}) {
    const span = new Span(name, options);
    this.spans.push(span);
    return span;
  }
};
function trace(fn, options) {
  const {
    agentName,
    farolKey,
    farolEndpoint = DEFAULT_ENDPOINT,
    model = "unknown",
    costPer1kInputTokens = 25e-5,
    costPer1kOutputTokens = 125e-5,
    captureIo = false,
    sampleRate = 1,
    promptVersion,
    parentTraceId
  } = options;
  const safePromptVersion = promptVersion ? promptVersion.slice(0, 50) : void 0;
  const safeParentTraceId = parentTraceId ? parentTraceId.slice(0, 50) : void 0;
  if (captureIo) {
    console.warn(
      "[Farol] WARNING: captureIo is enabled \u2014 prompts are being stored in your Farol dashboard"
    );
  }
  return async (...args) => {
    const run = new Run(agentName, model);
    const startTime = Date.now();
    if (safeParentTraceId) run.parentTraceId = safeParentTraceId;
    try {
      const result = await fn(run, ...args);
      run.status = "success";
      return result;
    } catch (err) {
      run.status = "error";
      run.error = err instanceof Error ? err.message : String(err);
      throw err;
    } finally {
      if (safePromptVersion) run.promptVersion = safePromptVersion;
      run.durationMs = Date.now() - startTime;
      run.costUsd = parseFloat(
        (run.inputTokens / 1e3 * costPer1kInputTokens + run.outputTokens / 1e3 * costPer1kOutputTokens).toFixed(6)
      );
      for (const span of run.spans) {
        if (!span.endedAt) span.end();
      }
      const shouldSend = run.status === "error" || Math.random() <= sampleRate;
      if (shouldSend) {
        await sendToFarol(run, farolKey, farolEndpoint, captureIo);
      } else {
        console.log(`[Farol] Run sampled out (sampleRate=${sampleRate})`);
      }
    }
  };
}
async function sendToFarol(run, farolKey, endpoint, captureIo) {
  try {
    const payload = {
      id: run.id,
      agent: run.agent,
      model: run.model,
      topic: run.topic ?? null,
      status: run.status,
      steps: run.steps,
      spans: run.spans.map((s) => s.toDict(captureIo)),
      input_tokens: run.inputTokens,
      output_tokens: run.outputTokens,
      cost_usd: run.costUsd,
      duration_ms: run.durationMs,
      error: run.error ?? null,
      timestamp: run.timestamp,
      anomaly: run.anomaly,
      anomaly_reason: run.anomalyReason ?? null,
      prompt_version: run.promptVersion ?? null,
      parent_trace_id: run.parentTraceId ?? null,
      farol_key: farolKey
    };
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    if (res.ok) {
      console.log("[Farol] Synced to Farol");
    } else {
      const body = await res.text();
      console.error(`[Farol] Ingest failed (${res.status}): ${body}`);
    }
  } catch (err) {
    console.error(`[Farol] Ingest request failed: ${err}`);
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  Run,
  Span,
  trace
});
