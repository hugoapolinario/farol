const DEFAULT_ENDPOINT =
  "https://drmyexzztahpudgrfjsk.supabase.co/functions/v1/ingest";

export interface TraceOptions {
  agentName: string;
  farolKey: string;
  farolEndpoint?: string;
  model?: string;
  costPer1kInputTokens?: number;
  costPer1kOutputTokens?: number;
  captureIo?: boolean;
  /** 0.0 to 1.0, default 1.0 */
  sampleRate?: number;
}

export interface SpanOptions {
  type?: "tool" | "llm";
  metadata?: Record<string, unknown>;
}

export class Span {
  name: string;
  type: string;
  metadata: Record<string, unknown>;
  inputTokens = 0;
  outputTokens = 0;
  costUsd = 0;
  input?: string;
  output?: string;
  error?: string;
  startedAt: string;
  endedAt?: string;
  durationMs?: number;
  private _startTime: number;

  constructor(name: string, options: SpanOptions = {}) {
    this.name = name;
    this.type = options.type ?? "tool";
    this.metadata = options.metadata ?? {};
    this.startedAt = new Date().toISOString();
    this._startTime = Date.now();
  }

  end(error?: Error): void {
    this.endedAt = new Date().toISOString();
    this.durationMs = Date.now() - this._startTime;
    if (error) this.error = error.message;
  }

  toDict(captureIo: boolean): Record<string, unknown> {
    const d: Record<string, unknown> = {
      name: this.name,
      type: this.type,
      metadata: this.metadata,
      started_at: this.startedAt,
      ended_at: this.endedAt,
      duration_ms: this.durationMs,
      input_tokens: this.inputTokens,
      output_tokens: this.outputTokens,
      cost_usd: this.costUsd,
      error: this.error ?? null,
    };
    if (captureIo) {
      d.input = this.input ?? null;
      d.output = this.output ?? null;
    }
    return d;
  }
}

export class Run {
  id: string;
  agent: string;
  model: string;
  topic?: string;
  status = "running";
  steps: unknown[] = [];
  spans: Span[] = [];
  inputTokens = 0;
  outputTokens = 0;
  costUsd = 0;
  durationMs = 0;
  error?: string;
  timestamp: string;
  anomaly = false;
  anomalyReason?: string;

  constructor(agentName: string, model: string) {
    this.id = `run_${Date.now()}`;
    this.agent = agentName;
    this.model = model;
    this.timestamp = new Date().toISOString();
  }

  startSpan(name: string, options: SpanOptions = {}): Span {
    const span = new Span(name, options);
    this.spans.push(span);
    return span;
  }
}

export function trace<T extends unknown[], R>(
  fn: (run: Run, ...args: T) => Promise<R>,
  options: TraceOptions,
): (...args: T) => Promise<R> {
  const {
    agentName,
    farolKey,
    farolEndpoint = DEFAULT_ENDPOINT,
    model = "unknown",
    costPer1kInputTokens = 0.00025,
    costPer1kOutputTokens = 0.00125,
    captureIo = false,
    sampleRate = 1.0,
  } = options;

  if (captureIo) {
    console.warn(
      "[Farol] WARNING: captureIo is enabled — prompts are being stored in your Farol dashboard",
    );
  }

  return async (...args: T): Promise<R> => {
    const run = new Run(agentName, model);
    const startTime = Date.now();

    try {
      const result = await fn(run, ...args);
      run.status = "success";
      return result;
    } catch (err) {
      run.status = "error";
      run.error = err instanceof Error ? err.message : String(err);
      throw err;
    } finally {
      run.durationMs = Date.now() - startTime;
      run.costUsd = parseFloat(
        (
          (run.inputTokens / 1000) * costPer1kInputTokens +
          (run.outputTokens / 1000) * costPer1kOutputTokens
        ).toFixed(6),
      );

      for (const span of run.spans) {
        if (!span.endedAt) span.end();
      }

      const shouldSend =
        run.status === "error" || Math.random() <= sampleRate;
      if (shouldSend) {
        await sendToFarol(run, farolKey, farolEndpoint, captureIo);
      } else {
        console.log(`[Farol] Run sampled out (sampleRate=${sampleRate})`);
      }
    }
  };
}

async function sendToFarol(
  run: Run,
  farolKey: string,
  endpoint: string,
  captureIo: boolean,
): Promise<void> {
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
      farol_key: farolKey,
    };

    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
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
