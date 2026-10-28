"""Verify an abandoned non-streaming request releases the vLLM connection."""
import http.client
import json
import os
import time
import urllib.request
from urllib.parse import urlsplit

base = os.environ.get("LOCALS_PROBE_URL", "http://127.0.0.1:8001")
url = urlsplit(base)
def health():
    with urllib.request.urlopen(base + "/health", timeout=10) as response:
        return json.load(response)

before = health()["locals"]["disconnects"]
connection = http.client.HTTPConnection(url.hostname, url.port, timeout=10)
connection.request("POST", "/v1/chat/completions", json.dumps({
    "model": "locals", "messages": [{"role": "user", "content": "Explain number theory in exhaustive detail."}],
    "max_tokens": 4096, "stream": False}), {"Content-Type": "application/json"})
time.sleep(0.5)
connection.close()
for _ in range(30):
    if health()["locals"]["disconnects"] > before:
        print("PASS abandoned_nonstreaming_request_cancelled")
        break
    time.sleep(0.2)
else:
    raise AssertionError("Disconnect not detected")
