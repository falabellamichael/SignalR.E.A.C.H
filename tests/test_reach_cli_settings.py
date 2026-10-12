"""CLI settings preserve existing configuration and apply validated preferences."""

import contextlib
import io
import json
import os
from pathlib import Path
import queue
import shutil
import subprocess
import sys
import tempfile
import threading
import types
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

    def refresh(self, base, key="", key_ref="", timeout=3):
        self.calls.append((base, key, key_ref))
        return {"status": "loading", "models": ["cached-model"], "stale": False,
                "error": "", "request_id": len(self.calls)}

    def snapshot(self, base, key_ref="", key=None):
        return {"status": "ready", "models": ["cached-model"], "stale": False, "error": ""}


class _CLISettingsFixture:
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="reach-settings-test-")
        self.addCleanup(self.directory.cleanup)
        self.path = Path(self.directory.name) / "config.json"
        self.environment = mock.patch.dict(os.environ, {
            "REACH_CLI_CONFIG": str(self.path),
            "REACH_KEY": "fixture-subscription-secret-never-show",
        })
        self.environment.start()
        self.addCleanup(self.environment.stop)
        self.cache = _CachedDiscovery()
        self.cache_patch = mock.patch.object(discovery, "MODEL_DISCOVERY", self.cache)
        self.cache_patch.start()
        self.addCleanup(self.cache_patch.stop)
        self.client = types.SimpleNamespace(
            base=endpoints.LOCAL_ENDPOINT_URL, endpoint_name="local", key="",
            _builtin_key="fixture-subscription-secret-never-show", model="existing-model",
            agent=True, workpath=self.directory.name, system=None, pet="cat", pet_motion=True,
            models=mock.Mock(side_effect=AssertionError("settings must use cached model metadata")),
        )
        self.history = []
        self.repl_session = commands.ReplSession()
        self.write({
            "model": "existing-model", "layout": "full", "future": {"keep": [1, True]},
            "custom_endpoints": {
                "office": {"url": "https://models.example/v1", "key_env": "OFFICE_API_KEY"},
            },
        })

    def write(self, value):
        self.path.write_text(json.dumps(value), encoding="utf-8")

    def read(self):
        return json.loads(self.path.read_text(encoding="utf-8"))

    def invoke(self, text):
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            result = commands.handle_slash(text, self.client, self.history, self.repl_session)
        rendered = output.getvalue()
        self.assertNotIn("fixture-subscription-secret-never-show", rendered)
        self.client.models.assert_not_called()
        return result, rendered


class CLISettingsTests(_CLISettingsFixture, unittest.TestCase):
    def test_main_settings_lists_every_studio_category_and_cached_model(self):
        before = self.path.read_bytes()
        result, text = self.invoke("/settings")
        self.assertTrue(result.success)
        for category in ("conversation", "connection", "budgeting", "mcp", "appearance"):
            self.assertIn(category, text.lower())
        self.assertIn("existing-model", text)
        self.assertIn("cached-model", text)
        self.assertIn(str(self.path), text)
        self.assertEqual(self.path.read_bytes(), before)
        self.assertEqual(len(self.cache.calls), 1)

    def test_conversation_update_changes_live_policy_and_preserves_unrelated_config(self):
        original = self.read()
        result, text = self.invoke("/settings conversation set approvals auto-all")
        self.assertTrue(result.success, text)
        saved = self.read()
        self.assertEqual(saved["settings"]["conversation"]["approvals"], "auto-all")
        self.assertEqual(self.client.cli_settings["conversation"]["approvals"], "auto-all")
        for key in ("model", "layout", "future", "custom_endpoints"):
            self.assertEqual(saved[key], original[key])

    def test_settings_updates_preserve_unknown_settings_fields(self):
        saved = self.read()
        saved["settings"] = {
            "future": {"preserve": "yes"},
            "conversation": {"futureConversation": ["keep"], "approvals": "prompt"},
            "budgets": {"futureBudget": 123},
        }
        self.write(saved)
        result, text = self.invoke("/settings conversation set reviewEdits true")
        self.assertTrue(result.success, text)
        result, text = self.invoke("/settings budgeting set maxRounds 100")
        self.assertTrue(result.success, text)
        persisted = self.read()["settings"]
        self.assertEqual(persisted["future"], {"preserve": "yes"})
        self.assertEqual(persisted["conversation"]["futureConversation"], ["keep"])
        self.assertEqual(persisted["budgets"]["futureBudget"], 123)
        self.assertIs(persisted["conversation"]["reviewEdits"], True)
        self.assertEqual(persisted["budgets"]["maxRounds"], 100)

    def test_zero_budget_is_saved_as_explicit_unlimited_value(self):
        from reach_cli import settings
        result, text = self.invoke("/settings budgeting set maxRounds 0")
        self.assertTrue(result.success, text)
        self.assertEqual(self.read()["settings"]["budgets"]["maxRounds"], 0)
        self.assertEqual(settings.effective_budgets(self.client)["maxRounds"], 0)

    def test_non_integer_and_non_finite_budget_inputs_leave_config_unchanged(self):
        for value in ("-1", "1.5", "NaN", "Infinity", "true", "false", "2147483648"):
            with self.subTest(value=value):
                original = self.path.read_bytes()
                result, text = self.invoke("/settings budgeting set maxRounds " + value)
                self.assertFalse(result.success, text)
                self.assertEqual(self.path.read_bytes(), original)

    def test_invalid_approval_or_boolean_input_does_not_save(self):
        for command in (
            "/settings conversation set approvals unrestricted",
            "/settings conversation set reviewEdits maybe",
            "/settings conversation set unknown value",
            "/settings budgeting set unknown 100",
        ):
            with self.subTest(command=command):
                original = self.path.read_bytes()
                result, text = self.invoke(command)
                self.assertFalse(result.success, text)
                self.assertEqual(self.path.read_bytes(), original)

    def test_corrupt_or_incompatible_config_is_never_replaced_by_settings_edit(self):
        for source, command in (
            ("{broken", "/settings conversation set approvals auto-read"),
            ("[]", "/settings conversation set approvals auto-read"),
            ('{"settings":{},"settings":{}}', "/settings conversation set approvals auto-read"),
            ('{"future":NaN}', "/settings conversation set approvals auto-read"),
            ('{"settings":[]}', "/settings conversation set approvals auto-read"),
            ('{"settings":{"conversation":[]}}', "/settings conversation set approvals auto-read"),
            ('{"settings":{"budgets":[]}}', "/settings budgeting set maxRounds 100"),
        ):
            with self.subTest(source=source):
                self.path.write_text(source, encoding="utf-8")
                original = self.path.read_bytes()
                result, text = self.invoke(command)
                self.assertFalse(result.success, text)
                self.assertEqual(self.path.read_bytes(), original)

    def test_quoted_conversation_name_is_stored_without_losing_spaces(self):
        result, text = self.invoke('/settings conversation set name "Work session"')
        self.assertTrue(result.success, text)
        self.assertEqual(self.read()["settings"]["conversation"]["name"], "Work session")

    def test_conversation_name_rejects_terminal_control_characters(self):
        for character in ("\x1b", "\x7f", "\x9b", "\u202e"):
            with self.subTest(character=repr(character)):
                original = self.path.read_bytes()
                result, text = self.invoke("/settings conversation set name invalid" + character + "name")
                self.assertFalse(result.success, text)
                self.assertNotIn(character, text)
                self.assertEqual(self.path.read_bytes(), original)

    def test_settings_command_syntax_failure_preserves_config(self):
        for command in ("/settings nowhere", "/settings conversation set",
                        "/settings budgeting set maxRounds", '/settings conversation set name "unterminated'):
            with self.subTest(command=command):
                original = self.path.read_bytes()
                result, text = self.invoke(command)
                self.assertFalse(result.success, text)
                self.assertEqual(self.path.read_bytes(), original)

    def test_saved_preferences_apply_at_startup_and_explicit_system_flag_wins(self):
        from reach_cli import settings
        saved = self.read()
        saved["settings"] = {
            "conversation": {"approvals": "auto-read", "reviewEdits": True, "name": "Saved name"},
            "budgets": {"maxRounds": 100, "maxTokens": 2000},
        }
        self.write(saved)
        self.client.system = "Flag supplied system"
        settings.apply_client_settings(self.client, args=types.SimpleNamespace(system="Flag supplied system"),
                                       path=self.path)
        self.assertEqual(self.client.cli_settings["conversation"]["approvals"], "auto-read")
        self.assertIs(self.client.cli_settings["conversation"]["reviewEdits"], True)
        self.assertEqual(settings.effective_budgets(self.client)["maxRounds"], 100)
        self.assertEqual(self.client.system, "Flag supplied system")

    def test_saved_numeric_boolean_is_ignored_instead_of_becoming_one_round(self):
        from reach_cli import settings
        saved = self.read()
        saved["settings"] = {"budgets": {"maxRounds": True}}
        self.write(saved)
        settings.apply_client_settings(self.client, path=self.path)
        self.assertNotIn("maxRounds", settings.effective_budgets(self.client))


class StudioBridgeClientTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="reach-settings-bridge-test-")
        self.addCleanup(self.directory.cleanup)
        self.path = Path(self.directory.name) / "studio-bridge.json"
        self.token = "a" * 64
        self.requests = []
        self.response_status = 200
        self.response_headers = {}
        self.response_body = {"ok": True, "result": {"field": "fixture-result"}}
        owner = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_args):
                pass

            def do_POST(self):
                length = int(self.headers.get("Content-Length", "0"))
                raw = self.rfile.read(length)
                owner.requests.append({"path": self.path, "headers": dict(self.headers),
                                       "body": json.loads(raw)})
                self.send_response(owner.response_status)
                for name, value in owner.response_headers.items():
                    self.send_header(name, value)
                self.end_headers()
                response = owner.response_body
                if not isinstance(response, bytes):
                    response = json.dumps(response).encode("utf-8")
                self.wfile.write(response)

            def do_GET(self):
                owner.requests.append({"path": self.path, "headers": dict(self.headers), "body": None})
                self.send_response(200)
                self.end_headers()

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.url = "http://127.0.0.1:%s" % self.server.server_address[1]
        self.worker = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.worker.start()
        self.addCleanup(self.close_server)
        self.manifest = {"version": 1, "url": self.url, "token": self.token, "pid": os.getpid()}
        self.write_manifest(self.manifest)

    def close_server(self):
        self.server.shutdown()
        self.server.server_close()
        self.worker.join(timeout=2)

    def write_manifest(self, value):
        self.path.write_text(json.dumps(value), encoding="utf-8")

    def bridge(self):
        from reach_cli.studio_settings import StudioSettingsClient
        return StudioSettingsClient(path=self.path)

    def test_call_uses_authenticated_post_and_bypasses_environment_proxy(self):
        with mock.patch.dict(os.environ, {"http_proxy": "http://invalid-proxy.test:1234",
                                          "HTTP_PROXY": "http://invalid-proxy.test:1234",
                                          "no_proxy": "", "NO_PROXY": ""}):
            result = self.bridge().call("settings.save", {"patch": {"pageLayout": "full-width"}})
        self.assertEqual(result, {"field": "fixture-result"})
        self.assertEqual(len(self.requests), 1)
        request = self.requests[0]
        self.assertEqual(request["path"], "/call")
        self.assertEqual(request["headers"]["Authorization"], "Bearer " + self.token)
        self.assertEqual(request["headers"]["Content-Type"], "application/json")
        self.assertEqual(request["body"], {"method": "settings.save",
                                          "params": {"patch": {"pageLayout": "full-width"}}})

    def test_manifest_rejects_non_loopback_or_credential_bearing_urls_before_network(self):
        from reach_cli.studio_settings import SettingsError
        for url in ("https://settings.example", "http://settings.example:8080", "http://0.0.0.0:8080",
                    "http://localhost:8080", "http://127.0.0.1:0", "http://127.0.0.1:65536",
                    self.url + "/call", self.url + "?token=fixture-secret", self.url + "#fixture-secret",
                    self.url.replace("//", "//fixture-secret@", 1)):
            with self.subTest(url=url):
                self.write_manifest(dict(self.manifest, url=url))
                with self.assertRaises(SettingsError) as raised:
                    self.bridge()
                self.assertNotIn("fixture-secret", str(raised.exception))
                self.assertEqual(self.requests, [])

    def test_invalid_manifest_reports_actionable_error_without_exposing_token(self):
        from reach_cli.studio_settings import SettingsError
        for source in ("{invalid", "[]", json.dumps(dict(self.manifest, version=2)),
                       json.dumps(dict(self.manifest, token="fixture-secret")),
                       json.dumps(dict(self.manifest, url=None))):
            with self.subTest(source=source):
                self.path.write_text(source, encoding="utf-8")
                with self.assertRaises(SettingsError) as raised:
                    self.bridge()
                self.assertIn("Studio", str(raised.exception))
                self.assertNotIn(self.token, str(raised.exception))
                self.assertNotIn("fixture-secret", str(raised.exception))

    def test_bridge_never_follows_redirect_or_forwards_bearer_to_redirect_target(self):
        from reach_cli.studio_settings import SettingsError
        for status in (301, 302, 303, 307, 308):
            with self.subTest(status=status):
                self.requests.clear()
                self.response_status = status
                self.response_headers = {"Location": self.url + "/redirect-target"}
                with self.assertRaises(SettingsError):
                    self.bridge().call("settings.get")
                self.assertEqual([row["path"] for row in self.requests], ["/call"])

    def test_http_failure_omits_raw_error_body_from_exception(self):
        from reach_cli.studio_settings import SettingsError
        self.response_status = 500
        self.response_body = b"fixture-secret-error-body"
        with self.assertRaises(SettingsError) as raised:
            self.bridge().call("settings.get")
        self.assertNotIn("fixture-secret", str(raised.exception))
        self.assertNotIn(self.token, str(raised.exception))

    def test_invalid_or_oversized_response_is_rejected_without_echo(self):
        from reach_cli.studio_settings import SettingsError
        for response in (b"fixture-secret-invalid-json", [], b" " * 1048577):
            with self.subTest(response_type=type(response).__name__):
                self.response_body = response
                with self.assertRaises(SettingsError) as raised:
                    self.bridge().call("settings.get")
                self.assertNotIn("fixture-secret", str(raised.exception))


class StudioSettingsCommandsTests(_CLISettingsFixture, unittest.TestCase):
    """Redacted Studio records must stay redacted when building an edit patch."""

    def setUp(self):
        super().setUp()
        self.bridge = mock.Mock()
        self.studio = {
            "connections": [
                {"id": "primary", "name": "Primary", "endpoint": "https://models.example/v1",
                 "model": "old-model", "enabled": True, "hasAccessKey": True},
                {"id": "backup", "name": "Backup", "endpoint": "https://backup.example/v1",
                 "model": "", "enabled": True, "hasAccessKey": False},
            ],
            "activeConnection": "primary", "jevEnabled": True, "jevAutoMode": False,
            "jevKeySource": "saved", "budgets": {"maxRounds": 40, "maxTokens": 16384}, "mcpServers": [
                {"name": "files", "transport": "stdio", "command": "node", "args": ["server.cjs"],
                 "enabled": True, "envKeys": ["MCP_FIXTURE_KEY"], "headerKeys": ["Authorization"]},
            ],
        }

        def call(method, params=None):
            if method == "settings.get":
                return self.studio
            if method == "mcp.status":
                return [{"id": "files", "status": "connected", "tools": []}]
            if method == "budget.schema":
                return {
                    "defaults": {"maxRounds": 40, "maxTokens": 16384, "requestPacing": True},
                    "fields": [
                        {"key": "maxRounds", "label": "Rounds", "type": "number", "min": 0,
                         "group": "Execution", "globalOnly": False, "help": "0 runs until completion"},
                        {"key": "maxTokens", "label": "Output tokens", "type": "number", "min": 0,
                         "group": "Generation", "globalOnly": False, "help": "0 omits provider cap"},
                        {"key": "requestPacing", "label": "Pace requests", "type": "boolean", "min": 0,
                         "group": "Generation", "globalOnly": True, "help": "Shared across provider"},
                    ],
                    "presets": {},
                }
            if method == "conversations.get":
                return {"id": params["id"], "name": "Existing conversation",
                        "settings": {"approvals": "prompt", "budgetOverrides": {"maxRounds": 12}}}
            return {"ok": True}

        self.bridge.call.side_effect = call
        self.patch = mock.patch("reach_cli.settings.StudioSettingsClient", return_value=self.bridge)
        self.patch.start()
        self.addCleanup(self.patch.stop)

    def test_studio_menu_lists_complete_five_category_surface(self):
        result, text = self.invoke("/settings studio")
        self.assertTrue(result.success, text)
        for category in ("connection", "appearance", "mcp", "conversation", "budgeting"):
            self.assertIn("/settings studio " + category, text)
        self.assertIn("Jev", text)

    def test_connection_edit_sends_partial_credentials_and_preserves_other_records(self):
        original = self.path.read_bytes()
        result, text = self.invoke("/settings studio connection set primary model updated-model")
        self.assertTrue(result.success, text)
        saves = [call for call in self.bridge.call.call_args_list if call.args[0] == "settings.save"]
        self.assertEqual(len(saves), 1)
        records = saves[0].args[1]["patch"]["connections"]
        self.assertEqual(records[0]["model"], "updated-model")
        self.assertEqual(records[1]["id"], "backup")
        for row in records:
            self.assertNotIn("accessKey", row)
            self.assertNotIn("hasAccessKey", row)
        self.assertEqual(self.path.read_bytes(), original)

    def test_studio_collection_save_carries_snapshot_revision_to_prevent_lost_edits(self):
        self.studio["settingsRevision"] = "b" * 64
        result, text = self.invoke("/settings studio connection set primary model updated-model")
        self.assertTrue(result.success, text)
        saves = [call for call in self.bridge.call.call_args_list if call.args[0] == "settings.save"]
        self.assertEqual(saves[0].args[1]["patch"]["settingsRevision"], "b" * 64)

    def test_studio_connection_string_field_keeps_numeric_alias_as_text(self):
        result, text = self.invoke('/settings studio connection set primary model "123"')
        self.assertTrue(result.success, text)
        saves = [call for call in self.bridge.call.call_args_list if call.args[0] == "settings.save"]
        self.assertEqual(saves[0].args[1]["patch"]["connections"][0]["model"], "123")

    def test_mcp_edit_omits_redacted_environment_and_header_fields(self):
        result, text = self.invoke("/settings studio mcp set files enabled false")
        self.assertTrue(result.success, text)
        saves = [call for call in self.bridge.call.call_args_list if call.args[0] == "settings.save"]
        row = saves[0].args[1]["patch"]["mcpServers"][0]
        self.assertIs(row["enabled"], False)
        for field in ("env", "headers", "envKeys", "headerKeys"):
            self.assertNotIn(field, row)
        self.assertEqual(row["args"], ["server.cjs"])

    def test_mcp_argument_array_keeps_json_string_entries(self):
        result, text = self.invoke('/settings studio mcp set files args ["--foo", "bar"]')
        self.assertTrue(result.success, text)
        saves = [call for call in self.bridge.call.call_args_list if call.args[0] == "settings.save"]
        self.assertEqual(saves[0].args[1]["patch"]["mcpServers"][0]["args"], ["--foo", "bar"])

    def test_mcp_add_keeps_backslashes_in_windows_executable_path(self):
        result, text = self.invoke(r"/settings studio mcp add windows stdio C:\Tools\Mcp\server.exe --flag")
        self.assertTrue(result.success, text)
        saves = [call for call in self.bridge.call.call_args_list if call.args[0] == "settings.save"]
        row = saves[0].args[1]["patch"]["mcpServers"][-1]
        self.assertEqual(row["command"], r"C:\Tools\Mcp\server.exe")
        self.assertEqual(row["args"], ["--flag"])

    def test_connection_key_uses_environment_reference_and_never_prints_value(self):
        with mock.patch.dict(os.environ, {"STUDIO_FIXTURE_KEY": "fixture-studio-key-never-show"}):
            result, text = self.invoke("/settings studio key primary STUDIO_FIXTURE_KEY")
        self.assertTrue(result.success, text)
        self.assertNotIn("fixture-studio-key-never-show", text)
        self.assertNotIn("fixture-studio-key-never-show", self.path.read_text(encoding="utf-8"))
        saves = [call for call in self.bridge.call.call_args_list if call.args[0] == "settings.save"]
        records = saves[0].args[1]["patch"]["connections"]
        self.assertEqual(records[0]["accessKey"], "fixture-studio-key-never-show")
        self.assertNotIn("accessKey", records[1])

    def test_invalid_key_reference_is_rejected_without_saving_or_echoing_input(self):
        result, text = self.invoke("/settings studio key primary sk-fixture-secret")
        self.assertFalse(result.success, text)
        self.assertNotIn("sk-fixture-secret", text)
        self.assertFalse(any(call.args[0] == "settings.save" for call in self.bridge.call.call_args_list))

    def test_studio_global_budget_update_preserves_other_budgets(self):
        result, text = self.invoke("/settings studio budgeting global set maxRounds 0")
        self.assertTrue(result.success, text)
        self.bridge.call.assert_any_call("settings.save", {
            "patch": {"budgets": {"maxRounds": 0, "maxTokens": 16384}},
        })

    def test_studio_budget_validation_rejects_invalid_values_before_save(self):
        for command in ("/settings studio budgeting global set maxRounds true",
                        "/settings studio budgeting global set maxRounds NaN",
                        "/settings studio budgeting global set requestPacing 1",
                        "/settings studio budgeting chat-fixture set requestPacing true"):
            with self.subTest(command=command):
                self.bridge.call.reset_mock()
                result, text = self.invoke(command)
                self.assertFalse(result.success, text)
                self.assertFalse(any(call.args[0] in ("settings.save", "conversations.update")
                                     for call in self.bridge.call.call_args_list))

    def test_studio_conversation_permission_update_uses_nested_settings_patch(self):
        result, text = self.invoke("/settings studio conversation set chat-fixture approvals auto-read")
        self.assertTrue(result.success, text)
        self.bridge.call.assert_any_call("conversations.update", {
            "id": "chat-fixture", "patch": {"settings": {"approvals": "auto-read"}},
        })

    def test_studio_appearance_updates_profile_without_changing_cli_config(self):
        original = self.path.read_bytes()
        result, text = self.invoke("/settings studio appearance set theme dark")
        self.assertTrue(result.success, text)
        self.bridge.call.assert_any_call("theme.set", {"theme": "dark"})
        self.assertEqual(self.path.read_bytes(), original)


@unittest.skipUnless(shutil.which("node"), "Node.js is required for the real Studio bridge smoke")
class RealStudioBridgeIntegrationTests(_CLISettingsFixture, unittest.TestCase):
    def setUp(self):
        super().setUp()
        self.manifest = Path(self.directory.name) / "studio-bridge.json"
        self.state_path = Path(self.directory.name) / "studio-state.json"
        self.script_path = Path(self.directory.name) / "studio-fixture.cjs"
        self.state_path.write_text(json.dumps({
            "settings": {
                "schemaVersion": 1, "pageLayout": "page-sized", "reachCli": "", "jevEnabled": True,
                "jevApiKey": "fixture-jev-secret", "activeConnection": "primary",
                "connections": [{"id": "primary", "name": "Primary", "endpoint": "https://models.example/v1",
                                 "accessKey": "fixture-provider-secret", "model": "old", "enabled": True}],
                "mcpServers": [
                    {"name": "files", "transport": "stdio", "command": "node", "args": ["server.cjs"],
                     "env": {"API_KEY": "fixture-mcp-env-secret"}, "enabled": True},
                    {"name": "remote", "transport": "http", "url": "https://models.example/mcp",
                     "headers": {"Authorization": "Bearer fixture-mcp-header-secret"}, "enabled": True},
                ],
                "budgets": {"maxRounds": 40, "maxTokens": 16384},
            },
            "conversation": {"id": "chat-fixture", "name": "Original", "model": "old", "settings": {
                "approvals": "prompt", "reviewEdits": True, "budgetOverrides": {"maxRounds": 12},
            }},
        }), encoding="utf-8")
        self.script_path.write_text(r"""
'use strict';
const fs = require('node:fs');
const readline = require('node:readline');
const { createHash } = require('node:crypto');
const { createCliSettingsBridge } = require(process.argv[2]);
const budgets = require(process.argv[3]);
const discoveryFile = process.argv[4], stateFile = process.argv[5];
let state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
const persist = () => fs.writeFileSync(stateFile, JSON.stringify(state));
const revision = settings => createHash('sha256').update(JSON.stringify(settings)).digest('hex');
const bridge = createCliSettingsBridge({
  discoveryFile, getSettings: () => state.settings, getRevision: revision, env: {}, handlers: {
    'settings.save': ({ patch }) => {
      if (patch.settingsRevision !== revision(state.settings)) return { ok: false, err: 'Settings changed; reload before saving.' };
      const saved = { ...patch }; delete saved.settingsRevision;
      state.settings = { ...state.settings, ...saved }; persist(); return { ok: true };
    },
    'budget.schema': () => ({ fields: budgets.fields, defaults: budgets.defaults, presets: budgets.presets }),
    'mcp.status': () => ({ ok: true, servers: state.settings.mcpServers }),
    'conversations.list': () => [state.conversation],
    'conversations.get': ({ id }) => id === state.conversation.id ? state.conversation : null,
    'conversations.update': ({ patch }) => {
      state.conversation = { ...state.conversation, ...patch,
        settings: { ...state.conversation.settings, ...patch.settings } };
      persist(); return { ok: true, agent: state.conversation };
    },
  },
});
const lines = readline.createInterface({ input: process.stdin });
lines.on('line', () => { bridge.stop(); lines.close(); process.exit(0); });
bridge.start().then(() => process.stdout.write('ready\n')).catch(error => {
  process.stderr.write(String(error.message)); process.exit(1);
});
""", encoding="utf-8")
        repository = Path(TOOLS).parent
        self.process = subprocess.Popen([
            shutil.which("node"), str(self.script_path),
            str(repository / "studio" / "agent" / "cli-settings-bridge.cjs"),
            str(repository / "studio" / "agent" / "budgets.cjs"),
            str(self.manifest), str(self.state_path),
        ], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True, encoding="utf-8")
        self.addCleanup(self.stop_fixture)
        startup_lines = queue.Queue()
        threading.Thread(target=lambda: startup_lines.put(self.process.stdout.readline()), daemon=True).start()
        try:
            started = startup_lines.get(timeout=10).strip()
        except queue.Empty:
            self.fail("Studio bridge fixture did not start within 10 seconds")
        if started != "ready":
            _out, error = self.process.communicate(timeout=5)
            self.fail("Studio bridge fixture could not start: " + error)
        self.bridge_path_patch = mock.patch("reach_cli.studio_settings.bridge_path", return_value=str(self.manifest))
        self.bridge_path_patch.start()
        self.addCleanup(self.bridge_path_patch.stop)

    def stop_fixture(self):
        if self.process.poll() is None:
            try:
                self.process.communicate("stop\n", timeout=5)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.communicate(timeout=5)
        else:
            self.process.communicate(timeout=5)

    def test_public_commands_edit_real_bridge_state_and_preserve_all_omitted_secrets(self):
        original_cli_config = self.path.read_bytes()
        output = []
        for command in (
            "/settings studio",
            '/settings studio connection set primary model "123"',
            "/settings studio appearance set pageLayout full-width",
            '/settings studio mcp set files args ["--foo", "bar"]',
            "/settings studio mcp set remote enabled false",
            "/settings studio conversation set chat-fixture approvals auto-read",
            "/settings studio budgeting global set maxRounds 100",
        ):
            with self.subTest(command=command):
                result, text = self.invoke(command)
                self.assertTrue(result.success, text)
                output.append(text)
        state = json.loads(self.state_path.read_text(encoding="utf-8"))
        settings = state["settings"]
        self.assertEqual(settings["connections"][0]["model"], "123")
        self.assertEqual(settings["pageLayout"], "full-width")
        self.assertEqual(settings["mcpServers"][0]["args"], ["--foo", "bar"])
        self.assertIs(settings["mcpServers"][1]["enabled"], False)
        self.assertEqual(settings["budgets"], {"maxRounds": 100, "maxTokens": 16384})
        self.assertEqual(state["conversation"]["settings"]["approvals"], "auto-read")
        self.assertEqual(state["conversation"]["settings"]["budgetOverrides"], {"maxRounds": 12})
        self.assertEqual(settings["connections"][0]["accessKey"], "fixture-provider-secret")
        self.assertEqual(settings["jevApiKey"], "fixture-jev-secret")
        self.assertEqual(settings["mcpServers"][0]["env"], {"API_KEY": "fixture-mcp-env-secret"})
        self.assertEqual(settings["mcpServers"][1]["headers"], {
            "Authorization": "Bearer fixture-mcp-header-secret",
        })
        text = "".join(output)
        for secret in ("fixture-provider-secret", "fixture-jev-secret", "fixture-mcp-env-secret",
                       "fixture-mcp-header-secret", json.loads(self.manifest.read_text())["token"]):
            self.assertNotIn(secret, text)
        self.assertEqual(self.path.read_bytes(), original_cli_config)


if __name__ == "__main__":
    unittest.main()
