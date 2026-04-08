# SDK (local prototype)

Python **decorator-based** SDK used while building Farol—not the published PyPI package (that lives in `farol-sdk/`).

| File | Role |
|------|------|
| `sdk.py` | `@trace` decorator, `runs.json` + Supabase sync, anomaly + email hooks |
| `__init__.py` | Re-exports `trace` so you can `from sdk import trace` |
| `agent.py` | Example agents (adds repo root to `sys.path`); run: `python sdk/agent.py` from repo root |
| `check.py` | Prints summary of **`runs.json`** at repo root |

**Imports:** Run scripts from the **repository root** (`python sdk/agent.py`, `python sdk/check.py`) so `from sdk import trace` resolves.

**Data:** `runs.json` is read/written at **`../runs.json`** (repo root), next to `.env`.
