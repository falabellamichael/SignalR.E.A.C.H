"""Metadata-only relay analytics for completions handled by hosted accounts."""
import json
import re
import time

import reachd.core as core


class AccountTelemetry:
    def __init__(self, handler, body):
        self.h = handler
        self.started = time.monotonic()
        # Bound to the RelayState that accepted the request. Fixture teardown
        # clears the process global before a cancelled handler finishes, and
        # end_request on that global is what used to raise AttributeError.
        self.state = core.STATE
        self.record = self.state.begin_request()
        self.status, self.error = 503, "accounts_unavailable"
        self.tokens_in = self.tokens_out = None
        self.replayed = False
        self.response = bytearray()
        self.streaming = False
        try:
            payload = json.loads(body or b"{}")
        except (ValueError, UnicodeError):
            payload = {}
        if not isinstance(payload, dict):
            payload = {}
        model = payload.get("model")
        self.model = model[:128] if isinstance(model, str) else ""
        self.stream = payload.get("stream") is True
        self.record.update(model=self.model, upstream="account-service", stream=self.stream, ip=handler._client_ip())
        token = handler.headers.get("Authorization", "")
        match = re.fullmatch(r"Bearer (rch_key_[a-f0-9]{8})[a-f0-9]{56}", token)
        self.label = "API key " + match[1] if match else "Account session"
        origin = handler.headers.get("Origin", "")
        if not match and origin in ("https://signalreach.ca", "https://www.signalreach.ca",
                                    "https://signalreach.com", "https://www.signalreach.com"):
            self.label = "Website"

    def headers(self, response):
        self.status = response.status
        self.error = "account_request_failed" if self.status >= 400 else None
        self.replayed = response.getheader("X-Reach-Replayed") == "true"
        self.streaming = "text/event-stream" in (response.getheader("Content-Type") or "").lower()
        ti, to = response.getheader("X-Reach-Usage-In") or "", response.getheader("X-Reach-Usage-Out") or ""
        if re.fullmatch(r"\d{1,13}", ti) and re.fullmatch(r"\d{1,13}", to) and max(int(ti), int(to)) <= 10**12:
            self.tokens_in, self.tokens_out = int(ti), int(to)
        account = response.getheader("X-Reach-Account-Id") or ""
        if re.fullmatch(r"[a-f0-9]{64}", account):
            self.label += " · account " + account[:12]

    def receive(self, data):
        # Match the proxy's response bound. Prompts and generated files are never
        # written to analytics, even when verbose logging is enabled elsewhere.
        if len(self.response) + len(data) <= 2 * 1024 * 1024:
            self.response.extend(data)

    def _read_usage(self, value):
        if not isinstance(value, dict):
            return
        usage = value.get("usage")
        if isinstance(usage, dict):
            ti, to = usage.get("prompt_tokens"), usage.get("completion_tokens")
            total = usage.get("total_tokens", (ti + to) if type(ti) is int and type(to) is int else None)
            if (type(ti) is int and type(to) is int and 0 <= ti <= 10**12 and 0 <= to <= 10**12
                    and type(total) is int and total == ti + to):
                self.tokens_in, self.tokens_out = ti, to
        error = value.get("error")
        if self.status >= 400 and isinstance(error, dict):
            code = error.get("code")
            if isinstance(code, str) and re.fullmatch(r"[a-zA-Z0-9_.-]{1,100}", code):
                self.error = code

    def finish(self, disconnected=False):
        try:
            if self.streaming:
                for line in self.response.splitlines():
                    if line.startswith(b"data:") and line[5:].strip() != b"[DONE]":
                        try:
                            self._read_usage(json.loads(line[5:]))
                        except (ValueError, UnicodeError):
                            pass
            else:
                try:
                    self._read_usage(json.loads(self.response))
                except (ValueError, UnicodeError):
                    pass
            if disconnected:
                self.status, self.error = 499, "request_cancelled"
            if self.replayed:
                self.tokens_in = self.tokens_out = 0
            self.h._log_chat(model=self.model, upstream_model="account-service", ip=self.h._client_ip(),
                             user_agent=self.h.headers.get("User-Agent", ""), status=self.status,
                             error=self.error, latency_ms=round((time.monotonic() - self.started) * 1000),
                             tokens_in=self.tokens_in, tokens_out=self.tokens_out, stream=self.stream,
                             cached=self.replayed, key_name=self.label, relay_state=self.state)
        finally:
            self.state.end_request(self.record)
