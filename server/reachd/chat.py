"""The chat request pipeline: transform, upstream relay, finalize."""

import json
import time
import urllib.error
import urllib.request

import reachd.core as core  # STATE is read at call time (cycle-safe)
from reachd.const import CLIENT_DISCONNECT_ERRORS
from reachd.text import ROLE_CONTINUATION_RE, count_tokens, scrub_trailing_roles


def merge_system_messages(messages):
    """Strict upstreams (vLLM/Qwen-class chat templates) accept exactly ONE
    system message, and only at index 0 — a second system, even one leading,
    is answered with 400 "System message must be at the beginning."

    Clients legitimately stack systems (agent rules + workspace context +
    compacted memory), and the model/global system_prompt injection adds one
    more. Merge every system message into a single leading message, preserving
    order, right before the request leaves the relay, so every upstream —
    present or added later — keeps working.
    """
    systems = sum(1 for m in messages
                  if isinstance(m, dict) and m.get("role") == "system")
    if not systems:
        return messages
    first = messages[0] if messages else None
    if systems == 1 and isinstance(first, dict) \
            and first.get("role") == "system":
        return messages
    contents = []
    rest = []
    for message in messages:
        if isinstance(message, dict) and message.get("role") == "system":
            text = message.get("content")
            if isinstance(text, str) and text:
                contents.append(text)
        else:
            rest.append(message)
    merged = ([{"role": "system", "content": "\n\n".join(contents)}]
              if contents else [])
    messages[:] = merged + rest
    return messages


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
    if not spec.get("public", True) and not h._admin_local():
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

    # ---- reasoning-model floor: models with long reasoning preambles
    # (Gemini 3.x) need headroom or upstream quality validation rejects the
    # reply as "reasoning consumed N/N tokens — no content output".
    min_out = int(spec.get("min_output_tokens", 0) or 0)
    if min_out:
        if "max_tokens" in payload and isinstance(payload["max_tokens"], int):
            payload["max_tokens"] = max(payload["max_tokens"], min_out)
        elif "max_completion_tokens" in payload \
                and isinstance(payload["max_completion_tokens"], int):
            payload["max_completion_tokens"] = max(payload["max_completion_tokens"], min_out)
        elif spec.get("max_tokens") is None:
            payload["max_tokens"] = min_out
        if effective_cap:
            for key in ("max_tokens", "max_completion_tokens"):
                if key in payload and isinstance(payload[key], int):
                    payload[key] = min(payload[key], effective_cap)

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

    # ---- exactly one leading system message ----
    # The injection above (and any client that stacks systems) may leave more
    # than one; strict upstream chat templates reject everything past index 0.
    merge_system_messages(messages)

    # ---- upstream model + circuit + key ----
    upstream_model = spec["upstream"]
    # "bridge/<model>" is served by the local tray bridge (the CodeGPT economy
    # models). It authenticates through the host's signed-in CodeGPT session,
    # so it needs no OmniRoute key — and must never be handed one.
    use_bridge = upstream_model.startswith("bridge/")
    # Publish what this request is doing while it runs (see /status in_flight).
    record = getattr(h, "_reach_request", None)
    if isinstance(record, dict):
        record.update({"model": requested, "upstream": upstream_model,
                       "stream": bool(stream), "ip": ip})
    h._reach_request = record
    h._reach_log("chat start model=%s upstream=%s stream=%s ip=%s"
                 % (requested, upstream_model,
                    "yes" if stream else "no", ip))
    if not use_bridge and not core.STATE.key:
        h._json(503, {"error": {"message": "SignalR.E.A.C.H is not "
                                                      "configured yet (no "
                                                      "OmniRoute key).",
                                          "type": "server_error"}}, rl_headers)
        return None
    # The breaker is PER UPSTREAM. A failing OmniRoute must not 503 the
    # CodeGPT economy aliases: they are served by the local tray bridge, a
    # different process on a different port, and share no connection with the
    # free upstream. Gating both on one global flag took every economy model
    # down whenever the free tier hiccuped.
    circuit = "bridge" if use_bridge else "omniroute"
    if core.STATE.circuit_open(circuit):
        h._json(503, {"error": {"message":
                                "The CodeGPT bridge is in a failure cool-down — retry shortly."
                                if use_bridge else
                                "Upstream is in a failure cool-down — retry shortly.",
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
        url = (core.STATE.bridge_url if use_bridge
               else core.STATE.omniroute_url).rstrip("/") + "/chat/completions"
        # The bridge names models itself ("codegpt-eco-<model>"); OmniRoute gets
        # the full provider-prefixed id.
        payload["model"] = upstream_model[len("bridge/"):] if use_bridge \
            else upstream_model
        auth_headers = {"Content-Type": "application/json"}
        if not use_bridge:
            auth_headers["Authorization"] = "Bearer " + core.STATE.key
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
                    headers=auth_headers)
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
        if upstream is not None:
            # Reaching this point IS the first response: whatever the model does
            # next, the log now shows the upstream answered the call.
            h._reach_log("chat upstream connected %s after %.1fs"
                         % (upstream_model, time.time() - started))
        # fallback alias on total failure (streaming or non-streaming)
        if upstream is None:
            fallback_alias = spec.get("fallback")
            if fallback_alias and fallback_alias in models \
                    and models[fallback_alias].get("enabled"):
                fb_upstream = models[fallback_alias]["upstream"]
                try:
                    fb_payload = dict(payload)
                    # The fallback alias may itself be a bridge alias, so it
                    # routes by its own prefix rather than reusing `url`.
                    fb_bridge = fb_upstream.startswith("bridge/")
                    fb_payload["model"] = fb_upstream[len("bridge/"):] \
                        if fb_bridge else fb_upstream
                    fb_headers = {"Content-Type": "application/json"}
                    if not fb_bridge:
                        fb_headers["Authorization"] = "Bearer " + core.STATE.key
                    fb_url = (core.STATE.bridge_url if fb_bridge
                              else core.STATE.omniroute_url).rstrip("/") \
                        + "/chat/completions"
                    fb_req = urllib.request.Request(
                        fb_url, data=json.dumps(fb_payload).encode("utf-8"),
                        method="POST", headers=fb_headers)
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
                core.STATE.note_failure(circuit)
                h._log_chat(model=requested, upstream_model=upstream_model,
                               ip=ip,
                               user_agent=h.headers.get("User-Agent"),
                               status=last_error.code, error="upstream_http",
                               latency_ms=int((time.time() - started) * 1000),
                               tokens_in=0, tokens_out=0, stream=stream,
                               request_body=request_body)
                h._relay_upstream_error(
                    last_error,
                    "CodeGPT bridge rejected the request" if use_bridge
                    else "OmniRoute rejected the request")
                return None
            core.STATE.note_failure(circuit)
            h._log_chat(model=requested, upstream_model=upstream_model,
                           ip=ip, user_agent=h.headers.get("User-Agent"),
                           status=502, error="upstream_unreachable",
                           latency_ms=int((time.time() - started) * 1000),
                           tokens_in=0, tokens_out=0, stream=stream,
                           request_body=request_body)
            h._relay_upstream_error(
                last_error,
                "CodeGPT bridge unreachable (is the SignalREACH tray running?)"
                if use_bridge else "OmniRoute unreachable")
            return None
    finally:
        if not stream or upstream is None:
            core.STATE.gate.release()
    ctx = {
        "started": started, "ip": ip, "rl_headers": rl_headers,
        "requested": requested, "upstream_model": upstream_model,
        "spec": spec, "stream": stream, "total_chars": total_chars,
        "request_body": request_body, "fallback_used": fallback_used,
        "cache_cfg": cache_cfg, "cache_key": cache_key,
        "url": url, "payload": payload, "models": models,
        # Which breaker this request belongs to, so finalize/cancel clear the
        # same one that a failure would have tripped.
        "circuit": circuit,
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
    # Clear the breaker for the upstream that actually answered — not a global
    # one, or a working bridge reply would mask a broken OmniRoute (and the
    # other way round).
    circuit = ctx.get("circuit", "omniroute")
    if stream:
        # Pre-read the upstream until the first real content token BEFORE
        # committing the 200: some routes (Gemini via OmniRoute) answer 200
        # with only keepalive chunks and then [DONE] -- an empty stream.
        # Treat that as a failure so the fallback alias can serve instead.
        pending_prefix = []
        saw_content = False
        raw_sock = None
        stream_timeout = int(core.STATE.cfg.get("stream_timeout_s", 300))
        try:
            sock = getattr(upstream, "fp", None)
            raw_sock = getattr(sock, "raw", None) or getattr(sock, "_sock", None)
            if raw_sock and hasattr(raw_sock, "settimeout"):
                raw_sock.settimeout(stream_timeout)
            while True:
                line = upstream.readline()
                if not line:
                    break
                pending_prefix.append(line)
                stripped = line.strip()
                if stripped == b"data: [DONE]":
                    break
                if stripped.startswith(b"data:"):
                    try:
                        parsed = json.loads(stripped[5:].decode("utf-8", "replace"))
                        choices = parsed.get("choices") if isinstance(parsed, dict) else None
                        if isinstance(choices, list) and choices:
                            delta = choices[0].get("delta", {})
                            token_text = (delta.get("content")
                                          or delta.get("reasoning_content")
                                          or delta.get("reasoning")
                                          or delta.get("thought"))
                            if isinstance(token_text, str) and token_text:
                                saw_content = True
                                break
                    except Exception:
                        pass
        except Exception:
            pass
        if raw_sock and hasattr(raw_sock, "settimeout"):
            try:
                raw_sock.settimeout(stream_timeout)
            except Exception:
                pass
        if not saw_content:
            pending_prefix = []
            fallback_alias = spec.get("fallback")
            models = ctx.get("models") or {}
            if fallback_alias and fallback_alias in models                     and models[fallback_alias].get("enabled"):
                try:
                    fb_payload = dict(ctx.get("payload") or {})
                    fb_upstream = models[fallback_alias]["upstream"]
                    # The fallback alias may itself be a bridge alias, so it
                    # routes by its own prefix rather than reusing the original
                    # upstream's URL. Getting this wrong sent a bridge wire id
                    # to OmniRoute, and leaked the OmniRoute bearer token to the
                    # local tray bridge. Mirrors chat_execute's fallback path.
                    fb_bridge = fb_upstream.startswith("bridge/")
                    fb_payload["model"] = fb_upstream[len("bridge/"):] \
                        if fb_bridge else fb_upstream
                    fb_headers = {"Content-Type": "application/json"}
                    if not fb_bridge:
                        fb_headers["Authorization"] = "Bearer " + core.STATE.key
                    fb_url = (core.STATE.bridge_url if fb_bridge
                              else core.STATE.omniroute_url).rstrip("/") \
                        + "/chat/completions"
                    fb_req = urllib.request.Request(
                        fb_url, data=json.dumps(fb_payload).encode("utf-8"),
                        method="POST", headers=fb_headers)
                    upstream = urllib.request.urlopen(
                        fb_req,
                        timeout=int(core.STATE.cfg.get("stream_timeout_s", 300)))
                    upstream_model = fb_upstream
                    spec = models[fallback_alias]
                    fallback_used = True
                except Exception:
                    upstream = None
            if upstream is None:
                core.STATE.note_failure(circuit)
                h._log_chat(model=requested, upstream_model=upstream_model,
                               ip=ip, user_agent=h.headers.get("User-Agent"),
                               status=502, error="upstream_timeout",
                               latency_ms=int((time.time() - started) * 1000),
                               tokens_in=0, tokens_out=0, stream=True,
                               request_body=request_body)
                h._relay_upstream_error(
                    OSError("Upstream model failed to emit tokens"),
                    "OmniRoute model timed out emitting first token")
                core.STATE.gate.release()
                return None

        def _next_line():
            if pending_prefix:
                return pending_prefix.pop(0)
            return upstream.readline()

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
                # Stream with a sliding scrub window: content deltas are
                # forwarded immediately, but the stream stops at the first
                # line-start transcript-continuation marker ("User:" etc.).
                # The first line is exempt, mirroring scrub_trailing_roles.
                assembled_chunks = []
                pending = ""
                first_line_done = False
                stopped = False
                created = int(time.time())
                while True:
                    line = _next_line()
                    if not line:
                        break
                    if not line.startswith(b"data:"):
                        continue
                    text_line = line[5:].strip()
                    if text_line == b"[DONE]":
                        break
                    try:
                        parsed = json.loads(text_line.decode("utf-8", "replace"))
                    except Exception:
                        continue
                    choices = parsed.get("choices") if isinstance(parsed, dict) else None
                    if not (isinstance(choices, list) and choices):
                        continue
                    delta = choices[0].get("delta", {})
                    reason = (delta.get("reasoning_content")
                              or delta.get("reasoning")
                              or delta.get("thought"))
                    if isinstance(reason, str) and reason:
                        # Forward the provider's reasoning/activity stream so
                        # reasoning-aware clients (VS Code-style chat panels)
                        # can render it as thinking while the answer forms.
                        # Content scrubbing below does not apply to it.
                        h._write_chunk(("data: " + json.dumps({
                            "id": "chatcmpl-reach",
                            "object": "chat.completion.chunk",
                            "created": created,
                            "model": requested,
                            "choices": [{"index": 0,
                                         "delta": {"reasoning_content": reason},
                                         "finish_reason": None}]
                        }) + "\n\n").encode("utf-8"))
                    content = delta.get("content")
                    if not (isinstance(content, str) and content):
                        continue
                    pending += content
                    emit = ""
                    if not first_line_done:
                        idx = pending.find("\n")
                        if idx >= 0:
                            emit += pending[:idx + 1]
                            pending = pending[idx + 1:]
                            first_line_done = True
                    if first_line_done:
                        while "\n" in pending:
                            idx = pending.find("\n")
                            candidate = pending[:idx]
                            if ROLE_CONTINUATION_RE.match(candidate):
                                stopped = True
                                pending = ""
                                break
                            emit += candidate + "\n"
                            pending = pending[idx + 1:]
                    if emit:
                        assembled_chunks.append(emit)
                        h._write_chunk(("data: " + json.dumps({
                            "id": "chatcmpl-reach",
                            "object": "chat.completion.chunk",
                            "created": created,
                            "model": requested,
                            "choices": [{"index": 0,
                                         "delta": {"content": emit},
                                         "finish_reason": None}]
                        }) + "\n\n").encode("utf-8"))
                    if stopped:
                        break
                if pending:
                    assembled_chunks.append(pending)
                    h._write_chunk(("data: " + json.dumps({
                        "id": "chatcmpl-reach",
                        "object": "chat.completion.chunk",
                        "created": created,
                        "model": requested,
                        "choices": [{"index": 0,
                                     "delta": {"content": pending},
                                     "finish_reason": None}]
                    }) + "\n\n").encode("utf-8"))
                scrubbed = "".join(assembled_chunks)
                now_end = time.time()
                stream_duration = max(0.2, now_end - started)
                latency_ms = int(stream_duration * 1000)
                approx_in = max(1, total_chars // 4)
                approx_out = count_tokens(scrubbed)
                tps = round(approx_out / stream_duration, 1)
                core.STATE.note_speed(tps)
                for payload_chunk in (
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
                        line = _next_line()
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
            core.STATE.note_success(circuit)
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
            msg = choices[0].get("message") or {}
            content_text = msg.get("content") or ""
            # Reasoning models (Gemini 3.x) may spend the whole token budget on
            # reasoning_content and leave content empty; surface the reasoning
            # text as the visible answer so clients don't render an empty reply.
            if not (isinstance(content_text, str) and content_text.strip()):
                reason = msg.get("reasoning_content")
                if isinstance(reason, str) and reason.strip():
                    msg["content"] = reason
                    content_text = reason
                    try:
                        parsed["choices"][0]["message"] = msg
                    except Exception:
                        pass

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
    core.STATE.note_success(circuit)
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
