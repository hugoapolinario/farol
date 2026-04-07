import time
import json
import os
import statistics
from datetime import datetime
from dotenv import load_dotenv
import resend
from supabase import create_client

load_dotenv()

LOGS_FILE = "runs.json"
COST_ALERT_THRESHOLD = 0.0001
RESEND_API_KEY = os.getenv("RESEND_API_KEY")
ALERT_EMAIL = os.getenv("ALERT_EMAIL")

_supabase_url = os.getenv("SUPABASE_URL")
supabase = create_client(
    _supabase_url,
    os.getenv("SUPABASE_KEY")
)
_service_key = os.getenv("SUPABASE_SERVICE_KEY")
supabase_admin = (
    create_client(_supabase_url, _service_key)
    if _service_key
    else supabase
)
resend.api_key = RESEND_API_KEY

def load_runs():
    if not os.path.exists(LOGS_FILE):
        return []
    with open(LOGS_FILE, "r") as f:
        return json.load(f)

def save_run(run: dict):
    anomaly = False
    anomaly_reason = None

    try:
        baseline_response = (
            supabase
            .table("runs")
            .select("cost_usd")
            .eq("agent", run["agent"])
            .eq("status", "success")
            .order("timestamp", desc=True)
            .limit(20)
            .execute()
        )
        baseline_rows = baseline_response.data or []
    except Exception as e:
        print(f"[Vigil] Baseline lookup failed: {e}")
        baseline_rows = []

    baseline_costs = []
    for row in baseline_rows:
        try:
            baseline_costs.append(float(row.get("cost_usd")))
        except (TypeError, ValueError, AttributeError):
            continue

    if len(baseline_costs) < 5:
        anomaly = False
        anomaly_reason = "Building baseline — need 5+ runs"
    else:
        median_cost = statistics.median(baseline_costs)
        mean_cost = statistics.mean(baseline_costs)
        std_dev_cost = statistics.stdev(baseline_costs)
        current_cost = float(run["cost_usd"])

        is_over_3x_median = current_cost > (3 * median_cost)
        is_over_2x_and_2std = current_cost > (2 * median_cost) and current_cost > (mean_cost + (2 * std_dev_cost))

        if is_over_3x_median or is_over_2x_and_2std:
            anomaly = True
            ratio = (current_cost / median_cost) if median_cost > 0 else float("inf")
            ratio_text = "∞" if ratio == float("inf") else f"{ratio:.1f}"
            anomaly_reason = (
                f"Cost {ratio_text}× above median baseline "
                f"(median: ${median_cost:.6f}, actual: ${current_cost:.6f})"
            )
        else:
            anomaly = False
            anomaly_reason = None

    run["anomaly"] = anomaly
    run["anomaly_reason"] = anomaly_reason

    # Save to local JSON
    runs = load_runs()
    runs.append(run)
    with open(LOGS_FILE, "w") as f:
        json.dump(runs, f, indent=2)

    # Save to Supabase
    try:
        user_id = None
        if run.get("farol_key"):
            try:
                key_res = (
                    supabase_admin
                    .table("api_keys")
                    .select("user_id")
                    .eq("api_key", run["farol_key"])
                    .limit(1)
                    .execute()
                )
                key_rows = key_res.data or []
                if key_rows and key_rows[0].get("user_id"):
                    user_id = key_rows[0].get("user_id")
                else:
                    print("[Farol] Invalid API key — run saved locally only")
                    return
            except Exception:
                print("[Farol] Invalid API key — run saved locally only")
                return

        payload = {
            "id": run["id"],
            "agent": run["agent"],
            "model": run["model"],
            "topic": run.get("topic"),
            "status": run["status"],
            "duration_ms": run["duration_ms"],
            "input_tokens": run["input_tokens"],
            "output_tokens": run["output_tokens"],
            "cost_usd": float(run["cost_usd"]),
            "anomaly": run.get("anomaly", False),
            "anomaly_reason": run.get("anomaly_reason", None),
            "steps": run["steps"],
            "error": run.get("error"),
            "timestamp": run["timestamp"]
        }
        if user_id is not None:
            payload["user_id"] = user_id

        supabase_admin.table("runs").insert(payload).execute()
        print(f"[Vigil] Synced to Supabase")
    except Exception as e:
        print(f"[Vigil] Supabase sync failed: {e}")

    print(f"[Vigil] Run recorded — {run['duration_ms']}ms | ${run['cost_usd']} | status: {run['status']}")
    if run["cost_usd"] > COST_ALERT_THRESHOLD:
        print(f"[Vigil] COST ALERT — {run['agent']} exceeded ${COST_ALERT_THRESHOLD} threshold (actual: ${run['cost_usd']})")
    if run["anomaly"]:
        print(f"[Vigil] COST ANOMALY DETECTED — {run['anomaly_reason']}")
        if RESEND_API_KEY and ALERT_EMAIL:
            email_payload = {
                "to": [ALERT_EMAIL],
                "subject": f"[Farol] Cost anomaly detected — {run['agent']}",
                "text": (
                    "A cost anomaly was detected by Farol.\n\n"
                    f"Agent: {run['agent']}\n"
                    f"Reason: {run.get('anomaly_reason')}\n"
                    f"Run ID: {run['id']}\n"
                    f"Timestamp: {run['timestamp']}\n"
                )
            }
            try:
                resend.Emails.send({
                    **email_payload,
                    "from": "Farol <alerts@usefarol.dev>"
                })
            except Exception:
                try:
                    resend.Emails.send({
                        **email_payload,
                        "from": "Farol <onboarding@resend.dev>"
                    })
                except Exception:
                    pass

def trace(agent_name: str, model: str = "claude-haiku-4-5-20251001", cost_per_1k_tokens: float = 0.00025, farol_key: str = None):
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
                "error": None,
                "anomaly": False,
                "anomaly_reason": None
            }
            if farol_key:
                run["farol_key"] = farol_key

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