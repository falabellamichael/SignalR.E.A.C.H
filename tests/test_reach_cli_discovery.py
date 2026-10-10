"""Offline discovery regressions using owned loopback HTTP endpoints."""

import contextlib
import io
import json
import os
import socket
import sys
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest import mock

TOOLS = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "tools")
sys.path.insert(0, TOOLS)

from reach_cli.discovery import (MAX_MODELS, MAX_RESPONSE_BYTES, ModelDiscovery,
                                 ModelDiscoveryError, fetch_models)


class MockEndpoint:
    def __init__(self):
        self.requests = []
        self.lock = threading.Lock()
        self.response = {"data": [{"id": "owned-model"}]}
        self.status = 200
        self.headers = {}
        self.before_response = None
        self.secret = ""
        endpoint = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_GET(self):
                with endpoint.lock:
                    auth = self.headers.get("Authorization", "")
                    endpoint.requests.append({"path": self.path,
                                              "authorized": bool(auth),
                                              "credential_matches": auth == "Bearer " + endpoint.secret})
                    response = endpoint.response
                    status = endpoint.status
                    headers = dict(endpoint.headers)
                    before = endpoint.before_response
                if before:
                    before(self)
                raw = response if isinstance(response, bytes) else json.dumps(response).encode("utf-8")
                try:
                    self.send_response(status)
                    self.send_header("Content-Type", "application/json")
                    if "Content-Length" not in headers:
                        self.send_header("Content-Length", str(len(raw)))
                    for name, value in headers.items():
                        self.send_header(name, value)
                    self.end_headers()
                    self.wfile.write(raw)
                except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
                    pass

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.server.daemon_threads = True
        self.base = "http://127.0.0.1:%d/v1" % self.server.server_port
        self.thread = threading.Thread(target=self.server.serve_forever,
                                       kwargs={"poll_interval": 0.01}, daemon=True)
        self.thread.start()

    def close(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(1)

    def count(self):
        with self.lock:
            return len(self.requests)

    def wait_requests(self, count, timeout=1):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if self.count() >= count:
                return True
            threading.Event().wait(0.005)
        return False


class DiscoveryTransportTests(unittest.TestCase):
    def setUp(self):
        self.endpoint = MockEndpoint()
        self.addCleanup(self.endpoint.close)

    def test_only_models_get_and_credential_header(self):
        self.endpoint.secret = "owned-fake-key-unique-123"
        models = fetch_models(self.endpoint.base, self.endpoint.secret)
        self.assertEqual(models, ["owned-model"])
        self.assertEqual(self.endpoint.requests, [{"path": "/v1/models", "authorized": True,
                                                   "credential_matches": True}])

    def test_duplicates_and_untrusted_control_model_ids_are_filtered(self):
        self.endpoint.response = {"data": [{"id": value} for value in
            ("owned-model", "owned-model", "model-模型", "bad\x1b[2J", "bad\x85id",
             "bad\u202eid", "bad id", "\ud800", " x", "x" * 513, 7)]}
        self.assertEqual(fetch_models(self.endpoint.base), ["owned-model", "model-模型"])

    def test_provider_cannot_echo_credential_as_model(self):
        self.endpoint.secret = "owned-credential-123"
        self.endpoint.response = {"data": [{"id": "owned-model"},
                                           {"id": "prefix-" + self.endpoint.secret}]}
        self.assertEqual(fetch_models(self.endpoint.base, self.endpoint.secret), ["owned-model"])

    def test_empty_valid_catalog(self):
        self.endpoint.response = {"data": []}
        self.assertEqual(fetch_models(self.endpoint.base), [])

    def test_invalid_response_shapes_and_bytes(self):
        for response in ([{"id": "x"}], {}, {"data": {}}, {"data": "x"},
                         {"data": [{"id": "\x1b[2J"}]}, b"not json", b"\xff"):
            with self.subTest(response_type=type(response).__name__):
                self.endpoint.response = response
                with self.assertRaisesRegex(ModelDiscoveryError, "invalid|valid model"):
                    fetch_models(self.endpoint.base)

    def test_model_count_limit(self):
        self.endpoint.response = {"data": [{"id": "x"}] * (MAX_MODELS + 1)}
        with self.assertRaisesRegex(ModelDiscoveryError, "too many"):
            fetch_models(self.endpoint.base)

    def test_body_size_limit_known_length(self):
        self.endpoint.response = b"x" * (MAX_RESPONSE_BYTES + 1)
        with self.assertRaisesRegex(ModelDiscoveryError, "too large"):
            fetch_models(self.endpoint.base)

    def test_body_size_limit_unknown_length(self):
        self.endpoint.response = b"x" * (MAX_RESPONSE_BYTES + 1)
        self.endpoint.headers["Content-Length"] = "invalid"
        with self.assertRaisesRegex(ModelDiscoveryError, "too large"):
            fetch_models(self.endpoint.base)

    def test_authorization_errors_do_not_expose_body_or_key(self):
        secret = "owned-error-credential-123"
        for status in (401, 403, 429, 500):
            with self.subTest(status=status):
                self.endpoint.status = status
                self.endpoint.response = {"error": {"message": secret + "\x1b[2JSECRET"}}
                with self.assertRaises(ModelDiscoveryError) as caught:
                    fetch_models(self.endpoint.base, secret)
                self.assertNotIn(secret, str(caught.exception))
                self.assertNotIn("\x1b", str(caught.exception))
                self.assertNotIn("SECRET", str(caught.exception))

    def test_redirect_does_not_forward_auth_or_contact_destination(self):
        target = MockEndpoint()
        self.addCleanup(target.close)
        self.endpoint.status = 302
        self.endpoint.headers["Location"] = target.base + "/models"
        with self.assertRaisesRegex(ModelDiscoveryError, "refuses redirects"):
            fetch_models(self.endpoint.base, "owned-redirect-key")
        self.assertEqual(self.endpoint.count(), 1)
        self.assertEqual(target.count(), 0)

    def test_invalid_url_and_header_inputs_make_no_request(self):
        for base in ("file:///tmp/no", "http://user:key@example.test", "http://host/?key=x",
                     "http://host/#x", "http://host/%1b[2J", "http://host:99999", None):
            with self.subTest(base_type=type(base).__name__):
                with self.assertRaises(ModelDiscoveryError):
                    fetch_models(base)
        for credential in ("owned\r\nInjected: yes", "owned-\u202e", "x" * 8193):
            with self.assertRaisesRegex(ModelDiscoveryError, "credential is invalid"):
                fetch_models(self.endpoint.base, credential)
        self.assertEqual(self.endpoint.count(), 0)

    def test_direct_transport_timeout_is_bounded(self):
        release = threading.Event()
        self.addCleanup(release.set)
        self.endpoint.before_response = lambda _handler: release.wait(1)
        started = time.monotonic()
        with self.assertRaisesRegex(ModelDiscoveryError, "timed out"):
            fetch_models(self.endpoint.base, timeout=0.08)
        self.assertLess(time.monotonic() - started, 0.5)

    def test_offline_loopback_error_is_actionable(self):
        with socket.socket() as owned_socket:
            owned_socket.bind(("127.0.0.1", 0))
            port = owned_socket.getsockname()[1]
        with self.assertRaisesRegex(ModelDiscoveryError, "unavailable|timed out"):
            fetch_models("http://127.0.0.1:%d/v1" % port, timeout=0.1)


class DiscoveryManagerTests(unittest.TestCase):
    def setUp(self):
        self.endpoint = MockEndpoint()
        self.addCleanup(self.endpoint.close)
        self.manager = ModelDiscovery()
        self.addCleanup(self.manager.close, True)

    def ready(self, manager=None, key="", key_ref=""):
        manager = manager or self.manager
        manager.refresh(self.endpoint.base, key=key, key_ref=key_ref)
        result = manager.wait(self.endpoint.base, key_ref=key_ref)
        self.assertEqual(result["status"], "ready", result)
        return result

    def test_refresh_is_nonblocking_and_concurrent_calls_share_one_get(self):
        release = threading.Event()
        self.addCleanup(release.set)
        self.endpoint.before_response = lambda _handler: release.wait(1)
        started = time.monotonic()
        first = self.manager.refresh(self.endpoint.base)
        self.assertLess(time.monotonic() - started, 0.1)
        self.assertEqual(first["status"], "loading")
        self.assertTrue(self.endpoint.wait_requests(1))
        results = []
        threads = [threading.Thread(target=lambda: results.append(self.manager.refresh(self.endpoint.base)))
                   for _ in range(12)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(1)
        self.assertEqual({result["request_id"] for result in results}, {first["request_id"]})
        self.assertEqual(self.endpoint.count(), 1)
        release.set()
        self.assertEqual(self.manager.wait(self.endpoint.base)["status"], "ready")

    def test_every_sequential_refresh_performs_one_get(self):
        request_ids = []
        for _ in range(5):
            result = self.ready()
            request_ids.append(result["request_id"])
        self.assertEqual(self.endpoint.count(), 5)
        self.assertEqual(len(set(request_ids)), 5)

    def test_snapshot_and_wait_never_fetch(self):
        self.assertEqual(self.manager.snapshot(self.endpoint.base)["status"], "idle")
        self.assertEqual(self.manager.wait(self.endpoint.base)["status"], "idle")
        self.ready()
        for _ in range(5):
            self.manager.snapshot(self.endpoint.base)
            self.manager.wait(self.endpoint.base)
        self.assertEqual(self.endpoint.count(), 1)

    def test_snapshot_returns_independent_model_list(self):
        result = self.ready()
        result["models"].append("untrusted-caller-change")
        self.assertEqual(self.manager.snapshot(self.endpoint.base)["models"], ["owned-model"])

    def test_loading_and_failed_refresh_retain_stale_models(self):
        previous = self.ready()
        release = threading.Event()
        self.addCleanup(release.set)
        self.endpoint.status = 500
        self.endpoint.before_response = lambda _handler: release.wait(1)
        pending = self.manager.refresh(self.endpoint.base)
        self.assertEqual(pending["models"], previous["models"])
        self.assertTrue(pending["stale"])
        release.set()
        failure = self.manager.wait(self.endpoint.base)
        self.assertEqual(failure["status"], "error")
        self.assertEqual(failure["models"], previous["models"])
        self.assertEqual(failure["fetched_at"], previous["fetched_at"])
        self.assertTrue(failure["stale"])

    def test_first_failure_has_no_cached_results(self):
        self.endpoint.status = 401
        self.manager.refresh(self.endpoint.base)
        result = self.manager.wait(self.endpoint.base)
        self.assertEqual(result["status"], "error")
        self.assertFalse(result["stale"])
        self.assertEqual(result["models"], [])
        self.assertIn("credential", result["error"])

    def test_recovery_replaces_cache(self):
        self.ready()
        self.endpoint.status = 503
        self.manager.refresh(self.endpoint.base)
        self.manager.wait(self.endpoint.base)
        self.endpoint.status = 200
        self.endpoint.response = {"data": [{"id": "recovered-model"}]}
        recovered = self.ready()
        self.assertEqual(recovered["models"], ["recovered-model"])
        self.assertFalse(recovered["stale"])
        self.assertFalse(recovered["error"])

    def test_credentials_are_isolated_and_not_cache_keys(self):
        secret = "owned-cache-key-unique-123"
        self.ready(key=secret, key_ref="OWNED_KEY_ENV")
        self.assertEqual(self.manager.snapshot(self.endpoint.base)["status"], "idle")
        self.assertEqual(self.manager.snapshot(self.endpoint.base, "OWNED_KEY_ENV")["status"], "ready")
        self.assertNotIn(secret, repr(self.manager._cache))
        self.assertNotIn(secret, repr(self.manager._latest))
        self.assertNotIn("OWNED_KEY_ENV", repr(self.manager._cache))
        self.assertNotIn(secret, json.dumps(self.manager.snapshot(self.endpoint.base, "OWNED_KEY_ENV")))

    def test_changed_credential_does_not_reuse_other_generation_models(self):
        self.ready(key="owned-key-first", key_ref="OWNED_KEY_ENV")
        release = threading.Event()
        self.addCleanup(release.set)
        self.endpoint.before_response = lambda _handler: release.wait(1)
        result = self.manager.refresh(self.endpoint.base, key="owned-key-second", key_ref="OWNED_KEY_ENV")
        self.assertEqual(result["models"], [])
        self.assertFalse(result["stale"])
        release.set()
        self.assertEqual(self.manager.wait(self.endpoint.base, "OWNED_KEY_ENV")["status"], "ready")

    def test_exact_current_credential_snapshot_and_wait_avoid_rotated_key_cache(self):
        self.ready(key="owned-first", key_ref="OWNED_KEY_ENV")
        self.assertEqual(self.manager.snapshot(self.endpoint.base, "OWNED_KEY_ENV",
                                              key="owned-second")["status"], "idle")
        self.assertEqual(self.manager.wait(self.endpoint.base, "OWNED_KEY_ENV",
                                          key="owned-second")["status"], "idle")
        self.endpoint.response = {"data": [{"id": "second-model"}]}
        self.manager.refresh(self.endpoint.base, key="owned-second", key_ref="OWNED_KEY_ENV")
        result = self.manager.wait(self.endpoint.base, "OWNED_KEY_ENV", key="owned-second")
        self.assertEqual(result["models"], ["second-model"])
        self.assertEqual(self.manager.snapshot(self.endpoint.base, "OWNED_KEY_ENV",
                                              key="owned-first")["models"], ["owned-model"])
        self.assertEqual(self.endpoint.count(), 2)

    def test_public_and_subscription_aliases_coalesce_async_pointer(self):
        entered = threading.Event()
        release = threading.Event()
        self.addCleanup(release.set)
        resolver_calls = []

        def resolver(timeout):
            resolver_calls.append(timeout)
            entered.set()
            release.wait(1)
            return self.endpoint.base

        manager = ModelDiscovery(resolver=resolver)
        self.addCleanup(manager.close, True)
        started = time.monotonic()
        first = manager.refresh("subscription", key_ref="builtin")
        self.assertLess(time.monotonic() - started, 0.1)
        self.assertTrue(entered.wait(1))
        second = manager.refresh("PUBLIC", key_ref="builtin")
        self.assertEqual(first["request_id"], second["request_id"])
        release.set()
        self.assertEqual(manager.wait("public", "builtin")["models"], ["owned-model"])
        self.assertEqual(len(resolver_calls), 1)
        self.assertEqual(self.endpoint.count(), 1)

    def test_local_alias_and_url_share_cache(self):
        fetcher = mock.Mock(return_value=["local-model"])
        manager = ModelDiscovery(fetcher=fetcher)
        self.addCleanup(manager.close, True)
        manager.refresh("local")
        manager.wait("local")
        self.assertEqual(manager.snapshot("http://127.0.0.1:20777/v1/")["models"], ["local-model"])
        self.assertEqual(fetcher.call_count, 1)

    def test_default_ports_authority_case_and_trailing_slash_coalesce(self):
        release = threading.Event()
        entered = threading.Event()
        self.addCleanup(release.set)

        def fetcher(base, key, timeout):
            entered.set()
            release.wait(1)
            return ["owned-model"]

        manager = ModelDiscovery(fetcher=fetcher)
        self.addCleanup(manager.close, True)
        first = manager.refresh("HTTP://EXAMPLE.TEST:80/v1/")
        self.assertTrue(entered.wait(1))
        other = manager.refresh("http://example.test/v1")
        self.assertEqual(first["request_id"], other["request_id"])
        release.set()

    def test_public_pointer_invalid_or_unavailable_is_honest_failure(self):
        for pointer in (None, "file:///tmp/owned", "http://x/%1b[2J", "public"):
            with self.subTest(pointer_type=type(pointer).__name__):
                fetcher = mock.Mock(return_value=["must-not-fetch"])
                manager = ModelDiscovery(fetcher=fetcher, resolver=lambda timeout: pointer)
                self.addCleanup(manager.close, True)
                manager.refresh("public")
                result = manager.wait("public")
                self.assertEqual(result["status"], "error")
                self.assertEqual(fetcher.call_count, 0)

    def test_wait_and_snapshot_expire_wall_clock_without_blocking_stalled_worker(self):
        release = threading.Event()
        entered = threading.Event()
        self.addCleanup(release.set)

        def fetcher(base, key, timeout):
            entered.set()
            release.wait(1)
            return ["late-model"]

        manager = ModelDiscovery(fetcher=fetcher)
        self.addCleanup(manager.close, True)
        manager.refresh(self.endpoint.base, timeout=0.06)
        self.assertTrue(entered.wait(1))
        started = time.monotonic()
        result = manager.wait(self.endpoint.base, timeout=0.5)
        self.assertLess(time.monotonic() - started, 0.2)
        self.assertEqual(result["status"], "error")
        self.assertIn("timed out", result["error"])
        self.assertEqual(manager.refresh(self.endpoint.base)["request_id"], result["request_id"])
        release.set()
        manager.reset(wait=True)
        self.assertEqual(manager.snapshot(self.endpoint.base)["status"], "idle")

    def test_late_timeout_result_cannot_replace_cache(self):
        release = threading.Event()
        entered = threading.Event()
        self.addCleanup(release.set)

        def fetcher(base, key, timeout):
            entered.set()
            release.wait(1)
            return ["late-model"]

        manager = ModelDiscovery(fetcher=fetcher)
        self.addCleanup(manager.close, True)
        manager.refresh(self.endpoint.base, timeout=0.05)
        self.assertTrue(entered.wait(1))
        timed_out = manager.wait(self.endpoint.base, timeout=0.5)
        release.set()
        with manager._condition:
            manager._condition.wait_for(lambda: not manager._jobs, timeout=1)
        self.assertEqual(manager.snapshot(self.endpoint.base), timed_out)

    def test_close_suppresses_late_result_and_cannot_reopen(self):
        release = threading.Event()
        entered = threading.Event()
        self.addCleanup(release.set)

        def fetcher(base, key, timeout):
            entered.set()
            release.wait(1)
            return ["late-model"]

        manager = ModelDiscovery(fetcher=fetcher)
        manager.refresh(self.endpoint.base)
        self.assertTrue(entered.wait(1))
        manager.close()
        release.set()
        manager.close(wait=True)
        self.assertEqual(manager.snapshot(self.endpoint.base)["status"], "idle")
        self.assertEqual(manager.refresh(self.endpoint.base)["status"], "error")

    def test_reset_suppresses_old_epoch_and_accepts_new_generation(self):
        release = threading.Event()
        entered = threading.Event()
        self.addCleanup(release.set)

        def fetcher(base, key, timeout):
            if key == "owned-first":
                entered.set()
                release.wait(1)
                return ["old-model"]
            return ["new-model"]

        manager = ModelDiscovery(fetcher=fetcher)
        self.addCleanup(manager.close, True)
        manager.refresh(self.endpoint.base, key="owned-first")
        self.assertTrue(entered.wait(1))
        manager.reset()
        manager.refresh(self.endpoint.base, key="owned-second")
        current = manager.wait(self.endpoint.base)
        release.set()
        with manager._condition:
            manager._condition.wait_for(lambda: not manager._jobs, timeout=1)
        self.assertEqual(current["models"], ["new-model"])
        self.assertEqual(manager.snapshot(self.endpoint.base), current)

    def test_changed_generation_late_worker_does_not_replace_current_scope(self):
        release = threading.Event()
        entered = threading.Event()
        self.addCleanup(release.set)

        def fetcher(base, key, timeout):
            if key == "owned-first":
                entered.set()
                release.wait(1)
                return ["first-model"]
            return ["second-model"]

        manager = ModelDiscovery(fetcher=fetcher)
        self.addCleanup(manager.close, True)
        manager.refresh(self.endpoint.base, key="owned-first", key_ref="OWNED")
        self.assertTrue(entered.wait(1))
        manager.refresh(self.endpoint.base, key="owned-second", key_ref="OWNED")
        result = manager.wait(self.endpoint.base, "OWNED")
        release.set()
        with manager._condition:
            manager._condition.wait_for(lambda: not manager._jobs, timeout=1)
        self.assertEqual(result["models"], ["second-model"])
        self.assertEqual(manager.snapshot(self.endpoint.base, "OWNED"), result)

    def test_worker_cap_prevents_unbounded_stalled_threads(self):
        release = threading.Event()
        entered = threading.Event()
        self.addCleanup(release.set)
        fetcher_calls = []

        def fetcher(base, key, timeout):
            fetcher_calls.append(base)
            entered.set()
            release.wait(1)
            return ["owned-model"]

        manager = ModelDiscovery(fetcher=fetcher, max_workers=1)
        self.addCleanup(manager.close, True)
        manager.refresh(self.endpoint.base)
        self.assertTrue(entered.wait(1))
        for index in range(10):
            result = manager.refresh("http://127.0.0.1:%d/v1" % (30000 + index))
            self.assertEqual(result["status"], "busy")
        self.assertEqual(len(fetcher_calls), 1)
        self.assertEqual(len(manager._jobs), 1)
        release.set()

    def test_cache_is_bounded(self):
        manager = ModelDiscovery(fetcher=lambda base, key, timeout: ["owned-model"],
                                 max_workers=1, max_entries=3)
        self.addCleanup(manager.close, True)
        for index in range(12):
            base = "http://127.0.0.1:%d/v1" % (30000 + index)
            manager.refresh(base)
            manager.wait(base)
        self.assertLessEqual(len(manager._cache), 3)
        self.assertLessEqual(len(manager._latest), 3)

    def test_fetched_catalog_becomes_stale_by_age(self):
        self.ready()
        with mock.patch("reach_cli.discovery.time.time", return_value=time.time() + 301):
            self.assertTrue(self.manager.snapshot(self.endpoint.base)["stale"])

    def test_worker_errors_and_stdout_never_leak_credentials(self):
        secret = "owned-unique-worker-key"

        def fetcher(base, key, timeout):
            raise ModelDiscoveryError("provider echoed " + key + "\x1b[2J")

        manager = ModelDiscovery(fetcher=fetcher)
        self.addCleanup(manager.close, True)
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            manager.refresh(self.endpoint.base, key=secret)
            result = manager.wait(self.endpoint.base)
        self.assertEqual(output.getvalue(), "")
        self.assertNotIn(secret, json.dumps(result))
        self.assertNotIn("\x1b", result["error"])

    def test_injected_nonempty_invalid_catalog_does_not_mark_ready(self):
        manager = ModelDiscovery(fetcher=lambda base, key, timeout: ["\x1b[2J", key])
        self.addCleanup(manager.close, True)
        manager.refresh(self.endpoint.base, key="owned-only-credential")
        result = manager.wait(self.endpoint.base)
        self.assertEqual(result["status"], "error")
        self.assertEqual(result["models"], [])
        self.assertNotIn("owned-only-credential", json.dumps(result))

    def test_failed_thread_start_does_not_leak_worker_slot(self):
        with mock.patch("reach_cli.discovery.threading.Thread.start", side_effect=RuntimeError("owned")):
            result = self.manager.refresh(self.endpoint.base)
        self.assertEqual(result["status"], "error")
        self.assertEqual(self.manager._jobs, {})
        self.assertEqual(self.manager._inflight, {})
        self.ready()

    def test_invalid_refresh_is_safe_and_does_not_launch_worker(self):
        result = self.manager.refresh("http://owned/%1b[2Jsecret")
        self.assertEqual(result["status"], "error")
        self.assertNotIn("secret", result["error"])
        self.assertEqual(self.endpoint.count(), 0)
        self.assertEqual(len(self.manager._jobs), 0)
        for credential in (None, "\ud800", "owned\r\nInjected", "x" * 8193):
            with self.subTest(credential_type=type(credential).__name__):
                result = self.manager.refresh(self.endpoint.base, key=credential)
                self.assertEqual(result["status"], "error")
                self.assertEqual(len(self.manager._jobs), 0)


if __name__ == "__main__":
    unittest.main()
