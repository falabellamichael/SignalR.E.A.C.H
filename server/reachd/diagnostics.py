"""Connectivity probes for the upstream service and published relay endpoint.

The HTTP handler supplies its current relay state and authentication helper.
Standard-library and net module objects stay shared with the handler so callers
can continue patching the existing HTTP and timing seams.
"""

import json
import time
import urllib.error
import urllib.request

from reachd import net


def handle_upstream_test(handler, state):
    started = time.time()
    models = state.public_models() or state.enabled_models()
    if not models:
        return handler._json(503, {"ok": False,
                                "error": "no enabled models configured"})
    # Prefer an OmniRoute alias — this is the OmniRoute connectivity probe.
    # Only when nothing but bridge aliases exists does it test the bridge.
    upstreams = sorted(models.values())
    upstream_model = next((u for u in upstreams
                           if not u.startswith("bridge/")), upstreams[0])
    use_bridge = upstream_model.startswith("bridge/")
    payload = {"model": upstream_model[len("bridge/"):] if use_bridge
               else upstream_model,
               "messages": [{"role": "user",
                             "content": "Reply with exactly: REACH OK"}],
               "max_tokens": 16}
    try:
        url = (state.bridge_url if use_bridge
               else state.omniroute_url).rstrip("/") + "/chat/completions"
        headers = {"Content-Type": "application/json"}
        if not use_bridge:
            headers["Authorization"] = "Bearer " + state.key
        req = urllib.request.Request(
            url, data=json.dumps(payload).encode("utf-8"), method="POST",
            headers=headers)
        with net.urlopen(req, timeout=60) as resp:
            data = json.loads(resp.read().decode("utf-8", "replace"))
        reply = (data.get("choices") or [{}])[0].get("message", {}).get("content")
        handler._json(200, {"ok": True, "reply": reply,
                         "latency_ms": round((time.time() - started) * 1000),
                         "model": upstream_model})
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", "replace")
        handler._json(502, {"ok": False, "error": body[:300],
                         "status": exc.code})
    except Exception as exc:
        handler._json(502, {"ok": False, "error": str(exc)[:300]})


def handle_diagnose(handler, state, key_expired):
    """PRD 'Test Public Endpoint Reachability': probe the relay's own
    public pointer URL from the outside — TLS handshake, headers, and a
    sample chat payload with round-trip timing. Server-side (not the
    browser) so CORS/opaque responses can't fake a pass."""
    url = (state.public_url or "").strip()
    if not url:
        return handler._json(409, {"ok": False,
                                "error": "no public URL — start a tunnel "
                                         "or set an override first"})
    if not url.lower().startswith("https://"):
        return handler._json(409, {"ok": False,
                                "error": "public URL is not https"})
    checks = []
    started = time.time()
    # ngrok free tier serves a browser-warning interstitial (HTTP 502 to
    # plain clients) unless this header is present — a diagnostics probe
    # must see the real endpoint, not the interstitial.
    probe_headers = {"User-Agent": "SignalR.E.A.C.H-diagnose",
                     "ngrok-skip-browser-warning": "1"}
    try:
        # Plain GET /health through the public URL. ssl context is the
        # default (verifies certificate + hostname) — a bad cert raises.
        # This check intentionally keeps the system proxy (unlike
        # net.urlopen's local calls): a host behind a corporate egress
        # proxy needs it to reach the internet, and the request carries
        # no credentials anyway.
        req = urllib.request.Request(url.rstrip("/") + "/health",
                                     headers=probe_headers)
        with urllib.request.urlopen(req, timeout=20) as resp:
            health_ms = round((time.time() - started) * 1000)
            body = resp.read(4096).decode("utf-8", "replace")
            try:
                health = json.loads(body)
            except ValueError:
                health = {}
            checks.append({"name": "tls_and_headers", "ok": True,
                           "detail": "certificate verified; HTTP %d in %d ms"
                                     % (resp.status, health_ms),
                           "status": resp.status, "latency_ms": health_ms})
            checks.append({"name": "relay_health",
                           "ok": bool(health.get("ok")),
                           "detail": "service=%s version=%s"
                                     % (health.get("service", "?"),
                                        health.get("version", "?"))})
    except urllib.error.HTTPError as exc:
        return handler._json(502, {"ok": False, "url": url, "checks": checks,
                                "error": "HTTP %d from public endpoint"
                                         % exc.code})
    except Exception as exc:
        # ssl.SSLCertVerificationError, DNS failures, timeouts, connection
        # refused (firewall) all land here with the real message.
        return handler._json(502, {"ok": False, "url": url, "checks": checks,
                                "error": str(exc)[:300]})

    # Sample chat payload through the public route (tiny, cheap).
    probe_started = time.time()
    access = state.cfg.get("access", {}) or {}
    headers = {"Content-Type": "application/json",
               "ngrok-skip-browser-warning": "1"}
    # Any credential the gate would accept: prefer a live client key,
    # fall back to the legacy access_key. Probing without auth would
    # report a healthy endpoint as broken whenever the operator relies
    # on per-client keys alone — and a remote caller needs a key even
    # when key_required is off (that flag only exempts local tools).
    probe_key = next(
        (k.get("key") for k in access.get("keys", [])
         if k.get("enabled", True) and k.get("key")
         and not key_expired(k)),
        None) or access.get("access_key")
    if probe_key:
        headers["Authorization"] = "Bearer " + probe_key
    payload = {"model": sorted(state.public_models() or ["gpt-4o"])[0],
               "messages": [{"role": "user",
                             "content": "Reply with exactly: REACH OK"}],
               "max_tokens": 16, "stream": False}
    try:
        req = urllib.request.Request(
            url.rstrip("/") + "/v1/chat/completions",
            data=json.dumps(payload).encode("utf-8"), method="POST",
            headers=headers)
        # System proxy kept on purpose (see the /health probe above): the
        # Authorization header rides inside TLS over CONNECT, so a proxy
        # only learns the tunnel hostname — same as any client would.
        with urllib.request.urlopen(req, timeout=60) as resp:
            chat_ms = round((time.time() - probe_started) * 1000)
            data = json.loads(resp.read().decode("utf-8", "replace"))
            reply = (data.get("choices") or [{}])[0].get("message", {}).get("content")
            checks.append({"name": "chat_completion", "ok": True,
                           "detail": "HTTP %d in %d ms — %r"
                                     % (resp.status, chat_ms,
                                        (reply or "")[:40]),
                           "status": resp.status, "latency_ms": chat_ms})
    except urllib.error.HTTPError as exc:
        detail = exc.read(512).decode("utf-8", "replace")
        checks.append({"name": "chat_completion", "ok": False,
                       "detail": "HTTP %d — %s" % (exc.code, detail[:200]),
                       "status": exc.code,
                       "latency_ms": round((time.time() - probe_started) * 1000)})
    except Exception as exc:
        checks.append({"name": "chat_completion", "ok": False,
                       "detail": str(exc)[:200],
                       "latency_ms": round((time.time() - probe_started) * 1000)})
    ok = all(c.get("ok") for c in checks)
    handler._json(200 if ok else 502,
               {"ok": ok, "url": url, "checks": checks,
                "total_ms": round((time.time() - started) * 1000)})

