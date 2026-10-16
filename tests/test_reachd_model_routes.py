"""Private model dispatch, usage accounting, and local operator controls."""
import copy
import json
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "server"))

from reachd import model_routes, model_services
from tests.test_reachd_access import RelayFixture, TUNNEL


class PrivateModelRouteTests(unittest.TestCase):
    def test_gpu_dispatch_preserves_input_and_requests_real_usage(self):
        for alias, (repository, port, *_rest) in model_routes.GPU_MODELS.items():
            for options in (None, {}, {"include_usage": False, "continuous_usage_stats": True}):
                with self.subTest(alias=alias, options=options):
                    payload = {"model": alias, "messages": [{"role": "user", "content": "hello"}],
                               "temperature": 0.7, "top_p": 0.9, "stream": True,
                               "max_completion_tokens": 256}
                    if options is not None:
                        payload["stream_options"] = options
                    before = copy.deepcopy(payload)
                    url, body, headers, circuit = model_routes.dispatch("gpu/" + alias, payload, None)
                    self.assertEqual(payload, before)
                    self.assertEqual(url, "http://127.0.0.1:%d/v1/chat/completions" % port)
                    self.assertEqual(body["model"], repository)
                    self.assertEqual(body["max_tokens"], 256)
                    self.assertEqual(body["temperature"], 0.7)
                    self.assertEqual(body["top_p"], 0.9)
                    self.assertTrue(body["stream_options"]["include_usage"])
                    if options and "continuous_usage_stats" in options:
                        self.assertTrue(body["stream_options"]["continuous_usage_stats"])
                    self.assertEqual(headers, {"Content-Type": "application/json"})
                    self.assertEqual(circuit, "gpu/" + alias)

    def test_private_selectors_are_fixed_and_granite_is_retired(self):
        for value in ("gpu/granite-4.2-3b-fp8", "gpu/http://example.invalid", "direct/unknown"):
            with self.subTest(value=value), self.assertRaises(ValueError):
                model_routes.private_route(value)
        defaults = model_routes.deployment_defaults({})
        self.assertFalse(any("granite" in name for name in defaults))
        for alias in ("gemma-4-12b-qat", "ornith-1.5-9b"):
            self.assertIn("TP2", defaults[alias]["description"])
        self.assertIn("FP8 (BF16 vision)", defaults["ornith-1.5-9b"]["description"])

    def test_nonstreaming_and_legacy_route_contracts_stay_distinct(self):
        _, body, _, _ = model_routes.dispatch("gpu/minicpm5-2b", {"stream": False}, None)
        self.assertNotIn("stream_options", body)
        state = SimpleNamespace(key="fixture-upstream", bridge_url="http://127.0.0.1:12345/v1",
                                omniroute_url="https://provider.example/v1")
        _, _, bridge_headers, _ = model_routes.dispatch("bridge/chatgpt-chat", {}, state)
        _, _, upstream_headers, _ = model_routes.dispatch("provider/model", {}, state)
        _, direct, private_headers, _ = model_routes.dispatch("direct/gpt-4o", {
            "messages": [], "temperature": 0.7, "tools": [], "stream": True}, state)
        self.assertNotIn("Authorization", bridge_headers)
        self.assertEqual(upstream_headers["Authorization"], "Bearer fixture-upstream")
        self.assertNotIn("Authorization", private_headers)
        self.assertNotIn("temperature", direct)
        self.assertNotIn("tools", direct)


class SubscriptionModelEditTests(unittest.TestCase):
    def test_compare_and_swap_preserves_private_fields_and_original_backup(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "accounts.json"
            config = {"upstreamKeyEnv": "FIXTURE_ONLY", "private": {"keep": "fixture"}, "models": [
                {"id": alias, "access": "requests", "metered": True,
                 "bridge": {"kind": "gpu", "model": row[0]}}
                for alias, row in model_routes.GPU_MODELS.items()]}
            original = (json.dumps(config) + "\n").encode()
            path.write_bytes(original)
            view = model_services.subscription_view(path)
            command = {"revision": view["revision"], "id": "gemma-4-12b-qat",
                       "changes": {"maxOutputTokens": 64}}
            model_services.update_subscription(command, path)
            saved = json.loads(path.read_text())
            self.assertEqual(saved["private"], config["private"])
            self.assertEqual(saved["upstreamKeyEnv"], config["upstreamKeyEnv"])
            self.assertEqual(saved["models"][0]["maxOutputTokens"], 64)
            backups = list((path.parent / "backups/admin-models").glob("*.json"))
            self.assertEqual(len(backups), 1)
            self.assertEqual(backups[0].read_bytes(), original)
            after = path.read_bytes()
            with self.assertRaisesRegex(ValueError, "Configuration changed"):
                model_services.update_subscription(command, path)
            self.assertEqual(path.read_bytes(), after)

    def test_retired_and_external_routes_are_not_editable(self):
        for bridge in ({"kind": "gpu", "model": "ibm-granite/granite-4.2-3b-fp8"},
                       {"kind": "gpu", "model": "http://example.invalid"}):
            self.assertFalse(model_services.editable({"access": "requests", "bridge": bridge}))


class ModelControlAccessTests(RelayFixture):
    def test_tunnels_foreign_origins_and_rebinding_cannot_reach_controls(self):
        for headers in (TUNNEL, {"Origin": "https://foreign.example"}, {"Host": "foreign.example"}):
            with self.subTest(headers=headers), patch.object(model_services, "inventory") as inventory:
                self.assertEqual(self.status("GET", "/_reach/model-services", headers), 403)
                inventory.assert_not_called()
            with patch.object(model_services, "update_subscription") as update:
                status = self.status("POST", "/_reach/subscription-models",
                                     {**headers, "Content-Type": "application/json"}, b"{}")
                self.assertEqual(status, 403)
                update.assert_not_called()


if __name__ == "__main__":
    unittest.main()
