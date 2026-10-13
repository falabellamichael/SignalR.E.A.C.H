"""Keyboard endpoint menus preserve selection, credentials and CRUD behavior."""

import contextlib
import io
import json
import os
import sys
import tempfile
import unittest
from types import SimpleNamespace
from unittest import mock

TOOLS = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "tools")
if TOOLS not in sys.path:
    sys.path.insert(0, TOOLS)

from reach_cli import terminal, commands, discovery, endpoints, picker


class _CachedDiscovery:
    def __init__(self):
        self.calls = []

    def refresh(self, base, key="", key_ref="", timeout=3):
        self.calls.append((base, key, key_ref))
        return {"status": "loading", "models": []}

    def snapshot(self, base, key_ref="", key=None):
        return {"status": "idle", "models": [], "stale": False, "error": ""}


class EndpointPickerTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="reach-endpoint-picker-")
        self.addCleanup(self.directory.cleanup)
        self.path = os.path.join(self.directory.name, "config.json")
        self.environment = mock.patch.dict(os.environ, {
            "REACH_CLI_CONFIG": self.path,
            "PICKER_ENDPOINT_KEY": "fixture-custom-secret-never-show",
        })
        self.environment.start()
        self.addCleanup(self.environment.stop)
        self.cache = _CachedDiscovery()
        patch = mock.patch.object(discovery, "MODEL_DISCOVERY", self.cache)
        patch.start()
        self.addCleanup(patch.stop)
        self.client = SimpleNamespace(
            base=endpoints.LOCAL_ENDPOINT_URL, endpoint_name="local", key="",
            _builtin_key="fixture-subscription-secret-never-show", model="old-model",
            agent=True, workpath=self.directory.name, system=None,
            models=mock.Mock(side_effect=AssertionError("must not synchronously fetch models")),
        )
        self.write_config({
            "endpoint": "local", "endpoint_name": "local", "model": "old-model",
            "layout": "full", "future_field": {"preserve": True},
            "custom_endpoints": {
                "office": {"url": "http://127.0.0.1:31991/v1", "key_env": "PICKER_ENDPOINT_KEY"},
                "backup": {"url": "http://127.0.0.1:31992/v1"},
            },
        })
        self.available_patch = mock.patch.object(picker, "available", return_value=True)
        self.available_patch.start()
        self.addCleanup(self.available_patch.stop)
        for target in ("reach_cli.client.ReachClient._reachable", "reach_cli.client.discover_public_url"):
            patch = mock.patch(target, side_effect=AssertionError("menus must not probe synchronously"))
            patch.start()
            self.addCleanup(patch.stop)

    def write_config(self, value):
        with open(self.path, "w", encoding="utf-8") as handle:
            json.dump(value, handle)

    def config(self):
        with open(self.path, encoding="utf-8") as handle:
            return json.load(handle)

    def invoke(self, command, choices=(), prompts=None):
        output = io.StringIO()
        before = len(self.cache.calls)
        input_effect = prompts if prompts is not None else AssertionError("selection must not require typed input")
        with contextlib.redirect_stdout(output), \
                mock.patch.object(picker, "choose", side_effect=choices) as choose, \
                mock.patch("reach_cli.terminal.read_input", side_effect=input_effect):
            result = commands.handle_slash(command, self.client, [])
        text = output.getvalue()
        self.assertEqual(len(self.cache.calls) - before, 1, "nested menu dispatch refreshed models more than once")
        self.assertNotIn("fixture-custom-secret-never-show", text)
        self.assertNotIn("fixture-subscription-secret-never-show", text)
        self.assertNotIn("fixture-custom-secret-never-show", repr(choose.call_args_list))
        self.assertNotIn("fixture-subscription-secret-never-show", repr(choose.call_args_list))
        self.client.models.assert_not_called()
        return result, text, choose

    @staticmethod
    def choice_values(call):
        rows = call.args[1] if len(call.args) > 1 else call.kwargs["choices"]
        return [row[0] for row in rows]

    @staticmethod
    def current_choice(call):
        return call.args[2] if len(call.args) > 2 else call.kwargs.get("current")

    def selected_client(self):
        return tuple(getattr(self.client, name, None) for name in (
            "base", "endpoint_name", "key", "key_env", "key_ref", "explicit_credential", "model",
        ))

    def test_bare_endpoint_aliases_select_saved_endpoint_without_typing(self):
        for command in ("/endpoint", "/endpoints"):
            with self.subTest(command=command):
                self.client.base = endpoints.LOCAL_ENDPOINT_URL
                self.client.endpoint_name = "local"
                self.client.model = "old-model"
                saved = self.config()
                saved["endpoint"] = "local"
                saved["endpoint_name"] = "local"
                saved["model"] = "old-model"
                self.write_config(saved)
                result, _text, choose = self.invoke(command, ["office"])
                self.assertTrue(result.success)
                self.assertEqual(self.client.base, "http://127.0.0.1:31991/v1")
                self.assertEqual(self.client.endpoint_name, "office")
                self.assertEqual(self.client.key, "fixture-custom-secret-never-show")
                self.assertEqual(self.client.key_env, "PICKER_ENDPOINT_KEY")
                self.assertIsNone(self.client.model)
                self.assertEqual(self.config()["endpoint_name"], "office")
                self.assertNotIn("model", self.config())
                self.assertEqual(self.config()["future_field"], {"preserve": True})
                self.assertEqual(result.refresh_target, (
                    "http://127.0.0.1:31991/v1", "fixture-custom-secret-never-show", "env:PICKER_ENDPOINT_KEY",
                ))
                choose.assert_called_once()
                self.assertEqual(self.choice_values(choose.call_args)[:2], ["local", "subscription"])
                self.assertEqual(set(self.choice_values(choose.call_args)), {
                    "local", "subscription", "office", "backup", "@add", "@manage",
                })
                self.assertEqual(self.current_choice(choose.call_args), "local")

    def test_current_endpoint_is_initial_choice_and_reselection_keeps_model(self):
        self.invoke("/endpoint office")
        self.client.model = "office-model"
        result, _text, choose = self.invoke("/endpoint", ["office"])
        self.assertTrue(result.success)
        self.assertEqual(self.current_choice(choose.call_args), "office")
        self.assertEqual(self.client.model, "office-model")

    def test_builtin_reselection_keeps_model_across_aliases_and_resolved_urls(self):
        cases = (
            ("subscription", "subscription"),
            ("public", "subscription"),
            ("https://subscription.fixture.invalid/v1", "subscription"),
            ("local", "local"),
        )
        for base, identity in cases:
            for command in ("/endpoint", "/endpoint select " + identity):
                with self.subTest(base=base, command=command):
                    self.client.base = base
                    self.client.endpoint_name = identity
                    self.client.model = "selected-builtin-model"
                    saved = self.config()
                    saved.update(endpoint=base, endpoint_name=identity,
                                 model="selected-builtin-model")
                    self.write_config(saved)
                    result, _text, choose = self.invoke(
                        command, [identity] if command == "/endpoint" else [])
                    self.assertTrue(result.success)
                    self.assertEqual(self.client.endpoint_name, identity)
                    self.assertEqual(self.client.model, "selected-builtin-model")
                    self.assertEqual(self.config()["model"], "selected-builtin-model")
                    if command == "/endpoint":
                        self.assertEqual(self.current_choice(choose.call_args), identity)
                    else:
                        choose.assert_not_called()

    def test_public_alias_reselection_keeps_subscription_model_but_switch_resets_it(self):
        self.client.base = "https://subscription.fixture.invalid/v1"
        self.client.endpoint_name = "subscription"
        self.client.model = "selected-builtin-model"
        saved = self.config()
        saved.update(endpoint="public", endpoint_name="subscription",
                     model="selected-builtin-model")
        self.write_config(saved)
        result, _text, _choose = self.invoke("/endpoint public")
        self.assertTrue(result.success)
        self.assertEqual(self.client.model, "selected-builtin-model")
        self.assertEqual(self.config()["model"], "selected-builtin-model")
        result, _text, _choose = self.invoke("/endpoint", ["local"])
        self.assertTrue(result.success)
        self.assertEqual(self.client.endpoint_name, "local")
        self.assertIsNone(self.client.model)
        self.assertNotIn("model", self.config())

    def test_unsaved_current_url_is_highlighted_and_retains_explicit_credentials(self):
        self.client.base = "https://fixture.invalid/v1"
        self.client.endpoint_name = None
        self.client.key_env = "PICKER_ENDPOINT_KEY"
        self.client.explicit_credential = True
        self.client.key = "fixture-custom-secret-never-show"
        self.client.model = "manual-model"
        saved = self.config()
        saved["endpoint"] = self.client.base
        saved.pop("endpoint_name", None)
        saved["model"] = self.client.model
        self.write_config(saved)
        result, _text, choose = self.invoke("/endpoint", [self.client.base])
        self.assertTrue(result.success)
        self.assertEqual(self.current_choice(choose.call_args), "https://fixture.invalid/v1")
        self.assertIn("https://fixture.invalid/v1", self.choice_values(choose.call_args))
        self.assertEqual(self.client.base, "https://fixture.invalid/v1")
        self.assertIsNone(self.client.endpoint_name)
        self.assertEqual(self.client.key, "fixture-custom-secret-never-show")
        self.assertEqual(self.client.key_env, "PICKER_ENDPOINT_KEY")
        self.assertTrue(self.client.explicit_credential)
        self.assertEqual(self.client.model, "manual-model")
        self.assertEqual(self.config()["model"], "manual-model")
        self.assertEqual(result.refresh_target, (
            "https://fixture.invalid/v1", "fixture-custom-secret-never-show", "env:PICKER_ENDPOINT_KEY",
        ))

    def test_current_url_quotes_survive_generated_select_and_test_arguments(self):
        for url in ("https://fixture.invalid/provider's/v1",
                    'https://fixture.invalid/provider"alias/v1'):
            for choices in ([url], ["@manage", "test", url]):
                with self.subTest(url=url, choices=choices):
                    self.client.base = url
                    self.client.endpoint_name = None
                    self.client.model = "manual-model"
                    saved = self.config()
                    saved.update(endpoint=url, endpoint_name="", model="manual-model")
                    self.write_config(saved)
                    result, _text, _choose = self.invoke("/endpoint", choices)
                    self.assertTrue(result.success)
                    self.assertEqual(self.client.base, url)
                    self.assertIsNone(self.client.endpoint_name)
                    self.assertEqual(self.client.model, "manual-model")
                    self.assertEqual(result.refresh_target[0], url)
                    self.assertEqual(self.config()["model"], "manual-model")
                    if choices[0] == "@manage":
                        self.assertEqual(self.config(), saved)

    def test_escape_from_selection_or_management_preserves_client_and_config(self):
        for choices in ([None], ["@manage", None], ["@manage", "edit", None], ["@manage", "remove", None]):
            with self.subTest(choices=choices):
                before = self.config()
                client_before = self.selected_client()
                result, text, _choose = self.invoke("/endpoint", choices)
                self.assertFalse(result.success)
                self.assertIn("cancelled", text)
                self.assertEqual(self.config(), before)
                self.assertEqual(self.selected_client(), client_before)

    def test_explicit_list_bypasses_menu_even_with_interactive_terminal(self):
        for command in ("/endpoint list", "/endpoints ls"):
            with self.subTest(command=command):
                before = self.config()
                result, text, choose = self.invoke(command)
                self.assertTrue(result.success)
                choose.assert_not_called()
                self.assertIn("office", text)
                self.assertIn("[protected]", text)
                self.assertEqual(self.config(), before)

    def test_non_tty_bare_command_keeps_printed_list(self):
        for command in ("/endpoint", "/endpoints"):
            with self.subTest(command=command), mock.patch.object(picker, "available", return_value=False):
                before = self.config()
                result, text, choose = self.invoke(command)
                self.assertTrue(result.success)
                choose.assert_not_called()
                self.assertIn("office", text)
                self.assertEqual(self.config(), before)

    def test_missing_select_target_uses_endpoint_chooser(self):
        result, _text, choose = self.invoke("/endpoint select", ["backup"])
        self.assertTrue(result.success)
        self.assertEqual(self.client.endpoint_name, "backup")
        self.assertEqual(self.client.key, "")
        self.assertIsNone(self.client.model)
        choose.assert_called_once()
        self.assertEqual(set(self.choice_values(choose.call_args)), {"local", "subscription", "office", "backup"})

    def test_manage_test_chooses_target_without_selecting_or_typing(self):
        before = self.config()
        client_before = self.selected_client()
        result, text, choose = self.invoke("/endpoint", ["@manage", "test", "office"])
        self.assertTrue(result.success)
        self.assertEqual(self.config(), before)
        self.assertEqual(self.selected_client(), client_before)
        self.assertEqual(result.refresh_target, (
            "http://127.0.0.1:31991/v1", "fixture-custom-secret-never-show", "env:PICKER_ENDPOINT_KEY",
        ))
        self.assertIn("queued", text)
        self.assertEqual(len(choose.call_args_list), 3)
        self.assertEqual(set(self.choice_values(choose.call_args_list[1])), {"test", "edit", "remove", "list"})
        self.assertEqual(set(self.choice_values(choose.call_args_list[2])), {"local", "subscription", "office", "backup"})

    def test_manage_edit_only_offers_custom_targets_and_updates_active_target(self):
        self.invoke("/endpoint office")
        self.client.model = "manual-model"
        result, _text, choose = self.invoke(
            "/endpoint", ["@manage", "edit", "office", "anonymous"], ["http://127.0.0.1:31993/v1"],
        )
        self.assertTrue(result.success)
        self.assertEqual(set(self.choice_values(choose.call_args_list[2])), {"office", "backup"})
        self.assertEqual(self.client.base, "http://127.0.0.1:31993/v1")
        self.assertEqual(self.client.key, "")
        self.assertIsNone(self.client.model)
        self.assertEqual(self.config()["endpoint"], self.client.base)
        self.assertEqual(self.config()["custom_endpoints"]["office"], {"url": self.client.base})
        self.assertEqual(set(self.choice_values(choose.call_args_list[3])), {"keep", "anonymous", "environment"})

    def test_manage_remove_only_offers_custom_targets_and_resets_active_endpoint(self):
        self.invoke("/endpoint office")
        result, _text, choose = self.invoke("/endpoint", ["@manage", "remove", "office", "remove"])
        self.assertTrue(result.success)
        self.assertEqual(set(self.choice_values(choose.call_args_list[2])), {"office", "backup"})
        self.assertNotIn("office", self.config()["custom_endpoints"])
        self.assertEqual(self.client.base, endpoints.LOCAL_ENDPOINT_URL)
        self.assertEqual(self.client.endpoint_name, "local")
        self.assertEqual(self.client.key, "")
        self.assertIsNone(self.client.model)
        self.assertEqual(result.refresh_target[0], endpoints.LOCAL_ENDPOINT_URL)
        self.assertEqual(self.choice_values(choose.call_args_list[3]), ["keep", "remove"])

    def test_remove_confirmation_keep_or_escape_preserves_active_saved_target(self):
        self.invoke("/endpoint office")
        for confirmation in ("keep", None):
            with self.subTest(confirmation=confirmation):
                before = self.config()
                client_before = self.selected_client()
                result, text, choose = self.invoke("/endpoint remove", ["office", confirmation])
                self.assertFalse(result.success)
                self.assertIn("cancelled", text)
                self.assertEqual(self.config(), before)
                self.assertEqual(self.selected_client(), client_before)
                self.assertEqual(self.choice_values(choose.call_args_list[1]), ["keep", "remove"])

    def test_missing_edit_and_remove_target_use_only_custom_choices(self):
        result, _text, choose = self.invoke("/endpoint edit", ["office", "anonymous"], [""])
        self.assertTrue(result.success)
        self.assertEqual(set(self.choice_values(choose.call_args_list[0])), {"office", "backup"})
        self.assertNotIn("key_env", self.config()["custom_endpoints"]["office"])
        result, _text, choose = self.invoke("/endpoint remove", ["office", "remove"])
        self.assertTrue(result.success)
        self.assertEqual(set(self.choice_values(choose.call_args_list[0])), {"office", "backup"})
        self.assertEqual(self.client.endpoint_name, "local")

    def test_settings_connection_opens_endpoint_menu_and_refreshes_only_once(self):
        result, _text, choose = self.invoke("/settings connection", ["office"])
        self.assertTrue(result.success)
        choose.assert_called_once()
        self.assertEqual(self.client.endpoint_name, "office")
        self.assertEqual(result.refresh_target, (
            "http://127.0.0.1:31991/v1", "fixture-custom-secret-never-show", "env:PICKER_ENDPOINT_KEY",
        ))

    def test_add_menu_keeps_text_entry_for_new_name_and_url(self):
        result, _text, choose = self.invoke(
            "/endpoint", ["@add", "anonymous"], ["new", "http://127.0.0.1:31994/v1"],
        )
        self.assertTrue(result.success)
        self.assertEqual(len(choose.call_args_list), 2)
        self.assertEqual(set(self.choice_values(choose.call_args_list[1])), {"anonymous", "environment"})
        self.assertEqual(self.config()["custom_endpoints"]["new"], {"url": "http://127.0.0.1:31994/v1"})
        self.assertEqual(self.client.endpoint_name, "local")

    def test_add_credential_menu_stores_environment_name_and_never_secret(self):
        result, _text, _choose = self.invoke(
            "/endpoint", ["@add", "environment"],
            ["new", "http://127.0.0.1:31994/v1", "PICKER_ENDPOINT_KEY"],
        )
        self.assertTrue(result.success)
        self.assertEqual(self.config()["custom_endpoints"]["new"], {
            "url": "http://127.0.0.1:31994/v1", "key_env": "PICKER_ENDPOINT_KEY",
        })
        self.assertNotIn("fixture-custom-secret-never-show", json.dumps(self.config()))
        self.assertEqual(result.refresh_target[1:], ("fixture-custom-secret-never-show", "env:PICKER_ENDPOINT_KEY"))

    def test_escape_from_credential_menu_does_not_commit_partial_add_or_edit(self):
        for choices, prompts in (
            (["@add", None], ["new", "http://127.0.0.1:31994/v1"]),
            (["@manage", "edit", "office", None], ["http://127.0.0.1:31993/v1"]),
        ):
            with self.subTest(choices=choices):
                before = self.config()
                client_before = self.selected_client()
                result, text, _choose = self.invoke("/endpoint", choices, prompts)
                self.assertFalse(result.success)
                self.assertIn("cancelled", text)
                self.assertEqual(self.config(), before)
                self.assertEqual(self.selected_client(), client_before)


if __name__ == "__main__":
    unittest.main()
