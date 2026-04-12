interface TraceOptions {
    agentName: string;
    farolKey: string;
    farolEndpoint?: string;
    model?: string;
    costPer1kInputTokens?: number;
    costPer1kOutputTokens?: number;
    captureIo?: boolean;
}
interface SpanOptions {
    type?: "tool" | "llm";
    metadata?: Record<string, unknown>;
}
declare class Span {
    name: string;
    type: string;
    metadata: Record<string, unknown>;
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
    input?: string;
    output?: string;
    error?: string;
    startedAt: string;
    endedAt?: string;
    durationMs?: number;
    private _startTime;
    constructor(name: string, options?: SpanOptions);
    end(error?: Error): void;
    toDict(captureIo: boolean): Record<string, unknown>;
}
declare class Run {
    id: string;
    agent: string;
    model: string;
    topic?: string;
    status: string;
    steps: unknown[];
    spans: Span[];
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
    durationMs: number;
    error?: string;
    timestamp: string;
    anomaly: boolean;
    anomalyReason?: string;
    constructor(agentName: string, model: string);
    startSpan(name: string, options?: SpanOptions): Span;
}
declare function trace<T extends unknown[], R>(fn: (run: Run, ...args: T) => Promise<R>, options: TraceOptions): (...args: T) => Promise<R>;

export { Run, Span, type SpanOptions, type TraceOptions, trace };
