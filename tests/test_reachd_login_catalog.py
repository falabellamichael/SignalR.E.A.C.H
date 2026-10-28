"""GPU API isolation and local signed-in provider catalog access."""
import copy
import io
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "server"))

from reachd import model_routes, model_services
from reachd.chat import chat_execute, chat_finalize
from tests.test_reachd_access import RelayFixture, TUNNEL


class LoginCatalogAccessTests(RelayFixture):
    def test_general_catalog_is_gpu_only_for_local_and_api_key_clients(self):
        self.state.cfg["models"]["custom-provider"] = {
            "upstream": "provider/custom", "enabled": True, "public": True}
        for headers in ({}, self.bearer(**TUNNEL), {"X-Reach-Client": "studio"}):
            with self.subTest(headers=list(headers)):
                status, raw, _ = self.call("GET", "/v1/models", headers)
                self.assertEqual(status, 200)
                ids = {row["id"] for row in json.loads(raw)["data"]}
                enabled = set(model_routes.GPU_MODELS) - model_routes.GPU_DISABLED_MODELS
                self.assertTrue(enabled <= ids)
                self.assertTrue(model_routes.GPU_DISABLED_MODELS.isdisjoint(ids))
                self.assertTrue({"bge-m3", "bge-reranker-v2-m3"} <= ids)
                self.assertFalse(set(model_routes.DIRECT_MODELS) & ids)
                self.assertFalse(set(model_routes.BROWSER_MODELS) & ids)
                self.assertNotIn("custom-provider", ids)

    def test_only_marked_direct_local_clients_get_login_providers(self):
        for client in ("studio", "vscode"):
            status, raw, _ = self.call("GET", "/_reach/login-providers/models",
                                       {"X-Reach-Client": client})
            self.assertEqual(status, 200)
            result = json.loads(raw)
            self.assertEqual(result["catalog"], "login-providers")
            rows = {row["id"]: row for row in result["data"]}
            self.assertIn("gpt-4o", rows)
            self.assertEqual(rows["gpt-4o"]["provider"], "codegpt")
            self.assertEqual(rows["chatgpt-chat"]["provider"], "chatgpt")
            self.assertEqual(rows["copilot-chat"]["provider"], "copilot")
            self.assertNotIn("gemini-chat", rows)  # Disabled sign-in is preserved.
            self.assertFalse(set(model_routes.GPU_MODELS) & set(rows))
            self.assertTrue(all(row["requires_login"] for row in rows.values()))
        before = copy.deepcopy(self.state.cfg)
        for headers in ({}, {"X-Reach-Client": "admin"},
                        {"X-Reach-Client": "studio", **TUNNEL},
                        {"X-Reach-Client": "vscode", "Origin": "https://foreign.example"},
                        {"X-Reach-Client": "studio", "Host": "foreign.example"}):
            with self.subTest(headers=headers):
                for method, path, body in (("GET", "/_reach/login-providers/models", None),
                        ("POST", "/_reach/login-providers/chat/completions", b"{}")):
                    self.assertEqual(self.status(method, path, self.bearer(**headers), body), 403)
        self.assertEqual(before, self.state.cfg)

    def test_generic_chat_rejects_login_routes_even_with_client_marker(self):
        for alias in ("gpt-4o", "chatgpt-chat", "copilot-chat"):
            for headers in ({}, self.bearer(**TUNNEL), {"X-Reach-Client": "studio"}):
                with self.subTest(alias=alias, headers=list(headers)), \
                        patch("reachd.chat.net.urlopen") as send:
                    status, raw, _ = self.call("POST", "/v1/chat/completions", headers,
                        json.dumps({"model": alias, "messages": [{"role": "user", "content": "hi"}]}).encode())
                    self.assertEqual(status, 404)
                    self.assertEqual(json.loads(raw)["error"]["code"], "model_not_found")
                    send.assert_not_called()

    def execute(self, model=None, *, catalog="gpu", stream=False):
        self.state.cfg["upstream_retries"] = 0
        self.state.cfg["cache"]["enabled"] = False
        h = MagicMock()
        h._client_ip.return_value = "127.0.0.1"
        h._admin_local.return_value = True
        h.key_limits.return_value = (None, 0, 0)
        h.headers = {}
        payload = {"messages": [{"role": "user", "content": "hi"}], "stream": stream}
        if model is not None:
            payload["model"] = model
        h._read_body.return_value = json.dumps(payload).encode()
        return h, lambda: chat_execute(h, catalog=catalog)

    def test_omitted_general_model_uses_gpu_when_saved_default_is_login(self):
        self.state.cfg["request"]["default_model"] = "gpt-4o"
        h, run = self.execute()
        with patch("reachd.chat.net.urlopen", return_value=MagicMock()) as send:
            result = run()
        h._json.assert_not_called()
        self.assertEqual(result[1]["requested"], "ornith-1.5-9b")
        self.assertEqual(send.call_args.args[0].full_url, "http://127.0.0.1:18002/v1/chat/completions")

    def test_login_client_dispatch_preserves_direct_and_browser_routes(self):
        self.state.cfg["models"]["gpt-4o"]["upstream"] = "direct/gpt-4o"
        for alias, expected in (("gpt-4o", "http://127.0.0.1:21304/v1/chat/completions"),
                                ("chatgpt-chat", self.state.bridge_url + "/chat/completions")):
            h, run = self.execute(alias, catalog="login-providers")
            with patch("reachd.chat.net.urlopen", return_value=MagicMock()) as send:
                result = run()
            self.assertIsNotNone(result)
            h._json.assert_not_called()
            self.assertEqual(send.call_args.args[0].full_url, expected)
            self.assertNotIn("Authorization", send.call_args.args[0].headers)
        h, run = self.execute("gemma-4-12b-qat", catalog="login-providers")
        with patch("reachd.chat.net.urlopen") as send:
            self.assertIsNone(run())
            send.assert_not_called()
            self.assertEqual(h._json.call_args.args[0], 404)

    def test_failed_gpu_request_cannot_fallback_to_signed_in_provider(self):
        self.state.cfg["models"]["ornith-1.5-9b"]["fallback"] = "gpt-4o"
        h, run = self.execute("ornith-1.5-9b")
        with patch("reachd.chat.net.urlopen", side_effect=OSError("fixture offline")) as send:
            self.assertIsNone(run())
        send.assert_called_once()
        h._relay_upstream_error.assert_called_once()

    def test_stream_preflight_cannot_fallback_across_catalogs(self):
        # Use a login route to exercise the existing buffered stream preflight;
        # its filtered context must not gain a GPU fallback during finalization.
        self.state.cfg["models"]["gpt-4o"]["fallback"] = "gemma-4-12b-qat"
        self.state.cfg["models"]["gpt-4o"]["upstream"] = "direct/gpt-4o"
        h, run = self.execute("gpt-4o", catalog="login-providers", stream=True)
        source = io.BytesIO(b'data: {"error":{"code":"fixture","message":"offline"}}\n\ndata: [DONE]\n\n')
        source.headers = {"Content-Type": "text/event-stream"}
        with patch("reachd.chat.net.urlopen", return_value=source) as send:
            result = run()
            self.assertIsNotNone(result)
            chat_finalize(h, *result)
        send.assert_called_once()
        self.assertEqual(h._json.call_args.args[0], 502)
        self.assertEqual(self.state.gate._active, 0)


class LoginSubscriptionIsolationTests(unittest.TestCase):
    def test_view_and_controls_keep_login_records_private_and_unchanged(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "accounts.json"
            config = {"private": "preserve", "models": [
                {"id": "gpu", "access": "requests", "metered": True,
                 "bridge": {"kind": "gpu", "model": model_routes.GPU_MODELS["gemma-4-12b-qat"][0]}},
                {"id": "login", "access": "requests", "metered": True,
                 "bridge": {"kind": "codegpt-direct", "model": "gpt-4o"}},
                {"id": "browser", "access": "requests", "metered": True,
                 "bridge": {"kind": "tray", "model": "chatgpt-chat"}}]}
            path.write_text(json.dumps(config), encoding="utf-8")
            before = path.read_bytes()
            view = model_services.subscription_view(path)
            self.assertEqual([m["id"] for m in view["models"]], ["gpu"])
            self.assertEqual(view["modelsRevision"], model_services.model_revision(config["models"]))
            with self.assertRaisesRegex(ValueError, "cannot be enabled"):
                model_services.update_subscription({"revision": view["revision"], "id": "login",
                                                    "changes": {"enabled": False}}, path)
            self.assertEqual(path.read_bytes(), before)
            with self.assertRaisesRegex(ValueError, "Keep at least one"):
                model_services.update_subscription({"revision": view["revision"], "id": "gpu",
                                                    "changes": {"enabled": False}}, path)
            model_services.update_subscription({"revision": view["revision"], "id": "gpu",
                                                "changes": {"maxOutputTokens": 128}}, path)
            saved = json.loads(path.read_bytes())
            self.assertEqual(saved["private"], "preserve")
            self.assertEqual(saved["models"][1:], config["models"][1:])


if __name__ == "__main__":
    unittest.main()
