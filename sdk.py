import time
import json
import os
from datetime import datetime
from dotenv import load_dotenv
from supabase import create_client

load_dotenv()

LOGS_FILE = "runs.json"
COST_ALERT_THRESHOLD = 0.0001

supabase = create_client(
    os.getenv("SUPABASE_URL"),
    os.getenv("SUPABASE_KEY")
)

def load_runs():
    if not os.path.exists(LOGS_FILE):
        return []
    with open(LOGS_FILE, "r") as f:
        return json.load(f)

def save_run(run: dict):
    # Save to local JSON
    runs = load_runs()
    runs.append(run)
    with open(LOGS_FILE, "w") as f:
        json.dump(runs, f, indent=2)

    # Save to Supabase
    try:
        supabase.table("runs").insert({
            "id": run["id"],
            "agent": run["agent"],
            "model": run["model"],
            "topic": run.get("topic"),
            "status": run["status"],
            "duration_ms": run["duration_ms"],
            "input_tokens": run["input_tokens"],
            "output_tokens": run["output_tokens"],
            "cost_usd": float(run["cost_usd"]),
            "steps": run["steps"],
            "error": run.get("error"),
            "timestamp": run["timestamp"]
        }).execute()
        print(f"[Vigil] Synced to Supabase")
    except Exception as e:
        print(f"[Vigil] Supabase sync failed: {e}")

    print(f"[Vigil] Run recorded — {run['duration_ms']}ms | ${run['cost_usd']} | status: {run['status']}")
    if run["cost_usd"] > COST_ALERT_THRESHOLD:
        print(f"[Vigil] COST ALERT — {run['agent']} exceeded ${COST_ALERT_THRESHOLD} threshold (actual: ${run['cost_usd']})")

def trace(agent_name: str, model: str = "claude-haiku-4-5-20251001", cost_per_1k_tokens: float = 0.00025):
    def decorator(func):
        def wrapper(*args, **kwargs):
            run = {
                "id": f"run_{int(time.time())}",
                "agent": agent_name,
                "model": model,
                "timestamp": datetime.utcnow().isoformat(),
                "status": "running",
                "steps": [],
                "input_tokens": 0,
                "output_tokens": 0,
                "cost_usd": 0.0,
                "duration_ms": 0,
                "error": None
            }

            start = time.time()

            try:
                result = func(*args, run=run, **kwargs)
                run["status"] = "success"
                return result
            except Exception as e:
                run["status"] = "error"
                run["error"] = str(e)
                raise
            finally:
                run["duration_ms"] = round((time.time() - start) * 1000)
                run["cost_usd"] = round(
                    (run["input_tokens"] + run["output_tokens"]) / 1000 * cost_per_1k_tokens, 6
                )
                save_run(run)

        return wrapper
    return decorator