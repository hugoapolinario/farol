# Farol

**AI agent observability for indie devs and small teams.**

AI agents fail silently and bill loudly. Farol tells you first.

→ [usefarol.dev](https://usefarol.dev) · [Docs](https://usefarol.dev/docs) · [Live demo](https://usefarol.dev/demo)

---

## What is Farol?

Farol is a monitoring tool for AI agents. Add one decorator to your agent function and instantly get:

- **Cost tracking** — token spend per run, anomaly detection when costs spike
- **Trace inspector** — every tool call, LLM call, duration, and error reconstructed end to end
- **Quality scoring** — rate outputs thumbs up/down, get alerted when quality degrades
- **Regression alerts** — automatic detection when success rate drops week over week
- **Budget alerts** — set monthly spend limits per agent, get notified when crossed
- **Weekly digest** — every Monday, a summary of your agents' health, cost, and quality
- **Slack + webhook alerts** — send alerts to Discord, Slack, Google Chat, or any HTTP endpoint
- **Shared dashboards** — generate a read-only link to share with clients or investors

## Install

**Python:**

```bash
pip install farol-sdk
```

**Node.js:**

```bash
npm install @usefarol/sdk
```

### Quick start — Python

```python
from farol import trace
from anthropic import Anthropic

client = Anthropic()

@trace(agent_name="my-agent", farol_key="frl_your_key_here")
def my_agent(task, run=None):
    run["topic"] = task

    with run.span("llm_call", type="llm") as span:
        response = client.messages.create(
            model="claude-haiku-4-5",
            max_tokens=1024,
            messages=[{"role": "user", "content": task}]
        )
        span.input_tokens = response.usage.input_tokens
        span.output_tokens = response.usage.output_tokens

    return response.content[0].text

result = my_agent("your task here")
```

### Quick start — Node.js

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

### Tracking spans (multi-step agents)

```python
@trace(agent_name="research-agent", farol_key="frl_your_key_here")
def research_agent(topic, run=None):
    run["topic"] = topic

    # Track a tool call
    with run.span("web_search", type="tool", metadata={"query": topic}) as span:
        results = search(topic)

    # Track an LLM call
    with run.span("llm_call", type="llm") as span:
        response = llm.call(results)
        span.input_tokens = response.usage.input_tokens
        span.output_tokens = response.usage.output_tokens

    return response.text
```

### SDK options

| Parameter | Description |
| --- | --- |
| `agent_name` | Display name in the dashboard |
| `farol_key` | API key from usefarol.dev |
| `model` | Model label for display |
| `cost_per_1k_input_tokens` | USD per 1k input tokens (default: 0.00025) |
| `cost_per_1k_output_tokens` | USD per 1k output tokens (default: 0.00125) |
| `capture_io` | Store prompt inputs/outputs (default: False) |
| `sample_rate` | Fraction of runs to send, 0.0–1.0 (default: 1.0) |

### Supported providers

Works with any Python or Node.js LLM call — Anthropic, OpenAI, Google Gemini, Mistral, Grok, and more. See full examples in the docs.

## Dashboard

Sign up free at [usefarol.dev](https://usefarol.dev) — no credit card required.

| Plan | Price | Agents | Events |
| --- | --- | --- | --- |
| Free | €0 | 1 | 50k/mo |
| Starter | €29 | 3 | 300k/mo |
| Builder | €69 | Unlimited | Unlimited |

## Architecture

- **SDK** — client-side decorator, no gateway, no latency overhead
- **Ingest** — Supabase Edge Function, rate limited, HMAC verified
- **Dashboard** — Vercel-hosted frontend, Supabase Postgres backend
- **Alerts** — Resend email + Slack + webhook

## License

MIT — see [LICENSE](LICENSE)

Built by Hugo Apolinário · [usefarol.dev](https://usefarol.dev)
