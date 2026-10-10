"""Regression coverage for relay connectivity probes and their handler facade."""

import io
import json
import sys
import unittest
import urllib.error
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock, Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "server"))

import reachd.core as core
from reachd.handler import RelayHandler


class ConnectivityProbeTests(unittest.TestCase):
    def setUp(self):
        self.handler = MagicMock(spec=RelayHandler)
        self.state = SimpleNamespace(
            public_models=Mock(return_value={"sample": "provider/sample"}),
            enabled_models=Mock(return_value={}),
            omniroute_url="http://127.0.0.1:20128/v1/",
            bridge_url="http://127.0.0.1:18080/v1/",
            key="upstream-test-placeholder",
            public_url="https://relay.example/",
            cfg={"access": {}},
        )

    @staticmethod
    def response(payload):
        response = MagicMock()
        response.status = 200
        response.read.return_value = json.dumps(payload).encode("utf-8")
        response.__enter__.return_value = response
        return response

    def test_no_models_returns_503_without_opening_a_connection(self):
        self.state.public_models.return_value = {}
        with patch.object(core, "STATE", self.state), \
             patch("reachd.handler.net.urlopen") as opener:
            RelayHandler.handle_upstream_test(self.handler)
        opener.assert_not_called()
        self.handler._json.assert_called_once_with(
            503, {"ok": False, "error": "no enabled models configured"})

    def test_mixed_models_prefer_omniroute_with_auth_and_handler_time_patch(self):
        self.state.public_models.return_value = {
            "bridge": "bridge/browser", "remote": "provider/remote"}
        response = self.response({"choices": [{"message": {"content": "REACH OK"}}]})
        with patch.object(core, "STATE", self.state), \
             patch("reachd.handler.net.urlopen", return_value=response) as opener, \
             patch("reachd.handler.time.time", side_effect=[100, 100.25]):
            RelayHandler.handle_upstream_test(self.handler)
        request = opener.call_args.args[0]
        self.assertEqual(request.full_url, "http://127.0.0.1:20128/v1/chat/completions")
        self.assertEqual(request.get_header("Authorization"), "Bearer upstream-test-placeholder")
        self.assertEqual(json.loads(request.data)["model"], "provider/remote")
        self.assertEqual(opener.call_args.kwargs, {"timeout": 60})
        self.state.enabled_models.assert_not_called()
        self.handler._json.assert_called_once_with(
            200, {"ok": True, "reply": "REACH OK",
                  "latency_ms": 250, "model": "provider/remote"})

    def test_bridge_only_fallback_strips_prefix_and_omits_bearer_auth(self):
        self.state.public_models.return_value = {}
        self.state.enabled_models.return_value = {"private": "bridge/browser"}
        response = self.response({"choices": [{"message": {"content": "bridge ready"}}]})
        with patch.object(core, "STATE", self.state), \
             patch("reachd.handler.net.urlopen", return_value=response) as opener:
            RelayHandler.handle_upstream_test(self.handler)
        request = opener.call_args.args[0]
        self.assertEqual(request.full_url, "http://127.0.0.1:18080/v1/chat/completions")
        self.assertIsNone(request.get_header("Authorization"))
        self.assertEqual(json.loads(request.data)["model"], "browser")
        self.assertEqual(self.handler._json.call_args.args[0], 200)
        self.assertEqual(self.handler._json.call_args.args[1]["model"], "bridge/browser")

    def test_upstream_http_failure_keeps_status_and_bounds_error_body(self):
        failure = urllib.error.HTTPError(
            "http://127.0.0.1:20128/v1/chat/completions", 429,
            "Too Many Requests", {}, io.BytesIO(b"x" * 400))
        self.addCleanup(failure.close)
        with patch.object(core, "STATE", self.state), \
             patch("reachd.handler.net.urlopen", side_effect=failure):
            RelayHandler.handle_upstream_test(self.handler)
        self.handler._json.assert_called_once_with(
            502, {"ok": False, "error": "x" * 300, "status": 429})

    def test_handler_resolves_replaced_state_for_each_probe(self):
        response = self.response({"choices": []})
        replacement = SimpleNamespace(**vars(self.state))
        replacement.public_models = Mock(return_value={"other": "provider/other"})
        with patch("reachd.handler.net.urlopen", return_value=response) as opener:
            with patch.object(core, "STATE", self.state):
                RelayHandler.handle_upstream_test(self.handler)
            with patch.object(core, "STATE", replacement):
                RelayHandler.handle_upstream_test(self.handler)
        models = [json.loads(call.args[0].data)["model"] for call in opener.call_args_list]
        self.assertEqual(models, ["provider/sample", "provider/other"])

    def test_diagnose_uses_handler_expiry_patch_and_public_system_opener(self):
        candidate = {"name": "candidate", "key": "client-test-placeholder"}
        self.state.cfg = {"access": {
            "keys": [candidate], "access_key": "legacy-test-placeholder"}}
        health = self.response({"ok": True, "service": "SignalR.E.A.C.H", "version": "test"})
        chat = self.response({"choices": [{"message": {"content": "REACH OK"}}]})
        with patch.object(core, "STATE", self.state), \
             patch("reachd.handler.key_expired", return_value=True) as expired, \
             patch("reachd.handler.urllib.request.urlopen", side_effect=[health, chat]) as opener, \
             patch("reachd.handler.net.urlopen") as local_opener:
            RelayHandler.handle_diagnose(self.handler)
        expired.assert_called_once_with(candidate)
        local_opener.assert_not_called()
        health_request, chat_request = [call.args[0] for call in opener.call_args_list]
        self.assertEqual(health_request.full_url, "https://relay.example/health")
        self.assertIsNone(health_request.get_header("Authorization"))
        self.assertEqual(chat_request.full_url, "https://relay.example/v1/chat/completions")
        self.assertEqual(chat_request.get_header("Authorization"), "Bearer legacy-test-placeholder")
        self.assertEqual(json.loads(chat_request.data)["model"], "sample")
        self.assertEqual([call.kwargs["timeout"] for call in opener.call_args_list], [20, 60])
        status, payload = self.handler._json.call_args.args
        self.assertEqual(status, 200)
        self.assertTrue(payload["ok"])
        self.assertEqual([check["name"] for check in payload["checks"]],
                         ["tls_and_headers", "relay_health", "chat_completion"])


if __name__ == "__main__":
    unittest.main()

