"""Custom endpoint selection chooses a model from its one metadata refresh."""

import contextlib
import io
import json
import os
import sys
import tempfile
import unittest
from unittest import mock

TOOLS = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "tools")
if TOOLS not in sys.path:
    sys.path.insert(0, TOOLS)

from reach_cli import terminal, commands, discovery, endpoints, picker
from reach_cli.client import ReachClient


class _Discovery:
    def __init__(self, status="ready", models=None):
        self.state = {"status": status, "models": ["fixture-first", "fixture-selected"]
                      if models is None else models, "stale": status == "error", "error": ""}
        self.refreshes = []
        self.waits = []

    def refresh(self, base, key="", key_ref="", timeout=3):
        self.refreshes.append((base, key, key_ref))
        return {"status": "loading", "models": []}

    def snapshot(self, base, key_ref="", key=None):
        return dict(self.state)

    def wait(self, base, key_ref="", timeout=3, key=None):
        if not self.refreshes:
            raise AssertionError("model selection waited before scheduling discovery")
        self.waits.append((base, key, key_ref, timeout))
        return self.snapshot(base, key_ref=key_ref, key=key)


class EndpointModelPickerTests(unittest.TestCase):
    office_url = "https://office.fixture.invalid/v1"

    def setUp(self):
        directory = tempfile.TemporaryDirectory(prefix="reach-endpoint-model-picker-")
        self.addCleanup(directory.cleanup)
        self.path = os.path.join(directory.name, "config.json")
        patch = mock.patch.dict(os.environ, {
            "REACH_CLI_CONFIG": self.path,
            "REACH_KEY": "fixture-builtin-never-print",
            "ENDPOINT_MODEL_KEY": "fixture-custom-never-print",
        })
        patch.start()
        self.addCleanup(patch.stop)
        with open(self.path, "w", encoding="utf-8") as handle:
            json.dump({"endpoint": "local", "endpoint_name": "local", "model": "old-model",
                       "future_field": {"preserve": True}, "custom_endpoints": {
                           "office": {"url": self.office_url, "key_env": "ENDPOINT_MODEL_KEY"},
                       }}, handle)
        self.client = ReachClient(endpoints.LOCAL_ENDPOINT_URL, model="old-model")
        self.client.endpoint_name = "local"
        self.client.models = mock.Mock(side_effect=AssertionError("must reuse scheduled discovery"))
        self.cache = _Discovery()
        patch = mock.patch.object(discovery, "MODEL_DISCOVERY", self.cache)
        patch.start()
        self.addCleanup(patch.stop)
        patch = mock.patch("urllib.request.urlopen", side_effect=AssertionError("selection must not issue synchronous HTTP"))
        patch.start()
        self.addCleanup(patch.stop)

    def config(self):
        with open(self.path, encoding="utf-8") as handle:
            return json.load(handle)

    def invoke(self, line="/endpoint office", choices=("fixture-selected",), available=True):
        output = io.StringIO()
        with contextlib.redirect_stdout(output), \
                mock.patch.object(picker, "available", return_value=available), \
                mock.patch.object(picker, "choose", side_effect=choices) as choose:
            result = commands.handle_slash(line, self.client, [])
        self.assertEqual(len(self.cache.refreshes), 1)
        self.client.models.assert_not_called()
        self.assertNotIn("fixture-custom-never-print", output.getvalue())
        self.assertNotIn("fixture-builtin-never-print", output.getvalue())
        return result, output.getvalue(), choose

    def assert_selected(self, result):
        self.assertTrue(result.success)
        self.assertTrue(result.select_model)
        self.assertEqual(self.client.base, self.office_url)
        self.assertEqual(self.client.endpoint_name, "office")
        self.assertEqual(self.client.model, "fixture-selected")
        self.assertEqual(self.config()["model"], "fixture-selected")
        self.assertEqual(self.config()["future_field"], {"preserve": True})
        self.assertEqual(self.cache.waits, [(self.office_url, "fixture-custom-never-print",
                                            "env:ENDPOINT_MODEL_KEY", 3)])

    def test_endpoint_menu_immediately_offers_shared_model_picker(self):
        result, _text, choose = self.invoke("/endpoint", choices=("office", "fixture-selected"))
        self.assert_selected(result)
        self.assertEqual(choose.call_count, 2)
        model_call = choose.call_args_list[1]
        self.assertEqual(model_call.args[0], "Select model (1-9 quick pick)")
        self.assertEqual([row[0] for row in model_call.args[1]], self.cache.state["models"])
        self.assertTrue(model_call.kwargs["quick_pick"])

    def test_named_alias_and_connection_settings_selection_offer_model_picker(self):
        for line in ("/endpoint office", "/endpoints select office", "/settings connection select office"):
            with self.subTest(line=line):
                self.client.base = endpoints.LOCAL_ENDPOINT_URL
                self.client.endpoint_name = "local"
                self.client.model = "old-model"
                self.cache.refreshes.clear()
                self.cache.waits.clear()
                result, _text, choose = self.invoke(line)
                self.assert_selected(result)
                self.assertEqual(choose.call_count, 1)

    def test_raw_url_selection_offers_model_picker(self):
        url = "https://manual.fixture.invalid/v1"
        result, _text, _choose = self.invoke("/endpoint " + url)
        self.assertTrue(result.select_model)
        self.assertEqual(self.client.base, url)
        self.assertIsNone(self.client.endpoint_name)
        self.assertEqual(self.client.model, "fixture-selected")
        self.assertEqual(self.cache.waits, [(url, "", "", 3)])

    def test_reselecting_custom_endpoint_without_model_offers_picker(self):
        self.client.base = self.office_url
        self.client.endpoint_name = "office"
        self.client.model = None
        result, _text, _choose = self.invoke()
        self.assert_selected(result)

    def test_reselection_with_existing_model_skips_second_picker_and_wait(self):
        self.client.base = self.office_url
        self.client.endpoint_name = "office"
        self.client.model = "fixture-existing"
        result, _text, choose = self.invoke(choices=())
        self.assertTrue(result.success)
        self.assertFalse(result.select_model)
        self.assertEqual(self.client.model, "fixture-existing")
        self.assertEqual(self.cache.waits, [])
        choose.assert_not_called()

    def test_builtins_keep_auto_model_without_followup_picker(self):
        for target in ("local", "subscription", "public"):
            with self.subTest(target=target):
                self.client.base = self.office_url
                self.client.endpoint_name = "office"
                self.client.model = None
                self.cache.refreshes.clear()
                result, _text, choose = self.invoke("/endpoint " + target, choices=())
                self.assertTrue(result.success)
                self.assertFalse(result.select_model)
                self.assertIsNone(self.client.model)
                self.assertEqual(self.cache.waits, [])
                choose.assert_not_called()

    def test_noninteractive_selection_does_not_wait_or_open_model_picker(self):
        result, _text, choose = self.invoke(choices=(), available=False)
        self.assertTrue(result.success)
        self.assertTrue(result.select_model)
        self.assertIsNone(self.client.model)
        self.assertEqual(self.cache.waits, [])
        choose.assert_not_called()

    def test_cancel_retains_selected_endpoint_and_requests_model_choice(self):
        for cancellation in (None, KeyboardInterrupt(), EOFError()):
            with self.subTest(cancellation=type(cancellation).__name__):
                self.client.base = endpoints.LOCAL_ENDPOINT_URL
                self.client.endpoint_name = "local"
                self.client.model = "old-model"
                self.cache.refreshes.clear()
                self.cache.waits.clear()
                result, text, _choose = self.invoke(choices=(cancellation,))
                self.assertTrue(result.success)
                self.assertEqual(self.client.endpoint_name, "office")
                self.assertIsNone(self.client.model)
                self.assertEqual(self.config()["endpoint_name"], "office")
                self.assertNotIn("model", self.config())
                self.assertIn("use /model", text)

    def test_failed_or_loading_discovery_never_selects_stale_models(self):
        for status in ("loading", "error", "busy", "idle", "ready"):
            with self.subTest(status=status):
                self.client.base = endpoints.LOCAL_ENDPOINT_URL
                self.client.endpoint_name = "local"
                self.client.model = "old-model"
                self.cache.refreshes.clear()
                self.cache.waits.clear()
                self.cache.state.update(status=status, models=[] if status == "ready" else ["fixture-stale"])
                result, text, choose = self.invoke(choices=())
                self.assertTrue(result.success)
                self.assertIsNone(self.client.model)
                self.assertEqual(self.client.endpoint_name, "office")
                self.assertIn("Use /model", text)
                choose.assert_not_called()

    def test_model_save_failure_keeps_runtime_and_saved_model_unset(self):
        with mock.patch.object(commands, "save_session_config", return_value=False) as save:
            result, text, _choose = self.invoke()
        self.assertTrue(result.success)
        self.assertEqual(self.client.endpoint_name, "office")
        self.assertIsNone(self.client.model)
        self.assertNotIn("model", self.config())
        save.assert_called_once_with(model="fixture-selected")
        self.assertIn("could not save the selected model", text)

    def test_management_actions_do_not_wait_or_open_model_picker(self):
        for line in ("/endpoint list", "/endpoint test office",
                     "/endpoint add extra https://extra.fixture.invalid/v1",
                     "/endpoint edit office --no-key"):
            with self.subTest(line=line):
                self.cache.refreshes.clear()
                self.cache.waits.clear()
                result, _text, choose = self.invoke(line, choices=())
                self.assertTrue(result.success)
                self.assertFalse(result.select_model)
                self.assertEqual(self.cache.waits, [])
                choose.assert_not_called()

    def test_legacy_discovery_manager_without_wait_uses_snapshot(self):
        self.cache.wait = None
        result, _text, choose = self.invoke()
        self.assertTrue(result.success)
        self.assertEqual(self.client.model, "fixture-selected")
        self.assertEqual(self.cache.waits, [])
        self.assertEqual(choose.call_count, 1)

    def test_real_discovery_manager_fetches_models_exactly_once(self):
        fetch = mock.Mock(return_value=["fixture-first", "fixture-selected"])
        manager = discovery.ModelDiscovery(fetcher=fetch)
        self.addCleanup(lambda: manager.close(wait=True))
        output = io.StringIO()
        with mock.patch.object(discovery, "MODEL_DISCOVERY", manager), \
                mock.patch.object(picker, "available", return_value=True), \
                mock.patch.object(picker, "choose", return_value="fixture-selected"), \
                contextlib.redirect_stdout(output):
            result = commands.handle_slash("/endpoint office", self.client, [])
        self.assertTrue(result.success)
        self.assertEqual(self.client.model, "fixture-selected")
        fetch.assert_called_once()
        self.client.models.assert_not_called()


if __name__ == "__main__":
    unittest.main()
