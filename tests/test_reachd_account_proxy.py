"""Public account proxy isolation, limits, and existing owner-route compatibility."""
import http.client
import json
import socket
import threading
import time
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
        # Reading the response can finish before the handler commits telemetry.
        # Windows cannot remove the fixture database while that connection is open.
        deadline = time.monotonic() + 5
        while self.state.in_flight_snapshot() and time.monotonic() < deadline:
            time.sleep(0.01)
        self.assertFalse(self.state.in_flight_snapshot(), 'Account handlers did not finish')
        super().tearDown()

    def session_headers(self, **extra):
        return {**TUNNEL, "Authorization": "Bearer rch_session_example", **extra}

    def account_log(self):
        deadline = time.monotonic() + 2
        while time.monotonic() < deadline:
            rows = self.state.analytics.logs()
            if rows and not self.state.in_flight_snapshot():
                return rows[0]
            time.sleep(0.005)
        self.fail("Account completion was not logged")

    def test_website_completion_logs_actual_usage_without_prompt_or_credentials(self):
        account = 'a' * 64
        self.reply_headers['X-Reach-Account-Id'] = account
        self.reply_body = json.dumps({'usage': {'prompt_tokens': 120, 'completion_tokens': 45, 'total_tokens': 165}}).encode()
        status, _, response = self.call('POST', '/v1/chat/completions',
            self.session_headers(Origin='https://signalreach.ca', **{'Content-Type': 'application/json'}),
            b'{"model":"gemma-4-12b-qat","messages":[{"role":"user","content":"private prompt"}]}')
        self.assertEqual(status, 200)
        self.assertIsNone(response.getheader('X-Reach-Account-Id'))
        row = self.account_log()
        self.assertEqual((row['tokens_in'], row['tokens_out']), (120, 45))
        self.assertEqual(row['key_name'], 'Website · account ' + account[:12])
        self.assertEqual(row['ip'], '203.0.113.9')
        self.assertEqual(row['model'], 'gemma-4-12b-qat')
        self.assertNotIn('private prompt', json.dumps(row))
        self.assertNotIn('rch_session_example', json.dumps(row))
        self.assertEqual(self.state.analytics.stats()['today']['requests'], 1)

    def test_api_key_stream_and_replay_are_logged_without_double_counting_tokens(self):
        self.reply_headers['Content-Type'] = 'text/event-stream'
        self.reply_body = b'data: {"choices":[{"delta":{"content":"answer"}}]}\n\ndata: {"usage":{"prompt_tokens":12,"completion_tokens":7,"total_tokens":19}}\n\ndata: [DONE]\n\n'
        headers = {**TUNNEL, 'Authorization': 'Bearer rch_key_' + 'b' * 64, 'Content-Type': 'application/json'}
        self.assertEqual(self.status('POST', '/api/v1/chat/completions', headers, b'{"model":"gemma-4-12b-qat","stream":true}'), 200)
        row = self.account_log()
        self.assertEqual((row['tokens_in'], row['tokens_out']), (12, 7))
        self.assertEqual(row['key_name'], 'API key rch_key_' + 'b' * 8)
        self.assertEqual(row['stream'], 1)
        self.reply_headers['X-Reach-Replayed'] = 'true'
        self.assertEqual(self.status('POST', '/v1/chat/completions', headers, b'{"model":"gemma-4-12b-qat","stream":true}'), 200)
        deadline = time.monotonic() + 2
        while len(self.state.analytics.logs()) < 2 and time.monotonic() < deadline:
            time.sleep(0.005)
        row = self.account_log()
        self.assertEqual((row['tokens_in'], row['tokens_out'], row['cached']), (0, 0, 1))
        self.assertEqual(self.state.analytics.stats()['today']['tokens_out'], 7)

    def test_private_gpu_usage_headers_reach_analytics_but_not_the_customer(self):
        self.reply_headers.update({'X-Reach-Usage-In': '80', 'X-Reach-Usage-Out': '25'})
        self.reply_body = b'{"choices":[{"message":{"content":"hello"}}]}'
        status, _, response = self.call('POST', '/v1/chat/completions', self.session_headers(), b'{"model":"gemma-4-12b-qat"}')
        self.assertEqual(status, 200)
        self.assertIsNone(response.getheader('X-Reach-Usage-In'))
        self.assertIsNone(response.getheader('X-Reach-Usage-Out'))
        row = self.account_log()
        self.assertEqual((row['tokens_in'], row['tokens_out']), (80, 25))

    def test_account_refusal_is_logged_and_non_chat_routes_are_not_usage(self):
        self.reply_status = 403
        self.reply_body = b'{"error":{"code":"model_not_allowed","message":"private detail"}}'
        self.assertEqual(self.status('POST', '/v1/chat/completions', self.session_headers(), b'{"model":"gemma-4-12b-qat"}'), 403)
        row = self.account_log()
        self.assertEqual((row['status'], row['error']), (403, 'model_not_allowed'))
        self.assertIsNone(row['tokens_in'])
        self.assertEqual(self.status('GET', '/v1/account', self.session_headers()), 403)
        self.assertEqual(len(self.state.analytics.logs()), 1)

    def test_account_key_metadata_requires_admin_and_strips_secrets(self):
        self.reply_body = b'{"data":[{"id":"safe-id","name":"Website key","prefix":"rch_key_12345678","hash":"never forward","key":"never forward"}],"hasMore":false}'
        self.assertEqual(self.status('GET', '/_reach/account-api-keys', self.session_headers()), 403)
        self.assertEqual(self.status('GET', '/_reach/operator/api-keys', self.session_headers()), 404)
        status, body, _ = self.call('GET', '/_reach/account-api-keys?offset=100')
        self.assertEqual(status, 200)
        self.assertEqual(self.requests[-1]['path'], '/_reach/operator/api-keys?offset=100')
        self.assertNotIn('X-Reach-Client-IP', self.requests[-1]['headers'])
        self.assertNotIn('never forward', body.decode())
        self.assertEqual(json.loads(body)['data'][0]['name'], 'Website key')

    def test_hosted_service_disables_anonymous_remote_bypass_even_with_legacy_setting(self):
        self.state.cfg["access"]["key_required"] = False
        self.assertEqual(self.status("GET", "/v1/models", TUNNEL), 401)
        self.assertEqual(self.status("GET", "/v1/models", {}), 200)

    def test_wallet_assets_and_account_routes_do_not_need_legacy_keys(self):
        for path in ("/wallet/connect", "/wallet/redeem", "/wallet/app.js", "/wallet/email.js", "/wallet/style.css",
                     "/wallet/rch", "/wallet/rch-logo.png", "/wallet/rch-tokenlist.json",
                     "/wallet/rch-add-token.js", "/v1/account/config", "/billing/return"):
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

    def test_stripe_webhook_body_and_signature_reach_the_account_service_unchanged(self):
        body = b'{"id": "evt_1",  "type":"invoice.paid"}'
        headers = {**TUNNEL, "Content-Type": "application/json; charset=utf-8",
                   "Stripe-Signature": "t=1,v1=abc", "X-Reach-Key": "owner-key"}
        status, _, _ = self.call("POST", "/v1/billing/stripe/webhook", headers, body)
        self.assertEqual(status, 200)
        sent = self.requests[-1]
        self.assertEqual(sent["path"], "/v1/billing/stripe/webhook")
        self.assertEqual(sent["body"], body)
        self.assertEqual(sent["headers"]["Stripe-Signature"], "t=1,v1=abc")
        self.assertNotIn("X-Reach-Key", sent["headers"])

    def test_paypal_webhook_transmission_headers_reach_the_account_service(self):
        body = b'{"id":"WH-1","event_type":"PAYMENT.CAPTURE.COMPLETED"}'
        transmission = {"PayPal-Auth-Algo": "SHA256withRSA", "PayPal-Cert-Url": "https://api.paypal.com/cert",
                        "PayPal-Transmission-Id": "t-1", "PayPal-Transmission-Sig": "sig", "PayPal-Transmission-Time": "2026-10-04T00:00:00Z"}
        status, _, _ = self.call("POST", "/v1/billing/paypal/webhook", {**TUNNEL, "Content-Type": "application/json", **transmission}, body)
        self.assertEqual(status, 200)
        sent = self.requests[-1]
        self.assertEqual(sent["body"], body)
        for name, value in transmission.items():
            self.assertEqual(sent["headers"][name], value)
        status, _, _ = self.call("GET", "/v1/billing/paypal/return?token=ORDER123&PayerID=P1", TUNNEL)
        self.assertEqual(status, 200)
        self.assertEqual(self.requests[-1]["path"], "/v1/billing/paypal/return?token=ORDER123&PayerID=P1")

    def test_billing_routes_are_forwarded_with_the_customer_session(self):
        for method, path in (("POST", "/v1/billing/checkout"), ("POST", "/v1/billing/portal"), ("GET", "/v1/billing/payments"),
                             ("POST", "/v1/auth/email/start"), ("POST", "/v1/auth/email/verify")):
            with self.subTest(path=path):
                status, _, _ = self.call(method, path, self.session_headers(**({"Content-Type": "application/json"} if method == "POST" else {})),
                                         b'{"kind":"subscription"}' if method == "POST" else None)
                self.assertEqual(status, 200)
                self.assertEqual(self.requests[-1]["path"], path)
                self.assertEqual(self.requests[-1]["headers"]["Authorization"], "Bearer rch_session_example")

    def test_customer_models_and_completions_never_reach_legacy_auth_or_generation(self):
        with patch("reachd.handler.RelayHandler._check_access", side_effect=AssertionError("legacy access")), \
             patch("reachd.handler.chat_execute", side_effect=AssertionError("legacy generation")):
            for path in ("/v1/models", "/models", "/api/v1/models"):
                self.assertEqual(self.status("GET", path, self.session_headers()), 200)
                self.assertEqual(self.requests[-1]["path"], "/v1/models")
            for path in ("/v1/chat/completions", "/chat/completions", "/api/v1/chat/completions"):
                self.assertEqual(self.status("POST", path, self.session_headers(), b'{}'), 200)
                self.assertEqual(self.requests[-1]["path"], "/v1/chat/completions")
                self.assertEqual(self.requests[-1]["headers"]["Authorization"], "Bearer rch_session_example")

    def test_account_response_preserves_service_origin_policy(self):
        self.reply_headers["Access-Control-Allow-Origin"] = "https://signalreach.com"
        self.reply_headers["Vary"] = "Origin"
        status, _, reply = self.call("GET", "/v1/account/config", {**TUNNEL, "Origin": "https://signalreach.com"})
        self.assertEqual(status, 200)
        self.assertEqual(reply.getheader("Access-Control-Allow-Origin"), "https://signalreach.com")
        self.assertEqual(reply.getheader("Vary"), "Origin")

    def test_website_preflight_allows_ngrok_header(self):
        status, _, reply = self.call("OPTIONS", "/v1/auth/start", {
            **TUNNEL, "Origin": "http://127.0.0.1:4173",
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "content-type,ngrok-skip-browser-warning",
        })
        self.assertEqual(status, 204)
        self.assertIn("ngrok-skip-browser-warning", reply.getheader("Access-Control-Allow-Headers").lower())

    def test_onboarding_wallet_link_reaches_account_service(self):
        self.assertEqual(self.status("POST", "/v1/account/link-wallet", self.session_headers(), b'{}'), 200)
        self.assertEqual(self.requests[-1]["path"], "/v1/account/link-wallet")

    def test_api_key_management_routes_reach_account_service(self):
        for method, path in (("GET", "/v1/account/api-keys"), ("POST", "/v1/account/api-keys"),
                             ("POST", "/v1/account/api-keys/revoke")):
            self.assertEqual(self.status(method, path, self.session_headers(), b'{}' if method == "POST" else None), 200)
            self.assertEqual(self.requests[-1]["path"], path)

    def test_api_keys_use_customer_gateway_not_owner_bypass(self):
        with patch("reachd.handler.RelayHandler._check_access", side_effect=AssertionError("legacy access")), \
             patch("reachd.handler.chat_execute", side_effect=AssertionError("legacy generation")):
            headers = {"Authorization": "Bearer rch_key_example"}
            for path in ("/v1/models", "/api/v1/models?client=lemonade"):
                self.assertEqual(self.status("GET", path, headers), 200)
                self.assertEqual(self.requests[-1]["path"], "/v1/models" + ("?client=lemonade" if "?" in path else ""))
            for path in ("/v1/chat/completions", "/api/v1/chat/completions"):
                self.assertEqual(self.status("POST", path, headers, b'{}'), 200)
                self.assertEqual(self.requests[-1]["path"], "/v1/chat/completions")
            self.assertEqual(self.requests[-1]["headers"]["Authorization"], "Bearer rch_key_example")

    def test_direct_loopback_customer_still_cannot_use_local_owner_bypass(self):
        self.reply_status = 401
        self.reply_body = b'{"error":{"code":"session_required"}}'
        status, data, _ = self.call("GET", "/api/v1/models", {"Authorization": "Bearer rch_session_invalid"})
        self.assertEqual(status, 401)
        self.assertIn(b"session_required", data)
        self.assertEqual(len(self.requests), 1)

    def test_existing_owner_key_stays_on_original_catalog(self):
        status, data, _ = self.call("GET", "/v1/models", self.bearer(**TUNNEL))
        self.assertEqual(status, 200)
        self.assertIn(b'"object": "list"', data)
        self.assertFalse(self.requests)

    def test_api_v1_aliases_preserve_owner_auth_and_do_not_alias_private_routes(self):
        self.assertEqual(self.status("GET", "/api/v1/models", TUNNEL), 401)
        self.assertEqual(self.status("GET", "/api/v1/models", self.bearer(**TUNNEL)), 200)
        self.assertEqual(self.status("POST", "/api/v1/chat/completions", TUNNEL, b'{}'), 401)
        with patch("reachd.handler.chat_execute", side_effect=lambda h, **_: h._json(200, {"ok": True})) as chat:
            self.assertEqual(self.status("POST", "/api/v1/chat/completions", self.bearer(**TUNNEL), b'{}'), 200)
            chat.assert_called_once()
        for path in ("/api/v1/account", "/api/v1/auth/start", "/api/v1/models/extra", "/api/v1/_reach/settings"):
            self.assertEqual(self.status("GET", path, self.session_headers()), 404)
        self.assertFalse(self.requests)

    def test_lemonade_probe_and_model_availability_do_not_expose_private_models(self):
        for headers in (TUNNEL, self.session_headers()):
            status, raw, _ = self.call("GET", "/live", headers)
            self.assertEqual(status, 200)
            self.assertEqual(json.loads(raw), {"status": "ok"})
        self.assertFalse(self.requests)
        for path in ("/v1/models", "/api/v1/models"):
            headers = self.bearer(**TUNNEL)
            status, raw, _ = self.call("GET", path, headers)
            self.assertEqual(status, 200)
            canonical = json.loads(raw)["data"]
            self.assertTrue(all("downloaded" not in model for model in canonical))
            status, raw, _ = self.call("GET", path + "?show_all=true", headers)
            self.assertEqual(status, 200)
            available = json.loads(raw)["data"]
            self.assertEqual([m["id"] for m in available], [m["id"] for m in canonical])
            self.assertNotIn("minicpm5-2b", [m["id"] for m in available])
            self.assertTrue(all(m["downloaded"] is True for m in available))
            self.assertEqual(self.status("GET", path + "?show_all=true", TUNNEL), 401)

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
        for path in ("/v1/chat/completions", "/api/v1/chat/completions"):
            status, data, reply = self.call("POST", path, self.session_headers(), b'{}')
            self.assertEqual(status, 200)
            self.assertEqual(data, self.reply_body)
            self.assertEqual(reply.getheader("Content-Type"), "text/event-stream")
            self.assertEqual(reply.getheader("Transfer-Encoding"), "chunked")

    def test_account_route_allowlist_cannot_proxy_other_paths(self):
        for path in ("/wallet/../../healthz", "/v1/account/config/extra", "/healthz", "/v1/auth/admin",
                     "/v1/billing", "/v1/billing/stripe", "/billing/return/../admin"):
            with self.subTest(path=path):
                self.assertEqual(self.status("GET", path, TUNNEL), 404)
        self.assertFalse(self.requests)

    def test_app_oauth_routes_reach_only_the_account_service(self):
        for provider in ("notion", "slack", "discord"):
            for action in ("start", "exchange", "refresh", "cancel"):
                path = f"/oauth/{provider}/{action}"
                self.assertEqual(self.status("POST", path, TUNNEL, b'{}'), 200)
                self.assertEqual(self.requests[-1]["path"], path)
            path = f"/oauth/{provider}/callback?state=fixture&code=fixture"
            self.assertEqual(self.status("GET", path, TUNNEL), 200)
            self.assertEqual(self.requests[-1]["path"], path)
        self.assertEqual(self.status("GET", "/oauth/notion/admin", TUNNEL), 404)
        for action in ("chat-poll", "chat-reply", "chat-close"):
            path = f"/oauth/discord/{action}"
            self.assertEqual(self.status("POST", path, TUNNEL, b'{}'), 200)
            self.assertEqual(self.requests[-1]["path"], path)
        self.assertEqual(self.status("POST", "/oauth/discord/chat-admin", TUNNEL, b'{}'), 404)

    def test_oversized_post_is_rejected_without_dispatch(self):
        status, data, _ = self.call("POST", "/v1/auth/start", {**TUNNEL, "Content-Length": "524289"})
        self.assertEqual(status, 413)
        self.assertFalse(self.requests)


class AccountProxyCancellationTests(RelayFixture):
    def cancellation(self, headers_first):
        arrived, disconnected, finish = threading.Event(), threading.Event(), threading.Event()

        class PendingAccountsHandler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, *_):
                pass

            def do_POST(self):
                self.rfile.read(int(self.headers.get("Content-Length", "0")))
                if headers_first:
                    self.send_response(200)
                    self.send_header("Content-Type", "application/json")
                    self.send_header("Content-Length", "100000")
                    self.end_headers()
                    self.wfile.write(b"{")
                    self.wfile.flush()
                arrived.set()
                self.connection.settimeout(0.1)
                while not finish.is_set():
                    try:
                        if not self.connection.recv(1):
                            disconnected.set()
                            return
                    except socket.timeout:
                        continue
                    except OSError:
                        disconnected.set()
                        return

        accounts = ThreadingHTTPServer(("127.0.0.1", 0), PendingAccountsHandler)
        threading.Thread(target=lambda: accounts.serve_forever(poll_interval=0.02), daemon=True).start()
        self.state.cfg["account_service_url"] = "http://127.0.0.1:%d" % accounts.server_address[1]
        client = socket.create_connection(("127.0.0.1", self.port), timeout=2)
        try:
            body = b'{"model":"fixture","messages":[{"role":"user","content":"hello"}]}'
            request = ("POST /v1/chat/completions HTTP/1.1\r\nHost: 127.0.0.1\r\n"
                       "Authorization: Bearer rch_session_fixture\r\nContent-Type: application/json\r\n"
                       "Content-Length: %d\r\n\r\n" % len(body)).encode() + body
            client.sendall(request)
            self.assertTrue(arrived.wait(2), "Mock model request never arrived")
            self.assertFalse(disconnected.is_set())
            started = time.monotonic()
            client.close()
            self.assertTrue(disconnected.wait(1), "Relay left the upstream model request running after Stop")
            self.assertLess(time.monotonic() - started, 1)
        finally:
            client.close()
            finish.set()
            accounts.shutdown()
            accounts.server_close()

    def test_disconnect_cancels_actual_upstream_while_response_headers_pending(self):
        self.cancellation(headers_first=False)

    def test_disconnect_cancels_actual_upstream_while_response_body_pending(self):
        self.cancellation(headers_first=True)


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
