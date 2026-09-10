"""Token-bucket rate limiting + the concurrency gate."""

import threading
import time

from reachd.const import MAX_RATE_BUCKETS

# ----------------------------------------------------------------------
# Rate limiter (token buckets: per-IP, per-IP+model, global)
# ----------------------------------------------------------------------

class RateLimiter:
    def __init__(self):
        self._lock = threading.RLock()
        self._buckets = {}        # key -> {"tokens": float, "updated": float}
        self._global = {"tokens": 0.0, "updated": 0.0}

    def _refill(self, bucket, rate, capacity, now):
        if bucket["updated"] == 0.0:
            bucket["updated"] = now
            bucket["tokens"] = float(capacity)
            return
        bucket["tokens"] = min(capacity,
                               bucket["tokens"] + (now - bucket["updated"]) * rate)
        bucket["updated"] = now

    def check(self, ip, settings, model=None):
        """Returns (allowed, headers, reason). Optionally enforces a per-model
        bucket (rate_limits.rpm on the alias)."""
        rl = settings.get("rate_limits", {})
        if not rl.get("enabled"):
            return True, {}, None
        with self._lock:
            if len(self._buckets) > MAX_RATE_BUCKETS:
                self._buckets.clear()
            now = time.time()
            per_ip_rpm = float(rl.get("per_ip_rpm", 12))
            burst = float(rl.get("burst", 4))
            global_rpm = float(rl.get("global_rpm", 60))

            self._refill(self._global, global_rpm / 60.0,
                         global_rpm + burst, now)
            if self._global["tokens"] < 1:
                wait = (1.0 - self._global["tokens"]) * 60.0 / global_rpm
                return False, {"X-RateLimit-Limit": str(int(global_rpm + burst)),
                               "X-RateLimit-Remaining": "0",
                               "Retry-After": str(max(1, int(wait)) + 1)}, \
                    "global_rpm"

            def bucket_for(key, rpm):
                bucket = self._buckets.setdefault(
                    key, {"tokens": 0.0, "updated": 0.0})
                self._refill(bucket, float(rpm) / 60.0, float(rpm) + burst, now)
                return bucket

            ip_bucket = bucket_for(ip, per_ip_rpm)
            headers = {"X-RateLimit-Limit": str(int(per_ip_rpm + burst)),
                       "X-RateLimit-Remaining": str(max(0, int(ip_bucket["tokens"] - 1)))}
            if ip_bucket["tokens"] < 1:
                wait = (1.0 - ip_bucket["tokens"]) * 60.0 / per_ip_rpm
                return False, {**headers, "X-RateLimit-Remaining": "0",
                               "Retry-After": str(max(1, int(wait)) + 1)}, \
                    "per_ip_rpm"

            model_rpm = None
            if model:
                model_rpm = settings.get("models", {}).get(model, {}) \
                    .get("rate_limits", {}).get("rpm", 0)
            if model_rpm:
                m_bucket = bucket_for(ip + "::" + model, model_rpm)
                if m_bucket["tokens"] < 1:
                    wait = (1.0 - m_bucket["tokens"]) * 60.0 / float(model_rpm)
                    return False, {**headers, "X-RateLimit-Limit": str(int(model_rpm + burst)),
                                   "X-RateLimit-Remaining": "0",
                                   "Retry-After": str(max(1, int(wait)) + 1)}, \
                        "model_rpm"

            ip_bucket["tokens"] -= 1.0
            self._global["tokens"] -= 1.0
            if model_rpm:
                self._buckets[ip + "::" + model]["tokens"] -= 1.0
        return True, headers, None


# ----------------------------------------------------------------------
# Relay state
# ----------------------------------------------------------------------

class CounterGate:
    """Configurable concurrency limit (live-updatable, unlike BoundedSemaphore)."""

    def __init__(self):
        self._lock = threading.Lock()
        self._active = 0

    def acquire(self, limit, timeout_s=None):
        deadline = (time.time() + timeout_s) if timeout_s is not None else None
        while True:
            with self._lock:
                if self._active < limit:
                    self._active += 1
                    return True
            if deadline is not None and time.time() >= deadline:
                return False
            time.sleep(0.05)

    def release(self):
        with self._lock:
            self._active = max(0, self._active - 1)
