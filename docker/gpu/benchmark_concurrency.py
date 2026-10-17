"""Measure native streaming latency under repeat, overlapping, and mixed load."""

import argparse
from concurrent.futures import ThreadPoolExecutor, wait, FIRST_COMPLETED
import json
import math
import statistics
import time
import urllib.request


def percentile(values, fraction):
    ordered = sorted(values)
    return ordered[max(0, math.ceil(len(ordered) * fraction) - 1)] if ordered else None


def request(base, model, prompt, tokens, delay=0):
    time.sleep(delay)
    started = time.perf_counter()
    arrivals = []
    first_content = None
    content_chars = 0
    reasoning_chars = 0
    usage = None
    finished = False
    done = False
    finish_reason = None
    payload = {"model": model, "messages": [{"role": "user", "content": prompt}],
               "max_tokens": tokens, "temperature": 0, "stream": True,
               "stream_options": {"include_usage": True}}
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    req = urllib.request.Request(base + "/v1/chat/completions",
        data=json.dumps(payload).encode(), headers={"Content-Type": "application/json"})
    try:
        with opener.open(req, timeout=300) as response:
            for line in response:
                if not line.startswith(b"data:"):
                    continue
                data = line[5:].strip()
                if data == b"[DONE]":
                    done = True
                    break
                event = json.loads(data)
                if event.get("error"):
                    raise RuntimeError(str(event["error"]))
                if event.get("usage"):
                    usage = event["usage"]
                for choice in event.get("choices", []):
                    delta = choice.get("delta", {})
                    if any(delta.get(key) for key in ("content", "reasoning_content", "reasoning", "tool_calls")):
                        arrived = time.perf_counter()
                        arrivals.append(arrived)
                        if delta.get("content") and first_content is None:
                            first_content = arrived
                    if delta.get("content"):
                        content_chars += len(delta["content"])
                    reasoning_chars += sum(len(delta.get(key) or "") for key in ("reasoning_content", "reasoning"))
                    finished |= choice.get("finish_reason") is not None
                    if choice.get("finish_reason") is not None:
                        finish_reason = choice["finish_reason"]
        if not (done and finished and usage and arrivals):
            raise RuntimeError("Incomplete stream or missing provider usage")
        elapsed = time.perf_counter() - started
        completion_tokens = usage.get("completion_tokens")
        if type(completion_tokens) is not int or completion_tokens < 1:
            raise RuntimeError("Missing or invalid provider completion_tokens")
        gaps = [b - a for a, b in zip(arrivals, arrivals[1:])]
        decode_span = arrivals[-1] - arrivals[0]
        return {"model": model, "elapsed_s": elapsed, "ttft_s": arrivals[0] - started,
                "first_content_s": first_content - started if first_content is not None else None,
                "content_chars": content_chars, "reasoning_chars": reasoning_chars,
                # Approximation: the first SSE chunk can contain multiple speculative tokens.
                # Native server generation metrics remain the authoritative decode measurement.
                "approx_decode_tokens_s": (completion_tokens - 1) / decode_span if decode_span > 0 else None,
                "decode_span_s": decode_span,
                "end_to_end_tokens_s": completion_tokens / elapsed if elapsed > 0 else None,
                "max_chunk_gap_s": max(gaps, default=0), "p95_chunk_gap_s": percentile(gaps, .95),
                "finish_reason": finish_reason, "chunks": len(arrivals), "usage": usage}
    except Exception as exc:
        return {"model": model, "error": str(exc), "elapsed_s": time.perf_counter() - started}


def summarize(samples, wall):
    good = [sample for sample in samples if "error" not in sample]
    rates = [s["end_to_end_tokens_s"] for s in good if s["end_to_end_tokens_s"] is not None]
    tokens = sum(s["usage"]["completion_tokens"] for s in good)
    return {"requests": len(samples), "successful_requests": len(good),
            "errors": len(samples) - len(good), "wall_s": wall,
            "completion_tokens": tokens,
            "p95_ttft_s": percentile([s["ttft_s"] for s in good], .95),
            "requests_with_visible_content": sum(s["first_content_s"] is not None for s in good),
            "p95_first_content_s": percentile([s["first_content_s"] for s in good if s["first_content_s"] is not None], .95),
            "p95_elapsed_s": percentile([s["elapsed_s"] for s in good], .95),
            "p95_max_chunk_gap_s": percentile([s["max_chunk_gap_s"] for s in good], .95),
            "aggregate_tokens_s": tokens / wall if wall > 0 else None,
            "median_end_to_end_tokens_s": statistics.median(rates) if rates else None}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--gemma", default="http://127.0.0.1:18001")
    parser.add_argument("--minicpm", default="http://127.0.0.1:18004")
    parser.add_argument("--rounds", type=int, default=3)
    parser.add_argument("--tokens", type=int, default=192)
    parser.add_argument("--concurrency", type=int, nargs="+", default=[1, 2, 4])
    parser.add_argument("--models", nargs="+", choices=["gemma", "minicpm"], default=["gemma", "minicpm"])
    parser.add_argument("--prompt-lines", type=int, default=0)
    parser.add_argument("--shared-prefix", action="store_true",
                        help="Model agent follow-ups with stable reference context before each unique task")
    parser.add_argument("--stagger", type=float, default=0)
    parser.add_argument("--requests", type=int, default=0,
                        help="Requests per round; refill completed slots to sustain concurrency (0: one wave)")
    parser.add_argument("--warmup", type=int, default=1, help="Unmeasured requests per model")
    args = parser.parse_args()
    if args.rounds < 1 or args.tokens < 2 or min(args.concurrency) < 1 or args.prompt_lines < 0 or not math.isfinite(args.stagger) or args.stagger < 0:
        parser.error("rounds/concurrency must be positive, tokens >= 2, and prompt-lines/stagger nonnegative")
    if args.warmup < 0 or args.requests < 0 or (args.requests and args.requests < max(args.concurrency)):
        parser.error("warmup must be nonnegative; requests must be zero or >= maximum concurrency")
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    targets = {}
    for name in args.models:
        base = getattr(args, name).rstrip("/")
        with opener.open(base + "/v1/models", timeout=10) as response:
            targets[name] = (base, json.load(response)["data"][0]["id"])
        for _ in range(args.warmup):
            result = request(*targets[name], "Explain database transactions.", args.tokens)
            if "error" in result:
                raise RuntimeError(f"{name} warmup failed: {result['error']}")
    groups = [[name] for name in targets]
    if len(targets) > 1:
        groups.append(list(targets))
    failed = False
    for names in groups:
        for concurrency in args.concurrency:
            samples = []
            wall = 0
            for round_index in range(args.rounds):
                started = time.perf_counter()
                with ThreadPoolExecutor(max_workers=concurrency) as pool:
                    count = args.requests or concurrency
                    def submit(index):
                        name = names[(round_index * count + index) % len(names)]
                        # Unique leading content prevents previous rounds masking prefill cost.
                        prompt = f"Run {time.time_ns()} round {round_index} request {index}.\n"
                        prompt += "Explain how a database handles concurrent transactions in detail. "
                        prompt += "Write a long technical explanation with examples.\n"
                        reference = "Transaction records: reads, writes, locks, commits, rollbacks.\n" * args.prompt_lines
                        prompt = reference + prompt if args.shared_prefix else prompt + reference
                        delay = index * args.stagger if index < concurrency else 0
                        return pool.submit(request, *targets[name], prompt, args.tokens, delay)
                    pending = {submit(index): index for index in range(concurrency)}
                    next_index = concurrency
                    results = []
                    while pending:
                        completed, _ = wait(pending, return_when=FIRST_COMPLETED)
                        for future in completed:
                            index = pending.pop(future)
                            name = names[(round_index * count + index) % len(names)]
                            try:
                                result = future.result()
                            except Exception as exc:
                                result = {"error": str(exc)}
                            results.append({**result, "model": targets[name][1], "target": name,
                                            "round": round_index, "request": index})
                            if next_index < count:
                                pending[submit(next_index)] = next_index
                                next_index += 1
                wall += time.perf_counter() - started
                samples.extend(results)
            report = {"models": names, "concurrency": concurrency, "rounds": args.rounds,
                      "requests_per_round": args.requests or concurrency,
                      "shared_prefix": args.shared_prefix, "prompt_lines": args.prompt_lines,
                      **summarize(samples, wall),
                      # Shared wall time makes per-target contributions additive under mixed load.
                      "per_model": {name: {"model": targets[name][1],
                          **summarize([s for s in samples if s["target"] == name], wall)}
                          for name in names},
                      "samples": samples}
            failed |= report["errors"] > 0
            print(json.dumps(report), flush=True)
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
