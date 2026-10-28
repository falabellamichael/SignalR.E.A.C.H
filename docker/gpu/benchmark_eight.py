import concurrent.futures
import json
import os
import time
import urllib.request

BASE = "http://127.0.0.1:8001"
CONCURRENCY = int(os.environ.get("BENCH_CONCURRENCY", "8"))

def one(i):
    body = {"model": "google/gemma-4-12B-it-qat-q4_0-unquantized",
            "messages": [{"role": "user", "content": f"Request {i}. Explain efficient software testing in detail."}],
            "temperature": 0, "max_tokens": 256, "min_tokens": 256, "ignore_eos": True,
            "chat_template_kwargs": {"enable_thinking": False}}
    start = time.monotonic()
    request = urllib.request.Request(BASE + "/v1/chat/completions", data=json.dumps(body).encode(), headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(request, timeout=300) as response:
        data = json.load(response)
    return {"seconds": time.monotonic() - start, "tokens": data["usage"]["completion_tokens"]}

for wave in range(4):
    start = time.monotonic()
    with concurrent.futures.ThreadPoolExecutor(max_workers=CONCURRENCY) as pool:
        results = list(pool.map(one, range(CONCURRENCY)))
    elapsed = time.monotonic() - start
    print(json.dumps({"wave": wave, "wall_s": elapsed, "tokens_s": sum(r["tokens"] for r in results) / elapsed, "requests": results}), flush=True)
