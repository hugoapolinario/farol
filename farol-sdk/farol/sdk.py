"""
Farol SDK — trace decorator and run sync.

Optional integrations (install extras: pip install 'farol-sdk[supabase]' etc.):
  - supabase: sync runs, baseline lookup for anomaly detection
  - resend: email alerts on cost anomalies

Environment variables (when using integrations):
  SUPABASE_URL, SUPABASE_KEY — read baseline / optional anon client
  SUPABASE_SERVICE_KEY — if set, used for api_keys lookup and runs insert (recommended)
  RESEND_API_KEY, ALERT_EMAIL — anomaly emails
"""

from __future__ import annotations

import os
import statistics
import time
from datetime import datetime
from typing import Any, Callable, Optional, TypeVar

COST_ALERT_THRESHOLD = 0.0001

try:
    from supabase import create_client as _create_client
except ImportError:  # pragma: no cover
    _create_client = None  # type: ignore[misc, assignment]

try:
    import resend as _resend
except ImportError:  # pragma: no cover
    _resend = None

F = TypeVar("F", bound=Callable[..., Any])

_supabase_read = None
_supabase_admin = None
_clients_initialized = False


def _init_supabase_clients() -> None:
    global _supabase_read, _supabase_admin, _clients_initialized
    if _clients_initialized:
        return
    _clients_initialized = True
    if _create_client is None:
        return
    url = os.environ.get("SUPABASE_URL")
    key = os.environ.get("SUPABASE_KEY")
    service = os.environ.get("SUPABASE_SERVICE_KEY")
    if not url or not key:
        return
    try:
        _supabase_read = _create_client(url, key)
        _supabase_admin = _create_client(url, service) if service else _supabase_read
    except Exception:  # pragma: no cover
        _supabase_read = None
        _supabase_admin = None


def _supabase_ready() -> bool:
    _init_supabase_clients()
    return _supabase_read is not None and _supabase_admin is not None


def _finalize_run_logging(run: dict) -> None:
    print(
        f"[Farol] Run recorded — {run['duration_ms']}ms | ${run['cost_usd']} | "
        f"status: {run['status']}"
    )
    if run["cost_usd"] > COST_ALERT_THRESHOLD:
        print(
            f"[Farol] COST ALERT — {run['agent']} exceeded ${COST_ALERT_THRESHOLD} "
            f"threshold (actual: ${run['cost_usd']})"
        )
    if run["anomaly"]:
        print(f"[Farol] COST ANOMALY DETECTED — {run['anomaly_reason']}")
        _send_anomaly_email(run)


def _send_anomaly_email(run: dict) -> None:
    if _resend is None:
        return
    api_key = os.environ.get("RESEND_API_KEY")
    alert_to = os.environ.get("ALERT_EMAIL")
    if not api_key or not alert_to:
        return
    _resend.api_key = api_key
    email_payload = {
        "to": [alert_to],
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
        _resend.Emails.send({**email_payload, "from": "Farol <alerts@usefarol.dev>"})
    except Exception:
        try:
            _resend.Emails.send({**email_payload, "from": "Farol <onboarding@resend.dev>"})
        except Exception:
            pass


def save_run(run: dict) -> None:
    anomaly = False
    anomaly_reason: Optional[str] = None

    if _supabase_ready() and _supabase_read is not None:
        try:
            baseline_response = (
                _supabase_read.table("runs")
                .select("cost_usd")
                .eq("agent", run["agent"])
                .eq("status", "success")
                .order("timestamp", desc=True)
                .limit(20)
                .execute()
            )
            baseline_rows = baseline_response.data or []
        except Exception as e:
            print(f"[Farol] Baseline lookup failed: {e}")
            baseline_rows = []
    else:
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

    if not _supabase_ready() or _supabase_admin is None:
        _finalize_run_logging(run)
        return

    try:
        user_id = None
        if run.get("farol_key"):
            try:
                key_res = (
                    _supabase_admin.table("api_keys")
                    .select("user_id")
                    .eq("api_key", run["farol_key"])
                    .limit(1)
                    .execute()
                )
                key_rows = key_res.data or []
                if key_rows and key_rows[0].get("user_id"):
                    user_id = key_rows[0].get("user_id")
                else:
                    print("[Farol] Invalid API key — run not synced")
                    return
            except Exception:
                print("[Farol] Invalid API key — run not synced")
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
            "timestamp": run["timestamp"],
        }
        if user_id is not None:
            payload["user_id"] = user_id

        _supabase_admin.table("runs").insert(payload).execute()
        print("[Farol] Synced to Supabase")
    except Exception as e:
        print(f"[Farol] Supabase sync failed: {e}")

    _finalize_run_logging(run)


def trace(
    agent_name: str,
    farol_key: Optional[str] = None,
    model: str = "claude-haiku-4-5-20251001",
    cost_per_1k_input_tokens: float = 0.00025,
    cost_per_1k_output_tokens: float = 0.00125,
) -> Callable[[F], F]:
    def decorator(func: F) -> F:
        def wrapper(*args: Any, **kwargs: Any) -> Any:
            run: dict[str, Any] = {
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
                    (run["input_tokens"] / 1000 * cost_per_1k_input_tokens) +
                    (run["output_tokens"] / 1000 * cost_per_1k_output_tokens),
                    6,
                )
                save_run(run)

        return wrapper  # type: ignore[return-value]

    return decorator
