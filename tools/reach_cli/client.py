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
import unicodedata


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




def _safe_text(value, key="", limit=None):
    value = str(value or "")
    value = "".join(ch for ch in value if ch in "\n\r\t" or not unicodedata.category(ch) in ("Cc", "Cf", "Cs"))
    if key:
        value = value.replace(key, "[credential redacted]")
    return value if limit is None else value[:limit]


class _TextRedactor:
    """Keep credential prefixes between deltas so split echoes stay private."""
    def __init__(self, key):
        self.key = key
        self.pending = ""

    def feed(self, value, final=False):
        value = self.pending + _safe_text(value)
        self.pending = ""
        if self.key:
            value = value.replace(self.key, "[credential redacted]")
            if not final:
                for length in range(min(len(value), len(self.key) - 1), 0, -1):
                    if value.endswith(self.key[:length]):
                        self.pending = value[-length:]
                        value = value[:-length]
                        break
            elif value and self.key.startswith(value):
                value = "[credential redacted]"
        return _safe_text(value)


def _request(url, key="", **kwargs):
    # urllib intentionally excludes unredirected headers on redirected requests.
    # Preserve ordinary urlopen hooks while preventing cross-host key forwarding.
    request = urllib.request.Request(url, **kwargs)
    if key:
        request.add_unredirected_header("Authorization", "Bearer " + key)
    return request


def _error_text(raw, base, key=""):
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
        return _safe_text(message, key, 1000).strip()
    except Exception:
        text = raw.decode("utf-8", "replace").strip()
        return _safe_text(text, key, 200) or "no response body from %s" % _safe_text(base, key, 200)




class ReachClient:
    def __init__(self, base, model=None, timeout=600, no_stream=False, key=None, key_env=None):
        self.base = base.rstrip("/")
        # An sk-reach key, needed for a hosted relay that requires one. A relay
        # on this machine does not, so the default (no key) still works there.
        builtin = self.base.lower() in ("public", "subscription")
        self._builtin_key = (os.environ.get("REACH_KEY") or "").strip()
        self.endpoint_name = None
        self.key_env = key_env
        self.explicit_credential = key is not None
        if key_env is not None:
            import re
            if not isinstance(key_env, str) or not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", key_env):
                raise ValueError("Use a valid environment variable name for --key-env.")
            self.key = (os.environ.get(key_env) or "").strip()
            self.key_ref = "env:" + key_env
        elif key is not None:
            self.key = str(key).strip()
            self.key_ref = "explicit"
            if builtin:
                self._builtin_key = self.key
        else:
            self.key = self._builtin_key if builtin else ""
            self.key_ref = "builtin:REACH_KEY" if builtin else "anonymous"
        if len(self.key) > 8192 or any(not 32 <= ord(ch) <= 126 for ch in self.key):
            raise ValueError("The configured credential is invalid; check its environment reference.")
        self.model = model
        self.timeout = timeout
        self.no_stream = no_stream
        self.usage = {"prompt": None, "completion": None}
        self.last_latency_ms = 0.0
        # Footer hook contract (read by terminal.print_footer):
        # {"tokens": int|None, "rounds": int, "latency": float seconds}
        self.last_turn = {"tokens": None, "rounds": 0, "latency": 0.0}
        # Whole-session counters (read by chatbox.session_meta); TurnMeter
        # accumulates into this on every completed turn.
        self.session_totals = {"turns": 0, "tokens": 0, "rounds": 0,
                               "latency": 0.0}
        self.system = None
        self.agent = False
        self.workpath = os.getcwd()

    def _headers(self, extra=None):
        return _auth_headers(self.key, extra)

    def resolve_base(self):
        """The endpoint to use. Never substitutes a different endpoint.

        The public pointer gist is consulted only when "public" was chosen
        explicitly (``--base public``). ``local`` is the relay on this
        machine. Any other base (a URL, REACH_BASE_URL) is used as-is even
        if it is down right now, so an unreachable endpoint is reported
        instead of silently replaced. Returns None only when "public" was
        chosen and the pointer cannot be read.
        """
        name = (self.base or "").strip().lower()
        if name in ("public", "subscription"):
            url = discover_public_url()
            return url.rstrip("/") if url else None
        if name == "local":
            return "http://127.0.0.1:20777/v1"
        from .endpoints import normalize_url
        try:
            return normalize_url(self.base)
        except (ValueError, TypeError):
            raise ReachApiError("Choose a valid endpoint URL without credentials, query or fragment.") from None
    @staticmethod
    def _reachable(base, key=""):
        try:
            request = _request(base.rstrip("/") + "/models", key)
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
        base = self.resolve_base()
        if not base:
            raise ReachApiError("The subscription endpoint pointer is unavailable.")
        request = _request(base + "/models", self.key)
        try:
            with urllib.request.urlopen(request, timeout=15) as resp:
                raw = resp.read(1024 * 1024 + 1)
                if len(raw) > 1024 * 1024:
                    raise ReachApiError("The endpoint's model list is too large.")
                data = json.loads(raw.decode("utf-8", "replace"))
        except urllib.error.HTTPError as exc:
            raise ReachApiError("Model listing failed (HTTP %s); check the endpoint credential." % exc.code,
                                status=exc.code) from None
        except (urllib.error.URLError, OSError, ValueError) as exc:
            raise ReachApiError("Model listing failed: %s" % _safe_text(exc, self.key, 300)) from None
        if not isinstance(data, dict) or not isinstance(data.get("data"), list):
            raise ReachApiError("The endpoint returned an invalid model list.")
        from .discovery import _safe_model_id
        return [m["id"] for m in data.get("data", [])[:1000]
                if isinstance(m, dict) and _safe_model_id(m.get("id"), self.key)]

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
        base = self.resolve_base()
        if not base:
            raise ReachApiError("The subscription endpoint pointer is unavailable.")
        request = _request(
            base + "/chat/completions", self.key,
            data=json.dumps(payload).encode("utf-8"),
            method="POST",
            headers={"Content-Type": "application/json"},
        )
        text = []
        slots = {}
        redactor = _TextRedactor(self.key)

        def emit(content, final=False):
            content = redactor.feed(content, final=final)
            if content:
                text.append(content)
                if on_text:
                    on_text(content)

        def partial():
            calls = _finish_tool_calls(slots)
            for call in calls:
                call["id"] = _safe_text(call.get("id"), self.key)
                fn = call.get("function") or {}
                fn["name"] = _safe_text(fn.get("name"), self.key)
                args = fn.get("arguments") or ""
                try:
                    decoded = json.loads(args)
                    def clean(value):
                        if isinstance(value, str):
                            return _safe_text(value, self.key)
                        if isinstance(value, list):
                            return [clean(item) for item in value]
                        if isinstance(value, dict):
                            return {_safe_text(k, self.key): clean(v) for k, v in value.items()}
                        return value
                    fn["arguments"] = json.dumps(clean(decoded))
                except (ValueError, TypeError):
                    fn["arguments"] = _safe_text(args, self.key)
            return {"content": "".join(text), "tool_calls": calls}

        try:
            response = urllib.request.urlopen(request, timeout=self.timeout)
        except urllib.error.HTTPError as exc:
            try:
                body = exc.read()
            except Exception:
                body = b""
            message = "endpoint error (HTTP %s): %s" % (
                exc.code, _error_text(body, self.base, self.key))
            if exc.code in TRANSIENT_HTTP:
                raise ReachTransientError(message, status=exc.code) from None
            raise ReachApiError(message, status=exc.code) from None
        except (socket.timeout, TimeoutError) as exc:
            raise ReachTransientError("timed out: %s" % _safe_text(exc, self.key, 300), status="timeout") from None
        except urllib.error.URLError as exc:
            reason = getattr(exc, "reason", None)
            if isinstance(reason, (socket.timeout, TimeoutError)) or "timed out" in str(exc):
                raise ReachTransientError("timed out: %s" % _safe_text(exc, self.key, 300), status="timeout") from None
            raise ReachTransientError("endpoint unreachable: %s" % _safe_text(exc, self.key, 300),
                                      status="unreachable") from None
        except ( socket.timeout, TimeoutError,
                ConnectionError, http.client.HTTPException, OSError) as exc:
            raise ReachTransientError("endpoint unreachable: %s" % _safe_text(exc, self.key, 300),
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
                    emit(content, final=True)
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
                        emit(content)
                    _merge_tool_delta(slots, delta.get("tool_calls"))
                    if choice.get("finish_reason"):
                        done = True
        except ReachTransientError:
            raise
        except (socket.timeout, TimeoutError, ConnectionError,
                http.client.HTTPException, OSError, ValueError) as exc:
            emit("", final=True)
            kind = "timeout" if isinstance(exc, (socket.timeout, TimeoutError)) else "cut"
            raise ReachTransientError("stream cut: %s" % _safe_text(exc, self.key, 300), partial(), status=kind) from None
        emit("", final=True)
        self.last_latency_ms = (time.time() - started) * 1000
        self.usage = stream_usage or _usage_dict({})
        result = partial()
        if not saw_sse:
            raise ReachTransientError(
                "endpoint error: " + _error_text(raw_rest, self.base, self.key), result)
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
        base = self.resolve_base()
        if not base:
            raise ReachApiError("The subscription endpoint pointer is unavailable.")
        request = _request(
            base + "/chat/completions", self.key,
            data=json.dumps(payload).encode("utf-8"),
            method="POST",
            headers={"Content-Type": "application/json"},
        )
        if payload["stream"]:
            chunks = []
            saw_sse = False
            raw_rest = b""
            redactor = _TextRedactor(self.key)
            try:
                response = urllib.request.urlopen(request, timeout=self.timeout)
            except urllib.error.HTTPError as exc:
                raise ReachApiError(
                    "endpoint error (HTTP %s): %s"
                    % (exc.code, _error_text(exc.read(), self.base, self.key))
                ) from None
            except urllib.error.URLError as exc:
                raise ReachApiError("endpoint unreachable: %s" % _safe_text(exc, self.key, 300)) from None
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
                        content = redactor.feed(content)
                        chunks.append(content)
                        if content:
                            yield content
                tail = redactor.feed("", final=True)
                if tail:
                    chunks.append(tail)
                    yield tail
            self.last_latency_ms = (time.time() - started) * 1000
            if not chunks and (raw_rest or not saw_sse):
                raise ReachApiError(
                    "endpoint error: " + _error_text(raw_rest, self.base, self.key)
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
                % (exc.code, _error_text(exc.read(), self.base, self.key))
            ) from None
        except urllib.error.URLError as exc:
            raise ReachApiError("endpoint unreachable: %s" % _safe_text(exc, self.key, 300)) from None
        except (ValueError, UnicodeDecodeError) as exc:
            raise ReachApiError("malformed endpoint response") from None
        self.last_latency_ms = (time.time() - started) * 1000
        usage = data.get("usage") or {}
        self.usage = {
            "prompt": usage.get("prompt_tokens"),
            "completion": usage.get("completion_tokens"),
        }
        content = (data.get("choices") or [{}])[0].get("message", {}).get("content")
        yield _safe_text(content, self.key)




def discover_public_url(timeout=8):
    try:
        with urllib.request.urlopen(POINTER_GIST, timeout=timeout) as resp:
            raw = resp.read(4097)
            if len(raw) > 4096:
                return None
            from .endpoints import normalize_url
            return normalize_url(raw.decode("utf-8").strip())
    except Exception:
        return None
