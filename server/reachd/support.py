"""Authenticated native operations on the fixed resident GPU support service."""
import json
import math
import time
import urllib.error
import urllib.request

import reachd.core as core
from reachd.model_services import SUPPORT_MODELS

PATHS = {"/v1/embeddings": "/v1/embeddings", "/embeddings": "/v1/embeddings",
         "/v1/rerank": "/rerank", "/rerank": "/rerank",
         "/v1/decisions": "/v1/decisions", "/decisions": "/v1/decisions"}


def catalog():
    # Generic OpenAI clients classify unknown types as chat. Keep Liquid models
    # in the typed Admin inventory and their native decisions operation.
    return [{"id": alias, "object": "model", "created": 1715367049,
             "owned_by": "SignalR.E.A.C.H", "name": name, "repository": repo,
             "type": {"embeddings": "embedding", "rerank": "reranker", "decisions": "decision"}[kind],
             "capabilities": {"chat": False, kind: True}, "endpoint": path,
             **({"max_model_len": 2048} if kind in ("embeddings", "rerank") else {})}
            for alias, repo, name, _precision, kind, path in SUPPORT_MODELS if kind != "decisions"]


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def _text_batches(texts):
    """Respect the support worker's transport limits without dropping texts."""
    if not isinstance(texts, list) or not texts or any(not isinstance(text, str) for text in texts):
        raise ValueError("Provide one or more text strings.")
    start, batch, characters = 0, [], 0
    for text in texts:
        if len(text) > 131072:
            raise ValueError("A single text exceeds the support service's 131072-character limit.")
        if batch and (len(batch) == 16 or characters + len(text) > 131072):
            yield start, batch
            start += len(batch)
            batch, characters = [], 0
        batch.append(text)
        characters += len(text)
    if batch:
        yield start, batch


def _request_native(opener, path, payload, timeout):
    request = urllib.request.Request("http://127.0.0.1:18030" + path,
        data=json.dumps(payload).encode(), headers={"Content-Type": "application/json"})
    with opener.open(request, timeout=timeout) as response:
        raw = response.read(2_000_001)
        if len(raw) > 2_000_000:
            raise ValueError("Support response exceeded the transport limit")
        result = json.loads(raw)
    if not isinstance(result, dict):
        raise ValueError("Support service returned invalid JSON")
    return result


def _request_batches(opener, path, payload, batches, timeout):
    if batches is None:
        return _request_native(opener, path, payload, timeout)
    embedding = path == "/v1/embeddings"
    combined, prompt_tokens, total_tokens = [], 0, 0
    for start, texts in batches:
        batch_payload = {**payload, "input" if embedding else "documents": texts}
        if not embedding:
            # Rank every candidate before applying the caller's global top_n.
            batch_payload.pop("top_n", None)
        result = _request_native(opener, path, batch_payload, timeout)
        rows = result.get("data" if embedding else "results")
        if not isinstance(rows, list) or len(rows) != len(texts):
            raise ValueError("Support service returned an incomplete batch")
        if any(not isinstance(row, dict) or type(row.get("index")) is not int for row in rows):
            raise ValueError("Support service returned invalid batch indices")
        rows = sorted(rows, key=lambda row: row["index"])
        if [row["index"] for row in rows] != list(range(len(texts))):
            raise ValueError("Support service returned invalid batch indices")
        if not embedding and any(not isinstance(row.get("relevance_score"), (int, float))
                                 or not math.isfinite(row["relevance_score"]) for row in rows):
            raise ValueError("Support service returned invalid rerank scores")
        combined.extend({**row, "index": start + row["index"]} for row in rows)
        if embedding:
            usage = result.get("usage") or {}
            counts = [usage.get("prompt_tokens"), usage.get("total_tokens")]
            if any(type(value) is not int or value < 0 for value in counts):
                raise ValueError("Support service returned invalid embedding usage")
            prompt_tokens += counts[0]
            total_tokens += counts[1]
    if embedding:
        return {"object": "list", "model": payload["model"], "data": combined,
                "usage": {"prompt_tokens": prompt_tokens, "total_tokens": total_tokens}}
    combined.sort(key=lambda row: row["relevance_score"], reverse=True)
    return {"model": payload["model"], "results": combined[:payload.get("top_n")]}


def execute(h, path):
    """Keep owner-key support requests out of chat and hosted-account routing."""
    if not h._check_ip_lists():
        return
    key_bucket, key_rpm, key_tokens_day = h.key_limits()
    allowed, headers, reason = core.STATE.limiter.check(
        h._client_ip(), core.STATE.cfg, key_bucket=key_bucket, key_rpm=key_rpm)
    if not allowed:
        return h._json(429, {"error": {"message": "Rate limit reached (%s)." % reason,
                                      "type": "rate_limit_error", "code": "rate_limit"}}, headers)
    if key_bucket and key_tokens_day and core.STATE.analytics.tokens_today(key_bucket) >= key_tokens_day:
        return h._json(429, {"error": {"message": "This API key reached its daily token budget.",
                                      "type": "rate_limit_error", "code": "key_daily_token_limit"}}, headers)
    try:
        payload = json.loads(h._read_body().decode("utf-8"))
    except (ValueError, UnicodeError):
        return h._json(400, {"error": {"message": "Send a JSON object.", "type": "invalid_request"}})
    if not isinstance(payload, dict):
        return h._json(400, {"error": {"message": "Send a JSON object.", "type": "invalid_request"}})
    requested = payload.get("model")
    model = next((row for row in SUPPORT_MODELS if requested in (row[0], row[1])), None)
    if not model or model[5] != PATHS[path]:
        return h._json(400, {"error": {"message": "Choose a model that supports this operation.",
                                      "type": "invalid_request", "code": "model_operation_mismatch"}})
    if payload.get("stream") or h.headers.get("X-Reach-Metered") == "provider-v1":
        return h._json(400, {"error": {"message": "This operation returns a native JSON response.",
                                      "type": "invalid_request"}})
    if model[4] == "embeddings" and (payload.get("encoding_format", "float") != "float"
                                    or payload.get("dimensions", 1024) != 1024):
        return h._json(400, {"error": {"message": "BGE M3 returns 1024 float dimensions.",
                                      "type": "invalid_request"}})
    batches = None
    try:
        if model[4] == "embeddings":
            texts = payload.get("input")
            batches = list(_text_batches([texts] if isinstance(texts, str) else texts))
        elif model[4] == "rerank":
            batches = list(_text_batches(payload.get("documents")))
            top_n = payload.get("top_n")
            if top_n is not None and (type(top_n) is not int or top_n < 1):
                raise ValueError("top_n must be a positive integer.")
    except ValueError as error:
        return h._json(400, {"error": {"message": str(error), "type": "invalid_request"}})
    payload["model"] = model[1]
    # Dedicated keys and global budgets still apply to native GPU operations.
    estimated_tokens = max(1, len(json.dumps(payload, ensure_ascii=False)) // 4)
    budgets = [("*", int(core.STATE.cfg.get("rate_limits", {}).get("global_tokens_day", 0) or 0))]
    if key_bucket:
        budgets.append((key_bucket, key_tokens_day))
    for bucket, limit in budgets:
        if limit and core.STATE.analytics.tokens_today(bucket) >= limit:
            return h._json(429, {"error": {"message": "Daily token budget reached.",
                                          "type": "rate_limit_error", "code": "daily_token_limit"}}, headers)
    if not core.STATE.gate.acquire(int(core.STATE.cfg.get("max_concurrency", 6)), timeout_s=15):
        return h._json(503, {"error": {"message": "Relay is at capacity; retry shortly.",
                                      "type": "server_error", "code": "overloaded"}}, headers)
    started = time.monotonic()
    try:
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), _NoRedirect())
        result = _request_batches(opener, model[5], payload, batches,
                                  core.STATE.cfg.get("upstream_timeout_s", 600))
        usage = result.get("usage") or {}
        tokens = usage.get("total_tokens", usage.get("input_tokens", estimated_tokens))
        if not isinstance(tokens, int) or isinstance(tokens, bool) or tokens < 0:
            tokens = estimated_tokens
        for bucket, _limit in budgets:
            core.STATE.analytics.add_tokens(bucket, tokens)
        if "model" in result:
            result["model"] = requested
        h._log_chat(model=model[0], upstream_model=model[1], ip=h._client_ip(),
            user_agent=h.headers.get("User-Agent"), status=200, error=None,
            latency_ms=int((time.monotonic()-started)*1000), tokens_in=tokens,
            tokens_out=0, stream=False)
        return h._json(200, result, headers)
    except urllib.error.HTTPError as error:
        if 400 <= error.code < 500:
            raw = error.read(8192)
            try:
                detail = json.loads(raw).get("detail", "Support service rejected the request.")
            except (ValueError, AttributeError):
                detail = "Support service rejected the request."
            return h._json(error.code, {"error": {"message": str(detail), "type": "invalid_request"}})
        return h._json(502, {"error": {"message": "GPU support service is unavailable.", "type": "server_error"}})
    except (OSError, ValueError):
        return h._json(502, {"error": {"message": "GPU support service is unavailable.", "type": "server_error"}})
    finally:
        core.STATE.gate.release()
