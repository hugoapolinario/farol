# Farol

**AI agent observability for indie devs and small teams.**

AI agents fail silently and bill loudly. Farol tells you first.

→ [usefarol.dev](https://usefarol.dev) · [Docs](https://usefarol.dev/docs) · [Live demo](https://usefarol.dev/demo) · [Changelog](https://usefarol.dev/changelog) · [Roadmap](https://usefarol.dev/roadmap) · [Security](https://usefarol.dev/security) · [GitHub](https://github.com/hugoapolinario/farol)

## Table of Contents

- [What is Farol?](#what-is-farol)
- [Install](#install)
- [Quick start — Python](#quick-start--python)
- [Quick start — Node.js](#quick-start--nodejs)
- [Tracking spans](#tracking-spans-multi-step-agents)
- [Multi-agent tracing](#multi-agent-tracing)
- [Framework integrations](#framework-integrations)
- [SDK options](#sdk-options)
- [Dashboard](#dashboard)
- [Architecture](#architecture)
- [Contributing](#contributing)
- [Acknowledgements](#acknowledgements)
- [License](#license)

---

## What is Farol?

Farol is a monitoring tool for AI agents. Add one decorator to your agent function and instantly get:

- Cost anomaly detection
- Duration & p95 latency anomaly alerts
- Regression alerts — success rate drops week over week
- Quality scoring & quality trend alerts
- Proactive trend alerts — drift detection before things break
- Alert grouping — multiple agents affected shown as one alert
- Multi-agent trace linking — connect child runs to parent pipelines
- Prompt version tagging — compare cost and quality across versions
- Budget alerts per agent
- Agent Health Score (0-100)
- Full trace inspector
- Native Slack + webhook alerts
- Weekly digest email
- Shared read-only dashboards
- CSV export
- Run notes & annotations

## Install

**Python:**

```bash
pip install farol-sdk
```

**Node.js:**

```bash
npm install @usefarol/sdk
```

## Quick start — Python

```python
from farol import trace
from anthropic import Anthropic

client = Anthropic()

@trace(agent_name="my-agent", farol_key="frl_your_key_here")
def my_agent(task, *, run):
    run["topic"] = task

    response = client.messages.create(
        model="claude-haiku-4-5",
        max_tokens=1024,
        messages=[{"role": "user", "content": task}],
    )
    run["input_tokens"] = response.usage.input_tokens
    run["output_tokens"] = response.usage.output_tokens
    return response.content[0].text

result = my_agent("your task here")
```

## Quick start — Node.js

```typescript
import { trace } from '@usefarol/sdk';

const myAgent = trace(
  async (run, task: string) => {
    run.topic = task;
    // your agent code here
  },
  {
    agentName: 'my-agent',
    farolKey: 'frl_your_key_here',
  }
);

await myAgent('your task here');
```

## Tracking spans (multi-step agents)

The **Node** SDK uses `run.startSpan()` for per-span timelines (see [@usefarol/sdk on npm](https://www.npmjs.com/package/@usefarol/sdk)).

With the **Python** SDK, `run` is a dict: set token fields and optionally append step labels to `run["steps"]` (there is no `run.span()` helper).

```python
@trace(agent_name="research-agent", farol_key="frl_your_key_here")
def research_agent(topic, *, run):
    run["topic"] = topic
    results = search(topic)
    response = llm.call(results)
    run["input_tokens"] = response.usage.input_tokens
    run["output_tokens"] = response.usage.output_tokens
    run["steps"].extend(
        [{"step": "web_search"}, {"step": "llm_call"}]
    )
    return response.text
```

## Multi-agent tracing

Nested traced calls automatically link runs via Python `contextvars` when `propagate=True` (the default on `@trace`):

```python
@trace(agent_name="research-agent", farol_key="frl_...")
def research_agent(topic, *, run):
    run["topic"] = topic
    return market_agent(topic)


@trace(agent_name="market-agent", farol_key="frl_...")
def market_agent(topic, *, run):
    run["topic"] = topic
    # parent_trace_id is filled from context when called under research_agent
    ...
```

You can also pass `parent_trace_id=` on the **decorator** to force a specific parent. Parent runs show spawned children and total pipeline cost in the dashboard.

## Framework integrations

Works with any framework — wrap your agent's entrypoint with `@trace`:

**LangChain:**

```python
@trace(agent_name="langchain-agent", farol_key="frl_...")
def run_chain(query, *, run):
    run["topic"] = query
    result = chain.invoke({"query": query})
    run["steps"].append({"step": "chain_invoke"})
    return result
```

**CrewAI:**

```python
@trace(agent_name="crewai-agent", farol_key="frl_...")
def run_crew(topic, *, run):
    run["topic"] = topic
    result = crew.kickoff(inputs={"topic": topic})
    run["steps"].append({"step": "crew_kickoff"})
    return result
```

**Cursor SDK (Node.js):**

```typescript
import { trace } from '@usefarol/sdk';
import { CursorClient } from '@cursor/sdk';

const client = new CursorClient({ apiKey: process.env.CURSOR_API_KEY });

const runAgent = trace(
  async (run, prompt: string) => {
    run.topic = prompt;

    const span = run.startSpan('cursor_agent', { type: 'tool' });
    try {
      const result = await client.agent.run({ prompt });
      span.end();
      return result;
    } catch (e) {
      span.end(e instanceof Error ? e : new Error(String(e)));
      throw e;
    }
  },
  { agentName: 'cursor-agent', farolKey: 'frl_your_key_here' }
);

await runAgent('scaffold a new Express API with TypeScript');
```

Cursor SDK is in early access — check the Cursor SDK docs for the latest API.

Also works with AutoGen, Haystack, LlamaIndex, smolagents, and any custom agent loop.

## SDK options

Python `@trace` (see `farol-sdk` on PyPI):

| Parameter | Description |
| --- | --- |
| `agent_name` | Display name in the dashboard (required) |
| `farol_key` | Optional API key; when set and Supabase extras + env are configured, runs sync to your account |
| `model` | Model label on the run (default: `claude-haiku-4-5-20251001`) |
| `cost_per_1k_input_tokens` | USD per 1k input tokens (default: 0.00025) |
| `cost_per_1k_output_tokens` | USD per 1k output tokens (default: 0.00125) |
| `sample_rate` | Fraction of successful runs to persist, 0.0–1.0 (default: 1.0); errors always saved |
| `prompt_version` | Tag runs with a version label (e.g. `"v2"`). Max 50 chars. |
| `parent_trace_id` | Optional explicit parent run id; otherwise inherited from context when `propagate=True` |
| `propagate` | When `True` (default), nested traces inherit parent id via `contextvars` |

The Python SDK does **not** expose `capture_io` or a custom ingest URL on the decorator. The Node SDK (`trace()` options) supports `farolEndpoint`, `captureIo`, `sampleRate`, `promptVersion`, `parentTraceId`, and `propagate` — see `farol-sdk-js/README.md`.

### Supported providers

Works with any Python or Node.js LLM call — Anthropic, OpenAI, Google Gemini, Mistral, Grok, and more. See full examples in the docs.

## Dashboard

Sign up free at [usefarol.dev](https://usefarol.dev) — no credit card required.

| Plan | Price | Agents | Events |
| --- | --- | --- | --- |
| Free | €0 | 1 agent | 50k/mo |
| Starter | €20 | 3 agents | 300k/mo |
| Builder | €50 | Unlimited | Unlimited |

## Architecture

- **SDK** — client-side decorator, no gateway, no latency overhead
- **Ingest** — Supabase Edge Function, rate limited, HMAC verified
- **Dashboard** — Vercel-hosted frontend, Supabase Postgres backend
- **Alerts** — Resend email + Slack + webhook

## Tech Stack

- **SDK** — Python (PyPI) + Node.js/TypeScript (npm)
- **Backend** — Supabase (Postgres, Auth, Edge Functions, RLS)
- **Frontend** — Vanilla HTML/CSS/JS hosted on Vercel
- **Email** — Resend
- **Billing** — Polar.sh
- **DNS** — Namecheap

## Contributing

Contributions are welcome! The SDK is MIT licensed and open to PRs.

- **Bug reports** — open a GitHub issue with reproduction steps
- **Feature requests** — open a GitHub issue or vote on the [roadmap](https://usefarol.dev/roadmap)
- **Pull requests** — fork the repo, make your changes, open a PR against `main`

For major changes, open an issue first to discuss what you'd like to change.

## Acknowledgements

Built with these fantastic tools:

- [Supabase](https://supabase.com) — backend, auth, database
- [Polar.sh](https://polar.sh) — billing and payments
- [Resend](https://resend.com) — transactional email
- [Vercel](https://vercel.com) — frontend hosting
- [Cursor](https://cursor.com) — AI code editor used to build Farol

## Security

- All data encrypted in transit (TLS 1.3) and at rest (AES-256)
- Row-level security on all database tables
- Prompts never stored by default (optional `captureIo` on Node `trace()` only if you enable it)
- EU data residency (AWS Paris)

See the full [Security page](https://usefarol.dev/security) for details.
Report vulnerabilities via [feedback](https://usefarol.dev/feedback).

## License

MIT — see [LICENSE](LICENSE)

## Author

Built by [Hugo Apolinário](https://github.com/hugoapolinario)
→ [usefarol.dev](https://usefarol.dev) · [LinkedIn](https://linkedin.com/in/hugo-apolinário-4832251b6)
