# @usefarol/sdk

**AI agent observability for Node.js** — wrap your agent entrypoints with a single `trace()` helper to send runs, token usage, cost, and spans to [Farol](https://usefarol.dev).

## Install

```bash
npm install @usefarol/sdk
```

Requires **Node.js 18+** (global `fetch`).

## API key

Create or copy your API key from the Farol app: **[usefarol.dev](https://usefarol.dev)** → sign in → dashboard / [usefarol.dev/app](https://usefarol.dev/app).

## Quick start — Anthropic

```typescript
import Anthropic from "@anthropic-ai/sdk";
import { trace } from "@usefarol/sdk";

const client = new Anthropic();

const myAgent = trace(
  async (run, task: string) => {
    run.topic = task;

    const span = run.startSpan("llm_call", { type: "llm" });
    try {
      const response = await client.messages.create({
        model: "claude-haiku-4-5",
        max_tokens: 1024,
        messages: [{ role: "user", content: task }],
      });
      span.inputTokens = response.usage.input_tokens;
      span.outputTokens = response.usage.output_tokens;
      run.inputTokens += response.usage.input_tokens;
      run.outputTokens += response.usage.output_tokens;
      span.end();
      return response.content[0].type === "text"
        ? response.content[0].text
        : "";
    } catch (e) {
      span.end(e instanceof Error ? e : new Error(String(e)));
      throw e;
    }
  },
  {
    agentName: "my-agent",
    farolKey: process.env.FAROL_KEY!,
    model: "claude-haiku-4-5",
  },
);

await myAgent("Summarize this week’s metrics.");
```

## Quick start — OpenAI

```typescript
import OpenAI from "openai";
import { trace } from "@usefarol/sdk";

const openai = new OpenAI();

const myAgent = trace(
  async (run, userMessage: string) => {
    run.topic = userMessage;

    const span = run.startSpan("chat", { type: "llm" });
    try {
      const response = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: userMessage }],
      });
      const usage = response.usage;
      if (usage) {
        span.inputTokens = usage.prompt_tokens;
        span.outputTokens = usage.completion_tokens;
        run.inputTokens += usage.prompt_tokens;
        run.outputTokens += usage.completion_tokens;
      }
      span.end();
      return response.choices[0]?.message.content ?? "";
    } catch (e) {
      span.end(e instanceof Error ? e : new Error(String(e)));
      throw e;
    }
  },
  {
    agentName: "support-bot",
    farolKey: process.env.FAROL_KEY!,
    model: "gpt-4o-mini",
  },
);

await myAgent("Hello!");
```

## Span tracking (`startSpan` / `end`)

Use `run.startSpan(name, { type, metadata })` for tools, retrieval, or extra LLM steps. Call `span.end()` when the step finishes, or `span.end(error)` on failure. Unclosed spans are auto-ended when the run completes.

```typescript
import { trace } from "@usefarol/sdk";

const pipeline = trace(
  async (run, query: string) => {
    run.topic = query;

    const search = run.startSpan("web_search", {
      type: "tool",
      metadata: { engine: "internal" },
    });
    const results = await fakeSearch(query);
    search.end();

    const llm = run.startSpan("answer", { type: "llm" });
    try {
      const answer = await fakeLlm(query, results);
      llm.inputTokens = 100;
      llm.outputTokens = 50;
      run.inputTokens += 100;
      run.outputTokens += 50;
      llm.end();
      return answer;
    } catch (e) {
      llm.end(e instanceof Error ? e : new Error(String(e)));
      throw e;
    }
  },
  { agentName: "research-agent", farolKey: process.env.FAROL_KEY! },
);

async function fakeSearch(q: string) {
  return [`result for ${q}`];
}
async function fakeLlm(_q: string, _ctx: string[]) {
  return "done";
}

await pipeline("What is Farol?");
```

### Optional: capture prompt/response text

Set `captureIo: true` in `trace` options to include `span.input` / `span.output` in the payload (only when you assign them). **Do not enable for sensitive data** without reviewing compliance needs.

## Sampling

Set `sampleRate` to reduce the percentage of runs sent to Farol. Errors are always sent regardless of sample rate.

```typescript
const myAgent = trace(fn, {
  agentName: "my-agent",
  farolKey: "frl_...",
  sampleRate: 0.1, // send 10% of successful runs
});
```

## Options

| Option | Description |
|--------|-------------|
| `agentName` | Display name in the Farol dashboard |
| `farolKey` | API key (`frl_…`) |
| `farolEndpoint` | Override ingest URL (default: hosted Farol ingest). Only change this if self-hosting. Never point to an untrusted URL — run data will be sent there. |
| `model` | Model label on the run |
| `costPer1kInputTokens` / `costPer1kOutputTokens` | USD per 1k tokens for cost estimates |
| `captureIo` | When `true`, include span `input`/`output` if set |
| `sampleRate` | Fraction of successful runs to send (`0.0`–`1.0`). Errors always sent. Default `1.0`. |
| `promptVersion` | Optional. Prompt version label (e.g. `v2`). Max 50 characters. Shown in the dashboard runs table and trace modal. |

## Build (from source)

```bash
cd farol-sdk-js
npm install
npm run build
```

Outputs `dist/index.js`, `dist/index.mjs`, and `dist/index.d.ts`.

## License

MIT
