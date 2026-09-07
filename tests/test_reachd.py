#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Tests for the SimpleREACH relay server (stdlib-only, unittest).

Run:  python -m unittest tests.test_reachd -v
  or: python tests/test_reachd.py
"""

import json
import os
import sys
import tempfile
import unittest
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

    def test_check_role_continuation_detection(self):
        # Match detection
        status, cut = reachd.check_role_continuation("Hello\n\nUser: How are you?")
        self.assertEqual(status, "MATCH")
        self.assertEqual(cut, len("Hello"))

        # Prefix detection on newline
        status, cut = reachd.check_role_continuation("Hello\n\n")
        self.assertEqual(status, "PREFIX")
        self.assertEqual(cut, len("Hello"))

        status, cut = reachd.check_role_continuation("Hello\n\nUs")
        self.assertEqual(status, "PREFIX")
        self.assertEqual(cut, len("Hello"))

        # Safe normal text
        status, cut = reachd.check_role_continuation("Hello\n1. User accounts")
        self.assertEqual(status, "SAFE")

        status, cut = reachd.check_role_continuation("Hello world!")
        self.assertEqual(status, "SAFE")

    def test_make_sse_chunk(self):
        orig = {"id": "c1", "choices": [{"index": 0, "delta": {"content": "Old"}}]}
        chunk_bytes = reachd.make_sse_chunk(orig, "New")
        self.assertTrue(chunk_bytes.startswith(b"data: {"))
        parsed = json.loads(chunk_bytes.decode("utf-8")[5:].strip())
        self.assertEqual(parsed["choices"][0]["delta"]["content"], "New")



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
        masked = reachd.mask_key("sk-reach-1234567890abcdef1234567890abcdef")
        self.assertTrue(masked.startswith("sk-reach-1234"))
        self.assertTrue(masked.endswith("cdef"))
        self.assertIn("…", masked)

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


if __name__ == "__main__":
    unittest.main(verbosity=2)
