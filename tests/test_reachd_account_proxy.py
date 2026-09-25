"""Public account proxy isolation, limits, and existing owner-route compatibility."""
import http.client
import json
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import patch

from tests.test_reachd_access import RelayFixture, TUNNEL
from reachd.account_proxy import account_service_target
from reachd.settings import DEFAULT_SETTINGS, SettingsError, validate_settings


class AccountProxyTests(RelayFixture):
    def setUp(self):
        super().setUp()
        self.requests = []
        outer = self

        class AccountsHandler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"
            def log_message(self, *_):
                pass
            def do_GET(self):
                self.respond()
            def do_POST(self):
                self.respond()
            def respond(self):
                body = self.rfile.read(int(self.headers.get("Content-Length", "0")))
                outer.requests.append({"path": self.path, "headers": dict(self.headers), "body": body})
                data = outer.reply_body
                self.send_response(outer.reply_status)
                for key, value in outer.reply_headers.items():
                    self.send_header(key, value)
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)
                self.wfile.flush()

        self.reply_status = 200
        self.reply_body = b'{"account":"customer"}'
        self.reply_headers = {"Content-Type": "application/json", "Content-Security-Policy": "default-src 'none'", "Referrer-Policy": "no-referrer"}
        self.accounts = ThreadingHTTPServer(("127.0.0.1", 0), AccountsHandler)
        threading.Thread(target=lambda: self.accounts.serve_forever(poll_interval=0.02), daemon=True).start()
        self.state.cfg["account_service_url"] = "http://127.0.0.1:%d" % self.accounts.server_address[1]

    def tearDown(self):
        self.accounts.shutdown()
        self.accounts.server_close()
        super().tearDown()

    def session_headers(self, **extra):
        return {**TUNNEL, "Authorization": "Bearer rch_session_example", **extra}

    def test_hosted_service_disables_anonymous_remote_bypass_even_with_legacy_setting(self):
        self.state.cfg["access"]["key_required"] = False
        self.assertEqual(self.status("GET", "/v1/models", TUNNEL), 401)
        self.assertEqual(self.status("GET", "/v1/models", {}), 200)

    def test_wallet_assets_and_account_routes_do_not_need_legacy_keys(self):
        for path in ("/wallet/connect", "/wallet/redeem", "/wallet/app.js", "/wallet/style.css", "/v1/account/config"):
            with self.subTest(path=path):
                status, data, reply = self.call("GET", path, TUNNEL)
                self.assertEqual(status, 200)
                self.assertEqual(data, self.reply_body)
                self.assertEqual(reply.getheader("Content-Security-Policy"), "default-src 'none'")
                self.assertEqual(reply.getheader("Referrer-Policy"), "no-referrer")
                self.assertEqual(self.requests[-1]["path"], path)

    def test_auth_body_and_origin_are_forwarded_without_cookies_or_owner_credentials(self):
        headers = {**TUNNEL, "Origin": "https://accounts.example", "Content-Type": "application/json",
                   "Cookie": "sensitive=operator", "X-Reach-Key": "owner-key", "Idempotency-Key": "abc",
                   "X-Reach-Client-IP": "192.0.2.99", "Cf-Connecting-Ip": "192.0.2.88"}
        status, _, _ = self.call("POST", "/v1/auth/verify", headers, b'{"signature":"test"}')
        self.assertEqual(status, 200)
        sent = self.requests[-1]
        self.assertEqual(sent["body"], b'{"signature":"test"}')
        self.assertEqual(sent["headers"]["Origin"], "https://accounts.example")
        self.assertEqual(sent["headers"]["Idempotency-Key"], "abc")
        self.assertEqual(sent["headers"]["X-Reach-Client-IP"], "203.0.113.9")
        for name in ("Cookie", "X-Reach-Key", "X-Forwarded-For", "X-Forwarded-Host"):
            self.assertNotIn(name, sent["headers"])
        self.assertTrue(sent["headers"]["Host"].startswith("127.0.0.1:"))

    def test_customer_models_and_completions_never_reach_legacy_auth_or_generation(self):
        with patch("reachd.handler.RelayHandler._check_access", side_effect=AssertionError("legacy access")), \
             patch("reachd.handler.chat_execute", side_effect=AssertionError("legacy generation")):
            for path in ("/v1/models", "/models"):
                self.assertEqual(self.status("GET", path, self.session_headers()), 200)
                self.assertEqual(self.requests[-1]["path"], "/v1/models")
            for path in ("/v1/chat/completions", "/chat/completions"):
                self.assertEqual(self.status("POST", path, self.session_headers(), b'{}'), 200)
                self.assertEqual(self.requests[-1]["path"], "/v1/chat/completions")
                self.assertEqual(self.requests[-1]["headers"]["Authorization"], "Bearer rch_session_example")

    def test_direct_loopback_customer_still_cannot_use_local_owner_bypass(self):
        self.reply_status = 401
        self.reply_body = b'{"error":{"code":"session_required"}}'
        status, data, _ = self.call("GET", "/v1/models", {"Authorization": "Bearer rch_session_invalid"})
        self.assertEqual(status, 401)
        self.assertIn(b"session_required", data)
        self.assertEqual(len(self.requests), 1)

    def test_existing_owner_key_stays_on_original_catalog(self):
        status, data, _ = self.call("GET", "/v1/models", self.bearer(**TUNNEL))
        self.assertEqual(status, 200)
        self.assertIn(b'"object": "list"', data)
        self.assertFalse(self.requests)

    def test_unconfigured_account_routes_fail_closed(self):
        self.state.cfg["account_service_url"] = ""
        for method, path, headers in (("GET", "/wallet/connect", TUNNEL),
                                     ("POST", "/v1/auth/start", TUNNEL),
                                     ("GET", "/v1/models", self.session_headers())):
            with self.subTest(path=path):
                status, data, _ = self.call(method, path, headers, b'{}' if method == 'POST' else None)
                self.assertEqual(status, 503)
                self.assertIn(b"accounts_unconfigured", data)
        self.assertFalse(self.requests)

    def test_redirect_is_not_followed_and_location_is_not_exposed(self):
        self.reply_status = 302
        self.reply_headers["Location"] = "https://sensitive.example/secret"
        status, data, reply = self.call("GET", "/wallet/connect", TUNNEL)
        self.assertEqual(status, 502)
        self.assertIsNone(reply.getheader("Location"))
        self.assertNotIn(b"sensitive", data)
        self.assertEqual(len(self.requests), 1)

    def test_sse_body_and_security_headers_are_preserved(self):
        self.reply_body = b'data: {"choices":[]}\n\ndata: [DONE]\n\n'
        self.reply_headers["Content-Type"] = "text/event-stream"
        status, data, reply = self.call("POST", "/v1/chat/completions", self.session_headers(), b'{}')
        self.assertEqual(status, 200)
        self.assertEqual(data, self.reply_body)
        self.assertEqual(reply.getheader("Content-Type"), "text/event-stream")
        self.assertEqual(reply.getheader("Transfer-Encoding"), "chunked")

    def test_account_route_allowlist_cannot_proxy_other_paths(self):
        for path in ("/wallet/../../healthz", "/v1/account/config/extra", "/healthz", "/v1/auth/admin"):
            with self.subTest(path=path):
                self.assertEqual(self.status("GET", path, TUNNEL), 404)
        self.assertFalse(self.requests)

    def test_oversized_post_is_rejected_without_dispatch(self):
        status, data, _ = self.call("POST", "/v1/auth/start", {**TUNNEL, "Content-Length": "524289"})
        self.assertEqual(status, 413)
        self.assertFalse(self.requests)


class AccountProxyConfigTests(unittest.TestCase):
    def test_only_literal_loopback_origins_are_allowed(self):
        self.assertEqual(account_service_target("http://127.0.0.1:20978"), ("http", "127.0.0.1", 20978))
        self.assertEqual(account_service_target("http://[::1]:20978/"), ("http", "::1", 20978))
        for value in ("http://localhost:20978", "http://10.0.0.1:20978", "https://public.example",
                      "http://127.0.0.1:20978/v1", "http://user:secret@127.0.0.1:20978", "http://127.0.0.1:20978?x=1"):
            with self.subTest(value=value), self.assertRaises(ValueError):
                account_service_target(value)

    def test_settings_accept_disabled_and_loopback_account_service(self):
        config = json.loads(json.dumps(DEFAULT_SETTINGS))
        validate_settings(config)
        config["account_service_url"] = "http://127.0.0.1:20978"
        validate_settings(config)
        for invalid in ("https://public.example", "http://127.0.0.1:20777"):
            config["account_service_url"] = invalid
            with self.subTest(invalid=invalid), self.assertRaises(SettingsError):
                validate_settings(config)


if __name__ == "__main__":
    unittest.main()
