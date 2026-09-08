"""Endpoint client: the OpenAI-compatible REACH relay.

Talks to the local relay (or the public pointer gist) with
streaming chat completions, model listing, and pointer fallback.
"""

import json
import os
import time
import urllib.error
import urllib.parse
import urllib.request


POINTER_GIST = (
    "https://gist.githubusercontent.com/falabellamichael/"
    "e261e0c31ad08c373bcd667b6982847a/raw/simple-reach-endpoint.txt"
)




class ReachApiError(RuntimeError):
    pass




def _error_text(raw, base):
    try:
        payload = json.loads(raw.decode("utf-8", "replace"))
        error = payload.get("error") or {}
        message = error.get("message") or json.dumps(payload)[:200]
        if error.get("reset_seconds"):
            message += " (retry in ~%ss)" % error["reset_seconds"]
        return message.strip()
    except Exception:
        text = raw.decode("utf-8", "replace").strip()
        return text[:200] or "no response body from %s" % base




class ReachClient:
    def __init__(self, base, model=None, timeout=600, no_stream=False):
        self.base = base.rstrip("/")
        self.model = model
        self.timeout = timeout
        self.no_stream = no_stream
        self.usage = {"prompt": None, "completion": None}
        self.last_latency_ms = 0.0
        self.system = None
        self.agent = False
        self.workpath = os.getcwd()

    def resolve_base(self):
        """Fall back to the public pointer gist when the local relay is down."""
        if self._reachable(self.base):
            return self.base
        try:
            with urllib.request.urlopen(POINTER_GIST, timeout=8) as resp:
                url = resp.read().decode().strip()
            if url and self._reachable(url):
                return url.rstrip("/")
        except Exception:
            pass
        return None

    @staticmethod
    def _reachable(base):
        try:
            request = urllib.request.Request(base.rstrip("/") + "/models")
            with urllib.request.urlopen(request, timeout=5) as resp:
                return resp.status == 200
        except Exception:
            return False

    def models(self):
        request = urllib.request.Request(self.base + "/models")
        with urllib.request.urlopen(request, timeout=15) as resp:
            data = json.loads(resp.read().decode("utf-8", "replace"))
        return [m.get("id") for m in data.get("data", []) if m.get("id")]

    def chat(self, messages, stream=True):
        """Yields text deltas; sets usage/last_latency_ms at the end."""
        payload = {"messages": messages}
        if self.model:
            payload["model"] = self.model
        payload["stream"] = stream and not self.no_stream
        started = time.time()
        request = urllib.request.Request(
            self.base + "/chat/completions",
            data=json.dumps(payload).encode("utf-8"),
            method="POST",
            headers={"Content-Type": "application/json"},
        )
        if payload["stream"]:
            chunks = []
            saw_sse = False
            raw_rest = b""
            try:
                response = urllib.request.urlopen(request, timeout=self.timeout)
            except urllib.error.HTTPError as exc:
                raise ReachApiError(
                    "endpoint error (HTTP %s): %s"
                    % (exc.code, _error_text(exc.read(), self.base))
                ) from exc
            with response:
                for raw in response:
                    line = raw.decode("utf-8", "replace").strip()
                    if not line.startswith("data:"):
                        # not SSE — likely an inline error body; keep reading
                        raw_rest += raw
                        continue
                    saw_sse = True
                    chunk = line[5:].strip()
                    if chunk == "[DONE]":
                        break
                    try:
                        delta = (json.loads(chunk).get("choices") or [{}])[0].get(
                            "delta", {}
                        )
                    except json.JSONDecodeError:
                        continue
                    content = delta.get("content")
                    if content:
                        chunks.append(content)
                        yield content
            self.last_latency_ms = (time.time() - started) * 1000
            if not chunks and (raw_rest or not saw_sse):
                raise ReachApiError(
                    "endpoint error: " + _error_text(raw_rest, self.base)
                )
            if not chunks and saw_sse:
                raise ReachApiError(
                    "stream ended without content — upstream may be cooling "
                    "down; try another model or retry shortly"
                )
            self.usage = {"prompt": None, "completion": None}
            return
        with urllib.request.urlopen(request, timeout=self.timeout) as resp:
            data = json.loads(resp.read().decode("utf-8", "replace"))
        self.last_latency_ms = (time.time() - started) * 1000
        usage = data.get("usage") or {}
        self.usage = {
            "prompt": usage.get("prompt_tokens"),
            "completion": usage.get("completion_tokens"),
        }
        content = (data.get("choices") or [{}])[0].get("message", {}).get("content")
        yield content or ""




def discover_public_url():
    try:
        with urllib.request.urlopen(POINTER_GIST, timeout=8) as resp:
            return resp.read().decode().strip()
    except Exception:
        return None
