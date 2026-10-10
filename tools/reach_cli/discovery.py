"""Bounded, nonblocking discovery of OpenAI-compatible model metadata.

The command dispatcher schedules one refresh per relevant invocation.  Rendering
only reads snapshots; workers never write to the terminal.  Credentials stay in
the request worker, and redirects cannot forward an Authorization header.
"""

import collections
import hashlib
import hmac
import json
import math
import os
import socket
import threading
import time
import unicodedata
import urllib.error
import urllib.request

LOCAL_BASE = "http://127.0.0.1:20777/v1"
MAX_RESPONSE_BYTES = 1024 * 1024
MAX_MODELS = 1000
MAX_MODEL_ID = 512
DEFAULT_TIMEOUT = 3.0
MAX_TIMEOUT = 15.0


class ModelDiscoveryError(RuntimeError):
    """A safe, user-facing discovery failure with no provider response text."""


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def _timeout(value):
    try:
        value = float(value)
    except (ValueError, TypeError, OverflowError):
        return DEFAULT_TIMEOUT
    if not math.isfinite(value):
        return DEFAULT_TIMEOUT
    return min(MAX_TIMEOUT, max(0.05, value))


def _canonical_base(base):
    if not isinstance(base, str):
        raise ModelDiscoveryError("Choose a valid HTTP or HTTPS endpoint.")
    alias = base.strip().lower()
    if alias in ("public", "subscription"):
        return "public"
    if alias == "local":
        return LOCAL_BASE
    try:
        from .endpoints import normalize_url
        result = normalize_url(base)
    except (TypeError, ValueError):
        raise ModelDiscoveryError("Choose a valid HTTP or HTTPS endpoint.") from None
    if not result:
        raise ModelDiscoveryError("Choose a valid HTTP or HTTPS endpoint.")
    # Equivalent authority spellings share requests and cache entries.
    from urllib.parse import urlsplit, urlunsplit
    parsed = urlsplit(result)
    authority = parsed.netloc.lower()
    if (parsed.scheme.lower() == "http" and parsed.port == 80
            or parsed.scheme.lower() == "https" and parsed.port == 443):
        authority = authority.rsplit(":", 1)[0]
    return urlunsplit((parsed.scheme.lower(), authority,
                       parsed.path.rstrip("/"), "", ""))


def _safe_model_id(value, key=""):
    if not isinstance(value, str) or not value or len(value) > MAX_MODEL_ID:
        return None
    if value != value.strip() or any(ch.isspace() for ch in value):
        return None
    if any(unicodedata.category(ch).startswith("C") for ch in value):
        return None
    if key and key in value:
        return None
    return value


def _valid_key(key):
    return (isinstance(key, str) and len(key) <= 8192
            and all(32 <= ord(ch) <= 126 for ch in key))


def _socket_timeout(response, remaining):
    """Refresh the socket budget between reads, when urllib exposes it."""
    try:
        response.fp.raw._sock.settimeout(max(0.001, remaining))
    except (AttributeError, OSError, ValueError):
        pass


def _read_bounded(response, deadline):
    length = response.headers.get("Content-Length")
    try:
        if length is not None and int(length) > MAX_RESPONSE_BYTES:
            raise ModelDiscoveryError("The endpoint's model list is too large.")
    except (ValueError, TypeError):
        pass
    chunks = []
    size = 0
    read = getattr(response, "read1", None) or response.read
    while True:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise ModelDiscoveryError("Model discovery timed out; cached models were retained.")
        _socket_timeout(response, remaining)
        chunk = read(min(65536, MAX_RESPONSE_BYTES + 1 - size))
        if not isinstance(chunk, bytes):
            raise ModelDiscoveryError("The endpoint returned an invalid model list.")
        if not chunk:
            return b"".join(chunks)
        chunks.append(chunk)
        size += len(chunk)
        if size > MAX_RESPONSE_BYTES:
            raise ModelDiscoveryError("The endpoint's model list is too large.")


def fetch_models(base, key="", timeout=DEFAULT_TIMEOUT):
    """Fetch model IDs only.  No completion requests or model downloads occur."""
    base = _canonical_base(base)
    if base == "public":
        raise ModelDiscoveryError("Resolve the subscription endpoint before discovery.")
    if not _valid_key(key):
        raise ModelDiscoveryError("The configured credential is invalid; check its environment reference.")
    headers = {"Accept": "application/json"}
    if key:
        headers["Authorization"] = "Bearer " + key
    budget = _timeout(timeout)
    deadline = time.monotonic() + budget
    request = urllib.request.Request(base + "/models", headers=headers, method="GET")
    opener = urllib.request.build_opener(_NoRedirect())
    try:
        with opener.open(request, timeout=budget) as response:
            raw = _read_bounded(response, deadline)
        payload = json.loads(raw.decode("utf-8"))
    except ModelDiscoveryError:
        raise
    except urllib.error.HTTPError as exc:
        status = exc.code
        exc.close()
        if status in (401, 403):
            text = "Model discovery needs a valid credential; check the endpoint's environment reference."
        elif 300 <= status < 400:
            text = "Model discovery refuses redirects; configure the final endpoint URL."
        else:
            text = "Model discovery failed (HTTP %d); cached models were retained." % status
        raise ModelDiscoveryError(text) from None
    except (socket.timeout, TimeoutError):
        raise ModelDiscoveryError("Model discovery timed out; cached models were retained.") from None
    except urllib.error.URLError as exc:
        if isinstance(exc.reason, (socket.timeout, TimeoutError)):
            text = "Model discovery timed out; cached models were retained."
        else:
            text = "The endpoint is unavailable; check its address and network connection."
        raise ModelDiscoveryError(text) from None
    except (ValueError, UnicodeError, TypeError):
        raise ModelDiscoveryError("The endpoint returned an invalid model list.") from None
    except Exception:
        # Never expose urllib errors, provider bodies, URLs, or credential data.
        raise ModelDiscoveryError("Model discovery failed; check the endpoint and try again.") from None
    if not isinstance(payload, dict) or not isinstance(payload.get("data"), list):
        raise ModelDiscoveryError("The endpoint returned an invalid model list.")
    records = payload["data"]
    if len(records) > MAX_MODELS:
        raise ModelDiscoveryError("The endpoint's model list has too many entries.")
    result = []
    seen = set()
    for record in records:
        model = _safe_model_id(record.get("id") if isinstance(record, dict) else None, key)
        if model and model not in seen:
            result.append(model)
            seen.add(model)
    if records and not result:
        raise ModelDiscoveryError("The endpoint returned no valid model IDs.")
    return result


def _public_url(timeout):
    from .client import discover_public_url
    return discover_public_url(timeout=timeout)


def _idle():
    return {"status": "idle", "models": [], "stale": False, "error": "",
            "fetched_at": None, "request_id": None}


class ModelDiscovery:
    """In-memory cache with bounded workers and credential-isolated generations."""

    def __init__(self, fetcher=None, resolver=None, max_workers=4,
                 max_entries=64, stale_after=300):
        self._fetcher = fetcher or fetch_models
        self._resolver = resolver or _public_url
        self._max_workers = max(1, int(max_workers))
        self._max_entries = max(self._max_workers, int(max_entries))
        self._stale_after = max(0, float(stale_after))
        self._condition = threading.Condition()
        self._secret = os.urandom(32)
        self._cache = collections.OrderedDict()
        self._latest = {}
        self._jobs = {}
        self._inflight = {}
        self._sequence = 0
        self._epoch = 0
        self._closed = False

    def _digest(self, value):
        return hmac.new(self._secret, value.encode("utf-8", "surrogatepass"), hashlib.sha256).digest()

    def _scope(self, base, key_ref):
        canonical = _canonical_base(base)
        reference = key_ref if isinstance(key_ref, str) else ""
        return canonical, self._digest(reference)

    def _expire_locked(self, entry):
        job = self._jobs.get(entry["request_id"])
        if (entry["status"] == "loading" and job
                and time.monotonic() >= job["deadline"]):
            job["expired"] = True
            entry["status"] = "error"
            entry["error"] = "Model discovery timed out; cached models were retained."
            entry["stale"] = entry["fetched_at"] is not None
            self._condition.notify_all()

    def _snapshot_locked(self, entry):
        self._expire_locked(entry)
        result = {name: entry[name] for name in _idle()}
        result["models"] = list(entry["models"])
        if (result["fetched_at"] is not None
                and time.time() - result["fetched_at"] >= self._stale_after):
            result["stale"] = True
        return result

    def _trim_locked(self):
        for cache_key in list(self._cache):
            if len(self._cache) <= self._max_entries:
                break
            if cache_key in self._inflight:
                continue
            self._cache.pop(cache_key, None)
            scope = cache_key[:2]
            if self._latest.get(scope) == cache_key:
                self._latest.pop(scope, None)

    def refresh(self, base, key="", key_ref="", timeout=DEFAULT_TIMEOUT):
        """Schedule a refresh, or join the same endpoint/credential's live one."""
        try:
            scope = self._scope(base, key_ref)
        except ModelDiscoveryError as exc:
            result = _idle()
            result.update(status="error", error=str(exc))
            return result
        if not _valid_key(key):
            result = _idle()
            result.update(status="error", error="The configured credential is invalid.")
            return result
        cache_key = scope + (self._digest(key),)
        with self._condition:
            if self._closed:
                result = _idle()
                result.update(status="error", error="Model discovery is closed.")
                return result
            self._latest[scope] = cache_key
            entry = self._cache.get(cache_key)
            if entry is None:
                entry = _idle()
                self._cache[cache_key] = entry
            self._cache.move_to_end(cache_key)
            if cache_key in self._inflight:
                return self._snapshot_locked(entry)
            if len(self._jobs) >= self._max_workers:
                entry.update(status="busy", error="Model discovery is busy; try again shortly.",
                             stale=entry["fetched_at"] is not None)
                self._trim_locked()
                return self._snapshot_locked(entry)
            self._sequence += 1
            request_id = self._sequence
            job = {"deadline": time.monotonic() + _timeout(timeout),
                   "expired": False, "epoch": self._epoch}
            self._jobs[request_id] = job
            self._inflight[cache_key] = request_id
            entry.update(status="loading", error="", request_id=request_id,
                         stale=entry["fetched_at"] is not None)
            thread = threading.Thread(target=self._worker,
                                      args=(cache_key, key, request_id, job),
                                      name="reach-model-discovery", daemon=True)
            try:
                thread.start()
            except RuntimeError:
                self._jobs.pop(request_id, None)
                self._inflight.pop(cache_key, None)
                entry.update(status="error", error="Model discovery could not start; try again shortly.",
                             stale=entry["fetched_at"] is not None)
            self._trim_locked()
            return self._snapshot_locked(entry)

    def _worker(self, cache_key, key, request_id, job):
        models = None
        error = ""
        try:
            base = cache_key[0]
            if base == "public":
                base = self._resolver(timeout=max(0.001, job["deadline"] - time.monotonic()))
                if not base:
                    raise ModelDiscoveryError("The subscription endpoint pointer is unavailable; cached models were retained.")
                base = _canonical_base(base)
                if base == "public":
                    raise ModelDiscoveryError("The subscription endpoint pointer is invalid.")
            remaining = job["deadline"] - time.monotonic()
            if remaining <= 0:
                raise ModelDiscoveryError("Model discovery timed out; cached models were retained.")
            models = self._fetcher(base, key=key, timeout=remaining)
            if not isinstance(models, list) or len(models) > MAX_MODELS:
                raise ModelDiscoveryError("The endpoint returned an invalid model list.")
            valid = list(dict.fromkeys(model for model in models
                                      if _safe_model_id(model, key)))
            if models and not valid:
                raise ModelDiscoveryError("The endpoint returned no valid model IDs.")
            models = valid
        except ModelDiscoveryError as exc:
            error = str(exc)
            # Injectable fetchers/resolvers also cannot leak the actual key.
            if key and key in error:
                error = "Model discovery failed; check the endpoint and try again."
            if any(unicodedata.category(ch).startswith("C") for ch in error):
                error = "Model discovery failed; check the endpoint and try again."
        except Exception:
            error = "Model discovery failed; check the endpoint and try again."
        finally:
            with self._condition:
                entry = self._cache.get(cache_key)
                if (entry is not None and entry["request_id"] == request_id
                        and not self._closed and job["epoch"] == self._epoch):
                    self._expire_locked(entry)
                    if not job["expired"]:
                        if error:
                            entry.update(status="error", error=error,
                                         stale=entry["fetched_at"] is not None)
                        else:
                            entry.update(status="ready", models=models, stale=False,
                                         error="", fetched_at=time.time())
                self._jobs.pop(request_id, None)
                if self._inflight.get(cache_key) == request_id:
                    self._inflight.pop(cache_key, None)
                self._trim_locked()
                self._condition.notify_all()

    def _generation_key_locked(self, scope, key):
        if key is None:
            return self._latest.get(scope)
        if _valid_key(key):
            return scope + (self._digest(key),)
        return None

    def snapshot(self, base, key_ref="", key=None):
        """Read a credential generation without scheduling a request.

        Passing the current ``key`` prevents a rotated environment reference
        from displaying a catalog fetched with an older credential.  Omitting
        it preserves the latest-generation lookup for existing callers.
        """
        try:
            scope = self._scope(base, key_ref)
        except ModelDiscoveryError as exc:
            result = _idle()
            result.update(status="error", error=str(exc))
            return result
        with self._condition:
            cache_key = self._generation_key_locked(scope, key)
            entry = self._cache.get(cache_key)
            return self._snapshot_locked(entry) if entry is not None else _idle()

    def wait(self, base, key_ref="", timeout=DEFAULT_TIMEOUT, key=None):
        """Wait for an already scheduled refresh; never starts another request."""
        try:
            scope = self._scope(base, key_ref)
        except ModelDiscoveryError as exc:
            result = _idle()
            result.update(status="error", error=str(exc))
            return result
        deadline = time.monotonic() + _timeout(timeout)
        with self._condition:
            cache_key = self._generation_key_locked(scope, key)
            entry = self._cache.get(cache_key)
            while entry is not None and entry["status"] == "loading":
                self._expire_locked(entry)
                if entry["status"] != "loading":
                    break
                job = self._jobs.get(entry["request_id"])
                remaining = min(deadline, job["deadline"] if job else deadline) - time.monotonic()
                if remaining <= 0:
                    break
                self._condition.wait(remaining)
                entry = self._cache.get(cache_key)
            return self._snapshot_locked(entry) if entry is not None else _idle()

    def reset(self, wait=False):
        """Clear this in-memory cache.  Used by owned offline test fixtures."""
        with self._condition:
            self._epoch += 1
            for job in self._jobs.values():
                job["expired"] = True
            self._cache.clear()
            self._latest.clear()
            self._inflight.clear()
            self._condition.notify_all()
            if wait:
                deadline = time.monotonic() + DEFAULT_TIMEOUT
                while self._jobs and time.monotonic() < deadline:
                    self._condition.wait(deadline - time.monotonic())

    def close(self, wait=False):
        """Disable scheduling and suppress any late worker cache updates."""
        with self._condition:
            self._closed = True
        self.reset(wait=wait)


MODEL_DISCOVERY = ModelDiscovery()
