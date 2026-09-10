#!/usr/bin/env python3
"""Probe every model on every path: relay (/v1) and tray bridge.

Reports status + reply + latency so a failing model is named, not guessed at.
Stdlib only.
"""
import json
import sys
import time
import urllib.error
import urllib.request

RELAY = "http://127.0.0.1:20777"
BRIDGE = "http://127.0.0.1:21302"
PROMPT = "Reply with exactly: PING_OK"
TIMEOUT = 120


def models(base):
    try:
        with urllib.request.urlopen(base + "/v1/models", timeout=10) as r:
            return [m["id"] for m in json.loads(r.read())["data"]]
    except Exception as exc:
        return {"__error__": str(exc)}


def chat(base, model, stream=False):
    body = json.dumps({
        "model": model,
        "messages": [{"role": "user", "content": PROMPT}],
        "max_tokens": 24,
        "stream": stream,
    }).encode()
    req = urllib.request.Request(base + "/v1/chat/completions", data=body,
                                method="POST",
                                headers={"Content-Type": "application/json"})
    started = time.time()
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
            raw = r.read().decode("utf-8", "replace")
            elapsed = time.time() - started
            if stream:
                return 200, "SSE %d bytes" % len(raw), elapsed
            data = json.loads(raw)
            text = (data.get("choices") or [{}])[0].get("message", {}).get("content", "")
            return 200, (text or "").strip()[:60], elapsed
    except urllib.error.HTTPError as exc:
        raw = exc.read().decode("utf-8", "replace")[:300]
        try:
            msg = json.loads(raw).get("error", {}).get("message", raw)
        except Exception:
            msg = raw
        return exc.code, str(msg)[:120], time.time() - started
    except Exception as exc:
        return 0, str(exc)[:120], time.time() - started


def run(label, base, only_eco=False):
    print("\n" + "=" * 78)
    print("%s  (%s)" % (label, base))
    print("=" * 78)
    ids = models(base)
    if isinstance(ids, dict):
        print("  !! cannot list models: %s" % ids["__error__"])
        return 0, 0
    if only_eco:
        ids = [i for i in ids if i.startswith("codegpt-eco")]
    ok = bad = 0
    for mid in ids:
        code, text, secs = chat(base, mid)
        flag = "OK  " if code == 200 else "FAIL"
        if code == 200:
            ok += 1
        else:
            bad += 1
        print("  %s %-38s %3s  %5.1fs  %s" % (flag, mid, code, secs, text))
    return ok, bad


def main():
    total_ok = total_bad = 0
    for label, base, eco in (
        ("RELAY — all models", RELAY, False),
        ("TRAY BRIDGE — economy models", BRIDGE, True),
    ):
        ok, bad = run(label, base, eco)
        total_ok += ok
        total_bad += bad
    print("\n" + "=" * 78)
    print("TOTAL: %d ok, %d failed" % (total_ok, total_bad))
    print("=" * 78)
    return 1 if total_bad else 0


if __name__ == "__main__":
    sys.exit(main())
