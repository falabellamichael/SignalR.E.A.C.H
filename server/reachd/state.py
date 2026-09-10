"""The live relay state: settings, upstream health, and stats."""

import collections
import json
import os
import threading
import time
import urllib.request

import reachd.core as core   # PORT is read at call time (cycle-safe)
from reachd.analytics import Analytics
from reachd.cache import ResponseCache
from reachd.const import (
    LATENCY_SAMPLE_LIMIT,
    SERVICE,
    VERSION,
)
from reachd.limits import CounterGate, RateLimiter
from reachd.settings import (
    DEFAULT_SETTINGS,
    _host_is_local,
    config_dir,
    find_omniroute_key,
)
from urllib.parse import urlsplit


class RelayState:
    def __init__(self, cfg, cfg_path):
        self.cfg = cfg
        self.cfg_path = cfg_path
        self.analytics = Analytics(config_dir() / "data" / "reach.db")
        self.limiter = RateLimiter()
        self.cache = ResponseCache()
        self.gate = CounterGate()
        self.latencies = collections.deque(maxlen=LATENCY_SAMPLE_LIMIT)
        self.speeds = collections.deque(maxlen=LATENCY_SAMPLE_LIMIT)
        self.public_url = None
        self.public_url_source = None
        self.started_at = time.time()
        self.upstream_ok = None
        self.upstream_checked = 0.0
        # Two INDEPENDENT breakers: "omniroute" (the free upstream) and
        # "bridge" (the local CodeGPT economy bridge). They are separate
        # processes on separate ports, so one being down says nothing about the
        # other. A single shared breaker meant an OmniRoute outage answered 503
        # for every economy alias too, even though those never touch OmniRoute.
        self._circuits = {}
        # Requests currently being relayed, keyed by id(record). A request that
        # runs long is visible here (and in /status) instead of being a silence.
        self.in_flight = {}
        self._lock = threading.RLock()

    @property
    def omniroute_url(self):
        # Last-line guard against SSRF/credential exfil: load_config's
        # validation is non-fatal, so a hand-edited config.json could carry a
        # public upstream. Refuse to attach the bearer token to a non-local
        # host — fall back to the loopback default instead.
        url = self.cfg.get("omniroute_url", DEFAULT_SETTINGS["omniroute_url"])
        try:
            host = urlsplit(url).hostname
        except ValueError:
            host = None
        if not host or not _host_is_local(host):
            return DEFAULT_SETTINGS["omniroute_url"]
        return url

    @property
    def bridge_url(self):
        """The local tray bridge (CodeGPT economy models). Same loopback guard
        as omniroute_url: a hand-edited config.json must not turn the relay into
        a proxy for an arbitrary upstream."""
        url = self.cfg.get("bridge_url", DEFAULT_SETTINGS["bridge_url"])
        try:
            host = urlsplit(url).hostname
        except ValueError:
            host = None
        if not host or not _host_is_local(host):
            return DEFAULT_SETTINGS["bridge_url"]
        return url

    @property
    def key(self):
        k = self.cfg.get("omniroute_key", "")
        if not k:
            k = find_omniroute_key() or ""
        return k

    def upstream_alive(self):
        interval = int(self.cfg.get("health_check_interval_s", 60))
        with self._lock:
            now = time.time()
            if self.upstream_checked and now - self.upstream_checked < interval:
                return self.upstream_ok
        ok = False
        if self.key:
            try:
                req = urllib.request.Request(
                    self.omniroute_url.rstrip("/") + "/models",
                    headers={"Authorization": "Bearer " + self.key})
                with urllib.request.urlopen(req, timeout=4) as resp:
                    ok = resp.status == 200
            except Exception:
                ok = False
        with self._lock:
            self.upstream_ok = ok
            self.upstream_checked = time.time()
        return ok

    def _circuit(self, upstream):
        # The breaker record for one upstream ("omniroute" or "bridge").
        return self._circuits.setdefault(
            upstream, {"failures": 0, "open_until": 0.0})

    def note_failure(self, upstream="omniroute"):
        # Record a failed call to one upstream, opening its breaker once the
        # configured consecutive-failure threshold is reached.
        threshold = int(self.cfg.get("circuit_threshold", 5))
        cooldown = int(self.cfg.get("circuit_cooldown_s", 30))
        with self._lock:
            state = self._circuit(upstream)
            state["failures"] += 1
            if state["failures"] >= threshold:
                state["open_until"] = time.time() + cooldown
                # Deliberately NOT resetting `failures` here. Clearing it would
                # let an upstream that never recovers re-arm from zero after
                # every cool-down, so it could fail forever without the breaker
                # ever re-tripping. Only note_success clears the counter.
    def note_success(self, upstream="omniroute"):
        # Clear one upstream's breaker after a completed call.
        with self._lock:
            state = self._circuit(upstream)
            state["failures"] = 0
            state["open_until"] = 0.0
    def circuit_open(self, upstream="omniroute"):
        # True while the named upstream is cooling down after failures.
        # Callers that serve one upstream must pass its name: a bridge request
        # is unaffected by an OmniRoute outage, and vice versa.
        with self._lock:
            state = self._circuits.get(upstream)
            return bool(state) and time.time() < state["open_until"]


    def discover_public_url(self):
        if self.cfg.get("tunnel", "ngrok") != "ngrok":
            return None, None
        try:
            req = urllib.request.Request("http://127.0.0.1:4040/api/tunnels")
            with urllib.request.urlopen(req, timeout=2) as resp:
                payload = json.loads(resp.read().decode("utf-8", "replace"))
            for tun in payload.get("tunnels", []):
                if tun.get("proto") == "https" and tun.get("public_url"):
                    return tun["public_url"], "ngrok"
        except Exception:
            pass
        return None, None

    def poll_public_url(self):
        manual = (self.cfg.get("public_url_override") or "").strip() or None
        if manual:
            with self._lock:
                self.public_url, self.public_url_source = manual, "manual"
            return
        url, source = self.discover_public_url()
        if url:
            with self._lock:
                self.public_url, self.public_url_source = url, source

    # ---- in-flight requests ----

    def begin_request(self):
        """Register a relayed request; returns the record the caller enriches
        (model/upstream/stream) and passes back to end_request."""
        record = {"started": time.time(), "model": "", "upstream": "",
                  "stream": False, "ip": ""}
        with self._lock:
            self.in_flight[id(record)] = record
        return record

    def end_request(self, record):
        """Drop a request from the in-flight table; returns how long it ran."""
        if not isinstance(record, dict):
            return 0.0
        with self._lock:
            self.in_flight.pop(id(record), None)
        return max(0.0, time.time() - record.get("started", time.time()))

    def in_flight_snapshot(self):
        with self._lock:
            records = list(self.in_flight.values())
        now = time.time()
        return [{"model": r.get("model") or "(resolving)",
                 "upstream": r.get("upstream", ""),
                 "stream": bool(r.get("stream")),
                 "ip": r.get("ip", ""),
                 "elapsed_s": round(now - r.get("started", now), 1)}
                for r in records]

    def enabled_models(self):
        return {alias: spec["upstream"] for alias, spec
                in self.cfg.get("models", {}).items() if spec.get("enabled")}

    def public_models(self):
        return {alias: spec["upstream"] for alias, spec
                in self.cfg.get("models", {}).items()
                if spec.get("enabled") and spec.get("public", True)}

    def p95_latency_ms(self):
        with self._lock:
            if not self.latencies:
                return 0.0
            ordered = sorted(self.latencies)
            return round(ordered[int(len(ordered) * 0.95) - 1], 1)

    def note_speed(self, tps):
        if tps and tps > 0:
            with self._lock:
                self.speeds.append(float(tps))

    def current_speed(self):
        with self._lock:
            if not self.speeds:
                return 0.0
            return round(sum(self.speeds) / len(self.speeds), 1)

    def snapshot(self):
        with self._lock:
            stats = self.analytics.stats()
            today = stats.get("today", {})
            speed = self.current_speed() or today.get("tokens_per_sec", 0.0)
            today["tokens_per_sec"] = speed
            today["live_tps"] = speed
            in_flight = self.in_flight_snapshot()
            return {
                "service": SERVICE,
                "version": VERSION,
                "ok": True,
                "port": core.PORT,
                "upstream": self.omniroute_url,
                "upstream_ok": self.upstream_alive(),
                "bridge_url": self.bridge_url,
                # Reported per upstream so the dashboard can tell a free-upstream
                # outage apart from the local bridge being down. `circuit_open`
                # stays as the OmniRoute flag for older panel builds.
                "circuit_open": self.circuit_open("omniroute"),
                "circuits": {
                    "omniroute": self.circuit_open("omniroute"),
                    "bridge": self.circuit_open("bridge"),
                },
                "models": list(self.public_models()),
                "model_count": len(self.cfg.get("models", {})),
                "public_url": self.public_url,
                "public_url_source": self.public_url_source,
                "uptime_s": round(time.time() - self.started_at, 1),
                "p95_latency_ms": self.p95_latency_ms(),
                "tokens_per_sec": speed,
                "today": today,
                "cache": self.cache.snapshot(),
                "rate_limits": {
                    "enabled": bool(self.cfg.get("rate_limits", {})
                                   .get("enabled")),
                },
                "access_required": bool(self.cfg.get("access", {})
                                       .get("key_required")),
                # Live work: a long generation shows up here while it runs, so
                # "still waiting" is something you can look up, not guess.
                "in_flight": in_flight,
                "in_flight_count": len(in_flight),
                "in_flight_oldest_s": max((item["elapsed_s"] for item in in_flight),
                                          default=0.0),
                "config_error": self.cfg.get("_last_config_error"),
            }

    def log_rotation(self, log_path):
        try:
            limit_mb = int(self.cfg.get("system", {}).get("log_rotation_mb", 2))
            if log_path.is_file() and log_path.stat().st_size > limit_mb * 1024 * 1024:
                os.replace(str(log_path), str(log_path) + ".1")
        except OSError:
            pass
