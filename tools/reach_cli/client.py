"""Endpoint client: the OpenAI-compatible REACH relay.

Talks to the local relay (or the public pointer gist) with
streaming chat completions, model listing, and pointer fallback.
"""

import http.client
import json
import os
import socket
import time
import urllib.error
import urllib.parse
import urllib.request


POINTER_GIST = (
    "https://gist.githubusercontent.com/falabellamichael/"
    "e261e0c31ad08c373bcd667b6982847a/raw/simple-reach-endpoint.txt"
)




class ReachApiError(RuntimeError):
    def __init__(self, message="", status=None):
        super().__init__(message)
        self.status = status


# HTTP statuses worth retrying on the SAME provider and model.
TRANSIENT_HTTP = {408, 429, 500, 502, 503, 504}


class ReachTransientError(ReachApiError):
    """A retryable failure (busy upstream, timeout, reset, cut stream).

    ``partial`` carries whatever was received before the failure:
    {"content": str, "tool_calls": [...]} so the caller can keep it.
    """

    def __init__(self, message, partial=None, status=None):
        super().__init__(message, status=status)
        self.partial = partial or {"content": "", "tool_calls": []}


def _usage_dict(usage):
    usage = usage if isinstance(usage, dict) else {}
    return {"prompt": usage.get("prompt_tokens"),
            "completion": usage.get("completion_tokens"),
            "total": usage.get("total_tokens")}


def usage_tokens(usage):
    """Total tokens from a usage dict, or None when the endpoint sent none."""
    usage = usage or {}
    if isinstance(usage.get("total"), int):
        return usage["total"]
    parts = [usage.get(k) for k in ("prompt", "completion")]
    if any(isinstance(p, int) for p in parts):
        return sum(p for p in parts if isinstance(p, int))
    return None


def _merge_tool_delta(slots, fragments):
    """Accumulate streamed tool_call fragments by index into ``slots``."""
    for frag in fragments or []:
        if not isinstance(frag, dict):
            continue
        index = frag.get("index")
        if not isinstance(index, int):
            index = len(slots) if frag.get("id") else max(len(slots) - 1, 0)
        slot = slots.setdefault(index, {
            "id": "", "type": "function",
            "function": {"name": "", "arguments": ""},
        })
        if frag.get("id"):
            slot["id"] = frag["id"]
        fn = frag.get("function") or {}
        if fn.get("name"):
            slot["function"]["name"] += fn["name"]
        if fn.get("arguments"):
            args = fn["arguments"]
            if not isinstance(args, str):
                args = json.dumps(args)
            slot["function"]["arguments"] += args


def _finish_tool_calls(slots):
    calls = []
    for index in sorted(slots):
        call = slots[index]
        if not call["function"]["name"]:
            continue
        if not call["id"]:
            call["id"] = "call_%d" % index
        calls.append(call)
    return calls


def _auth_headers(key, extra=None):
    headers = dict(extra or {})
    if key:
        headers["Authorization"] = "Bearer " + key
    return headers




def _error_text(raw, base):
    """Best-effort extraction of API error text."""
    if isinstance(raw, str):
        raw = raw.encode("utf-8", "replace")
    if not isinstance(raw, (bytes, bytearray)):
        raw = b""
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
    def __init__(self, base, model=None, timeout=600, no_stream=False, key=None):
        self.base = base.rstrip("/")
        # An sk-reach key, needed for a hosted relay that requires one. A relay
        # on this machine does not, so the default (no key) still works there.
        self.key = (key or os.environ.get("REACH_KEY") or "").strip()
        self.model = model
        self.timeout = timeout
        self.no_stream = no_stream
        self.usage = {"prompt": None, "completion": None}
        self.last_latency_ms = 0.0
        # Footer hook contract (read by terminal.print_footer):
        # {"tokens": int|None, "rounds": int, "latency": float seconds}
        self.last_turn = {"tokens": None, "rounds": 0, "latency": 0.0}
        self.system = None
        self.agent = False
        self.workpath = os.getcwd()

    def _headers(self, extra=None):
        return _auth_headers(self.key, extra)

    def resolve_base(self):
        """The endpoint to use. Never substitutes a different endpoint.

        The public pointer gist is consulted only when "public" was chosen
        explicitly (``--base public``). Any other base (a URL, the local
        preset, REACH_BASE_URL) is used as-is even if it is down right now,
        so an unreachable endpoint is reported instead of silently replaced.
        Returns None only when the public pointer cannot be read.
        """
        if (self.base or "").strip().lower() == "public":
            url = discover_public_url()
            return url.rstrip("/") if url else None
        return self.base
    @staticmethod
    def _reachable(base, key=""):
        try:
            request = urllib.request.Request(base.rstrip("/") + "/models",
                                             headers=_auth_headers(key))
            with urllib.request.urlopen(request, timeout=5) as resp:
                return resp.status == 200
        except urllib.error.HTTPError as exc:
            # 401/403 means a relay answered and wants a key. That is reachable;
            # the real request will then report the key problem, instead of the
            # CLI claiming nothing is there.
            return exc.code in (401, 403)
        except Exception:
            return False

    def models(self):
        request = urllib.request.Request(self.base + "/models",
                                         headers=self._headers())
        with urllib.request.urlopen(request, timeout=15) as resp:
            data = json.loads(resp.read().decode("utf-8", "replace"))
        return [m.get("id") for m in data.get("data", []) if m.get("id")]

    def complete(self, messages, tools=None, on_text=None, stream=True):
        """One request attempt. Returns {"content", "tool_calls"}.

        Streams text deltas to ``on_text`` as they arrive and accumulates
        native tool_call fragments by index. Retryable failures raise
        ReachTransientError carrying the partial result; never changes
        ``self.model`` or ``self.base``.
        """
        payload = {"messages": messages}
        if self.model:
            payload["model"] = self.model
        if tools:
            payload["tools"] = tools
            payload["tool_choice"] = "auto"
        payload["stream"] = bool(stream and not self.no_stream)
        started = time.time()
        request = urllib.request.Request(
            self.base + "/chat/completions",
            data=json.dumps(payload).encode("utf-8"),
            method="POST",
            headers=self._headers({"Content-Type": "application/json"}),
        )
        text = []
        slots = {}

        def partial():
            return {"content": "".join(text),
                    "tool_calls": _finish_tool_calls(slots)}

        try:
            response = urllib.request.urlopen(request, timeout=self.timeout)
        except urllib.error.HTTPError as exc:
            try:
                body = exc.read()
            except Exception:
                body = b""
            message = "endpoint error (HTTP %s): %s" % (
                exc.code, _error_text(body, self.base))
            if exc.code in TRANSIENT_HTTP:
                raise ReachTransientError(message, status=exc.code) from None
            raise ReachApiError(message, status=exc.code) from None
        except (socket.timeout, TimeoutError) as exc:
            raise ReachTransientError("timed out: %s" % exc, status="timeout") from None
        except urllib.error.URLError as exc:
            reason = getattr(exc, "reason", None)
            if isinstance(reason, (socket.timeout, TimeoutError)) or "timed out" in str(exc):
                raise ReachTransientError("timed out: %s" % exc, status="timeout") from None
            raise ReachTransientError("endpoint unreachable: %s" % exc,
                                      status="unreachable") from None
        except ( socket.timeout, TimeoutError,
                ConnectionError, http.client.HTTPException, OSError) as exc:
            raise ReachTransientError("endpoint unreachable: %s" % exc,
                                      status="unreachable") from None

        try:
            with response:
                if not payload["stream"]:
                    try:
                        data = json.loads(response.read().decode("utf-8", "replace"))
                    except ValueError:
                        raise ReachTransientError("malformed endpoint response") from None
                    usage = data.get("usage") or {}
                    self.usage = _usage_dict(usage)
                    message = ((data.get("choices") or [{}])[0] or {}).get("message") or {}
                    content = message.get("content") or ""
                    if content and on_text:
                        on_text(content)
                    text.append(content)
                    for i, call in enumerate(message.get("tool_calls") or []):
                        frag = dict(call)
                        frag.setdefault("index", i)
                        _merge_tool_delta(slots, [frag])
                    self.last_latency_ms = (time.time() - started) * 1000
                    result = partial()
                    if not result["content"] and not result["tool_calls"]:
                        raise ReachTransientError("empty endpoint response")
                    return result
                saw_sse = False
                done = False
                stream_usage = None
                raw_rest = b""
                for raw in response:
                    line = raw.decode("utf-8", "replace").strip()
                    if not line.startswith("data:"):
                        raw_rest += raw
                        continue
                    saw_sse = True
                    chunk = line[5:].strip()
                    if chunk == "[DONE]":
                        done = True
                        break
                    try:
                        obj = json.loads(chunk)
                        choice = (obj.get("choices") or [{}])[0] or {}
                    except (ValueError, AttributeError, IndexError):
                        continue
                    if isinstance(obj.get("usage"), dict):  # final usage chunk
                        stream_usage = _usage_dict(obj["usage"])
                    delta = choice.get("delta") or {}
                    content = delta.get("content")
                    if content:
                        text.append(content)
                        if on_text:
                            on_text(content)
                    _merge_tool_delta(slots, delta.get("tool_calls"))
                    if choice.get("finish_reason"):
                        done = True
        except ReachTransientError:
            raise
        except (socket.timeout, TimeoutError, ConnectionError,
                http.client.HTTPException, OSError, ValueError) as exc:
            kind = "timeout" if isinstance(exc, (socket.timeout, TimeoutError)) else "cut"
            raise ReachTransientError("stream cut: %s" % exc, partial(), status=kind) from None
        self.last_latency_ms = (time.time() - started) * 1000
        self.usage = stream_usage or _usage_dict({})
        result = partial()
        if not saw_sse:
            raise ReachTransientError(
                "endpoint error: " + _error_text(raw_rest, self.base), result)
        if not done or (not result["content"] and not result["tool_calls"]):
            raise ReachTransientError("stream ended early", result, status="cut")
        return result

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
            headers=self._headers({"Content-Type": "application/json"}),
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
            except urllib.error.URLError as exc:
                raise ReachApiError("endpoint unreachable: %s" % exc) from exc
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
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as resp:
                data = json.loads(resp.read().decode("utf-8", "replace"))
        except urllib.error.HTTPError as exc:
            raise ReachApiError(
                "endpoint error (HTTP %s): %s"
                % (exc.code, _error_text(exc.read(), self.base))
            ) from exc
        except urllib.error.URLError as exc:
            raise ReachApiError("endpoint unreachable: %s" % exc) from exc
        except (ValueError, UnicodeDecodeError) as exc:
            raise ReachApiError("malformed endpoint response: %s" % exc) from exc
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
