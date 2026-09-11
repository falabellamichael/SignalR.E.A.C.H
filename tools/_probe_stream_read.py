"""Scratch probe: does urllib readline() on the bridge's SSE respond as data
arrives, or only when the response completes? Mirrors how reachd reads the
bridge (urllib.request.urlopen + readline)."""
import json
import sys
import time
import urllib.request

target = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:21302/v1/chat/completions"
model = sys.argv[2] if len(sys.argv) > 2 else "codegpt-eco-MiniMax-M3"
prompt = sys.argv[3] if len(sys.argv) > 3 else "Describe a mountain lake in exactly five sentences."

body = json.dumps({"model": model, "stream": True, "messages": [{"role": "user", "content": prompt}]}).encode()
req = urllib.request.Request(target, data=body, method="POST", headers={"Content-Type": "application/json"})
started = time.time()
with urllib.request.urlopen(req, timeout=300) as resp:
    while True:
        line = resp.readline()
        if not line:
            break
        print("%6.2fs  %s" % (time.time() - started, line[:70].decode("utf-8", "replace").rstrip()))
