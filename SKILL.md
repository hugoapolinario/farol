---
name: farol
description: Install and use the Farol Python SDK (@trace) to sync AI agent runs, tokens, cost, and steps to Farol observability. Use when adding observability to Python agents.
---

# Farol SDK

## What it is

Farol is a Python SDK that wraps agent entrypoints with `@trace` and syncs runs (tokens, cost, steps, errors) to [Farol](https://usefarol.dev) for dashboards and cost anomaly detection.

## When to use it

Use Farol whenever you are building a **Python** AI agent (any framework) and want **observability**: run history, estimated cost, optional trace steps, and anomaly signals—without a heavy APM setup.

## Installation

```bash
pip install farol-sdk
```

For Supabase sync and dashboard attribution, also install:

```bash
pip install 'farol-sdk[supabase]'
```

## Setup

1. Sign up at **https://usefarol.dev** and open the app dashboard.
2. Copy your **API key** (`frl_…`). Pass it as `farol_key` on `@trace`.

## Basic usage

The decorator injects a `run` dict into your function. Set tokens (and optionally steps/topic) before returning.

```python
from farol import trace

@trace("my-agent", farol_key="frl_your_key_here", model="gpt-4o-mini")
def run_agent(prompt: str, *, run):
    run["input_tokens"] = 150
    run["output_tokens"] = 90
    return "ok"

run_agent("hello")
```

- `agent_name` (required): shown in the dashboard.
- `farol_key` (required): ties runs to your account.
- `model` (optional): display label; default in SDK may differ—set explicitly for clarity.
- `cost_per_1k_tokens` (optional): USD per 1k total tokens; default `0.00025`.

## Record steps

Append dicts to `run["steps"]` (list):

```python
run["steps"].append({"step": "llm_call", "detail": "summarize"})
run["steps"].append({"step": "tool", "detail": "search"})
```

Use stable `step` names your team recognizes; `detail` is free-form (URLs, model id, etc.).

## Record tokens

Set integers before the function returns (used for cost):

```python
run["input_tokens"] = 1200
run["output_tokens"] = 400
```

## Record topic

Optional string for filtering in the UI:

```python
run["topic"] = "customer-support"
```

## Environment variables

Set in the environment (or your host’s secret store) when using Supabase sync:

| Variable | Role |
|----------|------|
| `SUPABASE_URL` | Supabase project URL |
| `SUPABASE_KEY` | Anon key (baseline reads) |
| `SUPABASE_SERVICE_KEY` | Optional; recommended for `api_keys` lookup + `runs` insert when using `farol_key` |

If Supabase packages/env are missing, the decorator still runs; sync is skipped.

## Full docs

**https://usefarol.dev/docs.html**
