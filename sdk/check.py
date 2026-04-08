import json
import os

_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
_RUNS = os.path.join(_ROOT, "runs.json")

runs = json.load(open(_RUNS))
print(f"{len(runs)} runs logged\n")
for r in runs:
    print(f"  {r['agent']} | {r['duration_ms']}ms | ${r['cost_usd']} | {r['status']}")
