"""The chat request pipeline: transform, upstream relay, finalize."""

import json
import time
import urllib.error
import urllib.request

import reachd.core as core  # STATE is read at call time (cycle-safe)
from reachd.const import CLIENT_DISCONNECT_ERRORS
from reachd.text import count_tokens, scrub_trailing_roles


def chat_execute(h):
    ip = h._client_ip()
    if not h._check_ip_lists():
        return

    # ---- rate limit (global buckets; per-model applied after parsing) ----
    allowed, rl_headers, reason = core.STATE.limiter.check(ip, core.STATE.cfg)
    if not allowed:
        h._log_chat(model=None, upstream_model=None, ip=ip,
                       user_agent=h.headers.get("User-Agent"), status=429,
                       error="rate_limited:" + (reason or "?"), latency_ms=0,
                       tokens_in=0, tokens_out=0, stream=False)
        h._json(429, {
            "error": {"message": "Rate limit reached (%s). Slow down."
                                 % (reason or "limit"),
                      "type": "rate_limit_error", "code": "rate_limit"},
        }, rl_headers)
        return

    started = time.time()
    body = h._read_body()
    request_body = None
    try:
        payload = json.loads(body.decode("utf-8"))
    except (json.JSONDecodeError, UnicodeDecodeError):
        h._json(400, {"error": {"message": "invalid JSON body",
                                          "type": "invalid_request"}},
                          rl_headers)
        return None
    if not isinstance(payload, dict):
        h._json(400, {"error": {"message": "invalid request body",
                                          "type": "invalid_request"}},
                          rl_headers)
        return None

    req_cfg = core.STATE.cfg.get("request", {})
    models = core.STATE.cfg.get("models", {})
    requested = payload.get("model") or req_cfg.get("default_model", "")
    spec = models.get(requested)

    # model visibility: unknown or disabled → 404; private + remote → 404
    if not spec or not spec.get("enabled"):
        h._json(404, {
            "error": {
                "message": ("Unknown model %r. Served models: %s"
                            % (requested,
                               ", ".join(sorted(core.STATE.public_models()))
                               or "(none)")),
                "type": "invalid_request_error", "param": "model",
                "code": "model_not_found",
            },
        }, rl_headers)
        return
    if not spec.get("public", True) and not h._is_loopback():
        h._json(404, {
            "error": {"message": "Unknown model %r." % requested,
                      "type": "invalid_request_error", "param": "model",
                      "code": "model_not_found"},
        }, rl_headers)
        return

    # ---- per-model rate limit bucket ----
    allowed, rl_headers, reason = core.STATE.limiter.check(ip, core.STATE.cfg,
                                                      model=requested)
    if not allowed:
        h._log_chat(model=requested, upstream_model=None, ip=ip,
                       user_agent=h.headers.get("User-Agent"), status=429,
                       error="rate_limited:" + (reason or "?"), latency_ms=0,
                       tokens_in=0, tokens_out=0, stream=False)
        h._json(429, {
            "error": {"message": "Rate limit reached for model %r (%s)."
                                 % (requested, reason or "limit"),
                      "type": "rate_limit_error", "code": "rate_limit"},
        }, rl_headers)
        return

    # ---- field policy ----
    blocked = set(req_cfg.get("blocked_fields") or [])
    if req_cfg.get("allow_tools") is False or not spec.get("allow_tools", True):
        blocked |= {"tools", "tool_choice"}
    if not req_cfg.get("allow_response_format", True):
        blocked.add("response_format")
    if not req_cfg.get("allow_logprobs", False):
        blocked |= {"logprobs", "top_logprobs"}
    blocked = {f for f in blocked if isinstance(f, str) and f}
    if blocked:
        present = [f for f in blocked if f in payload]
        if present and req_cfg.get("reject_blocked"):
            h._json(400, {
                "error": {"message": "Field(s) not allowed: %s" % ", ".join(sorted(present)),
                          "type": "invalid_request_error",
                          "code": "blocked_field"},
            }, rl_headers)
            return None
        for field in present:
            payload.pop(field, None)

    # ---- input guards ----
    messages = payload.get("messages")
    if not isinstance(messages, list) or not messages:
        h._json(400, {"error": {"message": "messages must be a "
                                                      "non-empty array",
                                          "type": "invalid_request"}},
                          rl_headers)
        return None
    max_messages = int(req_cfg.get("max_messages", 100))
    if len(messages) > max_messages:
        h._json(400, {"error": {"message": "too many messages "
                                                      "(max %d)" % max_messages,
                                          "type": "invalid_request"}},
                          rl_headers)
        return None
    total_chars = 0
    for message in messages:
        if isinstance(message, dict):
            content = message.get("content")
            if isinstance(content, str):
                total_chars += len(content)
    max_input_chars = int(req_cfg.get("max_input_chars", 400000))
    if total_chars > max_input_chars:
        h._json(400, {"error": {"message": "input too large "
                                                      "(max %d chars)" % max_input_chars,
                                          "type": "invalid_request"}},
                          rl_headers)
        return None
    max_prompt_tokens = int(core.STATE.cfg.get("rate_limits", {})
                            .get("max_prompt_tokens", 0) or 0)
    if max_prompt_tokens and (total_chars // 4) > max_prompt_tokens:
        h._json(400, {"error": {"message": "prompt exceeds %d "
                                                      "tokens (approx)" % max_prompt_tokens,
                                          "type": "invalid_request",
                                          "code": "prompt_too_long"}},
                          rl_headers)
        return None

    # ---- temperature: default + clamp ----
    t_min = max(float(req_cfg.get("temperature_min", 0.0)),
                float(spec.get("temperature_min", 0.0) or 0.0))
    t_max = min(float(req_cfg.get("temperature_max", 2.0)),
                float(spec.get("temperature_max", 2.0) or 2.0))
    if "temperature" in payload:
        temp = payload["temperature"]
        if isinstance(temp, (int, float)):
            payload["temperature"] = max(t_min, min(t_max, float(temp)))
    elif spec.get("temperature") is not None:
        payload["temperature"] = float(spec["temperature"])

    # ---- max_tokens: default + cap ----
    effective_cap = int(req_cfg.get("max_tokens_cap", 0) or 0)
    model_cap = int(spec.get("max_tokens_cap", 0) or 0)
    if effective_cap and model_cap:
        effective_cap = min(effective_cap, model_cap)
    else:
        effective_cap = effective_cap or model_cap
    if "max_tokens" in payload:
        requested_tokens = payload["max_tokens"]
        if isinstance(requested_tokens, int) and requested_tokens > 0 \
                and effective_cap:
            payload["max_tokens"] = min(requested_tokens, effective_cap)
    elif spec.get("max_tokens") is not None:
        payload["max_tokens"] = int(spec["max_tokens"])

    # ---- stream ----
    stream = payload.get("stream")
    if stream is None:
        stream = bool(req_cfg.get("default_stream", False))
        payload["stream"] = stream
    else:
        stream = bool(stream)
    if stream and not spec.get("allow_stream", True):
        h._json(400, {"error": {"message": "streaming is disabled "
                                                      "for model %r" % requested,
                                          "type": "invalid_request"}},
                          rl_headers)
        return None

    # ---- system prompt injection (model-level, then global) ----
    injected = (spec.get("system_prompt") or "").strip() \
        or (req_cfg.get("inject_system_prompt") or "").strip()
    if injected:
        first = messages[0] if messages else None
        already = isinstance(first, dict) and first.get("role") == "system" \
            and (first.get("content") or "").strip() == injected
        if not already:
            messages.insert(0, {"role": "system", "content": injected})

    # ---- upstream model + circuit + key ----
    upstream_model = spec["upstream"]
    if not core.STATE.key:
        h._json(503, {"error": {"message": "SignalR.E.A.C.H is not "
                                                      "configured yet (no "
                                                      "OmniRoute key).",
                                          "type": "server_error"}}, rl_headers)
        return None
    if core.STATE.circuit_open():
        h._json(503, {"error": {"message": "Upstream is in a "
                                                      "failure cool-down — "
                                                      "retry shortly.",
                                          "type": "server_error",
                                          "code": "upstream_cooling_down"}},
                          rl_headers)
        return None

    # ---- cache lookup (non-stream) ----
    cache_cfg = core.STATE.cfg.get("cache", {})
    cache_key = None
    if cache_cfg.get("enabled") and not stream:
        cache_key = h._cache_key(payload, cache_cfg)
        cached_body = core.STATE.cache.get(cache_key)
        if cached_body is not None:
            latency_ms = int((time.time() - started) * 1000)
            h._log_chat(model=requested, upstream_model=upstream_model,
                           ip=ip, user_agent=h.headers.get("User-Agent"),
                           status=200, error=None, latency_ms=latency_ms,
                           tokens_in=None, tokens_out=None, stream=False,
                           cached=True)
            h.send_response(200)
            h.send_header("Content-Type", "application/json; charset=utf-8")
            h.send_header("Content-Length", str(len(cached_body)))
            h._cors()
            h._rate_limit_headers(rl_headers)
            h.send_header("X-Reach-Cache", "HIT")
            h.end_headers()
            try:
                h.wfile.write(cached_body)
            except CLIENT_DISCONNECT_ERRORS:
                pass
            return

    # ---- concurrency gate ----
    if not core.STATE.gate.acquire(int(core.STATE.cfg.get("max_concurrency", 6)),
                              timeout_s=15):
        h._json(503, {"error": {"message": "Relay is at capacity "
                                                      "— retry shortly.",
                                          "type": "server_error",
                                          "code": "overloaded"}}, rl_headers)
        return None
    try:
        url = core.STATE.omniroute_url.rstrip("/") + "/chat/completions"
        payload["model"] = upstream_model
        encoded = json.dumps(payload).encode("utf-8")
        if core.STATE.cfg.get("data", {}).get("log_bodies"):
            request_body = body[:2048].decode("utf-8", "replace")
        retries = int(core.STATE.cfg.get("upstream_retries", 1))
        retry_delay = float(core.STATE.cfg.get("retry_delay_ms", 1000)) / 1000.0
        upstream = None
        attempts = retries + 1 if not stream else 1
        last_error = None
        fallback_used = False
        for attempt in range(attempts):
            try:
                req = urllib.request.Request(
                    url, data=encoded, method="POST",
                    headers={"Content-Type": "application/json",
                             "Authorization": "Bearer " + core.STATE.key})
                upstream = urllib.request.urlopen(
                    req,
                    timeout=int(core.STATE.cfg.get("stream_timeout_s", 300)
                                if stream
                                else core.STATE.cfg.get("upstream_timeout_s", 600)))
                break
            except urllib.error.HTTPError as exc:
                if exc.code < 500 or attempt == attempts - 1:
                    last_error = exc
                    break
                last_error = exc
                time.sleep(retry_delay)
            except (urllib.error.URLError, OSError) as exc:
                last_error = exc
                if attempt == attempts - 1:
                    break
                time.sleep(retry_delay)
        # fallback alias on total failure (streaming or non-streaming)
        if upstream is None:
            fallback_alias = spec.get("fallback")
            if fallback_alias and fallback_alias in models \
                    and models[fallback_alias].get("enabled"):
                fb_upstream = models[fallback_alias]["upstream"]
                try:
                    fb_payload = dict(payload)
                    fb_payload["model"] = fb_upstream
                    fb_req = urllib.request.Request(
                        url, data=json.dumps(fb_payload).encode("utf-8"),
                        method="POST",
                        headers={"Content-Type": "application/json",
                                 "Authorization": "Bearer " + core.STATE.key})
                    upstream = urllib.request.urlopen(
                        fb_req,
                        timeout=int(core.STATE.cfg.get("upstream_timeout_s", 600)))
                    upstream_model = fb_upstream
                    spec = models[fallback_alias]
                    fallback_used = True
                except Exception as exc:
                    last_error = exc
        if upstream is None:
            if isinstance(last_error, urllib.error.HTTPError):
                core.STATE.note_failure()
                h._log_chat(model=requested, upstream_model=upstream_model,
                               ip=ip,
                               user_agent=h.headers.get("User-Agent"),
                               status=last_error.code, error="upstream_http",
                               latency_ms=int((time.time() - started) * 1000),
                               tokens_in=0, tokens_out=0, stream=stream,
                               request_body=request_body)
                h._relay_upstream_error(
                    last_error, "OmniRoute rejected the request")
                return None
            core.STATE.note_failure()
            h._log_chat(model=requested, upstream_model=upstream_model,
                           ip=ip, user_agent=h.headers.get("User-Agent"),
                           status=502, error="upstream_unreachable",
                           latency_ms=int((time.time() - started) * 1000),
                           tokens_in=0, tokens_out=0, stream=stream,
                           request_body=request_body)
            h._relay_upstream_error(
                last_error, "OmniRoute unreachable")
            return None
    finally:
        if not stream:
            core.STATE.gate.release()
    ctx = {
        "started": started, "ip": ip, "rl_headers": rl_headers,
        "requested": requested, "upstream_model": upstream_model,
        "spec": spec, "stream": stream, "total_chars": total_chars,
        "request_body": request_body, "fallback_used": fallback_used,
        "cache_cfg": cache_cfg, "cache_key": cache_key,
    }
    return upstream, ctx


def chat_finalize(h, upstream, ctx):
    started = ctx["started"]
    ip = ctx["ip"]
    rl_headers = ctx["rl_headers"]
    requested = ctx["requested"]
    upstream_model = ctx["upstream_model"]
    spec = ctx["spec"]
    stream = ctx["stream"]
    total_chars = ctx["total_chars"]
    request_body = ctx["request_body"]
    fallback_used = ctx["fallback_used"]
    cache_cfg = ctx["cache_cfg"]
    cache_key = ctx["cache_key"]
    content_type = upstream.headers.get("Content-Type", "application/json")
    if stream:
        try:
            h.send_response(200)
            h.send_header("Content-Type", content_type or "text/event-stream")
            h._cors()
            h._rate_limit_headers(rl_headers)
            h.send_header("Cache-Control", "no-cache")
            h.send_header("Transfer-Encoding", "chunked")
            if fallback_used:
                h.send_header("X-Reach-Fallback", "used")
            h.end_headers()
            if spec.get("strip_trailing_roles"):
                # Buffer the stream, scrub the assembled content, then
                # emit a single clean completion.
                buffered = b""
                while True:
                    line = upstream.readline()
                    if not line:
                        break
                    buffered += line
                assembled = []
                for line in buffered.decode("utf-8", "replace").splitlines():
                    if not line.startswith("data:"):
                        continue
                    chunk = line[5:].strip()
                    if chunk == "[DONE]":
                        continue
                    try:
                        delta = (json.loads(chunk).get("choices")
                                 or [{}])[0].get("delta", {})
                        content = delta.get("content")
                        if isinstance(content, str):
                            assembled.append(content)
                    except json.JSONDecodeError:
                        pass
                scrubbed = scrub_trailing_roles("".join(assembled))
                now_end = time.time()
                stream_duration = max(0.2, now_end - started)
                latency_ms = int(stream_duration * 1000)
                approx_in = max(1, total_chars // 4)
                approx_out = count_tokens(scrubbed)
                tps = round(approx_out / stream_duration, 1)
                core.STATE.note_speed(tps)
                created = int(time.time())
                for payload_chunk in (
                    {"id": "chatcmpl-reach", "object": "chat.completion.chunk",
                     "created": created, "model": requested,
                     "choices": [{"index": 0, "delta": {"content": scrubbed},
                                  "finish_reason": None}]},
                    {"id": "chatcmpl-reach", "object": "chat.completion.chunk",
                     "created": created, "model": requested,
                     "choices": [{"index": 0, "delta": {},
                                  "finish_reason": "stop"}]},
                    {"id": "chatcmpl-reach", "object": "chat.completion.chunk",
                     "created": created, "model": requested,
                     "choices": [],
                     "usage": {"prompt_tokens": approx_in,
                               "completion_tokens": approx_out,
                               "total_tokens": approx_in + approx_out,
                               "tokens_per_second": tps,
                               "tokensPerSecond": tps,
                               "completion_tokens_per_second": tps,
                               "speed_tps": tps}}
                ):
                    h._write_chunk(("data: " + json.dumps(payload_chunk)
                                       + "\n\n").encode("utf-8"))
                try:
                    h._write_chunk(b"data: [DONE]\n\n")
                    h._write_chunk(b"")  # terminating chunk
                except Exception:
                    pass
            else:
                first_token_time = None
                last_token_time = None
                token_chunks_count = 0
                streamed_tokens = 0
                streamed_prompt_tokens = 0
                assembled_chunks = []
                last_chunk_id = "chatcmpl-reach"
                try:
                    while True:
                        line = upstream.readline()
                        if not line:
                            break
                        if line.startswith(b"data:"):
                            text_line = line[5:].strip()
                            if text_line == b"[DONE]":
                                break
                            try:
                                parsed_chunk = json.loads(text_line.decode("utf-8", "replace"))
                                if isinstance(parsed_chunk, dict):
                                    if parsed_chunk.get("id"):
                                        last_chunk_id = parsed_chunk["id"]
                                    usage_obj = parsed_chunk.get("usage")
                                    if isinstance(usage_obj, dict):
                                        if usage_obj.get("completion_tokens"):
                                            streamed_tokens = int(usage_obj["completion_tokens"])
                                        if usage_obj.get("prompt_tokens"):
                                            streamed_prompt_tokens = int(usage_obj["prompt_tokens"])
                                    choices = parsed_chunk.get("choices")
                                    if isinstance(choices, list) and choices:
                                        delta = choices[0].get("delta", {})
                                        content = delta.get("content")
                                        if isinstance(content, str) and content:
                                            now_t = time.time()
                                            token_chunks_count += 1
                                            if first_token_time is None:
                                                first_token_time = now_t
                                            last_token_time = now_t
                                            assembled_chunks.append(content)
                            except Exception:
                                pass
                        h._write_chunk(line)

                    full_streamed_text = "".join(assembled_chunks)
                    approx_out = streamed_tokens if streamed_tokens > 0 else count_tokens(full_streamed_text)
                    now_end = time.time()
                    total_elapsed = max(0.2, now_end - started)
                    latency_ms = int((now_end - started) * 1000)

                    # Genuine continuous stream: multiple chunks spread over at least 300ms
                    if (first_token_time and last_token_time and
                            (last_token_time - first_token_time) >= 0.3 and
                            token_chunks_count >= 3 and approx_out > 2):
                        decode_duration = last_token_time - first_token_time
                        tps = round((approx_out - 1) / decode_duration, 1)
                    else:
                        # Buffered burst: tokens arrived in 1-2 chunks, use elapsed request duration
                        tps = round(approx_out / total_elapsed, 1)

                    if streamed_prompt_tokens > 0:
                        approx_in = streamed_prompt_tokens
                    else:
                        approx_in = max(1, total_chars // 4)

                    core.STATE.note_speed(tps)

                    created_now = int(time.time())
                    usage_chunk = {
                        "id": last_chunk_id,
                        "object": "chat.completion.chunk",
                        "created": created_now,
                        "model": requested,
                        "choices": [],
                        "usage": {
                            "prompt_tokens": approx_in,
                            "completion_tokens": approx_out,
                            "total_tokens": approx_in + approx_out,
                            "tokens_per_second": tps,
                            "tokensPerSecond": tps,
                            "completion_tokens_per_second": tps,
                            "speed_tps": tps
                        }
                    }
                    h._write_chunk(("data: " + json.dumps(usage_chunk) + "\n\n").encode("utf-8"))
                    h._write_chunk(b"data: [DONE]\n\n")
                finally:
                    try:
                        h._write_chunk(b"")
                    except Exception:
                        pass
            core.STATE.note_success()
            h._log_chat(model=requested, upstream_model=upstream_model,
                           ip=ip, user_agent=h.headers.get("User-Agent"),
                           status=200, error=None,
                           latency_ms=latency_ms,
                           tokens_in=approx_in, tokens_out=approx_out, stream=True,
                           request_body=request_body)
        finally:
            core.STATE.gate.release()
            try:
                upstream.close()
            except Exception:
                pass
        return

    data = upstream.read()
    tokens_in = tokens_out = None
    response_body = None
    parsed = None
    try:
        parsed = json.loads(data.decode("utf-8", "replace"))
        usage = parsed.get("usage") or {}
        tokens_in = usage.get("prompt_tokens")
        tokens_out = usage.get("completion_tokens")
    except Exception:
        parsed = None

    latency_ms = int((time.time() - started) * 1000)
    content_text = ""
    if isinstance(parsed, dict):
        choices = parsed.get("choices") or []
        if choices and isinstance(choices[0], dict):
            content_text = (choices[0].get("message") or {}).get("content") or ""

    if tokens_out is None or tokens_out == 0:
        tokens_out = count_tokens(content_text) if content_text else 1

    if tokens_in is None or tokens_in == 0:
        tokens_in = max(1, total_chars // 4)

    tps = round(tokens_out / max(0.2, latency_ms / 1000.0), 1)
    core.STATE.note_speed(tps)

    if isinstance(parsed, dict):
        usage = parsed.get("usage")
        if not isinstance(usage, dict):
            usage = {}
        usage["prompt_tokens"] = tokens_in
        usage["completion_tokens"] = tokens_out
        usage["total_tokens"] = tokens_in + tokens_out
        usage["tokens_per_second"] = tps
        usage["tokensPerSecond"] = tps
        usage["completion_tokens_per_second"] = tps
        usage["speed_tps"] = tps
        parsed["usage"] = usage

        if spec.get("strip_trailing_roles"):
            try:
                choices = parsed.get("choices")
                if isinstance(choices, list):
                    for choice in choices:
                        message = choice.get("message")
                        if isinstance(message, dict) \
                                and isinstance(message.get("content"), str):
                            message["content"] = scrub_trailing_roles(
                                message["content"])
            except Exception:
                pass
        data = json.dumps(parsed).encode("utf-8")

    if core.STATE.cfg.get("data", {}).get("log_bodies"):
        response_body = data[:2048].decode("utf-8", "replace")
    core.STATE.note_success()
    with core.STATE._lock:
        core.STATE.latencies.append(latency_ms)

    # ---- daily token budgets: global, per-IP, per-model ----
    if tokens_out:
        rl = core.STATE.cfg.get("rate_limits", {})
        global_budget = int(rl.get("global_tokens_day", 0) or 0)
        if global_budget:
            if core.STATE.analytics.add_tokens("*", int(tokens_out)) > global_budget:
                return h._json(429, {
                    "error": {"message": "Global daily token budget reached.",
                              "type": "rate_limit_error",
                              "code": "daily_token_limit"},
                }, {**rl_headers, "Retry-After": "86400"})
        per_ip_budget = int(rl.get("per_ip_tokens_day", 0) or 0)
        if per_ip_budget:
            if core.STATE.analytics.add_tokens(ip, int(tokens_out)) > per_ip_budget:
                return h._json(429, {
                    "error": {"message": "Daily token budget reached.",
                              "type": "rate_limit_error",
                              "code": "daily_token_limit"},
                }, {**rl_headers, "Retry-After": "86400"})
        model_budget = int((spec.get("rate_limits") or {})
                           .get("tokens_day", 0) or 0)
        if model_budget:
            if core.STATE.analytics.add_tokens(ip + "::" + requested,
                                          int(tokens_out)) > model_budget:
                return h._json(429, {
                    "error": {"message": "Daily token budget reached for "
                                         "model %r." % requested,
                              "type": "rate_limit_error",
                              "code": "daily_token_limit"},
                }, {**rl_headers, "Retry-After": "86400"})

    # ---- cache store ----
    if cache_cfg.get("enabled") and not stream and cache_key:
        core.STATE.cache.put(cache_key, data, int(cache_cfg.get("ttl_s", 300)),
                        int(cache_cfg.get("max_entries", 1000)))

    h._log_chat(model=requested, upstream_model=upstream_model, ip=ip,
                   user_agent=h.headers.get("User-Agent"), status=200,
                   error=None, latency_ms=latency_ms, tokens_in=tokens_in,
                   tokens_out=tokens_out, stream=False,
                   request_body=request_body, response_body=response_body)
    h.send_response(200)
    h.send_header("Content-Type", content_type)
    h.send_header("Content-Length", str(len(data)))
    h._cors()
    h._rate_limit_headers(rl_headers)
    if tps > 0:
        h.send_header("X-Tokens-Per-Second", str(tps))
        h.send_header("X-Reach-Tokens-Per-Second", str(tps))
    h.send_header("OpenAI-Processing-Ms", str(latency_ms))
    if fallback_used:
        h.send_header("X-Reach-Fallback", "used")
    h.end_headers()
    try:
        h.wfile.write(data)
    except CLIENT_DISCONNECT_ERRORS:
        pass
