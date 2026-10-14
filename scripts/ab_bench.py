#!/usr/bin/env python3
"""Qwen2.5-7B vs Ternary-Bonsai A/B coding benchmark (same machine).

Metrics per prompt: tps (output tokens/sec), wall time, errors, and a
simple completeness score by string match against reference answer parts.
Run against the llama-server HTTP API at BASE_URL.

Usage:
  python3 bench.py --base http://127.0.0.1:PORT --name "Ternary-Bonsai" --repeat 5
"""
import argparse, json, sys, time, urllib.request, urllib.error

DEFAULT_PROMPTS = [
    {
        "id": "code-generate",
        "role": "coding generation",
        "prompt": (
            "Write a Python function `dedup_sorted` that takes an unsorted list of "
            "hashable items and returns a new list with duplicates removed while "
            "preserving first-seen order. Include type hints and a docstring, and "
            "add 3 short doctests as assertions in the prompt example."
        ),
        "ref_keywords": ["def dedup_sorted", "return", "seen"],
    },
    {
        "id": "code-refactor",
        "role": "refactoring",
        "prompt": (
            "Refactor this Python function to remove code smells and make it more "
            "readable. Explain each change in one line of comment:\n\n"
            "def f(d):\n    r={}\n    for k in d:\n        if not k in r:\n            r[k]=1\n"
            "    else:\n        r[k]=r[k]+1\n    return r\n"
        ),
        "ref_keywords": ["return", "Counter", "dict", "defaultdict"],
    },
]

def post(base_url, payload, timeout=180):
    data = json.dumps(payload).encode()
    req = urllib.request.Request(
        base_url.rstrip("/") + "/completion",
        data=data, method="POST",
        headers={"Content-Type": "application/json"},
    )
    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            body = json.loads(r.read().decode())
    except (urllib.error.URLError, TimeoutError) as e:
        return {"error": str(e), "t_ok": time.time() - t0}
    elapsed = time.time() - t0
    tok = 0
    out = ""
    # llama-server may return completion or chat style; be lenient.
    if isinstance(body, dict):
        out = (body.get("message", {}).get("content")
               or body.get("choices", [{}])[0].get("message", {}).get("content")
               or body.get("content") or "")
        tok = int(body.get("eval_count", 0)
                  or len(out.split()) * (2 if not out.strip() else 1))
    return {"ok": True, "out": out, "tok": tok, "elapsed": elapsed}

def score(text, keywords):
    hits = sum(1 for k in keywords if k.lower() in text.lower())
    return round(hits / len(keywords), 3)

def run(base_url, name, repeat, prompts=None, n_predict=512, only_id=None):
    prompts = [p for p in (prompts or DEFAULT_PROMPTS) if only_id is None or p["id"] == only_id]
    print(f"\n===== {name} : {repeat} reps =====", flush=True)
    tps_all, errs, comp_all, wall_all = [], {}, [], []
    for i in range(1, repeat + 1):
        row = {}
        for p in prompts:
            payload = {
                "prompt": p["prompt"],
                "n_predict": n_predict,
                "temperature": 0.3,
                "top_k": 40, "top_p": 0.9,
                "stream": False,
                "seed": 7,
            }
            res = post(base_url, payload)
            if not res.get("ok"):
                errs[p["id"]] = errs.get(p["id"], 0) + 1
                row[p["id"]] = {"err": res.get("error")}
                continue
            s = score(res["out"], p["ref_keywords"])
            tps = round(res["tok"] / max(res["elapsed"], 1e-6), 1)
            row[p["id"]] = {
                "tps": tps, "tok": res["tok"],
                "wall_s": round(res["elapsed"], 2),
                "completeness": s,
            }
            tps_all.append(tps); comp_all.append(s); wall_all.append(res["elapsed"])
        print(f"  [{i}] {json.dumps(row, ensure_ascii=False)}", flush=True)
    def avg(x): return round(sum(x)/len(x), 2) if x else float("nan")
    out = {
        "model": name, "repeat": repeat,
        "tps_avg": [avg(tps_all)],
        "wall_avg_s": avg(wall_all),
        "completeness_avg": avg(comp_all),
        "errors": errs,
        "per_prompt_row": row if len(prompts) == 1 else {},
    }
    print(f"--- SUMMARY {name}: tps~{out['tps_avg'][0]} wall~{out['wall_avg_s']}s "
          f"comp~{out['completeness_avg']} "
          f"errors={errs} ---", flush=True)
    return out

if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", required=True)
    ap.add_argument("--name", default="model")
    ap.add_argument("--repeat", type=int, default=3)
    ap.add_argument("--only-id", default=None, help="run only this prompt id (code-generate|code-refactor)")
    ap.add_argument("--n-predict", type=int, default=128)
    a = ap.parse_args()
    json.dump(run(a.base, a.name, a.repeat, n_predict=a.n_predict, only_id=a.only_id), open("/tmp/bench_result.json","w"), indent=2, ensure_ascii=False)
    print("wrote /tmp/bench_result.json", flush=True)
