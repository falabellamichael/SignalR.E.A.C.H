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
        cfg["rate_limits"]["per_ip_rpm"] = 1001
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


if __name__ == "__main__":
    unittest.main(verbosity=2)
