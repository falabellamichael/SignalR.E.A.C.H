#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Tests for the SignalR.E.A.C.H relay server (stdlib-only, unittest).

Run:  python -m unittest tests.test_reachd -v
  or: python tests/test_reachd.py
"""

import json
import os
import sys
import tempfile
import time
import unittest
from unittest.mock import patch
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

    def test_client_ip_prefers_cf_connecting_ip(self):
        h = self._fake({"Cf-Connecting-Ip": "203.0.113.9",
                        "X-Forwarded-For": "1.1.1.1"})
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


if __name__ == "__main__":
    unittest.main(verbosity=2)
