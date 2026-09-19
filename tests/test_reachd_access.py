#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Access-control tests for the relay: who may use it, and who may not.

Boots the real RelayHandler in-process and drives it over HTTP, so the checks
cover the whole path a request takes rather than one helper at a time. A
"tunnel" request is one carrying the headers ngrok/cloudflared add and a public
Host; the "owner" is a bare loopback request.

Run:  python -m unittest tests.test_reachd_access -v
"""

import http.client
import json
import sys
import tempfile
import threading
import unittest
from http.server import ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "server"))

import reachd  # noqa: E402
from reachd import core  # noqa: E402
from reachd.handler import (  # noqa: E402
    RelayHandler, _host_is_loopback, _secret_equal, _trusted_proxy)
from reachd.state import RelayState  # noqa: E402

TUNNEL = {"X-Forwarded-For": "203.0.113.9", "Host": "abc.ngrok-free.app"}
EVIL_PAGE = {"Origin": "https://evil.example"}


def _tunnel(ip="203.0.113.9", **extra):
    return {"X-Forwarded-For": ip, "Host": "abc.ngrok-free.app", **extra}


class RelayFixture(unittest.TestCase):
    """A live relay on an ephemeral port, with a real config in a temp dir."""

    access_overrides = {}

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        tmp = Path(self._tmp.name)
        cfg = json.loads(json.dumps(reachd.DEFAULT_SETTINGS))
        cfg["system"]["host_bind"] = False
        cfg["system"]["admin_token"] = reachd.generate_admin_token()
        self.key = reachd.generate_client_key("Default")
        cfg["access"]["keys"] = [self.key]
        cfg["access"]["key_required"] = True
        cfg["access"].update(self.access_overrides)
        # RelayState opens its analytics DB under config_dir(); keep that out
        # of the real install.
        with patch("reachd.state.config_dir", return_value=tmp):
            self.state = RelayState(cfg, tmp / "config.json")
        self._patch = patch.object(core, "STATE", self.state)
        self._patch.start()
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), RelayHandler)
        self.port = self.server.server_address[1]
        threading.Thread(target=lambda: self.server.serve_forever(poll_interval=0.02), daemon=True).start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self._patch.stop()
        self._tmp.cleanup()

    def call(self, method, path, headers=None, body=None, conn=None):
        c = conn or http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        c.request(method, path, body=body, headers=dict(headers or {}))
        resp = c.getresponse()
        data = resp.read()
        if conn is None:
            c.close()
        return resp.status, data, resp

    def status(self, *args, **kwargs):
        return self.call(*args, **kwargs)[0]

    def bearer(self, **extra):
        return {"Authorization": "Bearer " + self.key["key"], **extra}


class KeyRequiredTests(RelayFixture):
    def test_owner_on_this_machine_needs_no_key(self):
        self.assertEqual(self.status("GET", "/v1/models"), 200)

    def test_stranger_through_the_tunnel_is_refused(self):
        self.assertEqual(self.status("GET", "/v1/models", TUNNEL), 401)
        self.assertEqual(self.status("POST", "/v1/chat/completions", TUNNEL,
                                     body=b"{}"), 401)

    def test_wrong_key_is_refused(self):
        headers = {**TUNNEL, "Authorization": "Bearer sk-reach-nope"}
        self.assertEqual(self.status("GET", "/v1/models", headers), 401)

    def test_valid_key_is_accepted_both_ways(self):
        self.assertEqual(self.status("GET", "/v1/models", self.bearer(**TUNNEL)), 200)
        self.assertEqual(self.status("GET", "/v1/models",
                                     {**TUNNEL, "X-Reach-Key": self.key["key"]}), 200)

    def test_disabled_key_is_refused(self):
        self.key["enabled"] = False
        self.assertEqual(self.status("GET", "/v1/models", self.bearer(**TUNNEL)), 401)

    def test_non_ascii_key_header_is_a_401_not_a_crash(self):
        # hmac.compare_digest raises TypeError on non-ASCII str, which used to
        # surface as a 500 with the exception text.
        headers = {**TUNNEL, "X-Reach-Key": "caf\xe9"}
        self.assertEqual(self.status("GET", "/v1/models", headers), 401)

    def test_a_blanked_key_placeholder_cannot_be_matched(self):
        # A host mismatch blanks a key's secret but keeps the entry visible.
        self.key["key"] = ""
        self.state.cfg["access"]["access_key"] = ""
        self.assertEqual(self.status("GET", "/v1/models", {**TUNNEL, "X-Reach-Key": ""}), 401)
        self.assertEqual(self.status("GET", "/v1/models", {**TUNNEL, "X-Reach-Key": "None"}), 401)

    def test_key_not_required_lets_everyone_in(self):
        self.state.cfg["access"]["key_required"] = False
        self.assertEqual(self.status("GET", "/v1/models", TUNNEL), 200)

    def test_refused_requests_are_logged(self):
        self.status("GET", "/v1/models", self.bearer(**TUNNEL))            # allowed
        self.status("GET", "/v1/models", _tunnel("198.51.100.3"))          # refused
        rows = json.loads(self.call("GET", "/_reach/logs?limit=10")[1])["logs"]
        refused = [r for r in rows if r.get("status") == 401]
        self.assertEqual(len(refused), 1)
        self.assertEqual(refused[0]["ip"], "198.51.100.3")
        self.assertEqual(refused[0]["error"], "auth_missing")


class LocalBypassTests(RelayFixture):
    access_overrides = {"local_bypass": False}

    def test_bypass_can_be_turned_off_for_reverse_proxy_setups(self):
        self.assertEqual(self.status("GET", "/v1/models"), 401)
        self.assertEqual(self.status("GET", "/v1/models", self.bearer()), 200)


class BrowserAttackTests(RelayFixture):
    """The owner's browser connects from 127.0.0.1 too, so a page they visit is
    'local' by address alone. It must not be treated as the owner."""

    def test_foreign_web_page_does_not_get_the_local_bypass(self):
        self.assertEqual(self.status("GET", "/v1/models", EVIL_PAGE), 401)
        self.assertEqual(self.status("POST", "/v1/chat/completions", EVIL_PAGE,
                                     body=b"{}"), 401)

    def test_foreign_web_page_cannot_use_the_admin_api(self):
        self.assertEqual(self.status("GET", "/_reach/settings", EVIL_PAGE), 403)
        self.assertEqual(self.status("GET", "/_reach/keys", EVIL_PAGE), 403)
        self.assertEqual(self.status("POST", "/_reach/keys",
                                     {**EVIL_PAGE, "Content-Type": "application/json"},
                                     body=b"{}"), 403)
        self.assertEqual(self.status("POST", "/_reach/reset", EVIL_PAGE), 403)

    def test_foreign_web_page_cannot_extract_a_key(self):
        self.assertEqual(self.status("POST", "/_reach/keys/ensure",
                                     {**EVIL_PAGE, "Content-Type": "application/json"},
                                     body=b"{}"), 403)

    def test_sandboxed_null_origin_is_not_local(self):
        self.assertEqual(self.status("GET", "/_reach/settings", {"Origin": "null"}), 403)

    def test_dns_rebinding_host_is_not_local(self):
        rebind = {"Host": "rebind.evil.example:20777"}
        self.assertEqual(self.status("GET", "/v1/models", rebind), 401)
        self.assertEqual(self.status("GET", "/_reach/settings", rebind), 403)

    def test_loopback_web_origin_still_works_for_the_panel(self):
        panel = {"Origin": "http://localhost:8080"}
        self.assertEqual(self.status("GET", "/_reach/settings", panel), 200)
        self.assertEqual(self.status("GET", "/v1/models", panel), 200)

    def test_owner_admin_still_works(self):
        self.assertEqual(self.status("GET", "/_reach/settings"), 200)

    def test_tunnel_cannot_use_admin_without_the_token(self):
        self.assertEqual(self.status("GET", "/_reach/settings", TUNNEL), 403)

    def test_admin_token_works_remotely_but_never_hands_out_a_key(self):
        token = self.state.cfg["system"]["admin_token"]
        admin = {**TUNNEL, "X-Reach-Admin": token}
        self.assertEqual(self.status("GET", "/_reach/settings", admin), 200)
        self.assertEqual(self.status("POST", "/_reach/keys/ensure",
                                     {**admin, "Content-Type": "application/json"},
                                     body=b"{}"), 403)


class LockoutTests(RelayFixture):
    access_overrides = {"auth_fail_limit": 3, "auth_lockout_s": 60}

    def test_repeated_bad_keys_lock_the_address_out(self):
        attacker = _tunnel("198.51.100.7")
        codes = [self.status("GET", "/v1/models", {**attacker, "X-Reach-Key": "guess%d" % i})
                 for i in range(5)]
        self.assertEqual(codes, [401, 401, 429, 429, 429])

    def test_lockout_holds_even_for_the_right_key(self):
        attacker = _tunnel("198.51.100.7")
        for i in range(3):
            self.status("GET", "/v1/models", {**attacker, "X-Reach-Key": "guess%d" % i})
        self.assertEqual(self.status("GET", "/v1/models", self.bearer(**attacker)), 429)

    def test_lockout_sends_retry_after(self):
        attacker = _tunnel("198.51.100.7")
        for i in range(3):
            self.status("GET", "/v1/models", {**attacker, "X-Reach-Key": "guess%d" % i})
        _s, _b, resp = self.call("GET", "/v1/models", attacker)
        self.assertEqual(resp.status, 429)
        self.assertGreater(int(resp.getheader("Retry-After")), 0)

    def test_lockout_is_per_address(self):
        for i in range(3):
            self.status("GET", "/v1/models", {**_tunnel("198.51.100.7"), "X-Reach-Key": "g%d" % i})
        self.assertEqual(self.status("GET", "/v1/models",
                                     self.bearer(**_tunnel("198.51.100.8"))), 200)

    def test_a_correct_key_clears_earlier_typos(self):
        who = _tunnel("198.51.100.9")
        for i in range(2):
            self.status("GET", "/v1/models", {**who, "X-Reach-Key": "typo%d" % i})
        self.assertEqual(self.status("GET", "/v1/models", self.bearer(**who)), 200)
        self.assertEqual(self.status("GET", "/v1/models", {**who, "X-Reach-Key": "typo"}), 401)

    def test_owner_is_never_locked_out(self):
        for i in range(10):
            self.status("GET", "/v1/models", {**EVIL_PAGE})   # foreign-page failures
        self.assertEqual(self.status("GET", "/v1/models"), 200)

    def test_admin_token_guessing_trips_the_same_lockout(self):
        attacker = _tunnel("198.51.100.50")
        codes = [self.status("GET", "/_reach/settings", {**attacker, "X-Reach-Admin": "rt-guess%d" % i})
                 for i in range(4)]
        self.assertEqual(codes, [403, 403, 429, 429])
        good = {**attacker, "X-Reach-Admin": self.state.cfg["system"]["admin_token"]}
        self.assertEqual(self.status("GET", "/_reach/settings", good), 429)

    def test_lockout_can_be_disabled(self):
        self.state.cfg["access"]["auth_fail_limit"] = 0
        attacker = _tunnel("198.51.100.7")
        codes = {self.status("GET", "/v1/models", {**attacker, "X-Reach-Key": "g%d" % i})
                 for i in range(6)}
        self.assertEqual(codes, {401})


class IpListTests(RelayFixture):
    def test_blocklist_refuses_before_the_key_is_considered(self):
        self.state.cfg["access"]["ip_blocklist"] = ["203.0.113.0/24"]
        self.assertEqual(self.status("GET", "/v1/models", self.bearer(**_tunnel("203.0.113.9"))), 403)
        self.assertEqual(self.status("GET", "/v1/models", self.bearer(**_tunnel("198.51.100.1"))), 200)

    def test_allowlist_admits_only_listed_addresses(self):
        self.state.cfg["access"]["ip_allowlist"] = ["198.51.100.1"]
        self.assertEqual(self.status("GET", "/v1/models", self.bearer(**_tunnel("198.51.100.1"))), 200)
        self.assertEqual(self.status("GET", "/v1/models", self.bearer(**_tunnel("198.51.100.2"))), 403)

    def test_lists_now_cover_the_models_route_too(self):
        # They used to be checked only on chat, so a blocked address could still
        # enumerate models.
        self.state.cfg["access"]["ip_blocklist"] = ["203.0.113.9"]
        self.assertEqual(self.status("GET", "/v1/models", self.bearer(**_tunnel("203.0.113.9"))), 403)

    def test_owner_is_exempt_from_the_lists(self):
        self.state.cfg["access"]["ip_allowlist"] = ["198.51.100.1"]
        self.assertEqual(self.status("GET", "/v1/models"), 200)


class HealthRedactionTests(RelayFixture):
    LEAKY = ("upstream", "bridge_url", "config_error")

    def test_stranger_does_not_see_internals(self):
        status, body, _ = self.call("GET", "/health", TUNNEL)
        self.assertEqual(status, 200)          # liveness stays public
        data = json.loads(body)
        self.assertTrue(data["ok"])
        for field in self.LEAKY:
            self.assertIsNone(data[field], field)
        self.assertEqual(data["in_flight"], [])

    def test_stranger_does_not_see_in_flight_client_addresses(self):
        self.state.in_flight[1] = {"model": "gpt-4o", "ip": "192.0.2.55",
                                   "started": 0, "stream": False}
        _s, body, _ = self.call("GET", "/health", TUNNEL)
        self.assertNotIn("192.0.2.55", body.decode())
        _s, body, _ = self.call("GET", "/health")
        self.assertIn("192.0.2.55", body.decode())     # the owner still does

    def test_owner_sees_everything(self):
        data = json.loads(self.call("GET", "/health")[1])
        self.assertTrue(data["upstream"])


class ResetAndAuditTests(RelayFixture):
    def test_reset_does_not_reopen_the_relay(self):
        self.assertEqual(self.status("POST", "/_reach/reset"), 200)
        access = self.state.cfg["access"]
        self.assertTrue(access["key_required"])
        self.assertEqual([k["key"] for k in access["keys"]], [self.key["key"]])
        self.assertEqual(self.status("GET", "/v1/models", TUNNEL), 401)
        self.assertEqual(self.status("GET", "/v1/models", self.bearer(**TUNNEL)), 200)

    def test_reset_via_settings_put_does_not_reopen_the_relay(self):
        status = self.status("PUT", "/_reach/settings",
                             {"Content-Type": "application/json"},
                             body=json.dumps({"reset": True}).encode())
        self.assertEqual(status, 200)
        self.assertTrue(self.state.cfg["access"]["key_required"])
        self.assertEqual(self.status("GET", "/v1/models", TUNNEL), 401)

    def test_loosening_access_is_audited(self):
        status = self.status("PUT", "/_reach/settings",
                             {"Content-Type": "application/json"},
                             body=json.dumps({"access": {"key_required": False}}).encode())
        self.assertEqual(status, 200)
        events = json.loads(self.call("GET", "/_reach/audit")[1])["events"]
        self.assertTrue(any(e["action"] == "access.change"
                            and "key_required" in e["detail"] for e in events))

    def test_audit_never_records_key_values(self):
        self.status("PUT", "/_reach/settings", {"Content-Type": "application/json"},
                    body=json.dumps({"access": {"key_required": False}}).encode())
        raw = self.call("GET", "/_reach/audit")[1].decode()
        self.assertNotIn(self.key["key"], raw)


class EnsureKeyTests(RelayFixture):
    def _ensure(self, name="SimpleRAG", headers=None):
        status, body, _ = self.call("POST", "/_reach/keys/ensure",
                                    {"Content-Type": "application/json", **(headers or {})},
                                    body=json.dumps({"name": name}).encode())
        return status, (json.loads(body) if body else {})

    def test_mints_once_then_reuses(self):
        s1, first = self._ensure()
        s2, second = self._ensure()
        self.assertEqual((s1, s2), (200, 200))
        self.assertTrue(first["created"])
        self.assertFalse(second["created"])
        self.assertEqual(first["key"], second["key"])
        self.assertEqual(len([k for k in self.state.cfg["access"]["keys"]
                              if k["name"] == "SimpleRAG"]), 1)

    def test_minted_key_actually_works_through_the_tunnel(self):
        _s, minted = self._ensure()
        headers = {**TUNNEL, "Authorization": "Bearer " + minted["key"]}
        self.assertEqual(self.status("GET", "/v1/models", headers), 200)


class ConnectionIntegrityTests(RelayFixture):
    """handle_chat used to raise after answering a rejected request, and the
    error handler then wrote a SECOND response onto the same connection."""

    def test_rejected_chat_request_leaves_the_connection_clean(self):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        try:
            status, _b, _r = self.call("POST", "/v1/chat/completions",
                                       {"Content-Type": "application/json"},
                                       body=b"this is not json", conn=conn)
            self.assertEqual(status, 400)
            status, body, _r = self.call("GET", "/health", conn=conn)
            self.assertEqual(status, 200)
            self.assertTrue(json.loads(body)["ok"])
        finally:
            conn.close()


class KeepAliveTests(RelayFixture):
    """Refusing a POST without reading its body used to leave the body on the
    connection, where it was parsed as the next request line."""

    BODY = json.dumps({"model": "gpt-4o",
                       "messages": [{"role": "user", "content": "hi"}]}).encode()

    def test_refused_post_does_not_poison_the_next_request(self):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        try:
            status, _b, resp = self.call("POST", "/v1/chat/completions",
                                         {**TUNNEL, "Content-Type": "application/json"},
                                         body=self.BODY, conn=conn)
            self.assertEqual(status, 401)
            # The relay must say it is closing, since it did not read the body.
            self.assertEqual((resp.getheader("Connection") or "").lower(), "close")
            status, body, _r = self.call("GET", "/health", conn=conn)
            self.assertEqual(status, 200)
            self.assertTrue(json.loads(body)["ok"])
        finally:
            conn.close()

    def test_a_consumed_body_keeps_the_connection_alive(self):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        try:
            status, _b, resp = self.call("POST", "/v1/chat/completions",
                                         {"Content-Type": "application/json"},
                                         body=b"not json", conn=conn)   # read, then refused
            self.assertEqual(status, 400)
            self.assertNotEqual((resp.getheader("Connection") or "").lower(), "close")
        finally:
            conn.close()

    def test_body_flag_is_reset_between_requests_on_one_connection(self):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        try:
            self.call("POST", "/v1/chat/completions", {"Content-Type": "application/json"},
                      body=b"not json", conn=conn)            # consumes its body
            status, _b, resp = self.call("POST", "/v1/chat/completions",
                                         {**TUNNEL, "Content-Type": "application/json"},
                                         body=self.BODY, conn=conn)   # refuses without reading
            self.assertEqual(status, 401)
            self.assertEqual((resp.getheader("Connection") or "").lower(), "close")
        finally:
            conn.close()


class HelperTests(unittest.TestCase):
    def test_host_is_loopback(self):
        for good in ("127.0.0.1", "127.0.0.1:20777", "localhost", "LOCALHOST:8080",
                     "[::1]", "[::1]:20777", "::1", None, ""):
            self.assertTrue(_host_is_loopback(good), good)
        for bad in ("abc.ngrok-free.app", "evil.example:20777", "localhost.evil.example",
                    "127.0.0.1.evil.example", "203.0.113.9", "0.0.0.0", "[2001:db8::1]:80"):
            self.assertFalse(_host_is_loopback(bad), bad)

    def test_secret_equal(self):
        self.assertTrue(_secret_equal("sk-reach-abc", "sk-reach-abc"))
        self.assertFalse(_secret_equal("sk-reach-abc", "sk-reach-abd"))
        self.assertFalse(_secret_equal("sk-reach-abc", "caf\xe9"))   # no TypeError
        self.assertFalse(_secret_equal("", ""))
        self.assertFalse(_secret_equal(None, "None"))
        self.assertFalse(_secret_equal("sk-reach-abc", ""))
        self.assertFalse(_secret_equal({"sealed": "x"}, "x"))

    def test_forwarding_headers_are_only_believed_from_trusted_peers(self):
        class _Stub:
            cfg = {"access": {"trusted_proxies": ["10.0.0.0/8"]}}
        with patch.object(core, "STATE", _Stub()):
            self.assertTrue(_trusted_proxy("127.0.0.1"))
            self.assertTrue(_trusted_proxy("::1"))
            self.assertTrue(_trusted_proxy("::ffff:127.0.0.1"))
            self.assertTrue(_trusted_proxy("10.1.2.3"))
            self.assertFalse(_trusted_proxy("203.0.113.9"))

    def _handler(self, peer, headers):
        class _H:
            _client_ip = RelayHandler._client_ip
        h = _H()
        h.client_address = (peer, 1234)
        h.headers = headers
        return h

    def test_direct_client_cannot_forge_its_address(self):
        # A client reaching the relay directly (Docker, LAN) can write any
        # X-Forwarded-For it likes; believing it would let it pick which IP the
        # allow/block lists and rate limiter see.
        class _Stub:
            cfg = {"access": {"trusted_proxies": []}}
        forged = {"X-Forwarded-For": "198.51.100.1", "Cf-Connecting-Ip": "198.51.100.1"}
        with patch.object(core, "STATE", _Stub()):
            self.assertEqual(self._handler("203.0.113.9", forged)._client_ip(), "203.0.113.9")
            self.assertEqual(self._handler("127.0.0.1", forged)._client_ip(), "198.51.100.1")

    def test_configured_proxy_is_believed(self):
        class _Stub:
            cfg = {"access": {"trusted_proxies": ["172.18.0.2"]}}
        with patch.object(core, "STATE", _Stub()):
            h = self._handler("172.18.0.2", {"X-Forwarded-For": "1.1.1.1, 198.51.100.4"})
            self.assertEqual(h._client_ip(), "198.51.100.4")


class AuthGuardTests(unittest.TestCase):
    CFG = {"access": {"auth_fail_limit": 3, "auth_lockout_s": 60}}

    def test_locks_out_at_the_limit_and_reports_retry_after(self):
        g = reachd.AuthGuard()
        self.assertEqual(g.retry_after("1.1.1.1", self.CFG), 0)
        self.assertEqual([g.record_failure("1.1.1.1", self.CFG) for _ in range(3)], [0, 0, 60])
        self.assertTrue(0 < g.retry_after("1.1.1.1", self.CFG) <= 61)
        self.assertEqual(g.retry_after("2.2.2.2", self.CFG), 0)

    def test_success_resets_the_count(self):
        g = reachd.AuthGuard()
        g.record_failure("1.1.1.1", self.CFG)
        g.record_failure("1.1.1.1", self.CFG)
        g.record_success("1.1.1.1")
        self.assertEqual(g.record_failure("1.1.1.1", self.CFG), 0)

    def test_zero_limit_disables_it(self):
        g = reachd.AuthGuard()
        cfg = {"access": {"auth_fail_limit": 0}}
        self.assertEqual([g.record_failure("1.1.1.1", cfg) for _ in range(20)], [0] * 20)
        self.assertEqual(g.retry_after("1.1.1.1", cfg), 0)

    def test_lockout_expires(self):
        g = reachd.AuthGuard()
        cfg = {"access": {"auth_fail_limit": 1, "auth_lockout_s": 1}}
        g.record_failure("1.1.1.1", cfg)
        self.assertGreater(g.retry_after("1.1.1.1", cfg), 0)
        with patch("reachd.limits.time.time", return_value=__import__("time").time() + 5):
            self.assertEqual(g.retry_after("1.1.1.1", cfg), 0)

    def test_table_is_bounded_and_never_wiped(self):
        g = reachd.AuthGuard()
        g.MAX_TRACKED = 50
        g.record_failure("victim", {"access": {"auth_fail_limit": 1, "auth_lockout_s": 3600}})
        for i in range(200):
            g.record_failure("10.0.%d.%d" % (i // 250, i % 250), self.CFG)
        self.assertLessEqual(len(g._fails), 50)


class ConfigSecurityTests(unittest.TestCase):
    def _load(self, raw=None):
        td = tempfile.TemporaryDirectory()
        self.addCleanup(td.cleanup)
        path = Path(td.name) / "config.json"
        if raw is not None:
            path.write_text(json.dumps(raw), encoding="utf-8")
        return reachd.load_config(path)

    def test_fresh_install_requires_a_key_and_validates(self):
        cfg = self._load()
        self.assertTrue(cfg["access"]["key_required"])
        self.assertTrue(any(k.get("key") for k in cfg["access"]["keys"]))
        reachd.validate_settings(cfg)

    def test_existing_open_install_is_locked_down_once(self):
        cfg = self._load({"access": {"key_required": False}})
        self.assertTrue(cfg["access"]["key_required"])
        self.assertGreaterEqual(cfg["system"]["security_revision"], 1)

    def test_migration_does_not_override_a_later_choice(self):
        cfg = self._load({"access": {"key_required": False},
                          "system": {"security_revision": 1}})
        self.assertFalse(cfg["access"]["key_required"])

    def test_migration_survives_a_restart(self):
        with tempfile.TemporaryDirectory() as td:
            path = Path(td) / "config.json"
            path.write_text(json.dumps({"access": {"key_required": False}}), encoding="utf-8")
            first = reachd.load_config(path)
            second = reachd.load_config(path)
        self.assertTrue(first["access"]["key_required"])
        self.assertTrue(second["access"]["key_required"])

    def test_new_settings_validate(self):
        cfg = json.loads(json.dumps(reachd.DEFAULT_SETTINGS))
        cfg["access"]["trusted_proxies"] = ["10.0.0.0/8", "172.18.0.2"]
        cfg["access"]["auth_fail_limit"] = 0
        reachd.validate_settings(cfg)

    def test_bad_settings_are_rejected(self):
        for field, value in (("trusted_proxies", ["not-an-ip"]),
                             ("trusted_proxies", "10.0.0.1"),
                             ("auth_fail_limit", -1),
                             ("auth_lockout_s", 0),
                             ("local_bypass", "yes")):
            cfg = json.loads(json.dumps(reachd.DEFAULT_SETTINGS))
            cfg["access"][field] = value
            with self.assertRaises(reachd.SettingsError, msg="%s=%r" % (field, value)):
                reachd.validate_settings(cfg)


if __name__ == "__main__":
    unittest.main(verbosity=2)
