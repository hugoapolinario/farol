# farol-sdk

Agent observability for builders. Wrap a function with `@trace`, pass token counts on the `run` dict, and Farol syncs runs to your dashboard—cost anomalies, alerts, the lot.

**[usefarol.dev](https://usefarol.dev)**

---

## Install

```bash
pip install farol-sdk
```

Sync to Supabase and email alerts need extras (zero required deps otherwise):

```bash
pip install 'farol-sdk[supabase,resend]'
```

Set environment variables: `SUPABASE_URL`, `SUPABASE_KEY`, optionally `SUPABASE_SERVICE_KEY` for writes + API key resolution; `RESEND_API_KEY` and `ALERT_EMAIL` for anomaly emails.

---

## Usage

```python
from farol import trace

@trace("research-agent", farol_key="frl_your_key_here", model="claude-3-5-haiku-latest")
def my_agent(task: str, *, run):
    run["input_tokens"] = 100
    run["output_tokens"] = 50
    return "done"
```

The wrapped function receives `run` with `steps`, token fields, and timing; Farol computes cost from `cost_per_1k_tokens` (default suits many providers—override as needed).

---

## License

MIT
