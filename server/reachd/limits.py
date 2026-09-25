"""Token-bucket rate limiting + the concurrency gate."""

import threading
import time

from reachd.const import MAX_RATE_BUCKETS

# A per-IP bucket idle longer than this is treated as stale: its owner has
# effectively stopped, and re-touching it grants a fresh full burst (the
# intended "fresh per user" semantics). Used only to trim the bucket table.
STALE_BUCKET_S = 600

# ----------------------------------------------------------------------
# Rate limiter (token buckets: per-IP, per-IP+model, global)
# ----------------------------------------------------------------------

class RateLimiter:
    def __init__(self):
        self._lock = threading.RLock()
        self._buckets = {}        # key -> {"tokens": float, "updated": float}
        self._global = {"tokens": 0.0, "updated": 0.0}

    def _evict_stale(self):
        """Trim the bucket table when it exceeds the cap.

        Eviction must be targeted, never global: the old behaviour
        (`self._buckets.clear()`) wiped every active per-IP bucket at once.
        On a public endpoint an attacker filling the table with fresh source
        IPs could trigger that and reset everyone's credit — the exact thing
        a rate limiter exists to deny. Instead:

        1. Drop only buckets idle for more than STALE_BUCKET_S. An idle bucket
           has effectively refilled to full anyway, so re-touching it grants a
           fresh burst — the "fresh per user" semantics, but applied only to
           users who actually stopped.
        2. If the table is still over the cap (every bucket is hot), drop the
           oldest by `updated` until it is back under the cap. This preserves
           every recently-active user's real credit and never resets the
           whole world.
        """
        if len(self._buckets) <= MAX_RATE_BUCKETS:
            return
        now = time.time()
        stale = [k for k, b in self._buckets.items()
                 if now - b["updated"] > STALE_BUCKET_S]
        for k in stale:
            del self._buckets[k]
        if len(self._buckets) > MAX_RATE_BUCKETS:
            for k in sorted(self._buckets, key=lambda k: self._buckets[k]["updated"]) \
                    [: len(self._buckets) - MAX_RATE_BUCKETS]:
                del self._buckets[k]

    def _refill(self, bucket, rate, capacity, now):
        if bucket["updated"] == 0.0:
            bucket["updated"] = now
            bucket["tokens"] = float(capacity)
            return
        bucket["tokens"] = min(capacity,
                               bucket["tokens"] + (now - bucket["updated"]) * rate)
        bucket["updated"] = now

    def check(self, ip, settings, model=None, key_bucket=None, key_rpm=0):
        """Returns (allowed, headers, reason). Optionally enforces a per-model
        bucket (rate_limits.rpm on the alias) and a per-key bucket.

        The per-key bucket is what makes a plan or a credit balance real: it is
        metered against the key rather than the address, so one subscriber
        cannot multiply their allowance by changing IP, and several people
        behind one address are not charged for each other."""
        rl = settings.get("rate_limits", {})
        if not rl.get("enabled"):
            if key_bucket and key_rpm > 0:
                # Disabling shared IP/global limits must not disable a key's
                # own plan cap. The key still has a bucket across all IPs.
                with self._lock:
                    self._evict_stale()
                    now = time.time()
                    burst = float(rl.get("burst", 4))
                    bucket = self._buckets.setdefault(
                        key_bucket, {"tokens": 0.0, "updated": 0.0})
                    self._refill(bucket, float(key_rpm) / 60.0,
                                 float(key_rpm) + burst, now)
                    headers = {"X-RateLimit-Limit": str(int(key_rpm + burst)),
                               "X-RateLimit-Remaining": str(max(0, int(bucket["tokens"] - 1)))}
                    if bucket["tokens"] < 1:
                        wait = (1.0 - bucket["tokens"]) * 60.0 / float(key_rpm)
                        return False, {**headers, "X-RateLimit-Remaining": "0",
                                       "Retry-After": str(max(1, int(wait)) + 1)}, \
                            "key_rpm"
                    bucket["tokens"] -= 1.0
                    return True, headers, None
            return True, {}, None
        with self._lock:
            self._evict_stale()
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

            # Per-key pace. Checked after the shared buckets so a key can
            # only ever be more restrictive than the endpoint as a whole.
            if key_bucket and key_rpm > 0:
                k_bucket = bucket_for(key_bucket, key_rpm)
                if k_bucket["tokens"] < 1:
                    wait = (1.0 - k_bucket["tokens"]) * 60.0 / float(key_rpm)
                    return False, {**headers,
                                   "X-RateLimit-Limit": str(int(key_rpm + burst)),
                                   "X-RateLimit-Remaining": "0",
                                   "Retry-After": str(max(1, int(wait)) + 1)}, \
                        "key_rpm"
                headers = {**headers,
                           "X-RateLimit-Limit": str(int(key_rpm + burst)),
                           "X-RateLimit-Remaining": str(max(0, int(k_bucket["tokens"] - 1)))}

            ip_bucket["tokens"] -= 1.0
            self._global["tokens"] -= 1.0
            if model_rpm:
                self._buckets[ip + "::" + model]["tokens"] -= 1.0
            if key_bucket and key_rpm > 0:
                self._buckets[key_bucket]["tokens"] -= 1.0
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


# ----------------------------------------------------------------------
# Failed-authentication lockout
# ----------------------------------------------------------------------

class AuthGuard:
    """Locks a client IP out after repeated failed key / admin-token attempts.

    The rate limiter only meters requests that got through; this meters the
    ones that did not. A locked-out client is refused *before* its credential is
    even compared, so a lockout cannot be ground down by guessing during it.
    Success clears the record, so an owner who mistypes once is not punished.
    """

    MAX_TRACKED = 4096

    def __init__(self):
        self._lock = threading.Lock()
        self._fails = {}      # ip -> {"count", "first", "locked_until"}

    @staticmethod
    def _limits(settings):
        access = (settings or {}).get("access", {}) or {}
        return (int(access.get("auth_fail_limit", 8) or 0),
                max(1, int(access.get("auth_lockout_s", 300) or 300)))

    def retry_after(self, ip, settings):
        """Seconds left on an active lockout for ip, or 0 when it may try."""
        limit, _lockout = self._limits(settings)
        if limit <= 0:
            return 0
        with self._lock:
            entry = self._fails.get(ip)
            if not entry:
                return 0
            remaining = entry["locked_until"] - time.time()
            return max(1, int(remaining) + 1) if remaining > 0 else 0

    def record_failure(self, ip, settings):
        """Count a failed attempt. Returns the lockout length in seconds when
        this failure tripped it, else 0."""
        limit, lockout = self._limits(settings)
        if limit <= 0:
            return 0
        now = time.time()
        with self._lock:
            entry = self._fails.get(ip)
            if entry is None or (entry["locked_until"] <= now
                                 and now - entry["first"] > lockout):
                entry = {"count": 0, "first": now, "locked_until": 0.0}
            entry["count"] += 1
            self._fails[ip] = entry
            tripped = 0
            if entry["count"] >= limit and entry["locked_until"] <= now:
                entry["locked_until"] = now + lockout
                tripped = lockout
            if len(self._fails) > self.MAX_TRACKED:
                self._evict(now)
            return tripped

    def record_success(self, ip):
        with self._lock:
            self._fails.pop(ip, None)

    def _evict(self, now):
        # Same rule as the rate limiter: never wipe everything (that would
        # hand an attacker a reset), drop expired records first, then the oldest.
        expired = [k for k, e in self._fails.items()
                   if e["locked_until"] <= now and now - e["first"] > STALE_BUCKET_S]
        for k in expired:
            del self._fails[k]
        if len(self._fails) > self.MAX_TRACKED:
            oldest = sorted(self._fails, key=lambda k: self._fails[k]["first"])
            for k in oldest[: len(self._fails) - self.MAX_TRACKED]:
                del self._fails[k]
