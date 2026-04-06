import json

runs = json.load(open("runs.json"))
print(f"{len(runs)} runs logged\n")
for r in runs:
    print(f"  {r['agent']} | {r['duration_ms']}ms | ${r['cost_usd']} | {r['status']}")