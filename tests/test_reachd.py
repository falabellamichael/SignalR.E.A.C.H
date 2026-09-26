#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Tests for the SignalR.E.A.C.H relay server (stdlib-only, unittest).

Run:  python -m unittest tests.test_reachd -v
  or: python tests/test_reachd.py
"""

import io
import json
import os
import sys
import tempfile
import time
import unittest
from unittest.mock import MagicMock, patch
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "server"))

import reachd  # noqa: E402


class SettingsTests(unittest.TestCase):
    def test_defaults_validate(self):
        cfg = json.loads(json.dumps(reachd.DEFAULT_SETTINGS))
        reachd.validate_settings(cfg)  # must not raise

    def test_unknown_key_rejected(self):
        cfg = json.loads(json.dumps(reachd.DEFAULT_SETTINGS))
        cfg["bogus"] = 1
        with self.assertRaises(reachd.SettingsError):
            reachd.validate_settings(cfg)

    def test_model_alias_rules(self):
        cfg = json.loads(json.dumps(reachd.DEFAULT_SETTINGS))
        cfg["models"]["bad alias!"] = {"upstream": "x/y", "enabled": True}
        with self.assertRaises(reachd.SettingsError):
            reachd.validate_settings(cfg)

    def test_rate_limit_ranges(self):
        cfg = json.loads(json.dumps(reachd.DEFAULT_SETTINGS))
        cfg["rate_limits"]["per_ip_rpm"] = 0
        with self.assertRaises(reachd.SettingsError):
            reachd.validate_settings(cfg)
        cfg["rate_limits"]["per_ip_rpm"] = 10001
        with self.assertRaises(reachd.SettingsError):
            reachd.validate_settings(cfg)

    def test_access_key_min_length_when_required(self):
        cfg = json.loads(json.dumps(reachd.DEFAULT_SETTINGS))
        cfg["access"]["key_required"] = True
        cfg["access"]["access_key"] = "abc"
        with self.assertRaises(reachd.SettingsError):
            reachd.validate_settings(cfg)

    def test_public_url_override_must_be_https(self):
        cfg = json.loads(json.dumps(reachd.DEFAULT_SETTINGS))
        cfg["public_url_override"] = "http://insecure.example"
        with self.assertRaises(reachd.SettingsError):
            reachd.validate_settings(cfg)

    def test_breaker_reopens_after_cooldown_without_a_success(self):
        # A breaker must re-trip after its cool-down even when the upstream
        # never recovers. Pre-fix, note_failure() zeroed the counter as it
        # opened the circuit, so the next failures started from zero and a
        # permanently-dead upstream could fail forever without ever
        # re-opening. Only note_success() should clear the counter.
        state = reachd.RelayState(json.loads(json.dumps(reachd.DEFAULT_SETTINGS)),
                                 Path("/dev/null"))
        for _ in range(state.cfg["circuit_threshold"]):
            state.note_failure("bridge")
        self.assertTrue(state.circuit_open("bridge"))
        # Simulate the cool-down elapsing.
        state._circuits["bridge"]["open_until"] = time.time() - 1
        self.assertFalse(state.circuit_open("bridge"))
        # One more failure must re-open it immediately (counter never reset).
        state.note_failure("bridge")
        self.assertTrue(state.circuit_open("bridge"))

    def test_success_clears_the_breaker(self):
        state = reachd.RelayState(json.loads(json.dumps(reachd.DEFAULT_SETTINGS)),
                                 Path("/dev/null"))
        for _ in range(state.cfg["circuit_threshold"]):
            state.note_failure("bridge")
        self.assertTrue(state.circuit_open("bridge"))
        state.note_success("bridge")
        self.assertFalse(state.circuit_open("bridge"))

    def test_stream_timeout_validated(self):
        cfg = json.loads(json.dumps(reachd.DEFAULT_SETTINGS))
        cfg["stream_timeout_s"] = 5
        with self.assertRaises(reachd.SettingsError):
            reachd.validate_settings(cfg)
        cfg["stream_timeout_s"] = 300
        reachd.validate_settings(cfg)  # must not raise

    def test_model_spec_fallback_must_exist(self):
        cfg = json.loads(json.dumps(reachd.DEFAULT_SETTINGS))
        cfg["models"]["gpt-4o"]["fallback"] = "does-not-exist"
        with self.assertRaises(reachd.SettingsError):
            reachd.validate_settings(cfg)

    def test_model_temperature_accepts_number_and_null(self):
        cfg = json.loads(json.dumps(reachd.DEFAULT_SETTINGS))
        cfg["models"]["gpt-4o"]["temperature"] = 0.7
        reachd.validate_settings(cfg)  # must not raise
        cfg["models"]["gpt-4o"]["temperature"] = None
        reachd.validate_settings(cfg)
        cfg["models"]["gpt-4o"]["temperature"] = "warm"
        with self.assertRaises(reachd.SettingsError):
            reachd.validate_settings(cfg)

    def test_model_spec_fallback_cannot_be_self(self):
        cfg = json.loads(json.dumps(reachd.DEFAULT_SETTINGS))
        cfg["models"]["gpt-4o"]["fallback"] = "gpt-4o"
        with self.assertRaises(reachd.SettingsError):
            reachd.validate_settings(cfg)

    def test_model_spec_unknown_key_rejected(self):
        cfg = json.loads(json.dumps(reachd.DEFAULT_SETTINGS))
        cfg["models"]["gpt-4o"]["bogus"] = 1
        with self.assertRaises(reachd.SettingsError):
            reachd.validate_settings(cfg)

    def test_model_rate_limit_ranges(self):
        cfg = json.loads(json.dumps(reachd.DEFAULT_SETTINGS))
        cfg["models"]["gpt-4o"]["rate_limits"]["rpm"] = 99999
        with self.assertRaises(reachd.SettingsError):
            reachd.validate_settings(cfg)

    def test_request_section_validation(self):
        cfg = json.loads(json.dumps(reachd.DEFAULT_SETTINGS))
        cfg["request"]["blocked_fields"] = [123]
        with self.assertRaises(reachd.SettingsError):
            reachd.validate_settings(cfg)
        cfg["request"]["blocked_fields"] = ["temperature"]
        cfg["request"]["temperature_min"] = 2.0
        cfg["request"]["temperature_max"] = 1.0
        with self.assertRaises(reachd.SettingsError):
            reachd.validate_settings(cfg)

    def test_log_level_and_publish_interval(self):
        cfg = json.loads(json.dumps(reachd.DEFAULT_SETTINGS))
        cfg["data"]["log_level"] = "everything"
        with self.assertRaises(reachd.SettingsError):
            reachd.validate_settings(cfg)
        cfg["data"]["log_level"] = "verbose"
        cfg["publish"]["interval_min"] = 2000
        with self.assertRaises(reachd.SettingsError):
            reachd.validate_settings(cfg)


class GeminiBridgeAliasTests(unittest.TestCase):
    def test_web_ui_alias_stays_private_until_tray_sign_in_is_verified(self):
        spec = reachd.DEFAULT_SETTINGS["models"]["gemini-chat"]
        self.assertEqual(spec["upstream"], "bridge/gemini-chat")
        self.assertFalse(spec["enabled"])
        self.assertFalse(spec["public"])
        reachd.validate_settings(json.loads(json.dumps(reachd.DEFAULT_SETTINGS)))

    def test_saved_model_choices_survive_additive_default_merge(self):
        with tempfile.TemporaryDirectory() as td:
            path = Path(td) / "config.json"
            path.write_text(json.dumps({"models": {"gpt-4o": {
                "upstream": "codegpt/codegpt-gpt-4o"}}}), encoding="utf-8")
            self.assertFalse(reachd.load_config(path)["models"]["gemini-chat"]["enabled"])

            path.write_text(json.dumps({"models": {"gemini-chat": {
                "upstream": "bridge/gemini-chat", "enabled": True, "public": True}}}),
                encoding="utf-8")
            saved = reachd.load_config(path)["models"]["gemini-chat"]
            self.assertTrue(saved["enabled"])
            self.assertTrue(saved["public"])

            path.write_text(json.dumps({"models": {},
                "_removed_models": ["gemini-chat"]}), encoding="utf-8")
            self.assertNotIn("gemini-chat", reachd.load_config(path)["models"])


class CodegptEconomyTests(unittest.TestCase):
    """The endpoint's CodeGPT economy aliases.

    CodeGPT only serves its unlimited ("economy") tier through a signed-in
    session, and its public API rejects those model ids outright, so every
    economy alias must be pinned to the local tray bridge instead of OmniRoute.
    """

    def test_economy_aliases_are_public_and_pinned_to_the_bridge(self):
        models = reachd.DEFAULT_SETTINGS["models"]
        bridged = 0
        for alias, label in reachd.CODEGPT_ECONOMY_MODELS:
            spec = models.get(alias)
            self.assertIsNotNone(spec, alias + " alias missing")
            upstream = spec["upstream"]
            if not upstream.startswith("bridge/"):
                # An alias that already exists keeps its own route; only
                # gemini-3.7-flash is in that position today.
                continue
            bridged += 1
            self.assertEqual(upstream, "bridge/codegpt-eco-" + alias)
            self.assertTrue(spec["enabled"], alias + " must be enabled")
            self.assertTrue(spec["public"], alias + " must be listed in /v1/models")
            self.assertIn(label, spec["description"])
        self.assertGreaterEqual(bridged, 1, "no economy alias reached the bridge")

    def test_economy_merge_never_repoints_an_existing_alias(self):
        """gemini-3.7-flash was routed through OmniRoute before this work; the
        economy defaults must not silently steal the name."""
        spec = reachd.DEFAULT_SETTINGS["models"]["gemini-3.7-flash"]
        self.assertEqual(spec["upstream"], "gemini/gemini-3.7-flash")
        self.assertEqual(spec["min_output_tokens"], 1024)

    def test_bridge_url_must_stay_local(self):
        cfg = json.loads(json.dumps(reachd.DEFAULT_SETTINGS))
        reachd.validate_settings(cfg)  # loopback default is fine
        cfg["bridge_url"] = "https://public.example/v1"
        with self.assertRaises(reachd.SettingsError):
            reachd.validate_settings(cfg)

    def test_economy_upstream_prefix_survives_alias_validation(self):
        # A "bridge/..." upstream must pass UPSTREAM_PATTERN; if the pattern ever
        # tightens, the economy aliases would silently fail validation.
        cfg = json.loads(json.dumps(reachd.DEFAULT_SETTINGS))
        cfg["models"]["ox-alpha"]["upstream"] = "bridge/codegpt-eco-ox-alpha"
        reachd.validate_settings(cfg)

    def test_bridge_aliases_never_carry_the_omniroute_key(self):
        """The tray bridge authenticates through its own signed-in session, so a
        bridge route must not inherit the OmniRoute bearer token."""
        source = (Path(__file__).resolve().parents[1]
                  / "server" / "reachd" / "chat.py").read_text(encoding="utf-8")
        self.assertIn('use_bridge = upstream_model.startswith("bridge/")', source)
        self.assertIn('if not use_bridge and not core.STATE.key:', source)
        self.assertIn('if not use_bridge:\n            auth_headers["Authorization"]', source)


class MergeTests(unittest.TestCase):
    def test_scalar_replace(self):
        cfg = reachd.merged_settings(reachd.DEFAULT_SETTINGS, {"port": 20888})
        self.assertEqual(cfg["port"], 20888)

    def test_section_shallow_merge(self):
        cfg = reachd.merged_settings(reachd.DEFAULT_SETTINGS,
                                     {"rate_limits": {"per_ip_rpm": 99}})
        self.assertEqual(cfg["rate_limits"]["per_ip_rpm"], 99)
        self.assertEqual(cfg["rate_limits"]["burst"],
                         reachd.DEFAULT_SETTINGS["rate_limits"]["burst"])

    def test_model_alias_partial_update_keeps_siblings(self):
        cfg = reachd.merged_settings(reachd.DEFAULT_SETTINGS,
                                     {"models": {"gpt-4o": {"enabled": False}}})
        self.assertFalse(cfg["models"]["gpt-4o"]["enabled"])
        self.assertIn("gpt-4o-mini", cfg["models"])

    def test_model_alias_null_removes(self):
        cfg = reachd.merged_settings(reachd.DEFAULT_SETTINGS,
                                     {"models": {"gpt-4o-mini": None}})
        self.assertNotIn("gpt-4o-mini", cfg["models"])
        self.assertIn("gpt-4o", cfg["models"])

    def test_model_alias_partial_spec_fills_defaults(self):
        cfg = reachd.merged_settings(reachd.DEFAULT_SETTINGS,
                                     {"models": {"gpt-4o": {"temperature": 0.5}}})
        spec = cfg["models"]["gpt-4o"]
        self.assertEqual(spec["temperature"], 0.5)
        self.assertEqual(spec["max_tokens_cap"],
                         reachd.MODEL_SPEC_DEFAULTS["max_tokens_cap"])
        self.assertEqual(spec["upstream"],
                         reachd.DEFAULT_SETTINGS["models"]["gpt-4o"]["upstream"])


class AnalyticsTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.db = Path(self.tmp.name) / "reach.db"
        self.analytics = reachd.Analytics(self.db)

    def tearDown(self):
        self.tmp.cleanup()

    def _log(self, **kwargs):
        defaults = dict(model="gpt-4o", upstream_model="codegpt/codegpt-gpt-4o",
                        ip="127.0.0.1", user_agent="test", status=200,
                        error=None, latency_ms=100, tokens_in=50,
                        tokens_out=25, stream=False)
        defaults.update(kwargs)
        self.analytics.log_request(**defaults)

    def test_log_and_stats_roundtrip(self):
        """Regression: SUM(tokens_out) aliased AS `to` was a SQLite syntax
        error ('near "to"') that left stats.today empty. The alias is now
        `tout` — this test fails loudly if stats() silently swallows errors."""
        self._log(tokens_in=10, tokens_out=5)
        self._log(tokens_in=20, tokens_out=8, status=429, error="rate_limited:x")
        stats = self.analytics.stats()
        today = stats["today"]
        self.assertEqual(today["requests"], 2)
        self.assertEqual(today["tokens_in"], 30)
        self.assertEqual(today["tokens_out"], 13)
        self.assertEqual(today["errors"], 1)
        self.assertEqual(today["rate_limited"], 1)
        self.assertEqual(stats["by_model"][0]["model"], "gpt-4o")
        self.assertEqual(stats["by_model"][0]["tokens_out"], 13)
        self.assertEqual(stats["top_clients"][0]["ip"], "127.0.0.1")
        self.assertEqual(len(stats["hourly"]), 1)

    def test_logs_filter_and_clear(self):
        self._log(model="gpt-4o", status=200)
        self._log(model="gpt-4o-mini", status=429)
        self.assertEqual(len(self.analytics.logs(status="4*")), 1)
        self.assertEqual(len(self.analytics.logs(model="gpt-4o-mini")), 1)
        self.analytics.clear()
        self.assertEqual(len(self.analytics.logs()), 0)

    def test_daily_token_counter(self):
        total = self.analytics.add_tokens("1.2.3.4", 100)
        self.assertEqual(total, 100)
        total = self.analytics.add_tokens("1.2.3.4", 50)
        self.assertEqual(total, 150)
        self.assertEqual(self.analytics.tokens_today("1.2.3.4"), 150)

    def test_log_detail_returns_bodies_and_404s_cleanly(self):
        self._log(request_body='{"model": "gpt-4o"}',
                  response_body='{"choices": []}', cached=True)
        rows = self.analytics.logs(limit=1)
        self.assertEqual(len(rows), 1)
        log_id = rows[0]["id"]
        # the list view never carries bodies…
        self.assertNotIn("request_body", rows[0])
        # …but the detail view does.
        detail = self.analytics.log_detail(log_id)
        self.assertIsNotNone(detail)
        self.assertEqual(detail["request_body"], '{"model": "gpt-4o"}')
        self.assertEqual(detail["response_body"], '{"choices": []}')
        self.assertEqual(detail["cached"], 1)
        self.assertIsNone(self.analytics.log_detail(999999))
        self.assertIsNone(self.analytics.log_detail("not-an-id"))

    def test_audit_trail_records_and_lists(self):
        self.assertTrue(self.analytics.log_audit(
            "logs.purge", "local-admin", ""))
        self.assertTrue(self.analytics.log_audit(
            "cache.flush", "remote-admin-token", "entries=3"))
        events = self.analytics.audit_events(limit=10)
        self.assertEqual(len(events), 2)
        # newest first
        self.assertEqual(events[0]["action"], "cache.flush")
        self.assertEqual(events[0]["actor"], "remote-admin-token")
        self.assertEqual(events[0]["detail"], "entries=3")
        self.assertEqual(events[1]["action"], "logs.purge")
        self.assertTrue(events[1]["ts"])
        # over-long fields are bounded, not rejected
        self.analytics.log_audit("x" * 500, "y" * 500, "z" * 5000)
        bounded = self.analytics.audit_events(limit=1)[0]
        self.assertLessEqual(len(bounded["action"]), 64)
        self.assertLessEqual(len(bounded["actor"]), 64)
        self.assertLessEqual(len(bounded["detail"]), 500)

    def test_audit_limit_is_clamped(self):
        for i in range(5):
            self.analytics.log_audit("test.%d" % i, "local-admin")
        self.assertEqual(len(self.analytics.audit_events(limit=2)), 2)
        # a bogus limit clamps to 1 (never a full dump, never an error)
        self.assertEqual(len(self.analytics.audit_events(limit=0)), 1)
        self.assertEqual(len(self.analytics.audit_events(limit=9999)), 5)


class RateLimiterTests(unittest.TestCase):
    def test_bucket_allows_then_blocks(self):
        limiter = reachd.RateLimiter()
        settings = json.loads(json.dumps(reachd.DEFAULT_SETTINGS))
        settings["rate_limits"] = {"enabled": True, "per_ip_rpm": 60,
                                   "per_ip_tokens_day": 0, "global_rpm": 60,
                                   "burst": 2}
        ok = 0
        for _ in range(62):
            allowed, headers, _reason = limiter.check("9.9.9.9", settings)
            if allowed:
                ok += 1
                self.assertIn("X-RateLimit-Limit", headers)
        self.assertEqual(ok, 62)  # 60 rpm + burst 2

    def test_disabled_limits_pass(self):
        limiter = reachd.RateLimiter()
        settings = json.loads(json.dumps(reachd.DEFAULT_SETTINGS))
        settings["rate_limits"]["enabled"] = False
        for _ in range(1000):
            allowed, _h, _r = limiter.check("9.9.9.9", settings)
            self.assertTrue(allowed)

    def test_per_model_bucket_independent(self):
        limiter = reachd.RateLimiter()
        settings = json.loads(json.dumps(reachd.DEFAULT_SETTINGS))
        settings["rate_limits"]["per_ip_rpm"] = 1000   # global plenty
        settings["rate_limits"]["burst"] = 0
        settings["models"]["gpt-4o"]["rate_limits"]["rpm"] = 2
        ok = 0
        for _ in range(4):
            allowed, _h, reason = limiter.check("1.1.1.1", settings, model="gpt-4o")
            if allowed:
                ok += 1
            else:
                self.assertEqual(reason, "model_rpm")
        self.assertEqual(ok, 2)

    def _rl_settings(self):
        settings = json.loads(json.dumps(reachd.DEFAULT_SETTINGS))
        settings["rate_limits"] = {"enabled": True, "per_ip_rpm": 60,
                                   "global_rpm": 10000, "burst": 0}
        return settings

    def test_eviction_drops_stale_not_active(self):
        """A full table trims only idle buckets: an active user's credit must
        survive a table-full eviction (the old code wiped everyone)."""
        limiter = reachd.RateLimiter()
        cap = reachd.MAX_RATE_BUCKETS
        now = time.time()
        # cap stale buckets + 3 hot buckets => over the cap.
        for i in range(cap):
            limiter._buckets["stale-%d" % i] = {"tokens": 30.0,
                                                "updated": now - 2000.0}
        for i in range(3):
            limiter._buckets["hot-%d" % i] = {"tokens": 30.0, "updated": now - 1.0}
        self.assertEqual(len(limiter._buckets), cap + 3)

        allowed, _h, _r = limiter.check("new.ip", self._rl_settings())

        self.assertTrue(allowed)
        # All stale buckets gone; the 3 hot ones preserved (credit intact, not
        # reset to full capacity); plus the fresh new.ip bucket.
        self.assertEqual(len(limiter._buckets), 4)
        for i in range(3):
            self.assertAlmostEqual(limiter._buckets["hot-%d" % i]["tokens"], 30.0)
        # new.ip is brand new: a full fresh burst (60) minus the one request
        # check() just consumed.
        self.assertAlmostEqual(limiter._buckets["new.ip"]["tokens"], 59.0)

    def test_eviction_keeps_hottest_when_all_hot(self):
        """When the table is over cap and NO bucket is stale, only the oldest
        are dropped; recently-active users keep their partial credit."""
        limiter = reachd.RateLimiter()
        cap = reachd.MAX_RATE_BUCKETS
        now = time.time()
        total = cap + 5
        # ip-0 is oldest ... ip-(total-1) is newest; all partial (30/60). The
        # 0.01s spread keeps every bucket within STALE_BUCKET_S (600s) so none
        # is treated as idle — this exercises the "drop oldest" path, not the
        # "drop stale" path.
        for i in range(total):
            limiter._buckets["ip-%d" % i] = {"tokens": 30.0,
                                             "updated": now - (total - 1 - i) * 0.01}
        self.assertEqual(len(limiter._buckets), total)

        limiter.check("new.ip", self._rl_settings())

        # 5 oldest evicted, the newest survive, new.ip added.
        self.assertEqual(len(limiter._buckets), cap + 1)
        for i in range(5):
            self.assertNotIn("ip-%d" % i, limiter._buckets)
        self.assertIn("ip-%d" % (total - 1), limiter._buckets)
        # A survivor was NOT reset to full capacity (old clear() would reset).
        self.assertAlmostEqual(limiter._buckets["ip-%d" % (total - 1)]["tokens"], 30.0)


class ScrubberTests(unittest.TestCase):
    def test_truncates_at_user_continuation(self):
        content = "The answer is Paris.\n\nUser: what about London?"
        self.assertEqual(reachd.scrub_trailing_roles(content),
                         "The answer is Paris.")

    def test_truncates_at_human_and_assistant(self):
        for marker in ("Human:", "Assistant:", "system:", "Anthropic:"):
            content = "Here is the answer.\n" + marker + " continue"
            self.assertEqual(reachd.scrub_trailing_roles(content),
                             "Here is the answer.")

    def test_leaves_mid_text_mentions(self):
        content = "I asked: what do you think?\nIt was about user: experience."
        self.assertEqual(reachd.scrub_trailing_roles(content), content)

    def test_leaves_short_and_clean_content(self):
        self.assertEqual(reachd.scrub_trailing_roles("OK"), "OK")
        self.assertEqual(reachd.scrub_trailing_roles(""), "")
        clean = "A perfectly normal answer with no continuation."
        self.assertEqual(reachd.scrub_trailing_roles(clean), clean)

    def test_scrub_role_continuation_detection(self):
        # Match detection
        cut = reachd.scrub_trailing_roles("Hello\n\nUser: How are you?")
        self.assertEqual(cut, "Hello")

        # Safe normal text
        self.assertEqual(
            reachd.scrub_trailing_roles("Hello\n1. User accounts"),
            "Hello\n1. User accounts")
        self.assertEqual(
            reachd.scrub_trailing_roles("Hello world!"), "Hello world!")

        # Other role markers truncate too
        self.assertEqual(
            reachd.scrub_trailing_roles("Hello there my friend\n\nHuman: what now?"),
            "Hello there my friend")



class ResponseCacheTests(unittest.TestCase):
    def test_lru_and_ttl(self):
        cache = reachd.ResponseCache()
        cache.put("a", b"1", ttl_s=60, max_entries=2)
        cache.put("b", b"2", ttl_s=60, max_entries=2)
        cache.put("c", b"3", ttl_s=60, max_entries=2)   # evicts "a"
        self.assertIsNone(cache.get("a"))
        self.assertEqual(cache.get("b"), b"2")
        self.assertEqual(cache.get("c"), b"3")
        self.assertEqual(cache.snapshot()["entries"], 2)

    def test_expiry(self):
        cache = reachd.ResponseCache()
        with patch("reachd.cache.time.time", return_value=1000):
            cache.put("a", b"1", ttl_s=0, max_entries=10)
            self.assertIsNone(cache.get("a"))

    def test_cache_key_deterministic_and_temperature_aware(self):
        payload = {"model": "gpt-4o",
                   "messages": [{"role": "user", "content": "hi"}],
                   "temperature": 0.7}
        cache_cfg = {"match_temperature": True}
        key1 = reachd.RelayHandler._cache_key(payload, cache_cfg)
        payload["temperature"] = 0.2
        key2 = reachd.RelayHandler._cache_key(payload, cache_cfg)
        self.assertNotEqual(key1, key2)
        cache_cfg = {"match_temperature": False}
        key3 = reachd.RelayHandler._cache_key(payload, cache_cfg)
        payload["temperature"] = 0.9
        key4 = reachd.RelayHandler._cache_key(payload, cache_cfg)
        self.assertEqual(key3, key4)


class ClientKeyManagementTests(unittest.TestCase):
    def test_generate_client_key_format(self):
        k = reachd.generate_client_key("WhiteShadow")
        self.assertEqual(k["name"], "WhiteShadow")
        self.assertTrue(k["key"].startswith("sk-reach-"))
        self.assertTrue(k["id"].startswith("key_"))
        self.assertTrue(k["enabled"])
        self.assertIn("created_at", k)
        self.assertIsNone(k["last_used_at"])

    def test_validate_keys_array(self):
        cfg = json.loads(json.dumps(reachd.DEFAULT_SETTINGS))
        cfg["access"]["keys"] = [reachd.generate_client_key("Test")]
        reachd.validate_settings(cfg)

        cfg["access"]["keys"] = "not a list"
        with self.assertRaises(reachd.SettingsError):
            reachd.validate_settings(cfg)

        cfg["access"]["keys"] = [{"id": "bad"}]  # missing key
        with self.assertRaises(reachd.SettingsError):
            reachd.validate_settings(cfg)

    def test_key_required_validates_presence(self):
        cfg = json.loads(json.dumps(reachd.DEFAULT_SETTINGS))
        cfg["access"]["key_required"] = True
        cfg["access"]["keys"] = []
        cfg["access"]["access_key"] = ""
        with self.assertRaises(reachd.SettingsError):
            reachd.validate_settings(cfg)

        cfg["access"]["keys"] = [reachd.generate_client_key("Valid")]
        reachd.validate_settings(cfg)  # passes with valid key

    def test_mask_key(self):
        self.assertEqual(reachd.mask_key(""), "(none)")
        self.assertEqual(reachd.mask_key("short"), "set (short)")
        masked = reachd.mask_key("sk-reach-" + "a" * 32)
        self.assertEqual(masked, "sk-reach-…", "sk-reach keys mask to prefix only")
        self.assertNotIn("aaaa", masked)
        # generic (legacy) keys keep first/last chars
        gen = reachd.mask_key("legacy-secret-123")
        self.assertTrue(gen.startswith("legacy-s"))
        self.assertTrue(gen.endswith("-123"))
        # preview never leaks secret characters
        self.assertEqual(reachd.key_preview("sk-reach-" + "b" * 32), "sk-reach-…")
        self.assertNotIn("bbbb", reachd.key_preview("sk-reach-" + "b" * 32))

    def test_load_config_generates_default_key_and_migrates_legacy(self):
        with tempfile.TemporaryDirectory() as td:
            cfg_path = Path(td) / "config.json"
            cfg_path.write_text(json.dumps({"access": {"access_key": "legacy-secret-123"}}), encoding="utf-8")
            cfg = reachd.load_config(cfg_path)
            keys = cfg.get("access", {}).get("keys", [])
            self.assertTrue(len(keys) >= 1)
            self.assertTrue(any(k.get("key") == "legacy-secret-123" for k in keys))

    def test_analytics_records_key_name(self):
        with tempfile.TemporaryDirectory() as td:
            db_path = Path(td) / "reach.db"
            an = reachd.Analytics(db_path)
            an.log_request(model="gpt-4o", status=200, latency_ms=45, key_name="WhiteShadow")
            logs = an.logs(limit=10)
            self.assertEqual(len(logs), 1)
            self.assertEqual(logs[0]["key_name"], "WhiteShadow")

    def test_settings_put_restores_masked_keys(self):
        """A full settings PUT carrying masked key strings must not clobber the
        raw client keys (the panel saves the whole draft, masked)."""
        raw_key = reachd.generate_client_key("WhiteShadow")["key"]
        cfg = json.loads(json.dumps(reachd.DEFAULT_SETTINGS))
        cfg["access"]["keys"] = [{"id": "key_1", "name": "WhiteShadow",
                                  "key": raw_key, "created_at": "x",
                                  "last_used_at": None, "enabled": True,
                                  "rate_limit_rpm": 0}]
        masked = json.loads(json.dumps(reachd.settings_public(cfg)))
        # simulate the handler flow: guard runs BEFORE merged_settings
        patch = {"access": {"keys": masked["access"]["keys"]}}
        touched = reachd.restore_masked_client_keys(
            cfg["access"], patch["access"])
        self.assertTrue(touched)
        next_cfg = reachd.merged_settings(cfg, patch)
        reachd.validate_settings(next_cfg)
        restored = next_cfg["access"]["keys"][0]["key"]
        self.assertEqual(restored, raw_key, "raw key must survive the masked round-trip")

    def test_restore_masked_keys_leaves_raw_keys_untouched(self):
        raw_key = reachd.generate_client_key("Kept")["key"]
        cfg = json.loads(json.dumps(reachd.DEFAULT_SETTINGS))
        cfg["access"]["keys"] = [{"id": "key_a", "name": "Kept", "key": raw_key,
                                  "created_at": "x", "last_used_at": None,
                                  "enabled": True, "rate_limit_rpm": 0}]
        patch = {"access": {"keys": [{"id": "key_a", "name": "Kept", "key": raw_key}]}}
        touched = reachd.restore_masked_client_keys(
            cfg["access"], patch["access"])
        self.assertFalse(touched)
        self.assertEqual(patch["access"]["keys"][0]["key"], raw_key)


class AdminGateTests(unittest.TestCase):
    """The advisory GHSA-m439-vg8j-pf3x fixes: admin gate, IP derivation,
    upstream-host validation, key redaction."""

    @staticmethod
    def _fake(headers=None, peer="127.0.0.1"):
        # Borrow the real methods under test; supply just the request attrs
        # they read. (Same unbound-method pattern as the _cache_key tests.)
        class _FakeH:
            _is_loopback = reachd.RelayHandler._is_loopback
            _admin_local = reachd.RelayHandler._admin_local
            _client_ip = reachd.RelayHandler._client_ip
        h = _FakeH()
        h.headers = headers or {}
        h.client_address = (peer, 12345)
        return h

    # ---- F1: admin gate no longer trusts peer address alone ----
    def test_admin_local_true_for_bare_loopback(self):
        self.assertTrue(self._fake()._admin_local())

    def test_admin_local_false_when_forwarded(self):
        # ngrok/cloudflared inject these; a tunneled request also arrives from
        # 127.0.0.1 but must NOT qualify as a local admin client.
        for hdr in ("X-Forwarded-For", "X-Forwarded-Proto", "Forwarded",
                    "Cf-Connecting-Ip"):
            self.assertFalse(self._fake({hdr: "1.2.3.4"})._admin_local(),
                             "%s should disqualify local admin" % hdr)

    def test_admin_local_false_for_remote_peer(self):
        self.assertFalse(self._fake(peer="203.0.113.9")._admin_local())

    def test_admin_token_roundtrips_and_bounds(self):
        tok = reachd.generate_admin_token()
        self.assertTrue(tok.startswith("rt-"))
        cfg = json.loads(json.dumps(reachd.DEFAULT_SETTINGS))
        cfg["system"]["admin_token"] = tok
        reachd.validate_settings(cfg)  # must not raise
        cfg["system"]["admin_token"] = "x" * 200
        with self.assertRaises(reachd.SettingsError):
            reachd.validate_settings(cfg)

    # ---- F4: real client IP is the proxy-added value, not attacker's first XFF ----
    def test_client_ip_takes_last_xff_not_spoofed_first(self):
        h = self._fake({"X-Forwarded-For": "1.1.1.1, 203.0.113.9"})
        self.assertEqual(h._client_ip(), "203.0.113.9")

    def test_client_ip_prefers_proxy_appended_xff_over_caller_cf_header(self):
        # ngrok appends the actual peer to XFF but may preserve a caller's CF
        # header. That caller-controlled header cannot select a rate bucket.
        h = self._fake({"Cf-Connecting-Ip": "1.1.1.1",
                        "X-Forwarded-For": "2.2.2.2, 203.0.113.9"})
        self.assertEqual(h._client_ip(), "203.0.113.9")

    def test_ip_in_list_cidr_and_exact(self):
        from reachd.handler import _ip_in_list
        self.assertTrue(_ip_in_list("10.1.2.3", ["10.0.0.0/8"]))
        self.assertFalse(_ip_in_list("11.1.2.3", ["10.0.0.0/8"]))
        self.assertTrue(_ip_in_list("203.0.113.9", ["203.0.113.9"]))
        # a differently-formatted but equal address still matches
        self.assertTrue(_ip_in_list("203.0.113.009".replace("009", "9"),
                                    ["203.0.113.9"]))

    # ---- F3: upstream host must be local/private, never public ----
    def test_omniroute_url_rejects_public_host(self):
        cfg = json.loads(json.dumps(reachd.DEFAULT_SETTINGS))
        cfg["omniroute_url"] = "http://8.8.8.8/v1"   # public IP literal, no DNS
        with self.assertRaises(reachd.SettingsError):
            reachd.validate_settings(cfg)

    def test_omniroute_url_allows_loopback_and_private(self):
        for url in ("http://127.0.0.1:20128/v1", "http://192.168.1.5/v1",
                    "http://localhost:20128/v1"):
            cfg = json.loads(json.dumps(reachd.DEFAULT_SETTINGS))
            cfg["omniroute_url"] = url
            reachd.validate_settings(cfg)  # must not raise

    def test_omniroute_url_rejects_non_http_scheme(self):
        cfg = json.loads(json.dumps(reachd.DEFAULT_SETTINGS))
        cfg["omniroute_url"] = "file:///etc/passwd"
        with self.assertRaises(reachd.SettingsError):
            reachd.validate_settings(cfg)

    # ---- F2: key views never carry the raw token ----
    def test_public_key_view_has_no_raw_token(self):
        k = reachd.generate_client_key("Legacy")
        view = reachd.public_key_view(k)
        self.assertNotEqual(view["key"], k["key"])
        self.assertEqual(view["key"], view["masked_key"])
        self.assertNotIn(k["key"], json.dumps(view))

    def test_settings_public_masks_admin_token(self):
        cfg = json.loads(json.dumps(reachd.DEFAULT_SETTINGS))
        cfg["system"]["admin_token"] = reachd.generate_admin_token()
        shown = reachd.settings_public(cfg)
        self.assertEqual(shown["system"]["admin_token"], "set")
        self.assertNotIn(cfg["system"]["admin_token"], json.dumps(shown))


class ConcurrencyGateTests(unittest.TestCase):
    def test_gate_acquire_and_release(self):
        gate = reachd.CounterGate()
        self.assertTrue(gate.acquire(2, timeout_s=0.1))
        self.assertTrue(gate.acquire(2, timeout_s=0.1))
        self.assertFalse(gate.acquire(2, timeout_s=0.1))
        gate.release()
        self.assertTrue(gate.acquire(2, timeout_s=0.1))
        gate.release()
        gate.release()
        self.assertEqual(gate._active, 0)

    def test_streaming_upstream_failure_releases_gate(self):
        from unittest.mock import MagicMock, patch
        from reachd import core
        from reachd.state import RelayState
        from reachd.chat import chat_execute
        import io

        with tempfile.NamedTemporaryFile() as tf:
            state = RelayState(json.loads(json.dumps(reachd.DEFAULT_SETTINGS)), Path(tf.name))
        state.cfg["models"]["gpt-4o"]["enabled"] = True

        h = MagicMock()
        h._client_ip.return_value = "127.0.0.1"
        # No per-key caps: the handler reports this as (bucket, rpm, tokens).
        h.key_limits.return_value = (None, 0, 0)
        raw_bytes = json.dumps({
            "model": "gpt-4o",
            "messages": [{"role": "user", "content": "hi"}],
            "stream": True,
        }).encode("utf-8")
        h._read_body.return_value = raw_bytes
        h.rfile = io.BytesIO(raw_bytes)
        h.headers = {"Content-Length": str(len(raw_bytes))}
        h._check_access.return_value = True

        with patch.object(core, "STATE", state):
            initial_active = state.gate._active
            with patch("urllib.request.urlopen", side_effect=OSError("connection refused")):
                res = chat_execute(h)
                self.assertIsNone(res)

            # Gate slot MUST be released even on streaming request failure
            self.assertEqual(state.gate._active, initial_active)




class StreamPreflightTests(unittest.TestCase):
    """An SSE error or empty reply must not be committed as a successful 200."""

    @staticmethod
    def _stream(*events):
        source = io.BytesIO(b"".join(
            b"data: " + (event if isinstance(event, bytes) else json.dumps(event).encode())
            + b"\n\n" for event in events))
        source.headers = {"Content-Type": "text/event-stream"}
        return source

    def _finalize(self, source, *, upstream_model="bridge/codegpt-eco-test",
                  fallback=None, urlopen=None, strip_roles=False):
        from reachd import core
        from reachd.chat import chat_finalize

        state = MagicMock()
        state.cfg = {"stream_timeout_s": 300, "data": {}}
        state.bridge_url = "http://127.0.0.1:21302/v1"
        state.omniroute_url = "http://127.0.0.1:20128/v1"
        state.key = "test-key"
        h = MagicMock()
        h.headers = {}
        h.key_limits.return_value = (None, 0, 0)
        ctx = {
            "started": time.time(), "ip": "127.0.0.1",
            "rl_headers": {"X-RateLimit-Limit": "12"},
            "requested": "test", "upstream_model": upstream_model,
            "spec": {**({"fallback": "backup"} if fallback else {}),
                     **({"strip_trailing_roles": True} if strip_roles else {})},
            "stream": True, "total_chars": 4, "request_body": None,
            "fallback_used": False, "cache_cfg": {}, "cache_key": None,
            "url": "", "payload": {"messages": [{"role": "user", "content": "hi"}]},
            "models": {"backup": fallback} if fallback else {},
        }
        with patch.object(core, "STATE", state):
            if urlopen:
                with patch("urllib.request.urlopen", side_effect=urlopen):
                    chat_finalize(h, source, ctx)
            else:
                chat_finalize(h, source, ctx)
        return h, state

    def test_bridge_sse_error_preserves_429_without_empty_success(self):
        source = self._stream({"error": {
            "code": "ECONOMY_CONCURRENCY_LIMIT", "status": 429,
            "provider": "codegpt", "retryable": True,
            "retryAfterSeconds": 15, "message": "Another stream is running."}},
            b"[DONE]")
        h, state = self._finalize(source)
        h.send_response.assert_not_called()
        status, payload, headers = h._json.call_args.args
        self.assertEqual(status, 429)
        self.assertEqual(payload["error"]["code"], "ECONOMY_CONCURRENCY_LIMIT")
        self.assertEqual(payload["error"]["message"], "Another stream is running.")
        self.assertEqual(payload["error"]["provider"], "codegpt")
        self.assertEqual(headers["Retry-After"], "15")
        state.note_failure.assert_not_called()
        state.note_success.assert_not_called()
        state.gate.release.assert_called_once()
        self.assertTrue(source.closed)

    def test_reasoning_only_stream_is_502_and_does_not_clear_breaker(self):
        source = self._stream(
            {"choices": [{"delta": {"reasoning_content": "still thinking"}}]},
            b"[DONE]")
        h, state = self._finalize(source)
        self.assertEqual(h._json.call_args.args[0], 502)
        self.assertEqual(h._json.call_args.args[1]["error"]["code"],
                         "empty_upstream_response")
        state.note_failure.assert_called_once_with("bridge")
        state.note_success.assert_not_called()
        state.gate.release.assert_called_once()
        self.assertTrue(source.closed)

    def test_error_after_first_answer_is_forwarded_and_records_failure(self):
        source = self._stream(
            {"choices": [{"delta": {"content": "partial"}}]},
            {"error": {"code": "upstream_broken", "message": "Stream cut."}},
            b"[DONE]")
        h, state = self._finalize(source)
        self.assertEqual(h.send_response.call_args.args[0], 200)
        self.assertTrue(any(b'"error"' in call.args[0]
                            for call in h._write_chunk.call_args_list))
        self.assertFalse(any(b'"usage"' in call.args[0]
                             for call in h._write_chunk.call_args_list))
        self.assertEqual(h._log_chat.call_args.kwargs["status"], 502)
        state.note_failure.assert_called_once_with("bridge")
        state.note_success.assert_not_called()
        state.gate.release.assert_called_once()

    def test_capacity_error_after_first_token_logs_429_without_usage(self):
        source = self._stream(
            {"choices": [{"delta": {"content": "partial"}}]},
            {"error": {"code": "ECONOMY_CONCURRENCY_LIMIT", "status": 429,
                       "message": "Another session is running."}}, b"[DONE]")
        h, state = self._finalize(source)
        self.assertEqual(h.send_response.call_args.args[0], 200)
        self.assertEqual(h._log_chat.call_args.kwargs["status"], 429)
        self.assertFalse(any(b'"usage"' in call.args[0]
                             for call in h._write_chunk.call_args_list))
        state.note_failure.assert_not_called()
        state.note_success.assert_not_called()

    def test_strip_route_forwards_provider_refusal(self):
        source = self._stream(
            {"choices": [{"delta": {"refusal": "I cannot help with that."},
                          "finish_reason": "content_filter"}]}, b"[DONE]")
        h, state = self._finalize(source, strip_roles=True)
        self.assertEqual(h.send_response.call_args.args[0], 200)
        sent = b"".join(call.args[0] for call in h._write_chunk.call_args_list)
        self.assertIn(b'I cannot help with that.', sent)
        self.assertIn(b'content_filter', sent)
        self.assertNotIn(b'"usage"', sent)
        self.assertNotIn(b'"finish_reason": "stop"', sent)
        self.assertEqual(h._log_chat.call_args.kwargs["error"], "content_refused")
        state.note_failure.assert_not_called()
        state.note_success.assert_called_once_with("bridge")

    def test_tool_only_reply_is_forwarded_only_when_route_supports_it(self):
        event = {"choices": [{"delta": {"tool_calls": [{"index": 0,
            "function": {"name": "lookup", "arguments": "{}"}}]}}]}
        h, state = self._finalize(self._stream(event, b"[DONE]"))
        self.assertEqual(h.send_response.call_args.args[0], 200)
        state.note_success.assert_called_once_with("bridge")

        h, state = self._finalize(self._stream(event, b"[DONE]"), strip_roles=True)
        h.send_response.assert_not_called()
        self.assertEqual(h._json.call_args.args[0], 502)
        state.note_success.assert_not_called()

    def test_fallback_must_emit_answer_and_keeps_bridge_token_free(self):
        original = self._stream({"error": {"message": "Primary failed."}}, b"[DONE]")
        fallback = self._stream({"choices": [{"delta": {"content": "Recovered"}}]},
                                b"[DONE]")
        captured = []

        def open_fallback(req, timeout):
            captured.append(req)
            return fallback

        h, state = self._finalize(
            original, upstream_model="omniroute/test",
            fallback={"enabled": True, "upstream": "bridge/codegpt-eco-test"},
            urlopen=open_fallback)
        self.assertEqual(h.send_response.call_args.args[0], 200)
        self.assertTrue(any(b"Recovered" in call.args[0]
                            for call in h._write_chunk.call_args_list))
        self.assertIn("127.0.0.1:21302", captured[0].full_url)
        self.assertNotIn("Authorization", captured[0].headers)
        state.note_failure.assert_called_once_with("omniroute")
        state.note_success.assert_called_once_with("bridge")
        state.gate.release.assert_called_once()
        self.assertTrue(original.closed)
        self.assertTrue(fallback.closed)

    def test_json_fallback_to_stream_request_is_forwarded_as_sse(self):
        original = self._stream({"error": {"message": "Primary failed."}}, b"[DONE]")
        fallback = io.BytesIO(json.dumps({
            "choices": [{"message": {"role": "assistant", "content": "Recovered JSON"},
                         "finish_reason": "stop"}],
        }).encode())
        fallback.headers = {"Content-Type": "application/json"}
        h, state = self._finalize(
            original, fallback={"enabled": True, "upstream": "bridge/codegpt-eco-backup"},
            urlopen=lambda req, timeout: fallback)
        self.assertEqual(h.send_response.call_args.args[0], 200)
        self.assertIn(("Content-Type", "text/event-stream"),
                      [call.args for call in h.send_header.call_args_list])
        sent = b"".join(call.args[0] for call in h._write_chunk.call_args_list)
        self.assertIn(b'data: ', sent)
        self.assertIn(b'Recovered JSON', sent)
        self.assertNotIn(b'{"choices": [{"message"', sent)
        state.note_success.assert_called_once_with("bridge")
        state.gate.release.assert_called_once()

    def test_empty_fallback_does_not_turn_into_200(self):
        original = self._stream({"error": {"message": "Primary failed."}}, b"[DONE]")
        fallback = self._stream(b"[DONE]")
        h, state = self._finalize(
            original, fallback={"enabled": True, "upstream": "bridge/codegpt-eco-backup"},
            urlopen=lambda req, timeout: fallback)
        self.assertEqual(h._json.call_args.args[0], 502)
        h.send_response.assert_not_called()
        self.assertEqual(state.note_failure.call_count, 2)
        state.note_success.assert_not_called()
        state.gate.release.assert_called_once()
        self.assertTrue(original.closed)
        self.assertTrue(fallback.closed)

    def test_fallback_capacity_does_not_trip_its_circuit(self):
        original = self._stream({"error": {"message": "Primary failed."}}, b"[DONE]")
        fallback = self._stream({"error": {
            "code": "ECONOMY_CONCURRENCY_LIMIT", "status": 429,
            "message": "Another session is running."}}, b"[DONE]")
        h, state = self._finalize(
            original, upstream_model="omniroute/test",
            fallback={"enabled": True, "upstream": "bridge/codegpt-eco-backup"},
            urlopen=lambda req, timeout: fallback)
        self.assertEqual(h._json.call_args.args[0], 429)
        state.note_failure.assert_called_once_with("omniroute")
        state.note_success.assert_not_called()
        state.gate.release.assert_called_once()


class DiagnosticsRouteTests(unittest.TestCase):
    """PRD 'Test Public Endpoint Reachability': /_reach/diagnose probes the
    public pointer URL (TLS + headers + sample chat payload) and reports
    per-check results."""

    def _state_and_handler(self, public_url):
        from unittest.mock import MagicMock
        from reachd.state import RelayState
        from reachd.handler import RelayHandler

        with tempfile.NamedTemporaryFile() as tf:
            state = RelayState(json.loads(json.dumps(reachd.DEFAULT_SETTINGS)),
                               Path(tf.name))
        state.public_url = public_url
        h = MagicMock(spec=RelayHandler)
        h.handle_diagnose = RelayHandler.handle_diagnose.__get__(h)
        h._json = MagicMock()
        return state, h

    def test_diagnose_requires_public_url(self):
        from reachd import core
        state, h = self._state_and_handler(None)
        with patch.object(core, "STATE", state):
            h.handle_diagnose()
        status = h._json.call_args[0][0]
        self.assertEqual(status, 409)

    def test_diagnose_rejects_non_https(self):
        from reachd import core
        state, h = self._state_and_handler("http://example.ngrok.io")
        with patch.object(core, "STATE", state):
            h.handle_diagnose()
        self.assertEqual(h._json.call_args[0][0], 409)

    def test_diagnose_reports_connection_failure(self):
        from reachd import core
        state, h = self._state_and_handler("https://dead.example.test")
        with patch.object(core, "STATE", state):
            with patch("urllib.request.urlopen",
                       side_effect=OSError("connection refused")):
                h.handle_diagnose()
        status, payload = h._json.call_args[0]
        self.assertEqual(status, 502)
        self.assertFalse(payload["ok"])
        self.assertIn("connection refused", payload["error"])

    def test_diagnose_passes_on_healthy_endpoint(self):
        from reachd import core
        import io
        state, h = self._state_and_handler("https://live.example.test")

        health_body = json.dumps({"ok": True, "service": "signalreach",
                                  "version": "26.9.3"}).encode()
        chat_body = json.dumps({"choices": [{"message": {"content": "REACH OK"}}]}).encode()

        class _FakeResp(io.BytesIO):
            status = 200

            def __enter__(self):
                return self

            def __exit__(self, *a):
                return False

        def fake_urlopen(req, timeout=None):
            if req.full_url.endswith("/health"):
                return _FakeResp(health_body)
            return _FakeResp(chat_body)

        with patch.object(core, "STATE", state):
            with patch("urllib.request.urlopen", side_effect=fake_urlopen):
                h.handle_diagnose()
        status, payload = h._json.call_args[0]
        self.assertEqual(status, 200)
        self.assertTrue(payload["ok"])
        names = [c["name"] for c in payload["checks"]]
        self.assertEqual(names, ["tls_and_headers", "relay_health",
                                 "chat_completion"])
        self.assertTrue(all(c["ok"] for c in payload["checks"]))

    def test_diagnose_fails_when_chat_probe_fails(self):
        from reachd import core
        import io
        import urllib.error
        state, h = self._state_and_handler("https://live.example.test")

        health_body = json.dumps({"ok": True}).encode()

        class _FakeResp(io.BytesIO):
            status = 200

            def __enter__(self):
                return self

            def __exit__(self, *a):
                return False

        def fake_urlopen(req, timeout=None):
            if req.full_url.endswith("/health"):
                return _FakeResp(health_body)
            raise urllib.error.HTTPError(
                req.full_url, 429, "rate limited", {},
                io.BytesIO(b'{"error": "slow down"}'))

        with patch.object(core, "STATE", state):
            with patch("urllib.request.urlopen", side_effect=fake_urlopen):
                h.handle_diagnose()
        status, payload = h._json.call_args[0]
        self.assertEqual(status, 502)
        self.assertFalse(payload["ok"])
        chat_check = [c for c in payload["checks"]
                      if c["name"] == "chat_completion"][0]
        self.assertFalse(chat_check["ok"])
        self.assertIn("429", chat_check["detail"])


class PublishTimestampTests(unittest.TestCase):
    """PRD 'Publish Public Pointer URL': UI displays publication timestamp;
    admin can revoke the pointer with a single click."""

    def _state(self):
        from reachd.state import RelayState
        with tempfile.NamedTemporaryFile() as tf:
            return RelayState(json.loads(json.dumps(reachd.DEFAULT_SETTINGS)),
                              Path(tf.name))

    def test_publish_records_timestamp_and_snapshot_exposes_it(self):
        from reachd import publish as pub
        state = self._state()
        state.public_url = "https://abc.ngrok-free.app"

        class _Ok:
            returncode = 0
            stderr = ""

        with patch("shutil.which", return_value="gh"), \
             patch("subprocess.run", return_value=_Ok()):
            ok, url = pub.publish_url(state)
        self.assertTrue(ok)
        self.assertEqual(url, "https://abc.ngrok-free.app")
        self.assertIsNotNone(state.last_published_at)
        snap = state.snapshot()
        self.assertEqual(snap["last_published_at"], state.last_published_at)
        self.assertIn("publish_enabled", snap)

    def test_publish_failure_records_no_timestamp(self):
        from reachd import publish as pub
        state = self._state()
        state.public_url = "https://abc.ngrok-free.app"

        class _Fail:
            returncode = 1
            stderr = "gist edit failed"

        with patch("shutil.which", return_value="gh"), \
             patch("subprocess.run", return_value=_Fail()):
            ok, detail = pub.publish_url(state)
        self.assertFalse(ok)
        self.assertIsNone(state.last_published_at)

    def test_revoke_blanks_pointer_and_clears_timestamp(self):
        from reachd import publish as pub
        state = self._state()
        state.last_published_at = "2026-09-18T00:00:00Z"

        class _Ok:
            returncode = 0
            stderr = ""

        with patch("shutil.which", return_value="gh"), \
             patch("subprocess.run", return_value=_Ok()) as run:
            ok, detail = pub.revoke_url(state)
        self.assertTrue(ok)
        self.assertIsNone(state.last_published_at)
        gist_file = state.cfg_path.parent / reachd.GIST_FILE
        self.assertEqual(gist_file.read_text(encoding="utf-8"), "")
        args = run.call_args[0][0]
        self.assertEqual(args[:3], ["gh", "gist", "edit"])

    def test_revoke_without_gh_cli_fails_gracefully(self):
        from reachd import publish as pub
        state = self._state()
        state.last_published_at = "2026-09-18T00:00:00Z"
        with patch("shutil.which", return_value=None), \
             patch("pathlib.Path.is_file", return_value=False):
            ok, detail = pub.revoke_url(state)
        self.assertFalse(ok)
        self.assertIn("gh CLI not found", detail)
        self.assertEqual(state.last_published_at, "2026-09-18T00:00:00Z")


class SystemMessageMergeTests(unittest.TestCase):
    """Strict upstreams (vLLM/Qwen-class chat templates) answer 400 for any
    system message past index 0; the relay merges them into one leading
    system before the request leaves for the upstream."""

    def test_merge_preserves_order_and_moves_everything_leading(self):
        from reachd.chat import merge_system_messages
        merged = merge_system_messages([
            {"role": "user", "content": "first"},
            {"role": "system", "content": "CTX"},
            {"role": "assistant", "content": "a"},
            {"role": "system", "content": "RULES"},
        ])
        self.assertEqual([m["role"] for m in merged],
                         ["system", "user", "assistant"])
        self.assertEqual(merged[0]["content"], "CTX\n\nRULES")

    def test_single_leading_system_is_left_alone(self):
        from reachd.chat import merge_system_messages
        original = [{"role": "system", "content": "ONLY"},
                    {"role": "user", "content": "hi"}]
        self.assertIs(merge_system_messages(original), original)

    def test_injected_prompt_never_stacks_an_end_to_end_request(self):
        from unittest.mock import MagicMock, patch
        from reachd import core
        from reachd.state import RelayState
        from reachd.chat import chat_execute
        import io

        with tempfile.NamedTemporaryFile() as tf:
            state = RelayState(json.loads(json.dumps(reachd.DEFAULT_SETTINGS)),
                               Path(tf.name))
        state.cfg["models"]["gpt-4o"]["enabled"] = True
        state.cfg["models"]["gpt-4o"]["system_prompt"] = "INJECTED RULES"
        state.cfg["omniroute_key"] = "test-key"

        h = MagicMock()
        h._client_ip.return_value = "127.0.0.1"
        # No per-key caps: the handler reports this as (bucket, rpm, tokens).
        h.key_limits.return_value = (None, 0, 0)
        raw = json.dumps({
            "model": "gpt-4o",
            "messages": [
                {"role": "system", "content": "CTX"},
                {"role": "user", "content": "hi"},
                {"role": "system", "content": "MID"},
            ],
        }).encode("utf-8")
        h._read_body.return_value = raw
        h.rfile = io.BytesIO(raw)
        h.headers = {"Content-Length": str(len(raw))}

        sent = {}

        def fake_urlopen(req, **kwargs):
            sent["body"] = json.loads(req.data.decode("utf-8"))
            return MagicMock()

        with patch.object(core, "STATE", state), \
                patch("urllib.request.urlopen", side_effect=fake_urlopen):
            chat_execute(h)

        roles = [m["role"] for m in sent["body"]["messages"]]
        self.assertEqual(roles, ["system", "user"])
        merged = sent["body"]["messages"][0]["content"]
        self.assertIn("INJECTED RULES", merged)
        self.assertIn("CTX", merged)
        self.assertIn("MID", merged)


if __name__ == "__main__":
    unittest.main(verbosity=2)
