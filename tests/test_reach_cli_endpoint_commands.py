"""Endpoint command behavior with isolated config and owned offline discovery."""

import contextlib
import io
import json
import os
import sys
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest import mock

TOOLS = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "tools")
if TOOLS not in sys.path:
    sys.path.insert(0, TOOLS)

from reach_cli import terminal, commands, discovery, endpoints


class _CachedDiscovery:
    def __init__(self):
        self.calls = []
        self.cached = {"status": "idle", "models": [], "stale": False, "error": ""}

    def refresh(self, base, key="", key_ref="", timeout=3):
        self.calls.append((base, key, key_ref))
        return dict(self.cached, status="loading", request_id=len(self.calls))

    def snapshot(self, base, key_ref="", key=None):
        return dict(self.cached)


class EndpointCommandTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="reach-endpoint-command-")
        self.addCleanup(self.directory.cleanup)
        self.path = os.path.join(self.directory.name, "config.json")
        self.env = mock.patch.dict(os.environ, {
            "REACH_CLI_CONFIG": self.path,
            "REACH_KEY": "fixture-subscription-secret-never-show",
            "FIXTURE_ENDPOINT_KEY": "fixture-custom-secret-never-show",
        })
        self.env.start()
        self.addCleanup(self.env.stop)
        self.cache = _CachedDiscovery()
        self.manager_patch = mock.patch.object(discovery, "MODEL_DISCOVERY", self.cache)
        self.manager_patch.start()
        self.addCleanup(self.manager_patch.stop)
        self.client = type("Client", (), {})()
        self.client.base = endpoints.LOCAL_ENDPOINT_URL
        self.client.endpoint_name = "local"
        self.client.key = ""
        self.client._builtin_key = "fixture-subscription-secret-never-show"
        self.client.model = "old-model"
        self.client.agent = True
        self.client.workpath = self.directory.name
        self.client.system = None
        self.client.models = mock.Mock(side_effect=AssertionError("must not synchronously fetch models"))
        self.write_config({"layout": "full", "future_field": {"preserve": True}, "model": "old-model"})
        self.no_reachable = mock.patch("reach_cli.client.ReachClient._reachable", side_effect=AssertionError("must not probe synchronously"))
        self.no_pointer = mock.patch("reach_cli.client.discover_public_url", side_effect=AssertionError("must not resolve pointer synchronously"))
        self.no_reachable.start()
        self.no_pointer.start()
        self.addCleanup(self.no_reachable.stop)
        self.addCleanup(self.no_pointer.stop)

    def write_config(self, value):
        with open(self.path, "w", encoding="utf-8") as handle:
            json.dump(value, handle)

    def config(self):
        with open(self.path, encoding="utf-8") as handle:
            return json.load(handle)

    def invoke(self, line, prompts=None):
        out = io.StringIO()
        before = len(self.cache.calls)
        with contextlib.redirect_stdout(out):
            if prompts is None:
                result = commands.handle_slash(line, self.client, [])
            else:
                with mock.patch("reach_cli.terminal.read_input", side_effect=prompts):
                    result = commands.handle_slash(line, self.client, [])
        text = out.getvalue()
        self.assertNotIn("fixture-custom-secret-never-show", text)
        self.assertNotIn("fixture-subscription-secret-never-show", text)
        token = line.strip().split(None, 1)[0].lower()
        expected = 1 if token in ("/help", "/settings", "/endpoint", "/endpoints") else 0
        self.assertEqual(len(self.cache.calls) - before, expected)
        return result, text

    def add(self, name="office", url="http://127.0.0.1:31991/v1", key=False):
        option = " --key-env FIXTURE_ENDPOINT_KEY" if key else ""
        result, _text = self.invoke("/endpoint add %s %s%s" % (name, url, option))
        self.assertTrue(result.success)

    def test_help_and_alias_registry_are_consistent(self):
        tokens = commands.command_tokens()
        self.assertEqual(len(tokens), len(set(tokens)))
        self.assertEqual(set(tokens), set(commands.HANDLERS))
        for command in ("/help", "/settings", "/endpoint", "/endpoints", "/endpoints list", "/ENDPOINTS\tlist"):
            with self.subTest(command=command):
                result, _text = self.invoke(command)
                self.assertTrue(result.success)
        _result, text = self.invoke("/help")
        for operation in ("add NAME", "edit NAME", "test [NAME]", "select NAME", "remove NAME", "--key-env"):
            self.assertIn(operation, text)

    def test_add_persists_in_existing_registry_without_selecting(self):
        result, text = self.invoke("/endpoint add office https://API.Example/v1/ --key-env FIXTURE_ENDPOINT_KEY")
        self.assertTrue(result.success)
        self.assertEqual(self.client.base, endpoints.LOCAL_ENDPOINT_URL)
        saved = self.config()
        self.assertEqual(saved["custom_endpoints"]["office"], {"url": "https://api.example/v1", "key_env": "FIXTURE_ENDPOINT_KEY"})
        self.assertEqual(saved["future_field"], {"preserve": True})
        self.assertEqual(result.refresh_target, ("https://api.example/v1", "fixture-custom-secret-never-show", "env:FIXTURE_ENDPOINT_KEY"))
        self.assertIn("added: office", text)
        self.assertNotIn("fixture-custom-secret", json.dumps(saved))

    def test_list_shows_protected_options_names_references_and_active_marker(self):
        self.add(key=True)
        self.invoke("/endpoint select office")
        _result, text = self.invoke("/endpoints")
        self.assertIn("local", text)
        self.assertIn("subscription", text)
        self.assertEqual(text.count("[protected]"), 2)
        self.assertIn("FIXTURE_ENDPOINT_KEY (set)", text)
        self.assertIn("office  http://127.0.0.1:31991/v1", text)
        self.assertIn("* current", text)

    def test_protected_options_cannot_be_added_edited_or_removed(self):
        for verb in ("add", "edit", "remove"):
            for name in ("local", "LOCAL", "subscription", "public"):
                with self.subTest(verb=verb, name=name):
                    before = self.config()
                    extra = " http://127.0.0.1:31991/v1" if verb != "remove" else ""
                    result, text = self.invoke("/endpoint %s %s%s" % (verb, name, extra))
                    self.assertFalse(result.success)
                    self.assertEqual(self.config(), before)
                    self.assertIn("reserved", text.lower())

    def test_duplicate_add_preserves_existing_record(self):
        self.add()
        before = self.config()
        result, text = self.invoke("/endpoint add OFFICE http://127.0.0.1:31992/v1")
        self.assertFalse(result.success)
        self.assertIn("already exists", text)
        self.assertEqual(self.config(), before)

    def test_select_named_custom_uses_only_its_credential_reference(self):
        self.add(key=True)
        result, text = self.invoke("/endpoint select office")
        self.assertTrue(result.success)
        self.assertEqual(self.client.key, "fixture-custom-secret-never-show")
        self.assertEqual(self.client.endpoint_name, "office")
        self.assertIsNone(self.client.model)
        self.assertNotIn("model", self.config())
        self.assertIn("background", text)
        self.client.models.assert_not_called()

    def test_select_anonymous_custom_does_not_inherit_global_key(self):
        self.add()
        self.client.key = self.client._builtin_key
        self.invoke("/endpoint office")
        self.assertEqual(self.client.key, "")
        self.assertEqual(self.cache.calls[-1][1:], ("", ""))

    def test_direct_url_select_anonymous_and_clear_saved_named_identity(self):
        self.add(key=True)
        self.invoke("/endpoint office")
        result, _text = self.invoke("/endpoint https://direct.example/v1/")
        self.assertTrue(result.success)
        self.assertEqual(self.client.base, "https://direct.example/v1")
        self.assertEqual(self.client.key, "")
        self.assertIsNone(self.client.endpoint_name)
        self.assertNotIn("endpoint_name", self.config())
        self.assertEqual(result.refresh_target, ("https://direct.example/v1", "", ""))

    def test_builtin_selection_preserves_subscription_key_after_custom(self):
        self.add(key=True)
        self.invoke("/endpoint office")
        for alias in ("subscription", "public"):
            result, _text = self.invoke("/endpoint " + alias)
            self.assertTrue(result.success)
            self.assertEqual(self.client.base, "public")
            self.assertEqual(self.client.endpoint_name, "subscription")
            self.assertEqual(self.client.key, self.client._builtin_key)
            self.assertEqual(result.refresh_target[2], "builtin")
        self.invoke("/endpoint local")
        self.assertEqual(self.client.base, endpoints.LOCAL_ENDPOINT_URL)
        self.assertEqual(self.client.key, "")

    def test_active_edit_updates_in_memory_and_saved_target_and_resets_model(self):
        self.add(key=True)
        self.invoke("/endpoint office")
        self.client.model = "manual-model"
        saved = self.config()
        saved["model"] = "manual-model"
        self.write_config(saved)
        result, _text = self.invoke("/endpoint edit office http://127.0.0.1:31992/v1 --no-key")
        self.assertTrue(result.success)
        self.assertEqual(self.client.base, "http://127.0.0.1:31992/v1")
        self.assertEqual(self.client.key, "")
        self.assertIsNone(self.client.model)
        self.assertEqual(self.config()["endpoint"], self.client.base)
        self.assertNotIn("model", self.config())
        self.assertNotIn("key_env", self.config()["custom_endpoints"]["office"])

    def test_key_only_edit_keeps_url_and_model(self):
        self.add()
        self.invoke("/endpoint office")
        self.client.model = "manual-model"
        result, _text = self.invoke("/endpoint edit office --key-env FIXTURE_ENDPOINT_KEY")
        self.assertTrue(result.success)
        self.assertEqual(self.client.model, "manual-model")
        self.assertEqual(self.client.key, "fixture-custom-secret-never-show")

    def test_inactive_edit_refreshes_result_target_without_selecting(self):
        self.add()
        result, _text = self.invoke("/endpoint edit office http://127.0.0.1:31992/v1")
        self.assertTrue(result.success)
        self.assertEqual(self.client.base, endpoints.LOCAL_ENDPOINT_URL)
        self.assertEqual(result.refresh_target[0], "http://127.0.0.1:31992/v1")

    def test_active_removal_falls_back_to_local_and_never_queries_deleted(self):
        self.add(key=True)
        self.invoke("/endpoint office")
        self.client.model = "manual-model"
        result, text = self.invoke("/endpoint remove office")
        self.assertTrue(result.success)
        self.assertEqual(self.client.base, endpoints.LOCAL_ENDPOINT_URL)
        self.assertEqual(self.client.endpoint_name, "local")
        self.assertIsNone(self.client.model)
        self.assertEqual(self.client.key, "")
        self.assertNotIn("office", self.config()["custom_endpoints"])
        self.assertEqual(self.config()["endpoint"], "local")
        self.assertNotIn("model", self.config())
        self.assertEqual(result.refresh_target[0], endpoints.LOCAL_ENDPOINT_URL)
        self.assertIn("reset the model to auto", text)

    def test_inactive_removal_retains_selected_endpoint(self):
        self.add("office")
        self.add("backup", "http://127.0.0.1:31992/v1")
        self.invoke("/endpoint backup")
        result, _text = self.invoke("/endpoint remove office")
        self.assertTrue(result.success)
        self.assertEqual(self.client.endpoint_name, "backup")
        self.assertEqual(result.refresh_target[0], "http://127.0.0.1:31992/v1")

    def test_legacy_unnamed_active_custom_removal_falls_back(self):
        self.add()
        self.client.base = "http://127.0.0.1:31991/v1"
        self.client.endpoint_name = None
        saved = self.config()
        saved["endpoint"] = self.client.base
        self.write_config(saved)
        self.invoke("/endpoint remove office")
        self.assertEqual(self.client.base, endpoints.LOCAL_ENDPOINT_URL)
        self.assertEqual(self.config()["endpoint_name"], "local")

    def test_test_fetches_named_target_without_selecting(self):
        self.add(key=True)
        before = self.config()
        result, text = self.invoke("/endpoints test office")
        self.assertTrue(result.success)
        self.assertEqual(self.client.base, endpoints.LOCAL_ENDPOINT_URL)
        self.assertEqual(self.config(), before)
        self.assertEqual(result.refresh_target[0], "http://127.0.0.1:31991/v1")
        self.assertIn("queued", text)

    def test_missing_credential_reference_is_actionable_and_stores_no_value(self):
        with mock.patch.dict(os.environ, {}, clear=True):
            with mock.patch.dict(os.environ, {"REACH_CLI_CONFIG": self.path}):
                result, text = self.invoke("/endpoint add office http://127.0.0.1:31991/v1 --key-env MISSING_FIXTURE_KEY")
        self.assertTrue(result.success)
        self.assertIn("MISSING_FIXTURE_KEY is not set", text)
        self.assertEqual(result.refresh_target[1], "")
        self.assertEqual(self.config()["custom_endpoints"]["office"]["key_env"], "MISSING_FIXTURE_KEY")

    def test_interactive_add_uses_owned_input_and_commits_once_complete(self):
        result, _text = self.invoke("/endpoint add", ["office", "http://127.0.0.1:31991/v1", "FIXTURE_ENDPOINT_KEY"])
        self.assertTrue(result.success)
        self.assertEqual(self.config()["custom_endpoints"]["office"]["key_env"], "FIXTURE_ENDPOINT_KEY")

    def test_partial_interactive_add_prompts_for_url_and_optional_reference(self):
        result, _text = self.invoke("/endpoint add office", ["http://127.0.0.1:31991/v1", ""])
        self.assertTrue(result.success)
        self.assertEqual(self.config()["custom_endpoints"]["office"], {"url": "http://127.0.0.1:31991/v1"})

    def test_interactive_edit_blank_keeps_values_and_dash_clears_reference(self):
        self.add(key=True)
        result, _text = self.invoke("/endpoint edit office", ["", ""])
        self.assertTrue(result.success)
        self.assertEqual(endpoints.get_custom("office")["key_env"], "FIXTURE_ENDPOINT_KEY")
        result, _text = self.invoke("/endpoint edit", ["office", "", "-"])
        self.assertTrue(result.success)
        self.assertNotIn("key_env", endpoints.get_custom("office"))

    def test_cancellation_at_any_interactive_stage_preserves_configuration(self):
        self.add(key=True)
        for command, replies in (
            ("/endpoint add", ["cancel"]),
            ("/endpoint add", ["new", EOFError()]),
            ("/endpoint add", ["new", "http://127.0.0.1:31992/v1", KeyboardInterrupt()]),
            ("/endpoint edit office", ["http://127.0.0.1:31992/v1", "cancel"]),
            ("/endpoint remove", [EOFError()]),
            ("/endpoint select", [KeyboardInterrupt()]),
        ):
            with self.subTest(command=command, replies=str(replies)):
                before = self.config()
                result, text = self.invoke(command, replies)
                self.assertFalse(result.success)
                self.assertEqual(self.config(), before)
                self.assertIn("cancelled", text)

    def test_invalid_forms_refresh_once_and_never_write(self):
        for argument in (
            "add office http://host/v1 --key-env", "add office http://host/v1 --key-env A --no-key",
            "add office http://host/v1 --unknown", "list extra", "test a b", "remove a b",
            "select a b", "edit office a b", "no such operation", "add \"unclosed",
            "add office http://invalid\\host/v1", "test local --no-key",
        ):
            with self.subTest(argument=argument):
                before = self.config()
                result, _text = self.invoke("/endpoint " + argument)
                self.assertFalse(result.success)
                self.assertEqual(self.config(), before)

    def test_unsafe_urls_and_key_values_are_not_reflected_in_errors(self):
        secret = "fixture-sensitive-token-NEVER-ECHO"
        for url in (
            "https://user:%s@api.example/v1" % secret,
            "https://api.example/v1?api_key=%s" % secret,
            "https://api.example/v1#%s" % secret,
            "file:///tmp/%s" % secret,
            "https://api.example/%%1b[31m%s" % secret,
        ):
            with self.subTest(url=url):
                result, text = self.invoke("/endpoint add office " + url)
                self.assertFalse(result.success)
                self.assertNotIn(secret, text)
        result, text = self.invoke("/endpoint add office https://api.example/v1 --key-env " + secret)
        self.assertFalse(result.success)
        self.assertNotIn(secret, text)

    def test_settings_shows_cached_failure_staleness_and_credential_reference(self):
        self.add(key=True)
        self.invoke("/endpoint office")
        self.cache.cached.update(status="error", models=["cached-model"], stale=True, error="Model discovery failed (HTTP 503); cached models were retained.")
        _result, text = self.invoke("/settings")
        self.assertIn("stale cached models: cached-model", text)
        self.assertIn("HTTP 503", text)
        self.assertIn("environment FIXTURE_ENDPOINT_KEY (set)", text)

    def test_status_hides_legacy_credential_bearing_base_and_key_prefixes(self):
        self.client.base = "https://user:fixture-sensitive-token-NEVER-ECHO@api.example/v1"
        self.client.endpoint_name = None
        self.client.key = "fixture-sensitive-token-NEVER-ECHO"
        _result, text = self.invoke("/status")
        self.assertNotIn("fixture-sensitive", text)
        self.assertIn("invalid endpoint URL", text)

    def test_persistence_failure_retains_in_memory_selection(self):
        before = self.client.base
        with mock.patch.object(commands, "save_session_config", return_value=False):
            result, text = self.invoke("/endpoint https://api.example/v1")
        self.assertFalse(result.success)
        self.assertEqual(self.client.base, before)
        self.assertIn("permissions", text)

    def test_unexpected_exception_is_redacted_and_still_refreshes_once(self):
        with mock.patch.object(commands, "_cmd_endpoint", side_effect=RuntimeError("fixture-sensitive-token-NEVER-ECHO")):
            with mock.patch.dict(commands.HANDLERS, {"/endpoint": commands._cmd_endpoint}):
                result, text = self.invoke("/endpoint")
        self.assertFalse(result.success)
        self.assertNotIn("fixture-sensitive", text)
        self.assertIn("command failed", text)

    def test_unrelated_commands_do_not_schedule_endpoint_discovery(self):
        for line in ("/status", "/history", "/system", "/exit", "/unknown"):
            self.invoke(line)

    def test_common_operation_aliases_share_crud_and_single_refresh(self):
        self.add()
        for line in ("/endpoints ls", "/endpoint update office http://127.0.0.1:31992/v1",
                     "/endpoints use office", "/endpoint check office", "/endpoints rm office"):
            result, _text = self.invoke(line)
            self.assertTrue(result.success, line)
        self.add()
        result, _text = self.invoke("/endpoint delete office")
        self.assertTrue(result.success)
        self.assertEqual(endpoints.list_custom(), {})

    def test_explicit_raw_url_auth_is_honored_by_help_settings_and_current_test(self):
        self.client.base = "http://127.0.0.1:31991/v1"
        self.client.endpoint_name = None
        self.client.explicit_credential = True
        self.client.key = "fixture-custom-secret-never-show"
        for command in ("/help", "/settings", "/endpoint test", "/endpoint test http://127.0.0.1:31991/v1"):
            result, _text = self.invoke(command)
            self.assertTrue(result.success)
            self.assertEqual(result.refresh_target, (self.client.base, self.client.key, "explicit"))

    def test_selecting_same_raw_url_preserves_explicit_auth_and_new_url_clears_it(self):
        self.client.base = "http://127.0.0.1:31991/v1"
        self.client.endpoint_name = None
        self.client.explicit_credential = True
        self.client.key = "fixture-custom-secret-never-show"
        self.invoke("/endpoint http://127.0.0.1:31991/v1")
        self.assertEqual(self.client.key, "fixture-custom-secret-never-show")
        self.assertTrue(self.client.explicit_credential)
        self.invoke("/endpoint http://127.0.0.1:31992/v1")
        self.assertEqual(self.client.key, "")
        self.assertFalse(self.client.explicit_credential)
        self.invoke("/endpoint subscription")
        self.assertEqual(self.client.key, "fixture-subscription-secret-never-show")

    def test_raw_url_env_reference_uses_current_value_and_same_scope_as_named(self):
        self.client.base = "http://127.0.0.1:31991/v1"
        self.client.endpoint_name = None
        self.client.key_env = "FIXTURE_ENDPOINT_KEY"
        self.client.key = "stale-fixture-credential"
        result, text = self.invoke("/settings")
        self.assertEqual(result.refresh_target[1:], ("fixture-custom-secret-never-show", "env:FIXTURE_ENDPOINT_KEY"))
        self.assertIn("FIXTURE_ENDPOINT_KEY", text)
        with mock.patch.dict(os.environ, {"FIXTURE_ENDPOINT_KEY": "rotated-fixture-secret"}):
            result, text = self.invoke("/endpoint test http://127.0.0.1:31991/v1")
        self.assertEqual(result.refresh_target[1], "rotated-fixture-secret")
        self.assertNotIn("rotated-fixture-secret", text)

    def test_large_model_catalog_preview_is_bounded(self):
        self.cache.cached.update(status="ready", models=["m%04d_" % index + "x" * 500 for index in range(1000)])
        _result, text = self.invoke("/settings")
        self.assertLess(len(text), 3000)
        self.assertIn("998 more available via /models", text)

    def test_inactive_model_test_result_is_visible_in_endpoint_list(self):
        self.add()
        self.cache.cached.update(status="error", stale=True, models=["cached-model"], error="Model discovery failed (HTTP 401); cached models were retained.")
        _result, text = self.invoke("/endpoints")
        self.assertIn("models: error; stale cache retained", text)
        self.assertIn("HTTP 401", text)

    def test_named_active_endpoint_honors_explicit_credential_override(self):
        self.add(key=True)
        self.invoke("/endpoint office")
        before = self.config()
        self.client.explicit_credential = True
        self.client.key_env = None
        self.client.key = "explicit-override-fixture-secret"
        result, text = self.invoke("/settings")
        self.assertEqual(result.refresh_target[1:], ("explicit-override-fixture-secret", "explicit"))
        self.assertIn("explicit credential (set)", text)
        self.assertNotIn("explicit-override-fixture-secret", text)
        self.assertEqual(self.config(), before)
        self.invoke("/endpoint select office")
        self.assertEqual(self.client.key, "fixture-custom-secret-never-show")
        self.assertFalse(self.client.explicit_credential)

    def test_named_active_endpoint_honors_explicit_environment_override(self):
        self.add(key=True)
        self.invoke("/endpoint office")
        before = self.config()
        self.client.explicit_credential = True
        self.client.key_env = "OVERRIDE_ENDPOINT_KEY"
        with mock.patch.dict(os.environ, {"OVERRIDE_ENDPOINT_KEY": "override-environment-fixture-secret"}):
            result, text = self.invoke("/settings")
        self.assertEqual(result.refresh_target[1:], ("override-environment-fixture-secret", "env:OVERRIDE_ENDPOINT_KEY"))
        self.assertIn("OVERRIDE_ENDPOINT_KEY (set)", text)
        self.assertNotIn("override-environment-fixture-secret", text)
        self.assertEqual(self.config(), before)


class EndpointDiscoveryDispatchTests(unittest.TestCase):
    """Count actual loopback HTTP requests, including in-flight coalescing."""

    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="reach-endpoint-http-")
        self.addCleanup(self.directory.cleanup)
        self.path = os.path.join(self.directory.name, "config.json")
        self.env = mock.patch.dict(os.environ, {"REACH_CLI_CONFIG": self.path})
        self.env.start()
        self.addCleanup(self.env.stop)
        self.requests = []
        self.release = threading.Event()
        self.release.set()
        self.entered = threading.Event()
        self.status = 200
        owner = self

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                owner.requests.append(self.path)
                owner.entered.set()
                owner.release.wait(2)
                body = json.dumps({"data": [{"id": "mock-model"}]}).encode()
                self.send_response(owner.status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                try:
                    self.wfile.write(body)
                except (BrokenPipeError, ConnectionResetError):
                    pass

            def log_message(self, *args):
                pass

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.server.daemon_threads = True
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.addCleanup(self._shutdown)
        self.base = "http://127.0.0.1:%d/v1" % self.server.server_port
        self.manager = discovery.ModelDiscovery()
        self.addCleanup(lambda: self.manager.close(wait=True))
        patch = mock.patch.object(discovery, "MODEL_DISCOVERY", self.manager)
        patch.start()
        self.addCleanup(patch.stop)
        endpoints.add_custom("fixture", self.base)
        endpoints.select_custom("fixture")
        self.client = type("Client", (), {"base": self.base, "endpoint_name": "fixture", "key": "", "model": None, "agent": False, "workpath": self.directory.name})()

    def _shutdown(self):
        self.release.set()
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(1)

    def invoke(self, line):
        with contextlib.redirect_stdout(io.StringIO()):
            return commands.handle_slash(line, self.client, [])

    def test_each_completed_invocation_fetches_exactly_once(self):
        for index, line in enumerate(("/help", "/settings", "/endpoint", "/endpoints", "/endpoint list", "/endpoints test fixture", "/endpoint select fixture", "/endpoint test missing"), 1):
            with self.subTest(line=line):
                result = self.invoke(line)
                self.manager.wait(result.refresh_target[0], key_ref=result.refresh_target[2], timeout=2)
                self.assertEqual(len(self.requests), index)
                self.assertEqual(self.requests[-1], "/v1/models")

    def test_slow_inflight_requests_coalesce_without_blocking_commands(self):
        self.release.clear()
        with mock.patch.object(self.manager, "refresh", wraps=self.manager.refresh) as refresh:
            started = time.monotonic()
            first = self.invoke("/endpoint test fixture")
            self.assertTrue(self.entered.wait(1))
            for command in ("/settings", "/endpoint", "/endpoints list", "/help"):
                self.invoke(command)
            elapsed = time.monotonic() - started
            self.assertLess(elapsed, 0.75)
            self.assertEqual(refresh.call_count, 5)
            self.assertEqual(len(self.requests), 1)
        self.release.set()
        final = self.manager.wait(first.refresh_target[0], key_ref=first.refresh_target[2], timeout=2)
        self.assertEqual(final["models"], ["mock-model"])

    def test_concurrent_endpoint_aliases_join_one_http_request(self):
        self.release.clear()
        results = []
        with mock.patch.object(commands, "tprint"), mock.patch.object(self.manager, "refresh", wraps=self.manager.refresh) as refresh:
            threads = [threading.Thread(target=lambda command=command: results.append(commands.handle_slash(command, self.client, []))) for command in ("/endpoint", "/endpoints", "/settings", "/endpoint test fixture")]
            for thread in threads:
                thread.start()
            for thread in threads:
                thread.join(1)
                self.assertFalse(thread.is_alive())
            self.assertTrue(self.entered.wait(1))
            self.assertEqual(refresh.call_count, 4)
            self.assertEqual(len(self.requests), 1)
            self.assertEqual(len(results), 4)
        self.release.set()
        self.manager.wait(self.base, timeout=2)

    def test_failure_retains_cached_models_and_status_is_honest(self):
        first = self.invoke("/endpoint test")
        self.manager.wait(first.refresh_target[0], timeout=2)
        self.status = 503
        second = self.invoke("/endpoint test fixture")
        final = self.manager.wait(second.refresh_target[0], timeout=2)
        self.assertEqual(len(self.requests), 2)
        self.assertEqual(final["status"], "error")
        self.assertTrue(final["stale"])
        self.assertEqual(final["models"], ["mock-model"])
        with contextlib.redirect_stdout(io.StringIO()) as output:
            result = commands.handle_slash("/settings", self.client, [])
        self.assertIn("stale cached", output.getvalue())
        self.assertIn("HTTP 503", output.getvalue())
        self.manager.wait(result.refresh_target[0], timeout=2)
        self.assertEqual(len(self.requests), 3)


if __name__ == "__main__":
    unittest.main()
