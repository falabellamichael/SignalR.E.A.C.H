#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Per-key quotas and expiry: the caps that make a key a plan, not just a door.

Before this, a client key was all-or-nothing — `rate_limit_rpm` was stored on
every key and read by nothing, and there was no expiry at all, so a key handed
out once was valid forever at the endpoint's shared rate. These tests pin the
three things that changed:

  1. an expired key is refused, and refusing it never counts as a failed guess
  2. a key's own requests-per-minute cap is enforced against the KEY, so it
     cannot be multiplied by changing address
  3. a key's daily token budget is refused BEFORE another completion is bought,
     and spend is recorded even for keys that set no budget

Run:  python -m unittest tests.test_reachd_key_limits -v
"""

import http.client
import json
import sys
import tempfile
import threading
import time
import unittest
from http.server import ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "server"))

import reachd  # noqa: E402
from reachd import core  # noqa: E402
from reachd.handler import RelayHandler  # noqa: E402
from reachd.settings import key_expired  # noqa: E402
from reachd.state import RelayState  # noqa: E402

TUNNEL = {"X-Forwarded-For": "203.0.113.9", "Host": "abc.ngrok-free.app"}


def stamp(offset_s):
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time() + offset_s))


class KeyExpiryUnitTests(unittest.TestCase):
    """key_expired() decides whether a key's term has ended."""

    def test_absent_or_blank_never_expires(self):
        for value in (None, "", "   "):
            self.assertFalse(key_expired({"expires_at": value}), repr(value))
        self.assertFalse(key_expired({}))

    def test_past_expires_future_does_not(self):
        self.assertTrue(key_expired({"expires_at": stamp(-60)}))
        self.assertFalse(key_expired({"expires_at": stamp(3600)}))

    def test_unreadable_timestamp_is_treated_as_no_expiry(self):
        # A hand-edited config must not lock the operator out of their own
        # relay; an unparseable value fails open and the validator is what
        # rejects it on the way in.
        for junk in ("tomorrow", "2026-13-45T99:99:99Z", "1790000000", "2026-12-31"):
            self.assertFalse(key_expired({"expires_at": junk}), junk)

    def test_boundary_is_inclusive(self):
        self.assertTrue(key_expired({"expires_at": stamp(0)}, now=time.time() + 1))

    def test_new_keys_carry_the_fields(self):
        key = reachd.generate_client_key("Alice")
        self.assertIsNone(key["expires_at"])
        self.assertEqual(key["rate_limit_rpm"], 0)
        self.assertEqual(key["tokens_day"], 0)


class KeyFieldValidationTests(unittest.TestCase):
    def _cfg(self, **key_fields):
        cfg = json.loads(json.dumps(reachd.DEFAULT_SETTINGS))
        key = reachd.generate_client_key("K")
        key.update(key_fields)
        cfg["access"]["keys"] = [key]
        return cfg

    def test_valid_values_pass(self):
        reachd.validate_settings(self._cfg(rate_limit_rpm=30, tokens_day=100000,
                                           expires_at=stamp(86400)))
        reachd.validate_settings(self._cfg(expires_at=None))

    def test_bad_values_are_rejected(self):
        for field, value in (("rate_limit_rpm", -1),
                             ("rate_limit_rpm", "fast"),
                             ("tokens_day", -5),
                             ("expires_at", "31/12/2026"),
                             ("expires_at", 1790000000)):
            with self.assertRaises(reachd.SettingsError, msg="%s=%r" % (field, value)):
                reachd.validate_settings(self._cfg(**{field: value}))


class RateLimiterKeyBucketTests(unittest.TestCase):
    """The per-key bucket is metered against the key, not the address."""

    CFG = {"rate_limits": {"enabled": True, "per_ip_rpm": 1000,
                           "global_rpm": 1000, "burst": 0}}

    def test_key_cap_applies_across_different_addresses(self):
        limiter = reachd.RateLimiter()
        allowed = [limiter.check("10.0.0.%d" % i, self.CFG,
                                 key_bucket="key::k1", key_rpm=2)[0]
                   for i in range(4)]
        # Two through, then the key is spent no matter which address asks.
        self.assertEqual(allowed, [True, True, False, False])

    def test_reason_identifies_the_key_bucket(self):
        limiter = reachd.RateLimiter()
        limiter.check("1.1.1.1", self.CFG, key_bucket="key::k1", key_rpm=1)
        allowed, headers, reason = limiter.check("1.1.1.1", self.CFG,
                                                 key_bucket="key::k1", key_rpm=1)
        self.assertFalse(allowed)
        self.assertEqual(reason, "key_rpm")
        self.assertEqual(headers["X-RateLimit-Remaining"], "0")
        self.assertGreaterEqual(int(headers["Retry-After"]), 1)

    def test_separate_keys_do_not_share_a_bucket(self):
        limiter = reachd.RateLimiter()
        limiter.check("1.1.1.1", self.CFG, key_bucket="key::a", key_rpm=1)
        self.assertFalse(limiter.check("1.1.1.1", self.CFG, key_bucket="key::a", key_rpm=1)[0])
        self.assertTrue(limiter.check("1.1.1.1", self.CFG, key_bucket="key::b", key_rpm=1)[0])

    def test_no_bucket_means_no_per_key_cap(self):
        limiter = reachd.RateLimiter()
        allowed = [limiter.check("1.1.1.1", self.CFG)[0] for _ in range(5)]
        self.assertEqual(allowed, [True] * 5)

    def test_key_cap_cannot_loosen_the_shared_cap(self):
        tight = {"rate_limits": {"enabled": True, "per_ip_rpm": 1,
                                 "global_rpm": 1000, "burst": 0}}
        limiter = reachd.RateLimiter()
        self.assertTrue(limiter.check("1.1.1.1", tight, key_bucket="key::k", key_rpm=9999)[0])
        allowed, _h, reason = limiter.check("1.1.1.1", tight, key_bucket="key::k", key_rpm=9999)
        self.assertFalse(allowed)
        self.assertEqual(reason, "per_ip_rpm")


class RelayFixture(unittest.TestCase):
    """A live relay whose single key carries whatever caps the test needs."""

    key_fields = {}
    rate_limit_overrides = {}

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        tmp = Path(self._tmp.name)
        cfg = json.loads(json.dumps(reachd.DEFAULT_SETTINGS))
        cfg["system"]["host_bind"] = False
        cfg["access"]["key_required"] = True
        self.key = reachd.generate_client_key("Subscriber")
        self.key.update(self.key_fields)
        cfg["access"]["keys"] = [self.key]
        cfg["rate_limits"].update(self.rate_limit_overrides)
        with patch("reachd.state.config_dir", return_value=tmp):
            self.state = RelayState(cfg, tmp / "config.json")
        self._patch = patch.object(core, "STATE", self.state)
        self._patch.start()
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), RelayHandler)
        self.port = self.server.server_address[1]
        threading.Thread(target=lambda: self.server.serve_forever(poll_interval=0.02),
                         daemon=True).start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self._patch.stop()
        self._tmp.cleanup()

    def call(self, method, path, headers=None, body=None):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        conn.request(method, path, body=body, headers=dict(headers or {}))
        resp = conn.getresponse()
        data = resp.read()
        conn.close()
        return resp.status, data

    def bearer(self, **extra):
        return {"Authorization": "Bearer " + self.key["key"], **TUNNEL, **extra}


class ExpiredKeyTests(RelayFixture):
    key_fields = {"expires_at": stamp(-3600)}

    def test_expired_key_is_refused_with_its_own_code(self):
        status, body = self.call("GET", "/v1/models", self.bearer())
        self.assertEqual(status, 401)
        self.assertEqual(json.loads(body)["error"]["code"], "key_expired")

    def test_expiry_never_counts_toward_the_lockout(self):
        # Eight is the default lockout threshold. A lapsed key is identified,
        # not guessed, so the holder must still get a clear 401 afterwards
        # rather than an opaque 429.
        for _ in range(10):
            status, _b = self.call("GET", "/v1/models", self.bearer())
            self.assertEqual(status, 401)
        self.assertEqual(json.loads(self.call("GET", "/v1/models", self.bearer())[1])
                         ["error"]["code"], "key_expired")

    def test_refusal_is_logged_as_expired(self):
        self.call("GET", "/v1/models", self.bearer())
        rows = json.loads(self.call("GET", "/_reach/logs?limit=5")[1])["logs"]
        self.assertTrue(any(r.get("error") == "key_expired" for r in rows), rows)


class UnexpiredKeyTests(RelayFixture):
    key_fields = {"expires_at": stamp(3600)}

    def test_a_key_inside_its_term_still_works(self):
        self.assertEqual(self.call("GET", "/v1/models", self.bearer())[0], 200)


class KeyRpmOverHttpTests(RelayFixture):
    """Metering lives on the chat path, where the shared limits already are.
    /v1/models is deliberately unmetered - it costs no upstream call - so a
    per-key cap must not appear there either."""

    key_fields = {"rate_limit_rpm": 2}
    # burst would add 4 more on top of the cap; 0 makes the allowance exact.
    rate_limit_overrides = {"burst": 0}

    def chat(self, **extra):
        body = json.dumps({"model": "gpt-4o",
                           "messages": [{"role": "user", "content": "hi"}]}).encode()
        return self.call("POST", "/v1/chat/completions",
                         self.bearer(**{"Content-Type": "application/json"}, **extra),
                         body=body)

    def test_chat_meters_the_key(self):
        codes = [self.chat()[0] for _ in range(5)]
        self.assertEqual(codes.count(429), 3, codes)
        self.assertNotIn(429, codes[:2], codes)

    def test_the_refusal_names_the_key_bucket(self):
        for _ in range(2):
            self.chat()
        status, body = self.chat()
        self.assertEqual(status, 429)
        message = json.loads(body)["error"]["message"]
        self.assertIn("key_rpm", message)

    def test_changing_address_does_not_refresh_the_allowance(self):
        for i in range(2):
            self.chat(**{"X-Forwarded-For": "10.0.0.%d" % i})
        status, _b = self.chat(**{"X-Forwarded-For": "10.0.0.99"})
        self.assertEqual(status, 429)

    def test_a_request_charges_the_key_exactly_once(self):
        """The limiter is consulted twice per chat request (shared buckets,
        then per-model). Charging the key on both halved every plan, so an
        rpm of N must admit exactly N requests - no more, no fewer."""
        codes = [self.chat()[0] for _ in range(4)]
        self.assertEqual(len([c for c in codes if c != 429]), 2, codes)
        self.assertEqual(codes[2:], [429, 429], codes)

    def test_models_stays_unmetered(self):
        codes = [self.call("GET", "/v1/models", self.bearer())[0] for _ in range(5)]
        self.assertEqual(codes, [200] * 5)


class KeyDailyTokenTests(RelayFixture):
    key_fields = {"tokens_day": 100}

    def _spend(self, tokens):
        self.state.analytics.add_tokens("key::" + self.key["id"], tokens)

    def test_refused_before_buying_another_completion(self):
        self._spend(150)
        body = json.dumps({"model": "gpt-4o",
                           "messages": [{"role": "user", "content": "hi"}]}).encode()
        status, payload = self.call(
            "POST", "/v1/chat/completions",
            self.bearer(**{"Content-Type": "application/json"}), body=body)
        self.assertEqual(status, 429)
        error = json.loads(payload)["error"]
        self.assertEqual(error["code"], "key_daily_token_limit")
        self.assertIn("100", error["message"])

    def test_under_budget_is_not_refused_by_the_key_gate(self):
        self._spend(10)
        body = json.dumps({"model": "gpt-4o",
                           "messages": [{"role": "user", "content": "hi"}]}).encode()
        status, payload = self.call(
            "POST", "/v1/chat/completions",
            self.bearer(**{"Content-Type": "application/json"}), body=body)
        # No upstream here, so anything but the key gate is a pass for this test.
        self.assertNotEqual(json.loads(payload).get("error", {}).get("code"),
                            "key_daily_token_limit")

    def test_spend_is_tracked_per_key_not_per_address(self):
        self._spend(60)
        self.assertEqual(self.state.analytics.tokens_today("key::" + self.key["id"]), 60)
        self.assertEqual(self.state.analytics.tokens_today("203.0.113.9"), 0)


class KeyLimitsAccessorTests(RelayFixture):
    """key_limits() is the one place the pipeline learns a key's caps."""

    key_fields = {"rate_limit_rpm": 5, "tokens_day": 1000}

    def _handler_for(self, key):
        class _H:
            key_limits = RelayHandler.key_limits
        h = _H()
        h._auth_key = key
        h._auth_key_id = (key or {}).get("id", "")
        return h

    def test_reports_the_keys_caps(self):
        bucket, rpm, tokens = self._handler_for(self.key).key_limits()
        self.assertEqual((bucket, rpm, tokens),
                         ("key::" + self.key["id"], 5, 1000))

    def test_no_key_means_nothing_to_meter(self):
        self.assertEqual(self._handler_for(None).key_limits(), (None, 0, 0))

    def test_a_key_without_caps_is_not_metered(self):
        plain = reachd.generate_client_key("Plain")
        self.assertEqual(self._handler_for(plain).key_limits(), (None, 0, 0))

    def test_garbage_caps_do_not_crash_the_request(self):
        broken = dict(self.key, rate_limit_rpm="lots", tokens_day=None)
        self.assertEqual(self._handler_for(broken).key_limits(), (None, 0, 0))


if __name__ == "__main__":
    unittest.main(verbosity=2)


class KeyPatchRouteTests(RelayFixture):
    """PATCH /_reach/keys/<id> can change a plan without a whole-settings PUT."""

    def patch_key(self, body):
        return self.call("PATCH", "/_reach/keys/" + self.key["id"],
                         {"Content-Type": "application/json"},
                         body=json.dumps(body).encode())

    def test_caps_can_be_set_and_cleared(self):
        status, _b = self.patch_key({"rate_limit_rpm": 30, "tokens_day": 5000,
                                     "expires_at": stamp(86400)})
        self.assertEqual(status, 200)
        self.assertEqual(self.key["rate_limit_rpm"], 30)
        self.assertEqual(self.key["tokens_day"], 5000)
        self.assertTrue(self.key["expires_at"])
        self.assertEqual(self.patch_key({"expires_at": None})[0], 200)
        self.assertIsNone(self.key["expires_at"])

    def test_a_bad_number_is_refused_not_coerced(self):
        status, body = self.patch_key({"rate_limit_rpm": "lots"})
        self.assertEqual(status, 400)
        self.assertIn("whole number", json.loads(body)["error"]["message"])
        self.assertEqual(self.key["rate_limit_rpm"], 0)

    def test_the_response_never_carries_the_raw_token(self):
        _s, body = self.patch_key({"rate_limit_rpm": 5})
        self.assertNotIn(self.key["key"], body.decode())
