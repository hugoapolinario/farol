from __future__ import annotations

import time
import json
import os
import statistics
import urllib.error
import urllib.request
from datetime import datetime
from typing import Optional
from dotenv import load_dotenv
import resend

_PROJECT_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
load_dotenv(os.path.join(_PROJECT_ROOT, ".env"))

LOGS_FILE = os.path.join(_PROJECT_ROOT, "runs.json")
COST_ALERT_THRESHOLD = 0.0001
RESEND_API_KEY = os.getenv("RESEND_API_KEY")
ALERT_EMAIL = os.getenv("ALERT_EMAIL")
resend.api_key = RESEND_API_KEY

DEFAULT_INGEST_URL = "https://usefarol.dev/api/ingest"


def load_runs():
    if not os.path.exists(LOGS_FILE):
        return []
    with open(LOGS_FILE, "r") as f:
        return json.load(f)


def _post_ingest(payload: dict, url: str) -> None:
    """POST JSON to ingest API. Raises on hard failures; prints server error body on HTTP errors."""
    data = json.dumps(payload, default=str).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=data,
        method="POST",
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            body = resp.read().decode("utf-8")
            if resp.status != 200:
                print(f"[Farol] Ingest failed ({resp.status}): {body}")
                return
            try:
                parsed = json.loads(body)
            except json.JSONDecodeError:
                print(f"[Farol] Ingest unexpected response: {body}")
                return
            if not parsed.get("success"):
                print(f"[Farol] Ingest error: {parsed.get('error', body)}")
            else:
                print("[Farol] Synced to Farol")
    except urllib.error.HTTPError as e:
        try:
            err_body = e.read().decode("utf-8")
            parsed = json.loads(err_body)
            msg = parsed.get("error", err_body)
        except Exception:
            msg = e.reason
        print(f"[Farol] Ingest failed ({e.code}): {msg}")
    except urllib.error.URLError as e:
        print(f"[Farol] Ingest request failed: {e.reason}")


def save_run(run: dict, farol_key: Optional[str], farol_endpoint: str):
    anomaly = False
    anomaly_reason = None

    baseline_rows = []
    for prev in load_runs():
        if prev.get("agent") == run["agent"] and prev.get("status") == "success":
            try:
                baseline_rows.append(float(prev.get("cost_usd")))
            except (TypeError, ValueError):
                continue
    baseline_rows = baseline_rows[-20:]

    if len(baseline_rows) < 5:
        anomaly = False
        anomaly_reason = "Building baseline — need 5+ runs"
    else:
        median_cost = statistics.median(baseline_rows)
        mean_cost = statistics.mean(baseline_rows)
        std_dev_cost = statistics.stdev(baseline_rows)
        current_cost = float(run["cost_usd"])

        is_over_3x_median = current_cost > (3 * median_cost)
        is_over_2x_and_2std = current_cost > (2 * median_cost) and current_cost > (
            mean_cost + (2 * std_dev_cost)
        )

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

    runs = load_runs()
    runs.append(run)
    with open(LOGS_FILE, "w") as f:
        json.dump(runs, f, indent=2)

    if farol_key:
        ingest_url = os.environ.get("FAROL_ENDPOINT", farol_endpoint)
        payload = {**run, "farol_key": farol_key}
        _post_ingest(payload, ingest_url)
    else:
        print("[Farol] No API key — not sent to Farol (local runs.json only)")

    print(f"[Farol] Run recorded — {run['duration_ms']}ms | ${run['cost_usd']} | status: {run['status']}")
    if run["cost_usd"] > COST_ALERT_THRESHOLD:
        print(
            f"[Farol] COST ALERT — {run['agent']} exceeded ${COST_ALERT_THRESHOLD} "
            f"threshold (actual: ${run['cost_usd']})"
        )
    if run["anomaly"]:
        print(f"[Farol] COST ANOMALY DETECTED — {run['anomaly_reason']}")
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
                ),
            }
            try:
                resend.Emails.send({**email_payload, "from": "Farol <alerts@usefarol.dev>"})
            except Exception:
                try:
                    resend.Emails.send({**email_payload, "from": "Farol <onboarding@resend.dev>"})
                except Exception:
                    pass


def trace(
    agent_name: str,
    model: str = "claude-haiku-4-5-20251001",
    cost_per_1k_tokens: float = 0.00025,
    farol_key: Optional[str] = None,
    farol_endpoint: str = DEFAULT_INGEST_URL,
):
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
                "anomaly_reason": None,
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
                    (run["input_tokens"] + run["output_tokens"]) / 1000 * cost_per_1k_tokens,
                    6,
                )
                save_run(run, farol_key, farol_endpoint)

        return wrapper

    return decorator
