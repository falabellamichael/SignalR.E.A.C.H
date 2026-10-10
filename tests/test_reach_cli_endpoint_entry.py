"""Direct endpoint management and credential-safe startup regressions."""

import argparse
import contextlib
import io
import json
import os
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "tools"))

from reach_cli import __main__ as entry
from reach_cli import terminal
from reach_cli.endpoints import LOCAL_ENDPOINT_URL


class FakeDiscovery:
    def __init__(self):
        self.refreshes = []
        self.waits = []
        self.status = "ready"

    def result(self):
        return {"status": self.status, "models": ["owned-model"] if self.status == "ready" else [],
                "stale": False, "error": "owned offline endpoint" if self.status == "error" else "",
                "fetched_at": 1, "request_id": len(self.refreshes)}

    def refresh(self, base, key="", key_ref="", timeout=3):
        self.refreshes.append((base, key, key_ref))
        return self.result()

    def snapshot(self, base, key_ref="", key=None):
        return self.result()

    def wait(self, base, key_ref="", timeout=3, key=None):
        self.waits.append((base, key, key_ref, timeout))
        return self.result()


class EndpointEntrypointTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="endpoint-entry-", dir=os.path.dirname(ROOT))
        self.addCleanup(self.temp.cleanup)
        self.config = os.path.join(self.temp.name, "config.json")
        self.discovery = FakeDiscovery()
        for patch in (
            mock.patch.dict(os.environ, {"REACH_CLI_CONFIG": self.config,
                                       "REACH_KEY": "owned-builtin-credential",
                                       "OWNED_CUSTOM_KEY": "owned-custom-credential",
                                       "OWNED_OVERRIDE_KEY": "owned-override-credential"}),
            mock.patch("reach_cli.__main__.DEFAULT_BASE", LOCAL_ENDPOINT_URL),
            mock.patch("reach_cli.discovery.MODEL_DISCOVERY", self.discovery),
            mock.patch("reach_cli.__main__.ReachClient._reachable", side_effect=AssertionError("startup probe")),
            mock.patch("urllib.request.urlopen", side_effect=AssertionError("unowned network request")),
        ):
            patch.start()
            self.addCleanup(patch.stop)
        terminal.PAINT = terminal.Paint(False)
        self.addCleanup(lambda: setattr(terminal, "PAINT", terminal.Paint(False)))

    def write_config(self, data):
        with open(self.config, "w", encoding="utf-8") as handle:
            json.dump(data, handle)

    def read_config(self):
        with open(self.config, encoding="utf-8") as handle:
            return json.load(handle)

    def invoke(self, args):
        output, errors = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(output), contextlib.redirect_stderr(errors):
            code = entry.main(["--color", "never"] + args)
        text = output.getvalue() + errors.getvalue()
        self.assertNotIn("owned-builtin-credential", text)
        self.assertNotIn("owned-custom-credential", text)
        self.assertNotIn("owned-override-credential", text)
        self.assertNotIn("Traceback", text)
        return code, text

    def saved_custom(self, key_env="OWNED_CUSTOM_KEY"):
        record = {"url": "http://owned.example/v1"}
        if key_env:
            record["key_env"] = key_env
        self.write_config({"custom_endpoints": {"lab": record}, "endpoint_name": "lab",
                           "endpoint": record["url"], "model": "saved-model",
                           "workpath": self.temp.name, "future": {"keep": True}})

    def test_direct_list_aliases_skip_all_startup_probes_and_refresh_once(self):
        for command in ("endpoint", "endpoints"):
            with self.subTest(command=command), mock.patch.object(
                    entry.ReachClient, "resolve_base", side_effect=AssertionError("startup resolution")):
                before = len(self.discovery.refreshes)
                code, text = self.invoke([command])
                self.assertEqual(code, 0)
                self.assertIn("[protected]", text)
                self.assertEqual(len(self.discovery.refreshes), before + 1)
                self.assertEqual(len(self.discovery.waits), before + 1)

    def test_direct_add_forwards_key_reference_and_waits_for_new_nonactive_target(self):
        code, text = self.invoke(["endpoints", "add", "lab", "http://owned.example/v1",
                                  "--key-env", "OWNED_CUSTOM_KEY"])
        self.assertEqual(code, 0)
        self.assertIn("endpoint added", text)
        self.assertEqual(self.read_config()["custom_endpoints"]["lab"],
                         {"url": "http://owned.example/v1", "key_env": "OWNED_CUSTOM_KEY"})
        self.assertEqual(self.discovery.refreshes, [("http://owned.example/v1", "owned-custom-credential",
                                                     "env:OWNED_CUSTOM_KEY")])
        self.assertEqual(self.discovery.waits[0][:3], self.discovery.refreshes[0])

    def test_direct_edit_no_key_and_remove_preserve_unknown_fields(self):
        self.saved_custom()
        self.assertEqual(self.invoke(["endpoint", "edit", "lab", "--no-key"])[0], 0)
        self.assertNotIn("key_env", self.read_config()["custom_endpoints"]["lab"])
        self.assertEqual(self.invoke(["endpoints", "remove", "lab"])[0], 0)
        config = self.read_config()
        self.assertEqual(config["custom_endpoints"], {})
        self.assertEqual(config["endpoint_name"], "local")
        self.assertEqual(config["future"], {"keep": True})
        self.assertEqual(len(self.discovery.refreshes), 2)
        self.assertEqual(self.discovery.refreshes[-1][0], LOCAL_ENDPOINT_URL)

    def test_direct_select_saves_name_and_waits_selected_credentials(self):
        self.saved_custom()
        self.assertEqual(self.invoke(["endpoint", "select", "local"])[0], 0)
        self.assertEqual(self.invoke(["endpoint", "select", "lab"])[0], 0)
        self.assertEqual(self.read_config()["endpoint_name"], "lab")
        self.assertEqual(self.discovery.waits[-1][:3],
                         ("http://owned.example/v1", "owned-custom-credential", "env:OWNED_CUSTOM_KEY"))

    def test_direct_test_failure_nonzero_but_list_and_saved_add_remain_usable_offline(self):
        self.discovery.status = "error"
        self.assertEqual(self.invoke(["endpoints", "test"])[0], 1)
        self.assertEqual(self.invoke(["endpoints"])[0], 0)
        self.assertEqual(self.invoke(["endpoints", "add", "lab", "http://offline.example/v1"])[0], 0)
        self.assertIn("lab", self.read_config()["custom_endpoints"])
        self.assertEqual(len(self.discovery.refreshes), 3)

    def test_direct_unknown_operation_and_protected_removal_are_nonzero_without_changes(self):
        self.saved_custom()
        original = self.read_config()
        for args in (["endpoints", "remove", "subscription"],
                     ["endpoint", "add", "local", "http://owned.example/v1"],
                     ["endpoint", "nonsense", "x"]):
            with self.subTest(operation=args[1]):
                self.assertEqual(self.invoke(args)[0], 1)
                self.assertEqual(self.read_config(), original)
        self.assertEqual(len(self.discovery.refreshes), 3)

    def test_direct_add_missing_values_prompts_through_same_handler(self):
        with mock.patch("reach_cli.terminal.read_input", side_effect=["lab", "http://owned.example/v1", ""]):
            code, _text = self.invoke(["endpoints", "add"])
        self.assertEqual(code, 0)
        self.assertEqual(self.read_config()["custom_endpoints"]["lab"], {"url": "http://owned.example/v1"})
        self.assertEqual(len(self.discovery.refreshes), 1)

    def test_operation_options_are_not_consumed_as_global_credential_flags(self):
        parsed = entry.build_parser().parse_args(
            ["endpoints", "add", "lab", "http://owned.example/v1", "--key-env", "NOT_SET_FIXTURE"])
        self.assertIsNone(parsed.key_env)
        self.assertEqual(parsed.endpoint_args[-2:], ["--key-env", "NOT_SET_FIXTURE"])
        with mock.patch.dict(os.environ):
            os.environ.pop("NOT_SET_FIXTURE", None)
            code, text = self.invoke(["endpoints", "add", "lab", "http://owned.example/v1",
                                      "--key-env", "NOT_SET_FIXTURE"])
        self.assertEqual(code, 0)
        self.assertIn("not set", text)
        self.assertEqual(self.read_config()["custom_endpoints"]["lab"]["key_env"], "NOT_SET_FIXTURE")

    def test_cross_scope_key_and_key_env_conflict_before_any_refresh(self):
        for args in (["--key", "owned-key", "endpoints", "--key-env", "OWNED_OVERRIDE_KEY"],
                     ["--key-env", "OWNED_OVERRIDE_KEY", "chat", "--key", "owned-key"]):
            self.assertEqual(self.invoke(args)[0], 2)
        self.assertEqual(self.discovery.refreshes, [])

    def test_key_env_validation_and_missing_env_make_no_requests_or_config_changes(self):
        for reference in ("sk-actual-looking", "BAD\nENV", ""):
            self.assertEqual(self.invoke(["--key-env", reference, "endpoints"])[0], 2)
        with mock.patch.dict(os.environ):
            os.environ.pop("OWNED_MISSING_ENV", None)
            code, text = self.invoke(["--key-env", "OWNED_MISSING_ENV", "endpoints"])
        self.assertEqual(code, 1)
        self.assertIn("configure that environment variable separately", text)
        self.assertFalse(os.path.exists(self.config))
        self.assertEqual(self.discovery.refreshes, [])

    def test_named_only_auto_resume_does_not_restore_model_or_workpath(self):
        self.saved_custom()
        held = {}
        with mock.patch.object(entry, "run_chat", side_effect=lambda client, base: held.update(client=client, base=base)):
            code, _text = self.invoke(["chat"])
        client = held["client"]
        self.assertEqual(code, 0)
        self.assertEqual(client.base, "http://owned.example/v1")
        self.assertEqual(client.endpoint_name, "lab")
        self.assertEqual(client.key, "owned-custom-credential")
        self.assertEqual(client.key_ref, "env:OWNED_CUSTOM_KEY")
        self.assertIsNone(client.model)
        self.assertEqual(client.workpath, os.getcwd())

    def test_continue_restores_full_saved_session(self):
        self.saved_custom()
        held = {}
        with mock.patch.object(entry, "run_chat", side_effect=lambda client, base: held.update(client=client)):
            self.assertEqual(self.invoke(["--continue"])[0], 0)
        self.assertEqual(held["client"].model, "saved-model")
        self.assertEqual(held["client"].workpath, self.temp.name)

    def test_legacy_url_only_session_requires_continue_and_never_inherits_builtin_key(self):
        self.write_config({"endpoint": "http://legacy.example/v1", "model": "saved-model"})
        clients = []
        with mock.patch.object(entry, "run_chat", side_effect=lambda client, base: clients.append(client)):
            self.assertEqual(self.invoke(["chat"])[0], 0)
            self.assertEqual(self.invoke(["--continue"])[0], 0)
        self.assertEqual(clients[0].base, LOCAL_ENDPOINT_URL)
        self.assertEqual(clients[1].base, "http://legacy.example/v1")
        self.assertEqual(clients[1].key, "")
        self.assertEqual(clients[1]._builtin_key, "owned-builtin-credential")

    def test_explicit_base_name_and_credential_overrides_preserve_identity(self):
        self.saved_custom()
        held = {}
        with mock.patch.object(entry, "run_chat", side_effect=lambda client, base: held.update(client=client)):
            code, _text = self.invoke(["--base", "lab", "--key-env", "OWNED_OVERRIDE_KEY", "chat"])
        self.assertEqual(code, 0)
        client = held["client"]
        self.assertEqual(client.endpoint_name, "lab")
        self.assertEqual(client.key, "owned-override-credential")
        self.assertEqual(client.key_ref, "env:OWNED_OVERRIDE_KEY")
        self.assertEqual(client._builtin_key, "owned-builtin-credential")
        self.assertEqual(self.read_config()["endpoint_name"], "lab")

    def test_explicit_key_on_resumed_custom_does_not_become_builtin_key(self):
        self.saved_custom()
        code, _text = self.invoke(["--key", "owned-override-credential", "endpoints"])
        self.assertEqual(code, 0)
        self.assertEqual(self.discovery.refreshes[-1][1], "owned-override-credential")
        with mock.patch.object(entry, "run_chat") as chat:
            self.assertEqual(self.invoke(["--key", "owned-override-credential", "chat"])[0], 0)
        client = chat.call_args.args[0]
        self.assertEqual(client._builtin_key, "owned-builtin-credential")

    def test_subscription_global_key_env_is_not_replaced_by_builtin_key(self):
        with mock.patch.object(entry.ReachClient, "resolve_base", return_value="https://owned.example/v1"), \
                mock.patch.object(entry, "run_chat") as chat:
            self.assertEqual(self.invoke(["--base", "subscription", "--key-env", "OWNED_OVERRIDE_KEY"])[0], 0)
        client = chat.call_args.args[0]
        self.assertEqual(client.key, "owned-override-credential")
        self.assertEqual(client.key_env, "OWNED_OVERRIDE_KEY")

    def test_explicit_env_survives_saved_custom_subscription_and_legacy_actual_model_request(self):
        cases = (
            ({"endpoint_name": "lab", "endpoint": "http://owned.example/v1",
              "custom_endpoints": {"lab": {"url": "http://owned.example/v1",
                                            "key_env": "OWNED_CUSTOM_KEY"}}},
             "http://owned.example/v1", []),
            ({"endpoint_name": "subscription", "endpoint": "public"},
             "https://owned.example/v1", []),
            ({"endpoint": "http://legacy.example/v1"},
             "http://legacy.example/v1", ["--continue"]),
        )
        for config, base, flags in cases:
            with self.subTest(saved_identity=config.get("endpoint_name", "legacy")):
                self.write_config(config)
                held = {}

                def capture(client, _base):
                    held["client"] = client
                    held["models"] = client.models()

                response = io.BytesIO(b'{"data":[{"id":"owned-model"}]}')
                with mock.patch.object(entry.ReachClient, "resolve_base", return_value=base), \
                        mock.patch.object(entry, "run_chat", side_effect=capture), \
                        mock.patch("urllib.request.urlopen", return_value=response) as transport:
                    self.assertEqual(self.invoke(flags + ["--key-env", "OWNED_OVERRIDE_KEY", "chat"])[0], 0)
                client = held["client"]
                self.assertEqual(client.key, "owned-override-credential")
                self.assertEqual(client.key_env, "OWNED_OVERRIDE_KEY")
                self.assertEqual(client.key_ref, "env:OWNED_OVERRIDE_KEY")
                self.assertEqual(client._builtin_key, "owned-builtin-credential")
                self.assertEqual(held["models"], ["owned-model"])
                request = transport.call_args.args[0]
                self.assertEqual(request.get_header("Authorization"), "Bearer owned-override-credential")
                self.assertEqual(request.full_url, base + "/models")

    def test_saved_subscription_uses_builtin_and_resolves_only_in_normal_startup(self):
        self.write_config({"endpoint_name": "subscription", "endpoint": "public", "model": "saved-model"})
        self.assertEqual(self.invoke(["endpoints"])[0], 0)
        self.assertEqual(self.discovery.refreshes[-1], ("subscription", "owned-builtin-credential", "builtin"))
        with mock.patch.object(entry.ReachClient, "resolve_base", return_value="https://owned.example/v1"), \
                mock.patch.object(entry, "run_chat") as chat:
            self.assertEqual(self.invoke(["chat"])[0], 0)
        self.assertEqual(chat.call_args.args[0].key, "owned-builtin-credential")
        self.assertIsNone(chat.call_args.args[0].model)

    def test_missing_saved_custom_falls_back_local_without_restoring_old_model(self):
        self.write_config({"endpoint_name": "removed", "endpoint": "http://removed.example/v1",
                           "model": "old-model", "custom_endpoints": {}})
        for flags in ([], ["--key", "owned-override-credential"]):
            with self.subTest(explicit_key=bool(flags)), mock.patch.object(entry, "run_chat") as chat:
                code, text = self.invoke(flags + ["chat"])
            self.assertEqual(code, 0)
            self.assertIn("using local", text)
            client = chat.call_args.args[0]
            self.assertEqual(client.base, LOCAL_ENDPOINT_URL)
            self.assertEqual(client.key, "")
            self.assertEqual(client._builtin_key, "owned-builtin-credential")
            self.assertIsNone(client.model)

    def test_invalid_or_credential_bearing_base_is_rejected_before_network(self):
        for base in ("http://user:password@owned.example/v1", "http://owned.example/%1b[2J",
                     "http://owned.example/v1?key=secret", "no-such-name"):
            code, text = self.invoke(["--base", base, "endpoints"])
            self.assertEqual(code, 1)
            self.assertNotIn("password", text)
            self.assertNotIn("?key=secret", text)
        self.assertEqual(self.discovery.refreshes, [])

    def test_documented_shim_help_supports_endpoint_management_without_network(self):
        completed = subprocess.run([sys.executable, "-B", os.path.join(ROOT, "tools", "reach-cli.py"),
                                    "endpoints", "--help"], capture_output=True, text=True, timeout=5)
        self.assertEqual(completed.returncode, 0)
        self.assertIn("protected", completed.stdout)
        self.assertIn("--key-env", completed.stdout)
        self.assertNotIn("Traceback", completed.stderr)

    def test_documented_shim_add_and_test_each_make_exactly_one_owned_models_get(self):
        from tests.test_reach_cli_discovery import MockEndpoint
        endpoint = MockEndpoint()
        self.addCleanup(endpoint.close)
        endpoint.secret = "owned-custom-credential"
        shim = os.path.join(ROOT, "tools", "reach-cli.py")
        for count, operation in enumerate((
                ["add", "lab", endpoint.base, "--key-env", "OWNED_CUSTOM_KEY"],
                ["test", "lab"]), 1):
            with self.subTest(operation=operation[0]):
                completed = subprocess.run([sys.executable, "-B", shim, "--color", "never",
                                            "endpoints"] + operation,
                                           capture_output=True, text=True, encoding="utf-8",
                                           timeout=8, env=dict(os.environ))
                self.assertEqual(completed.returncode, 0, completed.stdout + completed.stderr)
                self.assertIn("model discovery: ready", completed.stdout)
                self.assertNotIn(endpoint.secret, completed.stdout + completed.stderr)
                self.assertEqual(endpoint.count(), count)
                self.assertEqual(endpoint.requests[-1]["path"], "/v1/models")
                self.assertTrue(endpoint.requests[-1]["credential_matches"])


if __name__ == "__main__":
    unittest.main()
